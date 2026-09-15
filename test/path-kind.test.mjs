// path-kind.test.mjs — 批 7（可移植性三件）新增测试档。
// 设计档：docs/2026-09-13-portability-design.md
//   §6.1 判据单一权威伪代码 · §6.4 两个注入器三态 · §6.7 配置面
//   §10.3 真值表（AC-P8）· §8.2 机验锚 B1…B11
// J9（用户 2026-09-13 裁定）：本档在 test/guard-e.test.mjs 的 T-E19 清单中按**登记制**登记一行。
// 纪律：零网络、零真实 LLM；仅读源码 + 调纯函数（隔离同既有档：DSH_HOME 置空）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve, relative } from "node:path"
import { tmpdir } from "node:os"
import { DOC_EXT_RE, isDocPath, isProductCodePath } from "../lib/path-kind.mjs"
import { isProductCode, makeWriteGate } from "../lib/eng.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
import { buildAdvisorUserMessage } from "../lib/advisor-msgs.mjs"
// 批 7 分歧审计 #2：面 ①/③ 的**服务端面**直接调用（不写盘、不启服务）——AC-P12/P12b/P12c。
import { validateGlobalUserConfig } from "../lib/index.mjs"
import { mergeGlobalConfig } from "../lib/config-store.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const LIB_DIR = join(PLUGIN_DIR, "lib")
process.env.DSH_HOME = ""

/** 取 src 中 [startMarker, endMarker) 切片（endMarker 缺省 = 文件尾）——源码级锁的统一定位工具。 */
function srcSlice(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker)
  assert.ok(a >= 0, "切片起点可定位: " + startMarker)
  const b = endMarker === undefined ? src.length : src.indexOf(endMarker, a)
  assert.ok(b > a, "切片终点可定位: " + String(endMarker))
  return src.slice(a, b)
}

// ═══════════════════════ §10.3 真值表（AC-P8 / 锚 B10） ═══════════════════════
// 11 行 = §10.3 表格逐行；行内含多路径者逐路径断言。行内口径：
//   doc     = isDocPath 期望值
//   product = isProductCodePath 期望值（缺省 = !doc；空/白两行**显式双否**）
// 与今日差异：src/README.md（门禁拦 → 放行）· "  "（今日拦 → 放行）——本批唯一两处行为变化。

const TRUTH_TABLE = [
  { label: "docs/x.md / docs/x.mjs", paths: ["docs/x.md", "docs/x.mjs"], doc: true },
  { label: "src/a.mjs（陷阱对照组）", paths: ["src/a.mjs"], doc: false },
  { label: "lib/a.mjs（陷阱对照组）", paths: ["lib/a.mjs"], doc: false },
  { label: "packages/app/src/a.mjs（嵌套对照组）", paths: ["packages/app/src/a.mjs"], doc: false },
  { label: "test/x.mjs", paths: ["test/x.mjs"], doc: false },
  { label: "根 README.md / CHANGELOG.md", paths: ["README.md", "CHANGELOG.md"], doc: true },
  { label: "package.json", paths: ["package.json"], doc: false },
  { label: "LICENSE（无扩展名）", paths: ["LICENSE"], doc: false },
  { label: "src/README.md（本批唯一分类变化）", paths: ["src/README.md"], doc: true },
  { label: "空串", paths: [""], doc: false, product: false, doubleFalse: true },
  { label: "纯空白串", paths: ["  "], doc: false, product: false, doubleFalse: true },
]

test("T-PK1 (AC-P8, 锚 B10): §10.3 真值表 11 行——两谓词逐路径断言，空/白两行显式双否", () => {
  assert.equal(TRUTH_TABLE.length, 11, "真值表 = §10.3 的 11 行（行内多路径者逐路径断言）")
  let pathCount = 0
  for (const row of TRUTH_TABLE) {
    for (const p of row.paths) {
      pathCount++
      assert.equal(isDocPath(p), row.doc, "isDocPath(" + JSON.stringify(p) + ") —— " + row.label)
      const wantProduct = row.product !== undefined ? row.product : !row.doc
      assert.equal(isProductCodePath(p), wantProduct, "isProductCodePath(" + JSON.stringify(p) + ") —— " + row.label)
      if (row.doubleFalse) {
        assert.equal(isDocPath(p), false, "锚 B10 双否（isDocPath）: " + JSON.stringify(p))
        assert.equal(isProductCodePath(p), false, "锚 B10 双否（isProductCodePath）: " + JSON.stringify(p))
      }
    }
  }
  assert.equal(pathCount, 13, "11 行展开为 13 条路径断言")
})

test("T-PK2 (N-3): DOC_EXT_RE 唯一字面量；归一与规则边界逐条锁定", () => {
  // 反斜杠归一 → 视同 "/"（对齐 doc-hash.normalizeDocPath 既有裁定 G-4）
  assert.equal(isDocPath("docs\\x.md"), true, "反斜杠归一后命中 docs/ 前缀")
  assert.equal(isDocPath("lib\\a.mjs"), false, "反斜杠归一后仍判产品代码")
  assert.equal(isProductCodePath("lib\\a.mjs"), true)
  // 大小写不折叠（G-4：归一不做大小写折叠）；仅扩展名正则自带 /i
  // 前缀分支大小写敏感：用**非文档扩展名**探测（"Docs/x.md" 会被扩展名分支接住，探不出前缀口径）
  assert.equal(isDocPath("Docs/x.mjs"), false, "docs/ 前缀大小写敏感（不做大小写折叠）")
  assert.equal(isDocPath("DOCS/x.mjs"), false, "同上（大写前缀）")
  assert.equal(isDocPath("lib/A.MD"), true, "扩展名正则 /i —— 大写扩展名命中")
  // 任意目录任意深度的文档扩展名
  assert.equal(isDocPath("a/b/c/notes.txt"), true)
  assert.equal(isDocPath(".thincoder/advisor.md"), true)
  // 非字符串入参按 §6.1 伪代码 `String(p ?? "")` 强制转换：nullish/空数组 → 空串 → 双双 false
  for (const bad of [undefined, null, []]) {
    assert.equal(isDocPath(bad), false, "isDocPath(空/畸形) = false: " + String(bad))
    assert.equal(isProductCodePath(bad), false, "isProductCodePath(空/畸形) = false: " + String(bad))
  }
  // 非 nullish 的非字符串走 String() 转换（不是「畸形」——伪代码只对 nullish 落空串）
  assert.equal(isProductCodePath(0), true, "0 → \"0\"（非空、非文档 ⇒ 产品代码）")
  // 补集关系（非空输入下恒成立）
  for (const p of ["docs/x.md", "src/a.mjs", "README.md", "package.json", "src/README.md"]) {
    assert.equal(isProductCodePath(p), !isDocPath(p), "补集派生: " + p)
  }
  // DOC_EXT_RE 唯一字面量（锚 B3 的字面面；单一权威 = lib/path-kind.mjs）
  const src = readFileSync(join(LIB_DIR, "path-kind.mjs"), "utf8")
  const literal = src.match(/\/\\\.\(md\|markdown\|mdx\|txt\|rst\|adoc\)\$/gi) ?? []
  assert.equal(literal.length, 1, "文档扩展名正则字面在 path-kind.mjs 内恰好一处")
  assert.ok(DOC_EXT_RE.test("x.md") && !DOC_EXT_RE.test("x.mjs"), "DOC_EXT_RE 行为可用")
})

// ═══════════ §10.3 真值表「写门禁」列 + 锚 B4（AC-P8 / AC-P11 / D-P11 陷阱守卫） ═══════════
// 写门禁端到端：真实 makeWriteGate（eng.mjs 导出、函数体**可执行行逐字节**冻结）+ 真 state（eng ON、无令牌）。
// 判决口径：`await next()` ⇒ 放行；返回 { kind:"deny" } ⇒ 拦。

const GATE_SID = "pk7-gate-" + randomUUID()
const GATE_AGENT = { session: { id: GATE_SID, header: { cwd: PLUGIN_DIR, delegationDepth: 0 } } }

/** 写门禁端到端判决（"pass" | "deny"）。eng ON + 无 designToken ⇒ 产品代码必拦。 */
async function gateVerdict(target) {
  const st = sessionState(GATE_SID)
  st.engineering = true
  st.designToken = null
  const gate = makeWriteGate(() => true)
  const out = await gate({ name: "write", arguments: { file_path: target }, agent: GATE_AGENT }, async () => "NEXT")
  if (out === "NEXT") return "pass"
  if (out && out.kind === "deny") return "deny"
  return "unexpected:" + JSON.stringify(out)
}

test("T-PK7 (AC-P8 写门禁列, AC-P11, 边界 7): 真值表逐路径过真实写门禁——陷阱/嵌套对照组真阳性不丢", async () => {
  try {
    const seen = []
    for (const row of TRUTH_TABLE) {
      for (const p of row.paths) {
        seen.push(p)
        // 文档 ⇒ 放行；产品代码 ⇒ 拦（空/白两行走 !target 短路或双否谓词，均放行）
        const want = row.doc || row.doubleFalse ? "pass" : "deny"
        const got = await gateVerdict(p)
        assert.equal(got, want, "写门禁(" + JSON.stringify(p) + ") —— " + row.label)
      }
    }
    // D-P11 陷阱回归守卫：删掉根 src/ 锚**不得**收紧兜底 ⇒ 嵌套布局真阳性仍然拦
    for (const p of ["lib/a.mjs", "packages/app/src/a.mjs", "test/x.mjs", "src/a.mjs"]) {
      assert.equal(await gateVerdict(p), "deny", "陷阱对照组仍判产品代码: " + p)
    }
    // 本批唯一分类变化：src/ 下的**文档扩展名**文件从「拦」翻成「放行」
    assert.equal(await gateVerdict("src/README.md"), "pass", "src/**/*.md 重分类为文档（D-P11/J6）")
    assert.equal(seen.length, 13, "13 条路径全部过门禁")
  } finally { dropSession(GATE_SID) }
})

test("T-PK8 (锚 B4, AC-P10): eng.mjs 仍持有 isProductCode 绑定；子问题无第二套规则体", () => {
  // D-P14：guard-e.test.mjs 的 WRITE_GATE_FIXTURE（批 12 起 = **可执行行逐字节**，注释层不入锁）
  // 锁着 makeWriteGate 函数体的可执行行，
  // 其中 `isProductCode(target)` 行要求 eng.mjs **文件内**仍有可解析的 isProductCode 绑定。
  // ★ 共用终点标记（glm 的 N1 / 设计档 §9 边界-5）：本档下方 srcSlice 的右界标记与 guard-e 的 A2
  //   **是同一个字面** `"\n\n/**\n * 守卫 E 预闸"` ⇒ **标记一动，两处同红**（本档锚 B4 + guard-e 的 A2 边界断言）。
  const engSrc = readFileSync(join(LIB_DIR, "eng.mjs"), "utf8")
  // ★ 批 10（D-36）：切片起点由 `makeWriteGate(getConfigDefault) {` 改为**不带签名**的
  //   `makeWriteGate(`——该函数新增了**可选**第二参 `storPathOverride`（测试缝，向后兼容）。
  //   锚断言的是**函数体内**的绑定与调用行，签名不参与锚（写死签名会让合法扩参时定位失败）。
  const wg = srcSlice(engSrc, "export function makeWriteGate(", "\n\n/**\n * 守卫 E 预闸")
  assert.ok(wg.includes("if (!target || !isProductCode(target)) return await next()"),
    "锚 B4: makeWriteGate 切片内 isProductCode(target) 调用行逐字存在")
  assert.ok(engSrc.includes("export function isProductCode(p) {"),
    "锚 B4: eng.mjs 仍导出 isProductCode（薄转发）")
  assert.match(engSrc, /import \{ isProductCodePath \} from "\.\/path-kind\.mjs"/,
    "薄转发指向单一权威")
  // 转发函数体不得再长出自有规则（无第二套规则体：无 startsWith / 无扩展名正则 / 无锚）
  const body = srcSlice(engSrc, "export function isProductCode(p) {", "\n}")
  assert.ok(!body.includes("startsWith") && !body.includes("test(") && !body.includes("\\."),
    "转发体零规则字面（纯补集派生）: " + body.trim())
  // wrapper 与权威同判（抽样）
  for (const p of ["docs/x.md", "src/a.mjs", "src/README.md", "lib/a.mjs", "  ", ""]) {
    assert.equal(isProductCode(p), isProductCodePath(p), "wrapper 与权威同判: " + JSON.stringify(p))
  }
})

// ═══════════════ 注入器三态（AC-P3 / P3b / P3c / P5 / P6 / P7 / 锚 B5 · B6） ═══════════════

const STD_TEXT = "# Standards\n\nRule 1: keep the design thin.\n"
/** 未声明标准文档的降级句（§6.4 逐字）。 */
const NO_STANDARDS_SENTENCE = "(No project standards document declared — set advisor.standardsDoc to the project's standards file to have it evaluated. Until then, review against the documents list and general engineering practice. Do not attempt to locate or read any standards file on disk — the review scope is exactly the files listed above.)"
/** 未声明文档地图的降级句（§6.4 逐字；与上一句**逐字不同**）。 */
const NO_MAP_SENTENCE = "(No document map declared — set advisor.documentMapDoc to the project's document map file to have it used for the Document ownership criterion. Until then, judge ownership from the documents list. Do not attempt to locate or read any document map on disk — the review scope is exactly the files listed above.)"

function advisorMsg(overrides) {
  return buildAdvisorUserMessage({
    cwd: overrides.cwd, history: [], state: { advisorRound: 0 }, reviewType: overrides.reviewType ?? "design",
    designToken: null, documents: ["docs/x.md"], paths: [], includeProjectGuide: false,
    ...overrides,
  })
}

test("T-PK9 (AC-P3/P5/P6/P7, 锚 B5/B6): 标准段三态显式可区分；声明即注入（与模式标志无关）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk7-inj-"))
  try {
    writeFileSync(join(dir, "standards.md"), STD_TEXT)
    // 态 ① 声明且可读 —— 段名 + 声明说明句 + 全文（≤16384 字符时）
    const ok = advisorMsg({ cwd: dir, standardsDoc: "standards.md" })
    assert.ok(ok.includes("\n## Project Standards\n"), "态① 段名")
    assert.ok(ok.includes("The project declares the following standards document."), "态① 声明说明句")
    assert.ok(ok.includes("Rule 1: keep the design thin."), "态① 文件全文（≤16384 字符时逐字进上下文）")
    assert.ok(!ok.includes(NO_STANDARDS_SENTENCE), "态① 不带降级句")
    // 态 ② 声明但不可读 —— 与态 ③ 可区分，且点名配置键
    const unreadable = advisorMsg({ cwd: dir, standardsDoc: "missing.md" })
    assert.ok(unreadable.includes("(Declared project standards document 'missing.md' could not be read — check the advisor.standardsDoc setting. Proceeding without it.)"),
      "态② 响亮句 + 点名 advisor.standardsDoc")
    assert.ok(!unreadable.includes("## Project Standards\n"), "态② 无正文段")
    assert.ok(!unreadable.includes(NO_STANDARDS_SENTENCE), "态② 与态③ 可区分（不是同一句）")
    // 态 ③ 未声明 —— 逐字降级句 + 明说不得自行找文件；且该句不含被退役的词（评审 #3）
    const undeclared = advisorMsg({ cwd: dir })
    assert.ok(undeclared.includes(NO_STANDARDS_SENTENCE), "态③ 逐字降级句")
    assert.ok(undeclared.includes("Do not attempt to locate or read any standards file on disk"), "态③ 禁止自行去磁盘找")
    assert.ok(!NO_STANDARDS_SENTENCE.toLowerCase().includes("methodology"), "态③ 降级句不含被退役的词（否则自伤 AC-P1/B1）")
    // 三态标志串互不相同（锚 B5）
    const markers = ["## Project Standards", "(Declared project standards document", NO_STANDARDS_SENTENCE]
    assert.equal(new Set(markers).size, 3, "锚 B5: 标准段三态标志串互不相同")
    // AC-P7：模式标志 OFF + 已声明 ⇒ 仍注入（旧行为是「静默压制」）
    const engOff = advisorMsg({ cwd: dir, standardsDoc: "standards.md", engineering: false })
    assert.ok(engOff.includes("Rule 1: keep the design thin."), "AC-P7: engineering=false 时**照常注入**")
    // code round 1 同构（§12.2 第 2 项：同段名、同三态）
    const codeOk = advisorMsg({ cwd: dir, standardsDoc: "standards.md", reviewType: "code" })
    assert.ok(codeOk.includes("\n## Project Standards\n"), "code round1 同段名")
    const codeNone = advisorMsg({ cwd: dir, reviewType: "code" })
    assert.ok(codeNone.includes(NO_STANDARDS_SENTENCE), "code round1 同降级句")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("T-PK10 (AC-P3b, D-P8/J12): 超 16384 字符的标准文档 ⇒ 截断于 16384 且带标记串", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk7-trunc-"))
  try {
    const big = "A".repeat(16384) + "TAIL-BEYOND-BUDGET"
    writeFileSync(join(dir, "big.md"), big)
    const msg = advisorMsg({ cwd: dir, standardsDoc: "big.md" })
    assert.ok(msg.includes("…(truncated at 16384 chars"), "标记串在场")
    assert.ok(!msg.includes("TAIL-BEYOND-BUDGET"), "超出预算的尾部**不得**进上下文（评审按半份标准放行的隐患）")
    // 边界：恰好 16384 字符 ⇒ 不截断（无标记串）
    writeFileSync(join(dir, "exact.md"), "B".repeat(16384))
    const exact = advisorMsg({ cwd: dir, standardsDoc: "exact.md" })
    assert.ok(!exact.includes("…(truncated at"), "恰 16384 字符不截断")
    // 边界 +1 ⇒ 截断
    writeFileSync(join(dir, "over.md"), "C".repeat(16385))
    assert.ok(advisorMsg({ cwd: dir, standardsDoc: "over.md" }).includes("…(truncated at 16384 chars"),
      "16385 字符 ⇒ 截断（边界 +1）")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("T-PK11 (AC-P3c, J8): 文档地图三态——仅 design round1 注入；未声明/不可读各自可区分", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk7-map-"))
  try {
    writeFileSync(join(dir, "map.md"), "# Map\n\n| section | doc |\n")
    writeFileSync(join(dir, "standards.md"), STD_TEXT)
    // 态 ①：design round1 注入
    const ok = advisorMsg({ cwd: dir, documentMapDoc: "map.md", standardsDoc: "standards.md" })
    assert.ok(ok.includes("\n## Document Map\n"), "态① 段名")
    assert.ok(ok.includes("| section | doc |"), "态① 地图全文")
    // 段序（§12.2 第 3 项）：标准段之后、## Instructions 之前
    const iStd = ok.indexOf("\n## Project Standards\n")
    const iMap = ok.indexOf("\n## Document Map\n")
    const iIns = ok.indexOf("## Instructions")
    assert.ok(iStd > 0 && iMap > 0 && iIns > 0, "三段均可定位")
    assert.ok(iStd < iMap && iMap < iIns, "位次：标准段 → 地图段 → Instructions")
    // 态 ②：声明但不可读 → 点名 advisor.documentMapDoc
    const unreadable = advisorMsg({ cwd: dir, documentMapDoc: "nope.md" })
    assert.ok(unreadable.includes("(Declared document map 'nope.md' could not be read — check the advisor.documentMapDoc setting. Proceeding without it.)"),
      "态② 响亮句 + 点名 advisor.documentMapDoc")
    // 态 ③：未声明 → 逐字降级句
    const undeclared = advisorMsg({ cwd: dir })
    assert.ok(undeclared.includes(NO_MAP_SENTENCE), "态③ 逐字降级句")
    assert.ok(!undeclared.includes("## Document Map\n"), "态③ 无正文段")
    assert.notEqual(NO_MAP_SENTENCE, NO_STANDARDS_SENTENCE, "锚 B5: 两个注入器的降级句互不相同")
    // code round1 **不注入**地图段（对 code 评审无意义）
    const code = advisorMsg({ cwd: dir, documentMapDoc: "map.md", reviewType: "code" })
    assert.ok(!code.includes("## Document Map"), "code round1 不注入地图段（含降级句也不出现）")
    // —— 批 13（R-5 / AC-3 · AC-4 · 锚 V2/V3）：「文档归属」第 7 维的 **design-only 边界** ——
    // 正向锚：design round-1 的判据清单**含**第 7 维（与 `lib/prompts/advisor-design.md` 的系统提示
    // 7 维对齐——本批前用户消息只有 6 维，两条清单不一致）。
    assert.ok(advisorMsg({ cwd: dir }).includes("document ownership"),
      "AC-3/V2: design round-1 用户消息必须含第 7 维 document ownership")
    // 负向锚：code round-1 用户消息**不含**该子句。锁的是「design-only」这个**边界本身**——
    // 防未来重构把该句挪出 `reviewType === "design"` 分支（code 判据来自 loadAdvisorMd 的 5 条内置）。
    assert.ok(!advisorMsg({ cwd: dir, reviewType: "code" }).includes("document ownership"),
      "AC-4/V3: code round-1 用户消息不得含 document ownership（负向锚）")
    // —— 批 13（R-6 / AC-9 · AC-10 · AC-11 · 锚 V6）：判据档 `advisor.criteriaDoc` 的**三态** ——
    // 消费点 = `loadAdvisorMd`（只被 code round-1 的 `## Review Criteria` 段调用）⇒ 本组一律走 code 面。
    const CRIT_TEXT = "# Criteria\n\nCustom rule: no silent degradation.\n"
    writeFileSync(join(dir, "criteria.md"), CRIT_TEXT)
    // 态 ① 已声明且可读 ⇒ 注入其内容，且内置判据**不再**出现（= 替换判据段内容）
    const cOk = advisorMsg({ cwd: dir, criteriaDoc: "criteria.md", reviewType: "code" })
    assert.ok(cOk.includes("Custom rule: no silent degradation."), "AC-9 态①：声明且可读 ⇒ 注入文件内容")
    assert.ok(!cOk.includes("1. Correctness: logic errors"), "AC-9 态①：判据段内容被替换（内置五条不再出现）")
    // 态 ② 已声明但不可读 ⇒ **响亮句点名 advisor.criteriaDoc** + 回落内置判据（与态③ 可区分）
    const cBad = advisorMsg({ cwd: dir, criteriaDoc: "missing-criteria.md", reviewType: "code" })
    assert.ok(cBad.includes("(Declared review criteria document 'missing-criteria.md' could not be read — check the advisor.criteriaDoc setting."),
      "AC-10 态②：响亮句点名 advisor.criteriaDoc")
    assert.ok(cBad.includes("1. Correctness: logic errors"), "AC-10 态②：回落内置判据")
    // 态 ③ 未声明 ⇒ ★ legacy 回退链（**逐字节保持今日行为** = US-7 / AC-11）
    //   (a) 无 `<cwd>/.thincoder/advisor.md` ⇒ 内置判据
    const cLegacyMiss = advisorMsg({ cwd: dir, reviewType: "code" })
    assert.ok(cLegacyMiss.includes("1. Correctness: logic errors"), "AC-11 态③：未声明 ⇒ 内置判据（今日行为）")
    assert.ok(!cLegacyMiss.includes("Declared review criteria document"), "AC-11 态③：与态② 可区分（无响亮句）")
    //   (b) 有 `<cwd>/.thincoder/advisor.md` ⇒ 注入该文件（**上游产品名路径的 legacy 链仍在**）
    mkdirSync(join(dir, ".thincoder"), { recursive: true })
    writeFileSync(join(dir, ".thincoder", "advisor.md"), "# Legacy\n\nLegacy chain still works.\n")
    const cLegacyHit = advisorMsg({ cwd: dir, reviewType: "code" })
    assert.ok(cLegacyHit.includes("Legacy chain still works."),
      "AC-11 态③：未声明 ⇒ legacy 链照旧探 .thincoder/advisor.md（US-7 零行为变更）")
    // 设计档 §9 边界 4：判据档**只**做 code 面——design round-1 从不读它
    const cDesign = advisorMsg({ cwd: dir, criteriaDoc: "criteria.md" })
    assert.ok(!cDesign.includes("Custom rule: no silent degradation."),
      "边界 4：criteriaDoc 不接进 design round-1（注入点只在 code 分支）")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("T-PK12 (锚 B6, AC-P7): 注入门与模式标志解耦——切片内零模式标志引用", () => {
  // 本仓文件行尾混用（LF/CRLF）⇒ 归一后再按标记切片（断言是内容级的，归一安全）
  const src = readFileSync(join(LIB_DIR, "advisor-msgs.mjs"), "utf8").replace(/\r\n/g, "\n")
  const std = srcSlice(src, "function injectProjectStandards(", "\n/**\n * 文档地图段")
  const map = srcSlice(src, "/**\n * 文档地图段", "\n/**\n * 构建 advisor 会话的 user 消息")
  assert.ok(std.length > 0 && map.length > 0, "两切片可定位")
  // ★锚 B6 的字面读法（「切片不含 engineering 子串」）与 AC-P5/§6.4 **逐字**降级句冲突：
  // 该降级句含英文词组 "general engineering practice"。故本档按**锚的意图**（注入门与模式
  // 标志解耦）实施：切片内不得出现任何**模式标志引用**。
  const FLAG_REF = /(opts\.engineering|\bengineering\s*[?!.]|!\s*engineering|engineering\s*===|engineering\s*&&|engEffective)/
  assert.ok(!FLAG_REF.test(std), "锚 B6: 标准注入器零模式标志引用")
  assert.ok(!FLAG_REF.test(map), "锚 B6: 地图注入器零模式标志引用")
  // 允许的唯一命中：逐字降级句内的英文词组（不是模式标志）——逐命中核验，禁「整段放过」
  for (const [label, slice] of [["标准", std], ["地图", map]]) {
    const hits = [...slice.matchAll(/engineering/g)].map(m => slice.slice(Math.max(0, m.index - 60), m.index + 40))
    for (const h of hits) assert.match(h, /general engineering practice/,
      label + "注入器内 engineering 的唯一合法出现必须是降级句词组: " + h)
  }
  // ★加硬（交付代码评审 🔵#2）：上面的 FLAG_REF 是**枚举式**白名单——只覆盖「常见模式标志引用形」，
  // 漏 `state.engineering`、别名局部变量等形态。故补一条**枚举无关**的强断言：整个
  // buildAdvisorUserMessage 函数切片内，**代码面**不得出现 engineering token。
  // ⚠️ 「整个切片零 engineering token」的**字面**读法在当前工作树上**不可满足**：该函数首行注释
  //（`// 批 7（D-P5/J7）：opts.engineering **不再参与**注入门…`）即含该 token——它**记述**的是
  //「该键已退出注入门」，不是模式标志引用。故本档按评审**意图**实施：剥离**整行注释**后零 token。
  const fnSlice = srcSlice(src, "export function buildAdvisorUserMessage(opts) {",
    "\n// ————————————— 引用机械校验（host-verified citations）")
  assert.ok(fnSlice.length > 3000, "函数切片可定位且非空壳")
  const fnCode = fnSlice.split("\n").filter(l => !l.trim().startsWith("//")).join("\n")
  // 阴性对照（防「剥离过度 ⇒ 空串假绿」）：剥离后仍须含函数本体的可识别主体
  assert.ok(fnCode.includes("return buildConvergenceBody(state.lastAdvisorOutput, response, round, scopeFiles, designToken)"),
    "阴性对照：剥离注释后切片仍含函数主体（否证「剥成空串」式假绿）")
  const fnHits = [...fnCode.matchAll(/engineering/g)].map(m => fnCode.slice(Math.max(0, m.index - 60), m.index + 40))
  assert.equal(fnHits.length, 0,
    "锚 B6 加硬: buildAdvisorUserMessage 代码面零 engineering token" + (fnHits.length ? " — " + fnHits.join(" | ") : ""))
  // 模式标志确已从门上游摘除：注入入参不再含模式键（buildAdvisorUserMessage 的 opts 解构行）
  const destructure = srcSlice(src, "  const { cwd, history, state, reviewType, designToken, documents, paths,",
    "\n  const docList")
  assert.ok(!destructure.includes("engineering"), "解构面不再含模式键（注入门 = 声明键存在）")
  assert.ok(!src.includes("injectMethology"), "旧注入器（含拼写错误名）整函数已删除")
})

// ═══════════ 面 ⑥ 设置页：一张卡片三个文本框（AC-P13 / §6.7 · 批 13 R-6 加第三键） ═══════════

test("T-PK13 (AC-P13, §6.7 面⑥ · 批 13/AC-22): 设置页 projectdocs 卡片三个文本框各自到位；draftToPayload 对空串照发", () => {
  const src = readFileSync(join(LIB_DIR, "client.js"), "utf8").replace(/\r\n/g, "\n")
  // 卡片本体：**一张**卡片（key "projectdocs"）内**三个** text 输入框
  // （批 13 / R-6 加 advisor.criteriaDoc ⇒ 口径 2→3，见设计档 §9 边界 10 ③ 与 AC-22）
  const card = srcSlice(src, 'h("div", { className: "tc-card", key: "projectdocs" }', "\n\t\t\t\tconsultPoolCard(),")
  assert.ok(card.includes('h("div", { className: "tc-card", key: "projectdocs" }'), "卡片 key = projectdocs")
  const inputs = card.match(/type: "text",/g) ?? []
  assert.equal(inputs.length, 3, "一张卡片内恰好三个文本输入框")
  // 六子点里的**卡片面**（字段 / payload / 卡片）在本用例；**校验 / 种子 / 合并**三子点由
  // T-PK13b 用**真调用**覆盖（本档此前只有源码切片断言——审计 #1 判定那是假保证）。
  assert.match(card, /value: draft\.advisor\.standardsDoc/, "卡片绑定 standardsDoc 草稿字段")
  assert.match(card, /value: draft\.advisor\.documentMapDoc/, "卡片绑定 documentMapDoc 草稿字段")
  assert.match(card, /setField\(\["advisor", "standardsDoc"\]/, "standardsDoc onChange 落 setField")
  assert.match(card, /setField\(\["advisor", "documentMapDoc"\]/, "documentMapDoc onChange 落 setField")
  // 批 13（R-6 / §9 边界 10 ④）：第三键**同款绑定断言**（只加数组不加卡片绑定 ⇒ 本两条红）
  assert.match(card, /value: draft\.advisor\.criteriaDoc/, "卡片绑定 criteriaDoc 草稿字段")
  assert.match(card, /setField\(\["advisor", "criteriaDoc"\]/, "criteriaDoc onChange 落 setField")
  assert.ok(card.includes("清空=撤销声明"), "placeholder 明说清空 = 撤销声明（AC-P12c）")
  // 生效值/来源回显**三键各一行**（§6.7 的「两个 tc-hint 生效值/来源行」是**批 7 时点**的说法；
  // 批 13 / R-6 加第三键后为三个，见设计档 §9 边界 10）。
  // ★加硬（批 7 分歧审计 #1）：原断言 `card.includes('"standardsDoc"') && card.includes('"documentMapDoc"')`
  // 是 **tautological** —— 这两个 token 在卡片切片内**唯一一次**出现就是上面两行 setField 调用，
  // 故**整段删掉 tc-hint 行仍为真**：它自称验「fieldSource 各键一行」，实际一个字节都没验。
  // 现改为**逐行定位三条 tc-hint**，各自断言「生效值三目 + 来源符号」——删任意一行 ⇒ 定位失败 ⇒ 红。
  const HINT_STD_START = 'h("div", { className: "tc-hint" }, "standardsDoc = '
  const HINT_MAP_START = 'h("div", { className: "tc-hint" }, "documentMapDoc = '
  // 批 13（R-6）：第三键的 tc-hint 行——按**同一逐行定位**手法加一条（不是「切片里含某 token」式假保证）
  const HINT_CRIT_START = 'h("div", { className: "tc-hint" }, "criteriaDoc = '
  const iMapHint = card.indexOf(HINT_MAP_START)
  assert.ok(iMapHint >= 0, "地图 hint 行可定位（删掉该行 ⇒ 本断言红）")
  const iCritHint = card.indexOf(HINT_CRIT_START)
  assert.ok(iCritHint > iMapHint, "判据 hint 行可定位且在 地图 hint 之后（删掉该行 ⇒ 本断言红）")
  const hintStd = srcSlice(card, HINT_STD_START, HINT_MAP_START)
  const hintMap = srcSlice(card, HINT_MAP_START, HINT_CRIT_START)
  const hintCrit = card.slice(iCritHint)
  assert.ok(hintStd.includes('(effStdDoc === undefined ? "未声明" : effStdDoc)'),
    "标准 hint 行回显 effStdDoc（删该行 ⇒ 红）")
  assert.ok(hintStd.includes('+ "（来源 " + stdDocSource + "）。"'),
    "标准 hint 行回显 stdDocSource 来源（删该行 ⇒ 红）")
  assert.ok(hintMap.includes('(effMapDoc === undefined ? "未声明" : effMapDoc)'),
    "地图 hint 行回显 effMapDoc（删该行 ⇒ 红）")
  assert.ok(hintMap.includes('+ "（来源 " + mapDocSource + "）。"'),
    "地图 hint 行回显 mapDocSource 来源（删该行 ⇒ 红）")
  assert.ok(hintCrit.includes('(effCritDoc === undefined ? "未声明" : effCritDoc)'),
    "判据 hint 行回显 effCritDoc（批 13 第三键；删该行 ⇒ 红）")
  assert.ok(hintCrit.includes('+ "（来源 " + critDocSource + "）。"'),
    "判据 hint 行回显 critDocSource 来源（批 13 第三键；删该行 ⇒ 红）")
  // 四个符号必须是**真的**（不是悬空引用）：生效值定义区各自走 fieldSource(["advisor", <key>])
  // （批 13：随 client.js 的注释同步为「三个声明键」——该注释是 srcSlice 的起点标记）
  const effDefs = srcSlice(src, "// 批 7（D-P4）· 批 13（R-6）：三个声明键的当前生效回显", "\n\t\t\t// UI-5")
  assert.match(effDefs, /var effStdDoc = .*\.standardsDoc.*: undefined;/, "effStdDoc 取自生效配置的 standardsDoc")
  assert.match(effDefs, /var stdDocSource = fieldSource\(base, user, \["advisor", "standardsDoc"\]\)/, "stdDocSource 走 fieldSource(标准键)")
  assert.match(effDefs, /var effMapDoc = .*\.documentMapDoc.*: undefined;/, "effMapDoc 取自生效配置的 documentMapDoc")
  assert.match(effDefs, /var mapDocSource = fieldSource\(base, user, \["advisor", "documentMapDoc"\]\)/, "mapDocSource 走 fieldSource(地图键)")
  assert.match(effDefs, /var effCritDoc = .*\.criteriaDoc.*: undefined;/, "effCritDoc 取自生效配置的 criteriaDoc（批 13 第三键）")
  assert.match(effDefs, /var critDocSource = fieldSource\(base, user, \["advisor", "criteriaDoc"\]\)/, "critDocSource 走 fieldSource(判据键)")
  // ★撤销语义可达（锚 B11 的客户端面）：空串必须**照发**，不是「空字段不发送」
  const payload = srcSlice(src, "function draftToPayload(", "\n\t\t\tvar config = {};")
  assert.match(payload, /if \(v === ""\) advisor\[k\] = ""/,
    "空串照发（服务端据此删键 = 撤销声明）——「空字段不发送」会把用户锁死在已声明态")
  assert.match(payload, /else if \(v\.trim\(\) !== ""\) advisor\[k\] = v/,
    "纯空白跳过（§6.7：纯空白不是撤销；服务端也会以非文档路径 400 拒它）")
  // 常量区：不加 min/max（D-P15 / 锚 B8 的客户端面）
  assert.ok(!/STANDARDS_(MIN|MAX)|DOC_MAP_(MIN|MAX)/.test(src), "锚 B8: 三键无 min/max 常量")
})

// ═══════ 面 ⑥ 客户端三函数的**行为**面锁（AC-P13 的 ②③④ 子点；批 7 分歧审计 #1） ═══════
// 审计事实：这批「六子点」原锁只证明 4 个——validateDraft / effectiveToDraft /
// mergeDraftPreservingTouched **在套内一个字都没被引用**。这里不再是源码切片断言（会随 token
// 巧合误绿），而是**把 client.js 的工厂真跑起来**、把三个内部函数取出**真调用**。
// 手法：内存中在工厂的 `exports.apply = apply;` 之前注入一行 `exports.__pk = {...}` 导出
// 三个内部函数——**不改 lib/client.js 一个字节**（被测函数体逐字节不变），只给测试一个入口。
// window/require 用最小桩（工厂顶层只做定义；React 仅在渲染时才被调用）。

/** 载入 client.js 工厂并取回三个内部函数（validateDraft / effectiveToDraft / mergeDraftPreservingTouched）。 */
function loadClientInternals() {
  const src = readFileSync(join(LIB_DIR, "client.js"), "utf8")
  const ANCHOR = "exports.apply = apply;"
  const occurrences = src.split(ANCHOR).length - 1
  assert.equal(occurrences, 1, "工厂尾部导出锚唯一（注入点可定位）")
  const injected = src.replace(ANCHOR,
    "exports.__pk = { validateDraft: validateDraft, effectiveToDraft: effectiveToDraft,"
    + " mergeDraftPreservingTouched: mergeDraftPreservingTouched };\n" + ANCHOR)
  let spec = null
  const fakeWindow = { __ModuleLoader__: { load(s) { spec = s } } }
  const requireStub = () => ({
    useState() { return [undefined, function () {}] }, useEffect() {}, useCallback(fn) { return fn },
    useRef() { return { current: null } }, createElement() { return null },
  })
  // eslint-disable-next-line no-new-func
  new Function("window", "require", injected)(fakeWindow, requireStub)
  assert.ok(spec && typeof spec.factory === "function", "factory 注册成功（bundle 顶层可执行）")
  const exports = spec.factory(requireStub)
  assert.ok(exports && exports.__pk, "内部函数取回成功（注入点存在）")
  assert.equal(typeof exports.__pk.validateDraft, "function", "validateDraft 可调用")
  assert.equal(typeof exports.__pk.effectiveToDraft, "function", "effectiveToDraft 可调用")
  assert.equal(typeof exports.__pk.mergeDraftPreservingTouched, "function", "mergeDraftPreservingTouched 可调用")
  return exports.__pk
}

test("T-PK13b (AC-P13 ②③④, §6.7 面⑥): 三个客户端函数对三键的**真实行为**——validateDraft 类型分支 / effectiveToDraft 种子 / merge 保留", () => {
  const { validateDraft, effectiveToDraft, mergeDraftPreservingTouched } = loadClientInternals()
  // ★ 批 13 修复轮（D13-20 / 审计 F2）：本用例此前把这组循环写成**硬编码两键数组** ⇒ 第三键
  //   `criteriaDoc` **不过这条真调用路径**，第三键只剩「源码在场」这一种证据（present-but-inert）。
  //   ⇒ 一律改走 `PK_KEYS`（声明键的**单一事实源**：加键即自动扩面，不再需要人肉追四处）。
  // ② validateDraft：非字符串 ⇒ 报错含键名；空值（undefined/null）⇒ 不报错（= 撤销/未设都合法）
  for (const k of PK_KEYS) {
    const bad = validateDraft({ advisor: { [k]: 123 } })
    assert.ok(bad.some(e => e.includes("advisor." + k) && e.includes("文档路径字符串")),
      "validateDraft 对非字符串 " + k + " 报错（删掉 PROJECT_DOC_KEYS 校验块 ⇒ 红）: " + JSON.stringify(bad))
    assert.equal(validateDraft({ advisor: { [k]: 123 } }).filter(e => e.includes(k)).length, 1, k + " 非字符串只报一条")
    for (const emptyV of [undefined, null, ""]) {
      const okv = validateDraft({ advisor: { [k]: emptyV } })
      assert.equal(okv.filter(e => e.includes(k)).length, 0,
        "validateDraft 对空值 " + JSON.stringify(emptyV) + "（" + k + "）不报错（空串 = 撤销，必须放行）")
    }
    const good = validateDraft({ advisor: { [k]: "path/to/x.md" } })
    assert.equal(good.filter(e => e.includes(k)).length, 0, "validateDraft 对合法字符串 " + k + " 放行")
  }
  // ③ effectiveToDraft：三键各有一行（字符串保留 / 缺省与非法类型 → 空串 = 未声明）
  const SEED_VAL = { standardsDoc: "docs/std.md", documentMapDoc: "docs/map.md", criteriaDoc: "docs/crit.md" }
  const seeded = effectiveToDraft({ advisor: { ...SEED_VAL } })
  for (const k of PK_KEYS) {
    assert.equal(seeded.advisor[k], SEED_VAL[k], "effectiveToDraft 种子 " + k + "（删该行 ⇒ 红）")
  }
  const seededEmpty = effectiveToDraft({ advisor: {} })
  for (const k of PK_KEYS) assert.equal(seededEmpty.advisor[k], "", "缺省 ⇒ 空串（未声明，不是 undefined）：" + k)
  const seededNonStr = effectiveToDraft({ advisor: { standardsDoc: 42, documentMapDoc: null, criteriaDoc: 7 } })
  for (const k of PK_KEYS) assert.equal(seededNonStr.advisor[k], "", "非字符串 ⇒ 空串（不把非法值灌进表单）：" + k)
  // ④ mergeDraftPreservingTouched：touched 命中 ⇒ 用当前草稿值覆盖种子（三键各一条），未命中 ⇒ 保持种子
  const TYPED_VAL = { standardsDoc: "typed.md", documentMapDoc: "typed-map.md", criteriaDoc: "typed-crit.md" }
  const cur = { advisor: { ...TYPED_VAL } }
  const allTouched = Object.fromEntries(PK_KEYS.map((k) => ["advisor." + k, true]))
  const mergedAll = mergeDraftPreservingTouched(seededEmpty, cur, allTouched)
  for (const k of PK_KEYS) assert.equal(mergedAll.advisor[k], TYPED_VAL[k], "merge 保留用户改过的 " + k + "（删该分支 ⇒ 红）")
  const mergedNone = mergeDraftPreservingTouched(seeded, cur, {})
  for (const k of PK_KEYS) assert.equal(mergedNone.advisor[k], SEED_VAL[k], "未触碰 ⇒ 保持种子（不被 cur 无端覆盖）：" + k)
  // 只触碰一键 ⇒ 其余键不得跟着变（逐键独立，防「一改全跳」）——三键两两轮遍
  for (const k of PK_KEYS) {
    const mergedOne = mergeDraftPreservingTouched(seeded, cur, { ["advisor." + k]: true })
    assert.equal(mergedOne.advisor[k], TYPED_VAL[k], "单键触碰生效：" + k)
    for (const other of PK_KEYS) {
      if (other === k) continue
      assert.equal(mergedOne.advisor[other], SEED_VAL[other],
        "同一次 merge 中其余键保持种子（逐键独立）：" + k + " 被触碰 ⇒ " + other + " 不动")
    }
  }
})

// ═══════ 面 ① 服务端 PUT 校验器 + 面 ③ merge（AC-P12/P12b/P12c；批 7 分歧审计 #2） ═══════
// 审计事实：AC-P12/P12b/P12c 三条**核心** AC 在服务端面**零测试覆盖**——两键此前只出现在
// client.js 的源码切片断言里。这里**直接调用导出的校验器与合并函数**（零写盘、零起服务），
// 把审计员的探针固化成套内断言：`""`/`null` → ok:true 且 sanitized 无该键；`src/a.mjs` /
// `scripts/x.java` → ok:false 且文案含 must point to a DOCUMENT file；`docs/x.md` /
// `METHODOLOGY.md` → ok:true 且 sanitized 含该键；merge **三键**生效、空串不合并。
// （**批 13 修复轮订正**：本行原写「merge 两键生效」，与 T-PK14d 改走 `PK_KEYS` 后的三键现实不符。）

/** 声明键（三键同构——设计 §6.7 面①「两个键同构」；批 13 / R-6 加第三键 `criteriaDoc`）。 */
const PK_KEYS = ["standardsDoc", "documentMapDoc", "criteriaDoc"]
/** 直接调用 PUT 校验器（knownProviders = [] ：本组不设 provider/model，不触发注册表面）。 */
function putAdvisor(adv) { return validateGlobalUserConfig({ advisor: adv }, []) }

test("T-PK14 (AC-P12, §6.7 面①): PUT 类型面——非字符串 ⇒ ok:false + 错误散文含键名 + 不落 sanitized", () => {
  for (const k of PK_KEYS) {
    for (const bad of [123, true, [], {}]) {
      const r = putAdvisor({ [k]: bad })
      assert.equal(r.ok, false, "advisor." + k + "=" + JSON.stringify(bad) + " ⇒ ok:false")
      assert.ok(r.errors.some(e => e.includes("advisor." + k + " must be a string")),
        "错误散文含「advisor." + k + " must be a string」: " + JSON.stringify(r.errors))
      assert.ok(!r.sanitized.advisor || !(k in r.sanitized.advisor),
        "非法值不得落 sanitized（" + k + "）")
    }
    // 合法字符串 ⇒ ok:true 且落 sanitized（与上面同一条分支的正向面）
    const okv = putAdvisor({ [k]: "docs/x.md" })
    assert.equal(okv.ok, true, "advisor." + k + " 合法文档路径 ⇒ ok:true: " + JSON.stringify(okv.errors))
    assert.equal(okv.sanitized.advisor[k], "docs/x.md", "sanitized 落 " + k)
  }
  // 未被识别的 advisor 子键仍被白名单拒（**三键**都已进白名单——批 13 / R-6 加 `criteriaDoc` 后——不得被误报为不支持）
  const unknown = putAdvisor({ standardsDoc: "docs/x.md", notAKey: "x" })
  assert.equal(unknown.ok, false, "未知子键仍拒")
  assert.ok(unknown.errors.some(e => e.includes("advisor.notAKey is not supported")), "未知子键报错指名")
  assert.ok(unknown.errors.every(e => !e.startsWith("advisor.standardsDoc")), "合法键本身不被误伤")
  // 白名单**散文**面同样枚举了三键（面①的散文面同步——只加白名单不改散文是一种漂移）
  assert.ok(unknown.errors.some(e => e.includes("standardsDoc|documentMapDoc|criteriaDoc")),
    "白名单散文枚举三键: " + JSON.stringify(unknown.errors))
})

test("T-PK14b (AC-P12b, J11): PUT 文档路径前置校验——非文档 ⇒ ok:false + must point to a DOCUMENT file", () => {
  const BAD = ["scripts/x.java", "src/a.mjs"]
  for (const bad of BAD) {
    for (const k of PK_KEYS) {
      const r = putAdvisor({ [k]: bad })
      assert.equal(r.ok, false, "advisor." + k + "=" + bad + " ⇒ ok:false（J11：标尺必须是文档）")
      assert.ok(r.errors.some(e => e.includes("advisor." + k) && e.includes("must point to a DOCUMENT file")),
        "文案含 must point to a DOCUMENT file: " + JSON.stringify(r.errors))
      assert.ok(r.errors.some(e => e.includes("'" + bad + "'")), "文案回显被拒路径")
      assert.ok(!r.sanitized.advisor || !(k in r.sanitized.advisor), "被拒路径不得落 sanitized（" + k + "）")
    }
  }
  // 正向：docs/ 前缀与根级文档扩展名两种合法形态（METHODOLOGY.md = 本仓 dogfood 的实际声明值）
  for (const good of ["docs/x.md", "METHODOLOGY.md"]) {
    for (const k of PK_KEYS) {
      const r = putAdvisor({ [k]: good })
      assert.equal(r.ok, true, "advisor." + k + "=" + good + " ⇒ ok:true: " + JSON.stringify(r.errors))
      assert.equal(r.sanitized.advisor[k], good, "sanitized 含 " + k + "=" + good)
    }
  }
  // 两键同时合法（同一次 PUT 两个都落）
  const both = putAdvisor({ standardsDoc: "docs/std.md", documentMapDoc: "docs/map.md" })
  assert.equal(both.ok, true, "两键同时合法: " + JSON.stringify(both.errors))
  assert.equal(both.sanitized.advisor.standardsDoc, "docs/std.md")
  assert.equal(both.sanitized.advisor.documentMapDoc, "docs/map.md")
})

test("T-PK14c (AC-P12c, 锚 B11): 撤销语义——\"\"/null ⇒ ok:true 且 sanitized **无**该键（回到未声明）", () => {
  for (const emptyV of ["", null]) {
    for (const k of PK_KEYS) {
      const r = putAdvisor({ [k]: emptyV })
      assert.equal(r.ok, true, "撤销（" + k + "=" + JSON.stringify(emptyV) + "）⇒ ok:true（**不是** 400）: " + JSON.stringify(r.errors))
      assert.ok(!r.sanitized.advisor || !(k in r.sanitized.advisor),
        "锚 B11: 撤销值**不得**写进 advOut（" + k + "=" + JSON.stringify(emptyV) + "）")
    }
  }
  // 撤销一键、保留另一键 ⇒ 只删被撤销的那个（逐键独立，防「一撤两键都掉」）
  const mixedA = putAdvisor({ standardsDoc: "", documentMapDoc: "docs/map.md" })
  assert.equal(mixedA.ok, true)
  assert.equal("standardsDoc" in mixedA.sanitized.advisor, false, "被撤销的 standardsDoc 已删")
  assert.equal(mixedA.sanitized.advisor.documentMapDoc, "docs/map.md", "另一键保留")
  const mixedB = putAdvisor({ standardsDoc: "docs/std.md", documentMapDoc: null })
  assert.equal(mixedB.ok, true)
  assert.equal("documentMapDoc" in mixedB.sanitized.advisor, false, "被撤销的 documentMapDoc 已删")
  assert.equal(mixedB.sanitized.advisor.standardsDoc, "docs/std.md", "另一键保留")
  // 两键都撤销 ⇒ advisor 组不出现（不做空组噪音）
  const both = putAdvisor({ standardsDoc: "", documentMapDoc: "" })
  assert.equal(both.ok, true)
  assert.ok(!both.sanitized.advisor, "两键都撤销 ⇒ sanitized 不引入空 advisor 组")
})

test("T-PK14d (AC-P13 面③): mergeGlobalConfig——三键生效；空串不合并（撤销后 base 重新显现）", () => {
  // ★ 批 13 修复轮（D13-20 / 审计 F3）：本用例是 **AC-13（核心）的唯一覆盖点**，此前却硬编码**两键**
  //   ⇒ 第三键 `criteriaDoc` 的 merge 行为**零测试**（present-but-inert）。⇒ 改走 `PK_KEYS`。
  const BASE_VAL = { standardsDoc: "base-std.md", documentMapDoc: "base-map.md", criteriaDoc: "base-crit.md" }
  const USER_VAL = { standardsDoc: "user-std.md", documentMapDoc: "user-map.md", criteriaDoc: "user-crit.md" }
  // 生效：user 层非空字符串覆盖 base
  const m = mergeGlobalConfig({ advisor: { ...BASE_VAL } }, { advisor: { ...USER_VAL } })
  for (const k of PK_KEYS) assert.equal(m.advisor[k], USER_VAL[k], "user 覆盖 base（" + k + "）")
  // 空串 = 撤销声明 ⇒ **不合并**（base 值重新显现；服务端删键后即回到未声明）
  const revoked = mergeGlobalConfig({ advisor: { ...BASE_VAL } },
    { advisor: { standardsDoc: "", documentMapDoc: "", criteriaDoc: "" } })
  for (const k of PK_KEYS) assert.equal(revoked.advisor[k], BASE_VAL[k], "空串不合并 ⇒ base 显现（" + k + "）")
  // 纯空白同样不合并；非字符串不合并（merge 层只做 loose-scalar 白名单透传）——逐键各测两种非法值
  for (const k of PK_KEYS) {
    const ws = mergeGlobalConfig({}, { advisor: { [k]: "   " } })
    assert.equal(k in ws.advisor, false, "纯空白不合并（" + k + "）")
    const nonStr = mergeGlobalConfig({}, { advisor: { [k]: 42 } })
    assert.equal(k in nonStr.advisor, false, "非字符串不合并（" + k + "）")
  }
  // 无 user 层 / user 层空对象 ⇒ 不引入 advisor 组键（no-op 语义；无该键即「未声明」）
  assert.ok(!mergeGlobalConfig({}, {}).advisor, "无 user 层 ⇒ 不引入 advisor 组")
  const emptyAdvisor = mergeGlobalConfig({}, { advisor: {} }).advisor
  for (const k of PK_KEYS) assert.equal(k in emptyAdvisor, false, "user 层无该键不引入（" + k + "）")
  // 逐键独立：只合并被声明的那一键，其余键不被一并引入
  for (const k of PK_KEYS) {
    const one = mergeGlobalConfig({}, { advisor: { [k]: "only-" + k + ".md" } })
    assert.equal(one.advisor[k], "only-" + k + ".md", "单键合并生效（" + k + "）")
    for (const other of PK_KEYS) {
      if (other === k) continue
      assert.equal(other in one.advisor, false, "其余键不被一并引入（" + k + " 已声明 ⇒ " + other + " 不引入）")
    }
  }
})

// ═══════ 卫生锁 + 退役完备（AC-P16/锚 B9 · AC-P1/锚 B1 · AC-P2/锚 B2） ═══════
// 审计事实（批 7 分歧审计 #3）：锚 B9 / AC-P16 的**唯一交付物就是这条锁**，此前**套内零锁**——
// 该 AC 只剩手工 grep。B1/B2 的缺失性断言（methodology / docs/design / ENGINEERING-MODE）
// 同批固化在同一个用例里（同一种扫描，同一种失败形态）。

/** lib/** 递归文件清单（相对 lib 的路径；排序稳定）。 */
function walkLib(dir = LIB_DIR, out = [], base = LIB_DIR) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walkLib(full, out, base)
    else out.push(relative(base, full).split("\\").join("/"))
  }
  return out.sort()
}

test("T-PK15 (AC-P16/锚 B9, AC-P1/B1, AC-P2/B2): lib/** 全库扫描——六串命中均为 0（防未来引入的回归锁）", () => {
  // 判据表：pattern = 锚的谓词；probe = **独立手写**的阳性样本（防「正则写错 ⇒ 永远 0 命中」的假绿）
  const LOCK = [
    { label: "AC-P1/锚 B1 methodology", re: /methodology/i, probe: "… per METHODOLOGY.md" },
    { label: "AC-P2/锚 B2 docs/design", re: /docs\/design/, probe: "see docs/design/README.md" },
    { label: "AC-P2/锚 B2 ENGINEERING-MODE", re: /ENGINEERING-MODE/, probe: "read ENGINEERING-MODE.md" },
    { label: "AC-P16/锚 B9 check-doc-width", re: /check-doc-width/, probe: "run check-doc-width.py" },
    { label: "AC-P16/锚 B9 check-ledger", re: /check-ledger/, probe: "run check-ledger.py" },
    { label: "AC-P16/锚 B9 docs/TODO.md", re: /docs\/TODO\.md/, probe: "kept in docs/TODO.md" },
  ]
  const files = walkLib()
  // 扫描面自证：必须先证明这个谓词**能命中**，否则「0 命中」什么也没证明
  for (const p of LOCK) {
    assert.ok(p.re.test(p.probe), "断言器自证（阳性样本必命中）: " + p.label + " ← " + p.probe)
    assert.ok(!p.re.test("__negative control__"), "断言器自证（阴性样本不命中）: " + p.label)
  }
  assert.ok(files.length >= 25, "lib/** 递归扫描面非空（实得 " + files.length + " 档）")
  assert.ok(files.includes("path-kind.mjs") && files.includes("prompts/engineering.md"),
    "扫描面确实覆盖实现档与提示词档（不是空目录假绿）")
  for (const p of LOCK) {
    const hits = []
    for (const f of files) {
      const text = readFileSync(join(LIB_DIR, f), "utf8")
      if (p.re.test(text)) hits.push(f)
    }
    assert.deepEqual(hits, [], p.label + " 在 lib/** 内必须零命中，实得: " + hits.join(", "))
  }
})
