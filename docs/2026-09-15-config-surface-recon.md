# 批 14 摸底记录 —— 配置面与描述面同步

- 日期：2026-09-15
- 状态：**摸底（父侧自测已完成第一轮 + P0 机制剖析；独立勘察 `c189c415` 已派发）**
- **本档的用途**：暂存摸底结论，**批 14 正式开工后并入会诊纪要与设计档 §10**（本仓无「摸底档」先例，故此为临时载体，届时可退役或转为设计档附录）
- **主题**：**「插件自己的契约」与「它对外声称的契约」的一致性**

---

## §1 四项范围（全部经父侧实测，勿信旧登记）

| # | 项 | 级 | 实测依据 |
|---|---|---|---|
| **P0** | `engCoderEffort` 默认值与回落目标 | 🟡（**先前定级偏高，见 §3 订正**） | `lib/eng.mjs:752` `let engCoderEffort = "low"`；`:759-760` 非法值回落文案里**再硬编码一次 `low`**；`README.md:227` 与 `cordis.patch.yml:43` 的示例都写 `engCoderEffort: low` + 注释「缺省 low」 |
| **P1** | 白名单注释 vs 判据键集 **无常设锁** | 🟡 | `test/` 对 `cordis.patch.yml` **只有 2 处注释提及、零断言**（`codex-runner.test.mjs:3196`/`:3335`）；批 13 一次性修了 **4 项 / 2 文件**的缺漏，**下次改动仍会漂** |
| **P2a** | 审计 F8 遗留（批 13 带过来） | 🔵 | 见 §4 |
| **P2b** | V7 的 `topAllowed` 白名单一致性面 | 🔵 | `test/path-kind.test.mjs` 有 26 处 `criteriaDoc`（卡片 / 三态 / `PK_KEYS` 家族），**缺白名单一侧的常设断言** |

---

## §2 P0 机制（逐字复制自出厂源码后实测）

**两把梯子**（`lib/effort-resolve.mjs`）：

```js
const DSH_EFFORT_LADDER   = ["off", "low", "medium", "high", "max"]              // :25
const CODEX_EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"]   // :27（不含 off）
```

**算法**（`nearestEffort`，`:35-52`）：在 ladder **下标距离**上取最近受支持档，**等距向上**（DP-2）。

**★ 穷尽枚举结果（父侧实测，DSH 梯子全部 31 个受支持集）**：

| requested | 落到 off | 落到 low | 落到 medium | 落到 high | 落到 max |
|---|---|---|---|---|---|
| `low` | **4 / 16 含-off 集（25%）** | 16 | 8 | 2 | 1 |

（「含-off 集」= 16 个；落到 off 的**恰 4 个**。）

**⇒ 精确条件**：`requested = low` 落到 `off` **当且仅当** `low ∉ supported` ∧ `medium ∉ supported` ∧ `off ∈ supported`（此时 `off` 距离 1 而 `high` 距离 2）。

**用户实例**：`glm-5.3` 的警告原文 `supported: off|high|max` ⇒ **恰满足该条件**（无 low、无 medium、有 off）⇒ 落到 `off`。

**codex 梯子无此隐患**——不含 `off`，最差落到 `low`（63 个集：low 32 · medium 16 · high 8 · 上档 7）。

**可见性（实测为真）**：`lib/eng.mjs:556` 的 `warn` 收进 `warnings`；`:560` 的 `warnPrefix()` **随工具返回文本带出**（`:153` 注释逐字写明该通道）。⇒ 回落 note **会出现在返回里**（横幅位置），**不是静默丢失**。

---

## §3 ★ 父侧自我订正（留痕）

**我最初的结论是错的。** 我从**一个实例**（用户的 `off|high|max`）推出「**`low` 在含 `off` 的梯子上必然向下掉**」，并据此把 P0 定到 **🔴 / P0**。

**穷尽枚举推翻它**：只有 **25%**（4/16）落到 `off`；另 12 个落到 `low` 或 `medium`。

⇒ 两处订正：
1. **措辞**：「必然」→「**当且仅当 low 与 medium 都不被支持且 off 被支持**」；
2. **定级**：🔴 → **🟡**（它是**特定受支持集组合下的静默降级**，不是「默认值必然坏」）。

**⇒ 对修法选择的影响**：修法 **C**（把 `off` 排除出推理档的回落候选）的**真实收益面比父侧初判小得多**（只覆盖那 4/16），而代价不变（触梯子语义 + 两侧共用同一个 `nearestEffort`）⇒ **B 的性价比上升**。

**⇒ 元教训**（与批 13 同族）：**「用推理代替实测」在父侧是复发性的**——批 13 栽在「只可能误红」那句上，本批栽在「必然向下掉」上。**两次都是从一个实例推一般结论。**

---

## §4 P2a：审计 F8 遗留的根因与最小修法

`test/death-provenance.test.mjs`：

```js
:977  if (e?.code === "ENOENT") {          // 无 git：addingSha 留空（:978 注释说明是意为之）
:979  } else if (e?.status === 128 && /not a git repository/.test(...)) {   // 不在仓库内
:980    console.warn("... T-AP9 锚 A 跳过：不在 git 仓库内（" + ...)
:982  } else { throw e }
...
:992  } else {
:993    console.warn("... T-AP9 锚 A 未激活：本批新增档尚未提交（无历史提交可锚）")
```

**根因**：**两支都把 `addingSha` 留空** ⇒ **都**落到 `:992` 的 `else`。

| 情形 | 第二句 warn（`:993`） | 是否失实 |
|---|---|---|
| **无 git**（ENOENT） | 「本批新增档尚未提交」 | **对**——`:978` 注释说明这是**意为之** |
| **不在仓库内**（128） | 同上 | **失实**——真实原因是我们**无法与仓库对话**，不是「还没提交」 |

**最小修法**：`:979` 分支里置 `skippedNotRepo = true`，`:992` 的 `else` 据它**跳过第二句**（或把两句并成一句）。**一行级，零断言改动。**

**性质**：**纯输出噪音/误诊**（测试仍绿）⇒ 批 14 的 P2 级；**但它与批 13 的 F1 同族**（那条是把 `bad object` 说成「不在仓库内」）。

**★ 批 13 的一句设计判断只对了一半**：当时写「**随 F1 的收紧自然消解**」——收紧后 `bad object` 与 `path 不存在` 确实不再走这条通道，但 **not-a-repo 这条仍走**，所以第二句仍在。

---

## §5 P1：机检的落点分析

**权威侧**（判据键集）：`lib/index.mjs:177` `topAllowed` ∪ advisor 子键集（`:202-203`）∪ 组字段集（`:105`）。
**声称侧**（注释）：`cordis.patch.yml:10-14` 与 `README.md:169-172`（**两处**，批 13 已补齐）。

**谓词形态**（可照批 13 的 R-25 范式）：从两处注释**按词边界**提取键名集，与权威侧比对 ⇒ **两侧均须无缺项**。
**落点**：`test/doc-hygiene.test.mjs`（已读 `docs/README`、已有「并入既有块」先例）⇒ **不新增顶层 `test(`** ⇒ 台账 §三零改。

---

## §6 ★ 父侧在第 19 轮踩到的第 4 个同物种实例

`consultModels` 池里**混着两种条目形态**：`{provider, model, effort}` 与 **`{runner: {kind, model, effort}}`**（本机池的第 3 项就是后者）。
而 **`lib/config-store.mjs:22` 的注释把该键描述为单一形态**。⇒ **父侧按单一形态去读配置时读出了空串**（第 19 轮的假警报）。

⇒ **这是本批主题（「配置面与描述面同步」）的又一实例**，且**是父侧亲手踩到的**。**待勘察子代理与会诊确认严谨形态**（设置页校验与 UI 是否覆盖两种形态）。

---

## §7 独立勘察 `c189c415` 的结论（**已回，含对父侧六处纠错**）

> **★ 环境前置**：勘察期间 HEAD 从 `3e658f8` 移到 `e42e599`（父侧两次文档提交）。`git diff --stat 3e658f8..HEAD` **只含三份文档** ⇒ **`README.md` 与 `cordis.patch.yml` 与 `3e658f8` 逐字节相同**，故全部引用在 HEAD 有效。
> **★ EOL 事实（对修法重要）**：`README.md` 与 `lib/index.mjs` 是 **CRLF**（345 / 1236 行）；`cordis.patch.yml` 与 `lib/eng.mjs` 是 **LF**。⇒ **任何做 EOL 归一化的写入器都会重写整个文件。**

### §7.1 父侧六处纠错

| # | 父侧错在哪 | 实测结论 |
|---|---|---|
| **W1** | **交给勘察的简报里仍写着已被父侧撤回的旧结论**（「`low` 必然向下掉」） | 它**独立复算** 31 个非空集，与 §2 表**完全一致**（off 4 / low 16 / medium 8 / high 2 / max 1）；并把条件**收紧**为 `off∈S ∧ low∉S ∧ medium∉S`（`medium` 是唯一的距离-1 上邻 ⇒ **它的缺席就是全部触发条件**）。**⇒ 父侧的「给出去的简报没同步自己的订正」本身是一条流程教训** |
| **W2** | **P1 的数量低估**：父侧写「批 13 修了 **4 项**缺漏」 | **每文件缺 5 个名字 × 2 文件 = 10 处**：`contextTokens` · `standardsDoc` · `documentMapDoc` · `criteriaDoc` · **组字段 `runner`**。「4」只数了 advisor 子键。**⇒ 用法应为 5 / 10** |
| **W3** | **P2b 半错**：父侧写「`topAllowed` 无断言」 | **`topAllowed` 有断言**——`test/config-api.test.mjs:331-353`（U3c2 / D10-10）从 `lib/index.mjs` 源码字节解析它并断言 `draftToPayload` 可产生键 ⊆ 它。**真正无断言的是「文档散文面」**（README / patch.yml），**不是 `topAllowed`** |
| **W4** | **§6 引错档**：父侧引 `config-store.mjs:22` 当「单形态」证据 | 该行**对该键的条目形态零陈述**。真正的「单形态」散文在 **`lib/index.mjs:133`**：`errors.push("consultModels must be an array of { provider, model, effort? }")` —— 而**同一个函数 13 行之后（`:146-158`）就接受 `runner`** 且 codex 行**豁免 provider/model**。**⇒ 这才是真实例（代码侧错误文案 vs 接受形状）** |
| **W5** | **数字引错档**：父侧写「`path-kind` 有 26 处 `criteriaDoc`」 | 逐档实测：**`path-kind.test.mjs` = 29** · **`2026-09-15-registry-criteria-design.md` = 26**（父侧把设计档的数字安到了测试档头上）· `index.mjs` 5 · `config-store.mjs` 3 · `advisor.mjs` 3 · `advisor-msgs.mjs` 12 · `README.md` 2 · `cordis.patch.yml` 1 |
| **W6** | 可见性「过关」**基本对但漏两个例外** | 确认 `warn`（`:556`）→ `warnings`（`:558`）→ `warnPrefix()`（`:560`）→ 前置进工具文本（`:727`/`:801`/`:805`/`:859`/`:966`/`:1005`/`:1096`；且 `codex-runner.test.mjs:1091` 有断言）。**例外**：`:816` 与 `:923` 的 `if (inFlight) return inFlight` **是裸返回、无 `warnPrefix()`** ⇒ dsh 路径下 effort note **已在 `:912` push 但仍被丢弃**（`console.warn` 仍响）。**⚠ 修它会撞锁**：`doc-hygiene.test.mjs:337` 把字面串 `return inFlight` 钉在 PREFLIGHT 列表（`:372-375` 要求它可定位）⇒ 改写会令该字面消失 ⇒ V7 红 ⇒ **任何此类修法必须同批扩 PREFLIGHT needles** |

### §7.2 P0 的四问答案

- **(a)** 见 W1；反例（推翻「必然」）：`[off|low]→low` · `[off|medium]→medium`（距离-1 等距，向上取生效）· `[off|low|high|max]→low` · `[off|low|medium|high|max]→low`。
- **(b)** **codex 梯子无向下隐患**（`requested=low` 时 63 个子集**零**向下）：low 32 / medium 16 / high 8 / xhigh 4 / max 2 / ultra 1。**但另有一个不相关隐患**：只有 `off` 被特判成 null（`:124`），而 **codex 独有档（`xhigh`/`ultra`）无法经配置请求**——`index.mjs` 对每个用户可见 effort 校验 `EFFORT_LEVELS`（`advisor.mjs:373`）。
- **(c)** 可见性 TRUE（例外见 W6）。
- **(d)** `low` 作为默认**只有一处代码**（`eng.mjs:752`；`:759-760` 只在**警告字符串**里重复它，`else` 分支**不赋值**，故值仍是 `:752` 的初值）。**advisor 侧零默认**（`advisor.mjs:680`「缺省不传，用适配器默认」；`:795` 渲染 `effort: (not set — adapter default)`；只有 `timeoutMs` 有逐轮默认）。**散文本有六处**（父侧只列两处）：`README.md:227` · `cordis.patch.yml:43` · `docs/2026-09-01-advisor-config-design.md:102` 与 `:212` · **`lib/eng.mjs:734`（内部注释）** · **部署 profile 自己的 `cordis.patch.yml`（仓外）**。

### §7.3 ★★ 隐形锁：默认值与回落目标**都被测试钉死**

| 处 | 断言 | 钉的是什么 |
|---|---|---|
| `test/advisor-config.test.mjs:485-487` | `assert.equal(started2[0].agentOptions.reasoningEffort, "low")` | **默认值** |
| 同档 `:494-499` | 配置 `{ engCoderMaxTokens: "abc", engCoderEffort: "turbo" }` ⇒ 同断言 | **非法值的回落目标** |
| `codex-runner.test.mjs:889-890` | `b.effort === "off"`，注「历史事故 low 对 [off,high,max] → off」 | 回落语义 |
| 同档 `:975` / `:1090` / `:1146` | 同上（`:1090` 配置 `{engCoderEffort:"low"}`） | 回落语义（共四次） |

> **★★ 关键**：**`test/advisor-config.test.mjs` 是基线档、且不在 `AP_TEST_AUTHORIZED`** ⇒ **改默认值 ⇒ 必须把该档加进 `AP_TEST_AUTHORIZED`**（该列表的注释明写「扩列表不触发锚 B」）⇒ **而这个锁从 `lib/` 里完全看不见**。**这正是设计档必须显式声明的锁面变更。**
> **另**：非法值的**警告文本**无锁（只有 `:497` 的 `includes("[thincoder-suite] warning:")`），但**得出的值有锁**；**文档里「缺省 low」那句话无任何断言**。

### §7.4 ★ P0 是「今天就影响用户」还是「新部署才中招」

**本部署不受影响**（实测）：用户层 `config.json` 有 `"engCoderEffort": "high"` ⇒ `mergeGlobalConfig`（`config-store.mjs:321-323`）覆盖 base ⇒ **生效值 = `high`**。
**但新部署会中招**，而且**不是靠「代码默认」中招，是靠「示例配置」中招**：`eng.mjs:752` 只在**两层都没设**时生效，而**出厂的 base（`cordis.patch.yml:43`）就设了 `low`**，部署 profile 的 patch 也设了 `low`。
**按部署的模型梯队实测**（`profile/settings.yaml`）：`zai-coding-cn/glm-5.3-flash` 与 `glm-5.3-highspeed` = **`off|high|max`**（**正是向下形状**）· `fangzhou-codingplan/deepseek-v4-*-ga` 与**全部 `kimi-api` 模型**也是 `off|high|max` · 内置 `deepseek-official` 的 `REASONING_EFFORTS` = `off|low|high|MAX`（**无 medium**，故**恒支持 low**，不受影响）。
⇒ **结论**：**一个新部署，若父模型是上面任一 `off|high|max` 模型，且从 base 示例拿到 `low` ⇒ 第一次 eng_coder 调用就落到 `off` = 推理全关。**

### §7.5 P1 的权威面与落点

**三处权威**（须一致）：`index.mjs:177` `topAllowed` = 8 名 · `:202-203` advisor 子键 = 8 名 · 组字段 = 5 名（PUT 侧 `index.mjs:105` 与 merge 侧 `config-store.mjs:153` 的 `GROUP_FIELDS` **实测完全相同**）⇒ **权威面共 21 名**。
**散文面**：`cordis.patch.yml:10-16` 与 `README.md:169-173`。**批 13 各修 5 名（W2）**；**当前三轴零缺项、零多余**。
**落点建议**：**`test/config-api.test.mjs`**（**已在 `AP_TEST_AUTHORIZED`**、且 `:335-338` **已在解析 `lib/index.mjs` 源码字节** ⇒ 无需新授权、不撞台账）；次选 `doc-hygiene.test.mjs`。
**两条我测出的设计约束**：散文里 **`advisor.` 前缀名与裸名混用**；且 **`README.md` 是 CRLF** ⇒ **提取器必须做 EOL 归一化并接受两种拼写**，否则要么恒真、要么误红。

### §7.6 同物种的其余实例（实测）

| # | 处 | 分裂 |
|---|---|---|
| **6.1** | `codexCli.defaultTimeoutMs` **三方分裂** | `README.md:235`「缺省 600s」· adapter 常量 `CODEX_DEFAULT_TIMEOUT_MS = 600000`（`codex-adapter.mjs:39`）· escalate 保留 600000（`escalate.mjs:134`）· **但 eng_coder 的 codex 路径未设时用 `1800000`**（`eng.mjs:794`，意图见 `:791`「长任务默认放大 30min」）⇒ **同一字段、一处文档默认值、两个不同生效默认值** |
| **6.2** | `README.md:227` / `cordis.patch.yml:43`「非法值忽略并警告」 | 那是 **advisor 行**的语义（`README.md:252` 准确）；**对 `engCoderEffort` 不成立**——`eng.mjs:758-761` 把它**替换成显式 `"low"`** 并转发给子代理（**且那是初值、不是适配器默认**）⇒ **同一句话、两套机制** |
| **6.3** | `index.mjs:133` 错误文案 vs `:146-158` 接受形状 | 见 W4 |
| **6.4** | **同一份设置数据产出两个不同的受支持档集** | `index.mjs:635-641` 的 `effortsOf` 用 `!== null` **剔掉 `off: null`**（断言：`codex-runner.test.mjs:786` `assert.deepEqual(glm.efforts, ["low","medium","high"])`）⇒ **设置面说 `{high,max}`，运行时面说 `{off,high,max}`**——**而只有运行时面驱动产生了向下回落的那个回退** |
| **6.5** | `lib/eng.mjs:734` 注释 | P0 断言的**第二份代码内副本**，必须随默认值同改 |

**勘察确认 CLEAN 的两项**（不必再花预算）：`advisor_config` 的工具描述（`index.mjs:884-887`）与可设路径面（`:426`）及 `validateAdvisorGroup` 的组字段（`:105`）**一致**；其余 README 默认值断言**实测成立**（`engCoderMaxTokens` 65536 · `maxConcurrent` 8 · `idleTimeoutMs` 300000 · `dshBackgroundTimeoutMs` 1800000 / 60000..3600000 · round1/convergence 超时 600000/300000）。**未测**：`README.md:236` 的 `budgetCapMs` 「缺省 540s」——**按未测对待，不当作已确认**。

### §7.7 爆炸半径与锁（逐条实测）

**并集改动面**：P0 ⇒ `lib/eng.mjs:752`（+`:734`）· `README.md:227` · `cordis.patch.yml:43` · `docs/2026-09-01-advisor-config-design.md:102/:212` · **部署 profile 的 `cordis.patch.yml`（仓外）** · 测试 `advisor-config.test.mjs:487/:499`（**+ `AP_TEST_AUTHORIZED` 行**）；若选修法 (iii)/(iv) 则加 `codex-runner.test.mjs:890/:975/:1090/:1146`。**P1/P2b** ⇒ 折叠一条断言进既有档，**零生产文件改动**。**P2a** ⇒ 只动 `death-provenance.test.mjs:979/:992-995`。

**锁逐条**：
- **基线 10 档**：今日 `git diff --diff-filter=MD 2e6ca8b -- test` = `codex-runner` / `config-api` / `design-review-guard` —— **恰是 `AP_TEST_AUTHORIZED` 三项**。**⚠ 改 `advisor-config.test.mjs`（基线档、不在列表）⇒ T-AP9 锚 B 红**，除非同批加进列表。**改 `death-provenance.test.mjs` 本身安全**（基线外；其注释 `:950-952` 明说列表住在基线外）。
- **T-E19 清单**（`guard-e.test.mjs:755` `const existing = [`）与 fs 测试档集 deepEqual（`test-lifecycle.test.mjs:138-168`）：**20 == 20** ⇒ **新增档要动三处**；**折叠进既有档则全不动**（批 9 先例，`test-lifecycle.md` §三）。
- **台账逐档计数**：T-LC2（`test-lifecycle.test.mjs:110-123`）——**不是「不许改」而是「必须同步改」**；另 `ledger-parity.test.mjs:32-33` 钉住缺陷登记表与吸收清单的计数，**勿动**。
- **六串锁**（`path-kind.test.mjs:639-666`）与 **`doc-hygiene` V5**（`:222-244`）：扫描域 = `lib/**`（+ 批 11 点名的 5 档）⇒ **`README.md` / `cordis.patch.yml` 不在域内，P0/P1 的散文改动安全**；但若新散文落进 `lib/**`，注意 `methodology`（**大小写不敏感**）。
- **`failStop(` 计数锁**（`doc-hygiene.test.mjs:362`，== 18，16 个 needles + PREFLIGHT 白名单含字面 `return inFlight`）：**P0 不碰失败返回点 ⇒ 不撞**；**W6 的可见性修法会撞**（须同批更新 needle）。
- **U+FFFD 扫描**（`doc-hygiene.test.mjs:77-96`）覆盖根层文本档 ⇒ 改 `README.md` **须保 CRLF**。
- **发布门**：P1/P2a/P2b 与 P0 的**断言值**改动**都不动用例计数** ⇒ **CHANGELOG 计数行不必移**；只有增删用例数才触发 G3。

**勘察的推荐形状**：**修默认值（`:752` + 四处散文副本），不修 `nearestEffort`**——它是四种形状里**唯一伤害面真实**（本部署模型集）的，而 tie-break / 方向语义**挂着四条已钉断言**。**无论选哪个，设计档都必须显式声明 `advisor-config.test.mjs` 这个从 `lib/` 看不见的锁。**

---

## §8 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-15 | 首版（摸底，未开工）：§1 四项范围 · §2 P0 机制与**穷尽枚举** · **§3 父侧自我订正（🔴→🟡，「必然」→ 精确条件）** · §4 F8 根因与一行级修法 · §5 P1 落点 · §6 第 4 个同物种实例 · §7 待勘察问题 |
| 2026-09-15 | **独立勘察 `c189c415` 回填**：§7.1 **父侧六处纠错（W1–W6）**（含「父侧交给勘察的简报没同步自己的订正」这条流程教训）· §7.2 四问答案 · **§7.3 ★★ 隐形锁**（默认值与回落目标都被 `advisor-config.test.mjs:487/:499` 钉死，而该档在基线内且不在授权面）· **§7.4 本部署不受影响但新部署首调即中招**（`off\|high\|max` 模型清单实测）· §7.5 权威面 21 名与落点 · **§7.6 另五处同物种**（含 `defaultTimeoutMs` 三方分裂 · 设置面与运行时面产出**两个不同**受支持集）· §7.7 爆炸半径与锁逐条 |
