# Verdict 契约（判定族）—— 四档 prompt 的公共层权威

> **本档的规范性纪律**：以下每一句引述都与四个 advisor 档**逐字一致**，由
> `test/prompt-contract.test.mjs` 双向锁死。改任何一处必须同时改本档——反之，改本档也会让
> 测试红。**本档不减少任何字节，它把「一致性」变成可机检的。**

> **维护路径**（设计档 D-PC5 / 评审轮次 1 的 #10）：本档 §③ 的四段快照在 **stage 1 首版**
> 由**程序抽取写入**（禁手打——一次性引入上百个字符级偏差的风险）；抽取脚本**不入库**
> （入库 = 把 603 行语料再复制一份）。**日常维护 = 「手工改 + 锁纠错」**：spec 或档任一侧手改，
> 另一侧没跟上就红，红了再手改对齐。**「禁手打」只在首版成立**——后续维护允许手改，
> 因为**锁本身就是纠错器**。

> **本档不参与装载**（设计档 D-PC4 / N-3）：它是 `lib/prompts/` 下的**资产旁文档**，
> `lib/prompts.mjs` 永不装载它（库里无目录扫描；机验锚 C6 断言 `prompts.mjs` 源码不含本档名）。
> **EOL 契约（环境无关 —— 审计 #2 的 F2 修复）**：机验锚 C9 断言两件与**存储形态无关**的事：
> ① 任一档**同档内不混用** EOL；② 本档与四个 advisor 档的 EOL 约定**一致**——同为 CRLF 或
> **同为 LF 皆可**，不许一半一半。**不**钉「一律 CRLF」：本仓**无 `.gitattributes`**，提交进库的
> blob 是 LF，工作树是否为 CRLF 只取决于本机 `core.autocrlf`——钉死某种形态会让断言在
> `autocrlf=false`（git 默认）的克隆上**于一个字节未改的仓库上变红**（违目标 G6 / §9-6）。
> **「逐字」的含义** = 除行尾符外逐字符相同（比对前两侧各做一次 `\r\n` → `\n` 归一，
> 归一的是行尾而不是内容）。

## ① 契约字面（宿主机械解析，只追加不替换）

宿主解析点 = `VERDICT_LINE_RE`（`lib/advisor.mjs`）——**代码单点、文本四处**。以下四行在四个
advisor 档里**逐字节相同**（父侧实测：四档全档**非空行**交集的全部内容 = 4 行）。围栏仅为呈现：
引文本身逐字引自四档（由 stage-1 抽取脚本写入，非手打），四档才是权威字节。

```text
## Verdict Line (machine-readable — REQUIRED)
End your **final reply** with one verdict line, as the **last non-empty line**:
- Tolerated: leading whitespace, `**` around the whole line, **one** trailing period, CRLF. Nothing may follow the verdict line — no text, no summary, no code fence below it.
- A malformed or misplaced verdict line (e.g. `VERDICT: MAYBE`, two verdict lines, a verdict line followed by more text) counts as a **refused** verdict — the host neither guesses nor falls back to the prose heuristic. A refused verdict is never treated as an absent one: the host never falls back to guessing, and no token is issued.
```

> 定位谓词（行首前缀，四档各**恰 1 次**）：`## Verdict Line (machine-readable` ·
> `End your **final reply** with one verdict` · `- Tolerated: leading whitespace` ·
> `- A malformed or misplaced verdict line`。

上述四行之外的文本**四档不等长**（块大小 round1 11 行 / round2 10 / round3 10 / design 17，
按 §2.1 父侧实测口径）——带意差异见 §②，`design` 独有两条见 §⑤.1。

## ② 差异表（带意差异，登记 ≠ 待修）

<!-- DIFF:pass-criterion --> 三版 PASS 判据句（round1 / round2≡round3 / design）
<!-- DIFF:fail-criterion --> 两版 FAIL 判据句（rounds / design 短版）
<!-- DIFF:never-translate --> `Never translate` 行的 3:1 措辞差
<!-- DIFF:design-only    --> design 独有两条（host 拒签发 / plain 🟡🔵 不阻塞）

**登记 ≠ 待修**（设计档 D-PC3 / 裁定 J3）：它们都是**判定边界文本**。统一任一措辞 = **替换**
2/3 份 ⇒ 违反批 7 纪律 3「判定族字面只追加、绝不替换」。要合法地统一三版判据句，必须同时做
**三件事**：改四档 + 改本档 §③ 快照 + **改测试里的指纹常量**，并删/改「三版必须互不相同」的
负向锁——那是一组**可见、可评审**的动作，而不是一次静默的「顺手统一」（设计档 §9-4）。

**四类差异**（与上面四个 `DIFF` 哨兵一一对应）：

1. **PASS 判据句三版**（round1 / round2≡round3 / design）——实测 3 版。
2. **FAIL 判据句两版**（round1≡round2≡round3 / design 短版）。
3. **`Never translate this token.` 行的 3:1 措辞差**（见 §⑤.2）。
4. **`design` 独有两条**（见 §⑤.1）。

## ③ 四档逐字快照（程序抽取写入）

> 切片谓词：从各档 `## Verdict Line` 起 **切到档尾**（实测四档该节**都是最后一节**，其后无 `##`
> 级标题——由 AC-8 断言）。**尾换行契约**（设计档 §6.2）：块**保留尾换行**，故本档快照载荷
> **同样保留**——闭哨兵写在**独立一行**且快照输入末尾**无换行**时，捕获到的载荷恰等于块。
> 两侧不对称会让双向锁**恒红**。

> **组件② 的口径（审计 #3 / 父侧裁定）**：测试里的 `BLOCK_SHA256` 指纹 = `sha256Hex(lf(block))`，
> 即对 **EOL 归一后**的块内容求哈希——与组件①的逐字比较**同一口径**（组件①也比对 `lf()` 后的
> 文本）。故它钉的是「**归一后的块内容**」，**不是**文件的存储形态：同一块内容无论以 CRLF 还是
> LF 落地，指纹相同。别把它读成「源档字节不变」——那在 CRLF / LF 之间会自相矛盾。

<!-- SNAPSHOT:advisor-round1.md -->
## Verdict Line (machine-readable — REQUIRED)

End your **final reply** with one verdict line, as the **last non-empty line**:

`VERDICT: PASS` — you found no blocking issue (no unresolved 🔴, and no `🟡 must-fix` row).
`VERDICT: FAIL` — at least one unresolved 🔴 row, or a `🟡 must-fix` row, remains.

- **Never translate this token.** Reply in the conversation's language, but the words `VERDICT`, `PASS` and `FAIL` stay exactly as written — the line is parsed literally.
- Tolerated: leading whitespace, `**` around the whole line, **one** trailing period, CRLF. Nothing may follow the verdict line — no text, no summary, no code fence below it.
- A malformed or misplaced verdict line (e.g. `VERDICT: MAYBE`, two verdict lines, a verdict line followed by more text) counts as a **refused** verdict — the host neither guesses nor falls back to the prose heuristic. A refused verdict is never treated as an absent one: the host never falls back to guessing, and no token is issued.
- The verdict line is the single place that must carry this signal: do not bury the conclusion in prose only.
<!-- /SNAPSHOT:advisor-round1.md -->

<!-- SNAPSHOT:advisor-round2.md -->
## Verdict Line (machine-readable — REQUIRED)

End your **final reply** with one verdict line, as the **last non-empty line**:

`VERDICT: PASS` — no blocking issue remains (no unresolved 🔴, and no `🟡 must-fix` row).
`VERDICT: FAIL` — at least one unresolved 🔴 row, or a `🟡 must-fix` row, remains.

- **Never translate this token.** Reply in the conversation's language, but the words `VERDICT`, `PASS` and `FAIL` stay exactly as written — the line is parsed literally.
- Tolerated: leading whitespace, `**` around the whole line, **one** trailing period, CRLF. Nothing may follow the verdict line — no text, no summary, no code fence below it.
- A malformed or misplaced verdict line (e.g. `VERDICT: MAYBE`, two verdict lines, a verdict line followed by more text) counts as a **refused** verdict — the host neither guesses nor falls back to the prose heuristic. A refused verdict is never treated as an absent one: the host never falls back to guessing, and no token is issued.
<!-- /SNAPSHOT:advisor-round2.md -->

<!-- SNAPSHOT:advisor-round3.md -->
## Verdict Line (machine-readable — REQUIRED)

End your **final reply** with one verdict line, as the **last non-empty line**:

`VERDICT: PASS` — no blocking issue remains (no unresolved 🔴, and no `🟡 must-fix` row).
`VERDICT: FAIL` — at least one unresolved 🔴 row, or a `🟡 must-fix` row, remains.

- **Never translate this token.** Reply in the conversation's language, but the words `VERDICT`, `PASS` and `FAIL` stay exactly as written — the line is parsed literally.
- Tolerated: leading whitespace, `**` around the whole line, **one** trailing period, CRLF. Nothing may follow the verdict line — no text, no summary, no code fence below it.
- A malformed or misplaced verdict line (e.g. `VERDICT: MAYBE`, two verdict lines, a verdict line followed by more text) counts as a **refused** verdict — the host neither guesses nor falls back to the prose heuristic. A refused verdict is never treated as an absent one: the host never falls back to guessing, and no token is issued.
<!-- /SNAPSHOT:advisor-round3.md -->

<!-- SNAPSHOT:advisor-design.md -->
## Verdict Line (machine-readable — REQUIRED)

End your **final reply** with one verdict line, as the **last non-empty line**:

`VERDICT: PASS` — no 🔴 issue remains (the design may be approved).
`VERDICT: FAIL` — at least one 🔴 issue remains.

- **Never translate this token.** Reply in the conversation's language, but the words `VERDICT`, `PASS` and `FAIL` stay exactly as written — the host parses this line literally.
- Tolerated: leading whitespace, `**` around the whole line, **one** trailing period, CRLF. Nothing may follow the verdict line — no text, no summary, no code fence below it.
- A malformed or misplaced verdict line (e.g. `VERDICT: MAYBE`, two verdict lines, a verdict line followed by more text) counts as a **refused** verdict — the host neither guesses nor falls back to the prose heuristic. A refused verdict is never treated as an absent one: the host never falls back to guessing, and no token is issued.
- The host additionally refuses to issue a token when the table still contains an unresolved blocking row (a 🔴 severity cell, or a `🟡 must-fix` cell) — a `VERDICT: PASS` that contradicts your own table is rejected.
- A plain 🟡 or 🔵 row never blocks: `VERDICT: PASS` stays valid with advisory findings listed.

Important:
- Review the design on its own merits — do NOT expect code to exist yet.
- Read the design document fully. If a ## Project Standards section is present in the review context, it defines the project's standards — apply it.
- Do NOT run git diff or look for code changes — there are none at this stage.
<!-- /SNAPSHOT:advisor-design.md -->

## ④ 出现点地图

改任何一个判定族字面之前，先看这张地图——它是设计档图 2 的可执行版本，也是批 7 纪律 ②
「改了引用点要改所有副本」的可执行清单化（需求档 US-5）：

| 面 | 出现点 | 数量 | 既有锁 |
|---|---|---|---|
| 判定契约块（`## Verdict Line` 起至档尾） | `lib/prompts/advisor-round1.md` · `lib/prompts/advisor-round2.md` · `lib/prompts/advisor-round3.md` · `lib/prompts/advisor-design.md` | 四档各 1 节 | `AC-V13` / `AC-V13b`（`test/preset-static.test.mjs`，**读裸档字节**，不走 `prompts.mjs`） |
| 宿主机械解析点 | `VERDICT_LINE_RE`（`lib/advisor.mjs`）——**契约单点** | 1 | `AC-V13` 族（四档各含字面 + `refused` + never falls back） |
| `must-fix` 例外句 | 四档各 1 处 + `lib/advisor-msgs.mjs` 2 处 | 全族 6 | `AC-V13b`（四档各恰 1 + msgs 恰 2） |
| 次序句 `immediately ABOVE the` | `lib/prompts/advisor-design.md` 1 处 + `lib/advisor-msgs.mjs` 2 处 | 全族 3 | —（本批只登记） |
| 本档（公共层 spec） | `lib/prompts/verdict-contract.md` | 1 | `test/prompt-contract.test.mjs`（双向锁 + `BLOCK_SHA256` 指纹：钉的是 **EOL 归一后**的块内容，非文件存储形态） |

**第二重复轴（`advisor-msgs.mjs`）本批不动**（设计档 D-PC8 / 裁定 J6）：它不在「提示词公共层」
面内，把它拉进来会让本批从「提示词一致性」扩成「判定族单点化」（另立批次）。本批只登记。

## ⑤ 已存在的漂移登记

| # | 级别 | 内容 | 处置 |
|---|---|---|---|
| **R-10** | 🔵 | `Never translate this token.` 行的 **3:1 措辞差**（见 §⑤.2） | **登记，不修**——修则违「判定族字面只追加」。父侧裁定：**不是错**，design 评审的 verdict 由**宿主**核验 echo 码并注入令牌，该写法在**它自己的语境**里更精确 |
| **R-11** | 🔵 | 判定族的**出现点分布**（`must-fix` 例外句全族 6 处 / 次序句全族 3 处，见 §④），与 `VERDICT_LINE_RE` 构成「**契约单点 + 文本多处**」结构 | 本批只做 §④ 的出现点地图，**不做单点化** |
| **R-12** | 🔵 | 吸收清单 `COMMON-LAYER` 行记的重复症状（`engineering.md:173-174` 重复标题）**已实测陈旧**：该处无重复标题；全库提示词唯一的跨档重复标题就是 `## Verdict Line` 这 4 条 | 在本档更正该记载 |

### ⑤.1 `design` 档独有两条（差异，**非**漂移）

- The host additionally refuses to issue a token when the table still contains an unresolved blocking row (a 🔴 severity cell, or a `🟡 must-fix` cell) — a `VERDICT: PASS` that contradicts your own table is rejected.
- A plain 🟡 or 🔵 row never blocks: `VERDICT: PASS` stays valid with advisory findings listed.

这两条只存在于 `advisor-design.md`：① 表格仍有未决阻断行（🔴 或 `🟡 must-fix`）时宿主**拒发**
令牌；② 纯 🟡/🔵 行**不阻塞**。它们是 design 评审独有的判定边界，**原地保留**（裁定 J3）。

### ⑤.2 `Never translate this token.` 行的两版（3:1）

**版本 A（`advisor-round1.md` / `advisor-round2.md` / `advisor-round3.md`，3 次）**：

- **Never translate this token.** Reply in the conversation's language, but the words `VERDICT`, `PASS` and `FAIL` stay exactly as written — the line is parsed literally.

**版本 B（`advisor-design.md`，1 次）**：

- **Never translate this token.** Reply in the conversation's language, but the words `VERDICT`, `PASS` and `FAIL` stay exactly as written — the host parses this line literally.

> 父侧裁定（纪要 §2.2 第 4 条）：这**不是错**、也**不是待修的漂移**——round1 自述 code review 的
> 判定行是 *machine-readable to the caller*，而 design 评审的 verdict 由**宿主**核验，故 `design`
> 的写法在它自己的语境里更精确。**一律原地保留**。

