# 交付说明

## 可复现版本

仓库：https://github.com/AlezHibali/Boson26Director

```powershell
npm run release:info
```

输出完整 HEAD SHA 和 dirty 标志。交付应引用已提交且 dirty=false 的 SHA；Git 分支名不能代替精确版本。第五阶段的测试报告记录运行时基线 SHA 与 dirty 状态，最终提交可通过上述命令查询。

## 第三方运行

```powershell
git clone https://github.com/AlezHibali/Boson26Director.git
cd Boson26Director
npm ci
Copy-Item .env.example .env.local
# 编辑 .env.local：只配置服务端 BOSON_API_KEY
npm run doctor
npm run dev
```

需要 Node 24+、WebGL / AudioWorklet 浏览器。打开 http://127.0.0.1:3000。无密钥可运行手动三维预演；语音和生成需要账户权限与额度。生产演示使用 start-local.ps1 -Mode demo，见 [演示手册](DEMO_RUNBOOK.md)。

代码、锁文件、原始 GLB、程序化生成脚本、资产许可、测试和脱敏证据随仓库交付。Mira / Ren 为项目自有程序化资产，许可见 public/actors/LICENSE.txt；依赖按各自包许可分发。本地配置、原始录音、SQLite 和生成视频均不进入 Git。

## 材料状态

| 项目                             | 当前状态                                       |
| -------------------------------- | ---------------------------------------------- |
| 本地代码、启动与验收脚本         | 已提供                                         |
| 精确代码 SHA                     | npm run release:info 输出；每阶段有独立 commit |
| 本地双浏览器、真实服务与回放证据 | 见 STAGE5_VALIDATION.md                        |
| 2–3 分钟公开演示视频 URL         | 待录制和发布                                   |
| 公开远程仓库包含最终交付 SHA     | 待 push 后重新验证；本地 commit 不代表已发布   |
| 项目介绍、构建方式、演示边界     | README 与 DEMO_RUNBOOK.md                      |
| 团队成员与贡献分工               | 待项目负责人填写确认，不推断成员或工作量       |
| 真实麦克风、回声、主观情绪质量   | 待现场人工验收                                 |

本阶段不执行公开部署、push、视频发布或比赛提交。这些是后续明确动作。公开多用户部署需要先增加准入、任务归属、配额和多实例作业管理；当前本地单用户服务不作为匿名公共生成接口发布。

材料按仓库五阶段计划准备；提交前请核对 [比赛官网](https://www.boson.ai/hackathon) 的最新要求。本轮官网抓取不可用，未把既有计划当成已重新验证的当前规则。
