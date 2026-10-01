// contract-baseline.test.mjs — 批 28：契约面基线档的机验锚（设计档 docs/dsh017-batch28-design.md
// §2.2/§2.3 · §5.1 锚 A28-1…A28-5 · 决策 D28-2/D28-6/D28-7）。
//
// 五条锚各可独立转红：
//   A28-1 注入「与基线一致」的版本 ⇒ 哨兵 match 且**零告警**（装配零干扰）
//   A28-2 注入「不一致」的版本 ⇒ 恰**一条响亮告警** + 不阻断 + 文案含基线档与 docs/dsh017- 字样；
//         提示落点**钉死工具描述**（lib/index.mjs 的 contractWatch description——评审 #8）
//   A28-3 四源皆不可得 ⇒ 标 unknown + 告警 + **不崩**；四源钉死顺序与来源 evidence 逐级可查
//   ★ 批 31 扩源：源③ pluginManager（平台服务报告的平台组合包版本）与源④ 平台包解析——本档新增
//     它们的**判别力**腿（含「用户侧同前缀包不得被当平台包」的假阳性负控），全部并入既有 test( 块
//     （顶层用例数不变 ⇒ 台账 docs/test-lifecycle.md §三 逐格仍一致，与批 30 的先例同款）。
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
    const opts = { dshHomeOverride: empty, resolvePlatformPackage: () => null }
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
    const opts = { dshHomeOverride: empty, resolvePlatformPackage: () => null }
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

// ═════════ A28-3：四源皆不可得 ⇒ unknown + 告警 + 不崩；钉死顺序逐级可查（AC-1；批 31 扩源） ═════════

test("A28-3: 四源皆不可得 ⇒ 标 unknown + 告警 + 不崩；读取链按 ①ctx.pkg → ②profile manifest → ③pluginManager → ④平台包 钉死顺序", () => {
  const empty = mkTemp("empty")
  const home = mkTemp("manifest")
  try {
    // ① 四源皆不可得：无 ctx.pkg + 空 home（无 manifest）+ ctx.get 缺席（源③ 不适用）+ 源④恒 null
    const r = readPlatformVersion({}, { dshHomeOverride: empty, resolvePlatformPackage: () => null })
    assert.equal(r.version, "unknown", "取不到 ⇒ 标 unknown（不猜）")
    assert.equal(r.source, "unknown")
    assert.ok(r.evidence.length > 0, "unknown 同样带 evidence（说明缺了哪些源）")
    const s = evaluateVersionSentinel({}, { dshHomeOverride: empty, resolvePlatformPackage: () => null })
    assert.equal(s.status, "unknown")
    assert.equal(s.warnings.length, 1, "unknown ⇒ 告警（A28-3）")
    assert.ok(s.warnings[0].includes("unknown"), "告警点名 unknown")
    assert.ok(s.warnings[0].includes("contract-baseline") && s.warnings[0].includes("dsh017-"), "unknown 分支同样指向基线与设计档")
    // 不崩 = 走到这里即证（判定正常返回、零异常）
    // ② 钉死顺序：ctx.pkg 缺席时下探 profile manifest 的 dsh 依赖声明
    writeFileSync(join(home, "package.json"),
      JSON.stringify({ dependencies: { "@deepseek-ai/dsh-core": "^" + PLATFORM_VERSION_BASELINE } }), "utf8")
    const viaManifest = readPlatformVersion({}, { dshHomeOverride: home, resolvePlatformPackage: () => null })
    assert.equal(viaManifest.source, "profile-manifest")
    assert.equal(viaManifest.version, PLATFORM_VERSION_BASELINE, "范围符剥除后可比（^<基线> → <基线>，不写死版本号以免每次抬基线失同步）")
    assert.ok(viaManifest.evidence.includes("package.json"), "evidence 记 manifest 出处：" + viaManifest.evidence)
    // ③ 钉死顺序：① 永远先于 ②——ctx.pkg 在场时 manifest 不被消费
    const viaCtx = readPlatformVersion({ pkg: { version: "0.0.1-ctx-first" } }, { dshHomeOverride: home, resolvePlatformPackage: () => null })
    assert.equal(viaCtx.source, "ctx.pkg")
    assert.equal(viaCtx.version, "0.0.1-ctx-first")
    // ★ 批 31 新腿（源③ pluginManager；空 home ⇒ ② 不命中，故本腿独立于 ②）：
    //   ③a 平台组合包在场 ⇒ 取它（平台包与安装同版号）
    const fakeGet = (bundles) => ({ get: (name) => (name === "pluginManager" ? { listBundles: () => bundles } : undefined) })
    const viaManager = readPlatformVersion(
      fakeGet([{ name: "@deepseek-ai/dsh-base", version: PLATFORM_VERSION_BASELINE }]),
      { dshHomeOverride: empty, resolvePlatformPackage: () => null })
    assert.equal(viaManager.source, "plugin-manager", "源③ 命中 ⇒ 来源标注 plugin-manager")
    assert.equal(viaManager.version, PLATFORM_VERSION_BASELINE)
    assert.ok(viaManager.evidence.includes("@deepseek-ai/dsh-base@"), "evidence 记平台组合包出处：" + viaManager.evidence)
    //   ③b **假阳性负控**（本源的立项理由）：清单里只有**用户侧**同前缀包时**不得**被当平台包
    //      （本机实测形态：@deepseek-ai/dsh-token-cost@0.1.0 与平台同前缀）
    const userOnly = readPlatformVersion(
      fakeGet([{ name: "@deepseek-ai/dsh-token-cost", version: "0.1.0" }, { name: "dsh-undo-savepoint", version: "0.4.9" }]),
      { dshHomeOverride: empty, resolvePlatformPackage: () => null })
    assert.equal(userOnly.source, "unknown", "用户侧同前缀包不得冒充平台版本（假阳性负控）：" + JSON.stringify(userOnly))
    //   ③c 服务缺席 / 抛错 / 形状意外 ⇒ 逐级下探到源④（而不是崩、也不是假装命中）
    const throwing = { get: () => ({ listBundles: () => { throw new Error("boom") } }) }
    const fellThrough = readPlatformVersion(throwing, { dshHomeOverride: empty, resolvePlatformPackage: () => ({ version: "9.9.9-from-pkg", source: "package-json", evidence: "e" }) })
    assert.equal(fellThrough.source, "package-json", "源③ 抛错 ⇒ 下探源④")
    assert.equal(fellThrough.version, "9.9.9-from-pkg")
    // ④ 钉死顺序：② 先于 ③——manifest 在场时不去问服务
    let asked = false
    const viaManifestFirst = readPlatformVersion(
      { get: (name) => { asked = true; return name === "pluginManager" ? { listBundles: () => [] } : undefined } },
      { dshHomeOverride: home, resolvePlatformPackage: () => null })
    assert.equal(viaManifestFirst.source, "profile-manifest", "② 命中即停")
    assert.equal(asked, false, "② 命中 ⇒ ③ 的服务不得被调用（钉死顺序可查）")
    // ★ 批 31 真机复盘补（D31-2 · 并入本块以保顶层用例数不变）：unknown 时除逐源诊断外，
    //   还要交出**同一时刻的第二读数（旁证）**。动因是真机 2026-09-30 00:16 那次：四源里唯一
    //   能命中的源④a 读的是 app.asar，而它在平台换代时被**整体替换**（当前这份的 CreationTime
    //   是 00:14:38，新建而非原地改）⇒ 哨兵恰好在最该响的时刻瞎了，而事后**无从复盘**：装配期
    //   的 warn 只进宿主 stderr（DSH 只在内存里滚动，那次没留下），工具返回体里也没有第二读数。
    //   刻意**不**把旁证做成第五个源：它们会滞后（实测 runtime.json 现在写着 0.1.7-rc.2 时代的
    //   旧值）也会领先 —— 拿它当源等于把「读不到」换成「读错」，哨兵假告警比哨兵瞎更坏。
    const bystanderHome = mkTemp("bystander")
    const bystanderLocal = mkTemp("localappdata")
    const bareLocal = mkTemp("nolocal")
    try {
      const rtDir = join(bystanderHome, "dsh-runtimes", "dsh-primary-runtime")
      mkdirSync(rtDir, { recursive: true })
      writeFileSync(join(rtDir, "runtime.json"), JSON.stringify({ desktopVersion: "0.1.7-rc.2" }), "utf8")
      const updaterDir = join(bystanderLocal, "@deepseek-aidsh-desktop-updater", "pending")
      mkdirSync(updaterDir, { recursive: true })
      writeFileSync(join(updaterDir, "update-info.json"),
        JSON.stringify({ fileName: "deepseek-harness-0.1.7-rc.2-win-x64.exe" }), "utf8")
      // ★ 负控（真机实测逼出来的）：本机 %LOCALAPPDATA% 下**同时**躺着别的 electron-updater
      //   应用的 update-info.json（MiniMax Code / ZCode / Cherry Studio / uTools / NGP…）。第一版
      //   实现只按 `/updater$/` 匹配目录名 ⇒ 那些应用的版本全被刷进 evidence（真机读数当场抓到）。
      //   这一格把那次的形态原样钉住：非 DSH 的 updater 目录**一个字都不许进**。
      //  （计数刻意不写死：那类 `pending\update-info.json` 随安装完成而增减——2026-10-01 复测本机共
      //   6 条、其中 DSH 自己 1 条，与写入时的条数已不同。判据只依赖「非 DSH 不许进」这个不变量。）
      const otherDir = join(bystanderLocal, "cherrystudio-updater", "pending")
      mkdirSync(otherDir, { recursive: true })
      writeFileSync(join(otherDir, "update-info.json"),
        JSON.stringify({ fileName: "Cherry-Studio-2.0.14-win-x64-setup.exe" }), "utf8")
      const withBystander = readPlatformVersion({}, {
        dshHomeOverride: bystanderHome, localAppDataOverride: bystanderLocal, resolvePlatformPackage: () => null })
      // ① 判定面**逐字不变**：旁证在场也仍是 unknown，且绝不是枚举成员
      assert.equal(withBystander.version, "unknown", "旁证在场 ⇒ 仍标 unknown（不猜）")
      assert.equal(withBystander.source, "unknown", "旁证**不是**来源（否则从「读不到」变成「读错」）")
      assert.ok(!VERSION_SOURCES.includes("runtime-manifest"), "旁证不得偷偷混进 VERSION_SOURCES")
      // ② 判读面：两条旁证都进 evidence，且当场定性「不参与判定」
      assert.ok(withBystander.evidence.includes("runtime.json desktopVersion=0.1.7-rc.2"),
        "旁证①（runtime.json 的 desktopVersion）进 evidence：" + withBystander.evidence)
      assert.ok(withBystander.evidence.includes("deepseek-harness-0.1.7-rc.2-win-x64.exe"),
        "旁证②（更新器待装包 fileName）进 evidence：" + withBystander.evidence)
      assert.ok(!withBystander.evidence.includes("Cherry-Studio"),
        "★ 负控：非 DSH 的 updater 目录一个字都不许进（真机第一版就是被这个坑到，六个应用全刷进来）：" + withBystander.evidence)
      assert.ok(withBystander.evidence.includes("不参与判定"), "旁证必须当场定性，免得被读成来源：" + withBystander.evidence)
      assert.ok(withBystander.evidence.includes("逐源诊断"), "逐源诊断与旁证同时在场（A28-4 既有判据不撤）")
      // ③ 「查过、没有」必须与「没查」区分开：两腿都空时如实写出来，而不是留空或编一个
      const noBystander = readPlatformVersion({}, {
        dshHomeOverride: empty, localAppDataOverride: bareLocal, resolvePlatformPackage: () => null })
      assert.equal(noBystander.version, "unknown")
      assert.ok(noBystander.evidence.includes("无运行时目录") || noBystander.evidence.includes("无 dsh 系"),
        "旁证两腿落空 ⇒ 如实说明「查过、没有」：" + noBystander.evidence)
      // ④ 旁证坏档不抛、不影响判定（「旁证永不抛」是它的契约）
      writeFileSync(join(rtDir, "runtime.json"), "{ not json", "utf8")
      const broken = readPlatformVersion({}, {
        dshHomeOverride: bystanderHome, localAppDataOverride: bystanderLocal, resolvePlatformPackage: () => null })
      assert.equal(broken.version, "unknown", "坏旁证不影响判定，也不抛")
      assert.ok(broken.evidence.includes("update-info.json") || broken.evidence.includes("deepseek-harness"),
        "旁证① 坏掉不影响旁证② 仍然交出：" + broken.evidence)
    } finally { rmTemp(bystanderHome); rmTemp(bystanderLocal); rmTemp(bareLocal) }
  } finally { rmTemp(empty); rmTemp(home) }
})

// ═════════ A28-4：contractWatch 返回形状稳定（AC-2） ═════════

test("A28-4: contractWatch 返回 {platformVersion, versionSource, versionEvidence, locks=9×{id,ok,evidence}(ok 三态), jobsDir}——形状钉死", async () => {
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
  // ★ 批 31：形状 4 键 → 5 键（新增 versionEvidence）。理由 = 工具描述自批 28 起就承诺
  //   「shows all nine lock verdicts **plus the version evidence**」，而返回体里从没有 evidence
  //   ⇒ 这次真机读数拿不到版本时，模型**看不到任何失败原因**。补上即闭掉这处「描述 vs 实现」不一致。
  assert.deepEqual(Object.keys(out).sort(), ["jobsDir", "locks", "platformVersion", "versionEvidence", "versionSource"],
    "顶层形状钉死（批 31 起恰五键）")
  assert.equal(out.platformVersion, PLATFORM_VERSION_BASELINE)
  assert.equal(out.versionSource, "ctx.pkg")
  assert.ok(VERSION_SOURCES.includes(out.versionSource), "versionSource ∈ 钉死枚举")
  assert.equal(typeof out.versionEvidence, "string")
  assert.ok(out.versionEvidence.includes("ctx.pkg"), "versionEvidence 给出该值的出处：" + out.versionEvidence)
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
  // ★ 批 31 反向腿：versionEvidence 必须**真的**是逐源诊断，不是常量串——空 ctx（无 pkg、无服务）
  //   下取 unknown，且 evidence 必须点名每一个源与逐源原因（否则「补上 evidence」只是换个地方看不见）
  const outUnknown = JSON.parse(await (async () => {
    const registered2 = []
    const bare = { on: () => () => {}, effect: (fn) => { const d = fn?.(); return () => d?.() },
      systemPrompt: { section: () => () => {} }, tools: { register: (t) => { registered2.push(t); return () => {} } }, get: () => null }
    apply(bare, {})
    return registered2.find((t) => t.name === "contractWatch").execute({}, {})
  })())
  assert.equal(outUnknown.platformVersion, "unknown")
  for (const marker of ["ctx.pkg", "profile manifest", "pluginManager", "平台包解析", "逐源诊断"]) {
    assert.ok(outUnknown.versionEvidence.includes(marker), "unknown 的 versionEvidence 必须含「" + marker + "」：" + outUnknown.versionEvidence)
  }
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
  assert.deepEqual([...VERSION_SOURCES], ["ctx.pkg", "profile-manifest", "plugin-manager", "package-json", "unknown"],
    "来源枚举 = 批 31 扩源后的四源 + unknown（顺序即读取链的钉死顺序）")
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
    const both = readPlatformVersion({}, { dshHomeOverride: home, resolvePlatformPackage: () => null })
    assert.equal(both.source, "profile-manifest", "② 命中 manifest")
    assert.ok(both.evidence.includes("@deepseek-ai/dsh-core@"), "core 在场 ⇒ 优先取 core：" + both.evidence)
    assert.equal(both.version, PLATFORM_VERSION_BASELINE, "范围符剥除后可比")
    // ② 只有非 core 前缀键（本机实测的 rc.1/rc.2 混杂形态）⇒ 化简后仍然可达
    writeFileSync(join(home, "package.json"), JSON.stringify({ dependencies: {
      "@deepseek-ai/dsh-skew": "^" + PLATFORM_VERSION_BASELINE,
    } }), "utf8")
    const skew = readPlatformVersion({}, { dshHomeOverride: home, resolvePlatformPackage: () => null })
    assert.equal(skew.source, "profile-manifest", "非 core 前缀键仍被接受")
    assert.ok(skew.evidence.includes("@deepseek-ai/dsh-skew@"), "取的是该前缀键：" + skew.evidence)
    assert.equal(skew.version, PLATFORM_VERSION_BASELINE)
    // ★ 批 31 评审 #2（🔵）：非版本权威键 ⇒ evidence 打 skew 标记（判据面不变，只让假告警当场可辨）；
    //   权威键（core）则**不得**带该标记——两个方向都钉住，防标记退化成恒真/恒假
    assert.ok(skew.evidence.includes("非版本权威键"), "非权威键的 evidence 带 skew 标记：" + skew.evidence)
    assert.ok(!both.evidence.includes("非版本权威键"), "权威键（core）不得带 skew 标记：" + both.evidence)
    // 无任何 dsh 键 ⇒ 仍不可得（不猜）
    writeFileSync(join(home, "package.json"), JSON.stringify({ dependencies: { "lodash": "^4" } }), "utf8")
    const none = readPlatformVersion({}, { dshHomeOverride: home, resolvePlatformPackage: () => null })
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
    const opts = { dshHomeOverride: home, resolvePlatformPackage: () => null, warn: (...a) => seen.push(a.join(" ")) }
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
    const opts = { dshHomeOverride: home2, resolvePlatformPackage: () => null }
    // ★ 批 31：改用**基线自己**的大小写变体（原写死 0.1.7-RC.2——那会让本腿在每次抬基线时静默失同步）
    const UPPER = PLATFORM_VERSION_BASELINE.toUpperCase()
    const mixed = evaluateVersionSentinel({ pkg: { version: UPPER } }, opts)
    assert.equal(mixed.status, "match", UPPER + " 与基线 " + PLATFORM_VERSION_BASELINE + " 等价（🔵⑥）：" + JSON.stringify(mixed))
    assert.deepEqual(mixed.warnings, [], "等价 ⇒ 零告警（不再稳定假阳性）")
    const upperV = evaluateVersionSentinel({ pkg: { version: "V" + UPPER } }, opts)
    assert.equal(upperV.status, "match", "大写 V 前缀同样被剥（先归一再剥符号）")
    // 反例自证：真不同的版本仍必须 mismatch（大小写归一没有退化成「恒 match」）
    const real = evaluateVersionSentinel({ pkg: { version: "9.9.9-different" } }, opts)
    assert.equal(real.status, "mismatch", "真不同的版本仍 mismatch（谓词未被削弱）")
    assert.equal(real.warnings.length, 1, "mismatch 仍恰一条告警")
  } finally { rmTemp(home2) }
})

