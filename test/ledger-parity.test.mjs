// ledger-parity.test.mjs — 批 10（台账纪律·可落地版）：计数有据 + 指针不悬空 + 触发必填。
// 设计档：docs/2026-09-13-ledger-discipline-design.md
//   §6.1 机制伪代码（计数有据）· §6.1 结构性断言（指针/触发）· §6.4 吸收清单八处
//   §8.2 机验锚 M1–M5 · §9 边界（空面按红 / 跳空行 / 行号不机检 / 指针侧耦合律刻意不机检）
//   §11.2 AC-L1…AC-L4 · AC-P1…AC-P3
//
// ★ 本档的纪律（D10-2）：**测试源内不出现任何计数数字字面量**（两份文档自报的那两个两位数
//   及其历史错值，全禁——本档
//   自证见 T-LP3 的末段，用字符类拼装形态，故断言自身也不会引入被禁字面）。
//   期望值（文档自报句）与实算值（表体数据行）**两侧都从文档字节读**：想放水就得改文档，
//   而改文档会立刻被另一边抓住。纪律原文范本 = `test/test-lifecycle.test.mjs` 的格言
//   「档名列与用例数列是**被测事实**，绝不拿来当**别的断言**的期望值」。
//
// ★ 空面按红（D10-3）：实算 0 行 / 自报句解析不到 ⇒ **抛**（红），绝不 `0 == 0` 静默通过。
//   先例 = `release-check.mjs` 的 `gateG0`「扫描面为空 = 假绿」同律。
//
// ★ 刻意排除（D10-1 / 纪要 §2-①，明示、防下批误认为遗漏）：
//   ① **交接页 §4** 不在覆盖面内——它是 `release-check.mjs` G7 的 **MANUAL 人眼闸**
//      （评审 #3 的正式收窄：活页、编号会漂、无机器契约），本批不翻案；
//   ② **行号不机检**（D10-4：行号是位置提示不是身份，上方插入即漂 ⇒ 锁它 = 制造必然噪声）；
//   ③ **指针侧的耦合律不机检**（设计 §9-11：只机检「可解析且文件存在 或 恰为 `—`」与触发侧
//      不变式；「已定位 ⇒ 指针必填」「已修 ⇒ 指针 = CHANGELOG 版本锚」属内容补全，另立批次）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(TEST_DIR, "..")
/** 被测文档（期望值的唯一住所）。 */
const REGISTRY = join(PLUGIN_DIR, "docs", "2026-09-05-defect-registry.md")
const INVENTORY = join(PLUGIN_DIR, "docs", "2026-09-12-absorption-inventory.md")

/** 缺陷登记表小节标题（机验入口；改标题即让 T-LP1 红——刻意如此）。 */
const H_REGISTRY_TABLE = "## 登记表"
/** 吸收清单 §2 全量对照表小节标题。 */
const H_INVENTORY_TABLE = "## §2 全量对照表"

/** 登记表的「状态」列值域：终态四值（设计 §6.1 既定；非终态行必须有触发字段）。 */
const TERMINAL_STATUS_RE = /已修|不立项|已驳回|已交付/
/** 触发字段的**闭合四值**（J10-3）：`批 N` / `条件：<可判定谓词>` / `永不（理由）` / `—`（已闭环）。 */
const TRIGGER_RE = /^(?:批\s*\d+|条件：\S.*|永不（.+）|—（已闭环）)$/

// ————————————— 基础谓词（fs 字节读取，无第二份期望值） —————————————

const linesOf = (md) => md.split(/\r?\n/)
/** 表行：允许行首缩进（markdown 表格可缩进 ≤3 空格）——自证见 T-LP3 的缩进样例。 */
const isTableLine = (l) => /^\s*\|/.test(l)
const isBlank = (l) => l.trim() === ""
/** 分隔线形态：去掉 `|`/空白/`:`/`-` 之后为空。 */
const isSeparator = (l) => isTableLine(l) && l.replace(/[|\s:-]/g, "") === ""
/** 表行 → 单元格：只认**未转义**的 `|`（表格里的字面 `|` 必须写作 `\|`，否则整行错位）。 */
const cellsOf = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim())

/** 指针列的**词法**（设计 §9-3 / §6.1；纪要 §2-②）：`—` | `<仓库相对路径>[:<行号>]` |
 *  `docs/<档>.md[ §<n>]` | `CHANGELOG [x.y.z]`。**行号可选且不机检**（D10-4：行号是位置提示不是
 *  身份，上方插入即漂 ⇒ 锁它 = 制造必然噪声）。返回目标文件（仓库相对路径）或 null（未定位）；
 *  **形态不可解析 ⇒ 抛**（防「写一句话当指针」——不可解析的指针列比没有更糟）。 */
const POINTER_PATH_RE = /^([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)(?::\d+)?(?:\s*§\s*[0-9.]+)?$/
const CHANGELOG_POINTER_RE = /^CHANGELOG\s*\[[^\]\s]+\]$/
function pointerTarget(cell) {
  const c = String(cell ?? "").trim()
  if (c === "—") return null
  if (CHANGELOG_POINTER_RE.test(c)) return "CHANGELOG.md"
  const m = POINTER_PATH_RE.exec(c)
  if (!m) throw new Error("指针列形态不可解析：" + JSON.stringify(c))
  if (!/\.[A-Za-z0-9]+$/.test(m[1])) throw new Error("指针列必须指向带扩展名的文件：" + JSON.stringify(c))
  return m[1]
}

/**
 * 小节标题之后**首个表格**的表体数据行（原始行数组）。谓词（正负对照自证见 T-LP3）：
 *   - 表头行（首个 `|` 行）与分隔线**不计**；
 *   - 表体中间的空行**跳过**（登记表体里就有一个空行——设计 §9-2）；
 *   - 首个**非表行**（不以 `|` 开头且非空）**终止扫描** ⇒ 表后的正文/下一个标题不会被计入；
 *   - 「找不到标题 / 找不到表格 / 缺分隔线 / 数据行为 0」一律**抛**（空面按红，绝不返回 0）。
 * @param {string} md 文档字节
 * @param {string} heading 小节标题前缀
 * @returns {string[]}
 */
function tableRowsAfter(md, heading) {
  const lines = linesOf(md)
  const i = lines.findIndex((l) => l.startsWith(heading))
  if (i < 0) throw new Error("找不到小节标题：" + heading)
  let head = -1
  for (let j = i + 1; j < lines.length; j++) {
    if (isBlank(lines[j])) continue
    if (isTableLine(lines[j])) { head = j; break }
  }
  if (head < 0) throw new Error("小节内找不到表格（空面按红）：" + heading)
  if (!isSeparator(lines[head + 1] ?? "")) throw new Error("表格缺少分隔线：" + heading)
  const rows = []
  for (let j = head + 2; j < lines.length; j++) {
    const l = lines[j]
    if (isBlank(l)) continue
    if (!isTableLine(l)) break
    rows.push(l)
  }
  if (rows.length === 0) throw new Error("表格无数据行（空面按红）：" + heading)
  return rows
}

/**
 * 解析文档的**自报计数**（句式锚）。R-19：自报计数一律**单点**——出现 0 处或 >1 处都**抛**
 * （解析不到 ⇒ 红，绝不返回 0；多处 ⇒ 未归一 ⇒ 红）。
 * @param {string} md 文档字节
 * @param {RegExp} re 句式锚（须带捕获组 1 = 数字）
 * @returns {number}
 */
function parseSelfReported(md, re) {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g"
  const hits = [...md.matchAll(new RegExp(re.source, flags))]
  if (hits.length === 0) throw new Error("自报计数句解析不到（空面按红）：" + re)
  if (hits.length > 1) throw new Error("自报计数句出现 " + hits.length + " 处（未归一为单点）：" + re)
  return Number(hits[0][1])
}

// ————————————— M1：计数有据（机械行数 == 文档自报计数） —————————————

test("T-LP1 (AC-L1 / 锚 M1): 缺陷登记表的自报条数 == 机械数出的表体数据行", () => {
  const md = readFileSync(REGISTRY, "utf8")
  const rows = tableRowsAfter(md, H_REGISTRY_TABLE)
  const self = parseSelfReported(md, /本表登记\s*\**(\d+)\**\s*条/)
  assert.equal(self, rows.length,
    "自报条数 " + self + " != 机械行数 " + rows.length
    + "——改文档不改自报 / 改自报不改文档，两者都会红")
})

test("T-LP2 (AC-L1 / 锚 M1): 吸收清单 §2 的自报档数 == 机械行数（归一为单一权威句）", () => {
  const md = readFileSync(INVENTORY, "utf8")
  const rows = tableRowsAfter(md, H_INVENTORY_TABLE)
  // 归一后的唯一权威句形态 = `共 N 档`（设计 §6.1 钉死）；>1 处即未归一 ⇒ parseSelfReported 抛。
  const self = parseSelfReported(md, /共\s*(\d+)\s*档/)
  assert.equal(self, rows.length,
    "自报档数 " + self + " != 机械行数 " + rows.length
    + "——吸收清单的自报句必须与 §2 表体行数一致（单点自报，他处用指针句式）")
})

// ————————————— M2/M3：谓词自证（防空面假绿 + 反恒真） —————————————

test("T-LP3 (AC-L3/AC-L4 / 锚 M2+M3+M1): 计数器能区分真数据行 vs 表头/分隔线/空行；空面与解析失败按红；本档零计数字面量", () => {
  // —— 正负对照：表头 / 分隔线 / 表体空行 / 表后正文与表后另一张表，**都不得计入** ——
  const sample = [
    "## 表",
    "",
    "| A | B |",
    "|---|---|",
    "| r1 | x |",
    "",
    "| r2 | y |",
    "| r3 | z |",
    "",
    "表后正文（非表行 ⇒ 终止扫描）",
    "| r9 | w |",
    "",
  ].join("\n")
  assert.equal(tableRowsAfter(sample, "## 表").length, 3,
    "谓词自证：只有 3 行真数据行（表头/分隔线/空行/表后行均不计）")

  // 谓词自证②：行首缩进的表行仍是表行；`|` 出现在正文句首才算表行
  const indented = ["## 表", "  | A |", "  |---|", "  | r1 |", "  | r2 |", "正文"].join("\n")
  assert.equal(tableRowsAfter(indented, "## 表").length, 2, "谓词自证：缩进表行照常计入")

  // —— 空面按红（AC-L3）：零数据行 / 无表格 / 无标题 一律抛 ——
  assert.throws(() => tableRowsAfter("## 表\n\n| A |\n|---|\n\n正文\n", "## 表"),
    /无数据行/, "空面按红：只有表头+分隔线（零数据行）必须抛，不许 0 行静默通过")
  assert.throws(() => tableRowsAfter("## 表\n\n没有表格\n", "## 表"), /找不到表格/, "无表格 ⇒ 抛")
  assert.throws(() => tableRowsAfter("| A |\n|---|\n| r |\n", "## 别的标题"), /找不到小节标题/, "无标题 ⇒ 抛")

  // —— 自报句解析失败 ⇒ 抛（不得返回 0）——
  assert.throws(() => parseSelfReported("这句话里没有自报计数。", /本表登记\s*\**(\d+)\**\s*条/),
    /解析不到/, "自报句解析不到 ⇒ 抛（AC-L3）")
  assert.throws(() => parseSelfReported("本表登记 7 条。\n本表登记 9 条。", /本表登记\s*\**(\d+)\**\s*条/),
    /未归一为单点/, "自报句多处 ⇒ 抛（R-19：自报计数单点）")
  assert.equal(parseSelfReported("本表登记 **7** 条。", /本表登记\s*\**(\d+)\**\s*条/), 7,
    "谓词自证：加粗形态照常解析（不是恒抛）")

  // —— AC-L2 自证：本档源码内**不出现任何计数数字字面量** ——
  // 被禁集合 = 两份文档自报的那两个两位数 + 各自的历史错值。**用十进制字符码拼装**：
  // 直接写出这些两位数，会让本断言（以及「可 grep 自验」）自己踩中自己。
  const twoDigit = (...codes) => codes.map((c) => String.fromCharCode(c)).join("")
  const FORBIDDEN_COUNT_LITERALS = [
    twoDigit(51, 51), twoDigit(51, 54), // 登记表：历史错值 / 当前值
    twoDigit(52, 50), twoDigit(52, 51), // 吸收清单：当前值 / 历史错值
  ]
  const COUNT_LITERAL_RE = new RegExp("(?:^|\\D)(?:" + FORBIDDEN_COUNT_LITERALS.join("|") + ")(?:\\D|$)")
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8")
  assert.ok(!COUNT_LITERAL_RE.test(self),
    "本档源码内不得出现计数数字字面量（AC-L2 / N-3）：期望值住在文档里，实算值从文档字节读")
})

// ————————————— M4/M5：两条结构性断言（用户裁定 J10-11 = 加；AC-P1/AC-P2/AC-P3） —————————————

test("T-LP4 (AC-P1 / 锚 M4): 登记表每行的**指针列** ∈ {可解析且文件存在, —}", () => {
  const rows = tableRowsAfter(readFileSync(REGISTRY, "utf8"), H_REGISTRY_TABLE)
  const all = rows.map(cellsOf)
  const badShape = all.filter((c) => c.length !== 9)
  assert.deepEqual(badShape.map((c) => c[0]), [],
    "登记表每行必须是 9 列（ID…状态 + 指针 + 触发）——实得列数：" + JSON.stringify(all.map((c) => c.length)))

  const missing = []
  let located = 0
  for (const c of all) {
    const file = pointerTarget(c[7]) // 形态不可解析 ⇒ 抛（形态锁）
    if (file === null) continue
    located += 1
    if (!existsSync(join(PLUGIN_DIR, file))) missing.push(c[0] + " → " + file)
  }
  assert.deepEqual(missing, [], "指针列指向的文件必须在本仓存在（指针不悬空）")
  // 空面按红：整列都是 `—` = 等于没加列（假绿防线）
  assert.ok(located > 0, "指针列不得整列为「—」（那等于没加这一列）——实测非「—」条数 = " + located)
})

/** 单行触发列的违规集（T-LP5 的谓词本体；抽成纯函数以便对**合成行**自证）。
 *  ★ 批 10 分歧审计 #6：此处原有**第二条腿**——「非终态行的触发列不得为裸 `—`」。它
 *  **永不独立触发**：裸 `—` 已被上面的闭合四值谓词（`TRIGGER_RE` 不含裸 `—`）拦下 ⇒
 *  任何能让内层腿成立的行**同时必满足**上一条 ⇒ 它只是**重复的第二条消息**（present-but-inert
 *  的锁，正是本批要抓的那个物种，且就长在本批自己的锁里）。
 *  **改成「可达」不可行**：要让它独立成立，就得让闭合四值谓词放行裸 `—` —— 那是**削弱**
 *  有效谓词（AC-P2 / 锚 M5 要求「**所有**行必须命中闭合四值」）⇒ 按审计给的第二个选项
 *  **删除该腿**，判定结果**逐行零变化**（被删掉的只是重复消息）。
 *  该腿的原意（非终态行不得写成裸 `—`）由闭合四值谓词**整体蕴含**；该蕴含关系由 T-LP5
 *  末尾的**合成行自证**与既有自证段（`!TRIGGER_RE.test("—")`）活着证明。 */
function triggerViolations(c) {
  const [id, , , , , , status, , trigger] = c
  const out = []
  if (!TRIGGER_RE.test(String(trigger ?? "").trim())) {
    out.push(id + " 触发值不在闭合四值内：" + JSON.stringify(trigger))
  }
  if (/待修/.test(String(status ?? "")) && /^永不（/.test(String(trigger ?? "").trim())) {
    out.push(id + " 状态 `待修` 却写触发「永不」= 自相矛盾")
  }
  return out
}

test("T-LP5 (AC-P2 / 锚 M5): 触发列命中**闭合四值**；非终态行必有触发；`待修` 行不得 `永不`", () => {
  const rows = tableRowsAfter(readFileSync(REGISTRY, "utf8"), H_REGISTRY_TABLE)
  const bad = rows.map(cellsOf).flatMap(triggerViolations)
  assert.deepEqual(bad, [], "触发列违规：" + bad.join(" | "))

  // —— 谓词自证（律 3）：终态判据与闭合四值判据都**不是恒真/恒假** ——
  assert.ok(TERMINAL_STATUS_RE.test("**已修**（批 10）"), "自证：已修 ⇒ 终态")
  assert.ok(TERMINAL_STATUS_RE.test("已驳回（US-3 改为回归测试钉死该平台保证）"), "自证：已驳回 ⇒ 终态")
  assert.ok(!TERMINAL_STATUS_RE.test("—") && !TERMINAL_STATUS_RE.test("待修（本批未动）"), "自证：待修/— ⇒ 非终态")
  for (const v of ["批 11", "条件：条目量使人工巡检失效", "永不（号段保留）", "—（已闭环）"]) {
    assert.ok(TRIGGER_RE.test(v), "自证：闭合四值应当命中 —— " + v)
  }
  for (const v of ["等等看", "—", "", "以后再说"]) {
    assert.ok(!TRIGGER_RE.test(v), "自证：散文/裸破折号不得当触发 —— " + JSON.stringify(v))
  }

  // —— 合成行自证（**分歧审计 #6 的替代腿**）：构造「非终态 + 裸 `—` 触发」的 fixture 行 ——
  //    被删掉的内层腿断言的就是这个形态。这里用**合成行**把它重新钉成活锁：该形态**照样**
  //    进违规集（由闭合四值谓词蕴含）⇒ 「删掉内层腿」不等于「没人管这个形态」。
  //    锁是活的：若把闭合四值谓词放宽到放行裸 `—`，本条与上面那圈自证**同时**转红。
  for (const st of ["—", "待修（本批未动）"]) {
    const synth = ["D-XX", "主题", "现象", "根因状态", "🔵", "轮次", st, "lib/eng.mjs", "—"]
    const v = triggerViolations(synth)
    assert.ok(v.length > 0, "合成行自证：非终态（" + st + "）+ 裸 `—` 触发**必须**判违规"
      + "（该形态的约束由闭合四值谓词承担，不因删除内层腿而漏）——实得 " + JSON.stringify(v))
  }
  // 反向对照（防「恒真」）：同一合成行把触发换成合规值 ⇒ 违规集**必须为空**
  for (const good of ["批 11", "条件：条目量使人工巡检失效", "永不（号段保留）", "—（已闭环）"]) {
    assert.deepEqual(triggerViolations(["D-XX", "主题", "现象", "根因状态", "🔵", "轮次", "—", "lib/eng.mjs", good]), [],
      "合成行自证（负向）：合规触发不得被误判 —— " + good)
  }
})

test("T-LP6 (AC-P3 / 设计 §6.4-6a): 吸收清单 §2 的**触发列**逐行填充且命中闭合四值；不加指针列（D10-6）", () => {
  const md = readFileSync(INVENTORY, "utf8")
  const rows = tableRowsAfter(md, H_INVENTORY_TABLE)
  const all = rows.map(cellsOf)
  const badShape = all.filter((c) => c.length !== 7)
  assert.deepEqual(badShape.map((c) => c[0]), [],
    "§2 每行必须是 7 列（批次档…建议批次 + 触发 + 价值）——实得：" + JSON.stringify(all.map((c) => c.length)))
  const bad = []
  for (const c of all) if (!TRIGGER_RE.test(c[5])) bad.push(c[0] + " → " + JSON.stringify(c[5]))
  assert.deepEqual(bad, [], "§2 触发列必须逐行命中闭合四值：" + bad.join(" | "))
  // D10-6：§2 **不加指针列**（其指针指向上游批次档 `D:\workspace\thincoder\...`，本地不可验）
  const headerLine = linesOf(md).find((l) => l.startsWith("| 批次档 |"))
  assert.ok(headerLine, "§2 表头行可定位")
  assert.ok(!cellsOf(headerLine).some((h) => h.includes("指针")),
    "§2 不得出现指针列（D10-6）：表头 = " + headerLine)
})
