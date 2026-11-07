# 会诊纪要 —— consult #168（原始层，机制落盘）

- 日期：2026-11-07
- 会诊 id：168
- 模型：deepseek-official:deepseek-v4-pro
- 平台 job：consult-63308e77d2a94f9e
- 结果：1/1 交付（其中 1 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #168 finished — 1 of 1 replied (0 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #168 finished — 1 of 1 replied (0 failed)]
effective: 1 of 1 (0 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。★ 0.2.1 路线补充：只读依据 = **只下发 `agentPreset` 的 id**；预设**只能收窄它自己贡献的那一层**，其它插件在宿主面全局注册的工具**不受预设隐藏**（平台语义：作用域注册只遮蔽全局）⇒ 上述「白名单下发」弱证口径仅适用于老宿主路线。
models: deepseek-official:deepseek-v4-pro
job: consult-63308e77d2a94f9e
minutes: docs/consult-minutes/2026-11-07-consult-168-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] deepseek-official:deepseek-v4-pro — ok
(1) 已收到本探测，确认这是针对 `deepseek-official:deepseek-v4-pro` 路由连通性的串行重测。

(2) 我本次被配置为 `deepseek-official:deepseek-v4-pro`。

(3) 是的，本回复由该模型的正常推理链路生成，未走缓存或降级兜底。
```

## §2 逐问裁定（**主代理写**）

本次会诊性质：路由连通性串行重测第 1 行（deepseek-official:deepseek-v4-pro），处置对象是路由可用性证据。

| # | 来源 | 处置 | 理由 |
|---|---|---|---|
| 1 | deepseek-official:deepseek-v4-pro 的回复 | 采纳（连通性证据） | 3 点实质回复 ⇒ 该行经会诊子会话路径端到端可用 |

## §3 分歧与父侧裁定（**主代理写**）

无分歧（单行单回复）。父侧登记关键差分读数：同一 provider + 同一 model（deepseek-official:deepseek-v4-pro）在 advisor 收敛路径 = HTTP 400 INVALID_REQUEST（批 46 §12.4 实测窗口 22:47–22:52），在会诊子路径 = 正常应答（本测约 23:05，间隔约 13 分钟）⇒ 400 触发面收窄为 advisor 路径的请求形态（tools/system/messages/sessionId/streamOpts），非 provider、凭据或模型本身。

## §4 教训（**主代理写**）

provider 坏了与路径坏了必须分开判定：本行与 advisor 400 共用 provider、key、适配器，唯一变量是请求来源路径——该差分法正是 R-46-3 受控开关实验应沿用的方法。

## §5 不可验清单（**主代理写**）

- 回复中「未走缓存或降级兜底」为模型自述，本会话无法独立验证；连通性结论只依赖实质回复到达这一事实。
- deepseek-flash（非本池行）在会诊路径是否可用——未测（不在池内，不可点名）。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-11-07 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |
| 2026-11-07 | 裁定层补写（§2–§5）：v4-pro 行经会诊子路径可用；与 advisor 路径 400 构成同 provider 差分，R-46-3 触发面收窄为 advisor 请求形态 |
