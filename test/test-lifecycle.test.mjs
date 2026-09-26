// test-lifecycle.test.mjs — 台账-历史一致闸（批 9 · docs/2026-09-13-test-lifecycle-design.md §6.5）。
//
// 本档是**元锁**：它守的是 `docs/test-lifecycle.md`（活台账）与**客观事实**（git 历史 + 文件系统）
// 之间的一致性，别让台账数字漂移、也别让「元锁档被悄悄删掉」这种事溜过去。
//
// ★ 反 tautological 四律（本档自身必须满足）：
//   律 1 谓词写全 —— 每条断言显式标注**域**（历史提交 / 工作树 / 基线集合）与**自指**
//                     （台账**不在** `test/` 内 ⇒ 它不是档集合的成员；本档自己是成员）；「何谓改」
//                     在本档的口径 = 退役日志声明的**删除**。
//   律 2 独立事实源 —— 期望值**只从 git + fs + 字面常量导出**。台账**只作为被检对象**出现：
//                     档名列与用例数列是**被测事实**，绝不拿来当**别的断言**的期望值。
//                     即：不存在「先读台账、再按台账自证」的路径。
//   律 3 还原即红 —— 每条保护性断言都附**变异矩阵**（见 T-LC5 的合成行与交付报告的实测数字）。
//   律 4 锚不动 —— 基线用**固定 sha 常量** `9282882`，**禁止** HEAD / 工作树相对锚（D-37 的原罪）。
//
// ★ fail-open 自白（批 9 分歧审计 F5 —— **如实登记既存取舍，不静默，行为零改动**）：
//   本档在**无 git**（或基线 sha 不可解析）时**降级为 `console.warn` 而非强红**。降级面**恰为**三处：
//     ① T-LC4 的**基线集合等值**断言（`BASELINE_TEST_FILES` 10 档 == `git ls-tree <BASELINE_SHA> -- test`）
//        ⇒ 整段跳过，且连带跳过**第四方子集谓词** `authorizationViolations` 及其三条合成行自证
//        （它们在同一个 `else` 分支内）；
//     ② T-LC5 的变异 **(2)**（「sha 真实存在但并未删除所述档」）与 **(4)** 的前置 `git rev-parse HEAD`；
//     ③ T-LC5 的 **(6) 事实底座**「git 全史 `test/` 零删除」（`git log --diff-filter=D` 为空）。
//   **不降级**（无 git 也照常断言）：T-LC1 / T-LC2 / T-LC6 全部（纯 fs + 字面常量）· T-LC3 的 R0
//   两问（退役行文本 + 工作树存活）· T-LC4 的「`AP_BASELINE_SHA` 字面 == 本档 `BASELINE_SHA`」锚
//   （读的是 `death-provenance.test.mjs` 的**源码字节**，不调 git）· T-LC5 的 (1)(3)(5)。
//   **为何选降级而不是强红**：本档约一半期望值来自 git；强红会让**整个套件**在无 git 的导出环境
//   （zip 解包目录 / 非仓库工作树）**无法运行**——那会把「元锁」变成「套件不可用」，代价远大于收益。
//   **代价如实登记**：无 git 环境下，台账 ↔ 基线集合这条腿**事实上未受检**；读者**不得**把无 git
//   环境的全绿当作「基线未漂移」的证据（该环境须另用带 git 的复跑取证）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(TEST_DIR, "..")
const LEDGER_PATH = join(PLUGIN_DIR, "docs", "test-lifecycle.md")
const GUARD_E_SRC = join(TEST_DIR, "guard-e.test.mjs")
const DEATH_SRC = join(TEST_DIR, "death-provenance.test.mjs")

/** 律 4：批 6 开工基线（历史事件常量——**不得**改成 HEAD / 工作树形态）。 */
const BASELINE_SHA = "9282882"
/** R0 排除项（D9-3）：元锁档，其锁存活期间不可退役。 */
const R0_FILES = ["death-provenance.test.mjs", "guard-e.test.mjs"]
/** 基线集合（`git ls-tree <BASELINE_SHA> -- test` 的实测值，独立字面常量——不读任何产物的清单）。 */
const BASELINE_TEST_FILES = [
  "advisor-config.test.mjs", "codex-runner.test.mjs", "config-api.test.mjs", "consult.test.mjs",
  "context-budget.test.mjs", "design-review-guard.test.mjs", "preset-static.test.mjs",
  "session-state.test.mjs", "stages.test.mjs", "truncation.test.mjs",
]
/** 用例计数谓词（与台账「三、逐档处置行」单元格口径声明**同一形态**）。 */
const COUNT_RE = /^\s*test\s*\(/gm
/** 台账小节标题（机验入口；改标题即让本闸转红——刻意如此）。 */
const H_HEADINGS = "## 三、逐档处置行"
const H_RETIRE = "## 四、退役日志"

// ————————————— 基础读取器（fs / git 单点实现） —————————————

const countCases = (src) => (src.match(COUNT_RE) ?? []).length

/** 台账小节内的**数据行**（丢掉表头与分隔线；行内不得含 `|` 字面）。 */
function sectionRows(md, heading) {
  const lines = md.split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith(heading))
  assert.ok(i >= 0, "台账缺少小节标题：" + heading)
  const raw = []
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]
    if (l.startsWith("|")) { raw.push(l); continue }
    if (raw.length > 0) break
  }
  assert.ok(raw.length >= 2, heading + " 的表头/分隔线缺失")
  const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim())
  return raw.slice(2).map(cells)
}

/** 工作树 `test/` 的档集合（fs 事实源）。 */
function fsTestFiles() {
  return readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.mjs")).sort()
}

/**
 * git 读取器（非零退出 → null；无 git 的机器 → null）。
 * ★ 曾有一个 git 可用性探测函数（`has` + `Git`，**拼装写法**以免本注释自身成为检索命中源），
 *   定义后**从未被调用**——fail-open 判定实际走本函数的 `=== null` 内联 ⇒ 死代码，已删除
 *   （批 9 交付代码评审轮次 2 的 🔵#5）。**行为与自白口径零改动**：档首「fail-open 自白」
 *   所述的三处降级面照旧由 `gitRead(...) === null` 触发，本注释只登记这次删除。
 */
function gitRead(args) {
  try { return execFileSync("git", args, { cwd: PLUGIN_DIR, encoding: "utf8" }) } catch { return null }
}

// ————————————— 台账-历史一致闸 —————————————

test("T-LC1 (AC-4 / 锚 N1 / 律 1+2+4): 台账处置行档名集合 == 工作树 test 档集合（双射，域 = 工作树）", () => {
  const md = readFileSync(LEDGER_PATH, "utf8")
  const rows = sectionRows(md, H_HEADINGS)
  const ledgerFiles = rows.map((r) => r[0]).sort()
  const fsFiles = fsTestFiles()

  // 自指说明：台账**不在** test/ 内 ⇒ 它不是集合成员；但本批三个新档在集合内，故台账必须覆盖它们。
  assert.ok(!ledgerFiles.includes("test-lifecycle.md"), "自指：台账不是 test/ 的成员")
  assert.deepEqual(ledgerFiles, fsFiles,
    "台账处置行必须与工作树档集合**双射**（多一行 = 幽灵登记；少一行 = 新增档未登记）")
  assert.ok(ledgerFiles.length >= 15, "台账覆盖面非空实测：" + ledgerFiles.length)
})

test("T-LC2 (AC-5 / N-6): 每档用例数由本档用 fs + 正则**独立算得**（不读台账数字）", () => {
  // 谓词自证：计数器必须能区分「真调用」与「注释 / 字符串里的字面」（否则计数是恒真量）。
  const sample = "\n  test(\"a\", () => {})\ntest(\"b\", () => {})\n// test(\"c\")\nconst s = \"test(\"\n"
  assert.equal(countCases(sample), 2, "计数器正负对照失败（注释与字符串字面不得计入）")

  const md = readFileSync(LEDGER_PATH, "utf8")
  const declared = new Map(sectionRows(md, H_HEADINGS).map((r) => [r[0], Number(r[1])]))
  for (const f of fsTestFiles()) {
    const computed = countCases(readFileSync(join(TEST_DIR, f), "utf8")) // ← 期望值来源 = 文件系统
    assert.ok(Number.isInteger(declared.get(f)), f + " 的用例数单元格非整数：" + declared.get(f))
    assert.equal(declared.get(f), computed,
      f + " 台账登记用例数与 fs 实测不符（台账数字不得手写——它必须等于文件里的顶层 test( 计数）")
  }
})

test("T-LC3 (AC-2 / AC-3 / 锚 N3): 退役日志为空；R0 元锁档不得出现在退役行（一票否决）", () => {
  const md = readFileSync(LEDGER_PATH, "utf8")
  const retired = sectionRows(md, H_RETIRE)
  assert.deepEqual(retired, [], "本批退役 0 档 ⇒ 退役日志必须为空（实测 " + retired.length + " 行）")
  const logText = retired.map((r) => r.join(" ")).join("\n")
  for (const f of R0_FILES) {
    assert.ok(!logText.includes(f), "R0 一票否决：" + f + " 不得出现在退役行")
  }
  // R0 档必须**存活**于工作树（域 = 工作树）
  const fsFiles = fsTestFiles()
  for (const f of R0_FILES) assert.ok(fsFiles.includes(f), "R0 元锁档必须存活：" + f)
})

test("T-LC4 (AC-5 / 锚 N2+N3): 四方一致——台账 ↔ fs ↔ T-E19 清单 ↔ 退役授权面（**子集**谓词，非等值）", () => {
  const ledgerFiles = sectionRows(readFileSync(LEDGER_PATH, "utf8"), H_HEADINGS).map((r) => r[0]).sort()
  const fsFiles = fsTestFiles()

  // —— 第三/四方：从**源码字节**解析（fs 事实源；不借台账） ——
  const guardSrc = readFileSync(GUARD_E_SRC, "utf8")
  const mExisting = /const existing = \[([\s\S]*?)\n\s*\]/.exec(guardSrc)
  assert.ok(mExisting, "T-E19 的 existing 数组不可定位——档清单登记闸的形态变了，本闸必须随之复核")
  const te19Existing = [...mExisting[1].matchAll(/"([^"]+\.test\.mjs)"/g)].map((x) => x[1])
  const mSelf = /assert\.deepEqual\(files, \[\.\.\.existing, "([^"]+\.test\.mjs)"\]\.sort\(\)/.exec(guardSrc)
  assert.ok(mSelf, "T-E19 的 deepEqual 形态不可定位（非递归登记闸被改写？）")
  const te19Self = mSelf[1]
  const te19Set = [...te19Existing, te19Self].sort()

  const deathSrc = readFileSync(DEATH_SRC, "utf8")
  const mAuth = /const AP_TEST_AUTHORIZED = \[([^\]]*)\]/.exec(deathSrc)
  assert.ok(mAuth, "AP_TEST_AUTHORIZED 不可定位（授权面被改名/搬走了？）")
  const authorized = [...mAuth[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
  const mBase = /const AP_BASELINE_SHA = "([0-9a-f]{7,40})"/.exec(deathSrc)
  assert.ok(mBase, "AP_BASELINE_SHA 不可定位")
  assert.equal(mBase[1], BASELINE_SHA, "本闸的基线常量必须与 T-AP9 锚 B 的基线**同一 sha**（律 4：锚不动）")

  // 四方一致（台账 ↔ fs ↔ T-E19）。**第四方是授权面**，其谓词见下方子集断言。
  assert.deepEqual(ledgerFiles, fsFiles, "台账 ↔ fs")
  assert.deepEqual(te19Set, fsFiles, "T-E19 登记清单 ↔ fs（多一个 = 越界新增；少一个 = 档被改名/删除）")
  assert.equal(R0_FILES.every((f) => ledgerFiles.includes(f)), true, "R0 档在台账中在位")
  // ★ 口径锁（律 1：域错配 = 恒真断言）：`AP_TEST_AUTHORIZED` 的字面形态是 `git ls-tree` 的
  //   **仓库相对路径**（`test/<裸档名>`），而 `R0_FILES` 是**裸档名** ⇒ 拿裸名去 `includes`
  //   必然全 miss、断言**恒真**（本档交付时即踩过此坑）。故① 先钉住授权面的口径，
  //   ② 再在同一口径下比对。
  assert.ok(authorized.every((p) => /^test\/[A-Za-z0-9._-]+\.test\.mjs$/.test(p)),
    "授权面口径锁：每条必须是仓库相对路径 `test/<裸档名>`（换成裸名会让下方 R0 断言静默退化为恒真）：实测 "
    + JSON.stringify(authorized))
  const r0RelPaths = R0_FILES.map((f) => "test/" + f)
  assert.ok(r0RelPaths.every((p) => !authorized.includes(p)),
    "授权面不得包含 R0 元锁档（口径 = 仓库相对路径 test/<裸档名>，与 AP_TEST_AUTHORIZED 字面同形）：实测 "
    + JSON.stringify(authorized))

  // —— 第四方的**正确谓词 = 子集，不是等值**（评审 #6 / 轮次 2 的 #16）——
  // 被标记为退役**且属于基线集合**的档，必须 ⊆ AP_TEST_AUTHORIZED。
  // 两个集合的口径都取 **T-AP9 锚 B 的原始形态**：`git ls-tree` 的仓库相对路径
  // （`test/x.test.mjs`）——`AP_TEST_AUTHORIZED` 的字面就是这一形态，按裸档名比对必然全 miss。
  // 基线后档不受 T-AP9 锚 B 约束（它只锁基线时已存在的档）⇒ 无需授权。
  const baseline = gitRead(["ls-tree", "-r", "--name-only", BASELINE_SHA, "--", "test"])
  if (baseline === null) {
    console.warn("[thincoder-suite] 台账-历史一致：本机无 git（或基线 " + BASELINE_SHA
      + " 不可解析）——基线集合断言跳过；AP_BASELINE_SHA 字面锚仍生效"
      + "（降级面与理由见档首「fail-open 自白」）")
  } else {
    const baselinePaths = baseline.trim().split("\n").map((p) => p.trim()).filter((p) => p.endsWith(".test.mjs")).sort()
    assert.deepEqual(baselinePaths.map((p) => p.split("/").pop()), [...BASELINE_TEST_FILES].sort(),
      "基线 " + BASELINE_SHA + " 时的档集合必须等于字面常量（10 档）——它是 T-AP9 锚 B 的域")
    const retired = sectionRows(readFileSync(LEDGER_PATH, "utf8"), H_RETIRE)
    assert.deepEqual(authorizationViolations(retired, baselinePaths, authorized), [],
      "退役行若命中基线档，必须逐档出现在 AP_TEST_AUTHORIZED 里（子集谓词）")

    // —— 谓词自证（律 3）：三条合成行必须分别判出 违规 / 合规 / 合规 ——
    //    批 29 订正（单①）：违规样例由 `stages.test.mjs` 换成 `preset-static.test.mjs`——前者因 D29-3
    //    （`stages[].check` 语义改名「宿主验收清单」，host 态渲染文本随之改变）**已进授权表**；再拿它
    //    当「未授权」样例会让这条自证**自身失效**（它要证的恰是「谓词不得恒空」）。**当时全表仅剩
    //    `preset-static.test.mjs` 一档仍在表外**，故换用该档；谓词语义逐字不变。
    //    （历史）批 22 订正（D-39）：违规样例由 `session-state.test.mjs` 换成 `stages.test.mjs`——前者因本批
    //    的夹具改动**已进授权表**（`AP_TEST_AUTHORIZED` 新增 `context-budget` / `session-state` 两项），
    //    再拿它当「未授权」样例会让这条自证**自身失效**（它要证的恰是「谓词不得恒空」）。换成仍在表外
    //    的基线档，谓词语义逐字不变。
    const synth = (file) => ["2026-01-01", "deadbeef", "test/" + file + " :: \"some title\"", "R1 + 证据", "1", "0", "—"]
    assert.deepEqual(authorizationViolations([synth("preset-static.test.mjs")], baselinePaths, authorized),
      ["test/preset-static.test.mjs"], "自证：基线档且未授权 ⇒ 必须判违规（谓词不得恒空）")
    assert.deepEqual(authorizationViolations([synth("design-review-guard.test.mjs")], baselinePaths, authorized),
      [], "自证：基线档且在授权表内 ⇒ 合规")
    assert.deepEqual(authorizationViolations([synth("stage-gate.test.mjs")], baselinePaths, authorized),
      [], "自证：基线**后**新增档 ⇒ 无需授权（谓词不是等值比较）")
  }
})

/** 第四方谓词（子集）：被标记为退役、且属于**基线集合**的档 ⊆ 授权表（口径 = 仓库相对路径）。 */
function authorizationViolations(retiredRows, baselinePaths, authorized) {
  const out = []
  for (const r of retiredRows) {
    const f = retireFileOf(r)
    const rel = f === null ? null : "test/" + f
    if (rel && baselinePaths.includes(rel) && !authorized.includes(rel)) out.push(rel)
  }
  return out
}

/** 退役行 → 档名：`移除的测试标题（逐字）` 单元格的前缀形态 `<档名> :: <标题>`。 */
function retireFileOf(row) {
  const cell = row[2] ?? ""
  const m = /^test\/([A-Za-z0-9._-]+\.test\.mjs)\s*::/.exec(cell.trim())
  return m ? m[1] : null
}

test("T-LC5 (N-6 / 律 3 变异矩阵): 退役行核验器——伪造 sha ⇒ 红；伪造删除声明 ⇒ 红；合规行 ⇒ 绿", () => {
  const fakeFile = "ghost-retired.test.mjs"
  const row = (sha, file) => ["2026-01-01", sha, "test/" + file + " :: \"a removed title\"", "R1 + sha 引用", "413", "413", "J9-x"]

  // (1) 不存在的 sha ⇒ 红（sha 存在性）
  const missingSha = verifyRetirementRows([row("0000000000000000000000000000000000000000", fakeFile)], gitRead)
  assert.deepEqual(missingSha.map((e) => e.kind), ["sha-missing"],
    "伪造 sha 必须被点名（实测：" + JSON.stringify(missingSha) + "）")

  // (2) 真实存在、但**并未删除**所述档的 sha ⇒ 红（删除声明）
  const headSha = gitRead(["rev-parse", "HEAD"])
  if (headSha === null) {
    console.warn("[thincoder-suite] 退役行核验器：本机无 git —— (2)(4) 跳过，(3) 形态断言仍生效"
      + "（降级面与理由见档首「fail-open 自白」）")
  } else {
    const sha = headSha.trim()
    const notDeleted = verifyRetirementRows([row(sha, fakeFile)], gitRead)
    assert.deepEqual(notDeleted.map((e) => e.kind), ["no-deletion"],
      "未发生的删除声明必须被点名（实测：" + JSON.stringify(notDeleted) + "）")
    const addr = sha.slice(0, 8)
    assert.ok(notDeleted[0].detail.includes(addr), "点名必须带 sha 前缀：" + notDeleted[0].detail)
  }

  // (3) 形态锁：R0 档 / 档名不可解析 / sha 空 ⇒ 各自点名。
  //     R0 用例**故意给一条 sha 与删除证据都完美的行**——证明 veto 与 `git show` 无关、独立成立。
  const perfectGit = (args) => {
    if (args[0] === "rev-parse") return BASELINE_SHA + "\n"
    if (args[0] === "show") return "D\ttest/guard-e.test.mjs\n"
    return null
  }
  assert.deepEqual(verifyRetirementRows([row(BASELINE_SHA, "guard-e.test.mjs")], perfectGit).map((e) => e.kind), ["meta-lock"],
    "R0 一票否决必须由核验器独立判出（即便 sha 存在且确实删除了该档）")
  assert.deepEqual(verifyRetirementRows([["d", "s", "no-format", "", "", "", ""]], () => null).map((e) => e.kind), ["unparsable"],
    "档名不可解析必须点名")
  assert.deepEqual(verifyRetirementRows([["d", "", "test/x.test.mjs :: \"t\"", "", "", "", ""]], () => null).map((e) => e.kind), ["sha-missing"],
    "空 sha 必须点名")

  // (4) 阳性对照（防「核验器恒红」的假绿）：注入一个**确实删除**了所述档的 git 读取器 ⇒ 必须零错。
  const deletingGit = (args) => {
    if (args[0] === "rev-parse") return BASELINE_SHA + "\n"
    if (args[0] === "show") return "D\ttest/" + fakeFile + "\n"
    return null
  }
  assert.deepEqual(verifyRetirementRows([row(BASELINE_SHA, fakeFile)], deletingGit), [],
    "阳性对照：sha 存在 + show 证实删除 ⇒ 合规（核验器不是恒红断言）")

  // (5) 真实台账：退役行必须逐行通过核验（本批 0 行 ⇒ 期望 0 错）。伪造一行 ⇒ 此处与 T-LC3 同时红。
  const realRows = sectionRows(readFileSync(LEDGER_PATH, "utf8"), H_RETIRE)
  assert.deepEqual(verifyRetirementRows(realRows, gitRead), [],
    "台账退役行未通过核验（sha 不存在 / 该提交未删除所述档 / R0 档）：" + JSON.stringify(verifyRetirementRows(realRows, gitRead)))

  // (6) 事实底座：本仓 git 全史里 `test/` 零删除 ⇒ 真实退役行的期望值恒为 0 行。
  //     ★ fail-open ③：无 git（headSha === null）时本块**整体跳过**（见档首「fail-open 自白」）。
  if (headSha !== null) {
    const deletions = gitRead(["log", "--diff-filter=D", "--format=%H", "--", "test"])
    assert.equal(deletions.trim(), "", "本仓 git 全史 test/ 零删除（实测：" + deletions.trim().slice(0, 80) + "）")
  }
})

/** 退役行核验器（纯函数；git 读取器注入以便阳性对照）。返回错误列表，空 = 合规。 */
function verifyRetirementRows(rows, git) {
  const errors = []
  for (const r of rows) {
    const sha = (r[1] ?? "").trim()
    const file = retireFileOf(r)
    const origin = file ?? (r[2] ?? "").trim()
    if (file === null) {
      errors.push({ kind: "unparsable", file: origin, detail: "移除的测试标题单元格不符合 `<档名> :: <标题>` 口径：" + origin })
      continue
    }
    if (R0_FILES.includes(file)) {
      errors.push({ kind: "meta-lock", file, detail: "R0 元锁档不可退役（一票否决）：" + file })
    }
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      errors.push({ kind: "sha-missing", file, detail: "提交 sha 形态非法或为空：" + JSON.stringify(sha) })
      continue
    }
    const resolved = git(["rev-parse", "--verify", sha + "^{commit}"])
    if (resolved === null || resolved.trim() === "") {
      errors.push({ kind: "sha-missing", file, detail: "提交 sha 不存在：" + sha.slice(0, 8) })
      continue
    }
    const shown = git(["show", "--name-status", "--format=", sha, "--", "test/" + file])
    const deleted = (shown ?? "").split("\n").some((l) => /^D\t/.test(l.trim()))
    if (!deleted) {
      errors.push({ kind: "no-deletion", file, detail: "提交 " + sha.slice(0, 8) + " 并未删除 " + file })
    }
  }
  return errors
}

test("T-LC6 (律 1 谓词写全): 台账形态锁——层/处置枚举合法；retired ⇔ 退役日志有行；每行含判据与理由", () => {
  const md = readFileSync(LEDGER_PATH, "utf8")
  const rows = sectionRows(md, H_HEADINGS)
  const retired = sectionRows(md, H_RETIRE)
  assert.deepEqual(cellViolations(rows, retired), [], "台账单元格形态违规（层/处置枚举、判据、理由列）")
  // 谓词自证（律 3）：合成行必须能被判违规，否则上面那条是恒真空断言。
  assert.deepEqual(cellViolations([["x.test.mjs", "3", "④", "standing", "—", "理由"]], []).length, 1, "自证：非法层号必须违规")
  assert.deepEqual(cellViolations([["x.test.mjs", "三", "②", "standing", "—", "理由"]], []).length, 1, "自证：非整数用例数必须违规")
  assert.deepEqual(cellViolations([["x.test.mjs", "3", "②", "zombie", "—", "理由"]], []).length, 1, "自证：未知处置必须违规")
  assert.deepEqual(cellViolations([["x.test.mjs", "3", "②", "standing", "—", "  "]], []).length, 1, "自证：理由列空必须违规")
  assert.deepEqual(cellViolations([["x.test.mjs", "3", "②", "retired", "R1", "理由"]], []).length, 1, "自证：retired 而无退役日志行必须违规")
  assert.deepEqual(cellViolations([["x.test.mjs", "3", "②", "standing", "R9", "理由"]], []).length, 1, "自证：未知判据号必须违规")
  // 事实底座：本批全部 standing、零退役（与 T-LC3 同源，独立复述）
  const dispositions = new Set(rows.map((r) => r[3]))
  assert.deepEqual([...dispositions], ["standing"], "本批处置列只能是 standing（本批退役 0 档）")
  assert.equal(retired.length, 0, "退役日志为空")
})

/** 台账单元格形态谓词（纯函数；返回违规描述列表）。 */
function cellViolations(rows, retiredRows) {
  const LAYERS = new Set(["①", "②", "③", "①+②", "②+③"])
  const DISPOSITIONS = new Set(["standing", "retired"])
  const CRITERIA = new Set(["—", "R0", "R1", "R2", "R3", "R4"])
  const out = []
  for (const r of rows) {
    const [file, count, layer, disposition, criterion, reason] = r
    if (r.length !== 6) { out.push(file + ": 列数 != 6（实测 " + r.length + "）"); continue }
    if (!/^[A-Za-z0-9._-]+\.test\.mjs$/.test(file)) out.push(file + ": 档名形态非法")
    if (!/^\d+$/.test(count)) out.push(file + ": 用例数必须是整数（实测 " + JSON.stringify(count) + "）")
    if (!LAYERS.has(layer)) out.push(file + ": 未知层号 " + JSON.stringify(layer))
    if (!DISPOSITIONS.has(disposition)) out.push(file + ": 未知处置 " + JSON.stringify(disposition))
    if (!CRITERIA.has(criterion)) out.push(file + ": 未知判据号 " + JSON.stringify(criterion))
    if (!reason || reason.trim() === "") out.push(file + ": 理由列为空")
    if (disposition === "retired" && !retiredRows.some((x) => retireFileOf(x) === file)) {
      out.push(file + ": 标为 retired 但退役日志无对应行")
    }
  }
  return out
}
