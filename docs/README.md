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
| [2026-09-12-review-protocol-design.md](2026-09-12-review-protocol-design.md) | 2026-09-12 | 批 3 设计（**九章节 + 两张 mermaid 图 + 行号引用口径声明**）：背景/问题（P1–P7，含 D-33/D-34 实测根因）/目标/方案（FR-1 契约、FR-2 四值词表、FR-3 判据、FR-4 失败可见、FR-5 撤销收紧）/机制伪代码与状态机/状态与 schema（本批零 schema 变更）/防偏离（AC-V1…V22，含三条防「好心简化」的负向锁）/边界与失败方向/决策 D-a…D-i（含被否决备选）/受影响文件/部署注意——**已实施**（本机 v0.11.0；验收面 = AC-V1…V22 逐条有真实用例，全量 `node --test` **301/301** 绿；实施经三轮设计评审 + 一轮分歧审计 + 一轮交付代码评审 + 两轮修复） |

## 标准

- [METHODOLOGY.md](../METHODOLOGY.md) — 仓库工程工作流（设计→评审→实现→验证）
