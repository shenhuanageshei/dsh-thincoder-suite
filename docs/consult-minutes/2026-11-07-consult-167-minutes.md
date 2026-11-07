# 会诊纪要 —— consult #167（原始层，机制落盘）

- 日期：2026-11-07
- 会诊 id：167
- 模型：llmqax:deepseek-v4-flash, zai-coding-cn:glm-5.3, deepseek-official:deepseek-v4-pro, fangzhou-codeplan:kimi-k3.1-pro
- 平台 job：consult-b51643d10e354ba0
- 结果：1/4 交付（其中 1 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #167 finished — 1 of 4 replied (3 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #167 finished — 1 of 4 replied (3 failed)]
effective: 1 of 4 (3 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。★ 0.2.1 路线补充：只读依据 = **只下发 `agentPreset` 的 id**；预设**只能收窄它自己贡献的那一层**，其它插件在宿主面全局注册的工具**不受预设隐藏**（平台语义：作用域注册只遮蔽全局）⇒ 上述「白名单下发」弱证口径仅适用于老宿主路线。
models: llmqax:deepseek-v4-flash, zai-coding-cn:glm-5.3, deepseek-official:deepseek-v4-pro, fangzhou-codeplan:kimi-k3.1-pro
job: consult-b51643d10e354ba0
minutes: docs/consult-minutes/2026-11-07-consult-167-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] fangzhou-codeplan:kimi-k3.1-pro — failed
(consultation failed: subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents)

[2] zai-coding-cn:glm-5.3 — failed
(consultation failed: subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents)

[3] deepseek-official:deepseek-v4-pro — failed
(consultation failed: subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents)

[4] llmqax:deepseek-v4-flash — ok
1. 确认收到本次路由连通性探测，我这一行已进入会诊池并成功应答。
2. 据系统提示，我由 deepseek-v4-flash 驱动，对应 `llmqax:deepseek-v4-flash` 那一行。
3. 一句话猜测：400 只出现在子代理路径，最可能是两条路径的请求体序列化不同（子代理把工具 schema、preset 变量或 endpoint/max_tokens 拼出了 provider 不认的字段），同一 provider 的正常对话走的是已校验的那套请求形状，所以只有子代理侧被 INVALID_REQUEST 拒掉。
```

## §2 逐问裁定（**主代理写**）

本次会诊性质：路由连通性探测（用户指令「你都测一下」），处置对象是每行路由是否可用的证据。

| # | 来源 | 处置 | 理由 |
|---|---|---|---|
| 1 | llmqax:deepseek-v4-flash 回复 | 采纳（连通性证据） | 3 行中文实质回复，行为符合探测要求 ⇒ 该行经会诊子会话路径端到端可用 |
| 2 | 同回复第 3 点（序列化差异猜测） | 不采纳为结论，登记为未验假设 | 模型推测无直接证据；方向与 R-46-3 剩余项一致但粒度更粗，本轮不验 |
| 3 | zai-coding-cn:glm-5.3 — failed | 不构成路由判定 | 失败正文为 subagent limit reached (active child limit: 8)：派发期槽位拒绝，LLM 调用从未发生，需重测 |
| 4 | deepseek-official:deepseek-v4-pro — failed | 不构成路由判定 | 同上（child-limit 拒绝，非 HTTP 400） |
| 5 | fangzhou-codeplan:kimi-k3.1-pro — failed | 不构成路由判定 | 同上 |

## §3 分歧与父侧裁定（**主代理写**）

无模型间分歧（有效回复仅 1 条）。父侧裁定：被 child-limit 拒绝的 3 行不算测试结果，改为单行串行重测（每次只占 1 个子代理槽位）；8 槽的其余占用者是谁，本会话不可内省（见 §5）。

## §4 教训（**主代理写**）

派发期失败 ≠ 路由失败：subagent limit reached 发生在 LLM 请求之前，对路由可用性零证据力；digest 三类失败共用 (consultation failed: …) 前缀，必须读正文区分基础设施拒绝与 HTTP 错误。满载平台上做池测试，串行单行派发比并行整池派发更稳。

## §5 不可验清单（**主代理写**）

- active child limit: 8 的其余占用者身份——本会话没有列出平台活跃子代理集合的工具，不可验。
- llmqax 回复第 3 点的序列化差异假设——需 R-46-3 受控开关实验（下一批），本次不验。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-11-07 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |
| 2026-11-07 | 裁定层补写（§2–§5）：llmqax 行采纳为连通证据；3 行 child-limit 拒绝不构成判定，改单行串行重测 |
