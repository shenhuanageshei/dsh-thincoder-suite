# 后台作业全文读不回：现象、绕行方式、永久修法

- 日期：2026-09-25
- 性质：**常设运维说明**（非批次档）——记录一个**平台侧**缺陷的现场绕行方式，供本机（及同类部署）的**任何会话直接照用**，不必再自行摸索一遍
- 适用：DSH 0.1.7-rc.2 桌面版（`$DSH_HOME` = `C:\Users\magic\.dsh`）；其它版本先复现再照用
- 相关批次：**批 26（D-45）已交付**——全文现在落在 `$DSH_HOME/.thincoder/jobs/<jobId>.txt`（并追加 `index.jsonl` 记 `pathForm`），派发文案与工具描述已改为「首选读落盘文件」；**本文档描述的绕行手段已被取代，仅作历史留档**

## §1 现象（逐字）

调 `job_output({ job_id })` 读任何由本插件派发的后台作业，抛：

```text
Cannot read properties of undefined (reading 'output')
```

截至 2026-09-25 的**四次**复现：`advisor-dsh-1` · `advisor-dsh-3`（advisor 评审）· `consult-1`（会诊）· **`pwsh-315`（平台自己的后台 pwsh 作业）**。

**★ 定性更正（2026-09-25 二次核查）**：这不是「DSH 没有这个机制」——**机制在**：`job_output` / `job_list` / `job_kill` 由 `@deepseek-ai/dsh-tool-jobs` 提供。0.1.7-rc.2 的读取实现是 `readBody(read)`，它读 **`read.job.output.spillPaths`**，即**期望新形态** `{ chunks, lossy, result?, job }`。而 `job_list` 正常、不存在的 id 报干净的 `unknown job …` ⇒ 工具在、作业找得到，**坏的只是「读输出」这一步**：**读的一方与被读的一方不是同一代代码**（本机 profile 的 pnpm 店里残留着 **39 个 0.1.7-rc.1** 的 core 包，而 app 里是 rc.2；这是便携版→桌面版迁移留下的两代并存）。

**★ 另更正一处我自己的错**：早前把 `job_list()` 也算作一次「复现」是**我的调用姿势错误**——它不带参数调用，在 Code-Mode 边界就被拒（报的是另一条 `binding arguments must be lossless JSON`），与本缺陷无关；用 `job_list({})` 调用**完全正常**。

**★ 作业本身是成功的**：派发成功、跑完、完成通知也照常到达——坏的只有「读全文」这一条路径。

## §2 为什么一定会撞上

插件的派发文案写着「完成通知只含一行指针，全文经 `job_output` 读取」，于是任何会话拿到通知后的第一步就是调它，然后卡在那里。**这不是描述写错了，而是平台这条读取路径坏了**——描述在平台修好之前是一条无效指引。

## §3 立刻可用的绕行（按机制，均已实测）

| 机制 | 全文落在哪 | 怎么读 |
|---|---|---|
| **advisor**（`type=code` / `type=design`） | `$DSH_HOME/.thincoder/session-state.json` → `sessions[<会话 id>].lastAdvisorOutput` | 读该 JSON，取对应会话的 `lastAdvisorOutput`。**已验证**：2026-09-25 的两次评审全文都是这样拿到的 |
| **consult**（会诊） | `docs/consult-minutes/<日期>-consult-<id>-minutes.md` | 直接读纪要文件。台账 `$DSH_HOME/.thincoder/consult-ledger.jsonl` 的 `settled` 行带 `minutesPath`，可据此定位（机制在 settle 时**先落盘、再让作业完成**） |
| **eng_coder / escalate**（后台路径） | **没有落盘** —— 见 §4 | 走 §4 的三条应急 |

## §4 缺口：eng_coder / escalate 的交付报告没有落盘

`lib/eng.mjs` 把交付报告放进作业的 `output`（`:863` / `:999`）**并且只放那里**；磁盘上只有**簿记**（touchedFiles 等写进 `session-state.json`），不是报告正文。所以 `job_output` 坏着的时候，**eng_coder 的交付报告读不到**。

三条应急（按代价从小到大）：

1. **改同步派发**：调 `eng_coder` / `escalate` 时显式传 `background: false` —— 报告随工具返回值直接回来，完全不走作业读取路径。代价：受平台单次调用的墙钟约束（插件会按 `codexCli.budgetCapMs` 钳制并**响亮告警**），过长的任务跑不完。
2. **拆小任务**：把长任务切成几个短任务，每个都能在墙钟内同步跑完。
3. **接受簿记面**：`session-state.json` 里的 `touchedFiles` / 轮次变化仍会落盘（那部分不丢），但**交付报告正文会丢**——只在实在拿不到时才接受。

## §5 撞上时不要做什么

- **不要判作业失败**——它是成功的；也不要重试派发（重复消耗预算与评审轮次）。
- **不要用 `job_output({ wait: true })` 阻塞等待**——它本身就是坏的那条路径。
- **不要另找地方猜**：先照 §3 找；eng/escalate 找不到就照 §4 应急，并把这一次记下来（台账/登记表）。

## §6 永久修法（批 25 / D-45，已立项）

两条一起做：

1. **每次后台作业 settle 时把全文落盘**到 `$DSH_HOME/.thincoder/jobs/<kind>-<n>.txt`，并在派发文案里给出这个路径（工具描述同步）。
2. 派发文案改为**首选落盘路径、`job_output` 作为附加**——平台修好后前者依然有效，不会再出现「描述指向一条坏路径」。
3. **本机侧的对齐（与插件无关，但值得做）**：让 profile 的 core 包与 app 同代（清掉 `profiles/desktop/node_modules/.pnpm` 里那批未再被 lock 引用的 0.1.7-rc.1 残留、按 app 的版本重装 profile 依赖）——**请在 app 关闭时做**。做完用一次平台自产作业复测：`pwsh` 带 `run_in_background: true` 起一个 2 秒的作业，再用 `job_output` 读；读得回 ⇒ 不配对已消除；仍读不回 ⇒ 是 rc.2 自身的 bug，可按上面两处形状差异（`readBody` 期望 vs `readJob` 返回）向上游报。

## §7 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-25 | 首版：三次复现 · 两条已验证绕行 · eng/escalate 落盘缺口 · 三条应急 · 永久修法指向批 25（D-45） |
| 2026-09-25 | **二次核查订正**：复现改为四次（补 `advisor-dsh-3` 与**平台自产的 `pwsh-315`**）· **定性更正**为「机制在、是本机两代 core 包不配对」· 撤掉误记的 `job_list()` 一次（我的调用姿势错，`job_list({})` 正常）· 永久修法补第 3 条（本机对齐 + 复测办法） |
