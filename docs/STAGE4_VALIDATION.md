# Stage 4：情绪表演、Take 历史与 Retake

日期：2026-10-23。开发基线：fb5ff01。实现与自动化验收完成；A20 的主观情绪听感、自然度和逐帧口型质量仍待人工确认。

## 交付

- 按钮或语音 Action / 开拍：冻结 SceneState、台词、情绪、default 音色、模型、尺寸和参考人像版本，再提交一次 Avatar。
- 使用当前 GLB 的外形 morph 与服装，在独立相机、固定中性灯光、正面静止姿态下捕获 640×640 PNG。捕获读取冻结快照，不读取后续舞台变化；没有静默使用预设人像的降级。
- SQLite 保存 requestId → takeId → videoId、输入、SHA-256 和参考 PNG。历史由服务器恢复，不依赖 Blob URL 或浏览器缓存。
- Take 卡片展示角色、服装、人像同步状态、台词、情绪、时间和任务状态。点击只切换回放；异步结果只按 takeId 更新，不抢走选择。
- Retake 深拷贝指定来源，只改变有效 TTS emotion。原始 input.scene 完全保留，input.emotion 是本次实际使用的情绪；这使除有效情绪外的 invariantHash 保持一致。
- 恢复片场是独立按钮，通过 SceneController 的校验原子批量加载，使用新 revision / 动画 token。
- Cut / stop_playback 停止本地 video 和助手 Web Audio，忽略旧回复迟到音频；切换回放、离开页面也暂停并清理媒体。没有云端取消功能。
- 语音注册 perform / retake / stop_playback，仅在已绑定执行器时开放。工具结果返回真实 takeId / status；去重缓存和服务端 requestId 共同保护付费调用。表演工具必须独立调用，与片场修改混在同一回复时整组拒绝，先完成布景再开拍。

### 舞台与生成输入边界

Avatar 实际接收正面参考人像、台词与情绪标签。片场摄影机、灯光、演员位置、朝向、Wave 和房间只用于三维预演，也会存进快照以供恢复；不会声称供应商视频复现这些三维参数。参考人像保留外形与服装，姿态和灯光固定。

Lab 保留原始诊断能力，但 Avatar 提交也进入同一个 SQLite 活跃任务锁；卡片明确标记“Lab 人像，未同步片场”，不能将诊断记录直接 Retake。原有 video ID 查询仍可用。

## 付费任务与恢复

SQLite 位于 Git 忽略的 .data/takes.sqlite，参考图按 hash 去重存储。事务先保存 submitting，再调用上游；request_id 唯一约束和 active 唯一槽保证本机单进程最多一个生成任务。

| 状态或错误                        | 行为与恢复                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| submitting / queued / in_progress | 保留任务，约 2 秒开始查询，30 秒后 5 秒；隐藏页面至少 15 秒。没有 videoId 的 submitting 也会继续读服务器记录       |
| 重复 requestId                    | 同输入返回已有 Take；不同输入返回 409，不重新创建                                                                  |
| 并发新任务                        | 返回 409；Action / Retake 按钮也禁用                                                                               |
| 429 / 查询网络错误                | 保持真实生成状态，遵循秒数或 HTTP-date Retry-After；只重试查询                                                     |
| 等待超过 10 分钟                  | 暂停本地轮询，提示“继续查询”；不标记云端失败或取消                                                                 |
| 明确拒绝、认证失败、缺少配置      | 保存 failed；修复后由用户显式创建新任务                                                                            |
| 提交超时、无有效任务 ID、上游 5xx | 保存 submission_unknown，保留活跃锁；不自动再次付费                                                                |
| 进程在提交时退出                  | 下次启动把遗留 submitting 标为 submission_unknown，不重放 POST                                                     |
| 未知提交                          | 先到 Boson 核实。可关联已确认 video ID；确实未接收时勾选声明后解除本地锁。两种恢复都不创建任务、不声称取消云端任务 |
| 浏览器提交响应丢失                | 仅保存待确认 requestId，读取服务器历史；仍无记录时保持锁，须用户核实后显式解除                                     |
| 下载失败 / 供应商资源过期         | 原记录保留，提供重新加载媒体；不会通过重新生成来修复播放                                                           |

同源视频接口流式转发 Content-Type、长度、单段 Range 及供应商状态。真实供应商本次对 Range 返回 HTTP 200 完整 MP4；浏览器仍能播放。代理不会伪造 206；fixture 也覆盖 Range 转发与无效 Range 拒绝。

部署范围为本机单用户、一个 Node 进程和本地持久磁盘。公开多用户部署、多个应用实例和长期视频归档属于后续范围；SQLite 并不是公共用户鉴权。备份时应停止服务后复制整个 .data 目录，勿只复制正在写入的 SQLite 主文件。供应商视频保留期不作承诺。

## 验收结果

环境：Windows、Node 24.15.0、Next 16.4.3、Chromium / Playwright 1.64.1、SwiftShader。真实媒体由 ffprobe 解码检查，单元与默认浏览器测试使用明确 mock，不产生付费请求。

| 范围                       | 证据与结果                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 类型 / 生产构建 / 密钥检查 | 通过；主密钥不在客户端产物或可提交文件，.env.local、SQLite、原始媒体均忽略                                                    |
| 全量单元与接口             | 155 项，10 个文件；本阶段新增 34 项                                                                                           |
| 全量浏览器                 | 20 项：Lab 5、Stage 2 片场 5、Stage 3 语音 4、Stage 4 Take 6                                                                  |
| A15                        | 创建 → 查询 → 下载；完成前拒绝内容；同源 MP4、Range 转发与错误路径                                                            |
| A16                        | 相同 ID 在上游未返回时也复用同一记录；不同输入冲突；不同 ID 和 Lab 共享单任务锁                                               |
| A17                        | Retake 输入结构比较：除 input.emotion 外完全相同；原 Take 和 invariantHash 不变                                               |
| A18                        | SQLite 文件实际关闭重开后保留 videoId；客户端乱序更新分别命中各自记录，不改变选择；真实服务重启后也恢复两个已完成 Take        |
| A19                        | failed、429、查询超时、内容 404、未知提交、进程中断、浏览器丢失响应均有恢复测试；没有自动重建付费任务                         |
| B13                        | 模拟 WS 的 perform 经真实浏览器捕获外形，再修改当前机位；Retake 仍继承来源机位。另通过真实 Realtime 合成麦克风完成一次 Action |
| B14                        | 连续双击只提交一次；生成完成后仍选中旧 Take                                                                                   |
| B15                        | 切换、Cut、离开页面停止 video；真实 Web Audio 播放节点被语音 Cut 停止，迟到音频不再播放                                       |
| B16                        | 刷新恢复历史与任务状态；使用持久同源媒体地址；内容过期可重新加载，不重新生成                                                  |
| B17                        | 捕获 PNG 随外形 / 服装变化；仅修改机位、朝向、灯光时 PNG 不变；Lab 降级状态单独标示                                           |

### A20：真实两个情绪版本

台词同为 **I didn't do it.**，Mira、Suit、EyeSize 0.55；原舞台朝向 45°。Action 经真实 Realtime → perform → Take API，Retake 由按钮只改为 anger。期间把当前舞台摄影机距离从 5.2m 改为 3m，Retake 保存的距离仍为来源的 5.2m。

两个任务均 completed，都是 640×640 H.264 + AAC、约 1.58 秒；fear 为 63,315 字节，anger 为 70,591 字节。两个版本均已在真实 Chromium 解码、播放、Cut，刷新与服务重启后仍可查询及播放。共创建两个 Avatar；后续验收复用检查点，未再创建任务。另有一次缓存的短 TTS 用于合成“开始表演，Action。”麦克风输入。

已查看参考图和真实视频帧：演员发型、服装与参考对应，嘴部形状有变化。**这些证据不等于主观情绪或精确口型同步通过**；请人工 A/B 试听两个版本，检查恐惧与愤怒是否可辨、语气自然、嘴部时序及持续身份稳定。该人工质量门槛仍待验收，不能只凭 HTTP 200 判定完成。

首次真实脚本在过度严格的“Range 必须返回 206”断言处停止；两个任务此前已经完成。修正为接受合法的 200 完整内容或 206 后，使用原检查点完成剩余验收，没有重复付费。报告里的查询耗时是复用已有任务后的查询时间，不是生成延迟。

证据：

- [脱敏真实摘要](evidence/stage4-live-summary.json)
- [Take 历史与回放截图](evidence/stage4-live-takes.png)
- 本机私有媒体：docs/evidence/private/stage4/fear.mp4、anger.mp4、reference.png、live-report.json、checkpoint.json（全部 Git 忽略）。

## 复现

```powershell
npm run test:stage4
npm run test:stage4:e2e
npm run test:api
npm run typecheck
npm run test:unit
npm run test:e2e
npm run build
npm run check:secrets
# 真实服务需先运行 npm run dev 或 npm run start：
npm run test:stage4:live
```

真实脚本首次最多创建两个 Avatar，后续复用检查点。若已经标记 attempted 却找不到记录，脚本主动停止，禁止自行删除检查点后重跑。恢复未知提交应通过界面核实和关联，而不是清空数据库。

协议依据：[Avatar 输入](https://docs.boson.ai/models/higgs-avatar/input-options)、[视频查询](https://docs.boson.ai/api-reference/videos/retrieve-a-video)、[视频内容](https://docs.boson.ai/api-reference/videos/download-content)。实现沿用官方的 JSON 任务状态与 MP4 二进制内容边界。
