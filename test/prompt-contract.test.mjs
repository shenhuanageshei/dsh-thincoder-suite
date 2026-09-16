// prompt-contract.test.mjs —— 批 8（提示词公共层·裁减版）**新增**测试档。
// 设计档：docs/2026-09-13-prompt-common-design.md
//   §6.1 spec 档结构 · §6.2 双向锁测试（逐字伪代码）· §8.1 零改面 · §8.2 机验锚 C1…C10
//   · §9 边界 · §10.1 写域 · §10.2 验收 AC-1…AC-12（+ AC-5b/7b/7c/9b）
// 需求档：docs/2026-09-13-prompt-common-requirements.md（US-1…US-7 / N-1…N-6）
// 本批形态 = **零改面**：四个 advisor 提示词与 lib/prompts.mjs 一律**零字节改动**；
//   本档是**新增**档（建于基线 9282882 之后 ⇒ T-AP9 不管它），只需在 test/guard-e.test.mjs
//   的 T-E19 清单按**登记制**追加一行（用户裁定 J8）。
// 纪律：零网络、零真实 LLM；只读文件 + 纯函数。SHA-256 复用本仓唯一实现点
//   lib/doc-hash.mjs 的 sha256Hex（零新依赖，N-5）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { sha256Hex } from "../lib/doc-hash.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const PROMPTS_DIR = join(PLUGIN_DIR, "lib", "prompts")
const SPEC_PATH = join(PROMPTS_DIR, "verdict-contract.md")
const SPEC = readFileSync(SPEC_PATH, "utf8")
const ADVISOR_PROMPTS = ["advisor-round1.md", "advisor-round2.md", "advisor-round3.md", "advisor-design.md"]

/** EOL 归一（只归行尾，不动内容）——设计档 §6.2 的 EOL 口径（评审 #4）。 */
const lf = (s) => s.replace(/\r\n/g, "\n")

/** 从某档切出判定契约块：'## Verdict Line' 起 → 档尾。 */
function verdictBlockOf(text) {
  const i = lf(text).indexOf("## Verdict Line")
  assert.ok(i >= 0, "该档缺 ## Verdict Line 标题")
  return lf(text).slice(i)
}

/** 从 spec 取出某档快照（哨兵之间）——正则匹配，容忍 CRLF。
 *  ★评审轮次 2 的 #3：**不剥尾换行**——`verdictBlockOf` 用 `slice(i)` 保留块的尾换行，
 *  故快照载荷必须**同样保留**；两侧不对称会让 AC-3/4 **恒红**。
 *  规范 = `/SNAPSHOT:… -->` 写在**独立一行**且输入末尾**无换行** ⇒ 捕获到的载荷
 *  恰好等于 `block`（末行的 CRLF 落在闭哨兵之前）。 */
function snapshotOf(spec, name) {
  const re = new RegExp("<!-- SNAPSHOT:" + name + " -->\\r?\\n([\\s\\S]*?)<!-- /SNAPSHOT:" + name + " -->")
  const m = lf(spec).match(re)
  assert.ok(m, name + " 在 spec 里缺快照哨兵（或未闭合）")
  return m[1] // ★不 replace(/\n$/,"") —— 与 verdictBlockOf 的尾换行契约对齐
}

/** 某档的判定契约块（LF 归一后）——断言与指纹的统一读取口径。 */
const blockOf = (name) => verdictBlockOf(readFileSync(join(PROMPTS_DIR, name), "utf8"))

/** 裸 LF 计数（AC-9b / 机验锚 C9）：CRLF 之外单独的 `\n`。 */
const bareLfCount = (s) => (s.match(/\n/g) || []).length - (s.match(/\r\n/g) || []).length

/** CRLF 计数。 */
const crlfCount = (s) => (s.match(/\r\n/g) || []).length

/** 某档的 EOL 约定（**环境无关**口径）：出现过 CRLF ⇒ "CRLF"，否则 "LF"。
 *  它**不**要求某种具体约定，只供 AC-9b 断言「五档一致」。 */
const eolKindOf = (s) => (crlfCount(s) > 0 ? "CRLF" : "LF")

/** 该 readdir 调用的实参是否指向**本目录（prompts/）**——AC-10 的收窄谓词（审计 #4）。
 *  触发面三类：`PROMPTS_DIR` · 字面目录名 `"prompts"` / `'prompts'` · 实参**就是**装载器
 *  自身目录 `__dirname`（prompts 目录的父目录，唯一相关形态）。无关用途的扫描（如扫 docs/）
 *  不再触发本闸。 */
const scansPromptsDir = (arg) => {
  const a = arg.trim()
  if (/^__dirname\s*$/.test(a)) return true
  return /\bPROMPTS_DIR\b/.test(a) || /\bprompts\b/i.test(a)
}

// ═══════════════════════ AC-1：spec 档存在且五节齐全 ═══════════════════════

test("AC-1: lib/prompts/verdict-contract.md 存在且五节齐全（US-1 的「一处权威可查」）", () => {
  const SECTIONS = [
    "## ① 契约字面（宿主机械解析，只追加不替换）",
    "## ② 差异表（带意差异，登记 ≠ 待修）",
    "## ③ 四档逐字快照（程序抽取写入）",
    "## ④ 出现点地图",
    "## ⑤ 已存在的漂移登记",
  ]
  const flat = lf(SPEC)
  let prev = -1
  for (const s of SECTIONS) {
    const at = flat.indexOf(s)
    assert.ok(at > prev, s + " 必须存在且按 ①→⑤ 顺序出现（index=" + at + "）")
    prev = at
  }
})

// ═══════════════════ AC-2：本档登记进 docs/README.md（US-1 的后半句） ═══════════════════

test("AC-2: lib/prompts/verdict-contract.md 已登记进 docs/README.md 文档地图", () => {
  const readme = readFileSync(join(PLUGIN_DIR, "docs", "README.md"), "utf8")
  assert.ok(readme.includes("verdict-contract"), "文档地图必须登记本档（既有纪律：新建文档必须先登记）")
  assert.ok(readme.includes("](../lib/prompts/verdict-contract.md)"),
    "登记行必须按既有行的形态链接到本档（相对 docs/ 的路径）")
})

// ═══════════ AC-3 / AC-4 / AC-7c：组件①（双向逐字一致）+ 哨兵集合 ═══════════
// 失败类 A：档里改了 / spec 没跟上；失败类 B：spec 里改了 / 档没跟上。同一断言两向都报。

test("AC-3/AC-4: 组件①——spec 快照 ↔ 四档块逐字符相等（一次相等，两类失败）", () => {
  for (const name of ADVISOR_PROMPTS) {
    const block = blockOf(name)
    assert.equal(snapshotOf(SPEC, name), block, name + " 的判定契约块与 spec 快照不一致")
  }
})

test("AC-7c: spec 的 SNAPSHOT 哨兵集合恰为四个 advisor 档（无第五个、无重复）", () => {
  const names = [...lf(SPEC).matchAll(/<!-- SNAPSHOT:([^>]+?) -->/g)].map((m) => m[1])
  assert.deepEqual([...names].sort(), [...ADVISOR_PROMPTS].sort(),
    "spec 的 SNAPSHOT 哨兵集合必须恰为四个 advisor 档（无第五个、无重复）")
})

// ═════════════ AC-7b：组件②——四档 Verdict 块的 sha256 指纹常量 ═════════════
// ★硬编码常量：把「判定契约块**归一后**的内容」变成机械事实。协同改（prompt + spec 快照一起
// 改）在组件①下能全绿，但会撞这里 ⇒ 红。刻意更新指纹是**可见动作**（改常量即改测试）。
// ★口径（审计 #3 / 父侧裁定）：指纹 = `sha256Hex(lf(block))`，即对 **EOL 归一后**的块内容求
// 哈希——与组件①的逐字比较**同一口径**（组件①也比 `lf()` 后的文本）。它钉的是「**归一后的
// 块内容**」，**不是**文件的存储形态：同一块内容无论以 CRLF 还是 LF 落地，指纹相同（故它**不**
// 声称「源档字节不变」——那在 CRLF / LF 之间会自相矛盾）。

const BLOCK_SHA256 = {
  "advisor-round1.md": "94baf37666b29d11453093c10d4e11241a9267a262f2a5387de4badb88c3fa9c",
  "advisor-round2.md": "9f284ad0db2b2b6f7fd7b06ba8fe5f4a59bff85052a887a92e15266b56c77260",
  "advisor-round3.md": "9f284ad0db2b2b6f7fd7b06ba8fe5f4a59bff85052a887a92e15266b56c77260",
  "advisor-design.md": "8fc2397186c8aba236c4cf65ef8a79026b1ce037ebeebd0129f79ff1f34f1bfa",
}

test("AC-7b(#2): 组件②——四档判定契约块**EOL 归一后**内容的 sha256 指纹", () => {
  for (const name of ADVISOR_PROMPTS) {
    const block = blockOf(name)
    assert.equal(sha256Hex(block), BLOCK_SHA256[name],
      name + " 的判定契约块**归一后**内容已变（归一后块内容不变是本批闸的框架；EOL 落地形态不影响本指纹）——若确为刻意，请同步更新本指纹常量")
  }
})

// ═══════════════════ AC-6：不变式（带**定位谓词**，防 tautology） ═══════════════════

const SHARED_PREFIXES = [
  "## Verdict Line (machine-readable",          // 块标题
  "End your **final reply** with one verdict",  // 引导句
  "- Tolerated: leading whitespace",            // 容忍形
  "- A malformed or misplaced verdict line",    // 拒签形
]

test("AC-6: 不变式 1——四向逐字共享行 = 恰 4 行，各档恰 1 次且四档逐字相同", () => {
  for (const p of SHARED_PREFIXES) {
    const lines = ADVISOR_PROMPTS.map((n) => blockOf(n).split("\n").filter((l) => l.startsWith(p)))
    assert.deepEqual(lines.map((a) => a.length), [1, 1, 1, 1], p + " 必须在四档各恰出现一次")
    assert.equal(new Set(lines.map((a) => a[0])).size, 1, p + " 在四档必须**逐字相同**（同一行字面）")
  }
})

test("AC-6: 不变式 2——Never-translate 行恰两版、其一出现 3 次（3:1 带意差异）", () => {
  const NT_PREFIX = "- **Never translate this token.**"
  const nts = ADVISOR_PROMPTS.map((n) =>
    blockOf(n).split("\n").find((l) => l.startsWith(NT_PREFIX)) ?? "")
  assert.ok(nts.every((l) => l !== ""), "四档都必须有 Never-translate 行")
  assert.equal(new Set(nts).size, 2, "Never-translate 行应恰有两版（3:1）")
  assert.equal(nts.filter((l) => l === nts[0]).length, 3, "其中一版应恰出现 3 次（3:1 的 3）")
  // 3:1 的那一份「1」= advisor-design.md（登记 R-10：它写 `the host parses this line literally`）
  assert.notEqual(nts[0], nts[3], "3:1 的少数版必须是 advisor-design.md（R-10 的登记对象）")
})

test("AC-7: 负向锁（不变式 3）——三版 PASS 判据句互不相同（防「顺手统一」）", () => {
  const passLines = ADVISOR_PROMPTS.map((n) =>
    blockOf(n).split("\n").find((l) => l.trimStart().startsWith("`VERDICT: PASS`")) ?? "")
  assert.ok(passLines.every((l) => l !== ""), "四档都必须有 PASS 判据句")
  assert.equal(new Set(passLines).size, 3, "PASS 判据句应恰有三版（round1 / round2≡round3 / design）")
})

test("AC-8: 不变式 4——块以档尾结束（切片谓词的正确性前提）", () => {
  for (const n of ADVISOR_PROMPTS) {
    const t = lf(readFileSync(join(PROMPTS_DIR, n), "utf8"))
    const i = t.indexOf("## Verdict Line")
    assert.ok(i >= 0, n + " 缺 ## Verdict Line")
    assert.ok(!/^## /m.test(t.slice(i + 1)), n + " 的 Verdict 块之后不得再有 ## 级标题（切片前提）")
  }
})

// ═══════════════ AC-5：差异表**可判定**（ID 化哨兵，不是关键词 grep） ═══════════════

const DIFF_IDS = ["pass-criterion", "fail-criterion", "never-translate", "design-only"]

test("AC-5: spec 内 `<!-- DIFF:` 哨兵恰 4 个且 id 集合恰为四类（评审 #5）", () => {
  const ids = [...lf(SPEC).matchAll(/<!-- DIFF:\s*([^>\s]+)\s*-->/g)].map((m) => m[1])
  assert.equal(ids.length, 4, "差异表的 DIFF 哨兵必须恰 4 个，实得 " + ids.length)
  assert.deepEqual([...ids].sort(), [...DIFF_IDS].sort(), "DIFF 哨兵 id 集合必须恰为那四个")
})

// ═══════════════ AC-5b：出现点地图**有内容**（US-5，机验锚 C8） ═══════════════

test("AC-5b: spec 第 ④ 节（出现点地图）含 VERDICT_LINE_RE / advisor-msgs.mjs / AC-V13 / AC-V13b / 四个档名", () => {
  const flat = lf(SPEC)
  const a = flat.indexOf("## ④ 出现点地图")
  assert.ok(a >= 0, "缺第 ④ 节标题")
  const b = flat.indexOf("## ⑤ ", a)
  assert.ok(b > a, "第 ④ 节之后必须有第 ⑤ 节（否则切片不可界定）")
  const map = flat.slice(a, b)
  for (const anchor of ["VERDICT_LINE_RE", "advisor-msgs.mjs", "AC-V13", "AC-V13b", ...ADVISOR_PROMPTS]) {
    assert.ok(map.includes(anchor), "第 ④ 节缺出现点锚：" + anchor)
  }
})

// ═══════════ AC-9b / AC-10：EOL 契约（C9）与装载路径零接入（C6） ═══════════
// ★审计 #2 的 F2 修复：EOL 契约改为**环境无关**。本仓**无 `.gitattributes`**，提交进库的 blob
// 是 LF，工作树之所以是 CRLF 只因本机 `core.autocrlf=true` ⇒ 原「裸 LF 计数 = 0（全 CRLF）」
// 断言会在 `autocrlf=false`（git 默认）的克隆上**于一个字节未改的仓库上变红**——那是新增的
// 环境依赖失败面（违本批目标 G6「零新增启动期失败面」/ 设计档 §9-6「无 git 的机器」）。
// 改钉两件与**存储形态无关**的事：① 同档内不混用 EOL；② spec 与四档的 EOL 约定一致。

test("AC-9b(C9): EOL 契约（环境无关）——① 同档内不混用 EOL ② spec 与四档 EOL 约定一致", () => {
  const targets = [SPEC_PATH, ...ADVISOR_PROMPTS.map((n) => join(PROMPTS_DIR, n))]
  const text = new Map(targets.map((f) => [f, readFileSync(f, "utf8")]))

  // ① 同档内不混用：一档内 `\r\n` 与孤立的 `\n` 不得同时存在。
  for (const [f, s] of text) {
    assert.ok(!(crlfCount(s) > 0 && bareLfCount(s) > 0),
      f + " 同档内混用了 EOL（CRLF " + crlfCount(s) + " 处 + 裸 LF " + bareLfCount(s) + " 处）")
  }

  // ② 跨档一致：五档同为 CRLF 或同为 LF（不许一半一半）——同 CRLF / 同 LF 两种约定都合法。
  const kinds = targets.map((f) => eolKindOf(text.get(f)))
  assert.equal(new Set(kinds).size, 1,
    "spec 与四档的 EOL 约定必须一致（同为 CRLF 或同为 LF）：" +
    targets.map((f, i) => f + "=" + kinds[i]).join(" / "))
})

test("AC-10(C6): lib/prompts.mjs 源码不含 verdict-contract（spec 永不进装载路径）", () => {
  const src = readFileSync(join(PLUGIN_DIR, "lib", "prompts.mjs"), "utf8")
  assert.ok(!src.includes("verdict-contract"), "装载器不得引用本档（D-PC4 / N-3）")
  // D-PC4 的前提「库里无 `prompts` 目录扫描」的机械化——**收窄**（审计 #4）：
  // 原谓词 `/\breaddir(Sync)?\s*\(/` 是**整档一刀切**——将来 prompts.mjs 里任何**无关用途**
  // 的 readdir 都会让它红，而它又从未证明扫的是 prompts 目录（不精确 ⇒ 假阳性失败面）。
  // 现只拦「扫**本目录**（prompts/）」的 readdir 调用。
  const scans = [...src.matchAll(/\breaddir(?:Sync)?\s*\(([^)]*)/g)]
    .map((m) => m[1])
    .filter(scansPromptsDir)
  assert.deepEqual(scans, [], "装载器不得扫描 prompts 目录（D-PC4 的前提）——实得：" + JSON.stringify(scans))
})

// ═══════ AC-7b（自指面，机验锚 C7）：本档**同时**含组件①与组件② ═══════
// 缺任一即红的持久形态：断言本档源码（**剔除本用例自身与其后的文本**，避免自证）
// 同时含组件①的相等断言与组件②的指纹常量 + sha256Hex 比对。

test("AC-7b(C7): 本档同时含组件①（逐字相等）与组件②（BLOCK_SHA256 + sha256Hex），缺任一即红", () => {
  const SELF_PATH = fileURLToPath(import.meta.url)
  const src = readFileSync(SELF_PATH, "utf8")
  const cut = src.indexOf("AC-7b(C7): 本档同时含组件①")
  assert.ok(cut > 0, "自指切片点必须可定位")
  const body = src.slice(0, cut)
    .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n")
  assert.ok(body.includes("BLOCK_SHA256"), "组件②缺失：无 BLOCK_SHA256 指纹常量")
  assert.ok(body.includes("sha256Hex(block)"), "组件②缺失：无 sha256Hex 比对")
  assert.ok(body.includes("assert.equal(snapshotOf(SPEC, name), block"), "组件①缺失：无 spec↔档逐字相等断言")
})
