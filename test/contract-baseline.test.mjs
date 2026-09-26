// contract-baseline.test.mjs — 批 28：契约面基线档的机验锚（设计档 docs/dsh017-batch28-design.md
// §2.2/§2.3 · §5.1 锚 A28-1…A28-5 · 决策 D28-2/D28-6/D28-7）。
//
// 五条锚各可独立转红：
//   A28-1 注入「与基线一致」的版本 ⇒ 哨兵 match 且**零告警**（装配零干扰）
//   A28-2 注入「不一致」的版本 ⇒ 恰**一条响亮告警** + 不阻断 + 文案含基线档与 docs/dsh017- 字样；
//         提示落点**钉死工具描述**（lib/index.mjs 的 contractWatch description——评审 #8）
//   A28-3 三源皆不可得 ⇒ 标 unknown + 告警 + **不崩**；三源钉死顺序与来源 evidence 逐级可查
//   A28-4 contractWatch 返回形状稳定：{ platformVersion, versionSource,
//         locks = 9 条 { id, ok: true|false|"unknown", evidence }, jobsDir = { files, bytes, oldestDays } }
//   A28-5 静态锁：九条谓词在测试与工具间**同源**——实现标记 grep 唯一，不存在第二份字面
// 附加腿：D28-7 三态（取不到文本记 "unknown" 而非 false，且谓词判别力可独立转红）·
//         jobsDirStats 只读盘点（目录缺失 ⇒ 全零且**不建目录**）· 基线常量形状。
// 纪律：零网络、零真实 LLM、零子进程；隔离契约 process.env.DSH_HOME = ""（对齐既有测试档）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  readPlatformVersion, evaluateVersionSentinel, runVersionSentinel, resetVersionSentinelWarnForTests,
  evaluatePlatformSurfaceLocks, LOCK_IDS, REGISTRATION_SURFACE_BASELINE,
  PLATFORM_VERSION_BASELINE, BASELINE_RECORDED_AT, VERSION_SOURCES, jobsDirStats,
} from "../lib/contract-baseline.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const LIB = (f) => join(PLUGIN_DIR, "lib", f)
// 隔离契约（对齐既有测试档）：空串 = 显式无 env → 只走 override 临时目录。
process.env.DSH_HOME = ""

const mkTemp = (tag) => mkdtempSync(join(tmpdir(), "thincoder-b28-" + tag + "-"))
const rmTemp = (h) => { try { rmSync(h, { recursive: true, force: true }) } catch { /* 已清理 */ } }
const countOccurrences = (hay, needle) => hay.split(needle).length - 1

// ═════════ A28-1：一致 ⇒ 零告警（AC-1） ═════════

test("A28-1: 注入与基线一致的版本 ⇒ 哨兵 match、warnings 为空；装配入口同样静默", () => {
  const empty = mkTemp("empty")
  try {
    const opts = { dshHomeOverride: empty, resolveCorePackage: () => null }
    const r = evaluateVersionSentinel({ pkg: { version: PLATFORM_VERSION_BASELINE } }, opts)
    assert.equal(r.status, "match", "与基线一致 ⇒ match")
    assert.deepEqual(r.warnings, [], "一致 ⇒ 零告警（装配零干扰）")
    assert.equal(r.source, "ctx.pkg", "来源 = 宿主注入")
    assert.ok(r.evidence.includes("ctx.pkg"), "来源 evidence 在场：" + r.evidence)
    // 装配入口（runVersionSentinel）在 match 分支不打印、不消耗 once 标记
    const collected = []
    resetVersionSentinelWarnForTests()
    const r2 = runVersionSentinel({ pkg: { version: PLATFORM_VERSION_BASELINE } }, { ...opts, warn: (...a) => collected.push(a.join(" ")) })
    assert.equal(r2.status, "match")
    assert.equal(collected.length, 0, "match ⇒ 零打印")
  } finally { rmTemp(empty) }
})

// ═════════ A28-2：不一致 ⇒ 一条响亮告警 + 不阻断 + 文案含基线/dsh017- 字样（AC-1） ═════════

test("A28-2: 注入不一致版本 ⇒ 恰一条响亮告警（点名检测值与基线值、含 contract-baseline 与 dsh017- 字样）+ 不阻断；提示落点钉死工具描述", () => {
  const empty = mkTemp("empty")
  try {
    const opts = { dshHomeOverride: empty, resolveCorePackage: () => null }
    const FAKE = "9.9.9-not-a-platform"
    const r = evaluateVersionSentinel({ pkg: { version: FAKE } }, opts)
    assert.equal(r.status, "mismatch")
    assert.equal(r.warnings.length, 1, "不一致 ⇒ 恰一条告警（实测 " + r.warnings.length + "）")
    const w = r.warnings[0]
    assert.ok(w.includes(FAKE), "响亮 = 点名检测值")
    assert.ok(w.includes(PLATFORM_VERSION_BASELINE), "响亮 = 点名基线值")
    assert.ok(w.includes("contract-baseline"), "文案含基线档字样（lib/contract-baseline.mjs）")
    assert.ok(w.includes("dsh017-"), "文案含 docs/dsh017- 设计档字样（A28-2 主判据）")
    assert.ok(w.includes("只警告不阻断"), "不阻断声明在场（D28-1）")
    // 不阻断 = 判定与装配入口都正常返回结构化结果、绝不抛
    const collected = []
    resetVersionSentinelWarnForTests()
    const r2 = runVersionSentinel({ pkg: { version: FAKE } }, { ...opts, warn: (...a) => collected.push(a.join(" ")) })
    assert.equal(r2.status, "mismatch")
    assert.equal(collected.length, 1, "装配入口恰印一条（实测 " + collected.length + "）")
    // 提示落点**钉死工具描述**（A28-2 评审 #8）：lib/index.mjs 的 contractWatch description
    const indexSrc = readFileSync(LIB("index.mjs"), "utf8")
    const iTool = indexSrc.indexOf("name: \"contractWatch\"")
    assert.ok(iTool > 0, "contractWatch 注册点可定位")
    const desc = indexSrc.slice(iTool, indexSrc.indexOf("parameters:", iTool))
    assert.ok(desc.includes("contract-baseline"), "工具描述指向基线档（提示落点 = 工具描述）")
    assert.ok(desc.includes("dsh017-"), "工具描述指向 docs/dsh017- 设计档")
    // 基线版本的**点名**经导入常量注入（单一事实源：基线改值时描述自动跟随）——
    // 静态断言只看源码字节，故此处检查对常量的引用而非渲染后的值
    assert.ok(desc.includes("PLATFORM_VERSION_BASELINE"), "工具描述引用基线版本常量（运行时渲染出实际值）")
    assert.ok(desc.includes("BASELINE_RECORDED_AT"), "工具描述引用基线时点常量")
  } finally { rmTemp(empty) }
})

// ═════════ A28-3：三源皆不可得 ⇒ unknown + 告警 + 不崩；钉死顺序逐级可查（AC-1） ═════════

test("A28-3: 三源皆不可得 ⇒ 标 unknown + 告警 + 不崩；读取链按 ①ctx.pkg → ②profile manifest → ③包版本 钉死顺序", () => {
  const empty = mkTemp("empty")
  const home = mkTemp("manifest")
  try {
    // ① 三源皆不可得：无 ctx.pkg + 空 home（无 manifest）+ 源③恒 null
    const r = readPlatformVersion({}, { dshHomeOverride: empty, resolveCorePackage: () => null })
    assert.equal(r.version, "unknown", "取不到 ⇒ 标 unknown（不猜）")
    assert.equal(r.source, "unknown")
    assert.ok(r.evidence.length > 0, "unknown 同样带 evidence（说明缺了哪些源）")
    const s = evaluateVersionSentinel({}, { dshHomeOverride: empty, resolveCorePackage: () => null })
    assert.equal(s.status, "unknown")
    assert.equal(s.warnings.length, 1, "unknown ⇒ 告警（A28-3）")
    assert.ok(s.warnings[0].includes("unknown"), "告警点名 unknown")
    assert.ok(s.warnings[0].includes("contract-baseline") && s.warnings[0].includes("dsh017-"), "unknown 分支同样指向基线与设计档")
    // 不崩 = 走到这里即证（判定正常返回、零异常）
    // ② 钉死顺序：ctx.pkg 缺席时下探 profile manifest 的 dsh 依赖声明
    writeFileSync(join(home, "package.json"),
      JSON.stringify({ dependencies: { "@deepseek-ai/dsh-core": "^" + PLATFORM_VERSION_BASELINE } }), "utf8")
    const viaManifest = readPlatformVersion({}, { dshHomeOverride: home, resolveCorePackage: () => null })
    assert.equal(viaManifest.source, "profile-manifest")
    assert.equal(viaManifest.version, PLATFORM_VERSION_BASELINE, "范围符剥除后可比（^0.1.7-rc.2 → 0.1.7-rc.2）")
    assert.ok(viaManifest.evidence.includes("package.json"), "evidence 记 manifest 出处：" + viaManifest.evidence)
    // ③ 钉死顺序：① 永远先于 ②——ctx.pkg 在场时 manifest 不被消费
    const viaCtx = readPlatformVersion({ pkg: { version: "0.0.1-ctx-first" } }, { dshHomeOverride: home, resolveCorePackage: () => null })
    assert.equal(viaCtx.source, "ctx.pkg")
    assert.equal(viaCtx.version, "0.0.1-ctx-first")
  } finally { rmTemp(empty); rmTemp(home) }
})

// ═════════ A28-4：contractWatch 返回形状稳定（AC-2） ═════════

test("A28-4: contractWatch 返回 {platformVersion, versionSource, locks=9×{id,ok,evidence}(ok 三态), jobsDir}——形状钉死", async () => {
  const { apply } = await import("../lib/index.mjs")
  const registered = []
  const fakeCtx = {
    pkg: { version: PLATFORM_VERSION_BASELINE }, // 哨兵静默（A28-1 分支）+ 巡检版本来源钉死为 ctx.pkg
    on: () => () => {},
    effect: (fn) => { const d = fn?.(); return () => d?.() },
    systemPrompt: { section: () => () => {} },
    tools: { register: (t) => { registered.push(t); return () => {} } },
    get: () => null,
  }
  apply(fakeCtx, {})
  const tool = registered.find((t) => t.name === "contractWatch")
  assert.ok(tool, "apply() 注册了 contractWatch")
  const out = JSON.parse(await tool.execute({}, {}))
  assert.deepEqual(Object.keys(out).sort(), ["jobsDir", "locks", "platformVersion", "versionSource"], "顶层形状钉死（恰四键）")
  assert.equal(out.platformVersion, PLATFORM_VERSION_BASELINE)
  assert.equal(out.versionSource, "ctx.pkg")
  assert.ok(VERSION_SOURCES.includes(out.versionSource), "versionSource ∈ 钉死枚举")
  assert.equal(out.locks.length, 9, "locks 恒 9 条（实测 " + out.locks.length + "）")
  assert.deepEqual(out.locks.map((l) => l.id), [...LOCK_IDS], "id 集合与顺序 = LOCK_IDS")
  for (const l of out.locks) {
    assert.deepEqual(Object.keys(l).sort(), ["evidence", "id", "ok"], "每条形如 { id, ok, evidence }：" + JSON.stringify(Object.keys(l)))
    assert.ok(l.ok === true || l.ok === false || l.ok === "unknown", "ok 三态（true/false/\"unknown\"）：实测 " + String(l.ok))
    assert.equal(typeof l.evidence, "string")
    assert.ok(l.evidence.length > 0, "evidence 非空（读自哪个文件/为何转红）：" + l.id)
  }
  assert.deepEqual(Object.keys(out.jobsDir).sort(), ["bytes", "files", "oldestDays"], "jobsDir = { files, bytes, oldestDays }")
  for (const k of ["files", "bytes", "oldestDays"]) assert.equal(typeof out.jobsDir[k], "number", "jobsDir." + k + " 为数值")
})

// ═════════ A28-5：静态同源锁——不存在第二份字面（AC-3） ═════════

test("A28-5: 九条谓词实现 grep 唯一（lib/contract-baseline.mjs）；测试档与 index.mjs 均 import 而非复刻", () => {
  const baselineSrc = readFileSync(LIB("contract-baseline.mjs"), "utf8")
  const psSrc = readFileSync(join(PLUGIN_DIR, "test", "platform-surface.test.mjs"), "utf8")
  const indexSrc = readFileSync(LIB("index.mjs"), "utf8")
  // ① 谓词实现（两个 helper + 九个 lockPsN 定义）只活在基线档，且各恰一份
  // ★ 标记**拼装**（"function " + 名字 + "("）——避免本档自身成为命中源（T-CB8 的既有先例同款）
  const fnMarker = (name) => "function " + name + "("
  const markers = [
    fnMarker("objectEnd"),
    fnMarker("collectKeys"),
    ...LOCK_IDS.map((_v, i) => fnMarker("lockPs" + (i + 1))),
  ]
  for (const m of markers) {
    assert.equal(countOccurrences(baselineSrc, m), 1, "实现恰一份（基线档）：" + m)
    assert.equal(countOccurrences(psSrc, m), 0, "测试档不得留第二份谓词字面：" + m)
    assert.equal(countOccurrences(indexSrc, m), 0, "工具档不得留第二份谓词字面：" + m)
  }
  // ② 消费侧是 import，不是复刻
  assert.ok(psSrc.includes("from \"../lib/contract-baseline.mjs\""), "platform-surface.test.mjs import 基线档")
  assert.ok(indexSrc.includes("from \"./contract-baseline.mjs\""), "index.mjs import 基线档")
  // ③ 全仓唯一性（lib/ + test/ 的全部 .mjs——防未来任何第三处复刻）
  const walk = (dir) => {
    const out = []
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) out.push(...walk(p))
      else if (e.endsWith(".mjs")) out.push(p)
    }
    return out
  }
  const all = [...walk(join(PLUGIN_DIR, "lib")), ...walk(join(PLUGIN_DIR, "test"))]
  assert.ok(all.length >= 20, "扫描面非空（实测 " + all.length + " 档）")
  for (const m of markers) {
    const hits = all.filter((f) => countOccurrences(readFileSync(f, "utf8"), m) > 0)
    assert.deepEqual(hits, [join(PLUGIN_DIR, "lib", "contract-baseline.mjs")],
      "实现标记全仓唯一（命中面必须恰为基线档）：" + m + " → " + JSON.stringify(hits.map((h) => h.split(/[\\/]/).slice(-2).join("/"))))
  }
  // ④ 求值顺序与 id 枚举一致（unknown 注入态下 id 仍全数在位）
  const ids = evaluatePlatformSurfaceLocks({ readText: () => null, listFiles: () => [] }).map((l) => l.id)
  assert.deepEqual(ids, [...LOCK_IDS])
})

// ═════════ D28-7：谓词三态（unknown 而非 false）+ 判别力自证 ═════════

test("D28-7: 取不到源文本 ⇒ ok=\"unknown\"（而非 false）；塞回旧形状 ⇒ 该条立红（谓词可独立转红）", () => {
  // ① 全部不可读 ⇒ 九条全 unknown，evidence 说明原因
  const unknown = evaluatePlatformSurfaceLocks({ readText: () => null, listFiles: () => [] })
  assert.equal(unknown.length, 9)
  for (const l of unknown) {
    assert.equal(l.ok, "unknown", l.id + " 取不到文本 ⇒ unknown（D28-7）")
    assert.ok(l.evidence.includes("unknown"), "evidence 说明未知原因：" + l.id)
  }
  // ② 判别力自证（防恒 unknown 退化）：advisor.mjs 塞回 0.1.6 旧形状 ⇒ ps1 立 red、其余仍 unknown
  const fakeAdvisor = "role: \"tool\",\nrole: \"tool\",\ntype: \"tool-result\""
  const mixed = evaluatePlatformSurfaceLocks({
    readText: (f) => (f === "advisor.mjs" ? fakeAdvisor : null),
    listFiles: () => [],
  })
  const ps1 = mixed.find((l) => l.id === LOCK_IDS[0])
  assert.equal(ps1.ok, false, "旧形状在场 ⇒ ps1 立红")
  assert.ok(ps1.evidence.length > 0, "转红 evidence 指明违规点：" + ps1.evidence.slice(0, 80))
  assert.ok(mixed.filter((l) => l.ok === "unknown").length === 8, "其余取不到文本的条目仍如实 unknown")
})

// ═════════ jobsDirStats：只读盘点（US-3 的 jobsDir 腿） ═════════

test("jobsDirStats: 目录缺失 ⇒ 全零且不建目录；有文件 ⇒ { files, bytes, oldestDays } 如实盘点", () => {
  const home = mkTemp("jobs")
  try {
    assert.deepEqual(jobsDirStats({ dshHomeOverride: home }), { files: 0, bytes: 0, oldestDays: 0 }, "目录缺失 ⇒ 全零")
    assert.ok(!existsSync(join(home, ".thincoder")), "只读：巡检不建目录、不写盘")
    const dir = join(home, ".thincoder", "jobs")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "advisor-dsh-1.txt"), "abc", "utf8")
    writeFileSync(join(dir, "index.jsonl"), "de", "utf8")
    const fourDaysAgo = new Date(Date.now() - 4 * 86400000)
    utimesSync(join(dir, "advisor-dsh-1.txt"), fourDaysAgo, fourDaysAgo)
    const st = jobsDirStats({ dshHomeOverride: home })
    assert.equal(st.files, 2, "普通文件计数（含 index.jsonl）")
    assert.equal(st.bytes, 5, "字节总和")
    assert.ok(st.oldestDays >= 3 && st.oldestDays <= 5, "最旧龄 ≈ 4 天：" + st.oldestDays)
  } finally { rmTemp(home) }
})

// ═════════ 基线常量形状（哨兵文案与 #7 基线的可读性前提） ═════════

test("基线常量: 版本非空且 recorded-at 为 ISO 日期；来源枚举钉死；注册面基线 = 批 28 上调值（D28-6）", () => {
  assert.equal(typeof PLATFORM_VERSION_BASELINE, "string")
  assert.ok(PLATFORM_VERSION_BASELINE.length > 0)
  assert.match(BASELINE_RECORDED_AT, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual([...VERSION_SOURCES], ["ctx.pkg", "profile-manifest", "package-json", "unknown"])
  assert.deepEqual(REGISTRATION_SURFACE_BASELINE, { toolsRegister: 1, systemPromptSection: 3, textTool: 8 },
    "#7 基线 = 批 28 上调值（textTool 7→8：contractWatch，D28-6；上调登记见 REGISTRATION_SURFACE_BASELINE 注释）")
})

// ═════════ A29-6（批 29 单② / US-4 🔵④⑤⑥）：源②键过滤化简 · once 标记的共用语义 · 版本词元大小写 ═════════

test("A29-6④ (US-4 🔵④): 源②键过滤化简为单一前缀判据——行为不变（core 优先 / 非 core 前缀键仍可达）", () => {
  const src = readFileSync(LIB("contract-baseline.mjs"), "utf8")
  // 只看**代码**（注释里保留旧写法作对照不算命中——锁的是实现，不是散文）
  const codeOnly = src.split(/\r?\n/).filter((l) => {
    const t = l.trim()
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
  }).join("\n")
  assert.ok(codeOnly.includes('filter((k) => k.startsWith("@deepseek-ai/dsh"))'),
    "键过滤 = 单一前缀判据（源码字节级）")
  assert.ok(!codeOnly.includes('k !== "@deepseek-ai/dsh-core"'),
    "冗余分支必须已从**代码**删除（化简后集合恒等）")
  // 行为不变（化简前后集合恒等）：① core 在场 ⇒ 优先取 core；② 只有非 core 前缀键 ⇒ 仍可达
  const home = mkTemp("keys")
  try {
    writeFileSync(join(home, "package.json"), JSON.stringify({ dependencies: {
      "@deepseek-ai/dsh-skew": "^" + PLATFORM_VERSION_BASELINE,
      "@deepseek-ai/dsh-core": "^" + PLATFORM_VERSION_BASELINE,
    } }), "utf8")
    const both = readPlatformVersion({}, { dshHomeOverride: home, resolveCorePackage: () => null })
    assert.equal(both.source, "profile-manifest", "② 命中 manifest")
    assert.ok(both.evidence.includes("@deepseek-ai/dsh-core@"), "core 在场 ⇒ 优先取 core：" + both.evidence)
    assert.equal(both.version, PLATFORM_VERSION_BASELINE, "范围符剥除后可比")
    // ② 只有非 core 前缀键（本机实测的 rc.1/rc.2 混杂形态）⇒ 化简后仍然可达
    writeFileSync(join(home, "package.json"), JSON.stringify({ dependencies: {
      "@deepseek-ai/dsh-skew": "^" + PLATFORM_VERSION_BASELINE,
    } }), "utf8")
    const skew = readPlatformVersion({}, { dshHomeOverride: home, resolveCorePackage: () => null })
    assert.equal(skew.source, "profile-manifest", "非 core 前缀键仍被接受")
    assert.ok(skew.evidence.includes("@deepseek-ai/dsh-skew@"), "取的是该前缀键：" + skew.evidence)
    assert.equal(skew.version, PLATFORM_VERSION_BASELINE)
    // 无任何 dsh 键 ⇒ 仍不可得（不猜）
    writeFileSync(join(home, "package.json"), JSON.stringify({ dependencies: { "lodash": "^4" } }), "utf8")
    const none = readPlatformVersion({}, { dshHomeOverride: home, resolveCorePackage: () => null })
    assert.equal(none.source, "unknown", "无 dsh 键 ⇒ 不可得（不猜）")
  } finally { rmTemp(home) }
})

test("A29-6⑤⑥ (US-4 🔵⑤⑥): once 标记两形态共用（注释 + 行为）· 版本词元大小写等价（match 仍须真等价）", () => {
  const src = readFileSync(LIB("contract-baseline.mjs"), "utf8")
  // ⑤ 注释到场：`unknown` 与 `mismatch` **共用** ⇒ 首个 unknown 会占坑
  assert.ok(src.includes("首个 unknown 会占坑"), "once 标记的共用语义必须写明（🔵⑤）")
  assert.ok(src.includes("`unknown` 与 `mismatch` **共用**"), "点名两形态共用同一闩")
  // ⑤ 行为腿：先 unknown（占坑）⇒ 随后的 mismatch **不再响**（闩是共用的，不是每形态一个）
  const home = mkTemp("once")
  try {
    const seen = []
    const opts = { dshHomeOverride: home, resolveCorePackage: () => null, warn: (...a) => seen.push(a.join(" ")) }
    resetVersionSentinelWarnForTests()
    const r1 = runVersionSentinel({}, opts)
    assert.equal(r1.status, "unknown", "前提：第一场取不到版本 ⇒ unknown")
    const r2 = runVersionSentinel({ pkg: { version: "9.9.9-not-a-platform" } }, opts)
    assert.equal(r2.status, "mismatch", "前提：第二场是真 mismatch")
    assert.equal(seen.length, 1, "闩为两形态共用：首个 unknown 占坑后 mismatch 不再响（实测 " + seen.length + " 条）")
    assert.ok(String(seen[0]).includes("unknown"), "占坑的那一句是先到的 unknown：" + String(seen[0]).slice(0, 80))
  } finally { resetVersionSentinelWarnForTests(); rmTemp(home) }
  // ⑥ 大小写等价：混合大小写词元必须与基线**等价**（不再误报 mismatch —— 旧行为是稳定假阳性）
  const home2 = mkTemp("case")
  try {
    const opts = { dshHomeOverride: home2, resolveCorePackage: () => null }
    const mixed = evaluateVersionSentinel({ pkg: { version: "0.1.7-RC.2" } }, opts)
    assert.equal(mixed.status, "match", "0.1.7-RC.2 与基线 0.1.7-rc.2 等价（🔵⑥）：" + JSON.stringify(mixed))
    assert.deepEqual(mixed.warnings, [], "等价 ⇒ 零告警（不再稳定假阳性）")
    const upperV = evaluateVersionSentinel({ pkg: { version: "V0.1.7-RC.2" } }, opts)
    assert.equal(upperV.status, "match", "大写 V 前缀同样被剥（先归一再剥符号）")
    // 反例自证：真不同的版本仍必须 mismatch（大小写归一没有退化成「恒 match」）
    const real = evaluateVersionSentinel({ pkg: { version: "0.1.7-rc.3" } }, opts)
    assert.equal(real.status, "mismatch", "真不同的版本仍 mismatch（谓词未被削弱）")
    assert.equal(real.warnings.length, 1, "mismatch 仍恰一条告警")
  } finally { rmTemp(home2) }
})

