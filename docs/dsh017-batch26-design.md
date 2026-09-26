# 设计（批 26）：把报告拿回来 ⊕ 把验证门归位

- 日期：2026-09-26
- 状态：**设计（第 1 轮评审 FAIL 的 8 条已按用户裁定并入；待用户发起第 2 轮设计评审）**
- 前序：[`dsh017-full-alignment-design.md`](./dsh017-full-alignment-design.md)（批 25：D-46 作业输出契约 · D-44 指纹基座）
- 缺陷登记：**D-45**（作业全文无第二条可读路径）· **D-47**（冻结写门禁相对路径 fail-open）· **D-48**（eng 验证相位起跑即挂死）——见 [`2026-09-05-defect-registry.md`](./2026-09-05-defect-registry.md)

## §1 背景与用户故事

**实测事实 A（2026-09-26，用户重启桌面版后当场复测）**：批 25 把**生产者侧**按 0.1.7 契约修好之后，`job_output` **依然读不回**——平台自产的作业（`pwsh-22`）与**我们插件自产的作业**（`escalate-dsh-1`，8.4 秒跑完、`completed`、`delivered`）报的是**同一个错** `Cannot read properties of undefined (reading 'output')`。⇒ 坏的仍是**读取面**（不属本仓）。本机另有一层环境事实：桌面 profile 的 pnpm 虚拟店里残留 **39 个 v0.1.7-rc.1** 的 `@deepseek-ai/dsh*`（含 profile 自带的 `dsh-jobs-local` 与 `dsh-tool-jobs`），而 app 是 rc.2。

**实测事实 B（会话 `session-625c6f0d` 现场，稳定复现）**：`eng-dsh-13` 三阶段文件编辑**全部落地**（最后写入 07:51:33），随后启动**自身验证**（创建 `.pytest_full.log`）——**日志 0 字节、约 8 分钟无输出**，最终被 `dshBackgroundTimeoutMs` 兜底掐死，报告显示 `status: failed`。而**宿主跑同一条命令 7.24 秒全绿**（424 passed / 7 skipped）。同会话 `eng-dsh-5` 同款失败（**2/3 次**）。⇒ 交付本身完成且正确；**死的只是「子代理自己跑验证」这一步**，而它**既不报错也不返回**。

- **US-1**：不管平台那条读取路径好不好用，**后台作业的报告全文都拿得到**（我自己开 shell 也能读到）。
- **US-2**：别的会话/别的模型**不需要再问「怎么绕」**——路径写在派发文案与工具描述里。
- **US-3**：本该拦住的写入**真的被拦住**（冻结集比对不因相对路径而静默放行）。
- **US-4**：平台**下次再换契约**时，第二处、第三处断裂**在改的当下就红**，不再靠人撞。
- **US-5**：同步派发的墙钟陷阱**在派发时**就说清。
- **US-6（新）**：**验证门归位**——「谁来跑 check 命令」由**派发参数**决定（dsh 路径默认宿主），不再靠任务书里一句可能被忽略的免责声明。
- **US-7（新）**：**挂死可诊断**——兜底掐死时的信封**自带 stages 的 check 命令与取证指路**，宿主一条命令即可验收，不必再去翻会话导出。

## §2 方案

### §2.1 D-45：全文自持落盘（**已按裁定扩面到四条机制**）

1. **收口点**仍是 `lib/job-outcome.mjs` 的 `jobOutcome(handle, outcome)`；**jobId 自取**：`jobId = handle?.id`（0.1.7 的 handle 自带 `id`）——**因此不需要在 28 个调用点透传**；旧运行时（不传 handle）没有 id ⇒ **不落盘**（如实写明，这是兼容代价）。
2. **落盘**：`$DSH_HOME/.thincoder/jobs/<jobId>.txt`；空报告**也写文件**（内容为空串，AC 判据是「文件存在」）；写失败**只 warn 不抛**、不改作业 status。
3. **追溯与取景**：同目录追加 `index.jsonl`，每行 `{ jobId, kind, at, bytes, pathForm }` —— `pathForm` 记录**本次报告是从哪条路径产出的**（如 `result` / `ring` / `session-state`），把用户报的「advisor 三形态并存、条件不明」从**猜**变成**可查**（攒几次即可看出条件）。
4. **扩面**：四条机制（advisor · consult · eng · escalate）的**全文**都落同一目录；advisor 既有 `session-state.lastAdvisorOutput` 保留，但**统一落盘**使「一处读得到」成立。
5. **文案与描述面**：派发文案与 `job_output` 相关工具描述改为「**首选读落盘文件**，`job_output` 作为附加」。
6. **边界**：目录**清扫/轮转不在本批**（与 D-11 的 24h 清扫先例解耦）；跨 owner 撞名时后写覆盖，`index.jsonl` 保证可追溯。

### §2.2 D-47：冻结写门禁的相对路径 fail-open

`lib/eng.mjs` 的 `makeWriteGate` 比对冻结集时，`target` 的归一**必须传会话 cwd**（与批 25 的 D-44 同物种）。**同批更新** `test/guard-e.test.mjs` 的 A2 夹具（该锁把函数体可执行行与夹具逐行等值比对——这是批 25 推迟它的唯一原因）。

### §2.3 契约面常设锁（**已按裁定补「触点 → 断言」对照表**）

新档 `test/platform-surface.test.mjs`，九条触点各一条可独立转红的断言：

| 触点（批 25 矩阵 #） | 断言什么 |
|---|---|
| #1 llm 工具结果消息 | advisor 构造的工具结果满足 `role:'tool'` + 消息级 `toolCallId`/`isError`，且全档零处旧形状 |
| #2 `jobs.start` 的 owner | 四档 `jobs.start(` 处数 === `ownerIdOf(agent)` 处数（=== 7），零处直传 Agent 对象 |
| #3 jobs 输出契约 | 四档 `run` 形参个数 === 1（收 handle），且 `jobOutcome(` 被四处派发调用 |
| #4 `settings.yaml` 改名 | home 探测函数**同时接受** `settings.yaml` 与 `settings.yaml.imported` |
| #5 `subagents.start` 形状 | 调用点的参数键集合 ⊆ {prompt,parent,signal,agentOptions,toolFilter,outputSchema}（出现集合外键即红） |
| #6 agent/session 字段 | 被读取的字段（`session.header.cwd` 等）在桩上有值（读取点存在性） |
| #7 注册面 | `ctx.tools.register` / `systemPrompt.section` 的调用点计数不变（形状漂移即红） |
| #8 `connection.requestRejection` | 处理函数**首个**调用是信任栅栏（D-39 腿复述） |
| #9 读取面（不在本仓） | **插件侧取向**：派发文案含「首选落盘路径」字样（文本锁） |

**新腿落档点名**（消解「腿没写住哪」）：A26-1/A26-2 → `test/dsh017-compat.test.mjs`（扩 D-46 组）· A26-3 → `test/guard-e.test.mjs` · A26-4/A26-6/A26-7 → `test/platform-surface.test.mjs`。

### §2.4 搭车两项

① **墙钟常量**：`background:false` 且 `resolveCodexBudgetCapMs(config) ≥ PLATFORM_RUN_CODE_WALL_MS`（**常量 600000**，与仓内既有「平台 run_code 墙钟 600s」表述同源；平台无注入面，D-16）时，派发文案明确说明「本路会白等」。
② `test/dsh017-compat.test.mjs` 的中段 import 上移到文件首部（纯可读性）。

### §2.5 D-48：eng 验证相位起跑即挂死（**本轮新增，🔴**）

**根因链（三段，都有实证）**：
1. **平台侧**：dsh 子代理**执行子进程**（`python -m pytest … > .pytest_full.log`）时**既不报错也不返回**——日志 0 字节、约 8 分钟无输出。宿主同一命令 **7.24 秒**全绿 ⇒ 不是命令的问题、也不是慢，是**沙箱下的子进程执行会挂住**。
2. **插件侧（真正可修的那一段）**：任务书里**已经写了**逃生条款（「pytest 可跑则跑（沙箱子进程受限时以编译自检 + 测试文件完整交付为准，宿主复跑为门）」），但**结构化 `stages[].check` 字段 + 阶段门语义（stage N 的 check 必须先过）仍在推它去跑** ⇒ 一句埋在文末的免责声明**拦不住**（同一个会话实测两次都没拦住）。
3. **结果**：编辑全部落地、验证相位挂死 ⇒ 报告 `status: failed`，而交付其实是完整且绿的（宿主复跑 424 passed / 7 s）。**代价是整轮排障 + 一次重派裁决。**

**修法（四条）**：
- **D48-1 执行者归位**：新增 `stages[].checkMode`（`"subagent"` | `"host"`）；**dsh 路径默认 `host`**、codex 路径默认 `subagent`。为 `host` 时，任务书**不再出现「跑它」语义**，渲染为「验证命令（**由宿主执行**，你只负责原样报回）」，阶段门文案同步改为「本阶段不要求你执行命令」。⇒ 从根上不进入「子代理跑命令」这条分支。
- **D48-2 宿主验收回执**：dsh 路径交付后，插件在**宿主侧**按 stages 的 check 命令跑一遍，把「退出码 + 尾部输出」写进交付报告与落盘文件（与 §2.1 同一处），并给出 `验收：PASS/FAIL`。⇒「宿主复跑为门」从**口头纪律**变成**机制**。
  ⚠️ **已知代价（须同批处理）**：`lib/**` 会新增一个子进程调用点 ⇒ 撞既有锁 **T-SG4「零新执行面：`lib/**` 的 `child_process` 计数必须为 1」**。这是**有意的设计变更**，与 D-47 撞 guard-e A2 同性质 ⇒ **同批改该锁并在档内写明理由**。
  **备选（若你否决改锁）**：只做 D48-1/D48-3，把「宿主跑 check」留给流程（主代理执行）——零新执行面，但门仍依赖执行者自觉。**决策点 D26-5。**
- **D48-3 兜底信封可操作化**：`dshBackgroundTimeoutMs` 兜底触发时，信封**附上 stages 的 check 命令原文** + 一句取证指路：「若 Partial output 为空且验证类日志 0 字节 ⇒ 高度疑似沙箱禁子进程 ⇒ 请宿主执行上述命令；本报告已附改动文件清单」。⇒ 本次是人肉翻会话导出才查清的，这条把它变成一眼可见。
- **D48-4 上游建议（不写码）**：沙箱拒绝子进程时应**报错**（fail-closed），而不是**挂住**——挂住只能靠 30/60 分钟兜底，代价是整轮时间。写进登记表与对外报告的建议段。

## §3 受影响文件（**已按第 1 轮 🔴 订正：eng 纳入授权面**）

| 文件 | 改动 |
|---|---|
| `lib/job-outcome.mjs` | 落盘（jobId 自取 `handle?.id`）+ `index.jsonl` + `pathForm`；失败只 warn |
| `lib/advisor.mjs` · `lib/consult.mjs` · `lib/eng.mjs` · `lib/escalate.mjs` | **派发文案**改「首选落盘路径」；**D-48** 的 `checkMode` 渲染与兜底信封（含 check 命令） |
| `lib/eng.mjs` | D-47：`makeWriteGate` 的 `normalizeDocPath(target, cwd)`；D-48：checkMode 与验收回执 |
| `lib/index.mjs` | 工具描述与 stages schema（`checkMode`）同步 |
| `test/guard-e.test.mjs` | A2 夹具同步（D-47 的必然代价） |
| `test/stage-gate.test.mjs` | T-SG4「零新执行面」锁按 D26-5 的裁定改（若采纳 D48-2） |
| `test/platform-surface.test.mjs` | **新增**：九条触点常设锁 |
| `test/dsh017-compat.test.mjs` | A26-1/A26-2 两条新腿 + 搭车② import 上移 |
| `docs/2026-09-05-defect-registry.md` · `docs/test-lifecycle.md` · `CHANGELOG.md` · `README.md` · `package.json` | 登记级联与版本 |

## §4 决策

| # | 决策 | 理由 |
|---|---|---|
| D26-1 | 落盘放**收口点**（`jobOutcome`），不放各派发点 | 契约面收口：再来一次变更只改一处 |
| D26-2 | 落盘**失败只 warn**、不改作业 status | 兜底不得成为新的失败源 |
| D26-3 | D-47 与 guard-e 夹具**同批**改 | 批 25 推迟它的原因正是「改了函数体就撞夹具」 |
| D26-4 | 环境层（profile 的 rc.1 残留）**不经本批交付**，走 `scripts/fix-desktop-core-skew.ps1` 的**最小可证伪实验** | 机器层面、需 app 关闭时执行 |
| **D26-5** | **D48-2 采纳与否 = 是否同批改 T-SG4 锁**（建议：**采纳**，把门机制化；备选只做 D48-1/D48-3） | 「宿主复跑为门」若只是纪律，就会重演本次（两次都没拦住） |
| **D26-6** | D-45 **扩面到四条机制**（advisor/consult/eng/escalate 全文统一落盘） | 用户报的「advisor 三形态并存、条件不明」由此变成可查（`pathForm`） |
| **D26-7** | jobId 用 `handle?.id`，**不做调用点透传** | 消解「28 处透传」的宽度与授权面矛盾（第 1 轮 🔴） |
| **D26-8** | 本批锚改名 **A26-1…A26-7** | 消歧 guard-e 既有的「A2 夹具」 |
| **D26-9** | 落盘目录**不做清扫** | 与 D-11 的 24h 清扫解耦，避免本批膨胀 |

## §5 锚与判据

### §5.1 机验锚

| 锚 | 检索目标 | 谓词 | 期望 |
|---|---|---|---|
| **A26-1** | `test/dsh017-compat.test.mjs` | 调 `jobOutcome(handle,{output})` | 环里在写、盘上同时出现正文文件，两者内容一致 |
| **A26-2** | 同上 | 落盘目录不可写 | 只 warn，**不抛**、不改 outcome |
| **A26-3** | `test/guard-e.test.mjs` | 伪造相对路径 `target` | 命中冻结集 ⇒ 被拦（不再 fail-open） |
| **A26-4** | `test/platform-surface.test.mjs` | 九条触点逐条断言 | 全绿；任一条被改回旧契约 ⇒ 该条红 |
| **A26-5** | 派发文案 | `resolveCodexBudgetCapMs ≥ 600000` 且 `background:false` | 文案含明确的「本路会白等」提示 |
| **A26-6** | `checkMode:"host"` 的任务书渲染 | 生成的任务书文本 | **不含**要求子代理执行 check 的措辞，且 stages 的 check 命令被标注「由宿主执行」 |
| **A26-7** | 兜底信封 | 构造一次兜底超时 | 信封含 stages 的 check 命令原文与取证指路句 |

### §5.2 验收标准

| # | 验收标准 | 层 | 锚 | US |
|---|---|---|---|---|
| **AC-1** | 作业结算后 `$DSH_HOME/.thincoder/jobs/<jobId>.txt` 存在且内容 = 报告正文（空报告也写文件） | T1 | A26-1 | US-1 |
| **AC-2** | 落盘失败不影响作业与派发（只 warn） | T1 | A26-2 | US-1 |
| **AC-3** | 冻结集比对对相对路径不再放行 | T1 | A26-3 | US-3 |
| **AC-4** | 九条触点各有一条常设锁，且能各自独立转红 | T1 | A26-4 | US-4 |
| **AC-5** | 同步路径的墙钟陷阱在派发时被点明 | T2 | A26-5 | US-5 |
| **AC-6** | 四条机制的全文都落在同一目录，且 `index.jsonl` 记录 `pathForm` | T1 | A26-1 | US-2 |
| **AC-7** | `checkMode:"host"` 下任务书不含「要求子代理执行验证命令」的措辞 | T2 | A26-6 | US-6 |
| **AC-8** | 兜底信封自带 check 命令与取证指路；若采纳 D48-2，则交付报告含宿主验收结论 | T1 | A26-7 | US-7 |
| **AC-9** | 登记级联（登记表 D-45/D-47/D-48 收口 · 台账 · CHANGELOG · 版本号） | T3 | — | US-2 |

## §6 边界（本批不做）

- **不修平台的 `job_output`**（不在本仓）；`scripts/fix-desktop-core-skew.ps1` 是一次**可回退的环境实验**（最小可证伪：只移 profile 自带的 `dsh-jobs-local` / `dsh-tool-jobs`），结果另行记录。
- **不做落盘目录的清扫/轮转**（D26-9）。
- **不碰**批 25 已交付的契约面（D-46/D-44）。

## §7 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-26 | **第 1 轮设计评审处置并入**（用户裁定「全按建议」）：🔴 §3 补 `lib/eng.mjs` 授权并以 `handle?.id` 消解 28 处透传 · 🟡 补「触点→断言」九行对照表 · 🟡 新腿逐条点名落档 · 🟡 锚改名 A26-1…A26-7 · 🟡 文件名/覆盖语义 + `index.jsonl` + 清扫边界 · 🔵 `handle?.id` · 🔵 墙钟常量 600000 · 🔵 空报告/取消两句语义 |
| 2026-09-26 | **用户新报三问题并入**：D-45 **扩面到四条机制**（含 `pathForm` 记录，解「advisor 三形态并存、条件不明」）；**新增 §2.5 D-48**（eng 验证相位起跑即挂死：根因链 + D48-1…D48-4 + 决策点 D26-5）；登记表新增 **D-48（🔴）** |
| 2026-09-26 | 首版：D-45 落盘兜底 · D-47 冻结门禁 · 契约面常设锁 · 搭车两项；含重启后 `job_output` 仍崩的实测证据 · 决策 D26-1…D26-4 · 锚 A1…A5 · AC-1…AC-6 |
