# thincoder-suite 文档地图

> 规则：每个机制只在**一处**详述，其他文档引用不复制；新建文档必须先登记到本地图。

## 设计文档

| 文档 | 日期 | 主题 |
|---|---|---|
| [2026-09-01-advisor-config-design.md](2026-09-01-advisor-config-design.md) | 2026-09-01 | advisor 可配置分层路由：round1/convergence 双组模型、reasoningEffort 透传、评审记忆开关、会话级覆盖、超时硬生效、二期 DSH 设置页 UI（PROPOSED） |
| [2026-09-02-thincoder-suite-extensions-design.md](2026-09-02-thincoder-suite-extensions-design.md) | 2026-09-02 | F10 design token 磁盘持久化（重启存活）+ thincoder-eng 预设 PTC 工具集（PROPOSED） |
| [2026-09-02-settings-ui-design.md](2026-09-02-settings-ui-design.md) | 2026-09-02 | 二期：DSH 设置页「Thincoder」全局配置编辑器（config.json user 层 + 手写 CJS client；U 系列验收；定案取代 2026-09-01 §4/§5.2）——已实施（v0.4） |
| [2026-09-02-session-state-stages-design.md](2026-09-02-session-state-stages-design.md) | 2026-09-02 | F12 会话级状态持久化（engineering/评审轮次重启恢复）+ F13 eng_coder 阶段化任务书（stages）+ D 复核（工具输出已 64K，keyFiles 改进）——设计输入为会诊（consult 2026-09-02）——已实施（v0.6） |
| [2026-09-05-defect-remediation-requirements.md](2026-09-05-defect-remediation-requirements.md) | 2026-09-05 | 机制缺陷治理 R0-R4：需求三层（不变式总体目标 / 12 用户故事 / 7 非功能标准）——设计输入为会诊（consult 2026-09-05，2/3 回复）——PROPOSED |
| [2026-09-05-defect-registry.md](2026-09-05-defect-registry.md) | 2026-09-05 | 缺陷登记表 D-01…D-24（LIVING）：thorough 审计定稿，含平台 jobs 契约五条与已核清非缺陷清单 |
| [2026-09-05-defect-remediation-design.md](2026-09-05-defect-remediation-design.md) | 2026-09-05 | 分轮修复设计 R1-R4（诊断校验/执行架构/回落语义/一致性 UX）+ UI 决策 + DP-1/2/3 决策点——PROPOSED |
| [2026-09-11-token-lifecycle-requirements.md](2026-09-11-token-lifecycle-requirements.md) | 2026-09-11 | D-30 design token 生命周期：需求三层（授权与时限解耦总目标 / 8 用户故事 / 7 非功能标准）——设计输入为会诊 id 3（1/4 回复，3 超时；两条范围缺口 G1/G2 经父侧实证采纳）——已实施（v0.10.0；**验收面构成**：AC-1…AC-27 中 26 条有专用用例，AC-12 由 AC-13 的无 `docHash` 记录路径实质覆盖，全量 `node --test` **274/274** 绿；实施过程含首轮「零新增用例」被分歧审计揭穿后的补用例轮，七轮记录见设计档 §5.2） |
| [2026-09-11-token-lifecycle-design.md](2026-09-11-token-lifecycle-design.md) | 2026-09-11 | D-30 设计（批 2）：FR-T1…T9（两段化 / 删密钥链 / 审批码无状态派生 / TTL 7d / doc-hash 门控续期 / 文案四分支 / 会话口径 / token-store 两缺口 / 旧格式迁移）+ 27 验收 AC-1…AC-27 + 决策 D1…D11 + 3 遗留风险——已实施（v0.10.0；**验收面构成**：AC-1…AC-27 中 26 条有专用用例，AC-12 由 AC-13 的无 `docHash` 记录路径实质覆盖，全量 `node --test` **274/274** 绿） |

## 吸收面

| 文档 | 日期 | 主题 |
|---|---|---|
| [2026-09-12-absorption-inventory.md](2026-09-12-absorption-inventory.md) | 2026-09-12 | **thincoder 吸收清单（43 批次档全量、可追溯）——吸收面的单一事实源**：§1 实测痛点 7 条 / §2 全量对照表（43 行，含 T-ONLY 硬裁剪） / §3 跨批主题 / §4 上游反转与陷阱 14 条 / §5 明确不吸收 7 类 / §6 批次排序与两份报告分歧裁定。来源 = 会诊 id 1（4 模型并发、2 份有效）+ 父侧逐条回代码核验（已抓到并纠正 1 处误报） |
| [2026-09-12-review-protocol-requirements.md](2026-09-12-review-protocol-requirements.md) | 2026-09-12 | 批 3 需求三层：评审协议增强（四值词表 / VERDICT 收尾行 / R1–R7e 判据）——7 用户故事 / 6 非功能标准 / 5 条范围边界。设计输入 = 会诊 id 2 |
| [2026-09-13-context-budget-requirements.md](2026-09-13-context-budget-requirements.md) | 2026-09-13 | 批 5 需求三层：评审上下文预算跟随模型窗口 + 估算器 CJK 加权（6 用户故事 / 6 非功能标准 / 4 条登记面）。设计输入 = 会诊 id 1（3/4 回复）+ 父侧只读勘察（DSH 运行时窗口通道）；含 §0 会诊汇总（分歧与父侧裁定）——**已实施**（v0.11.0） |
| [2026-09-13-context-budget-design.md](2026-09-13-context-budget-design.md) | 2026-09-13 | 批 5 设计（**九章节 + 两张 mermaid 图 + 行号引用口径声明**）：三级窗口解析链（手配 > `llm.resolveModelInfo` 运行时权威 > 保守兜底 131072）/ 比例式两档（`floor(窗口×0.8)` 与 `×0.8`）/ 估算器 CJK 加权（纯 ASCII 逐值零回归）/ 配置三面同步 + 设置页六条 UI 规格 / 防偏离（AC-CB1…AC-CB9 + 反向控制）/ 决策 D-CB1…D-CB11（含否决备选）——**已实施**（v0.11.0；全量 `node --test` **320/320**，既有 304 原样全绿；AC-CB1…AC-CB9 逐条有可失败断言；独立分歧审计 1🔴 已修 + 交付代码评审 PASS） |
| [2026-09-13-design-review-guard-requirements.md](2026-09-13-design-review-guard-requirements.md) | 2026-09-13 | 批 4 需求三层：设计评审豁免 5 轮上限 + 三振结算护栏（**成对吸收**；6 用户故事 / 6 非功能标准 / 4 条登记面）。设计输入 = 会诊 id 2（**2/4 交付，另 2 份因 DSH 非正常结束不可复得**）；含 §0 会诊汇总（7 条分歧/补充裁定）——**已实施**（v0.12.0） |
| [2026-09-13-design-review-guard-design.md](2026-09-13-design-review-guard-design.md) | 2026-09-13 | 批 4 设计（**九章节 + 两张 mermaid 图 + 行号引用口径声明**）：cap 仅 code（豁免落点唯一）/ 三振预检在类型切换**之前**（零副作用）/ 键 = **纯路径形状**（`normalizeDocPath`，非内容哈希——父侧裁定）/ 计数 = 会话内存（照抄 `codexFailureCount` 先例）/ 机械 kind 归类（不用散文猜）/ 拒绝串六项必备（含**防乒乓**）/ 与硬停轴正交不自解除 / 防偏离（AC-G1…AC-G9，含**摘除即红**的成对锁）/ 决策 D-G1–D-G12（含两处分歧的父侧裁定与否决备选）——**已实施**（v0.12.0；全量 `node --test` **342/342**，既有 320 原样全绿；AC-G1…AC-G11 逐条有可失败断言；独立分歧审计 2🟡/1🔵 已修 + 交付代码评审 PASS（1🟡/4🔵 已处置）；含 §12 D-35 折入 / §13 设计评审修正块 / §13.1 D-1 偏差裁定 / §14 分歧审计修复轮 / §15 交付代码评审微修轮） |
| [2026-09-13-death-diagnosability-requirements.md](2026-09-13-death-diagnosability-requirements.md) | 2026-09-13 | 批 6 需求三层：死亡可诊断（守卫 D 判定换血 + 四家族 abort 溯源 + 裸 abort 灭绝；5 用户故事 / 5 非功能标准 / 4 条登记面 + 出批与缓议）。设计输入 = 会诊 id 1（**2/2 交付**，含对我方勘察的**两处前提纠错**）——**设计待评审** |
| [2026-09-13-death-diagnosability-design.md](2026-09-13-death-diagnosability-design.md) | 2026-09-13 | 批 6 设计（**九章节 + 两张 mermaid 图 + 行号引用口径声明**）：新模块 `lib/abort-provenance.mjs`（唯一词汇表：trigger 5 值 / layer 4 值 / `deathLine` 合成器）/ 墙判定**换血**（文本嗅探 → 信号状态 + latch，抛错与返回两形态同判）/ 0.75 一次性预算提示（纯函数）/ 超时尾扩容（前缀逐字）/ 四家族接线 + 五处裸 `abort()` 灭绝 / 防偏离（AC-AP1…AC-AP9，含四分辨矩阵与未知态显式）/ 决策 D-AP1–D-AP11（含否决备选）——**已实施**（v0.13.0） |
| [2026-09-13-guard-e-consult-minutes.md](2026-09-13-guard-e-consult-minutes.md) | 2026-09-13 | **批 6b 会诊纪要**（会诊 id 1 守卫 E；**4/4 交付**：v4-pro / glm-5.3 / gpt-6-astra / kimi-k3）：§1 四家一致 11 条直接落地 / §2 **五处分歧父侧裁定**（① 闭包捕获 vs 读活 state ② 子代理拦不拦 ③ **失配是否计三振** ④ fail 朝向扁平 vs 分层 ⑤ 其余三处）/ §3 登记六项 O-E1…O-E6 / §4 七个最易栽点 / §5 可翻转性声明 |
| [2026-09-13-guard-e-requirements.md](2026-09-13-guard-e-requirements.md) | 2026-09-13 | 批 6b 需求三层：守卫 E（在途窗口冻结 + 预闸拦截 + 结算侧指纹兜底；7 用户故事 / 7 非功能标准 / §5.1 六项不做 + §5.2 七项登记）。设计输入 = 会诊 id 1（**4/4 交付**）；含 §0 会诊汇总（5 处分歧与父侧裁定）。核心问题 **F17 型漏洞**（令牌指纹 = 派发前快照，签发时不复检）——**已实施（v0.14.0）** |
| [2026-09-13-guard-e-design.md](2026-09-13-guard-e-design.md) | 2026-09-13 | 批 6b 设计（**九章节 + 两张 mermaid 图 + 行号引用口径声明**）：槽位载荷扩容（位置参数，既有 **6** 调用点零改动——批前 advisor ×2/eng ×2/escalate ×2；**批后仍三参 = 4**，计数经分歧审计 F3 订正，原文误记 5）/ 预闸=**独立** `tools/pre-execute` 监听器（与写门禁三条结构性差异：fail 朝向相反 · depth 不豁免 · 拒域不相交）/ **扫全表**拦子代理 / **闭包捕获**铸造对 / finalize 签发前指纹复检（漂移 ⇒ 不签发 · 不撤销 · 不计振 · 复位轮次）/ **分层 fail 朝向** / 防偏离（AC-E1…AC-E21 + 机验锚 **A1…A10**，谓词三要素写全）/ 决策 D-E1–D-E17——**已实施（v0.14.0）**：设计评审轮次 1 `FAIL`（🔴1 已修 → AC-E20）→ 轮次 2 `PASS` → 实施 → 独立分歧审计 **🔴0 🟡1 🔵5**（F1/F2 修复轮，变异自证可失败）→ 交付代码评审 `PASS`（🔴0 🟡1 🔵4）；全量 `node --test` **384/384**，既有 360 原样全绿；含 §12.1–§12.8 全流程落档 |
| [2026-09-12-review-protocol-design.md](2026-09-12-review-protocol-design.md) | 2026-09-12 | 批 3 设计（**九章节 + 两张 mermaid 图 + 行号引用口径声明**）：背景/问题（P1–P7，含 D-33/D-34 实测根因）/目标/方案（FR-1 契约、FR-2 四值词表、FR-3 判据、FR-4 失败可见、FR-5 撤销收紧）/机制伪代码与状态机/状态与 schema（本批零 schema 变更）/防偏离（AC-V1…V22，含三条防「好心简化」的负向锁）/边界与失败方向/决策 D-a…D-i（含被否决备选）/受影响文件/部署注意——**已实施**（本机 **v0.10.0**——批 3 未 bump 版本号，`v0.11.0` 系本索引旧误记，已于批 5 修正；验收面 = AC-V1…V22 逐条有真实用例，全量 `node --test` **301/301** 绿；实施经三轮设计评审 + 一轮分歧审计 + 一轮交付代码评审 + 两轮修复） |

## 交接

- [2026-09-13-handoff.md](2026-09-13-handoff.md) — **新会话入口**：进度快照（批 1/2/3/4/5/6 已交付，6b/7/8/9/10 + D-31 待办）· 每批必走的链路与**吃过亏的纪律**（锚的谓词三要素 / 判定族字面只追加 / 禁 PowerShell 改代码 / 两次设计评审间插一次代码评审）· 环境事实（junction 实时 / 令牌是内存态 / DSH 约 2 小时崩一次）· 未决缺陷 · **已就绪的设计输入**（批 6b 守卫 E 与批 7 可移植性，不必重新会诊）· 新会话第一小时建议

## 标准

- [METHODOLOGY.md](../METHODOLOGY.md) — 仓库工程工作流（设计→评审→实现→验证）
