# Changelog

本插件遵循语义化版本。完整设计文档见 [`docs/`](./docs/)，工程方法论见 [METHODOLOGY.md](./METHODOLOGY.md)。

## [0.16.0] — 2026-09-13

**批 8：提示词公共层（裁减版）—— 判定契约从「碰运气不漂移」变成「由 spec + 双向锁钉死」**

- **形态 = 零改面**。四个 advisor 提示词（`advisor-round1/2/3.md` + `advisor-design.md`）与 `lib/prompts.mjs` **零字节改动**——本批**不搬运任何提示词字节**。交付物 = 一份契约 spec + 一条双向锁测试。
- **为什么不用真抽取**：可逐字节抽取的只有 **4 行**（标题 / 引导句 / `Tolerated:` / `malformed-refused`），去重收益 = **12 行**；而代价是 ① 新增**启动期**失败面（`prompts.mjs` 顶层急读，片段缺失 ⇒ 整个插件加载失败）② **必须改写 `AC-V13`/`AC-V13b`**——本仓**最安全相关**的两个测试（它们**直接读裸档字节**，抽取后裸档不再含那 4 行，必红）③ 破坏「零构建」这一既存性质。**为 12 行去动最硬的锁，风险收益倒挂。**
- **交付物**：
  - `lib/prompts/verdict-contract.md`（**新增**）：判定族的公共层权威——① 契约字面（四档逐字共享的 4 行）② 差异表（**ID 化 `<!-- DIFF:… -->` 哨兵**，使「恰 4 类带意差异」可机器判定）③ **四档 Verdict 块逐字快照**（程序抽取写入）④ **出现点地图**（四档 + `advisor-msgs.mjs` 的 2+2 处 + `AC-V13`/`AC-V13b` 锁位置 + `VERDICT_LINE_RE`）⑤ 已存在的漂移登记。**该档不进装载路径**（`loadPrompt` 按显式文件名装载，库内无 `prompts` 目录扫描）。
  - `test/prompt-contract.test.mjs`（**新增**，14 用例）：**两组件闸** + 哨兵集合 + 四条不变式 + DIFF 哨兵 + 地图内容 + EOL 契约 + 装载路径零接入。
- **闸的两组件（这是本批的要害）**：**组件①** = spec ↔ 四档**逐字一致**；**组件②** = **四档 Verdict 块的 sha256 内容指纹**（硬编码常量）。① 是**共拥有**的锁——「提示词 + spec 快照」**协同改**能全绿；② 把块的归一后内容钉成常量，**协同改即红**。**设计评审轮次 1 的 🔴 正是指出纪要写了两个组件而我设计档只落了一个**；修复后**审计员独立复现 M3**：协同改 ⇒ 组件① 绿、组件② 红。
- **反向锁**：三版 PASS 判据句 / 两版 FAIL 判据句 / `Never translate` 的 3:1 措辞差 / `design` 的独有两条 —— **一律原地保留、只登记不合并**。统一任一措辞 = **替换** ⇒ 违反「判定族字面只追加、绝不替换」。另加**负向锁**：三版 PASS 判据句**必须互不相同**（防后人「顺手统一」）。
- **流程留痕**：会诊 id 3（**4/4 交付**）→ 父侧实测（可抽取集 = 4 行 · 四档块 11/10/10/17 行 · 本机 603/603 CRLF）→ 用户裁定形态 = **零改面**（否决组装层）→ 设计评审**轮次 1 `FAIL`**（🔴1 🟡7 🔵5；🔴 = 「裁定写进纪要 ≠ 设计档兑现」**第五次命中**）→ 修 13 条 → **轮次 2 `PASS`**（残留 7 条含**尾换行不对称会让 AC 恒红**的真缺陷，父侧全部修掉）→ 实施（后台一次通过，18 次变异自证）→ **独立分歧审计 `🔴0 🟡2 🔵2`** → 修复轮（**F2 = 父侧设计前提错误**：`AC-9b` 钉的是**本机 checkout 配置**而非仓库属性——本仓**无 `.gitattributes`**、**提交进库的 blob 是 LF**，CRLF 只是本机 `core.autocrlf=true` 的投影 ⇒ 在默认配置的克隆上**一个字节未改的仓库就会红**；改为**环境无关**的「同档不混用 + 跨档一致」，并以**模拟全 LF 克隆 14/14 绿**验证）。
- **本批沉淀两条纪律**：① **交付文档面必须回读本批纪要的裁定清单做交叉自检**（本批 🔴 与批 7 的 4 条 🔴 同族，已升级为可执行动作）；② **在 `core.autocrlf=true` 的机器上，「零改动」不能只靠 `git diff` 证明**——git 会在 diff 前归一 EOL，一次「只改行尾」的编辑会被吞掉；必须**另用字节级读取佐证**（审计员提出并示范）。
- **登记面**：R-10 `Never translate` 的 3:1 措辞差（已登记不修）· R-11 判定族的出现点分布（「契约单点 + 文本多处」）· R-12 吸收清单记载的重复症状已陈旧 · **R-13** `test/session-state.test.mjs` T6 的**既有时序 flake**（单独复跑 10/10 绿、其后全量连续 7 次绿；不在本批写域、无因果）。
- **测试**：`node --test` **413/413**（基线 399 + 本批 14）· 既有测试档零修改（唯一授权改动 = `test/guard-e.test.mjs` 的 T-E19 清单登记一行，用户 2026-09-13 裁定）· **四档提示词与 `lib/prompts.mjs` 一个字节未动**（经字节级核验）。

## [0.15.0] — 2026-09-13

**批 7：可移植性三件（METHODOLOGY 退役 + 产品提示词去本仓指涉 + 判据单一权威）**

- **总目标**：让本插件的**产品提示词不再绑定任何具体仓库**——评审的判据来源由**项目自己声明**（缺省时**显式降级**而非静默），提示词里不再出现本仓/上游的文件名与路径，且「这个路径是文档还是代码」这件事**只有一个权威实现**。
- **① 退役（19 处，逐处改写，零整段删除）**：`injectMethology` 整函数删除（含其拼写错误的名字）；`injectDocumentMap` **保留函数名、整段重写**（它此前读死路径 `docs/design/README.md`，**本仓不存在 ⇒ 今日恒不生效**）；`advisor-design.md` 4 处 + `engineering.md` 9 处 + `advisor-msgs.mjs` 2 处判据/硬要求句全部改写。手法纪律 = **退役是改写不是删词**——不许留下空括号、双逗号、悬空限定语残句。**可验收形态**：`grep -ri methodology lib/` = **0**（含注释与提示词）。
- **② 声明键 + 三态显式注入（`standardsDoc` / `documentMapDoc`）**：两键均为**项目属性**（**global-only**，不做会话覆盖——与批 5 `contextTokens` 同族，实测最小面集一致，**免掉 7 个面**的改动）。三态**各有可区分输出**：声明且可读 ⇒ `## Project Standards` / `## Document Map` + 全文（**新增 16384 预算 + 截断标记**，此前无预算）；声明但**读不到** ⇒ 响亮句并**点名配置键**；**未声明** ⇒ **显式降级句** + 明说「不得自行去磁盘找」。**注入门 = 声明键存在**，删掉旧的 `engineering === true` 门（留门会造出「已声明却被模式静默压制」的新静默洞）。**空串 / null = 撤销该键**（回到「未声明」这一**正常态**），设置页**清空文本框即发送空串**（不是「空字段不发送」，那会把用户锁死在已声明态）。
- **③ 判据单一权威（F17 之外的又一处「两份副本」）**：新建零依赖叶模块 **`lib/path-kind.mjs`** —— `isDocPath`（`docs/` 前缀 ∪ 文档扩展名，任意深度）为**唯一权威**；`isProductCodePath` = **纯补集派生**（无第二套规则体）；`eng.mjs` 的 `isProductCode` 变**薄转发**（名字与 export 保留 ⇒ 写门禁字节夹具不需更新）；`advisor.mjs` 本地 `isDocFile` **删除**；**`^src\/` 死锚删除**——**这是删死代码而非收紧**：对代码扩展名它冗余（`lib/`、`packages/app/src/` 靠兜底已真阳性），对文档扩展名它是**唯一矛盾源**（`src/README.md` 曾被写门禁拦却可进评审文档表）。上游那条「收紧为 `^src/` 前缀」是**记录在案的陷阱**，本批反向行之。**唯一行为变化**：`src/**/*.md` 从「产品代码」翻为「文档」——本仓无 `src/` ⇒ **零现场影响**。
- **流程留痕（本批一半价值在此）**：会诊 id 2 **4/4 交付**，且**三家独立指出父侧会诊任务书的四条前提错误**（`isProductCode("docs/x.mjs")` 方向反了 · 根级 `README.md` 实为文档 · 「`docs/` 两谓词语义相反」不成立 · 16K 截断归因错）——父侧回盘实测并落档；随后**两轮只读勘察**又纠正父侧两处（配置面是 **7 个面**不是「四面管道」；T-E19 的测试档清单闸 ⇒ 新增测试档会被拦）。设计评审 **轮次 1 = FAIL**（🔴5 🟡5 🔵4，**其中 4 条 🔴 是我违反了自己刚写下的裁定**）→ 修 → **轮次 2 = PASS**（5 条 🔴 经引用级复核全修；残留 7 条为「同一件事有第二个落点」）→ 实施（同步路径被 540s 内部截止 abort 且零输出 ⇒ 改**后台**一次通过）→ **独立分歧审计 🔴1 🟡2 🔵2**（🔴 = AC-P13 的静态锁自称六子点、实测只证 4 个，且一条断言**tautological**——**代码全部合规，是锁缺陷**；🟡 = 三条核心 AC 在服务端面零覆盖 + 卫生锁无套内锁）→ 修复轮（**11 次变异全部「删/插被保护行 ⇒ 目标用例红、不误伤」**）→ **交付代码评审 PASS**（🔵2）→ 收尾修复轮。
- **本批沉淀的四条纪律**（均已进交接页 §6）：① **裁定写进纪要 ≠ 设计档兑现**（设计档交付前必须逐条回读纪要裁定清单做交叉自检）；② **改了引用点，却没改被引用的副本**（每次改一个约定，必须全库检索其所有出现点并一起改——该 `grep` 级纪律原先只当**代码面**纪律用，**文档面同样适用**）；③ **不许用「不可达」当免验理由**（「不可达」本身是需要证明的断言，本轮我那条证明就是错的）；④ **当一条闸的谓词与它的意图不等价时，修的是谓词，不是被闸的东西**（本批两度命中：锚 B6「切片不含 engineering」vs「门不由模式决定」；评审 #2 的同类建议——且第二次出在**评审建议**上，故**评审的话也要回盘核验**）。
- **登记面**：R-5 六维/七维清单预先存在的漂移（系统提示列 7 维、硬要求句列 6 维）· R-6 `.thincoder/advisor.md` 沿用上游产品名 · R-7 `viz/*.html` 过时数字 · R-8 eng_coder 参数描述里的示例路径 · R-9 `cordis.patch.yml` 白名单注释已过时。
- **测试**：`node --test` **399/399**（基线 384 + 本批 15）· 既有测试档零修改（唯一授权改动 = `test/guard-e.test.mjs` 的 T-E19 清单登记一行 + 同处注释，用户 2026-09-13 显式裁定「按登记制扩展」）· 新增 `test/path-kind.test.mjs`。

## [0.14.0] — 2026-09-13

**批 6b：守卫 E（在途窗口冻结 + 预闸拦截 + 结算侧指纹兜底）**

- **总目标**：把「评审窗口内被审文档不得被改动」从**流程纪律**升级为**机制不变式**——窗口开启时**事前拦**（`write`/`edit` 撞冻结集 → 拒绝 + 真逃生门），窗口结算时**事后核**（签发前重算指纹，失配则本次不签发）。守卫 D 让**失败**自证来源；守卫 E 让**成功**自证依据。
- **闭合的问题（F17 型漏洞）**：令牌指纹此前是**派发前快照**、签发时**不复检** ⇒ 评审在飞期间（我方路由下可达数分钟到 1 小时）改动被审文档，评审员读到「前半段旧内容 + 后半段新内容」的混合体，而宿主照常按 `verdictPassed ∧ echoOk` 签发一枚**声称审过**该内容的令牌。**静默**且**每次窗口内编辑必然发生**。我方没有上游那种基于变更日志的 `reviewIsStale`，故用**已有的两口子**（在途槽位 + D-30 指纹）拼出等价物。
- **两半，缺一不成立**：
  - **预闸**（事前）：新增**独立** `tools/pre-execute` 监听器 `makeDocFreezeGate`（`lib/eng.mjs`），命中冻结集 → `{kind:"deny", reason:"frozen: …"}`。**与写门禁刻意不同**的三点：① **fail 朝向相反**（已确认窗口内 fail-closed；写门禁无条件 fail-open）② **depth 不豁免**（写门禁 `depth>0` 放行——子代理是受令牌保护的实现者；预闸拦的是「正在被审的文档」，写入权与写入者身份无关）③ **拒域不相交**（冻结集 = 文档 vs `isProductCode` = 非文档）。拒文案前缀 `"frozen: "` **不与** `"denied: "` 混用（两态出路完全不同）。
  - **结算侧兜底**（事后）：`finalize` 的 `if (echoOk) {` 首条语句重算并集指纹，失配 ⇒ **不签发**。这一半专门覆盖预闸**原理上拦不到**的面（`bash`/`pwsh`/`run_code`/`file_ops`/外部编辑器/别的会话）。
- **槽位载荷扩容**：`inFlightJobs` 值 `{jobId, mechanism}` → `{jobId, mechanism, reviewType, docSet}`；`setInFlightJob` 加**第四位置参** `payload`（缺省 `{}`）⇒ 既有 **6** 个三参调用点（advisor ×2 / eng ×2 / escalate ×2）**零改动**仍合法。新增只读访问器 `designFreezeSet()`——**扫全表**而非按会话键单查（子代理 `session.id` ≠ 父会话 ⇒ 键查必然 miss，而子代理恰是典型漂移向量）。
- **闭包捕获**：`castDocPaths`/`castDocHash` 在铸造块末捕获、`finalize` 只读捕获值。与「读活 `state.pendingDoc*`」在当前代码下**等价**（单飞入口检查早于铸造，窗口内无第二写点），但捕获让正确性**不依赖**该不变式——否则将来有人在窗口内加一个写点，守卫会**静默退化成自比恒真**且无测试会红；捕获还把「不许读活 state」落成**机器验锚**（锚 A1：签发块内 `state.pendingDoc` = 0 次）。
- **漂移的处置语义（四条，缺一会引入新死锁）**：① **不签发**（不写 `state.designToken`、不调 `saveTokenRecord`）② **不撤销**既有令牌（漂移针对 pending 集；与「PASS 但回显缺失不撤销」同族）③ **不计三振**（早返回绕过通用计振尾——护栏计的是**插件自身健康度**，七 kind 无一例外是管线自己的故障；漂移是管线**正常**而外部改了文件，计入会让诊断面指向错误修法）④ **复位轮次**（`advisorRound=0` + 清 prior + 落盘）——否则下一轮取「只验证不找新问题」的**收敛轮**提示词去覆盖**从未被评审**的内容 = 真实的放行面。**不** `bumpAdvisorGeneration`（代际是「弃置在飞结果」的轴，+1 会误伤无关机制的 settle）。
- **真空豁免**：`castDocHash === null`（空文档集 / 铸造即不可读）⇒ 跳过复检、签发照旧（D-30 决策 D6 的既有权衡；漏判会让**空集评审永远签不出**）——AC-E20 专锁。
- **流程留痕（本批一半价值在此）**：会诊 id 1 **四家全部交付**（v4-pro / glm-5.3 / gpt-6-astra / kimi-k3）→ **五处分歧父侧裁定**（① 闭包捕获 vs 读活 state ② 子代理拦不拦 ③ **失配是否计三振** ④ fail 朝向扁平 vs 分层 ⑤ 其余三处）→ 设计评审**轮次 1 `FAIL`**（🔴 = 真空豁免无 AC；**评审员判得对**，纪要 §4 栽点 2 已明令「FR + AC」）→ 修 12 条 → **轮次 2 `PASS`** → 实施 → **独立分歧审计 🔴0 🟡1 🔵5**（审计用 **10 组变异实验**自证：M8 删 `.slice()` / M10 删空集跳过各自 **22/22 存活** ⇒ F1 两条已规定不变式零覆盖）→ 修复轮（+`T-E22`/`T-E23`，**变异自证可失败**：M8→23/1 唯红 T-E22、M10→23/1 唯红 T-E23）→ **交付代码评审 `PASS`**（🔴0 🟡1 🔵4，含 F3 的调用点计数订正与 §12.6 的**设计文本缺陷裁定**）。
- **父侧自身缺陷亦落档**：① 派发任务书把 stage 1 的 check 写成**不存在的** `test/in-flight.test.mjs`（实现者按纪律换等价自检并如实上报，未为迁就任务书造文件）② 设计档 §6.1 伪代码把 `const` 画在块内却又要求块外消费——**按字面不可运行**（判定为**设计文本缺陷**，正文冻结不改、以 §12.6 #1 裁定为准）。两次都属「凭形状推测而不回代码核验」的同一类病，与批 6 §0.2 同族。
- **登记面（本批不做）**：O-E1 跨会话误拒 · O-E2 跨链过度冻结（D-30 并集语义投影）· O-E3 未过期旧令牌 + 漂移在 `eng_coder` spawn 时不复检（F17 类洞、**窗口外**，属 D-30 扩展）· O-E4 `file_ops` 条件纳入 · O-E5 路径 cwd 偏斜（miss 方向） · O-E6 不可读原因不细分 · O-E7 若出现「每窗必漂」则另立**独立漂移计数器**（与三振正交），不塞进三振。
- **测试**：`node --test` **384/384**（既有 **360 原样全绿**，既有测试档零修改；新增 `test/guard-e.test.mjs` 24 用例覆盖 AC-E1…AC-E21 + 机验锚 A1…A10）。

## [0.13.0] — 2026-09-13

**批 6：死亡可诊断（守卫 D 判定换血 + 四家族 abort 溯源 + 裸 abort 灭绝）**

- **总目标**：让**每一种死亡自证来源**——「哪一层按下的（provider / agent / settle）+ 因为什么（user / timeout / cancel / stop / unknown）」在一次工具返回里可判。动机有**生产事故实证**：`consult.mjs` 头注自认「2026-09-08 生产：**20 次失败全被读成「aborted 无死因」**」（D-28 当时试了 21 次才诊断出来）。
- **新模块 `lib/abort-provenance.mjs`（唯一词汇表）**：`TRIGGERS`(5) / `LAYERS`(4) / `triggerOf` / `abortError` / `timeoutError` / `annotateAbort` / `deathLine`（截断顺序 = 先截 detail → 再拼 cause/tag → 最后整体兜底 ≤300）/ `abortTag`（`detail` 机器短标签）/ `hostAbortInfo` + `hostAbortSource`（宿主面机械判据：控制器已中止 ∧ reason **未带**我方标注 ⇒ `{cancel, settle}`）。
- **FR-AP2 墙判定换血**：`runAdvisorToolLoop` 的 `/deadline reached/` **文本嗅探整行删除**，改由 `deadlineFired` latch 与 `abortInfo.trigger` 判定——适配器以**无声样 AbortError** 抛出时不再被误判为「用户中断」并丢掉超时统计尾。
- **FR-AP3/AP4**：`shouldBudgetNudge` 纯函数 + 循环顶**每场至多一次**的 75% 预算提示（走 `messages` 注入，**不进**返回正文/prior）；超时尾**纯追加**——既有那句一字符未动，其后追加 `tool calls / review text produced / budget` 三要素与两条出路。
- **FR-AP5/AP6 四家族接线 + 裸写点灭绝**：advisor 五站（循环 catch · 环内 `kind==="error"` 站 · 两条 job catch · 外层 catch）· eng 三站 · escalate 三站 · consult 五站；**`grep '\.abort()' lib/` = 0 命中**（基线 5 处裸写点全部补上 reason 载荷），**零新增写点、零定时器时长/条件变更**（`.abort(` 计数与 HEAD 逐文件相等）。
- **流程留痕**：设计评审**轮次 1 = FAIL**（🔴 = 我自己的设计档自相矛盾：超时尾「追加」与「替换 + 逐处改断言」三处打架，而零改面纪律禁止改断言——**评审员判得对**）→ 修正为纯追加 → 轮次 2 PASS → 实施 → **独立分歧审计 1🔴/4🟡/3🔵**：🔴 = consult 的 stop/cancel 两构造的判据打在**手搓等价物**上、且生产死亡行**没有消费者**（`settleChild` 丢弃 payload）→ 修复轮**给它接了真实消费面**（死亡行进该行模型的可见文本），并给出「删生产站点即红」实测；其余含宿主面层映射（job_kill 误报 `unknown@agent` → 修成 `cancel@settle`）、环内 error 站补接线、矩阵补六站、模块实测表计数订正、定时器门禁改逐字比对、两个不可持久的锚（**D-37**/T-G9 与 T-AP9）改成历史事实锚。
- **测试**：`node --test` **360/360**（既有 320 中 319 条原样未动 + T-G9 按 D-37 授权修为历史锚；零其余既有测试修改）。

## [0.12.0] — 2026-09-13

**批 4：设计评审豁免 5 轮上限 + 三振结算护栏（成对吸收）+ D-35 评审链作用域折入**

- **总目标**：把设计评审的**拒绝轴**从「轮次上限」换成「结算健康度」，且两者**成对**生效——cap 只对代码评审生效；设计评审由三振护栏兜底。两半拆开任一件都比现状更糟（只豁免 = 撤掉唯一的界、无限烧钱；只护栏 = 第 6 次仍被 cap 误杀，吸收等于没做）。
- **FR-G1 豁免**：cap 检查条件加 `reviewType !== "design"`（`MAX_ADVISOR_ROUNDS` 与 **cap 消息体逐字节不变**）；轮次照增、提示词轮换与显示照常——豁免的只是「第 6 次拒绝」这一轴。
- **FR-G2 三振护栏**：同一文档集连续 3 次跑不出可用结算 ⇒ 后续发起被拒（**零 LLM、零状态变更**；工具层 + 核心层**双入口**）；键 = **纯路径形状**（`normalizeDocPath` 归一 + 去重 + 排序；空集哨兵 `"empty"`；**绝不用内容哈希**——那会被一次空白编辑洗白）；计数 = **会话级内存**（照抄 `codexFailureCount` 先例，不落盘）；清理只挂 `session/disposed`，**不挂** `resetRouteFailureState`。
- **FR-G5/FR-G6 计数与复位**：宿主截断族 + 陈旧结算 + 凭证落盘失败 + 无报告结算计振；`interrupted` **不计**；派发返回 **不计**；**dsh 后台兜底 abort 按 `timeout` 计**（机械事实，不做串面猜）；**codex `ABORTED` → `interrupted`（0 振）**、`TIMEOUT` → `timeout`（+1）；可用判决（pass ∧ 回显 ∧ 落盘成功）与显式 `VERDICT: FAIL` **复位**（FAIL 同时撤销 token 是**另一条正交轴**，注释钉死）。
- **FR-G9（D-35 折入）**：设计评审链**按文档集作用域**——换文档集即等价类型切换（round/prior/代际重置），与 F11 合并为**单一重置谓词**、重置动作各执行一次；`session-state.json` 新增可选字段 `lastDesignDocKey`（**本批唯一 schema 变更**）。该字段存 `sha256Hex(designDocKey)` **摘要**而非路径原文——`session-state` 的既有 AC-20 契约禁止落盘被绑文档路径，父侧裁定接受（等值判定语义等价）。
- **流程留痕（本批一半价值在此）**：设计评审 **PASS**（12 条发现同链处置）→ 实施 → **独立分歧审计 2🟡/1🔵**：① 工具层预检**不是「摘除即红」**（核心层单独就满足全部四条断言——审计员用「连 `deps.llm` 都没有」的探针实证）② **codex 路由上的用户中断被计振**（`ABORTED` 信封未映射 ⇒ 归 `review_failed`，与 US-4/README 矛盾）③ `stale` 对**失败**的 job 也记账 → 修复轮三条全修，并各做「**还原即红**」实验（A 摘工具层→T-G3b 红；B 摘 ABORTED 映射→T-G5g 红；C/C3 还原 stale 打点→T-G5f 两臂各自红），实验后逐字还原。
- **D-35（评审链会话级 → 文档集级）**：本批开工时**现场复现**——同一会话里第二份设计文档拿到的是**收敛轮**提示词（「只验证、不找新问题」）、prior 还是**另一份文档**的发现，并据此**铸造了一枚声称覆盖未评审文档的令牌**。该次评审被判**无效、令牌不予采用**；缺陷登记为 D-35（🔴）并折入本批（同一把键）。
- **测试**：`node --test` **340/340**（既有 320 **原样全绿**，零既有用例修改）。

## [0.11.0] — 2026-09-13

**批 5：评审上下文预算跟随模型窗口 + 评审估算器 CJK 加权（120K 硬编码退场）**

- **总目标**：让评审循环的上限来自**它真正要调的那个模型**，并让估算值不再对中文内容系统性撒谎——两件同批落地（拆开任一件都比现状更糟：只上窗口派生会 CJK 真实死点推到越过真窗、只上估算器会让 CJK 死点 4× 前移）。
- **FR-CB1 窗口三级链**：`advisor.contextTokens`（手配）> `ctx.llm.resolveModelInfo(provider, model).context.contextWindow`（运行时权威——**本插件早已为 effort 在调同一方法**）> 保守兜底 `131072`。逐级 fail-open；兜底/元数据失败时 `console.warn` + post-finalize 追加一行（值 / 来源 / 两档 / 出口），**绝不进判死文案**。
- **FR-CB2 比例式两档**：`limit = floor(窗口 × 0.8)`、`compactAt = floor(limit × 0.8)`（两次 floor 钉死）。本机默认评审路由（`deepseek-flash`，适配器声明 **1M**）判死线 120000 → **800000**；128K 级 / 未知路由 120000 → **104857**（收紧 12.6%，给「对该路由一无所知」一个诚实的头寸）。`MAX_CONTEXT_TOKENS` **退役、不留别名**。
- **FR-CB4 估算器 CJK 加权**：逐消息 `ceil(ascii码元数/4) + 非ASCII码元数`——纯 ASCII **逐值等于旧式**（可机验零回归），`"中"×400` 从 100 修正为 **400**。签名与导出面不变（仍为模块私有）。
- **FR-CB5 三面同步**：`advisor.contextTokens` 进 PUT 白名单（整数 16384..4194304，校验单一事实源在 `lib/advisor.mjs`）⊕ `mergeGlobalConfig` 白名单透传 ⊕ 设置页卡片（占位不写具体数值 / 回显仅配置层 / 含残余格子提示 / 内联校验 / 清空即删键 / **不新增服务端 GET 载荷**）。
- **流程留痕（本批的价值一半在这里）**：设计评审 **PASS**（7 条发现同链处置）→ 实施 → **独立分歧审计抓到 1 条 🔴 假锁**——T-CB4 的 CJK 判据全部打在测试档**本地副本**上，把生产权重改成任意 `w ∈ (0.552, 1.504]` 仍 **319/319 全绿** → 修复轮新增 **T-CB10 走生产路径**（`"中"×300000` ⇒ 逐字 `300007` 判死；把权重改 0.75 即转红，红→绿两次实测留档）→ 交付代码评审 **PASS**（2 🔵：模块头注释枚举滞后、逐调用配对锁退化——均已修）。
- **测试**：`node --test` **320/320**（既有 304 **原样全绿**，零既有用例修改）。
- **同批的流程性修正**：批 3 交付时 `package.json` **未 bump 版本**（`docs/README.md` 该行却写了 `v0.11.0`）——本批统一为 **0.11.0** 并修正那条声明。

## [0.10.0] — 2026-09-11

**D-30 design token 生命周期：续期路径 + 精确切除签名腿（批 2）**

- **总目标**：把 design token 从「限期作废、只能靠再评审重铸」改成**授权与时限解耦**——只要被评审的设计文档集没变，就续期而不是重评审；文档变了才必须重评。
- **FR-T1/T2/T3 两段化 + 删密钥链 + 审批码换源**：token = `<uuid>:<expiresAt>`，**恰好两段**（对齐上游 thincoder 的「uuid:expiresAt, exact slot match + TTL only」）；D-25 引入的 HMAC 签名腿与整条密钥解析链（`resolveTokenSecretPath`/`resolveTokenSecret`/进程内单例/公开默认值回落）**整体删除**。删除依据（需求档 §2.3 威胁模型，会诊判定 + 父侧回代码核实）：① 门禁刻意 fail-open（`eng.mjs:167`）——它是纪律护栏不是安全边界；② 真正挡住伪造的是**记录全等匹配**（判定在签名校验之前）；③ 密钥与 token 镜像**同目录**（能写后者者几乎必然能读前者，Windows 上 0600 近似 no-op）；④ 净效果为负（密钥链换来启动全量作废 + 一条独立运维失效轴，防伪造增量 ≈ 0）。**审批码不一起删**（否则 R2 的 `[APPROVE:<code>]` 防伪造语义静默归零）——改为**无状态派生** `sha256(uuid).slice(0,8)`：uuid 由宿主 `randomUUID()` 生成且**从不进提示词**，对主代理同样不可预测。
- **FR-T4 缺省 TTL 7d**：`TOKEN_TTL_DEFAULT_MS = 7d`（TTL 只作陈旧度护栏）；`cordis.patch.yml` base 的 `engTokenTtlMs` 3600000 → **604800000**，使新缺省在交付后即刻现场生效（决策 D11）。
- **FR-T5 续期（本批核心）**：落点 = **`eng_coder` 过期子分支**（决策 D1；否决写门禁——其契约是 fail-open 而续期必须 fail-closed，且没有回传新串的通道；否决 advisor 入口——语义倒置，续期正是为了不付评审成本）。四路判定：无记录/无指纹 → 无法续期；文档不可读 → 视为已变更拒绝（fail-closed）；指纹同 → **同一 uuid** + `expiresAt = now + 当前生效 TTL`，内存与磁盘同步并**回传新令牌串 + 「替换副本」指引**；指纹异 → 文档已变更拒绝。指纹 = 文档集**路径 + 内容**双绑：`sorted(normalize(path) + "\0" + sha256(content))` 再整体 sha256（新建 `lib/doc-hash.mjs` 单点实现；`normalize` = `path.resolve` + 反斜杠归一 + **不做**大小写折叠）。快照时点 = **待批令牌铸造时**，内容 = **历轮 documents 之并集**（决策 D5 + 设计评审 #2：防止「批准轮收窄 documents」把指纹绑窄）；空文档集不写指纹（决策 D6）；**未过期路径不做文档校验**（决策 D7，代价显式接受）。
- **FR-T6/T9 文案与迁移**：过期提示四分支各自说清（已续期 / 文档已变更 / 无法续期 / 旧版本令牌）；写门禁 deny 在令牌**已过期**时不再说「先写设计文档」（误导）而是指向续期/重评；TTL > 24h 时有效期显示**日期**而非裸 `HH:MM`。三段式旧令牌由形状检测识别 → 明确「旧版本令牌、形状已不兼容、无法续期」并指引重跑一次（**不做**旧格式兼容验签——保留旧通道等于保留伪造面，先例 = v2 废除 `[DESIGN-TOKEN:...]` 回显，决策 D8）。
- **FR-T8 token-store 两缺口**（会诊 G1/G2，父侧实证）：① 保存路径此前显式重建三字段 → 传入的 `docHash` 被静默丢弃（续期永远拿不到素材），现补 `docHash`/`docPaths` 条件字段；② 全局清扫此前「过期即删」→ 会顺手删掉**别的会话**可续期的记录（头号场景「重启后续期」非确定性失败），现改为五分支：畸形删 / 未过期留 / 过期且无指纹删 / 过期且有指纹**保留**（保留期上限 = `ENG_TOKEN_TTL_MAX_MS` = 30d，锚点 = `expiresAt`）。磁盘格式**纯追加**，旧记录读得动。
- **FR-T7 会诊口径修正**：`lib/prompts/main.md` 原称会诊「绑定当前回合、打断或回合结束即终止」，与 `consult.mjs`（D-28）实现矛盾——改为「**跨回合存活**（打断/回合结束不杀），且**有界**（只由 `consult_stop` / session 销毁 / `consultTimeoutMs` 看门狗终止；缺省 10min 可配）」。
- **删除后的两处静默显式处理**（设计评审 #9）：① 旧密钥环境变量 `THINCODER_TOKEN_SECRET` 变为无声 no-op → 启动时打印**一次性弃用告警**（密钥链已删除、该变量不再有任何作用）；② 磁盘上的 `.thincoder/token-secret` 成孤儿文件 → **声明不清理、留档**（删除属破坏性动作，不在本批范围；README 已注明其已被弃用）。
- **本批无 UI 变更**（设置页字段已在 D-29 落地）；零新增依赖、无构建步骤。
- 测试：全量 `node --test` 全绿（详见提交时套件计数）。

**D-29 配置面缺口：`consultTimeoutMs` / `engTokenTtlMs` 进 user 层白名单（用户实测痛点）——同批发版**

- **缺口**：两键运行时都读得到配置（`lib/consult.mjs:115` / `lib/advisor.mjs:677`），却都被 `mergeGlobalConfig` 的白名单排除 —— 结果是它们**只能**在 entry base（`cordis.patch.yml`）里改，**设置页改不动**。用户侧实测后果：① design token 每 1h 过期，而新 token 只能由一次新的设计评审签发 → **反复重评审**；② 会诊里慢/挂的模型把整轮吊满缺省 600000（10min），四个模型常只剩两个能回。
- **修复**：两键补进三面白名单（对齐 `dshBackgroundTimeoutMs` 的 N-5/US-10 先例）——`lib/config-store.mjs` 值域校验与常量（`isValidConsultTimeoutMs` 30000..3600000 / `isValidEngTokenTtlMs` 600000..2592000000）⊕ `mergeGlobalConfig` 白名单 ⊕ `lib/index.mjs` PUT 校验（`topAllowed` + 区间错误文案）⊕ 设置页表单字段（`lib/client.js`：校验 / 载荷 / 初始态 / busy 窗口编辑保留 / 新增卡片）。
- **base 示例值**：`cordis.patch.yml` 的 `consultTimeoutMs` 600000 → **1800000**（慢模型有合理窗口；原值会让整轮吊满 10min）。`engTokenTtlMs` 保持 3600000 —— **缺省值的语义变更属后续批次，本批只让两键可配**。
- **测试**：新增 4 条（`test/codex-runner.test.mjs`）——① PUT 接受合法值 + 回归断言「不再被当 unknown top-level field 忽略」+ merge 覆盖语义；② 区间外/非整数拒绝且不落盘（边界值两侧合法）；③ 设置页接线静态核对（`client.js` 无既有 UI 测试面，锁住「后端开了前端没接」这类静默半成品：初始态 / 载荷 / 校验 / busy 保留 / onChange / 区间常量同值）；④ user 层落盘 → `loadUserConfig` → merge → 到达运行时消费点的完整往返（锁「user 层能覆盖 base 钉死值」）。241 → **245 全绿**。
- **文档同步**：`README.md` 的 user 层白名单段与 `cordis.patch.yml` 头部白名单清单同步补齐（两处此前仍称两键「只在 base 配」，与本批改动矛盾）；README base 示例值同步为 1800000。

## [0.9.2] — 2026-09-09

**D-28 会诊跨回合失效修复（生产缺陷：PTC run-scoped 信号被继承）**

- **根因**：`consult_start` 把调用方 `exec.signal` 直传子代理，而 PTC 模式下它是 run_code 程序的 run-scoped 控制器（`dsh-tools/lib/types/ptc.js:375` 注入、`:532` 在程序 settle 的 finally 里 `abort('run_code settled')`）——会诊是「本回合 start、后续回合 check」的跨回合协议，子代理因此在启动 1~3 秒内被 `child.cancel({kind:'parent'})` 杀掉（stopReason=aborted，且从未发出模型请求）。2026-09-08/09 lore 会话生产实证：21 次尝试 20 次失败；唯一成功的一次是启动程序被一个 61 秒的 grep 卡住没结束。
- **修复**：子代理改用插件自持 `AbortController`（`lib/consult.mjs`）——取消只走 `consult_stop` / `consultTimeoutMs` 看门狗 / session 销毁 `cleanupConsultSessions` 三条显式路径；`lib/index.mjs` 的 consult_start 不再传 `exec.signal`。
- **附带归因修复**：看门狗超时与显式 abort 在驱动层都坍缩成 `stopReason=aborted`，现按 `timedOut` 归因（超时不再被读成「aborted 无死因」）；预算 < 1min 时显示为秒。
- 新增 `test/consult.test.mjs`（跨回合信号解耦回归 / stop 早停 / 看门狗有界 / session 销毁清理 / 选择器语义）。
- **advisor 复审跟进**（1🟡+5🔵 同轮清零）：①🟡 `consult_check` 的调用方信号只结束本次读取，不再杀子代理（此前会落进 failed 分支被读成「child ended: aborted」），并写进头注释；②🔵 codex 行提前 return 漏掉 `clearTimeout(watchdog)`，已补 finally；③🔵 codex 行 ABORTED 也按 `timedOut` 归因；④🔵 fire-and-forget 子代理补 `.catch` 兜底（异常不再让 `pending` 永久 >0 卡死后续 check）；⑤🔵 亚秒预算不再显示 0s；⑥🔵 `consult_check`/`consult_stop`/advisor 补齐 `markSessionSeen`。
- 测试 235 → **241** 全绿。

## [0.9.1] — 2026-09-07

**R6 维护轮（D-26 十项打磨全清，登记表 27/27 终态）**

- eng/escalate codex 分支：`resolveCodexCliGlobals` 告警逐条 warn + timeout/idle 非法回落响亮告警
- `engineeringToggle` 移除未用参数（调用方与测试全部迁移，兼容 shim 删除）
- eng 单飞拒绝返回补 warnPrefix；codex/dsh 空输出统一「(empty report)」交付语义；F10 盘回填区分「已签发未传」与「从未签发」两态文案
- eng dsh 同步路径簿记收敛到模块级 `deliverBookkeeping`（四路单一实现）
- dsh 后台兜底超时信封 code=ABORTED（resolve-race 与 reject-race 双分支均触发回滚指引）
- escalate codex jobs reject 分支补 `codexThreads` 清理；eng/escalate 后台派发句柄并入配置告警（warnPrefix，对齐 advisor 先例）
- 测试 229 → **235** 全绿

## [0.9.0] — 2026-09-06

**R5：dsh 路径后台化（DP-1 方案 B）——插件自建后台机制覆盖全部四机制，DSH 平台零修改**

- **advisor dsh 循环自动后台化**：dsh 路由预算 > `codexCli.budgetCapMs` 且 ctx.jobs 可用 → 自动派后台 job 跑完整评审循环（job 内预算不钳制）；≤cap 或 jobs 缺失 → 同步 + D-17 钳制告警（同步快路径护栏保留）
- **escalate/eng dsh 显式 `background` 参数**：不传=同步（现状）；传=true → 后台 job 内跑子代理（完成通知送指针、全文经 job_output）；followup 同参数语义
- **挂死兜底**：新配置 `dshBackgroundTimeoutMs`（顶层，默认 30min，60s~60min；三面白名单 + 设置页字段）；deadline 合成 = max(任务预算, 兜底)
- **降级两段式**：派发前预检/抛错 → 同步+钳制+告警；run() 内 ctx 破裂 → job 诊断失败（不可恢复）
- 单飞复合键、代际检查、簿记-done-成功分支全套复用 R2 模式
- 工程流程契约：background 任务返回句柄，「等完成通知再继续」
- 测试 215 → 229 全绿；真机终验：dsh 路由 900s 预算自动后台化、钳制告警消失

## [0.8.0] — 2026-09-05/06

**R1-R4 机制缺陷治理（26 项登记缺陷：24 修 1 驳 1 测量收口；测试 125 → 215）**

- **R1 诊断与校验层**：effort 最近支持档回落（等距向上取，全 9 消费点收口含 codex catalog resolver）；advisor 流观测（finish.kind/usage/blocks）+ 空响应四形态分类；dsh 预算钳制；`advisor.maxOutputTokens` 可配置（三面白名单，默认 16384）
- **R2 执行架构与进程生命周期**：escalate/eng codex 路径迁 ctx.jobs（簿记 done 成功分支恰好一次）；三机制复合键 single-flight；`advisorGeneration` 代际检查（晚到 finalize 不复活已重置状态）；全局 codex 并发准入 `codexCli.maxConcurrent`（默认 8，CONCURRENCY_LIMIT fail-fast）；启动清扫陈旧临时目录；DP-1 方案 A dsh 钳制
- **R3 回落与失败语义**：回落活锁封顶（fallbackFailureCount 连败 2 次硬停 + 双路由诊断）；空响应自动重试一次（D-裁决-1）→ 仍空转可归因失败不烧轮次；prior 纯净化（机制后缀不进 lastAdvisorOutput）
- **R4 一致性与 UX**：设置页保存竞态修复（busy 全表单禁用 + 触碰字段保留）；`advisorOverride.runner` 三面同步；**token-secret 安全加固（D-25）**：公开默认密钥 → env / `$DSH_HOME/.thincoder/token-secret` 持久化随机密钥（0600，损坏自愈）/ 无持久化面响亮告警；D-15 idle 测量（3 次 high-effort 实测最大静默间隙 50s << 240s，维持 300s 默认）
- 真机验证 10 项收口（四机制 + 两受害场景：空响应与 effort 秒死活体治愈）

## [0.7.0] — 2026-09-05

**codex-cli runner 集成（一/二期 + 评审修复 + jobs 派发 + 智能回落基线入库）**

- `lib/codex-adapter.mjs`：codex exec 子进程适配器（无 shell spawn、Windows shim 解析、进程树终止、--json 事件流、-o 权威输出、idle watchdog、B8 反套娃前缀）
- 四机制接入：advisor/consult 只读沙箱、escalate/eng_coder 写沙箱（workspace-write）；followup 线程连续性（`exec resume`，内存态）
- ctx.jobs 后台派发（预算 > budgetCapMs）：完成通知指针 + job_output 全文（保尾截断）；job id branded string
- 智能回落：codex 连续 2 次失败 → 自动回落 dsh 路由一轮；`codexCli.budgetCapMs`（默认 540s，平台 600s 墙钟内安全余量）
- 设置页：runner 选择、codex 模型/effort 目录化下拉（`/catalog` 运行时注册表端点）、budgetCapMs/maxConcurrent/idleTimeoutMs 字段
- 测试 78 → 125 全绿（本版本为历史工作基线入库，版本号自 0.1.0 锚定）

## [0.6] — 2026-09-03

- **F12 会话级状态持久化**：`$DSH_HOME/.thincoder/session-state.json`（engineering/评审轮次+prior/触达文件/覆盖，跨重启恢复、只填空槽、7d TTL、与 design-tokens.json 分文件回滚独立）
- **F13 eng_coder 阶段化任务书**：`stages` 结构化参数（maxItems 10、四段渲染、阶段纪律、stage 状态表前置防掐断）
- compactMessages keyFiles 去重上限 15；测试 50 → 78

## [0.5] — 2026-09-02

- 设置页 UI 打磨：宿主语义 token（深浅色随动）、code review 2 轮 11 项修复、池保存/草稿播种修复

## [0.4] — 2026-09-02

- **二期设置页**：全局配置二层（entry base ⊕ `$DSH_HOME/.thincoder/config.json` user 层，保存即生效）；DSH 设置面板「Thincoder」页（手写 CJS 免构建）；host config API `/thincoder-suite/api`

## [0.3] — 2026-09-02

- **F10** design token 磁盘持久化（重启免重评审）；**F11** reviewType 切换重置轮次；thincoder-eng 预设 PTC 工具集；F8 判定启发式 v4

## [0.2] — 2026-09-01/02

- **一期 host 机制**：advisor 分层路由（round1/convergence）、effort 透传、会话级覆盖（advisor_config）、预算模型+超时硬生效；F8 评审通过判定修复；F9 eng_coder 资源策略

## [0.1] — 2026-09-01

- thincoder 四机制（advisor/eng/escalate/consult）移植为 DSH cordis 插件（零依赖、免构建）
