# 会诊纪要 —— consult #166（原始层，机制落盘）

- 日期：2026-11-07
- 会诊 id：166
- 模型：llmqax:deepseek-v4-flash, zai-coding-cn:glm-5.3, deepseek-official:deepseek-v4-pro, fangzhou-codeplan:kimi-k3.1-pro
- 平台 job：consult-18a13935d0c14834
- 结果：4/4 交付（其中 4 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #166 finished — 4 of 4 replied (0 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #166 finished — 4 of 4 replied (0 failed)]
effective: 4 of 4 (0 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。★ 0.2.1 路线补充：只读依据 = **只下发 `agentPreset` 的 id**；预设**只能收窄它自己贡献的那一层**，其它插件在宿主面全局注册的工具**不受预设隐藏**（平台语义：作用域注册只遮蔽全局）⇒ 上述「白名单下发」弱证口径仅适用于老宿主路线。
models: llmqax:deepseek-v4-flash, zai-coding-cn:glm-5.3, deepseek-official:deepseek-v4-pro, fangzhou-codeplan:kimi-k3.1-pro
job: consult-18a13935d0c14834
minutes: docs/consult-minutes/2026-11-07-consult-166-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] deepseek-official:deepseek-v4-pro — ok
I've traced the full path: the plugin's request assembly, the platform's `dsh-llm-deepseek` Messages adapter source, and the batch-46 diagnostic doc that already excludes `purpose`. Here's my analysis.

---

## 三句话结论

1. **这不是插件整体坏了**：同一套 advisor 请求在 `zai-coding-cn` / `llmqax` / `fangzhou` 上正常，只在 `deepseek-official` 上 400。差别在协议——`deepseek-official` 走的是 **Anthropic 兼容的 Messages 协议**（`dsh-llm-deepseek` 适配器，端点 `api.deepseek.com/anthropic/messages`），另外三条走 pi-ai（chat-completions）。**同一份请求内容，两个协议的服务端校验松紧不同**，这才是可比较的两面。

2. **400 是服务端真拒绝，不是插件客户端校验**。我核对了适配器源码 `providerError()`：`DeepSeek Messages request failed (400)` 这句**兜底文案只在「响应体里没有 `error.message` 字符串」时出现**；`code=INVALID_REQUEST` 由 `status===400` 推得；`requestId` 取自 `request-id`/`x-request-id` 响应头（没有就为空）。即：请求发出去了，服务端回了 400，但**响应体不是标准的 Anthropic/DeepSeek 错误 JSON**（否则 message 不会是这句兜底）。

3. **最可能元凶是 `tools` 数组（`input_schema` 的 JSON Schema 内容）**，其次 `sessionId` 头 / `messages` 形态，`system` 提示词基本可排除。建议先做一次「抓原始响应体」的前置探测，再按下表的单开关实验逐项隔离。

---

## 机制事实（源码确认，非推测）

| 事实 | 证据 |
|---|---|
| advisor 请求装配 | `lib/advisor.mjs:1636-1643`：`streamOpts = { provider, model, system, messages, tools, signal, sessionId?, purpose?, maxTokens, reasoningEffort? }` |
| 4 个工具 schema | `lib/readonly-tools.mjs:168-217`：`read` 的 `offset`/`limit` 是 **`type:"number"`**；`ls` **没有 `required` 数组** |
| 消息形态 | `lib/advisor.mjs:1249-1250` `userMsg`：`{ id:"adv-<uuid>", role:"user", content:[{type:"text",text}], source:{kind:"user"} }` |
| sessionId 来源 | `lib/advisor.mjs:2054` `const sid = agent.session.id`，经 `:2730-2735` 传入 `runAdvisorToolLoop` |
| Messages 协议把 `parameters` → `input_schema` | `dsh-llm-deepseek` 源码 `serialize()`：`tools: options.tools.map(t => ({ name, description, input_schema: t.parameters }))` |
| 400 兜底文案 + code/requestId 来源 | 同适配器 `providerError()`：`message` 兜底当 `error.message` 非字符串；`code=INVALID_REQUEST` 当 `status===400`；`requestId` 来自响应头三选一 |
| 首轮即炸 | 观测行 `blocks(text=0,tool-call=0)` ⇒ 失败的是**第一次请求**（单条 user + system + 4 tools），不是第二轮工具结果回传 |

关键结构性判断：**首轮就 400**，排除了「工具结果回传的 tool-call/tool-result 配对」这条路径（那只会从第二轮开始炸，且是客户端 `LlmError` 无 `status:400`）。失败请求的内容 = 一条 user 消息 + system 提示 + 4 个 tools + sessionId 头。

---

## 可能性排序

| 排名 | 嫌疑 | 理由（支持 / 反对） | 估计 |
|---|---|---|---|
| **H1** | **`tools` 数组（`input_schema` 内容）** | **支持**：同一套 4 个工具在 pi-ai（`parameters`，宽松）上通过，在 Messages（`input_schema`，Anthropic 严格 JSON Schema）上被拒——这是最干净的协议差分。具体红旗：`read.offset/limit` 用 `type:"number"`（Anthropic/DeepSeek 常要求 `integer`）、`ls` 无 `required`。**反对**：普通对话也走同一适配器发 tools 且通——但发的是**平台自有工具的不同 schema**。 | 最高 |
| **H2** | **`sessionId` 头（`x-deepseek-harness-session-id`）** | **支持**：「响应体无 `error.message` + 无 `requestId`」这个形态更符合**网关/代理层**拒绝（网关常不回标准错误体、不设 request-id 头），而 sessionId 是唯一以**头**形式带出去的非平台默认字段。**反对**：值是普通 session id 字符串，看不出为何非法。 | 中 |
| **H3** | **`messages` 形态** | **支持**：手工拼的 Message（自定义 `id`/`source`）。**反对**：适配器 `serialize()` 只读 `role`/`content`，`id`/`source` 被忽略；单条 user 是合法形态，与普通对话共用同一 `input()` 路径。 | 低 |
| **H4** | **`system` 提示词内容** | 正常英文提示（`lib/prompts/advisor-round1.md`，约 5KB），没有任何会触发 400 INVALID_REQUEST 的特征。 | 最低 |

> **一个必须先澄清的歧义**：题面说「通过 `ctx.llm / subagents` 都 400」。但**已落盘的证据只有 advisor（`ctx.llm.stream`）路径**（批 46 §12.4），且上面 4 个嫌疑都是 advisor 请求专属字段。若 `eng_coder`/`consult`/`escalate` 这些**子代理**路径也真能复现同一 400，那是另一条更根本的信号（子代理走的是平台自己的 system + 平台工具，跟普通对话几乎同构）——指向 provider/账号层而非请求内容层。**建议第一步先确认子代理是否真复现**，这决定了排查面是「advisor 请求内容」还是「provider 层」。

---

## 隔离实验矩阵（一项一个开关）

判据统一（成功与失败的读数）：

- **失败读数（当前基线）**：`Advisor: review failed — DeepSeek Messages request failed (400) (INVALID_REQUEST · HTTP 400)`，观测行 `code=INVALID_REQUEST | status=400 | 无 requestId`。
- **成功读数**：advisor 返回评审正文（不以上述 400 开头）。

前置约束：改 `lib/` **不热重载**（批 46 已实测），所以正确做法是**一次重启内**把四个开关都做成会话级覆盖（仿 `sendPurpose` 先例），逐个 flip，避免每个实验一次重启。

```dsh-ui
{"title":"400 隔离实验矩阵（一项一开关）","gap":12,"items":[{"type":"callout","content":"判据统一：失败 = `code=INVALID_REQUEST · status=400 · 无 requestId`；成功 = advisor 返回评审正文（非 400 开头）。所有开关在一次重启内 flip。","tone":"info"},{"type":"table","columns":["#","唯一开关（改什么）","若 400 消失 →","若仍 400 →"],"rows":[["E0","前置：surface 原始响应体 `e.cause.message`（适配器把原始 body 放在 `cause: new Error(text)` 里，现被丢弃）","拿到 `error.message`/`detail`，直接点名非法字段，省掉后续二分","body 空/非 JSON/无 error.message ⇒ 400 来自网关层，嫌疑转 sessionId/user-id 头"],["E1","`omitTools`：streamOpts 不传 `tools`","**tools 是元凶**（再二分：offset/limit 的 `number`→`integer`；`ls` 补 `required`；逐个加回 glob/grep/ls）","排除 tools"],["E2","`bareMessages`：用最简 `[{role:'user',content:[{type:'text',text}]}]`（去 id/source）","messages 形态是元凶","排除 messages"],["E3","`omitSessionId`：不传 `sessionId`","sessionId 头是元凶","排除 sessionId"],["E4","`emptySystem`：`system` 置空/固定一句","system 内容是元凶","排除 system"]]}]}
```

**执行顺序与理由**：

- **E0 先做**：它不隔离任何项，但把「服务端为什么拒」的原始 body 捞出来——这是当前诊断面**唯一还丢着的信息**（批 46 已补 code/status/requestId，但原始响应体仍被 `providerError` 的 `cause` 吃掉）。`DEEPSEEK_BASE_URL` 指向本地转发代理也可达同效且零代码改动。
- **E1 排第一**：H1 概率最高，且去 tools 后模型仍能直接产出评审正文（不会 read/grep，但不影响判「请求是否合法」），是四个里**最便宜也最有判别力**的。
- E3 排第二（H2，网关层嫌疑）；E2/E4 殿后（低概率）。

**每个实验的机械可失败性**：每个开关都必须先造一个「改坏必红」的断言（仿批 46 的 M1–M16 变异自证）——例如 `omitTools=true` 时断言 `streamOpts` 无 `tools` 键；把开关改回默认必须复绿。否则「开关没接线」会和「排除该项」混在一起，无法区分。

---

## 建议路径（我建议选哪条）

1. **先澄清子代理是否真复现**（一条命令的事：把 `consultModels` 里某行配成 `deepseek-official:deepseek-flash` 跑一次会诊）。若子代理**不** 400 ⇒ 排查面锁定 advisor 请求内容，走 E0→E1→E3→E2→E4；若子代理**也** 400 ⇒ 直接跳过请求内容层，转向 provider/账号/网关层（`DEEPSEEK_BASE_URL`、扩展头 `x-deepseek-harness-user-id`、账号开通的模型路由）。
2. **E0 抓原始 body** 是最低成本的下一步，很可能一次就把答案打出来（代价：一次代码改动 + 一次重启，或一个本地转发代理）。
3. 若 E0 拿不到 body（确认是网关层），**E3（sessionId）立刻升为头号嫌疑**，因为它与「无 error.message + 无 requestId」的网关层特征最吻合。

代价如实声明：以上任何一条都绕不开「改 `lib/` 需重启」这个事实（批 46 需求档 §2.4 已探针实证），所以**每新增一个开关都必须跟用户确认重启时机**——这正是 `sendPurpose` 那条会话级开关先例的意义：把四个开关一次性装进去，一次重启跑完全部 A/B。

[2] llmqax:deepseek-v4-flash — ok
## 三句话结论

1. **这个 400 不是“插件把请求拼坏了”，也不是平台漏填 requestId**：我把 `D:\DSH-Desktop-Official\resources\app.asar` 里真正在跑的 `@deepseek-ai/dsh-llm-deepseek` 反出来了——`requestId` 只从响应头 `request-id`/`x-request-id`/`x-deepseek-request-id` 取，拿不到就是上游没给；而 `DeepSeek Messages request failed (400)` 是**适配器在“响应体里没有 `error.message`”时的兜底串**。也就是说：**400 确实来自网络响应，且响应体是空的/非 JSON**。
2. **剩余嫌疑里，`purpose` 可以结构性排除（不是靠 A/B），`sessionId` 只进请求头、不进 body**；真正剩下的是“插件比正常对话多给/少给的那几个**信封字段**”——最可能是 `max_tokens`（显式 vs 路由自带缺省）与 `tools` 的声明方式。
3. **建议先做一次“同一条链路抓两次包然后 diff”**（把 `baseURL` 指到本地代理，分别跑一次正常对话和一次 advisor），这一步的情报量等于其余所有实验之和；然后把捕获到的 body 用 curl 逐字段回放做单变量排除——**不需要改插件、不需要重启 DSH**。

---

## 一、已从运行时代码确证的事实（这些不用再猜）

来源：`app.asar` → `@deepseek-ai/dsh-llm-deepseek/lib/index.js`（`DeepSeekAdapter` / `serialize()` / `request()`）。

| # | 事实 | 对本案的意义 |
|---|---|---|
| F1 | 请求 URL = `messagesApiRoot(baseURL) + "/messages"`，默认 `baseURL = https://api.deepseek.com/anthropic` | **端点可在设置页 DeepSeek 卡片里改 `baseURL`** ⇒ 本地代理可行，零改码 |
| F2 | body 字段**只有**：`model / stream / messages / max_tokens / thinking / output_config(仅 effort≠off) / system / temperature(仅显式给) / stop_sequences(仅显式给) / tools(映射为 name/description/input_schema[+defer_loading])` | `purpose`、`sessionId` **不是 body 字段**——`purpose` 的 A/B 结果由此得到结构化解释，不是巧合 |
| F3 | 请求头：`attributionHeaders()` + `anthropic-version: 2023-06-01` + `auth.headers` + `x-deepseek-harness-user-id` + **`x-deepseek-harness-session-id`（仅当 options.sessionId 存在）** + `anthropic-beta`（仅当有 files / tool_addition 块）+ `x-deepseek-harness-compact`（**仅当 purpose === "compaction"**） | `sessionId` 确实上线（头），`purpose="thincoder-advisor"` **完全不产生任何头** ⇒ 已 A/B 的结论与代码一致 |
| F4 | `max_tokens: options.maxTokens ?? model?.maxTokens ?? connection.maxTokens` | 插件显式传 16384 时**覆盖**路由缺省；而 agent 侧有一个 `adapterDefaults.maxTokens === true ⇒ delete proposal.maxTokens` 的机制（agent loop 文档原话），即**正常对话可能根本不发这个字段** |
| F5 | 本地预检失败都有**专属 message**：`duplicate tool call id` / `tool result has no matching call` / `tool calls need immediate results` / `history ends with unresolved tools` / `request image is missing`；effort 不在 `off|low|high|max` 时抛 `UNSUPPORTED_REASONING_EFFORT` | 现场看到的是**兜底串** ⇒ 这些本地分支全都没触发，请求确实发到了服务器 |
| F6 | 400 → 映射为 `INVALID_REQUEST`；错误对象保留 `cause: new Error(响应体原文)` | **响应体原文一直在 Error.cause 里**——插件的 `failureParen()` 只打印 code/status/requestId，把这行最有价值的东西丢了 |
| F7 | `/models` 列表按模型公布 `api_capabilities.anthropic_messages.{system_prompt_update, tool_update}`、`context_window`、`max_output_tokens` | 系统提示与工具**“怎么声明”是服务端按模型声明的协议**，不是纯内容问题 |

> 版本注意：以上是 `D:\DSH-Desktop-Official` 这台机器上正在跑的打包代码（runtime context 指的就是它）。若换机需重新核。

---

## 二、成因排序（按“能同时解释全部观测”的程度）

排序依据：**它必须是“正常对话不会出现、而插件请求会出现”的差异**。正常对话与插件请求共用同一适配器、同一 UA、同一 user-id 头、同一凭据。

| 排序 | 候选 | 为什么排这 | 若它是真凶，应看到什么 | 先验 |
|---|---|---|---|---|
| **1** | **信封缺省面：`max_tokens` 显式值** | 这是**唯一“插件多给、agent 可能从不发”的字段**（F4 的 `adapterDefaults` 删除机制）。它还能解释“8192/65536 都 400”：如果路由要求**省略**由自己解析，任何显式值都错 | 回放实验里“删掉 `max_tokens` 键”这一条从 400 变 200，其余不动 | ~30% |
| **2** | **`tools` 的声明方式** | 服务端按模型声明 `tool_update`（F7）。插件永远发 leading-only 的 `tools` 数组，**没有任何 developer/`tool_addition` 投影**；agent 侧由 `LlmRuntime` 投影 | 回放里“去掉 `tools`”变 200，或“加 defer_loading/改声明方式”变 200 | ~25% |
| **3** | **`messages` 形态（第二轮 tool_use/tool_result）** | 仅当 400 发生在**第 2 轮及以后**才成立；若首轮就 400 则直接归零 | 首轮单条 user 消息 200、加一轮 tool_call+tool_result 后 400 | ~20%（条件） |
| **4** | **`system` 提示词** | 内容层面最不该被拒；但插件系统提示含中文、emoji、`[APPROVE:…]`，且长度可观 | 换成一句英文 system 后 200 | ~10% |
| **5** | **请求头面**（`x-deepseek-harness-session-id` 的取值形态 / `anthropic-beta` / 出口代理） | 头随调用方不同；公司网关有过 UA 白名单拦截的前科（`~/.dsh/llm-4xx-dump.log` 里 403 "User-Agent is not allowed"） | 去掉/改掉某个头后 200；或换网络环境后 200 | ~8% |
| **6** | `sessionId` / `purpose` | `purpose` **结构性为 0**（F3：非 `compaction` 不产生任何东西）；`sessionId` 只进头且一直带着 | — | ≤2% |

**要我押一注**：1 与 2 合计过半，且两者可以在同一个下午用同一套装置分别钉死。

---

## 三、隔离实验设计（一项一个开关，每项都能单独复现或排除）

### 前置 E0：一次捕获，两条请求（这一步决定后面所有实验的成本）

**做法**：设置页 → DeepSeek 卡片 → `baseURL` 改成 `http://127.0.0.1:8787`；本机起一个 20 行的转发代理（原样转发到 `https://api.deepseek.com/anthropic`，把 `method/url/headers/body` 与 `status/响应头/响应体` 各落一行 JSONL）。

- **成功读数**：`.jsonl` 里出现**两条**记录——① 一次正常对话请求（`200`，`content-type: text/event-stream`，首帧 `message_start`）；② 一次 advisor 请求（`400`）。两者**同一端点、同一天、同一凭据**。
- **失败读数**：只抓到 ① 或只抓到 ② ⇒ baseURL 覆盖没生效（有些部署要求重启，属“配置变更需重启”，别硬试）或走了不同路由。
- **能排除什么**：直接给出 body 逐字段 diff、以及**那条 400 的响应体原文**（F6 说它在 Error.cause 里，代理这里更直接）。顺带核一件事：**正常对话的 200 响应有没有 `request-id` 头**——如果没有，“平台未填充 requestId”就不是症状，而是该 provider 的常态。

> 若设置页拒绝 `localhost` 形态的端点（文档里有对 localhost/IP 字面地址的限制），用 hosts 别名（如 `dsproxy.local → 127.0.0.1`）或 LAN IP 绕过；代理只监听回环，跑完立刻删掉覆盖。

### E1～E7：一次只动一个字段（在捕获的 body 上裁剪，curl 回放）

每个实验的**起点**都是 E0 捕获到的、**已知会 400 的原始 body**；每次只改一处，其余逐字节不变。判据统一：

- **通**：HTTP 200 **且** 首个 SSE 帧是 `message_start` **且** 10s 内出现 `message_stop`（只有 200 没有事件流 = 未通）。
- **不通**：HTTP 4xx，**且把响应体原文抄下来**（≤500 字符）——下一轮判断的输入就是这段文本。
- **不确定**：同一 body 连跑 3 次结果不一致 ⇒ 判为测量噪声/中间层不稳定，先不要下结论。

| 编号 | 唯一变量 | 操作 | 通 ⇒ 结论 | 不通 ⇒ 结论 |
|---|---|---|---|---|
| E1 | 无（复现性） | 原样回放捕获的 body + 全部头 | 400 与线上逐字同 ⇒ 问题完全在 **body/头**，插件侧可闭环 | 200 ⇒ 差异在**插件看不到的层**（extensions/凭据/代理），转 E8 |
| E2 | 整体最小化 | 只留 `{model, stream:true, max_tokens:1024?, messages:[{role:"user",content:[{type:"text",text:"hi"}]}], thinking:{type:"disabled"}}` | 200 ⇒ 逐字段加回（E3→E7） | 400 ⇒ **连基线都不通**，问题在 model/凭据/端点，跟插件无关 |
| E3 | `system` | 加回真实 system 字符串 | 400 ⇒ **系统提示是真凶** | 200 ⇒ 排掉 system |
| E4 | `tools` | 加回 4 个工具 schema | 400 ⇒ **工具声明面是真凶**（再做“加 `defer_loading:true`”与“单个工具”两腿收窄） | 200 ⇒ 排掉 tools |
| E5 | `max_tokens` | 分别测：显式 16384 / 显式 8192 / **整键删除** | 删除后 200 ⇒ **真凶 = 显式覆盖路由缺省**（插件侧改成“不传”即可） | 全 400 ⇒ 排掉 max_tokens |
| E6 | `thinking`/`output_config` | `{type:"disabled"}`（无 output_config） vs `{type:"enabled"}+output_config:{effort:"high"}` | 二者一好一坏 ⇒ 精确到强度面 | 都坏 ⇒ 排掉，且与已做的 A/B 一致 |
| E7 | `messages` 形态 | 单轮 vs 加一轮 assistant `tool_use` + 对应 `tool_result`（且**紧跟**） | 单轮 200、双轮 400 ⇒ 第二轮形态是真凶 | 双轮也 200 ⇒ 排掉 messages |
| E8 | 请求头面 | 全头 vs 去掉 `x-deepseek-harness-session-id` vs 去掉 `anthropic-beta` vs 换出口网络 | 去掉某头后 200 ⇒ 头面真凶 | 全 400 ⇒ 排掉头面 |

**纪律**：E2 通过之后，每步只在**上一步仍失败**的 body 上改一处；一旦某步变通，**立刻停手**——那一步的唯一变量就是答案，继续加字段只会稀释证据。

### E0'（可选，极便宜）：读 `/models` 拿到该模型的协议声明

用同一凭据 `GET https://api.deepseek.com/models`（列表端点按 F7 会回 `anthropic_messages.system_prompt_update` / `tool_update` / `max_output_tokens` / `context_window`）。

- **读数**：若 `max_output_tokens < 16384` ⇒ E5 直接有嫌疑人；若 `tool_update` 是 `in-history`/`addition-only` ⇒ E4 优先级提到第 1。

---

## 四、给本仓的两条顺手结论（不是本次 400 的成因，但影响后续调查）

1. **批 46 的诊断面漏掉了唯一能终结调查的字段**：F6 说明响应体原文在 `Error.cause` 里，而 `lib/advisor.mjs` 的失败正文只用 `failure.message/name/code/status/requestId`。建议增一处：失败时追加 `cause` 原文（截断 500 字符）。这条落地后，本类 400 会**从“一句兜底串”变成“服务端原话”**。
2. **已登记的排除项里有一条不是有效实验**：`maxTokens=1024` 会被 `isValidAdvisorMaxOutputTokens`（4096..65536）判非法 → `console.warn` + **回落 16384**。所以“1024 也 400”证明的是“16384 也 400”，不是 1024。真正被排除的只有 65536/8192 两个值，而这两者都**不是“省略该字段”**。同理 `purpose` 现在可以从“实验排除”升级为“结构性不可能”。

---

## 五、需要你拍板的三件事（含建议）

| # | 事项 | 前因后果 | 我的建议 |
|---|---|---|---|
| 1 | 走**代理捕获**还是走**插件开关** | 代理：零改码、一轮抓两条、可 curl 回放；代价是临时改 baseURL（正常对话也会经过代理，需回滚）。插件开关：每加一个开关都要改 `lib/` + **重启 DSH**（本仓已确认改 lib 不热重载），一轮一个变量，成本高一个数量级 | **走代理**；插件开关只在代理被设置页拒绝（localhost 限制）时作为退路 |
| 2 | 是否现在就把 `cause` 原文加进失败正文 | 不加：下一次 400 仍然只有一句兜底串，等于把今天的调查重跑一遍。加：一行改动 + 一次重启，往后所有 400 都自带服务端原话 | **加**，且与 E0 同批做，一次重启吃两份收益 |
| 3 | 若 E5 命中（`max_tokens`），是“不传”还是“传模型上限” | 不传 = 跟 agent 侧 `adapterDefaults` 行为对齐，最小惊讶；传上限 = 显式但需要知道上限（`/models` 能给） | 优先**不传**（与正常对话同形），并在 `/models` 读数支持下把 `advisor.maxOutputTokens` 的解释改成“传则显式覆盖” |

**最小落地顺序（半天）**：E0 抓两条 → diff + 读 400 原文 → E2 基线 → E3/E4/E5 三条各一次 → 命中即收工。若 E1 就回到 200，直接转 E8（头面/出口网络），并在结论里写清“差异不在 body”。

[3] fangzhou-codeplan:kimi-k3.1-pro — ok
## 三句话结论

1. **若首轮请求就 400：最可疑的是 `tools` 的 schema／声明投影，其次是 `system` 的内容或长度；`sessionId` 与首轮 `messages` 概率较低。**
2. **若第一轮成功、工具结果回送后的第二轮才 400：`messages` 立即升为第一嫌疑**，重点是 `assistantMsg()` 丢弃了 reasoning 与 `replayState`。
3. 当前错误把原始 HTTP 响应藏进了 `cause`，随后又被标准化丢弃；**先抓真实出站请求体和原始 400 响应体，再做双向单变量实验**，否则只能靠猜。

### 代码依据

- [advisor.mjs](lib/advisor.mjs#L1577-L1579) 每轮固定装入四个只读工具；[advisor.mjs](lib/advisor.mjs#L1636-L1643) 同时携带 `system/messages/tools/sessionId`。
- [advisor.mjs](lib/advisor.mjs#L1249-L1280) 首轮只有一条 user 文本，但后续 `assistantMsg()` 只保留 `text/tool-call`，会丢掉 reasoning 和源消息上的 `replayState`。
- 普通 agent-loop 会传 `toolHistory`，见 [agent.ts](D:/workspace/deepseek-harness/packages/core/agent-loop/src/agent.ts#L695-L702)；advisor direct call 没传。这个差异值得查，但**不能单独解释 subagents 也失败**，因为 subagents 会走正常 agent-loop。
- [adapter.ts](D:/workspace/deepseek-harness/packages/llm/llm-deepseek/src/adapter.ts#L151-L161) 把原始响应保存为 `cause`；[transport.ts](D:/workspace/deepseek-harness/packages/llm/llm-deepseek/src/transport.ts#L22-L41) 在响应缺少 `error.message` 时才生成现在这句通用错误，`requestId` 则仅来自响应头。因此“无 requestId”不代表请求没发到服务端。
- [index.mjs](lib/index.mjs#L1182-L1193) 只是直接传入 `ctx.llm`；[effort-resolve.mjs](lib/effort-resolve.mjs#L72-L135) 只解析 effort。既然省略 effort 仍失败，这两处不应继续作为首轮实验重点。

```dsh-ui
{"title":"成因排序：首轮请求即 400","gap":10,"items":[{"type":"table","columns":["排名","嫌疑","判断依据"],"rows":[["1","tools 数组 / 工具声明投影","两类入口都带工具；direct call 不传 toolHistory，与普通 agent-loop 有真实差异。先查具体 schema、激活形态，不只查“有没有 tools”。"],["2","system 提示词内容或长度","system 字段本身受适配器支持；更可疑的是插件特有正文、长度，或与 tools 的组合。"],["3","sessionId 及其派生扩展","会同时影响 x-deepseek-harness-session-id 与 dsh_plugin_packages；但普通对话也带 sessionId，所以先验概率较低。"],["4","messages 形态","advisor 首轮仅一条 user 文本，且 subagents 不经过这套构造函数；若是第二轮才 400，则此项升为第 1。"]]}]}
```

## 隔离实验设计

以下是设计，**我尚未用真实 provider 执行这些探针**。

每次请求都记录：`case`、完整出站 body、白名单请求头、HTTP status、原始响应体、`request-id/x-request-id/x-deepseek-request-id`、最终 `finish`。**不要记录 `x-api-key` 或 `Authorization`。**

最好在 DeepSeek adapter 的 `fetch` 边界抓取，因为这里才能看到中间件和 `dsh_plugin_packages` 合并后的真实请求。可用唯一 probe marker 过滤其他并发请求，并在 `finally` 恢复 `fetch`。另抓一次正常普通对话作 JSON 对照，但对照 diff **不能替代**下面的单变量实验。

```dsh-ui
{"title":"可机械执行的单变量隔离矩阵","gap":14,"items":[{"type":"steps","steps":[{"title":"1. 在同一失败会话与路由下抓真实 wire：出站 body、白名单 headers、HTTP status、原始 response body；不记录凭据"},{"title":"2. 固定 FULL=原始失败首轮；MIN=仅 provider/model/maxTokens=1024/一条 PONG user，其余候选键整键缺席"},{"title":"3. 每项只删或替换一个 X：FULL 跑一臂，MIN 跑对称臂，用唯一 marker 关联请求与响应"},{"title":"4. 成功=HTTP 2xx + finish=stop + 有文本或 tool-call；目标失败=HTTP 400 + INVALID_REQUEST；其他结果均为未决"}]},{"type":"table","columns":["项","唯一开关（FULL 臂 / MIN 臂）","锁定与排除判据"],"rows":[["F0 / M0 基线","原样 FULL / 原样 MIN","FULL 必须复现 400，否则停止并查环境差异；MIN 若也 400，优先查公共中间件、请求扩展、账户/端点，不能归因四个候选。"],["T：tools","FULL 删除 tools / MIN 加 advisorToolSchemas() 四项","锁定：删后成功且加后 400。排除独立因：删后仍 400且加后成功。锁定后逐个单加 read/glob/grep/ls，再对命中项拆 name/description/parameters/required。"],["S：system","FULL 删除 system / MIN 加完整原始 system","锁定：删后成功且加后 400。随后分别用极短 system、等长填充、原文前半/后半单测，区分“字段存在”与“长度/内容”。"],["I：sessionId","FULL 删除 sessionId / MIN 加失败会话 sid","锁定：删后成功且加后 400。若锁定，再拆 header 与 dsh_plugin_packages 两个派生面；purpose=false 并不会关掉这个 sessionId 轴。"],["M：首轮 messages","FULL 换成 MIN 的简单 user / MIN 换成原始 firstUserText","锁定：简单文本成功且原始文本 400。若两臂都成功，首轮 messages 排除；不要用空 messages 当对照，因为它本身可能非法。"],["H：工具循环历史（仅首轮能成功时）","同一首轮响应分别保留完整 assistant/replay，或经 assistantMsg 过滤；tool result 保持完全相同","完整历史成功、过滤历史 400 ⇒ reasoning/replayState 丢失；两者都 400 ⇒ 继续查 tool_result 配对/形状；过滤历史成功 ⇒ 排除该嫌疑。"]]},{"type":"callout","tone":"warning","content":"“删除 tools”必须是整键缺席，不要改成 tools: []——序列化器会把后者发成空数组，那是另一个变量。FULL−X 成功但 MIN+X 成功表示交互作用，不得写成 X 已排除；下一步只把 X 与 tools 或 system 做双因素组合。"}]}
```

**建议执行顺序：先跑 `F0/M0` 和 `T` 的双臂，再跑 `S`；原始 400 body 若直接指出字段，则以该证据重排。若发现失败其实发生在第二轮，停止首轮矩阵，直接做 `H`。**

[4] zai-coding-cn:glm-5.3 — ok
# 会诊意见：deepseek-official 走插件固定 400 的成因排序与隔离设计

**三句话结论**：① 运行时真正服务 `deepseek-official` 的不是你能在 node_modules 里找到的那个适配器，而是 app.asar 内置的 **Anthropic-Messages 形态**适配器（`…/v1/messages`，带 `thinking`/`output_config`/`anthropic-version` 头）；② 你看到的报错文案 `DeepSeek Messages request failed (400)` 是适配器的**兜底文案**——只有当 400 响应体里**没有** `error.message` 字符串时才会出现，且 `requestId` 只从响应头读取（也没有）⇒ 这个 400 极可能来自**网关/策略层（非 JSON 错误体、无 request-id）**，而不是 API 本体的字段校验；③ 因此头号嫌疑是「网关按内容/形状的策略拒绝」，隔离路径 = 先抓出 DSH 实际发出的**字节级载荷**（baseURL 指到本地转发代理，免重启），再脱离 DSH 用 curl 单因子二分。

---

## 一、已核实的机制链（证据锚点）

**插件侧（请求装配）**
- 请求唯一出口 `lib/advisor.mjs:1636-1643`：`{provider, model, system, messages, tools, sessionId, purpose?, maxTokens, reasoningEffort?}`。round1 **第一次调用**的 messages 只有一条 user 消息（`advisor.mjs:1579`），没有任何 tool-result ⇒ 「工具配对/orphan tool_result」一族的假设**解释不了首 call 即 400**（若实测首 call 不红、第 2+ call 才红，则该族复活——见 E0）。
- tools 恒为 4 个只读工具（`lib/readonly-tools.mjs:168-217`；注意 `ls` 的 schema **没有 `required` 键**）。
- 收敛轮与 round1 共用同一 `runAdvisorToolLoop`，差异只在 system/首条 user 文本（`lib/advisor-msgs.mjs:134-191`）。

**平台侧（真运行适配器，从 app.asar 解出 `/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`，127,859 字节）**
- 请求体：`{model, stream:true, messages, max_tokens, thinking:{type:"enabled"|"disabled"}}` **恒在场**；effort≠off 时加 `output_config:{effort}`；`system` 为拼接字符串；`tools` 只要 `options.tools !== undefined` 就上 wire（空数组也会上 `tools:[]`）。
- 传输：`POST ${messagesApiRoot(baseURL)}/messages`（baseURL 不以 `/v1` 结尾则补 `/v1`）；头含 `anthropic-version: 2023-06-01`、auth 头、`x-deepseek-harness-user-id`、有 sessionId 时 `x-deepseek-harness-session-id`；**`purpose` 只有值为 `compaction` 才上头**——与你实测 sendPurpose=false 无效完全吻合（源头排除，不必再试）。
- 错误映射（`providerError`）：`message = body.error.message`（仅当是字符串）**否则兜底** `DeepSeek Messages request failed (${status})`；HTTP 400/413 → `INVALID_REQUEST`；`requestId` 仅取自响应头 `request-id`/`x-request-id`/`x-deepseek-request-id`；**原始 body 全文保存在 `LlmError.cause`（`cause: new Error(text)`）里**，但插件的括号段（`advisor.mjs:1459-1484`）只透出 code/status/requestId ⇒ **400 的真实原因文本被信封吞掉了**。
- 本地预校验（孤儿 tool_result、重复 call id 等）抛的是**带专门文案的本地 LlmError**，不会出现 `(400)` 字样 ⇒ 你看到的确定是 HTTP 层 400。
- dsh-llm 核心（`/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/index.js`）对 `purpose`/`sessionId` **零处理**（grep 0 命中）⇒ 两者不进 body。

**环境侧（新证据）**
- `C:\Users\huangchaowen\.dsh\llm-4xx-dump.log`（2026-08-31）显示这台机器的 DeepSeek 流量历史上走**带策略的公司网关**（`codegen.qianxin-inc.cn` / `ai-gateway.qianxin-inc.cn`），并有策略性 403：「this User-Agent is not allowed by configured policy」——网关按策略拒请求在本环境有前科。
- `C:\Users\huangchaowen\.dsh\llm-deepseek\files-v3.json` 有 **2026-11 月末的新鲜 Files API 记录**（同 baseURL、同 anthropic-beta 面）⇒ 端点、鉴权、连通近期都是通的——**与「普通对话正常」互证，指向「载荷特定」的拒绝**。
- 三条正常路由（zai-coding-cn/llmqax/fangzhou）注册在 `dsh-llm-pi-ai`（`C:\Users\huangchaowen\.dsh\profiles\desktop\cordis.patch.yml:49-50`），是**另一套 OpenAI-compat 适配器/网关**，wire 形态完全不同 ⇒ 「同载荷在别的网关通过」对定位 deepseek 网关的严格度没有约束力。

## 二、成因排序 + 隔离实验矩阵

```dsh-ui
{"items": [{"columns": [{"key": "rank", "label": "优先级"}, {"key": "cause", "label": "成因假设"}, {"key": "why", "label": "关键依据"}], "rows": [["P1", "网关策略层拒绝（WAF/中继按内容或形状拒，回非标准 400）", "报文=兜底文案（body 无 error.message）+ 无 request-id + 本机有网关策略前科 + 仅此 provider 中招"], ["P2", "thinking/output_config/max_tokens 字段组合落雷区（既有排除矩阵未交叉）", "普通对话组合恰好可用；插件 effort=off 会产生 thinking:{type:disabled} 这一非 Anthropic 标准形态"], ["P3", "插件 tools 数组 schema 细节（如 ls 无 required）", "插件专属的 4 个 input_schema；主对话工具集不同"], ["P4", "system/user 消息内容（长度上限或敏感词/字符）", "advisor·consult·escalate 提示词同族（CJK+安全词汇+emoji），普通对话提示词不同族"], ["P5", "x-deepseek-harness-* 头策略（UA/session-id）", "2026-08-31 有 User-Agent 策略 403 前科；一行 curl 可排除"]], "type": "table"}, {"columns": [{"key": "id", "label": "实验"}, {"key": "switch", "label": "唯一开关"}, {"key": "ok", "label": "通过判读"}, {"key": "fail", "label": "命中判读"}], "rows": [["E0", "读既有日志/cause 链定位首红 call", "拿到 400 body 原文=终局诊断", "无记录 → 进 E1"], ["E1", "baseURL→本地转发代理，跑一次 advisor", "代理录到完整请求字节+真实 400 body+首红 call 序号", "设置不热生效 → 改系统代理/mitm 方案"], ["E2", "捕获载荷原样 curl 复放真端点", "200 SSE → DSH 侧管道问题（重查中间件）", "400 → 载荷有罪，body 即诊断书"], ["E2b", "复放时去掉 harness/UA 头", "200 → 头策略成因（P5）", "仍 400 → 回到 body 字段"], ["E3.1", "基线最小请求（model+单条 user+max_tokens+thinking:enabled+effort:high）", "200 SSE = 基线绿（后续每格只加一项）", "400 → 端点/鉴权/头层问题，P1-P4 全部重排"], ["E3.2", "基线 + 插件 4 个 tools 原样", "200 → tools 无辜", "400 → 命中；再二分（只留 read / 去掉无 required 的 ls / 换 description）"], ["E3.3", "基线 + advisor system 原文", "200 → system 无辜", "400 → 命中；对半裁剪：1KB 仍红=内容敏感，1KB 变绿=长度"], ["E3.4", "基线 + advisor user 消息原文", "200 → 内容无辜", "400 → 命中；同样对半裁剪"], ["E3.5", "thinking enabled↔disabled 翻转（其余不动）", "两态皆绿 → 无辜", "单态红 → P2 组合成因"], ["E3.6", "max_tokens 扫 1024/4096/8192/16384/65536（固定 effort=high）", "全绿 → 无辜", "某值红 → 预算组合成因"], ["E3.7", "基线 + x-deepseek-harness-session-id（原值）", "200 → 无辜", "400 → P5 头策略"], ["E3.8", "E3.2-E3.7 全绿后做两两组合格", "组合亦绿 → 查三重交互或时序（重放首红 call 的完整原文）", "组合红 → 交互成因"]], "type": "table"}], "title": "deepseek-official 400：成因排序与隔离矩阵"}
```

## 三、实验落地要点

- **E1（抓字节，免重启）**：llm-deepseek 的设置面是**按请求解析**的（settings 变更下一条请求即生效——包内 `installSettingsSection` 机制），把 deepseek-official 的 baseURL 临时指到 `http://127.0.0.1:<port>` 的**转发代理**（本地收下请求→原样转发真端点→把真实 status/body 透传回来并落盘），在 DSH 里跑一次 advisor。一次运行同时得到：完整请求字节、真实 400 body、首红 call 序号。判据：代理日志出现 `POST …/v1/messages` 且 advisor 结果仍是 `(INVALID_REQUEST · HTTP 400)`。若 baseURL 改动竟需重启才生效——**停下，重启需用户拍板**（全局规矩），改走系统代理/mitm 方案。
- **E2/E3（脱离 DSH 复放）**：用 E1 落盘的 headers+body，`node`/`curl` 直打真端点。统一判读：**成功 = HTTP 200 + SSE 首事件 `event: message_start`；失败 = HTTP 400，并把 body 原文逐字记录**（这次的 body 你看得见——插件信封吞掉的那份）。每格只动一个开关，其余与基线逐字节相同。
- **E0（先做，零成本）**：适配器把原始 body 放在 `LlmError.cause` 里；先翻 DSH 侧日志（含 death-forensics / 会话日志里的 stream observation 行），grep `Messages request failed`，看有没有带 cause 的记录；同时确认 advisor 失败发生在第几次 llm 调用（首 call 红 ⇒ 消息历史族假设全灭；第 2+ call 红 ⇒ E3 加一格「+assistant(tool_use)+tool_result 历史」）。
- **未核实项（作为实验输入，不臆断）**：deepseek-official 当前 baseURL 的实际值（我在 storages/profile 常规位置没找到，E1 的代理日志会直接给出 Host）；普通对话实际下发的 effort/maxTokens 组合（E2 对照组可从代理日志抓一次普通对话请求得到——这是「好区」的样本）。

## 四、两个防跑偏警示

1. **红鲱鱼**：`C:\Users\huangchaowen\.dsh\dsh-browser\node_modules\.pnpm\@deepseek-ai+dsh-llm-deepse_…\lib\index.js` 是 **0.1.1-rc.1 的 chat-completions 旧拷贝**，与运行时无关（grep node_modules 会找到它）；真身是 app.asar 内的 Messages 形态适配器。按旧拷贝排障/打补丁会修错对象。
2. 本仓前科（advisor.mjs D-41 注释自记）：上一轮 400 事故就是「读代码下结论」翻车、靠逐字节复放才定位的——本矩阵的 E1/E2 就是把「不再猜」机制化：**先拿字节，再谈假设**。
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
| 2026-11-07 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |

## §2 逐条处置（主代理裁定）

| # | 模型 | 处置 | 理由 |
|---|---|---|---|
| 1 | llmqax:deepseek-v4-flash | 采纳（部分） | 采纳「max_tokens 恒在场」「400 兜底串 ⇒ 响应体无 error.message」「先抓两组请求再 diff」「maxTokens=1024 不是有效实验（<4096 回落）」；其「purpose 可结构性排除」经本代理复核成立，但**理由被改写**（见 §3） |
| 2 | deepseek-official:deepseek-v4-pro | 采纳（部分） | 采纳「E0 先取原始响应体」「先澄清子代理是否复现」；「tools 是头号嫌疑」记为待验证（本轮未做 E1 开关）；其把 purpose 归为「实验排除」被本代理推翻（见 §3） |
| 3 | fangzhou-codeplan:kimi-k3.1-pro | 采纳（部分） | 采纳「首轮 vs 第二轮决定嫌疑面」的判据与 FULL/MIN 双臂设计、「删 tools 必须整键缺席而非 tools:[]」；其把首轮 messages 列第 1 的排序**不采纳**（缺读数支撑），记为待验证 |
| 4 | zai-coding-cn:glm-5.3 | 采纳（部分） | 采纳「网关策略层拒绝」为并列候选（本机有 UA 策略 403 前科）；其适配器叙述已由本代理逐处自证（§3 六处行号） |

（方括号序号 = digest 中的回复序号减一，见 §1。）

## §3 本代理自证（运行时适配器，解自 app.asar 的 @deepseek-ai/dsh-llm-deepseek/lib/index.js，127859 B）

| 行 | 事实 | 对本案的意义 |
|---|---|---|
| 1772 | 兜底串 `DeepSeek Messages request failed (<status>)` 仅在响应体无 `error.message` 时出现 | 400 的响应体不是标准错误 JSON |
| 1785 | `requestId` 仅取响应头 request-id / x-request-id / x-deepseek-request-id | 「平台未填」= 上游没给，不是平台缺陷 |
| 2244 | `sessionId` 只进头 `x-deepseek-harness-session-id`，不进 body | sessionId 不参与 body 校验 |
| 2245 | `purpose` 仅当值 === "compaction" 才产生头 | **`purpose:"thincoder-advisor"` 从不产生任何 wire 差异 ⇒ 批 46 的 purpose A/B 是空操作，不是有效排除** |
| 2259 | `cause: new Error(text)` 保留响应体原文 | 插件信封未透出该字段——这是唯一能终结调查的信息 |
| 1732 | `max_tokens` 恒在场（options.maxTokens ?? model ?? connection） | 与普通对话的差异候选 |

## §4 本会诊即实验（读数）

- 交付 4/4、失败 0，其中含 `deepseek-official:deepseek-v4-pro`（此前 advisor 侧固定 400）。
- ⇒ 子代理路径（agent-loop）**不复现** 400 ⇒ provider / 凭据 / 账号 / 网关层封锁被排除。
- ⇒ 400 属 advisor 直连 `ctx.llm.stream` 的请求形态问题，嫌疑集中在 body 字段（tools / system / max_tokens / messages）。

## §5 裁定

- **采纳**：E0（先取 `cause` 原始响应体）+ baseURL 指本地代理抓「正常对话 / advisor」两组请求再逐字段 diff；不改插件、不重启即可执行。
- **登记修正（建议并入 R-46-3）**：① purpose 属结构性不相关，不再是「实验排除」；② `maxTokens=1024` 不是有效实验（<4096 回落 16384）；③ 子代理不复现 400。
- **待用户拍板**：是否推进代理实验（需临时改 DeepSeek baseURL，跑完回滚）。
