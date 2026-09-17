// config-api.test.mjs — 二期设置页 host 侧单元测试（docs/2026-09-02-settings-ui-design.md §5，U2/U3/U5/U6/U7/U8）。
// node:test 零依赖。临时 DSH_HOME（dshHomeOverride 注入缝）做 config-store 落盘，不碰真实
// $DSH_HOME/.thincoder/config.json。
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import {
  mergeGlobalConfig, effectiveGlobalConfig,
  loadUserConfig, saveUserConfig, clearUserConfig, resolveConfigStorePath,
} from "../lib/config-store.mjs"
import {
  validateGlobalUserConfig, applySessionOverride, resetSessionOverride,
  sanitizeSessionAdvisor, describeSessionView, registerConfigApi, CONFIG_API_PREFIX, makeApiHandler,
} from "../lib/index.mjs"
import { resolveAdvisorRoute } from "../lib/advisor.mjs"

const mkHome = () => mkdtempSync(join(tmpdir(), "thincoder-cfg-"))
const rmHome = (h) => { try { rmSync(h, { recursive: true, force: true }) } catch { /* 已清理 */ } }
/** 插件根（U3c2 的白名单一致性锁要读两侧**源码字节**）。 */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

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

test("U3c: valid payload validates ok and returns sanitized whitelist payload；未知顶层键 ⇒ errors（批 10 / D-31 翻转）", () => {
  // ★ 批 10（D-31 / D10-9 · 决策 J10-6「取报错不取回显」）**翻转本用例的期望值**：
  //   `engineering: true` 是**白名单外的顶层键**——旧契约把它归 `notes`（`ok:true` + 静默丢弃，
  //   实测后果 = 全未知键 PUT ⇒ 200「已保存」而 user 层被**整体替换清空**）；
  //   新契约把它归 **`errors`** ⇒ `ok:false` ⇒ PUT **400** ⇒ **在写盘之前拦下**（数据丢失路径灭绝）。
  //   本档是**基线档**（受 T-AP9 保护）⇒ 改动经 `AP_TEST_AUTHORIZED` 显式授权通道（见其注释）。
  const v = validateGlobalUserConfig({
    advisor: {
      round1: { provider: "qax", model: "glm-5.3", effort: "medium", timeoutMs: 900000 },
      includeProjectGuide: false,
    },
    consultModels: [{ provider: "qax", model: "glm-5.3", effort: "high" }],
    engCoderMaxTokens: 65536,
    engCoderEffort: "low",
    engineering: true, // 白名单外顶层键 ⇒ **errors**（不再是 note）
  }, ["qax"])
  assert.equal(v.ok, false, "未知顶层键 ⇒ ok:false（D-31 新契约：报错，不再静默丢弃）")
  assert.ok(v.errors.some((e) => e.includes("engineering") && e.includes("not a supported top-level field")),
    "400 的 errors 必须**点名**未知键 + 白名单提示（镜像嵌套分支的既有形态）：" + JSON.stringify(v.errors))
  assert.ok(!("engineering" in (v.sanitized ?? {})), "sanitized 不得含未知键：" + JSON.stringify(v.sanitized))
  assert.ok(!(v.notes ?? []).some((n) => n.includes("ignoring unknown top-level field")),
    "旧形态的 note 必须消失（否则同一事实两处口径）：" + JSON.stringify(v.notes))
  // 合法键照常净化（同一请求里的合法部分不受影响——报错面只针对未知键）
  assert.deepEqual(v.sanitized.advisor, {
    round1: { provider: "qax", model: "glm-5.3", effort: "medium", timeoutMs: 900000 }, includeProjectGuide: false,
  })
  assert.deepEqual(v.sanitized.consultModels, [{ provider: "qax", model: "glm-5.3", effort: "high" }])
  // 全已知键 ⇒ 行为逐字不变（零回归面）
  const ok = validateGlobalUserConfig({
    advisor: { round1: { provider: "qax", model: "glm-5.3", effort: "medium", timeoutMs: 900000 }, includeProjectGuide: false },
    consultModels: [{ provider: "qax", model: "glm-5.3", effort: "high" }],
    engCoderMaxTokens: 65536,
    engCoderEffort: "low",
  }, ["qax"])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.sanitized, {
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

test("U3c2 (D10-10 / AC-D5 / 锚 M6): 设置页可产出的顶层键 ⊆ 服务端白名单（两侧都从**源码字节**解析）", () => {
  // 报错方案（D-31）唯一的顾虑 = 「客户端能产出服务端不认的键 ⇒ 设置页死锁」。用**一条锁**消除它：
  // 断言 `draftToPayload` 可产出的顶层键 **⊆** `topAllowed`。**两侧都从源码字面解析**（不手写清单、
  // 不 import 私有实现）——任一侧将来加键忘同步 ⇒ 本用例红。
  const indexSrc = readFileSync(join(PLUGIN_DIR, "lib", "index.mjs"), "utf8")
  const mAllowed = /const topAllowed = \[([^\]]*)\]/.exec(indexSrc)
  assert.ok(mAllowed, "index.mjs 的 topAllowed 字面不可定位（服务端白名单形态变了 ⇒ 本锁必须随之复核）")
  const allowed = [...mAllowed[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])

  const clientSrc = readFileSync(join(PLUGIN_DIR, "lib", "client.js"), "utf8")
  const i0 = clientSrc.indexOf("function draftToPayload(draft) {")
  const i1 = clientSrc.indexOf("\n\t\t\treturn config;", i0)
  assert.ok(i0 >= 0 && i1 > i0, "client.js 的 draftToPayload 函数体不可定位（形态变了 ⇒ 本锁必须随之复核）")
  const body = clientSrc.slice(i0, i1)
  const payloadKeys = [...new Set([...body.matchAll(/\bconfig\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)].map((x) => x[1]))]

  // 解析器自证段（D10-10 明文要求）：两侧都必须真的解析出 ≥N 键，否则本锁退化为恒真空断言。
  assert.ok(allowed.length >= 5, "服务端白名单解析自证：实得 " + allowed.length + " 键 " + JSON.stringify(allowed))
  assert.ok(payloadKeys.length >= 5, "客户端载荷键解析自证：实得 " + payloadKeys.length + " 键 " + JSON.stringify(payloadKeys))
  const extra = payloadKeys.filter((k) => !allowed.includes(k))
  assert.deepEqual(extra, [],
    "设置页可产出的顶层键必须 ⊆ 服务端 topAllowed（否则 D-31 的 400 会让设置页死锁）：多出 " + JSON.stringify(extra))
})

// ————————————— U3c2b 白名单散文面三轴锁（批 14 / FR-2 · 锚 A3 + A4 · AC-4…AC-7） —————————————
//
// 主题：**「插件自己的契约」与「它对外声称的契约」的一致性**。权威面 = 三轴 8/8/5 = 21 名，
// 分别从 `lib/index.mjs`（topAllowed / GROUP_KEYS+advisor 子键）与 `lib/config-store.mjs`
// （GROUP_FIELDS）的**源码字面**解析；散文面 = 各档的**用户层白名单段**。要求**双向**：
// 散文 ⊄ 权威（多写）与权威 ⊄ 散文（漂了没人知）都必红。
//
// ★ 两级过滤的每一级都由一个**实测陷阱**逼出来（会诊 R-3 的陷阱清单，父侧复核）：
//   ① `user` 层可配字段白名单：」**段级**：yml / README 的块**尾部**紧跟一句以
//      「只在 base 配」起头的排除句（内含 `engineering`），不切段就多抓 ⇒ 先切段；
//   ② **行级**：块内还有「（组内字段级 …）」这样的**排除子句**（`；`/`——` 起头的说明尾巴）；
//   ③ `README.md` 是 **CRLF**、`cordis.patch.yml` 是 **LF** ⇒ EOL 归一；
//   ④ 三种**格式不同**：yml 是纯文本（无反引号）、README 用反引号、config-store 是分行列表；
//   ⑤ 假阳性：块内有 `D-29` / `R1 §3.6` / `FR-CB5` / `mergeGlobalConfig` ⇒ 首字符小写 + 长度 ≥3 + stoplist。
//
// ★ 本块自带**负控腿**（防恒真；批 15 的 W3 教训 = 谓词匹配 0 处 ⇒ 永不可能通过）：
//   腿 A：把键名从散文**删掉** ⇒ 该档断言必红（本条 ⓸ 直接构造该场景）；
//   腿 B：把**段级切分**改坏（喂整档）⇒ 多抓块外 token ⇒ 「多余」断言必红（⓸）；
//   腿 C：把提取集弄成**空集** ⇒ **防恒真护栏必红**（⓸；★ 批 14 修复轮补）。
//   ★ 订正留痕：本节原写「腿 B：把提取器的**标记剥离**改坏 ⇒ **空集 ⇒ 必红**」——**实测为假**
//     （腿 B 走的是「多抓」那一支，空集从未被构造过；分歧审计逐字点名）⇒ 今如实改述，
//     空集那一支由**腿 C** 承担。
const DOCKEY_RE = /(?<![A-Za-z0-9_.])(?:[a-z][A-Za-z0-9]*|[A-Z][A-Za-z0-9]*)(?:\.[A-Za-z][A-Za-z0-9]*)?(?![A-Za-z0-9_])/g
/** 散文面的**噪声 token**（全部来自实测：块内的批号/档名/组键/容器名/说明词）。 */
const DOCKEY_STOP = new Set(["user", "base", "provider", "model", "engineering",
  "reg", "legacy", "round1", "convergence", "mergeGlobalConfig", "CB5", "consult"])

/** 从源码全文切出**用户层白名单段**（段级过滤；边界缺失 ⇒ null ⇒ 调用方必红）。 */
function sliceUserLayerSegment(src, format) {
  const span = (a, b) => { const i = src.indexOf(a); if (i < 0) return null; const j = src.indexOf(b, i); if (j < 0) return null; return src.slice(i, j) }
  if (format === "yml") return span("用户层可配字段白名单：", "下列示例值若在 user 层被覆盖")
  if (format === "readme") return span("user 层可配字段白名单：", "只在 base 配")
  if (format === "config-store") return span("// - mergeGlobalConfig(base, user)：字段级白名单浅合并", "//   原样保留——合并只叠加")
  return null
}

/** 段内提取键名（行级过滤 → 标记剥离 → EOL 归一 → token → 三道筛）。 */
function extractDocKeys(block) {
  assert.ok(typeof block === "string" && block.length > 0, "白名单段必须可定位（空段 ⇒ 提取器必然空转 ⇒ 恒真）")
  const keys = new Set()      // 归一后的键集（`advisor.round1` → 容器名 `advisor`）
  const advSub = new Set()    // advisor **子键**（原样 token；组键 round1/convergence 另走组字段轴）
  for (const raw of block.split(/\r?\n/)) {                                    // ② EOL 归一（README 是 CRLF）
    let s = raw.replace(/^\s*(\/\/|\*|#|-)\s*/, "")                            // ① 标记剥离
    s = s.replace(/`/g, "")
    for (const mark of ["；", "——", "以及"]) { const k = s.indexOf(mark); if (k >= 0) s = s.slice(0, k) }  // ③ 行级：先切排除子句
    for (const t of (s.match(DOCKEY_RE) ?? [])) {
      if (t.length < 3) continue                                               // 长度 ≥3（滤 D-29 / R1）
      if (DOCKEY_STOP.has(t)) continue                                         // stoplist（滤 user / base / engineering / 组键）
      keys.add(t.startsWith("advisor.") ? "advisor" : t)                       // `advisor.round1` → 容器名 `advisor`
      if (t.startsWith("advisor.") && !["round1", "convergence"].includes(t.slice(8))) advSub.add(t.slice(8))
    }
  }
  return { keys, advSub }
}

/** ★ 防恒真护栏（**单点实现**）：提取集为空 ⇒ 立即红（§6.2 图 2 的「空集 = 恒真的唯一入口」）。
 *
 *  ★ 为什么抽成一个函数（批 14 修复轮）：原实现把这条断言**逐处内联**三次
 *  （yml / README / config-store），而**分歧审计逐字点名**：设计档 §8.2 的 A4 负控承诺
 *  「把提取器**故意改坏** ⇒ **空集 ⇒ 必红**」，**而交付里没有任何一条腿把提取集弄成空集**
 *  ——当时的两条腿断言的是「喂整档 ⇒ **多抓**」与「删键 ⇒ 缺项」⇒ **唯一防恒真的
 *  `keys.size >= 1` 自身从未被证明会红**，「空集 = 恒真的唯一入口」当时只是**声明**。
 *  ⇒ 抽成单点后，**腿 C 的负控证的就是 ⓵/⓶/⓷ 三处实际调用的这一个函数**，
 *  而不是一句会与 ⓵ 漂离的复制品。 */
function assertDocKeysNonEmpty(keys, what) {
  assert.ok(keys.size >= 1, what + " 提取集非空（空集 ⇒ 恒真的唯一入口）")
}

/** 组字段轴：`advisor.round1/convergence` 的**同句括号名单**（段内搜索；三档的写法略有出入，
 *  故用正则在**同一行内**找括号——`yml`/`README` 是「… 组（provider/model/…）」，
 *  `config-store` 是「…（组内字段级 provider/model/…）」。**只看括号那一小段**，
 *  故不会把段内其他反引号项误收进来。 */
function groupFieldNames(segment) {
  const out = new Set()
  for (const line of segment.split(/\r?\n/)) {
    const at = line.indexOf("advisor.round1/convergence")
    if (at < 0) continue
    const op = line.indexOf("（", at)
    if (op < 0) continue
    const cl = line.indexOf("）", op)
    const inner = line.slice(op + 1, cl < 0 ? line.length : cl)
    for (const t of (inner.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [])) out.add(t)
  }
  return out
}

test("U3c2b (批 14 / FR-2 / 锚 A3+A4): 白名单散文面与权威面三轴一致（8/8/5 = 21 名，逐文件各一条 + 先钉基数 + 双向）", () => {
  // —— ⓪ 权威面（源码字面；缺任一 ⇒ 断言落地即红）——
  const indexSrc = readFileSync(join(PLUGIN_DIR, "lib", "index.mjs"), "utf8")
  const storeSrc = readFileSync(join(PLUGIN_DIR, "lib", "config-store.mjs"), "utf8")
  const lit = (src, re, what) => { const m = re.exec(src); assert.ok(m, what + " 的字面不可定位（形态变了 ⇒ 本锁必须随之复核）"); return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) }
  const TOP = lit(indexSrc, /const topAllowed = \[([^\]]*)\]/, "index.mjs 的 topAllowed")
  const GROUPS = lit(indexSrc, /const GROUP_KEYS = \[([^\]]*)\]/, "index.mjs 的 GROUP_KEYS")
  const ADV_SUB = lit(indexSrc, /\[\.\.\.GROUP_KEYS, ([^\]]*)\]/, "index.mjs 的 advisor 子键清单")
  const GROUP_FORM = lit(storeSrc, /const GROUP_FIELDS = \[([^\]]*)\]/, "config-store.mjs 的 GROUP_FIELDS")
  // ★ 先钉基数（A4）：不钉基数 ⇒ 解析器空转即恒真
  assert.equal(TOP.length, 8, "权威面轴①（顶层）必须是 8 名，实测 " + TOP.length + " " + JSON.stringify(TOP))
  assert.equal(ADV_SUB.length, 6, "权威面轴②（advisor 子键，组键 round1/convergence 另归组轴）必须是 6 名，实测 " + ADV_SUB.length + " " + JSON.stringify(ADV_SUB))
  assert.equal(GROUP_FORM.length, 5, "权威面轴③（组**表单字段**）必须是 5 名，实测 " + GROUP_FORM.length + " " + JSON.stringify(GROUP_FORM))
  assert.equal(GROUPS.length, 2, "权威面组键（round1/convergence）必须是 2 名，实测 " + JSON.stringify(GROUPS))
  assert.equal(TOP.length + ADV_SUB.length + GROUPS.length + GROUP_FORM.length, 21,
    "三轴合计 = 8 + (2+6) + 5 = 21（`topAllowed` ×8 · advisor 子键 ×8 · 组字段 ×5）")
  const allNames = new Set([...TOP, ...ADV_SUB, ...GROUPS, ...GROUP_FORM])

  const ymlSrc = readFileSync(join(PLUGIN_DIR, "cordis.patch.yml"), "utf8")
  const readmeSrc = readFileSync(join(PLUGIN_DIR, "README.md"), "utf8")

  // —— ① `cordis.patch.yml`（逐文件各一条；A3 轴①/② + ⓪ 的 A4 基数钉）——
  const ymlBlock = sliceUserLayerSegment(ymlSrc, "yml")
  const { keys: ymlKeys, advSub: ymlAdv } = extractDocKeys(ymlBlock)
  assertDocKeysNonEmpty(ymlKeys, "cordis.patch.yml 白名单段")
  const ymlTop = [...ymlKeys].filter((k) => !ADV_SUB.includes(k) && !GROUP_FORM.includes(k))
  assert.deepEqual(TOP.filter((k) => !ymlTop.includes(k)), [], "cordis.patch.yml 白名单段**缺**顶层键（散文漂了 ⇒ 必红）")
  assert.deepEqual(ymlTop.filter((k) => !TOP.includes(k)), [], "cordis.patch.yml 白名单段**多**顶层键（散文多写 ⇒ 必红）")
  assert.deepEqual(ADV_SUB.filter((k) => ![...ymlAdv].includes(k)), [], "cordis.patch.yml 白名单段**缺** advisor 子键")
  assert.deepEqual([...ymlAdv].filter((k) => !ADV_SUB.includes(k)), [], "cordis.patch.yml 白名单段**多** advisor 子键")
  assert.deepEqual([...groupFieldNames(ymlBlock)].filter((k) => ![...GROUP_FORM, ...GROUPS].includes(k)), [], "cordis.patch.yml 的组字段名单多出权威面外的名")
  assert.deepEqual(GROUP_FORM.filter((k) => ![...groupFieldNames(ymlBlock)].includes(k)), [], "cordis.patch.yml 的组字段名单缺表单字段")

  // —— ② `README.md`（同三轴；**CRLF** 档，EOL 归一由 extractDocKeys 承担）——
  const readmeBlock = sliceUserLayerSegment(readmeSrc, "readme")
  const { keys: readmeKeys, advSub: readmeAdv } = extractDocKeys(readmeBlock)
  assertDocKeysNonEmpty(readmeKeys, "README.md 白名单段")
  const readmeTop = [...readmeKeys].filter((k) => !ADV_SUB.includes(k) && !GROUP_FORM.includes(k))
  assert.deepEqual(TOP.filter((k) => !readmeTop.includes(k)), [], "README.md 白名单段**缺**顶层键")
  assert.deepEqual(readmeTop.filter((k) => !TOP.includes(k)), [], "README.md 白名单段**多**顶层键")
  assert.deepEqual(ADV_SUB.filter((k) => ![...readmeAdv].includes(k)), [], "README.md 白名单段**缺** advisor 子键")
  assert.deepEqual([...readmeAdv].filter((k) => !ADV_SUB.includes(k)), [], "README.md 白名单段**多** advisor 子键")
  assert.deepEqual([...groupFieldNames(readmeBlock)].filter((k) => ![...GROUP_FORM, ...GROUPS].includes(k)), [], "README.md 的组字段名单多出权威面外的名")
  assert.deepEqual(GROUP_FORM.filter((k) => ![...groupFieldNames(readmeBlock)].includes(k)), [], "README.md 的组字段名单缺表单字段")

  // —— ③ `lib/config-store.mjs` 的头注释（A5 / AC-7：**P4 修复后**组字段零缺项）——
  const storeBlock = sliceUserLayerSegment(storeSrc, "config-store")
  const { keys: storeKeys } = extractDocKeys(storeBlock)
  assertDocKeysNonEmpty(storeKeys, "config-store 头注释段")
  assert.deepEqual([...storeKeys].filter((k) => !allNames.has(k)), [],
    "头注释里出现权威面**没有**的名（命名漂移 ⇒ 必红）")
  assert.deepEqual(GROUP_FORM.filter((k) => ![...groupFieldNames(storeBlock)].includes(k)), [],
    "★ P4/AC-7：mergeGlobalConfig 头注释的组字段名单必须含全部 5 名（`runner` 曾缺位）")

  // —— ④ 负控（防恒真；**三条腿都必须红**。腿 A/B 出自设计档 §8.2 / AC-20，腿 C = 批 14 修复轮补的
  //    「空集 ⇒ 必红」那一支——见下方 ★★）——
  // 腿 B：**故意改坏提取器**（不作**段级切分**，见 §6.2 图 2 的 ①——直接喂整档）⇒ 实测多抓 43 个
  //       块外 token（`dsh` / `suite` / `insert` / `medium` …）⇒ **「多余」断言必红**。
  //       段级边界**是**过滤器：这一腿证明它不是恒真（若边界坏成「切到空」则落到**腿 C** 的空集支，同样必红）。
  const sabotagedWhole = extractDocKeys(ymlSrc)
  assert.ok(sabotagedWhole.keys.size > ymlKeys.size + ymlAdv.size,
    "负控腿 B：改坏段级切分（喂整档）⇒ 实测多抓（" + sabotagedWhole.keys.size + " > 正式 " + (ymlKeys.size + ymlAdv.size) + "）")
  assert.ok([...sabotagedWhole.keys].some((k) => !allNames.has(k)), "负控腿 B：多抓里必有权威面外的名（「多余」断言不恒空）")
  // 腿 B（边界形）：段级**起点**前移 ⇒ 吞进 YAML 正文（`insert:` / `engCoderEffort: low` …）⇒ 同样多抓
  const badYmlSeg = ymlSrc.slice(ymlSrc.indexOf("用户层可配字段白名单：") - 1200)
  const badYmlKeys = extractDocKeys(badYmlSeg).keys
  assert.ok([...badYmlKeys].some((k) => !allNames.has(k)),
    "负控腿 B（边界形）：起点前移后多抓的名里必有权威面外的（本条是「多余」断言不恒空的第二证据）")
  // 腿 A：**把键名从散文里删掉** ⇒ 「缺项」断言必红（构造真实语义：破坏 `advisor.` 前缀）
  const removedAdvice = ymlBlock.split("advisor.").join("advisor")
  const removedKeys = extractDocKeys(removedAdvice).keys
  const missingAfterRemoval = TOP.filter((k) => ![...removedKeys].filter((x) => !ADV_SUB.includes(x) && !GROUP_FORM.includes(x)).includes(k))
  assert.ok(missingAfterRemoval.includes("advisor"),
    "负控腿 A：从散文段删掉一处键名 ⇒ 「缺项」集合必须非空（本条证明 ⓵ 的缺项断言不是恒空）")

  // ★★ 腿 C：**空集 ⇒ 防恒真护栏必红**（批 14 修复轮补——分歧审计点名的**唯一代码面缺口**）。
  //   设计档 §8.2 的 A4 负控原文：「把提取器**故意改坏**（如吞掉标记剥离）⇒ **空集 ⇒ 必红**」，
  //   与 §9 的「**空集**：散文块为空 / 提取器返回空集 ⇒ **`assert` 非空后红**（**这是恒真的
  //   唯一入口**）」。**而交付里这两条从未被任何腿触发**：腿 B 实测走的是「喂整档 ⇒ **多抓**」
  //   那一支（断言 `sabotagedWhole.keys.size > …`），腿 A 走的是「删键 ⇒ 缺项」——
  //   **唯一防恒真的护栏 `keys.size >= 1` 自身从未被证明会红** ⇒ 那句承诺当时是**声明**，
  //   不是已验证的性质。本腿**真的把提取集弄成空集**，并证明护栏会红。
  //
  //   构造 ①（**段级失配 ⇒ 块为空**，即 §9 的「散文块为空」支）：真实档字节不动，只把**段起
  //     标记**改坏 ⇒ `sliceUserLayerSegment` 返回 `null` ⇒ 提取器的**入口非空断言必红**
  //     （fail-closed：空块不得静默通过、更不得当空集放过）。
  const noMarkerSrc = ymlSrc.split("用户层可配字段白名单：").join("（段起标记已被改坏）")
  const noMarkerSeg = sliceUserLayerSegment(noMarkerSrc, "yml")
  assert.equal(noMarkerSeg, null,
    "腿 C 构造自证①：段起标记改坏后段级切分必须失配（实得 " + JSON.stringify(noMarkerSeg)
    + "）——否则本腿验的不是空集")
  assert.throws(() => extractDocKeys(noMarkerSeg), /白名单段必须可定位/,
    "腿 C ①：段级失配 ⇒ 提取器入口的**非空断言必红**（空集不得静默通过）")
  //
  //   构造 ②（**块非空但零键名 ⇒ 提取器返回空集**，即 §9 的「提取器返回空集」支）：取**真实
  //     白名单段**，把段内**拉丁 token 机械抹平**（键名与噪声一起消失）⇒ 段级切分照常成功
  //     （块非空 ⇒ 入口断言通过）⇒ 提取器**返回** `keys.size === 0`。⇒ 对**这条空集**逐字复跑
  //     ⓵/⓶/⓷ 实际调用的那道护栏 ⇒ **必红**——这就是设计承诺的那条负控。
  const tokenlessBlock = ymlBlock.replace(/[A-Za-z][A-Za-z0-9]*/g, "键")
  const emptyKeys = extractDocKeys(tokenlessBlock).keys
  assert.equal(emptyKeys.size, 0,
    "腿 C 构造自证②：抹平段内拉丁 token 后提取集必须为**空**（实得 " + emptyKeys.size
    + " 名：" + JSON.stringify([...emptyKeys]) + "）——否则本条没在验空集")
  assert.throws(() => assertDocKeysNonEmpty(emptyKeys, "腿 C 构造②"),
    /提取集非空/,
    "腿 C ②：提取器返回空集 ⇒ **防恒真护栏必红**（证明 `keys.size >= 1` 真的会红，而它平时是绿的）")
  //   阳性对照（防「腿 C 恒红」的假绿）：同一道护栏对**非空集**必须**不**抛。
  assert.doesNotThrow(() => assertDocKeysNonEmpty(new Set(["provider"]), "腿 C 阳性对照"),
    "腿 C 阳性对照：同一道护栏对非空集不得抛——否则本腿是恒红断言，什么也没证明")

  // —— ⑤ 提取器自证（陷阱实证：不做**行级排除子句切分**就会多抓排除子句里的名）——
  const noExclSplit = new Set()
  for (const raw of ymlBlock.split(/\r?\n/)) {
    const s = raw.replace(/^\s*(\/\/|\*|#|-)\s*/, "").replace(/`/g, "")
    for (const t of (s.match(DOCKEY_RE) ?? [])) if (t.length >= 3) noExclSplit.add(t)
  }
  assert.ok(noExclSplit.size > ymlKeys.size + ymlAdv.size,
    "实证：不切排除子句会多抓（实测 " + noExclSplit.size + " > 正式提取 " + (ymlKeys.size + ymlAdv.size) + "）")
  assert.ok(noExclSplit.has("engineering"),
    "实证：排除句里的 `engineering` 在不切排除子句时会被当成键抓进来")
  assert.ok(!ymlKeys.has("engineering") && ![...ymlAdv].includes("engineering"),
    "实证的反面：正式提取器必须滤掉 engineering")

  // —— ⑥ ★ 悬空指针零命中（A9 / AC-14：`lib/**` 内的**两个死名**）——
  // 批 14 / FR-5 把 10 处指向两份**从未提交**的设计档的引用逐处删净（只删指针 + 连接词手术、
  // 零新增散文、**不重指**——仓内无对应的 DSH 适配档，重指会造新假指针）。本腿把它变成**常设锁**：
  // **只扫 `lib/**`**——`docs/` 里对这两个死名的历史记录是合法存在，不进锁域。
  // ★ 本腿是**变异自证逼出来的**：批 14 的变异 M4（往 `lib/state.mjs` 塞回一处引用）实测**全绿**
  //   ⇒ 说明 A9 当时**只有 grep 谓词、没有进程内断言** ⇒ 现补上（否则 AC-14 在套件里不可证）。
  const DEAD_NAMES = ["DESIGN-dsh-port.md", "DESIGN-advisor-token-protocol-fix.md"]
  const libHits = []
  const walkLib = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walkLib(p); continue }
      if (!/\.(mjs|js|ts|json|ya?ml|md)$/.test(e.name)) continue
      const s = readFileSync(p, "utf8")
      for (const d of DEAD_NAMES) if (s.includes(d)) libHits.push(p.replace(PLUGIN_DIR + "\\", "").replace(PLUGIN_DIR + "/", "") + " ← " + d)
    }
  }
  walkLib(join(PLUGIN_DIR, "lib"))
  assert.deepEqual(libHits, [], "`lib/**` 内两个死名必须零命中（只锁 lib/**；docs/ 里的历史记录不入锁域）：" + JSON.stringify(libHits))
  // 谓词自证：域必须真的非空（否则「零命中」是恒真量——空目录永远零命中）
  const libFiles = []
  const countLib = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) countLib(p); else libFiles.push(p) } }
  countLib(join(PLUGIN_DIR, "lib"))
  assert.ok(libFiles.length >= 20, "谓词自证：`lib/**` 域必须非空（实测 " + libFiles.length + " 档）——否则「零命中」恒真")
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

// ————————————— 批 10 / D-31：PUT 的**静默清盘灭绝**（handler 级；AC-D1/AC-D2/AC-D3 + 锚 M7/M8） —————————————

test("T-D31 (AC-D1/AC-D2/AC-D3 / 锚 M7+M8): 含未知顶层键的 PUT ⇒ 400 + 点名 + **盘字节不变**；全已知键/空配置照旧", async () => {
  // 旧态（批 10 前，父侧实测复现）：全未知键 PUT ⇒ **200「已保存」** + `sanitized === {}` ⇒
  // `saveUserConfig({})` **整体替换** ⇒ **既有 user 层配置被整档清空**。本用例是那条路径的
  // **独立回归锚**：判据 = HTTP 状态 + errors 点名 + **磁盘字节前后快照比对**。
  const home = mkHome()
  try {
    const seeded = { advisor: { round1: { provider: "qax", model: "glm-5.3" } }, engCoderMaxTokens: 65536 }
    assert.equal(saveUserConfig(seeded, home), true)
    const storePath = resolveConfigStorePath(home)
    const before = readFileSync(storePath, "utf8")

    const handler = makeApiHandler({}, {
      baseConfig: {}, sessionExists: () => false, agentOptionsOf: () => ({}),
      stateOf: () => ({}), settingsGet: () => null, cwdHint: undefined, dshHomeOverride: home,
    })
    const call = async (method, path, body) => {
      let status = 0, payload = ""
      const res = { writeHead: (c) => { status = c }, end: (t) => { payload = String(t) } }
      const text = JSON.stringify(body)
      const req = { url: "http://localhost" + path, method, [Symbol.asyncIterator]: async function* () { yield text } }
      await handler(req, res)
      return { status, payload: payload ? JSON.parse(payload) : null }
    }
    const PUT = (body) => call("PUT", CONFIG_API_PREFIX + "/config", body)

    // ① 全未知键 ⇒ 400 + **每个**未知键都被点名 + 白名单提示 + 盘字节**一字不变**
    const r1 = await PUT({ config: { bogusField: 123, anotherBogus: "x" } })
    assert.equal(r1.status, 400, "全未知键 ⇒ 400（不是 200「已保存」）：" + JSON.stringify(r1.payload))
    for (const k of ["bogusField", "anotherBogus"]) {
      assert.ok((r1.payload.errors ?? []).some((e) => e.includes(k)),
        "errors 必须点名未知键 " + k + "：" + JSON.stringify(r1.payload.errors))
    }
    assert.ok((r1.payload.errors ?? []).some((e) => e.includes("user-layer whitelist")),
      "errors 必须带白名单提示（可行动）：" + JSON.stringify(r1.payload.errors))
    assert.equal(readFileSync(storePath, "utf8"), before, "**盘字节必须不变**（静默清盘路径灭绝）")
    assert.deepEqual(loadUserConfig(home), seeded, "既有配置原样保留")

    // ② 混合（合法 + 未知）⇒ 仍 400 且盘不变（报错面优先于部分成功）
    const r2 = await PUT({ config: { engCoderMaxTokens: 65536, nope: 1 } })
    assert.equal(r2.status, 400, "混合请求同样 400")
    assert.equal(readFileSync(storePath, "utf8"), before, "混合请求同样不动盘")

    // ③ 全已知键 ⇒ 200 且真的落盘（零回归）
    const r3 = await PUT({ config: { engCoderMaxTokens: 32768 } })
    assert.equal(r3.status, 200, "全已知键照旧 200：" + JSON.stringify(r3.payload))
    assert.deepEqual(loadUserConfig(home), { engCoderMaxTokens: 32768 }, "整体替换语义不变（D10-12）")

    // ④ `{config:{}}` = 有意清空 ⇒ 仍 200 且盘为空配置（边界 6：删除键靠「缺席」表达）
    const r4 = await PUT({ config: {} })
    assert.equal(r4.status, 200, "空配置是有意清空，不是错误：" + JSON.stringify(r4.payload))
    assert.deepEqual(loadUserConfig(home), {}, "盘上留下空配置（语义不受损）")
  } finally { rmHome(home) }
})

// ————————————— 批 20 修复轮（D20-8 / AC-8 / US-8 / 锚 A12）：DELETE /config 的失败可见面（handler 级） —————————————

test("A12 (批 20 修复轮 / AC-8 / US-8): DELETE /config 清除失败 ⇒ ok:false + 500（改前无条件 ok:true —— 面向用户的谎）", async () => {
  // 审计🔴1：AC-8 / A12 / FR-3§5.3-③ / D20-8 / US-8 完全未实施——DELETE /config 丢弃 clearUserConfig
  // 返回值并无条件 send({ok:true})。注入「清除失败」无需 fs 竞态：dshHomeOverride 缺省 + cwdHint 指向
  // 无 profile 根的深层临时目录（U6c 同款已证形态）⇒ resolveConfigStorePath ⇒ null ⇒ clearUserConfig
  // 直接返回 false（存储路径不可解析失败面）。前置断言钉死注入成立，防假绿。对照先例：PUT 路径的
  // save 失败面（T-D31 档内：ok:false + 500 + error 文案）。
  const root = mkHome()
  try {
    const unreachable = join(root, "no", "profile", "here")
    assert.equal(resolveConfigStorePath(undefined, unreachable), null,
      "前置自证：注入的清除失败必须真的成立（路径不可解析 ⇒ clearUserConfig 必返回 false）")
    const handler = makeApiHandler({}, {
      baseConfig: {}, sessionExists: () => false, agentOptionsOf: () => ({}),
      stateOf: () => ({}), settingsGet: () => null,
      cwdHint: () => unreachable, dshHomeOverride: undefined,
    })
    let status = 0, payload = ""
    const res = { writeHead: (c) => { status = c }, end: (t) => { payload = String(t) } }
    const req = {
      url: "http://localhost" + CONFIG_API_PREFIX + "/config", method: "DELETE",
      [Symbol.asyncIterator]: async function* () { },
    }
    await handler(req, res)
    const body = payload ? JSON.parse(payload) : null
    assert.equal(status, 500, "清除失败 ⇒ 500（改前是无条件 200「成功」）：" + JSON.stringify(body))
    assert.equal(body && body.ok, false, "响应必须 ok:false（改前无条件 ok:true）：" + JSON.stringify(body))
    assert.ok(typeof (body && body.error) === "string" && body.error.length > 0,
      "error 字段在场且非空（对齐 PUT 先例的失败面形态）：" + JSON.stringify(body))
  } finally { rmHome(root) }
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
