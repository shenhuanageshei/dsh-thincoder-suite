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

## 标准

- [METHODOLOGY.md](../METHODOLOGY.md) — 仓库工程工作流（设计→评审→实现→验证）
