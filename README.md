# AI Director Studio

Stage 2 · 手动 3D 导演台与 Boson 能力验证工作台。

首页已实现固定审讯室、演员替换、外形/服装/动作、镜头灯光和统一 SceneStore。第一阶段的角色人像、Realtime、TTS 与 Avatar 验证保留在 /lab；语音导演工具与 Take/Retake 按后续阶段实施。

![Director Desk](docs/evidence/stage2-studio.png)

## 本地启动

要求：Node.js 22.13+（本次使用 24.15.0）、npm、支持 WebGL/AudioWorklet 的浏览器。真实媒体验证脚本额外需要 ffmpeg/ffprobe 在 PATH 中。

在 PowerShell 中：

```powershell
cd C:\Users\alida\Documents\Development\Boson26Director
npm ci
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
# 在 .env.local 设置 BOSON_API_KEY；不要加 NEXT_PUBLIC_ 前缀。
npm run dev
```

打开 http://127.0.0.1:3000。服务仅绑定本机地址。当前为本地单用户导演台与诊断工具；公开部署需要后续增加身份、任务归属、额度和持久任务管理。

主密钥只由服务端读取。页面拿到的临时凭证只用于 Realtime 连接；不写入 localStorage、不显示在日志里。修改本地配置后重启服务。

## 手动导演台的使用顺序

1. 首页左侧选择 Mira / Ren，调整眼睛、脸宽与服装。替换演员会保留当前机位、灯光、台词和兼容参数。
2. 设置演员朝向，或点击左右转身按钮；Wave 播放一次后自动回到 Idle，重复点击会重新开始。
3. 右侧选择全景 / 中景 / 特写，调整距离、环绕、高度和 FOV。推近超出安全距离时会提示并保留机位。
4. 调整主光、补光、轮廓光、环境光与色调，或使用“审讯氛围”。
5. 在中间填写台词与情绪；它们属于场景状态，角色替换不会清空。
6. 下方开发诊断展示目标场景与实际渲染采样，并支持带校验的命令 JSON。批量命令整批成功才提交。

每个成功命令使 revision 增加一次；非法参数、不支持的能力或资产加载失败不会改变场景。加载新角色期间保留当前演员；失败后可以重试。当前场景在页面会话中保存，刷新会重置。

详见 [第二阶段验收报告](docs/STAGE2_VALIDATION.md)。

## 验证工作台的使用顺序

打开 http://127.0.0.1:3000/lab。

1. 切换 Mira / Ren，调整眼睛大小和脸宽，切换日常服装/西装及 Idle/Wave。底部能力摘要来自实际加载的 GLB。
2. 点击「截取角色人像」。拍摄使用独立正面相机；修改外形/服装后会提示重新截取。
3. 点击「连接麦克风」，允许权限后说一句话。听到回复后点击「停止连接」释放设备。本阶段仅验证对话，尚未接入导演工具。
4. 输入短台词，选择情绪，点击「试听 TTS 3」，再通过音频控件播放。
5. 首先选择官方示例人像验证 Avatar 协议，再选择当前角色截图验证风格化外观。每次点击会真实创建一个生成任务。
6. 等待任务完成后播放视频。自动轮询失败/超过等待时间时，用返回的 video_ ID 手动继续查询。刷新仅恢复最近一个 ID，不是完整 Take 历史。

Avatar 输出为二维说话视频。当前 3D 视角、身体动画和房间场景不作为完整三维视频输入。生成画面中供应商会添加 AI 提示水印。

## 本地 API

| 方法与路径                  | 作用                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET /api/diagnostics        | 配置是否存在、模型列表；不调用上游                                                                    |
| POST /api/realtime/session  | 输入 {}，获取短期凭证                                                                                 |
| POST /api/voice-preview     | 输入 {text, emotion}，返回 MP3 字节流                                                                 |
| POST /api/avatar            | 输入 {ref_image, input_tts: {text, emotion}, size}，返回任务对象；也支持白名单/内联音频 input，二选一 |
| GET /api/avatar/:id         | 查询 queued / in_progress / completed / failed                                                        |
| GET /api/avatar/:id/content | 完成后代理 video/mp4；支持单段 Range                                                                  |

emotion 为 neutral / fear / anger；台词限制 300 字。人像仅接受 Boson 官方示例地址或 PNG/JPEG/WebP data URI（约 2 MB 限制）。未开放任意远程人像 URL。

所有接口返回 no-store。错误返回 {error: {code, message}}，不会把上游原始错误或密钥反射给浏览器。付费创建请求不自动重试；网络超时或无法确认提交结果时显示 SUBMISSION_UNKNOWN 并禁用当前页面重复提交。跨重启幂等与 Take 持久化属于 Stage 4。

## 测试

```powershell
npm run typecheck
npm run test:unit
npx playwright install chromium
npm run test:e2e
npm run build
```

单元测试使用明确的上游 mock，验证请求协议、错误处理、无效输入不发请求、下载字节流、实际 GLB 顶点与骨骼、动画和 PCM 编码。浏览器默认测试使用本地媒体夹具及模拟 WebSocket，不调用付费服务；另有真实 GLB 画面和截图测试。

真实测试会使用 .env.local 的密钥并产生调用费用：

```powershell
# 先执行浏览器测试，产出项目角色参考人像，再执行：
npm run test:live
# 保持 npm run dev 运行，在另一个终端执行：
npm run test:live:browser
```

真实脚本首次运行最多生成两段短 TTS、两段短 Avatar（官方人像/项目人像），另验证 Realtime 正常、无效及过期凭证。任务检查点写入被 Git 忽略的 docs/evidence/private/，重复运行优先复用已保存任务，不自动重复付费创建。若提交结果未知或人像发生变化，脚本会停止，需先检查原任务再决定如何重新验收。

真实浏览器测试复用已完成 Avatar，只额外生成一次 TTS；用之前生成的语音文件作为 Chromium 合成麦克风输入，经应用 AudioWorklet、真实 WebSocket 收到回复并调用 Web Audio 播放。这能验证采音处理链路，物理麦克风、声卡、耳机以及恐惧/愤怒的听感仍需现场验收。

测试夹具 tests/fixtures/ 的音视频为本地生成的单音/纯色画面，仅用于明确标记的模拟测试。真实结果独立保存，不混用。

## 角色资产

public/actors/ 内 Mira 与 Ren 为本仓库程序化生成的风格化角色，包含 33 个 mesh、7 个骨骼、FaceWidth / EyeSize 两个 morph、Casual / Suit 两套服装和 Idle / Wave 动画。许可及来源见 public/actors/LICENSE.txt 与 manifest.json；未使用第三方人物模型或纹理。

```powershell
npm run assets:generate
```

会从 scripts/generate-actors.ts 重新导出两个 GLB 和包含 SHA-256 的清单。模型是能力验证用的简洁资产，后续可换成具有同等能力的精细角色。

## 本阶段验收记录

见 [Stage 1 验收报告](docs/STAGE1_VALIDATION.md)、[五阶段开发方案](DEVELOPMENT_PLAN.md) 与 [原始 handoff](PROJECT_HANDOFF_AI_DIRECTOR_STUDIO.md)。

协议依据：[Boson Realtime](https://docs.boson.ai/api-reference/realtime/client-events)、[Realtime 服务器事件](https://docs.boson.ai/api-reference/realtime/server-events)、[Avatar 输入](https://docs.boson.ai/models/higgs-avatar/input-options)、[TTS 标签](https://docs.boson.ai/models/higgs-tts/tags)。
