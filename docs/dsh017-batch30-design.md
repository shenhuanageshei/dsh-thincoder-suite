# 批 30 设计 —— 把两条防线**真接上**（D-55 / D-56 / D-57 + 候选池清干）

> **状态**：**第 2 轮设计评审已通过（2026-09-27，`[APPROVE:12b50530]`）**；轮 1/轮 2 均已交付并通过审计与码评（详见 §7）。范围由用户 2026-09-27 裁定为 **B+**（两条真修并入本批）；并行送审的 **会诊 #13** 已回**墓碑 digest（0/5 全灭）**——零意见逐条处置见 [`docs/consult-minutes/2026-09-27-consult-13-minutes.md`](consult-minutes/2026-09-27-consult-13-minutes.md) §2，**不阻塞本裁定**（决策来源是用户本人）；重试 **#14** 台账未 settle；其子会话已观测失败、**形态不同**（`400 server_error`，成因未查——同档 §5）。

## §0 一句话

批 29 交付了两条防线却**在生产上空转**；本批把它们**真接上**——校正读取对象（工具面用 Agent scope 读名域、看门狗改接 `localAgent.session.seq` 与 `ctx` 事件面），并修掉**会丢证据**的落盘缺陷（D-57）。

## §1 需求

### §1.1 总体目标

把「把门禁变可信」从**两兑现（阶段门 · 报告落档）+ 两空转**变成**四兑现**：工具面禁执行真拦得住、静默看门狗真能武装并早停；同时消除「刚拿到的证据被后写覆盖」这一证据链缺陷。

### §1.2 用户故事

- **US-1（工具面真生效）**：作为架构师，我要派发的子代理**拿不到命名执行类工具** ⇒ 它不能自跑验证、不能绕过宿主验收。**取证已证明能力存在**（见 §2.0），缺陷是插件读了**无参全局视图**。**可达成边界（评审 🟡 订正）**：本部署 **`run_code` 是平台保留传输面、不可经 `restrict` 收窄** ⇒ 命名面收窄后 `run_code` 仍是绕行口；**真实收窄取决于 US-6**，本批的交付面是「**命名面生效 + 残余风险如实标注**」。
- **US-2（看门狗真武装）**：作为用户，我要一个**静默挂死**的子代理在阈值内被掐掉并给出可诊断终止文案，而不是烧满总预算（D-50 两次事故各烧约 8 / 60 分钟）。
- **US-3（证据不再丢）**：作为架构师，我要作业报告**只增不减**——同一 `<jobId>.txt` 的后写不得截断覆盖先前写入的回执 / 留档（D-57 实测：`eng-dsh-1.txt` 曾在含留档的 7776 B 与不含的 4688 B 之间来回，**最终留下的是短的那版**）。
- **US-4（候选池清干）**：作为维护者，我要批 30 候选池里的**机械项**一次收干，不留「评审提了就蒸发」。
- **US-5（会诊不再被一段文本打死，且失败可诊断）**（D-58）：作为用户，我要会诊**不因注入历史里的某段文本整批死亡**，且失败时 digest **带出真因**（子会话 `turn/end` 的 reason / stderr / exit code），而不是只给一行坍缩过的 `child ended: error`。
- **US-6（子会话权限面如实，不再假称只读）**（D-60）：作为架构师，我要**「只读」这种声明由模型请求头验证**，并且子会话/会诊的写权限**真的被收窄**——本部署实测子会话是 `danger-full-access` 且**已实际改写我仓文件**。
- **US-7（池行前置可用性）**（D-59）：作为用户，我要池里的**配置性必败行**在派发前被点名（模型目录 / 账号类型 / `reasoningEffort` 兼容性），不再每次会诊白烧一行。

### §1.3 非功能标准

- **零新执行面**：`lib/eng.mjs` 内不得出现子进程模块名字面（保持 0）。
- **锁约束逐字保持**：`lib/eng.mjs` 的 `setTimeout(`=2（第二实参 `backstopMs` / `budgetCap`）· `.abort(`=5 · `failStop(`=18 · `stageGateNote(`=5；`lib/silence-watchdog.mjs` 的 `setInterval(`=1（心跳轮询**复用既有轮询者**，不新增第二个）。
- **诚实降级不变**：任何读取失败 ⇒ **如实标注 + 退回既有行为**，绝不假装生效；**绝不猜工具名**（未注册名会抛错 ⇒ 整次派发失败）。
- **不新增测试档**（沿用 `test/silence-watchdog.test.mjs` · `test/job-persistence.test.mjs` 的既有锚）。

## §2 设计

### §2.0 取证结论（平台事实；只读取自平台源码，全部带坐标）

**A. 工具面（D-55）**
- `restrict(filter)`：`allow` 只保留 / `deny` 移除、可同给取交集；按**已注册工具名精确匹配**；**未注册名 ⇒ 抛错**、保留名 `run_code` ⇒ 抛错、空 `{}` ⇒ 抛错；**只过滤继承面**（global + 祖先链），本层自有注册永不被过滤（`dsh-tools/lib/index.js:2895-2910` · `:2641-2644` · `:2905` · `:2970-2978`）。
- **合法名域** = `view(scope).restrictableNames`（`:2959-2985`）；`schemas(scope)` 是**文档化 API**（`dsh-tool-cordis/lib/types/api-catalog.js:3182` · `:3176`），多出「本层自有名」与 `run_code`。
- **`scope` 就是 Agent 对象本身**：`dsh-agent-loop/lib/index.js:778`；平台自身多处如此传（`dsh-subagent/lib/index.js:1738` · `providers.js:52` · `dsh-cordis-host-runner/lib/index.js:582`）。
- **真机 `applied:false` 的根因**：插件调**无参** `svc.view()`（`lib/eng.mjs:638`）= 全局视图；而本部署把执行类工具 `disabled` 在宿主面、挂到 `preset-code` 的**祖先层**（`dsh-web-app/cordis.patch.yml:409-452` · profile `cordis.patch.yml:1232-1238`）⇒ 全局层看不见执行类名。
- **派发路径确实消费它**：`dsh-subagent/lib/index.js:510-523`（`:522 childCtx.tools.restrict(composition.toolFilter)`）；**setup 抛错 ⇒ 整次派发失败**（`dsh-agent-loop/lib/index.js:1847-1852 → 1864-1872`）。

**B. 存活信号（D-56）**
- `SubagentRun` 是**声明契约 4 键**（`api-catalog.js:7095-7096`）⇒ run 上**永远没有**订阅面（结构性，非版本巧合）。
- 可用心跳：① `sub.localAgent?.session?.seq`（**append 即增**的单调计数器，`dsh-session/lib/types/index.js:526-529`，声明面 `:6255-6256`；同档 `snapshotEvents` / `eventAt` 已 `@deprecated`，**`seq` 未弃用**）；② `ctx.on('agent/assistant-stream')`（**token 级**，发射点 `dsh-agent-loop/lib/index.js:1052-1054`，声明 `catalog:3632-3637`）；③ `ctx.on('tools/result')`（`catalog:4176-4181`）；④ `ctx.on('subagent/start' | 'end')`（仅首尾，作**就绪 / 终局锚**，`lifecycle.js:56-77` / `:30-47`）。
- **插件收得到**（三重证据）：分发器过滤式 `hook.global || !filter || filter(...)`（`cordis/src/events.ts:171-173`）；无 scope 标签的监听者被放行（`dsh-scope/lib/index.js:327-333`，关键 `:332`）；平台自己在用（`dsh-hooks-claude-code/lib/index.js:309-329` · `dsh-subagent/index.js:72-83` 带 `{global:true}`）。
- **jobs 侧不是心跳源**：只回显插件自己 push 的内容（`dsh-jobs-local/lib/index.js:428-436` · `:496-498`）。

> **本段（C 段）由会诊子会话 `kimi-api:kimi-k3` 实际写入**（会诊并非只读——见登记表 **D-60** 与其现场证据）；内容经主会话核验通过后保留，作者与来源在此可审计。

**C. 会诊 #13 全灭溯源（2026-09-27，主会话三路互证 + 委派手独立汇合）——真因已确证，「D-55 同类根因」候选证伪**
- **真因（子会话落盘 `turn/end` seq 7 铁证 + 平台源码链 + 本地解码复现）**：注入子会话的「Main Session History」含**裸文本 `dsh-session:483-499`**（`<pkg>:<行号>` 简写），撞平台**会话引用 URI 语法**——解析器当它做 canonical URI 做 base64url 解码 ⇒ `JSON.parse` 抛 `Unexpected token '\uFFFD'` ⇒ `agent/pre-step` 抛出 ⇒ 整回合 `reason.kind="error"` ⇒ in-process driver 映射 `stopReason:"error"`（**不带 diagnostic**）⇒ 插件渲染 `child ended: error`。与模型无关（4 个不同 provider 同因）。
- **「toolFilter 白名单 ⇒ restrict 抛错」候选证伪**（双侧独立得出同一形态判据）：restrict 在 setup 抛错 ⇒ `ctx.subagents.start` **reject** ⇒ 走 `lib/consult.mjs:719-727` / `:750` catch、落 `deathLine` 格式（`lib/abort-provenance.mjs:275`，带 trigger/layer 标注）；实测行只能来自**已发布 run 的 resolve**（`lib/consult.mjs:730-744` 分支逐字吻合；`dsh-subagent/lib/index.js:2624-2638` `settleRunResult`）。
- **连带写作纪律（对本批直接生效）**：文件:行引用**必须带后缀路径**（如 `dsh-session/lib/types/index.js:483-499`），**绝不用 `<pkg>:<行号>` 裸简写**——它会被平台当会话引用解析、炸掉任何注入该文本的子会话。本档既有平台坐标引用已全量核查、均带后缀路径；唯本节与 §7 保留罪证原串 `dsh-session:483-499` 共 3 处（引述必需，与分钟档 §4-2 同例）。
- **codex 行（独立配置面）**：rollout 末行 `The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.` ⇒ 模型与账号类型不匹配；目录未命中是同一配置缺陷的表征。
- **#14**：台账未 settle；其子会话已观测失败、**形态不同**（`400 server_error: Streaming response failed: [400] Invalid request parameters`），成因未查（分钟档 §5）。
- 对批 30 的影响：**零**——US-1 / US-2 的取证结论（A / B 两段）不依赖会诊结论；本条防止错误归因 + 固化写作纪律。

### §2.1 US-1 · 工具面：按 Agent scope 读名域（`lib/eng.mjs`）

把 `resolveExecToolDeny` 的读取面从「无参 `view()`」改为**带 scope**，并保持三级诚实降级：
1. 首选 `tools.view(agent).restrictableNames`（= restrict 的**合法名域**；`agent` 取 `deps.agent`，与 `:1482` 传给 `parent` 的**同一对象**）；
2. 退路 `tools.schemas(agent).map(s => s.name).filter(n => n !== 'run_code')`（文档化 API；须接受「本层自有名可能被 restrict 判 unknown 而抛错」的残余风险）；
3. 两条都拿不到 ⇒ **维持现状**：如实标注「未生效」、**不下发任何执行类名**（`applied:false` 语义不变）——**注意**：基线 `deny`（`ENG_CODER_DENY`）**照发**，与批 29 JSDoc 口径一致（**措辞订正见轮 2 审计 F3**：原写「不下发 toolFilter」与实现字面不符）。
- **硬约束**：deny 只收「读取面里**确有**的名字 ∩ 执行类谓词命中」；**绝不含 `run_code`**；**绝不硬编码** `pwsh` / `bash`。
- **残余风险（必须写进交付与留档）**：`run_code` 不可被 restrict 收窄（平台保留名）⇒ 本机制**不构成「子代理跑不了命令」的保证**；保证只覆盖**命名工具面**，`run_code` 通道由 US-6 如实标注。
- **证据口径不变**：留档里附「名下来源（`view(agent)` / `schemas(agent)`）」与**逐字命中名清单**，使首次派发即可自证。

### §2.2 US-2 · 心跳：改接 `seq` 轮询 + `ctx` 事件面（`lib/silence-watchdog.mjs` · `lib/eng.mjs`）

- **主腿（零订阅）**：`sub.localAgent?.session?.seq` 变化即心跳 —— **复用既有 `createSilenceWatchdog` 的 `setInterval`**（不新增轮询者，`setInterval(` 仍 =1），每拍比对上次读数，不涨即静默。
- **辅腿（补长模型调用盲区）**：`ctx.on('agent/assistant-stream', ({agent}) => { if (agent?.id === sub.id) beat() }, { global: true })` 与 `ctx.on('tools/result', exec => { if (exec?.agent?.id === sub.id) beat() }, { global: true })`；**dispose 时必须 `off()`**（含派发返回、异常、静默终止三条路径）。
- **就绪 / 终局锚**：`ctx.on('subagent/start' | 'end', …, {global:true})` 仅用于「已开跑」与「已结束」，**不作静默判据**。
- **武装纪律不变**（批 29 §2.1②′ 口径）：**首次真实心跳前不武装**；读取面全不可用 ⇒ 如实标「未生效」+ 退回总预算。
- **边界（写进注释）**：`localAgent.session` 属**穿过类型读具体类**的事实 API（`catalog:4319-4320` 的 `interface Agent` 只声明 `id`；平台自身也这么读）⇒ **换平台版本时此处是第一复核点**。

### §2.3 US-3 · D-57 落盘**只增不减**（`lib/job-outcome.mjs`）

- `persistJobReport` 写前先**读回现值**：新文本**短于**现值且现值**以新文本为前缀**（= 后写是旧写的截断）⇒ **保留现值**（不覆盖），并 `console.warn` 一行（裸 warn，不进正文）；
- 其他情形按既有语义覆盖（含合法的整体重写）；
- **只增不减**的不变量以腿钉死：模拟「先写含留档的长版、再写截断短版」⇒ 盘上**仍是长版**。

### §2.4 US-4 · 候选池机械项

1. `onSilence` 注销函数改为「仅当当前回调仍是自己时才清」（防注销 A 误杀 B）；
2. `watchJobHandle` 的 `Object.create(handle)` 补 JSDoc「**枚举面不保证同形**，只保证读写访问语义」；
3. `silenceMinutesLabel` 对 <3000ms 阈值给秒级渲染（消「静默 0 分钟」的语义误导）；
4. A29-15 补「**短折叠 + 长原串**」形态，使「折叠**先于**截断」成为决定性（现变异 M3b 仍绿）；
5. 未捕获腿的留档噪音：给相关腿套 `captureWarn`（或在档头纪律注一句）；
6. A29-11 第三子句（「为何决定性」注释在场）补静态锁。

### §2.5 US-5 · 会诊：注入面消毒 + 失败可诊断（`lib/consult.mjs`）

- **消毒（技法已钉死为 ZWSP 插入，评审 #8）**：组装「Main Session History」与问题正文时，把**裸 `dsh-session` + 冒号 + 载荷** 形态**断开**（**实现落定 = 在包名与冒号之间插入 U+200B**；另覆盖 `](` 上下文形态），使其不再命中平台会话引用正则（`dsh-session-reference/lib/types/uri.js` 的 bare 分支）；**带路径的引用**（形如 `dsh-session/lib/types/index.js:483-499`）不触发，无需改。
- **失败可诊断**：`stopReason` 非 completed 且无 `diagnostic` 时，**兜底读出子会话日志的 `turn/end.reason`**（**通道与 §2.6 的捕获通道同源**：`<cwd-slug>/<childId>/session.v4.jsonl.zstd` + 按 magic 切帧解压；本批实测真因就在盘上），带进 digest；**退路**：若解压/定位不可行 ⇒ 本腿**收窄为「codex 行 diagnostics 上浮 + 如实声明子代理面不可诊断」**并在档内注明；codex 行同理——把 `env.diagnostics`（exit code / stderr）**一并显示**，不再只显示 `userMessage`（`lib/consult.mjs:684`）。
- **上游登记（不改平台）**：bare 分支对非 canonical 载荷应**降级为普通文本**，而非连坐整回合（写进 §6 与登记表 D-58 的备注）。

### §2.6 US-6 · 权限面如实 + 生效性判据升级（`lib/consult.mjs` · `lib/eng.mjs`）

- **判据升级（硬）**：任何「工具面已生效/只读已生效」的断言，其**证据**必须是**模型请求头里的工具面**（本部署 PTC 下模型可见面 = `[run_code]` 单元素），**不得**以「`restrict` 未抛错」代替。**判据分层（评审 🔴 订正）**：**A30-2 / A30-3 保持单测面**（deny 逻辑与三级降级，不动）；**新增 A30-12（真机项）** 承载请求头判据。
- **捕获通道（评审 🔴 要求补出）**：主通道 = 读**子会话落盘日志** `$DSH_HOME/sessions/<cwd-slug>/<childId>/session.v4.jsonl.zstd` 的 **`request/header` 事件**（该事件即模型可见工具面；子会话 id 由 `sub.id` 给出，cwd-slug 由既有 `cwdHint` 逻辑推导）；该档是**多帧 zstd**（逐事件一帧）⇒ 按 magic `28 B5 2F FD` **切帧循环**解压（Node 内建 `zlib.zstdDecompressSync`）。**退路**：读不到 ⇒ **如实标注「本部署无法取得请求头证据」**，该断言降级为「restrict 已下发、模型面未验」。
- **交付面裁定（评审 #2）**：本批对 US-6 的交付面 = 「**逐行类型写明尝试过的机制 + 无法收窄时如实标注 + 上游诉求**」——**不发明**平台未提供的收窄手段（eng 侧已带该声明；会诊侧经 F1 修复后两条产物同源带出）。
- **运行前提（评审 #5）**：`request/header` 通道依赖 Node ≥ 22.15 的 `zlib.zstdDecompressSync` + 多帧 magic 切帧；**实现已有 `zstdOk` 运行时特性检查**，缺失 ⇒ 走「模型面未验」如实降级；测试夹具按 magic 逐帧构造多帧 zstd（见 `test/consult.test.mjs` 的 header-落第 2 帧腿）。
- **写权限收窄**：子会话/会诊的派发须**真实收窄写面**（不能只发 `allow` 白名单就宣称只读）；若平台面无法收窄 ⇒ **如实标注「本部署无法保证只读」**，并在会诊产物里带该声明。
- **现场留痕**：本批设计档被会诊子会话**未授权改写**（+1844 字符）已在档内注明作者——作为该项的**验收现场**保留。

### §2.7 US-7 · 池行前置可用性（`lib/consult.mjs` · `lib/codex-adapter.mjs`）

- 派发前对池内每行做**可用性预检**，**数据源逐项写死（评审 🟡 订正）**：① 模型是否在目录内 ⇒ 读既有 codex 目录解析（`lib/codex-adapter.mjs` 的 `effort-resolve` 路径）；② `reasoningEffort` 是否被该模型接受 ⇒ 读**同一目录的 effort 元数据**；**判据口径（审计 F2 订正，以实现为准）**：只有「**不被接受** **且** **解析器无法回落映射**（只能原样透传）」才拦；**受支持档直接放行**、**可回落档放行并附 note**（既有 `test/codex-runner.test.mjs` 的两条回落腿即此契约，本批不改它们）；③ **账号类型（ChatGPT vs API）插件侧无法预知** ⇒ **不做前置判定**，改由 **US-5 的诊断上浮**承担（fail-fast + 带出 CLI 原文）。
- 本批两例的**归因强度如实标注**：`codex-cli` 行 = 账号不支持该模型（**codex rollout 原文，已确证**）；`oc-go` 行 = 「不支持 `reasoningEffort:max`」为**回复 [4] 的观察、未独立确证**（成因仍在 §2.0 C 的「未查」状态）⇒ 该行只作**动机示例**，**不作**预检可拦截的已证例证；
- 预检失败 ⇒ **不派发该行**，digest 里点名「因配置未派发」+ 原因（省一行预算，也避免把配置问题误报成模型问题）。

## §3 受影响文件

| 文件 | 改动 |
|---|---|
| `lib/eng.mjs` | US-1 名域读取（带 scope）+ 三级降级 · US-2 派发点接线与 `off()` 生命周期 · 留档证据附名下来源 |
| `lib/silence-watchdog.mjs` | US-2 心跳改接（`seq` 轮询复用 + `ctx.on` 辅腿）· 删「猜名」候选腿并写明结构性理由 · 🔵1/2/3 |
| `lib/job-outcome.mjs` | US-3 落盘只增不减 |
| `lib/consult.mjs` | US-5 注入面消毒 + 失败可诊断（兜底读子会话 `turn/end` / 带出 diagnostics）· US-6 只读声明如实 · US-7 池预检 |
| `lib/codex-adapter.mjs` | US-7 codex 行诊断面（exit code / stderr 进 digest）与模型可用性预检 |
| `test/consult.test.mjs` | **US-5/US-6/US-7 与轮 2 的 A30-8…A30-11、markdown 消毒腿、会诊只读声明腿**（含 F1 的 8 条分离腿）——评审 #1 订正补登 |
| `test/silence-watchdog.test.mjs` | A30-* 对位腿（心跳 / 事件面 / 降级 / 🔵 项）· **US-1 的名域两态腿（A30-2/A30-3）亦落在此档** |
| `test/job-persistence.test.mjs` | A30-* 落盘只增不减腿 |
| `docs/**`（架构师） | 本档 · 登记表（**D-55 / D-56 / D-57 / D-58 / D-59 / D-60 六项转已修**）· 台账 · CHANGELOG · 交接页 |

## §4 工单

| 号 | 内容 | 依赖 |
|---|---|---|
| **D30-1** | US-3 落盘只增不减（最小、独立、最该先做——它护住后续所有证据） | — |
| **D30-2** | US-1 工具面名域（带 scope + 三级降级 + 证据口径） | 取证（已有） |
| **D30-3** | US-2 心跳改接（seq 主腿 + 事件辅腿 + off 生命周期 + 首次心跳前不武装） | D30-2（同文件 `eng.mjs`，避免并行写） |
| **D30-4** | US-4 候选池机械项 | —（可与 D30-1 同轮） |
| **D30-5** | US-5 会诊注入面消毒 + 失败可诊断 | 独立（`consult.mjs`） |
| **D30-6** | US-6 权限面如实 + **生效性判据升级**（US-1 的锚同步） | 与 D30-2 同源 |
| **D30-7** | US-7 池行前置可用性预检 | 独立（`consult.mjs` · `codex-adapter.mjs`） |

### §4.1 轮次切分与状态（码评 🟡#2 要求登记，避免口径靠记忆传递）

| 轮 | 工单 | 文件面 | 判据 |
|---|---|---|---|
| **轮 1（已交付）** | D30-1 · D30-5 · D30-7 · D30-4 | `lib/job-outcome.mjs` · `lib/consult.mjs` · `lib/codex-adapter.mjs` · `lib/silence-watchdog.mjs` + 三个测试档 | A30-1 · A30-8/9 · A30-11 · A30-7 |
| **轮 2（已交付 2026-09-28）** | D30-2 · D30-3 · D30-6 | 以 `lib/eng.mjs` 为主（+ `lib/silence-watchdog.mjs` 心跳面 + 锚升级） | A30-2/3 · A30-4/5/6 · A30-10 · **A30-12（真机项）** |

**依据**：`lib/eng.mjs` 是两条 US（US-1 名域读取、US-2 派发接线）与 US-6 判据升级的**共同写面** ⇒ 必须串行、同轮；轮 1 的四单与其**零重叠**（码评 🟡#2 的 grep 已证实轮 2 面在仓内「尚无任何落地」）。

## §5.1 机验锚

| 锚 | 档 | 形态 | 判据 |
|---|---|---|---|
| **A30-1** | `test/job-persistence.test.mjs` | 长版 → 截断短版 | 盘上**仍是长版**；覆盖被拒时有裸 warn |
| **A30-2** | `test/silence-watchdog.test.mjs` | 带 scope 的假 tools 服务（`view(agent)` 命中执行类名） | deny 恰含命中名、不含 `run_code`；`applied:true` 且证据行含名下来源 |
| **A30-3** | 同上 | `view(agent)` 抛错 / 返回空 ⇒ 退 `schemas(agent)` | 退路可用且**剔 `run_code`**；两条都失败 ⇒ 不下发 toolFilter + 如实标注 |
| **A30-4** | 同上 | 假子代理 run：`localAgent.session.seq` 单调 | 涨 ⇒ 续命；不涨到阈值 ⇒ abort +「疑似挂死」文案 |
| **A30-5** | 同上 | 事件面辅腿（按子 id 过滤 / 他子事件不续命） | 本子事件续命、他子事件**不**续命；dispose 后**零残留监听** |
| **A30-6** | 同上 | 首次心跳前不武装 **+ out-of-process 降级**（评审 🔵 订正） | 零事件运行 ⇒ **不 abort**、退回总预算（D9 口径不回退）；`localAgent === undefined` ⇒ **如实标「未生效」** + 退回总预算（不抛、不静默） |
| **A30-7** | 同上 | 候选池机械项（**逐项写死形态，评审 🟡 订正**） | 🔵1 = 注销误杀形态断言 · 🔵2 = JSDoc 串**静态锁** · 🔵3 = 秒级渲染断言 · 🔵4 = 短折叠+长原串决定性形态 · 🔵5 = **套 `captureWarn`**（二选一定死为捕获，**不用「档头注一句」**）· 🔵6 = 注释在场**静态锁** |
| **A30-8** | `test/consult*.test.mjs` | 注入文本含**裸引用形态** | 消毒后**不再命中**平台正则（**判据正则以字面钉进测试并注明来源坐标**：`dsh-session-reference/lib/types/uri.js:59` 的 bare 分支；**不 import 平台模块**，避免测试耦合平台内部）+ 带路径形态**不被改** |
| **A30-9** | 同上 | 子会话 `turn/end` 为 error 且无 diagnostic | digest **带出真因**（reason 原文）；codex 行带出 exit code / stderr |
| **A30-10** | 同上 | 权限面判据 | 「只读生效」的断言**读模型请求头**（非「restrict 未抛错」）；平台面无法收窄时**如实标注** |
| **A30-11** | 同上 | 池含必败行（模型不在目录 / effort **不被接受且不可回落**） | 该行**不被派发**且 digest 点名原因；**可回落档必须照常派发**（反向腿在场） |
| **A30-12**（**真机项**，评审 🔴 新增） | 真机一次派发 | **模型可见工具面**的生效判据 | 从子会话落盘 `request/header` 读出模型面：执行类**命名**工具**不在**其中；`run_code` 在场 ⇒ **如实标注「残余绕行口」**；请求头读不到 ⇒ **如实标注「模型面未验」**（不得以「restrict 未抛错」代替） |

## §5.2 验收标准

| AC | 标准 | 工单 | 锚 |
|---|---|---|---|
| **AC-1** | 工具面**命名面**生效 + **残余风险如实**：名域来自 Agent scope；deny 名逐字可证；两条读取都失败时诚实降级且**不猜名**；**模型面由 A30-12 真机项裁定** | D30-2 · D30-6 | A30-2 / A30-3 / **A30-12** |
| **AC-2** | 看门狗真武装：`seq` 与事件面任一心跳即可续命；阈值内静默必掐；dispose 零残留；首次心跳前不武装 | D30-3 | A30-4/5/6 |
| **AC-3** | 落盘只增不减 | D30-1 | A30-1 |
| **AC-4** | 候选池清干（🔵1–6 各有决定性腿） | D30-4 | A30-7 |
| **AC-5** | 会诊不再被一段文本整批打死，且失败带出真因 | D30-5 | A30-8 / A30-9 |
| **AC-6** | 权限面如实：只读声明由**模型请求头**验证，无法收窄则如实标注 | D30-6 | A30-10 |
| **AC-7** | 池内必败行在派发前被拦并点名 | D30-7 | A30-11 |

## §6 边界（本批不做 / 复核义务）

- **不做 `guard()` 路线**（备选：`ctx.tools.guard(...)` 零枚举）：guard 是**进程全局**且有时序窗口 ⇒ 本批走 scope 名域。
- **不碰远端 provider 语义**：`localAgent === undefined`（out-of-process）时心跳主腿不可用 ⇒ 如实降级（本批只在进程内 spawn 腿取证）。
**复核义务**：`localAgent.session` 与 `view()` 均属**事实 API**（非文档化契约）⇒ 平台升级后**第一处复核**。
- **不扩面**：本批六项（D-55…D-60）之外的新发现另开登记，不在本批顺手改。
- **上游登记（本批产出，报平台不代改）**：① `dsh-session-reference` 的 bare 分支对**非 canonical 载荷**应**降级为普通文本**，而非抛错连坐整回合（D-58 备注）；② 「只读」类声明在 PTC 面下不可实现 ⇒ 平台应提供**真实写面收窄**手段（D-60 备注）。

### §6.1 批 30 候选池（本批评审/审计产出，逐条不丢）

| 来源 | 项 | 去向 |
|---|---|---|
| 轮 1 码评 🔵#3 | `preflightCodexRow` 与派发侧各做一次目录读取 + effort 解析（有进程内快照兜底；判定逻辑两条路径） | 候选池：把 preflight 的 `res.effort` 随 verdict 附进可派发行，或加注「共用 effort-resolve 单一事实源」 |
| 轮 2 审计 F2 | 退路面 `schemas(agent)` 剔 `run_code` 是**非决定性防线**（`EXEC_TOOL_RE` 本不命中它；删掉仍全绿） | 候选池（双保险保留无害；决定性由 D1 谓词腿承担） |
| 轮 2 审计 F4 | `lib/eng.mjs:1634` 注释含 `setInterval(` 字面 ⇒ 若将来加**库级**计数锁会读出 2 | 候选池备注（同 `silence-watchdog.mjs:27` 的自避纪律） |
| 轮 2 审计 F5 | 模型面证据只在 dsh **后台**路径采集、失败返回点不 drain ⇒ 失败派证据顺延到下次交付 | **登记为通道边界**（不违反硬要求；设计只要求「读不到 ⇒ 如实标注」） |
| 轮 2 码评 🔵#4 | `renderModelSurfaceEvidence` 在 `execNames` 为空时仍渲染「（命名面收窄生效）」= **空真** | 候选池：`execs.length === 0` 时改中性措辞或附 `denyPlan.applied` |
| 轮 2 码评 🔵#5 | `readChildModelToolSurface` 注释「以最后一个 `request/header` 为准」↔ 实现「最后一个**含可读工具面**的为准」 | 候选池：改注释（行为更稳，非缺陷） |
| 轮 2 码评 🔵#6 | `readZstdFrames` 按 magic 全文切帧：magic 若出现在帧内载荷中会切坏该帧（**跳过、不炸**）且无提示 | 候选池：切帧失败计数 >0 时在 reason 里带「跳过 N 帧」 |
| 轮 1 码评 🔵#4 | `silenceMinutesLabel(1)` 渲染为 `0.001 秒 = 0`（分钟段为 0） | 候选池：有意契约；若后续触碰该函数可给 `<0.001` |

**§2.6 读法（观察项订正）**：回执区可能同时出现两类证据行——A29-1 的「工具面禁执行已下发…**强证**」（子会话**生效面**）与 A30-12 的「**模型面证据**」（模型请求头的工具面）。**两者口径不同**：本批起「只读/已生效」的判据**一律以模型面为准**，生效面仅作辅助。

**残余窗口（评审 #3）**：AC-3/A30-1 的不变量精确表述为「**前缀形**截断覆盖被拒」；**更短的非前缀**写仍可缩水（窗口已在登记表 D-57 收口文字中记录）。

## §7 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-27 | **立项 + 取证完成 + 范围裁定**：用户选 **B+**（两条真修并入本批）；两条只读取证（工具面 / 存活信号）完成，结论见 §2.0（均带平台源码坐标）；同一决策并行送 **会诊 #13**（5 模型只读），digest 回来后逐条处置并补记本行 |
| 2026-09-28 | **轮 2 交付 + F1 修复 + 两轮审计/码评收口**：轮 2 = D30-2（名域带 scope + 三级降级，名下来源入留档）· D30-3（心跳改接：`seq` 主腿复用既有轮询 + 事件辅腿按子 id 过滤 + 三路径 `off()` + 首次心跳前不武装 + out-of-process 如实降级）· D30-6（模型面证据通道 `request/header` 复用轮 1 读取器 + 「模型面未验」如实标注）；**审计 F1**（会诊产物缺只读声明）⇒ **改实现**：新增 `CONSULT_READONLY_DISCLAIMER` 逐字同源进「派发 detail + digest」两条产物 + 8 条分离腿；**审计 F2–F6** 与**码评 6 条**处置见本表与 §6.1；**两轮均无 🔴**；轮 2 审计真机读到子会话 `request/header` = `[run_code]` 单元素（A30-12 通道可达性已实证） |
| 2026-09-27 | **轮 1 交付码评（无 🔴）→ 4 条去向**：🟡#1（F3 扩到 markdown 分支的消毒面**无腿**——删半分仍全绿）⇒ **并入轮 2**（`test/consult.test.mjs` 补 markdown 提及形态腿 + 两半各自必红），并遵守「修完必使对应变异必红」；🟡#2（轮次切分未登记）⇒ 本档新增 **§4.1**；🔵#3（preflight 与派发侧两处 effort 判定）⇒ 记入 **§6.1 候选池**；🔵#4（`silenceMinutesLabel(1)` 渲染 `0.001 秒 = 0`）⇒ 有意契约、仅可读性微瑕，记入候选池；**F1 的决定性已由架构师在副本亲验**（删 `text.length < prior.length` ⇒ 该档转红） |
| 2026-09-27 | **轮 1 分歧审计 → 口径订正（F2）**：A30-11 与 §2.7② 由「effort 不被支持 ⇒ 不派发」**收窄为**「**不被接受且不可回落** ⇒ 不派发；受支持放行、可回落放行 + note」——以**实现**与既有 `test/codex-runner.test.mjs` 两条回落腿为准（审计实测该收窄在代码注释里自认、但档内未披露）；余 F1/F3/F4/F5 派修复轮（F1 补「同文重写」腿、F3 头注口径、F4 stderr 残留行为腿、F5 陈旧注释同步） |
| 2026-09-27 | **设计评审第 1 轮（FAIL）→ 订正**：🔴#1 判据自相矛盾且缺捕获通道 ⇒ **判据分层**（A30-2/A30-3 保持单测面 + **新增 A30-12 真机项**）并补出**捕获通道**（子会话落盘 `request/header` + 多帧 zstd 切帧解压）；🟡#2 US-1 可达成边界（`run_code` 不可收窄）；🟡#3 US-5 复用同源通道 + 退路收窄；🟡#4 US-7 数据源写死 + oc-go 归因降为「未独立确证」；🟡#5 §6 补上游登记；🟡#6 A30-7 逐项写死、🔵5 定死用 `captureWarn`；🟡#7 A30-8 正则字面钉入并注来源；🟡#8 §3 docs 行覆盖六项；🔵#9 A30-6 补 out-of-process 降级腿；🔵#10 登记表 D-52 触发列同步 |
| 2026-09-27 | **范围扩张（用户裁定）**：**D-58 / D-59 / D-60 并入本批** ⇒ 新增 **US-5（会诊不再被一段文本打死 + 失败可诊断）· US-6（权限面如实 + **生效性判据升级为读模型请求头**）· US-7（池行前置可用性）**，对应 **§2.5–§2.7 · D30-5/6/7 · A30-8…A30-11 · AC-5/6/7**；受影响文件增 `lib/consult.mjs`、`lib/codex-adapter.mjs` |
| 2026-09-27 | **会诊 #14 处置完毕 + D-60 立项**：#14 = `3 of 5`，但**三条成功回复全部答非所问**（子会话继承主历史 ⇒ 继续做调查），就委托问题**零意见**⇒ 批 30 范围**不变**；三条回复的**证据**被采纳，其中回复 [4] 揭出 **「会诊只读」在生产不成立**（PTC 下模型可见工具面 = `[run_code]` 单元素、子会话 `danger-full-access`）⇒ 登记 **D-60（🔴）**，并**升级 US-1 生效性判据为「读模型请求头工具面」**；回复 [5] 的实际写入（本档 +1844 字符）作为 D-60 现场证据保留并已注明作者；两行失败（codex 账号不匹配 / oc-go 不支持 `reasoningEffort:max`）并入 **D-59** |
| 2026-09-27 | **会诊 #13 处置完毕 + 溯源定稿**：#13 回**墓碑（0/5 全灭）**，零意见尽数「不采纳」（分钟档 §2），**不阻塞 B+ 裁定**；#13 已 `digested` 落账；**真因确证**（裸 `dsh-session:483-499` 撞平台会话引用语法，分钟档 §4-2；「restrict 抛错」候选由主会话与委派手双侧独立证伪）；重试 **#14** 台账未 settle、其子会话已观测失败（形态不同：`400 server_error`，成因未查）；§2.0 **C 段**随之定稿 |
