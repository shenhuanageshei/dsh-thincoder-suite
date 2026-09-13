# 需求：评审上下文预算跟随模型窗口 + 评审估算器 CJK 加权 —— 批 5

- 日期：2026-09-13
- 批次：批 5（批次排序见 [`2026-09-12-absorption-inventory.md`](./2026-09-12-absorption-inventory.md) §6；上游来源 = 第 25 批 `ADVISOR-CONTEXT-BUDGET` + 群 B `ADVISOR-CONVERGENCE` §18）
- 设计输入：**会诊 id 1**（4 模型并发：glm-5.3 / deepseek-v4-pro / kimi-k3 交付完整裁定；codex-cli:gpt-6-astra 超时 20 分钟）+ **父侧只读勘察**（DSH 运行时窗口通道，见 §0.2）
- 设计档：[`2026-09-13-context-budget-design.md`](./2026-09-13-context-budget-design.md)
- 状态：**设计待评审**（本档落笔于设计评审之前）

---

## §0 会诊汇总（纪律要求：会诊结果落档，含分歧与父侧裁定）

### §0.1 模型结果

**会诊 id 1**（4 模型并发，`consultTimeoutMs` = 20 分钟）：

| 模型 | 结果 | 贡献 |
|---|---|---|
| zai-coding-cn:glm-5.3 | ✅ 交付 | 完整裁定；主张**读 settings.yaml**、**回退 128K**、**拆两批**；提供头寸四科目分解 |
| deepseek-official:deepseek-v4-pro | ✅ 交付 | 完整裁定；主张**五级链含插件内置模型表**、**回退 262144**、**同批交付**；提供头寸闭合性定量核验 |
| kimi-api:kimi-k3 | ✅ 交付 | 完整裁定 + 逐项亲验；**独立发现运行时权威通道**、主张**三级链无内置表**、**回退 128K**、**同批交付**；发现「现状 CJK 评审在 200K 窗模型上会先撞 provider 硬错误」 |
| codex-cli:gpt-6-astra | ⏱ 超时 | —（20 分钟看门狗终止；即 D-29 那条「会诊超时不可配」痛点的现场重演——该键已于 D-29 进 user 层白名单，本批零关系） |

### §0.2 一条关键事实：两家会诊的前提被推翻

glm-5.3 与 deepseek-v4-pro 都在「窗口从哪来」上绕了远路（读 `settings.yaml`、建插件内置模型表），
因为它们默认「插件拿不到模型元数据」。**该前提不成立**——父侧另派只读勘察，kimi-k3 独立核验，两边结论一致：

| # | 事实 | 证据 |
|---|---|---|
| 1 | DSH 运行时服务暴露模型元数据 | `ctx.llm.resolveModelInfo(provider, model)` → `info.context.contextWindow`（`dsh-llm` `LlmRuntime`；**非** `@Remote` 远程调用，是进程内解析） |
| 2 | **本插件已经在调它** | `lib/effort-resolve.mjs:81` `await llm.resolveModelInfo(provider, model)`——为 `reasoning.efforts` 而调，且已接在评审两条路径上（`lib/advisor.mjs:1722` 回落轮 / `:1907` 主路径），带 fail-open 守卫（`:71-78`） |
| 3 | 它返回的是**适配器权威值**，覆盖内置路由 | pi-ai：`models[].contextWindow ?? 目录 base ?? defaultContextWindow`；内置 deepseek 适配器：`configured ?? connection.defaultContextWindow`。**`deepseek-official` 这类内置路由在 settings.yaml 里查不到**（`llm-deepseek: {}` 为空），只有这条通道拿得到 |
| 4 | 本部署的默认评审路由窗口 = **1M** | `dsh-llm-deepseek`：`deepseek-flash` 的 `contextWindow: DEFAULT_CONTEXT_WINDOW` = `1e6`；DSH `agent-default-model` = `deepseek-official/deepseek-flash` |

**推论（直接决定修法）**：`settings.yaml` 直读 = 严格更劣的第二真相源（对内置路由必然落空）；
插件内置模型表 = 必然随模型 ID churn 腐烂的第三份目录。**两者都不采用**（见设计档 D-CB2/D-CB3）。

### §0.3 分歧与父侧裁定

| # | 争点 | 三方主张 | 父侧裁定 |
|---|---|---|---|
| 1 | 窗口来源与优先级 | glm/v4-pro：读 settings.yaml（v4-pro 另加内置表）｜kimi：三级链（手配 > 运行时权威 > 常量） | **采纳 kimi**——运行时通道已实证且本插件已在用（§0.2）；settings 只是用户覆盖层，对内置路由必然落空 |
| 2 | 未知路由回退值 | glm 128K｜v4-pro 262144｜kimi 128K | **128K（131072）**。决定性理由（kimi）：262144 是 pi-ai **声明式路由的配置缺省**，对 pi-ai 路由它本来就会经权威通道到达——选 128K 不丢弃它，只是不让它在「对该路由一无所知」时冒充证据。且失败不对称：高估 → provider 硬报错、预算白烧；低估 → 早压缩、评审仍完成 |
| 3 | 两缺陷同批还是分批 | glm：拆两批（窗口先行）｜v4-pro：同批｜kimi：同批 | **同批**。两方同批论据可复算（见 §2.3），且我们跑在 live profile——拆批的中间态会上生产 |
| 4 | OOM 头寸 | 三家一致：保留比例、改写注释归因 | **采纳**——旧注释归因错误（见 §2.4） |
| 5 | 判定族/尾文案/压缩本体 | 三家一致：逐字零改 | **采纳**——`"Advisor:"` 前缀是**失败**判定契约（各路径以 `startsWith("Advisor:")` 判「未产出可用评审」，如 `advisor.mjs:1732` 的 `fbCompleted`；completed 判定正是消费它），`compactMessages` 被 T13 钉住 |

### §0.4 会诊未定死、由父侧补充的裁定

| # | 裁定 | 理由 |
|---|---|---|
| P-a | 新增手配键 `advisor.contextTokens`，语义 = **模型窗口**（**不是**判死线） | 三源同语义（配置 / 适配器 / 兜底），不让窗口语义与预算语义分裂成配置地雷；手配是唯一保证可达的止血阀 |
| P-b | 值域 = 整数 `16384..4194304` | 4M = 本部署实测最大窗（1048576 / 1024000）的 2 倍；能挡住多打一位的笔误，又不约束任何现实模型 |
| P-c | 接线点 = **已在调 `resolveModelInfo` 的那两处**（`advisor.mjs:1722` / `:1907`），每次评审解析一次 | 与 `resolveSupportedEffort` 同点同缝；不引入新缝、不改 `resolveAdvisorRoute` 的纯同步契约 |
| P-d | 观测只走 console + **兜底时才追加 post-finalize note**；**绝不进判死文案** | 返回文案是协议面（completed 判定 / prior 存储）；`dshEffNote`/`dshCapNote` 已有「机制后缀在 finalize 之后」先例 |
| P-e | codex-cli 路由 **零改动** | `runAdvisorToolLoop` 全库仅三个调用点（`:1727` 回落 dsh / `:1947` dsh 后台 job / `:2011` dsh 同步），**全是 dsh 路由**；codex 走子进程自管上下文，无消费面 |

---

## §1 总目标（一句话）

让评审循环的上限**来自它真正要调的那个模型的窗口**、让「估算值」**不再对中文内容系统性撒谎**——
两件事一起落地，因为拆开任何一件都比现状更糟。

---

## §2 背景与问题

### §2.1 缺陷一：评审上下文预算写死，与实际模型的窗口无关

| # | 事实 | 证据（as-of 2026-09-13） |
|---|---|---|
| 1 | 上限是常量 | `lib/advisor.mjs:44` `const MAX_CONTEXT_TOKENS = 120_000 // 上下文窗口预算（预留余量）` |
| 2 | 两个消费点都读它 | `lib/advisor.mjs:1156` `currentTokens > MAX_CONTEXT_TOKENS * 0.8` → 本地压缩；`:1158` 压缩后仍 `> MAX_CONTEXT_TOKENS` → **判死** |
| 3 | 判死文案 | `:1159` `"Advisor: context window limit reached (" + N + " tokens). Review incomplete — too many tool calls. Try a narrower scope."` |
| 4 | 生效两档（现状） | 压缩触发 **96000**、判死线 **120000** ——与任何模型无关 |
| 5 | 本部署的默认评审路由窗口 = **1M** | `deepseek-official/deepseek-flash`（DSH `agent-default-model`）；适配器 `DEFAULT_CONTEXT_WINDOW = 1e6` |
| 6 | 浪费倍数 | 写死帽 **8.3×** 低于本机默认路由自己的窗口声明；换算成「上游式派生」口径，120K/96K 恰好等价于**一个假想的 150K 窗口** |

**当前没有本机事故日志**（会话记录中检索 `context window limit reached` 零命中）——因为这需要单次评审的估算上下文
真的越 120K（宽范围评审 + 大量文件读取）。上游 thincoder 的同款缺陷是**以事故形态出现**的
（`Advisor: context window limit reached (120225 tokens).`，用户报告为 bug）。**我们这条是潜在缺陷、不是历史事故**，
如实记录：本批的动因是代码事实 + 上游实证，不是本地翻车。

### §2.2 缺陷二：估算器对 CJK 内容低估约 4×

| # | 事实 | 证据 |
|---|---|---|
| 1 | 估算式 = UTF-16 码元数 ÷ 4，扁平 | `lib/advisor.mjs:944-946`：`Math.ceil(JSON.stringify(m.content ?? []).length / 4)` |
| 2 | `.length` 计 UTF-16 码元，一个汉字 = 1 码元 | ⇒ 1 个汉字被估成 **0.25 token** |
| 3 | 真实开销 ≈ 1 token/汉字 | 低估 **~4×**；ASCII 侧 4 字符 ≈ 1 token，旧式是准的 |
| 4 | 后果（kimi-k3 实测推论） | 现状下 200K 窗模型 + 中文内容：本地压缩要到**真实 ~384K** 才触发——**此时早已越过 provider 真窗**，用户看到的是 provider 侧 `context_too_long`，而不是本地干净判死 |

### §2.3 为什么两条缺陷必须同批（可复算）

| 假设 | 后果 |
|---|---|
| **只上窗口派生**（估算器不动） | 1M 窗模型判死线抬到 800000（**旧的、低估 4× 的尺子**）⇒ 对应真实内容 ≈ 3.2M tokens，**越过 1M 真窗**——本地干净判死换成 provider 硬错误。且现状的 120K 帽**恰好在无意中挡住了这个坑**（把 CJK 真实占用压在 ~480K 以内）⇒ **比现状更糟** |
| **只上估算器**（120K 帽不动） | 估值变准 ⇒ CJK 评审的本地死点从真实 ~480K 前移到真实 ~120K ⇒ **4× 级预算回退**（ASCII 逐值不变，纯 CJK 用户单方面受损） |
| **同批** | 尺子修准 + 上限跟随窗口，两者互为前提：`0.8` 头寸的安全论证**只在估算器准确时闭合**（上游自认「20% 头寸盖不住 4× CJK 低估」） |

上游能拆两批，是因为两批落在同一发布窗口内；**本插件跑在 live profile（会话记录里已有 1M 窗模型在用）**，
拆批的中间态会上生产。

### §2.4 旧注释「Reserve headroom to avoid OOM」归因错误

1M tokens ↔ 估算口径 ~4M 字符 ↔ JS 字符串 ~8MB（UTF-16）——与 V8 默认堆相差两个数量级，
**进程 OOM 不成立**。头寸的真实用途是四项：输出预算（输入输出同窗）、估算器看不见的 system/tools schema、
分词漂移、压缩后增长走廊。本批**保留 0.8/0.8 比例**，只改写注释归因（设计档 D-CB8）。

---

## §3 功能用户故事

| # | 用户故事 | 判定句（可机验 / 可见） |
|---|---|---|
| **US-1** | 作为用大窗模型（1M）跑评审的用户，我希望评审不再因为一个与我模型无关的常量被判死 | 1M 窗 + 196608 估算 tokens 的夹具 → 评审**正常收尾**，不出现 `context window limit reached`（设计档 AC-CB2 反向控制：旧帽同夹具**判死**） |
| **US-2** | 作为用小窗模型（128K/200K 级）的用户，我希望判死线跟随**我的**窗口，而不是所有人共用 120K | 200K 窗 → 判死 160000 / 触发 128000；131072 兜底 → 判死 104857 / 触发 83885（逐值断言） |
| **US-3** | 作为中文内容为主的用户，我希望估算值不再低估 4×，判死点名副其实 | 纯 ASCII **逐值等于旧式**（零回归）；`"中"×400` → 400（旧式 100）；200 ASCII + 200 CJK → 250 |
| **US-4** | 作为运维/排障的我，希望知道窗口是从哪来的、什么时候是猜的 | 窗口来源三态可分辨（config / runtime / fallback）；走兜底与元数据失败**响亮告警**，且兜底时**在评审返回尾部追加一行机制说明**（post-finalize，不入 prior） |
| **US-5** | 作为要覆盖特殊路由的用户，我能在设置页配 `advisor.contextTokens`，且三面一致 | PUT 校验（区间整数）⊕ merge 白名单 ⊕ 设置页回显/内联校验；非法值 PUT 拒绝、运行时忽略并告警 |
| **US-6** | 作为评审机制的使用者，我不希望本批顺手改变评审协议的任何可观察行为 | 判定族六 kind / 六条尾文案 / `compactMessages` 本体 / 两段式守卫结构（先压缩后判死）**逐字零改**；既有 304 用例**原样全绿** |

---

## §4 非功能标准

| # | 标准 | 判定 |
|---|---|---|
| **N-1** | **零新依赖** | 不引入 YAML 解析器、不新增 npm 依赖；纯 `node:fs`/既有模块 |
| **N-2** | **纯 ASCII 零回归** | 新估算式对纯 ASCII 与旧式**逐值相等**（`ceil(ascii/4) + 0`），可单测证明 |
| **N-3** | **fail-open，绝不砖化** | 元数据缺失/方法缺失/抛错/无 `context` 字段 → 逐级下探 + 告警，**评审照常进行**（对齐 `effort-resolve.mjs` 既有教义） |
| **N-4** | **协议面零改** | 判死文案、判定族、尾文案、`compactMessages`、两段式结构逐字不动 |
| **N-5** | **既有锁零伤** | `node --test` 基线 **304/304 原样全绿**（零用例修改；若确需改既有用例 → 先上报父侧裁定） |
| **N-6** | **三面同步** | 新配置键照抄 `advisor.maxOutputTokens` 先例：校验单一事实源（`advisor.mjs` 导出）⊕ `index.mjs` PUT ⊕ `config-store.mjs` 白名单 ⊕ `client.js` 设置页 |

---

## §5 边界与登记面

**本批明确不做**：

1. 不建插件内置模型表（必然腐烂的第三份目录）；不读/解析 `settings.yaml`（不引入 YAML 依赖）；
2. 不改 codex-cli 路由（无消费面，§0.4 P-e）；不改服务端窗口 / tpm 闸门；
3. 不改 `compactMessages` 本体与签名；不改判定族/六条尾文案；不改 `estimateTokens` 的签名与导出面；
4. 不改 `resolveAdvisorRoute` 的纯同步契约（窗口解析走异步旁路）；
5. 不为 consult/escalate/eng 加本地上下文守卫（它们无多轮循环，无消费面）。

**登记面（本批不做、如实记录）**：

| # | 登记项 | 说明 |
|---|---|---|
| R-1 | `estimateTokens` 的 UTF-16 码元口径 | 星平面字符（emoji）计 2 码元 → 计 2 tokens；与上游同口径，本批不改 |
| R-2 | 手配值域上限 4M | 若将来出现更大窗模型，需重估（当前为实测最大窗的 2×） |
| R-3 | 超小窗 + 超大头寸的残余格子 | `maxOutputTokens=65536` ∧ 小窗时，20% 头寸可能小于输出预算——由手配键 + 设置页 hint 承接 |
| R-4 | 吸收清单 §1 P1 行的行号漂移 | 该行引「`:1032/:1034` 消费」，批 3 后实为 `:1155-1161`；**批 5 收口时随批更新**（不在设计期改写台账基线） |
