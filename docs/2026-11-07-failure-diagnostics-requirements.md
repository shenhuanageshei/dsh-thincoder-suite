# 批 46 需求：失败面可诊断性 + purpose 隔离能力

<!-- doc-shape
count-marks: 项|处|条|档|版|组
-->

> **状态**：**设计评审 PASS**（2026-11-07）· 实施已交付，收口中（设计档见 [2026-11-07-failure-diagnostics-design.md](2026-11-07-failure-diagnostics-design.md)：§12.2 评审处置 / §12.3 实施落档）
> **日期**：2026-11-07
> **触发**：批 45 验收期追查 `deepseek-official` 的 `400` 时，**一整天没能定位根因**——不是查得不够，是**插件把诊断信息丢了**。

---

## §一 总目标（不变式）

> **失败必须可判读**：当一次 LLM / codex 调用失败时，报告里要同时有「**人话**」和「**机械事实**」，而不是二选一。

本批**不改任何评审判定逻辑**，只改「失败时说什么」与「能不能做受控对照实验」。

---

## §二 背景与问题（各带一手证据）

### §2.1 问题 A：`userMessage || diagnostics` 二选一，真因被吞（6 处）

> 同一天内**两次**撞上同一个病灶：
> - 早上验飞刀：只拿到「codex 进程失败（非零退出且无有效输出）」，看不到 exit / stderr；
> - 下午查 400：只拿到「DeepSeek Messages request failed (400)」，看不到 code / status / requestId。

| 位置 | 现状 |
|---|---|
| `lib/advisor.mjs:2598` · `:2686` · `:2710` | `(env.userMessage \|\| env.diagnostics \|\| "unknown error")` |
| `lib/escalate.mjs:216` · `:282` | 同型 |
| `lib/eng.mjs:1512` | 同型 |

**对照组**：`lib/consult.mjs:1251-1252` 在**批 30（D-58 / 锚 A30-9③）**已经修过同一个病，注释白纸黑字写着「此前 `userMessage || diagnostics` 是二选一，`userMessage` 在场就把真因吞掉」。**会诊修了，其余三处没修。**

### §2.2 问题 B：advisor 观测行不读 `failure` 的结构化字段

平台 `LlmFailure` 的契约字段（`dsh-llm` 0.2.2 实测）：

```ts
interface LlmFailure {
  readonly message: string
  readonly code: string        // 稳定机读码：INVALID_REQUEST / AUTH / QUOTA / RATE_LIMIT …
  readonly status?: number     // 提供方 HTTP 状态
  readonly providerRetryAfterMs?: number
  readonly requestId?: ProviderRequestId   // 提供方请求 id（可用于向他们侧对账）
}
```

本仓 `failure.code` / `failure.status` / `failure.requestId` **全仓零处读取**（grep 实测）。⇒ 400 时只能显示平台兜底文案，**无法区分「请求非法 / 鉴权 / 配额 / 服务端」**。

### §2.3 问题 C：`purpose` 字段无法隔离，导致 400 根因悬空

`lib/advisor.mjs:1555` 恒定发送 `purpose: "thincoder-advisor"`。而正常对话请求**没有**这个字段——且正常对话走同一个 provider、同一把 key、同一个适配器**是通的**（用户实测会话 `session-4339c7ca`）。

已排除：模型名（flash/v4-pro）· `reasoningEffort`（high/off）· `maxTokens`（65536/8192/1024）· 凭据（重存 key）。⇒ **剩下唯一显著差异就是这个字段**，但**当前没有任何手段可以隔离它**。

### §2.4 问题 D：改代码不热重载（实验方法学）

2026-11-07 实测：修改 `lib/advisor.mjs`（去掉 `purpose` 并给失败文案加探针前缀）后立即派发评审 ⇒ 输出里**没有探针前缀**，行为完全同旧代码。⇒ **运行中的插件用的是启动那一刻装载的代码**；任何「改代码 → 立刻观察」的实验**无效**，必须重启。

**本批的对策**：把对照实验做成**会话级开关**，于是「一次重启内」即可完成 A/B，不必反复重启。

---

## §三 用户故事

- **US-1**：作为维护者，一次 LLM 调用失败时，我要**同时**看到人话与机械事实（code/status/requestId），而不是二选一。
- **US-2**：作为维护者，一次 codex 类失败时，我要**同时**看到 `userMessage` 与 `diagnostics`（exit / stderr 尾部）。
- **US-3**：作为维护者，我要能在**不重启**的前提下开关 `purpose` 字段，用它做受控对照，把 `deepseek-official` 的 400 定案。
- **US-4**：作为维护者，我要实验**不留永久分叉**：默认行为与旧版逐字节一致，且实验结论必须落档。

---

## §四 非功能标准

| 编号 | 标准 | 判据 |
|---|---|---|
| **N-1** | 默认行为零变化 | `sendPurpose` 缺省 = 发送；请求内容与旧版逐字节同 |
| **N-2** | 不新增全局配置键 | 只做**会话级**覆盖（避免动 `config-api` 的 TOP/合计白名单计数三面同步） |
| **N-3** | 诊断不泄露内容 | `requestId` 截断到 64 字符；`diagnostics` 沿用既有 4K 尾部截断 |
| **N-4** | 每条新腿必须能红 | 变异自证（改坏 ⇒ 红 ⇒ 改回） |
| **N-5** | 全量回归保持绿 | 批 45 后实测 **678/678** |
| **N-6** | 文档卫生五条 | 见根 [AGENTS.md](../AGENTS.md)：§五 |

---

## §五 边界

### §5.1 本批明确不做

1. **不改 provider 配置**（用户的 `consultModels` / `advisor` 路由一律不动）。
2. **不改任何评审判定逻辑**：round1/convergence 选择、PASS/FAIL 判定、令牌签发全部不动。
3. **不动 consult**（它已在批 30 修好，仅作为口径参照）。
4. **不新增全局配置键**（见 N-2）。
5. **不清理 R-45-6 / R-45-7**（那两条与本次无关，留待测试收口批）。

### §5.2 登记面（已知但不做）

| 编号 | 内容 | 理由 |
|---|---|---|
| **R-46-1** | `purpose` 是否应作为**永久**可选字段 | 由实验结论决定；本批只提供**隔离能力**，不预设结论 |
| **R-46-2** | 平台侧 `providerError()` 在响应体无 `error.message` 时只给兜底文案 | 平台代码，本仓不可改；本批只把自己能拿到的结构化字段打出来 |

### §5.3 扫过的面 / 排除的面

- **扫过的面**：`lib/**` 全量 grep（`userMessage || diagnostics` / `failure.code|status|requestId` / `purpose`）；平台 `dsh-llm@0.2.2-rc.1` 的 `types.d.ts`（`GenerateOptions` / `LlmFailure` / `ToolSchema` 三处契约）。
- **被排除的面**：① 平台适配器 `dsh-llm-deepseek` 的请求构造（只读源码，不改）；② provider 侧日志（不可达）；③ 客户端 `lib/client.js` 的设置页（本批不涉及）。

---

## §六 与既有文档的关系

- 二选一病灶的**原始修复与判据**：见 [dsh017-batch30-design.md](dsh017-batch30-design.md) 与 `lib/consult.mjs:1251-1252` 的注释（D-58 / 锚 A30-9③）。
- 平台 `LlmFailure` 契约：见 `@deepseek-ai/dsh-llm@0.2.2-rc.1` 的 `lib/types/types.d.ts`。
- 上一批（批 45）的登记面：见 [2026-11-06-platform-022-requirements.md](2026-11-06-platform-022-requirements.md)：§5.2（R-45-8 / R-45-9 / R-45-10）。
- 本批设计：见 [2026-11-07-failure-diagnostics-design.md](2026-11-07-failure-diagnostics-design.md)。
