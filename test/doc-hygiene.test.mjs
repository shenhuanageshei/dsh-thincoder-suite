// doc-hygiene.test.mjs — 批 11：DOC-HYGIENE 的机械层（D6「回读核对」的一般规则 → 机械网）。
// 设计档：docs/2026-09-13-doc-discipline-design.md
//   §6.4 两项机械检查（U+FFFD 全仓 + 常设档 canary）· §8.2 机验锚 V1…V14 · §11 本批**不可真机验证**清单（未重启 DSH）
//   §8.1-8 六串锁的权威作用域（`lib/**` 内命中 = 0）· §6.1 冻结交付文本 · §6.2 失败后缀块
//
// 本档用例（顶层 `test(` 数 = 24，台账 docs/test-lifecycle.md §三 同数）：
//   ① U+FFFD 全仓扫描（锚 V13）
//   ② 常设档 canary（锚 V14）+ 规范层形状与纪律（锚 V1/V2/V3/V4——按 §6.4 的「并入既有 test() 块」）
//      + **登记完备（批 13 / R-25 / AC-14·AC-15 / 锚 V8——同走「并入既有块」）**
//      + **批 16 形状声明解析 + 四条腿对真实档实跑 + `scanned >= 1`（锚 A1–A8——同走「并入既有块」）**
//   ③ 批 11 新文本六串负向（锚 V5）+ 正向锚与划界（锚 V10 / V11② / V12②/③）
//   ④ 失败后缀块与出口边界（锚 V6 / V7 / V8）
//   ⑤–⑨ **批 16 五条负控腿**（锚 A7 / AC-11）：腿 1 · 腿 2 · 腿 3 · 腿 4 闸 B（含**反向孤儿锚腿**）·
//      腿 4 闸 A——每条各为一个顶层 `test(`（AC-10：`用例数 = 基线 + 5`；**★ 代码评审 #2 订正：**
//      修复轮 F9/F10 各增一条 ⇒ 基线 + 7；**★ 代码评审 #6 订正：** 零数据行闸再增一条 ⇒
//      **终值 = 基线 + 8**，**批 16 交付时点本档顶层 `test(` = 12**（**★ 分歧审计 F6 订正：本行原写「本档顶层 `test(` 总数为 12」，与档首 L6 的「= 24」在同档头里相抵——那是批 16 时点的值被当成本档总数读；本档现为 24**），**全部在仓外临时档/临时副本上构造**
//   ⑩ **批 16 修复轮 F9 负控腿**（**闸 0：行被吞**）：表体被非表行截断且其后仍有表行 ⇒ 必红；
//      含**阴性对照**（表自然结束 ⇒ 不红；`|` 裸写在散文里 ⇒ 不红）——纯内存夹具，零临时档
//   ⑪ **批 16 修复轮 F10 负控腿**（**闸 A 报红后不得整行丢弃**）：残缺行**仍参与 AC 号提取**
//      （只跳其锚列判定）——含 F10 两条下游误报的可观察面 + 反向腿结构性边界 + 两条零回归对照
//   ⑫ **批 16 代码评审 #6 负控腿**（**零数据行闸 · §9 空集类②「零行」**）：锚表 / AC 表
//      **任一张只有表头 + 分隔线、零数据行** ⇒ 必红（两张表**各报各的**、点名哪张表空）；
//      含**阴性对照**（正常表头 + 分隔线 + 一行数据 ⇒ 不报）——纯内存夹具，零临时档
//
// ★ 批 17 新增 **12 条顶层用例**（**`test(` 12 → 24**；台账 §三 同批同步——`T-LC2` 等值锁）：
//   ⑬ **批 17 负控腿 1**（**锚 A1 / AC-4 · FR-0a**）：**深度感知闭括号**——`（3 项：a（§1）· b · c）`
//      ⇒ 3 == 3 绿；**改前**取首个 `）` ⇒ 截断 ⇒ 假红（`legacyCountMarks` 复现）
//   ⑭ **批 17 负控腿 2**（**锚 A2 / AC-5 · FR-0b**）：**围栏状态机掩码**——围栏内**整块**（标记与路径）
//      不受检；改前围栏内容裸奔 ⇒ 假红（同一链接写到围栏外照旧红，即其反面实证）
//   ⑮ **批 17 负控腿 3**（**锚 A1b / AC-4b · FR-0c**）：**掩码改非空白占位符**——项**整体住在代码 span 里**
//      （``（2 档：`a.md` · `b.md`）``）⇒ 2 == 2 绿；**改前**空格掩码 ⇒ `actual=0` ⇒ 假红
//   ⑯ **批 17 负控腿 4**（**锚 A3 / A4 / AC-1 · FR-1**）：两种标记形态共用匹配器 · **全枚举禁省略** ·
//      **id 字符集排除 `@` 与竖线**（且「不接受」的方向是**红**，不是静默不认）
//   ⑰ **批 17 负控腿 5**（**锚 A8 / AC-11 · FR-3**）：**双模式真值表**——未声明档三条宽松约束**各自跳过**；
//      声明档**同构造 ⇒ 红**（成对）；带 `id=` 一律严格
//   ⑱ **批 17 负控腿 6**（**AC-2 / R-1…R-8 · FR-4**）：值**只从标记载荷取** · 集合 trim 后精确串等值且
//      顺序无关 · 措辞与量词不入等值 · 报错含全部出现处的 `文件:行:原文`
//   ⑲ **批 17 负控腿 7**（**锚 A5 / A6 / A7 · AC-1…AC-3 · FR-2**）：**事实 id 腿**——**不变量①**（同 id 异值 ⇒
//      红 ＋ 报全部出现处）· **不变量②**（`@N` 次数）· **防恒真**（全域零个多次组 ⇒ 红）· 集合成员比对
//   ⑳ **批 17 负控腿 8**（**锚 A9 / AC-6 · AC-7 · FR-5**）：**CHANGELOG 两态定位器**（死区态 / 首节态 /
//      死区 >1 处 ⇒ 红 / 两态都不含 ⇒ 红）＋ **锚定行抽取** ＋ **与既有解析器的等值锁**（含反面）
//   ㉑ **批 17 负控腿 9**（**锚 A9b / AC-6b**）：**绑定规则三槽**（`changelog.nsN` / `.baseline` / `.added`）＋
//      **畸形绑定三条**（未知源/槽 · 缺 `@N` · 同 `bind` 双占）＋ 合法绑定 ⇒ 与 docs 侧同值
//   ㉒ **批 17 负控腿 10**（**锚 A10 / AC-8 · FR-6**）：`CUTOFF` 后无声明 ⇒ 红；**CUTOFF 前 / 非日期前缀 ⇒ 绿**
//   ㉓ **批 17 负控腿 11**（**锚 A11b / AC-9b · FR-6b**）：已声明档内有 AC 形表而无 `acs` ⇒ 红（锚形表同理）；
//      **普通表 ⇒ 不红** · **未声明档 ⇒ 不跑**（fail-open）
//   ㉔ **批 17 负控腿 12**（**锚 A11 / AC-9 · FR-6**）：**exempt 四闸**各自红 ＋ 超 `EXEMPT_BUDGET` ⇒ 红
//
// ★ 批 17 的三处**既有正确性修复**（FR-0a/0b/0c）**先于**一切新判据落地；**扫描域**改为
//   `docs/**` 递归（− `docs/consult-minutes/**`）＋ `CHANGELOG.md`：**腿 1 全域跑**（宽松档位），
//   **腿 2 / 腿 3 / 腿 4 / `require-facts` 仍只在声明档**（严格腿）。
// ★ 批 17 的**腿 4 id 抽取口径放宽**为「可选一个小写后缀」（设计档自己命名的 `A1b`/`AC-4b` 等
//   照旧口径根本不可表达）；**对无后缀 id 行为逐字不变**（批 16 八条负控腿零回归为证）。
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
// ★ 批 17 FR-5 的**等值锁**：**只读** `release-check.mjs` 的既有导出（该档本批**零改动**——
//   需求档 §5.1 第 5 项「不动 `release-check.mjs` 的既有闸」；读不算动）。
import { parseChangelogCountLine } from "../release-check.mjs"

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
  // ★ A7：**全域 ≥1 个「≥2 出现处的组」**（防恒真）——真实域上真的比过至少一组，不是只跑了空集
  assert.ok(shape.factStats.multiGroups >= 1,
    "A7：全域「≥2 处档内出现的事实 id 组」必须 ≥1，实测 " + shape.factStats.multiGroups
    + "（零组 ⇒ 该腿恒真——D16-7 同律）")
  // 实测值打印（锚 A2 的 `scanned` 必须**可被人读到**，不只是被断言）
  t.diagnostic("批 16/17 形状谓词实测：扫描域 " + shape.files + " 档（− 纪要子目录 ＋ CHANGELOG.md）· 进作用域 scanned="
    + shape.scanned + " · 腿 1 核到标记 " + shape.leg1Hits + " 处（其中宽松档 " + shape.leg1Loose + " 档）· 腿 2 实跑 "
    + shape.leg2Runs + " 档 · 腿 3 受检引用 " + shape.leg3Checked + " 条 · 腿 4 实跑 " + shape.leg4Runs + " 档 ⇒ "
    + shape.leg4Stats.join(" "))
  t.diagnostic("批 17 事实 id 腿实测：组 " + shape.factStats.groups + " 个 · 其中 ≥2 处档内出现的组 "
    + shape.factStats.multiGroups + " 个 · **注册事实**里 ≥2 处出现的 " + JSON.stringify(shape.regMulti)
    + " · 出现处合计 " + shape.factStats.occurrences
    + " · CHANGELOG 定位态 " + shape.lock.state + "（行 " + shape.lock.line + " · 等值锁 "
    + (shape.lock.state === "first-section" ? (shape.lock.locked ? "已生效" : "未生效") : "不适用（死区态）") + "）")
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

/** 形状声明的合法键（§5.1 ＋ 批 17 新增的 `require-facts` / `mode`）。未知键 ⇒ 红（§9 畸形输入，**不得**静默降级为空声明）。 */
const SHAPE_KEYS = new Set(["anchors", "acs", "count-marks", "compare", "require-facts", "mode"])
/** `mode` 的合法取值（§5.7 D17-6：本批只认 `exempt`）。 */
const SHAPE_MODES = new Set(["exempt"])
/**
 * **绑定规则的槽位表**（§5.6 的三槽；评审 #3 补入的语法）。
 * 源恒为 `changelog`；槽 `nsN` / `baseline` / `added` 各自对应定位行内的一个数。
 * ★ 未知源 / 未知槽 ⇒ **红**（fail-closed）。**★ 分歧审计 F6 订正：本行原写「当前没有任何条目」——那是 stage 3 时点的真值；收口后本批两档各带一处活绑定**（`b17-全量用例数@1 bind=changelog.nsN` · `b17-用例增量@1 bind=changelog.added`），**且负控腿 9 就在验它们**。
 */
const SHAPE_BIND_SLOTS = new Set(["nsN", "baseline", "added"])
/** 槽 → 抽取器字段（§5.6 的三槽各自对应 `shapeExtractCountLine` 的一个输出字段）。 */
const SHAPE_BIND_FIELD = { nsN: "actual", baseline: "baseline", added: "added" }
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
 * 形状声明的解析（§5.1 / §6 的 `parseDocShape`；批 17 增加 `require-facts` 与 `mode` 两个键）。
 * @pre  `src` 是整档文本
 * @post 无声明 ⇒ 返回 `null`（该档**完全跳过**）；有声明 ⇒ 返回键值对象
 *       **绝不**在解析失败时静默返回「空声明」（那会让谓词空转 ⇒ 恒真）
 *       `require-facts` ⇒ `[{ id, n, bind }]`（**畸形绑定 ⇒ 抛**，见 `parseRequireFacts`）
 */
function parseDocShape(src) {
  const m = SHAPE_DECL_RE.exec(String(src))
  if (m === null) return null
  const decl = {
    anchors: null, acs: null, compare: null, "count-marks": SHAPE_DEFAULT_MARKS.slice(),
    "require-facts": [], mode: null, "exempt-reason": null,
    /** **显式出现过的键集**（exempt 闸 1「独键」要靠它——缺省值不算「写了这个键」）。 */
    keys: new Set(),
  }
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "") continue
    const at = line.indexOf(":")
    if (at < 0) throw new Error("doc-shape 声明畸形（缺冒号）：" + JSON.stringify(line))
    const key = line.slice(0, at).trim()
    const val = line.slice(at + 1).trim()
    if (!SHAPE_KEYS.has(key)) throw new Error("doc-shape 声明含未知键：" + JSON.stringify(key))
    if (val === "") throw new Error("doc-shape 声明的键值为空：" + JSON.stringify(key))
    decl.keys.add(key)
    if (key === "mode") {
      const mode = val.split(/[（(]/)[0].trim() // `mode: exempt（理由）`——理由内联在同一行
      if (!SHAPE_MODES.has(mode)) throw new Error("doc-shape 的 mode 取值非法：" + JSON.stringify(val))
      decl.mode = mode
      decl["exempt-reason"] = val.slice(val.indexOf(mode) + mode.length).replace(/^[\s（(]+/, "").replace(/[）)]+$/, "").trim()
      continue
    }
    decl[key] = key === "count-marks"
      ? val.split("|").map((s) => s.trim()).filter((s) => s !== "")
      : key === "require-facts" ? parseRequireFacts(val) : val
  }
  return decl
}

/**
 * `require-facts: id@N|id@N bind=<源>.<槽>` 的解析（§5.3 不变量② · §5.6 绑定语法）。
 * @post `[{ id, n, bind }]`；**畸形 ⇒ 抛（红）**：
 *   · 条目缺 `@N` · `bind=` 指向**未知源 / 未知槽** · **同 `bind` 被两个 id 占用** · **同 id 两条声明**
 * ★ `@N` 的计数语义（§5.6 · 评审 #8 的裁定）：**只数「档内标记的出现次数」，绑定出现不计入**。
 */
function parseRequireFacts(val) {
  const out = []
  const bound = new Map()
  const seen = new Set()
  for (const rawEntry of String(val).split("|")) {
    const entry = rawEntry.trim()
    if (entry === "") throw new Error("require-facts 含空条目：" + JSON.stringify(val))
    const m = /^([^\s@|]+)\s*@\s*([0-9]+)(?:\s+bind=([^\s|]+))?$/.exec(entry)
    if (!m) throw new Error("require-facts 条目畸形（期望 `id@N` 或 `id@N bind=<源>.<槽>`）：" + JSON.stringify(entry))
    const id = m[1]
    const n = Number(m[2])
    if (seen.has(id)) throw new Error("require-facts 里同一 id 声明了两次：" + JSON.stringify(id))
    seen.add(id)
    let bind = null
    if (m[3] !== undefined) {
      const parts = m[3].split(".")
      const [source, slot] = parts
      if (parts.length !== 2 || source !== "changelog" || !SHAPE_BIND_SLOTS.has(slot)) {
        throw new Error("require-facts 的绑定畸形（未知源或未知槽，期望 `bind=changelog.<nsN|baseline|added>`）："
          + JSON.stringify(m[3]))
      }
      if (bound.has(m[3])) throw new Error("同一条 `bind=` 被两个 id 占用：" + JSON.stringify(m[3]))
      bound.set(m[3], id)
      bind = { source, slot }
    }
    out.push({ id, n, bind, raw: entry })
  }
  return out
}

// ═══════════ 批 17 · FR-0：三处既有正确性修复（掩码与闭括号） ═══════════
// 设计档 `docs/2026-09-17-scope-alignment-design.md`：**§5.1 FR-0a/FR-0b/FR-0c** ·
// **§8.2 锚 A1 / A1b / A2** · **§10.3 AC-4 / AC-4b / AC-5** · **§9.2 CE-4 / CE-6**。
// ★ 三处都是**修缺陷**（不是加豁免），且**先于**本批任何新判据落地（stage 1）。

/**
 * **非空白占位符**（FR-0c）。掩码字符由「空格」改为它 ⇒ **「该段非空」的判定不受掩码影响**，
 * 而**内容仍不可被匹配器读到**（占位符不是数字 / `·` / `）` / 反引号）。
 * ★ 改前的空格掩码会把「**项整体住在代码 span 里**」的列表整段掩成空白 ⇒ 段 trim 后为空 ⇒
 *   `actual=0` ⇒ **假红**；而**本仓文风必然把档名写成反引号** ⇒ 本批两档的标记示例正是这种形态。
 */
const SHAPE_PLACE = "\u0000"
/** 同长非空白占位符串（掩码体的唯一构造点）。 */
const shapePlace = (s) => SHAPE_PLACE.repeat(s.length)

/**
 * 行内代码 span 掩码器（§5.2 边界① / §5.4 腿 3 的豁免面 / D16-5 · **FR-0c 改占位符**）。
 * 把 `` `…` `` 连同反引号替换成**同长度非空白占位符** ⇒ 行列偏移不变，而**代码 span 之内**的内容
 * 再也不可能被匹配到——这就是「**代码 span 之内一律跳过（豁免）**」的那条分支。
 * ★ 受检引用的字符类必须**显式排除占位符**（见 `checkRefs` 的 `linkRe`）——改前掩码体是空白、
 *   天然被 `\s` 排除；改占位符后若不排除，掩码体就能被 `[^)\s]+` 吃进链接目标 ⇒ 假红。
 */
const maskCodeSpans = (line) => line.replace(/`[^`]*`/g, shapePlace)

/**
 * **FR-0b 围栏状态机掩码**（CE-6：批 16 的掩码器只认行内 span ⇒ 围栏块裸奔）。
 * @pre  逐档调用，`st = { inFence }` **跨行维护**
 * @post 围栏（``` 起，``` 止）内的**整行**内容被掩成同长非空白占位符 ⇒ 其内的标记与路径不受检
 *       ★ 围栏界定行**本身**也被掩（它与围栏内同待遇）；
 *       ★ 与行内 span 同待遇；**本批自己的语法规格块靠它才不误红**（设计档 §5.1 的影响面自证）。
 */
function maskFenced(line, st) {
  const isFence = /^\s*```/.test(line)
  if (st.inFence) {
    if (isFence) st.inFence = false
    return shapePlace(line)
  }
  if (isFence) {
    st.inFence = true
    return shapePlace(line)
  }
  return maskCodeSpans(line)
}

/**
 * 逐档掩码（**围栏掩码先于行内 span 掩码**，两者都用非空白占位符——§5.1 FR-0c 的顺序）。
 * 返回**逐行**掩码文本（与 `lf(text).split("\n")` 逐行对应，行号不变）。
 */
function shapeMaskDoc(text) {
  const st = { inFence: false }
  return lf(text).split("\n").map((line) => maskFenced(line, st))
}

/**
 * **FR-0a 深度感知闭括号**（§5.1 · 锚 A1 · AC-4）。
 * @pre  `rest` 是标记（`（N 量词…：`）之后的同段文本
 * @post 返回**与本标记配对**的闭括号下标；全角 `（` 深度 +1、`）` 深度 −1，**归零处才是本标记的闭括号**
 *       ⇒ `（§3）` 式引注**不再截断列表**；同段内找不到配对闭括号 ⇒ `-1`
 * ★ 改前取**首个** `）` ⇒ 任何全角嵌套引注都截断 ⇒ 项数误判（**假红**）。
 */
function findMatchClose(rest) {
  let depth = 0
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (ch === "（") depth++
    else if (ch === "）") {
      if (depth === 0) return i
      depth--
    }
  }
  return -1
}

// ═══════════ 批 17 · FR-1：事实标记语法（设计档 §5.2） ═══════════

/**
 * **事实 id 的字符集**（§5.2）：`[^\s（）：·@|]+`。
 * ★ `@` 与 `|` **必须排除**——它们是 `require-facts: id@N|id@N` 的**分隔符**，
 *   不排除则事实腿的解析必与 `require-facts` 的解析打架（会诊 #4 [2] 的语法补丁）。
 * ⇒ 含 `@` 或 `|` 的 id **不被接受**（锚 A4）：该处**连标记都不成立**（不是「接受后再报错」）。
 */
const SHAPE_ID_CHARS = "[^\\s（）：·@|]+"

/** 量词集合 → 正则片（缺省 = 七量词；**逃逸**，否则 `·` 这类元字符会炸）。 */
const shapeUnitsSrc = (marks) => (marks && marks.length > 0 ? marks : SHAPE_DEFAULT_MARKS)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|")

/**
 * **FR-1：两种标记形态共用的匹配器**（§5.2 · §6 的 `parseFacts` 底座）。
 * | 形态 | 字面 | 值 |
 * |---|---|---|
 * | **全枚举形** | `（8 条 id=X：a · b · …）` | `(N, 项集)`；**禁省略**（项数判据复用腿 1 的 `N == 项数`） |
 * | **裸引用形** | `（8 条 id=X）` | `N`（无列表可比） |
 * ★ 旧标记（无 id）**保持合法**（§9 升级类：旧语法不退化）——它与全枚举形**同一个正则**（id 段可选）。
 * @return `[{ at, head, headLen, segStart, segEnd, id, n, unit, enumerated }]`（按 `at` 升序）
 */
function shapeMarksInLine(maskedLine, marks) {
  const units = shapeUnitsSrc(marks)
  const colon = new RegExp("（([0-9]+)\\s*(" + units + ")(?:\\s+id=(" + SHAPE_ID_CHARS + "))?：", "g")
  const bare = new RegExp("（([0-9]+)\\s*(" + units + ")\\s+id=(" + SHAPE_ID_CHARS + ")）", "g")
  const out = []
  for (const m of maskedLine.matchAll(colon)) {
    const segStart = m.index + m[0].length
    const close = findMatchClose(maskedLine.slice(segStart))
    const segEnd = close < 0 ? maskedLine.length : segStart + close
    out.push({
      at: m.index, head: m[0], headLen: m[0].length, segStart, segEnd,
      id: m[3] ?? null, n: Number(m[1]), unit: m[2], enumerated: true,
    })
  }
  const colonSpans = out.map((h) => [h.at, h.segEnd + 1])
  for (const m of maskedLine.matchAll(bare)) {
    if (colonSpans.some(([a, b]) => m.index >= a && m.index < b)) continue // 与全枚举形重叠 ⇒ 不重复计
    out.push({
      at: m.index, head: m[0], headLen: m[0].length, segStart: null, segEnd: null,
      id: m[3], n: Number(m[1]), unit: m[2], enumerated: false,
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

/**
 * **FR-1/FR-2：`parseFacts`**（设计档 §6 的伪代码）。
 * @pre  无（未声明档也跑，只要标记带 `id=`）
 * @post `hits = [{ file, line, raw, id|null, n, unit, items|null }]`——**id 为 null = 普通计数标记**
 *       ★ **值只从标记载荷取**（R-1/R-2：项集取**未掩码原文**的对应区间 ⇒ span 里的档名是**真值**，
 *         而不是掩码占位串；标记外的散文永不入值）
 */
function parseFacts(text, file = "(内存档)", marks = SHAPE_DEFAULT_MARKS) {
  const rawLines = lf(text).split("\n")
  const maskedLines = shapeMaskDoc(text)
  const out = []
  for (let i = 0; i < maskedLines.length; i++) {
    for (const h of shapeMarksInLine(maskedLines[i], marks)) {
      out.push({
        file, line: i + 1, raw: h.head, id: h.id, n: h.n, unit: h.unit,
        items: h.enumerated
          ? rawLines[i].slice(h.segStart, h.segEnd).split("·").map((s) => s.trim()).filter((s) => s !== "")
          : null,
        enumerated: h.enumerated,
      })
    }
  }
  return out
}

// ═══════════ 批 17 · FR-4：归一化（R-1…R-8，**值只从标记载荷取**） ═══════════

/** R-1/R-8：标量 = 标记载荷里的非负整数（整数比较；不做任何词典归一）。 */
const shapeScalar = (n) => Number(n)
/**
 * R-3：**集合等值**——元素 **trim 后精确串等值、顺序无关**（`sort()` 归一顺序，**不解释内容**）。
 * ★ 元原则（D17-8）：**归一只许修呈现，永不许修语义**——本函数只做 trim 与排序，
 *   不做同义词 / 饰词 / 量词 / 全半角折叠（那些会把真污染洗成绿）。
 */
const shapeSet = (items) => (items ?? []).map((s) => s.trim()).sort()
/** R-4：混合形态——每个全枚举处**强制 `N == |集|`**（腿 1 既有）；跨处只比标量。 */
const shapeSetEqual = (a, b) => shapeSet(a).join("\u0001") === shapeSet(b).join("\u0001")
/**
 * R-6：**报错面 = 全部出现处的 `文件:行:原文`**（绝不只报归一值——否则「8 vs 8」对人不可复核）。
 */
const shapeOccurrences = (hits) => hits.map((h) => h.file + ":" + h.line + ":" + h.raw).join(" │ ")

/**
 * 腿 1：计数 ↔ 列表（§5.2 · AC-1 / AC-2 · 锚 A1/A3 · US-1）。
 * @pre  只在**已声明**的档上调用；`marks` = 量词集合（空 ⇒ 用七量词缺省）
 * @post 每个 `（N <量词>：` 标记的 `·` 项数 == N；违规文本含 **文件:行 + 声明值 + 实际值**
 *       （三者缺一即不可定位——AC-2）
 * ★ 三条边界（缺一即错，§5.2）：
 *   ① **行内代码 span 一律豁免**（否则谓词会对本批两档自己的示例报红）；
 *      ★ 批 17 **FR-0b** 把这条边界扩到**围栏块**（`maskFenced`：围栏内整行同待遇）；
 *      ★ 批 17 **FR-0c** 把掩码字符由空格改成**非空白占位符**（项整体住 span 里时不再被判空段）；
 *   ② **`N` 只认阿拉伯数字**（字面 `N` 不匹配——否则规范文本本身会触发）；
 *   ③ **只数同一行内的 `·` 项**（跨行不算——跨行会让「N 项」失去肉眼可核性）。
 * ★ 批 17 **FR-0a**：闭括号由 `findMatchClose` **按全角嵌套深度配对**（改前取首个 `）`
 *   ⇒ 任何 `（§3）` 式引注都截断列表 ⇒ 项数误判）。
 * @return 该档被核到的标记数
 */
function checkCountMarks(text, marks, file = "(内存档)", opts = {}) {
  const declaredDoc = opts.declared === true
  const bad = []
  let hits = 0
  const maskedLines = shapeMaskDoc(text) // ← 边界①：围栏（整行）+ 行内 span（行级）双重掩码
  const usedMarks = declaredDoc ? marks : SHAPE_DEFAULT_MARKS // §5.4：自定义量词集只在**声明档**生效
  const units = shapeUnitsSrc(usedMarks)
  // ★ §9.1 畸形输入（fail-closed）：**id 含 `@` 或 `|` ⇒ 不接受**（它们是 `require-facts` 的分隔符）。
  //   ★ 方向必须是**红**而不是「静默不认这个标记」——后者是 fail-open（一个畸形 id 就能让该处的
  //     计数检查整条消失）。⇒ 用**更宽的 id 类**先把它捞出来，再点名报红。
  const badId = new RegExp("（([0-9]+)\\s*(" + units + ")\\s+id=([^\\s（）：·]*[@|][^\\s（）：·]*)\\s*[：）]", "g")
  for (let i = 0; i < maskedLines.length; i++) {
    for (const m of maskedLines[i].matchAll(badId)) {
      bad.push(file + ":" + (i + 1) + ": 事实 id " + JSON.stringify(m[3])
        + " 含 `require-facts` 的分隔符（`@` / `|`）⇒ **不接受**（§5.2 的 id 字符集排除它们；fail-closed）")
    }
    for (const h of shapeMarksInLine(maskedLines[i], usedMarks)) {
      if (!h.enumerated) continue // 裸引用形（无 `：`）没有列表可比 ⇒ 腿 1 不核它
      hits++
      const seg = maskedLines[i].slice(h.segStart, h.segEnd)
      const declared = h.n
      // ★ **FR-3 双模式真值表**（§5.4 · §8.2 A8 · K6）：
      //   严格档位 = **声明档 ∨ 该处带 `id=`**（**带 id 一律严格**——未声明档也不例外）；
      //   宽松档位 = 未声明档 ∧ 无 id（**三条宽松约束**只在它上面生效）。
      const strict = declaredDoc || h.id !== null
      if (strict) {
        // 批 16 语义**原样保留**：项数 = 本行内非空的 `·` 分隔段数（空段不计入 ⇒ `（2 项：a ·` 判 1 ⇒ 红）
        const actual = seg.split("·").filter((s) => s.trim() !== "").length
        if (actual !== declared) {
          bad.push(file + ":" + (i + 1) + ": 声明 " + declared + " " + h.unit
            + " · 实际 " + actual + " " + h.unit + "（标记字面 " + JSON.stringify(h.head) + "）")
        }
        continue
      }
      // —— 宽松档位（未声明档，新增）：三条保守约束，**跳过 ≠ 抓到**（代价见设计档 §9.2）——
      // ① **段内零 `·` 且 N≥2 ⇒ 跳过**（杀 CE-2/CE-3 的零段形态：顿号 / 带圈序号 / 跨行枚举）
      if (!seg.includes("·") && declared >= 2) continue
      // ③ **尾随 `·`（末段为空）⇒ 跳过**（杀 CE-7 的折行形态：它更像「列表在下一行继续」而非断言）
      const rawSegs = seg.split("·")
      if (rawSegs[rawSegs.length - 1].trim() === "") continue
      // ② **只认两侧带空格的 ` · `**（杀 CE-1 的译名 `·`——`爱因斯坦` 两侧无空格不算分隔符）
      const items = seg.split(/\s·\s/).filter((s) => s.trim() !== "")
      // N≥2 而宽松分隔符一个都没有 ⇒ 该形态不可核 ⇒ 跳过（与 ① 同族的 fail-open）
      if (declared >= 2 && items.length === 1) continue
      if (items.length !== declared) {
        bad.push(file + ":" + (i + 1) + ": 声明 " + declared + " " + h.unit
          + " · 实际 " + items.length + " " + h.unit + "（宽松模式·标记字面 "
          + JSON.stringify(h.head) + "）")
      }
    }
  }
  shapeThrow(bad)
  return hits
}

// ═══════════ 批 17 · 扫描域（§4 D17-10 · §5.3 · FR-5） ═══════════
//
// **域 = `docs/**` 递归 − `docs/consult-minutes/**` ＋ `CHANGELOG.md`**（三层精确定义）：
//   · **腿 1 全域跑**（宽松腿：零存量红是它的验收条件，N-2 的第二次订正口径）；
//   · **腿 2 / 腿 4 / `require-facts` 只跑声明档**（严格腿）；
//   · **`docs/consult-minutes/**` 排除**——理由不是白名单而是**范畴**：**机器产物无作者契约**
//     （纪要是逐字记录面、内容不可控且按纪律不能润色）；实测该子目录有 **7 处**扩展标记形命中。

/** 交付时点的批次档日期切点（§5.7 D17-4）；消费者见 `checkDeclarationDuty`。 */
const SHAPE_CUTOFF = "2026-09-16"

/** 扫描域（批 17 口径）：`docs/**`（递归，排除纪要子目录）＋ `CHANGELOG.md`。 */
const shapeDomainFiles = () => walkText(join(PLUGIN_DIR, "docs"))
  .filter((f) => f.endsWith(".md") && !f.startsWith("docs/consult-minutes/"))
  .concat("CHANGELOG.md")
  .sort()

/** 读域内全部档（**不做声明过滤**——腿 1 的宽松档位要靠它跑全档）。 */
function shapeReadDomain(files = shapeDomainFiles(), loader = read) {
  const out = []
  for (const f of files) {
    const text = lf(loader(f))
    out.push({ file: f, text, decl: parseDocShape(text) })
  }
  return out
}

// ═══════════ 批 17 · FR-5：CHANGELOG 两态定位器（设计档 §5.6 · 图 3） ═══════════
//
// ★ 交付时点与收口后是**两个不同的态**：新条目落在「**死区**」（`# Changelog` 到首个 `## [` 之间），
//   而 `parseChangelogCountLine` **永远只读首节** ⇒ 直接复用它会把本批绑到**上一批的数**上 ⇒
//   交付时点**必红**（假红）。⇒ 定位器必须两态；`【计数行】` 是批 16 条目里**已在用**的显式标记，
//   本批把它**升格为定位契约**（零新造语法，与 N-1 兼容）。

/** 定位契约的显式标记（批 16 条目里已在用；本批把它升格为契约）。 */
const SHAPE_COUNT_MARK = "【计数行】"

/**
 * **FR-5 定位器**（锚 A9）：切「死区」= `# Changelog` 到**首个 `## [`** 之间。
 * @post `{ state, line, text }`——`state ∈ {"deadzone","first-section"}`；`line` = 命中行号（1-based）
 *       · 死区含**恰 1 处** `【计数行】` ⇒ 绑死区（交付时点态）
 *       · 死区含 **>1 处** ⇒ **红**（两批同飞不是本仓惯例，fail-closed）
 *       · 死区 0 处 ⇒ **首节含 ⇒ 绑首节**（收口后态）；**两处都不含 ⇒ 红**（定位失败不是跳过）
 */
function shapeLocateCountLine(text, file = "CHANGELOG.md") {
  const lines = lf(text).split("\n")
  const iHead = lines.findIndex((l) => /^#\s+Changelog\s*$/.test(l))
  const iFirst = lines.findIndex((l) => /^##\s*\[/.test(l))
  if (iHead < 0 || iFirst < 0) {
    shapeThrow([file + ": CHANGELOG 两态定位器**定位失败**（缺 `# Changelog` 标题或缺首个 `## [x.y.z]` 版本头）"
      + "⇒ 红（§9：定位失败**不是跳过**）"])
  }
  const pick = (from, to) => {
    const hits = []
    for (let i = from; i < to && i < lines.length; i++) if (lines[i].includes(SHAPE_COUNT_MARK)) hits.push(i)
    return hits
  }
  const dead = pick(iHead + 1, iFirst)
  if (dead.length > 1) {
    shapeThrow([file + ": **死区**（`# Changelog` 到首个版本头之间）含 " + dead.length
      + " 处 `" + SHAPE_COUNT_MARK + "`（期望 ≤1）⇒ 红（两批同飞不是本仓惯例，fail-closed）"])
  }
  if (dead.length === 1) {
    return { state: "deadzone", line: dead[0] + 1, text: lines[dead[0]] }
  }
  const first = pick(iFirst, lines.length)
  if (first.length === 0) {
    shapeThrow([file + ": **两态都不含** `" + SHAPE_COUNT_MARK + "`（死区 0 处 · 首节 0 处）⇒ 红（§9：定位失败不是跳过）"])
  }
  // 首节 = 首个版本头到下一个版本头之间（与 `firstChangelogSection` 同口径）
  const next = lines.findIndex((l, i) => i > iFirst && /^##\s*\[/.test(l))
  const end = next < 0 ? lines.length : next
  const inFirst = first.filter((i) => i < end)
  if (inFirst.length === 0) {
    shapeThrow([file + ": `" + SHAPE_COUNT_MARK + "` 既不在死区、也不在**首节**内 ⇒ 红（定位失败不是跳过）"])
  }
  return { state: "first-section", line: inFirst[0] + 1, text: lines[inFirst[0]] }
}

/**
 * **FR-5 抽取器**（锚 A9 · R-1）：在**定位到的行**上套三条抽取。
 * ★ **锚定行抽取，不是正则首例匹配**——后者正是 `G-常驻3` 的已知雷（批 16 条目里曾埋着第二处推导式）。
 * @post `{ actual, total, baseline, added, line, text }`；**任一抽取不到 ⇒ 红**（fail-closed）
 */
function shapeExtractCountLine(lineText, line, file = "CHANGELOG.md") {
  const bad = []
  const m = /\*\*(\d+)\s*\/\s*(\d+)\*\*/.exec(lineText)
  if (!m) bad.push(file + ":" + line + ": 定位行内抽取不到 `**N/N**` 计数 ⇒ 红（R-1 的三条抽取之一落空）")
  const bm = /基线\s*(\d+)/.exec(lineText)
  const am = /本批\s*(\d+)/.exec(lineText)
  if (!bm) bad.push(file + ":" + line + ": 定位行内抽取不到 `基线 X` ⇒ 红")
  if (!am) bad.push(file + ":" + line + ": 定位行内抽取不到 `本批 Y` ⇒ 红")
  shapeThrow(bad)
  return {
    actual: Number(m[1]), total: Number(m[2]), baseline: Number(bm[1]), added: Number(am[1]),
    line, text: lineText,
  }
}

/**
 * **FR-5 等值锁**（锚 A9 · AC-7）：**当条目位于首节时**（收口后状态），本抽取器的结果
 * 必须 == `parseChangelogCountLine` 的输出——**防两个抽取器漂成两种方言**。
 * @post 首节态 ⇒ 返回比对结果；死区态 ⇒ `{ state: "deadzone", locked: false }`（该锁不适用）
 */
function shapeChangelogLock(text, file = "CHANGELOG.md") {
  const loc = shapeLocateCountLine(text, file)
  if (loc.state !== "first-section") return { state: loc.state, locked: false, line: loc.line }
  const mine = shapeExtractCountLine(loc.text, loc.line, file)
  const ref = parseChangelogCountLine(text) // ← **只读** release-check 的既有导出
  const bad = []
  for (const k of ["actual", "total", "baseline", "added"]) {
    if (mine[k] !== ref[k]) {
      bad.push(file + ": 等值锁破——" + k + "：本抽取器 " + JSON.stringify(mine[k])
        + " vs `parseChangelogCountLine` " + JSON.stringify(ref[k]) + " ⇒ 红（两个抽取器漂成两种方言）")
    }
  }
  shapeThrow(bad)
  return { state: loc.state, locked: true, line: loc.line, mine, ref }
}

// ═══════════ 批 17 · FR-2：事实 id 腿（跨档分组 ＋ 两条不变量） ═══════════

/**
 * **FR-2：跨档分组与两条不变量**（设计档 §5.3 · §6 · 图 2 · 锚 A5/A6/A7 · AC-1…AC-3 · AC-12）。
 * @pre  `hits` = `parseFacts` 的**全域**结果；`requireFacts` = 各**声明档**的注册项并集
 * @post **不变量①（同值）**：组内标量全相等；**≥2 处携带枚举时**其集合也全相等 ⇒ 否则红，
 *         **报全部出现处的 `文件:行:原文`**（R-6 / US-2）
 *       **不变量②（次数）**：**仅注册事实**：**档内标记**的出现次数 == `@N`
 *         （★ **绑定出现不计入 `@N`**——§5.6 · 评审 #8 的裁定）
 *       **防恒真**：全域至少 1 个「**≥2 处档内出现**的组」⇒ 否则红（D16-7 同律）
 * ★ 未注册的**单例 id 不红**（「一次事实只出现一次」是常态——D17-2 的不对称是有意的）。
 * @return `{ groups, multiGroups, occurrences }`
 */
function checkFactGroups(hits, requireFacts = [], opts = {}) {
  const changelogText = opts.changelogText ?? null
  const bad = []
  const byId = new Map()
  for (const h of hits) {
    if (h.id === null) continue
    if (!byId.has(h.id)) byId.set(h.id, [])
    byId.get(h.id).push(h)
  }
  // —— CHANGELOG 是**登记的外部面**（图 4 的闭域 C3）⇒ 定位器**无条件**跑（定位失败 ⇒ 红）——
  let countLine = null
  if (changelogText !== null) {
    const loc = shapeLocateCountLine(changelogText, "CHANGELOG.md")
    countLine = shapeExtractCountLine(loc.text, loc.line, "CHANGELOG.md")
    countLine.state = loc.state
  }
  // —— 绑定出现（§5.6）：每个带 `bind=` 的注册项追加**恰一次**「CHANGELOG 侧出现」——
  for (const rf of requireFacts) {
    if (!rf.bind) continue
    if (countLine === null) {
      bad.push("注册事实 " + JSON.stringify(rf.id) + " 声明了 `bind=`，但本次调用未提供 CHANGELOG 文本 ⇒ 红（fail-closed）")
      continue
    }
    if (!byId.has(rf.id)) byId.set(rf.id, [])
    const field = SHAPE_BIND_FIELD[rf.bind.slot]
    byId.get(rf.id).push({
      file: "CHANGELOG.md", line: countLine.line, id: rf.id, unit: null, items: null, enumerated: false, bound: true,
      raw: SHAPE_COUNT_MARK + " 行的 " + rf.bind.slot + "=" + countLine[field],
      n: countLine[field],
    })
  }
  // —— 注册面的自洽：同一 id 被两条注册成不同次数 ⇒ 红（fail-closed）——
  const regN = new Map()
  for (const rf of requireFacts) {
    if (regN.has(rf.id) && regN.get(rf.id) !== rf.n) {
      bad.push("同一 id " + JSON.stringify(rf.id) + " 被两条 `require-facts` 注册成不同次数（"
        + regN.get(rf.id) + " vs " + rf.n + "）⇒ 红")
    }
    regN.set(rf.id, rf.n)
  }
  // —— 逐组：不变量①（同值；标量恒比、集合「≥2 处携带枚举」才比——R-3/R-4）——
  let multiGroups = 0
  for (const [id, occ] of byId) {
    const docOcc = occ.filter((h) => !h.bound)
    if (docOcc.length >= 2) multiGroups++
    const scalars = [...new Set(occ.map((h) => shapeScalar(h.n)))]
    if (scalars.length > 1) {
      bad.push("事实 id " + JSON.stringify(id) + " 的**不变量①（组内同值）破**——实测 " + scalars.length
        + " 个不同值 " + JSON.stringify(scalars) + "；**全部出现处**：" + shapeOccurrences(occ))
    }
    const enumSites = docOcc.filter((h) => h.items !== null)
    if (enumSites.length >= 2) {
      for (const s of enumSites.slice(1)) {
        if (!shapeSetEqual(enumSites[0].items, s.items)) {
          bad.push("事实 id " + JSON.stringify(id) + " 的**集合不变量破**（R-3：trim 后精确串等值 && 顺序无关）——"
            + shapeOccurrences([enumSites[0], s]) + "；**全部出现处**：" + shapeOccurrences(occ))
        }
      }
    }
  }
  // —— 不变量②（次数：**仅注册事实**）——
  for (const [id, n] of regN) {
    const occ = byId.get(id) ?? []
    const docCount = occ.filter((h) => !h.bound).length
    if (docCount !== n) {
      bad.push("注册事实 " + JSON.stringify(id) + " 的**不变量②（次数）破**——`require-facts` 声明 @" + n
        + "，实测**档内标记出现** " + docCount + " 处（**绑定出现不计入**）；出现处：" + shapeOccurrences(occ))
    }
  }
  // —— 防恒真（A7）：全域至少 1 个「≥2 处**档内**出现」的组（否则该腿在真实域上什么都没比过）——
  if (multiGroups === 0) {
    bad.push("全域**零个**「≥2 处档内出现的事实 id 组」⇒ 红（防恒真：id 全部裂成单例时该腿恒真）")
  }
  shapeThrow(bad)
  let occurrences = 0
  for (const v of byId.values()) occurrences += v.length
  return { groups: byId.size, multiGroups, occurrences }
}

// ═══════════ 批 17 · FR-6 / FR-6b：强制声明 · 面级结构触发 · exempt 四闸（§5.7 / §5.7b） ═══════════

/**
 * `EXEMPT_BUDGET`（§5.7 D17-6）：**全域有效豁免数 > 预算 ⇒ 红**。
 * ★ **初值 2 没有实测出处**——会诊建议 2，父侧照抄并**据实登记为「未实测的初值」**（§5.7b）。
 *   它**只是一个防「静默生长」的可见性旋钮**，其数值本身**不承载判据**（超预算红是「被看见」
 *   而不是「被判定」）；**首次 bump 时必须在该次提交里写明理由**（与 `CUTOFF` 同款）。
 */
const SHAPE_EXEMPT_BUDGET = 2
/** 批次档的**文件名日期前缀**（D17-4 的机械判据：`docs/` 顶层 · 非递归）。 */
const SHAPE_DOC_DATE_RE = /^(\d{4}-\d{2}-\d{2})-/

/**
 * **面级结构检测器**（§5.7b；**FR-6b 与 exempt 闸 4 用的是同一个检测器**）。
 * @post `{ ac: Set<行号>, anchor: Set<行号> }`——两张表的**首行行号**（1-based）
 * ★ 这是**结构检测，不是中文猜测**（N-1 兼容）：判据是**表格首列的机械形态**（剥离 `*`/反引号后前缀匹配）。
 */
function shapeTableShapes(text) {
  const lines = lf(text).split("\n")
  const out = { ac: new Set(), anchor: new Set() }
  let tbl = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) {
      if (tbl < 0) tbl = i
      const first = (lines[i].split("|")[1] ?? "").replace(/[*`\s]/g, "")
      if (/^AC-[0-9]+/.test(first)) out.ac.add(tbl + 1)
      else if (/^A[0-9]+/.test(first)) out.anchor.add(tbl + 1)
    } else tbl = -1
  }
  return out
}

/**
 * **FR-6b 面级结构触发**（§5.7b · 锚 A11b · AC-9b）——**「档内缩作用域」那个口的唯一堵法**。
 * @pre  该档**带声明**（`decl !== null`；**未声明档不跑** ⇒ fail-open）
 * @post 出现**首列匹配 `AC-\d+` 的表** ⇒ `acs` 键必填；出现**首列匹配 `A\d+` 的表** ⇒ `anchors` 键必填
 *       ⇒ 缺键**红**（报「档内有 AC 形表而无 `acs` 键」）；**普通表（首列非两者）⇒ 不红**
 */
function checkStructureDuty(text, decl, file = "(内存档)") {
  const shapes = shapeTableShapes(text)
  const bad = []
  if (shapes.ac.size > 0 && !decl.acs) {
    bad.push(file + ": 档内有 **AC 形表**（首列匹配 `AC-\\d+`，首见第 " + [...shapes.ac][0]
      + " 行）而**无 `acs` 键** ⇒ 红（有表 ⇒ 键必填：否则腿 4 永不跑 ⇒ 档内的 AC 表逃出作用域）")
  }
  if (shapes.anchor.size > 0 && !decl.anchors) {
    bad.push(file + ": 档内有 **锚形表**（首列匹配 `A\\d+`，首见第 " + [...shapes.anchor][0]
      + " 行）而**无 `anchors` 键** ⇒ 红（有表 ⇒ 键必填）")
  }
  shapeThrow(bad)
  return shapes
}

/**
 * **exempt 四道闸**（§5.7 D17-6：独键 · 必带理由 · 只许写在日期前缀档 · **内容证伪**）。
 * @post 任一闸破 ⇒ 红；**内容证伪**用 `shapeTableShapes` **同一个检测器**（两个方向一条判据）
 */
function checkExemptGates(text, decl, rel, file = null) {
  const name = file ?? rel
  const bad = []
  if (decl.mode !== "exempt") return bad
  // —— 闸 1 **独键**：`mode: exempt` 必须是声明的**唯一**键 ——
  const extra = [...decl.keys].filter((k) => k !== "mode")
  if (extra.length > 0) {
    bad.push(name + ": `mode: exempt` 与其它键并存（" + JSON.stringify(extra)
      + "）⇒ 红（**独键**：exempt 与任何配置键并存都自相矛盾）")
  }
  // —— 闸 2 **必带理由**：`mode: exempt` 后必须跟非空理由文本 ——
  if (!decl["exempt-reason"]) {
    bad.push(name + ": `mode: exempt` **缺理由**（`mode: exempt（这里写理由）`）⇒ 红（豁免必须被看见）")
  }
  // —— 闸 3 **只许写在日期前缀档上**（exempt 只为「日期 ≥ CUTOFF 而无契约可声明」的档存在）——
  if (!SHAPE_DOC_DATE_RE.test(name.split("/").pop())) {
    bad.push(name + ": `mode: exempt` 写在**非日期前缀档**上 ⇒ 红（语法误用）")
  }
  // —— 闸 4 **内容证伪**：exempt 档内长出受管面 ⇒ 红（唯一对「时间」免疫的一条）——
  const masked = shapeMaskDoc(text)
  const badId = /（[0-9]+\s*[项处条档值步腿]/
  const markLines = []
  for (let i = 0; i < masked.length; i++) {
    if (badId.test(masked[i]) || masked[i].includes("id=")) markLines.push(i + 1)
  }
  const shapes = shapeTableShapes(text)
  if (markLines.length > 0) {
    bad.push(name + ": exempt 档内出现**受管标记**（`（N 量词` / `id=`，首见第 " + markLines[0]
      + " 行）⇒ 红（「声称无可数事实」的档长出了可数事实）")
  }
  if (shapes.ac.size > 0 || shapes.anchor.size > 0) {
    bad.push(name + ": exempt 档内出现**AC 形表或锚形表**（首见第 " + ([...shapes.ac, ...shapes.anchor][0])
      + " 行）⇒ 红（`有表 ⇒ 键必填` 与 `有表 ⇒ exempt 作废` 是同一判据的两个方向）")
  }
  return bad
}

/**
 * **FR-6 强制声明**（§5.7 D17-4 · 锚 A10 · AC-8）＋ exempt 四闸与预算。
 * @pre  `files` = `docs/` **顶层**档（非递归）的仓库相对路径；`loader` 注入以便夹具自证
 * @post 文件名匹配 `^(\d{4}-\d{2}-\d{2})-` 且 **日期 ≥ `cutoff`** 且**无声明** ⇒ 红；
 *       **CUTOFF 前无声明 ⇒ 绿**（阴性对照）；非日期前缀 ⇒ 天然域外、零清单维护；
 *       全域有效豁免数 > `budget` ⇒ 红
 * ★ **没有档能静默从闭域滑进开域**（图 4）：CUTOFF 后无声明 = **红**（不是跳过）。
 */
function checkDeclarationDuty(files, cutoff = SHAPE_CUTOFF, budget = SHAPE_EXEMPT_BUDGET, opts = {}) {
  const loader = opts.loader ?? read
  const bad = []
  const exempts = []
  for (const rel of files) {
    const text = lf(loader(rel))
    const decl = parseDocShape(text) // 畸形 ⇒ 抛（批 16 既有：绝不静默返空声明）
    const m = SHAPE_DOC_DATE_RE.exec(rel.split("/").pop())
    const date = m ? m[1] : null
    if (date !== null && date >= cutoff && decl === null) {
      bad.push(rel + ": 文件名日期 " + date + " ≥ CUTOFF " + cutoff + " 而**无 `doc-shape` 声明** ⇒ 红"
        + "（D17-4：义务本身是一个常数 ⇒ 存量档零触动，而「没声明就红」只作用于义务存在之处）")
      continue
    }
    if (decl === null) continue // CUTOFF 前 / 非日期前缀 ⇒ **开域 fail-open**（永久）
    bad.push(...checkExemptGates(text, decl, rel))
    if (decl.mode === "exempt") exempts.push({ file: rel, reason: decl["exempt-reason"] ?? "" })
  }
  if (exempts.length > budget) {
    bad.push("全域**有效豁免数 " + exempts.length + " > `EXEMPT_BUDGET` " + budget + "** ⇒ 红"
      + "（「白名单长一行」变成「改一个带注释的常量」；首次 bump 必须写明理由）："
      + exempts.map((e) => e.file).join(" · "))
  }
  shapeThrow(bad)
  return { scanned: files.length, exempts }
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

/**
 * 表行判定（**容前导空格**——缩进的表行与顶格的表行**同样算表行**）。
 * ★ 为什么必须容空格：形状声明是**格式契约**，1 个空格的缩进**不改变**该行的表行语义；
 *   而「以其后是否还有表行」为判据时，**过于严格的表行判定会把真违规当成自然结束**（漏检）。
 *   代价（**可证伪的边界**）：本文档风格**不用**缩进代码块存表行 ⇒ 假阳性面实测为零
 *   （本次修复轮对 `docs/**` 与**本批两档**逐节实跑腿 4：闸 0 **零命中** ⇒ 存量与自产档均不误伤）。
 */
const SHAPE_TABLE_ROW_RE = /^\s*\|/

/**
 * 本节内**首段连续表格**的解析（表头 + 表体；引用块里的 `> |` 自然不在其列）。
 *
 * @pre  `sec.body` = 该节正文（不含标题行）
 * @post 返回 `{ header, rows, swallowed }`——`swallowed` = **被非表行截断后仍然出现**的表行
 *       （行号 + 原文）。**截断**（其后仍有表行）与**自然结束**（其后不再有表行）**必须区分**：
 *       前者红、后者不红。
 * ★ 分歧审计 **F9（恒真入口 2.0）**：现实现遇到第一个非表行就 `break` ⇒ 被吞的表行
 *   **既不入表、也不算红**。实测：3 行 AC 表里插一行非表行 ⇒ 谓词判 `PASS {"acs":2}`，
 *   而**第三条 AC 完全没被看见**。同族第二面：**同一节关键字下若有第二张表**，也只取第一段
 *   ⇒ 第二张表的 AC 永不校验。
 * ★ 判据是「**其后是否仍有表行**」而**不是**「出现非表行就红」——后者会误伤正常排版
 *   （**本仓设计档 §10.3 的 AC 表后面就跟着散文**）。
 */
function shapeTable(sec, what, file) {
  const lines = lf(sec.body).split("\n")
  const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim())
  const isRow = (l) => SHAPE_TABLE_ROW_RE.test(l)
  const raw = []
  const swallowed = []
  let broke = false // 表体是否已被**非表行**截断
  for (let i = 0; i < lines.length; i++) {
    if (isRow(lines[i])) {
      if (broke) swallowed.push({ line: sec.line + 1 + i, raw: lines[i] })
      else raw.push(lines[i])
      continue
    }
    // 非表行：**表体一旦已经开始** ⇒ 只记「截断于此」，**继续扫完整节**
    //（不再 `break`——被吞的行由此可被看见；尚未开始则视为表前导语，跳过）
    if (raw.length > 0) broke = true
  }
  if (raw.length < 2) {
    shapeThrow([file + ": " + what + " 的表格**定位不到**（本节内没有以 `|` 起头的表头/分隔线）⇒ 红（§9）"])
  }
  return { header: cells(raw[0]), rows: raw.slice(2).map((l) => ({ raw: l, cells: cells(l) })), swallowed }
}

/** 闸：**表体被吞**（§9 空集类的第三个入口「行被吞」）。截断后仍有表行 ⇒ 红；自然结束 ⇒ 不红。 */
function shapeSwallowedTableRows(tab, what, file) {
  shapeThrow(tab.swallowed.map((s) =>
    file + ":" + s.line + ": " + what + " 的表体被非表行**截断**，其后仍有表行 ⇒ **这些行被吞了**"
    + "（既不进表、也不校验）：" + s.raw.trim().slice(0, 80)))
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
  const maskedLines = shapeMaskDoc(text) // ← 围栏（整行）+ 行内 span 双重掩码（FR-0b/FR-0c）
  // ★ FR-0c 的配套收紧：掩码体由空白改为**非空白占位符** ⇒ 受检目标字符类必须**显式排除占位符**
  //   （改前它天然被 `\s` 排除；不排除则掩码体可被 `[^)\s]+` 吃进链接目标 ⇒ 假红）。
  const linkRe = /\]\(([^)\s\u0000]+)\)/g
  // ★ 代码评审第 2 轮 #3 订正：主干初为 `[\w-]+`（不含 `.`）⇒ **多点文件名**
  // （如 `test/doc-hygiene.test.mjs:14`、`anything.v2.md:30`）的裸引用**不进受检面**
  // （`lib/eng.mjs:747` 能匹配而 `doc-hygiene.test.mjs:14` 不能 —— 静默收窄）。
  // 今放宽为 `[\w.-]+`，与设计档 §5.4「实体受检面」的诚实声明对齐。
  const pathRe = /(?:^|[^\w`./-])((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|js|cjs|md|json|txt|ya?ml)):([0-9]+)/g
  for (let i = 0; i < maskedLines.length; i++) {
    const masked = maskedLines[i] // ← 已掩码行（围栏内整行被掩 ⇒ 其内引用一律不受检）
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

// ═══════════ 批 17 · 腿 4 的两处**id 抽取口径放宽**（必要性由设计档自己的命名逼出） ═══════════
//
// ★ 批 16 的锚/AC id 抽取是 `\bA[0-9]+\b` 与 `AC-[0-9]+`——**它们只认纯数字后缀**。
//   而**本批设计档自己**命名了 **A1b / A9b / A11b**（评审 #1/#2/#3 补入的三条锚）与
//   **AC-4b / AC-6b / AC-9b**（三条补充验收标准）⇒ 照旧口径，这些 id **根本无法被腿 4 表达**：
//   · `\bA[0-9]+\b` 在 `**A1b**` 上**匹配不到**（`1` 与 `b` 之间没有词边界）⇒ 「锚 id 解析不到」；
//   · `AC-[0-9]+` 在 `**AC-4b**` 上匹配到 **`AC-4`** ⇒ 与真 `AC-4` 撞成「**AC 号重复**」（**假红**）。
// ⇒ 两处口径放宽为「**可选一个小写后缀**」。**对无后缀的 id 行为逐字不变**（A1…A13 / AC-1…AC-12
//   的判定与批 16 完全同值——批 16 的八条负控腿是零回归的实证）。
const SHAPE_ANCHOR_ID_RE = /\bA[0-9]+[a-z]?\b/
/** 同上，**全局**形态（`referenced` 的收集用；`g` 标志必须每次新建，故此处只存源串）。 */
const SHAPE_ANCHOR_ID_RE_G = new RegExp(SHAPE_ANCHOR_ID_RE.source, "g")
const SHAPE_AC_ID_RE = /AC-[0-9]+[a-z]?/

/**
 * 腿 4：AC ↔ 锚互引（§5.4 · **两道闸 + 反向腿** · AC-6 / AC-7 / AC-8 · US-4）。
 * @pre  声明含 `anchors` 与 `acs`，且**两个节都能定位**（定位不到 ⇒ **红**，不是跳过）
 * @post ⓪ **闸 0**：表体被非表行**截断**且其后仍有表行 ⇒ 红（**行被吞**——审计 F9 补入；
 *          判据是「其后仍有表行」，**不是**「出现非表行就红」⇒ §10.3 的表后散文不误伤）
 *       ⓪-b **零数据行闸**（**代码评审 #6 补入**）：锚表 / AC 表**任一张只有表头 + 分隔线、
 *          一行数据行都没有** ⇒ 红（§9 空集类②「零行」），**两张表各报各的**。
 *          ★ 实测口径：`shapeTable` 的 `raw` 收**含表头 + 分隔线**的全部表行 ⇒ 双侧同空时
 *          `raw.length === 2`，旧判据 `raw.length < 2` **放行**，而三者全空 ⇒ 整体判绿。
 *          ⇒ 判据 = 「**零数据行**」——**不充分的是 `raw.length < 2` 这个旧措辞**，
 *          而 §9 的意图（**空集 ⇒ 红**）不变；与腿 2 的「某侧零条目 ⇒ 红」同律。
 *       ① **闸 A**：每行 cell 数 == 表头列数（防 `|` 缺失导致串列）
 *       ② **闸 B**：锚列非空——免锚的合法写法只有两种：显式 `—` 与层标**连 T3 都不是**（其余空值一律红）
 *       ③ 所引锚 id 必须在锚表中有定义
 *       ④ **T1/T2 的 AC 必须有锚**；**T3 与「连 T3 都不是」免锚**（D16-4——批 14 把这条写成「满射」⇒ 当场为假）
 *       ⑤ **AC 号不重复**
 *       ⑥ **反向腿**：锚表里每个锚至少被一条 AC 引用；**未被引用的锚必须自带显式豁免标记**
 *       ★ **残缺行（cell 数不符）仍参与 AC 号提取**（分歧审计 **F10**）：否则一个真实存在的 AC
 *         会触发反向腿的**二次误报**（该行的 AC 号不进 `seen`、其锚不进 `referenced`）。
 *         「跳过」只跳**锚列判定**（层标分层不变量），**不跳 id 记录与引用记录**。
 */
function checkAnchorsAndACs(text, decl, file = "(内存档)") {
  const bad = []
  const aTab = shapeTable(shapeSection(text, decl.anchors, "锚表（anchors）", file), "锚表（anchors）", file)
  const cTab = shapeTable(shapeSection(text, decl.acs, "AC 表（acs）", file), "AC 表（acs）", file)
  // —— 闸 0（**分歧审计 F9 补入**）：表体被非表行**截断**且其后仍有表行 ⇒ 红 ——
  //    **必须在闸 A 之前报**：表被截断时，闸 A 只看得到存活的那几行 ⇒ 被吞的行**永远不会**被闸 A 看见
  //    （这就是「零档 / 零行 / **行被吞**」三个恒真入口里的第三个）。
  shapeSwallowedTableRows(aTab, "锚表（anchors）", file)
  shapeSwallowedTableRows(cTab, "AC 表（acs）", file)

  // —— ★ **零数据行闸**（**代码评审 #6 补入** · §9 空集类②「零行」） ——
  //    实测的 fail-open 缝：`shapeTable` 的 `raw` 收**全部表行（含表头 + 分隔线）** ⇒
  //    锚表与 AC 表**双侧都只剩「表头 + 分隔线、零数据行」**时 `raw.length === 2` ⇒ 旧判据
  //    `raw.length < 2` **放行**；而 `anchors` / `seen` / `referenced` **三者全空** ⇒ 整体判绿。
  //    （单侧空表会被「引用了不存在的锚」或反向腿兜住，**双侧同空则全绿**——所以它不是误报面，是漏报面。）
  //    ⇒ 判据改口径为「**零数据行 ⇒ 红**」，与腿 2 的「某侧零条目 ⇒ 红」同律（§9 失败方向①：
  //    **谓词面全 fail-closed**）；**两张表各报各的**——报错文本必须点名**是哪张表空**。
  for (const [what, tab] of [["锚表（anchors）", aTab], ["AC 表（acs）", cTab]]) {
    if (tab.rows.length === 0) {
      bad.push(file + ": " + what + " **零数据行**（只有表头 + 分隔线，一行数据都没有）⇒ 红"
        + "（§9 空集类②：表定位到了却读不出任何一行——空集不得当作「无从判定」通过；实测表头 "
        + JSON.stringify(tab.header) + "）")
    }
  }

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
    const m = (r.cells[0] ?? "").match(SHAPE_ANCHOR_ID_RE)
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
    // ★ **残缺行（cell 数不符）仍参与 AC 号提取**（分歧审计 **F10**）：闸 A 报红后若在此
    //   `continue`，该行被**整行丢弃** ⇒ **AC 号不进 `seen`**、**其锚引用不进 `referenced`**。
    //   审计所称的两条下游症状（孤儿锚 / AC 号重复）**在可构造的形态下均不可观察**（见下）：
    //   ① 残缺行若**丢掉锚列**，谓词**本来就看不见那个引用**（结构性，不因本次修复而变）；
    //   ② 残缺行若**首列即 AC 号**，后续行的 AC 号取自**本行首列** ⇒ 不可能被误判为重复。
    //   ⇒ 本条修复的本体是「**残缺失效行的任何东西都不得丢**」；负控腿 7 据实钉这一性质。
    const acId = (r.cells[0] ?? "").match(SHAPE_AC_ID_RE)
    const complete = r.cells.length === cTab.header.length
    if (acId) {
      if (seen.has(acId[0])) bad.push(file + ": AC 号重复：" + acId[0])
      seen.add(acId[0])
    } else if (complete) {
      bad.push(file + ": AC 表首列解析不到 AC 号：" + r.raw.trim().slice(0, 80))
      continue
    }
    // 锚列的**取值**按列语义取（残缺失列 ⇒ 空串，fail-closed）；**受检 refs** 另从已有 cell 里抽。
    const cell = (r.cells[iAnchor] ?? "").replace(/[*`]/g, "").trim()
    const refs = [...new Set((complete ? cell : r.cells.join(" ")).match(SHAPE_ANCHOR_ID_RE_G) ?? [])]
    for (const a of refs) referenced.add(a) // ← 残缺行**照样**计入「被引用」（F10：引用记录零丢失）
    if (!complete) continue // 闸 A 已报；该行的**锚列判定**（层标分层不变量）跳过——**只跳锚列判定**
    if (!acId) continue
    const layer = (r.cells[iLayer] ?? "").replace(/[*`\s]/g, "")
    if (SHAPE_MUST_ANCHOR.has(layer)) {
      if (SHAPE_NO_ANCHOR.has(cell)) {
        bad.push(file + ": " + acId[0] + " 层标 " + layer + " ⇒ **必须有锚**（T1/T2 必填）；免锚的合法写法"
          + "只有两种：显式 `—` 与层标**连 T3 都不是**；实测锚列 " + JSON.stringify(cell))
      }
    } else if (refs.length === 0 && !SHAPE_NO_ANCHOR.has(cell)) {
      bad.push(file + ": " + acId[0] + " 锚列非空但解析不到锚 id：" + JSON.stringify(cell))
    }
    for (const a of refs) {
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
 * ★ 批 17：**严格腿（腿 2 / 腿 4 / `require-facts`）的域就是这个 `scanned` 集**；
 *   **腿 1 的域是 `shapeDomainFiles()` 全域**（宽松档位由 `shapeReadDomain` 承担）。
 * @throws 声明畸形（缺冒号 / 未知键 / 空值）⇒ 抛（fail-closed，绝不静默返空声明）
 */
function shapeScan(files = shapeDomainFiles(), loader = read) {
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
  const files = shapeDomainFiles() // ★ 批 17 的域：docs/** 递归 − 纪要子目录 ＋ CHANGELOG.md
  assert.ok(files.length >= 40, "扫描域自证：docs/ 递归（− 纪要）＋ CHANGELOG.md 实测 " + files.length + " 档")
  assert.ok(!files.some((f) => f.startsWith("docs/consult-minutes/")),
    "域口径：`docs/consult-minutes/**` 必须在域外（机器产物无作者契约——§4 D17-10）")
  assert.ok(files.includes("CHANGELOG.md"), "域口径：`CHANGELOG.md` 必须在域内（它就是 P-4 的落点）")
  const scanned = shapeScan(files).length
  assert.ok(scanned >= 1, "A2：**进作用域的档**数（scanned）必须 >= 1，实测 " + scanned
    + "——零扫描 ⇒ 谓词恒真（D16-7），fail-closed 红")
  assert.ok(scanned < files.length, "自证：存量档确实被跳过（扫描域 " + files.length + " 档 → 作用域 " + scanned + " 档）")

  // —— 四条腿对**真实档**实跑 ——
  //    ★ 腿 1（**宽松腿**）跑**全域**：声明档走严格档位、未声明档走宽松档位（FR-3 双模式真值表）；
  //    ★ 腿 2 / 腿 3 / 腿 4 仍只在**声明档**上跑（严格腿，N-2 的第一次订正口径）。
  const domain = shapeReadDomain(files)
  const scope = domain.filter((s) => s.decl !== null)
  let leg1Hits = 0
  let leg1Loose = 0
  let leg2Runs = 0
  let leg3Checked = 0
  let leg4Runs = 0
  const leg4Stats = []
  for (const s of domain) {
    const declared = s.decl !== null
    let l1 = 0
    assertShapeClean(s.file + " 腿 1（计数 ↔ 列表 · " + (declared ? "严格档" : "宽松档") + "）", () => {
      l1 = checkCountMarks(s.text, declared ? s.decl["count-marks"] : SHAPE_DEFAULT_MARKS, s.file, { declared })
    })
    leg1Hits += l1
    if (!declared) leg1Loose++
  }
  for (const s of scope) {
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

  // —— 批 17 新腿：**事实 id 腿 + CHANGELOG 两态定位器**（前置「无」：未声明档也跑，只要标记带 id）——
  const facts = domain.flatMap((s) => parseFacts(s.text, s.file, s.decl ? s.decl["count-marks"] : SHAPE_DEFAULT_MARKS))
  const regs = []
  for (const s of scope) for (const rf of s.decl["require-facts"]) regs.push({ ...rf, declFile: s.file })
  const cl = domain.find((d) => d.file === "CHANGELOG.md")
  assert.ok(cl, "域口径：CHANGELOG.md 必须在域内（FR-5 的登记外部面）")
  const factStats = checkFactGroups(facts, regs, { changelogText: cl.text })
  // ★ **A12 的机械面（防「防恒真闸被语法示例满足」）**：注册事实里必须 ≥1 个**真的**在两处以上出现。
  //   ★ 实施期实测：本档 §2 的语法示例 `（8 条 id=X）` **未包进代码 span**（两处同串）⇒ 它自己就
  //     凑成了一个「≥2 出现处的组」，把 A7 的防恒真闸**从名义上**满足了——**这正是本批要抓的物种**
  //     （批 16 评审 #18 的「自应用陷阱」）。⇒ 本断言把闸口收到**注册事实**上。
  const docCounts = new Map()
  for (const h of facts) if (h.id !== null) docCounts.set(h.id, (docCounts.get(h.id) ?? 0) + 1)
  const regMulti = [...new Set(regs.map((r) => r.id))].filter((id) => (docCounts.get(id) ?? 0) >= 2)
  assert.ok(regMulti.length >= 1,
    "A12：**注册事实**里必须 ≥1 个真的在两处以上出现（实测 " + JSON.stringify(regMulti)
    + "）——否则 A7 的防恒真闸只会被语法示例满足（本批实施期实测到的一次）")
  // FR-5 等值锁：**两态各自成立**——首节态必须与既有解析器同值；死区态该锁不适用（定位器不适用）
  const lock = shapeChangelogLock(cl.text)
  assert.ok(lock.state === "deadzone" || lock.locked,
    "FR-5：CHANGELOG 必须处于**两态之一**且定位成功（实测 state=" + lock.state + " · line=" + lock.line + "）")
  // —— 批 17 新腿：**FR-6 强制声明**（`docs/` 顶层批次档义务 ＋ exempt 四闸 ＋ 预算）——
  const duty = checkDeclarationDuty(docsTopLevel().map((n) => "docs/" + n))
  // —— 批 17 新腿：**FR-6b 面级结构触发**（**只在已声明档**上跑——未声明档 fail-open）——
  for (const s of scope) {
    assertShapeClean(s.file + " FR-6b 面级结构触发", () => checkStructureDuty(s.text, s.decl, s.file))
  }
  return {
    files: files.length, scanned, leg1Hits, leg1Loose, leg2Runs, leg3Checked, leg4Runs, leg4Stats,
    factStats, lock, regMulti, duty,
  }
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
    // ★ 批 17 FR-3：本夹具**带 doc-shape 声明** ⇒ 按真值表走**严格档位**（批 16 语义原样）
    //   ——`{ declared: true }` 把「该档有声明」这件事显式告知谓词（批 16 时它认档不认参数）。
    const OPTS = { declared: true }

    // 阳性对照（防「谓词恒红」的假绿）：声明值与实际一致 ⇒ 零违规
    assert.equal(checkCountMarks(okDoc, marks, "ok.md", OPTS), 1, "阳性对照：2 项 == 2 项 ⇒ 绿")
    // 负控：声明 3 而实际 2 ⇒ 必红，且必须是**谓词/断言级红**（`ShapeViolation`），不是整档崩溃
    // ★ 谓词按「档:行」报错，但**本断言不锚行号**（行号只作 as-of；锚形状不锚位置）
    assert.throws(() => checkCountMarks(badText, marks, "minimal.md", OPTS),
      (e) => e instanceof ShapeViolation && /minimal\.md:[0-9]+: 声明 3 项 · 实际 2 项/.test(e.message),
      "负控腿 1：裸写的「（3 项：a · b）」必须被抓（真红 = ShapeViolation，带 档:行 + 声明值 + 实际值）")
    // AC-2：报错文本三要素逐条在位（档:行 / 声明值 / 实际值）
    try {
      checkCountMarks(badText, marks, "minimal.md", OPTS)
      assert.fail("应当抛")
    } catch (e) {
      assert.ok(/minimal\.md:\d+/.test(e.message), "AC-2①：报错含 文件:行")
      assert.ok(e.message.includes("声明 3"), "AC-2②：报错含声明值")
      assert.ok(e.message.includes("实际 2"), "AC-2③：报错含实际值")
    }

    // —— 三条边界逐条自证（缺一即错，§5.2） ——
    // ① 行内代码 span 一律豁免：同一条违规标记，包进反引号后**不得**再被抓
    assert.equal(checkCountMarks(SHAPE_HEAD + "示例：`（3 项：a · b）`\n", marks, "span.md", OPTS), 0,
      "边界①：代码 span 之内的计数标记一律豁免（谓词不得对自家示例报红）")
    // ② `N` 只认阿拉伯数字：字面 `N` 不匹配
    assert.equal(checkCountMarks(SHAPE_HEAD + "形态：（N 项：a · b）\n", marks, "literal.md", OPTS), 0,
      "边界②：字面 `N` 不是阿拉伯数字 ⇒ 不匹配（否则规范文本本身会触发）")
    // ③ 只数同一行内的 `·` 项：第 2 项在下一行 ⇒ 本行只数到 1 项 ⇒ 与声明 2 不等 ⇒ 红（不静默放过）
    assert.throws(() => checkCountMarks(SHAPE_HEAD + "本档（2 项：a ·\nb）\n", marks, "wrap.md", OPTS),
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

// ——— ⑤-f：负控腿 6（**批 16 修复轮 · 分歧审计 F9**：闸 0「行被吞」） ———
// ★ 现实现的入口：`shapeTable` 取「第一段连续 `|` 行」，**遇到第一个非表行就 `break`** ⇒
//   被吞的表行**既不入表、也不算红**（实测：3 行 AC 表插一行非表行 ⇒ `PASS {"acs":2}`，
//   **第三条 AC 完全没被看见**）。同族第二面：**同一节关键字下的第二张表**也只因 `break` 而整段消失。
// ★ 判据必须是「**截断之后（同一节内）是否仍有表行**」——**不是**「出现非表行就红」
//   （后者会误伤正常排版：**本仓设计档 §10.3 的 AC 表后面就跟着散文**）。故本块**必然**包含
//   两条**阴性对照**（表自然结束 / `|` 裸写在散文里）来证明它不是恒红、也不误伤。

/** F9 负控的极简夹具（**纯内存**：不落盘、零临时档 ⇒ 无 EOL 陷阱、无仓内残留）。 */
const SHAPE_SWALLOW_FIXTURE = (acsBody) =>
  "<!-- doc-shape\nanchors: 机验锚\nacs: 验收标准\n-->\n\n"
  + "### §8.2 机验锚\n\n| 锚 | 检索目标 | 谓词 | 期望 |\n|---|---|---|---|\n"
  + "| **A1** | 甲 | 乙 | 丙 |\n\n"
  + "### §10.3 验收标准\n\n| # | 验收标准 | 层 | 锚 |\n|---|---|---|---|\n" + acsBody

test("DOC-HYGIENE 批 16 负控腿 6（审计 F9 / 闸 0）: AC 表中间插一行非表行 ⇒ 其后表行被吞必须红（真红）；表自然结束与散文里的裸 `|` 不得误报", () => {
  const decl = parseDocShape(SHAPE_SWALLOW_FIXTURE(""))
  assert.equal(decl.acs, "验收标准", "夹具声明必须可解析（否则负控跑不起来）")
  const HEAD = "| # | 验收标准 | 层 | 锚 |\n|---|---|---|---|\n"
  const AC1 = "| **AC-1** | 甲 | T2 | A1 |\n"
  const AC2 = "| **AC-2** | 甲 | T2 | A1 |\n"
  const AC3 = "| **AC-3** | 甲 | T2 | A1 |\n"

  // —— 阴性对照①（**防「恒红」的假绿**）：表**自然结束**（其后不再有表行）⇒ 链上的一切都不得报 ——
  //    ★ 变体 a：表末行之后直接接标题（旧实现与此同判；新实现必须**同判**）
  const naturalA = SHAPE_SWALLOW_FIXTURE(AC1 + AC2 + "\n### §10.4 另一节\n\n散文。\n")
  assert.deepEqual(checkAnchorsAndACs(naturalA, decl, "natural-a.md"), { anchors: 1, acs: 2, referenced: 1 },
    "阴性对照①a：表体后不再有表行（自然结束）⇒ 不报——闸 0 不是「出现非表行就红」")
  //    ★ 变体 b：表末行之后接**散文**且**再无表行** ⇒ 同样不报（本仓 §10.3 的真实排版）
  const naturalB = SHAPE_SWALLOW_FIXTURE(AC1 + AC2 + "\n**读图要点**：表后的散文段落。\n")
  assert.deepEqual(checkAnchorsAndACs(naturalB, decl, "natural-b.md"), { anchors: 1, acs: 2, referenced: 1 },
    "阴性对照①b：表后的散文（其后不再有表行）⇒ 不报（设计档 §10.3 的表后散文就是这个形态）")
  //    ★ 变体 c：**裸写的 `|` 行**放在**表之前**（尚未开始 ⇒ 只算前导语）⇒ 不得被当成「被吞的行」
  const preamble = SHAPE_SWALLOW_FIXTURE(AC1 + AC2).replace(
    "### §10.3 验收标准\n\n", "### §10.3 验收标准\n\n散文里的一个裸 `|` 竖线。\n\n")
  assert.deepEqual(checkAnchorsAndACs(preamble, decl, "preamble.md"),
    { anchors: 1, acs: 2, referenced: 1 },
    "阴性对照①c：表**之前**的裸 `|` 只算前导语（表尚未开始）⇒ 不报")

  // —— 审计的原始构型（逐字复现）：3 行 AC 表，**第 2 行之后插一行非表行续行** ——
  //    旧实现：`break` ⇒ 只见 AC-1/AC-2 ⇒ **`PASS {"acs":2}` 而 AC-3 完全没被看见**（漏检，非误报）
  const swallowMid = SHAPE_SWALLOW_FIXTURE(AC1 + AC2 + " 这一行不是表行（表体在此被截断）。\n" + AC3)
  assert.throws(() => checkAnchorsAndACs(swallowMid, decl, "swallow-mid.md"),
    (e) => e instanceof ShapeViolation && e.message.includes("**这些行被吞了**")
      && e.message.includes("swallow-mid.md:") && e.message.includes("AC-3"),
    "负控腿 6（闸 0 · 审计原始构型）：截断后仍有表行 ⇒ **必红**，且报出**被丢的行**"
    + "（真红 = ShapeViolation，带 `文件:行` + 被吞行原文；不是整仓崩溃）")
  // 打红消息逐字自证：三要素（档:行 / 「行被吞」 / 被丢行原文）逐条在位
  try {
    checkAnchorsAndACs(swallowMid, decl, "swallow-mid.md")
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(/swallow-mid\.md:\d+/.test(e.message), "闸 0①：报错含 文件:行（被吞行的行号）")
    assert.ok(e.message.includes("表体被非表行**截断**"), "闸 0②：报错明说「截断」（与「自然结束」相对）")
    assert.ok(e.message.includes("**这些行被吞了**"), "闸 0③：报错含「行被吞」字样")
    assert.ok(e.message.includes("**AC-3**"), "闸 0④：报错点名**被丢的那一行**（否则人不知道丢了什么）")
    assert.ok(e.message.includes("AC 表（acs）"), "闸 0⑤：报错点名**是哪张表**（锚表 / AC 表）")
  }

  // —— 同族**第二面**（审计点名的另一面）：同一节关键字下**第二张表** ⇒ 旧实现整段消失、永不校验 ——
  const secondTable = SHAPE_SWALLOW_FIXTURE(AC1 + AC2 + "\n**中间散文**（表与表之间）。\n\n" + AC3)
  assert.throws(() => checkAnchorsAndACs(secondTable, decl, "second-table.md"),
    (e) => e instanceof ShapeViolation && e.message.includes("**这些行被吞了**") && e.message.includes("**AC-3**"),
    "负控腿 6（闸 0 · 同族第二面）：同节内的第二张表 ⇒ 其行同样**不得静默消失**（必红）")

  // —— 锚表侧同样受管（闸 0 是**两张表都校**，不是只校 AC 表） ——
  const anchorSwallow =
    "<!-- doc-shape\nanchors: 机验锚\nacs: 验收标准\n-->\n\n"
    + "### §8.2 机验锚\n\n| 锚 | 检索目标 | 谓词 | 期望 |\n|---|---|---|---|\n"
    + "| **A1** | 甲 | 乙 | 丙 |\n（插入语）\n| **A2** | 甲 | 乙 | 丙 |\n\n"
    + "### §10.3 验收标准\n\n| # | 验收标准 | 层 | 锚 |\n|---|---|---|---|\n| **AC-1** | 甲 | T2 | A1 |\n"
  assert.throws(() => checkAnchorsAndACs(anchorSwallow, decl, "anchor-swallow.md"),
    (e) => e instanceof ShapeViolation && e.message.includes("锚表（anchors）")
      && e.message.includes("**这些行被吞了**"),
    "负控腿 6（闸 0 · 锚表侧）：锚表被截断同样必红（闸 0 两张表都校）")

  // —— 阴性对照②（**审计构造的对照**）：「两行表自然结束」⇒ 不报（与上面变体 a/b 同律，此处独立成条） ——
  const twoRowEnd = SHAPE_SWALLOW_FIXTURE(AC1 + AC2 + "\n本节到此结束。\n")
  assert.deepEqual(checkAnchorsAndACs(twoRowEnd, decl, "two-row.md"), { anchors: 1, acs: 2, referenced: 1 },
    "阴性对照②：两行表自然结束 ⇒ 不报（闸 0 既非恒真、也不误伤正常排版）")
})

// ——— ⑤-g：负控腿 7（**批 16 修复轮 · 分歧审计 F10**：闸 A 报红后反向腿的**二次误报**） ———
// ★ 现实现的入口：闸 A（cell 数不符）报红后该行被 `continue` ⇒ 其 **AC 号不进 `seen`、
//   其锚不进 `referenced`** ⇒ 一个**真实存在**的 AC 会触发 **反向腿的二次误报**
//   （「锚 A1 未被任何 AC 引用」——而该锚明明被这一行引用着）。
// ★ 负控形态 = **二次误报的阴性对照**：构造「某 AC 行的 cell 数不符 · 且其锚未被**其他** AC 引用」
//   ⇒ **应只报闸 A 一条**，不得再报反向腿。判据用**违规条数**（`e.violations.length === 1`），
//   不是「消息里没有反向腿字样」——后者对整档崩溃同样成立（假绿）。

test("DOC-HYGIENE 批 16 负控腿 7（审计 F10 / 闸 A↔反向腿）: 残缺行仍参与 AC 号提取 ⇒ 闸 A 只报一条、反向腿不得二次误报", () => {
  // 夹具（**本腿自带两张表**：锚 A1/A2 各被**唯一一条** AC 引用 ⇒ 任一 AC 行残缺失效即会把它变成「孤儿锚」）
  //   ★ `SHAPE_SWALLOW_FIXTURE` **已含 AC 表的表头与分隔线** ⇒ 这里只传**表体行**，不再另加表头
  const fit = (acsBody, anchorRows = "| **A1** | 甲 | 乙 | 丙 |\n| **A2** | 甲 | 乙 | 丙（豁免：本腿夹具，不挂单项 AC） |\n") =>
    SHAPE_SWALLOW_FIXTURE("").replace(
      "### §8.2 机验锚\n\n| 锚 | 检索目标 | 谓词 | 期望 |\n|---|---|---|---|\n| **A1** | 甲 | 乙 | 丙 |\n",
      "### §8.2 机验锚\n\n| 锚 | 检索目标 | 谓词 | 期望 |\n|---|---|---|---|\n" + anchorRows) + acsBody
  const decl = parseDocShape(fit(""))
  assert.equal(decl.acs, "验收标准", "夹具声明必须可解析（否则负控跑不起来）")
  // 阳性对照（防「谓词恒红」的假绿）：两行都完整、两锚都被引用 ⇒ 绿
  assert.deepEqual(checkAnchorsAndACs(fit("| **AC-1** | 甲 | T2 | A1 |\n| **AC-2** | 甲 | T2 | A2 |\n"),
    decl, "ok.md"), { anchors: 2, acs: 2, referenced: 2 },
    "阳性对照：两行完整且两锚各被引用 ⇒ 绿")
  // ★ 负控（F10 的**可复现构型**）：AC-1 行**删掉末列**（cell 数 4 → 3 ⇒ 锚列整个不见了）；
  //   **A1 由另一条完整行（AC-2）引用** ⇒ **两锚都不是孤儿锚**（A2 带显式豁免标记）——
  //   故本构型下**只有闸 A 该红**，任何别的红都是二次误报。
  const shortOne = fit("| **AC-1** | 甲 | T2 |\n| **AC-2** | 甲 | T2 | A1 |\n")
  let caught = null
  try {
    checkAnchorsAndACs(shortOne, decl, "short-one.md")
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation, "必须是**谓词级红**（真红 = ShapeViolation），不是整档崩溃")
    caught = e
  }
  assert.deepEqual(caught.violations,
    ["short-one.md: AC 表 cell 数 3 != 表头列数 4 ⇒ 红（串列 / 漏 `|`）：| **AC-1** | 甲 | T2 |"],
    "负控腿 7（F10）：残缺行**仍参与 AC 号提取** ⇒ 只报**闸 A 一条**（实测 " + caught.violations.length + " 条：\n"
    + caught.message + "）")
  // —— 阴性对照①（**F10 的可观察面**）：把残缺行换成「**首个 cell 就是 AC 号、整行只有 2 个 cell**」——
  //    ★ 实测（本腿自己的两条断言）：该行的 **AC 号照旧进 `seen`** ⇒ 随后那条完整行**既不被误报
  //      「AC 号重复」，也**不触发任何引用类误报**（`referenced` 的成员全在锚表里）。
  //      旧实现在此处 `continue` ⇒ 该行的 AC 号与引用记录**整批丢失**（本腿注释与实测输出为证）。
  const dupFalse = fit("| **AC-1** | 甲 |\n| **AC-2** | 甲 | T2 | A1（另见 AC-1） |\n")
  let caughtDup = null
  try {
    checkAnchorsAndACs(dupFalse, decl, "dup-false.md")
    assert.fail("应当抛")
  } catch (e) { caughtDup = e }
  assert.ok(caughtDup instanceof ShapeViolation, "必须是谓词级红（真红），不是整档崩溃")
  assert.ok(caughtDup.message.includes("AC 表 cell 数 2 != 表头列数 4"), "闸 A 必须报（cell 数不符）")
  assert.ok(!caughtDup.message.includes("AC 号重复"),
    "阴性对照①：残缺行的 AC 号**已进 `seen`** ⇒ 后续行把它当**重复**误报的现象**不存在**；"
    + "实测 " + caughtDup.violations.length + " 条：\n" + caughtDup.message)
  // —— 阴性对照②（**F10 的第二可观察面**：引用记录的**零丢失**）：残缺行的各 cell 里**一个锚号都没有**
  //    ⇒ `referenced` 的成员**必须全部在锚表里** ⇒ 「引用了不存在的锚」**一条都不许有**
  //    （旧实现整行丢弃该行后，这类记录会静默消失；**实测两者在此均不报**，故本腿据实登记：
  //     F10 的两条下游误报在「残缺行首列即 AC 号」的形态下**都不可观察**——见报告的自白段）。
  assert.ok(!caughtDup.message.includes("引用了**不存在的锚**"),
    "阴性对照②：残缺行不产生任何「引用不存在的锚」误报（`referenced` 零丢失）")
  // —— 阴性对照③（**反向腿一侧的诚实边界**）：残缺行丢掉的若**正是锚列**，则该引用**在谓词视野里不存在**——
  //    A2 只被这一条残缺行引用 ⇒ 反向腿**照报**；这是**结构性**的（不是本修复的漏），**只报不改**。
  const lostAnchor = fit("| **AC-1** | 甲 | T2 |\n", "| **A2** | 甲 | 乙 | 丙 |\n")
  assert.throws(() => checkAnchorsAndACs(lostAnchor, decl, "lost-anchor.md"),
    (e) => e instanceof ShapeViolation && e.message.includes("AC 表 cell 数 3 != 表头列数 4")
      && e.message.includes("反向腿——锚 A2 **未被任何 AC 引用**"),
    "阴性对照③：残缺行丢掉的**正是锚列**时，该引用在谓词视野里不存在 ⇒ 反向腿照报"
    + "（**结构性边界，已登记**：谓词读不到的东西不可能被它看见）")
  // —— 阴性对照④（防「反向腿恒不报」的假绿）：残缺行引用的锚**在锚表里没有定义** ⇒ 照样要报 ——
  const shortAndUndefined = fit("| **AC-1** | 甲 |\n| **AC-2** | 甲 | T2 | A7 |\n",
    "| **A1** | 甲 | 乙 | 丙 |\n| **A2** | 甲 | 乙 | 丙（豁免：本腿夹具，不挂单项 AC） |\n")
  assert.throws(() => checkAnchorsAndACs(shortAndUndefined, decl, "short-undef.md"),
    (e) => e instanceof ShapeViolation && e.message.includes("AC-2 引用了**不存在的锚** A7"),
    "阴性对照④：引用了未定义锚的行**照样**要报（引用的定义性判定不得被跳过）")
  // —— 阴性对照⑤（回归）：**完整行**的锚列清空照旧报闸 B ——
  //    ★ 用**既有负控腿 4 的夹具**（不带行尾换行）跑，证明 F10 的重构**零回归**
  const l4 = parseDocShape(SHAPE_FIXTURE)
  assert.throws(() => checkAnchorsAndACs(
    SHAPE_FIXTURE.replace("| **AC-1** | 甲 | T2 | A1 |", "| **AC-1** | 甲 | T2 |  |"), l4, "l4.md"),
    (e) => e instanceof ShapeViolation && e.message.includes("AC-1 层标 T2") && e.message.includes("必须有锚"),
    "阴性对照⑤（回归）：既有负控腿 4 的构型在 F10 修复后**照旧**红在闸 B（零回归）")
  // —— 阴性对照⑥（回归）：既有负控腿 5 的构型（末列删掉）照旧只报闸 A ——
  //    ★ 该构型的锚列**仍在**（只丢末列）⇒ 引用记录不受影响 ⇒ 与修复前同判
  assert.throws(() => checkAnchorsAndACs(
    SHAPE_FIXTURE.replace("| **AC-1** | 甲 | T2 | A1 |", "| **AC-1** | 甲 | T2 |"), l4, "l5.md"),
    (e) => e instanceof ShapeViolation && e.message.includes("AC 表 cell 数 3 != 表头列数 4"),
    "阴性对照⑥（回归）：既有负控腿 5 的构型照旧必红在闸 A")
})

// ——— ⑤-h：负控腿 8（**批 16 代码评审 #6 · §9 空集类②「零行」**） ———
// ★ 实测的 fail-open 缝：`shapeTable` 的 `raw` 收**全部表行（含表头 + 分隔线）** ⇒ 锚表与 AC 表
//   **双侧都只剩「表头 + 分隔线、零数据行」**时 `raw.length === 2` ⇒ 旧判据 `raw.length < 2`
//   **放行**，而 `anchors` / `seen` / `referenced` **三者全空** ⇒ `checkAnchorsAndACs` **整体判绿**。
//   （单侧空表会被「引用了不存在的锚」或反向腿兜住 ⇒ **双侧同空才全绿**——它是**漏报面**，不是误报面。）
// ★ 与 §9 失败方向①（**谓词面全 fail-closed**）直接相悖 ⇒ 判据改口径为「**零数据行 ⇒ 红**」
//   （与腿 2 的「某侧零条目 ⇒ 红」同律），且**两张表各报各的**——报错必须点名**是哪张表空**。
// ★ 夹具**纯内存**（不落临时档 ⇒ 零 EOL 陷阱、仓内零残留），并含**阴性对照**：
//   正常「表头 + 分隔线 + 一行数据」⇒ **不报**（证明新闸既非恒真、也不误伤正常表）。

/** 代码评审 #6 负控的极简夹具（**纯内存**；两张表各传**表体**，空串 = **零数据行**）。 */
const SHAPE_ZERO_ROW_FIXTURE = (anchorsBody, acsBody) =>
  "<!-- doc-shape\nanchors: 机验锚\nacs: 验收标准\n-->\n\n"
  + "### §8.2 机验锚\n\n| 锚 | 检索目标 | 谓词 | 期望 |\n|---|---|---|---|\n" + anchorsBody
  + "\n### §10.3 验收标准\n\n| # | 验收标准 | 层 | 锚 |\n|---|---|---|---|\n" + acsBody

test("DOC-HYGIENE 批 16 负控腿 8（代码评审 #6 / §9 空集类②）: 零数据行 ⇒ 必红（点名哪张表空）；正常一行 ⇒ 不报", () => {
  const decl = parseDocShape(SHAPE_ZERO_ROW_FIXTURE("", ""))
  assert.equal(decl.acs, "验收标准", "夹具声明必须可解析（否则负控跑不起来）")
  const A1 = "| **A1** | 甲 | 乙 | 丙 |\n"
  const AC1 = "| **AC-1** | 甲 | T2 | A1 |\n"
  /** 跑一遍并**只要谓词级红**（`ShapeViolation` = 真红；整档崩溃 = 假红 ⇒ 直接失败）。 */
  const shapeRed = (text, name) => {
    try {
      checkAnchorsAndACs(text, decl, name)
    } catch (e) {
      assert.ok(e instanceof ShapeViolation,
        "必须是**谓词级红**（真红 = ShapeViolation），不是整档崩溃：" + e)
      return e
    }
    return null
  }

  // —— 阴性对照①（**防「新闸恒红」的假绿**）：正常「表头 + 分隔线 + 一行数据」⇒ 一切照旧判绿 ——
  assert.deepEqual(checkAnchorsAndACs(SHAPE_ZERO_ROW_FIXTURE(A1, AC1), decl, "one-row.md"),
    { anchors: 1, acs: 1, referenced: 1 },
    "阴性对照①：表头 + 分隔线 + 一行数据 ⇒ 不报（新闸既非恒真、也不误伤正常表）")

  // —— 负控（**§9 空集类②的原始构型**）：锚表与 AC 表**双侧零数据行** ⇒ 必红 ——
  //    旧实现：`raw.length === 2` ⇒ 放行；`anchors` / `seen` / `referenced` 全空 ⇒ **整体判绿**
  const both = shapeRed(SHAPE_ZERO_ROW_FIXTURE("", ""), "zero-row.md")
  assert.ok(both !== null, "负控腿 8：**双侧零数据行**必须红（这正是旧实现的 fail-open 缝）")
  assert.equal(both.violations.length, 2,
    "两张空表**各报一条**，实测 " + both.violations.length + " 条：\n" + both.message)
  assert.ok(both.violations[0].includes("锚表（anchors）") && !both.violations[0].includes("AC 表（acs）"),
    "判据区分表①：第 1 条**点名锚表空**（且不得指向 AC 表）：" + both.violations[0])
  assert.ok(both.violations[1].includes("AC 表（acs）") && !both.violations[1].includes("锚表（anchors）"),
    "判据区分表②：第 2 条**点名 AC 表空**（且不得指向锚表）：" + both.violations[1])
  for (const v of both.violations) {
    assert.ok(v.includes("**零数据行**"), "报错必须含判据字样「零数据行」：" + v)
    assert.ok(/^zero-row\.md: /.test(v), "报错必须含档案名（可定位）：" + v)
  }

  // —— **单侧区分力**（逐条自证：新闸不是「凡跑必报两条」的恒真写法） ——
  //    ② 只**锚表**空（AC 表给一行**免锚的 T3** ⇒ 不触发任何引用类违规）⇒ **只报锚表空**
  const onlyAnchor = shapeRed(SHAPE_ZERO_ROW_FIXTURE("", "| **AC-1** | 甲 | T3 | — |\n"), "only-anchor.md")
  assert.ok(onlyAnchor !== null, "锚表零数据行 ⇒ 必红")
  assert.equal(onlyAnchor.violations.length, 1,
    "只锚表空 ⇒ **只报一条**（AC 表那侧不得误报），实测 " + onlyAnchor.violations.length + " 条：\n" + onlyAnchor.message)
  assert.ok(onlyAnchor.violations[0].includes("锚表（anchors） **零数据行**"),
    "只锚表空 ⇒ 报错**点名锚表**：" + onlyAnchor.violations[0])
  //    ③ 只 **AC 表**空（锚表的锚带**显式豁免标记** ⇒ 不触发反向腿）⇒ **只报 AC 表空**
  const onlyAcs = shapeRed(SHAPE_ZERO_ROW_FIXTURE("| **A1** | 甲 | 乙 | 丙（豁免：本腿夹具，不挂单项 AC） |\n", ""), "only-acs.md")
  assert.ok(onlyAcs !== null, "AC 表零数据行 ⇒ 必红")
  assert.equal(onlyAcs.violations.length, 1,
    "只 AC 表空 ⇒ **只报一条**（锚表那侧不得误报），实测 " + onlyAcs.violations.length + " 条：\n" + onlyAcs.message)
  assert.ok(onlyAcs.violations[0].includes("AC 表（acs） **零数据行**"),
    "只 AC 表空 ⇒ 报错**点名 AC 表**：" + onlyAcs.violations[0])
})

// ═══════════════ ⑥ 批 17 · FR-0 三处既有正确性修复的负控腿（**改前红 / 改后绿**） ═══════════════
//
// 设计档 `docs/2026-09-17-scope-alignment-design.md`：**§5.1 FR-0a/FR-0b/FR-0c** ·
// **§8.2 锚 A1 / A1b / A2 与负控表第 4/5/6 行** · **§10.3 AC-4 / AC-4b / AC-5** ·
// **§9.2 CE-4 / CE-6** · **§10.4 stage 1**。
// ★ 三条腿都是**修缺陷**（不是加豁免）：**改前红 / 改后绿** 由 `legacyCountMarks`（**改前形态复现**，
//   只在负控里使用、**不在谓词路径上**）与「同一内容去掉围栏后照旧红」两种方式各自取证。
// ★ 全部在**纯内存夹具**上构造（D5：不动被锁对象；仓内零残留）。

/**
 * **改前形态复现**（负控自证专用，**绝不进谓词路径**）：批 16 的三处形态——
 * ① 掩码 = **空格**（不是占位符）· ② 闭括号取**首个** `）` · ③ 掩码器**不认围栏**。
 * @return 违规明细（`{ line, declared, actual }`），空 = 判绿
 */
function legacyCountMarks(text, marks) {
  const units = (marks && marks.length > 0 ? marks : SHAPE_DEFAULT_MARKS)
    .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  const markSrc = "（([0-9]+)\\s*(" + units + ")："
  const bad = []
  const lines = lf(text).split("\n")
  for (let i = 0; i < lines.length; i++) {
    const masked = lines[i].replace(/`[^`]*`/g, (s) => " ".repeat(s.length)) // 改前：空格掩码、不认围栏
    for (const m of masked.matchAll(new RegExp(markSrc, "g"))) {
      const rest = masked.slice(m.index + m[0].length)
      const close = rest.indexOf("）") // 改前：**首个**全角闭括号
      const seg = close < 0 ? rest : rest.slice(0, close)
      const actual = seg.split("·").filter((s) => s.trim() !== "").length
      if (actual !== Number(m[1])) bad.push({ line: i + 1, declared: Number(m[1]), actual })
    }
  }
  return bad
}

test("DOC-HYGIENE 批 17 负控腿 1（锚 A1 / AC-4 · FR-0a）: 深度感知闭括号——`（3 项：a（§1）· b · c）` ⇒ 3 == 3 绿；改前截断 ⇒ 假红", () => {
  const marks = SHAPE_DEFAULT_MARKS
  // ★ FR-0a 的宿主是**严格档位**（批 16 的 `indexOf("）")` 就住在那条路上）；
  //   而设计档锚 A1 的构造用的是**无空格 `·`** ⇒ 在宽松档位会被约束②跳过（另有一条断言钉它）。
  const STRICT = { declared: true }
  const LOOSE = { declared: false }
  // 设计档 §8.2 锚 A1 的构造（逐字）：**全角嵌套引注**（`（§1）`）是中文技术写作的常态。
  const nested = "本档（3 项：需求档（§1）· 设计档（§7）· 台账（§三））三处同改。\n"
  // —— 改后（谓词路径）：深度归零处才是本标记的闭括号 ⇒ 3 == 3 ⇒ 绿 ——
  assert.equal(checkCountMarks(nested, marks, "nested.md", STRICT), 1,
    "FR-0a：嵌套引注不得截断列表 ⇒ 3 项 == 3 项 ⇒ 绿（严格档位）")
  // —— 改前形态复现（**假红**的实证）：首个 `）` 截在 `§1` 之后 ⇒ 只数到 1 段 ⇒ 1 ≠ 3 ⇒ 红 ——
  assert.deepEqual(legacyCountMarks(nested, marks), [{ line: 1, declared: 3, actual: 1 }],
    "改前形态复现：`rest.indexOf(\"）\")` 取首个 ⇒ 截断在第 1 个 `）` ⇒ 1 ≠ 3（**假红**，非真违规）")
  // —— 谓词自证（防「恒绿」的假绿）：真不等**照样**红，且报错带三要素（档:行 + 声明值 + 实际值）——
  assert.throws(() => checkCountMarks("本档（3 项：设计档（§7）· 台账（§三））\n", marks, "short.md", STRICT),
    (e) => e instanceof ShapeViolation && /short\.md:1: 声明 3 项 · 实际 2 项/.test(e.message),
    "谓词自证：嵌套引注 + **真少一项** ⇒ 2 ≠ 3 ⇒ 必红（深度感知不是「一律放行」）")
  // 阴性对照：无嵌套的同构造照旧按旧判据工作（零回归）
  assert.equal(checkCountMarks("本档（2 项：a · b）\n", marks, "plain.md", STRICT), 1, "阴性对照：无嵌套形态照旧判绿（零回归）")
  // ★ 双模式分工（FR-3 §5.4 约束②）：同一构造成在**未声明档**里 ⇒ 无空格 `·` 不算分隔符 ⇒ **跳过**
  assert.equal(checkCountMarks(nested, marks, "nested-loose.md", LOOSE), 1,
    "双模式分工：无空格 `·` 在未声明档**不作分隔信号** ⇒ 跳过（不红）——A1 的 3==3 由严格档位给出")
})

test("DOC-HYGIENE 批 17 负控腿 2（锚 A2 / AC-5 · FR-0b）: 围栏内整块不受检（标记与路径）——改前围栏内容裸奔 ⇒ 假红", () => {
  const marks = SHAPE_DEFAULT_MARKS
  const STRICT = { declared: true }
  // 设计档 §8.2 锚 A2 的构造：围栏内的标记与路径（本批自己的语法规格块就是这种形态）。
  const doc = "```text\n（3 项：a · b）\n见 [缺档](./b17-nonexistent.md)。\n```\n"
    + "围栏外（2 项：a · b）与声明一致。\n"
  // —— 改后：围栏界定行 + 围栏内整行都被掩 ⇒ 只核到**围栏外**那 1 处 ——
  assert.equal(checkCountMarks(doc, marks, "fenced.md", STRICT), 1,
    "FR-0b：围栏内整块不受检 ⇒ 只核到围栏外 1 处（实测 " + checkCountMarks(doc, marks, "fenced.md", STRICT) + "）")
  assert.deepEqual(checkRefs(doc, PLUGIN_DIR, PLUGIN_DIR, "fenced.md"),
    { checked: 0, targets: [] },
    "FR-0b：围栏内的相对链接**同样**不受检（与行内 span 同待遇）")
  // —— 改前红（**同一内容去掉围栏** ⇒ 两条腿各自真红）——
  assert.deepEqual(legacyCountMarks(doc, marks).map((v) => v.actual), [2],
    "改前形态复现：掩码器不认围栏 ⇒ 围栏内的 `（3 项：a · b）` 被核 ⇒ 2 ≠ 3 ⇒（假红）")
  assert.throws(() => checkRefs("见 [缺档](./b17-nonexistent.md)。\n", PLUGIN_DIR, PLUGIN_DIR, "nofence.md"),
    (e) => e instanceof ShapeViolation && e.message.includes("b17-nonexistent.md"),
    "改前红的实证：**同样的链接写到围栏之外** ⇒ 腿 3 照旧必红（⇒ 围栏是唯一让它免检的东西）")
  // —— 闭合围栏**之后**恢复受检（状态机不得「一进不出」）——
  const after = "```text\n(示例行)\n```\n后文（3 项：a · b）。\n"
  assert.throws(() => checkCountMarks(after, marks, "after.md", STRICT),
    (e) => e instanceof ShapeViolation && e.message.includes("实际 2 项"),
    "闭合围栏之后的标记**照旧受检**（状态机在闭合行复位）")
  // 阴性对照：未闭合围栏（无 ``` 收尾）⇒ 其后直到档尾都在围栏内 ⇒ 不受检
  assert.equal(checkCountMarks("```text\n（3 项：a · b）\n", marks, "unclosed.md", STRICT), 0,
    "阴性对照：未闭合围栏 ⇒ 余下全文视为围栏内 ⇒ 零受检")
})

test("DOC-HYGIENE 批 17 负控腿 3（锚 A1b / AC-4b · FR-0c）: 项整体住在代码 span 里 ⇒ 段仍判非空 ⇒ 2 == 2 绿；改前 actual=0 ⇒ 假红", () => {
  const marks = SHAPE_DEFAULT_MARKS
  const STRICT = { declared: true }
  const LOOSE = { declared: false }
  // 设计档 §8.2 锚 A1b 的构造（逐字）：**项整体住在反引号里**——本仓文风必然这么写档名。
  const spans = "本批（2 档：`docs/2026-09-17-scope-alignment-design.md` · `docs/2026-09-17-scope-alignment-requirements.md`）自带声明。\n"
  // —— 改后：掩码体是**非空白占位符** ⇒ 两段各自非空 ⇒ 2 == 2 ⇒ 绿（**两档位各证一次**）——
  assert.equal(checkCountMarks(spans, marks, "spans.md", STRICT), 1, "FR-0c：项整体住在 span 里 ⇒ 2 档 == 2 档 ⇒ 绿（严格档位）")
  assert.equal(checkCountMarks(spans, marks, "spans-loose.md", LOOSE), 1, "FR-0c：同上（未声明档/宽松档位——CE-4 的原始宿主）")
  // 占位符语义自证：它**不是空白**（否则 `trim()` 会把整段判空——那正是改前的假红机制）
  assert.equal(SHAPE_PLACE.trim(), SHAPE_PLACE, "FR-0c 自证：占位符必须**非空白**（`trim()` 不得剥掉它）")
  // —— 改前形态复现（**假红**的实证）：空格掩码 ⇒ 两段 trim 后全空 ⇒ actual = 0 ⇒ 0 ≠ 2 ⇒ 红 ——
  assert.deepEqual(legacyCountMarks(spans, marks), [{ line: 1, declared: 2, actual: 0 }],
    "改前形态复现：空格掩码 ⇒ 段全空 ⇒ actual=0 ≠ 2（**假红**——本仓下一个会话必踩）")
  // —— 谓词自证（防「掩码把一切洗绿」）：真不等**照样**红 ——
  assert.throws(() => checkCountMarks("本批（3 档：`a.md` · `b.md`）自带声明。\n", marks, "short-span.md", STRICT),
    (e) => e instanceof ShapeViolation && /short-span\.md:1: 声明 3 档 · 实际 2 档/.test(e.message),
    "谓词自证：项全住 span 里 + 真少一项 ⇒ 2 ≠ 3 ⇒ 必红（占位符不是「一律放行」）")
  // 阴性对照：span 内外混合 + 空段仍不计入
  assert.equal(checkCountMarks("本批（2 档：`a.md` · 说明档）自带声明。\n", marks, "mixed.md", STRICT), 1,
    "阴性对照：span 内一项 + span 外一项 ⇒ 2 == 2（混合形态同判）")
})

// ═══════════════ ⑦ 批 17 · FR-1 / FR-3 / FR-4 的负控腿 ═══════════════
//
// 设计档：**§5.2 FR-1**（标记语法与 id 字符集 · 锚 A3/A4）· **§5.4 FR-3**（双模式真值表 ·
// 锚 A8 · N-3）· **§5.5 FR-4**（R-1…R-8）· **§9.1 升级/畸形输入**（旧标记不退化 · id 含 `@`/`|` 不接受）·
// **§8.2 负控表第 7/8/9 行**（三条宽松约束，**成对**：未声明档跳过 / 声明档同构造 ⇒ 红）。

test("DOC-HYGIENE 批 17 负控腿 4（锚 A3 / A4 / AC-1）: 全枚举形与裸引用形共用匹配器；全枚举禁省略；id 含 `@`/`|` 不接受", () => {
  const marks = SHAPE_DEFAULT_MARKS
  const STRICT = { declared: true }
  const LOOSE = { declared: false }
  // —— A3：**全枚举形**（值 = `(N, 项集)`）——项数 == N ——
  const full = parseFacts("本批（8 条 id=b17-负控构造：a · b · c · d · e · f · g · h）八项。\n", "full.md", marks)
  assert.equal(full.length, 1, "A3：全枚举形必须被识别（实测 " + full.length + " 处）")
  assert.equal(full[0].id, "b17-负控构造", "A3：id 必须逐字读出")
  assert.equal(full[0].n, 8, "A3：N 必须读出")
  assert.deepEqual(full[0].items, ["a", "b", "c", "d", "e", "f", "g", "h"], "A3：全枚举形的**项集**必须读全（禁省略）")
  // —— A3：**裸引用形**（值 = N，无列表可比）——
  const bare = parseFacts("本批（8 条 id=b17-负控构造）。\n", "bare.md", marks)
  assert.equal(bare.length, 1, "A3：裸引用形必须被识别")
  assert.equal(bare[0].items, null, "A3：裸引用形**没有项集**（`items === null`）")
  assert.equal(bare[0].n, 8, "A3：裸引用形的值 = N")
  // —— §9 升级类：**旧标记（无 id）保持合法**（N-3 不退化）——
  const legacy = parseFacts("本档（3 项：a · b · c）。\n", "legacy.md", marks)
  assert.equal(legacy[0].id, null, "旧标记的 id 为 null（= 普通计数标记）")
  assert.deepEqual(legacy[0].items, ["a", "b", "c"], "旧标记的项集照旧读全")
  // —— A4：**id 字符集排除 `@` 与 `|`**（它们是 `require-facts` 的分隔符）——
  assert.deepEqual(parseFacts("本批（8 条 id=b17@x：a · b）。\n", "at.md", marks).filter((h) => h.id !== null), [],
    "A4：`@` 不被接受为该 id（否则与 `require-facts: id@N` 的解析必打架）")
  assert.deepEqual(parseFacts("本批（8 条 id=b17|x）。\n", "pipe.md", marks).filter((h) => h.id !== null), [],
    "A4：`|` 不被接受为该 id（它是 `require-facts` 的条目分隔符）")
  // ★ 而「不被接受」的方向是 **fail-closed 红**（§9.1 畸形输入），不是「静默不认这个标记」
  assert.throws(() => checkCountMarks("本批（8 条 id=b17@x：a · b）。\n", marks, "at.md", LOOSE),
    (e) => e instanceof ShapeViolation && e.message.includes("不接受") && e.message.includes("b17@x"),
    "A4 的失败方向：畸形 id 必须**点名报红**（静默跳过 = 一个畸形 id 就让该处的计数检查整条消失）")
  assert.throws(() => checkCountMarks("本批（8 条 id=b17|x）。\n", marks, "pipe.md", STRICT),
    (e) => e instanceof ShapeViolation && e.message.includes("不接受"),
    "A4：裸引用形里的畸形 id 同样必红")
  // —— ★ **全枚举形禁省略**（D17-3，集成事实）：`（8 条 id=X：a · b …）` 照字面写进真档必红 ——
  assert.throws(() => checkCountMarks("本批（8 条 id=b17-x：a · b …）。\n", marks, "ellipsis.md", LOOSE),
    (e) => e instanceof ShapeViolation && e.message.includes("实际 2 条"),
    "D17-3：省略形在**任何**档位都必红（带 `id=` ⇒ 一律严格档位，K6）")
  // 阳性对照：写全 ⇒ 绿（8 == 8）
  assert.equal(checkCountMarks("本批（8 条 id=b17-x：a · b · c · d · e · f · g · h）。\n", marks, "full8.md", LOOSE), 1,
    "阳性对照：全枚举写全 ⇒ 8 == 8 ⇒ 绿（带 id 的标记在未声明档也走严格档位）")
})

test("DOC-HYGIENE 批 17 负控腿 5（锚 A8 / AC-11 · FR-3）: 未声明档三条宽松约束各自跳过；声明档同构造 ⇒ 红（成对）", () => {
  const marks = SHAPE_DEFAULT_MARKS
  const STRICT = { declared: true }
  const LOOSE = { declared: false }
  // —— 宽松约束①（**段内零 `·` 且 N≥2 ⇒ 跳过**：杀 CE-2/CE-3 的零段形态）——
  const dunhao = "本批（3 项：甲、乙、丙）。\n"          // 顿号枚举（中文第一枚举习惯）
  assert.equal(checkCountMarks(dunhao, marks, "dunhao-loose.md", LOOSE), 1,
    "宽松约束①：未声明档「零 `·` 且 N≥2」⇒ **跳过**（不红）")
  assert.throws(() => checkCountMarks(dunhao, marks, "dunhao-strict.md", STRICT),
    (e) => e instanceof ShapeViolation && e.message.includes("实际 1 项"),
    "宽松约束①（成对）：**声明档同构造 ⇒ 红**（批 16 的严格语义不退化——签约者写顿号即违约）")
  const wrapOpen = "本批（3 项：\n甲乙丙）\n"              // CE-2：跨行枚举（行内无段）
  assert.equal(checkCountMarks(wrapOpen, marks, "wrap-loose.md", LOOSE), 1, "宽松约束①：跨行枚举（行内零段）⇒ 跳过")
  // —— 宽松约束②（**只认两侧带空格的 ` · `**）——
  const noSpace = "本批（2 项：a·b）。\n"                 // 无空格 `·`：不作列表信号
  assert.equal(checkCountMarks(noSpace, marks, "nospace-loose.md", LOOSE), 1,
    "宽松约束②：无空格 `·` 不裂段 ⇒ 未声明档跳过（CE-1 的译名形态同族）")
  assert.throws(() => checkCountMarks("本批（3 项：a·b）。\n", marks, "nospace-strict.md", STRICT),
    (e) => e instanceof ShapeViolation && e.message.includes("实际 2 项"),
    "宽松约束②（成对·同分隔符形态）：声明档里 `·` **仍是**分隔符 ⇒ 2 ≠ 3 ⇒ 红")
  // ② 的正例：带空格 ` · ` 在未声明档**照常受核**（跳过只针对「不可核」的形态，不是「凡未声明就跳过」）
  assert.throws(() => checkCountMarks("本批（3 项：a · b）。\n", marks, "spaced-loose.md", LOOSE),
    (e) => e instanceof ShapeViolation && e.message.includes("实际 2 项"),
    "宽松约束②的反面：带空格 ` · ` 的列表在未声明档**照常受核**（该腿不是恒 skip）")
  // —— 宽松约束③（**尾随 `·`（末段为空）⇒ 跳过**：杀 CE-7 的折行形态）——
  const trailing = "本批（2 项：a ·\nb）。\n"
  assert.equal(checkCountMarks(trailing, marks, "trail-loose.md", LOOSE), 1, "宽松约束③：尾随 `·` ⇒ 未声明档跳过")
  assert.throws(() => checkCountMarks(trailing, marks, "trail-strict.md", STRICT),
    (e) => e instanceof ShapeViolation && e.message.includes("实际 1 项"),
    "宽松约束③（成对）：**声明档同构造 ⇒ 红**（批 16 边界③ 的语义原样保留）")
  // —— CE-1 的原始形态：译名内的**无空格 `·`** ⇒ 宽松档按 3 人正确计数（**不是跳过**）——
  assert.equal(checkCountMarks("本批（3 项：让-保罗·萨特 · 西蒙娜·德·波伏瓦 · 阿尔贝·加缪）。\n", marks, "ce1.md", LOOSE), 1,
    "CE-1：未声明档只认 ` · ` ⇒ 译名内的无空格 `·` 不裂段 ⇒ 3 人 == 3 ⇒ 绿（改前会裂成更多段）")
  assert.throws(() => checkCountMarks("本批（3 项：让-保罗·萨特 · 西蒙娜·德·波伏瓦 · 阿尔贝·加缪）。\n", marks, "ce1-s.md", STRICT),
    (e) => e instanceof ShapeViolation,
    "CE-1（成对）：同一构造成在**声明档** ⇒ 严格档位按每个 `·` 裂段 ⇒ 必红（代价已登记于设计档 §9.2）")
})

test("DOC-HYGIENE 批 17 负控腿 6（AC-2 / R-1…R-8 · FR-4）: 值只从标记载荷取；集合 trim 后精确串等值且顺序无关；措辞与量词不入等值", () => {
  const marks = SHAPE_DEFAULT_MARKS
  // —— R-3：**集合等值 = trim 后精确串等值 + 顺序无关** ——
  const a = parseFacts("（3 项 id=b17-s：甲 · 乙 · 丙）\n", "a.md", marks)[0]
  const b = parseFacts("（3 项 id=b17-s：丙 · 甲 · 乙）\n", "b.md", marks)[0]
  assert.deepEqual(shapeSet(a.items), ["丙", "乙", "甲"].sort(), "R-3：集合归一 = trim + 排序（顺序无关）")
  assert.ok(shapeSetEqual(a.items, b.items), "R-3：同一集合**换序** ⇒ 判等（顺序漂移不是漂移）")
  const c = parseFacts("（3 项 id=b17-s：甲 · 乙 · 丙（订正））\n", "c.md", marks)[0]
  assert.ok(!shapeSetEqual(a.items, c.items),
    "R-3 的元原则（D17-8）：**归一只许修呈现**——`丙（订正）` 与 `丙` 必须判**不等**"
    + "（若在这里做「剥括注」的归一，真污染就被洗成绿了）")
  // —— R-2/R-7：**措辞与量词不入等值**（值只从标记载荷取）——
  const w1 = parseFacts("本批**新增**（8 条 id=b17-t）本批条目。\n", "w1.md", marks)[0]
  const w2 = parseFacts("本批（8 项 id=b17-t）。\n", "w2.md", marks)[0]
  assert.equal(w1.n, w2.n, "R-1/R-2：包装词「新增」在标记**之外** ⇒ 不进比较面（值只从载荷取）")
  assert.equal(w1.unit + "|" + w2.unit, "条|项", "R-7：量词是呈现、id 才是同一性 ⇒ 量词不入等值（实测 " + w1.unit + "/" + w2.unit + "）")
  assert.equal(shapeScalar(w1.n), shapeScalar(w2.n), "R-1：标量按**整数**比较（`08` 与 `8` 同值）")
  assert.equal(shapeScalar(parseFacts("（08 条 id=b17-t）。\n", "w3.md", marks)[0].n), 8, "R-1：前导零按整数归一（`08` ⇒ 8）")
  // —— R-8：**值域 = 非负整数**；semver / SHA 类事实**不进标记语法**（不匹配 ⇒ 静默无事发生，已登记）——
  assert.deepEqual(parseFacts("本批（v0.24.0 条 id=b17-u）。\n", "semver.md", marks), [],
    "R-8：semver 不是整数 ⇒ 不进标记语法（那是「锚定现实」方向，已登记为后续）")
  assert.deepEqual(parseFacts("（1,024 条 id=b17-u）。\n", "comma.md", marks), [],
    "R-8：千分位 ⇒ 不匹配（既定天花板，登记在 §9.3 R-2）")
  // —— R-6：**报错面 = 全部出现处的 `文件:行:原文`**（绝不只报归一值）——
  const occ = [a, b, c]
  const txt = shapeOccurrences(occ)
  for (const h of occ) {
    assert.ok(txt.includes(h.file + ":" + h.line + ":" + h.raw),
      "R-6：报错面必须含每一处的 `文件:行:原文`（实测 " + txt + "）")
  }
  // —— R-4：混合形态——**全枚举处强制 `N == |集|`**（腿 1 既有判据），跨处只比标量 ——
  assert.throws(() => checkCountMarks("（8 条 id=b17-v：a · b · c）。\n", marks, "mixed4.md", { declared: false }),
    (e) => e instanceof ShapeViolation && e.message.includes("实际 3 条"),
    "R-4：全枚举形**强制 `N == |集|`**（混合形态下这一条对每个全枚举处都成立，不因跨处比较而放松）")
})

// ═══════════════ ⑧ 批 17 · FR-2（事实 id 腿）与 FR-5（CHANGELOG 两态）的负控腿 ═══════════════
//
// 设计档：**§5.3 FR-2**（跨档分组 ＋ 两条不变量 · §6 的 `checkFactGroups` · 图 2）·
// **§5.6 FR-5**（两态定位器 ＋ 锚定行抽取 ＋ 绑定规则 ＋ 等值锁 · 图 3）· **§8.2 锚 A5/A6/A7/A9/A9b** ·
// **§10.3 AC-1…AC-3 / AC-6 / AC-6b / AC-7** · **§8.2 负控表第 1/2/3 行与「CHANGELOG 两态」行**。
// ★ 夹具一律**纯内存**（零临时档 ⇒ 零 EOL 陷阱、仓内零残留）。

test("DOC-HYGIENE 批 17 负控腿 7（锚 A5 / A6 / A7 · AC-1…AC-3）: 事实 id 腿——同值不变量 · @N 次数 · 防恒真（三条负控各自红）", () => {
  const marks = SHAPE_DEFAULT_MARKS
  const F = (t) => parseFacts(t, "f.md", marks) // 出现处的档名统一为 f.md（报错面自证的载体）
  // 阳性对照（防「该腿恒红」的假绿）：**两处同值** ＋ 另一组两处同值 ⇒ 绿
  const healthy = "甲（8 条 id=b17-x）。\n乙（8 条 id=b17-x）。\n丙（3 条 id=b17-y）。\n丁（3 条 id=b17-y）。\n"
  assert.deepEqual(checkFactGroups(F(healthy), [{ id: "b17-x", n: 2, bind: null }, { id: "b17-y", n: 2, bind: null }]),
    { groups: 2, multiGroups: 2, occurrences: 4 }, "阳性对照：两组各自两处同值 ⇒ 绿")
  // —— 负控①（**不变量①·同值**）：同 id 两处异值 ⇒ 红，且**报全部出现处的 `文件:行:原文`** ——
  const diff = "甲（8 条 id=b17-x）。\n乙（9 条 id=b17-x）。\n丙（3 条 id=b17-y）。\n丁（3 条 id=b17-y）。\n"
  try {
    checkFactGroups(F(diff), [])
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation, "必须是**谓词级红**（真红 = ShapeViolation），不是整档崩溃")
    assert.ok(e.message.includes("不变量①（组内同值）破"), "断言①：打红的是**不变量①**那条：" + e.message)
    assert.ok(e.message.includes("f.md:1:") && e.message.includes("f.md:2:"),
      "R-6 / US-2：报错必须含**全部出现处**的 `文件:行`（实测：" + e.message + "）")
    assert.ok(e.message.includes("8") && e.message.includes("9"), "报错必须点名两个**不同的值**")
  }
  // —— 负控②（**不变量②·次数**）：注册 id `@2` 而档内只出现 1 次 ⇒ 红（id 笔误 ⇒ 裂成单例 ⇒ 次数不足）——
  const single = "甲（8 条 id=b17-x）。\n丙（3 条 id=b17-y）。\n丁（3 条 id=b17-y）。\n"
  try {
    checkFactGroups(F(single), [{ id: "b17-x", n: 2, bind: null }])
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("不变量②（次数）破"),
      "断言②：打红的是**不变量②**那条（id 笔误 ⇒ 次数不足）：" + e.message)
    assert.ok(e.message.includes("@2") && e.message.includes("1 处"), "报错必须点名声明次数与实际次数：" + e.message)
  }
  // —— 阴性对照（D17-2 的不对称）：**未注册的单例 id 不红**（「一次事实只出现一次」是常态） ——
  assert.deepEqual(checkFactGroups(F(single), []), { groups: 2, multiGroups: 1, occurrences: 3 },
    "阴性对照：未注册的单例 id `b17-x` 不红（只有**注册事实**才受 @N 约束）")
  // —— 负控③（**防恒真** A7）：全域零个「≥2 处档内出现」的组 ⇒ 红 ——
  const singletons = "甲（8 条 id=b17-p）。\n乙（9 条 id=b17-q）。\n"
  try {
    checkFactGroups(F(singletons), [])
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("零个"),
      "断言③：打红的是**防恒真**那条（id 全部裂成单例 ⇒ 该腿什么都没比过）：" + e.message)
  }
  // —— 集合不变量（≥2 处携带枚举时才比——R-3）：N 相同而**成员不同** ⇒ 红 ——
  const setDiff = "甲（3 条 id=b17-z：a · b · c）。\n乙（3 条 id=b17-z：a · b · d）。\n"
  try {
    checkFactGroups(F(setDiff), [{ id: "b17-z", n: 2, bind: null }])
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("集合不变量破"),
      "集合不变量：**N 相同而成员不同** ⇒ 红（这是本机制唯一能抓「同 N 不同成员」的腿）：" + e.message)
  }
  // 集合不变量的**顺序无关**（R-3）：换序 ⇒ 绿
  assert.deepEqual(checkFactGroups(F("甲（3 条 id=b17-z：a · b · c）。\n乙（3 条 id=b17-z：c · a · b）。\n"),
    [{ id: "b17-z", n: 2, bind: null }]), { groups: 1, multiGroups: 1, occurrences: 2 },
    "R-3：同一集合**换序** ⇒ 绿（顺序漂移不是漂移）")
})

test("DOC-HYGIENE 批 17 负控腿 8（锚 A9 / AC-6 · AC-7）: CHANGELOG 两态定位器 ＋ 锚定行抽取 ＋ 与既有解析器的等值锁", () => {
  // —— 死区态（**交付时点**）：新条目落在 `# Changelog` 到首个版本头之间 ——
  const DEAD = "# Changelog\n\n引言行。\n\n**批 17**\n\n- 死区里的本批条目：【计数行】**473/473**（基线 464 + 本批 9）。\n\n"
    + "## [0.24.0] — 2026-09-16\n\n- **【计数行】**：**464/464**（基线 456 + 本批 8）。\n"
  const dead = shapeLocateCountLine(DEAD, "changelog.md")
  assert.equal(dead.state, "deadzone", "AC-6①：死区含 1 处标记 ⇒ **绑死区**（交付时点态）")
  const exDead = shapeExtractCountLine(dead.text, dead.line, "changelog.md")
  assert.deepEqual([exDead.actual, exDead.total, exDead.baseline, exDead.added], [473, 473, 464, 9],
    "AC-6①：死区行的三条抽取（`**N/N**` 的 N · 基线 · 本批）")
  // —— 首节态（**收口后**）：死区 0 处 ⇒ 绑首节 ——
  const FIRST = "# Changelog\n\n引言行。\n\n## [0.24.0] — 2026-09-16\n\n"
    + "- **【计数行】**：**464/464**（基线 456 + 本批 8）。\n\n## [0.23.0]\n\n- 旧条目。【计数行】**1/1** 基线 0 本批 1\n"
  const first = shapeLocateCountLine(FIRST, "changelog.md")
  assert.equal(first.state, "first-section", "AC-6②：死区 0 处而首节含 ⇒ **绑首节**（收口后态）")
  assert.equal(first.line, 7, "AC-6②：绑的是**首节内**那一行（不是 0.23.0 节里的）")
  // —— 负控（fail-closed）：死区 **>1 处** ⇒ 红 ——
  try {
    shapeLocateCountLine("# Changelog\n\nA：【计数行】 x\nB：【计数行】 y\n\n## [1.0.0]\n\n- 【计数行】 z\n", "changelog.md")
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("死区") && e.message.includes("fail-closed"),
      "AC-6 负控①：死区 >1 处 ⇒ 红（两批同飞不是本仓惯例）：" + e.message)
  }
  // —— 负控：**两态都不含** ⇒ 红（定位失败**不是跳过**）——
  try {
    shapeLocateCountLine("# Changelog\n\n无标记。\n\n## [1.0.0]\n\n- 无标记。\n", "changelog.md")
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("定位失败不是跳过"),
      "AC-6 负控②：两态都不含 ⇒ 红（§9：定位失败不是跳过）：" + e.message)
  }
  // —— 负控：定位行内**缺 `基线 X`** ⇒ 锚定行抽取红（R-1 的三条抽取之一落空）——
  try {
    const l = shapeLocateCountLine("# Changelog\n\n## [1.0.0]\n\n- 【计数行】**464/464**（本批 8）。\n", "changelog.md")
    shapeExtractCountLine(l.text, l.line, "changelog.md")
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("基线"), "AC-6 负控③：定位行缺 `基线 X` ⇒ 红：" + e.message)
  }
  // —— ★ 等值锁（AC-7）：**首节态**下，本抽取器 == `parseChangelogCountLine` 的输出 ——
  const refFirst = parseChangelogCountLine(FIRST)
  assert.equal(refFirst.actual, 464, "参照面自证：既有解析器在首节态读到 464（实测 " + refFirst.actual + "）")
  assert.ok(shapeChangelogLock(FIRST, "changelog.md").locked, "AC-7：首节态 ⇒ 等值锁**生效**且两侧同值")
  // —— 等值锁的反面（防恒真）：首节内**首例**与**锚定行**不同 ⇒ 等值锁必红 ——
  const TRAP = "# Changelog\n\n## [0.24.0] — 2026-09-16\n\n散文里的次生推导式 **999/999**（基线 1 + 本批 2）。\n"
    + "- **【计数行】**：**464/464**（基线 456 + 本批 8）。\n"
  try {
    shapeChangelogLock(TRAP, "changelog.md")
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("等值锁破"),
      "AC-7 负控：锚定行抽取（464）≠ 既有解析器的首例匹配（999）⇒ 等值锁必红（证明它不是恒真）：" + e.message)
  }
  // —— 真实 CHANGELOG：**两态各自成立**（stage 3 时点为**首节态**；stage 4 写入本批条目后成**死区态**）——
  const real = lf(read("CHANGELOG.md"))
  const lock = shapeChangelogLock(real, "CHANGELOG.md")
  assert.ok(lock.state === "deadzone" || (lock.state === "first-section" && lock.locked),
    "真实 CHANGELOG 必须处于两态之一且定位成功（实测 state=" + lock.state + " · line=" + lock.line + "）")
})

test("DOC-HYGIENE 批 17 负控腿 9（锚 A9b / AC-6b）: 绑定规则三槽（nsN/baseline/added）＋ 畸形绑定三条 ＋ 合法绑定 ⇒ 与 docs 侧同值", () => {
  const marks = SHAPE_DEFAULT_MARKS
  const CL = "# Changelog\n\n引言行。\n\n## [9.9.9] — 2026-01-01\n\n- **【计数行】**：**20/20**（基线 17 + 本批 3）。\n"
  // —— 合法绑定：**三槽各有抽取断言**，且**抽取值 == docs 侧同 id 值** ——
  const regs = parseRequireFacts("b17-c@2 bind=changelog.nsN|b17-b@2 bind=changelog.baseline|b17-a@2 bind=changelog.added")
  assert.deepEqual(regs.map((r) => r.bind.slot), ["nsN", "baseline", "added"], "AC-6b：三槽逐条解析出来")
  const docs = "甲（20 条 id=b17-c）。\n乙（20 条 id=b17-c）。\n丙（17 条 id=b17-b）。\n丁（17 条 id=b17-b）。\n"
    + "戊（3 条 id=b17-a）。\n己（3 条 id=b17-a）。\n"
  assert.deepEqual(checkFactGroups(parseFacts(docs, "d.md", marks), regs, { changelogText: CL }),
    { groups: 3, multiGroups: 3, occurrences: 9 },
    "AC-6b / A9b：合法绑定 ⇒ **抽取值 == docs 侧同 id 值**（3 组各 2 处档内 ＋ 1 次绑定，全绿）")
  // —— ★ `@N` 只数「档内标记的出现次数」，**绑定出现不计入**（§5.6 · 评审 #8 的裁定）——
  try {
    checkFactGroups(parseFacts(docs, "d.md", marks),
      parseRequireFacts("b17-c@3 bind=changelog.nsN|b17-b@2|b17-a@2"), { changelogText: CL })
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("不变量②（次数）破") && e.message.includes("@3"),
      "评审 #8 的裁定：绑定侧白送一次**不进** `@N` ⇒ 档内 2 处 vs @3 ⇒ 红：" + e.message)
  }
  // —— 负控①（**绑定字形**）：`bind=` 指向**未知源 / 未知槽** ⇒ 红 ——
  for (const bad of ["b17-c@1 bind=changelog.nope", "b17-c@1 bind=git.sha", "b17-c@1 bind=changelog"]) {
    assert.throws(() => parseRequireFacts(bad), /绑定畸形/,
      "AC-6b 负控①：`" + bad + "` 必须判畸形（未知源 / 未知槽 / 缺槽）")
  }
  // —— 负控②（**缺 `@N`**）⇒ 红 ——
  assert.throws(() => parseRequireFacts("b17-c bind=changelog.nsN"), /条目畸形/,
    "AC-6b 负控②：缺 `@N` ⇒ 红（`@N` 是次数锁的承重件）")
  // —— 负控③（**同 `bind` 被两个 id 占用**）⇒ 红 ——
  assert.throws(() => parseRequireFacts("b17-c@1 bind=changelog.nsN|b17-d@1 bind=changelog.nsN"), /被两个 id 占用/,
    "AC-6b 负控③：同一条 `bind=` 被两个 id 占用 ⇒ 红（否则一个槽会被两处各抽一次，判据劈叉）")
  // —— 附加畸形（fail-closed）：空条目 · 同 id 两条声明 ——
  assert.throws(() => parseRequireFacts("b17-c@1||b17-d@1"), /空条目/, "空条目 ⇒ 红")
  assert.throws(() => parseRequireFacts("b17-c@1|b17-c@2"), /同一 id 声明了两次/, "同 id 两条声明 ⇒ 红")
  // —— 绑定侧的**失败方向**：声明了 `bind=` 而拿不到 CHANGELOG ⇒ 红（不是静默跳过）——
  try {
    checkFactGroups(parseFacts(docs, "d.md", marks), parseRequireFacts("b17-c@2 bind=changelog.nsN"), {})
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("未提供 CHANGELOG"),
      "绑定侧 fail-closed：拿不到 CHANGELOG ⇒ 红：" + e.message)
  }
  // —— 异值绑定的负控：绑定抽出的数 ≠ docs 侧 ⇒ **不变量①**红且**报出绑定出现处** ——
  try {
    checkFactGroups(parseFacts("甲（21 条 id=b17-c）。\n乙（21 条 id=b17-c）。\n", "d.md", marks),
      parseRequireFacts("b17-c@2 bind=changelog.nsN"), { changelogText: CL })
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("不变量①（组内同值）破"),
      "P-4 的机械化：docs 侧改了、CHANGELOG 侧没改 ⇒ 跨档不等 ⇒ 红：" + e.message)
    assert.ok(e.message.includes("CHANGELOG.md:"), "报错面必须含**绑定侧**的出现处：" + e.message)
  }
})


// ═══════════════ ⑨ 批 17 · FR-6 / FR-6b / exempt 的负控腿 ═══════════════
//
// 设计档：**§5.7 FR-6**（强制声明 ＋ exempt 四闸 ＋ `EXEMPT_BUDGET`）· **§5.7b FR-6b**（面级结构触发）·
// **§8.2 锚 A10 / A11 / A11b** · **§10.3 AC-8 / AC-9 / AC-9b** · 图 4（域分离）·
// **§8.2 负控表第 10/11/12/13 行**（强制声明 · exempt 四闸 · exempt 预算 · FR-6b 结构触发）。

/** 夹具加载器：**虚拟档系统**（零临时档、零 EOL 陷阱、仓内零残留——D5）。 */
const shapeLoaderOf = (map) => (p) => {
  if (!Object.prototype.hasOwnProperty.call(map, p)) throw new Error("夹具缺档：" + p)
  return map[p]
}

test("DOC-HYGIENE 批 17 负控腿 10（锚 A10 / AC-8 · FR-6）: 日期 ≥ CUTOFF 无声明 ⇒ 红；CUTOFF 前 / 非日期前缀 ⇒ 绿", () => {
  const DISK = {
    "docs/README.md": "# 登记簿\n\n| 文档 | 日期 | 主题 |\n|---|---|---|\n| x | 2026-01-01 | y |\n",
    "docs/2026-09-15-old.md": "# 陈旧批次档（CUTOFF 前）\n\n无声明。\n",
    "docs/2026-09-16-boundary.md": "# 边界日（日期 == CUTOFF）\n\n无声明。\n",
    "docs/2026-09-17-new.md": "# 新批次档\n\n无声明。\n",
    "docs/2026-09-17-ok.md": "<!-- doc-shape\nrequire-facts: b17-测试档数@2\n-->\n\n# 已声明\n",
    "docs/test-lifecycle.md": "# 台账（非日期前缀）\n\n无声明。\n",
  }
  const load = shapeLoaderOf(DISK)
  const run = (files, cutoff = SHAPE_CUTOFF) => checkDeclarationDuty(files, cutoff, SHAPE_EXEMPT_BUDGET, { loader: load })
  // —— **阴性对照**（防「边界恒红」的假绿）：CUTOFF 前 ＋ 非日期前缀 ＋ 已声明 ⇒ 零红 ——
  assert.deepEqual(run(["docs/README.md", "docs/2026-09-15-old.md", "docs/test-lifecycle.md", "docs/2026-09-17-ok.md"]),
    { scanned: 4, exempts: [] },
    "阴性对照：CUTOFF 前的批次档 / 非日期前缀的常设档 / 已声明档 ⇒ 全部绿（**存量档零触动**是 N-2 的机械面）")
  // —— 负控①：CUTOFF **当天**（`≥` 取闭区间）无声明 ⇒ 红 ——
  try {
    run(["docs/2026-09-16-boundary.md"])
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("2026-09-16-boundary.md") && e.message.includes("CUTOFF"),
      "负控①：日期 == CUTOFF 且无声明 ⇒ 红（`≥` 是闭区间）：" + e.message)
  }
  // —— 负控②：CUTOFF **之后**无声明 ⇒ 红（**不是跳过**——这就是「没有档能静默滑进开域」）——
  try {
    run(["docs/2026-09-17-new.md"])
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("无 `doc-shape` 声明"),
      "负控②：CUTOFF 后无声明 ⇒ 红（D17-4 的义务）：" + e.message)
  }
  // —— 阴性对照②（**边界绑定的是日期关系，不是档本身**）：把 CUTOFF 后移 ⇒ 同一档不再红 ——
  assert.deepEqual(run(["docs/2026-09-17-new.md"], "2026-09-18"), { scanned: 1, exempts: [] },
    "阴性对照②：CUTOFF 后移一天 ⇒ 同一份档不再红（⇒ 红的是**日期关系**，不是档名表）")
  // —— 畸形声明在义务域内 ⇒ **抛**（批 16 既有：绝不静默返空声明 ⇒ 谓词空转）——
  const badDisk = { "docs/2026-09-17-bad.md": "<!-- doc-shape\nanchors 机验锚\n-->\n\n# x\n" }
  assert.throws(() => checkDeclarationDuty(["docs/2026-09-17-bad.md"], SHAPE_CUTOFF, 2, { loader: shapeLoaderOf(badDisk) }),
    /缺冒号/, "畸形声明 ⇒ 抛（fail-closed），**不得**降级成「无声明」而被后面那条判红掩盖")
  // —— 真实仓：全绿（`docs/` 顶层每个 CUTOFF 后的批次档都已声明）——
  assert.deepEqual(checkDeclarationDuty(docsTopLevel().map((n) => "docs/" + n)), { scanned: docsTopLevel().length, exempts: [] },
    "真实仓：本批两档都已声明、全域零豁免 ⇒ FR-6 绿（**实测**，" + docsTopLevel().length + " 档）")
})

test("DOC-HYGIENE 批 17 负控腿 11（锚 A11b / AC-9b · FR-6b）: 已声明档内有 AC 形表而无 acs 键 ⇒ 红；锚形表同理；普通表 / 未声明档 ⇒ 不红", () => {
  const declBare = parseDocShape("<!-- doc-shape\nrequire-facts: b17-测试档数@2\n-->")
  assert.ok(declBare !== null && declBare.acs === null && declBare.anchors === null, "夹具声明必须可解析（否则负控跑不起来）")
  const AC_TAB = "\n### §10.3 验收标准\n\n| # | 验收标准 | 层 | 锚 |\n|---|---|---|---|\n| **AC-1** | 甲 | T2 | A1 |\n"
  const A_TAB = "\n### §8.2 机验锚\n\n| 锚 | 检索目标 | 谓词 | 期望 |\n|---|---|---|---|\n| **A1** | 甲 | 乙 | 丙 |\n"
  const PLAIN_TAB = "\n### §4 决策与理由\n\n| # | 决策 | 为什么 |\n|---|---|---|\n| **D17-1** | 甲 | 乙 |\n"
  // —— 负控①：**有 AC 形表而无 `acs` 键** ⇒ 红（「档内缩作用域」那个口的唯一堵法）——
  try {
    checkStructureDuty(AC_TAB, declBare, "ac-shape.md")
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("AC 形表") && e.message.includes("`acs` 键"),
      "负控①：有 AC 形表而无 `acs` 键 ⇒ 红：" + e.message)
  }
  // —— 负控②：**有锚形表而无 `anchors` 键** ⇒ 红 ——
  try {
    checkStructureDuty(A_TAB, declBare, "anchor-shape.md")
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("锚形表") && e.message.includes("`anchors` 键"),
      "负控②：有锚形表而无 `anchors` 键 ⇒ 红：" + e.message)
  }
  // —— 检出器自证（双向）：它**真的**分得出这两种表形 ——
  assert.equal(shapeTableShapes(AC_TAB).ac.size, 1, "检出器自证：AC 形表必须被认出")
  assert.equal(shapeTableShapes(A_TAB).anchor.size, 1, "检出器自证：锚形表必须被认出")
  // —— 阴性对照①：**普通表**（首列既非 `AC-\d+` 也非 `A\d+`）⇒ 不红 ——
  assert.deepEqual(checkStructureDuty(PLAIN_TAB, declBare, "plain.md"), { ac: new Set(), anchor: new Set() },
    "阴性对照①：普通表 ⇒ 不红（**该闸不是「凡有表就红」**）")
  // —— 阴性对照②：两键齐备 ⇒ 不红（该闸也不是恒红）——
  const declFull = parseDocShape("<!-- doc-shape\nanchors: 机验锚\nacs: 验收标准\n-->")
  assert.equal(checkStructureDuty(AC_TAB + A_TAB, declFull, "full.md").ac.size, 1, "阴性对照②：键齐备 ⇒ 不红")
  // —— 阴性对照③（**fail-open**）：**未声明档不跑**——`parseDocShape` 返 null ⇒ 调用方（`runShapeLegsOnRealDocs`）
  //    只对**进作用域的档**（`scope`）调用本闸；CHANGELOG.md 有表而未声明 ⇒ 不受本闸管 ——
  assert.equal(parseDocShape("# 无声明的一档\n\n" + AC_TAB), null, "未声明档 ⇒ 返 null ⇒ FR-6b 在它上面**不跑**（fail-open）")
  assert.equal(parseDocShape(lf(read("CHANGELOG.md"))), null, "真实证据：CHANGELOG.md（有表）未声明 ⇒ FR-6b 不跑它")
  // —— 受管面自证：真实域里**进作用域的档**各自由本闸过一遍（零红）——
  const scope = shapeReadDomain().filter((s) => s.decl !== null)
  assert.ok(scope.length >= 3, "真实域里进作用域的档 ≥3（实测 " + scope.length + "）")
  for (const s of scope) assertShapeClean(s.file + " FR-6b", () => checkStructureDuty(s.text, s.decl, s.file))
})

test("DOC-HYGIENE 批 17 负控腿 12（锚 A11 / AC-9 · FR-6）: exempt 四闸各自红 ＋ 超 `EXEMPT_BUDGET` ⇒ 红", () => {
  const DATE = "docs/2026-09-17-memo.md"
  const run = (map) => checkDeclarationDuty([DATE], SHAPE_CUTOFF, SHAPE_EXEMPT_BUDGET, { loader: shapeLoaderOf(map) })
  const memoTxt = (body) => ({ [DATE]: "<!-- doc-shape\n" + body + "\n-->\n\n# 备忘录\n" })
  // —— **阴性对照**：合法 exempt 档（独键 + 有理由 + 日期前缀档 + 档内无可数事实）⇒ 绿 ——
  const legal = run(memoTxt("mode: exempt（本档为一次性备忘录，无可数事实）"))
  assert.deepEqual(legal.exempts, [{ file: DATE, reason: "本档为一次性备忘录，无可数事实" }],
    "阴性对照：合法 exempt ⇒ 绿，并把**豁免清单（档名 + 理由）**打进返回值（收口盘点面）")
  // —— 闸 1 **独键**：与任何配置键并存 ⇒ 红 ——
  try {
    run(memoTxt("mode: exempt（理由）\nanchors: 机验锚"))
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("独键"),
      "闸 1：`mode: exempt` 与 `anchors` 并存 ⇒ 红（自相矛盾）：" + e.message)
  }
  // —— 闸 2 **必带理由** ⇒ 红 ——
  try {
    run(memoTxt("mode: exempt"))
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("缺理由"), "闸 2：exempt 无理由 ⇒ 红：" + e.message)
  }
  // —— 闸 3 **只许写在日期前缀档上** ⇒ 红 ——
  try {
    checkDeclarationDuty(["docs/NOTES.md"], SHAPE_CUTOFF, SHAPE_EXEMPT_BUDGET,
      { loader: shapeLoaderOf({ "docs/NOTES.md": "<!-- doc-shape\nmode: exempt（理由）\n-->\n\n# 常设档\n" }) })
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("非日期前缀档"), "闸 3：非日期档写 exempt ⇒ 红：" + e.message)
  }
  // —— 闸 4 **内容证伪**（两种面形**各一条**——与 FR-6b 用**同一个检测器**）——
  try {
    run({ [DATE]: "<!-- doc-shape\nmode: exempt（理由）\n-->\n\n# 备忘录\n\n本档（3 项：a · b · c）。\n" })
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("受管标记"), "闸 4①：exempt 档内长出受管标记 ⇒ 红：" + e.message)
  }
  try {
    run({ [DATE]: "<!-- doc-shape\nmode: exempt（理由）\n-->\n\n# 备忘录\n\n| # | 验收标准 | 层 | 锚 |\n|---|---|---|---|\n| **AC-1** | 甲 | T2 | A1 |\n" })
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("AC 形表或锚形表"),
      "闸 4②：exempt 档内长出 AC 形表 ⇒ 红（「有表 ⇒ 键必填」与「有表 ⇒ exempt 作废」是同一判据的两个方向）：" + e.message)
  }
  // —— `EXEMPT_BUDGET`：**全域有效豁免数 > 预算 ⇒ 红** ——
  const three = {
    "docs/2026-09-10-a.md": "<!-- doc-shape\nmode: exempt（甲）\n-->\n",
    "docs/2026-09-11-b.md": "<!-- doc-shape\nmode: exempt（乙）\n-->\n",
    "docs/2026-09-12-c.md": "<!-- doc-shape\nmode: exempt（丙）\n-->\n",
  }
  try {
    checkDeclarationDuty(Object.keys(three), SHAPE_CUTOFF, SHAPE_EXEMPT_BUDGET, { loader: shapeLoaderOf(three) })
    assert.fail("应当抛")
  } catch (e) {
    assert.ok(e instanceof ShapeViolation && e.message.includes("EXEMPT_BUDGET") && e.message.includes("3 >"),
      "预算：3 个豁免 > `EXEMPT_BUDGET` " + SHAPE_EXEMPT_BUDGET + " ⇒ 红（「白名单长一行」变成「改一个带注释的常量」）：" + e.message)
  }
  // 阴性对照③：同三档、预算抬到 3 ⇒ 绿（⇒ 红的是**预算关系**，不是 exempt 本身）
  assert.equal(checkDeclarationDuty(Object.keys(three), SHAPE_CUTOFF, 3, { loader: shapeLoaderOf(three) }).exempts.length, 3,
    "阴性对照③：预算抬到 3 ⇒ 同样三档全绿（红的是预算关系）")
})