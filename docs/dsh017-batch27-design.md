# 设计（批 27）：残差清零 —— 把批 26 的余项与自曝缺口一次收干

- 日期：2026-09-26
- 状态：**已交付（批 27）**——设计评审 3 轮至 PASS · 实现 = eng_coder 首轮 + 分歧修复轮 `eng-dsh-4` · 宿主验收 `node --test` **559/559**（详见 §7）
- 来源：批 26 交付码评的 **4 条 🔵**（Deferred 项）+ 批 26 §6 明确划出的边界（落盘清扫）+ **本批自查发现的一处测试隔离泄漏**
- 前序：[`dsh017-batch26-design.md`](./dsh017-batch26-design.md)（D-45 落盘 · D-47 门禁 · D-48 验证门）

## §1 背景与用户故事

**背景**：批 26 把「报告拿回来 + 验证门归位」交付了（v0.29.5，545/545）。剩四件小事与一件自查出来的事：
① 落盘目录**只增不减**（批 26 §6 明确划在边界外）；② 非法 `pathForm` 会**静默回落**（削弱 D26-6 的可查性）；
③ 宿主验收超时的解析逻辑**两处重复**（将来改值域容易只改一处）；④ `finish()` 在**正常 close** 路径也调 kill（语义不精确）；
⑤ `persistJobReport` 解析 home 时**不传 cwdHint**（D-40/D-44 同一物种的最后一处）；
⑥ **自查订正（原判据是错的，如实留痕）**：`$DSH_HOME/.thincoder/jobs/` 里出现 `smoke-nohome-1.txt`（1 字节 `z`，kind=`smoke-nohome`，mtime 03:56:56Z）。**初判为「测试隔离泄漏」，经核实为误判**：仓内全量 + `git log -S` 全历史检索**均无该字面**，它是批 26 实现窗口内**一次性 smoke** 的产物。⇒ 处置改为：① 交付时**手工删除**该文件；② **撤销**原「测试隔离缝改造」设计项（不存在泄漏测试）；③ 保留一条**回归锚**（无 `DSH_HOME` ⇒ 零落盘），复用 `lib/job-outcome.mjs:62` 既有的 `dshHomeOverride` 注入缝。**附带如实记录一条边界**：该文件**不匹配**四类 kind 钉死正则 ⇒ 清扫**不会**自动清它（这正是「只清自己的」纪律的副作用，副作用本身是可接受的）。

- **US-1**：落盘目录**不会无限增长**（按天数 + 条数双重上限清扫，`index.jsonl` 同步裁剪，永不删「非本插件所有」的文件）。
- **US-2**：非法 `pathForm` **可见**（warn 一行，不抛）。
- **US-3**：超时解析**单点**（两处共用同一 helper）。
- **US-4**：正常退出**不再 kill**，kill 只用于超时/未 close。
- **US-5**：`jobOutcome` 接受可选 `cwdHint` 并透传给 home 探测（缺省行为不变）。
- **US-6**：**无 `DSH_HOME` 时零落盘**（回归锚；用既有注入缝，不做隔离缝改造——理由见 §1⑥）+ 清掉那份一次性产物。

## §2 方案

### §2.1 清扫与轮转（US-1）
`lib/job-outcome.mjs` 增加 `sweepJobReports({ maxAgeDays = 7, maxFiles = 200 })`：扫描 `<jobId>.txt` 与 `index.jsonl`，
**只处理本插件自己派发的四类作业**（评审 #1 要求钉死）：`/^(advisor|consult|eng|escalate)-[A-Za-z0-9._-]+\.txt$/`——即那 7 个 `jobs.start` 点所属的四个机制；**平台 kind（`pwsh-*` 等）与任何其它文件永不触碰**（A27-3 的负控正是它）；按 `mtime` 先删超龄、再按条数截断；同步把 `index.jsonl` 重写为**仍存在的文件**对应行（同目录临时文件 + rename 原子替换）。
**时机**：每次 `persistJobReport` 成功后**尽力而为**触发一次（失败只 warn）。
**并发边界（评审 #3）**：`index.jsonl` 的重写是**尽力而为且可自愈**——共享 `DSH_HOME` 的其它会话在同一瞬间追加的行**可能永久丢于索引**（正文文件仍在磁盘上，**丢的只是追溯元数据**）。**不做行合成**——`{at, bytes, pathForm}` 无法从文件本身还原，凭文件合成只会**伪造** `pathForm`（违反批 26 §2.1「记录实际携带正文的通道」那条契约）；批 26 定的 append-only、无锁语义在写入侧不变，重写侧接受这条窗口，**不引入锁**。

### §2.2 三条小硬化（US-2/3/4）
① 非法 `pathForm` ⇒ `console.warn` 一行（列合法值），维持 D26-2「不抛」；
② `lib/host-check.mjs` 抽出 `effectiveTimeoutMs(opts)`，`runOneHostCheck` 与文案共用；
③ `finish()` 仅在 `timedOut === true` 或尚未收到 close 时 `kill`，正常 close 直接 `clearTimeout` + settle。

### §2.3 home 探测传 cwd（US-5）
`jobOutcome(handle, outcome, opts?)` 增可选 `opts.cwdHint`；`persistJobReport` 把它透传给 `pickDshHome`。
**实际交付形态（审计 D4 订正）**：四档各定义一次 `jobPersistOpts`，**28 处 `jobOutcome` 调用点全部追加该实参**（四档 7 处 `jobs.start` 派发点全部传上会话 cwd）——初版设计写的「**不动那 28 个调用点**」与实测不符，档面按实测订正。**语义零变化**：eng/escalate 原本无第三参，传入对象里**没有 `pathForm` 键** ⇒ `opts?.pathForm === undefined` ⇒ 仍走原推断分支、零新增告警；advisor/consult 原有的 `{ pathForm: … }` 逐字保留。

### §2.4 零落盘回归锚与产物清理（US-6）
**不定位、不改任何测试**（核实后确认本仓无泄漏测试）。改为：① 复用既有注入缝（`dshHomeOverride`）与「home 不可解析」形态，补一条**回归锚**——断言 `persistJobReport` 在该形态下**不写任何文件**（含不写 `process.cwd()`、不写真实 home）；② 交付时手工删除 `smoke-nohome-1.txt` 并在报告里说明；③ 在 §6 明写「清扫只清四类 kind ⇒ 他形态产物需人工清」这条边界。

## §3 受影响文件

| 文件 | 改动 |
|---|---|
| `lib/job-outcome.mjs` | 清扫/轮转 + 非法 pathForm warn + `opts.cwdHint` 透传 |
| `lib/host-check.mjs` | `effectiveTimeoutMs` helper + kill 收窄 |
| `lib/advisor.mjs` · `lib/consult.mjs` · `lib/eng.mjs` · `lib/escalate.mjs` | 派发处顺带传 `cwdHint`（可选） |
| `test/job-persistence.test.mjs` | **新增**：清扫策略（超龄/超数/不误删）· 隔离缝回归 · pathForm warn 三条腿 |
| `test/host-check.test.mjs` | **新增**：超时 helper 单点 · 正常 close 不 kill |
| `test/dsh017-compat.test.mjs` | 若隔离缝合在该档则同步登记 |
| `docs/2026-09-05-defect-registry.md` · `docs/test-lifecycle.md` · `CHANGELOG.md` · `README.md` · `package.json` | 登记级联与版本 |

**分工裁定（审计口径冲突）**：本表下半那批「登记级联与版本」档（`docs/test-lifecycle.md` · `CHANGELOG.md` · `README.md` · `package.json` · 登记表）由**架构师**在实现落地后统一收口；eng_coder 的白名单只含代码与测试档（外加 `test/guard-e.test.mjs` 里 T-E19 清单的登记两行）。**理由**：若把 docs 同时写进设计表又写进禁令，会得到「设计要求级联、任务书禁止改」的自相矛盾（本批首轮即撞上，审计记为口径冲突）。

## §4 决策

| # | 决策 | 理由 |
|---|---|---|
| D27-1 | 清扫**尽力而为**（persist 后触发、失败只 warn） | 与 D26-2 同一条纪律：兜底不得成为失败源 |
| D27-2 | 双重上限：`maxAgeDays=7` + `maxFiles=200` | 天数防长期、条数防突发；两个都可配且可测 |
| D27-3 | **只删本插件自己写的形态**（`<kind>-<n>.txt`） | 目录是共享的，不碰他人文件 |
| D27-4 | `cwdHint` 为**可选参数**、四档尽量传 | 不制造第 29 个必改点；缺省行为逐字不变 |
| D27-5 | **不做隔离缝改造**；只补零落盘回归锚 + 手工清产物 | 自查误判已订正——本仓无泄漏测试（全历史检索为证）；无缺口可藏，也就不必造缝 |

## §5 锚与判据

### §5.1 机验锚
| 锚 | 检索目标 | 谓词 | 期望 |
|---|---|---|---|
| **A27-1** | `test/job-persistence.test.mjs` | 造 3 个超龄 + 1 个新鲜文件后触发清扫 | 超龄全删、新鲜保留，`index.jsonl` 只剩新鲜行 |
| **A27-2** | 同上 | 造 `maxFiles+5` 个文件 | 只留 `maxFiles` 个（按 mtime 从新到旧） |
| **A27-3** | 同上 | 同目录放一个**非本插件形态**的文件 | 清扫**不碰它** |
| **A27-4** | `test/job-persistence.test.mjs` | 注入「home 不可解析」（既有 `dshHomeOverride` 缝）后调 `persistJobReport` | **零文件落盘**（不写 cwd、不写真实 home）；且进程内只 warn 一次 |
| **A27-5** | `test/host-check.test.mjs` | 正常 close 的假子进程 | 未被 kill；超时路径仍 kill |
| **A27-6** | `test/job-persistence.test.mjs` | 传非法 `pathForm` | warn 一行且**不抛**，写入的仍是合法枚举值 |
| **A27-7** | `test/host-check.test.mjs` | 静态：超时解析字面在 `lib/host-check.mjs` 的出现次数 | **恰好 1 处**（两处调用共用同一 helper） |
| **A27-8** | `test/job-persistence.test.mjs` | `cwdHint` 在四档派发点（7 处 `jobs.start`）被传的次数 | **= 7**（缺一即红）；且行为腿：经任一档派发后 `pickDshHome` 收到的基座 === 该会话 cwd |

### §5.2 验收标准
| # | 验收标准 | 层 | 锚 | US |
|---|---|---|---|---|
| **AC-1** | 目录双重上限生效且不误删他人文件 | T1 | A27-1 · A27-2 · A27-3 | US-1 |
| **AC-2** | 无 `DSH_HOME` 时零落盘（注入缝回归） | T1 | A27-4 | US-6 |
| **AC-3** | kill 语义收窄 | T1 | A27-5 | US-4 |
| **AC-4** | 非法 `pathForm` 可见且不抛 | T2 | A27-6 | US-2 |
| **AC-5** | 超时解析单点 | T1 | **A27-7**（`test/host-check.test.mjs`：`lib/host-check.mjs` 内超时值域解析字面**恰好出现一次**，且回执标注与真实生效值一致） | US-3 |
| **AC-6** | `cwdHint` 透传且缺省行为逐字不变 | T1 | **A27-8**（正向）+ 既有 545 条不得转红（反向） | US-5 |
| **AC-7** | 登记级联（台账新档 · CHANGELOG · 版本 · 事实 id） | T3 | — | 全部 |

## §6 边界（本批不做）

- 不做跨会话/跨 home 的集中清理台（本目录自清足够）。
- 不对 `job_output` 平台读取面做任何事（上游，见批 28）。

## §7 变更记录
| 日期 | 变更 |
|---|---|
| 2026-09-26 | 首版：清扫/轮转 · 三条小硬化 · cwdHint 透传 · 零落盘回归锚；决策 D27-1…5 · 锚 A27-1…7 · AC-1…7 |
| 2026-09-26 | **首轮交付 + 分歧审计处置**：交付实测 **558 / 552 / 6**；审计判定「需修复轮」——**D1** 自家断言不可满足（`lib/host-check.mjs:26` 注释含 `effectiveTimeoutMs(opts)` 字面，把用例引用计数从 3 顶到 4）· **D2** 两新档未入册（档清单 + 台账）· **D3** 清扫面声明与实现不一致（额外清 `.index.jsonl.tmp-*`）· **D6** 原子写重复造轮（应复用 `lib/dsh-home.mjs` 的 `writeFileAtomic`）· **D5** A27-8 行为腿未走派发路径 · **D4** §2.3 订正 · **D7** `docs/README.md` 行订正。级联分工见 §3 |
| 2026-09-26 | **第 1 轮设计评审处置并入**（PASS）：① 清扫面**钉死四类 kind 正则**（平台 kind 永不触碰，A27-3 负控据此）② 并发边界**如实写明**（索引窗口内他方行可能永久丢失，**不做行合成**以免伪造 `pathForm`）③ AC-5 由静态注释变**真锚 A27-7** ④ **⑥ 自查误判订正**：撤销「测试隔离缝改造」（全历史检索证无泄漏测试），改为清产物 + 零落盘回归锚 ⑤ **A27-8** 补 `cwdHint` 正向锚 ⇒ 锚区间 **A27-1…8** |
