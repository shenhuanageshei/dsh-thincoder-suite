# Changelog

本插件遵循语义化版本。完整设计文档见 [`docs/`](./docs/)，工程方法论见 [METHODOLOGY.md](./METHODOLOGY.md)。

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
