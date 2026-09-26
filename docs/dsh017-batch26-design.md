# 设计（批 26）：把报告拿回来 —— 作业全文自持落盘 ⊕ 冻结门禁补齐 ⊕ 契约面常设锁

- 日期：2026-09-26
- 状态：**设计待评审**（等用户发起设计评审签发合格证）
- 前序：[`dsh017-full-alignment-design.md`](./dsh017-full-alignment-design.md)（批 25：D-46 作业输出契约 · D-44 指纹基座）· 缺陷登记 [`2026-09-05-defect-registry.md`](./2026-09-05-defect-registry.md)（**D-45** · **D-47**）

## §1 背景与用户故事

**实测事实（2026-09-26，用户重启桌面版后当场复测）**：批 25 把**生产者侧**按 0.1.7 契约修好之后，
`job_output` **依然读不回**——平台自产的作业（`pwsh-22`）与**我们插件自产的作业**（`escalate-dsh-1`，8.4 秒跑完、
`status=completed`、`detail=escalate delivered`）报的是**同一个错**：`Cannot read properties of undefined (reading 'output')`。
⇒ 坏的仍是**读取面**（平台的 `readBody(read)` 读 `read.job.output.spillPaths`，而它拿到的 `read` 里没有 `job`）。
本机还有一层环境事实：桌面 profile 的 pnpm 虚拟店里残留 **39 个 v0.1.7-rc.1** 的 `@deepseek-ai/dsh*`（app 是 rc.2），
其中含 profile 自带的 `dsh-jobs-local` 与 `dsh-tool-jobs` ⇒ **读的一方与被读的一方可能不同代**。

- **US-1**：不管平台那条读取路径好不好用，**后台作业的报告全文都拿得到**（我自己开 shell 也能读到）。
- **US-2**：别的会话/别的模型**不需要再问「怎么绕」**——路径写在派发文案与工具描述里。
- **US-3**：本该拦住的写入**真的被拦住**（冻结集比对不因相对路径而静默放行）。
- **US-4**：平台**下次再换契约**时，第二处、第三处断裂**在改的当下就红**，不再靠人撞。
- **US-5**：同步派发的墙钟陷阱**在派发时**就说清（cap 高于平台墙钟且我没要求后台时，明确提示）。

## §2 方案

### §2.1 D-45：作业全文自持落盘（本批核心 · 直接兑现 US-1/US-2）

在 `lib/job-outcome.mjs` 的**同一收口点**增加落盘：`jobOutcome(handle, outcome)` 在写环的同时，把 `text` 写到
`$DSH_HOME/.thincoder/jobs/<jobId>.txt`（jobId 由调用方传入，沿用 `jobs.start` 的返回 id）；文件为空/写失败**只 warn 不抛**（不得因兜底失败而砖化派发）。
派发文案与 `job_output` 相关描述改为：**首选读落盘文件**，`job_output` 作为附加路径。

### §2.2 D-47：冻结写门禁的相对路径 fail-open

`lib/eng.mjs` 的 `makeWriteGate` 比对冻结集时，`target` 的归一**必须传会话 cwd**（与批 25 的 D-44 同物种）。
**同批更新** `test/guard-e.test.mjs` 的 A2 夹具（该锁把函数体可执行行与夹具逐行等值比对——这是批 25 推迟它的唯一原因）。

### §2.3 契约面常设锁（兑现 US-4）

把批 25 的 9 条平台触点矩阵落成**可执行的形状锁**（新档 `test/platform-surface.test.mjs`）：
每条触点一条断言（如「`spec.run` 的形参个数 === 1」「工具结果消息为 `role:'tool'`」「`jobs.start` 的 `owner` 为 id」
「`normalizeDocPath` 的生产调用点都传基座」），使下一次契约变更**在改的当场**就红。

### §2.4 搭车两项（兑现 US-5 + 评审留转 🔵）

① `background:false` 且 `resolveCodexBudgetCapMs(config) ≥ 平台墙钟` 时，派发文案里**明确说明本路会白等**；
② `test/dsh017-compat.test.mjs` 的中段 import 上移到文件首部（纯可读性）。

## §3 受影响文件

| 文件 | 改动 |
|---|---|
| `lib/job-outcome.mjs` | 增落盘（失败只 warn）· 收口点不变 |
| `lib/eng.mjs` | D-47：`makeWriteGate` 的 `normalizeDocPath(target, cwd)` |
| `lib/advisor.mjs` · `lib/consult.mjs` · `lib/escalate.mjs` | 落盘所需的 jobId 透传 + 派发文案改「首选落盘路径」 |
| `lib/index.mjs` | 工具描述面同步（`job_output` 相关文案） |
| `test/guard-e.test.mjs` | A2 夹具同步（D-47 的必然代价） |
| `test/platform-surface.test.mjs` | **新增**：契约面常设锁 |
| `test/dsh017-compat.test.mjs` | 搭车②：import 上移 |
| `docs/2026-09-05-defect-registry.md` · `docs/test-lifecycle.md` · `CHANGELOG.md` · `README.md` · `package.json` | 登记级联与版本 |

## §4 决策

| # | 决策 | 理由 |
|---|---|---|
| D26-1 | 落盘放**收口点**（`jobOutcome`），不放各派发点 | 与批 25 同一条理由：契约面收口，再来一次变更只改一处 |
| D26-2 | 落盘**失败只 warn**、不改变作业 status | 兜底不得变成新的失败源 |
| D26-3 | D-47 与 guard-e 夹具**同一批**改 | 批 25 推迟它的原因就是「改了函数体就撞夹具」；同批改才是正解 |
| D26-4 | 环境层（profile 的 rc.1 残留）**不经本批交付**，走 `scripts/fix-desktop-core-skew.ps1` 的**最小可证伪实验** | 那是机器层面、需在 app 关闭时执行；本批只保证「平台坏了也拿得到报告」 |

## §5 锚与判据

### §5.1 机验锚

| 锚 | 检索目标 | 谓词 | 期望 |
|---|---|---|---|
| **A1** | `lib/job-outcome.mjs` | 调用 `jobOutcome(handle, { output })` | 环里在写、盘上同时出现正文文件，两者内容一致 |
| **A2** | 同上 | 落盘目录不可写 | 只 warn，**不抛**、不改 outcome |
| **A3** | `lib/eng.mjs` 的 `makeWriteGate` | 伪造相对路径 `target` | 命中冻结集 ⇒ 被拦（不再 fail-open） |
| **A4** | `test/platform-surface.test.mjs` | 9 条触点逐条断言 | 全绿；任一条被改回旧契约 ⇒ 该条红 |
| **A5** | 派发文案 | `resolveCodexBudgetCapMs ≥ 墙钟` 且 `background:false` | 文案含明确的「本路会白等」提示 |

### §5.2 验收标准

| # | 验收标准 | 层 | 锚 | US |
|---|---|---|---|---|
| **AC-1** | 作业结算后，`$DSH_HOME/.thincoder/jobs/<jobId>.txt` 存在且内容 = 报告正文 | T1 | A1 | US-1 |
| **AC-2** | 落盘失败不影响作业与派发（只 warn） | T1 | A2 | US-1 |
| **AC-3** | 冻结集比对对相对路径不再放行 | T1 | A3 | US-3 |
| **AC-4** | 9 条触点各有一条常设锁，且能各自独立转红 | T1 | A4 | US-4 |
| **AC-5** | 同步路径的墙钟陷阱在派发时被点明 | T2 | A5 | US-5 |
| **AC-6** | 登记级联（登记表 D-45/D-47 收口 · 台账 · CHANGELOG · 版本号） | T3 | — | US-2 |

## §6 边界（本批不做）

- **不修平台的 `job_output`**（不在本仓）：`scripts/fix-desktop-core-skew.ps1` 是一次**可回退的环境实验**，结果另行记录。
- **不碰**批 25 已交付的契约面（D-46/D-44）。

## §7 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-26 | 首版：D-45 落盘兜底 · D-47 冻结门禁 · 契约面常设锁 · 搭车两项；含实测证据（重启后 `job_output` 仍崩 · 平台与插件作业同错）· 决策 D26-1…D26-4 · 锚 A1…A5 · AC-1…AC-6 |
