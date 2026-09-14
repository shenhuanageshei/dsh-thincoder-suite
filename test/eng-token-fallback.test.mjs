// eng-token-fallback.test.mjs — 批 10（D-36）：写门禁的**内存态为空时读盘回退腿**（显式三态路由）。
// 设计档：docs/2026-09-13-ledger-discipline-design.md
//   §5.2 图 2（判据与失败方向）· §6.3 机制伪代码 · §8.2 机验锚 M9–M12 · §9 边界 7/8/9
//   §10「推翻 D1」专节 · §11.2 AC-G1…AC-G6
// ★ 批 10 交付代码评审 🔵#4（收尾轮）：T-TF4 增补一条腿——盘记录 `token` **非空但形状不可解析**时
//   盘态路由为 missing（复用既有 no-token 文案），**不归 expired**（见 lib/eng.mjs 的 diskState）。
// 纪律：零网络、零真实 LLM、零长等待；不读真 config / session 盘。
// 隔离：`process.env.DSH_HOME` 置空 + `makeWriteGate(getConfigDefault, storPathOverride)` 的
//   可选第二参（测试缝，向后兼容）指向临时目录 ⇒ 不碰真实 $DSH_HOME。会话 id 用 randomUUID。
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { makeWriteGate } from "../lib/eng.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
import { resolveTokenStorePath, removeTokenRecord } from "../lib/token-store.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
/** 隔离契约（对齐既有测试档）：空串 = 显式无 env ⇒ 只走 override 临时目录。 */
process.env.DSH_HOME = ""

const mkHome = () => mkdtempSync(join(tmpdir(), "thincoder-b10g-"))
const rmHome = (h) => { try { rmSync(h, { recursive: true, force: true }) } catch { /* 已清理 */ } }
const newSid = () => "b10-" + randomUUID()
const cleanSid = (sid) => { try { dropSession(sid) } catch { /* noop */ } }
/** 产品代码（门禁的拦截域 —— path-kind 单一权威判它 true）。 */
const PRODUCT = join(PLUGIN_DIR, "lib", "eng.mjs")

/** 两段式令牌（D-30）：`<uuid>:<expiresAt>`。 */
const mint = (ttlMs) => randomUUID() + ":" + (Date.now() + ttlMs)
/**
 * 直接写令牌盘（**必须绕过 `saveTokenRecord`**）：它带「过期且无指纹 ⇒ 删除」的清扫规则，
 * 用它会造不出「盘上有过期记录」这一被测形态。
 */
function writeStore(home, tokens) {
  mkdirSync(join(home, ".thincoder"), { recursive: true })
  writeFileSync(resolveTokenStorePath(home), JSON.stringify({ version: 1, tokens }, null, 2) + "\n", "utf8")
}
/** 跑一次门禁（默认：主代理 depth 0 + 产品码写）。 */
async function runGate(gate, sid, { depth = 0, name = "write", file = PRODUCT, cwd = PLUGIN_DIR } = {}) {
  let allowed = false
  const next = async () => { allowed = true; return { kind: "next" } }
  const agent = { session: { id: sid, header: { cwd, delegationDepth: depth } } }
  const res = await gate({ name, arguments: { file_path: file }, agent }, next)
  return { allowed, res }
}
/** 捕获 console.warn（日志断言 = M9 的「有日志」腿）。 */
async function withWarns(fn) {
  const warns = []
  const orig = console.warn
  console.warn = (m) => warns.push(String(m))
  try { return { value: await fn(), warns } } finally { console.warn = orig }
}
const freshState = (sid) => { dropSession(sid); return sessionState(sid) }

// ————————————— M9：三态（valid ⇒ 放行 + 回填 + 日志 / expired ⇒ expired 文案 / missing ⇒ no-token 文案） —————————————

test("T-TF1 (AC-G1 / 锚 M9): 内存态为空 + 本会话有效盘记录 ⇒ 放行 + 已回填 + **有日志**", async () => {
  const home = mkHome()
  const sid = newSid()
  const token = mint(3600_000)
  writeStore(home, { [sid]: { token, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
  try {
    const state = freshState(sid)
    assert.equal(state.designToken, null, "前提：内存态为空（重启后的形态）")
    const gate = makeWriteGate(() => true, home)
    const first = await withWarns(() => runGate(gate, sid))
    assert.equal(first.value.allowed, true, "有效盘记录 ⇒ 放行（D-36 的痛被消掉）")
    assert.equal(state.designToken, token, "回填进 state.designToken（(e)：避免每次写操作重复读盘）")
    assert.ok(first.warns.some((w) => w.includes("gate: design token restored from token-store") && w.includes(sid)),
      "放行必须**留痕**（D10-13「显式 + 留痕」回应的正是 D1 的「静默」）：" + JSON.stringify(first.warns))
    // 二次调用走内存快路径 ⇒ 不再读盘、不再告警
    const second = await withWarns(() => runGate(gate, sid))
    assert.equal(second.value.allowed, true)
    assert.deepEqual(second.warns, [], "已回填 ⇒ 走内存路径 ⇒ 零新增告警")
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-TF2 (AC-G2 / 锚 M9): 三态**各自接线到既有的对应拒绝分支** —— 过期拿 expired 文案，无记录/他会话拿 no-token 文案", async () => {
  // ① 盘记录**已过期** ⇒ denied 且走 expired 文案（不新造第二条文案、也不落穿到 no-token）
  const homeA = mkHome()
  const sidA = newSid()
  const expAt = Date.now() - 120000
  writeStore(homeA, { [sidA]: { token: sidA + ":" + expAt, issuedAt: expAt - 3600_000, expiresAt: expAt } })
  try {
    const state = freshState(sidA)
    const gate = makeWriteGate(() => true, homeA)
    const r = await runGate(gate, sidA)
    assert.equal(r.allowed, false, "过期 ⇒ 拒")
    assert.equal(r.res?.kind, "deny")
    assert.ok(/expired at/.test(r.res.reason), "必须拿**既有 expired 文案**：" + r.res.reason)
    assert.ok(!/no design token/.test(r.res.reason), "不得落穿到 no-token 分支（评审 #3 的订正点）")
    assert.equal(state.designToken, null, "过期 ⇒ 不回填")
  } finally { cleanSid(sidA); rmHome(homeA) }

  // ② 本会话**无记录**（文件不存在）⇒ no-token 文案
  const homeB = mkHome()
  const sidB = newSid()
  try {
    const gate = makeWriteGate(() => true, homeB)
    const r = await runGate(gate, sidB)
    assert.equal(r.allowed, false, "无记录 ⇒ 拒")
    assert.ok(/no design token/.test(r.res.reason), "走 no-token 文案：" + r.res.reason)
    assert.ok(!/expired at/.test(r.res.reason), "不得说「过期」（它从未签发）")
  } finally { cleanSid(sidB); rmHome(homeB) }

  // ③ 盘上有记录但属于**别的会话** ⇒ sessionId 精确匹配不命中 ⇒ no-token 文案（边界 9）
  const homeC = mkHome()
  const sidC = newSid()
  const other = newSid()
  writeStore(homeC, { [other]: { token: mint(3600_000), issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
  try {
    const state = freshState(sidC)
    const gate = makeWriteGate(() => true, homeC)
    const r = await runGate(gate, sidC)
    assert.equal(r.allowed, false, "他会话的记录不命中 ⇒ 拒")
    assert.ok(/no design token/.test(r.res.reason))
    assert.equal(state.designToken, null, "不得回填别的会话的令牌")
  } finally { cleanSid(sidC); rmHome(homeC) }
})

// ————————————— M10/M11：失效方向（撤销后重启仍拒 · 读盘失败 ⇒ 拒） —————————————

test("T-TF3 (AC-G3 / 锚 M10): **撤销后重启仍拒** —— 盘记录已删 ⇒ 同 sessionId 新内存态 ⇒ 拒", async () => {
  const home = mkHome()
  const sid = newSid()
  const token = mint(3600_000)
  writeStore(home, { [sid]: { token, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
  try {
    const gate = makeWriteGate(() => true, home)
    freshState(sid)
    assert.equal((await runGate(gate, sid)).allowed, true, "前提：有效盘记录先放行一次（并回填）")
    // 撤销 = **同流程双清**（advisor.mjs）：内存置 null + 删盘记录
    sessionState(sid).designToken = null
    assert.equal(removeTokenRecord(sid, home), true, "撤销删除盘记录")
    const left = existsSync(resolveTokenStorePath(home))
    // 模拟重启：同 sessionId、全新内存态（内存态**不持久化**——D-30 契约）
    const state = freshState(sid)
    assert.equal(state.designToken, null, "重启后内存态为空")
    const r = await runGate(gate, sid)
    assert.equal(r.allowed, false, "撤销后重启**仍拒**（「不削弱门禁」论证的落点）"
      + "（盘文件存在性 = " + left + "）")
    assert.ok(/no design token/.test(r.res.reason), r.res.reason)
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-TF4 (AC-G4 / 锚 M11): 读盘失败（损坏 / 结构畸形 / **token 形状不可解析** / 路径不可解析）⇒ **拒**，不 fail-open", async () => {
  const home = mkHome()
  const sid = newSid()
  try {
    const gate = makeWriteGate(() => true, home)
    const state = freshState(sid)
    // ① 非 JSON
    mkdirSync(join(home, ".thincoder"), { recursive: true })
    writeFileSync(resolveTokenStorePath(home), "{ not json !!!", "utf8")
    const r1 = await runGate(gate, sid)
    assert.equal(r1.allowed, false, "损坏文件 ⇒ 拒（fail-closed；loadTokenRecord 的 fail-safe → null → 无记录）")
    assert.ok(/no design token/.test(r1.res.reason), r1.res.reason)
    // ② 结构畸形（tokens 非对象 / 记录非对象）
    writeFileSync(resolveTokenStorePath(home), JSON.stringify({ version: 1, tokens: [1, 2, 3] }), "utf8")
    assert.equal((await runGate(gate, sid)).allowed, false, "tokens 形态畸形 ⇒ 拒")
    writeFileSync(resolveTokenStorePath(home), JSON.stringify({ version: 1, tokens: { [sid]: "nope" } }), "utf8")
    assert.equal((await runGate(gate, sid)).allowed, false, "记录非对象 ⇒ 拒")
    // ③ **记录是对象、`token` 非空，但形状不可解析**（**批 10 交付评审 🔵#4**）⇒ 路由为 **missing**
    //    ⇒ 拿**既有 no-token 文案**，**不得**说「过期」——与 `loadTokenRecord` 对畸形记录的
    //    fail-safe **同向**：判据是「这枚凭证**不可用**」，不是「这枚凭证**过期了**」。
    //    ★ 自证可失败：把 `diskState` 的第三态改回「一律 expired」⇒ **本条转红**（见下方两例）。
    const pastMs = Date.now() - 7 * 24 * 3600 * 1000
    const MALFORMED_TOKENS = [
      // 前两例：`tokenExpiryMs` 为 null（第二段不可解析）。旧写法下盘态是 "expired" 而渲染的是
      //   no-token 文案 ⇒ **态与文案不符**（文案恰好没骗人）。这两例**不构成致红腿**——它们锁的是
      //   「路由为 missing / 不归 expired」这条判定本身（改成 "valid"、或让 diskToken 解析出错即红）。
      ["无冒号（1 段）", "not-a-token"],
      ["第二段非数字（2 段）", sid + ":notanumber"],
      // 后两例：**第二段恰可解析为过去的毫秒时间戳**。旧写法下 `gateExpired === true` ⇒ 渲染出
      //   **假的**「expired at …」（这枚凭证的**形状**今日已不可用，而不是它**到期**了）⇒ **致红腿**。
      ["旧版式（3 段；第二段 = 过去的毫秒时间戳）", sid + ":" + pastMs + ":docHash"],
      ["四段畸形（第二段 = 过去的毫秒时间戳）", sid + ":" + pastMs + ":x:y"],
    ]
    for (const [label, bad] of MALFORMED_TOKENS) {
      writeStore(home, { [sid]: { token: bad, issuedAt: pastMs, expiresAt: pastMs } })
      const r = await runGate(gate, sid)
      assert.equal(r.allowed, false, label + " ⇒ 拒（拒绝方向不变）")
      assert.equal(r.res?.kind, "deny", label + " ⇒ deny")
      assert.ok(/no design token/.test(r.res.reason),
        label + " ⇒ 必须走**既有 no-token 文案**（路由为 missing）：" + r.res.reason)
      assert.ok(!/expired at/.test(r.res.reason),
        label + " ⇒ **不得**说「过期」（形状不可解析 ≠ 过期）：" + r.res.reason)
    }
    // ④ 路径不可解析（无 override、无 DSH_HOME、cwdHint 探测不到 profile 根）⇒ 无记录 ⇒ 拒
    const nowhere = mkdtempSync(join(tmpdir(), "thincoder-nohome-"))
    try {
      const gateNoHome = makeWriteGate(() => true)
      const r3 = await runGate(gateNoHome, sid, { cwd: nowhere })
      assert.equal(r3.allowed, false, "盘路径不可解析 ⇒ 拒（不是「读不到就放行」）")
      assert.ok(/no design token/.test(r3.res.reason), r3.res.reason)
    } finally { rmHome(nowhere) }
    assert.equal(state.designToken, null, "以上任何形态都不得回填")
  } finally { cleanSid(sid); rmHome(home) }
})

// ————————————— M12：内存路径零行为变更 + 回退腿不越界 —————————————

test("T-TF5 (AC-G5 / 锚 M12): **内存路径逐字不动 + 三态路由仅在内存态为空时可达** —— 内存有令牌时判定结果与盘记录无关", async () => {
  // ★ 批 10 分歧审计 #7：本条原标题声称覆盖「(a) 仅内存态为空时读盘」，**超出它实际能检出的事**。
  //   实测：把读盘那一行（`if (!state.designToken) {`）的守卫改成无条件 `if (true)` 之后，
  //   **本条仍绿**——那次读盘是**纯**且 fail-safe 的（`loadTokenRecord` 不抛、不写状态），
  //   而三态**路由**仍被 `!state.designToken` 门着 ⇒ 内存态非空时**没有任何可观测差异**
  //   （放行 / 拒绝 / 回填 / 日志四者全同）。⇒ 标题改为它**真能检出**的事，不再声称能检出那一条。
  //   本条的实际约束力（两条腿）：
  //     ① 内存有有效令牌 + 盘上**过期**记录 ⇒ 放行、内存值不被覆盖、**零日志**（盘记录不参与判定）；
  //     ② 内存令牌**过期** + 盘上**有效**记录 ⇒ 拒 + 既有 expired 文案 + **不回填**。
  //   变异证据（**实测**）：两条守卫**同时**打开才转红 —— 只改读盘守卫 `if (true)` 或只去掉
  //   `diskState` 的门，本条**都仍绿**（二者的任一条单独存在即已足够保持「内存非空 ⇒ 盘记录
  //   不参与判定」这条不变式）。**同时**打开时，腿 ② 红：`内存令牌过期 ⇒ 拒` 实得 `allowed=true`
  //   —— 与设计档 §13.3 的 M12 变异（「去掉『仅内存态为空才读盘』+ `diskState` 去门」）逐字对应。
  //   「读盘那一行是否被 `!state.designToken` 门着」**不在本条覆盖面内**（它**单独**改动无可观测
  //   差异）：它由 `test/guard-e.test.mjs` 的 `WRITE_GATE_FIXTURE`（`makeWriteGate` 函数体
  //   **逐字节**夹具）承担——实测该夹具在该变异下转红；同一谓词**不在此处复制第二份**
  //   （D10-1 的「判据单一权威」律）。
  // ① 内存有**有效**令牌 + 盘上是**过期**记录 ⇒ 仍放行、内存值不被覆盖、零日志
  const homeA = mkHome()
  const sidA = newSid()
  writeStore(homeA, { [sidA]: { token: sidA + ":" + (Date.now() - 60000), issuedAt: Date.now() - 3600000, expiresAt: Date.now() - 60000 } })
  try {
    const state = freshState(sidA)
    const token = mint(3600_000)
    state.designToken = token
    const gate = makeWriteGate(() => true, homeA)
    const r = await withWarns(() => runGate(gate, sidA))
    assert.equal(r.value.allowed, true, "内存有效令牌 ⇒ 放行（既有语义逐字不变）")
    assert.equal(state.designToken, token, "内存令牌不被盘记录覆盖")
    assert.deepEqual(r.warns, [], "盘记录不参与判定 ⇒ 零日志（内存路径不因盘记录产生任何可观测副作用）")
  } finally { cleanSid(sidA); rmHome(homeA) }

  // ② 内存令牌**已过期** + 盘上是**有效**记录 ⇒ 拒（既有 expired 文案）且**不回填**盘上的有效值
  const homeB = mkHome()
  const sidB = newSid()
  writeStore(homeB, { [sidB]: { token: mint(3600_000), issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
  try {
    const state = freshState(sidB)
    const stale = sidB + ":" + (Date.now() - 60000)
    state.designToken = stale
    const gate = makeWriteGate(() => true, homeB)
    const r = await runGate(gate, sidB)
    assert.equal(r.allowed, false, "内存令牌过期 ⇒ 拒（既有语义：门禁绝不在此续期）")
    assert.ok(/expired at/.test(r.res.reason), "既有 expired 文案：" + r.res.reason)
    assert.equal(state.designToken, stale, "内存非空 ⇒ **不读盘**、不回填（这正是「不是放宽」的关键约束）")
  } finally { cleanSid(sidB); rmHome(homeB) }
})

test("T-TF6 (AC-G6 配套 / 零回归): 回退腿不越界 —— 子代理 / 非产品码 / eng OFF / 单参旧形态 一律按既有语义", async () => {
  const home = mkHome()
  const sid = newSid()
  const token = mint(3600_000)
  writeStore(home, { [sid]: { token, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
  try {
    const gate = makeWriteGate(() => true, home)
    freshState(sid)
    // ① depth > 0：子代理是 sanctioned 实现者 ⇒ 放行（且不读盘、不回填）——门禁既有语义
    const sub = await runGate(gate, sid, { depth: 1 })
    assert.equal(sub.allowed, true, "depth>0 豁免（既有语义不动）")
    assert.equal(sessionState(sid).designToken, null, "子代理路径不触发回填")
    // ② 非产品码（文档）⇒ 放行（门禁只管产品代码）
    const doc = await runGate(gate, sid, { file: join(PLUGIN_DIR, "docs", "README.md") })
    assert.equal(doc.allowed, true, "文档可写（既有语义不动）")
    // ③ eng OFF ⇒ 放行（模式门在 token 之前）
    const gateOff = makeWriteGate(() => false, home)
    const off = await runGate(gateOff, sid)
    assert.equal(off.allowed, true, "eng OFF ⇒ 门禁不介入")
    // ④ 单参旧形态仍可构造（向后兼容：storPathOverride 是**可选**第二参）
    assert.equal(typeof makeWriteGate(() => true), "function", "单参调用形态零改动")
    // ⑤ 产品码 + 有效盘记录 + 内存空 ⇒ 仍放行（与 ①②③④ 同一条门禁，确认上面的放行不是「门禁失效」）
    const ok = await runGate(gate, sid)
    assert.equal(ok.allowed, true, "回到正题：本会话有效盘记录 ⇒ 放行")
    assert.equal(sessionState(sid).designToken, token, "回填")
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-TF7 (AC-G6 / 锚 M13): **D1 注释已同步改写** —— 旧注释字面零残留 + 翻案说明在位（防 doc-code drift）", () => {
  // 本修复是**对既有裁定 D1 的明示推翻**（决策 D10-13）。注释与新行为矛盾 = doc-code drift
  // ⇒ 交付评审必查；**否则下一轮分歧审计会把本修复当回归抓出来**（设计档 §10 的明文要求）。
  // 断言的是 `eng.mjs` 的**源码字节**（独立事实源），不借任何台账。
  const engSrc = readFileSync(join(PLUGIN_DIR, "lib", "eng.mjs"), "utf8")
  assert.ok(!engSrc.includes("避免有效盘 token 驻留 state"),
    "旧注释字面必须零残留（它与新行为矛盾）——实得命中数 = " + (engSrc.split("避免有效盘 token 驻留 state").length - 1))
  assert.ok(engSrc.includes("翻案说明"), "新注释必须**显式登记本批翻案**（防下轮审计误判为回归）")
  assert.ok(engSrc.includes("docs/2026-09-13-ledger-discipline-design.md") && engSrc.includes("§10"),
    "新注释必须指向设计档的「推翻 D1」专节（§10）")
  assert.ok(engSrc.includes("避免盘上有效 token 经一次调用就驻留 state"),
    "改写后的措辞必须**保留原关切的描述**（改的是结论，不是隐去旧理由）")
  // 谓词自证（律 3）：上面的检索**不是恒真/恒假**——同一条断言在同一份源码上正反都有对应物
  assert.ok(engSrc.includes("回填收窄为「传入 token === 盘上记录 token」"),
    "自证：该区段的**保留部分**（错 token 不回填）仍在源码里")
})
