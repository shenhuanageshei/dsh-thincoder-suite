// session-state.test.mjs — F12 会话级状态持久化单元测试（docs/2026-09-02-session-state-stages-design.md §6）。
// 覆盖 T1（restore 直测 + session-start 接线/section 重挂）、T2（round 2 + prior 恢复 → 收敛轮带
// prior）、T3（normalizeRestored 规范化）、T4（advisorOverride/touchedFiles/mutatedThisRun 恢复 + 去重
// 封顶 200）、T5（损坏/缺失/不可写 fail-safe）、T6（session/disposed 删除 + 写时清扫 7d）、
// T7（designToken 绝不入 session-state.json）、T8（与 design-tokens.json 分文件回滚独立）、
// T15（只填空槽守卫）+ §2.3 写点（eng 翻转 / eng_coder 交付 / advisor 完成分支与 F11 类型切换 /
// advisor_config set/reset / config API apply/reset-session）。
// node:test 零依赖；临时 DSH_HOME（storPathOverride 注入缝或 env）不碰真实 $DSH_HOME。
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID, createHmac } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import {
  sessionState, dropSession, restoreSessionState, viewOfSessionState, persistedSessionView,
} from "../lib/state.mjs"
import {
  saveSessionState, loadSessionState, removeSessionState, resolveSessionStorePath,
  normalizeRestored, STATE_TTL_MS, TOUCHED_FILES_CAP,
} from "../lib/session-store.mjs"
import { runAdvisorReview, runAdvisorConfigTool } from "../lib/advisor.mjs"
import { engineeringToggle, runEngCoder, attachEngineeringSection } from "../lib/eng.mjs"
import { apply, applySessionOverride, resetSessionOverride, makeApiHandler } from "../lib/index.mjs"
import { saveTokenRecord, loadTokenRecord, resolveTokenStorePath } from "../lib/token-store.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// 屏蔽宿主 DSH_HOME（本机指向真实 profile）：本文件除 apply() 接线用例（用例内显式设置并
// 复原）外全走 storPathOverride/env 临时目录，避免真实 session-state/config 污染。进程内生效。
process.env.DSH_HOME = ""

const mkHome = () => mkdtempSync(join(tmpdir(), "thincoder-f12-"))
const rmHome = (h) => { try { rmSync(h, { recursive: true, force: true }) } catch { /* 已清理 */ } }

/** 铸造一枚格式合法的 design token（uuid:expiresAt:hmac16，同 advisor 签发口径）。 */
function makeToken(expiresAt = Date.now() + 3600_000) {
  const secret = process.env.THINCODER_TOKEN_SECRET || "thincoder-default-secret"
  const payload = randomUUID() + ":" + expiresAt
  return payload + ":" + createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16)
}

/** advisor 用 agent stub（route 走 agent options；deriveMessages 空）。 */
function makeAgent(id, header = {}) {
  return {
    session: { id, header: { cwd: PLUGIN_DIR, ...header }, deriveMessages: () => [] },
    options: { provider: "p", model: "m" },
  }
}

/** eng_coder 用 deps stub：subagents.start 收集 request 并返回固定交付报告。 */
function makeEngDeps(id, dshHome, started) {
  const subagents = {
    async start(kind, req) {
      started.push(req)
      return {
        result: Promise.resolve({
          output: [{ type: "text", text: "delivered ok\n\nTouched files: lib/a.mjs" }],
          stopReason: "completed", diagnostic: null,
        }),
        dispose: async () => {},
      }
    },
  }
  return {
    ctx: { subagents },
    agent: { session: { id, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
    config: {}, signal: undefined, configDefaultEngineering: false, storPathOverride: dshHome,
  }
}

/** eng 会话 fixture：engineering=true + 有效 design token（+ 可选已有轮次/prior）。 */
function makeEngState(id, round = 0, prior = null) {
  const state = sessionState(id)
  state.engineering = true
  state.designToken = makeToken()
  state.advisorRound = round
  state.lastAdvisorOutput = prior
  return state
}

/** 通过型 code 评审 LLM stub：返回 ≥200 字符的表格式评审文本（looksLikeReview=true）。 */
const REVIEW_TEXT = "| # | Category | Severity | Issue | Suggestion |\n"
  + "| 1 | Correctness | 🟡 | issue detail line one | fix suggestion |\n"
  + "| 2 | Maintainability | 🔵 | minor naming | rename |\n"
  + "Overall the implementation looks reasonable; the convergence protocol is followed. "
  + "No critical findings this round; the table above lists advisory items only."
function reviewishLlm() {
  const calls = []
  return {
    calls,
    stream(opts) {
      calls.push(opts)
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: REVIEW_TEXT } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
}

/** 通过型 design 评审 LLM stub：提取 [APPROVE:<code>] 并回显 → 触发签发（R2，同 F10 测试）。 */
function approvingLlm() {
  return {
    stream(opts) {
      const userText = opts?.messages?.[0]?.content?.[0]?.text ?? ""
      const m = userText.match(/\[APPROVE:([0-9a-f]{8})\]/)
      const code = m ? m[1] : "00000000"
      const echo = "The design is approved with no unresolved Critical issues.\n\n[APPROVE:" + code + "]"
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: echo } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
}

/**
 * apply() 接线用 fake ctx：捕获 ctx.on 事件处理器 / systemPrompt sections / 注册工具。
 * ctx.effect 立即执行（cordis 已启动语境）；ctx.get 返回 null（agents/settings/webServer
 * 不可用 → 各自降级路径，与生产容错分支一致）。
 */
function makeFakeCtx() {
  const sections = []
  const registeredTools = []
  const handlers = new Map()
  const cleanups = []
  const fakeCtx = {
    sections, registeredTools,
    on: (ev, fn) => {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(fn)
      return () => { /* disposer no-op（测试语境） */ }
    },
    emit: (ev, payload) => { for (const fn of handlers.get(ev) ?? []) fn(payload) },
    effect: (fn) => {
      const d = fn?.()
      cleanups.push(d)
      return () => d?.()
    },
    systemPrompt: { section: (opts) => { sections.push(opts); return () => {} } },
    tools: { register: (t) => { registeredTools.push(t); return () => {} } },
    get: () => null,
    cleanups,
  }
  return fakeCtx
}

// ————————————— T1（单元部分）：eng enter 落盘 + 重启恢复 —————————————

test("T1: eng enter persists engineering=true; restart sim (drop memory) + restore → engineering=true; engSection NOT persisted, re-attach via attachEngineeringSection", () => {
  const home = mkHome()
  const sid = "f12-t1-" + randomUUID()
  try {
    const agent = makeAgent(sid)
    const out = engineeringToggle(agent, false, "enter", { storPathOverride: home })
    assert.match(out, /Engineering mode ON/)
    const path = resolveSessionStorePath(home)
    assert.ok(path && existsSync(path))
    const file = JSON.parse(readFileSync(path, "utf8"))
    assert.equal(file.version, 1)
    assert.equal(file.sessions[sid].engineering, true)
    assert.equal(typeof file.sessions[sid].lastSeen, "number")
    // 模拟重启：清内存 → 预载恢复（注意：不得在 restore 前调 sessionState()——那会先建槽，
    // 触发 T15 只填空槽守卫；恢复成功本身即证明槽是空的）
    dropSession(sid)
    const snap = loadSessionState(sid, home)
    assert.ok(snap, "on-disk entry loadable")
    const r = restoreSessionState(sid, snap)
    assert.equal(r.restored, true)
    const state = sessionState(sid)
    assert.equal(state.engineering, true)
    assert.equal(state.engSection, null, "engSection is process-local (not persisted, §2.1)")
    // 重挂：既有守卫路径（engineering===true && !engSection → attach）
    const disposer = () => { disposed = true }
    let disposed = false
    const agent2 = { ...makeAgent(sid), ctx: { systemPrompt: { section: () => disposer } } }
    if (state.engineering === true && !state.engSection) {
      state.engSection = attachEngineeringSection(agent2)
    }
    assert.equal(state.engSection, disposer, "section re-attached")
    state.engSection()
    assert.equal(disposed, true, "disposer wired")
    // exit 也落盘（翻转写点，§2.3）
    engineeringToggle(agent, false, "exit", { storPathOverride: home })
    const file2 = JSON.parse(readFileSync(path, "utf8"))
    assert.equal(file2.sessions[sid].engineering, false)
  } finally {
    dropSession(sid)
    rmHome(home)
  }
})

// ————————————— T1（session-start 接线）：恢复 + section 重挂 + 观测行 + 守卫 —————————————

test("T1-session-start: agent/session-start restores state, re-attaches engineering section, prints the observation line; second start does not double-attach (T15); preset auto-enter coexists", () => {
  const home = mkHome()
  const sid = "f12-start-" + randomUUID()
  const savedEnv = process.env.DSH_HOME
  const logs = []
  const origLog = console.log
  console.log = (m) => logs.push(String(m))
  process.env.DSH_HOME = home
  try {
    // 停机前状态（eng enter + design 评审 2 轮）
    saveSessionState(sid, {
      engineering: true, advisorRound: 2, lastAdvisorOutput: "prior review text",
      lastReviewType: "design", mutatedThisRun: true, touchedFiles: ["lib/a.mjs"],
    }, home)
    const fakeCtx = makeFakeCtx()
    apply(fakeCtx, {})
    const disposer = () => {}
    const agent = {
      session: { id: sid, header: { cwd: PLUGIN_DIR, agentPreset: "" } },
      options: { provider: "p", model: "m" },
      ctx: { systemPrompt: { section: (opts) => { fakeCtx.sections.push(opts); return disposer } } },
    }
    fakeCtx.emit("agent/session-start", { agent, source: "resume" })
    const state = sessionState(sid)
    assert.equal(state.engineering, true)
    assert.equal(state.advisorRound, 2)
    assert.equal(state.lastAdvisorOutput, "prior review text")
    assert.equal(state.lastReviewType, "design")
    assert.equal(state.mutatedThisRun, true)
    assert.deepEqual(state.touchedFiles, ["lib/a.mjs"])
    assert.equal(state.engSection, disposer, "engineering section re-attached on restore")
    assert.ok(fakeCtx.sections.some(s => s.name === "thincoder:engineering"), "section registered")
    assert.ok(logs.some(l => l.includes("session state restored") && l.includes("restored engineering=on from session state")),
      "observation line: " + logs.join(" | "))
    // 二次 session-start（map 已有该 key）→ 只填空槽：跳过恢复，不重复挂 section
    fakeCtx.emit("agent/session-start", { agent, source: "resume" })
    assert.equal(fakeCtx.sections.filter(s => s.name === "thincoder:engineering").length, 1,
      "T15: empty-slot guard prevents double attach")
    // preset 自动 enter 双路径不冲突（设计 §7 确认项 4）：恢复先行，engineeringToggle 守卫消解
    const sid2 = "f12-start2-" + randomUUID()
    saveSessionState(sid2, { engineering: true, advisorRound: 0, touchedFiles: [] }, home)
    const agent2 = { ...agent, session: { id: sid2, header: { cwd: PLUGIN_DIR, agentPreset: "thincoder-eng" } } }
    fakeCtx.emit("agent/session-start", { agent: agent2, source: "resume" })
    assert.equal(fakeCtx.sections.filter(s => s.name === "thincoder:engineering").length, 2,
      "exactly one engineering section for sid2 (restore + preset guard)")
    // 无盘上状态的会话：不崩溃、无恢复观测行
    const sid3 = "f12-start3-" + randomUUID()
    const logsBefore = logs.length
    fakeCtx.emit("agent/session-start", { agent: { ...agent, session: { id: sid3, header: { cwd: PLUGIN_DIR, agentPreset: "" } } }, source: "startup" })
    assert.equal(logs.length, logsBefore, "no restore line for a session without disk state")
  } finally {
    process.env.DSH_HOME = savedEnv
    console.log = origLog
    dropSession(sid)
    rmHome(home)
  }
})

// ————————————— T2：round 2 + prior 恢复 → 收敛轮带 prior —————————————

test("T2: two completed code rounds persist; restart sim → advisorRound=2 + prior restored; the next review runs the convergence round WITH the prior table", async () => {
  const home = mkHome()
  const sid = "f12-t2-" + randomUUID()
  try {
    const llm = reviewishLlm()
    const agent = makeAgent(sid)
    const opts = () => ({ agent, config: {}, reviewType: "code", paths: ["package.json"], storPathOverride: home })
    await runAdvisorReview({ llm }, opts())
    assert.equal(sessionState(sid).advisorRound, 1)
    await runAdvisorReview({ llm }, opts())
    assert.equal(sessionState(sid).advisorRound, 2)
    // 盘上原子组（§2.1）：round + prior + type 一起落盘
    const file = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8"))
    assert.equal(file.sessions[sid].advisorRound, 2)
    assert.equal(file.sessions[sid].lastReviewType, "code")
    assert.ok(file.sessions[sid].lastAdvisorOutput.includes("Correctness"), "prior text persisted")
    // 模拟重启：清内存 → 恢复 → 下一次评审走收敛轮且注入恢复的 prior
    dropSession(sid)
    const r = restoreSessionState(sid, loadSessionState(sid, home))
    assert.equal(r.restored, true)
    assert.equal(sessionState(sid).advisorRound, 2)
    await runAdvisorReview({ llm }, opts())
    assert.equal(llm.calls.length, 3)
    const third = llm.calls[2].messages[0].content[0].text
    assert.ok(third.includes("Round 3"), "convergence round after restore: " + third.slice(0, 120))
    assert.ok(third.includes("Prior Review Output"), "prior injected")
    assert.ok(third.includes("Correctness"), "restored prior content is the injected prior")
  } finally {
    dropSession(sid)
    rmHome(home)
  }
})

// ————————————— T3：normalizeRestored 规范化（round>0 无 prior → round=0） —————————————

test("T3: normalizeRestored — round>0 without prior → round=0; round with prior kept; garbage tolerated; full load path applies it", () => {
  assert.equal(normalizeRestored({ advisorRound: 3, lastAdvisorOutput: null }).advisorRound, 0)
  assert.equal(normalizeRestored({ advisorRound: 3 }).advisorRound, 0)
  assert.equal(normalizeRestored({ advisorRound: 2, lastAdvisorOutput: "prior" }).advisorRound, 2)
  assert.equal(normalizeRestored({ advisorRound: -5 }).advisorRound, 0)
  assert.equal(normalizeRestored({ advisorRound: 2.7, lastAdvisorOutput: "p" }).advisorRound, 2)
  assert.equal(normalizeRestored({ advisorRound: "x" }).advisorRound, 0)
  assert.equal(normalizeRestored(null), null)
  assert.equal(normalizeRestored("nope"), null)
  assert.equal(normalizeRestored([1, 2]), null)
  // 盘上手写 round>0 无 prior → load 即规范化
  const home = mkHome()
  try {
    mkdirSync(join(home, ".thincoder"), { recursive: true })
    writeFileSync(resolveSessionStorePath(home), JSON.stringify({
      version: 1,
      sessions: { s: { advisorRound: 4, lastReviewType: "code", lastSeen: Date.now() } },
    }))
    const snap = loadSessionState("s", home)
    assert.equal(snap.advisorRound, 0)
    assert.equal(snap.lastReviewType, "code")
  } finally { rmHome(home) }
})

// ————————————— T4：advisorOverride/touchedFiles/mutatedThisRun 恢复（去重封顶 200） —————————————

test("T4: advisorOverride/touchedFiles/mutatedThisRun restored; touchedFiles deduped and capped at 200; advisorOverride structural whitelist", () => {
  const touched = []
  for (let i = 0; i < 300; i++) touched.push(i % 3 === 0 ? "dup.mjs" : "f" + i + ".mjs")
  const v = normalizeRestored({
    advisorRound: 1, lastAdvisorOutput: "p", mutatedThisRun: true,
    touchedFiles: touched,
    advisorOverride: {
      round1: { provider: "qax", model: "glm-5.3", bogus: 1 },
      convergence: "not-an-object",
      includeProjectGuide: true, junk: "dropped",
    },
  })
  assert.equal(v.mutatedThisRun, true)
  assert.equal(v.touchedFiles.length, TOUCHED_FILES_CAP)
  assert.equal(new Set(v.touchedFiles).size, TOUCHED_FILES_CAP, "deduped")
  assert.equal(v.touchedFiles.filter(f => f === "dup.mjs").length, 1)
  assert.deepEqual(v.advisorOverride, { round1: { provider: "qax", model: "glm-5.3" }, includeProjectGuide: true })
  // 走完整 restore 路径（灌入内存）
  const sid = "f12-t4-" + randomUUID()
  try {
    const r = restoreSessionState(sid, v)
    assert.equal(r.restored, true)
    const state = sessionState(sid)
    assert.equal(state.mutatedThisRun, true)
    assert.equal(state.touchedFiles.length, TOUCHED_FILES_CAP)
    assert.deepEqual(state.advisorOverride, { round1: { provider: "qax", model: "glm-5.3" }, includeProjectGuide: true })
  } finally { dropSession(sid) }
  // mutatedThisRun 非真值 → false；engineering tri-state 原样
  const v2 = normalizeRestored({ advisorRound: 0, engineering: false, mutatedThisRun: "yes" })
  assert.equal(v2.mutatedThisRun, false)
  assert.equal(v2.engineering, false)
  assert.equal(normalizeRestored({ engineering: true }).engineering, true)
  assert.equal(normalizeRestored({ engineering: "on" }).engineering, null)
})

// ————————————— T5：fail-safe（损坏/缺失/不可写/无效快照） —————————————

test("T5: corrupt/missing/structure-broken store → load null (pure memory fallback, no crash); unwritable save → false + warn, no throw; invalid snapshot → restore declines without creating the slot", () => {
  const home = mkHome()
  const warns = []
  const origWarn = console.warn
  console.warn = (m) => warns.push(String(m))
  try {
    // 缺失 → null
    assert.equal(loadSessionState("x", home), null)
    // 损坏（非 JSON）→ null
    mkdirSync(join(home, ".thincoder"), { recursive: true })
    writeFileSync(resolveSessionStorePath(home), "{ not json !!!")
    assert.equal(loadSessionState("x", home), null)
    // 结构不对（sessions 非对象 / 顶层非对象）→ null
    writeFileSync(resolveSessionStorePath(home), JSON.stringify({ version: 1, sessions: "nope" }))
    assert.equal(loadSessionState("x", home), null)
    writeFileSync(resolveSessionStorePath(home), JSON.stringify([1, 2]))
    assert.equal(loadSessionState("x", home), null)
    // version 不符（未来 v2 文件）→ 按无 store 处理，不做部分解读（审计瑕疵 3 补测：session-store.mjs readStore 分支）
    writeFileSync(resolveSessionStorePath(home), JSON.stringify({ version: 2, sessions: { z: { advisorRound: 3, lastSeen: Date.now() } } }))
    assert.equal(loadSessionState("z", home), null)
    // 非对象条目（sessions 内含畸形成员）→ 该 session 读不到但不崩
    writeFileSync(resolveSessionStorePath(home), JSON.stringify({ version: 1, sessions: { x: "bad", y: null } }))
    assert.equal(loadSessionState("x", home), null)
  } finally {
    console.warn = origWarn
    rmHome(home)
  }
  // 不可写路径（blk 是普通文件且充当中间路径 → mkdir ENOTDIR）→ save false + warn，不抛
  const root = mkHome()
  console.warn = (m) => warns.push(String(m))
  try {
    writeFileSync(join(root, "blk"), "a regular file")
    const badHome = join(root, "blk", "sub") // blk 是普通文件：mkdir 必然失败（同 F10-T5 手法）
    const ok = saveSessionState("y", { advisorRound: 0, touchedFiles: [] }, badHome)
    assert.equal(ok, false)
    assert.ok(warns.some(w => w.includes("failed to persist session state")), "warn emitted: " + warns.join(" | "))
    assert.ok(!existsSync(resolveSessionStorePath(badHome)), "nothing written")
  } finally {
    console.warn = origWarn
    rmHome(root)
  }
  // 无效快照 → restore 拒绝（invalid）且不建内存条目（后续有效快照仍可恢复）
  const sid = "f12-t5-" + randomUUID()
  try {
    assert.deepEqual(restoreSessionState(sid, "garbage"), { restored: false, reason: "invalid" })
    assert.deepEqual(restoreSessionState(sid, null), { restored: false, reason: "invalid" })
    const r2 = restoreSessionState(sid, { advisorRound: 1, lastAdvisorOutput: "ok" })
    assert.equal(r2.restored, true, "invalid call did not create the memory slot")
  } finally { dropSession(sid) }
})

// ————————————— T6：session/disposed 删除 + 写时清扫 7d 孤儿 —————————————

test("T6: removeSessionState deletes the entry; save-time sweep drops >7d orphans and malformed entries of all sessions", () => {
  const home = mkHome()
  try {
    saveSessionState("live", { advisorRound: 0, touchedFiles: [] }, home)
    assert.ok(loadSessionState("live", home))
    assert.equal(removeSessionState("live", home), true)
    assert.equal(loadSessionState("live", home), null)
    assert.equal(removeSessionState("never-there", home), true, "no record to delete is a no-op success")
    // 清扫：手写文件带 fresh + stale（>7d）+ 无 lastSeen 畸形条目 → save 触发全量清扫
    mkdirSync(join(home, ".thincoder"), { recursive: true })
    const stale = Date.now() - STATE_TTL_MS - 1000
    writeFileSync(resolveSessionStorePath(home), JSON.stringify({
      version: 1,
      sessions: {
        stale1: { advisorRound: 1, lastSeen: stale },
        stale2: { advisorRound: 2, lastSeen: stale - 5000 },
        malformed: { advisorRound: "x" },
        keep: { advisorRound: 1, lastAdvisorOutput: "p", lastSeen: Date.now() - 1000 },
      },
    }))
    saveSessionState("fresh", { advisorRound: 0, touchedFiles: [] }, home)
    const file = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8"))
    assert.deepEqual(Object.keys(file.sessions).sort(), ["fresh", "keep"].sort(),
      "stale + malformed entries swept on write; live + fresh kept")
    // TTL 边界内（恰好 7d 前 - 1s）的条目仍可 load（写时清扫只删超限）
    assert.ok(loadSessionState("keep", home), "TTL-valid entry loadable")
  } finally { rmHome(home) }
})

test("T6-handler: session/disposed → removeSessionState called (index.mjs wiring, mirrors removeTokenRecord)", () => {
  const home = mkHome()
  const sid = "f12-disp-" + randomUUID()
  const savedEnv = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    saveSessionState(sid, { advisorRound: 1, lastAdvisorOutput: "p", touchedFiles: [] }, home)
    assert.ok(loadSessionState(sid, home))
    const fakeCtx = makeFakeCtx()
    apply(fakeCtx, {})
    fakeCtx.emit("session/disposed", { id: sid })
    assert.equal(loadSessionState(sid, home), null, "entry removed on session/disposed")
  } finally {
    process.env.DSH_HOME = savedEnv
    dropSession(sid)
    rmHome(home)
  }
})

// ————————————— T7：designToken 绝不入 session-state.json（双盘禁止） —————————————

test("T7: session-state.json never contains designToken/pendingDesignToken — field whitelist only; full design-approval flow puts the token ONLY in design-tokens.json", async () => {
  const home = mkHome()
  const sid = "f12-t7-" + randomUUID()
  try {
    // state 持有 token（设计签发后）——持久化视图/盘上均不得出现
    const state = sessionState(sid)
    state.designToken = makeToken()
    state.pendingDesignToken = makeToken()
    state.engineering = true
    assert.equal(saveSessionState(sid, viewOfSessionState(state), home), true)
    const raw = readFileSync(resolveSessionStorePath(home), "utf8")
    assert.ok(!raw.includes(state.designToken), "token value must not appear in session-state.json")
    assert.ok(!raw.includes(state.pendingDesignToken), "pending token value must not appear")
    const entry = JSON.parse(raw).sessions[sid]
    assert.deepEqual(Object.keys(entry).sort(),
      ["advisorOverride", "advisorRound", "engineering", "lastAdvisorOutput", "lastReviewType", "lastSeen", "mutatedThisRun", "touchedFiles"].sort())
    // 视图函数同样不含 token 字段
    const view = persistedSessionView(sid)
    for (const k of Object.keys(view)) assert.ok(!/designToken/i.test(k), "view field " + k)
  } finally {
    dropSession(sid)
    rmHome(home)
  }
  // 全链路（设计评审签发 → F10 token 落盘 + F12 状态落盘）：token 只在 design-tokens.json
  const home2 = mkHome()
  const sid2 = "f12-t7b-" + randomUUID()
  try {
    const agent = makeAgent(sid2)
    const out = await runAdvisorReview({ llm: approvingLlm() }, {
      agent, config: {}, reviewType: "design",
      documents: ["docs/2026-09-02-session-state-stages-design.md"],
      storPathOverride: home2,
    })
    assert.match(out, /Approved\. Pass this exact token to eng_coder/)
    const tokenPath = resolveTokenStorePath(home2)
    const statePath = resolveSessionStorePath(home2)
    assert.ok(existsSync(tokenPath) && existsSync(statePath), "both stores written (separate files)")
    const tokenFile = JSON.parse(readFileSync(tokenPath, "utf8"))
    const stateFile = JSON.parse(readFileSync(statePath, "utf8"))
    assert.ok(tokenFile.tokens[sid2].token, "token record present in design-tokens.json")
    const stateRaw = readFileSync(statePath, "utf8")
    assert.ok(!stateRaw.includes(tokenFile.tokens[sid2].token), "token value absent from session-state.json (T7)")
    for (const k of Object.keys(stateFile.sessions[sid2])) {
      assert.ok(!/designToken|pendingDesignToken/.test(k), "no token key: " + k)
    }
    // 状态条目确实落盘（reviewType=design）；stub 的批准输出 < 200 字符且无表格 →
    // lastAdvisorOutput 不存 → 落盘时经 T3 规范化 round=0（无 prior 的轮次不成立——设计行为）
    assert.equal(stateFile.sessions[sid2].lastReviewType, "design")
    assert.equal(stateFile.sessions[sid2].advisorRound, 0)
    assert.equal(stateFile.sessions[sid2].lastAdvisorOutput, null)
  } finally {
    dropSession(sid2)
    rmHome(home2)
  }
})

// ————————————— T8：分文件 + 回滚独立 —————————————

test("T8: session-state.json and design-tokens.json are separate files; deleting either leaves the other intact (rollback independence)", () => {
  const home = mkHome()
  const sid = "f12-t8"
  try {
    const token = makeToken()
    saveTokenRecord(sid, { token, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 }, home)
    saveSessionState(sid, { advisorRound: 2, lastAdvisorOutput: "p", touchedFiles: ["a.mjs"] }, home)
    const tokenPath = resolveTokenStorePath(home)
    const statePath = resolveSessionStorePath(home)
    assert.notEqual(tokenPath, statePath)
    assert.ok(existsSync(tokenPath) && existsSync(statePath))
    // 删 session-state.json → token 不受牵连；会话状态回纯内存行为
    rmSync(statePath)
    assert.equal(loadTokenRecord(sid, home).token, token, "token store unaffected")
    assert.equal(loadSessionState(sid, home), null, "session state gone")
    // 反向：删 token 文件 → 会话状态不受牵连
    saveSessionState(sid, { advisorRound: 2, lastAdvisorOutput: "p", touchedFiles: [] }, home)
    rmSync(tokenPath)
    assert.equal(loadTokenRecord(sid, home), null)
    const snap = loadSessionState(sid, home)
    assert.ok(snap && snap.advisorRound === 2, "session state unaffected")
  } finally { rmHome(home) }
})

// ————————————— T15：只填空槽守卫（内存胜，盘不覆盖） —————————————

test("T15: restore fills EMPTY slots only — in-memory advanced state wins over a stale on-disk entry", () => {
  const sid = "f12-t15-" + randomUUID()
  try {
    const state = sessionState(sid)
    state.advisorRound = 3
    state.lastAdvisorOutput = "memory prior"
    state.lastReviewType = "code"
    state.engineering = true
    const r = restoreSessionState(sid, {
      advisorRound: 1, lastAdvisorOutput: "disk prior", lastReviewType: "design",
      engineering: false, mutatedThisRun: true, touchedFiles: ["disk.mjs"],
    })
    assert.deepEqual(r, { restored: false, reason: "present" })
    assert.equal(state.advisorRound, 3, "memory wins")
    assert.equal(state.lastAdvisorOutput, "memory prior")
    assert.equal(state.lastReviewType, "code")
    assert.equal(state.engineering, true)
    assert.deepEqual(state.touchedFiles, [], "disk touchedFiles NOT poured over memory")
  } finally { dropSession(sid) }
})

// ————————————— §2.3 写点：eng_coder 交付后 —————————————

test("writepoint eng_coder: delivery persists mutatedThisRun/touchedFiles + round reset + prior cleared", async () => {
  const home = mkHome()
  const sid = "f12-wp-eng-" + randomUUID()
  try {
    const state = makeEngState(sid, 1, "prior review text")
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, home, started), { task: "implement x", designToken: state.designToken })
    assert.ok(out.includes("eng_coder delivery:"), out)
    const entry = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8")).sessions[sid]
    assert.equal(entry.mutatedThisRun, true)
    assert.deepEqual(entry.touchedFiles, ["lib/a.mjs"])
    assert.equal(entry.advisorRound, 0, "round reset persisted")
    assert.equal(entry.lastAdvisorOutput, null, "prior cleared persisted")
    assert.equal(entry.engineering, true)
    // 内存态一致（写盘即内存快照）
    assert.equal(sessionState(sid).advisorRound, 0)
    assert.equal(sessionState(sid).touchedFiles.length, 1)
  } finally {
    dropSession(sid)
    rmHome(home)
  }
})

// ————————————— §2.3 写点：F11 类型切换重置（评审失败也落盘重置） —————————————

test("writepoint F11 type-switch: code→design reset persists (round 0, prior cleared, new type) even when the review itself fails", async () => {
  const home = mkHome()
  const sid = "f12-wp-f11-" + randomUUID()
  try {
    const state = sessionState(sid)
    state.advisorRound = 1
    state.lastAdvisorOutput = "code prior"
    state.lastReviewType = "code"
    // llm 无 stream → 工具循环报 "Advisor: review failed"（completed=false，完成分支不写盘）
    // → 只剩类型切换写点（隔离验证）
    const out = await runAdvisorReview({ llm: {} }, {
      agent: makeAgent(sid), config: {}, reviewType: "design",
      documents: ["docs/d.md"], storPathOverride: home,
    })
    assert.ok(out.startsWith("Advisor:"), "review failed as scripted: " + out.slice(0, 80))
    const entry = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8")).sessions[sid]
    assert.equal(entry.advisorRound, 0, "reset round persisted")
    assert.equal(entry.lastAdvisorOutput, null, "cleared prior persisted")
    assert.equal(entry.lastReviewType, "design", "new type persisted")
  } finally {
    dropSession(sid)
    rmHome(home)
  }
})

// ————————————— §2.3 写点：advisor_config set/reset（工具包装层） —————————————

test("writepoint advisor_config: set/reset persist advisorOverride via the tool execute wrapper; get/invalid do not write", async () => {
  const home = mkHome()
  const sid = "f12-wp-ac-" + randomUUID()
  const savedEnv = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const fakeCtx = makeFakeCtx()
    apply(fakeCtx, {})
    const tool = fakeCtx.registeredTools.find(t => t.name === "advisor_config")
    assert.ok(tool, "advisor_config registered")
    const exec = { agent: makeAgent(sid) }
    const setOut = await tool.execute({ request: JSON.stringify({ action: "set", path: "round1.effort", value: "low" }) }, exec)
    assert.match(setOut, /^advisor_config: set round1\.effort/)
    const file = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8"))
    assert.deepEqual(file.sessions[sid].advisorOverride, { round1: { effort: "low" } })
    const resetOut = await tool.execute({ request: JSON.stringify({ action: "reset", path: "round1" }) }, exec)
    assert.match(resetOut, /^advisor_config: reset round1/)
    const file2 = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8"))
    assert.equal(file2.sessions[sid].advisorOverride, null)
    // get / invalid 不触发写点（以内容不变断言）
    await tool.execute({ request: JSON.stringify({ action: "get" }) }, exec)
    await tool.execute({ request: "not json" }, exec)
    const file3 = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8"))
    assert.equal(file3.sessions[sid].advisorOverride, null, "no state change from get/invalid")
  } finally {
    process.env.DSH_HOME = savedEnv
    dropSession(sid)
    rmHome(home)
  }
})

// ————————————— §2.3 写点：config API apply/reset-session —————————————

test("writepoint config API: applySessionOverride/resetSessionOverride invoke deps.persistSession only after a successful mutation", () => {
  const persisted = []
  const states = new Map()
  const deps = {
    sessionExists: (id) => id === "known",
    stateOf: (id) => { if (!states.has(id)) states.set(id, { advisorOverride: null }); return states.get(id) },
    persistSession: (id) => persisted.push(String(id)),
  }
  const r = applySessionOverride(deps, "known", { round1: { effort: "low" } })
  assert.equal(r.ok, true)
  assert.deepEqual(persisted, ["known"])
  // no-session / invalid payload → 不写
  persisted.length = 0
  assert.equal(applySessionOverride(deps, "ghost", {}).reason, "no-session")
  assert.deepEqual(persisted, [])
  assert.equal(applySessionOverride(deps, "known", { junk: 1 }).ok, false)
  assert.deepEqual(persisted, [])
  const r2 = resetSessionOverride(deps, "known")
  assert.equal(r2.ok, true)
  assert.deepEqual(persisted, ["known"])
  assert.equal(applySessionOverride(deps, "known", { round1: { effort: "low" } }).ok, true)
  assert.deepEqual(states.get("known").advisorOverride, { round1: { effort: "low" } })
})

test("writepoint config API handler: POST /apply-session and DELETE /session flow opts.persistSession through makeApiHandler", async () => {
  const persisted = []
  const known = new Set(["known-sid"])
  const stateMap = new Map()
  const opts = {
    baseConfig: {},
    sessionExists: (id) => known.has(String(id)),
    agentOptionsOf: () => ({}),
    stateOf: (id) => { if (!stateMap.has(id)) stateMap.set(id, { advisorOverride: null }); return stateMap.get(id) },
    persistSession: (id) => persisted.push(String(id)),
    settingsGet: () => null,
  }
  const handler = makeApiHandler({}, opts)
  const call = async (method, path, body) => {
    let status = 0, payload = ""
    const res = { writeHead: (code) => { status = code }, end: (text) => { payload = String(text) } }
    let req
    if (body !== undefined) {
      const text = JSON.stringify(body)
      req = { url: "http://localhost" + path, method, [Symbol.asyncIterator]: async function* () { yield text } }
    } else {
      req = { url: "http://localhost" + path, method, [Symbol.asyncIterator]: async function* () {} }
    }
    await handler(req, res)
    return { status, payload: payload ? JSON.parse(payload) : null }
  }
  try {
    const r = await call("POST", "/thincoder-suite/api/apply-session", { sessionId: "known-sid", advisor: { round1: { effort: "low" } } })
    assert.equal(r.status, 200, JSON.stringify(r.payload))
    assert.deepEqual(persisted, ["known-sid"])
    persisted.length = 0
    const d = await call("DELETE", "/thincoder-suite/api/session?sessionId=known-sid")
    assert.equal(d.status, 200)
    assert.deepEqual(persisted, ["known-sid"])
    // 无效 sessionId → 不写
    persisted.length = 0
    const bad = await call("POST", "/thincoder-suite/api/apply-session", { sessionId: "ghost", advisor: {} })
    assert.equal(bad.status, 404)
    assert.deepEqual(persisted, [])
  } finally {
    // 清理：stateMap 是 stub 普通对象，无需 dropSession
  }
})

// ————————————— 边界：runAdvisorConfigTool 直调不写盘（写点在 index 包装层） —————————————

test("isolation: runAdvisorConfigTool called directly (no disk wiring) leaves no store file — persist lives in the index.mjs wrapper", () => {
  const home = mkHome()
  const sid = "f12-iso-" + randomUUID()
  try {
    const state = { advisorOverride: null }
    const out = runAdvisorConfigTool(JSON.stringify({ action: "set", path: "round1.effort", value: "low" }), {
      config: {}, agentOpts: {}, state, sessionId: sid,
    })
    assert.match(out, /^advisor_config: set /)
    assert.ok(!existsSync(resolveSessionStorePath(home)), "no disk write from the pure tool path")
  } finally { rmHome(home) }
})
