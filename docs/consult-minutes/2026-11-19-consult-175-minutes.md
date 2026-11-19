# 会诊纪要 —— consult #175（原始层，机制落盘）

- 日期：2026-11-19
- 会诊 id：175
- 模型：deepseek-official:deepseek-flash, zai-coding-cn:glm-5.3, deepseek-official:deepseek-v4-pro, fangzhou-codeplan:kimi-k3.1-pro
- 平台 job：consult-5d9c55fc09ac4e3c
- 结果：0/4 交付（其中 0 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #175 finished — 0 of 4 replied (4 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #175 finished — 0 of 4 replied (4 failed)]
effective: 0 of 4 (4 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。★ 0.2.1 路线补充：只读依据 = **只下发 `agentPreset` 的 id**；预设**只能收窄它自己贡献的那一层**，其它插件在宿主面全局注册的工具**不受预设隐藏**（平台语义：作用域注册只遮蔽全局）⇒ 上述「白名单下发」弱证口径仅适用于老宿主路线。
models: deepseek-official:deepseek-flash, zai-coding-cn:glm-5.3, deepseek-official:deepseek-v4-pro, fangzhou-codeplan:kimi-k3.1-pro
job: consult-5d9c55fc09ac4e3c
minutes: docs/consult-minutes/2026-11-19-consult-175-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] fangzhou-codeplan:kimi-k3.1-pro — failed
(consultation failed: Cannot read properties of undefined (reading 'id'))

[2] zai-coding-cn:glm-5.3 — failed
(consultation failed: Cannot read properties of undefined (reading 'id'))

[3] deepseek-official:deepseek-flash — failed
(consultation failed: Cannot read properties of undefined (reading 'id'))

[4] deepseek-official:deepseek-v4-pro — failed
(consultation failed: Cannot read properties of undefined (reading 'id'))
```

## §2 逐问裁定（**主代理写**）

> 待主代理填写：每条意见**恰一条处置**——采纳 / 不采纳（**必附理由**）/ 待定。

## §3 分歧与父侧裁定（**主代理写**）

> 待主代理填写。

## §4 教训（**主代理写**）

> 待主代理填写。

## §5 不可验清单（**主代理写**）

> 待主代理填写。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-11-19 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |

## §2 裁定层（主代理写）

**本次会诊 = 连通性自检，0/4 交付。** 四行失败文案逐字相同：

```text
(consultation failed: Cannot read properties of undefined (reading 'id'))
```

→ **不是模型/凭据问题，是派发层的平台契约漂移**。判定与修复见下方 §4。

## §3 分歧

无（0 条有效回复，无分歧可判）。

## §4 教训（本次最有价值的一条）

1. **「读了平台源码」不等于「读的是运行中的那一版」**：`D:\workspace\deepseek-harness` 的 `master` 停在
   `0.2.2-rc.1`（`fcc0ad46`），而运行中的是 **`0.2.2-rc.5`**。本次靠 **npm 发布的 rc.5 包**
   （`@deepseek-ai/dsh-subagent@0.2.2-rc.5`）才看到真实契约。
2. **裸 TypeError 是「契约断层」的典型指纹**：`Cannot read properties of undefined (reading 'id')`
   来自平台 `lib/index.js`：`agents.get(spec.parent.id) !== spec.parent` —— 我们没把 `parent` 放到
   `spec` 顶层（rc.1 的形状是 `spec.request.parent`，rc.5 把 spec **压平**了）。
3. **单点派发救了三路**：会诊 / eng_coder / escalate 共用 `lib/subagent-dispatch.mjs` 一个入口 ⇒
   一处修复三条路同时恢复；否则要改三处并各自回归。

## §5 不可验

- 修复后的**运行时**行为：`lib/**` 不热重载，**必须重启 DSH 才能验证**（本轮未重启 ⇒ 未验）。
- `escalate` 的 dsh 路线仍按设计拒绝（无法保证 deny 工具面），这与会诊失败**无关**，也未在本轮改变。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-11-19 | 机制落盘（§0/§1）；裁定层 §2–§5 由主代理补写 |
