# 设计（批 25）：插件对 DSH 0.1.7-rc.2 的全面契约对齐

- 日期：2026-09-26
- 缺陷登记：[`2026-09-05-defect-registry.md`](./2026-09-05-defect-registry.md)（**D-44** 文档集指纹基座 · **D-46** 作业输出契约 · D-45 兜底，见 §7）
- 需求来源：**实况故障**（用户在桌面版上实测：后台作业的报告正文读不回）。本批是缺陷修复，需求层折入 §1。
- 状态：**已交付（批 25 · 提交 `510ace3`）**——实现由子代理执行、主代理逐项实证验收；交付评审第 1 轮的 1🔴/1🟡/3🔵 已全部处置（见 §8 与登记表）

<!-- doc-shape
anchors: 机验锚
acs: 验收标准
-->

## §1 背景与用户故事

**目标**：插件的代码**按 0.1.7-rc.2 的契约**把活交出去，而不是让使用者去绕。判据不是「能跑」，而是「每一处平台触点都对着 0.1.7-rc.2 的实现在代码层对齐了」。

- **US-1**：后台作业（评审 / 会诊 / 工程 / 飞刀）跑完后，**报告正文能被模型读到**（0.1.7 的读法）。
- **US-2**：即使读到的是别的一代运行时，报告正文也**不丢**。
- **US-3**：设计评审签发的「合格证」**真的绑定了文档集**（相对路径的 `documents` 也绑得上），续期与「文件改了要重审」两道闸恢复有效。
- **US-4**：上述两条都有**回归锚**，把「改回旧契约」变成红灯。
- **US-5**：插件**全部平台触点**有一份对着两代实现逐条给定论的矩阵，杜绝「第四处断裂靠人撞」。

## §2 契约差（两版源码逐字对照）

### §2.1 D-46：作业输出契约（本次的核心）

| 面 | 0.1.6（插件当前写法） | 0.1.7-rc.2（必须对齐） |
|---|---|---|
| 生产者入口 | `const hooks = spec.run()` —— **无参** | `const hooks = spec.run(handle)`，handle = `{ id, append(text, options), updateProgress(line) }` |
| 模型可见正文从哪来 | `done` 的 outcome 里 **`output`** 字段 ⇒ `job.output = outcome.output`；`read()` 返回 `{ text: job.output ?? "", snapshot }` | 由 **输出环**承载：`handle.append(...)`（生产者）或 `spec.output` 源泵入（平台）；`read()` 返回 `{ chunks, lossy, result?, job }`，`settle` 只写 **`job.result = outcome.result`** —— **`job.output` 这个字段已不存在** |
| 插件的现状 | 7 处派发全部 `run: () => ({ cancel, done })`，`done` 解析为 `{ status, detail, output }` | ⇒ **既不往环里写、也不返回 `result`** ⇒ 在 0.1.7 下**报告正文根本到不了模型**（即使读的接口不崩） |

**7 处落点**：`lib/advisor.mjs`（advisor-codex · advisor-dsh）· `lib/consult.mjs`（consult）· `lib/eng.mjs`（eng-codex · eng-dsh）· `lib/escalate.mjs`（escalate-codex · escalate-dsh）。

### §2.2 D-44：文档集指纹的路径基座

`lib/doc-hash.mjs` 的 `normalizeDocPath(p)` 实现为 `resolve(String(p))` —— **`resolve` 不带基座 ⇒ 退化成 `process.cwd()`**。DSH 宿主进程的 cwd 是 **profile 目录**（实测令牌记录里写的是 `C:/Users/magic/.dsh/profiles/desktop/docs/…`，该文件不存在；真实路径在项目目录）⇒ 凡**相对路径**的 `documents` 一律读不到 ⇒ `computeDocHash` 按 fail-closed 返回 `ok:false` ⇒ `advisor.mjs` 把 `pendingDocHash` 置 **null**。三条后果：① **指纹门控续期从未生效**（到期只能重跑整轮评审）；② **Guard E 的「文档已变更 ⇒ 重跑评审」没有可比对象**；③ 诊断文案把原因归给「该次评审未绑定文档集」，误导排查方向。

### §2.3 平台触点矩阵（本轮逐条实证；「已修」= 有回归锚）

| # | 触点 | 0.1.6 → 0.1.7-rc.2 的变化 | 结论 |
|---|---|---|---|
| 1 | `ctx.llm.stream` 的消息模型 | **改**：工具结果从 `user` 内的 `tool-result` 块 → 独立 `tool` 角色消息，且**删除了旧形状兼容** | **已修**（D-41，锚 D-41a/b） |
| 2 | `jobs.start` 的 `owner` | **改**：新增 `resolveOwner(owner)` → `agents.get(id)`；owner 由「对象当桶用」变成「必须是 id」 | **已修**（D-42，锚 D-42a/b） |
| 3 | `jobs` 的输出契约 | **改**：`spec.run()` → `spec.run(handle)`；模型可见正文从 `outcome.output`/`job.output` → **输出环（`handle.append` / `spec.output` 泵入）** + `outcome.result` | **本批修**（D-46，锚 A1/A2/A5） |
| 4 | `$DSH_HOME/settings.yaml` | **改**：改名为 `settings.yaml.imported`（home 兜底探测的特征失效） | **已修**（D-40，锚 U6d） |
| 5 | `ctx.subagents.start("spawn", {…})` | **未变**（`prompt`/`parent`/`signal`/`agentOptions`/`toolFilter` 两版一致；会诊 #6 逐项 diff） | 无需改 |
| 6 | `agent` / `session` 形状 | **未变**（`enter()` 两版逐字相同；`header.cwd` / `delegationDepth` / agentPreset 均在） | 无需改 |
| 7 | `ctx.tools.register` / `ctx.systemPrompt.section` | **未变**（插件在 0.1.7 上装配成功、`eng enter` 实测生效即为证） | 无需改 |
| 8 | `ctx.get("connection").requestRejection` | **未变**（D-39 已按该契约接线并通过 7 条栅栏腿） | 无需改 |
| 9 | 作业结果的**读取**面（`job_output`） | 0.1.7 的读法读 `read.job.output.spillPaths`；**本机实测该路径对所有作业（含平台自产）都崩** | **不在本仓**（已登记为环境问题；本批的 D-46 保证「按契约生产」，读法出问题也不丢正文） |

## §3 方案

### §3.1 D-46：按 0.1.7 的契约生产输出

1. **改 `run` 的形参**：`run: () => ({…})` → `run: (handle) => ({…})`。
2. **正文进环**：在生产出正文的位置（评审 / 报告收束处）调用 `handle.append(text)`；`detail` 仍是**短句**（它进的是状态行与完成通知，不是正文）。
3. **outcome 的字段**：`done` 解析为 `{ status, detail, result: text, output: text }` —— **`result` 是 0.1.7 读的字段，`output` 是 0.1.6/rc.1 读的字段，两者是同一个值的别名**（不是两套契约：写两处只为兼容旧运行时不丢正文；一旦确认运行时版本可对齐，`output` 一行可删）。
4. **`append` 用可选链**：`handle?.append?.(text)` —— 旧运行时不会传 handle，缺它时不得抛（否则旧运行时上派发即失败）。

### §3.2 D-44：基座显式化

`normalizeDocPath(p, baseCwd?)` / `computeDocHash(paths, baseCwd?)` 接受**显式基座**；**调用方传会话 cwd**（`agent.session.header.cwd`）而不是让叶子模块去猜 `process.cwd()`。缺基座时**保持现状行为**（向后兼容，fail-closed 不变）。

## §4 受影响文件

| 文件 | 改动 |
|---|---|
| `lib/advisor.mjs` | 2 处 `run(handle)` + `append` + outcome 双字段 |
| `lib/consult.mjs` | 1 处（同上） |
| `lib/eng.mjs` | 2 处（同上） |
| `lib/escalate.mjs` | 2 处（同上） |
| `lib/doc-hash.mjs` | `normalizeDocPath` / `computeDocHash` 增显式基座 |
| `lib/advisor.mjs` · `lib/eng.mjs` | 传给 `computeDocHash` 的基座改为会话 cwd |
| `test/dsh017-compat.test.mjs` | 新增本批锚腿（D46a/D46b/D44a/D44b） |
| `docs/dsh017-full-alignment-design.md` | 本档（含 §6 锚表） |
| `docs/2026-09-05-defect-registry.md` · `docs/test-lifecycle.md` · `CHANGELOG.md` · `package.json` | 登记级联与版本 |

## §5 决策

| # | 决策 | 理由 |
|---|---|---|
| D25-1 | outcome **同时**带 `result` 与 `output` | 本机实测存在两代运行时并存的部署；两字段同值只是别名，代价一行，换来「报告不丢」。**不作双契约**：读法仍以 0.1.7 的环为主线 |
| D25-2 | `append` 走 `handle?.append?.()` | 旧运行时不传 handle；不防会直接抛，把兼容变成故障 |
| D25-3 | 基座**由调用方传**，叶子模块不猜 | 与 D-40 同物种（拿 `process.cwd()` 猜基座已两次致故障）；显式传参是唯一可测的形态 |
| D25-4 | **不动** D-45（作业全文落盘）与 D-44 之外的兜底 | 本批只做契约对齐；兜底是独立取舍，见 §7 |

## §6 锚与判据对照

### §6.1 机验锚（**三要素写全：检索目标 / 谓词 / 期望**）

| 锚 | 检索目标 | 谓词 | 期望 |
|---|---|---|---|
| **A1** | `test/dsh017-compat.test.mjs` 的 D46a | 假 jobs 服务捕获 `spec.run(handle)` 的 handle | `run` 收到了 handle，且**被调用过 `append`**，且 append 的文本等于报告正文 |
| **A2** | 同档 D46b | 捕获 `done` 的 outcome | outcome **同时**含 `result` 与 `output` 且二者等于正文；`detail` 仍是短句（不含正文） |
| **A3** | `lib/doc-hash.mjs` 的 `normalizeDocPath` / `computeDocHash` | 入参面 | 接受显式基座；**缺基座时行为不变**（向后兼容） |
| **A4** | 同档 D44a | 同一份文档，绝对路径 vs 「相对路径 + 基座」 | 两种算法得到**同一个指纹**，且指纹**非空** |
| **A5** | 4 档源码字节 | 静态扫描 | 7 处 `jobs.start` 的 `run` 形参均为 handle 形（`run: (handle)`）——与 `jobs.start({` 计数一一对应 |
| **A6** | `docs/dsh017-full-alignment-design.md` 的平台触点矩阵 | 逐条给定论 | 每条触点都有「已对齐 / 本批修 / 无需改」三类结论之一，无空条 |

### §6.2 验收标准

| # | 验收标准 | 层 | 锚 | US |
|---|---|---|---|---|
| **AC-1** | 后台作业的正文在 0.1.7 下进入输出环（`guard`/`append` 路径真实被走到） | T1 | A1 | US-1 |
| **AC-2** | outcome 双字段可读，报告正文在两代运行时都不丢 | T1 | A2 | US-2 |
| **AC-3** | 相对路径的 `documents` 能算出**非空指纹**，且与绝对路径同值 | T1 | A3 · A4 | US-3 |
| **AC-4** | 7 处派发点全部改为 handle 形，回归锚落地且全量绿 | T1 | A5 | US-4 |
| **AC-5** | 平台触点矩阵落档，每条有定论 | T2 | A6 | US-5 |
| **AC-6** | 登记级联（登记表 D-44/D-46 · 台账 · CHANGELOG · 版本号） | T3 | — | US-5 |

## §7 边界（本批不做）

- **不做 D-45**（作业全文另存一份到 `$DSH_HOME/.thincoder/jobs/`）：它是**兜底**，与「按契约生产」是两件事；本批先把契约对齐做干净，兜底另立取舍（README 已把现场绕行写成常设说明）。
- **不改平台代码**（`job_output` 的读取实现不在本仓）。
- **不动**已修的 D-40 / D-41 / D-42 三处（它们已有各自的回归锚）。

## §8 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-26 | **交付（批 25）**：`lib/job-outcome.mjs` 单点收口 `jobOutcome(handle, outcome)` 落地——四处派发 28 处 outcome 换装（advisor 6 · consult 3 · eng 10 · escalate 9）；`doc-hash` 基座显式化 + 两处调用方传会话 cwd；腿 D-46a/b · D-44a/b ⊕ **D-46-static**（锚 A5 全量静态锁：`run: (handle)` 计数 === `jobs.start({` 计数、四档合计 7、零处无参 run）。交付评审第 1 轮：1🔴（A5 未落地）已补 · 1🟡（D-45 触发列）已改 · 3🔵（result 与 append 同源 · 本档状态行 · 测试档头注）已处置。`node --test` 526 → 527；既有结构锁逐字保留（`stageGateNote(` = 5 · `failStop(` = 18） |
| 2026-09-26 | 首版：D-46 作业输出契约 + D-44 指纹基座；含两版源码逐字对照 · 决策 D25-1…D25-4 · 机验锚 A1…A6 · 验收标准 AC-1…AC-6 |
