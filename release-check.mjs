#!/usr/bin/env node
// release-check.mjs — 发布门（批 9 / D9-6 · US-5 · US-6 · US-12）。
//
// 形态（D9-6）：**仓根单文件、零依赖、纯 node**——不进 `scripts/`（本仓无该目录），
// `package.json` 加一行 script 即够（`npm run release:check -- v0.17.0`）。
//
// ★ **零配置、零 DSH 态**（D-31 / D-36 教训）：全新进程可跑，**不 import 插件内任何模块**
//   （不读 config / session / token）。它只读本仓的 git 状态、CHANGELOG、package.json、台账与套件。
//
// 用法：`node release-check.mjs v0.17.0`  在 **git tag 之前**跑；**非零退出 = 拦**。
//
// ── 七闸 ──
//   G0 语法      node --check 全部 lib/*.mjs
//   G1 工作树卫生 git status --porcelain 无非豁免项（`??` 未跟踪**豁免**——viz/ 故意不提交）+ 目标 tag 不存在
//   G2 全量套件   node --test --test-reporter=tap <**显式档清单**>，退出码 0 且能解析 `# pass N`（**零重试**）
//   G3 计数一致   运行计数 == CHANGELOG 顶部计数（**只比两处**——评审 #3 收窄）
//   G4 版本一致   package.json#version == CHANGELOG 顶部 `## [x.y.z]` == 传入 tag（去 v 前缀后相等）
//   G5 ★ 编号保留、**无闸** —— 不要顺手补一个 G5：上游三环里被本仓砍掉的 lint 环已由 G0 承担，
//      号段留作将来；此注记即为防误读（设计档 §6.2 的评审 #7 处置）。
//   G6 flake 预案 G2 红且**失败项全部**命中台账「已知 flake 表」⇒ 允许**立即复跑一次**；
//                两跑结果**由人**登记（脚本只打印待登记内容，**不写任何文档**——评审 #5）
//   G7 （**人工**，明说是人眼闸）① CHANGELOG 顶条目覆盖上一 tag 以来的 diff
//                ② 交接页 baseline 计数与 CHANGELOG 顶部计数一致（自 G3 移出，见上）
//
// ★ 导出的**闸级比较函数**（`gateG0`…`gateG6` → `{ok, detail}`）供 `test/release-check.test.mjs`
//   用 **fixture 态**直接断言「漂移 ⇒ 红且点名哪两处」——无需给脚本加 `--root` 注入口，
//   也无需触碰真实仓库（评审 #4）。
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

/** 仓根（= 本文件所在目录）。 */
export const ROOT = dirname(fileURLToPath(import.meta.url))

// ═══════════════ 解析纯函数（律 2：断言的都是**外部事实**——文件字节 / 命令输出） ═══════════════

/** CHANGELOG 顶部版本头：首个 `## [x.y.z]` 的括号内文本（原样，去 v 是 `semverEq` 的事）。 */
export function parseChangelogTopVersion(md) {
  const m = /^##\s*\[([^\]]+)\]/m.exec(String(md ?? ""))
  return m ? m[1].trim() : null
}

/** CHANGELOG **首节**的正文切片（首个 `## [x]` 到下一个 `## [` 之间）。 */
export function firstChangelogSection(md) {
  const s = String(md ?? "")
  const m = /^##\s*\[[^\]]+\]/m.exec(s)
  if (!m) return ""
  const rest = s.slice(m.index + m[0].length)
  const next = /^##\s*\[/m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

/**
 * CHANGELOG 顶部**计数行**：取首节 `**N/N**` 的 N（含「基线 X + 本批 Y」形态）。
 * 返回 `{ raw, actual, total, baseline, added, derivable }`；`actual === null` = 无计数行（G3 红）。
 * `derivable`：有「基线 + 本批」时，二者之和必须等于 N（**形态**可验——数值留给 tag 时点）。
 */
export function parseChangelogCountLine(md) {
  const sec = firstChangelogSection(md)
  const m = /\*\*(\d+)\s*\/\s*(\d+)\*\*/.exec(sec)
  if (!m) return { raw: null, actual: null, total: null, baseline: null, added: null, derivable: false }
  const actual = Number(m[1])
  const total = Number(m[2])
  const bm = /基线\s*(\d+)/.exec(sec)
  const am = /本批\s*(\d+)/.exec(sec)
  const baseline = bm ? Number(bm[1]) : null
  const added = am ? Number(am[1]) : null
  const derivable = baseline === null || added === null ? false : baseline + added === actual
  return { raw: m[0], actual, total, baseline, added, derivable }
}

/** `node --test --test-reporter=tap` 的通过计数（TAP 是**稳定机器格式**；人类可读的 `ℹ pass N` 不是契约）。 */
export function parseTapPass(tap) {
  const m = /^# pass (\d+)$/m.exec(String(tap ?? ""))
  return m ? Number(m[1]) : null
}

/** TAP 的失败计数（`# fail N`）。 */
export function parseTapFail(tap) {
  const m = /^# fail (\d+)$/m.exec(String(tap ?? ""))
  return m ? Number(m[1]) : null
}

/**
 * TAP 失败项：`not ok N - <name>`（TAP 允许缩进）。file 由**同一诊断块里紧随其后的**
 * `location: '<path>:<line>:<col>'` 反推（Node 的 TAP reporter 会带上它；多档同跑时
 * node 把各档的用例**平铺**成顶层子测试，故位置信息是唯一的档归属来源）。
 * 兜底：名字本身以 `.test.mjs` 结尾（档级结果行）时直接取该档名。
 */
export function parseTapFailures(tap) {
  const lines = String(tap ?? "").split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+ - (.+?)\s*$/.exec(lines[i])
    if (!m) continue
    const name = m[1].trim()
    let file = /\.test\.mjs$/.test(name) ? name.split(/[\\/]/).pop() : null
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
      if (/^\s*not ok \d+ - /.test(lines[j]) || /^\s*\.\.\.\s*$/.test(lines[j])) break
      const loc = /^\s*location:\s*'?([^'\n]+?)'?\s*$/.exec(lines[j])
      if (loc) { file = loc[1].split(/[\\/]/).pop().split(":")[0]; break }
    }
    out.push({ name, file })
  }
  return out
}

/** 静态 `test(` 计数（**备用/交叉核验**口径——发布门的权威计数是 TAP 运行计数，D9-12）。 */
export function countStaticTests(sources) {
  return (sources ?? []).reduce((n, s) => n + ((String(s).match(/^\s*test\s*\(/gm)) ?? []).length, 0)
}

/**
 * 去掉可选 `v` 前缀后相等（D9-13：tag = `vX.Y.Z`，`package.json#version` 不带 v）。
 * ★ 守卫判空的对象是**去前缀后**的值（交付评审 F7）：只查原串非空会让 `"v"` vs `"v"`
 *   两侧都退化成空串却判「一致」——两个非 semver 垃圾串被当成版本一致，正是 G4 要防的假绿。
 */
export function semverEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false
  const x = a.trim().replace(/^v/i, "")
  const y = b.trim().replace(/^v/i, "")
  return x !== "" && y !== "" && x === y
}

/** 台账「五、已知 flake 表」的数据行 → `[{file, title}]`（行长格式：`<档名> :: <用例标题>`）。 */
export function parseFlakeEntries(ledgerMd) {
  const lines = String(ledgerMd ?? "").split(/\r?\n/)
  const i = lines.findIndex((l) => l.startsWith("## 五、已知 flake 表"))
  if (i < 0) return null
  const raw = []
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]
    if (l.startsWith("|")) { raw.push(l); continue }
    if (raw.length > 0) break
  }
  return raw.slice(2).map((l) => l.split("|").slice(1, -1).map((c) => c.trim())).map((c) => {
    const m = /^([A-Za-z0-9._-]+\.test\.mjs)\s*::\s*(.*)$/.exec(c[0] ?? "")
    return m ? { file: m[1], title: m[2].trim() } : { file: null, title: (c[0] ?? "").trim() }
  })
}

/** 失败标题的首 token（`T6: foo` → `T6`；用于与 flake 表条目标题比对）。 */
export function failureToken(title) {
  const t = String(title ?? "").trim()
  const m = /^([A-Za-z0-9_-]+)\s*:?/.exec(t)
  return m ? m[1] : ""
}

/** 某失败项是否命中台账已知 flake 表：**档名相同**且**标题首 token 相同**（缺一不可）。 */
export function isKnownFlake(failure, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false
  const file = failure?.file ?? null
  const tok = failureToken(failure?.name)
  return entries.some((e) => {
    if (!e.file || !file) return false
    if (e.file !== file) return false
    if (!e.title) return true
    return failureToken(e.title) === tok
  })
}

// ═══════════════ 闸级比较函数（**输入已解析的值**，输出判定 + 点名的详情） ═══════════════

/** G0 语法：`node --check` 的逐档结果。 */
export function gateG0({ files, failed }) {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, detail: "G0：没扫到任何 lib/*.mjs（扫描面为空 = 假绿）" }
  if (failed && failed.length > 0) return { ok: false, detail: "G0：语法检查失败 " + failed.length + " 档 —— " + failed.join(" | ") }
  return { ok: true, detail: "G0：" + files.length + " 个 lib/*.mjs 全部通过 node --check" }
}

/** G1 工作树卫生：`??` 未跟踪**豁免**；目标 tag 不得已存在。 */
export function gateG1({ porcelain, tags, tag }) {
  const dirty = String(porcelain ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).filter((l) => !l.startsWith("??"))
  const problems = []
  if (dirty.length > 0) problems.push("tracked 文件有未提交变更 " + dirty.length + " 处 —— " + dirty.join(" | "))
  if (tag && String(tags ?? "").split(/\r?\n/).map((s) => s.trim()).includes(tag)) problems.push("目标 tag 已存在（防覆盖）：" + tag)
  if (problems.length > 0) return { ok: false, detail: "G1：" + problems.join(" ； ") }
  return { ok: true, detail: "G1：工作树干净（`??` 已豁免）且 tag " + tag + " 尚不存在" }
}

/** G2 全量套件：退出码 0 + 能解析 `# pass N`（**零重试**由调用方保证：只跑一次）。 */
export function gateG2({ exitCode, pass, fail, expectedFiles }) {
  if (pass === null) return { ok: false, detail: "G2：TAP 里解析不到 `# pass N`（计数无权威口径）——退出码 " + exitCode }
  if (exitCode !== 0) return { ok: false, detail: "G2：套件非零退出（" + exitCode + "），pass " + pass + " / fail " + fail }
  if (fail !== null && fail !== 0) return { ok: false, detail: "G2：退出码为 0 但 `# fail` = " + fail + "（不一致 ⇒ 门红，不猜）" }
  if (Array.isArray(expectedFiles) && pass <= 0) return { ok: false, detail: "G2：通过计数为 0（" + expectedFiles.length + " 档全空 = 假绿）" }
  return { ok: true, detail: "G2：" + pass + " 用例全绿（" + (expectedFiles?.length ?? "?") + " 档，零重试）" }
}

/** G3 计数一致：**只比两处** —— `node --test` 运行计数 vs CHANGELOG 顶部计数行。 */
export function gateG3({ runtime, changelog }) {
  if (!Number.isInteger(runtime)) return { ok: false, detail: "G3：运行计数不可解析（缺 `# pass N`）" }
  if (!changelog || !Number.isInteger(changelog.actual)) {
    return { ok: false, detail: "G3：CHANGELOG 顶部计数行缺失/不可解析（计数行是**机器契约**）——" + JSON.stringify(changelog?.raw ?? null) + " 处" }
  }
  if (runtime !== changelog.actual) {
    return {
      ok: false,
      detail: "G3：计数漂移——**两处**不一致：① `node --test` 运行计数 = " + runtime
        + " ② `CHANGELOG.md` 顶部计数行 " + changelog.raw + " = " + changelog.actual
        + "（差额 " + (runtime - changelog.actual) + "）",
    }
  }
  return { ok: true, detail: "G3：运行计数 " + runtime + " == CHANGELOG 顶部 " + changelog.actual }
}

/** G4 版本一致：package.json#version == CHANGELOG 顶部版本头 == 传入 tag（去 v 前缀后相等）。 */
export function gateG4({ pkgVersion, changelogVersion, tag }) {
  const pairs = []
  if (!semverEq(pkgVersion, changelogVersion)) pairs.push("`package.json#version` = " + JSON.stringify(pkgVersion) + " vs CHANGELOG 顶部版本头 = " + JSON.stringify(changelogVersion))
  if (!semverEq(pkgVersion, tag)) pairs.push("`package.json#version` = " + JSON.stringify(pkgVersion) + " vs 拟用 tag = " + JSON.stringify(tag))
  if (pairs.length > 0) return { ok: false, detail: "G4：版本不一致 —— " + pairs.join(" ； ") }
  return { ok: true, detail: "G4：三处一致（" + String(pkgVersion).trim() + " = " + String(changelogVersion).trim() + " = " + String(tag).trim() + "）" }
}

/**
 * G6 flake 预案：G2 绿 ⇒ 未触发；G2 红 ⇒ **每一个**失败项都必须命中台账已知 flake 表，
 * 否则门红（不冤杀、不纵容）。命中时 `rerun: true` = 允许调用方**立即复跑一次**（仅一次）。
 */
export function gateG6({ g2Ok, failures, flakeEntries }) {
  if (g2Ok) return { ok: true, detail: "G6：G2 绿 ⇒ flake 预案未触发" }
  if (!Array.isArray(failures) || failures.length === 0) {
    return { ok: false, detail: "G6：G2 红但 TAP 里解析不到失败项（不猜——按门红处理）" }
  }
  if (flakeEntries === null) return { ok: false, detail: "G6：台账「已知 flake 表」不可定位 ⇒ 预案无法判定，按门红处理" }
  const unknown = failures.filter((f) => !isKnownFlake(f, flakeEntries))
  if (unknown.length > 0) {
    return { ok: false, detail: "G6：存在**不在**已知 flake 表内的失败 " + unknown.length + " 项 —— " + unknown.map((u) => (u.file ?? "?") + " :: " + u.name).join(" | ") }
  }
  return { ok: true, rerun: true, detail: "G6：失败项全部命中已知 flake 表（" + failures.length + " 项）⇒ 允许**立即复跑一次**" }
}

/**
 * 机械闸的总退出码（0 = 放行；G7 是**人眼闸**，`manual: true` 不参与——评审 #8）。
 * 与 `main()` 的收口判定共用同一实现（防「脚本里另写一份」的劈叉）。
 */
export function exitCodeOf(results) {
  return (results ?? []).some((r) => !r.manual && !r.ok) ? 1 : 0
}

/**
 * 复跑**成功**（第二跑退出码 0）后的**落款措辞**（批 9 交付代码评审轮次 2 的 🔵#3）。
 *
 * 为何必须是「按退出码」而不是「无条件」：`settleRerun` 是按**第二跑重算**，**不是置绿**——
 * G3 可能仍红（CHANGELOG 计数漂移）⇒ 机械闸总退出码仍是 1。若日志无条件写「放行」，
 * 日志与判定就劈叉（读者照日志发版、脚本却非零退出）。
 * ⇒ 「**放行**」二字**只**在机械闸总退出码为 0 时出现；其余情形明说「以汇总为准」。
 * ★ 措辞纪律（比设计档的原样建议更严一档）：非 0 分支的落款里**连「放行」二字都不出现**
 *   （写「不得发布（以机械闸汇总为准）」而非「不得放行……」）——这样「打印文本含不含『放行』」
 *   本身就是一个**可机验的判据**，不必靠人读语气分辨「是主张还是引用」。
 */
export function rerunOutcomeClaim(exitCode) {
  return exitCode === 0 ? "机械闸汇总全绿 ⇒ 放行" : "机械闸汇总仍有红项 ⇒ 不得发布（以机械闸汇总为准）"
}

/**
 * **G6 复跑的结算**（批 9 交付代码评审 F1 的 🔴 修复）：复跑**成功**时，必须用**第二跑**结果
 * **重算并覆盖** G2/G3 条目。
 *
 * 为何是结构性的：复跑**唯一**的触发前提是**第一跑红**（`gateG6` 只在 `g2Ok === false` 时给
 * `rerun: true`），而第一跑红意味着固化进 `results` 的 G2/G3 条目必然是红——若复跑块**只打印**
 * 「复跑转绿 ⇒ 放行」而**不回写**，则 `exitCodeOf(results)` 恒为 1 ⇒ **「放行」永远不可达**。
 *
 * 纯函数：不就地改写入参，返回 `{ results（新数组）, exitCode }`。
 * G2 按第二跑的 `exitCode/pass/fail` 重算；G3 的 `runtime` 取**第二跑的 pass**（计数一致性的
 * 口径是「运行计数」，第二跑才是被放行的那一跑）；其余闸（G0/G1/G4/G6）不受影响。
 */
export function settleRerun({ results, second, changelog, expectedFiles }) {
  const note = "（R-13 flake 复跑转绿，两跑结果待人工登记）"
  const g2 = gateG2({ exitCode: second.exitCode, pass: second.pass, fail: second.fail, expectedFiles: expectedFiles ?? second.files })
  const g3 = gateG3({ runtime: second.pass, changelog })
  const merged = (results ?? []).map((r) => {
    if (r.id === "G2") return { ...r, ...g2, detail: g2.detail + note }
    if (r.id === "G3") return { ...r, ...g3, detail: g3.detail + note }
    return r
  })
  return { results: merged, exitCode: exitCodeOf(merged) }
}

// ═══════════════ 闸执行（仓根侧；只用 node 内建 + git） ═══════════════

const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim()
const run = (args, opts) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, ...opts }) }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") }
  }
}

/** G2 的档清单：**显式清单**，不靠 node 默认 glob（免疫 glob 行为随版本漂移）。 */
export function testFiles() {
  return readdirSync(join(ROOT, "test")).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => join("test", f))
}

function runSuite() {
  const files = testFiles()
  const r = run(["--test", "--test-reporter=tap", ...files])
  return { files, exitCode: r.code, tap: r.out, pass: parseTapPass(r.out), fail: parseTapFail(r.out), failures: parseTapFailures(r.out) }
}

/**
 * G6 的**待登记内容**（只打印；脚本**不写任何文档**——评审 #5 的文档写面禁令）。
 * 行格式 = 台账「五、已知 flake 表」的**同列口径**（测试 / 症状 / 处置），日期与两跑结果
 * 都塞进「症状」列 ⇒ 人**照抄即可**，不需要再翻译一次。
 *
 * ★ 首列（测试）= **实际命中项**（`names`），**不再**取 flake 表的首行（批 9 交付代码评审轮次 2
 *   的 🔵#4）：`names` 由第一/第二跑的**失败项**并集导出，而 flake 表可能有多行——取 `entries[0]`
 *   在表仅一行时偶然正确，扩到 ≥2 行即把待登记行指到**别人的**那一行（登记信息错位）。
 * ★ 处置列（🔵#3）：`转绿` 分支的落款由**机械闸总退出码**决定（`rerunExit`），不认第二跑退出码——
 *   第二跑绿 ≠ 汇总绿（G3 可能仍红）。
 *
 * 导出供 `test/release-check.test.mjs` 直接断言**打印文本**（判定逻辑必须在可测面内）。
 */
export function flakeRegistrationBlock(tag, first, second, rerunExit) {
  const date = new Date().toISOString().slice(0, 10)
  const names = [...new Set([...first.failures, ...second.failures].map((f) => (f.file ?? "?") + " :: " + f.name))]
  return [
    "",
    "  ── 以下内容由**人**登记进 docs/test-lifecycle.md「五、已知 flake 表」（脚本不写文档）──",
    "  | " + names.join(" / ") + " | " + date + " 复跑记录（tag " + tag + "）：第一跑 " + first.fail + " fail（"
      + first.failures.map((f) => f.name).join(" / ") + "）；第二跑 " + second.fail + " fail（"
      + second.failures.map((f) => f.name).join(" / ") + "） | 处置：复跑"
      + (second.exitCode === 0 ? "转绿 ⇒ " + rerunOutcomeClaim(rerunExit) : "仍红 ⇒ 门红") + " |",
    "",
  ].join("\n")
}

function main() {
  const tag = process.argv[2]
  const results = []
  const push = (id, name, r, manual) => {
    results.push({ id, name, ...r, manual: manual === true })
    const mark = manual === true ? "MANUAL" : (r.ok ? "PASS" : "FAIL")
    console.log("[" + id + "] " + mark.padEnd(6) + " " + r.detail)
  }

  console.log("release-check —— 仓根发布门（批 9 / 七闸）· 目标 tag = " + JSON.stringify(tag ?? null) + " · ROOT = " + ROOT)
  console.log("")

  if (!tag) {
    console.log("[!!] 用法：node release-check.mjs vX.Y.Z（在 git tag 之前跑；非零退出 = 拦）")
    process.exitCode = 1
    return
  }

  // —— G0 语法 ——
  let g0
  try {
    const all = readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".mjs"))
    const failed = []
    for (const f of all) {
      const r = run(["--check", join(ROOT, "lib", f)])
      if (r.code !== 0) failed.push("lib/" + f + " → " + r.out.trim().split("\n")[0])
    }
    g0 = gateG0({ files: all, failed })
  } catch (e) { g0 = { ok: false, detail: "G0：扫描 lib/ 失败 —— " + (e?.message ?? e) } }
  push("G0", "语法", g0)

  // —— G1 工作树卫生 + tag 不存在 ——
  let g1
  try { g1 = gateG1({ porcelain: git(["status", "--porcelain"]), tags: git(["tag", "-l"]), tag }) }
  catch (e) { g1 = { ok: false, detail: "G1：git 不可用或命令失败 —— " + (e?.message ?? e) } }
  push("G1", "工作树卫生", g1)

  // —— G2 全量套件（**一次**，零重试） ——
  // ★ 单份谓词（批 9 交付代码评审轮次 2 的 🔵#2）：G2 的判定结果对象**就是** G6 的 `g2Ok` 来源。
  //   此前 G6 另写了一份 `exitCode === 0 && fail === 0`，比 `gateG2` 少「`pass === null`」与
  //   「`pass <= 0`」两条 ⇒ 极端形态（如 `# fail 0` 可解析但 `# pass N` 解析不到、或通过计数为 0）
  //   下两闸对**同一事实**给出相反判定（G2 条目红、G6 却报「未触发」）。双份谓词 = 下次改一处就劈叉。
  const first = runSuite()
  const g2r = gateG2({ exitCode: first.exitCode, pass: first.pass, fail: first.fail, expectedFiles: first.files })
  push("G2", "全量套件", g2r)

  // —— G3 计数一致 ——
  let g3
  let changelogCount = null // G6 复跑成功时要用**同一份** CHANGELOG 计数行重算 G3
  try {
    const md = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")
    changelogCount = parseChangelogCountLine(md)
    g3 = gateG3({ runtime: first.pass, changelog: changelogCount })
  } catch (e) { g3 = { ok: false, detail: "G3：读 CHANGELOG 失败 —— " + (e?.message ?? e) } }
  push("G3", "计数一致", g3)

  // —— G4 版本一致 ——
  let g4
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    g4 = gateG4({ pkgVersion: pkg.version, changelogVersion: parseChangelogTopVersion(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")), tag })
  } catch (e) { g4 = { ok: false, detail: "G4：读 package.json / CHANGELOG 失败 —— " + (e?.message ?? e) } }
  push("G4", "版本一致", g4)

  console.log("[G5] RESERVED 号段保留、**无闸**——不要顺手补一个 G5（上游 lint 环已由 G0 承担）")

  // —— G6 flake 预案（命中已知 flake ⇒ 允许**一次**复跑；两跑结果由人登记） ——
  let g6
  let flakeEntries = null
  try {
    const ledgerPath = join(ROOT, "docs", "test-lifecycle.md")
    flakeEntries = existsSync(ledgerPath) ? parseFlakeEntries(readFileSync(ledgerPath, "utf8")) : null
    // g2Ok = **已算出的** gateG2 结果（🔵#2：单份谓词，不再复写）
    g6 = gateG6({ g2Ok: g2r.ok, failures: first.failures, flakeEntries })
  } catch (e) { g6 = { ok: false, detail: "G6：读台账失败 —— " + (e?.message ?? e) } }
  push("G6", "flake 预案", g6)
  if (g6.rerun) {
    console.log("     第一跑：" + first.fail + " 项失败 —— " + first.failures.map((f) => (f.file ?? "?") + " :: " + f.name).join(" | "))
    const second = runSuite() // 唯一的一次复跑
    console.log("     第二跑：" + second.fail + " 项失败 —— " + second.failures.map((f) => (f.file ?? "?") + " :: " + f.name).join(" | "))
    let rerunExit // 复跑后的**机械闸汇总**退出码（🔵#3：登记块的落款也按它，而不是第二跑退出码）
    const setResult = (id, r) => {
      const i = results.findIndex((x) => x.id === id)
      if (i >= 0) results[i] = { ...results[i], ...r }
    }
    if (second.exitCode !== 0) {
      g6.ok = false
      g6.detail = "G6：复跑仍红（fail=" + second.fail + "）⇒ 门红"
      setResult("G6", { ok: false, detail: g6.detail })
      console.log("[G6] FAIL   " + g6.detail)
      rerunExit = 1
    } else {
      // ★ F1（🔴）：复跑转绿 ⇒ 必须用**第二跑**结果**重算并覆盖** G2/G3 条目。
      //   第一跑红是复跑的前提 ⇒ 若不回写，`results` 里固化的仍是第一跑的红值
      //   ⇒ 收口判定恒为 exitCode 1，「放行」永远不可达（预案结构性失效）。
      const settled = settleRerun({ results, second, changelog: changelogCount, expectedFiles: first.files })
      results.splice(0, results.length, ...settled.results)
      rerunExit = settled.exitCode
      // ★ 🔵#3：措辞**按汇总退出码**落款——`settleRerun` 是重算而非置绿，第二跑绿 ≠ 汇总绿
      //   （G3 可能仍红）⇒ 日志不得无条件写「放行」，否则日志与判定劈叉（读者照日志发版、脚本非零退出）。
      console.log("[G6] PASS   复跑转绿（G2/G3 条目已按**第二跑**重算并覆盖；"
        + "仍须由人按台账 flake 表行格式登记两跑结果）⇒ " + rerunOutcomeClaim(settled.exitCode))
      // 覆写后的 G2/G3 逐条重印：上面早先打的 FAIL 行已被**第二跑**取代，日志不得与判定劈叉。
      for (const id of ["G2", "G3"]) {
        const r = results.find((x) => x.id === id)
        if (r) console.log("[" + id + "] " + (r.ok ? "PASS" : "FAIL").padEnd(6) + r.detail + "   ← 按第二跑覆盖")
      }
    }
    console.log(flakeRegistrationBlock(tag, first, second, rerunExit))
  }

  // —— G7 人工核验项（明说是人眼闸，不参与退出码） ——
  console.log("")
  console.log("[G7] MANUAL 人工核验项（**人眼闸**，不机械化、不参与退出码）：")
  console.log("     ① CHANGELOG 顶条目是否覆盖**上一 tag 以来**的 diff")
  console.log("     ② `docs/2026-09-13-handoff.md` 的 baseline 计数是否与 CHANGELOG 顶部计数一致")
  console.log("       （该行自 G3 移出：交接页是活页、编号会漂、无机器契约 —— 评审 #3 收窄）")

  const mechanical = results.filter((r) => !r.manual)
  const reds = mechanical.filter((r) => !r.ok)
  console.log("")
  console.log("→ 机械闸 " + (mechanical.length - reds.length) + "/" + mechanical.length + " 通过"
    + (reds.length > 0 ? " ；红：" + reds.map((r) => r.id).join(",") : " ；G7 仍需人眼核验"))
  process.exitCode = exitCodeOf(results) // 与 fixture 态断言**同一实现**（F1：结果数组即权威）
}

// 被 import 时（`test/release-check.test.mjs`）**不执行**；直接跑时才执行。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
