# 会诊纪要 —— consult #178（原始层，机制落盘）

- 日期：2026-11-19
- 会诊 id：178
- 模型：deepseek-official:deepseek-flash
- 平台 job：consult-eda20dd43da14597
- 结果：1/1 交付（其中 1 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #178 finished — 1 of 1 replied (0 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #178 finished — 1 of 1 replied (0 failed)]
effective: 1 of 1 (0 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。★ 0.2.1 路线补充：只读依据 = **只下发 `agentPreset` 的 id**；预设**只能收窄它自己贡献的那一层**，其它插件在宿主面全局注册的工具**不受预设隐藏**（平台语义：作用域注册只遮蔽全局）⇒ 上述「白名单下发」弱证口径仅适用于老宿主路线。
models: deepseek-official:deepseek-flash
job: consult-eda20dd43da14597
minutes: docs/consult-minutes/2026-11-19-consult-178-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] deepseek-official:deepseek-flash — ok
子代理派发就是把一个任务连同上下文和权限边界交给一个独立会话去跑、再把它带回的结论收回来的机制——说人话就是「分身干活、本体收账」。

（另：这次回复本身就是证据——**派发链路已通**，`spec.parent` 读 `.id` 的那个 TypeError 没再出现。）
```

## §2 逐问裁定（**主代理写**）

| # | 意见摘要 | 处置 | 理由 |
|---|---|---|---|
| 1a | 子代理派发 = 把任务连同上下文与权限边界交给独立会话、收回结论 | **采纳** | 与本仓 `lib/subagent-dispatch.mjs` 的契约一致：`parent`/`prompt`/`cwd`/`agentPreset` 原样透传，能力面按 provider 声明的 capabilities 判（不猜、不降级放行） |
| 1b | 「这次回复本身就是证据——派发链路已通」 | **采纳** | 有独立读数支撑，不靠对方自证：digest 首行 `1 of 1 replied (0 failed)`；对照同日 #175/#176 的 `0/4`（同一插件、同一平台）。派发面由失败转成功 = 该断言的机器证据 |

## §3 分歧与父侧裁定（**主代理写**）

无分歧：单模型、单条回复，无对立主张可供裁决。

父侧裁定：**#178 的用途是「重启后的派发存活探针」，不是设计取舍。** 它不进入任何设计档的决策链，也不改变 #175/#176 已落的根因结论（根因已在 `d5b5ffc` 的提交信息与 §0 中定案）。

## §4 教训（**主代理写**）

1. **「提交」不等于「生效」。** `lib/**` 不热重载（批 46 已用探针实证）；`d5b5ffc` 提交之后 #176 仍 0/4，失败原因恰恰是「跑的还是旧代码」。#178 是修复后第一次真正验到生效——**中间差的就是一次重启**。
2. **探针要挑最短路径。** 一行问题 + 单模型，判据只有一条「有没有回复」，成本约 1 分钟；比再跑一次 4 模型会诊省 3/4 的预算，而结论强度不变（失败形态是**全灭**，不是概率性抖动，1 条足够区分）。
3. **单点派发在这里付了红利。** `grep dispatchSubagent(` 显示 consult / eng / escalate / codex **四条路**全部走 `lib/subagent-dispatch.mjs` 单入口 ⇒ 一处修复四条路；回归锁 T-30c 只锁一处形状即可。

## §5 不可验清单（**主代理写**）

- **eng_coder 未做活体派发。** 它要求 advisor(design) 的 PASS token 才能启动，构造该前置的成本远高于探针价值。当前依据是「与 consult 共用同一单入口 + T-30b/T-30c 离线锁」——这是**推断**，不是实测，如实标未验。
- **escalate 未做活体派发。** dsh 路线按设计 fail-closed（本部署无法保证 deny 工具面）；codex 路线需配 runner ⇒ 当前配置下它**不可能**成功。「未验」在此等同于「按设计不可用」。
- **平台除 rc.5 以外的宿主形状。** 本次只验 rc.5 一种；「两形并存、覆盖 ≤rc.1」目前只有 T-30c 的哑宿主断言，**无活体验证**。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-11-19 | 机制落盘（§0 汇总 + §1 原始层） |
| 2026-11-19 | 裁定层补齐（§2–§5）：单条意见 1a/1b 均采纳；本纪要用途 = **重启后的派发存活探针**，不进设计决策链 |
