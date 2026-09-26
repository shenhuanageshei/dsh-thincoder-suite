# 设计（批 26）：把报告拿回来 ⊕ 把验证门归位

- 日期：2026-09-26
- 状态：**已交付（批 26）**——设计评审 5 轮（R1 FAIL → R2 PASS → R3 PASS → R4 FAIL → R5 PASS）· 实现 = eng_coder 首轮 + 分歧修复轮 `eng-dsh-1` · 宿主验收：`node --test` 545 条全绿（本行于交付时更新）
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
3. **追溯与取景**：同目录追加 `index.jsonl`，每行 `{ jobId, kind, at, bytes, pathForm }` —— `pathForm` 记录**本次报告是从哪条路径产出的**，取值**钉死枚举**；**判定规则（评审 #4）**：由**收口点按本次结算实际携带正文的通道**判定，**不由 `kind` 静态推出**——调用方传入「本次正文来自哪条通道」（advisor=`session-state` · consult=`consult-minutes` · 环里有字节=`ring` · 只有 `job.result`=`result` · 都没有=`none`）（评审 #8）：`result`（0.1.7 的 `job.result`）· `ring`（输出环）· `session-state`（advisor 的 `lastAdvisorOutput`）· `consult-minutes`（会诊纪要）· `none`（无正文），把用户报的「advisor 三形态并存、条件不明」从**猜**变成**可查**（攒几次即可看出条件）。
4. **扩面**：四条机制（advisor · consult · eng · escalate）的**全文**都落同一目录；advisor 既有 `session-state.lastAdvisorOutput` 保留，但**统一落盘**使「一处读得到」成立。
5. **文案与描述面**：派发文案与 `job_output` 相关工具描述改为「**首选读落盘文件**，`job_output` 作为附加」。
6. **边界**：目录**清扫/轮转不在本批**（与 D-11 的 24h 清扫先例解耦）；跨 owner 撞名时后写覆盖，`index.jsonl` 保证可追溯。
7. **边缘（评审 #10）**：① **作业永不结算**（宿主硬死，登记表 B9 边界）⇒ **不落盘**（没有终态就没有正文），如实写明；② **多会话共用 `DSH_HOME` 并发追加 `index.jsonl`** ⇒ 用**单行 JSON + append 追加**（单行小写入的追加语义足够，不做锁）。

### §2.2 D-47：冻结写门禁的相对路径 fail-open

`lib/eng.mjs` 的 **`makeDocFreezeGate`**（:357-387，**不是** `makeWriteGate`——审计第 ④-1 条订正）比对冻结集时，`target` 的归一**必须传会话 cwd**——来源与线程化点**与 D-44 同款**：`agent.session.header.cwd`，在 `makeWriteGate` 的构造调用点透传（评审 #4 要求点名，A26-3 才写得出来）。**实测代价订正（审计 ④-1）**：A2 夹具只锁 `makeWriteGate` 的**可执行行**，与 `makeDocFreezeGate` 无交集 ⇒ **夹具零改动**（T-E17 全绿）。批 25 推迟 D-47 的真实原因是「当时未定位到落点函数」，不是夹具冲突。

### §2.3 契约面常设锁（**已按裁定补「触点 → 断言」对照表**）

新档 `test/platform-surface.test.mjs`，九条触点各一条可独立转红的断言：

| 触点（批 25 矩阵 #） | 断言什么 |
|---|---|
| #1 llm 工具结果消息 | advisor 构造的工具结果满足 `role:'tool'` + 消息级 `toolCallId`/`isError`，且全档零处旧形状 |
| #2 `jobs.start` 的 owner（**derived**：与 D-42b 同锁，未来新增派发点须**两处同改**） | 四档 `jobs.start(` 处数 === `ownerIdOf(agent)` 处数（=== 7），零处直传 Agent 对象 |
| #3 jobs 输出契约（**derived**：与 D-46-static 同锁，两处同改） | 四档 `run` 形参个数 === 1（收 handle），且 `jobOutcome(` 被四处派发调用 |
| #4 `settings.yaml` 改名（**derived**：与 U6d 同锁，两处同改） | home 探测函数**同时接受** `settings.yaml` 与 `settings.yaml.imported` |
| #5 `subagents.start` 形状 | 调用点的参数键集合 ⊆ {prompt,parent,signal,agentOptions,toolFilter,outputSchema}（出现集合外键即红） |
| #6 agent/session 字段 | 具体谓词：桩上 `session.header.cwd` 为**非空字符串**、`session.id` 非空、`options.provider/model` 为字符串（评审 #9 要求实谓词，非「存在性」） |
| #7 注册面 | 期望计数 = **实测基线并写死**（`ctx.tools.register` 与 `systemPrompt.section` 各 N 处，N 于实现时由 fresh grep 实测填入本行；「不变」以该数字为准，评审 #9） |
| #8 `connection.requestRejection` | 处理函数**首个**调用是信任栅栏（D-39 腿复述） |
| #9 读取面（不在本仓） | **插件侧取向**：派发文案含「首选落盘路径」字样（文本锁） |

**新腿落档点名**（消解「腿没写住哪」）：A26-1/A26-2 → `test/dsh017-compat.test.mjs`（扩 D-46 组）· A26-3 → `test/guard-e.test.mjs` · A26-4/A26-6/A26-7 → `test/platform-surface.test.mjs` · **A26-5（墙钟文案）→ `test/dsh017-compat.test.mjs`**（派发文案断言已在该档）。

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
  **D48-5（审计 ②-D2 的裁定）**：宿主验收执行面（`runOneHostCheck` · `runHostStageChecks`，含其 `setTimeout`）**抽成新 leaf 模块 `lib/host-check.mjs`**，`lib/eng.mjs` 只 import。理由：常驻锁 `T-AP7` 把 `lib/{advisor,eng,escalate,consult}.mjs` 的定时器时长标识逐字钉死，且**同时**与 HEAD 源交叉核验 ⇒ 新增定时器后「当前源 == 表」与「HEAD 源 == 表」**结构上不可同时成立**。走 leaf 模块 ⇒ 锁**零改动**、T-AP7 自动绿；另一条路（改 T-AP7）属**锁弱化**，本批不取。

**执行信封（评审 #3 要求钉死）**：cwd = **会话 cwd**（`agent.session.header.cwd`）· shell = 宿主默认 shell（**Windows 上实测为 `%ComSpec%`＝cmd.exe**，因实现用 `spawn(cmd,{shell:true})`——审计 ④-2 订正）· **独立超时** `HOST_CHECK_TIMEOUT_MS = 120000`，到点收敛为 `check timed out` 回执（**background 路径**下回执在 job 内，不占调用回合；**同步路径**下回执在 return 前 await，最坏 120s × host 阶段数——审计 ④-3 要求写明这一语义）· 命令失败 ⇒ 回执 **FAIL**，**作业状态不变**（验收回执不是作业终态）。
  ⚠️ **已知代价（须同批处理）**：`lib/**` 会新增一个子进程调用点 ⇒ 撞既有锁 **T-SG4「零新执行面：`lib/**` 的 `child_process` 计数必须为 1」**。这是**有意的设计变更**，与 D-47 撞 guard-e A2 同性质 ⇒ **同批改该锁并在档内写明理由**。
  **备选（**已否决，留档**——D26-5 裁定走 leaf 模块）**：只做 D48-1/D48-3，把「宿主跑 check」留给流程（主代理执行）——零新执行面，但门仍依赖执行者自觉。**决策点 D26-5。**
- **D48-3 兜底信封可操作化**：`dshBackgroundTimeoutMs` 兜底触发时，信封**附上 stages 的 check 命令原文** + 一句取证指路：「若 Partial output 为空且验证类日志 0 字节 ⇒ 高度疑似沙箱禁子进程 ⇒ 请宿主执行上述命令；本报告已附改动文件清单」。⇒ 本次是人肉翻会话导出才查清的，这条把它变成一眼可见。
- **D48-4 上游建议（不写码）**：沙箱拒绝子进程时应**报错**（fail-closed），而不是**挂住**——挂住只能靠 30/60 分钟兜底，代价是整轮时间。写进登记表与对外报告的建议段。

## §3 受影响文件（**已按第 1 轮 🔴 订正：eng 纳入授权面**）

| 文件 | 改动 |
|---|---|
| `lib/job-outcome.mjs` | 落盘（jobId 自取 `handle?.id`）+ `index.jsonl` + `pathForm`；失败只 warn |
| `lib/advisor.mjs` · `lib/consult.mjs` · `lib/eng.mjs` · `lib/escalate.mjs` | 四档**派发文案**改「首选落盘路径」（D-45）；`checkMode` 渲染与兜底信封（含 check 命令）**只在有 stages 的机制**（eng；escalate 若有 stages 则一并，advisor/consult 无 stages 不涉） |
| `lib/eng.mjs` | D-47：**`makeDocFreezeGate`** 的 `normalizeDocPath(target, cwd)`（审计 ④-1；A2 夹具不动）；D-48：checkMode 与宿主验收回执的**调用侧**（执行面见 `lib/host-check.mjs`） |
| `lib/index.mjs` | 工具描述与 stages schema（`checkMode`）同步 |
| `test/guard-e.test.mjs` | **仅** T-E19 的 `existing` 清单追加新档（分歧审计 ③-G1）——**A2 夹具零改动**（§2.2 代价订正；T-E17 保持绿） |
| `test/stage-gate.test.mjs` | T-SG4「零新执行面」锁按 **D26-5（已裁定采纳）** 改：新增执行面落在 **`lib/host-check.mjs`（D48-5）**，故该锁的字面表与计数按该文件同批更新（理由已写明） |
| `lib/host-check.mjs` | **新增（D48-5）**：宿主验收执行面（含独立超时与 spawn），使 `lib/eng.mjs` 不引入新定时器 ⇒ T-AP7 零改动 |
| `scripts/fix-desktop-core-skew.ps1` | **在批修正（审计 ④-越界项：收编进清单）**：① 扫描面从 `node_modules/@deepseek-ai+*` 改为 `node_modules/.pnpm`（实测该机 `@scope+name@ver` 形态只在 `.pnpm`，HEAD 版**空跑**）② `-Restore` 只取**非空** moved-list（防空备份遮蔽）③ 存为 UTF-8 带 BOM（PS 5.1 解析需要） |
| `test/platform-surface.test.mjs` | **新增**：九条触点常设锁 |
| `test/dsh017-compat.test.mjs` | A26-1/A26-2 两条新腿 + 搭车② import 上移 |
| `docs/job-output-fallback.md` | **纳入级联**（评审 #5）：改指 `$DSH_HOME/.thincoder/jobs/<jobId>.txt`，并标「**已被批 26 取代**」（原文案是绕行说明） |
| `docs/2026-09-05-defect-registry.md` · `docs/test-lifecycle.md` · `CHANGELOG.md` · `README.md` · `package.json` | 登记级联与版本 |

## §4 决策

| # | 决策 | 理由 |
|---|---|---|
| D26-1 | 落盘放**收口点**（`jobOutcome`），不放各派发点 | 契约面收口：再来一次变更只改一处 |
| D26-2 | 落盘**失败只 warn**、不改作业 status | 兜底不得成为新的失败源 |
| D26-3 | D-47 只改 **`makeDocFreezeGate`**，**guard-e A2 夹具零改动** | 审计 ④-1 实测：A2 锁的是 `makeWriteGate` 的可执行行，与落点函数无交集；批 25 推迟的真实原因是当时未定位落点函数 |
| D26-4 | 环境层（profile 的 rc.1 残留）**不经本批交付**，走 `scripts/fix-desktop-core-skew.ps1` 的**最小可证伪实验** | 机器层面、需 app 关闭时执行 |
| **D26-5** | **D48-2 采纳：同批改 T-SG4 锁，把「宿主验收」机制化**（用户 2026-09-26 裁定） | 「宿主复跑为门」若只是纪律，就会重演本次（两次都没拦住） |
| **D26-6** | D-45 **扩面到四条机制**（advisor/consult/eng/escalate 全文统一落盘） | 用户报的「advisor 三形态并存、条件不明」由此变成可查（`pathForm`） |
| **D26-7** | jobId 用 `handle?.id`，**不做调用点透传** | 消解「28 处透传」的宽度与授权面矛盾（第 1 轮 🔴） |
| **D26-8** | 本批锚改名 **A26-1…A26-7** | 消歧 guard-e 既有的「A2 夹具」 |
| **D26-9** | 落盘目录**不做清扫** | 与 D-11 的 24h 清扫解耦，避免本批膨胀 |

## §5 锚与判据

### §5.1 机验锚

| 锚 | 检索目标 | 谓词 | 期望 |
|---|---|---|---|
| **A26-1** | `test/dsh017-compat.test.mjs` | 调 `jobOutcome(handle,{output})` | 环里在写、盘上同时出现正文文件，两者内容一致；**`index.jsonl` 末行可解析为 `{jobId,kind,at,bytes,pathForm}` 且 `pathForm` ∈ 枚举，并跨 advisor/consult/eng/escalate 各跑一次**（评审 #5） |
| **A26-2** | 同上 | 落盘目录不可写 | 只 warn，**不抛**、不改 outcome |
| **A26-3** | `test/guard-e.test.mjs` | 伪造相对路径 `target` | 命中冻结集 ⇒ 被拦（不再 fail-open） |
| **A26-4** | `test/platform-surface.test.mjs` | 九条触点逐条断言 | 全绿；任一条被改回旧契约 ⇒ 该条红 |
| **A26-5** | 派发文案 | `resolveCodexBudgetCapMs ≥ 600000` 且 `background:false` | 文案含明确的「本路会白等」提示 |
| **A26-6** | `checkMode:"host"` 的任务书渲染 | 生成的任务书文本 | **不含**要求子代理执行 check 的措辞，且 stages 的 check 命令被标注「由宿主执行」 |
| **A26-7** | 兜底信封 | 构造一次兜底超时 | 信封含 stages 的 check 命令原文与取证指路句 |
| **A26-8** | 宿主验收回执（D48-2） | 用可注入的超时/命令缝跑一次 host 阶段 | 回执含退出码与尾部输出并进交付文本；失败 ⇒ 回执 FAIL 而**作业 status 不变**；超时 ⇒ 收敛为 `timed out`（**不真等 120s**） |

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
| **AC-8** | 兜底信封自带 check 命令与取证指路；**交付报告含宿主验收回执**（D26-5 已裁定采纳 ⇒ **无条件**） | T1 | A26-7 · A26-8 | US-7 |
| **AC-9** | 登记级联（登记表 D-45/D-47/D-48 收口 · 台账 · CHANGELOG · 版本号） | T3 | — | US-2 |

## §6 边界（本批不做）

- **不修平台的 `job_output`**（不在本仓）；`scripts/fix-desktop-core-skew.ps1` 是一次**可回退的环境实验**（最小可证伪：只移 profile 自带的 `dsh-jobs-local` / `dsh-tool-jobs`），结果另行记录。
- **不做落盘目录的清扫/轮转**（D26-9）。
- **不碰**批 25 已交付的契约面（D-46/D-44）。

## §8 环境实验记录（评审 #7 要求的落点）

**脚本归属**：`scripts/fix-desktop-core-skew.ps1` 是**批 26 的在批交付物**（已随设计档提交 `e48e9d8`），不是既有脚本。

**实验（2026-09-26，用户执行 + 重启）**：脚本按默认**最小可证伪**口径移出 profile 自带的 `dsh-jobs-local`（rc.1）与 `dsh-tool-jobs`（rc.1）——执行**成功**（证据：`profiles/desktop/_core-skew-backup-20260926-114225/` 内含两份目录 + `moved-list.txt`，`.pnpm` 内已无**匹配脚本正则**的 jobs 目录（审计 ④ 订正：`@deepseek-ai+dsh-jobs@0.1.7_…` 仍在，不匹配 `dsh-(jobs-local|tool-jobs)` 故未被移出），顶层 `@deepseek-ai` 仍 5 项）。重启后复测：**`job_output` 依旧崩**（平台自产 `pwsh-1` 同错）⇒ **假设被证伪**：被加载的 jobs 实现**不是** profile 自带副本。

**结论**：读取面缺陷落在**平台自身的包对**（或其间包装器）——属上游问题，本仓不可修；**D-45 的落盘兜底因此是唯一在仓的答案**（本批交付）。上游报告应附：本实验（干净移除 profile 副本后仍崩）+ 宿主自产作业同样崩。

**回退**：`scripts/fix-desktop-core-skew.ps1 -Restore`（把两份目录移回原处）。当前保留「已移出」状态（它们可证未被加载）。

## §7 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-26 | **第 1 轮设计评审处置并入**（用户裁定「全按建议」）：🔴 §3 补 `lib/eng.mjs` 授权并以 `handle?.id` 消解 28 处透传 · 🟡 补「触点→断言」九行对照表 · 🟡 新腿逐条点名落档 · 🟡 锚改名 A26-1…A26-7 · 🟡 文件名/覆盖语义 + `index.jsonl` + 清扫边界 · 🔵 `handle?.id` · 🔵 墙钟常量 600000 · 🔵 空报告/取消两句语义 |
| 2026-09-26 | **分歧审计（第 1 轮）处置并入**：§2.2 落点函数名与「夹具必然代价」订正 · §2.5 shell（cmd.exe）与「不阻塞」语义订正 · **新增 §2.5 D48-5**（宿主验收执行面抽 leaf 模块 `lib/host-check.mjs`，取「锁零改动」路线）· §3 补 `lib/host-check.mjs` 与 `scripts/fix-desktop-core-skew.ps1`（收编越界档）· §5.1 补 **A26-8**（宿主验收回执锚）· §8 两处事实订正 |
| 2026-09-26 | **第 2 轮设计评审处置并入**（PASS 后的 4🟡+6🔵）：#1 A26-5 点名落档 · **#2 D26-5 定案=采纳 D48-2** · #3 D48-2 执行信封钉死（cwd/shell/超时 120s/失败不改作业态）· #4 D-47 的 cwd 来源与线程化点 · #5 `job-output-fallback.md` 纳入级联 · #6 三条 derived 锁标注「两处同改」· #7 脚本归属 + **新增 §8 环境实验记录** · #8 `pathForm` 枚举钉死 · #9 #6/#7 改实谓词与写死基线 · #10 作业永不结算 + `index.jsonl` 并发两条边缘 |
| 2026-09-26 | **用户新报三问题并入**：D-45 **扩面到四条机制**（含 `pathForm` 记录，解「advisor 三形态并存、条件不明」）；**新增 §2.5 D-48**（eng 验证相位起跑即挂死：根因链 + D48-1…D48-4 + 决策点 D26-5）；登记表新增 **D-48（🔴）** |
| 2026-09-26 | 首版：D-45 落盘兜底 · D-47 冻结门禁 · 契约面常设锁 · 搭车两项；含重启后 `job_output` 仍崩的实测证据 · 决策 D26-1…D26-4 · 锚 A1…A5 · AC-1…AC-6 |
