# dsh017 结项说明（program closeout · 批 24–28）

- 定位：DSH 0.1.7 契约对齐程序（批 24→28）的**常设交接页**——会话会丢，档不会（D28-5）。将来任何会话接手，从本页进入：批次脉络 → 触点矩阵指针 → 护栏机制 → 平台再换契约时的标准动作。
- 权威源声明：九条触点锁的**唯一权威实现** = `lib/contract-baseline.mjs`（批 28 / D28-2 单一事实源）；本页对矩阵**只做指针 + 摘要**，批次历史细节链回各批设计档（批 28 评审 #7：避免三处并存漂移）。
- 平台版本基线：`0.1.7-rc.2`（记录时点 2026-09-26；批 24–27 的交付与宿主验收运行时）。哨兵在装配期对照该基线（`runVersionSentinel`），不一致/取不到 ⇒ 一条响亮告警、不阻断（D28-1）；用户侧常驻提示落在 `contractWatch` 工具描述（A28-2 评审 #8）。

## 一、批次脉络（24/25/26/27/28）

| 批 | 设计档 | 一句话 | 关键决策/缺陷 |
|---|---|---|---|
| 24 | [2026-09-25-dsh017-compat-design.md](2026-09-25-dsh017-compat-design.md) | DSH 0.1.7 换契约后的首次对齐：工具结果消息形状（独立 tool 角色消息）+ jobs owner（agent/session id） | D-41 · D-42 |
| 25 | [dsh017-full-alignment-design.md](dsh017-full-alignment-design.md) | 对 0.1.7-rc.2 的全面契约对齐：作业输出生产契约（run(handle)/输出环/job.result）+ 文档集指纹基座（不再拿 process.cwd() 猜）；产出九触点矩阵的原型 | D-46 · D-44 |
| 26 | [dsh017-batch26-design.md](dsh017-batch26-design.md) | 把报告拿回来 + 验证门归位：全文自持落盘（含 pathForm）、冻结门禁相对路径 fail-open、checkMode/宿主验收回执/兜底信封、九条触点常设锁落档 | D-45 · D-47 · D-48 · D26-5 |
| 27 | [dsh017-batch27-design.md](dsh017-batch27-design.md) | 残差清零：落盘目录清扫/轮转（只认四类 kind）、非法 pathForm 可见、超时解析单点、kill 语义收窄、cwdHint 透传、零落盘回归锚 | D27-1…D27-5 |
| 28 | [dsh017-batch28-design.md](dsh017-batch28-design.md) | 对外收口：上游报告包 + 版本哨兵 + contractWatch 巡检 + 契约基线单一事实源 + 本结项页 | D28-1…D28-7 |

缺陷登记（D-41…D-48）见 [2026-09-05-defect-registry.md](2026-09-05-defect-registry.md)；平台侧三问题（本仓不可修）的上游报告包见 [upstream-2026-09-26-platform-issues.md](upstream-2026-09-26-platform-issues.md)。

## 二、九条触点矩阵（指针 + 摘要；权威源 = lib/contract-baseline.mjs）

- **机验权威**：`evaluatePlatformSurfaceLocks()`（`lib/contract-baseline.mjs`）——九条一律按源码文本/夹具文本求值，恒返回九条 `{ id, ok: true|false|"unknown", evidence }`（D28-7：取不到文本记 unknown 而非 false）。
- **消费方**：`test/platform-surface.test.mjs`（每条一个独立转红的断言腿 + A26-6/7/8 行为腿）与 `contractWatch` 工具（一次调用出全量巡检报告）。同源由 A28-5 静态锁守护（实现标记 grep 唯一）。
- 下表是**摘要**；每条断言什么、怎么算转红，以基线档内实现与其 evidence 为准。

| 锁 id | 触点摘要 | 批次细节链 |
|---|---|---|
| ps1-llm-tool-result-msg | 工具结果必须是独立 tool 角色消息（消息级 toolCallId/isError/source），0.1.6 旧形状零残留 | 批 24 设计档（D-41）· 批 26 §2.3 #1 |
| ps2-jobs-start-owner | jobs.start 的 owner 必须 = ownerIdOf(agent)（四档七处一一对应，零处直传 Agent） | 批 24 设计档（D-42）· 批 26 §2.3 #2（derived，两处同改） |
| ps3-jobs-output-contract | run(handle) 收句柄 + 正文经 jobOutcome 收口（0.1.7 输出环/job.result） | 批 25 设计档（D-46）· 批 26 §2.3 #3（derived，两处同改） |
| ps4-home-probe-dual-name | home 探测同时认 settings.yaml 与 settings.yaml.imported（sessions/ 特征仍在） | 批 24/25 矩阵 #4 · 批 26 §2.3 #4（derived，两处同改） |
| ps5-subagents-start-shape | subagents.start 全部调用点的参数键 ⊆ 平台已知九键并集（六个调用点） | 批 25 矩阵 #5 · 批 26 §2.3 #5 |
| ps6-agent-session-fields | lib 消费面逐点消费 session.id / delegationDepth / header.cwd / options.provider·model / maxTokens | 批 25 矩阵 #6 · 批 26 §2.3 #6 |
| ps7-registration-surface | 注册面期望计数 = 实测基线（批 28 上调 textTool 7→8：contractWatch，D28-6） | 批 26 §2.3 #7 · D28-6（登记处 = REGISTRATION_SURFACE_BASELINE 注释） |
| ps8-request-rejection-fence | web 路由处理函数首个业务调用 = 信任栅栏（先取 connection 再问请求拒绝，契约外 503） | 批 22/24 矩阵 #8（D-39）· 批 26 §2.3 #8 |
| ps9-dispatch-copy-persisted-path | 派发文案首选落盘文件、job_output 降为附加（读取面不在本仓的插件侧取向） | 批 26（D-45）§2.3 #9 |

## 三、四道护栏

1. **设计令牌 + 文档集指纹（docHash）**：`advisor(type='design')` 通过后签发两段式令牌（uuid:expiresAt）并绑定**当时文档集的指纹**；`eng_coder` 只认令牌；评审窗口内文档漂移 ⇒ 预闸冻结窗口拦截 + 结算侧不签发（guard E：`test/guard-e.test.mjs`）。令牌不是密钥，是「这份设计评审过」的精确事实。
2. **锚 / AC（每批设计档 §5）**：机验锚（A-批号-N）与验收标准（AC-批号-N）逐条可独立转红——「改了契约面却不改档」会在锚上红，「交付了却没达成验收」在 AC 上红。
3. **常驻锁**：九条平台触点锁（§二）+ 登记闸（T-E19：新增测试档必须登记）+ 执行面计数（T-SG4）+ 台账四方一致（`test/test-lifecycle.test.mjs`：台账 ↔ fs ↔ T-E19 ↔ 退役授权面）+ U+FFFD/登记完备等文档纪律锁（`test/doc-hygiene.test.mjs`）。被合法变更撞到的锁**同批上调并在档内写明理由**（先例：批 26 §2.5 对 T-SG4；批 28 D28-6 对 #7）。
4. **宿主验收回执**：dsh 路径的 check 命令缺省 `checkMode:"host"`——**宿主**在交付后逐条执行，回执（退出码 + 尾部输出 + 验收：PASS/FAIL）写进交付报告（D48-2）；执行面独立超时 120s（`lib/host-check.mjs`），失败不改作业终态；兜底超时的信封自带 check 命令原文与取证指路（D48-3）。

## 四、平台换契约时的标准动作

1. **先跑巡检**：调 `contractWatch` 工具（一次调用 = 平台版本 + 来源 evidence + 九条锁 + 落盘目录盘点）。装配期哨兵告警的文案会把人指到这里与基线档。
2. **对照矩阵**：拿红了的锁 id 对照 §二矩阵与 `lib/contract-baseline.mjs` 内该锁的实现/evidence，定位平台改的是哪个触点、波及哪些消费面（derived 锁注明「两处同改」的伙伴档）。
3. **开新批**：写设计档（来源 = 一手实测证据；哪些锁会被撞、哪些基线要上调，**在档内写明**——先例：批 26 §2.5 对 T-SG4、批 28 D28-6 对 #7）→ 设计评审（advisor）→ 实现（eng_coder，宿主验收）→ 登记级联（台账 · CHANGELOG · 版本 · 事实 id）由主代理收口。
4. **不要做的事**：不要绕过锁临场解释（被自家锁打红 = 先改锁理由后改代码，次序不能反）；不要让哨兵/巡检阻断装配（只警告不阻断——D28-1，拒启动会成为新的砖化源）；不要手工修平台侧问题（上游问题只出报告与只读复现——D28-3，见上游报告包）。
