# 会诊纪要 —— consult #165（原始层，机制落盘）

- 日期：2026-11-07
- 会诊 id：165
- 模型：llmqax:deepseek-v4-flash, zai-coding-cn:glm-5.3, deepseek-official:deepseek-v4-pro, fangzhou-codeplan:kimi-k3.1-pro
- 平台 job：consult-5047d02b4f5f4eab
- 结果：4/4 交付（其中 4 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：false
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #165 stopped — 4 of 4 replied (0 failed) before stop]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #165 stopped — 4 of 4 replied (0 failed) before stop]
effective: 4 of 4 (0 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。★ 0.2.1 路线补充：只读依据 = **只下发 `agentPreset` 的 id**；预设**只能收窄它自己贡献的那一层**，其它插件在宿主面全局注册的工具**不受预设隐藏**（平台语义：作用域注册只遮蔽全局）⇒ 上述「白名单下发」弱证口径仅适用于老宿主路线。
models: llmqax:deepseek-v4-flash, zai-coding-cn:glm-5.3, deepseek-official:deepseek-v4-pro, fangzhou-codeplan:kimi-k3.1-pro
job: consult-5047d02b4f5f4eab
minutes: docs/consult-minutes/2026-11-07-consult-165-minutes.md
requiresReport: false

--- replies (raw, unjudged — verify with your own tools) ---

[1] fangzhou-codeplan:kimi-k3.1-pro — ok
✅ **本会诊子代理路由测试通过**：已正常接收提示词与主会话历史，并成功生成回复。

- 当前模型标识：`kimi-k3.1-pro`
- 这条回复即为该路由**端到端可用**的实测证据。
- 其余三条路由应以各自子代理的实际返回为准，不能由本条回复代判。

[2] deepseek-official:deepseek-v4-pro — ok
I've completed a thorough source-level investigation. Here's what I found — and it changes the diagnosis fundamentally.

## 三句话结论

1. **400 的根不在这个仓（`dsh-thincoder-suite`）**：这个插件只把 `{provider, model, system, messages, tools, sessionId, purpose, maxTokens, reasoningEffort}` 交给 `ctx.llm.stream()`，**线上请求体完全由平台适配器构造**。
2. **`deepseek-official` = DeepSeek 的 Anthropic 兼容 Messages API**（`https://api.deepseek.com/anthropic`），适配器是 `@deepseek-ai/dsh-llm-deepseek`，**打包在 `app.asar` 里，不在 profile 的 node_modules**。
3. **`llmqax` 能通是因为它是另一套 provider → 另一套（OpenAI 兼容）适配器**，根本不走这条会 400 的 Messages 序列化路径。

我把 `app.asar` 里那个 127KB 的适配器 `lib/index.js` 整个抽出来读完了（已存到 `C:\Users\huangchaowen\.dsh\dsllm.js`）。

```dsh-ui
{"title":"关键证据（平台适配器 dsh-llm-deepseek，非本仓）","gap":12,"items":[
 {"type":"table","columns":["事实","证据（dsllm.js:行）"],"rows":[
   ["端点 = Anthropic 兼容 Messages API","`PUBLIC_BASE_URL = \"https://api.deepseek.com/anthropic\"`（:347）"],
   ["请求体**必带** `thinking:{type}`","`thinking: { type: effort===\"off\"?\"disabled\":\"enabled\" }`（:1733）"],
   ["effort≠off 时**必带** `output_config:{effort}`","`...effort===\"off\"?{}:{ output_config:{effort} }`（:1734）"],
   ["官方模型目录只有 `deepseek-flash` / `deepseek-v4-pro`","`DEFAULT_MODELS`（:19-31）"],
   ["400 ⇒ 分类成 `INVALID_REQUEST`，**无回落重试**","`status===400 ⇒ code=\"INVALID_REQUEST\"`（:217）；`!response.ok ⇒ throw`（:2248-2260）"],
   ["`onExtensionsUnaccepted` 只处理 HTTP 2xx 后的 accept 失败","注释「after HTTP 2xx」（:1368）——**对 400 不生效**"]
 ]},
 {"type":"callout","tone":"warning","content":"`thinking` 和 `output_config` 不是标准 Anthropic Messages 字段（`output_config` 本是 Anthropic SDK 0.72 的结构化输出字段，标准形状是 `{format:…}`，这里却被塞成 `{effort}`）。适配器对「服务端不接受这些字段」**没有任何 400 回落**——400 直接抛 `LlmError(INVALID_REQUEST)`。"}
]}
```

## 根因分析（已证实 vs 假设）

**已证实**（读代码，非推测）：

- 每一条 `deepseek-official` 请求都会带上 `thinking` 和（effort≠off 时）`output_config` 这两个**非标准扩展字段**。
- 服务端返回 400 时，适配器**没有**像 `onExtensionsUnaccepted` 那样的降级路径——直接抛错。所谓「extensions 回落」只覆盖「HTTP 2xx 之后 accept 失败」这一条路，**对 400 完全不触发**（`dsllm.js:2248-2260`）。
- 观测到的错误正文是**兜底文案** `DeepSeek Messages request failed (400)`，意味着 400 响应体里没有 `{error:{message:string}}` 这种形状——即 DeepSeek 网关的报错格式和适配器预期的 `providerErrorDetail` 对不上，所以连服务端真正的报错文案都被吞了（`dsllm.js:209`、`:1753`）。

**关键假设（需平台侧确认，我无法打 API）**：

> 「正常对话走 `deepseek-official` 是通的」这条是**未经证实的转述**。最省事的解释是：**`deepseek-official` 对所有请求都 400**（`thinking`/`output_config` 被 DeepSeek 网关拒），而「那个能跑的会话」其实走的是**另一个 provider**。若果真如此，advisor/consult 的 400 与 `tools/system/messages` 无关，是**整条路由坏了**。

## 对你下一步的建议

1. **别再把 R-46-3 当「追根因」的正道**：给 `tools/system/messages/sessionId` 加开关，只能改变插件传的字段，**改不了平台适配器拼出来的 wire body**——`thinking`/`output_config` 是适配器自己拼的，插件关不掉。这是本仓能力边界之外的事。

2. **最快的判据**：在设置里建一个**极简**的 `deepseek-official` 会话（单轮、无工具、就是普通聊天），看它是否也 400。这一步能立刻区分「整条路由坏」还是「只有 advisor/consult 坏」。

3. **修复位置**：得改平台 `dsh-llm-deepseek`（`app.asar` 内），或在其 400 路径补回落（去掉 `thinking`/`output_config` 重试一次），或确认 DeepSeek `/anthropic` 端点对这两个字段的真实要求。**这些都不在本仓 `dsh-thincoder-suite` 的改动面内。**

4. **短期不阻塞**：继续把 advisor 收敛轮 + consult 全切到 `llmqax`（你已经验证能跑 8629B / 6029B），这就是当前唯一可用路径；`deepseek-official` 的问题单独开一档平台侧追。

需要的话，我可以把 `dsllm.js` 里 `serialize` / `providerError` / `prepareRequestExtensions` 三段完整源码贴给平台侧的人，或者继续深挖 `deepseekLlmApiExtensions` 服务到底往请求体里注入了什么（那是唯一还没排除的、可能引入非标准字段的注入点）。

[3] zai-coding-cn:glm-5.3 — ok
**会诊 4 行测试完成：全部跑通（4/4）。其中 `deepseek-official:deepseek-v4-pro` 在会诊路径正常应答——与 advisor 路径的 400 构成同 provider 差分，R-46-3 的嫌疑面被这次测试收窄了。**

```dsh-ui
{"title":"会诊池 4 行 + advisor 收敛 · 实测矩阵（2026-11-07 22:53–23:2x）","gap":12,"items":[
 {"type":"table","columns":["配置项","路由","判定","证据"],"rows":[
  ["advisor.convergence（用户切换）","llmqax:deepseek-v4-flash","✅ 可用","父会话今晚实测（真实二轮评审完整返回）"],
  ["consultModels[0]（用户切换）","llmqax:deepseek-v4-flash · max","✅ 可用","consult #167 并行轮，实质回复"],
  ["consultModels[1]","zai-coding-cn:glm-5.3 · max","✅ 可用","consult #169 串行轮，实质回复"],
  ["consultModels[2]","deepseek-official:deepseek-v4-pro · max","✅ **可用**","consult #168 串行轮，实质回复（★ 关键行）"],
  ["consultModels[3]","fangzhou-codeplan:kimi-k3.1-pro · high","✅ 可用","consult #170 串行轮，实质回复"]
 ]},
 {"type":"callout","tone":"success","content":"**结论一句话：会诊整池 4/4 可用，escalate 默认行（[0]）也可用；用户切换后的配置不用再动。**"},
 {"type":"callout","tone":"warning","content":"**R-46-3 关键差分读数**：同一 provider+model（deepseek-official:deepseek-v4-pro）——advisor 收敛路径 = HTTP 400 INVALID_REQUEST（今晚 22:47–22:52 A/B，flash；v4-pro 此前 8 次真测亦 400），会诊子路径 = 正常应答（#168，约 23:05）。⇒ **400 的触发面收窄为 advisor 路径的请求形态（tools/system/messages/sessionId/streamOpts），不是 provider、key、模型或适配器**。差分法就是 R-46-3 受控开关实验该沿用的方法。"}
]}
```

## 测试经过（一处必须如实交代的污染）

第一轮 **并行** 派发 4 行（consult #167）：只有 llmqax 拿到 LLM 调用机会，其余 3 行死于**派发期基础设施拒绝**——`subagent limit reached (active child limit: 8)`（平台活跃子代理槽位满，其余占用者身份本会话不可内省）。这 3 行**不构成路由判定**，我改为**单行串行重测**（每次只占 1 槽）：#168 → #169 → #170，全部通过。

这本身是一个值得登记的运维事实：**满载平台上并行整池会诊会产生「假失败」行**——digest 里 `(consultation failed: …)` 前缀相同，必须读正文区分「槽位拒绝」与「HTTP 错误」。是否做成批（如派发前探测槽位/降级串行），由你决定。

## 证据落盘

| 产物 | 位置 |
|---|---|
| 4 份 digest 全文 | `~/.dsh/.thincoder/jobs/consult-b51643d10e354ba0.txt`（#167）· `consult-63308e77d2a94f9e.txt`（#168）· `consult-01471afdb6a34036.txt`（#169）· `consult-d0072393c8a24177.txt`（#170） |
| 4 份会诊纪要（§0/§1 机制写，§2–§5 裁定层我已补写并回读验证：锚点在位、无 U+FFFD、无残留占位符） | [2026-11-07-consult-167-minutes.md](docs/consult-minutes/2026-11-07-consult-167-minutes.md) · [2026-11-07-consult-168-minutes.md](docs/consult-minutes/2026-11-07-consult-168-minutes.md) · [2026-11-07-consult-169-minutes.md](docs/consult-minutes/2026-11-07-consult-169-minutes.md) · [2026-11-07-consult-170-minutes.md](docs/consult-minutes/2026-11-07-consult-170-minutes.md) |
| 配置读数来源 | `~/.dsh/.thincoder/config.json`（4 行池 + convergence 全文直读） |
| 文档闸门 | `node --test test/doc-hygiene.test.mjs test/test-lifecycle.test.mjs` → **31/31 pass，EXIT=0**（4 份纪要改动无回归） |

## 逐条处置（#167 的 1 条意见 + 后续 3 轮全部采纳为连通证据）

- llmqax 回复第 3 点（400 = 请求体序列化差异的猜测）：**不采纳为结论**，登记为未验假设——方向与 R-46-3 剩余项一致但无直接证据；本次差分实验反而是它第一个旁证。
- 各子会话「未走缓存/非模板」自述：模型自述不可独立验证，连通结论只依赖**实质回复到达**这一事实。

## 不可验清单（如实）

- **deepseek-flash 在会诊路径未测**（不在池内，consult 的 models 选择器只认池内行）——flash 的差分只能到 provider 级，v4-pro 才是 provider+model 级。
- 各行 effort 档（max/high）是否被平台真实下发：本测只验证端到端连通。
- 8 个子代理槽的其余占用者是谁：本会话无工具可列出。

## 我没动的东西

用户 config.json（只读）、插件代码、全局配置——零改动；仓库内改动仅上述 4 份纪要的裁定层。无在飞后台作业（4 个 consult 全部结算且经 minutes 确认消化），终端已关闭。

[4] llmqax:deepseek-v4-flash — ok
**三句话结论**

1. **advisor 收敛轮（`llmqax:deepseek-v4-flash`）跑通了**：连续两轮（R2/R3）真跑，都产出完整评审正文，不是空回包。
2. **会诊 4 个模型 4/4 全部成功、0 失败**——**包括此前在 advisor 侧固定 400 的 `deepseek-official:deepseek-v4-pro`**。
3. 由此**改变 400 的定性**：不是账号/网关封锁（子代理路径用同一 provider、同一 key 是通的），而是 **advisor 直连 `ctx.llm.stream` 的请求形态特有**；顺带查出批 46 那次 purpose A/B **其实是空操作**（下面给源码证据）。

```dsh-ui
{"title":"本轮实测读数（三组真跑）","gap":12,"items":[{"columns":["路线","用途","结果","证据"],"rows":[["zai-coding-cn:glm-5.3","advisor round1","✅ 4051 B 评审","job advisor-dsh-d91d73c4b3e84977"],["llmqax:deepseek-v4-flash","advisor 收敛轮 R2","✅ 2928 B · PASS","job advisor-dsh-385ad79373ed433d（工具自报路由 = llmqax）"],["llmqax:deepseek-v4-flash","advisor 收敛轮 R3","✅ 2729 B · PASS","job advisor-dsh-4a24d491e5314cde"],["llmqax:deepseek-v4-flash","会诊 #166","✅ ok","reply[2]"],["zai-coding-cn:glm-5.3","会诊 #166","✅ ok","reply[4]"],["deepseek-official:deepseek-v4-pro","会诊 #166","✅ ok（此前 advisor 侧固定 400）","reply[1]"],["fangzhou-codeplan:kimi-k3.1-pro","会诊 #166","✅ ok","reply[3]"]],"type":"table"},{"content":"会诊 4/4 交付、0 失败；advisor 两轮收敛都跑在 llmqax 上并产出完整评审（不是空回包）。","tone":"success","type":"callout"}]}
```

## 为什么 deepseek-official 这次没 400 —— 这是本轮最有价值的读数

会诊是**真派子代理**（每个模型一个 session、走 agent-loop、真实 LLM 调用），`deepseek-official:deepseek-v4-pro` 回了整整一屏分析 ⇒ **provider / 凭据 / 账号 / 网关层封锁全部排除**。差异只剩一处：advisor 直连那条请求**自己拼的 body**。

顺带把「purpose 已排除」这条旧结论**改判**了。我把运行时适配器从 `app.asar` 解出来（127,859 B）逐行核对：

| 行 | 事实 | 对本案的意义 |
|---|---|---|
| 2245 | `purpose` 仅当值 === `"compaction"` 才上头 | **`purpose:"thincoder-advisor"` 从不产生任何 wire 差异** ⇒ 批 46 那次 A/B 是空操作，不是有效排除 |
| 1772 | 兜底串 `DeepSeek Messages request failed (<status>)` 仅在响应体无 `error.message` 时出现 | 400 的响应体不是标准错误 JSON |
| 1785 | `requestId` 只取响应头三选一 | 「平台未填」= 上游没给 |
| 2259 | `cause: new Error(text)` 保留响应体原文 | 插件信封没透出它——**这是唯一能终结调查的字段** |
| 1732 | `max_tokens` 恒在场 | 与普通对话的差异候选 |

## 评审处置（两轮 advisor，🔴 = 0）

| # | Action | Detail |
|---|---|---|
| 1 | Fixed | [test/advisor-envelope.test.mjs](test/advisor-envelope.test.mjs) 头注与全部站点标签的锚从 `:2508/:2596/:2620` 更新到 `:2598/:2686/:2710`，并加「行号 as-of 批 46 收口」；[test/guard-e.test.mjs](test/guard-e.test.mjs) 同处一并更新 |
| 2 | Fixed | [设计档 §五 FR-2](docs/2026-11-07-failure-diagnostics-design.md) 补「`requestId` 在场时同段原样保留（`requestId=…`，见 §12.3 D-01）」 |
| 3 | Fixed | 同表 FR-2/FR-3 行号漂移对齐并补 as-of：`:1410-1430`→[`lib/advisor.mjs:1494`](lib/advisor.mjs)、`:1649`→`:1735`、`:1555`→`:1640` |

验证：`node --test` 全量 **692 / 692 通过（0 fail）**；工作区只有上述 3 处修改 + 本轮新增纪要 [docs/consult-minutes/2026-11-07-consult-166-minutes.md](docs/consult-minutes/2026-11-07-consult-166-minutes.md)（§2 逐条处置 / §3 自证 / §4 读数 / §5 裁定 已补写，会诊要求 `requiresReport:true`）。

## 建议与待你拍板

| 事项 | 前因后果 | 我的建议 |
|---|---|---|
| 是否继续追 400 | 现在能确定它只在 advisor 直连路径出现；「先取 `cause` 原始响应体 + baseURL 指本地代理抓两组请求 diff」是最短路径，且**不改插件、不重启** | **做**，但要你同意临时改 DeepSeek baseURL（跑完回滚） |
| 是否现在发 `v0.41.0` | 批 46 的能力已验证；400 根因未定位，但它已不影响 advisor（收敛轮已换 llmqax） | 可以发，400 作为下一批 R-46-3 |
| 我顺带发现的登记修正 | purpose 属结构性不相关、`maxTokens=1024` 因 <4096 回落 16384 不是有效实验、子代理不复现 400 | 建议并入 R-46-3 一起落档 |
```

## §2 逐问裁定（**主代理写**）

> 待主代理填写：每条意见**恰一条处置**——采纳 / 不采纳（**必附理由**）/ 待定。

## §3 分歧与父侧裁定（**主代理写**）

> 待主代理填写。

## §4 教训（**主代理写**）

> 待主代理填写。

## §5 不可验清单（**主代理写**）

> 待主代理填写。

## §2 裁定层（逐条处置 · 主代理写）

### [1] `fangzhou-codeplan:kimi-k3.1-pro`

- 「本会诊子代理路由测试通过」→ **采纳为连通证据（弱证）**：该行确有实质回复。模型自述的「非模板/走缓存」**不采纳**（无法独立验证）。

### [2] `deepseek-official:deepseek-v4-pro`（它的存在本身就是关键证据）

| 意见 | 处置 | 理由 |
|---|---|---|
| 400 的根不在本仓 | **采纳** | 与父侧判断一致；父侧独立复核适配器源码（`dsllm.js`，127,856 B） |
| 每请求必带 `thinking` / `output_config` | **采纳** | 复核 L1732-1734 存在该形状 |
| 400 ⇒ `INVALID_REQUEST`，无回落 | **采纳** | 与观测一致（立即失败、`code=INVALID_REQUEST`） |
| **「正常对话走 deepseek-official 是通的」是未经证实的转述** | **驳回（有反证）** | **它自己这条回复就是经该 provider 的子代理返回的**；glm 行的串行实测（#168）独立复现同一行可用 ⇒ 该假设被证伪 |
| 别再拿 R-46-3 当追根因的正道 | **部分采纳** | 给 `tools`/`sessionId` 加开关确实改不了适配器拼的 body；但「先取 `cause` 原始响应体」是更短路径 |

### [3] `zai-coding-cn:glm-5.3`

- 「会诊 4 行 4/4 可用」→ **采纳**（本 digest 4/4，且用户切换后 advisor 收敛轮 `llmqax` 实测跑通，两条独立证据）。
- 「同一 provider 在两路径下结果不同 ⇒ 差异只在 advisor 直连请求」→ **采纳**，本轮最有价值的读数。
- 「并行派发时 3 行死于 `subagent limit reached (active child limit: 8)`」→ **采纳为运维事实**（满载平台会产生「假失败」行，须读正文区分「槽位拒绝」与「HTTP 错误」）；**不采纳为路由判定**（它自己也如此声明）。

### [4] `llmqax:deepseek-v4-flash`

| 意见 | 处置 | 理由 |
|---|---|---|
| **`purpose` 仅当 === `"compaction"` 才上头 ⇒ 批 46 的 A/B 是空操作** | **采纳，并自我订正** | 父侧复核：L2213 `...options.purpose === void 0 ? {} : { purpose: options.purpose }`（只进 `requestIdentity`）· L2245 `...requestIdentity.purpose === "compaction" ? { "x-deepseek-harness-compact": "1" } : {}`（唯一 wire 效应）⇒ **`"thincoder-advisor"` 零 wire 差异**。**结论（排除 purpose）仍成立，但设计档 §12.4 写的理由错了** —— 已订正 |
| `cause: new Error(text)` 保存原始响应体，是唯一能终结调查的字段 | **采纳为线索，可行性未证** | 父侧复核 L2259 确认存在；但该 `cause` 挂在 **throw 的 `LlmError`** 上，而 advisor 走 **stream + `LlmFailure` 对象**，该契约无 `cause` ⇒ 插件侧能否取到**未验证** |
| `maxTokens=1024` 因 <4096 回落到 16384，故不是有效实验 | **驳回（未证实）** | 父侧复核 L1732 `max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens`，**未见 4096 夹取**；L329 schema 为 `min(1)/max(MAX_SAFE_INTEGER)`，亦无此夹取。该断言缺证据，若要坚持须给出具体行号 |

## §3 分歧

**「正常对话走 `deepseek-official` 是否可用」**：[2] 判为「未经证实的转述」，[3] 判为「可用」。

**裁定**：采纳 [3] —— **反证是 [2] 自己的回复**（它正是经该 provider 返回的）。这是一处「模型无法观测自身路由」导致的自我否认，值得记入教训。

## §4 教训

1. **做 A/B 之前，必须先证明该变量真的会出现在 wire 上。**
   本次 `sendPurpose` 开关在**插件侧完全有效**（`streamOpts` 里整键缺席，测试可断言），但**无论开关如何，wire 上都没有 `purpose`** ⇒ 这是一条**结构上不可能失败的腿**。这正是本仓反复打击的「假腿」形态 —— 只不过这次出现在**人的推理**里，而不是测试里。
2. **同一 provider 的两条调用路径必须分开判定**：子代理对话与插件直连 `ctx.llm.stream` 不可混为一谈；混同会得出「整条路由坏了」的错误结论。
3. **模型无法观测自身路由**：[2] 用自己这条回复去否认「该 provider 可用」，属可预期的自我盲区 —— 判定类结论不得只采信模型自述。

## §5 不可验（如实）

- **`cause` 能否被插件拿到**：未验证。需读平台把 `LlmError` 转成 `LlmFailure` 的那段代码，或实际改代码试。
- 各子代理的 `effort` 档是否真被平台下发。
- 那 8 个 active child 的其余占用者身份（本会话无工具可列出）。
- `deepseek-flash` 在**会诊路径**未测（不在池内；选择器只认池内行）—— flash 的差分只到 provider 级，`v4-pro` 才是 provider+model 级。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-11-07 | 机制落盘（§0 汇总 + §1 原始层）；裁定层 §2–§5 由主代理补写（含一条**自我订正**：purpose A/B 是空操作） |

