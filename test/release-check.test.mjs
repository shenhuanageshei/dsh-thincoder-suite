// release-check.test.mjs — 发布门的**常驻断言** + 纯函数单测（批 9 · 设计档 §6.2/§6.3、AC-8）。
//
// 为什么要有本档（D9-7 的「采 glm 的一半」）：「不新增测试层」≠「不新增测试」。写进**脚本**的东西
// **可能永远没人跑**，而本仓文化已把 `node --test` 当通用门 ⇒ 门的**非计数**断言必须常驻套件。
//
// ★ **计数相等性故意不在这里**（D9-6 的时序论证）：`node --test` 的用例数**包含本档自己**，
//   而 CHANGELOG 的 `N` 要等**全绿之后**才写 ⇒ 自指、单次运行内不可能成立。计数相等性只住在
//   仓根脚本的 G3（tag 时点断言）。**版本一致性不含此类自指**，故它**必须**常驻（AC-8）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import {
  parseChangelogTopVersion, parseChangelogCountLine, parseTapPass, parseTapFail, parseTapFailures,
  countStaticTests, semverEq, parseFlakeEntries, isKnownFlake, failureToken,
  gateG0, gateG1, gateG2, gateG3, gateG4, gateG6,
  exitCodeOf, settleRerun, rerunOutcomeClaim, flakeRegistrationBlock,
  ROOT,
} from "../release-check.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const TEST_DIR = join(PLUGIN_DIR, "test")
const pkgRaw = readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")
const pkg = JSON.parse(pkgRaw)
const changelog = readFileSync(join(PLUGIN_DIR, "CHANGELOG.md"), "utf8")
const ledger = readFileSync(join(PLUGIN_DIR, "docs", "test-lifecycle.md"), "utf8")
const gateSrc = readFileSync(join(PLUGIN_DIR, "release-check.mjs"), "utf8")

const ledgerFiles = () => readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.mjs")).sort()

// ————————————— 常驻断言（保证会被执行；每条都能失败） —————————————

test("G-常驻1: test/ 零 .skip / .only（锁住套件诚实——静默跳过的绿不是绿）", () => {
  const offenders = []
  for (const f of ledgerFiles()) {
    const src = readFileSync(join(TEST_DIR, f), "utf8")
    const stripped = src.replace(/^\s*\/\/.*$/gm, "") // 注释里引述字面不算实现
    if (/\btest\s*\.\s*(skip|only)\s*\(/.test(stripped)) offenders.push(f + " → test.skip/only")
    if (/\bdescribe\s*\.\s*(skip|only)\s*\(/.test(stripped)) offenders.push(f + " → describe.skip/only")
    if (/^\s*test\s*\([^)]*,\s*\{\s*skip\s*:\s*true/m.test(stripped)) offenders.push(f + " → { skip: true }")
  }
  assert.deepEqual(offenders, [], "套件里不得存在 .skip / .only（实测：" + offenders.join(" | ") + "）")
  // 谓词自证：合成样本必被判出（否则上面那条是恒真空断言）。
  // ★ 样本**拼装**成串——否则本档自身会变成命中源（同 context-budget 的退役常量先例）。
  const OFF = "test" + "." + "skip("
  const ONLY = "test" + "." + "only("
  const probe = OFF + "\"x\", () => {})\n" + ONLY + "\"y\", () => {})"
  assert.ok(/\btest\s*\.\s*(skip|only)\s*\(/.test(probe), "谓词自证：合成样本必命中")
  assert.ok(!/\btest\s*\.\s*(skip|only)\s*\(/.test("test(\"z\", () => {})"), "谓词自证：正常 test( 不命中")
})

test("G-常驻2: package.json#version 合法 semver 且 == CHANGELOG 顶部版本头（去 v 前缀后相等）", () => {
  const v = pkg.version
  assert.match(String(v), /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "package.json#version 必须是合法 semver：" + JSON.stringify(v))
  const top = parseChangelogTopVersion(changelog)
  assert.ok(top !== null, "CHANGELOG 顶部必须有 `## [x.y.z]` 版本头")
  assert.ok(semverEq(v, top),
    "版本一致性（AC-8 / 评审轮次 2 的 #20）：package.json#version = " + JSON.stringify(v)
    + " 必须等于 CHANGELOG 顶部版本头 = " + JSON.stringify(top)
    + "。★ 收口纪律：bump 与 CHANGELOG 新条目必须**同一次编辑/同一个提交**（两步拆开 ⇒ 本断言立刻红——那正是它要抓的）")
  // 口径自证：`v` 前缀被归一（tag 带 v、package.json 不带 v —— D9-13）
  assert.ok(semverEq("v1.2.3", "1.2.3"), "自证：`v` 前缀归一")
  assert.ok(!semverEq("1.2.3", "1.2.4"), "自证：不同版本判否（不是恒真）")
})

test("G-常驻3: CHANGELOG 顶部计数行形态合法（可推导式 `基线 X + 本批 Y` = N）", () => {
  const c = parseChangelogCountLine(changelog)
  assert.ok(Number.isInteger(c.actual), "CHANGELOG 顶部必须有 `**N/N**` 计数行（机器契约）：实得 " + JSON.stringify(c.raw))
  assert.equal(c.total, c.actual, "`**N/N**` 两侧必须一致（形态锁）：" + JSON.stringify(c.raw))
  assert.ok(c.derivable,
    "计数行必须**可推导**（`基线 X + 本批 Y` 之和 == N）：实得 " + JSON.stringify({ raw: c.raw, baseline: c.baseline, added: c.added, actual: c.actual }))
  // 数值**不**在此断言（自指，见文件头）；此处只锁形态
  assert.ok(c.baseline !== null && c.added !== null, "计数行必须写明基线与本批量（可推导性的前提）")
})

test("G-常驻4: 依赖键集合不变（零新增依赖）+ 门的 script 已在位（N-3 / 评审 #9）", () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], "dependencies 键集合必须为空（现状）——加一个键即红")
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), [], "devDependencies 键集合必须为空（现状）——加一个键即红")
  assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), ["cordis"], "peerDependencies 键集合必须不变（宿主提供，不计入零依赖口径）")
  assert.equal(pkg.scripts?.["release:check"], "node release-check.mjs",
    "package.json 必须有 release:check script（一行）——实得 " + JSON.stringify(pkg.scripts))
  assert.equal(pkg.scripts?.test, "node --test", "既有 test script 不得改动")
})

test("G-常驻5: 档清单等值 —— **引用 T-E19**，不重复造第二份清单", () => {
  const guardSrc = readFileSync(join(TEST_DIR, "guard-e.test.mjs"), "utf8")
  const mExisting = /const existing = \[([\s\S]*?)\n\s*\]/.exec(guardSrc)
  const mSelf = /assert\.deepEqual\(files, \[\.\.\.existing, "([^"]+\.test\.mjs)"\]\.sort\(\)/.exec(guardSrc)
  assert.ok(mExisting && mSelf, "T-E19 的清单/自档名必须可定位（登记闸形态变了 ⇒ 本断言必须随之复核，不许静默）")
  const registered = [...mExisting[1].matchAll(/"([^"]+\.test\.mjs)"/g)].map((x) => x[1]).concat([mSelf[1]]).sort()
  assert.deepEqual(registered, ledgerFiles(),
    "档清单必须以 T-E19 为唯一权威（多一个 = 越界新增；少一个 = 档被改名/删除）")
  // 反向自证：本档（发布门测试档）必须在清单里——否则「新增档未登记」会被上一条静默放过
  assert.ok(registered.includes("release-check.test.mjs"), "本档自身必须已登记进 T-E19")
})

test("G-纯函数: 解析函数对畸形/漂移输入各有断言（CHANGELOG / TAP / semver / 静态计数 / flake 表）", () => {
  const FIXTURE = [
    "# Changelog", "",
    "## [0.17.0] — 2026-09-14", "", "**批 9**", "",
    "- **测试**：`node --test` **425/425**（基线 413 + 本批 12）· 零回归", "",
    "## [0.16.0] — 2026-09-13", "", "**批 8**", "",
    "- **测试**：`node --test` **413/413**（基线 399 + 本批 14）", "",
  ].join("\n")
  assert.equal(parseChangelogTopVersion(FIXTURE), "0.17.0", "取**首个**版本头（不是最后一节的旧值）")
  assert.equal(parseChangelogTopVersion("no header here"), null, "畸形输入 ⇒ null（不猜）")
  assert.equal(parseChangelogTopVersion(""), null)

  const c = parseChangelogCountLine(FIXTURE)
  assert.deepEqual([c.actual, c.total, c.baseline, c.added, c.derivable], [425, 425, 413, 12, true],
    "首节计数行解析（含「基线 + 本批」可推导式）")
  assert.equal(parseChangelogCountLine("## [1.0.0]\n\nno counts").actual, null, "无计数行 ⇒ actual=null（G3 红的前提）")
  assert.equal(parseChangelogCountLine("").actual, null)
  assert.equal(parseChangelogCountLine("## [1.0.0]\n\n**10/10**（基线 9 + 本批 2）").derivable, false,
    "自证：可推导式不成立时 derivable=false（不是恒真）")

  const TAP = [
    "TAP version 13",
    "# Subtest: alpha passes", "ok 1 - alpha passes",
    "  ---", "  duration_ms: 0.5", "  ...",
    "# Subtest: T6: session-state file roundtrip", "not ok 2 - T6: session-state file roundtrip",
    "  ---", "  duration_ms: 0.8",
    "  location: 'C:\\\\repo\\\\test\\\\session-state.test.mjs:99:1'", "  ...",
    "1..2", "# tests 2", "# pass 1", "# fail 1",
  ].join("\n")
  assert.equal(parseTapPass(TAP), 1, "`# pass N` 解析")
  assert.equal(parseTapFail(TAP), 1, "`# fail N` 解析")
  assert.equal(parseTapPass("ℹ pass 425"), null, "人类可读格式**不是契约**（D9-12）⇒ 不解析")
  assert.equal(parseTapPass(""), null)
  assert.deepEqual(parseTapFailures(TAP), [{ name: "T6: session-state file roundtrip", file: "session-state.test.mjs" }],
    "失败项 + 档归属（由 location 反推）")

  assert.equal(countStaticTests(["test(\"a\",()=>{})\n  test(\"b\",()=>{})"]), 2, "静态计数（备用/交叉核验口径）")
  assert.equal(countStaticTests([]), 0)
  assert.equal(countStaticTests(["// test(\"commented\")"]), 0, "自证：注释不计入静态计数")

  assert.equal(semverEq("v0.17.0", "0.17.0"), true)
  assert.equal(semverEq("0.17.0", "0.17.1"), false)
  assert.equal(semverEq("", ""), false, "空串不得判相等（防「两处都空 ⇒ 一致」的假绿）")
  assert.equal(semverEq("v", "v"), false,
    "自证（F7）：守卫必须对**去 `v` 前缀后**的值判空——`v` 去前缀后是空串，属两个非 semver 串，不得判「一致」")
  assert.equal(semverEq("v", "1.2.3"), false, "自证：单 `v` 与真版本不等")
  assert.equal(semverEq(null, "1.0.0"), false, "非字符串 ⇒ false")
  assert.equal(failureToken("T6: foo bar"), "T6", "失败标题首 token")
  assert.equal(failureToken(""), "")

  const entries = parseFlakeEntries(ledger)
  assert.ok(Array.isArray(entries) && entries.length >= 1, "台账「五、已知 flake 表」必须可解析且非空")
  assert.ok(entries.some((e) => e.file === "session-state.test.mjs" && e.title === "T6"),
    "R-13 必须登记在 flake 表首行（同档同标题）：实得 " + JSON.stringify(entries))
  assert.equal(parseFlakeEntries("no table"), null, "畸形输入 ⇒ null（不猜）")
  assert.ok(isKnownFlake({ file: "session-state.test.mjs", name: "T6: roundtrip" }, entries), "命中：同档同 token")
  assert.ok(!isKnownFlake({ file: "session-state.test.mjs", name: "T1: other" }, entries), "同档但不同用例 ⇒ **不**放行（防「整档豁免」）")
  assert.ok(!isKnownFlake({ file: "consult.test.mjs", name: "T6: roundtrip" }, entries), "不同档 ⇒ 不放行")
  assert.ok(!isKnownFlake({ file: null, name: "T6: roundtrip" }, entries), "档归属缺失 ⇒ 不放行（宁严不纵容）")
})

test("G-纯函数: 闸级比较函数对**漂移态**各自红且点名（G0/G1/G2/G3/G4/G6）", () => {
  // G0
  assert.equal(gateG0({ files: ["a.mjs", "b.mjs"], failed: [] }).ok, true)
  assert.equal(gateG0({ files: ["a.mjs"], failed: ["a.mjs → SyntaxError"] }).ok, false, "G0 语法破坏 ⇒ 红")
  assert.equal(gateG0({ files: [], failed: [] }).ok, false, "G0 扫描面为空 ⇒ 红（假绿防线）")

  // G1
  assert.equal(gateG1({ porcelain: "?? viz/\n", tags: "", tag: "v1.0.0" }).ok, true, "`??` 未跟踪**豁免**")
  const g1dirty = gateG1({ porcelain: " M lib/eng.mjs\n?? viz/\n", tags: "", tag: "v1.0.0" })
  assert.equal(g1dirty.ok, false, "tracked 脏 ⇒ 红")
  assert.ok(g1dirty.detail.includes("lib/eng.mjs"), "点名脏文件：" + g1dirty.detail)
  assert.equal(gateG1({ porcelain: "", tags: "v1.0.0\nv0.9.0", tag: "v1.0.0" }).ok, false, "tag 已存在 ⇒ 红（防覆盖）")

  // G2
  assert.equal(gateG2({ exitCode: 0, pass: 425, fail: 0, expectedFiles: ["a"] }).ok, true)
  assert.equal(gateG2({ exitCode: 1, pass: 424, fail: 1, expectedFiles: ["a"] }).ok, false, "非零退出 ⇒ 红")
  assert.equal(gateG2({ exitCode: 0, pass: null, fail: null, expectedFiles: ["a"] }).ok, false, "解析不到 `# pass N` ⇒ 红")
  assert.equal(gateG2({ exitCode: 0, pass: 0, fail: 0, expectedFiles: ["a", "b"] }).ok, false, "计数为 0 ⇒ 红（假绿防线）")

  // G3（漂移态：必须**点名两处**）
  const g3 = gateG3({ runtime: 426, changelog: { raw: "**425/425**", actual: 425 } })
  assert.equal(g3.ok, false, "计数漂移 ⇒ 红")
  assert.ok(g3.detail.includes("426") && g3.detail.includes("425") && g3.detail.includes("两处"),
    "必须点名**哪两处**不一致（不是「计数错」）：" + g3.detail)
  assert.equal(gateG3({ runtime: 425, changelog: { raw: "**425/425**", actual: 425 } }).ok, true)
  assert.equal(gateG3({ runtime: 425, changelog: { raw: null, actual: null } }).ok, false, "CHANGELOG 无计数行 ⇒ 红")

  // G4（漂移态：两处不同的不一致各自点名）
  const g4a = gateG4({ pkgVersion: "0.16.0", changelogVersion: "0.17.0", tag: "v0.17.0" })
  assert.equal(g4a.ok, false, "package.json 落后于 CHANGELOG ⇒ 红")
  assert.ok(g4a.detail.includes("0.16.0") && g4a.detail.includes("0.17.0"), "点名版本对：" + g4a.detail)
  const g4b = gateG4({ pkgVersion: "0.16.0", changelogVersion: "0.16.0", tag: "v0.17.0" })
  assert.equal(g4b.ok, false, "tag 与清单不一致 ⇒ 红")
  assert.ok(g4b.detail.includes("tag"), "点名 tag 一侧：" + g4b.detail)
  assert.equal(gateG4({ pkgVersion: "0.17.0", changelogVersion: "0.17.0", tag: "v0.17.0" }).ok, true, "`v` 前缀归一后一致")

  // G6（三态：绿 / 命中 flake ⇒ 允许复跑 / 未命中 ⇒ 红）
  const entries = parseFlakeEntries(ledger)
  assert.equal(gateG6({ g2Ok: true, failures: [], flakeEntries: entries }).ok, true, "G2 绿 ⇒ 预案未触发")
  const hit = gateG6({ g2Ok: false, failures: [{ file: "session-state.test.mjs", name: "T6: roundtrip" }], flakeEntries: entries })
  assert.equal(hit.ok, true, "唯一失败项命中已知 flake ⇒ 允许复跑")
  assert.equal(hit.rerun, true, "必须显式请求复跑（rerun=true）")
  const miss = gateG6({ g2Ok: false, failures: [{ file: "consult.test.mjs", name: "T2: x" }], flakeEntries: entries })
  assert.equal(miss.ok, false, "未命中 flake 表 ⇒ 门红（不纵容）")
  assert.ok(miss.detail.includes("consult.test.mjs"), "点名未命中项：" + miss.detail)
  assert.equal(gateG6({ g2Ok: false, failures: [{ file: "session-state.test.mjs", name: "T6: a" }, { file: "consult.test.mjs", name: "T2: b" }], flakeEntries: entries }).ok,
    false, "**多个**失败项中只要有一个未命中 ⇒ 红（「唯一」是硬条件）")
  assert.equal(gateG6({ g2Ok: false, failures: [{ file: "x.test.mjs", name: "T1" }], flakeEntries: null }).ok, false,
    "台账 flake 表不可定位 ⇒ 红（不猜）")

  // ═══ 🔵#2（交付代码评审轮次 2）：G2 与 G6 对**同一事实**必须同口径 ═══
  //     极端形态①（评审员原话的形态）：`# fail 0` 可解析、退出码 0，但**解不到** `# pass N`。
  //     G2 条目红（计数无权威口径）；旧实现里 G6 另有第二份谓词 `exitCode === 0 && fail === 0`，
  //     在同一输入下判**绿** ⇒ G6 报「未触发」，同一次运行里 G2 红而 G6 绿。
  const weirdPass = { exitCode: 0, pass: null, fail: 0, expectedFiles: ["a.test.mjs"] }
  assert.equal(gateG2(weirdPass).ok, false, "G2：解析不到 `# pass N` ⇒ 红")
  assert.equal(gateG2({ ...weirdPass, expectedFiles: undefined }).ok, false,
    "该红必须由 `pass === null` **这条腿本身**给出（去掉 expectedFiles 后仍是红 ⇒ 不是被 `pass <= 0` 那条腿掩盖）")
  assert.equal(weirdPass.exitCode === 0 && weirdPass.fail === 0, true,
    "旧形态复现：第二份谓词在同一输入下判**绿** ⇒ 与 gateG2 劈叉（本 fixture 确实踩中该缺陷）")
  const g6Same = gateG6({ g2Ok: gateG2(weirdPass).ok, failures: [], flakeEntries: entries })
  assert.equal(g6Same.ok, false, "新口径：G2 红 ⇒ G6 必须同口径红")
  assert.ok(!g6Same.detail.includes("未触发"), "G6 不得声称预案未触发：" + g6Same.detail)
  assert.equal(gateG6({ g2Ok: true, failures: [], flakeEntries: entries }).ok, true,
    "旧口径复现：以第二份谓词为准时 G6 报绿（同一次运行里 G2 红 / G6 绿 = 劈叉）")
  //     极端形态②：`# pass 0`（通过计数为 0 = 假绿）且退出码 0 / fail 0。
  const zeroPass = { exitCode: 0, pass: 0, fail: 0, expectedFiles: ["a.test.mjs"] }
  assert.equal(gateG2(zeroPass).ok, false, "G2：通过计数为 0 ⇒ 红（假绿防线）")
  assert.equal(zeroPass.exitCode === 0 && zeroPass.fail === 0, true, "旧形态复现：同一输入下第二份谓词仍判绿")
  assert.equal(gateG6({ g2Ok: gateG2(zeroPass).ok, failures: [], flakeEntries: entries }).ok, false, "新口径：G6 随之红")
})

test("G-形态: 七闸齐全（六机械 + G7 人工）、G5 保留、零依赖零 DSH 态、G6 不写文档", () => {
  // 七闸齐全 + G5 保留（防「顺手补一个 G5」）
  for (const id of ["G0", "G1", "G2", "G3", "G4", "G6"]) {
    assert.ok(gateSrc.includes('push("' + id + '"'), id + " 必须作为机械闸接线（push 点）")
    assert.equal(typeof { gateG0, gateG1, gateG2, gateG3, gateG4, gateG6 }["gate" + id], "function", id + " 的闸级比较函数必须导出")
  }
  assert.ok(gateSrc.includes("[G5] RESERVED") && !gateSrc.includes('push("G5"'), "G5 号段保留、**无闸**")
  assert.ok(gateSrc.includes("[G7] MANUAL"), "G7 必须明说是**人眼闸**")
  assert.ok(!gateSrc.includes('push("G7"'), "G7 不得作为机械闸接线（人眼闸不可机械变异）")

  // 零依赖：只 import node: 内建
  const imports = [...gateSrc.matchAll(/^import\s+.*?from\s+"([^"]+)"/gm)].map((m) => m[1])
  assert.ok(imports.length >= 3, "门的 import 可解析（实测 " + imports.length + "）")
  for (const spec of imports) {
    assert.ok(spec.startsWith("node:"), "门只允许 import node: 内建模块，实得 " + spec)
  }
  assert.ok(!/from\s+"\.\/lib\//.test(gateSrc) && !/from\s+"\.\.\/lib\//.test(gateSrc),
    "零 DSH 态：门**不得** import 插件内任何模块（不读 config / session / token）")

  // G6 文档写面禁令：脚本只打印，不写文件
  for (const banned of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "createWriteStream"]) {
    assert.ok(!gateSrc.includes(banned), "发布工具不得获得文档写面（评审 #5）：出现 " + banned)
  }
  assert.ok(gateSrc.includes("由**人**登记"), "G6 必须明说「两跑结果由人登记」")

  // 门的 ROOT 就在仓根（`release-check.mjs` 是仓根单文件）
  assert.equal(ROOT, PLUGIN_DIR, "门的 ROOT 必须等于插件仓根")
  assert.ok(readdirSync(PLUGIN_DIR).includes("release-check.mjs"), "release-check.mjs 在仓根")
  // G2 的档清单是**显式清单**（不靠 node 默认 glob）
  assert.ok(gateSrc.includes("export function testFiles()") && gateSrc.includes("readdirSync(join(ROOT, \"test\"))"),
    "G2 档清单必须显式枚举 test/*.test.mjs")

  // ★ F1 接线（**结构配对**）：`main()` 的复跑成功分支必须**回写**——否则 fixture 态用例测的
  //   就只是「一个没人调用的纯函数」，真正跑的那条路径照旧只打印（正是 F1 的原始缺陷）。
  assert.ok(/results\.splice\(0, results\.length, \.\.\.settled\.results\)/.test(gateSrc),
    "F1：复跑成功分支必须把 settleRerun 的结果**回写**进 results（只打印不回写 ⇒ 预案结构性失效）")
  assert.ok(gateSrc.includes("settleRerun({ results, second, changelog: changelogCount"),
    "F1：回写必须用**第二跑**结果与**同一份** CHANGELOG 计数行重算")
  assert.ok(gateSrc.includes("process.exitCode = exitCodeOf(results)"),
    "F1：收口退出码必须由 exitCodeOf(results) 判定——与 fixture 态断言**同一实现**（防两处劈叉）")

  // ★ 🔵#2 接线锁（交付代码评审轮次 2）：`main()` 必须**复用**已算出的 gateG2 结果对象，
  //   不得再持有第二份 G2 谓词（双份谓词少两条红条件 ⇒ 下次只改一处就劈叉）。
  assert.ok(/g2Ok:\s*g2r\.ok/.test(gateSrc), "G6 必须复用 gateG2 的判定结果（`g2Ok: g2r.ok`）")
  assert.ok(!gateSrc.includes("first.exitCode === 0 && first.fail === 0"),
    "第二份 G2 谓词必须消失（它是 G2/G6 口径劈叉的唯一来源）")
})

test("G-复跑结算(F1): G2 红 + 复跑转绿 ⇒ **总退出码 0**（复跑成功必须回写 G2/G3 条目）", () => {
  // fixture 态：模拟 `main()` 在第一跑后**已固化**进 results 的结果数组
  // （G2/G3 按**第一跑**写入——第一跑红正是 G6 复跑唯一的触发前提）。
  const firstRun = [
    { id: "G0", name: "语法", ok: true, detail: "G0：ok" },
    { id: "G1", name: "工作树卫生", ok: true, detail: "G1：ok" },
    { id: "G2", name: "全量套件", ok: false, detail: "G2：套件非零退出（1），pass 432 / fail 1" },
    { id: "G3", name: "计数一致", ok: false, detail: "G3：计数漂移——运行计数 432 vs CHANGELOG 433" },
    { id: "G4", name: "版本一致", ok: true, detail: "G4：ok" },
    { id: "G6", name: "flake 预案", ok: true, rerun: true, detail: "G6：失败项全部命中已知 flake 表（1 项）⇒ 允许**立即复跑一次**" },
  ]
  const changelog = { raw: "**433/433**", actual: 433 }
  const green = { exitCode: 0, pass: 433, fail: 0, files: ["a.test.mjs"] }

  // —— 旧实现复现（回写缺失）：复跑块**只打印**、G2/G3 条目保持第一跑值 ⇒ 退出码恒为 1 ——
  //    这正是 F1 的结构性失效：复跑的前提 = 第一跑红，而第一跑红的 G2/G3 已固化 ⇒
  //    「复跑转绿 ⇒ 放行」这一分支**永远不可能**产生退出码 0。
  assert.equal(exitCodeOf(firstRun), 1,
    "旧实现复现：无回写时，同一份输入下复跑转绿仍以退出码 1 收场（放行不可达）")

  // —— 修后行为：用**第二跑**结果**重算并覆盖** G2/G3 条目 ——
  const settled = settleRerun({ results: firstRun, second: green, changelog, expectedFiles: ["a.test.mjs"] })
  assert.equal(settled.exitCode, 0, "F1：复跑转绿 ⇒ 总退出码必须为 0（放行）")
  assert.equal(settled.results.length, firstRun.length, "覆盖而非追加（G2/G3 不得各多出一条）")
  const g2 = settled.results.find((r) => r.id === "G2")
  const g3 = settled.results.find((r) => r.id === "G3")
  assert.equal(g2.ok, true, "G2 条目必须按**第二跑**转绿")
  assert.equal(g3.ok, true, "G3 条目必须按**第二跑**转绿（runtime 取第二跑的 pass）")
  assert.ok(g2.detail.includes("433"), "G2 detail 必须按第二跑重算（点名第二跑通过数）：" + g2.detail)
  assert.ok(/复跑转绿，两跑结果待人工登记/.test(g2.detail), "G2 detail 须注明待人工登记：" + g2.detail)
  assert.ok(/复跑转绿，两跑结果待人工登记/.test(g3.detail), "G3 detail 须同样注明：" + g3.detail)
  assert.equal(settled.results.find((r) => r.id === "G6").ok, true, "G6 条目（预案已触发且复跑成功）保持放行")
  assert.equal(firstRun.find((r) => r.id === "G2").ok, false, "纯函数：不得就地改写入参（原数组保持第一跑值）")

  // —— 反例 1（防恒真）：第二跑**仍红** ⇒ 退出码仍 1，G2/G3 保持红 ——
  const stillRed = settleRerun({
    results: firstRun, second: { exitCode: 1, pass: 432, fail: 1, files: ["a.test.mjs"] }, changelog, expectedFiles: ["a.test.mjs"],
  })
  assert.equal(stillRed.exitCode, 1, "复跑仍红 ⇒ 门红（回写不得把红洗成绿）")
  assert.equal(stillRed.results.find((r) => r.id === "G2").ok, false, "仍红时 G2 条目必须保持红")

  // —— 反例 2（防「无脑置绿」）：第二跑绿但 G3 判定仍不成立（CHANGELOG 计数漂移）⇒ 仍红 ——
  const drift = settleRerun({
    results: firstRun, second: green, changelog: { raw: "**413/413**", actual: 413 }, expectedFiles: ["a.test.mjs"],
  })
  assert.equal(drift.exitCode, 1, "第二跑绿但计数对不上 CHANGELOG ⇒ 仍红（回写按第二跑**重算**，不是无脑置绿）")
  assert.equal(drift.results.find((r) => r.id === "G2").ok, true, "G2 这条腿按第二跑转绿")
  assert.equal(drift.results.find((r) => r.id === "G3").ok, false, "G3 这条腿仍红（两腿各自独立判定）")

  // ═══ 🔵#3（交付代码评审轮次 2）：复跑成功分支的**措辞**必须按**汇总退出码**落款 ═══
  //     复用上面那条 `drift`（复跑转绿、但 CHANGELOG 计数漂移 ⇒ 汇总仍 exit 1）：
  //     旧措辞无条件打印「复跑转绿 ⇒ 放行」，与「退出码 1、不放行」直接劈叉。
  const redClaim = rerunOutcomeClaim(drift.exitCode)
  assert.ok(!redClaim.includes("放行"), "非 0 汇总退出码的落款**不得**含「放行」字样：" + redClaim)
  assert.ok(redClaim.includes("不得发布"), "非 0 汇总退出码必须明说不得发布：" + redClaim)
  assert.ok(rerunOutcomeClaim(0).includes("放行"), "汇总退出码 0 ⇒ 落款写明放行：" + rerunOutcomeClaim(0))

  // 接线锁：成功分支的落款必须挂在**结算出的**退出码上，而不是无条件的固定串。
  assert.ok(gateSrc.includes("rerunOutcomeClaim(settled.exitCode)"),
    "复跑成功分支的落款必须由 settleRerun 的退出码决定")
  const rerunLog = /console\.log\(\s*"\[G6\] PASS([^)]*)/.exec(gateSrc)
  assert.ok(rerunLog, "复跑成功分支的打印语句必须可定位（形态变了 ⇒ 本断言必须随之复核）")
  assert.ok(!rerunLog[1].includes("放行"),
    "该打印语句本身**不得**含「放行」字样（放行只由 rerunOutcomeClaim 在退出码 0 时给出）：" + rerunLog[1])

  // 登记块（同一条措辞纪律的第二个出口）：`转绿` 分支的落款按**汇总**退出码，不认第二跑退出码。
  const hit1 = [{ file: "session-state.test.mjs", name: "T6: x" }]
  const blockRed = flakeRegistrationBlock("v0.0.0-test", { failures: hit1, fail: 1 }, { failures: hit1, fail: 0, exitCode: 0 }, 1)
  assert.ok(!blockRed.includes("放行"), "登记块在汇总仍红时不得写「放行」：" + blockRed)
  const blockGreen = flakeRegistrationBlock("v0.0.0-test", { failures: hit1, fail: 1 }, { failures: hit1, fail: 0, exitCode: 0 }, 0)
  assert.ok(blockGreen.includes("放行"), "登记块在汇总全绿时写明放行：" + blockGreen)
  assert.ok(gateSrc.includes("rerunOutcomeClaim(rerunExit)"), "登记块必须复用同一措辞谓词（防两处劈叉）")

  // ═══ 🔵#4（交付代码评审轮次 2）：待登记行的首列取**实际命中项**，不取 flake 表首行 ═══
  //     fixture：flake 表**两行**，本次只命中**第二行**（consult）；首行是 session-state。
  const twoRowLedger = [
    "### 六、已否决方案",
    "## 五、已知 flake 表",
    "| 测试 | 症状 | 处置 |",
    "| --- | --- | --- |",
    "| session-state.test.mjs :: T6 | 偶发 | 复跑 |",
    "| consult.test.mjs :: T2 | 偶发 | 复跑 |",
    "",
  ].join("\n")
  const entries2 = parseFlakeEntries(twoRowLedger)
  assert.equal(entries2.length, 2, "fixture：flake 表必须真的有两行（否则本 fixture 踩不中该缺陷）")
  // 旧形态复现：label 取 `entries[0]` ⇒ 指向**首行**（session-state），而命中项是 consult。
  const oldLabel = entries2[0].file + " :: " + entries2[0].title
  assert.ok(oldLabel.startsWith("session-state.test.mjs"),
    "旧形态复现：`entries[0]` 在此 fixture 下指向首行（非命中项）⇒ 待登记行会指错行：" + oldLabel)

  const hit2 = [{ file: "consult.test.mjs", name: "T2: flaky" }]
  const block = flakeRegistrationBlock("v0.0.0-test", { failures: hit2, fail: 1 }, { failures: hit2, fail: 1, exitCode: 1 }, 1)
  assert.ok(block.includes("| consult.test.mjs :: T2: flaky |"),
    "首列必须是**实际命中项**：" + block.split("\n")[2])
  assert.ok(!block.includes("session-state.test.mjs"),
    "首列不得出现 flake 表**首行**（该档本次并没有失败）：" + block)
  // 反例（防「恒取全部 flake 表行」的另一种错法）：待登记项 = 两跑失败项的并集，多跑项也要列全
  const blockBoth = flakeRegistrationBlock("v0.0.0-test",
    { failures: hit2, fail: 1 }, { failures: [{ file: "session-state.test.mjs", name: "T6: again" }], fail: 1, exitCode: 1 }, 1)
  assert.ok(blockBoth.includes("consult.test.mjs :: T2: flaky") && blockBoth.includes("session-state.test.mjs :: T6: again"),
    "两跑各自的失败项都要出现在待登记行里（并集）：" + blockBoth)
})
