// doc-hygiene.test.mjs — 批 11：DOC-HYGIENE 的机械层（D6「回读核对」的一般规则 → 机械网）。
// 设计档：docs/2026-09-13-doc-discipline-design.md
//   §6.4 两项机械检查（U+FFFD 全仓 + 常设档 canary）· §8.2 机验锚 V1…V14 · §11 本批**不可真机验证**清单（未重启 DSH）
//   §8.1-8 六串锁的权威作用域（`lib/**` 内命中 = 0）· §6.1 冻结交付文本 · §6.2 失败后缀块
//
// 本档四项用例（顶层 `test(` 数 = 4，台账 docs/test-lifecycle.md §三 同数）：
//   ① U+FFFD 全仓扫描（锚 V13）
//   ② 常设档 canary（锚 V14）+ 规范层形状与纪律（锚 V1/V2/V3/V4——按 §6.4 的「并入既有 test() 块」）
//      + **登记完备（批 13 / R-25 / AC-14·AC-15 / 锚 V8——同走「并入既有块」，故顶层 test() 数仍为 4）**
//   ③ 批 11 新文本六串负向（锚 V5）+ 正向锚与划界（锚 V10 / V11② / V12②/③）
//   ④ 失败后缀块与出口边界（锚 V6 / V7 / V8）
//
// ★ 本档自身的六串洁净：本档**必须**点名常设标准档档名与那六串禁字，故一律用**拼接写法**
//   （批 9 的 `has` + `Git` 先例）——直写会让本档自己命中 V5 的逐文件负向 grep。
// ★ 本档的 V5 腿按 **§8.1-8 的权威判据**（`lib/**` 内六串命中 = 0）落实；设计档 §8.2 V5 的
//   文件清单还列了常设标准档的**新子节**，该腿**不可满足**（§6.1 的冻结 D1 行逐字含
//   「**常设标准档**（`METHOD`+`OLOGY.md`，含本节）」自指自身档名）⇒ 该冲突如实登记在交付报告，
//   本档**不**静默改写 §6.1、也不删除 V5 的清单。
// ★ 本档是纯 fs 断言（零网络 / 零 spawn / 零长等待）；唯一的行为面是 ④ 里对 runEngCoder 的
//   一次**进程内**调用（stub 子代理）——它验的是返回**字串构造**，不是真机行为（§11-2 不可验）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, extname, join, relative, resolve } from "node:path"
import { runEngCoder } from "../lib/eng.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"

// 隔离契约（对齐既有测试档）：空串 = 显式无 env → 落盘只走 override 临时目录。
process.env.DSH_HOME = ""

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
/** 常设标准档档名（拼接写法：直写会让本档自己命中六串负向扫描）。 */
const STANDARDS_DOC = "METHOD" + "OLOGY.md"
/** 扫描面：根 + `docs/` + `lib/` + `test/` 的文本扩展名（§6.4；排除 `.git`）。 */
const SCAN_EXT = new Set([".md", ".mjs", ".js", ".json", ".txt"])

const read = (rel) => readFileSync(join(PLUGIN_DIR, rel), "utf8")
const lf = (t) => t.split(/\r?\n/).join("\n")

/** 递归收集某目录下的文本档（仓库相对路径，POSIX 分隔符；跳过 .git / node_modules）。 */
function walkText(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walkText(full, out)
    else if (SCAN_EXT.has(extname(e.name))) out.push(relative(PLUGIN_DIR, full).split("\\").join("/"))
  }
  return out
}

/** §6.4 的扫描面：根目录（非递归）+ `docs/` / `lib/` / `test/`（递归）。 */
function scanFiles() {
  const out = []
  for (const e of readdirSync(PLUGIN_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() && SCAN_EXT.has(extname(e.name))) out.push(e.name)
  }
  for (const d of ["docs", "lib", "test"]) out.push(...walkText(join(PLUGIN_DIR, d)))
  return out.sort()
}

/** U+FFFD 谓词（纯函数，读取器注入以便谓词自证）。 */
const fffdCount = (text) => (text.match(/\uFFFD/g) ?? []).length
function fffdViolations(files, loader = read) {
  const bad = []
  for (const f of files) {
    const n = fffdCount(loader(f))
    if (n > 0) bad.push(f + " → " + n)
  }
  return bad
}

// ═══════════════ ① U+FFFD 全仓扫描（锚 V13 / AC-13） ═══════════════

test("DOC-HYGIENE T1（锚 V13 / AC-13）: U+FFFD 全仓扫描——被跟踪文本零命中（零白名单）", () => {
  const files = scanFiles()
  assert.ok(files.length >= 80, "扫描面非空（实测 " + files.length + " 档）")
  // 扫描面覆盖自证（防「空集合假绿」——与 release-check G0「扫描面为空 = 假绿」同律）
  for (const probe of [STANDARDS_DOC, "docs/README.md", "docs/test-lifecycle.md", "lib/eng.mjs", "test/fixtures/coder-brief-with-docs.txt"]) {
    assert.ok(files.includes(probe), "扫描面必须覆盖 " + probe + "（实测 " + files.length + " 档）")
  }
  // 谓词自证：先证明谓词**能命中**，否则「零命中」什么也没证明（律 3 的合成行自证同族）
  assert.deepEqual(fffdViolations(["synth-bad"], () => "ok \uFFFD bad"), ["synth-bad → 1"], "谓词自证：注入一个 U+FFFD ⇒ 必判违规")
  assert.deepEqual(fffdViolations(["synth-clean"], () => "clean text"), [], "谓词自证：洁净文本 ⇒ 零违规")
  // 事实底座：落地时点全仓实测 = 0（§6.4：「为 0 则零白名单直锁」）⇒ 无需任何豁免
  assert.deepEqual(fffdViolations(files), [], "被跟踪文本必须零 U+FFFD（有命中则该档/Fixture 必须精确豁免并写理由）")
})

// ═══════════════ ② 常设档 canary（锚 V14）+ 规范层（锚 V1–V4） ═══════════════

/** 五常设档的 canary 锚串（§8.2 V14 的逐档清单；每档 ≥1 个稳定顶层标题/表头行）。 */
const CANARY = [
  [STANDARDS_DOC, ["## 文档纪律", "## 工作流（四步 + 门禁）"]],
  ["docs/README.md", ["## 设计文档", "## 吸收面", "| 文档 | 日期 | 主题 |"]],
  ["docs/test-lifecycle.md", ["# 测试生命周期台账（活登记表）", "## 三、逐档处置行", "| 档名 | 用例数 | 层 | 处置 | 判据 | 理由 / 证据 |"]],
  ["docs/2026-09-12-absorption-inventory.md", ["## §2", "## §6"]],
  ["docs/2026-09-05-defect-registry.md", ["| ID | 主题 | 现象（一句话） | 根因状态（含证据） | 风险 | 轮次 | 状态 | 指针 | 触发 |"]],
]

/** canary 谓词（纯函数，读取器注入以便谓词自证）。返回违规描述列表。 */
function canaryViolations(docs, loader = read) {
  const bad = []
  for (const [file, anchors] of docs) {
    assert.ok(anchors.length >= 1, "canary 锚清单不得为空：" + file)
    const text = loader(file)
    for (const a of anchors) {
      if (!text.includes(a)) bad.push(file + " → 缺锚 " + JSON.stringify(a))
    }
  }
  return bad
}

/** 登记完备性（批 13 / R-25 / AC-14 · AC-15 · 锚 V8）：`docs/` 顶层 `*.md`（**非递归**；例外
 *  **恰一条** = 登记簿自身 `README.md`）必须全部以 `](name.md)` 的链接形态出现在 `docs/README.md`
 *  的**全文**里。
 *  ★ 口径一：must 扫**全文**——`handoff.md` 走「## 交接」bullet，**不在**两张表内 ⇒ 只解析两张表
 *    会**误报**。
 *  ★ 口径二：只认**纯文件名链接形态** `](name.md)`——带锚点/后缀的形态（如 `](x.md#sec)`）
 *    **不计**为已登记（今日域内无此形态 ⇒ 落地即绿；写明口径防将来假阴性）。
 *  ★ 域 = `docs/` **顶层**：子目录（今日无；`viz/` 及未来子目录）**天然在域外**，无需例外条目。 */
const unregisteredDocs = (readme, onDisk) =>
  onDisk.filter((f) => f !== "README.md" && !readme.includes("](" + f + ")"))

/** `docs/` 顶层 `*.md` 的 basename 清单（**非递归**）。 */
function docsTopLevel() {
  return readdirSync(join(PLUGIN_DIR, "docs"), { withFileTypes: true })
    .filter((e) => e.isFile() && extname(e.name) === ".md")
    .map((e) => e.name)
    .sort()
}

test("DOC-HYGIENE T2（锚 V14 + V1/V2/V3/V4 + 批 13 R-25 登记完备）: 常设档 canary（防截断为 1 行）+ 规范层零状态句 + 登记完备", () => {
  // —— V14 谓词自证：截断为 1 行的档**必须**被判违规（否则 canary 是恒真锁） ——
  const truncated = STANDARDS_DOC + "\n"
  assert.ok(canaryViolations([[STANDARDS_DOC, CANARY[0][1]]], () => truncated).length > 0,
    "谓词自证：截断为 1 行 ⇒ 必判违规")
  assert.deepEqual(canaryViolations([[STANDARDS_DOC, CANARY[0][1]]], (f) => read(f)), [],
    "阳性对照：真实档 ⇒ 零违规（canary 不是恒红断言）")
  // —— 事实断言：五个常设档逐个在位 ——
  assert.deepEqual(canaryViolations(CANARY), [], "五个常设档必须各含其顶层标题/表头锚")
  // README 的两张表表头行（§8.2 V14 的字面口径）
  const readme = read("docs/README.md")
  assert.ok(readme.split("| 文档 | 日期 | 主题 |").length - 1 >= 2,
    "docs/README.md 的两张表表头行都必须在位")

  // —— V1/V2/V3/V4：规范层新子节（§6.1 冻结交付文本） ——
  const md = read(STANDARDS_DOC)
  const L = md.split(/\r?\n/)
  const i0 = L.findIndex((l) => l === "### 文档更新纪律 D1–D7")
  assert.ok(i0 >= 0, "规范层新子节标题必须逐字在位（§6.1）")
  const i1 = L.findIndex((l, i) => i > i0 && /^#{2,3} /.test(l))
  const sub = L.slice(i0 + 1, i1 < 0 ? L.length : i1).join("\n")
  assert.ok(sub.length > 500, "子节切片非空且完好（实测 " + sub.length + " 字符）")

  // V1：七标签各**恰一次**且顺序精确
  const LABELS = ["**D1 写权矩阵**", "**D2 单一权威源**", "**D3 计数·枚举纪律**", "**D4 指针纪律**",
    "**D5 冻结窗口**", "**D6 回读核对**", "**D7 变更留痕**"]
  let prev = -1
  for (const lb of LABELS) {
    assert.equal(sub.split(lb).length - 1, 1, "V1：" + lb + " 必须恰出现一次")
    const at = sub.indexOf(lb)
    assert.ok(at > prev, "V1：标签必须按 D1…D7 顺序出现（" + lb + "）")
    prev = at
  }

  // V2：零状态句（精确词表）+ 零聚合计数句（必须是**数字字面**）
  const BANNED_WORDS = ["现有", "已有", "部分", "缺席", "已实现", "未实现", "已交付", "待评审", "已完成"]
  assert.deepEqual(BANNED_WORDS.filter((w) => sub.includes(w)), [], "V2：规范层零状态词命中")
  assert.deepEqual(sub.match(/[0-9０-９]+\s*[条处项]/g) ?? [], [],
    "V2：零聚合计数句（D3 自身的元变量写法 N 项/N 处/N 条 不是数字字面 ⇒ 显式豁免，不是命中）")

  // V3：「核销」恰一处，且在同一行含「不吸收」（指名否定，不复活已废除名词）
  const hexiaoLines = sub.split("\n").filter((l) => l.includes("核销"))
  assert.equal(hexiaoLines.length, 1, "V3：「核销」在规范层恰一处（实测 " + hexiaoLines.length + " 行）")
  assert.ok(hexiaoLines[0].includes("不吸收"), "V3：该行必须含「不吸收」——只在否定语境出现")

  // V4：三条字面判据（全部取自 §6.1 冻结文本）
  const seg = (a, b) => sub.slice(sub.indexOf(a), b === null ? sub.length : sub.indexOf(b))
  const d1 = seg("**D1 写权矩阵**", "**D2 单一权威源**")
  const d2 = seg("**D2 单一权威源**", "**D3 计数·枚举纪律**")
  assert.ok(d2.includes("一条机制只在一处详述，其余处只引用不重述"), "V4①：D2 段必须在位")
  assert.ok(d1.includes("文档地图 = **建档者随建随登**"), "V4②：D1 段必须在位")
  const whole = lf(md)
  for (const phrase of ["每个机制只在**一处**详述", "新建文档必须登记到"]) {
    assert.equal(whole.split(phrase).length - 1, 0, "V4③：原 :32/:33 的短语必须已归并（不再含：" + phrase + "）")
  }

  // —— 批 13（R-25 / AC-14 · AC-15 · 锚 V8）：登记完备谓词（**并入本既有块**，不新开顶层 test()） ——
  const docsOnDisk = docsTopLevel()
  assert.ok(docsOnDisk.length >= 40, "域非空（docs/ 顶层 *.md 实测 " + docsOnDisk.length + " 档）")
  assert.ok(docsOnDisk.includes("README.md"), "登记簿自身在域内（例外恰一条 = 它自己）")
  // 谓词自证（律 3——防「恒真锁」）：① 注入合成未登记名 ⇒ 必红；② 空登记簿 ⇒ 必红
  assert.deepEqual(unregisteredDocs("whatever", ["README.md", "synth-unregistered.md"]), ["synth-unregistered.md"],
    "谓词自证①：域内注入合成未登记名 ⇒ 必判违规")
  assert.deepEqual(unregisteredDocs("", ["README.md", "x.md"]), ["x.md"],
    "谓词自证②：空登记簿 ⇒ 域内每一档都判违规")
  // 阴性对照（防「恒红」）：README 全文里出现该档的纯文件名链接 ⇒ 判已登记
  assert.deepEqual(unregisteredDocs("see ](x.md) here", ["README.md", "x.md"]), [],
    "阴性对照：含 `](x.md)` ⇒ 判已登记（谓词不是恒红）")
  // 口径二自证：带锚点/后缀的链接形态**不计**为已登记
  assert.deepEqual(unregisteredDocs("see ](x.md#sec) here", ["README.md", "x.md"]), ["x.md"],
    "口径：`](x.md#sec)` 这种带锚点形态不计为已登记")
  // 事实底座（AC-14「落地即绿」）：域 \ {README} 全部已登记 ⇒ 零追加豁免
  assert.deepEqual(unregisteredDocs(readme, docsOnDisk), [],
    "AC-14：docs/ 顶层每个 basename 必须已登记在 docs/README.md 全文里（新建文档漏登记 ⇒ 本断言红）")
})

// ═══════════════ ③ 六串负向（V5）+ 正向锚与划界（V10/V11②/V12②③） ═══════════════

/** 六串禁字锁（拼接写法：直写会让本档自己命中；probe = 独立手写的阳性样本）。 */
const SIX_STRING_LOCK = [
  ["B1 " + "method" + "ology", new RegExp("method" + "ology", "i"), "… per " + "METHOD" + "OLOGY.md"],
  ["B2 " + "docs/" + "design", new RegExp("docs/" + "design"), "see docs/" + "design" + "/README.md"],
  ["B2 " + "ENGINEERING" + "-MODE", new RegExp("ENGINEERING" + "-MODE"), "read ENGINEERING" + "-MODE.md"],
  ["B9 " + "check-doc-" + "width", new RegExp("check-doc-" + "width"), "run check-doc-" + "width.py"],
  ["B9 " + "check-" + "ledger", new RegExp("check-" + "ledger"), "run check-" + "ledger.py"],
  ["B9 docs/" + "TODO.md", new RegExp("docs/" + "TODO\\.md"), "kept in docs/" + "TODO.md"],
]

test("DOC-HYGIENE T3（锚 V5 / V10 / V11② / V12②③）: 批 11 新文本六串零命中 + 正向锚在位", () => {
  // —— 谓词自证（防「正则写错 ⇒ 永远 0 命中」的假绿，与 T-PK15 同款） ——
  for (const [label, re, probe] of SIX_STRING_LOCK) {
    assert.ok(re.test(probe), "断言器自证（阳性样本必命中）: " + label)
    assert.ok(!re.test("__negative control__"), "断言器自证（阴性样本不命中）: " + label)
  }
  // —— V5：批 11 每个新增/修改行的落点文件（提示词两档 + 两个 lib 档 + 本档）——
  //    `lib/**` 的口径与 §8.1-8 一致（= T-PK15 的实测面）。
  const TEXT_FILES = ["lib/prompts/discipline.md", "lib/prompts/engineering.md", "lib/eng.mjs", "lib/index.mjs",
    "test/doc-hygiene.test.mjs"]
  const hits = []
  for (const f of TEXT_FILES) {
    const t = read(f)
    for (const [label, re] of SIX_STRING_LOCK) if (re.test(t)) hits.push(f + " :: " + label)
  }
  assert.deepEqual(hits, [], "V5：批 11 新文本落点必须六串零命中，实得：" + hits.join(" | "))
  // 扫描面自证：`lib/**` 全库（§8.1-8 的权威判据）
  const libFiles = walkText(join(PLUGIN_DIR, "lib"))
  assert.ok(libFiles.length >= 25, "`lib/**` 扫描面非空（实测 " + libFiles.length + " 档）")
  for (const [label, re, probe] of SIX_STRING_LOCK) {
    const libHits = libFiles.filter((f) => re.test(read(f)))
    assert.deepEqual(libHits, [], "§8.1-8：" + label + " 在 `lib/**` 内必须零命中")
  }

  // —— V10：eng_coder 描述串两侧同批在位（授权侧 + 边界侧） ——
  const idx = read("lib/index.mjs")
  assert.ok(idx.includes("re-spawn ONE new eng_coder with corrected stages starting from the failed stage (the token is not consumed)"),
    "V10 授权侧：自报阶段失败 ⇒ 重派一次（原文保留）")
  assert.ok(idx.includes("ONLY to a stage the sub-agent itself declared failed in a complete report"),
    "V10 授权范围收窄：只限子代理**自报**的阶段失败且报告完整")
  assert.ok(idx.includes("crashes / times out / is aborted"), "V10：崩溃 / 超时 / abort 三类必须点名")
  assert.ok(idx.includes("do NOT re-spawn on your own"), "V10 边界侧：崩溃/超时/abort ⇒ 不自动重派")

  // —— V11②：engineering.md 政策句的三类关键串（英文权威字面）+ 两处**无行内强调** ——
  const policy = read("lib/prompts/engineering.md")
  for (const a of ["stop and report", "do not re-spawn", "user's decision"]) {
    assert.ok(policy.includes(a), "V11②：" + JSON.stringify(a) + " 必须在位（§6.3b 逐字交付）")
  }
  for (const a of ["do not re-spawn", "user's decision"]) {
    const at = policy.indexOf(a)
    assert.ok(at > 0, "V11②：锚串必须可定位：" + a)
    assert.ok(policy[at - 1] !== "*" && policy[at + a.length] !== "*",
      "V11②：加粗星号会切断锚串（评审轮次 4 的 🔴）——" + JSON.stringify(a) + " 两侧不得是 `*`")
  }

  // —— V12②：discipline.md 卫生条的五串（逐字取自 §6.3） ——
  const disc = read("lib/prompts/discipline.md")
  for (const a of ["计数与列表同改", "档名：§节", "回读", "状态行", "描述面"]) {
    assert.ok(disc.includes(a), "V12②：" + JSON.stringify(a) + " 必须在位")
  }
  // —— V12③：AC-V14 四值词表（四档；本档独立复述，不替代 preset-static 的用例） ——
  for (const rel of ["lib/prompts/discipline.md", "lib/prompts/engineering.md", "lib/index.mjs", "README.md"]) {
    const t = read(rel)
    for (const w of ["Fixed", "Dispatched", "Not an issue", "Deferred"]) {
      assert.ok(t.includes(w), "AC-V14（四档复述）：" + rel + " 缺 " + w)
    }
    assert.ok(!/exactly three values|三值|three values/i.test(t), "AC-V14（四档复述）：" + rel + " 不得含封三值表述")
  }
  // —— 只追加：既有 review-discipline 行必须逐字仍在（AC-V14 的四值词表载体） ——
  assert.ok(disc.includes("Review discipline (standard mode only — engineering mode has its own review timing rules):"),
    "§6.3 硬约束：只追加、不删改既有 review-discipline 行")
})

// ═══════════════ ④ 失败后缀块与出口边界（锚 V6 / V7 / V8） ═══════════════

const ENG_SRC = read("lib/eng.mjs")
/** 失败/abort 返回点的**既有**识别谓词（与 test/stage-gate.test.mjs 的 T-SG4 同款，刻意复用）。 */
const FAIL_RE = /status: "failed"|failureText\(|eng_coder error|eng_coder aborted|eng_coder ended|failed to start/
/** 后缀块五项菜单 + 不自动重派 + 用户裁决 + 三要素（§6.2 的逐字交付内容）。 */
const MENU = [
  "--- eng_coder 执行已停止 —— **不自动重派**，由用户裁决。---",
  "报告须含：崩在哪一步（见上方 detail）/ 工作区已改了什么（见上方 partial 与 Touched advisory）/ 任务哪部分未动。",
  "  ① 原样重派（同 token，若仍有效 —— 自报阶段失败那一类 token 未消费）",
  "  ② 带半成品继续（先核对 partial 与工作区实况）",
  "  ③ 清理工作区后重来（必要时 git 回滚）",
  "  ④ 改道（换执行通道或策略）",
  "  ⑤ 作废本链",
]
/**
 * 「失败种类 → 返回点」映射表（§6.2 适用范围；**逐点**列出，此表即 V6 的测试清单）。
 * `n` = 该针在其源码中必须出现的次数（同一针覆盖同类两路时 >1）。
 */
const SITES = [
  [1, 'detail: "codex-cli " + env.code, output: failStop(failureText(env))'],
  [1, 'output: failStop(warnPrefix() + "eng_coder error: " + (e?.message ?? String(e))),'],
  [1, "return failStop(failureText(env) + capNote)"],
  [1, '"caller signal abort"), signal) + capNote)'],
  [1, "+ (e?.message ?? String(e)) + capNote)"],
  [1, 'output: failStop(warnPrefix() + "eng_coder failed: ctx.subagents is unavailable'],
  [1, 'output: failStop(warnPrefix() + "eng_coder ended: dsh 后台子代理超兜底截止（dshBackgroundTimeoutMs=" + backstopMs + ")到点，子代理已 abort—— Partial output:'],
  [1, 'output: failStop(warnPrefix() + "eng_coder ended: " + stopReason + "\\nPartial output:'],
  [1, 'abort—— ABORTED" + codexFailureAdvisory({ text: "", code: "ABORTED" }))'],
  [1, 'layer, "dsh subagent abort"), src)),'],
  [1, 'output: failStop(warnPrefix() + "eng_coder failed: " + (e?.message ?? String(e))) }'],
  [1, 'return failStop(warnPrefix() + "eng_coder failed to start: "'],
  [2, '）到点，子代理已 abort—— dsh 子代理路径受平台墙钟约束，超限任务被终止；如需长任务请走 codex runner 或拆分 stages。"'],
  [1, 'dsh subagent abort"), src))\n    }'],
  [1, 'return failStop(warnPrefix() + "eng_coder error: " + (e?.message ?? String(e)))'],
  [1, 'return failStop(warnPrefix() + "eng_coder ended: " + stopReason + diag'],
]
/** 预检拒绝点（spawn **之前**；§6.2：工作未发生 ⇒ 不挂 wrapper、无菜单）。 */
const PREFLIGHT = [
  'return "Error: task is required."',
  'return "Error: invalid stages — " + v.error',
  '"Error: engineering mode is OFF',
  '"Error: invalid design token — it does not match the latest issued record',
  'design token was issued in this session but was not provided this time',
  '"Error: no design token issued in this session',
  'this is a **legacy (three-part) design token**',
  '"Error: the design token you passed has been SUPERSEDED by a renewal in this session"',
  '"Error: invalid or missing design token',
  '" — it cannot be renewed automatically: this session\'s issued record carries"',
  '" — it cannot be renewed: the design document set is no longer readable"',
  '" — the design document set has CHANGED since the review approved it"',
  "return warnPrefix() + inFlightAtEntry",
  "return inFlight",
]

test("DOC-HYGIENE T4（锚 V6 / V7 / V8）: 失败后缀块挂在每个终态失败返回点；预检拒绝点零挂", async () => {
  // —— V8：后缀块字面本身不越字节雷区 ——
  const bs = ENG_SRC.indexOf("const FAILURE_OPTIONS_BLOCK = [")
  const be = ENG_SRC.indexOf("].join(", bs)
  assert.ok(bs > 0 && be > bs, "后缀块常量必须可定位")
  const BLOCK_SRC = ENG_SRC.slice(bs, ENG_SRC.indexOf("\n", be))
  for (const banned of ["Partial" + " output", "Touched" + " 行"]) {
    assert.ok(!BLOCK_SRC.includes(banned), "V8：后缀块不得含字面 " + JSON.stringify(banned))
  }
  assert.ok(!BLOCK_SRC.includes("stageGateNote"), "V8：后缀块不得引入阶段门字样")
  // ★ 交付代码评审 🔵3 订正：初写 `MENU.slice(0, 2).concat(MENU.slice(2))` 是**恒等表达式**
  //   （重构残留，读起来像做了特殊切片），且 `m.replace("\n", "\\n")` 永不触发（MENU 项无换行）
  //   ⇒ 直接遍历 MENU，语义不变（七项逐字全查）。
  for (const m of MENU) {
    assert.ok(BLOCK_SRC.includes(m), "V6：后缀块必须含逐字菜单/声明项：" + JSON.stringify(m.slice(0, 40)))
  }

  // —— V6：映射表逐点接线（每个终态失败返回点在源码内确实调用 wrapper） ——
  for (const [n, needle] of SITES) {
    assert.equal(ENG_SRC.split(needle).length - 1, n,
      "V6：终态失败返回点未接线（期望 " + n + " 处）：" + JSON.stringify(needle.slice(0, 70)))
  }
  assert.equal(ENG_SRC.split("failStop(").length - 1, 18,
    "V6：failStop 出现次数 = 1 处定义 + 17 个挂点（少一处即漏挂 / 多一处越界）")
  const iGate = ENG_SRC.indexOf("export function stageGateNote")
  const iWriteGate = ENG_SRC.indexOf("export function makeWriteGate")
  const iHelper = ENG_SRC.indexOf("const FAILURE_OPTIONS_BLOCK")
  assert.ok(iGate > 0 && iWriteGate > iGate && iHelper > 0, "阶段门切片与 helper 位置均可定位")
  assert.ok(!(iHelper >= iGate && iHelper < iWriteGate),
    "§6.2：helper 必须落在阶段门函数体切片 [" + iGate + "," + iWriteGate + ") 之外（实测 " + iHelper + "）")

  // —— V7：预检拒绝点**零挂**（反向断言）+ wrapper 只出现在首个 spawn 之后 ——
  for (const p of PREFLIGHT) {
    const lines = ENG_SRC.split("\n").filter((l) => l.includes(p))
    assert.ok(lines.length >= 1, "V7：预检返回点必须可定位：" + JSON.stringify(p))
    for (const l of lines) assert.ok(!l.includes("failStop("), "V7：预检拒绝点不得挂 wrapper：" + JSON.stringify(p))
  }
  const firstSpawn = Math.min(ENG_SRC.indexOf("runCodexTask(deps, {"), ENG_SRC.indexOf("ctx.subagents.start("))
  assert.ok(firstSpawn > 0, "V7：首个 spawn 点必须可定位")
  assert.ok(ENG_SRC.indexOf("failStop(failureText(env))") > firstSpawn,
    "V7：wrapper 的**首个**挂点必须在 spawn 之后（预检拒绝一律不挂——靠返回点位置区分，禁用内容判据）")

  // —— V8：失败行不得含阶段门字样（与 stage-gate T-SG4 的反向锁同域、独立复述） ——
  const failLines = ENG_SRC.split("\n").filter((l) => /\breturn\b/.test(l) && FAIL_RE.test(l))
  assert.ok(failLines.length >= 8, "失败/abort 返回点应被识别到（实测 " + failLines.length + " 条）")
  for (const l of failLines) assert.ok(!l.includes("stageGateNote"), "V8：失败行不得含阶段门字样：" + l.trim().slice(0, 80))

  // —— V6 行为面（**进程内**：stub 子代理 ⇒ 失败终态 ⇒ 返回串必须带菜单；非真机行为） ——
  const home = mkdtempSync(join(tmpdir(), "thincoder-dh-"))
  const sid = "dh-" + randomUUID()
  try {
    const st = sessionState(sid)
    st.engineering = true
    st.designToken = randomUUID() + ":" + (Date.now() + 3600_000)
    const subagents = {
      async start() {
        return {
          result: Promise.resolve({ output: [{ type: "text", text: "half done" }], stopReason: "failed", diagnostic: null }),
          dispose: async () => {},
        }
      },
    }
    const llm = {
      async resolveModelInfo() {
        return { reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }], defaultEffort: "low" } }
      },
    }
    const out = await runEngCoder({
      ctx: { subagents, llm },
      agent: { session: { id: sid, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
      config: {}, signal: undefined, configDefaultEngineering: false, storPathOverride: home,
    }, { task: "implement x", designToken: st.designToken, docs: [] })
    assert.equal(typeof out, "string", "dsh 同步失败路径返回字符串")
    assert.ok(out.includes("eng_coder ended: failed"), "走既有失败路径（不引入新 status 枚举）")
    for (const m of MENU) assert.ok(out.includes(m), "V6：失败返回串必须含菜单项 " + JSON.stringify(m.slice(0, 30)))
    assert.ok(!out.includes("stage verification:"), "§8.1-6：失败路径不得加阶段门横幅")
  } finally {
    dropSession(sid)
    try { rmSync(home, { recursive: true, force: true }) } catch { /* 已清理 */ }
  }
})
