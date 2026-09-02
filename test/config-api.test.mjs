// config-api.test.mjs — 二期设置页 host 侧单元测试（docs/2026-09-02-settings-ui-design.md §5，U2/U3/U5/U6/U7/U8）。
// node:test 零依赖。临时 DSH_HOME（dshHomeOverride 注入缝）做 config-store 落盘，不碰真实
// $DSH_HOME/.thincoder/config.json。
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  mergeGlobalConfig, effectiveGlobalConfig,
  loadUserConfig, saveUserConfig, clearUserConfig, resolveConfigStorePath,
} from "../lib/config-store.mjs"
import {
  validateGlobalUserConfig, applySessionOverride, resetSessionOverride,
  sanitizeSessionAdvisor, describeSessionView, registerConfigApi, CONFIG_API_PREFIX,
} from "../lib/index.mjs"
import { resolveAdvisorRoute } from "../lib/advisor.mjs"

const mkHome = () => mkdtempSync(join(tmpdir(), "thincoder-cfg-"))
const rmHome = (h) => { try { rmSync(h, { recursive: true, force: true }) } catch { /* 已清理 */ } }

// 屏蔽宿主 DSH_HOME（本机指向真实 profile）：本文件全部走显式 dshHomeOverride/临时目录，
// 避免真实 user 层（config.json）污染 effectiveGlobalConfig 相关断言。进程内生效。
process.env.DSH_HOME = ""

/** 会话 stub 集：known = 已知 sessionId 集合；stateOf 返回普通可变对象（记录调用次数）。 */
function sessionStubs(knownIds) {
  const states = new Map()
  const known = new Set(knownIds.map(String))
  const stubs = {
    sessionExists: (id) => known.has(String(id)),
    stateOf: (id) => {
      stubs.stateOfCalls.push(String(id))
      const key = String(id)
      if (!states.has(key)) states.set(key, { advisorOverride: null })
      return states.get(key)
    },
    stateOfCalls: [],
    getState: (id) => states.get(String(id)),
    agentOptionsOf: () => ({}),
    baseConfig: {},
    cwdHint: undefined,
  }
  return stubs
}

// ————————————— U2/U6：config-store save/clear/merge/损坏容错 —————————————

test("U2a: saveUserConfig writes versioned file; loadUserConfig roundtrips", () => {
  const home = mkHome()
  try {
    const cfg = { advisor: { round1: { provider: "qax", model: "glm-5.3" } }, consultModels: [{ provider: "qax", model: "glm-5.3" }] }
    assert.equal(saveUserConfig(cfg, home), true)
    const path = resolveConfigStorePath(home)
    assert.ok(path && existsSync(path))
    const file = JSON.parse(readFileSync(path, "utf8"))
    assert.equal(file.version, 1)
    assert.deepEqual(file.config, cfg)
    assert.deepEqual(loadUserConfig(home), cfg)
  } finally { rmHome(home) }
})

test("U2b: saveUserConfig mkdir recursive (parent dir not pre-created) + clearUserConfig removes", () => {
  const root = mkHome()
  const home = join(root, "deep", "nested") // 父目录不预创建——验证 mkdirSync recursive
  try {
    const cfg = { advisor: { includeProjectGuide: true } }
    assert.equal(saveUserConfig(cfg, home), true)
    assert.deepEqual(loadUserConfig(home), cfg)
    assert.equal(clearUserConfig(home), true)
    assert.ok(!existsSync(resolveConfigStorePath(home)), "file removed after clear")
    assert.equal(loadUserConfig(home), null, "cleared → no user layer")
    assert.equal(clearUserConfig(home), true, "clear on missing file is a no-op success")
  } finally { rmHome(root) }
})

test("U6a: corrupt / missing / non-object config file → loadUserConfig null (no crash, falls back to base)", () => {
  const home = mkHome()
  try {
    // 缺失 → null
    assert.equal(loadUserConfig(home), null)
    // 损坏（非 JSON）→ null
    mkdirSync(join(home, ".thincoder"), { recursive: true })
    writeFileSync(resolveConfigStorePath(home), "{ not json !!!")
    assert.equal(loadUserConfig(home), null)
    // JSON 但非对象 / config 非对象 → null
    writeFileSync(resolveConfigStorePath(home), JSON.stringify({ version: 1, config: "nope" }))
    assert.equal(loadUserConfig(home), null)
    writeFileSync(resolveConfigStorePath(home), JSON.stringify([1, 2]))
    assert.equal(loadUserConfig(home), null)
  } finally { rmHome(home) }
})

test("U6b: save to unwritable path (parent is a regular file) → false + warn, does not throw", () => {
  const root = mkHome()
  const blocker = join(root, "blk")
  const warns = []
  const orig = console.warn
  console.warn = (m) => warns.push(String(m))
  try {
    writeFileSync(blocker, "a regular file")
    const badHome = join(blocker, "sub") // mkdir 必失败（父级是文件）
    const cfg = { advisor: {} }
    assert.equal(saveUserConfig(cfg, badHome), false)
    assert.ok(warns.some((w) => w.includes("failed to save user config")), "warn emitted: " + warns.join(" | "))
    assert.equal(loadUserConfig(badHome), null, "unreadable → null")
    assert.equal(clearUserConfig(badHome), true, "nothing written → clear is a successful no-op (no user layer to remove)")
  } finally {
    console.warn = orig
    rmHome(root)
  }
})

// ————————————— U5：合并顺序（会话覆盖 > user 层 > base） —————————————

test("U5a: mergeGlobalConfig field-level — user layer overrides base advisor group fields; base-only fields preserved", () => {
  const base = {
    advisor: {
      round1: { provider: "base-p", model: "base-m", effort: "medium", timeoutMs: 900000 },
      convergence: { provider: "base-cp", model: "base-cm" },
      includeProjectGuide: false,
    },
    consultModels: [{ provider: "a", model: "x" }],
    engCoderMaxTokens: 65536,
    engCoderEffort: "low",
    engineering: true,          // 非白名单 base 键必须保留
    engTokenTtlMs: 3600000,
    legacyField: "keep",        // 非白名单任意键原样保留
  }
  const user = {
    advisor: {
      round1: { effort: "low", timeoutMs: 400000, bogus: "drop-me" },
      convergence: { model: "user-cm" },
    },
    consultModels: [{ provider: "b", model: "y" }, { provider: "c", model: "z", effort: "high" }],
    engCoderEffort: "high",
    unknownTop: 1, // 白名单外顶层键不合并
  }
  const merged = mergeGlobalConfig(base, user)
  // advisor 组字段级：base provider/model 保留，user effort/timeoutMs 覆盖；未知字段不进
  assert.deepEqual(merged.advisor.round1, {
    provider: "base-p", model: "base-m", effort: "low", timeoutMs: 400000,
  })
  assert.deepEqual(merged.advisor.convergence, { provider: "base-cp", model: "user-cm" })
  assert.equal(merged.advisor.includeProjectGuide, false)
  // consultModels 整体替换
  assert.deepEqual(merged.consultModels, [{ provider: "b", model: "y" }, { provider: "c", model: "z", effort: "high" }])
  // engCoder 覆盖 + 非白名单保留
  assert.equal(merged.engCoderMaxTokens, 65536)
  assert.equal(merged.engCoderEffort, "high")
  assert.equal(merged.engineering, true)
  assert.equal(merged.engTokenTtlMs, 3600000)
  assert.equal(merged.legacyField, "keep")
  assert.equal("unknownTop" in merged, false)
  // 入参不被 mutate（merge 产出新对象；user 原样保留未知键——白名单在合并层丢弃）
  assert.ok("bogus" in user.advisor.round1)
  assert.deepEqual(base.advisor.round1, { provider: "base-p", model: "base-m", effort: "medium", timeoutMs: 900000 })
})

test("U5a2: mergeGlobalConfig — legacy advisor.* base keys and no-user identity preserved", () => {
  // 一期 F6 兼容字段（advisor.provider/model 等非组键）随 base advisor 原样保留
  const base = { advisor: { provider: "legacy-p", model: "legacy-m", timeoutMs: 700000 } }
  const user = { advisor: { round1: { provider: "u-p" } } } // round1 覆盖、convergence 不引入
  const merged = mergeGlobalConfig(base, user)
  assert.equal(merged.advisor.round1.provider, "u-p")
  assert.equal(merged.advisor.round1.model, undefined)
  assert.equal(merged.advisor.convergence, undefined)
  assert.equal(merged.advisor.provider, "legacy-p")
  assert.equal(merged.advisor.timeoutMs, 700000)
  // 无 user 层 → 恒等
  assert.deepEqual(mergeGlobalConfig(base, null), base)
  assert.deepEqual(mergeGlobalConfig(base, {}), base)
})

test("U5b: resolution order — session override beats merged user-layer beats base (advisor route)", () => {
  const base = { advisor: { round1: { provider: "base-p", model: "base-m", effort: "high" } } }
  const user = { advisor: { round1: { provider: "user-p", model: "user-m", effort: "medium" } } }
  const effective = mergeGlobalConfig(base, user)
  const agentOpts = { provider: "agent-p", model: "agent-m" }
  // 无会话覆盖 → user 层 > base
  const rNoOv = resolveAdvisorRoute({ config: effective, override: null, agentOpts, advisorRound: 0 })
  assert.equal(rNoOv.provider, "user-p")
  assert.equal(rNoOv.model, "user-m")
  assert.equal(rNoOv.effort, "medium")
  // 会话覆盖仍最高（一期语义零回归：advisorOverride > 生效全局）
  const override = { round1: { provider: "ov-p", effort: "low" } }
  const rOv = resolveAdvisorRoute({ config: effective, override, agentOpts, advisorRound: 0 })
  assert.equal(rOv.provider, "ov-p")
  assert.equal(rOv.model, "user-m") // 未覆盖字段回落 user 层（非 base！）
  assert.equal(rOv.effort, "low")
  // base 在无 user 层覆盖时的值仍生效
  const eff2 = mergeGlobalConfig(base, { advisor: { round1: { effort: "low" } } })
  const r2 = resolveAdvisorRoute({ config: eff2, override: null, agentOpts, advisorRound: 0 })
  assert.equal(r2.provider, "base-p")
  assert.equal(r2.model, "base-m")
})

test("U5c: effectiveGlobalConfig reads the persisted user layer on each call", () => {
  const home = mkHome()
  const base = { advisor: { round1: { provider: "base-p", model: "base-m" } } }
  try {
    assert.deepEqual(effectiveGlobalConfig(base, { dshHomeOverride: home }).advisor.round1,
      { provider: "base-p", model: "base-m" }, "no user layer → base")
    saveUserConfig({ advisor: { round1: { provider: "user-p", model: "user-m" } } }, home)
    assert.deepEqual(effectiveGlobalConfig(base, { dshHomeOverride: home }).advisor.round1,
      { provider: "user-p", model: "user-m" }, "saved user layer merged immediately (no restart)")
    clearUserConfig(home)
    assert.deepEqual(effectiveGlobalConfig(base, { dshHomeOverride: home }).advisor.round1,
      { provider: "base-p", model: "base-m" }, "cleared → falls back to base")
  } finally { rmHome(home) }
})

test("U6c: resolveConfigStorePath without any DSH home → null (callers fail-safe)", () => {
  // cwdHint 指向一个不含 sessions/+settings.yaml 的深层临时目录；临时屏蔽 DSH_HOME 环境变量
  // （宿主可能设置）→ 探测失败 → null
  const root = mkHome()
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = ""
  try {
    const path = resolveConfigStorePath(undefined, join(root, "no", "profile", "here"))
    assert.equal(path, null)
    assert.equal(loadUserConfig(undefined, join(root, "no", "profile", "here")), null)
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    rmHome(root)
  }
})

// ————————————— U3：host 校验 helper（与一期同源导出复用） —————————————

test("U3a: validateGlobalUserConfig rejects invalid values with field errors", () => {
  const badCases = [
    [{ advisor: { round1: { provider: "", model: "m" } } }, /round1\.provider is required/],
    [{ advisor: { convergence: { provider: "p", model: "" } } }, /convergence\.model is required/],
    [{ advisor: { round1: { provider: "p", model: "m", effort: "turbo" } } }, /round1\.effort must be one of/],
    [{ advisor: { round1: { provider: "p", model: "m", timeoutMs: 50 } } }, /round1\.timeoutMs must be a number in 1000\.\.3600000/],
    [{ advisor: { round1: { provider: "p", model: "m", timeoutMs: 99999999999 } } }, /round1\.timeoutMs must be a number/],
    [{ advisor: { round1: { provider: "p", model: "m", timeoutMs: "300000" } } }, /round1\.timeoutMs must be a number/],
    [{ advisor: { includeProjectGuide: "yes" } }, /includeProjectGuide must be a boolean/],
    [{ advisor: { round1: { provider: "p", model: "m", bogus: 1 } } }, /round1\.bogus is not a supported advisor field/],
    [{ advisor: { round1: { provider: "p", model: "m" }, nope: {} } }, /advisor\.nope is not supported/],
    [{ engCoderMaxTokens: 0 }, /engCoderMaxTokens must be a positive integer/],
    [{ engCoderMaxTokens: 1.5 }, /engCoderMaxTokens must be a positive integer/],
    [{ engCoderMaxTokens: "65536" }, /engCoderMaxTokens must be a positive integer/],
    [{ engCoderEffort: "turbo" }, /engCoderEffort must be one of/],
    [{ consultModels: [{ provider: "p" }] }, /consultModels\[0\]\.model is required/],
    [{ consultModels: [{ provider: "p", model: "m", effort: "ultra" }] }, /consultModels\[0\]\.effort must be one of/],
    [{ consultModels: [{ provider: "p", model: "m" }, { provider: "p", model: "m" }, { provider: "p", model: "m" }, { provider: "p", model: "m" }, { provider: "p", model: "m" }, { provider: "p", model: "m" }] }, /consultModels supports at most 5 models/],
    [{ consultModels: "nope" }, /consultModels must be an array/],
    [null, /config must be an object/],
    ["str", /config must be an object/],
    [123, /config must be an object/],
  ]
  for (const [cfg, re] of badCases) {
    const v = validateGlobalUserConfig(cfg, undefined)
    assert.equal(v.ok, false, JSON.stringify(cfg))
    assert.ok(v.errors.some((e) => re.test(e)), JSON.stringify(cfg) + " → " + JSON.stringify(v.errors))
  }
})

test("U3b: provider existence checked when registry is available; skipped with a note when not", () => {
  const cfg = { advisor: { round1: { provider: "nope-provider", model: "m" } } }
  const withRegistry = validateGlobalUserConfig(cfg, ["qax", "zai-coding-cn"])
  assert.equal(withRegistry.ok, false)
  assert.ok(withRegistry.errors.some((e) => e.includes("not in the configured provider registry")))
  const withoutRegistry = validateGlobalUserConfig(cfg, undefined)
  assert.equal(withoutRegistry.ok, true, "registry unavailable → existence not verified")
  assert.ok(withoutRegistry.notes.some((e) => e.includes("provider registry unavailable")))
  // 注册表命中 → 无 provider 错误
  const hit = validateGlobalUserConfig(
    { advisor: { round1: { provider: "qax", model: "glm-5.3" } }, consultModels: [{ provider: "qax", model: "glm-5.3" }] },
    ["qax"],
  )
  assert.equal(hit.ok, true)
  assert.equal(hit.errors.length, 0)
})

test("U3c: valid payload validates ok and returns sanitized whitelist payload (unknown dropped as notes)", () => {
  const v = validateGlobalUserConfig({
    advisor: {
      round1: { provider: "qax", model: "glm-5.3", effort: "medium", timeoutMs: 900000 },
      includeProjectGuide: false,
    },
    consultModels: [{ provider: "qax", model: "glm-5.3", effort: "high" }],
    engCoderMaxTokens: 65536,
    engCoderEffort: "low",
    engineering: true, // 白名单外 → note，不进 sanitized
  }, ["qax"])
  assert.equal(v.ok, true)
  assert.ok(v.notes.some((e) => e.includes("engineering")))
  assert.deepEqual(v.sanitized, {
    advisor: { round1: { provider: "qax", model: "glm-5.3", effort: "medium", timeoutMs: 900000 }, includeProjectGuide: false },
    consultModels: [{ provider: "qax", model: "glm-5.3", effort: "high" }],
    engCoderMaxTokens: 65536,
    engCoderEffort: "low",
  })
  // 空组净化：空字符串字段不进 payload（= 不覆盖 base）
  const v2 = validateGlobalUserConfig({ advisor: { convergence: { provider: "", effort: "low" } } }, undefined)
  assert.equal(v2.ok, false) // provider "" 仍报必填
  const v3 = validateGlobalUserConfig({ advisor: { convergence: { effort: "low" } } }, undefined)
  assert.equal(v3.ok, true)
  assert.deepEqual(v3.sanitized.advisor.convergence, { effort: "low" })
})

// ————————————— U7：apply-session / reset-session（stub sessionState） —————————————

test("U7a: apply-session with a valid sessionId writes the advisor override subset", () => {
  const stubs = sessionStubs(["s1"])
  const r = applySessionOverride(stubs, "s1", {
    round1: { provider: "qax", model: "glm-5.3", effort: "low", timeoutMs: 500000 },
    convergence: { provider: "qax", model: "glm-5.3-flash" },
    includeProjectGuide: true,
  })
  assert.equal(r.ok, true)
  const state = stubs.getState("s1")
  assert.deepEqual(state.advisorOverride, {
    round1: { provider: "qax", model: "glm-5.3", effort: "low", timeoutMs: 500000 },
    convergence: { provider: "qax", model: "glm-5.3-flash" },
    includeProjectGuide: true,
  })
})

test("U7b: apply-session invalid sessionId → {ok:false, reason:'no-session'}, nothing written, no crash", () => {
  const stubs = sessionStubs([])
  const r = applySessionOverride(stubs, "ghost-session", { round1: { provider: "qax", model: "glm-5.3" } })
  assert.deepEqual(r, { ok: false, reason: "no-session" })
  assert.equal(stubs.stateOfCalls.length, 0, "stateOf never invoked for an invalid session (no state entry created)")
  // 空/缺失 id 同样 no-session，且不触碰 state
  assert.equal(applySessionOverride(stubs, "", {}).reason, "no-session")
  assert.equal(applySessionOverride(stubs, undefined, {}).reason, "no-session")
  assert.equal(applySessionOverride(stubs, "  ", {}).reason, "no-session")
  assert.equal(stubs.stateOfCalls.length, 0)
})

test("U7c: apply-session rejects invalid advisor values (validation errors) and does not mutate state", () => {
  const stubs = sessionStubs(["s2"])
  stubs.stateOf("s2").advisorOverride = { round1: { provider: "keep" } }
  const cases = [
    { round1: { provider: "qax", model: "m", effort: "turbo" } },
    { round1: { provider: "", model: "m" } },
    { convergence: { provider: "qax", model: "m", timeoutMs: 50 } },
    { includeProjectGuide: "yes" },
    { consultModels: [{ provider: "qax", model: "m" }] }, // 非 advisor 白名单 → 拒绝
  ]
  for (const advisor of cases) {
    const r = applySessionOverride(stubs, "s2", advisor)
    assert.equal(r.ok, false, JSON.stringify(advisor))
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, JSON.stringify(r))
  }
  assert.deepEqual(stubs.getState("s2").advisorOverride, { round1: { provider: "keep" } }, "state untouched on errors")
})

test("U7d: reset-session clears the override for valid sessions; invalid → no-session", () => {
  const stubs = sessionStubs(["s3"])
  stubs.stateOf("s3").advisorOverride = { round1: { provider: "qax" } }
  const r = resetSessionOverride(stubs, "s3")
  assert.deepEqual(r, { ok: true })
  assert.equal(stubs.getState("s3").advisorOverride, null)
  assert.deepEqual(resetSessionOverride(stubs, "nope"), { ok: false, reason: "no-session" })
})

test("U7e: sanitizeSessionAdvisor drops unknown keys, rejects empty-string fields, null for empty payload", () => {
  // 空字符串 provider/model = 非法输入（表单不会发送空字段；后端校验拒绝）
  const vBad = sanitizeSessionAdvisor({ round1: { provider: "", model: "" }, convergence: null })
  assert.equal(vBad.ok, false)
  assert.ok(vBad.errors.some((e) => e.includes("round1.provider is required")))
  // 无字段的组对象 / 空载荷 → 无覆盖（null）
  const v = sanitizeSessionAdvisor({ round1: {}, convergence: {} })
  assert.equal(v.ok, true)
  assert.equal(v.advisor, null, "fully empty group payload → no override")
  const v2 = sanitizeSessionAdvisor({ round1: { provider: "qax", model: "glm-5.3", timeoutMs: 0 } })
  assert.equal(v2.ok, false, "timeoutMs 0 out of range")
  const v3 = sanitizeSessionAdvisor({ round1: { provider: "qax", model: "glm-5.3", timeoutMs: 300000 } })
  assert.deepEqual(v3.advisor, { round1: { provider: "qax", model: "glm-5.3", timeoutMs: 300000 } })
  const v4 = sanitizeSessionAdvisor({})
  assert.equal(v4.advisor, null)
})

test("U7f: describeSessionView returns override + effective summary for a known session; no-session otherwise", () => {
  const home = mkHome() // 隔离真实 $DSH_HOME 的 user 层（测试确定性）
  const deps = sessionStubs(["s4"])
  deps.baseConfig = {
    advisor: {
      round1: { provider: "base-p", model: "base-m", effort: "medium", timeoutMs: 900000 },
      convergence: { provider: "base-cp", model: "base-cm" },
      includeProjectGuide: false,
    },
  }
  deps.dshHomeOverride = home
  try {
    // 无覆盖 → {ok:true, override:null, effective 摘要}
    const view = describeSessionView(deps, "s4")
    assert.equal(view.ok, true)
    assert.equal(view.override, null)
    assert.equal(view.effective.round1.ok, true)
    assert.equal(view.effective.round1.provider, "base-p")
    assert.equal(view.effective.round1.pairSource, "global config")
    assert.equal(view.effective.convergence.ok, true)
    assert.equal(view.effective.includeProjectGuide.value, false)
    assert.equal(view.effective.includeProjectGuide.source, "global config")
    // 有覆盖 → override 呈现 + 摘要反映会话覆盖优先
    deps.stateOf("s4").advisorOverride = { round1: { provider: "ov-p", effort: "low" } }
    const view2 = describeSessionView(deps, "s4")
    assert.equal(view2.ok, true)
    assert.deepEqual(view2.override, { round1: { provider: "ov-p", effort: "low" } })
    assert.equal(view2.effective.round1.provider, "ov-p")
    assert.equal(view2.effective.round1.model, "base-m")
    assert.equal(view2.effective.round1.effort, "low")
    // 无效会话
    assert.deepEqual(describeSessionView(deps, "ghost"), { ok: false, reason: "no-session" })
  } finally { rmHome(home) }
})

// ————————————— U8：webServer 缺失降级 —————————————

test("U8a: registerConfigApi with no webServer service → console.warn + null (host tools unaffected)", () => {
  const warns = []
  const orig = console.warn
  console.warn = (m) => warns.push(String(m))
  try {
    const dispose = registerConfigApi({}, { baseConfig: {} })
    assert.equal(dispose, null)
    assert.equal(warns.length, 1)
    assert.ok(warns[0].includes("webServer service unavailable"))
    // webServer 存在但 register 缺失 → 同样降级
    const dispose2 = registerConfigApi({ webServer: {} }, { baseConfig: {} })
    assert.equal(dispose2, null)
    assert.equal(warns.length, 2)
  } finally {
    console.warn = orig
  }
})

test("U8b: registerConfigApi with webServer registers the prefix route and returns its disposer", () => {
  let registered = null
  const disposeFn = () => {}
  const ctx = { webServer: { register: (spec) => { registered = spec; return disposeFn } } }
  const dispose = registerConfigApi(ctx, { baseConfig: { advisor: {} } })
  assert.equal(dispose, disposeFn)
  assert.ok(registered)
  assert.equal(registered.kind, "prefix")
  assert.equal(registered.path, CONFIG_API_PREFIX)
  assert.equal(typeof registered.handler, "function")
})

// ————————————— 校验 helper 单测（与一期同源导出，U3 侧面） —————————————

test("U3d: advisor exported validators are reused by index validation (single source, review #5)", async () => {  // 通过 index 校验路径间接触发 advisor.mjs 的导出（同一函数引用），此处再直测导出：
  const { isValidEffort, isValidTimeoutMs, isModelField, isValidEngCoderMaxTokens, EFFORT_LEVELS } = await import("../lib/advisor.mjs")
  assert.equal(isValidEffort("low"), true)
  assert.equal(isValidEffort("turbo"), false)
  assert.equal(isValidTimeoutMs(300000), true)
  assert.equal(isValidTimeoutMs(0), false)
  assert.equal(isValidTimeoutMs(9999999999), false)
  assert.equal(isValidTimeoutMs("300000"), false)
  assert.equal(isModelField("qax"), true)
  assert.equal(isModelField(""), false)
  assert.equal(isModelField(42), false)
  assert.equal(isValidEngCoderMaxTokens(65536), true)
  assert.equal(isValidEngCoderMaxTokens(0), false)
  assert.equal(isValidEngCoderMaxTokens(1.5), false)
  assert.equal(isValidEngCoderMaxTokens("65536"), false)
  assert.deepEqual(EFFORT_LEVELS, ["off", "low", "medium", "high", "max"])
  // 与 validateGlobalUserConfig 走同一实现：非法 effort 在两边都拒绝
  const direct = validateGlobalUserConfig({ advisor: { round1: { provider: "p", model: "m", effort: "turbo" } } }, undefined)
  assert.equal(direct.ok, false)
})

// ————————————— 评审 #1 回归：handler 级集成（生产形状 opts，防「stateOf 未接线被 stub 掩盖」） —————————————

test("review#1: handler-level integration — production-shaped opts (stateOf wired via sessionState) serve POST /apply-session and GET /session", async () => {
  const { makeApiHandler } = await import("../lib/index.mjs")
  const { sessionState, dropSession } = await import("../lib/state.mjs")
  const sid = "srv-it-" + Date.now()
  // 生产形状：与 lib/index.mjs apply() 注册处一致的依赖形状（stateOf 绑 sessionState；sessionExists 认已知集）
  const known = new Set([sid])
  const opts = {
    baseConfig: { advisor: { round1: { provider: "qax", model: "glm-5.3" } } },
    sessionExists: (id) => known.has(String(id)),
    agentOptionsOf: () => ({}),
    stateOf: (id) => sessionState(String(id)),
    settingsGet: () => null,
    cwdHint: undefined,
    dshHomeOverride: undefined,
  }
  const handler = makeApiHandler({}, opts)
  const call = async (method, path, body) => {
    let status = 0, payload = ""
    const res = {
      writeHead: (code) => { status = code },
      end: (text) => { payload = String(text) },
    }
    let req
    if (body !== undefined) {
      const text = JSON.stringify(body)
      req = {
        url: "http://localhost" + path, method,
        [Symbol.asyncIterator]: async function* () { yield text },
      }
    } else {
      req = { url: "http://localhost" + path, method, [Symbol.asyncIterator]: async function* () {} }
    }
    await handler(req, res)
    return { status, payload: payload ? JSON.parse(payload) : null }
  }
  try {
    // 生产形状下 POST /apply-session 成功（stateOf 未接线会在 500 兜底暴露）
    const r = await call("POST", "/thincoder-suite/api/apply-session", { sessionId: sid, advisor: { round1: { provider: "qax", model: "glm-5.3" } } })
    assert.equal(r.status, 200, JSON.stringify(r.payload))
    assert.equal(r.payload.ok, true)
    assert.deepEqual(sessionState(sid).advisorOverride, { round1: { provider: "qax", model: "glm-5.3" } })
    // GET /session 摘要（describe 经同一 stateOf）
    const g = await call("GET", "/thincoder-suite/api/session?sessionId=" + encodeURIComponent(sid))
    assert.equal(g.status, 200)
    assert.equal(g.payload.ok, true)
    assert.deepEqual(g.payload.override, { round1: { provider: "qax", model: "glm-5.3" } })
    // 无效 sessionId → no-session 404
    const bad = await call("POST", "/thincoder-suite/api/apply-session", { sessionId: "ghost", advisor: {} })
    assert.equal(bad.status, 404)
    assert.equal(bad.payload.reason, "no-session")
  } finally {
    dropSession(sid)
  }
})
