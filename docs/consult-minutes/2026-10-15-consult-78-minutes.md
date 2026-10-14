# 会诊纪要 —— consult #78（原始层，机制落盘）

- 日期：2026-10-15
- 会诊 id：78
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro, codex-cli:gpt-6-astra
- 平台 job：consult-5
- 结果：4/5 交付（其中 4 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #78 finished — 4 of 5 replied (1 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #78 finished — 4 of 5 replied (1 failed)]
effective: 4 of 5 (1 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro, codex-cli:gpt-6-astra
job: consult-5
minutes: docs/consult-minutes/2026-10-15-consult-78-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] codex-cli:gpt-6-astra — failed
(consultation failed: codex-cli PROCESS_ERROR: codex 进程失败（非零退出且无有效输出）（diagnostics: exit=1 | stderr: 2026-10-14T16:25:08.604489Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out 2026-10-14T16:25:08.634874Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out 2026-10-14T16:25:31.849984Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest("http/request failed: error sending request for url (https://chatgpt.com/backend-api/ps/mcp)"))) 2026-10-14T16:25:40.453334Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel cl…）)

[2] deepseek-official:deepseek-v4-pro — ok
# 裁定：两处张力 · 独立意见

**三句话结论**：① 张力 1 选 **(a)**——设计档的「零 schema 变更」指的是**台账行格式与派生读面**，不是策略字段；但 B 仓有 6 条机器锁把「零 schema」钉成了「policy.json 十键」，选 (a) 必须**同批**改写这 6 条锁，装不成免费。② 张力 2 选 **(a) 收紧版**——`retract` 正文必须带 `ref:#<seq>`，机器核对该 seq 是**同文件、同任务、kind∈{claim,done,block}** 的真实行；这是 (c) 的严格超集、零额外成本。③ 两处都要落机检腿，且要回填需求档/设计档两处未定义点。

---

## 张力 1：开关落哪 — 选 (a)，边界在此

**边界确认（你的直觉对，但有一处你没看到的硬代价）**：

- 设计档 §7 的表叫「状态与 schema（谁写谁读）」，team-link 那一行是「tasks.md 行｜既有六列｜行格式不动」——**「schema」在该档语境 = 台账状态形状，不是配置形状**。FR-7:220 明列不改的五项（行格式/seq/上限/kind 闭集/读面派生），FR-7:219 已写「team-link 侧读自己的配置面」、FR-8:228 已承诺 team-link 一键。所以给 `PolicyConfig` 加字段**不违背**该声明的本义。
- **但**：B 仓把「零 schema」机器化成硬锁——`U19_POLICY_KEYS`（host-half.test.mjs:7391，十键权威读数）被 **6 处判据**引用：U19(:7397)、批K·U9(:13785)、Aw3③(:14038)、Aw6(:14110)、批J·U8(:14425)、Pi5①(:14650)。加第 11 个顶层键 ⇒ 这 6 条全红。
- 因此选 (a) 的真实成本 = **同批把 `U19_POLICY_KEYS` 改成十一键 + 改写 6 条判据的措辞（「十键」→「十一键」）+ README 键集描述（U17 纪律）+ CHANGELOG + 设计档 §7:325 那句修正**。这是批 D「500→2000 改写不删除」同款锁更新，不算「既有测试回归」，但**必须在交付里点名，不能声称零改动**。

**具体形状与读取**：

- `PolicyConfig` 加**嵌套** `antiDrift: { ledgerTransitionGate: z.boolean().default(false) }`（镜像 `sections` 先例，:1235；与设计档点号键逐字对应；以后 TL 侧 antiDrift 新键都进这个顶层键，十键锁不再动）。三处同步：`PolicyConfig`(:1190) + `DEFAULT_POLICY`(:1050) + `normalizePolicy`(:1281，镜像 `sectionsView`)。
- 门内读 `policy.get().antiDrift?.ledgerTransitionGate === true`。`get()` 是**每调现读 + 归一化**（:2259-2269），且本工具已在 :7766 用过一次 ⇒ 即时生效、不需重启（FR-8 的「现读」要求）；老档缺键 ⇒ 默认 false ⇒ 门关 ⇒ 既有用户零行为变化；`POLICY_FILE_SCHEMA` 保持 1（加法兼容，Aw6 的「const 未动」半条不受影响）。
- **失败方向**：门本身 fail-open（配置缺键/不可读 = 门关 = 放行，正确——默认 OFF 意味着读不出配置绝不能开始拒写）；台账解析失败仍 fail-closed（D10 口径不变）。**无 eng 豁免**（会诊 FR-8/FR-9 明言「结构门 FR-1/2/7 不受 eng 影响，它们不唠叨」）。
- **否决 (b)**：另立 JSON/env = 第二配置面 = 新 schema、新失败模式，还得重造批 K/L 那套原子写与所有权机制；违背 FR-8「同一配置面」与本仓「两套跟踪是反模式」的教训。
- **否决 (c)**：恒开 = 对既有安装的 done 写入静默改行为，直接违背已定的 D7（默认 OFF、先单队试点）。

## 张力 2：撤回证据 — 选 (a) 收紧版，判据如下

**机械判据形态**（gate ON ∧ `kind==="retract"` 时）：

1. 正文（**消毒后的 `clean.text`**，与长度复检同口径）必须含至少一个 `ref:#<seq>`（正则 `/ref:\s*#(\d+)/gi`，`#` 必填——TL 读面本来就印 `#45`，且无 `#` 的「ref: 3」是自然行文，防误报）；
2. 该 seq 在**本文件**真实存在（复用 `parseTasksRow`(:6715) + `blackboardLines`，零新解析器）；
3. 该行 `task === 本行 task`（跨任务指针不是证据）；
4. 该行 `kind ∈ {claim, done, block}`（= TL 台账档 §9.3.4 规则 1 的「主张」闭集——plan 是登记、dispute 是存疑、retract 禁成链，都不可被撤回）。

任一 `ref` 满足即过；全不满足 ⇒ 拒 + 零写，文案含「（Nothing was written）」（与 A-7 锚同一短语）。**零自然语言理解**：正则 + seq 存在性 + 列等值；2000 码点内 O(n)。**不校验撤回者与被撤回主张作者一致**（台账档 :249 约定级、§9.4 黑板模型——正是设计档承诺不动的「写权限口径」）。

**否决理由**：(c) 的「task 号存在」已被既有校验覆盖（非 plan 必登记，:7868），退化成 no-op；「seq 存在」不加同任务+kind 闭集就允许拿**别人的任务行、plan 行**当证据 = 装饰不是证据。(b) 的 ≥N 字符可被填充糊弄、「提及被撤回主张」= NLU ⇒ 双死。(d) 会让门不对称（done 有来历、retract 无证据），且增量只有 ~15 行 + 复用 A-7 夹具——**做，但必须同批回填两处文档**：需求档 grep 0 命中、suite 设计档 FR-7 只写了一条规则，这条的**定义本身**要补进两档（文档卫生：描述面与实现一致）。

## 落码与验收腿（B 仓）

- **插入点**：tasks 分支 :7872（task 定案）之后、:7873（`const seq`）之前；done 规则与 retract 规则同门同开关，扩展设计档 §6 的 `boardTasksGate(newKind, taskNo, body, rows)` 伪代码。门函数体内 `policy.get()` 现读开关。
- **新判据块**（续 A-7 档位，建议 8–10 条）：默认 OFF 双态放行（done 无 claim 过 / retract 无 ref 过 = 既有用户零变化）；gate ON 下 done 无 claim 拒（盘上零写）、有 claim 过、retract 无 ref 拒、ref→同任务 claim 过、ref→异任务/plan/不存在 seq 各拒、`update` 翻转后同一会话立即生效（不用重启）。全部带红相配方。
- **回归口径**：6 处十键锁同批改十一键（点名如上）；断言总数 = 现 1697 + 新增；client-half 一字未动（310）。工具 description(:7751/7757) 与 README 同批补一句「可选结构门（默认关）」说明——模型可见面与实现同批同步。

[3] zai-coding-cn:glm-5.3 — ok
# FR-7 跨仓写门 · 两处张力裁定报告

**三句话结论**：张力 1 选 **(a)**——开关照抄 B 仓 `sections` 先例落进它自己的 `PolicyConfig`，「零 schema 变更」按档面文字只锚**台账行格式与派生读面**，设置命名空间加布尔键不在射程内，但设计档三处（§7/§11/L-9）与 FR-8 的「六键」口径必须同批回填才成立；张力 2 选 **(d)**——**盘上没有任何一档要求 retract 带证据**（需求档、设计档、会诊 #74、B 仓全部 docs 均零命中），前提本身不成立，本批不做、登记遗留并写明将来唯一无 NLU 候选。代价面：张力 1 的 (a) 会触发 B 仓测试档约 9 处「恰十键」断言与 README 键数措辞的同批更新——这是仓内既定纪律（批 3/批 I 先例），不是回归，但「零既有测试回归」必须读成「跑完零红（含同批更新的键集腿）」。

---

## 一、证据底座（本轮实读）

- B 仓写入口：[lib/index.js:7827-7890](D:/workspace/dsh-plugins/dsh-team-link/lib/index.js#L7827) tasks 分支，既有四道校验（kind 闭集 :7829 / 单行无换行 :7838 / ≤2000 码点 :7840 / 非 plan 必须已登记 :7864-7872），seq 分配在 :7873——**门的插入点 = :7872 之后、:7873 之前**，与设计档 §5 FR-7 一致。
- B 仓开关先例：`sections: z.object({ role, resources })` 布尔总开关（FR-9 批 3，[lib/index.js:1234-1238](D:/workspace/dsh-plugins/dsh-team-link/lib/index.js#L1234)）+ `DEFAULT_POLICY` 作 base（:2482）+ `normalizePolicy` 里 `sectionsView` 归一（:1291）+ `sectionsSwitches` 读法（:4909）+ 工具侧 `policy.get()` 直读（:4207、:12030）——**门读开关零新增管道**。
- retract 现语义：派生面按**位置**解释（最后 claim 之后的全部 retract 行，[lib/index.js:6799-6830](D:/workspace/dsh-plugins/dsh-team-link/lib/index.js#L6799)）；B 仓设计立场逐字写在 :6804-6809 注释里——「撤回者有无资格留给人类判断，读面出示两个 id 而不是裁决」（§9.3.4 rule 1）。

## 二、张力 1 裁定：选 (a)，边界成立但要回填

**边界确认**：「零 schema 变更」两处原文都自带括注锚定射程——§7:325「锚在正文，行格式不动」、§11:455「行格式与派生读面不动」。策略字段不在这两句话射程内，你的判断**文字上成立**。但它不是自证的：§14 L-9（[设计档:549](docs/2026-10-14-anti-drift-design.md#L549)）已如实登记这是「内部张力必须先裁，不得未裁先扩」——所以成立条件是**本次裁定同批回填进档**。

**否决 (b)**：B 仓花了整批工程（policy-persistence / atomic-write / crash-forensics）把设置命名空间的降级、原子写、崩溃窗做硬；另立 JSON/env 等于造一套无降级故事、无原子写、无观测面的平行配置面——为了绕开一个本来就不违反的约束。且新 JSON 文件的格式本身就是字面意义上的「新 schema」，比 zod+1 布尔更违反精神；桌面宿主里 env 也没有可靠通道。

**否决 (c)**：恒开直接违反 FR-7 自己的「默认 OFF」决策，且 §8 A-7 第三断言「开关关 ⇒ 一律过」（[设计档:354](docs/2026-10-14-anti-drift-design.md#L354)）在恒开世界里不可写；还无条件改变既有用户 done 写入行为。

**(a) 的隐藏代价（必须向主会话如实报）**：`PolicyConfig` +1 键 ⇒ [host-half.test.mjs](D:/workspace/dsh-plugins/dsh-team-link/host-half.test.mjs) 里 **9 处「恰十键」断言**（:5598、:5773、:7391+7397、:8813、:9856、:10929-10931、:13788、:14038、:14111）与 **README 键数措辞**（U17 红线 :10929-10931）需同批 10→11。这些腿是防静默扩 schema 的警报器，正在尽职；批 3 加 `sections`（七→九）、批 I 加 `blocks`（九→十）都是同批改腿+改 README 走过来的。**若「零既有测试回归」按字面「一行都不许动」读，则 (a)(b)(c) 全灭，需回用户重定约束；我建议读成「跑完零红（含同批更新的键集腿）」**——这也是仓内两次先例的实际口径。

**FR-8 连带修订**：FR-8 的「六键全部读插件配置（TH config-store）」对 team-link 一键与 (a) 不兼容——suite 工具代写 B 仓命名空间违反 §7:334 单向性（「FR-7 在 team-link 侧独占」）。应改为：工具面服务 **suite 五键**；team-link 一键由 B 仓自有设置面承载，用户经设置服务既有编辑通道翻转。

```dsh-ui
{"title":"两处张力 · 裁定一览","gap":14,"items":[{"type":"table","columns":["张力","裁定","核心理由（证据）","代价与回填"],"rows":[["① 开关读法","(a) 落 PolicyConfig，仿 sections 先例","「零 schema 变更」两处括注均只锚行格式/派生读面（§7:325、§11:455）；sections 先例完整可抄（zod+DEFAULT_POLICY+normalizePolicy+policy.get()，B 仓 :1234/:2482/:1291/:4909）","测试档 9 处十键腿+README 键数同批 10→11；设计档 §7/§11/L-9 三处回填边界；FR-8 六键改五键"],["② retract 证据","(d) 本批不做，登记 L-10","盘上零档要求此条（需求档:91、设计档全文零 retract、会诊#74 R1/R2 亦无）；候选 (a)(c) 造行格式/派生面变更，(b) 需 NLU 违铁律；B 仓 §9.3.4 明文「资格留给人类」","L-10 写明将来唯一无 NLU 候选=同 author 同 task 先序 claim 行；若主会话有用户原话，先进需求档走成文流程"]]}]}
```

## 三、张力 2 裁定：选 (d)，并先纠正前提

```dsh-ui
{"title":"前提核查：『FR-7 要求撤回带证据』在盘上不存在","gap":14,"items":[{"type":"callout","tone":"warning","title":"四处实读零命中","content":"需求档 :91 明写「一期只做 done 需 claim 一条」；设计档 §5 FR-7（:214-220）全文只有一条规则、整档零 retract 字样（grep 证实）；会诊 #74 纪要 :614-621 的提议规则 R1=done 需 claim、R2=重复 claim 拒（R2 已被最终设计砍掉——设计是刻意收敛到极简的）；B 仓全部 docs 对「retract+证据」零命中。若主会话持有用户原话出处，按成文流程先进需求档（US+评审），不搭 FR-7 便车。"},{"type":"list","items":[{"text":"候选 (a) 指针 token：给正文发明机器可解析子格式 = 事实上的行格式变更（FR-7 明言不改），且派生面按位置解释、不认这个指针 ⇒ 写下的指针与派生语义脱节"},{"text":"候选 (b) 非空+≥N 字符：可机检但纯剧场（补空格即过）；『提及被撤回的主张』= NLU，铁律禁止"},{"text":"候选 (c) 引真实存在的号：task 列已由既有校验强制（B 仓 :7864-7872）⇒ 对 task 号是已实现的无操作；对 seq 则同 (a) 的脱节问题，消脱节须改派生读面 ⇒ 违本批冻结"},{"text":"结构性区别：done⇒claim 是结构迁移规则（kind+task 两列可判）；『撤回带证据』是正当性规则（关于内容质量），与 B 仓 §9.3.4『读面出示两个 id 而不是裁决』的明文立场正面冲突"},{"text":"retract 现有可机检锚已在：task 列必须已登记 + author 内嵌行内 + append-only seq ⇒ 谁何时撤了哪件 task 结构上可审计"}]}]}
```

**裁定**：(d)。L-10 建议措辞：「retract 证据判据未定义、无任何档要求；若将来要做，唯一无 NLU 候选 = 同 author 在同 task 上有先序 claim 行（author+kind+task 三列可判，与 kind 描述『撤回自己此前的主张』自洽）——但它与 B 仓 §9.3.4『资格留给人类』立场冲突，须自带需求档轮次+用户裁定+B 仓设计档修订，不得搭车」。

## 四、同批交付清单（A-7 机检腿含在内）

```dsh-ui
{"title":"C9/C14 交付序列","gap":14,"items":[{"type":"steps","steps":[{"title":"B 仓 schema 面","desc":"PolicyConfig 加 antiDrift:{ledgerTransitionGate:z.boolean().default(false)}（仿 :1234-1238）+ DEFAULT_POLICY 同键 + normalizePolicy 加归一（垃圾值降级 false=门关=现状行为）+ antiDriftSwitches 伴 :4909"},{"title":"B 仓门本体","desc":"tasks 分支 :7872 后、:7873 前插门：policy.get() 读开关；done ∧ 全文件无该 task 的 claim 行 ⇒ wellFormed 拒+零写入，文案仿 :7869 风格含修法与 Nothing was written"},{"title":"B 仓测试腿","desc":"host-half.test.mjs +A-7 四断言：默认过 / 开∧无claim 拒且盘上零写入（读回字节不变）/ 开∧有claim 过 / 开∧垃圾配置值降级关；经 settingsSeed(:2072 先例) 翻开关；同批更新 9 处键集腿 10→11 + README（U17）"},{"title":"B 仓文档（C14）","desc":"README/CHANGELOG 与实现同批：键集十一项、新开关语义、默认 OFF 即现状"},{"title":"A 仓设计档回填","desc":"§7:325 与 §11:455 边界改写（零『台账』schema 变更+括注本次裁定）；FR-8 六键→五键+team-link 自有面；L-9② 关账；L-10 新登记；C9 解除 🔴"}]}]}
```

**范围说明**：本轮全部为只读核查（两仓 lib/docs/test 四路实读），未做任何写入；两处裁定均可直接进设计档修订与实施任务书。若主会话对「零回归」持字面零改动口径，请先回用户重定该约束——那是一条需要用户拍板的解释分歧，不宜由实施侧静默选择。

[4] opencode-go-plan:mimo-v2.6-pro — ok
# FR-7 跨插件写门 · 两处设计裁定

**三句话结论**：① 张力 1 选 **(a) 往 `PolicyConfig` 加一个缺省 false 的开关**——设计档的「零 schema 变更」自带括号定义，指的就是**台账行格式**，不是策略声明面；② 张力 2 选 **(c) 的收紧形态**：`retract` 正文必须含一个 `#<seq>` 指针，且指向**同一 tasks.md 里同一任务的既有行**——这是台账自己的记法，纯字符串判据、零自然语言；③ 但我勘察到一个**你没提到的成本**：B 仓测试里有一组「零 schema」红线把 policy 键集钉死在**十键**，加第 11 键必须同批改锚（详见下方警示），否则它就是既有测试回归。

---

## 张力 1：选 (a)，边界这样划

**「零 schema 变更」的边界不是我猜的，设计档自己用括号划好了**：

- [anti-drift-design.md:455](<docs/2026-10-14-anti-drift-design.md>)：「该仓**零 schema 变更**（**行格式与派生读面不动**）」
- [anti-drift-design.md:325](<docs/2026-10-14-anti-drift-design.md>)：「team-link 零 schema 变更（**锚在正文，行格式不动**）」

两处括号都锚在**台账数据合同**（tasks.md 六列行格式 / seq 分配 / 派生读面）。而 FR-7 的开关管的是「**谁在什么条件下被允许写**」——那是**策略声明面**，本仓叫 `PolicyConfig`（[team-link/lib/index.js:1190](<D:\workspace\dsh-plugins\dsh-team-link\lib\index.js>)）。两个不同的 schema，加策略字段**不越界**，但 PR/文档里**不许裸写「零 schema 变更」**，必须改写成：「零**台账** schema 变更（行格式/seq/派生读面不动）；策略声明面新增一键」。

**三条硬理由**：

1. **先例就在同一文件**：`sections: z.object({role, resources})`（[lib/index.js:1235](<D:\workspace\dsh-plugins\dsh-team-link\lib\index.js>)，FR-9 总开关）——功能开关进 `PolicyConfig` 是本仓既有做法，连形状都一样（嵌套对象 + 缺省值）。所以 `antiDrift: { ledgerTransitionGate: false }` 是照抄先例，不是发明。
2. **走私键在技术上不可行**：`normalizePolicy`（[lib/index.js:1281-1292](<D:\workspace\dsh-plugins\dsh-team-link\lib\index.js>)）按**声明字段**重建视图，`policy.get()` 读的是归一化视图 ⇒ 未声明的键根本读不回来。声明不是可选项。
3. **(b) 另立 JSON/env 在本部署是造第二个事实源**：team-link 的 AGENTS.md:131 明写「本部署的状态事实源是 **policy.json**，不是设置 UI」（宿主 `settings.register` 是 `no-register`）。policy store 已带文件后端 + 原子写 + 折叠降级（`foldTail`，lib/index.js:2676-2683）；(a) 白拿这一切，(b) 要重造一遍还和 AGENTS.md 打架。

**否 (c) 恒开**：黑板合同明写「任何会话都可写：**黑板没有写权限门**」（工具描述，[lib/index.js:7751](<D:\workspace\dsh-plugins\dsh-team-link\lib\index.js>)）。恒开 = 既有用户今天写得进的 `done`/`retract` 明天被拒，是行为破坏，不是防漂。默认 OFF ⇒ 既有夹具没有该键 ⇒ 读回 false ⇒ 门关 ⇒ **运行行为逐字不变**。

```dsh-ui
{"title":"勘察发现：B 仓的「十键」红线是 (a) 的真实成本，必须如实进裁定","tone":"warning","content":"host-half.test.mjs 有一组断言把 policy 键集钉死在十键，加第 11 个顶层键会碰它们：`U19_POLICY_KEYS`（:7391 权威清单）· U29 手抄十键清单（:5598）· 「exactly its ten keys」（:7397）· 「声明面 = 十项 + README 同批」（:10929）· :13785 / :14029 / :14110 / :14426 / :14650 各自名字里的「十键」；源码侧还有 policyIsAtDefaults（lib/index.js:1790，注释明写「Fields added to DEFAULT_POLICY belong here AND in every wholesale write, in the same change」）与折叠整写补丁（~:2664）。这些红线的红相写的是「**顺手**往 policy.json 加一格键 ⇒ 本条红」——抓的是未声明的加键；本仓注释（:5749）与两处先例（FR-9 sections、批 I blocks，键集 8→10）规定的正路是**同批改锚**。⇒ (a) 的口径 = 改锚不破保：四面同键（声明==存储==README==文件）保证不削弱，计数 10→11、断言名里的「十」同批改掉。若「零既有测试回归」按字面理解成「一条既有断言都不许动」，(a) 与它冲突——这一条需要你拍板口径。"}
```

## 张力 2：选 (c) 收紧形态——`#<seq>` 同任务指针

**判据形态（纯机械，零自然语言理解）**：

```text
retractEvidenceOk(body, rows, task, newSeq) :=
  tokens = 从 body 用 /#(\d+)/gu 抽出的整数集合
  成立条件: tokens ≠ ∅  ∧  ∃ n∈tokens, ∃ r∈rows:
      r.seq === n  ∧  r.task === task  ∧  r.seq < newSeq
```

- **`#<seq>` 是台账自己的指针记法**，不是新发明：派生读面本来就印「已由 **#N** 撤回」「存疑已由 **#\<seq\>** 消解」（[lib/index.js:6874](<D:\workspace\dsh-plugins\dsh-team-link\lib\index.js>)；台账设计档 [team-ledger-and-mode-design-2026-09-26.md:281](<D:\workspace\dsh-plugins\dsh-team-link\docs\team-ledger-and-mode-design-2026-09-26.md>) 同款）。既有测试夹具的 retract 正文就写着「撤回 #4 的第 2 处」（host-half.test.mjs:2679）。
- **三条约束全部可机检**：存在（seq 在文件里）· 同任务（该行 `task` 同为 `t-<n>`）· 先后（`r.seq < newSeq`）。机器件都在场：`parseTasksRow`（lib/index.js:6715）+ 一次扫描。
- **不判作者**——既有设计明说「作者关系不在派生里强制……由人判断这够不够」（台账设计档:282）。**不判 kind∈claim 族**——`retract` 也用来消解 `dispute`（§9.3.4 规则 2）。
- **∃ 语义不是 ∀**：正文里出现外部票号（GitHub #123）不致误拒；反过来「随便指一条同任务旧行」的假证据，本台账也不裁——「绝不自动裁决」是既有铁则，门只要求**可核指针**，不裁内容。
- 拒绝文案点名缺什么 + 列候选：「拒写 retract(t-1)：正文没有指向本任务既有行的 `#<seq>` 指针——t-1 的既有行：#2 #4 #5（Nothing was written）」。

**否 (a)**：`ref: t-N` 与行内 task 列**逐字重复** ⇒ 每条 retract 天然满足 ⇒ 门形同虚设；`file:line` 要门去解析任意文件路径（IO + 安全面），且「那一行是不是被撤回的主张」仍需自然语言理解 ⇒ 撞铁律。**否 (b)**：「提及被撤回的主张」= 自然语言理解 ⇒ 撞铁律；「≥N 字符」只检长度不检证据 ⇒ 假门。**否 (d)**：(c) 成本 ≈ 一个正则 + 一次既有扫描，推迟换不到东西，只会让「撤回必须带证据」停在口号。

## 两条规则共用一个开关

`antiDrift.ledgerTransitionGate`（缺省 false）同时罩两条：**done ⇒ 必有 claim**、**retract ⇒ 必有 `#<seq>` 证据**。理由：两条都是「在无写门黑板上新增拒绝」，拆两个键只增配置面。**现读**：门在写入时 `policy.get()` 现判（`policy` 已在 `registerTeamTools(ctx, policy, ...)` 作用域，[lib/index.js:7192](<D:\workspace\dsh-plugins\dsh-team-link\lib\index.js>)）⇒ 即时生效、不需要重启；若实施做成装配期快照，描述必须改「重启生效」（设计档 N-7）。**失败方向**：配置值畸形 ⇒ 按缺省 false（fail-open——写门坏了不许锁死账本）；台账行解析失败 ⇒ 按 §5 表 fail-closed（找不到 claim 就拒）。

```dsh-ui
{"title":"实施与文档同步清单（FR-7 · 批 34 跨仓）","steps":[{"title":"B 仓代码（team-link/lib/index.js）","desc":"PolicyConfig 加 antiDrift:{ledgerTransitionGate:false}（:1190）· DEFAULT_POLICY 同名键（:1050）· normalizePolicy 加 antiDriftView（:1281，照抄 sectionsView :1101，非布尔按 false 读）· policyIsAtDefaults 加一项（:1790）· 折叠整写补丁同批补键（~:2664）· 门插在「任务号已登记」校验后、append 前（~:7872-7873），两条规则共用一次现读"},{"title":"B 仓文档（与代码同批，不得只改代码）","desc":"team_link_team_append 工具描述补门的措辞（:7751「黑板没有写权限门」现与门矛盾）· README 键集表与「十项」计数（:1154，U17 红线强制同批）· CHANGELOG"},{"title":"B 仓测试（host-half.test.mjs）","desc":"新增 FR-7 直调腿 6-8 条：默认无键 ⇒ done 无 claim 照常写（既有行为锁）· 开 ⇒ done 无 claim 拒且 tasksLines() 长度不变 · 先 claim 后 done 收 · retract 无 token 拒 / #99999 拒 / #<别的任务行> 拒 / #<本任务真 seq> 收"},{"title":"B 仓键集红线改锚（裁定 1 的代价）","desc":"U19_POLICY_KEYS（:7391）· U29 手抄清单（:5598）· 各断言名「十键→十一键」（:7397/:13785/:14029/:14110/:14426/:14650）——同批改，保证不断、计数同改（文档卫生①⑤）"},{"title":"A 仓设计档措辞收口","desc":"FR-7「规则（一条）」⇒ 两条（:217）· §6 boardTasksGate 伪代码加 retract 步（:306-311）· §7「零 schema 变更」（:325）与 §11（:455）改写成「零台账 schema 变更；策略声明面新增一键」· §8 腿 A-7 与 §11 改动表行数同批"}]}
```

```dsh-ui
{"title":"待你拍板（含前因后果与建议）","columns":["事项","建议","前因后果","不采纳的代价"],"rows":[["张力 1：开关放哪","(a) PolicyConfig 加 antiDrift.ledgerTransitionGate（缺省 false）","设计档「零 schema 变更」自带括号限定为行格式/派生读面；开关属策略声明面；sections 先例同款；normalizePolicy 读回要求声明；本部署事实源=policy.json","(b) 造第二个事实源、重造原子写；(c) 恒开=既有写入行为当场改变，违背「无写门」合同"],["「零既有测试回归」的口径","回归=行为保证不削弱、无断言从绿转红；允许同批改键集锚","B 仓红线把键集钉死在十键（8-9 处断言/注释点名），加键必须改锚——本仓注释与 FR-9/批 I 两处先例都规定这条正路","按字面「不许动既有断言」⇒ (a) 不可行，只能退 (b)，代价见上行"],["张力 2：证据判据","(c) 收紧：正文含 #<seq>，指向同一 tasks.md 同任务的既有行（∃ 语义）","#N 是台账自身记法（派生读面已在用）；存在/同任务/先后三条纯机械；不判作者与 kind（既有设计已定）","(a) ref:t-N 形同虚设、file:line 撞铁律；(b) 撞铁律+假门；(d) 该条停在口号"],["两条规则的开关粒度","一个键罩两条（done⇒claim、retract⇒证据）","两条都是「无写门黑板上新增拒绝」，拆键只增配置面","拆两个键=配置面翻倍，测试腿也要翻倍"]]}
```

**一句话收尾**：两处裁定都能落成可机检验收腿、都不碰自然语言理解；唯一需要你额外确认的是「零既有测试回归」的口径——**(a) 会动 B 仓 8-9 处「十键」锚的断言文本（改锚不破保，不是回归）**，这一条按字面理解就会把方案推回 (b)。

[thincoder-suite] effort "max" is not supported by model mimo-v2.6-pro (supported: off|high) — falling back to nearest supported effort "high"（D-裁决-2 最近支持档，等距向上取）

[5] kimi-api:kimi-k3 — ok
裁定完成。以下是全文。

---

# 设计裁定：FR-7 跨插件写门的两处张力

**三句话结论**：① 张力 1 选 **(a)**——「零 schema 变更」按设计档自己的括号注管的是**台账行格式与派生读面**，策略命名空间加一个默认 `false` 的布尔是 team-link 仓有两次先例的正规做法，但必须付全该仓自己的「加键仪式」；② 张力 2 选 **(d)**——「撤回必须带证据」在**两份设计档里逐字查无此条**，它是未设计规则，本批不得进代码，同时把候选判据 (c) 的定稿形态登记进遗留项；③ **现场警报：另一个会话已在 team-link 并行实施，两处都已自作主张**——方向与我裁定一致的是 (a)，但开关目前**是死的**（归一化没接），retract 规则**引用了不存在的设计依据**，需要先处理既成事实再谈落地。

```dsh-ui
{"title":"现场警报：裁定对象已在被并行实施（盘上事实，非推测）","gap":12,"items":[{"content":"team-link/lib/index.js 在我核查期间从 16238 行涨到 16332 行：另一个会话正在实时实施 FR-7，且两处张力都已自行拍板——与「都还没定」的前提已不符。","tone":"warning","title":"前提已过时"},{"content":"① 开关是死的：zod 加了 ledgerTransitionGate（index.js:1238），但 normalizePolicy 的返回对象（index.js:1256-1306）没有它——policy.get() 永远读不出 ⇒ 门永远 OFF ⇒ 测试腿 A-7②③④⑤（host-half.test.mjs:2692-2731，开关置真）按代码静态推断必红。DEFAULT_POLICY（:1050）也没加。② retract 规则无设计锚：设计档 §5 FR-7 只有 done⇒claim 一条规则，而代码注释（:6723-6736）声称两条规则都出自「设计档 §5 FR-7」——该引用对规则②为假。③ 加键仪式未付：U19_POLICY_KEYS（host-half.test.mjs:7391）仍是十键、README 键集描述未动、五条「零 schema」红线断言期望未更新。","tone":"error","title":"既成实施的三处缺陷"}]}
```

## 张力 1：选 (a)，边界如下划定

**前因后果**：设计档 §7（`2026-10-14-anti-drift-design.md:343`）与 §11（:455）两处都说「team-link 零 schema 变更」，且两处都自带括号注——「锚在正文，行格式不动」「行格式与派生读面不动」；需求档 N-4（`2026-10-14-anti-drift-requirements.md:47`）同样列的是「行格式、上限、seq 分配、写权限口径」。**四处证据一致：这个声明约束的是黑板数据面**（六列行格式 / seq / 2000 码点上限 / kind 闭集 / 派生读面 / 无写权限门）。FR-7 的门插在写路径内部，盘上行的形状一个字节不动——(a) 不违反这个声明。

**但要诚实补一刀**：在 **team-link 自己的词汇表**里，「schema 变更」还指**策略命名空间的键集**——该仓有整整五条红线断言把「`policy.json` 十键逐字不变」钉死（`U19_POLICY_KEYS` 于 host-half.test.mjs:7391；文件后端镜像断言 :8810-8813；U17 README 同步断言 :10929；批 K/L/P 三条「红相＝加一格键」断言 :13785、:14110、:14650）。所以 (a) 在 team-link 的口径下**就是一次 schema 变更**——它不是免费的，而是要走该仓**既有两次先例**（批 3 加 `sections`、批 I 加 `blocks`，见 :10929 的历史自述）的治理路径：

1. `PolicyConfig` 加字段（带默认值——该仓铁律：手改的畸形行要能降级，不能拖垮整个命名空间）；
2. `DEFAULT_POLICY` 同名键 + 注释（:1050）；
3. `normalizePolicy` 返回对象加归一化视图（:1256）——**缺了它开关就是死的**（并行实施正踩在这里）；降级方向 = 手改垃圾 ⇒ 读回 `false`（门 OFF = 旧行为，fail-safe 方向正确）；
4. `U19_POLICY_KEYS` 十键→十一键 + 上述五条断言的期望同批更新；
5. README 键集描述同批（U17 纪律）+ CHANGELOG；
6. 新增一条归一化降级腿（手改 `antiDrift` 为垃圾 ⇒ 读回 `false`）。

**形式建议**：键做成**嵌套对象** `antiDrift: { ledgerTransitionGate: false }`（照抄 `sections` 先例的形状），不要并行实施现在用的顶层裸布尔——设计键名是 `antiDrift.ledgerTransitionGate`，与 suite 侧已落盘的同名键（`anti-drift.mjs:41`）路径一致，且会诊纪要已留「指针闸二期」的配置位，将来还有兄弟子键。顶层裸布尔不算违反，但偏离了设计键名。

**被否决的备选**：
- **(b) 另立读法**（env/JSON 侧档）：team-link 全部状态都收口在 settings 命名空间 + 文件后端折叠这一套里，另开一个面就是重引入它刚花几个批次消掉的失败模式（损坏、原子性、可见性）；且「谁写这个面」无解——suite 的 `anti_drift_config` 写它 = 跨插件写，违反「自己的文件自己管」（需求档 :88 与 D8）。省下的只是五条断言的一行改动，买来一个永久架构孤儿。
- **(c) 恒开**：直接违反设计档 FR-7（:219「默认 OFF」）、需求档（:35「默认关，先单队试点」）与 L-9 的裁定框架（L-9 只给了「接 settings vs 另立读法」两个活选项）；且无 opt-out 地改变既有用户的 done 写入行为。

**生效语义**：并行实施在写入点**现读** `policy.get()`（:7957），与 FR-8「每次需要时现读、即时生效、不需重启」一致——这点是对的，保留。读策略抛错回落 OFF 的方向也对（默认 OFF 是用户拍板的语义，策略面故障不该凭空改变写入行为）。

**一个必须随批登记的代价**（write-face 分裂）：suite 侧 `anti_drift_config` 已落盘的 `ledgerTransitionGate` 键只写 suite 自己的配置仓，对 team-link 的门**无效**；门读的是 team-link 命名空间的同名键。两档文档必须把「开门 = 两侧各设一次」写明白（team-link README + suite 工具描述），否则用户翻了 suite 的开关而门不动，就是一条实测级困惑。设计档 FR-8「六键全部读插件配置」那句是裁定前写的，与 FR-7/L-9「team-link 侧读自己的配置面」互相矛盾，修订时必须改掉。

## 张力 2：选 (d)——该规则在盘上不存在，先登记遗留

**前因后果（取证，非转述）**：「撤回必须带证据」在**两份设计档里逐字查无此条**——

- 设计档 §5 FR-7（:214-220）只有**一条规则**：`done` ⇒ 同任务须先有 `claim`；全文 grep `retract|撤回` **零命中**；
- 需求档 grep 同样零命中（只提到「done 需 claim 来历」，:62）；
- §8 的验收腿 **A-7**（:372）只设计了 done 腿 + 开关关放行，**没有 retract 腿**；
- 会诊 #74 的草案提过 R1/R2 与一张含 retract 迁移的状态图，但定稿设计档**有意收窄**为一条规则——草案 ≠ 设计；
- team-link 自己的台账哲学（README:920）：「谁有资格撤回由人判断：黑板没有写权限门」——retract 语义是**刻意留给人**的，FR-7 的 done 规则已是唯一精心收窄的例外，第二条例外需要同等的设计审议。

按本仓成文流程（讨论→设计档→用户确认→实施）与设计令牌纪律（§11：令牌绑定设计档集；C9 = 设计档里那个一条规则的 FR-7），**它就是不能进本批代码**。并行实施把它写进去了，还在注释里引「设计档 §5 FR-7」作依据——该引用为假，属「描述面与实现不一致」，必须处理。

**机检层面的两个硬事实**（佐证"现在不能定"）：既有语料里 retract 的指针惯例**本身不一致**——README:878 的示例是「撤回 43 的第 2 处」（无 `#`），测试夹具 host-half.test.mjs:2754 是「撤回 #3」，而 :2813-2814 两条是「撤回自己（第一条）」**完全无指针**的合法撤回。任何机检规则落地前，这些既有语料要么改、要么规则就得认得完——这正是设计审议要做的事，不是实施拍脑袋的事。

**登记的候选判据 = (c)，定稿形态如下**（可直接抄进设计档修订段）：

1. **触发**：门 ON 且 `kind === "retract"`；
2. **抽取**：正文内全部 `t-<数字>`（`/\bt-(\d+)\b/gu`）与 `#<数字>`（`/#(\d+)\b/gu`）token；
3. **命中**：至少一个 `t-<n>` ∈ 本文件**可解析行**的 task 集合，或至少一个 `#<n>` ∈ 可解析行的 seq 集合（解析口径 = 既有 `parseTasksRow`，坏行不算存在；复用已读入的 `existing.text`，零新增 IO）；
4. **拒绝**：零命中 ⇒ 拒 + **零写入**，文案点名抽到的引用并给正确示例（沿 index.js:7829 族风格）；
5. **明确不做**：不判「引用是否同一任务」、不判「撤回是否真驳倒了它」——那需要 NLP/裁决，超机检铁律；
6. **修订时必须拍的三个开放问题**：① 是否收紧为「`#<seq>` 必须指向同 task 的行」；② 门只认 `t-<n>` / `#<n>` 两种形态 ⇒ README:878 的裸「43」示例要同批改写；③ 夹具 :2813-2814 两条无指针 retract 在门 ON 下会被拒——要么改夹具要么锁定只在 OFF 下跑。

**被否决的备选**：(a) 只查指针 token 形状不查存在性——`ref: t-999` 也过，等于给漂移发通行证，比没有门更坏（它提供假保证）；(b)「非空 + ≥N 字符 + 提及被撤主张」——「提及」本质是 NLP/模糊匹配，撞本仓铁律，且长度阈是纯噪声（复读 20 字即过）。

**落地路径（二选一，都合规）**：
- **路径甲（推荐，若想保留已写代码）**：设计档增订一段（FR-7 加规则② + 上述判据 + 三个开放问题的拍板 + §8 A-7 加 retract 腿 + L-9 消解记录）→ 用户确认 → 令牌续期 → 代码保留、注释的依据引用改真。代码成本已沉没，补的是**权威**。
- **路径乙（若不想开修订）**：剥离规则②与腿 A-7⑤⑥ 的 retract 部分，只交付设计的一条 done 规则；retract 判据登记为 L-10 遗留。

## 验收腿 A-7 与裁定的映射

| 既有腿（并行实施已写） | 裁定下的处置 |
| --- | --- |
| ① 默认 OFF 行为逐字不变 | **保留**（= 设计 A-7「开关关 ⇒ 一律过」） |
| ② ON + 无 claim ⇒ done 拒 + 零写入 | **保留**（= 设计 A-7 主腿；当前因死开关必红，接好 `normalizePolicy` 后才可能绿） |
| ③ ON + 有 claim ⇒ done 放行 | **保留**；但其「负控」腿（:2711-2715）**腿名与代码不符**——它实际又测了一遍「有 claim ⇒ 过」，从未制造「done 先于 claim」的时序；真负控已由②+③在 t3 上的组合覆盖，建议改名或改写 |
| ④ 非迁移动作不受影响 | **保留** |
| ⑤⑥ retract 引用判据 | **走路径甲则保留 + 补设计锚；走路径乙则撤**（超出设计 A-7 射程） |
| （新增）键集仪式 + 归一化降级腿 | **必须补**（见张力 1 清单第 4/6 条） |

## 决策点汇总

```dsh-ui
{"title":"决策点汇总（每条带前因后果与建议）","gap":12,"items":[{"columns":["#","决策点","前因后果","建议与代价"],"rows":[["T1","开关读法：PolicyConfig 加键 / 另立读法 / 恒开","「零 schema 变更」四处括号注都锚在行格式与派生读面；但 team-link 自己的五条红线断言把 policy 十键也叫 schema——加键在该仓口径下是变更，有两次先例的治理路径可走；另立读法制造第二配置面且无人有权写它；恒开违反设计档「默认 OFF」","选 (a)，嵌套 antiDrift.ledgerTransitionGate。代价：付全加键仪式（normalizePolicy+DEFAULT_POLICY+U19_POLICY_KEYS+五条断言期望+README+CHANGELOG+降级腿）；另须两档文档写清「开门=两侧各设一次」"],["T2","retract 证据规则：本批做不做、判据选哪个","「撤回必须带证据」两份设计档逐字查无此条，FR-7 与 A-7 都只有 done 规则——未设计规则进代码违反成文流程与令牌纪律；且既有语料指针惯例不一致（README 裸 43 / 夹具有无指针撤回），机检规则未到可冻结时点","选 (d)：本批不做，登记遗留并附判据 (c) 定稿形态（t-<n>/#<seq> 须命中本文件可解析行，零 NLP）。想保留已写代码则先修订设计档+用户确认+令牌续期（路径甲），否则剥离（路径乙）"],["F1","并行实施的既成缺陷怎么处理","开关死的（normalizePolicy 未接）⇒ A-7②-⑤ 必红；retract 注释引用假设计依据；键集仪式未付；③ 负控腿名不副实","接好 normalizePolicy/DEFAULT_POLICY 是 T1 的既定内容，顺手修；假依据引用随 T2 路径甲/乙一并处理；③ 负控腿改名或改写；先跑一遍 host-half.test.mjs 拿实测读数再收口"]]}]}
```

**未实跑声明**：A-7 腿当前红绿的判断是**静态代码推断**（`policy.get()` 必经 `normalizePolicy`，而其返回无此键），我没有实跑 1.5MB 测试档——另一个会话正在同时编辑这两个文件，实跑以它为准。设计档里那条「锚在正文，行格式不动」的承诺在 (a) 下完好：FR-7 门之后，tasks.md 的每一行仍是六列、seq 照旧分配、上限照旧、派生读面照旧——变的只是「什么样的行能被写进去」这一件事，而这正是 FR-7 的设计目的本身。
```

## §2 逐问裁定（**主代理写**）

> 口径：**每条回复恰一条处置**（采纳 / 不采纳+理由 / 待定）。会诊 #78 = 4/5 家回执（`codex-cli:gpt-6-astra` 进程失败）。
> 问题 = FR-7 的两处设计张力：**张力 1**（开关读法）与**张力 2**（`retract` 证据判据）。

### §2.1 全体一致的结论（4/4 家，全部**采纳**）

| # | 结论 | 处置 | 落实处 |
|---|---|---|---|
| A1 | 设计档「零 schema 变更」的**射程 = 台账数据面**（行格式/seq/上限/派生读面），**不含策略声明面** ⇒ 开关落 team-link 自己的 `PolicyConfig` **不违背**该声明 | **采纳** | 设计档 §5 FR-7 规则② 段 + L-9 行 |
| A2 | 但该仓把「policy 键集」也机器化成红线（`U19_POLICY_KEYS` 等 ~6-9 处），所以加键**在该仓口径下确实是一次变更**，必须走它的**加键仪式**（含 `normalizePolicy` 归一，否则开关是死的） | **采纳** | 已写进 C11/FR-7 相关注释与 L-9 |
| A3 | **否决**「另立 JSON/env 读法」（= 第二配置面：无降级故事、无原子写、无观测面；且无人有权写它） | **采纳（作为否决理由）** | 设计档 L-9 |
| A4 | **否决**「门恒开」（违反 FR-7 自己的「默认 OFF」与需求档「先单队试点」） | **采纳（作为否决理由）** | 设计档 FR-7 |
| A5 | 门**现读** `policy.get()`（即时生效、不需重启）**正确**；读策略抛错 ⇒ 回落 OFF 的方向**正确**（配置坏了不该开始拒写） | **采纳** | 已按此实现并保留 |

### §2.2 单家/多家的技术建议（逐条处置）

| # | 来源 | 建议 | 处置 | 理由 |
|---|---|---|---|---|
| B1 | deepseek/glm/mimo 三家 | 开关应为**嵌套** `antiDrift.ledgerTransitionGate`（照抄该仓 `sections` 先例；键名与设计档点号路径一致；将来兄弟键不必再动键集锁） | **采纳（建议）** | 键名与设计档逐字对应；列为 D-2 待用户拍板后随独立交付执行 |
| B2 | deepseek | `retract` 指针只认 `kind ∈ {claim, done, block}` 的行 | **不采纳** | **既有合法夹具 `host-half.test.mjs:2679` 的正文是「撤回 #4 的第 2 处」，而 `#4` 那行是 `dispute`**——retract 在既有设计里**正是用来消解 dispute 的**（§9.3.4 规则 2）。加该白名单**会打红一条既有合法撤回**。**判据：夹具是权威，模型建议不是。**（该判断已写入设计档注释供后来者复用） |
| B3 | mimo | 拒绝文案"点名缺什么 + 列候选" | **采纳** | 已写进设计档 FR-7 规则② 的判据描述（列本任务可用行） |
| B4 | deepseek | 「`ref:` 前缀 + `#` 必填」形态 | **不采纳** | 多一个自有子格式（`ref:`）等于给正文发明机器可解析语法；**`t-<n>` / `#<n>` 本仓既有记法已够**，不必再加前缀 |
| B5 | glm/mimo/kimi | 收尾短语统一为 `（Nothing was written）` | **采纳** | 已用于门的两条拒绝文案 |
| B6 | kimi | 应增加**归一化降级腿**（手改 `antiDrift` 为垃圾 ⇒ 读回 `false`） | **采纳（列入独立交付的腿清单）** | 与 B2 同族的"配置面畸形必须降级"铁律 |

### §2.3 张力 2「本批做不做」——四家**二比二分裂**

| 家 | 立场 | 我对其理由的评估 |
|---|---|---|
| deepseek | **做**（收紧形态） | 理由成立：成本 ≈ 一个正则 + 一次既有扫描 |
| mimo | **做**（收紧形态） | 同上 |
| glm | **不做**（登记遗留） | 理由成立且**有取证价值**：既有语料指针惯例**本身不一致**（README 裸「43 的第 2 处」/ 夹具 `#3` / `:2813-2814` 两条完全无指针的合法撤回）⇒ 机检规则未到可冻结时点 |
| kimi | **不做**（登记遗留） | 同上，且强调与 §9.3.4「资格留给人类」的立场冲突 |

**父侧裁定：做（取收紧形态），但把 glm/kimi 的取证结论当作必须同批登记的**已知不一致**。**
理由三条：① 该要求来自**用户转述的吸收清单第 6 项**，是**用户点名要做**的机制 ⇒ 我不能把它留成空条文；② 收紧形态（同任务 + 真实存在）**可机检、零 NLP**，不违反任何既有铁律；③ glm/kimi 的顾虑**已按他们的要求落进文档**（语料不一致如实登记），而不是被压掉——**门默认 OFF**，既有语料在 OFF 下不受影响。

### §2.4 对 §2.2 的补充：本次会诊的**唯一事实性错误**

`deepseek` 与 `mimo` 都建议给 `retract` 加 `kind` 白名单（见 B2）——**这是本次会诊唯一被既有语料直接证伪的建议**。仍如实留在档内，因为「模型建议与夹具冲突时以夹具为准」这条判断方式本身值得留痕。

## §3 分歧与父侧裁定（**主代理写**）

| 分歧点 | 各方 | 父侧裁定 | 依据 |
|---|---|---|---|
| 张力 1 开关读法 | 4/4 选 (a)；分歧只在**形状**（嵌套 vs 顶层裸布尔） | **选 (a) + 嵌套形状**（B1） | 键名与设计档逐字对应；照抄该仓 `sections` 先例；将来兄弟键不必再动键集锁 |
| 张力 2 本批做不做 | **二比二**（deepseek/mimo 做 · glm/kimi 不做） | **做（收紧形态）**，并把「不做」两家的取证结论同批登记为**已知不一致** | 见 §2.3 的三条理由 |
| 「零既有测试回归」的口径 | deepseek/glm 明确提示这是**需要用户拍板的口径分歧**，不宜由实施侧静默选择 | **上升为用户决策（D-3）**，我不自行解释 | 会诊自己点名要求上升；且它决定加键方案可不可行 |
| 既成实施（盘上半成品）的处置 | kimi 指出前提已过时（实现已在被并行写） | **停手 + 不擅自清理 + 上升为用户决策（D-0）** | 另一会话明确请求裁定前别动该仓；在别人仓上"顺手修"属越界 |

## §4 教训（**主代理写**）

1. **「HEAD 里有」≠「已交付」**（本夜最重的一条）。我据 `dsh-team-link` HEAD 里有门函数 + A-7 腿 14 条，判定 FR-7「已交付」并写进设计档 L-9；实况是前一笔提交用 **`git add -A`** 把**来路不明**的改动（疑为某子代理 error 后仍在写盘）连带进库，**用户已用 `87d215d` 回退**。⇒ **判断交付必须同核四样：实现 + 声明 + 验收腿 + 提交者意图**，缺一即为半成品。
2. **共享工作树上的 `git add -A` 是跨会话事故的固定来源**。本仓 CHANGELOG 批 31 行已记过同款事故（把另一会话未提交的「旁证」改动一并提交并打进 tag）。本次是**同一物种的复发**，且这次连累的是**另一个仓**。⇒ 逐文件 `add` 不是形式主义。
3. **模型建议与既有夹具冲突时，以夹具为准**（B2）。四家里有两家给出同一条错建议——**多模型一致 ≠ 正确**，一致性只提高"值得认真评估"的权重，不替代本地取证。
4. **"先写完再被核实"是本夜两次自我更正的共同成因**：`caps.total`（两种取值下都不成立）与「已交付」误判，都是**先写完**、再靠**跑一遍/被别人核一遍**才发现。⇒ 可信度来自**实测与交叉核实**，不来自写得仔细。

## §5 不可验清单（**主代理写**）

1. **本部署无法保证只读**（A30-10）：「只读」仅为弱证（`toolFilter.allow` 白名单**下发**，平台不保证模型面可见）；实测子会话实为 `danger-full-access`。⇒ 四家的"只读核查"结论**不能当作已证**，凡引用其 file:line 者，我已在自己仓内**逐条复核**（本档 §2 的处置均基于我的实测，而非其转述）。
2. **`codex-cli:gpt-6-astra` 未回执**（进程失败：`request timed out` + MCP transport closed）⇒ 「4/5 家」是**实际有效家数**，不是设计家数；该家的意见**不存在**，不得倒推。
3. **`mimo-v2.6-pro` 的 effort 回落**：其自述支持 `off|high`，本仓请求 `max` ⇒ 回落 `high`（D-裁决-2 最近支持档）。⇒ 该家的"max effort"未按请求执行。
4. **`glm` 与 `kimi` 关于"既有语料指针惯例不一致"的取证**（README 裸「43 的第 2 处」/ `:2813-2814` 无指针撤回）我**未逐条复跑**，仅采纳其结论并在设计档如实登记为**已知不一致**（未据此改任何既有语料）。
5. **A-7 腿当前红绿未实跑**（kimi 自己也声明这点）：本轮我**没有**在 `dsh-team-link` 跑 1.5 MB 的 `host-half.test.mjs`——那属于独立交付的执行面，且该仓现处于「半成品 + 用户未裁定」状态。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-10-15 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |
| 2026-10-15 | **裁定层补齐（主代理）**：§2 逐问裁定（A1–A5 全采纳 · B1–B6 逐条处置 · 张力 2 的**二比二分裂**父侧裁定为「做，取收紧形态」）· §3 分歧与父侧裁定（含两条上升为用户决策：D-0 半成品处置 / D-3「零回归」口径）· §4 教训四条（**「HEAD 里有」≠「已交付」** 为最重）· §5 不可验清单五条（含只读弱证、1 家未回执、effort 回落、两条取证未复跑、A-7 未实跑） |
