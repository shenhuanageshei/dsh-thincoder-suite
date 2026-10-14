# 会诊纪要 —— consult #48（原始层，机制落盘）

- 日期：2026-10-12
- 会诊 id：48
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro, codex-cli:gpt-6-astra
- 平台 job：consult-2
- 结果：3/5 交付（其中 3 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #48 finished — 3 of 5 replied (2 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #48 finished — 3 of 5 replied (2 failed)]
effective: 3 of 5 (2 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro, codex-cli:gpt-6-astra
job: consult-2
minutes: docs/consult-minutes/2026-10-12-consult-48-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] opencode-go-plan:mimo-v2.6-pro — failed
(consultation failed: child ended: error — 子代理面不可诊断（no diagnostic, and the child session log gave no turn/end reason — 本部署无法取得该证据：子会话 id / 会话档 / 解压任一不可得）)

[2] codex-cli:gpt-6-astra — failed
(consultation failed: codex-cli PROCESS_ERROR: codex 进程失败（非零退出且无有效输出）（diagnostics: exit=4294967295 | stderr: 2026-10-12T03:47:21.054783Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out 2026-10-12T03:47:21.076678Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out 2026-10-12T03:49:27.285514Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out 2026-10-12T03:50:05.511346Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\"Failed to create unified exec process: helper_unknown_error: setup refresh had errors\")" } …）)

[3] zai-coding-cn:glm-5.3 — ok
# 会诊回复：R-62-4（`requestHeader()` 升不升第 10 条契约锁）

**三句话结论**：① 该不该升的真问题不是「要不要多一个谓词」，而是「`requestHeader()` 这个平台触点**要不要进换版复核的检查清单**」——九条锁全是**插件源码文本谓词**（`lib/contract-baseline.mjs:23-28`，批 28 评审钉死的口径），平台侧漂移从来靠「哨兵告警 + 人按矩阵逐条复核」防，**不进矩阵 = 下一轮批 31 式复核系统性漏检它**。② 我建议**升**：回落是「静默退化为 D-62 事故形态」而非报错，而批 32 的两处文档已误称「九锁会在换版时先红」（CHANGELOG.md:21、设计档 §九 :224——九锁只看插件源码，平台改名**不会红任何一条**），这个错觉本身就证明矩阵被当成了平台侧覆盖面。③ 若不升，理由必须落在**三处**（结项页 §二 + 设计档 §十状态翻转 + 基线档 LOCK_IDS 旁），否则复核的人永远看不到这是个决定。

---

## ① 取舍依据（升 vs 不升）

### 先校准一个事实：九条锁防的是谁

- 九条锁**一律按源码/夹具文本求值**（`lib/contract-baseline.mjs:23-28`）——它们锁的是「**插件以已验证的形状消费平台**」，抓的是**插件侧漂移**（例：有人把 `provider: agentOpts.provider` 改回去 ⇒ ps6 红）。
- **平台侧漂移**（如平台把 `requestHeader` 改名）：插件源码没变 ⇒ **九条锁全绿**；先响的是**版本哨兵**（`evaluateVersionSentinel`，只警告不阻断），然后靠人按 `docs/dsh017-program-closeout.md` §二的矩阵**逐条对平台源码复核**——批 31 就是这么干的（对 `app.asar` 源码逐条走九条 + sha256 对照，见 closeout:5）。
- 所以 R-62-4 的实质是：**`requestHeader()` 要不要成为这个复核清单的一员**。矩阵行不只是「锁的说明书」，它是换版时「查什么」的唯一载体。

### 升的理由（四条，按分量排）

1. **失效形态是静默的**。两级回落保证「不崩」，也保证「不叫」——回落后的行为**恰好就是 D-62 事故形态**（子代理钉死创建期路由 ⇒ 错模型 ⇒ 429/成本/延迟，见 `docs/2026-10-09-eng-route-live-design.md:15-21`）。若创建期路由恰好还有效，退化**零可见信号**。且该面已是**正确性承重面**：四处消费（eng effort+取证、advisor 兜底路由+硬停指纹、index 设置页显示），不是展示面。
2. **平台侧改名有先例，而且锁矩阵里就有一起**：ps4 存在的理由就是平台把 `settings.yaml` 改名成 `.imported`（closeout §二 :30）；批 31 又实测 `@deepseek-ai/dsh-core` 在 0.2.0 里消失。DSH 0.1.x→0.2.x 已经动过好几个本插件消费的面——「平台自己也在用 `requestHeader()` 所以不会改」不是保险。
3. **现有兜底有明确的洞，且文档已经写错了一次**：CHANGELOG.md:21 与设计档 §九 :224 都写着「平台若改名 ⇒ `contractWatch` 九锁会在换版时先红」——**这句话不成立**（平台改名时九锁仍全绿，响的是哨兵）。这两句是批 32 自己写的描述面瑕疵（文档卫生第 5 条：描述面与实现一致），无论升降都该订正；它恰好说明「矩阵覆盖平台侧」是大家已有的心智模型，而当前矩阵对 `requestHeader()` 没有兑现。
4. **成本可控、先例齐备**：同批改锁有 D28-6（计数上调 7→8）与批 32（ps6 改判）两条成熟先例；改动面是纯机械的「九→十」级联（清单见②），grep 得干净。

### 被否决的两个备选（及否决理由）

- **折进 ps6（不加第 10 条，只强化 ps6 的腿与行文）**：触点分类上说得通（同一颗 session 对象），且零计数级联。否决理由：ps6 锁的是「**消费路由的人**」（eng/advisor/index 必须走 `liveAgentRoute`、禁以 `agent.options` 充路由，`contract-baseline.mjs:719-743`），第 10 条锁的是「**读面本身的形状**」（守卫式调用/整对语义/回落方向）——对象不同、独立转红（A26-4）定位更细；ps6 行已经过载（五件事 + D-62 负向锁），再塞平台侧形状与复核指引会不可读；R-62-4 自己的措辞就是「**正式登记为触点**」。
- **运行期探针（contractWatch 或装配期真调一次 `requestHeader()` 验形）**：否决理由：打破 contractWatch「源码文本求值、结果确定、零运行期依赖」的既定纪律；装配期与工具期都**不保证有活会话**；探针自己会成新的失败源（D28-4「只读」与「巡检不是砖化源」同一条纪律）。平台侧形状由**矩阵行文字 + 平台源码锚**承载（`dsh-subagent/lib/index.js:406-424` 的 `parentAgentOptionsForDelegation`，`lib/agent-route.mjs:6-9` 已引用），换版复核时人去 grep 平台源码——这正是其余九条的工作方式。

### 不升的成立条件（诚实说）

若裁定不升，站得住的理由只有一条半：① 消费面已被 ps6 ④/④b + `codex-runner.test.mjs` 腿 4（四态行为锁，:1522-1546）双层钉住，插件侧不会再漂；② 「九」的计数面太大（全库 20+ 处、两条机验断言 `test/contract-baseline.test.mjs:237/312`），级联风险高于收益。但这条理由**必须写进②③的落档处**才有效——否则它只是「还没来得及」。

---

## ② 若升：最小改动面清单 + 谓词写法

### 改动面（一次同批级联；`九|nine|NINE|恒 9` 全库 grep 是本批的机械门）

| 文件 | 改什么 |
|---|---|
| `lib/contract-baseline.mjs` | ① `LOCK_IDS` 加 `"ps10-session-request-header"`（:466-476）；② 新 `lockPs10(readText)`（读 `agent-route.mjs`）；③ `evaluatePlatformSurfaceLocks` 数组加一行（:868-878）；④ 头注/哨兵文案里的四处「九条」改十条（:23/:394/:396/:404；A28-2 只断言 `contract-baseline`/`dsh017-` 子串，**不会**被计数改字打红——已核 `test/contract-baseline.test.mjs:61-87`）；⑤ `PLATFORM_VERSION_BASELINE_EVIDENCE` 不动（历史陈述） |
| `test/platform-surface.test.mjs` | 加一条独立断言腿 `#10`（12→13 用例）；头注「九条」改十条 |
| `test/contract-baseline.test.mjs` | `out.locks.length, 9 → 10`（:237）与 `unknown.length, 9 → 10`（:312）——**这两条是 A28-4 形状锁，必须同批** |
| `lib/index.mjs` | contractWatch 描述两处 "NINE/nine" → "TEN/ten"（:1231/:1238）；头注 :1218-1220 |
| `docs/dsh017-program-closeout.md` | §二 加 ps10 行（含**平台侧形状与复核指引**，见下）+ :4/:19/:21/:41/:46 的「九条」同改 |
| `docs/test-lifecycle.md` | §三 platform-surface 行 12→13 + §七 登记（T-LC2 等值锁会强制） |
| `README.md` | :144/:149/:150/:385 的「九条」 |
| `scripts/repro-platform-issues.ps1` | :205 "nine contact-point locks" |
| `CHANGELOG.md` + `docs/README.md` | 新版本条目 + 新设计档行（照本仓流程走需求档→设计档→用户确认） |
| **不动** | 历史批次档（批 26/28/31 设计档保留旧陈述——既有惯例）；`REGISTRATION_SURFACE_BASELINE`（无新工具）；guard-e T-E19（无新测试档） |

风险提示：本仓**四次**计数同步事故在案（CHANGELOG.md:319 自记「九条/8 条/464/12 四处未同步且零留痕」）——级联清单本身是缓解，全库 grep 读数要进交付自证。

### 谓词怎么写（含负向断言——「不被一次无效改名骗过」要拆成三个骗局）

**骗局 A：平台改名，插件源码没动** ⇒ 任何源码谓词都**不可能**抓到（九条锁同此）。防它的不是谓词，是**矩阵行文字**：ps10 行必须写明平台侧形状 + 平台源码锚，让换版复核的人去 grep 平台本体——

> `ps10-session-request-header` ｜ 平台触点：`Session` 暴露 `requestHeader()` → `{ config: { provider, model, reasoningEffort?, … } }`（平台同源消费 = `dsh-subagent` 的 `parentAgentOptionsForDelegation`，见 `lib/agent-route.mjs` 头注引用）；**换版复核时对平台源码 grep 本体，不得只看插件侧绿** ｜ 插件侧：守卫式调用 + 整对语义 + 回落创建期（退化不崩）；`maxTokens` 恒取创建期 ｜ 批 32 §十 R-62-4 · 本批升锁登记

**骗局 B：插件内的语义腐蚀，弱谓词陪绿**（如谓词只查 `includes("requestHeader")`，任何重构都过）⇒ 谓词必须钉**承重字面**，禁**已知坏形状**：

```js
function lockPs10(readText) {
  const id = LOCK_IDS[9]
  const route = readText("agent-route.mjs")
  if (route === null) return { id, ok: "unknown", evidence: "agent-route.mjs 源文本不可读（D28-7）" }
  const bad = []
  // 正向：守卫（存在性+函数性双检）与调用点——钉字面，不钉标识符
  if (!route.includes('typeof session.requestHeader === "function"')) bad.push("守卫字面不在场（平台改名后直接 TypeError，违反「永不抛」）")
  if (!route.includes("session.requestHeader()")) bad.push("调用点不在场")
  // 正向：config 形状门 + 整对语义门（交付评审 #1 修复的锚）
  if (!route.includes('typeof h.config === "object"')) bad.push("config 形状门不在场")
  if (!route.includes("hp !== null && hm !== null")) bad.push("整对语义门不在场（单侧空串必须整对回落）")
  // 正向：来源三态如实标注（取证面自证）
  if (!route.includes('"request-header"') || !route.includes('"creation-options"')) bad.push("source 三态标注不在场")
  // 负向①：逐键跨源回流（评审 #1 修复前的坏形状——header.model ⊕ created.provider 混搭对）
  if (/header\?\.\s*(provider|model)\s*\?\?/.test(route)) bad.push("逐键跨源回落回来了（D-62 交付评审 #1）")
  if (bad.length > 0) return { id, ok: false, evidence: "agent-route.mjs：" + bad.join("；") }
  return { id, ok: true, evidence: "agent-route.mjs：守卫式调用 + config 门 + 整对语义 + 回落创建期 + source 三态；零逐键跨源回落" + "；平台侧形状见矩阵行（换版须对平台源码复核）" }
}
```

**刻意不锁的**：`agent.options` 在 `agent-route.mjs` / `eng.mjs` 里**合法**（maxTokens 恒取创建期 + 回落，`contract-baseline.mjs:725` 反而要求它在）——ps10 禁它就是写错对象；「永不抛」的 try 包裹属**行为语义**，由 `codex-runner.test.mjs` 腿 4（抛错 getter/空串四态，:1522-1546）当权威，源码锁只钉形状——与其余八条同一分工。

**骗局 C：谓词被掏空（恒真化）** ⇒ 按本仓负控惯例出**修复前必红读数**：负控1 = 还原逐键回落（拆整对门）⇒ ps10 红 + 腿 4 单侧空串断言红；负控2 = 删守卫 ⇒ ps10 红 + 抛错回落行为腿红；阴性对照 = 只动注释 ⇒ 仍绿。

---

## ③ 若不升：理由落在哪（三处，缺一即「隐形决定」）

1. **`docs/dsh017-program-closeout.md` §二（矩阵节）末尾**——加一个小节「**已消费但未升锁的平台触点**」：`requestHeader()` 一行，写明「两级回落 + 版本哨兵 + ps6 ④/④b 与 codex-runner 腿 4 已钉消费面」+ 指回设计档 §十。**这是唯一必落处**：§四「平台换契约标准动作」第 2 步走的就是本页，复核的人会站在这里；同时 §四 第 2 步补一句「另复核本节末尾的未升锁触点清单」。**若不落这里，决定等于不存在。**
2. **`docs/2026-10-09-eng-route-live-design.md` §十 R-62-4 行**——状态从「待评估」翻转为「已裁定：不升锁 + 一句理由 + 指向 closeout §二」（登记项自己的归宿，防两档漂移）。
3. **`lib/contract-baseline.mjs` 的 `LOCK_IDS` 旁（:465 附近）**——两行注释：「`requestHeader()` 已消费、经评估**不**单列锁（理由与补偿见 closeout §二）」。基线档是声明的单一事实源；读它的人必须看出缺口是**有意的**，不是漏（先例：批 17 设计档「§9 补边界防被当遗漏读」）。

另外**无论升降都要做的两件小事**：① 订正 CHANGELOG.md:21 的「九锁会在换版时先红」为「版本哨兵会告警；九锁只看插件源码，不因平台改名而红」（同句在设计档 :224，历史档按惯例留痕不改，CHANGELOG 顶部是现役描述面要改）；② R-62-4 的裁定按你仓流程回写两档（上文 1/2）。

---

**给用户的决策表（一行）**：前因 = 批 32 新消费了平台面但矩阵没跟；建议 = **升为 ps10**（理由：静默退化 + 复核清单缺口 + 平台改名有前例；代价：一次约 10 文件的「九→十」机械级联，两条机验断言同批改，本仓有四次计数事故史但清单可 grep 门控）；不升的代价 = 省一次级联，换来「下轮换版复核系统性漏检 + 决定必须落三处档才不被当遗漏」。

[4] deepseek-official:deepseek-v4-pro — ok
分析完成（只读，未改任何文件）。先把结论说人话，再给三条依据与两个分支的完整方案。

```dsh-ui
{"title":"三句话结论","gap":10,"items":[{"type":"list","items":["这事是什么：D-62 让 eng_coder 改读活动路由 session.requestHeader().config——这是「会话当前路由」的唯一权威读面，四个消费点（两次 spawn、advisor 兜底路由、硬停指纹、设置页）全压在它上面。","对插件有什么影响：今天读面的『行为』已被 ps6 的 D-62 负向锁和 codex-runner 腿 4 锁住，但读面『词元本身』与『只准在一个地方读』没有任何锁钉死——一个直读的第二消费点或一次词元改名，现有九条锁全都看不见。","建议怎么办：升为第 10 条——但升成『文本通道的插件消费形状锁』（钉 agent-route.mjs 的读取词元 + 单读取点负向），不要做成对活 agent 的运行时存在性探针：探针形态破九条锁『零宿主态』的求值纪律，且首次请求前 requestHeader()?.config 合法为空 ⇒ 内建假红窗口。"]}]}
```

## ① 取舍依据（升 vs 不升）

```dsh-ui
{"title":"四条硬事实（每条带证据锚）","gap":10,"items":[{"type":"list","items":["事实 1 · 这条锁只能做成「插件消费形状锁」，做不成「平台存在性锁」：九条锁的求值口径是『源码文本/夹具文本、零真实网络/LLM/子进程』（lib/contract-baseline.mjs:24-28，D28-4/D28-7）。对活 agent 做探针会是第一条依赖宿主态的锁；更致命的是平台 JSDoc 明文『creation options remain the fallback before the first request』——首次请求前 requestHeader()?.config 合法为空，探针从形状上分不清『还没请求』与『被改名』。","事实 2 · 升的净增量真实且只有两块：① 钉死 agent-route.mjs 内部读取词元与形状守卫；② 单读取点负向锁（lib/** 除 agent-route.mjs 外零处代码行直读）。其中 ② 今天没有任何锁覆盖——ps6 ④b 只扫 advisor/index 的 `agent.options ?? {}`，腿 4 只测 liveAgentRoute 函数本身。实测该纪律今天已成立：lib/** 里代码行读 session.requestHeader 的只有 lib/agent-route.mjs:52-53，其余 8 处全是注释。而「第二个直读点绕过整对语义」正是交付评审 #1 那类跨源混搭对的复活路径，与 D-62 FR-5『决策同源』同一个威胁模型。","事实 3 · 不升的兜底其实有 4 层，不是题述的 2 层：① 两级回落 fail-open；② routeLabel/取证行逐次自证 source——失败报告的『本次派发路由』后缀写死是 request-header 还是 creation-options（lib/agent-route.mjs:82-88），退化在每次派发报告里可见；③ 版本哨兵（平台改名必伴随换版 ⇒ 装配期响亮告警）；④ ps6 ④/④b + codex-runner 腿 4 的行为锁。","事实 4 · 平台侧风险被结构性压低：平台自己的 parentAgentOptionsForDelegation（dsh-subagent/lib/index.js:406-424）内部就消费同一方法——把它改名先破平台自己的子代理继承，且必然换版 ⇒ 哨兵必响。"]}]}
```

```dsh-ui
{"title":"裁决","gap":10,"items":[{"type":"callout","tone":"success","title":"我建议：升为第 10 条（文本通道）","content":"三点理由：① 本仓自己的残余声明承认「全新的平台面仍可能漏网」（README:385），而 R-62-4 是结项后第一个新面——不锁等于永久保留这个残余；② 单读取点负向是真增量，且正对 D-62 的事故形态（同一份事实多处各读各的）；③ 代价有界、全是机械连锁，R-62-4 当初就已预估（扩十条连带改工具描述与结项页）。\n\n折中提示（如果你不愿付九条→十条连锁）：把同一谓词并进 ps6 的 ④ 节（新增 ④c 腿）——覆盖等价、零连锁，代价是 ps6 矩阵行更长、独立转红粒度变粗（A26-4『各自独立转红』的精神弱半档）。"},{"type":"list","items":["不升唯一比升强的地方：少付一次『九条→十条』的活描述面连锁（约 8 处），但兜底层数再多也不会把『单读取点』变成有人守——那正是升要补的唯一真缺口。","诚实边界（无论升不升都要写进档）：文本通道锁看不到平台源码——平台真把方法删了/改名且不留壳，本条锁不红，靠「回落 + source 自证 + 哨兵」兜。升的不是『平台存在性锁』，是『插件消费形状锁』。"]}]}
```

## ② 若升：最小改动面 + 谓词写法

```dsh-ui
{"title":"最小改动面（批 33 收口，7 个活面）","gap":10,"items":[{"type":"table","columns":["文件","改动"],"rows":[["lib/contract-baseline.mjs","LOCK_IDS 追加 ps10-session-request-header；新增 lockPs10(readText, listFiles)；evaluatePlatformSurfaceLocks 返回数组 +1；活注释与哨兵两段告警文案『九条』→『十条』（:23/25/394/396/404/451/465/857 等）。PLATFORM_VERSION_BASELINE_EVIDENCE（:57）是批 31 的历史证据串，不动（D12-11 历史记录禁改）"],["test/platform-surface.test.mjs","新增 test(\"#10 …\") → assertLock(\"ps10-session-request-header\")；头注释 3 处『九条』→『十条』；不改 A26-7 夹具——header 路径的集成覆盖已在 codex-runner.test.mjs:1157 的夹具里"],["lib/index.mjs","contractWatch 描述『the NINE platform contact-point locks』→『the TEN …』、『all nine lock verdicts』→『all ten』（:1231/:1238）；两处活注释（:52/:1218-1221）"],["test/contract-baseline.test.mjs","A28-4 标题 + locks.length 9→10（:237）；D28-7 unknown.length 9→10、其余 unknown 8→9（:312/:326）；A28-5 断言体经 LOCK_IDS 自动覆盖 lockPs10，只改标题措辞"],["docs/dsh017-program-closeout.md","§二 标题/导语/『恒返回九条』→十条 + 矩阵新增 ps10 行（含『不覆盖平台侧改名』的诚实边界）；§三护栏、§四标准动作『九条』→『十条』"],["docs/2026-10-09-eng-route-live-design.md","§十 R-62-4 行翻成『已升锁（批 33 · ps10），指针 → closeout §二』，闭合登记链"],["docs/test-lifecycle.md · README.md","台账 platform-surface 行（描述九条→十条 + 用例数 12→13 + 全量计数级联，T-LC2 会钉）；README 活行（要求节 :144、contractWatch 提示 :149-150、残余行 :385）；README :405 版本历史行与 CHANGELOG 历史条目不动"]],"note":"纪律：文档卫生第 1 条——改矩阵行与改『九条』计数声明必须同一次编辑；写后回读被改区域。新增的是测试腿不是新测试档 ⇒ T-E19 登记闸不触发。"}]}
```

**该条谓词怎么写**（含负向断言，落在 `lib/contract-baseline.mjs`）：

```js
// — #10 会话活动路由读取面（批 33 / R-62-4 升锁）— 文本通道：钉读面词元与形状 + 单读取点负向
function lockPs10(readText, listFiles) {
  const id = LOCK_IDS[9]
  const ar = readText("agent-route.mjs")
  if (ar === null) return { id, ok: "unknown", evidence: "agent-route.mjs 源文本不可读（D28-7：记 unknown 而非 false）" }
  const bad = []
  // ① 正向：读面词元。必须用正则锚死「调用形态」——includes("session.requestHeader") 会被
  //    session.requestHeaderLegacy( 这类后缀改名骗过（子串仍在）；正则要求后随非标识符的调用括号。
  if (!/session\.requestHeader\s*\(/.test(ar)) bad.push("agent-route.mjs 未以 session.requestHeader( 读取活动路由（词元被改名）")
  if (!ar.includes('typeof session.requestHeader === "function"')) bad.push("缺可调用守卫（truthy 非函数会骗过存在性检查）")
  if (!ar.includes('h.config && typeof h.config === "object"')) bad.push("缺 config 形状守卫（平台改键留空壳会骗过）")
  // ② 负向：单读取点——lib/**（除 agent-route.mjs 与本档自身）代码行零直读 session.requestHeader(
  //    直读绕过 liveAgentRoute 的整对语义 = 交付评审 #1 那类跨源混搭对复活。
  //    ★ 只看代码行（剥 // 行首注释——负向断言只看代码，D12-6 同律）；本档自身必须除外，
  //      因为本锁的 evidence 串必然写该词元；agent-route.mjs 是被钉的唯一点。
  const skip = new Set(["agent-route.mjs", "contract-baseline.mjs"])
  for (const f of (listFiles() ?? []).filter((f) => f.endsWith(".mjs") && !skip.has(f))) {
    const s = readText(f)
    if (s === null) continue // 单档不可读 ⇒ 跳过该档，不拖累整条（全不可读由①先行判 unknown）
    const code = s.split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n")
    if (/session\.requestHeader\s*\(/.test(code)) bad.push(f + ": 代码行直读 session.requestHeader（必须经 liveAgentRoute 单点）")
  }
  if (bad.length > 0) return { id, ok: false, evidence: bad.join("；") }
  return { id, ok: true, evidence: "agent-route.mjs：session.requestHeader( 词元 + 可调用守卫 + config 形状守卫在场；lib/** 零第二读取点（liveAgentRoute 单点，D-62 FR-5 同模型）" }
}
```

```dsh-ui
{"title":"『无效改名』骗不过去的对照表（负向断言五连）","gap":10,"items":[{"type":"table","columns":["骗法（一次无效改名）","谁的改动","被哪条腿识破"],"rows":[["requestHeader → requestHeaderLegacy(（includes(\"requestHeader\") 恒真，朴素文本锁被骗过）","插件","① 正向正则锚 session\\.requestHeader\\s*\\(（后随非标识符的调用括号，后缀改名立即红）"],["requestHeader: {}（truthy 非函数值）","插件/平台","① 钉 typeof session.requestHeader === \"function\" 守卫字面"],["方法还在但返回空壳（config 缺失 / provider·model 空串 / 调用抛错）","平台（改名后留兼容别名）","① 钉 h.config && typeof h.config === \"object\" + 已有行为腿（codex-runner 腿 4：空壳 ⇒ 整对回落、source 不得谎报 request-header）"],["config 键改名（→ requestConfig）","平台/插件","① 钉 h.config 词元 + 行为腿（读不到 config ⇒ 整对回落而非认 header）"],["第二个档直读 session.requestHeader()（绕过 liveAgentRoute 的整对语义）","插件","② 负向单读取点扫描（代码行；对 D-62『三处各读各的』事故形态的直接防线）"]],"note":"残余风险如实登入矩阵行：/* */ 块注释内引用该词元会逃过行首 // 剥除——今天的 lib 源码全是 // 行注释（grep 实测 8 处），判定为可接受并写明。"}]}
```

## ③ 若不升：理由该落哪

```dsh-ui
{"title":"不升时理由的落点（两处，一处主、一处闭合）","gap":10,"items":[{"type":"list","items":["主落点：docs/dsh017-program-closeout.md §二（九条触点矩阵节），矩阵表正下方加一节『已知未入锁触点（有意不锁，勿当遗漏）』——写：表面名（agent.session.requestHeader()）、登记项 R-62-4、不锁的四层理由（fail-open 回落 + routeLabel 逐次自证 source + 版本哨兵换版必响 + ps6 ④/④b 与腿 4 行为锁）、以及复核触发条件（平台换版走 §四标准动作；或报告中『本次派发路由』后缀退化为 creation-options 且请求已发生）。选这一节的理由：它是常设交接页（D28-5）——未来维护者审矩阵完备性、或 contractWatch 报警后翻页时，看到的都是这一页；矩阵缺一行恰恰是『像被遗漏』的形态，只有在这里落字才能把『遗漏』转成『裁决』。","闭合落点：docs/2026-10-09-eng-route-live-design.md §十 的 R-62-4 行，从『待评估触点』翻成『已裁定：不升锁，理由见 docs/dsh017-program-closeout.md §二』——否则登记链悬着，下一批接手时会把它当『还没人处理』再评估一遍。","可选加强：closeout §四『标准动作』加一条判读指引——eng_coder 报告的派发路由后缀若是 creation-options（且请求已发生）⇒ 活动路由读面退化信号，按 §二 该触点记录复核，不必等 contractWatch。"]}]}
```

两点收尾提醒：① 升锁方案里**没有**对活 `agent` 的运行时探针——那会把第一条宿主态锁带进矩阵，且首次请求前的合法空值窗口会让它假红；「平台真把方法删了」这条腿永远由哨兵+标准动作兜，这点必须在 ps10 矩阵行里写明，防止过卖。② 无论选哪支，R-62-4 的登记行都要在**同一批**里翻成终态（升/不升 + 指针），这是本仓「登记链闭合」的既有纪律。

[5] kimi-api:kimi-k3 — ok
# 会诊意见：R-62-4 —— `requestHeader()` 该不该升为第 10 条契约锁

**三句话结论**：① 这事的关键在于「锁是瞎子」——九条锁全是**本仓源码文本谓词**，对平台改名**结构性看不见**，所以一条新锁回答不了 R-62-4 字面上的问题（「平台那边还在不在」）。② 它能回答的那半（「本仓这边还读得对不对」）已有两层覆盖：ps6 钉住了调用点、行为测试钉住了漏斗语义。③ **我的建议：不升为独立第 10 条；把「漏斗形状」判据作为 ps6 的新腿 ④c 并入（条数不变），并按下面 ③ 的三处落点把 R-62-4 结案。**

---

## ① 取舍依据（升 vs 不升）

### 先把 R-62-4 拆成两个子问题——它们能被机械回答的程度完全不同

```text
R-62-4「requestHeader() 存在且形状可用」
├─ (a) 平台侧：平台还在提供这个方法吗？      ← 锁【看不见】
│     九条锁的既定口径（D28-4，contract-baseline.mjs:25-27）：
│     一律按【本仓源码文本/夹具文本】求值，零平台读取。
│     平台改名 ≠ 本仓文本变化 ⇒ 任何本仓文本谓词恒绿。
│     覆盖机制 = 版本哨兵（换版告警）+ 逐版人工复核（批 31 模式）
│     ——是【流程】，不是【锁】。
│
└─ (b) 本仓侧：本仓还在按约定形状读它吗？    ← 锁【看得见】
      现状已覆盖两层：
      ① ps6 ④/④b（批 32 改判，contract-baseline.mjs:725-743）：
         钉死 eng/advisor/index 必须走 liveAgentRoute(agent)、
         禁以 agent.options 充当路由 —— 调用点已锁。
      ② 行为测试（test/codex-runner.test.mjs:1518-1550）：
         夹具暴露 requestHeader、断言 source==="request-header"
         ⇒ 漏斗里一次无效改名 ⇒ 整对回落 ⇒ 立即红。
      唯一缺口 = agent-route.mjs 的【文本形状】无独立红腿。
```

**升第 10 条锁的真实边际收益**只有：一条独立于行为测试的文本红腿（防「同一批里代码 + 夹具被一起改掉」的合谋漂移）+ 矩阵行数的形式完备。

**升第 10 条锁的真实代价**（实测全库「九条」字样，非凭记忆）——9→10 不是改一个数组，是一次**八活档级联**，且每一刀都正落在本仓记录在案的头号缺陷物种上（「计数改了列表没改」，见 METHODOLOGY.md 批 16/17 行的五次复发史）：

| 连带面 | 位置（实测） | 性质 |
|---|---|---|
| A28-4 形状锁 | test/contract-baseline.test.mjs:237 `assert.equal(out.locks.length, 9)` | **机械断言**，须同批上调 + 写理由（先例 D28-6） |
| 哨兵文案 ×2 | lib/contract-baseline.mjs:394-396、404（「九条平台触点锁可能失配」「查看九条触点锁现状」） | **用户可见**告警文本 |
| 工具描述 ×2 | lib/index.mjs:1231（"NINE"）、1238（"all nine"） | **模型可见**描述（描述面须与实现一致） |
| 基线档自身 | lib/contract-baseline.mjs:23/25/49/57/451/465/857/861 | 头注 + JSDoc（恒 9 条） |
| 结项页 | docs/dsh017-program-closeout.md:4/19/21/41/46/47 + §二表加行 | 常设交接页 |
| 测试计数 | platform-surface +1 腿 ⇒ 594→595 ⇒ CHANGELOG 计数行 + docs/test-lifecycle.md:111/114 + handoff 行 + 发布门 G3 | T-LC2 台账等值锁强制同改 |
| README | README.md:144/149/150/385 | 活口径 4 处 |
| docs/README | docs/README.md:34 | 结项页索引行 |

（批 26/28 设计档、旧 CHANGELOG 条目等 **as-of 历史档按惯例不动**——批 31 抬基线时就没回写批 28 §2.2。）

### 不升的三条硬理由

1. **触点对象已有主**。ps6 的 id 是 `ps6-agent-session-fields`——它管辖的就是 **agent.session 这个对象的成员面**（session.id / header.delegationDepth / header.cwd，批 32 又加了活动路由）。`requestHeader()` 是**同一个对象上的新成员**，不是新触点对象。本仓先例清一色是「同一触点消费面变化 ⇒ 改既有行」：ps6 批 32 改判（closeout:32「本行随改」）、ps9 的 2026-09-28 更正（同行更正）。开第 10 行会把一个平台对象拆成两行，正好制造本仓反复在打的「两处同改」病。
2. **批 32 自己已建第三层兜底，R-62-4 登记时没算进去**：`liveAgentRoute` 的 `source` 如实标注（agent-route.mjs:73-88）+ 失败取证会把「派发路由（creation-options）」写进每次报告 ⇒ 平台真改名时不是完全静默，是「**报告面可见的退化**」。加上两级回落（不崩）与版本哨兵（换版告警），残余风险是「报告面可见 + 换版有告警」的窄缝。
3. **升了也堵不上 R-62-4 真正担心的洞**。怕的是「平台改名 ⇒ 静默退化」；而本仓文本锁对平台改名恒绿（上面 (a)）。要堵那个洞只能靠读平台源码或读活会话——前者破 D28-4 口径且宿主布局相关（非桌面宿主按 D28-7 只能报 unknown 而非红；asar 整体替换窗口正是「哨兵最该响时最容易瞎」的窗口，contract-baseline.mjs:263-268 的复盘原文），后者超出锁的纯文本机制。**拿一条回答不了该问题的锁去答该问题，是把「矩阵看着完整」误当成「风险被覆盖」。**

### 附带发现（无论升不升，下一批都该顺手修）

批 32 设计档 §九（2026-10-09-eng-route-live-design.md:224）与 CHANGELOG 批 32 条目（CHANGELOG.md:21）都写「`contractWatch` 九锁会在换版时先红」——**不精确**：换版时先响的是**版本哨兵**（每进程一次、只警告不阻断）；九条锁本身不会因平台改名变红（本仓文本没动）。这句会让后来者**高估**既有兜底，正是文档卫生第 5 条（描述面与实现一致）要治的形态。

---

## ② 若升：最小改动面清单 + 谓词写法（含负向断言）

> 说明：同一套谓词体，作独立 `lockPs10` 或作 ps6 新腿 ④c **逐字通用**——区别只在登记面。下文的「若升为第 10 条」清单供完整决策；推荐形态（ps6 ④c）的改动面只有清单里第 1、2 项的一小部分。

### 若坚持升为独立第 10 条：最小改动面（同批，缺一不可）

1. `lib/contract-baseline.mjs`：`LOCK_IDS` +`"ps10-session-request-header-shape"`；新增 `lockPs10(readText)`；求值数组 +1；JSDoc「恒 9 条→恒 10 条」；头注与哨兵两条文案的「九条」全改。
2. `test/platform-surface.test.mjs`：+1 独立断言腿（A26-4：每条锁各自独立转红）；头注；**顶层用例 594→595**。
3. `test/contract-baseline.test.mjs:237`：A28-4 形状锁 `locks.length===9→10`，注释写明上调理由（先例 D28-6）。
4. `lib/index.mjs`：contractWatch 描述 "NINE"→"TEN"、"all nine"→"all ten" + :1220 注释。
5. `docs/dsh017-program-closeout.md`：§二标题/权威源声明/机验权威行/§三.3/§四.1-2 + §二表加 ps10 行。
6. `README.md:144/149/150/385` 与 `docs/README.md:34` 的「九条」。
7. `docs/test-lifecycle.md`：§三 platform-surface 行 12→13、contract-baseline 行「恒 9 条→恒 10 条」、§七加行（T-LC2 等值锁，数字必须 = fs 实测）。
8. `CHANGELOG.md` 新批条目（计数行 + 锁数 + A28-4 上调理由）+ 版本号 bump；`docs/2026-09-13-handoff.md` 加批行。
9. `docs/2026-10-09-eng-route-live-design.md` §十：R-62-4 结案为「已升锁」+ 指针。
10. 下次换版人工复核清单（closeout §四）补 requestHeader() 一项。

### 谓词怎么写（核心是「不被一次无效改名骗过」）

**先讲陷阱（实测）**：`agent-route.mjs:11` 的头注里就有 `` `agent.session.requestHeader()?.config` `` ——若谓词写裸 `includes("session.requestHeader()")`，有人把**代码**改名成 `requestHeaders()` 而**注释没动**，锁照样绿（注释里的子串满足了它）。**这就是「被一次无效改名骗过」的具体机制** ⇒ 全部正向腿必须用**代码形字面**（带 const/typeof/运算符上下文），注释形态 structurally 满足不了。

```text
lockPs10 / ps6④c —— 单文件锁 over agent-route.mjs（readText 为 null ⇒ "unknown"，D28-7）

正向腿（缺任一即红；逐条对应当前行号，as-of v0.30.1）：
  P1  includes('typeof session.requestHeader === "function"')   // :52 永不抛门
  P2  includes('const h = session.requestHeader()')             // :53 调用点（const 前缀 = 代码形）
  P3  includes('h.config && typeof h.config === "object"')      // :54 形状闸
  P4  includes('hp !== null && hm !== null')                    // :67 整对判据（评审 #1 修复）
  P5  includes('fromHeader ? "request-header"')                 // :73 来源如实标注（禁谎报）

负向腿（出现任一即红）：
  N1  !includes('hm ?? cm') && !includes('hp ?? cp')
      // 逐键混搭回落 = 评审 #1 修掉的形态（跨源假路由对）；注意必须精确到
      // 这两个字面——:71 的 effort 行 asName(...) ?? asName(...) 是【设计允许】的
      // effort 回落，宽泛禁 "??" 会误伤它。
  N2  跨文件计数：lib 全域 '= session.requestHeader()' 恰 1 处（= agent-route.mjs 那一处）
      // 单一漏斗：任何人绕开 agent-route.mjs 另建读取点即红。
      // ★ 自扫描陷阱：谓词住在 contract-baseline.mjs，而本档头注（:36-38）钉死
      //   「不得出现未转义的被扫描字面」⇒ 该字面必须拼接写：
      //   "= session.requestHeader" + "()"（先例：BT = String.fromCharCode(96)，:605）。
      //   已实测：advisor.mjs:13 / eng.mjs:1415 / contract-baseline.mjs:720 的注释
      //   只含 `session.requestHeader().config`，不含 "= session.requestHeader()" ⇒ 零误报。
```

**为什么这套不被骗过**（三层互证）：① 正向腿全是代码形字面——改名必然打碎字面，注释救不了；② N1 钉死「修复前的已知坏形态」，防顺手改回去（这正是 ps6 ④「负向锁」的同款手法，contract-baseline.mjs:728-730）；③ N2 + 行为腿（test/codex-runner.test.mjs:1518-1550，夹具断言 `source==="request-header"`）构成**两份独立事实**——文本锁防「夹具被同批一起改」，行为锁防「文本措辞被同义改写」，单点失守另一方仍红。

**明确否决的备选**（写进决策记录）：谓词去读平台源码（app.asar 内 `dsh-subagent/lib/index.js` 的 `parentAgentOptionsForDelegation`）。否决理由：破 D28-4「本仓文本」口径；宿主布局相关（非桌面宿主读不到 ⇒ 按 D28-7 只能报 unknown 而非红，锁就失去告警力）；且撞上 asar 整体替换的盲区窗口（contract-baseline.mjs:263-268 的真机复盘：「哨兵最需要响的那一刻恰好是它最容易瞎的窗口」）。

---

## ③ 若不升：「不升」的理由该落在哪，后来者才看得见

落点分三层，主次有序：

1. **主落点 = `docs/2026-10-09-eng-route-live-design.md` §十（遗留与登记）**。R-62-4 条目自己就写着结案方式：「或明确判为『不升锁』并写明理由」（:234）；同节 R-62-1/R-62-2 已示范了结案写法（「如实登记为已排除，不再追」）。把状态从「待评估触点」翻成「**已裁定：不升锁**」，写三条理由——(i) 平台侧事实超出本仓文本锁口径（D28-4），锁回答不了；(ii) 触点对象已由 ps6 管辖，消费侧已由 ps6 ④/④b + 行为腿（codex-runner 腿 4）+ `source` 自证面覆盖；(iii) 条数 9→10 的级联面（A28-4/哨兵文案/工具描述/台账/计数）与新增检测力不成比例。若采纳我的建议并入 ps6 ④c，此处一并写明「判据并入 ps6，条数不变」。
2. **防误读落点 = `docs/dsh017-program-closeout.md` §二 ps6 行的批次细节链**（:32）。结项页是常设交接页（「会话会丢，档不会」），§二正是后来者查「这个平台面有没有锁」的地方——没有这一句，`requestHeader()` 不在矩阵里就会被读成**遗漏**而非**裁定**。补半句即可：「批 33：session.requestHeader() 读面经 R-62-4 裁定**不单独升锁**（理由见批 32 设计档 §十；消费侧已由本行 D-62 负向锁与行为腿覆盖）」。同时在 §四（平台换契约时的标准动作）的人工复核项里补 requestHeader()——平台侧那半本来就只能靠逐版复核覆盖，让它进清单比进锁更对症。
3. **流程落点**：结案本身走一个批次——批设计档的「决策与理由」节写明被否决的「升第 10 条」备选与否决理由（METHODOLOGY 必备章节要求），CHANGELOG 条目与 handoff.md 行随批登记。**不要**回写批 32 的 CHANGELOG 条目与 handoff 批 32 行（as-of 历史档不动）；顺带修 §九:224 与 CHANGELOG:21 那句「九锁会先红」⇒「版本哨兵先告警」。

---

## 决策表（前因后果 + 建议 + 代价）

| 选项 | 检测面增量 | 代价 | 评价 |
|---|---|---|---|
| **A. 升为第 10 条** | 文本红腿 ×1 + 矩阵形式完备 | 8 活档 ~25 处「九条」+ A28-4 上调 + 594→595 全链；正中本仓头号缺陷物种 | 边际收益最小、改动面最大 |
| **B. 不升，纯两层兜底** | 零 | 零改动 | agent-route.mjs 内部形状无独立文本红腿；R-62-4 落不了案 |
| **C.（我建议）不升条数，判据并入 ps6 ④c + R-62-4 三处落案** | 与 A 同一条文本红腿 | 基线档一处谓词 + closeout 半句 + 设计档 §十结案；**计数/形状锁/哨兵文案/工具描述全不碰，594 不变** | 拿走 A 约九成的检测力，付约一成的代价；完全贴合 ps6 批 32 改判先例 |

**我建议选 C**。理由：触点对象归 ps6 管辖是本仓既定结构；A 相对 C 只多「矩阵行数的形式好看」，却要触发一次八档级联；B 则浪费了一条成本极低的独立红腿。选 C 的代价：ps6 的 evidence 变长（可接受，无测试钉它的文案）；不选 A 的代价：矩阵行数与「消费面清单」不再一一对应——由 closeout §二 ps6 行那句裁定说明兜底，后来者不会误读。若你（用户）对「每个新消费平台面必须有独立矩阵行」有规范性偏好，则选 A，按 ② 的十项清单同批执行——那是形式完备的值钱买法，但请连同 ② 的负向断言一起买，否则那条新锁第一天就是条会被注释骗过的软锁。
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
| 2026-10-12 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |


---

## §2 裁定层（主代理写；机制只写 §0/§1）

### §2.1 逐条处置（每条恰一个处置）

| 回复 | 型号 | 立场 / 结局 | 处置 |
|---|---|---|---|
| [3] | zai-coding-cn:glm-5.3 | **升**第 10 条锁（先校准「九锁防的是插件侧漂移」；四条理由；给出谓词与负向断言五连） | **未定（待用户拍板）**——与 [5] 正面冲突，见 §3 |
| [4] | deepseek-official:deepseek-v4-pro | **升**，但只升成「文本通道消费形状锁」（钉词元 + 单读取点负向），明确反对运行时探针 | **未定（待用户拍板）**；其「不要运行时探针」一条**已采纳**（[3] 独立同结论） |
| [5] | kimi-api:kimi-k3 | **不升**，折进 ps6 新腿 ④c（条数不变）；三条硬理由 + 附带发现文档硬伤 | **未定（待用户拍板）**——与 [3][4] 冲突 |
| [1] | opencode-go-plan:mimo-v2.6-pro | 失败：`400 Invalid request parameters` | **已定位，与本议题无关**：真因 = 上游缺 `x-opencode-session`（MissingSessionID）。2026-10-13 已补头到生效块（profile `cordis.patch.yml` 的 `config.autoBackup.sections.llm-pi-ai.providers.opencode-go-plan`）+ 备份 + 全档 YAML 校验（相对备份只差 1 条路径）。另发现 digest 的「不可诊断」不实 ⇒ 登记 R-63（§5） |
| [2] | codex-cli:gpt-6-astra | 失败：`PROCESS_ERROR exit=-1` | **已定位，与本议题无关**：CLI 侧环境（模型表刷新网络超时 + `chatgpt.com/backend-api/ps/mcp` 不可达 + Windows 执行助手 `helper_unknown_error`；`~/.codex/config.toml` 内有 `[windows] sandbox = "elevated"`）。2026-10-13 复跑仍未通 ⇒ 登记 R-64 |

### §2.2 两派共识（无论升不升都必须做）

1. **文档硬伤**（[5] 与 [3] 独立指出、且事实成立）：`CHANGELOG.md` 批 32 条目与 `docs/2026-10-09-eng-route-live-design.md` §九 写「平台若改名 ⇒ `contractWatch` 九锁会在换版时先红」——**不成立**：九条锁全是**本仓源码文本谓词**，平台改名时本仓文本未变 ⇒ 九锁全绿；先响的是**版本哨兵**（只警告不阻断）。⇒ 待修（文档卫生第 5 条「描述面与实现一致」）。
2. **登记链闭合**：登记项 **R-62-4** 必须与最终决定**同批**翻成终态（升 / 不升 + 指针），否则下一批会把它当「还没人处理」重评一遍。

### §3 未定项与理由（为什么主代理不自行拍板）

升与不升是**真实的技术分歧**，不是措辞分歧：升派认为「矩阵 = 换版复核清单 ⇒ 不进矩阵 = 系统性漏检」；不升派认为「文本锁对平台改名恒绿 ⇒ 新锁答不了 R-62-4 问的那半，只让矩阵看起来完整」。两边的代价不同（升 = 九→十级联，contractWatch 描述与结项页同改；不升 = 需在三处写明「有意不锁，勿当遗漏」）。按工程模式纪律，设计选择归用户 ⇒ 标 **未定**。

### §4 已采纳的独立结论

- 「**不做运行时存在性探针**」：[3] 与 [4] 独立同结论（破「零宿主态」求值纪律 + 首次请求前 `requestHeader()?.config` 合法为空会造成内建假红）⇒ **采纳**。
- 「**不得静默收口 R-62-4**」：三票一致要求登记链闭合 ⇒ **采纳**。

### §5 后续登记（新发现两项）

- **R-63**：consult 侧失败取证腿未取到**明明可读**的子会话档（本例 mimo 的 `turn/end` 原文就在盘上），digest 却报「子代理面不可诊断」——与批 32 已修的 eng 侧（D-62）同族，consult 侧仍缺。建议与 D-58 同批复核。
- **R-64**：codex 行的可用性依赖 CLI 侧环境（Windows 沙箱助手 + 联网子系统），插件侧无自愈手段；建议在 codex 相关文档登记一条「换机器/换网络先跑一次 tool-required 冒烟」的判据（本次的复现命令即该冒烟）。
