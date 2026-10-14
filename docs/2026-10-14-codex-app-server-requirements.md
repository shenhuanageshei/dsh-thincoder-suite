# 需求：codex app-server 通道（新 runner kind）—— 批 33 · 需求档

- 日期：2026-10-14
- 设计档：[`2026-10-14-codex-app-server-design.md`](./2026-10-14-codex-app-server-design.md)
- 前置事实（2026-10-13/14 实测）：插件的 codex 用法走 `codex exec --json` 子进程；本机该通道在**需要执行命令**的任务上必挂（`Failed to create unified exec process: helper_unknown_error`；联网子系统 `chatgpt.com/backend-api/ps/mcp` 超时），**不需要工具**的简单轮次可用。平台自带 `@deepseek-ai/dsh-subagent-codex`（注册 **`codex`** subagent provider，spawn **`codex app-server --stdio`**），本机已装配（profile `package.json` + `cordis.patch.yml` L12 insert 行），且**协议握手实测通过**（`initialize` 有合法响应，进程存活 15s，见设计档 §2）。

<!-- doc-shape
count-marks: 项|处|条|档|值|步|腿
-->

## 一、总目标

让插件**多一条可选的 codex 通道**：走平台自带的 `codex` subagent provider（官方 app-server 协议），用于**只读/分析类**用法；**不替换**现有 `codex exec` 通道（它保留为后备，且在其它机器/网络下可能仍是最佳路径）。

**判据一句话**：在 `consultModels` / advisor 行上写 `runner.kind = "codex-app-server"`，会诊/评审能通过 app-server 通道拿到 codex 的正文；写 `"codex-cli"` 仍走旧通道；两者语义、失败面、证据面各自可辨。

## 二、用户故事（功能层）

- **US-1**：作为使用者，我能在 `consultModels` 里写一行 `{ "runner": { "kind": "codex-app-server" } }`，会诊时该行通过 app-server 通道产出正文。
- **US-2**：我能在 advisor 的组配置/会话覆盖里选这条通道（与 `codex-cli` 并列、互斥），用于 code review 的 codex 行。
- **US-3**：通道不可用时（平台未装配该 provider / app-server 起不来 / 轮次失败），**失败原因可诊断**：digest/报告里能看到平台侧错误码与原因，而不是一句「不可诊断」。
- **US-4**：我能在设置页与 `advisor_config` 里选择 `codex-app-server`，非法值被拒绝并给出合法集。
- **US-5**：拿不到「模型/effort 行级覆盖」时（见非目标），**配置面如实告知**：该通道不消费 `model`/`effort` 字段——不得静默忽略。
- **US-6**：通道选择**可回退**：任一档位改回 `codex-cli` 即恢复旧行为，零残留。

## 三、非功能标准

- **N-1 契约锁不破**：`subagents.start` 的参数字面仍 ⊆ 平台已知九键并集（`prompt/parent/signal/agentOptions/toolFilter/outputSchema/persona/label/maxDepth`）；本通道**只发** `prompt/parent/signal` **+ 可选 `label`**（`label` **不在**平台能力闸内：`dsh-subagent/lib/index.js:3174-3195` 的 `assertCapabilities` 只查 `agentOptions`/`outputSchema`/`maxDepth`/`toolFilter`/`persona`，`label` 在 `:3120-3124` 进 descriptor；其余四键多传即被拒）。
- **N-2 失败面归属**：平台侧失败（provider 未注册 / 能力拒绝 / 轮次 error / max-tokens / aborted）必须映射到插件既有 envelope 语义，**不新增 status 枚举**。
- **N-3 零改面**：不改动 `codex-cli` 通道的任何行为与既有测试期望；不改 `consult`/`advisor` 的既有降级路径。
- **N-4 可测**：新通道的核心逻辑必须有**可在套件内跑**的夹具腿（stub provider/子代理），不得只靠真机。
- **N-5 文档卫生**：`contractWatch` 描述、结项页矩阵、README 的配置字段清单与本批实现**同批同步**。
- **N-6 无人值守边界如实**：该通道对审批**一律拒绝/cancel** ⇒ 只读定位；文档与设置页必须写明，避免被当成「能写工作区的 codex 通道」。
