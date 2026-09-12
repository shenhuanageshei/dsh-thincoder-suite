# Changelog

本插件遵循语义化版本。完整设计文档见 [`docs/`](./docs/)，工程方法论见 [METHODOLOGY.md](./METHODOLOGY.md)。

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
