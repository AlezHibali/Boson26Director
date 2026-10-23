# Stage 3：实时语音导演验收记录

日期：2026-10-23。开发基线：f751bce（已补提交前两个阶段）。本阶段完成后创建独立 Git commit；该规则也已写入仓库 AGENTS.md。

## 已交付

首页提供语音导演连接/停止、麦克风状态、最新识别指令、助手回复、工具参数与执行结果，以及连接和插话诊断。原有手动控件仍使用同一个 SceneController / SceneStore。

语音工具覆盖角色替换、morph、服装、转身、位置、动作、摄影机、dolly/orbit、灯光、台词、情绪、显式重置、原子复合指令及只读场景查询。未注册 Stage 4 的 perform / retake / stop_playback。

工具参数 JSON Schema 来自现有 Zod 命令定义，外形/服装/动画能力来自角色清单。会话指令包含当前 SceneState 和每套资产能力，明确角度为度、距离为米、actorId 稳定以及不支持时不得替换成其他能力。

## 执行与恢复机制

1. 参数 delta 和 arguments.done 只表示流式协议进度。应用在 completed response.done 的最终 function_call 到达后执行，再用原 call_id 回传 function_call_output，最后请求模型继续回复。[Boson 工具协议](https://docs.boson.ai/models/higgs-realtime/guides/tool-calling)
2. 调用按接收顺序串行执行。复合请求使用 batch_commands；即使模型在同一回复返回多个独立写工具，运行时仍合成一个原子批量，任一非法则全部不执行。
3. call_id 缓存结果与参数指纹。重复 ID 返回原始结果，不重复修改场景；同 ID 参数变化会被拒绝。同一 response.done 重复到达也不重复继续回复。
4. 队列和去重缓存属于当前导演实例，重连后保留；缓存到达上限时不通过丢弃旧 ID 来冒险重放。停止/断线时连接 AbortSignal 会取消尚未提交的资产操作；旧连接的事件与结果不能再次写入当前场景。
5. 手动修改或工具执行后，精简最新状态和能力信息会同步进 session instructions。角色加载期间的镜头/灯光修改仍按 Stage 2 规则保留。
6. 每次连接获取新的服务端临时凭证；失效或掉线最多自动重试两次，等待分别约 0.5 / 1.5 秒。离线时等待网络恢复，停止或麦克风断开时释放资源。重连不回放旧用户录音或旧指令。
7. 收到 speech_started 即停止本地所有待播/正在播放的回复分块，并按实际已播时长截断未听完的会话 item。被打断 response 的迟到音频被忽略；旧 response.done 也不会把新回复错误标记为结束。[客户端事件](https://docs.boson.ai/api-reference/realtime/client-events)、[服务器事件](https://docs.boson.ai/api-reference/realtime/server-events)

录音使用 AudioWorklet 输出 24 kHz PCM16 单声道；会话启用 Higgs STT 3.1 转写用于“听到的指令”。转写、工具日志、临时凭证和录音不写入 localStorage 或版本库。原始验收音频与详细服务报告仅保存在 Git 忽略的 private 目录。

## 测试结果

| 检查                | 结果                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| 全量单元/接口测试   | 121 项通过，8 个测试文件；Stage 3 新增 29 项                                             |
| 全量浏览器测试      | 14 项通过：Lab 5 项、手动导演台 5 项、语音导演 4 项                                      |
| 生产构建 / 类型检查 | 通过                                                                                     |
| 密钥检查            | 主密钥未出现在可提交文件或浏览器构建产物，.env.local 保持忽略                            |
| 真实中英文语音语料  | 10/10 首次通过，5 条中文、5 条英文                                                       |
| 真实浏览器导演      | 通过；实际 GLB 右转 45°、Wave 后回 Idle、真实回复进入 Web Audio，停止后 track ended      |
| 真实服务插话        | 通过；停止 53 个回复分块播放节点，发出 1 次截断，新中文指令将距离改为 4.8m，演员保持 45° |

### 计划用例映射

| 用例 | 实际覆盖                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| A10  | 参数分片/完整调用、畸形 JSON、未知工具、重复 call_id、同 ID 参数冲突、重复 response；无完整最终调用时不执行  |
| A11  | 先等待场景实际执行，再用原 call_id 返回真实结果/快照，然后请求继续；不在异步资产加载完成前确认               |
| A12  | 过期关闭码、新凭证重连、旧事件回调、停止时晚到麦克风、正在加载的旧工具、离线恢复、最大重试次数               |
| A13  | 非法 compound 整批拒绝；同一个 response 内的多个独立写调用也原子提交；不支持衣服不会产生半次转身             |
| A14  | 真实 TTS 生成固定双语语料，再输入真实 Higgs Realtime，经同一 VoiceSession/ToolBridge 修改实际领域状态；10/10 |
| B9   | 浏览器合成麦克风 → AudioWorklet → 真实服务 → 工具 → 三维角色；Node 语料覆盖更多中文/英文参数                 |
| B10  | 模拟故障测试与真实服务测试均停止 Web Audio、发送已播时长截断、忽略迟到音频；第二条语音继续可执行             |
| B11  | 重复连接只打开一次设备；权限拒绝可重试；停止释放 track；模拟断线恢复保留场景；麦克风断开停止会话             |
| B12  | 按钮改变朝向后，模型上下文包含最新值，后续语音相对操作从新状态执行；不会恢复旧参数                           |

### 真实语料

1. 英文：替换为 Ren，保持其他内容。
2. 中文：换成黑色西装。
3. 英文：右转 45 度并挥手。
4. 中文：镜头靠近一点。
5. 英文：机位向右环绕 15 度。
6. 中文：眼睛大小为 0.8。
7. 英文：脸宽为 0.6。
8. 中文：主光为 2，补光为 0.5。
9. 英文：设置台词 We need to talk. 和愤怒情绪。
10. 中文：换 Ren、穿黑色西装、右转 45 度，其余保持。

逐条耗时约 3.46–11.92 秒，包含整句语音输入、尾部静音、网络以及助手回复完成，不能当作模型首包延迟。测试使用真实 TTS 语音文件，未使用人工转写直接代替语音识别，也未把 mock 的工具选择算作真实模型理解。

真实插话的约 0.4 ms 是浏览器收到 speech_started 后调用本地播放停止的耗时；不包含用户发声到服务器识别插话的时间，也不代表物理扬声器声学延迟。

## 证据

- [脱敏真实服务摘要](evidence/stage3-live-summary.json)：逐条原句、识别结果、工具、状态、耗时以及真实浏览器/插话结果。
- [真实语音驱动浏览器截图](evidence/stage3-live-browser.png)。
- [工具日志、缓存结果与不支持能力提示](evidence/stage3-voice-director.png)。
- 详细报告和缓存语音：docs/evidence/private/stage3/，不提交。

自动回归的 HTTP/WS 故障、权限、设备等测试使用明确 fixture；真正模型能力由上述真实服务测试单独验证。常规回归的历史阶段截图输出到 test-results/evidence，避免覆盖已提交的旧阶段证据；仅显式 UPDATE_EVIDENCE=1 时更新这些历史文件。

## 复验

```powershell
npm run test:stage3
npm run test:stage3:e2e
npm run test:unit
npm run test:e2e
npm run build
npm run check:secrets
```

下列命令使用本地 .env.local，产生真实调用；先启动 npm run dev。语料脚本优先复用缓存的 TTS 文件：

```powershell
npm run test:stage3:live
npm run test:stage3:browser
npm run test:stage3:barge
npm run test:stage3:report
```

stage3:live 验证语音理解与领域状态；stage3:browser 验证实际 WebGL 角色/播放；stage3:barge 通过可控 Web Audio 麦克风，在真实回复播放期间送入第二条语音。以上均使用合成输入，不代替演示电脑上的真人麦克风、回声、耳机/扬声器和听感验收。

## 边界

本阶段的实现、自动回归与真实服务语音链路已交付。物理麦克风现场验收仍需实际使用者确认。Avatar 表演、Take/Retake 和任务持久化继续按 Stage 4 实施；本阶段没有把这些能力作为可执行语音工具。
