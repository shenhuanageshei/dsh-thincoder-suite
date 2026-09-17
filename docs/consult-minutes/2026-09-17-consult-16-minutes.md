# 会诊纪要 —— consult #16（原始层，机制落盘）

- 日期：2026-09-17
- 会诊 id：16
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
- 平台 job：consult-3
- 结果：3/4 交付（其中 3 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #16 finished — 3 of 4 replied (1 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #16 finished — 3 of 4 replied (1 failed)]
effective: 3 of 4 (1 failed · 0 without content)
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
job: consult-3
minutes: docs/consult-minutes/2026-09-17-consult-16-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] codex-cli:gpt-6-astra — failed
(consultation failed: codex-cli PROCESS_ERROR: codex 进程失败（非零退出且无有效输出）)

[2] zai-coding-cn:glm-5.3 — ok
证据收集完毕。以下是独立回盘意见——只读分析，不动代码。

---

## 总裁定

**方向 endorsed：`off` 是开关不是档位，把它当回落候选是类别错误，根修成立。** 且有一个主会话未强调、但**反而强化裁定**的证据：现行代码还存在**逆向形状**——显式请求 `off` 而模型无 `off`（如 `{low,medium}`）时，`nearestEffort("off", …)` 会回落到 `low`，即**用户明确要求关推理，却被打开**（`:920-921` 现役断言钉死了这个行为）。裁定 ②（off 不支持 ⇒ `null`）把这个更糟的形状一并修掉。这不是规避性补丁，是语义修正。

## 逐问回答

### Q1 修法有没有洞——有三个，都可堵

**洞 ①（最重要）：`off⇒null` 若照抄 codex 的静默形态，违反本模块自己的审计公约。** codex 侧 `effort-resolve.mjs:124` 的 `off⇒null` 是**无条件改名**（codex 梯子根本没有 off，必然发生，无需 note）。dsh 侧的 `off⇒null` 是**条件性回落事件**（仅当模型不支持时发生）。模块头注释 `:19-20` 明文「回落与透传都带 note（调用方把告警带进结果尾部，附录 D.3 规则）」。对称性只转移**值**（null），不转移**沉默**——若实现成 `{effort:null, note:null}`，用户显式关推理被静默换成提供方默认，恰是本批要消灭的「静默语义变更」类伤害。**必须带 note + console.warn**，且 note 措辞**不要**复用 `"falling back to nearest supported effort"`（不是最近档事件；独立措辞也让两侧断言不会交叉误绿）。

**洞 ②：断言锁面被低估——是 5 处不是 3 处。** 主会话登记 `:1002/:1119/:1175` 三处机制级断言，但 resolver 单测层还有两处直接钉死旧行为：
- `:914-916`：`low` 对 `[off,high,max]` → `"off"`（**生产事故复现档**，注解明写「绝不秒死」）——修后翻成 `"high"`，测试名里的「历史事故 → off」也要改写；
- `:920-921`：`off` 对 `[low,high]` → `"low"`——修后翻成 `null`（且需断言 note）。

只改三处机制断言，跑测试必红在这两处，别当成意外。

**洞 ③：实现形态陷阱——排除必须**按名**、在 **dsh 调用点**做，绝不能按下标、不能在 `nearestEffort` 内部做。** 见 Q4。

### Q2 退化集 `{off}` 兜底是不是自相矛盾——不构成形式矛盾，但理由层有一处真实张力，设计档必须二选一说清

按裁定原文「仅当支持集**完全没有力度档**时才用 off」读，「off 只在它是唯一候选时可选」是自洽规则（优先任何力度档；模型一个力度档都不给，才用它的唯一旋钮）。**张力在于**：裁定的**理由**（「off 是关闭开关，回落不得翻转开关」）在退化情形同样成立——`{off}`-only 模型上 `medium→off` 同样静默全关推理（只多一条 note）。即：**规则 ① 的机制和理由 ② 的哲学不共享同一个辩护**。两个自洽的完成式：

| 完成式 | 不变量 | 代价 |
|---|---|---|
| (i) 按裁定：退化→`off`+note | 「off 仅当唯一候选」 | README:281「medium 只在退化集 {off} 落 off」**保持字面为真**（文档面零改动）；但残余「回落翻开关」形状（{off}-only、`{off,xhigh}` 之外的变体）仍在 |
| (ii) 退化→`null`+note | 「输出 off ⟺ 显式请求 off ∧ 模型支持 off」——干净不变量，易测 | README:281、`lib/eng.mjs:45` 注释、CHANGELOG:59 的相关散文**必须同批改**（状态行与事实同步） |

我个人倾向 (ii)（不变量干净、把批 14 留的最后一个洞也关上），但 (i) 按裁定执行**可接受**——前提：退化分支**必须带 note**（不许复用透传通道），设计档显式写一段「为何豁免」。真正自相矛盾的只有「用 (ii) 的理由、行 (i) 的机制」却不解释。

另有一个**子形状必须区分**：`{off, xhigh}`——`xhigh` 是力度档但不在 dsh 梯子上。按裁定原文它**有**力度档 ⇒ 不落 off ⇒ 走既有「无交集」透传（`:105`，`high` 原样 + note）。实现上这意味着要区分「候选池去 off 后**为空**（退化）」与「非空但**无 dsh 梯档**（透传）」两种 null。

### Q3 `null` 出口会不会打穿调用方——不会，五处消费点逐一核过

| 调用点 | 消费形态 | null 时 |
|---|---|---|
| `consult.mjs:702-703` | `if (effRes.effort)` 三元 | `agentOptions` **不含** reasoningEffort 键 |
| `escalate.mjs:410-412` | 同上三元 | 同上 |
| `eng.mjs:971/:1071` | `engCoderEffortFinal !== null ? {reasoningEffort} : {}`，注释明写「null 表示不传」 | 键缺省 |
| `advisor.mjs:2265/:2481` | `effort: effRes.effort ?? undefined` → `runAdvisorToolLoop:1438` `isValidEffort ? : null` → `:1507` falsy 不展开 | 键缺省 |

三点补强：① **null 通道今天就在生产上跑**（requested 未设时 `:66` 返回 null），不是未测路径；② 任何消费点都**构造不出** `reasoningEffort: null` 字面量（全是三元/展开缺省，不会进 JSON 序列化面）；③ `isValidEffort`（`advisor.mjs:373/:416`）枚举**含 off** ⇒ 「受支持的显式 off」在 advisor 工具环里不会被二次丢弃——无 advisor 特有不一致。

### Q4 codex 侧连带面——按推荐形态实现则为零，且只有一种实现会出事

推荐：**`nearestEffort` 函数一行不动**，off 排除只做在 `resolveSupportedEffort` 的调用点（`:96` 精确命中检查**之后**、`:97` 传参前）：

```js
if (efforts.includes(requested)) return { effort: requested, note: null }   // ← 原样，先于一切排除
if (requested === "off") { /* note + WARN; return { effort: null, note } */ }
const pool = efforts.filter((e) => e !== "off")
const nearest = nearestEffort(requested, DSH_EFFORT_LADDER, pool.length ? pool : efforts)
```

`pool.length ? pool : efforts` 这个小手法让**退化豁免自然落出**（off 只在唯一候选时可能胜出），零分支。codex 侧连带面：

- **语义零连带（按名排除）**：`CODEX_EFFORT_LADDER` 无 off 档 ⇒ 名排除对 codex 是结构化 no-op（`:43` 的 `ci<0 continue` 本来就跳过 off）；codex 的 `requested==="off"` 在 `:124` 短路，永远到不了 `nearestEffort`。
- **危险实现（按下标排除，如「排除 ladder[0]」）会真打穿 codex**：codex 梯子 `[0]` 是 **`low`**——`medium` 对 `{low,xhigh}` 会从 `low` 翻成 `xhigh`，`:942-945`、`:1023` 等一串 codex 断言全红。这是唯一的连带路径，设计档里要写成禁止项。
- 顺序陷阱：若把 off 从 `efforts` 里滤在 `:96` **之前**，「受支持的显式 off」会被误送进 off⇒null 分支——`:922-924`（off 对 `[off,high]` → 保持 off、无 note）就是防这个的阴性对照，**不许改**。

### Q5 负控与阴性对照怎么造才有意义

原则：**「修了什么」用翻断言证明，「没修坏什么」用零编辑仍绿证明**。清单：

**零编辑必须仍绿（阴性对照主体）**
1. **codex 全家族不动**：`:939-978`（resolver）、`:1008-1027`（consult codex）、`:1055-1073`（escalate codex，含 off→argv 不传）、`:1075-1099`（eng codex）、`:1124-1154`（advisor codex）——共享函数未被语义漂移的证明。
2. `:896-900` 受支持档原样（无 note 无告警）——排除只发生在回落路径，不碰命中检查。
3. `:922-924` **off 受支持 → 保持 off**——裁定 ② 的头号负控（防顺序陷阱）。
4. `:927-937` 元数据不可得 → fail-open 透传——透传语义未动。
5. `:902-908` + `:1207`（`medium` 对 `[low,high]`/`[off,high]` → `high`）——DP-2 等距向上在力度域内存活。

**翻预期（阳性）**：`:914-916`（→ `high`，事故档复现新语义）、`:920-921`（→ `null` + note）、`:1002/:1119/:1175`（→ `high`，note 措辞断言同步）。

**新增用例**：显式 off 不支持 → `null` + note 且 note **不含** "falling back"；退化 `{off}`（按裁定 → off+note，或按推荐 → null+note，断言写清）；`{off,xhigh}` 请求 `high` → 透传 + 「无交集」note（区分两种 null 的探针）；机制级断言用 **`!("reasoningEffort" in agentOptions)`**（键缺省）而非 `=== undefined`——这类 bug 的病灶就是「键在、值错」，断言键缺省才能逮住 `reasoningEffort: effRes.effort` 无条件展开的回归。

### Q6 裁定方向本身——没有问题，两条精化

方向对（含逆向形状的修复收益）。精化即 Q1-洞①（off⇒null 必带 note）与 Q2（退化分支二选一、说清理由；我倾向 null 但按裁定执行可接受）。

## 交付面清单（供父侧排期）

- 代码：`lib/effort-resolve.mjs`——`resolveSupportedEffort` 内加 off⇒null 分支 + pool 过滤（约 +12 行）；`nearestEffort` 零改动；头注释 `:16-17` 回落语义描述**同批更新**（描述面与实现一致）。
- 测试：5 处断言翻预期 + 6 条零编辑负控圈定 + 4 条新增用例。
- 文档同步（视 Q2 选择）：README:281、`lib/eng.mjs:45` 注释（现况描述→历史描述）、METHODOLOGY 批 19 行；CHANGELOG:59 是 v0.23.0 历史条目，不改史。

[3] deepseek-official:deepseek-v4-pro — ok
# 会诊意见：批 19 `nearestEffort` 根修复核

先说结论：**裁定方向本身无否决点**（off 是开关、不是力度档，把它放进距离竞争是类别错误，生产事故形状实证存在）。但有 **1 处锁面计数错误、1 处实现层真洞（退化判定的写法）、1 处 null 覆盖缺口**，以及若干需要写进设计的语义点。逐条如下。

## ① 锁面不是三处，是 4+1 处断言 + 3 处文案

摸底漏了最直接的一处——**单元级锁**：

| 位置 | 现役钉死 | 新语义下 |
|---|---|---|
| `test/codex-runner.test.mjs:914-915` | `low` 对 `[off,high,max]` ⇒ `"off"`（消息「D-裁决-2 最近支持档，**绝不秒死**」） | ⇒ `"high"` |
| `:1002`（consult dsh 接线） | `reasoningEffort === "off"` | ⇒ `"high"` |
| `:1119`（eng dsh 接线） | 同上 | ⇒ `"high"` |
| `:1175`（advisor dsh 主路径） | 同上 | ⇒ `"high"` |
| `:920-921`（显式 off 对 `[low,high]`） | ⇒ `"low"` | **规则 ② ⇒ `null`** |

另外三处描述文案会变假：`:910` 标题里的「历史事故 … → off」、`:915` 消息、`:919` 标题「off 参与档位序（未受支持 → 最近档）」。改写断言时必须同改这些文案（否则文档卫生规则 5 起步扣分）。好消息：`:902-908`（DP-2 等距向上）、`:910-912`（非等距最近）、`:922-924`（显式 off 受支持保持）、`:1023`/`:1050`/`:1180-1207`/`:2580`/`:2615`（medium 对 `[off,high]` ⇒ high，off 本来就没赢）**全部保持绿色**，可直接列作阴性对照。

## ② 退化集 `{off}` 不矛盾，但「退化」的判定写法有个真洞

矛盾与否取决于理由的表述：**「off 不参与力度距离竞争」** 与退化兜底自洽；**「回落永不落 off」** 则自相矛盾——设计档必须用前者措辞。退化兜底本身可辩护：它是唯一保证不抛 `UNSUPPORTED_REASONING_EFFORT` 且不回归现役行为的选项（现役 `{off}` 请求 low 也是落 off，只是没改名）。

**真洞在实现**：退化判定若写成「nearest 返回 null 且 off ∈ efforts ⇒ 落 off」，会把 `{off, xhigh}` 这类形状误判成退化（xhigh 不在 dsh 梯子，nearest 返回 null，于是落 off——但 xhigh 是力度档，只是本仓梯子不认识）。正确判定是 **`efforts 去掉 off 后为空`** 才算退化；去掉后非空但无梯子交集 ⇒ 走既有 fail-open 透传（现役 `:105-106` 路径）。这是本批最重要的实现细节。

另：`{off}` 在真实 pi-ai 元数据里几乎不可达（真机要么列真档要么全空走透传），退化兜底主要是防御完备性 + 测试夹具面。建议退化路径用**独立文案**（如「supported 仅含 off——退化兜底」），与常规回落 note 区分，便于运维识别。

## ③ null 出口：四个调用方全部结构性 null-safe，但缺一条接线级钉

| 调用方 | 机制 | 判定 |
|---|---|---|
| consult `:702-703` | `if (effRes.effort) … else {provider, model}` | ✓ provider/model 保留，key 缺席 |
| escalate `:410-412` | 同形三元 | ✓ |
| eng `:926` + `:971`/`:1071` | `!== null ? {reasoningEffort} : {}` | ✓ |
| advisor `:1507` 展开 + `:2265`/`:2481` `?? undefined` | truthy 展开 | ✓ |

**不会穿洞**：现役 falsy-request 路径（`:66` 返回 null）已经在走这些分支，规则 ② 只是把更多输入路由到同一分支。但有一个覆盖缺口：**没有任何接线级测试钉「truthy 请求 ⇒ null ⇒ reasoningEffort 键缺席 + provider/model 仍在」**——规则 ② 首次让该路径生产可达（显式 off 对无 off 档模型）。必须新增：consult dsh 行 `effort:"off"` 对 `[low,high]` ⇒ `!("reasoningEffort" in started[0].agentOptions)` 且 provider/model 仍传。这条就是「null 不穿洞」的回归锁。

## ④ codex 侧连带面：零行为变化，但别把 "off" 硬编码进共享函数

`CODEX_EFFORT_LADDER`（`:27`）无 off；codex catalog 的 `supported_reasoning_levels` 不含 off，且即便含，现役 `:43` 的 `indexOf(cand) < 0 → continue` 已跳过。所以候选过滤对 codex 路径是严格 no-op，`medium` 对 `[low,high]` ⇒ high（`:1023`）、codex 显式 off ⇒ null（`:1070`）等现役钉全部不动。

但**推荐实现形态**：`nearestEffort` 保持纯距离函数，把「off 排除 + 退化判定」放在 dsh 调用侧（`:97` 处先过滤 pool 再传入）。这样「codex 零连带」由检视可证，而非依赖「codex 梯子恰好没有 off」这一事实——未来若 codex 侧出现 off 类开关，硬编码会静默吞掉它。规则 ② 同理：dsh 侧新增 requested-off 分支，与 codex 侧 `:124` 对称，共享函数零改动。

## ⑤ 规则 ② 的两个语义点（不否决，但必须写进设计）

1. **null ≠ 「无推理」，是「交还提供方默认」**。显式 off 的成本意图在无 off 档模型上不可兑现——新行为下用户要的是关推理，实际拿到的是提供方默认档（可能比旧行为落到的 `low` 更贵）。旧行为落 `low` 至少方向贴近意图。这与 codex 侧语义一致、裁定有效，但设计档要明说这个不对称，别让读者以为是「最低档」。
2. **建议 dsh 侧规则 ② 带 note**（codex 侧保持静默，`:124` 现役钉不动）。理由：dsh 侧旧行为落 `low` 时是带 note 的，静默化会丢失一个显式请求的可见性；且 `:1120`、`:1004` 等断言依赖 note 子串（「is not supported by model」「falling back to nearest supported effort」），若规则 ② 静默则这类断言面反而更窄。

另注意一个现役不对称（写入设计即可，不必改）：**元数据不可得时显式 off 仍原样透传**（`:92-95` fail-open）——规则 ② 只覆盖「确知不支持」，元数据缺失时不知支持与否，透传是 fail-open 原则的既有推论，与所有档位一致。

## ⑥ 阴性/阳性对照清单（有意义的构造）

**阴性（应保持绿色，多数现役可复用）**：N1 DP-2 等距向上 medium/[low,high]⇒high（`:902`）；N2 非等距 high/[off,low]⇒low（`:910`）——证明只排除了 off、没动距离语义；N3 显式 off 受支持⇒off（`:922`）；N4 codex 三钉（`:1023`/`:1070`）——证明共享面零泄漏；N5 medium/[off,high]⇒high（`:1180`/`:2580`/`:2615`）——证明排除 off 不改「off 本来就输」的局；N6 fail-open 透传族（`:927-937`/`:960-977`）。

**阳性（新增/改写，钉新语义）**：P1 单元 low/[off,high,max]⇒high + note（改写 `:914`）；P2 三处接线断言改写为 "high"（`:1002`/`:1119`/`:1175`）；P3 单元显式 off/[low,high]⇒**null**（改写 `:920`）；P4 接线级「null ⇒ key 缺席、provider/model 仍传」（新增，见 §③）；P5 单元退化 low/[off]⇒off + 独立退化文案（新增）；P6 单元 tie-after-exclusion：medium/[off,low,high]⇒high（排除后仍等距，tie-break 不因过滤失效）；可选 P7 low/[off,max]⇒max——距离 1 的 off 被排除后跳到距离 3，把「开关不参与竞争」钉到极端。

## ⑦ 散文连带面（同批同步，别漏）

修复后 `lib/eng.mjs:45` 注释与 `README.md:281` 的「low 是唯一在一切非退化支持集上都可能被 `nearestEffort` 静默落到 off 的程度档」整段过期（回落不再落 off，该理由不复存在）；`effort-resolve.mjs` 头注释 `:16-20` 的回落语义段需补「off 不参与距离竞争 + 退化兜底 + 显式 off 规则 ②」。`EFFORT_LEVELS`（`advisor.mjs:373`、`config-api.test.mjs:748`）含 off 不动——显式 off 仍是合法配置入口。若新增顶层 `test(`，T-LC2 台账同批同步。

**总评**：方向采纳，无证据支持否决。需修正的是三件机制细节——退化判定按「efforts∖{off} 为空」而非「nearest 为 null」、过滤放调用侧不污染共享函数、规则 ② 在 dsh 侧带 note 并在接线层钉 null 出口；锁面按 4+1 处计数重报。

[4] kimi-api:kimi-k3 — ok
核查完毕。基于当次实测（非旧登记），逐问回答。先给总判：

```dsh-ui
{"title":"总判：裁定方向成立，但有 3 个必须前置处理的点","gap":12,"items":[
{"type":"callout","tone":"success","title":"方向无洞","content":"裁定①是 DP-2（保推理质量）的一致完成：新行为在每个支持集形状上都不差于旧行为（支配性论证见下）。裁定②可立。实现落点建议放在 dsh 包装层而非 `nearestEffort` 函数体——根修的是语义，不动共享函数。"},
{"type":"callout","tone":"warning","title":"三个前置点","content":"**H1** 现役锁面实测是 5 处不是 3 处，其中 `:921` 钉的恰是裁定②要废除的行为（显式 off 不支持 ⇒ 旧语义落 low）；**H2** 裁定②若不带 note，「用户要关、实际开」的同种静默只是下移了一层；**H3** 退化分支的触发条件必须精确定义，否则 `{off, 不可排序档}` 子形状没有表态。"}
]}
```

## 一、锁面实测：5 处，不是 3 处

```dsh-ui
{"gap":10,"items":[
{"type":"table","columns":["位置","层级","钉死的行为","裁定后应为"],"rows":[
["test/codex-runner.test.mjs:915","单元","`low` 对 `[off,high,max]` ⇒ `\"off\"`","`\"high\"`（裁定①）"],
["test/codex-runner.test.mjs:921","单元","显式 `off` 对 `[low,high]` ⇒ `\"low\"`","`null` + note（裁定②——**此断言与裁定直接冲突**）"],
["test/codex-runner.test.mjs:1002","集成 consult dsh","`reasoningEffort === \"off\"`","`\"high\"`"],
["test/codex-runner.test.mjs:1119","集成 eng dsh","同上","`\"high\"`"],
["test/codex-runner.test.mjs:1175","集成 advisor dsh 主路径","同上","`\"high\"`"],
["test/codex-runner.test.mjs:922-924","单元","`off ∈ supported` ⇒ `\"off\"`、note null","**不变**（负控①）"],
["test/codex-runner.test.mjs:1207","集成 advisor 回落轮","`medium` 对 `[off,high]` ⇒ `\"high\"`","**不变**（负控②，新语义下巧合同值）"]
],"types":["text","text","text","text"]},
{"type":"text","content":"只改你登记的三处 ⇒ `:915`/`:921` 两条单元测试必红。另：`:910` 的测试**标题**（「历史事故 low 对 [off,high,max] → off」）与 `:913` 注释在修复后变陈旧，同批改写——把事故形状的新归宿（⇒ high）写进标题。"}
]}
```

## 二、逐问回答

**Q1：修法有没有洞？** 方向无洞，但有 6 个精度点（H1 见上表）：

```dsh-ui
{"gap":8,"items":[
{"type":"list","items":[
"**H2 裁定②必须带响亮 note**：裁定原文只说了 `effort:null`，没说 note。`off` 不受支持时给 `null` = 推理按**提供方默认**跑——用户的「关」被逆转为「开」。若无 note，这正是本批要杀的同种静默。注意 codex 侧既有 `off⇒null` 是**沉默的**（`effort-resolve.mjs:124` 返回 `note:null`），且该沉默被 `:955` 断言钉死——「与 codex 对称」若包含沉默，就是在引进它。建议：dsh 侧 ② 带 note（新行为新文案，不破既有断言）；codex `:124` 是否解钉（翻 `:955`）单独拍板，本批至少登记。",
"**H3 退化分支条件要精确**：建议定义为 `candidates = supported ∩ dsh梯子 \\ {off}` 为空 **且** `off ∈ supported`。`{off, xhigh}` 这类「off + 不可排序档」子形状必须表态——建议同走退化分支（off 是唯一**已验证可用**的值；盲选不可排序档是从 low 到 xhigh 的预算跳变，超出 DP-2「等距向上」的授权范围），note 点名不可排序档。",
"**H4 实现落点 = dsh 包装层，不改 `nearestEffort` 函数体**：在 `resolveSupportedEffort` 内 `pool = efforts.filter(e => e !== \"off\")` 后调原函数。语义根修一分不少，codex 连带面从「需要论证为零」变成「结构上不存在」。新逻辑顺序：fast path（:96，`off∈supported` 仍原样保持）→ `requested===\"off\"` ⇒ `null`+note → pool 过滤取最近 → 空 ⇒ `off∈efforts` ? 退化 `off`+note : 既有 passthrough（:105）。",
"**H5 fail-open 路径上的显式 off**：元数据不可得时无法判定支持集，现状原样透传 `off`——若模型实际不支持则 `UNSUPPORTED_REASONING_EFFORT` 秒死（正是本机制要防的砖）。这是「fail-open 统一透传」教义（头注 :18-20）与砖化风险的微决策，建议**保持透传 + 设计档登记**，不为 off 开特例。",
"**H6 描述面同批同步**（文档卫生）：`README:281` 与 `lib/eng.mjs:40-46` 的「low 是唯一可能被 nearestEffort 静默落到 off 的程度档」修复后**成为假陈述**，须改写为历史记述 + medium 缺省的现行理由；`METHODOLOGY.md:156`、`docs/2026-09-15-config-surface-design.md` 的 P1/D14-2 行加前向指针（状态行与事实同步）。",
"**H7 设置面不对称被 note 放大**：新 note 会写 `supported: off|high|max`，而设置页下拉因 `index.mjs:641` 滤 null 只显示 `high|max`——用户对照困惑。批 14 勘察 §7.6 已登记，本批交叉引用即可，不必顺手修。"
]}
]}
```

**Q2：退化 `{off}` 兜底自相矛盾吗？** 不矛盾，但有两个强制条件：

```dsh-ui
{"gap":8,"items":[
{"type":"callout","tone":"info","title":"不自相矛盾——支配性论证","content":"裁定①保护的是「**存在**力度档时的推理预算」；退化集里按定义不存在可保护的预算，`off` 没有偷走任何本可存在的推理。逐形状比对：旧行为里只有 `requested=low` 能在非退化集上落到 `off`（off 在下标 0，等距向上 ⇒ 只有**严格最近**才胜出 ⇒ 需 `supported` 同时缺 low/medium）；这些形状下新行为全部改落力度档（严格更好），其余所有形状新旧同值。**没有任何形状变差** ⇒ ①+退化兜底是一个支配性改进，不是折中。"},
{"type":"callout","tone":"warning","title":"两个强制条件","content":"① 退化分支**必须带 note 且措辞与普通回落分叉**（不能含 `falling back to nearest supported effort`）——因为只钉值的话该断言对新旧实现都绿（旧代码对 `{off}` 也得 off），区分力**全部**在 note 措辞上（见 Q5）。② 触发条件按 H3 精确定义并在设计档写明，否则「退化」与「bug 回潮」无从区分。"}
]}
```

**Q3：`null` 出口会不会打穿调用方？** 实测六个消费点，全部兜住：

```dsh-ui
{"gap":8,"items":[
{"type":"table","columns":["消费点","兜底形态","结论"],"rows":[
["advisor dsh 主路径 advisor.mjs:2481 → :1507","`effRes.effort ?? undefined` → `...(effort ? {reasoningEffort} : {})`","✓ 省略"],
["advisor 回落轮 advisor.mjs:2265","同上","✓ 省略"],
["consult dsh 行 consult.mjs:702-703","`if (effRes.effort)` truthy 分支","✓ 省略"],
["escalate dsh 行 escalate.mjs:410-412","三元 truthy 分支","✓ 省略"],
["eng dsh 分支 eng.mjs:926 → :971/:1071","`...(effortFinal !== null ? {...} : {})`","✓ 省略（见下）"],
["codex 三处 → buildCodexArgs codex-adapter.mjs:284","`effort ?? undefined` → `if (effort)`","✓ argv 不带 effort 项"]
],"types":["text","text","text"]},
{"type":"text","content":"一个瑕疵（非洞）：eng 用 `!== null` 而非 truthy——resolver 契约（`:66` `requested ?? null` 及其余返回均为 string|null）保证永不返回 `undefined`，今天打不穿；但若有人改契约返回 `undefined`，`undefined !== null` 为真会把 `reasoningEffort: undefined` 铺进 agentOptions。建议顺手对齐 truthy 或登记为已知脆点。"}
]}
```

**Q4：codex 侧连带面？** 按 H4 落点是**结构性零**：`nearestEffort` 是模块私有函数（仅 `:97`/`:160` 两调用点），改 dsh 包装层则 codex 路径执行的代码一行未变。即使改函数体特判 `off`，论证也是零：codex 梯子（`:27`）不含 `off`，目录里若混入 `"off"` 本就被 `:43` 的梯子检查跳过，`requested==="off"` 被 `:124` 在进入函数前拦截。但「论证出来的零」不如「结构性的零」。codex 钉死套件（`:939-978`、`:1023`、`:1060`、`:1065-1073`、`:1094`、`:1134`、`:1151`）整组不动且全绿，即零连带的回归证。

**Q5：负控与阴性对照怎么造才有意义？** 核心是这张**可证明完备**的语义差分表：

```dsh-ui
{"gap":8,"items":[
{"type":"table","columns":["requested","supported","旧行为","新行为","旧实现下新断言"],"rows":[
["low","{off}","off（普通回落 note）","off（**degenerate note，措辞分叉**）","仅靠 note 子串红"],
["low","{off,high}","off","high","红（值）"],
["low","{off,max}","off","max","红（值）"],
["low","{off,high,max}","off","high","红（值）"],
["off","无 off 集如 {low,high}","最近档 low","**null + note**","红（值+键存在性）"],
["medium/high/max","任意非退化集","最近档","**同值不变**","—（负控，不红才对）"],
["任意","{off} 退化","off","off（值同，note 分叉）","仅靠 note 子串红"]
],"types":["text","text","text","text","text"]},
{"type":"text","content":"**完备性证明**（写进设计档）：off 在下标 0 且等距向上 ⇒ 仅当严格最近才胜出 ⇒ 仅 `requested=low`（idx1）且 `supported ∩ {low,medium} = ∅` 时新旧值不同；枚举 `supported ⊇ {off}` 的全部此类形状即表中前四行。其余 requested 在一切形状上新旧同值。"},
{"type":"list","items":[
"**阴性对照规则 1**：每条新断言在设计档登记「旧实现下为红」的具体方式。**值差异只在 4 行**；退化行只钉值是永真断言（旧代码也得 off）⇒ 必须钉 degenerate note 的关键子串，且该子串不得出现在普通回落 note 里。",
"**阴性对照规则 2**：显式 `off`⇒`null` 的集成断言钉「`agentOptions` **无** `reasoningEffort` 键」（`!(\"reasoningEffort\" in agentOptions)`），不是钉值——防的是 null 被打穿成 `reasoningEffort: \"off\"` / `\"null\"` 的回归。",
"**阴性对照规则 3（负控）**：`:902-908`（tie-break 向上）、`:922-924`（off 快路径）、`:927-937`（fail-open）、`:1207` 及全部 codex 钉**保持不动且全绿**——它们红任何一条都说明改动越界。",
"**阴性对照规则 4（变异测试）**：实现后临时撤掉 off 过滤跑一次套件，应当在且仅在差分表值差异行红；然后恢复。这证明测试网眼尺寸正好。",
"**执行方式**：新测试先对未改的 lib 跑一遍（git stash），逐条确认按预期方式红，再实施修复转绿——红的方式（值红 vs note 红）比红本身更有信息量。"
]}
]}
```

## 三、对裁定本身的异议——有，但只到「登记取舍」这一级

```dsh-ui
{"gap":8,"items":[
{"type":"callout","tone":"info","title":"裁定②有一个值得登记的反向论据（不推翻）","content":"显式 off 不受支持时，**`null` 是未验证的提供方默认**——对推理强制型模型（支持集 `[low,medium,high]` 无 off），提供方默认通常**不是**最低档。若用户配 off 的意图是省钱/关推理，`null` 可能给出比「最低受支持档」更贵的结果。备选方案「向上取最低受支持档」用**已验证可用**的值保住成本意图。反论也成立：`null` 永不抛错、两侧规则统一（off⇒省略）、且不为用户明确拒绝的推理 token 买单。**结论：方向不推翻，但「最低档备选被否决的理由」必须写进设计档**——不写，下一个人会把它当 bug 改回最近档。"},
{"type":"callout","tone":"warning","title":"唯一坚持项","content":"裁定①我完全支持；裁定②我唯一坚持的是 **dsh 侧必须带响亮 note**（H2）。`off` 是关闭开关，它被静默逆转为「提供方默认开」比「low 静默落 off」更难被用户察觉——用户配 off 时往往根本不打算看输出质量。note 文案建议显式包含「未能关闭推理」字样，与普通回落 note 分叉。"}
]}
```

主要产出：以上分析全部基于当次实测（`lib/effort-resolve.mjs:35-170`、六个消费点、`test/codex-runner.test.mjs:896-1209` 锁面、`lib/codex-adapter.mjs:284`、`lib/index.mjs:641`），未引用旧登记的计数。锁面 5 处、语义差分 7 行表、消费点 6 处核查是本回答的实测增量。如果你裁定 H2（dsh 侧 ② 带 note）与 H4（包装层落点），我就可以按差分表开工——codex `:124` 的沉默解钉与否，等你一句话。
```

## §2 逐条处置（**主代理写** · 每条回复**恰一条**处置）

### §2.1 [1] `codex-cli:gpt-6-astra` — **处置：无输出可处置**

`consultation failed: codex-cli PROCESS_ERROR: codex 进程失败（非零退出且无有效输出）`。
**这是该席第四次 `PROCESS_ERROR`**（批 9 · 批 10 各一次；批 18 两轮后成功一次）。按 R-15 / 批 4 同族纪律：**不重试、不补位、不臆称结论**。**有效数如实登记 3/4**。

### §2.2 [2] `zai-coding-cn:glm-5.3` — **处置：采纳 5 条 / 不采纳 1 条**（共 6 条）

| # | 它主张什么 | 处置 |
|---|---|---|
| **[2]-1** | **逆向形状**：显式 `off` 而模型无 `off` ⇒ 现役回落到 `low`（**用户要关推理，却被打开**）；`test/codex-runner.test.mjs:920-921` 现役断言钉死了它 | **采纳**（父侧实测复现，见 §4-2） |
| **[2]-2** | **洞②：锁面是 5 处不是 3 处**（补 `:915` 与 `:921`） | **采纳**（父侧独立实测同值：仓外副本 **472 pass / 5 fail**，见 §4-1） |
| **[2]-3** | **洞①：`off⇒null` 必须带 note + `console.warn`**，且措辞**不复用** `falling back to nearest supported effort`（不是最近档事件；独立措辞也让两侧断言不会交叉误绿） | **采纳**（并入 §3 D-3） |
| **[2]-4** | **洞③：排除必须按名、在 dsh 调用点做；禁按梯子下标**（codex 梯子 `[0]` 是 `low` ⇒ 按下标会把 `medium` 对 `{low,xhigh}` 从 `low` 翻成 `xhigh`） | **采纳**（落为设计档的**禁止项**，§3 D-2） |
| **[2]-5** | **Q3：五处消费点逐一核过 ⇒ `null` 不打穿** | **采纳**（父侧独立复核同结论，§4-5） |
| **[2]-6** | **Q2 完成式 (ii)**：退化 ⇒ `null`（它自标为「倾向」） | **不采纳（附理由）**：① 与用户 2026-09-17 的裁定原文相抵触（「**仅当支持集完全没有力度档时才用 `off`**」，见 §3 D-1）；② 它把退化集唯一的**已验证可执行值**换成**未验证的提供方默认**。**⇒ 采纳其诊断（必须说清理由），不采纳其取值。** |

### §2.3 [3] `deepseek-official:deepseek-v4-pro` — **处置：采纳 9 条 / 不采纳 1 条**（共 10 条）

| # | 它主张什么 | 处置 |
|---|---|---|
| **[3]-1** | **锁面 = 4+1 处断言 + 3 处陈旧文案**（测试标题 `:910` · 消息 `:915` · 标题 `:919`） | **采纳**（父侧实测同值，§4-1） |
| **[3]-2** | **退化判定写法是真洞**：写成「`nearest` 返回 `null` 且 `off ∈ efforts` ⇒ 落 `off`」会把 `{off, xhigh}` 误判 | **采纳其诊断**（取值另行裁定，见 **[3]-10**） |
| **[3]-3** | **`null` 出口缺一条接线级钉**：truthy 请求 ⇒ `null` ⇒ **键缺席** + `provider`/`model` 仍在 | **采纳**（落为新增验收用例；断言用 `!("reasoningEffort" in agentOptions)`） |
| **[3]-4** | codex 侧零连带，但**别把 `"off"` 硬编码进共享函数** | **采纳**（§3 D-2） |
| **[3]-5** | 规则②的语义：**`null` ≠「无推理」，是「交还提供方默认」**；「要关得到开」的不对称必须写明 | **采纳**（进设计档 §4 决策理由与 §9 残差） |
| **[3]-6** | dsh 侧规则②**带 note**（codex 侧 `:124` 保持沉默） | **采纳** |
| **[3]-7** | 元数据不可得时显式 `off` **仍原样透传** —— 登记为既有不对称 | **采纳**（进 §9 边界，不为 `off` 开特例） |
| **[3]-8** | 阳性 **P1–P7** / 阴性 **N1–N6** 对照清单 | **采纳**（逐条进设计档 §8.2 负控表） |
| **[3]-9** | 散文连带面：`lib/eng.mjs:45` · `README.md:281` · `effort-resolve.mjs` 头注释 `:16-20` · `T-LC2` 台账 | **采纳**（进 §10.1 写域） |
| **[3]-10** | `{off, xhigh}` 的归宿：**透传**（它认为去掉 off 后非空 ⇒ 非退化 ⇒ 走既有「无交集」透传） | **不采纳（附理由）**：见 §3 **D-1**（三条可测理由：扩大爆炸半径 · 引入秒死路径 · `off` 是该形状唯一已验证可用值） |

### §2.4 [4] `kimi-api:kimi-k3` — **处置：采纳 10 条 / 不采纳 2 条**（共 12 条）

| # | 它主张什么 | 处置 |
|---|---|---|
| **[4]-1** | **锁面 5 处**（逐处点名，含 `:921` 与裁定②正面冲突） | **采纳**（§4-1） |
| **[4]-2** | **H2：规则②必须带响亮 note**——否则「用户要关、实际开」的同种静默只是下移了一层 | **采纳**（§3 D-3） |
| **[4]-3** | **H3：退化触发条件要精确；`{off, xhigh}` 这类「off + 不可排序档」应走退化支** | **采纳**（**这是与 [3]-10 的正面分歧**，父侧裁定见 §3 D-1） |
| **[4]-4** | **H4：实现落点 = dsh 包装层，`nearestEffort` 函数体不动**（codex 连带面从「论证为零」变「结构性为零」） | **采纳**（§3 D-2） |
| **[4]-5** | **H5：fail-open 路径上的显式 `off` 保持透传 + 登记** | **采纳**（同 [3]-7） |
| **[4]-6** | **H6：描述面同批同步**（`README:281` · `lib/eng.mjs:40-46`） | **采纳**（live 面，进 §10.1） |
| **[4]-7** | **H6 后半**：给 `METHODOLOGY.md:156` 与 `docs/2026-09-15-config-surface-design.md` 的旧行加前向指针 | **不采纳（附理由）**：它们是**带日期的历史记述**（W3），「兑现」由 CHANGELOG + METHODOLOGY 批 19 行承载。**唯一例外**见 §3 D-5（该档 §10 是**触发条件表**，只填其证据格） |
| **[4]-8** | **H7：设置面不对称被新 note 放大**（`index.mjs:641` 滤 null ⇒ 下拉只显示 `high\|max`，而 note 会写 `off\|high\|max`） | **采纳**（批 14 勘察已登记 ⇒ **只交叉引用，不顺手修**） |
| **[4]-9** | **支配性论证**：新行为在**每个**支持集形状上都不差于旧行为 | **采纳**（作为设计档的正确性论证；父侧穷尽 31 集复核，§4-3） |
| **[4]-10** | 异议（登记取舍级）：裁定②的「**向上取最低受支持档**」备选被否决的理由**必须写进设计档**，否则下一个人会当 bug 改回去 | **采纳**（进设计档 §4 的「被否决的备选」） |
| **[4]-11** | codex `:124` 的**沉默是否解钉** | **不采纳（附理由）**：本批**不解钉**——理由与登记见 §3 **D-4** |
| **[4]-12** | `eng.mjs` 用 `!== null` 而其余处用 truthiness —— 已知脆点 | **采纳为登记**（本批不改，理由见 §5 的 **R-59**） |

---

## §3 分歧与父侧裁定（**主代理写**）

### D-1 ★ **退化触发条件的定义，与 `{off, xhigh}` 的归宿**（[3]-10 vs [4]-3 的正面分歧）

**裁定：采纳 [4] 的取值。**

**触发条件（逐字进设计档）**：
```
cands    = supported ∩ DSH_EFFORT_LADDER          // 在本插件梯子上的候选
degrees  = cands \ { "off" }                      // 力度档候选
pool     = degrees.length > 0 ? degrees : cands   // 力度域优先
退化 ⟺ degrees.length === 0 ∧ cands.length > 0    // off 是本梯子上唯一候选
```
⇒ `{off}` 与 `{off, xhigh}` **都落在退化支**：值 = `off` ＋ **独立措辞的退化 note**（note 回显 `supported:` 全集，**不会掩盖 `xhigh` 的存在**）。
⇒ `cands` 为空（如 `{xhigh}`）⇒ 走**既有**的「无交集」透传路径（逐字不变）。

**不采纳 [3]-10 的三条理由（逐条可测）**：

| # | 理由 | 证据 |
|---|---|---|
| ① | **它把行为改到超出本批靶子的形状上** | 现役代码对 `{off,xhigh}` 请求力度档**就是落 `off`** ⇒ [3] 的写法把它改成透传 ⇒ **爆炸半径从「恰 3 组」扩大**（父侧穷尽实测，§4-4） |
| ② | **它引入一条秒死路径** | 透传的是一个**已知不被支持**的请求值 —— 正是本机制 2026-09-04 立项要消灭的病 |
| ③ | `off` 是该形状里**唯一已验证可执行**的值 | `xhigh` 不在插件梯子上，`nearestEffort` **永远选不到它** ⇒ 「抛不抛得动」未知 |

**★ 而 [4] 的论证我不照抄**：它给的理由是「盲选不可排序档是低到 `xhigh` 的预算跳变」——**在 `{off,xhigh}` 上「选 xhigh」这个选项根本不存在**。**⇒ 采纳结论，改写理由**（这正是「会诊报告自己也会漏 / 结论对而机理错」的同族，见 §5 教训 2）。

### D-2 **实现落点 = dsh 调用点；`nearestEffort` 函数体零改动**（三家一致）

**理由**：codex 侧的「零连带」从**论证出来的零**变成**结构性的零**（codex 路径执行的代码**一行未变**）。
**★ 禁止项（逐字进设计档）**：**禁按梯子下标排除**（「排除 `ladder[0]`」）——codex 梯子 `[0]` 是 `low`，按下标会把 `medium` 对 `{low,xhigh}` 从 `low` 翻成 `xhigh`。

### D-3 **规则②（显式 `off` 不被支持 ⇒ `effort: null`）必须带 note + `console.warn`**（三家一致）

- 措辞**不复用** `falling back to nearest supported effort`（不是最近档事件；且**避免两侧断言交叉误绿**）。
- note 必须让「**未能关闭推理**」可见（[4]-2 的坚持项）。
- 依据是**本模块自己的公约**：头注释「回落与透传**都带 note**（调用方把告警带进结果尾部，附录 D.3 规则）」——**对称性只转移值（`null`），不转移沉默**（[2]-3）。

### D-4 **codex 侧 `:124` 的沉默不解钉**

**理由**：它是**无条件**改名（codex 梯子根本没有 `off`），不是条件性回落事件；翻它要动 `:955` 的现役钉与 codex 既有语义 ⇒ **超出本批靶子**。**登记为本批 §9 残差**（R-58）。

### D-5 **历史批次档不加前向指针**（不采纳 [4]-7）

`docs/2026-09-15-config-surface-design.md` 与 `METHODOLOGY.md` 批 14 行是**带日期的历史记述**——它们那句「`low` 是唯一……落到 `off` 的程度档」**是当时的真值**，不是现状断言（W1 的「未密封区」限定语正是为此而设）。**「契约已兑现」由 CHANGELOG 与 METHODOLOGY 的批 19 历史行承载**（D7 留痕）。
**⇒ 唯一例外**：该档 **§10 偏离表的 `nearestEffort` 行**——它的「触发条件」列写的是「**该批次立项时**」，**那是一张触发登记表，而触发已发生** ⇒ **只填其「证据」格（add-only），不动其余**。

### D-6 **交付豁免（`requiresReport: true` 的处置）**

digest 标 `requiresReport: true`，按纪律**默认应停在会诊断点向用户汇报**。**豁免依据 = 类型 2「目标已由用户原话固定」**：

> 用户 2026-09-17 原话：「【链条】会诊 → **纪要裁定层+ack** → 需求档 → 设计档 … → 交接页 + METHODOLOGY 历史行」·「**做完批 19 再做批 20**」

**链条本身把「继续走完」写成了指令**，且**用户已给出本批的语义裁定**（`ask_user_question` 的两个答案）。**⇒ 不停在会诊断点，按用户给定的链条继续**；**本条处置的汇报随本会话的最终回复给出**（逐条处置表 + 采纳/不采纳清单）。

---

## §4 父侧独立回盘核（**不采信任何一方的自报**）

**方法**：① 把整仓拷到**仓外临时副本**，在其上实施**拟议修法**并跑全量（这是实测锁面，不是推理）；② 用**真实** `resolveSupportedEffort` 穷尽 dsh 梯子的 **31 个非空支持集**；③ 逐处读消费点源码。**仓内零残留**。

| # | 待核主张 | 出处 | 父侧实测 | 结论 |
|---|---|---|---|---|
| **§4-1** | 锁面是 **5 处**（不是 3 处） | [2]-2 · [3]-1 · [4]-1（三家独立同结论） | 仓外副本实施拟议修法 ⇒ `node --test` = **472 pass / 5 fail**，失败**恰为** `:915` · `:921` · `:1002` · `:1119` · `:1175`，**零其他失败** | **成立**。⇒ **父侧交给会诊的简报里写的「3 处」是错的**（漏了 resolver 单测层那两处） |
| **§4-2** | **逆向形状**：显式 `off` 不被支持 ⇒ 落到力度档（把推理打开） | [2]-1 | 真实 resolver：`off` 对 `{low,high}` ⇒ `"low"` · 对 `{medium,high}` ⇒ `"medium"` · 对 `{max}` ⇒ `"max"`（均带 note） | **成立** |
| **§4-3** | **支配性论证**：新行为逐形状不差于旧行为 | [4]-9 | 穷尽 31 集：`requested=low` 落 `off` 恰 **4** 组（`{off}` · `{off,high}` · `{off,max}` · `{off,high,max}`）；`medium`/`high`/`max` 各**仅**退化集 1 组；`off` 自身 16 组**全是命中**（note=false） | **成立** |
| **§4-4** | 改动差集 | 父侧（模型态）+ 副本实测双路 | **恰 3 组**：`{off,high}`→`high` · `{off,max}`→`max` · `{off,high,max}`→`high`；退化集 `{off}` 五种请求**全仍落 `off`**；`{xhigh}` 仍透传；codex 侧零变化 | **成立**（**「恒等于 3」正是 D-1 选值的凭据**） |
| **§4-5** | `null` 出口不打穿消费点 | [2]-5 · [3]-3 · [4] | 逐处读源：`consult.mjs:702-703` · `escalate.mjs:410-412` · `eng.mjs:971`/`:1071`（`!== null`）· `advisor.mjs:2481 → :1507` · `advisor.mjs:2265`。且 `null` **今天就在生产上跑**（`requested` 未设时 `:66` 即返回 `null`） | **成立** |
| **§4-6** | 本部署形状与「今天是否中招」 | 父侧 | `profile/settings.yaml`：**20 个模型条目 / 8 个是 `{off,high,max}`**；`profile/profiles/web/cordis.patch.yml:30-31` 的 convergence 是 **`glm-5.3-flash` + `low`**、`:35` 是 **`engCoderEffort: low`** —— **恰是中招组合**；但被 user 层 `.thincoder/config.json` 的 `max`/`high` 覆盖 | **成立**（**as-of 2026-09-17**）⇒ **今天未中招；清掉 user 层即中招**（新机器照抄 base 亦中招） |

---

## §5 教训与登记（**主代理写**）

### §5.1 教训三条

| # | 教训 | 证据 |
|---|---|---|
| **1** | **父侧把锁面写成「3 处」而实测是 5 处** —— 「枚举不追列表」同物种又一次命中；**这次由两路独立发现**（仓外副本实跑 + 三家会诊）。**并且它与批 14 的 W1 同族**：**交给会诊的简报里仍带着父侧未同步的旧值** | §4-1 |
| **2** | **会诊报告本身必须回盘核**：[3]-10 的退化判定写法**照抄会扩大爆炸半径并引入秒死路径**；[4]-3 的**结论对、而它给的理由在 `{off,xhigh}` 上不成立** | §3 D-1 |
| **3** | **`codex-cli` 第四次 `PROCESS_ERROR`** —— **3/4 是本仓会诊的常态而非异常**；不补位、不重试 | §2.1 |

### §5.2 登记（**全文见** `docs/2026-09-17-effort-off-fallback-requirements.md` **§5.2**）

**R-57**（`{off,xhigh}` 形状在本部署真实语料上**零观测** ⇒ 退化支取值争议**不可在真实语料上验证**）· **R-58**（codex 侧 `:124` 的沉默是本批**有意不解**的残差）· **R-59**（`eng.mjs` 的 `!== null` 判空与其余三处的 truthiness **不同源**，今天等价、契约一变即铺 `reasoningEffort: undefined`）。

> **D2 单一权威源**：本处只给指针，**三行的全文与处置在需求档 §5.2**，不在此重述。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-17 | 机制落盘（§0 汇总 + §1 原始层） |
| 2026-09-17 | **裁定层补写（主代理）**：**§2 逐条处置**（[1] 失败席「无输出可处置」· [2] 采纳 5 / 不采纳 1 · [3] 采纳 9 / 不采纳 1 · [4] 采纳 10 / 不采纳 2）· **§3 六条裁定 D-1…D-6**（★ **D-1 是 [3]-10 与 [4]-3 的正面分歧**：`{off, xhigh}` **走退化支取 `off`**，**不采纳** [3] 的透传写法，附三条可测理由；**D-6 = 交付豁免的类型 2 依据**（用户原话已把链条写成指令））· **§4 六项父侧独立回盘核**（★ **锁面 5 处**由**仓外副本实跑**证实 —— **父侧交给会诊的简报里的「3 处」是错的**）· **§5 教训三条 + R-57…R-59**（全文在需求档 §5.2） |
