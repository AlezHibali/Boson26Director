# Stage 2：手动 3D 导演台验收记录

日期：2026-10-23。依据 DEVELOPMENT_PLAN.md 的 Stage 2。首页为导演台，第一阶段诊断页保留在 /lab。

## 已交付功能

- 固定审讯室：桌子、两把椅子、镜窗、门、灯具与布光。
- Mira / Ren 角色切换、EyeSize / FaceWidth 真实几何变形、日常针织 / 黑色西装切换。
- 角色站位、相对 / 绝对转身、一次 Wave、自动回到 Idle、重复 Wave 重新开始。
- 摄影机全景 / 中景 / 特写预设、dolly、orbit、高度、FOV；实际相机位置、焦点和 FOV 平滑过渡。
- 主光、补光、轮廓光、环境光与色调控制。
- 场景台词、情绪、重置、错误提示、资产重试、开发诊断与命令入口。

## 状态和命令实现

场景唯一业务状态为 Zustand SceneStore 内的 SceneState；React 控件读取该状态，所有修改都通过 controller.dispatch。Three.js 仅保存渲染插值和动画播放状态，不反向写入未经校验的业务参数。

src/domain/scene.ts 的 transition 是纯命令边界：先校验完整参数，再在深拷贝上执行，成功才增加 revision。失败返回原状态对象；batch 中任何一条失败，整批不提交。批量最多 16 条，禁止嵌套。

切换角色先检查整条指令，再异步加载并校验实际 GLB 能力，最后对最新场景重新执行并一次提交。加载期间镜头/灯光编辑可继续；加载失败保留原演员。每个角色选择请求带递增序号，旧请求即使晚到也不能覆盖新选择，重置也会使旧请求失效。

演员使用稳定 actorId，presetId 表示外观资产。替换时保留 transform、相机、灯光、台词和兼容外形/服装/动作。遇到不支持的 morph 会移除，范围不兼容会限制到合法范围，服装/动作会回退并返回 notices。当前两个真实资产的能力一致；不兼容回退使用缩减能力的测试清单验证，没有虚构第三个可用角色。

静态 appearance 与动态 expression 分开。Wave 由单一 AnimationMixer 以 LoopOnce 播放；完成事件只有 presetId 和 animation token 都仍匹配当前场景时，才切回 Idle。重复动作会停止旧 action 并重新开始。

### 命令接口

这些是浏览器内的应用命令，不是 Boson API，也没有新增远程场景写接口。后续语音工具应调用同一个异步 controller.dispatch。

| 命令                       | 参数与语义                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| select_actor               | actorId、presetId；资产加载成功才提交                                                         |
| set_appearance             | actorId、真实 morph 名称、value；当前为 0–1                                                   |
| set_outfit                 | actorId、服装组名称                                                                           |
| rotate_actor               | actorId、mode: relative / absolute、degrees；绕世界 Y 轴，正数朝画面右侧，归一化到 [-180,180) |
| set_position               | actorId、x: -0.75–0.75m、z: -0.8–0m；y 固定为 0                                               |
| play_animation             | actorId、animation；当前支持 Idle / Wave                                                      |
| set_camera                 | camera 局部字段；不得为空                                                                     |
| dolly                      | amount 为正时推近，负时拉远，单步绝对值最多 2m                                                |
| orbit                      | degrees 相对增加机位环绕角                                                                    |
| set_lighting               | lights 局部字段；不得为空                                                                     |
| set_dialogue / set_emotion | 台词最多 300 字；neutral / fear / anger                                                       |
| reset_scene                | 恢复初始场景，保持 actorId 并使旧资产请求失效                                                 |
| batch                      | 原子执行 commands 数组，成功只增加一个 revision                                               |

摄影机距离指演员周围的水平距离：2.2–6m；环绕 -60°–60°；高度 0.8–3m；FOV 25°–65°；目标高度 0.8–1.8m。越界命令拒绝执行并保留原机位，不静默越界或无限推近。当前固定房间没有任意物体碰撞系统。

灯光范围：key / rim 0–6、fill 0–4、ambient 0.05–1.5；色调 warm / neutral / cool。强度单位为 Three.js 灯光参数，不作为摄影测光数值。

## 测试结果

| 验证                          | 结果                                                               |
| ----------------------------- | ------------------------------------------------------------------ |
| 全量单元/接口测试             | 92 项通过，6 个测试文件；其中第二阶段新增 59 项                    |
| 全量浏览器回归                | 10 项通过：Stage 1 /lab 5 项，Stage 2 导演台 5 项                  |
| TypeScript / production build | 通过；首页与 /lab 均成功构建                                       |
| 密钥检查                      | .env.local 被 Git 忽略；主密钥未出现在可提交文件或浏览器构建产物中 |
| 上游调用                      | 本阶段功能与回归使用本地资产，无需新增 Boson 付费调用              |

### 对应计划用例

| 计划用例              | 验收方式与结果                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A6 正常/边界/非法命令 | 每类命令的合法值、数值越界、NaN/Infinity、未知 actor/preset/morph/outfit/animation、未知字段均覆盖；失败不改状态/revision |
| A7 角色替换           | 比较完整状态验证稳定 actorId、transform、相机、灯光、台词及兼容参数保留；缩减能力清单验证所有回退提示                     |
| A8 确定性             | 同一初态/命令产生相同输出；相对转身累加、绝对转身替换；测试静态外形不污染动态表情                                         |
| A9 原子批量           | 末条不支持则整批回滚；合法批量只提交一次；无效批量不触发资产下载；资产下载失败也不会先应用镜头变化                        |
| B5 完整手动流程       | 浏览器执行换演员→换装→修改形态→转身→挥手→推镜→调暗；验证 SceneState、实际 morph、实际相机和可见画面                       |
| B6 竞态和重复操作     | 延迟 Ren 加载，再选择 Mira，迟到结果不覆盖；多次 Wave 无叠加，最终回 Idle；快速连续形态修改无回跳、画面始终只有一位演员   |
| B7 加载失败           | 拦截 GLB 请求模拟失败，原演员与状态保留，镜头仍可编辑；解除失败后重试成功，机位不重置                                     |
| B8 布局和帧率         | 实际 Chromium WebGL 在 1280×720 / 1920×1080 下无横向溢出，控件可访问；采样含多次环绕操作，目标中位帧率至少 30 FPS         |

本次环境为 Windows 11 / Intel Core i9-13900H / Chromium SwiftShader 软件渲染。1280×720 的 5 次采样均为 60 FPS；1920×1080 为 42、40、41、42、40 FPS，中位数 41 FPS。采样期间进行了机位环绕操作。

性能环境与逐次帧率见 [测量数据](evidence/stage2-performance.json)。这是该机器、浏览器和场景下的短时实测，不推广为所有硬件的保证；没有用固定数值模拟 FPS。

### 截图证据

- [初始导演台](evidence/stage2-studio.png)
- [换装、转身、特写与调暗](evidence/stage2-directed.png)
- [外形修改前](evidence/stage2-morph-before.png) / [修改后](evidence/stage2-morph-after.png)
- [1280×720 布局](evidence/stage2-1280.png) / [1920×1080 布局](evidence/stage2-1920.png)

## 联调发现与修正

1. 替换演员后，开发模式的 StrictMode 会重新执行 effect。原先在 useMemo 创建播放器、在 effect 清理时移除监听，导致再次挂载后结束监听没有恢复，Wave 画面结束但业务状态仍为 Wave。播放器改在 effect 内创建并成对清理，替换角色后的完整流程已回归通过。
2. 测试中的 range.fill 必须使用完整数字格式，如 0.85；.85 会在浏览器测试工具处报格式错误。已修正测试输入。
3. details 的 open 属性为空字符串也代表展开；诊断测试原先误将其视为关闭，重复切换后无法定位编辑器。已修正展开判断。
4. 能力查找只接受清单自己的字段，拒绝 **proto** / toString 等继承名称；已有回归覆盖。

## 使用及后续工作

启动 npm run dev 后打开首页即可手动导演。展开下方“开发诊断”可查看 SceneState、实际渲染采样与执行命令 JSON。示例原子命令：

```json
{
  "type": "batch",
  "commands": [
    { "type": "select_actor", "actorId": "actor-1", "presetId": "ren" },
    { "type": "set_outfit", "actorId": "actor-1", "outfit": "Suit" },
    {
      "type": "rotate_actor",
      "actorId": "actor-1",
      "mode": "relative",
      "degrees": 45
    },
    { "type": "set_camera", "camera": { "distance": 3.2 } }
  ]
}
```

复验命令：

```powershell
npm run test:stage2
npm run test:stage2:e2e
npm run test:unit
npm run test:e2e
npm run build
npm run check:secrets
```

本阶段已完成计划中的手动导演台。下一阶段在此命令边界接入 Realtime 工具调用；Take/Retake 与生成任务持久化仍按 Stage 4 实施。场景状态当前保存在当前页面会话，刷新会回到初始片场。
