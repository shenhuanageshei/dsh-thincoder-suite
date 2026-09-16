// doc-hygiene.test.mjs — 批 11：DOC-HYGIENE 的机械层（D6「回读核对」的一般规则 → 机械网）。
// 设计档：docs/2026-09-13-doc-discipline-design.md
//   §6.4 两项机械检查（U+FFFD 全仓 + 常设档 canary）· §8.2 机验锚 V1…V14 · §11 本批**不可真机验证**清单（未重启 DSH）
//   §8.1-8 六串锁的权威作用域（`lib/**` 内命中 = 0）· §6.1 冻结交付文本 · §6.2 失败后缀块
//
// 本档用例（顶层 `test(` 数 = 9，台账 docs/test-lifecycle.md §三 同数）：
//   ① U+FFFD 全仓扫描（锚 V13）
//   ② 常设档 canary（锚 V14）+ 规范层形状与纪律（锚 V1/V2/V3/V4——按 §6.4 的「并入既有 test() 块」）
//      + **登记完备（批 13 / R-25 / AC-14·AC-15 / 锚 V8——同走「并入既有块」）**
//      + **批 16 形状声明解析 + 四条腿对真实档实跑 + `scanned >= 1`（锚 A1–A8——同走「并入既有块」）**
//   ③ 批 11 新文本六串负向（锚 V5）+ 正向锚与划界（锚 V10 / V11② / V12②/③）
//   ④ 失败后缀块与出口边界（锚 V6 / V7 / V8）
//   ⑤–⑨ **批 16 五条负控腿**（锚 A7 / AC-11）：腿 1 · 腿 2 · 腿 3 · 腿 4 闸 B（含**反向孤儿锚腿**）·
//      腿 4 闸 A——每条各为一个顶层 `test(`（AC-10：`用例数 = 基线 + 5`），**全部在仓外临时档/临时副本上构造**
//
// ★ 批 16 的档内形状声明（`<!-- doc-shape … -->`）就住**被检的档自己**身上，本测试档**不维护
//   档名→格式的映射表**（D16-3：单一权威源，测试不做第二份真相源）。
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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
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

test("DOC-HYGIENE T2（锚 V14 + V1/V2/V3/V4 + 批 13 R-25 登记完备）: 常设档 canary（防截断为 1 行）+ 规范层零状态句 + 登记完备", (t) => {
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

  // —— 批 16（锚 A1–A8）：文档形状谓词——形状声明解析 + 四条腿 + `scanned >= 1` ——
  //    **并入本既有块**（不新开顶层 test()）：本批新增的顶层用例恰为五条负控腿。
  const shape = runShapeLegsOnRealDocs()
  assert.ok(shape.scanned >= 1 && shape.leg4Runs >= 1,
    "批 16 四腿实跑：扫描域 " + shape.files + " 档 → 作用域 " + shape.scanned + " 档 · 腿 2 " + shape.leg2Runs
    + " 档 · 腿 3 受检引用 " + shape.leg3Checked + " 条 · 腿 4 " + shape.leg4Runs + " 档")
  // 实测值打印（锚 A2 的 `scanned` 必须**可被人读到**，不只是被断言）
  t.diagnostic("批 16 形状谓词实测：扫描域 " + shape.files + " 档 · 进作用域 scanned=" + shape.scanned
    + " · 腿 1 核到标记 " + shape.leg1Hits + " 处 · 腿 2 实跑 " + shape.leg2Runs + " 档 · 腿 3 受检引用 "
    + shape.leg3Checked + " 条 · 腿 4 实跑 " + shape.leg4Runs + " 档 ⇒ " + shape.leg4Stats.join(" "))
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

// ═══════════════ ⑤ 文档形状谓词（批 16 · 锚 A1–A10） ═══════════════
//
// 设计档 `docs/2026-09-16-doc-shape-design.md`（§5.2 腿 1 · §5.3 腿 2 · §5.4 腿 3/4 · §6 伪代码 ·
// §8.2 锚 A1–A10 与负控表 · §9 边界 · §10.3 AC-1…AC-12）· 需求档
// `docs/2026-09-16-doc-shape-requirements.md`（US-1…US-6 · N-1…N-7 · §5.1 七项不做）。
//
// ★ 两条形态约束（需求档 §2.3 的 P-9 / P-10 直接推出）：**只认显式标记**（不猜中文量词）·
//   **前向生效**（只作用于档内自带 `doc-shape` 声明的档，存量档**完全跳过**、不追溯）。
// ★ 失败方向（§9）：**谓词面全 fail-closed**（空集 / 畸形 / 定位失败 ⇒ 红）·
//   **存量档 fail-open**（无声明即跳过，零触碰既有档）。
// ★ 谓词只报不改（US-4 的 D1 写权矩阵）：它红了就是红了，改档是主代理 / eng_coder 的事。
// ★ 一切定位按**字符串 / 符号锚定**，**零行号锚定**（行号只作 as-of 括注——D4）。
// ★ 本档自身的洁净：本节所有「禁用串」示例一律用拼接写法（与档首六串锁同律）。

/** 形状声明的合法键（§5.1）。未知键 ⇒ 红（§9 畸形输入，**不得**静默降级为空声明）。 */
const SHAPE_KEYS = new Set(["anchors", "acs", "count-marks", "compare"])
/** 腿 1 认的量词**缺省**集合（§5.1 的缺省值）。 */
const SHAPE_DEFAULT_MARKS = ["项", "处", "条", "档", "值", "步", "腿"]
/** 腿 4 的层标语义（D16-4）：**T1/T2 必须有锚**；**T3 与「连 T3 都不是」免锚**。 */
const SHAPE_MUST_ANCHOR = new Set(["T1", "T2"])
/** 免锚的合法写法（§5.4 · §6）：显式 `—`，或层标**连 T3 都不是**。其余空值一律红。 */
// ★ 分歧审计 F6 订正：初版是 `new Set(["", "—", "-"])`，而设计档 §5.4/§6 逐字写
// 「免锚的合法写法只有两种：显式 `—` 与层标『连 T3 都不是』」⇒ 半角 `-` 无出处，
// 属静默放宽（fail-open 方向）。今移除，使代码与设计同值。
const SHAPE_NO_ANCHOR = new Set(["", "—"])
/** 反向腿的**显式豁免标记**（§8.2 的 A10 一行写法：`（豁免：…）`）。 */
const SHAPE_EXEMPT_RE = /（豁免：/
/** 块级 HTML 注释里的形状声明（§5.1：档头插一份 `<!-- doc-shape … -->`；取**首个**）。 */
const SHAPE_DECL_RE = /<!--\s*doc-shape\b([\s\S]*?)-->/

/**
 * 谓词违规（§10.2：负控腿「跑起来就必须红，由 `assert.throws` 捕获」）。
 * **断言 / 谓词级红 = 真红**；`ReferenceError` / 整档崩溃 = 假红——本类就是把违规收敛成
 * 「可被 `assert.throws` 抓住、且带逐条明细」的错误，而不是让整档崩掉。
 */
class ShapeViolation extends Error {
  constructor(violations) {
    super(violations.join("\n"))
    this.name = "ShapeViolation"
    this.violations = violations
  }
}

/** 有违规就抛（§9 fail-closed：谓词面绝不 fail-open）。 */
function shapeThrow(violations) {
  if (violations.length > 0) throw new ShapeViolation(violations)
}

/**
 * 形状声明的解析（§5.1 / §6 的 `parseDocShape`）。
 * @pre  `src` 是整档文本
 * @post 无声明 ⇒ 返回 `null`（该档**完全跳过**）；有声明 ⇒ 返回键值对象
 *       **绝不**在解析失败时静默返回「空声明」（那会让谓词空转 ⇒ 恒真）
 */
function parseDocShape(src) {
  const m = SHAPE_DECL_RE.exec(String(src))
  if (m === null) return null
  const decl = { anchors: null, acs: null, compare: null, "count-marks": SHAPE_DEFAULT_MARKS.slice() }
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "") continue
    const at = line.indexOf(":")
    if (at < 0) throw new Error("doc-shape 声明畸形（缺冒号）：" + JSON.stringify(line))
    const key = line.slice(0, at).trim()
    const val = line.slice(at + 1).trim()
    if (!SHAPE_KEYS.has(key)) throw new Error("doc-shape 声明含未知键：" + JSON.stringify(key))
    if (val === "") throw new Error("doc-shape 声明的键值为空：" + JSON.stringify(key))
    decl[key] = key === "count-marks"
      ? val.split("|").map((s) => s.trim()).filter((s) => s !== "")
      : val
  }
  return decl
}

/**
 * 行内代码 span 掩码器（§5.2 边界① / §5.4 腿 3 的豁免面 / D16-5）。
 * 把 `` `…` `` 连同反引号替换成**同长度空格** ⇒ 行列偏移不变，而**代码 span 之内**的内容
 * 再也不可能被匹配到——这就是「**代码 span 之内一律跳过（豁免）**」的那条分支。
 */
const maskCodeSpans = (line) => line.replace(/`[^`]*`/g, (s) => " ".repeat(s.length))

/**
 * 腿 1：计数 ↔ 列表（§5.2 · AC-1 / AC-2 · 锚 A1/A3 · US-1）。
 * @pre  只在**已声明**的档上调用；`marks` = 量词集合（空 ⇒ 用七量词缺省）
 * @post 每个 `（N <量词>：` 标记的 `·` 项数 == N；违规文本含 **文件:行 + 声明值 + 实际值**
 *       （三者缺一即不可定位——AC-2）
 * ★ 三条边界（缺一即错，§5.2）：
 *   ① **行内代码 span 一律豁免**（否则谓词会对本批两档自己的示例报红）；
 *   ② **`N` 只认阿拉伯数字**（字面 `N` 不匹配——否则规范文本本身会触发）；
 *   ③ **只数同一行内的 `·` 项**（跨行不算——跨行会让「N 项」失去肉眼可核性）。
 * @return 该档被核到的标记数
 */
function checkCountMarks(text, marks, file = "(内存档)") {
  const units = (marks && marks.length > 0 ? marks : SHAPE_DEFAULT_MARKS)
    .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
  // 边界②：`[0-9]+` 只认阿拉伯数字（`（N 项：` 里的字面 N 不匹配）
  const markSrc = "（([0-9]+)\\s*(" + units + ")："
  const bad = []
  let hits = 0
  const lines = lf(text).split("\n")
  for (let i = 0; i < lines.length; i++) {
    const masked = maskCodeSpans(lines[i]) // ← 边界①：代码 span 之内的标记一律豁免
    for (const m of masked.matchAll(new RegExp(markSrc, "g"))) {
      hits++
      const rest = masked.slice(m.index + m[0].length)
      const close = rest.indexOf("）")
      const seg = close < 0 ? rest : rest.slice(0, close) // ← 边界③：同行为界，跨行不算
      // 项数 = **本行内非空的** `·` 分隔段数（空段 = 该段的内容不在本行 ⇒ 不计入，
      // 故 `（2 项：a ·` + 次行 `b）` 判 1 项 ⇒ 红，而不会被「尾随 `·` 凑成 2」蒙混过去）
      const actual = seg.split("·").filter((s) => s.trim() !== "").length
      const declared = Number(m[1])
      if (actual !== declared) {
        bad.push(file + ":" + (i + 1) + ": 声明 " + declared + " " + m[2]
          + " · 实际 " + actual + " " + m[2] + "（标记字面 " + JSON.stringify(m[0]) + "）")
      }
    }
  }
  shapeThrow(bad)
  return hits
}

/**
 * 节定位（按**标题关键字**——符号锚定，**零行号锚定**）。
 * @throws 定位不到 ⇒ **红**（§9：定位失败**不是**跳过——那正是谓词空转的入口）
 * @return `{ line, body }`：`line` 只作报错用的 as-of 括注，`body` = 该节正文（不含标题行）
 */
function shapeSection(text, keyword, what, file) {
  const lines = lf(text).split("\n")
  const i = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.includes(keyword))
  if (i < 0) {
    shapeThrow([file + ": 形状声明的 " + what + " 指向节标题关键字 " + JSON.stringify(keyword)
      + "，但档内**定位不到**该节标题 ⇒ 红（§9：定位失败不是跳过）"])
  }
  let j = i + 1
  while (j < lines.length && !/^#{1,6}\s/.test(lines[j])) j++
  return { line: i + 1, body: lines.slice(i + 1, j).join("\n") }
}

/** 本节内**直连**表格的解析（只取以 `|` 起头的行；引用块里的 `> |` 自然不在其列）。 */
function shapeTable(sec, what, file) {
  const lines = sec.body.split("\n")
  const raw = []
  for (const l of lines) {
    if (l.startsWith("|")) { raw.push(l); continue }
    if (raw.length > 0) break
  }
  if (raw.length < 2) {
    shapeThrow([file + ": " + what + " 的表格**定位不到**（本节内没有以 `|` 起头的表头/分隔线）⇒ 红（§9）"])
  }
  const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim())
  return { header: cells(raw[0]), rows: raw.slice(2).map((l) => ({ raw: l, cells: cells(l) })) }
}

/**
 * 腿 2：同一事实多处一致（§5.3 · AC-3 · US-2）。
 * @pre  `pair` 形如 `§11.2:§11.3`，**两节都必须能定位**（定位不到 ⇒ **红**，不是跳过）
 * @post 两侧读出的**集合**相等；**任一侧读到零条目 ⇒ 红**（不能当作「空集 == 空集」通过——那是恒真的入口）
 * ★ 本节**只做集合型**；**计数型**明确不入本批（需求档 §5.1 第 7 项：需先定义「哪个 N 权威」）。
 * ★ 集合元素口径 = `AC-<n>` 号（§5.3 的示例形态：§11.2 分层表的 AC 清单 ↔ §11.3 定义的 AC 号集）。
 */
function checkComparePair(text, pair, file = "(内存档)") {
  const [a, b] = String(pair).split(":")
  if (!a || !b) shapeThrow([file + ": compare 声明形态非法（期望 `节A:节B`）：" + JSON.stringify(pair)])
  const ids = (sec) => [...new Set(sec.body.match(/AC-[0-9]+/g) ?? [])].sort()
  const setA = ids(shapeSection(text, a, "比对对左侧（compare 冒号前）", file))
  const setB = ids(shapeSection(text, b, "比对对右侧（compare 冒号后）", file))
  const bad = []
  if (setA.length === 0 || setB.length === 0) {
    bad.push(file + ": compare " + pair + " 某侧读到**零条目**（左 " + setA.length + " · 右 " + setB.length
      + "）⇒ 红（不得当作「空集 == 空集」通过）")
  } else if (setA.join(" ") !== setB.join(" ")) {
    bad.push(file + ": compare " + pair + " 两侧集合**不等**——左侧独有 ["
      + setA.filter((x) => !setB.includes(x)).join(" ") + "] · 右侧独有 ["
      + setB.filter((x) => !setA.includes(x)).join(" ") + "]")
  }
  shapeThrow(bad)
  return { a: setA.length, b: setB.length }
}

/**
 * 腿 3：引用可解析（§5.4 · AC-4 / AC-5 · US-3）。
 * @post 每个**行内代码 span 之外**的相对 md 链接、以及 span 之外裸露的 `` `路径:行号` `` 的**路径**，
 *       都必须在仓根下存在。**行号不解析**（D4：行号只作 as-of 括注——它会漂）。
 * ★ **代码 span 之内 ⇒ 跳过（豁免）**：实测 11 个「不存在」里 7 个是示例（`lib/a.mjs` 这类）。
 * ★ 诚实的现状声明（§5.4）：本仓引用惯例**全部带反引号** ⇒ 实际受检面**主要是 md 链接**。
 */
function checkRefs(text, baseDir, rootDir, file = "(内存档)") {
  const bad = []
  let checked = 0
  const hit = new Set()
  const lines = lf(text).split("\n")
  const linkRe = /\]\(([^)\s]+)\)/g
  const pathRe = /(?:^|[^\w`./-])((?:[\w-]+\/)*[\w-]+\.(?:mjs|js|cjs|md|json|txt|ya?ml)):([0-9]+)/g
  for (let i = 0; i < lines.length; i++) {
    const masked = maskCodeSpans(lines[i]) // ← 代码 span 之内一律**跳过**（豁免分支）
    for (const m of masked.matchAll(linkRe)) {
      const raw = m[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue // 外部链接 / 纯页内锚点
      const target = raw.split("#")[0]
      if (target === "") continue
      checked++
      hit.add(target)
      if (!shapeRefExists(target, baseDir, rootDir)) {
        bad.push(file + ":" + (i + 1) + ": 相对链接指向**不存在**的落点 " + JSON.stringify(raw))
      }
    }
    for (const m of masked.matchAll(pathRe)) {
      // `路径:行号` 的**路径**受检；**行号不解析**（只作 as-of）
      checked++
      hit.add(m[1])
      if (!shapeRefExists(m[1], rootDir, rootDir)) {
        bad.push(file + ":" + (i + 1) + ": 裸露的 `路径:行号` 的**路径**不存在 " + JSON.stringify(m[1]))
      }
    }
  }
  shapeThrow(bad)
  return { checked, targets: [...hit].sort() }
}

/** 相对链接 / 路径的存在性（域 = `rootDir` 之下；绝对路径或越界 ⇒ 判不存在）。 */
function shapeRefExists(target, baseDir, rootDir) {
  if (isAbsolute(target)) return false
  const abs = resolve(baseDir, target)
  const root = resolve(rootDir)
  if (abs !== root && !abs.startsWith(root + sep)) return false
  return existsSync(abs)
}

/**
 * 腿 4：AC ↔ 锚互引（§5.4 · **两道闸 + 反向腿** · AC-6 / AC-7 / AC-8 · US-4）。
 * @pre  声明含 `anchors` 与 `acs`，且**两个节都能定位**（定位不到 ⇒ **红**，不是跳过）
 * @post ① **闸 A**：每行 cell 数 == 表头列数（防 `|` 缺失导致串列）
 *       ② **闸 B**：锚列非空——免锚的合法写法只有两种：显式 `—` 与层标**连 T3 都不是**（其余空值一律红）
 *       ③ 所引锚 id 必须在锚表中有定义
 *       ④ **T1/T2 的 AC 必须有锚**；**T3 与「连 T3 都不是」免锚**（D16-4——批 14 把这条写成「满射」⇒ 当场为假）
 *       ⑤ **AC 号不重复**
 *       ⑥ **反向腿**：锚表里每个锚至少被一条 AC 引用；**未被引用的锚必须自带显式豁免标记**
 */
function checkAnchorsAndACs(text, decl, file = "(内存档)") {
  const bad = []
  const aTab = shapeTable(shapeSection(text, decl.anchors, "锚表（anchors）", file), "锚表（anchors）", file)
  const cTab = shapeTable(shapeSection(text, decl.acs, "AC 表（acs）", file), "AC 表（acs）", file)

  // —— 闸 A：cell 数 == 表头列数（**两张表都校**，逐行报出） ——
  for (const [what, tab] of [["锚表", aTab], ["AC 表", cTab]]) {
    for (const r of tab.rows) {
      if (r.cells.length !== tab.header.length) {
        bad.push(file + ": " + what + " cell 数 " + r.cells.length + " != 表头列数 " + tab.header.length
          + " ⇒ 红（串列 / 漏 `|`）：" + r.raw.trim().slice(0, 80))
      }
    }
  }
  // —— 锚表：抽锚 id（§5.1：`anchors` = 锚表的节标题关键字，用于定位锚表、**抽取锚 id**） ——
  const anchors = new Map()
  for (const r of aTab.rows) {
    const m = (r.cells[0] ?? "").match(/\bA[0-9]+\b/)
    if (!m) {
      bad.push(file + ": 锚表首列解析不到锚 id（期望 `A<n>`）：" + r.raw.trim().slice(0, 80))
      continue
    }
    if (anchors.has(m[0])) bad.push(file + ": 锚 id 重复定义：" + m[0])
    anchors.set(m[0], r.raw)
  }
  // —— AC 表的列定位（按**表头关键字**，零列号硬编码） ——
  const iAnchor = cTab.header.findIndex((h) => h.includes("锚"))
  const iLayer = cTab.header.findIndex((h) => h.includes("层"))
  if (iAnchor < 0 || iLayer < 0) {
    bad.push(file + ": AC 表**定位不到**" + [iAnchor < 0 ? "锚列" : "", iLayer < 0 ? "层列" : ""].filter(Boolean).join(" 与 ")
      + "（表头实测 " + JSON.stringify(cTab.header) + "）⇒ 红（§9：定位失败不是跳过）")
    shapeThrow(bad)
  }
  // —— 逐行：闸 B + 锚 id 定义性 + 层标分层不变量 + 重复 AC 号 ——
  const referenced = new Set()
  const seen = new Set()
  for (const r of cTab.rows) {
    if (r.cells.length !== cTab.header.length) continue // 闸 A 已报；残缺行不再二次误报
    const acId = (r.cells[0] ?? "").match(/AC-[0-9]+/)
    if (!acId) {
      bad.push(file + ": AC 表首列解析不到 AC 号：" + r.raw.trim().slice(0, 80))
      continue
    }
    if (seen.has(acId[0])) bad.push(file + ": AC 号重复：" + acId[0])
    seen.add(acId[0])
    const layer = (r.cells[iLayer] ?? "").replace(/[*`\s]/g, "")
    const cell = (r.cells[iAnchor] ?? "").replace(/[*`]/g, "").trim()
    const refs = [...new Set(cell.match(/\bA[0-9]+\b/g) ?? [])]
    if (SHAPE_MUST_ANCHOR.has(layer)) {
      if (SHAPE_NO_ANCHOR.has(cell)) {
        bad.push(file + ": " + acId[0] + " 层标 " + layer + " ⇒ **必须有锚**（T1/T2 必填）；免锚的合法写法"
          + "只有两种：显式 `—` 与层标**连 T3 都不是**；实测锚列 " + JSON.stringify(cell))
      }
    } else if (refs.length === 0 && !SHAPE_NO_ANCHOR.has(cell)) {
      bad.push(file + ": " + acId[0] + " 锚列非空但解析不到锚 id：" + JSON.stringify(cell))
    }
    for (const a of refs) {
      referenced.add(a)
      if (!anchors.has(a)) {
        bad.push(file + ": " + acId[0] + " 引用了**不存在的锚** " + a
          + "（锚表实有：" + [...anchors.keys()].join(" ") + "）")
      }
    }
  }
  // —— 反向腿（评审 #5 补入）：孤儿锚 ——
  for (const [id, raw] of anchors) {
    if (referenced.has(id)) continue
    if (SHAPE_EXEMPT_RE.test(raw)) continue // **显式豁免标记**（写法见 §8.2 的 A10 一行）
    bad.push(file + ": 反向腿——锚 " + id + " **未被任何 AC 引用**，且其行未带显式豁免标记 `（豁免：…）` ⇒ 红")
  }
  shapeThrow(bad)
  return { anchors: anchors.size, acs: seen.size, referenced: referenced.size }
}

/** 扫描域 = `docs/` 下**递归**收的全部 `.md`（图 1 的入口）。 */
const shapeDocFiles = () => walkText(join(PLUGIN_DIR, "docs")).filter((f) => f.endsWith(".md")).sort()

/**
 * 扫描：**有声明 ⇒ 进作用域；无声明 ⇒ 完全跳过**（D16-2 的前向生效，存量档 fail-open）。
 * ★ `scanned` 数的是**进作用域的档**，不是「扫到的档」——那个区别就是「零扫描 ⇒ 恒真」的堵口（图 2）。
 * @throws 声明畸形（缺冒号 / 未知键 / 空值）⇒ 抛（fail-closed，绝不静默返空声明）
 */
function shapeScan(files = shapeDocFiles(), loader = read) {
  const out = []
  for (const f of files) {
    const text = lf(loader(f))
    const decl = parseDocShape(text)
    if (decl === null) continue
    out.push({ file: f, text, decl })
  }
  return out
}

/** 把谓词的 `ShapeViolation` 收敛成**断言级红**（真红）：明细必须被人看见，而不是整档崩掉。 */
function assertShapeClean(label, fn) {
  try {
    fn()
  } catch (e) {
    if (e instanceof ShapeViolation) assert.fail(label + " ⇒ 红：\n" + e.message)
    throw e
  }
}

// ——— ⑤-a：形状声明解析 + 四条腿对真实档实跑 + 「进作用域的档 >= 1」（锚 A1 / A2 / A3） ———
// ★ 形态：**并入既有 test() 块**（批 9/11/13 的同款先例），**不新开顶层 `test(`**——
//   本批新增的顶层用例**恰为五条负控腿**（AC-10 / AC-11：`用例数 = 基线 + 5`）。

function runShapeLegsOnRealDocs() {
  // —— A1：无声明 ⇒ 返 null（该档**完全跳过**；前向生效，不追溯存量） ——
  assert.equal(parseDocShape("# 无声明的一档\n\n正文里出现 doc-shape 这几个字也不算声明。\n"), null,
    "A1：无 `<!-- doc-shape … -->` 注释 ⇒ 必须返 null（存量档完全跳过）")
  // 解析失败**绝不静默返空声明**（§9 畸形输入 fail-closed——那会让谓词空转 ⇒ 恒真）
  assert.throws(() => parseDocShape("<!-- doc-shape\nanchors 机验锚\n-->"), /缺冒号/,
    "畸形声明（缺冒号）必须红，不得降级为空声明")
  assert.throws(() => parseDocShape("<!-- doc-shape\nunknowne-key: x\n-->"), /未知键/,
    "未知键必须红（§5.1 的键是封闭集合）")
  assert.throws(() => parseDocShape("<!-- doc-shape\nanchors:\n-->"), /键值为空/, "空键值必须红")
  // 声明解读 + 缺省（§5.1）
  const d = parseDocShape("<!-- doc-shape\nanchors: 机验锚\nacs: 验收标准\ncount-marks: 项|条\ncompare: §1:§2\n-->")
  assert.deepEqual([d.anchors, d.acs, d["count-marks"], d.compare], ["机验锚", "验收标准", ["项", "条"], "§1:§2"],
    "四键必须逐字读出")
  assert.deepEqual(parseDocShape("<!-- doc-shape\nanchors: x\nacs: y\n-->")["count-marks"], SHAPE_DEFAULT_MARKS,
    "count-marks 缺省 = §5.1 的七量词")

  // —— A2（D16-7）：**扫描集为空 ⇒ 红**；数的是**进作用域的档**，不是「扫到的档」 ——
  const files = shapeDocFiles()
  assert.ok(files.length >= 40, "扫描域自证：docs/ 下递归的 .md 实测 " + files.length + " 档")
  const scanned = shapeScan(files).length
  assert.ok(scanned >= 1, "A2：**进作用域的档**数（scanned）必须 >= 1，实测 " + scanned
    + "——零扫描 ⇒ 谓词恒真（D16-7），fail-closed 红")
  assert.ok(scanned < files.length, "自证：存量档确实被跳过（扫描域 " + files.length + " 档 → 作用域 " + scanned + " 档）")

  // —— 四条腿对**真实档**实跑（腿 2 只在声明了 compare 的档上跑；腿 4 只在声明了 anchors/acs 的档上跑） ——
  const scope = shapeScan(files)
  let leg1Hits = 0
  let leg2Runs = 0
  let leg3Checked = 0
  let leg4Runs = 0
  const leg4Stats = []
  for (const s of scope) {
    let l1 = 0
    assertShapeClean(s.file + " 腿 1（计数 ↔ 列表）", () => { l1 = checkCountMarks(s.text, s.decl["count-marks"], s.file) })
    leg1Hits += l1
    if (s.decl.compare) {
      leg2Runs++
      assertShapeClean(s.file + " 腿 2（比对对）", () => checkComparePair(s.text, s.decl.compare, s.file))
    }
    leg3Checked += checkRefs(s.text, dirname(join(PLUGIN_DIR, s.file)), PLUGIN_DIR, s.file).checked
    if (s.decl.anchors && s.decl.acs) {
      leg4Runs++
      let stats = null
      assertShapeClean(s.file + " 腿 4（AC ↔ 锚互引）", () => { stats = checkAnchorsAndACs(s.text, s.decl, s.file) })
      leg4Stats.push(s.file + "（锚 " + stats.anchors + " · AC " + stats.acs + " · 被引用锚 " + stats.referenced + "）")
    }
  }
  assert.ok(leg4Runs >= 1, "腿 4 必须至少在一档上实跑（否则它的正例面无证据），实测 " + leg4Runs)
  return { files: files.length, scanned, leg1Hits, leg2Runs, leg3Checked, leg4Runs, leg4Stats }
}

// ——— ⑤-b：负控腿 1（锚 A7 第 1 行 · §8.2 负控表第 1 行） ———
// ★ 必须在**代码 span 之外**构造：本批两档的 `（N …：` 标记**全部在代码 span 内**（受 D16-5 豁免），
//   照字面改它们会被自家豁免吞掉、负控不红 ⇒ 在**临时目录新建一份极简档**（D5：不动被锁对象）。

test("DOC-HYGIENE 批 16 负控腿 1（锚 A7）: 裸写「（3 项：a · b）」⇒ 腿 1 必红（真红）+ 三条边界在位", () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-shape-l1-"))
  try {
    const SHAPE_HEAD = "<!-- doc-shape\ncount-marks: " + SHAPE_DEFAULT_MARKS.join("|") + "\n-->\n\n# 极简档\n\n"
    const badDoc = SHAPE_HEAD + "本档（3 项：a · b）是裸写的标记，不在代码 span 内。\n"
    const okDoc = SHAPE_HEAD + "本档（2 项：a · b）与声明一致。\n"
    writeFileSync(join(dir, "minimal.md"), badDoc, "utf8")
    const badText = readFileSync(join(dir, "minimal.md"), "utf8")
    const decl = parseDocShape(badText)
    assert.ok(decl !== null, "极简档的声明必须可解析（否则负控跑不起来）")
    const marks = decl["count-marks"]

    // 阳性对照（防「谓词恒红」的假绿）：声明值与实际一致 ⇒ 零违规
    assert.equal(checkCountMarks(okDoc, marks, "ok.md"), 1, "阳性对照：2 项 == 2 项 ⇒ 绿")
    // 负控：声明 3 而实际 2 ⇒ 必红，且必须是**谓词/断言级红**（`ShapeViolation`），不是整档崩溃
    // ★ 谓词按「档:行」报错，但**本断言不锚行号**（行号只作 as-of；锚形状不锚位置）
    assert.throws(() => checkCountMarks(badText, marks, "minimal.md"),
      (e) => e instanceof ShapeViolation && /minimal\.md:[0-9]+: 声明 3 项 · 实际 2 项/.test(e.message),
      "负控腿 1：裸写的「（3 项：a · b）」必须被抓（真红 = ShapeViolation，带 档:行 + 声明值 + 实际值）")
    // AC-2：报错文本三要素逐条在位（档:行 / 声明值 / 实际值）
    try {
      checkCountMarks(badText, marks, "minimal.md")
      assert.fail("应当抛")
    } catch (e) {
      assert.ok(/minimal\.md:\d+/.test(e.message), "AC-2①：报错含 文件:行")
      assert.ok(e.message.includes("声明 3"), "AC-2②：报错含声明值")
      assert.ok(e.message.includes("实际 2"), "AC-2③：报错含实际值")
    }

    // —— 三条边界逐条自证（缺一即错，§5.2） ——
    // ① 行内代码 span 一律豁免：同一条违规标记，包进反引号后**不得**再被抓
    assert.equal(checkCountMarks(SHAPE_HEAD + "示例：`（3 项：a · b）`\n", marks, "span.md"), 0,
      "边界①：代码 span 之内的计数标记一律豁免（谓词不得对自家示例报红）")
    // ② `N` 只认阿拉伯数字：字面 `N` 不匹配
    assert.equal(checkCountMarks(SHAPE_HEAD + "形态：（N 项：a · b）\n", marks, "literal.md"), 0,
      "边界②：字面 `N` 不是阿拉伯数字 ⇒ 不匹配（否则规范文本本身会触发）")
    // ③ 只数同一行内的 `·` 项：第 2 项在下一行 ⇒ 本行只数到 1 项 ⇒ 与声明 2 不等 ⇒ 红（不静默放过）
    assert.throws(() => checkCountMarks(SHAPE_HEAD + "本档（2 项：a ·\nb）\n", marks, "wrap.md"),
      (e) => e instanceof ShapeViolation && e.message.includes("实际 1 项"),
      "边界③：跨行的 `·` 项不计入 ⇒ 判 1 项 ≠ 声明 2 ⇒ 红（跨行会让「N 项」失去肉眼可核性）")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 在**仓外临时目录**里做「写档 → 读回」的往返（D5：不动被锁对象；做完即弃、仓内零残留）。 */
function shapeTempWrite(dir, name, text) {
  const p = join(dir, name)
  writeFileSync(p, text, "utf8")
  return { path: p, read: () => lf(readFileSync(p, "utf8")) }
}

test("DOC-HYGIENE 批 16 负控腿 2（锚 A7 / AC-3）: §11.2 清单删掉一个 AC 号 ⇒ 腿 2 必红；某侧零条目 ⇒ 必红", () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-shape-l2-"))
  try {
    const copy = shapeTempWrite(dir, "copy.md",
      "<!-- doc-shape\ncompare: §11.2:§11.3\n-->\n\n"
      + "### §11.2 分层登记\n\n| 层 | 本批 AC |\n|---|---|\n| T2 | AC-1 · AC-2 |\n\n"
      + "### §11.3 验收标准\n\n- AC-1\n- AC-2\n")
    const decl = parseDocShape(copy.read())
    assert.equal(decl.compare, "§11.2:§11.3", "临时副本的 compare 声明必须可解析（否则负控跑不起来）")
    // 阳性对照（防「谓词恒红」的假绿）：两侧集合相等 ⇒ 绿
    assert.deepEqual(checkComparePair(copy.read(), decl.compare, "copy.md"), { a: 2, b: 2 },
      "阳性对照：§11.2 与 §11.3 的集合相等 ⇒ 绿")
    // 负控 ①：把 §11.2 的 AC-2 从清单里删掉（**改在仓外临时副本上**）
    shapeTempWrite(dir, "copy.md", copy.read().replace("| T2 | AC-1 · AC-2 |", "| T2 | AC-1 |"))
    assert.throws(() => checkComparePair(copy.read(), decl.compare, "copy.md"),
      (e) => e instanceof ShapeViolation && e.message.includes("AC-2") && e.message.includes("两侧集合**不等**"),
      "负控腿 2：§11.2 少一个 AC 号 ⇒ 集合不等必红（真红 = ShapeViolation，不是整档崩溃）")
    // 负控 ②（第二面）：某侧读到**零条目** ⇒ 必红（不得当作「空集 == 空集」通过）
    shapeTempWrite(dir, "copy2.md", copy.read().replace("- AC-1\n- AC-2\n", "- 无 AC 号\n"))
    const zeroDoc = readFileSync(join(dir, "copy2.md"), "utf8")
    assert.throws(() => checkComparePair(zeroDoc, decl.compare, "copy2.md"),
      (e) => e instanceof ShapeViolation && e.message.includes("零条目"),
      "腿 2 第二面：某侧零条目 ⇒ 必红（「空集 == 空集」是恒真的入口）")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("DOC-HYGIENE 批 16 负控腿 3（锚 A7 / AC-4 · AC-5）: 裸写 `](不存在的档.md)` ⇒ 腿 3 必红；代码 span 内的路径不受检", () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-shape-l3-"))
  try {
    shapeTempWrite(dir, "存在档.md", "# 在\n")
    const copy = shapeTempWrite(dir, "copy.md",
      "<!-- doc-shape\ncount-marks: " + SHAPE_DEFAULT_MARKS.join("|") + "\n-->\n\n"
      + "见 [存在档](./存在档.md)。\n\n"
      + "示例（代码 span 之内 ⇒ **豁免**）：`](./不存在的档.md)`\n")
    // 阳性对照 + **代码 span 豁免的实测**：span 内那条既不报、也不进受检集
    const r = checkRefs(copy.read(), dir, dir, "copy.md")
    assert.equal(r.checked, 1, "阳性对照：只有 1 条受检引用（代码 span 内那条被跳过），实测 " + r.checked)
    assert.deepEqual(r.targets, ["./存在档.md"],
      "AC-5：代码 span **之内**的路径既不报也不受检（豁免分支在位）")
    // 负控：加一个**裸写**（代码 span 之外）的不存在链接 ⇒ 必红
    shapeTempWrite(dir, "copy.md", copy.read() + "\n见 [缺档](./不存在的档.md)。\n")
    assert.throws(() => checkRefs(copy.read(), dir, dir, "copy.md"),
      (e) => e instanceof ShapeViolation && e.message.includes("不存在的档.md") && e.message.includes("不存在**的落点"),
      "负控腿 3：裸写的 `](不存在的档.md)` ⇒ 路径存在性断言必红")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 腿 4 两条负控共用的极简夹具（锚表 2 锚 + AC 表 2 条 T2，两锚都被引用）。 */
const SHAPE_FIXTURE =
  "<!-- doc-shape\nanchors: 机验锚\nacs: 验收标准\n-->\n\n"
  + "### §8.2 机验锚\n\n| 锚 | 检索目标 | 谓词 | 期望 |\n|---|---|---|---|\n"
  + "| **A1** | 甲 | 乙 | 丙 |\n| **A2** | 甲 | 乙 | 丙 |\n\n"
  + "### §10.3 验收标准\n\n| # | 验收标准 | 层 | 锚 |\n|---|---|---|---|\n"
  + "| **AC-1** | 甲 | T2 | A1 |\n| **AC-2** | 甲 | T2 | A2 |\n"

test("DOC-HYGIENE 批 16 负控腿 4（锚 A7 / AC-7 · AC-8）: T2 锚列清空 ⇒ 闸 B 必红；锚失去全部 AC 引用且无豁免标记 ⇒ 反向腿必红", () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-shape-l4b-"))
  try {
    const copy = shapeTempWrite(dir, "copy.md", SHAPE_FIXTURE)
    const decl = parseDocShape(copy.read())
    // 阳性对照：T2 都有锚、两锚都被引用 ⇒ 绿
    assert.deepEqual(checkAnchorsAndACs(copy.read(), decl, "copy.md"), { anchors: 2, acs: 2, referenced: 2 },
      "阳性对照：T1/T2 都有锚且锚都被引用 ⇒ 绿")
    // 负控 ①（闸 B）：把某条 **T2** 的 AC 锚列清空 ⇒ 必红
    shapeTempWrite(dir, "copy.md", SHAPE_FIXTURE.replace("| **AC-1** | 甲 | T2 | A1 |", "| **AC-1** | 甲 | T2 |  |"))
    assert.throws(() => checkAnchorsAndACs(copy.read(), decl, "copy.md"),
      (e) => e instanceof ShapeViolation && e.message.includes("AC-1 层标 T2") && e.message.includes("必须有锚"),
      "负控腿 4①（闸 B）：T2 的锚列清空 ⇒ 必红（T3 与「连 T3 都不是」才免锚——D16-4）")
    // 负控 ②（**反向 / 孤儿锚腿**）：删掉引用某锚的全部 AC 行且**不给**豁免标记 ⇒ 必红并点名该锚
    //   ★ 每步都从**干净的夹具**重写（不复用上一步的临时态），否则上一步的违规会污染本步的判定
    shapeTempWrite(dir, "copy.md", SHAPE_FIXTURE.replace("| **AC-2** | 甲 | T2 | A2 |\n", ""))
    assert.throws(() => checkAnchorsAndACs(copy.read(), decl, "copy.md"),
      (e) => e instanceof ShapeViolation && e.message.includes("反向腿——锚 A2")
        && !e.message.includes("反向腿——锚 A1"),
      "负控腿 4②（反向腿）：A2 失去全部 AC 引用且无 `（豁免：…）` ⇒ 必红（且只点名 A2）")
    // 阴性对照（防「反向腿恒红」的假绿）：同一形态 + 给 A2 那一行加**显式豁免标记** ⇒ 反向腿不再报
    shapeTempWrite(dir, "copy.md",
      SHAPE_FIXTURE.replace("| **AC-2** | 甲 | T2 | A2 |\n", "")
        .replace("| **A2** | 甲 | 乙 | 丙 |", "| **A2** | 甲 | 乙 | 丙（豁免：测试用，不挂单项 AC） |"))
    assert.deepEqual(checkAnchorsAndACs(copy.read(), decl, "copy.md"), { anchors: 2, acs: 1, referenced: 1 },
      "阴性对照：未引用的锚带显式豁免标记 ⇒ 反向腿不报（该腿不是恒红）")
    // —— 补面（并入本块，不新开顶层 test()）：AC-8 的另外两面 + AC-7 的免锚行仍须验锚 ——
    // ① 免锚合法：**T3** 行写 `—`、以及层标**连 T3 都不是**（`—`）的行留空 ⇒ 都绿
    shapeTempWrite(dir, "copy.md", SHAPE_FIXTURE + "| **AC-3** | 甲 | T3 | — |\n| **AC-4** | 甲 | — |  |\n")
    assert.deepEqual(checkAnchorsAndACs(copy.read(), decl, "copy.md"), { anchors: 2, acs: 4, referenced: 2 },
      "免锚例外在位：T3 写 `—` 与层标「连 T3 都不是」留空 ⇒ 均判绿（D16-4）")
    // ② 免锚行**引了锚**时，「锚 id 必须已定义」仍生效（图 3 的 G 节点）
    shapeTempWrite(dir, "copy.md", SHAPE_FIXTURE + "| **AC-3** | 甲 | T3 | A7 |\n")
    assert.throws(() => checkAnchorsAndACs(copy.read(), decl, "copy.md"),
      (e) => e instanceof ShapeViolation && e.message.includes("AC-3 引用了**不存在的锚** A7"),
      "免锚行引用的锚仍必须已定义（免锚 ≠ 免检）")
    // ③ AC 号不重复 ⇒ 同一 AC 号出现两次必红
    shapeTempWrite(dir, "copy.md", SHAPE_FIXTURE + "| **AC-1** | 甲 | T2 | A1 |\n")
    assert.throws(() => checkAnchorsAndACs(copy.read(), decl, "copy.md"),
      (e) => e instanceof ShapeViolation && e.message.includes("AC 号重复：AC-1"),
      "AC 号不重复：同号出现两次 ⇒ 必红")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("DOC-HYGIENE 批 16 负控腿 5（锚 A7 / AC-6）: AC 表某行末列删掉（cell 数少 1）⇒ 闸 A 必红", () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-shape-l4a-"))
  try {
    const copy = shapeTempWrite(dir, "copy.md", SHAPE_FIXTURE)
    const decl = parseDocShape(copy.read())
    // 阳性对照：cell 数 == 表头列数 ⇒ 闸 A 不报（上面那条 deepEqual 已证，这里再钉一次列数）
    assert.match(copy.read(), /\| # \| 验收标准 \| 层 \| 锚 \|/, "夹具的 AC 表表头必须可定位")
    // 负控：把 AC-1 行的**末列删掉**（cell 数 3 < 表头 4）⇒ 必红
    shapeTempWrite(dir, "copy.md", copy.read().replace("| **AC-1** | 甲 | T2 | A1 |", "| **AC-1** | 甲 | T2 |"))
    assert.throws(() => checkAnchorsAndACs(copy.read(), decl, "copy.md"),
      (e) => e instanceof ShapeViolation && e.message.includes("AC 表 cell 数 3 != 表头列数 4"),
      "负控腿 5（闸 A）：AC 表某行 cell 数少 1 ⇒ 必红（防 `|` 缺失导致串列）")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
