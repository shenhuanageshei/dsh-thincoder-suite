// design-review-guard.test.mjs — 批 4：设计评审豁免 5 轮上限 + 三振结算护栏（成对吸收）+ D-35 链作用域。
// 设计档：docs/2026-09-13-design-review-guard-design.md §5（方案）/§6（伪代码）/§8.2（机验锚）/
// §10.3（AC-G1…AC-G9）/§12（D-35 折入 AC-G10）/§13（轮次 1 修正块 AC-G11）。
// 本档 = T-G1…T-G11，逐条映射 AC-G1…AC-G11；既有测试文件零修改。
// 纪律：零网络、零真实 LLM（deps.llm.stream 桩 + 假 jobs 服务）、零长等待（兜底用例用 120ms 截止）。
// 隔离：process.env.DSH_HOME 置空（走 storPathOverride/env 临时目录，不碰真实 $DSH_HOME）；
// 三振计数是**会话级模块内存态**，每个用例用独立 sessionId（randomUUID）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import {
  runAdvisorReview, MAX_ADVISOR_ROUNDS, DESIGN_STRIKE_LIMIT,
  designDocKey, designChainKey, designStrikes, settlementGuardText,
  classifySettlement, recordDesignSettlement, clearDesignSettlementStrikes,
  bumpAdvisorGeneration,
} from "../lib/advisor.mjs"
import { sessionState, dropSession, dropAllSessions } from "../lib/state.mjs"
import { resolveSessionStorePath } from "../lib/session-store.mjs"
import { apply } from "../lib/index.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
/** 隔离契约（对齐 session-state.test.mjs）：空串 = 显式无 env → 测试只走 override/env 临时目录。 */
process.env.DSH_HOME = ""

const mkHome = () => mkdtempSync(join(tmpdir(), "thincoder-b4-"))
const rmHome = (h) => { try { rmSync(h, { recursive: true, force: true }) } catch { /* 已清理 */ } }
const newSid = (tag) => "b4-" + tag + "-" + randomUUID()
const cleanSid = (sid) => { try { clearDesignSettlementStrikes(sid) } catch { /* noop */ } ; try { dropSession(sid) } catch { /* noop */ } }

/** advisor 用 agent stub（路由走 agent options；deriveMessages 空）。 */
function makeAgent(id) {
  return {
    session: { id, header: { cwd: PLUGIN_DIR }, deriveMessages: () => [] },
    options: { provider: "p", model: "m" },
  }
}

/** 脚本化 llm stub：每次 stream 记 opts；第 n 次返回 scripts[n]（超出取最后一个）。
 *  元素语义：string → 该文本的完成流；null → **挂起**（直到 signal abort 才以 AbortError reject，
 *  用于驱动 dsh 后台兜底截止）。 */
function scriptedLlm(scripts) {
  const calls = []
  const llm = {
    calls,
    stream(opts) {
      calls.push(opts)
      const s = scripts[Math.min(calls.length - 1, scripts.length - 1)]
      if (s === null) {
        return (async function* () {
          await new Promise((_res, rej) => {
            const sig = opts?.signal
            const die = () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))
            if (sig?.aborted) return die()
            sig?.addEventListener?.("abort", die, { once: true })
          })
        })()
      }
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: String(s) } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  return llm
}

/** 通过型 design 评审 stub：回显提示词里的批准码（触发签发，取 token 落盘返回值）。 */
function approvingLlm() {
  const calls = []
  return {
    calls,
    stream(opts) {
      calls.push(opts)
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

/** 假 jobs 服务（平台契约：start(spec) → branded string，spec.run() 返回 { cancel, done }）。 */
function fakeJobs() {
  const specs = []
  return {
    specs,
    service: {
      start(p) {
        const hooks = p.run()
        const id = (p.kind ?? "job") + "-" + (specs.length + 1)
        specs.push({ payload: p, hooks, id })
        return id
      },
    },
  }
}
const jobsCtx = (service) => ({ get: (n) => (n === "jobs" ? service : null) })

/** apply() 接线用 fake ctx（捕获 ctx.on 处理器 + 注册的工具）。 */
function makeFakeCtx() {
  const registeredTools = []
  const handlers = new Map()
  return {
    registeredTools,
    on: (ev, fn) => {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(fn)
      return () => { /* disposer no-op */ }
    },
    emit: (ev, payload) => { for (const fn of handlers.get(ev) ?? []) fn(payload) },
    effect: (fn) => { const d = fn?.(); return () => d?.() },
    systemPrompt: { section: () => () => {} },
    tools: { register: (t) => { registeredTools.push(t); return () => {} } },
    get: () => null,
  }
}

/** 带 config API 的 fake ctx（捕获 webServer.register 的 {path, handler}）——T-G3b 经其 GET /session
 *  读「会话可见性注册表」（`markSessionSeen` 的**唯一**对外读取面，见 lib/index.mjs sessionExists）。 */
function makeFakeCtxWithApi() {
  const ctx = makeFakeCtx()
  const captured = {}
  ctx.webServer = { register: (opts) => { captured.api = opts; return () => {} } }
  return { ctx, captured }
}

/** 经 config API handler 发一次 GET（假 req/res，JSON 往返）。 */
async function apiGet(api, url) {
  const chunks = []
  const res = { writeHead: () => {}, end: (s) => { chunks.push(String(s ?? "")) } }
  await api.handler({ method: "GET", url }, res)
  return JSON.parse(chunks.join("") || "{}")
}

/** 极简假 codex 子进程（对齐 codex-runner.test.mjs 的 fakeSpawnFactory，只留本档所需形态）：
 *  `--version` 探测 → 固定版本行；其余 → spec（events / exitCode / exitDelay / hang）。
 *  hang=true = 永不自退出（等 watchdog 或 abort 杀）——不遗留真实定时器。 */
function fakeCodexSpawn(spec) {
  return (_file, args) => {
    const s = args.includes("--version") ? { events: [{ data: "codex-cli 0.150.1\n" }], exitCode: 0 } : spec
    const child = new EventEmitter()
    child.pid = 424242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { write() {}, end() {} }
    child.kill = () => { setImmediate(() => child.emit("exit", null, "SIGKILL")) }
    ;(async () => {
      for (const ev of s.events ?? []) {
        await new Promise((r) => setTimeout(r, ev.delay ?? 0))
        ;(child[ev.stream ?? "stdout"] ?? child.stdout).emit("data", Buffer.from(ev.data ?? ""))
      }
      if (s.hang === true) return
      await new Promise((r) => setTimeout(r, s.exitDelay ?? 10))
      child.emit("exit", s.exitCode ?? 0)
    })()
    return child
  }
}

/** codex 路由夹具（T-G5g）：进程内假子进程 + 组超时 1000ms（`ADVISOR_TIMEOUT_MIN_MS`）——
 *  1000 ≤ 默认 budgetCap（540000）⇒ 走**同步**执行路径（无 jobs 依赖）。 */
const CODEX_CFG = {
  codexCli: { executable: process.execPath },
  advisor: { round1: { runner: { kind: "codex-cli", model: "fake-codex-model" }, timeoutMs: 1000 } },
}

/** N-1 快照字段清单（§13 #5：补 lastDesignDocKey）。 */
const SNAP_FIELDS = [
  "advisorRound", "lastAdvisorOutput", "lastReviewType", "pendingDesignToken",
  "pendingDocPaths", "pendingDocHash", "designToken", "lastDesignDocKey",
  "advisorGeneration", "mutatedThisRun", "touchedFiles",
]
function snap(sid) {
  const s = sessionState(sid)
  const o = {}
  for (const k of SNAP_FIELDS) o[k] = JSON.parse(JSON.stringify(s[k] === undefined ? null : s[k]))
  return o
}

/** 结算四要素的“最近三次 kind”可从护栏串读出（唯一对外可观测面）。 */
const guardKindsLine = (text) => (text.match(/Recent settlement failures \(oldest → newest\): ([^\n]*)/) ?? [])[1]

const NOT_A_REVIEW = "I could not complete this review."
/** prior 表（供 cap 的 unfixed 提取与收敛轮 prompt）。 */
const PRIOR_TABLE = "| # | Category | Severity | Issue | Suggestion |\n"
  + "| 1 | Correctness | 🟡 | minor detail | tweak |\n"
  + "| 2 | Clarity | 🔵 | wording | reword |\n"
/** 通过型 code 评审正文（looksLikeReview=true，无 VERDICT、无结论词）。 */
const REVIEW_TABLE = "| # | Category | Severity | Issue | Suggestion |\n"
  + "| 1 | Correctness | 🟡 | issue detail line one | fix suggestion |\n"
  + "| 2 | Maintainability | 🔵 | minor naming | rename |\n"
  + "Overall the implementation looks reasonable; the convergence protocol is followed. "
  + "No critical findings this round; the table above lists advisory items only."

/** 冻结字面量（§8.1 零改面：cap 串逐字节）——**故意写死**：改文案即红。 */
const CAP_TEXT_NO_UNFIXED = "Advisor: convergence cap reached after 5 rounds.\n"
  + "\nAll prior issues appear resolved.\n"
  + "\nOptions:\n1. Accept current state and proceed\n2. Manually review specific concerns with read/grep\n3. Start a new session to reset the advisor"
const CAP_TEXT_UNFIXED = "Advisor: convergence cap reached after 5 rounds.\n"
  + "\nUnresolved issues from prior rounds:\n- 1 | Correctness | 🔴 | bug | fix it\n"
  + "\nOptions:\n1. Accept current state and proceed\n2. Manually review specific concerns with read/grep\n3. Start a new session to reset the advisor"

const callDesign = (deps, agent, docs, home, config = {}) =>
  runAdvisorReview(deps, { agent, config, reviewType: "design", documents: docs, storPathOverride: home })
const callCode = (deps, agent, home, config = {}) =>
  runAdvisorReview(deps, { agent, config, reviewType: "code", paths: ["package.json"], storPathOverride: home })

// ————————————————————— T-G1 / AC-G1：design 豁免 cap（轮次照增、提示词轮换照常） —————————————————————

test("T-G1 (AC-G1): design @ advisorRound=5 is NOT blocked by the cap — the review runs and the round still advances", async () => {
  const home = mkHome()
  const sid = newSid("acg1")
  const docs = ["docs/b4-acg1.md"]
  try {
    const st = sessionState(sid)
    st.advisorRound = 5
    st.lastReviewType = "design"
    st.lastAdvisorOutput = PRIOR_TABLE
    // 链作用域键 = 本次同一文档集（否则会先走 D-35 链重置，轮次归 0 —— 那是 T-G10 的面）
    st.lastDesignDocKey = designChainKey(docs)
    const llm = scriptedLlm([REVIEW_TABLE])
    const out = await callDesign({ llm }, makeAgent(sid), docs, home)
    assert.ok(!out.includes("convergence cap reached"), "design 不得被 cap 拒：" + out.slice(0, 200))
    assert.equal(llm.calls.length, 1, "design 评审确实跑了 LLM（豁免生效，而非静默短路）")
    assert.ok(out.includes("convergence protocol is followed"), "返回正常路径产物")
    assert.equal(sessionState(sid).advisorRound, 6, "轮次语义零改：照常推进（D-G11）")
  } finally { cleanSid(sid); rmHome(home) }
})

// ————————————————————— T-G2 / AC-G2：code 的 cap 串逐字节不变 —————————————————————

test("T-G2 (AC-G2): code @ advisorRound=5 returns the cap text BYTE-FOR-BYTE (both branches)", async () => {
  const home = mkHome()
  const sidA = newSid("acg2a")
  const sidB = newSid("acg2b")
  try {
    const a = sessionState(sidA)
    a.advisorRound = 5
    a.lastReviewType = "code"
    // prior 存在（round 预算不住在原地）但**全部已核销** → 走「All prior issues appear resolved.」分支
    a.lastAdvisorOutput = "| # | Category | Severity | Issue | Suggestion |\n| 1 | Correctness | 🟡 | minor detail | fixed |"
    const llmA = scriptedLlm([REVIEW_TABLE])
    const outA = await callCode({ llm: llmA }, makeAgent(sidA), home)
    assert.equal(outA, CAP_TEXT_NO_UNFIXED, "无 unfixed 分支逐字节")
    assert.equal(llmA.calls.length, 0, "cap 拒绝零 LLM")

    const b = sessionState(sidB)
    b.advisorRound = 5
    b.lastReviewType = "code"
    b.lastAdvisorOutput = "| # | Category | Severity | Issue | Suggestion |\n| 1 | Correctness | 🔴 | bug | fix it |"
    const llmB = scriptedLlm([REVIEW_TABLE])
    const outB = await callCode({ llm: llmB }, makeAgent(sidB), home)
    assert.equal(outB, CAP_TEXT_UNFIXED, "unfixed 提取分支逐字节")
    assert.equal(llmB.calls.length, 0)
    assert.equal(MAX_ADVISOR_ROUNDS, 5, "常量导出与值不变")
  } finally { cleanSid(sidA); cleanSid(sidB); rmHome(home) }
})

// ————————————————————— T-G3 / AC-G3：三振拦截（双入口 + 零 LLM + 零状态变更） —————————————————————

test("T-G3 (AC-G3): after 3 unsettled design reviews the 4th is blocked — zero LLM, zero state change, both entry points", async () => {
  const home = mkHome()
  const sid = newSid("acg3")
  const docs = ["docs/b4-acg3-a.md", "docs/b4-acg3-b.md"]
  const docKey = designDocKey(docs)
  try {
    const agent = makeAgent(sid)
    const llm = scriptedLlm([NOT_A_REVIEW]) // 完成但不是可用判决 → review_failed ×3
    const config = {}
    for (let i = 0; i < 3; i++) {
      const out = await callDesign({ llm }, agent, docs, home, config)
      assert.ok(out.includes("could not complete"), "第 " + (i + 1) + " 次照常执行")
    }
    assert.equal(designStrikes(sid, docKey), DESIGN_STRIKE_LIMIT, "三次无结算 ⇒ 计数到顶")
    assert.equal(llm.calls.length, 3, "前三次各调一次 LLM")

    const statePath = resolveSessionStorePath(home)
    const before = snap(sid)
    const fileBefore = readFileSync(statePath, "utf8")
    const callsBefore = llm.calls.length

    // ① 核心层入口（runAdvisorReview 直调）
    const blocked = await callDesign({ llm }, agent, docs, home, config)
    assert.ok(blocked.startsWith("Advisor: design review blocked by the settlement guard (3/3"),
      "第一行即结论（P-a）：" + blocked.slice(0, 120))
    assert.equal(llm.calls.length, callsBefore, "N-2：被拒路径零 LLM（核心层）")
    assert.deepEqual(snap(sid), before, "N-1：状态快照全等（含 lastDesignDocKey）")
    assert.equal(readFileSync(statePath, "utf8"), fileBefore, "N-1：saveSessionState 未被调用")

    // 六项必备信息（D-G8）
    assert.ok(blocked.includes("3/3"), "① 计数 N/3")
    for (const d of docKey.split("\n")) assert.ok(blocked.includes("- " + d), "② 归一文档集含 " + d)
    assert.equal(guardKindsLine(blocked), "review_failed → review_failed → review_failed", "③ 最近三次 kind")
    assert.ok(blocked.includes("cannot be cleared inside this session"), "④ 不可自解除声明")
    assert.ok(blocked.includes("Only a new session starts a fresh count"), "⑤ 唯一出口 = 新会话")
    assert.ok(blocked.includes("eng_coder renewal refusal"), "⑥ 防乒乓行")

    // ② 工具层入口（同一判定）。**诚实边界（分歧审计 #1）**：下面四条断言对「摘除工具层预检」
    // **不敏感**——工具层被摘掉后核心层 runAdvisorReview 在同一点返回**同一个**串（同一护栏、
    // 零 LLM、零状态变更、不落盘），故「若未被拦住会直接抛」是**错的**（核心层在碰 `deps.llm`
    // 之前就返回了）。它们锁的是「双入口行为一致」，不是工具层钩子自身。工具层**自身**的可观察
    // 面（markSessionSeen 会话可见性注册表）见 T-G3b，附实测摘除实验输出。
    const fakeCtx = makeFakeCtx()
    apply(fakeCtx, {})
    const tool = fakeCtx.registeredTools.find(t => t.name === "advisor")
    assert.ok(tool, "advisor 工具已注册")
    const outTool = await tool.execute({ type: "design", documents: docs }, { agent, signal: undefined })
    assert.ok(outTool.startsWith("Advisor: design review blocked by the settlement guard (3/3"),
      "工具层同样拦截：" + String(outTool).slice(0, 120))
    assert.equal(llm.calls.length, callsBefore, "N-2：被拒路径零 LLM（工具层）")
    assert.deepEqual(snap(sid), before, "工具层被拒同样零状态变更")
    assert.equal(readFileSync(statePath, "utf8"), fileBefore, "工具层被拒同样不落盘")
  } finally { cleanSid(sid); rmHome(home) }
})

// ————————————— T-G3b / AC-G3 + §8.2「摘除即红」：工具层钩子自身的可观察面 —————————————
// 分歧审计 #1：上面 T-G3 的四条工具层断言**也被核心层回退满足**（删掉工具层预检后它们照样绿），
// 故它们证明的是「双入口行为一致」，不是「工具层钩子存在」。本用例锁**只有工具层快速路径才有的
// 可观察副作用**：预检在 `markSessionSeen(agent.session.id)` 之前 return ⇒ 会话可见性注册表
// （`sessionRegistry`；config API `GET /session` → `sessionExists` 是它唯一的读取面——agents 服务
// 缺席时该注册表即决定源）**未被写入**；若工具层预检被摘除，runAdvisorReview 会被调用 ⇒
// markSessionSeen 已执行 ⇒ 注册表可读。
// 实测摘除实验（交付报告附完整输出）：把 lib/index.mjs 的工具层预检条件改为恒假（等价于摘除该块）
// → 本用例在「工具层预检早于会话注册」一行转红（ok:true ≠ no-session），其余用例仍绿。
// 性质声明：这是一条**实现面锁**（锁「快速路径先于注册」这个事实），不是设计需求本身——设计
// 需求（双入口都拦）由 T-G3 锁；本条存在的唯一目的 = 让 §8.2 的「摘除即红」对这一处钩子成立。

test("T-G3b (§8.2 removal lock): the TOOL-layer precheck is observable — it returns BEFORE the session is registered as seen (API GET /session)", async () => {
  const home = mkHome()
  const sid = newSid("acg3b")
  const docs = ["docs/b4-acg3b.md"]
  const docKey = designDocKey(docs)
  try {
    const agent = makeAgent(sid)
    const llm = scriptedLlm([NOT_A_REVIEW])
    for (let i = 0; i < 3; i++) await callDesign({ llm }, agent, docs, home)
    assert.equal(designStrikes(sid, docKey), DESIGN_STRIKE_LIMIT, "前置：该文档集已三振")

    const { ctx: fakeCtx, captured } = makeFakeCtxWithApi()
    apply(fakeCtx, {})
    const tool = fakeCtx.registeredTools.find(t => t.name === "advisor")
    assert.ok(tool && captured.api?.handler, "advisor 工具 + config API handler 均已装配")

    const viewUrl = "/thincoder-suite/api/session?sessionId=" + encodeURIComponent(sid)
    // 工具层被拒：与核心层同一个护栏串（行为面，T-G3 已断言；这里只做前置核对）
    const outTool = await tool.execute({ type: "design", documents: docs }, { agent, signal: undefined })
    assert.ok(outTool.startsWith("Advisor: design review blocked by the settlement guard (3/3"))

    const blockedView = await apiGet(captured.api, viewUrl)
    assert.equal(blockedView.reason, "no-session",
      "工具层预检**先于**会话注册返回（摘除该预检 → runAdvisorReview 被调用 → markSessionSeen 执行 → 此处变成 ok:true，用例转红）：" + JSON.stringify(blockedView))

    // 对照（同一 apply / 同一 sid）：一次**不走**预检的工具调用 → markSessionSeen 执行 → 该 sid 可读
    const noScope = await tool.execute({}, { agent, signal: undefined })
    assert.ok(String(noScope).startsWith("Advisor: no review scope specified"),
      "非 design 调用不进预检（走核心层常规路径）：" + String(noScope).slice(0, 80))
    const seenView = await apiGet(captured.api, viewUrl)
    assert.notEqual(seenView.reason, "no-session",
      "对照：同一 sid 经一次未被拦的工具调用后确实已登记（证明上一条断言有区分度，不是环境恒定值）")
  } finally { cleanSid(sid); rmHome(home) }
})

// ————————————————————— T-G4 / AC-G4：成对锁的「摘除即红」面 —————————————————————

test("T-G4 (AC-G4): the zero-LLM assertion above IS the removal-lock — a 4th call with a *different* doc set still reaches the LLM (scope isolation)", async () => {
  const home = mkHome()
  const sid = newSid("acg4")
  const blockedDocs = ["docs/b4-acg4-a.md"]
  const otherDocs = ["docs/b4-acg4-b.md"]
  try {
    const agent = makeAgent(sid)
    const llm = scriptedLlm([NOT_A_REVIEW])
    for (let i = 0; i < 3; i++) await callDesign({ llm }, agent, blockedDocs, home)
    assert.equal(designStrikes(sid, designDocKey(blockedDocs)), 3)
    // 同键第 4 次：零 LLM（摘掉护栏钩子 → 这里会变成 4 —— 见交付报告的实测输出）
    const callsBefore = llm.calls.length
    await callDesign({ llm }, agent, blockedDocs, home)
    assert.equal(llm.calls.length, callsBefore, "摘除护栏钩子即红（第 4 次必须仍然零 LLM）")
    // 换文档集：照常放行（护栏是**文档集级**，不是会话级）
    const out = await callDesign({ llm }, agent, otherDocs, home)
    assert.equal(llm.calls.length, callsBefore + 1, "不同文档集不受该键的连败影响")
    assert.ok(!out.startsWith("Advisor: design review blocked"), "换集不被拦")
  } finally { cleanSid(sid); rmHome(home) }
})

// ————————————————————— T-G5 / AC-G5：逐形态计数（机械事实优先） —————————————————————

test("T-G5a (AC-G5): the five self-produced prefixes map to their kinds; non-Advisor text maps to null", () => {
  assert.equal(classifySettlement("Advisor: context window limit reached (1 tokens). Review incomplete"), "context_limit")
  assert.equal(classifySettlement("Advisor: stopped after 100 tool rounds — the review appears to be looping."), "turn_cap")
  assert.equal(classifySettlement("Advisor: review timeout after 600000ms (round 1, 3 files read)"), "timeout")
  assert.equal(classifySettlement("Advisor: review failed (empty response — 重试一次仍空)。\n[thincoder-suite] x"), "empty")
  assert.equal(classifySettlement("Advisor: interrupted."), "interrupted")
  assert.equal(classifySettlement("Advisor: something else entirely"), "review_failed", "其余 Advisor: 前缀 = review_failed")
  assert.equal(classifySettlement("a normal completed review"), null, "非失败前缀 = 完成态（由调用方按可用判决判定）")
  // 站点机械事实优先（D-G5）：backstop / stale / token_persist_failed 直传；hint 压过散文
  assert.equal(classifySettlement("Advisor: interrupted.", "timeout"), "timeout", "内部兜底 abort 不得被 interrupted 豁免漏掉")
  assert.equal(classifySettlement("whatever", "stale"), "stale")
  assert.equal(classifySettlement("whatever", "token_persist_failed"), "token_persist_failed")
})

test("T-G5b (AC-G5): context_limit / turn_cap / empty / timeout / review_failed each +1 through the REAL review path", async () => {
  const home = mkHome()
  const cases = [
    ["context_limit", "Advisor: context window limit reached (100 tokens). Review incomplete — too many tool calls."],
    ["turn_cap", "Advisor: stopped after 100 tool rounds — the review appears to be looping."],
    ["empty", "Advisor: review failed (empty response — 重试一次仍空)。"],
    ["timeout", "Advisor: review timeout after 600000ms (round 1, 0 files read)"],
    ["review_failed", NOT_A_REVIEW],
  ]
  const sids = []
  try {
    for (const [kind, text] of cases) {
      const sid = newSid("acg5-" + kind)
      sids.push(sid)
      const docs = ["docs/b4-acg5-" + kind + ".md"]
      const llm = scriptedLlm([text])
      await callDesign({ llm }, makeAgent(sid), docs, home)
      assert.equal(designStrikes(sid, designDocKey(docs)), 1, kind + " 计 1 振")
      // 种类可观测面：再把该 kind 累积到 3 次 → 护栏串的“最近三次 kind”必须写对
      const llm2 = scriptedLlm([text])
      await callDesign({ llm: llm2 }, makeAgent(sid), docs, home)
      await callDesign({ llm: llm2 }, makeAgent(sid), docs, home)
      assert.equal(designStrikes(sid, designDocKey(docs)), 3, kind + " 三次到顶")
      const guard = settlementGuardText(sid, designDocKey(docs))
      assert.equal(guardKindsLine(guard), [kind, kind, kind].join(" → "), kind + " 的 kind 归类正确")
    }
  } finally { for (const s of sids) cleanSid(s); rmHome(home) }
})

test("T-G5c (AC-G5): interrupted → 0; a dispatch return → 0 (review has not happened yet)", async () => {
  const home = mkHome()
  const sidA = newSid("acg5c-int")
  const sidB = newSid("acg5c-disp")
  try {
    // ① 用户主动中断（US-4）：不计振
    const docsA = ["docs/b4-acg5c-int.md"]
    const llmA = scriptedLlm(["Advisor: interrupted."])
    await callDesign({ llm: llmA }, makeAgent(sidA), docsA, home)
    assert.equal(designStrikes(sidA, designDocKey(docsA)), 0, "interrupted 不计振")

    // ② 派发返回（派后台 job，评审尚未发生）：不计振；job 内真跑完才计
    const docsB = ["docs/b4-acg5c-disp.md"]
    const { specs, service } = fakeJobs()
    const llmB = scriptedLlm([NOT_A_REVIEW])
    const config = { advisor: { round1: { provider: "p", model: "m", timeoutMs: 600000 } }, codexCli: { budgetCapMs: 5000 } }
    const reply = await callDesign({ llm: llmB, ctx: jobsCtx(service) }, makeAgent(sidB), docsB, home, config)
    assert.match(reply, /started as background job/, "确实走了后台派发：" + reply.slice(0, 120))
    assert.equal(designStrikes(sidB, designDocKey(docsB)), 0, "派发返回不计振（评审尚未发生）")
    await specs[0].hooks.done
    assert.equal(designStrikes(sidB, designDocKey(docsB)), 1, "job 内结算后恰好 +1（证明派发点自身贡献 0）")
  } finally { cleanSid(sidA); cleanSid(sidB); rmHome(home) }
})

test("T-G5d (AC-G5): the dsh background backstop deadline counts as `timeout`, NOT as `interrupted`", async () => {
  const home = mkHome()
  const sid = newSid("acg5d")
  const docs = ["docs/b4-acg5d.md"]
  const docKey = designDocKey(docs)
  try {
    // null 脚本 = 挂起的 llm 流；dshBackgroundTimeoutMs=120 → 兜底 abort（§7.2 挂死防护）
    const config = {
      dshBackgroundTimeoutMs: 120,
      advisor: { round1: { provider: "p", model: "m", timeoutMs: 600000 } },
      codexCli: { budgetCapMs: 5000 },
    }
    for (let i = 0; i < 3; i++) {
      const { specs, service } = fakeJobs()
      const llm = scriptedLlm([null])
      const reply = await callDesign({ llm, ctx: jobsCtx(service) }, makeAgent(sid), docs, home, config)
      assert.match(reply, /started as background job/)
      await specs[0].hooks.done
    }
    assert.equal(designStrikes(sid, docKey), 3, "兜底截止三次 → 三振（不是 0）")
    const guard = settlementGuardText(sid, docKey)
    assert.equal(guardKindsLine(guard), "timeout → timeout → timeout",
      "兜底 abort 按 timeout 计——若按 interrupted 豁免则会退化成 0")
    assert.ok(!guard.includes("interrupted"), "护栏串里不得出现 interrupted")
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-G5e (AC-G5): a stale settlement (generation mismatch — finalize skipped) counts +1 as `stale`", async () => {
  const home = mkHome()
  const sid = newSid("acg5e")
  const docs = ["docs/b4-acg5e.md"]
  const docKey = designDocKey(docs)
  try {
    const config = { advisor: { round1: { provider: "p", model: "m", timeoutMs: 600000 } }, codexCli: { budgetCapMs: 5000 } }
    const { specs, service } = fakeJobs()
    let release = null
    const gate = new Promise((r) => { release = r })
    const llm = {
      calls: [],
      stream(opts) {
        this.calls.push(opts)
        return (async function* () {
          await gate // 挂住 job 内的评审，制造 dispatch 后 / settle 前的窗口
          yield { type: "block-end", block: { type: "text", text: REVIEW_TABLE } }
          yield { type: "finish", reason: { kind: "stop" } }
        })()
      },
    }
    const reply = await callDesign({ llm, ctx: jobsCtx(service) }, makeAgent(sid), docs, home, config)
    assert.match(reply, /started as background job/)
    // 语义转换点（D-10）：派发后代际变更 → finalize 被跳过
    bumpAdvisorGeneration(sessionState(sid))
    release()
    await specs[0].hooks.done
    assert.equal(designStrikes(sid, docKey), 1, "陈旧结算绕过 finalize 仍被显式打点")
    assert.equal(guardKindsLine(settlementGuardText(sid, docKey)), "stale", "归类为 stale")
  } finally { cleanSid(sid); rmHome(home) }
})

// ————————————— T-G5f / AC-G5 + 分歧审计 #3：失败形态**不**记 stale —————————————
// §5.4 对 stale 的定义是「job **完成**但 finalize 被跳过」；旧实现在 `completed`/`env.ok` 判定
// **之前**打点 ⇒ 代际失配的**失败** job（兜底超时/普通失败）也被记成 stale（计数都是 +1，差别只在
// 护栏串展示的 kind 与其按 kind 指引）。修法后：完成 → stale；失败 → 本路径既有归类。

test("T-G5f (§5.4 / 审计#3): a FAILED stale job is NOT recorded as `stale` — backstop timeout → `timeout`, generic failure → `review_failed`", async () => {
  const home = mkHome()
  const sidA = newSid("acg5f-timeout")
  const sidB = newSid("acg5f-generic")
  const docsA = ["docs/b4-acg5f-timeout.md"]
  const docsB = ["docs/b4-acg5f-generic.md"]
  const keyA = designDocKey(docsA)
  const keyB = designDocKey(docsB)
  const config = { dshBackgroundTimeoutMs: 120, advisor: { round1: { provider: "p", model: "m", timeoutMs: 600000 } }, codexCli: { budgetCapMs: 5000 } }
  try {
    // ① 兜底截止的 job 恰好同时换了代：按 `backstopFired` 机械事实记 timeout（**不是** stale）
    {
      const { specs, service } = fakeJobs()
      const reply = await callDesign({ llm: scriptedLlm([null]), ctx: jobsCtx(service) }, makeAgent(sidA), docsA, home, config)
      assert.match(reply, /started as background job/)
      bumpAdvisorGeneration(sessionState(sidA))
      const outcomeA = await specs[0].hooks.done
      assert.ok(String(outcomeA.output).includes("状态代际已变更"),
        "确走**代际失配**分支（不是 finalize 路径）：" + String(outcomeA.output).slice(0, 120))
      assert.equal(designStrikes(sidA, keyA), 1, "失败的陈旧 job 仍计 1 振（计数不变）")
      assert.equal(guardKindsLine(settlementGuardText(sidA, keyA)), "timeout",
        "失败形态按兜底机械事实记 timeout，不记 stale")
    }

    // ② 普通失败的 job 恰好同时换了代：仍按既有归类记 review_failed
    {
      const { specs, service } = fakeJobs()
      let release = null
      const gate = new Promise((r) => { release = r })
      const llm = {
        calls: [],
        stream(opts) {
          this.calls.push(opts)
          return (async function* () {
            await gate
            yield { type: "block-end", block: { type: "text", text: "Advisor: something else entirely" } }
            yield { type: "finish", reason: { kind: "stop" } }
          })()
        },
      }
      const reply = await callDesign({ llm, ctx: jobsCtx(service) }, makeAgent(sidB), docsB, home, config)
      assert.match(reply, /started as background job/)
      bumpAdvisorGeneration(sessionState(sidB))
      release()
      const outcomeB = await specs[0].hooks.done
      assert.ok(String(outcomeB.output).includes("状态代际已变更"),
        "确走**代际失配**分支（不是 finalize 路径——finalize 也会记 review_failed，那样本用例就绿得没有意义）："
        + String(outcomeB.output).slice(0, 120))
      assert.equal(designStrikes(sidB, keyB), 1, "失败的陈旧 job 仍计 1 振")
      assert.equal(guardKindsLine(settlementGuardText(sidB, keyB)), "review_failed",
        "失败形态按前缀表记 review_failed，不记 stale")
    }
  } finally { cleanSid(sidA); cleanSid(sidB); rmHome(home) }
})

// ————————————— T-G5g / AC-G5 + 分歧审计 #2：codex 路由的用户中断（ABORTED）不计振 —————————————
// codex-adapter 把中止信号结算为 `emptyEnvelope("ABORTED")` → 站点造出
// "Advisor: review failed (codex-cli ABORTED) — 已取消"；前缀表无该形态 ⇒ 旧实现归 `review_failed`
// ⇒ **用户主动中断被计振**（与 §5.4 第 11 行 / US-4 / README 矛盾；dsh 路径返回
// "Advisor: interrupted." 是对的，T-G5c 只喂了 dsh 那句故抓不到本形态）。
// 修法：`codexSettlementHint` 把 ABORTED 映射为 `interrupted`（finalize 的结算打点显式豁免它）。
// 反例对照：TIMEOUT 信封**仍计振**且 kind = timeout（证明只豁免中断形态）。

test("T-G5g (§5.4 / 审计#2): the codex ABORTED envelope is a USER INTERRUPT (0 strikes); the codex TIMEOUT envelope still counts as `timeout`", async () => {
  const home = mkHome()
  const sidA = newSid("acg5g-abort")
  const sidB = newSid("acg5g-timeout")
  const docsA = ["docs/b4-acg5g-abort.md"]
  const docsB = ["docs/b4-acg5g-timeout.md"]
  const keyA = designDocKey(docsA)
  const keyB = designDocKey(docsB)
  const codexDeps = (spec) => ({
    llm: { stream: () => { throw new Error("the codex route must not touch llm") } },
    spawn: fakeCodexSpawn(spec), platform: "linux", env: {},
  })
  try {
    // 反例锚（审计探针的实测）：信封原文**不带 hint** 时落进前缀表兜底 = review_failed ⇒
    // 修法必须在站点 hint 侧（D-G5「机械事实优先」），而不是靠散文猜。
    assert.equal(classifySettlement("Advisor: review failed (codex-cli ABORTED) — 已取消", undefined), "review_failed",
      "无 hint 时该串归 review_failed（正是审计探针的实测）")

    // ① 用户主动中断：abort 信号 → ABORTED 信封 → 不计振（US-4）
    const ctrl = new AbortController()
    const pending = runAdvisorReview(codexDeps({ events: [], hang: true }), {
      agent: makeAgent(sidA), config: CODEX_CFG, reviewType: "design", documents: docsA,
      signal: ctrl.signal, storPathOverride: home,
    })
    setTimeout(() => ctrl.abort(), 30)
    const outA = await pending
    assert.ok(outA.includes("codex-cli ABORTED"), "确是 ABORTED 信封面世：" + outA.slice(0, 160))
    assert.equal(designStrikes(sidA, keyA), 0, "用户中断不计振（ABORTED → interrupted）")
    assert.equal(guardKindsLine(settlementGuardText(sidA, keyA)), "(none recorded)", "无任何连败记录")

    // ② 对照：codex TIMEOUT 信封（watchdog 到期）**仍计振**，kind = timeout
    const outB = await runAdvisorReview(codexDeps({ events: [], hang: true }), {
      agent: makeAgent(sidB), config: CODEX_CFG, reviewType: "design", documents: docsB, storPathOverride: home,
    })
    assert.ok(outB.includes("codex-cli TIMEOUT"), "确是 TIMEOUT 信封面世：" + outB.slice(0, 160))
    assert.equal(designStrikes(sidB, keyB), 1, "TIMEOUT 信封仍记 1 振（只豁免中断形态）")
    assert.equal(guardKindsLine(settlementGuardText(sidB, keyB)), "timeout", "kind = timeout")
  } finally { cleanSid(sidA); cleanSid(sidB); rmHome(home) }
})

// ————————————————————— T-G6 / AC-G6：复位面（可用判决） —————————————————————

test("T-G6a (AC-G6): pass ∧ echo ∧ persisted===true resets the counter; explicit VERDICT: FAIL also resets", async () => {
  const home = mkHome()
  const sidA = newSid("acg6a")
  const sidB = newSid("acg6b")
  try {
    // ① 可用判决（签发成功）→ 复位
    const docsA = ["docs/b4-acg6a.md"]
    const keyA = designDocKey(docsA)
    recordDesignSettlement(sidA, keyA, "timeout")
    recordDesignSettlement(sidA, keyA, "empty")
    assert.equal(designStrikes(sidA, keyA), 2, "前置：确有连败")
    const llmA = approvingLlm()
    const outA = await callDesign({ llm: llmA }, makeAgent(sidA), docsA, home)
    assert.match(outA, /Approved\. Pass this exact token to eng_coder/, "签发成功")
    assert.equal(designStrikes(sidA, keyA), 0, "pass ∧ 回显 ∧ 落盘成功 → 复位为 0")

    // ② 显式 VERDICT: FAIL → 复位（**同时撤销 token 是另一条正交轴**）
    const docsB = ["docs/b4-acg6b.md"]
    const keyB = designDocKey(docsB)
    recordDesignSettlement(sidB, keyB, "stale")
    recordDesignSettlement(sidB, keyB, "turn_cap")
    assert.equal(designStrikes(sidB, keyB), 2)
    const llmB = scriptedLlm(["The design has unresolved problems.\n\nVERDICT: FAIL"])
    await callDesign({ llm: llmB }, makeAgent(sidB), docsB, home)
    assert.equal(designStrikes(sidB, keyB), 0, "显式 FAIL = 可用判决 → 复位")
  } finally { cleanSid(sidA); cleanSid(sidB); rmHome(home) }
})

test("T-G6b (AC-G6): pass ∧ echo but persisted===false counts +1 as `token_persist_failed` (§13 #6)", async () => {
  const home = mkHome()
  const sid = newSid("acg6c")
  const docs = ["docs/b4-acg6c.md"]
  const docKey = designDocKey(docs)
  // 不可写存储：override 指向一个**文件**（mkdirSync 必失败 → saveTokenRecord 返回 false）
  const blocker = join(home, "blocker")
  try {
    writeFileSync(blocker, "not a directory", "utf8")
    for (let i = 0; i < 3; i++) {
      const llm = approvingLlm()
      const out = await callDesign({ llm }, makeAgent(sid), docs, blocker)
      assert.match(out, /Approved\. Pass this exact token to eng_coder/, "签发路径本身照常（N2 fail-safe）")
    }
    assert.equal(designStrikes(sid, docKey), 3, "落盘失败三次 → 三振")
    assert.equal(guardKindsLine(settlementGuardText(sid, docKey)),
      "token_persist_failed → token_persist_failed → token_persist_failed")
  } finally { cleanSid(sid); rmHome(home) }
})

// ————————————————————— T-G7 / AC-G7：键不变性、内容无关与文档集隔离 —————————————————————

test("T-G7 (AC-G7): the key is PATH SHAPE only — order/relative-vs-absolute/backslash collapse; case does not; content edits do not rekey", () => {
  const a = join(PLUGIN_DIR, "docs", "b4-acg7-a.md")
  assert.equal(designDocKey([a, join(PLUGIN_DIR, "docs", "b4-acg7-b.md")]),
    designDocKey([join(PLUGIN_DIR, "docs", "b4-acg7-b.md"), a]), "乱序同键")
  assert.equal(designDocKey(["docs/b4-acg7-a.md"]), designDocKey(["./docs/b4-acg7-a.md"]), "相对写法同键")
  assert.equal(designDocKey(["docs\\b4-acg7-a.md"]), designDocKey(["docs/b4-acg7-a.md"]), "反斜杠同键")
  assert.notEqual(designDocKey(["docs/B4-ACG7-A.md"]), designDocKey(["docs/b4-acg7-a.md"]), "大小写不折叠 = 不同键（G-4）")
  assert.equal(designDocKey(["docs/b4-acg7-a.md", "docs/b4-acg7-a.md"]), designDocKey(["docs/b4-acg7-a.md"]), "去重")
  assert.equal(designDocKey([]), "empty", "空集哨兵")
  assert.equal(designDocKey(["  "]), "empty")
  assert.equal(designDocKey(null), "empty")
  // 内容无关（D-G3：**绝不用 computeDocHash** —— 一次空白编辑不得洗白计数）
  const home = mkHome()
  try {
    const p = join(home, "b4-acg7-content.md")
    writeFileSync(p, "v1", "utf8")
    const k1 = designDocKey([p])
    writeFileSync(p, "v2 — the document was completely rewritten", "utf8")
    assert.equal(designDocKey([p]), k1, "内容编辑不换键（纯路径形状）")
  } finally { rmHome(home) }
})

// ————————————————————— T-G8 / AC-G8：生命周期与两轴正交 —————————————————————

test("T-G8 (AC-G8): session/disposed clears the counter; a route success (resetRouteFailureState) does NOT; the hard-stop release shares that same function", async () => {
  const home = mkHome()
  const sid = newSid("acg8")
  const docs = ["docs/b4-acg8.md"]
  const docKey = designDocKey(docs)
  try {
    const agent = makeAgent(sid)
    const llm = scriptedLlm([NOT_A_REVIEW])
    for (let i = 0; i < 3; i++) await callDesign({ llm }, agent, docs, home)
    assert.equal(designStrikes(sid, docKey), 3)

    // 路由成功轴（任一路由成功 → resetRouteFailureState）：**不清**三振（P-d：不挂该钩子）
    const codeLlm = scriptedLlm([REVIEW_TABLE])
    await callCode({ llm: codeLlm }, agent, home)
    assert.equal(codeLlm.calls.length, 1, "code 评审确实跑成功（走到了 finalize 的 resetRouteFailureState 点）")
    assert.equal(designStrikes(sid, docKey), 3, "路由成功不清三振（N-5 两轴正交）")
    // 硬停解除路径调用的是**同一个** resetRouteFailureState（lib/advisor.mjs 指纹失配分支）——
    // 故上面这一行同时覆盖「硬停解除 → 不清」；另用静态锚钉死该调用点存在（防将来换实现）。
    const src = readFileSync(join(PLUGIN_DIR, "lib", "advisor.mjs"), "utf8")
    assert.match(src, /advisorHardStops\.delete\(sid\)\s*\n\s*resetRouteFailureState\(sid\)/, "硬停解除仍走同一清理函数")
    assert.ok(!/function resetRouteFailureState[\s\S]{0,400}designSettlementStrikes/.test(src),
      "resetRouteFailureState 不得触碰三振计数")

    // 会话销毁 = **唯一**解除路径
    const fakeCtx = makeFakeCtx()
    apply(fakeCtx, {})
    fakeCtx.emit("session/disposed", { id: sid })
    assert.equal(designStrikes(sid, docKey), 0, "session/disposed 清除计数")
  } finally { cleanSid(sid); rmHome(home) }
})

// ————————————————————— T-G9 / AC-G9：零改面静态锚 —————————————————————

test("T-G9 (AC-G9): zero-change static anchors — cap text verbatim, constant unchanged, tool/README wording synced, eng/prompts untouched", () => {
  const advisorSrc = readFileSync(join(PLUGIN_DIR, "lib", "advisor.mjs"), "utf8")
  for (const line of [
    'let message = "Advisor: convergence cap reached after " + MAX_ADVISOR_ROUNDS + " rounds.\\n"',
    'message += "\\nUnresolved issues from prior rounds:\\n" + unfixed.map(i => "- " + i).join("\\n") + "\\n"',
    'message += "\\nAll prior issues appear resolved.\\n"',
    'message += "\\nOptions:\\n1. Accept current state and proceed\\n2. Manually review specific concerns with read/grep\\n3. Start a new session to reset the advisor"',
  ]) assert.ok(advisorSrc.includes(line), "cap 串源码行逐字节：" + line)
  assert.ok(/if \(reviewType !== "design" && \(state\.advisorRound \|\| 0\) >= MAX_ADVISOR_ROUNDS\)/.test(advisorSrc),
    "cap 检查带类型条件（D-G1）")
  assert.equal(MAX_ADVISOR_ROUNDS, 5)
  assert.equal(DESIGN_STRIKE_LIMIT, 3)

  const indexSrc = readFileSync(join(PLUGIN_DIR, "lib", "index.mjs"), "utf8")
  assert.ok(!indexSrc.includes("max 5 rounds"), "工具描述不再撒谎（N-6/D-G12）")
  assert.ok(indexSrc.includes("5-round convergence cap applies to type='code' only"), "工具描述含新表述")

  const readme = readFileSync(join(PLUGIN_DIR, "README.md"), "utf8")
  assert.ok(!readme.includes("共用 5 轮预算"), "README 不再说共享 5 轮")
  assert.ok(readme.includes("只对 code 评审生效"), "README 含新表述")

  // eng.mjs / prompts 面零 diff（§13 #1 改判后的口径；session-store 由 §12 改为 +1 字段，不在此列）
  let gitOut = null
  try {
    gitOut = execFileSync("git", ["diff", "--name-only", "HEAD", "--", "lib/eng.mjs", "lib/prompts.mjs", "lib/prompts"],
      { cwd: PLUGIN_DIR, encoding: "utf8" }).trim()
  } catch (e) {
    if (e?.code === "ENOENT") gitOut = null // 无 git 的机器：跳过该锚（其余锚仍生效）
    else throw e
  }
  if (gitOut !== null) assert.equal(gitOut, "", "eng.mjs / prompts 面零 diff")
})

// ————————————————————— T-G10 / AC-G10：链作用域按文档集（D-35 折入） —————————————————————

test("T-G10 (AC-G10): switching the document set resets round+prior AND takes the round-1 prompt; the same set keeps advancing", async () => {
  const home = mkHome()
  const sid = newSid("acg10")
  const setA = ["docs/b4-acg10-a.md"]
  const setB = ["docs/b4-acg10-b.md"]
  try {
    const st = sessionState(sid)
    st.advisorRound = 3
    st.lastReviewType = "design"
    st.lastAdvisorOutput = PRIOR_TABLE
    st.lastDesignDocKey = designChainKey(setA)
    const agent = makeAgent(sid)

    // 换集 B：等价于类型切换 → round=0 / prior=null / 代际+1 / 落盘；随后写 lastDesignDocKey=B
    const seenAtStream = []
    const llm = {
      calls: [],
      stream(opts) {
        this.calls.push(opts)
        const s = sessionState(sid)
        seenAtStream.push({ round: s.advisorRound, prior: s.lastAdvisorOutput, prompt: opts.messages?.[0]?.content?.[0]?.text ?? "" })
        const text = seenAtStream.length === 1 ? REVIEW_TABLE : REVIEW_TABLE
        return (async function* () {
          yield { type: "block-end", block: { type: "text", text } }
          yield { type: "finish", reason: { kind: "stop" } }
        })()
      },
    }
    await callDesign({ llm }, agent, setB, home)
    assert.equal(seenAtStream[0].round, 0, "换集 → 提示词构建时 advisorRound 已归 0（round-1 判据）")
    assert.equal(seenAtStream[0].prior, null, "换集 → prior 已清空（零跨文档污染）")
    const genAfterSwitch = sessionState(sid).advisorGeneration
    assert.equal(sessionState(sid).advisorRound, 1, "换集后本轮照常推进（0 → 1）")
    assert.equal(sessionState(sid).lastDesignDocKey, designChainKey(setB), "链作用域键写成本次文档集")

    // 同一文档集 B 再发起：**不再**重置（只对「换集」动作重置）
    await callDesign({ llm }, agent, setB, home)
    assert.equal(seenAtStream[1].round, 1, "同一文档集：轮次照常（1，未被重置）")
    assert.equal(sessionState(sid).advisorRound, 2, "再推进一格")
    assert.equal(sessionState(sid).advisorGeneration, genAfterSwitch, "同一文档集不产生新的代际 +1（重置动作只发生一次）")

    // 提示词确实按轮次轮换（round-1 设计提示词 ≠ 收敛轮提示词）——排除「只看计数器」的空断言
    assert.ok(seenAtStream[0].prompt.includes("## Design Review"), "首次构建的是设计评审提示词")
    assert.notEqual(seenAtStream[0].prompt, seenAtStream[1].prompt, "round-1 与收敛轮提示词不同（轮换照常）")
  } finally { cleanSid(sid); rmHome(home) }
})

// ————————————————————— T-G11 / AC-G11：单实现 + 持久化往返 —————————————————————

test("T-G11a (AC-G11): designDocKey has exactly ONE definition across lib/ (no second key implementation)", () => {
  const libDir = join(PLUGIN_DIR, "lib")
  const files = readdirSync(libDir).filter(f => f.endsWith(".mjs")) // 全库扫描（非白名单——防新文件偷偷再定义一份）
  assert.ok(files.length >= 10, "确实扫到了 lib/ 的模块集：" + files.length)
  let defs = 0
  for (const f of files) {
    const src = readFileSync(join(libDir, f), "utf8")
    defs += (src.match(/function designDocKey\s*\(/g) ?? []).length
  }
  assert.equal(defs, 1, "链路键/计数键同一实现（N-7/D-G13）")
  assert.equal((readFileSync(join(libDir, "advisor.mjs"), "utf8").match(/function designChainKey\s*\(/g) ?? []).length, 1,
    "持久化表示也只有一个派生点")
})

test("T-G11b (AC-G11): lastDesignDocKey is in the persistence whitelist AND survives a write → read → restore round trip", async () => {
  const home = mkHome()
  const sid = newSid("acg11b")
  const docs = ["docs/b4-acg11b.md"]
  const key = designChainKey(docs)
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home // session-start 恢复路径不带 override —— 写/读必须落在同一 store
  try {
    const agent = makeAgent(sid)
    // 写：一次正常 design 评审（首写 lastDesignDocKey 即落盘）
    await callDesign({ llm: scriptedLlm([REVIEW_TABLE]) }, agent, docs, undefined)
    const raw = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8"))
    const entry = raw.sessions[sid]
    assert.equal(entry.lastDesignDocKey, key, "链作用域键已落盘（§12「必须落盘」）")
    assert.ok(!entry.lastDesignDocKey.includes("docs/"), "落盘值不含裸文档路径（AC-20 既有约束）")

    // 重启模拟：清内存 → agent/session-start 恢复
    dropAllSessions()
    const fakeCtx = makeFakeCtx()
    apply(fakeCtx, {})
    fakeCtx.emit("agent/session-start", { source: "resume", agent: makeAgent(sid) })
    assert.equal(sessionState(sid).lastDesignDocKey, key, "恢复后在内存态同值（读写往返）")

    // 恢复后的链判定仍然正确：同一文档集**不**触发重置
    const st = sessionState(sid)
    st.advisorRound = 2
    st.lastAdvisorOutput = PRIOR_TABLE
    st.lastReviewType = "design"
    const seen = []
    const llm = {
      stream(opts) {
        seen.push(sessionState(sid).advisorRound)
        return (async function* () {
          yield { type: "block-end", block: { type: "text", text: NOT_A_REVIEW } }
          yield { type: "finish", reason: { kind: "stop" } }
        })()
      },
    }
    await callDesign({ llm }, makeAgent(sid), docs, undefined)
    assert.equal(seen[0], 2, "重启后同一文档集不被误判为新链（否则这里会是 0）")
  } finally {
    process.env.DSH_HOME = prevHome
    cleanSid(sid)
    rmHome(home)
  }
})

// ————————— 批 4 评审微修 #1：非法文档集必须在**链重置之前**被拒（零状态变更） —————————
// 缺陷形态（设计层排序隐患）：检查序里「链重置判定」（needReset → round=0 / prior=null / 代际+1 /
// 落盘，并写入 lastDesignDocKey）**先于**文档合法性校验 ⇒ 用户对文档集 A 已收敛到 round 3，
// 一次手滑把 ["docs/a.md","src/typo.mjs"] 发进 design 评审 → chainKeyChanged 成立 → A 的 prior 被
// 清空**且已落盘**，随后才因非法文档被拒——而 D-G10 把「非法文档」定性为**预检类拒绝**
//（零 LLM、调用方**立即可自纠**），后置顺序让「立即可自纠」事实上不成立。
// 修法 = 该校验前移到链重置之前（三振预检之后），纯读、零状态变更。
// **还原即红**（实测输出见交付报告）：把该块移回原位置 → 本用例在「轮次仍在 3」/「prior 未被清空」/
// 「链作用域键未变」/「session-state.json 字节全等」四行转红。

test("T-G12 (微修 #1): an ILLEGAL design document set is rejected BEFORE the chain reset — the converged chain A survives untouched (zero state change)", async () => {
  const home = mkHome()
  const sid = newSid("fix1")
  const setA = ["docs/b4-fix1-a.md"]
  const illegal = [...setA, "src/typo.mjs"]
  try {
    const agent = makeAgent(sid)
    // 前置：先跑一次正常 design 评审 —— 既让链作用域键 A 落盘（获得非空的 session-state 镜像），
    // 也证明该文档集本来可用。
    const warm = scriptedLlm([REVIEW_TABLE])
    await callDesign({ llm: warm }, agent, setA, home)
    assert.equal(warm.calls.length, 1, "前置：合法文档集的评审照常执行")

    // 播种「文档集 A 上已收敛到 round 3」+ 链作用域键 = A（§13 #5 / AC-G10 同款播种面）
    const st = sessionState(sid)
    st.advisorRound = 3
    st.lastAdvisorOutput = PRIOR_TABLE
    st.lastReviewType = "design"
    st.lastDesignDocKey = designChainKey(setA)

    const statePath = resolveSessionStorePath(home)
    const before = snap(sid)
    const fileBefore = readFileSync(statePath, "utf8")
    const llm = scriptedLlm([REVIEW_TABLE])

    // 发起一次**含非法文档**的 design 评审（文档集 ≠ A ⇒ 若不前移就会先触发 chainKeyChanged）
    const out = await callDesign({ llm }, agent, illegal, home)

    // ① 返回非法文档错误串（文案与判定谓词与原文逐字一致）
    assert.ok(out.startsWith("Advisor: design review documents must be in docs/ directory or be recognized doc files. Invalid: src/typo.mjs"),
      "非法文档被拒且首部即错误串：" + String(out).slice(0, 160))

    // ② 零状态变更：在途链 A 完好无损（这就是本微修的全部意义）
    assert.equal(llm.calls.length, 0, "D-G10 预检类拒绝：零 LLM")
    assert.equal(sessionState(sid).advisorRound, 3, "在途链未被摧毁：轮次仍是 3（还原即红）")
    assert.equal(sessionState(sid).lastAdvisorOutput, PRIOR_TABLE, "prior 未被清空（还原即红）")
    assert.equal(sessionState(sid).lastDesignDocKey, designChainKey(setA), "链作用域键未被改写（还原即红）")
    assert.deepEqual(snap(sid), before, "N-1：状态快照全等（含 lastDesignDocKey）")
    assert.equal(readFileSync(statePath, "utf8"), fileBefore, "N-1：session-state.json 字节全等（零落盘）（还原即红）")
  } finally { cleanSid(sid); rmHome(home) }
})

// ————————— 批 4 评审微修 #4：护栏串的计数显示封顶 —————————
// `recordDesignSettlement` 的 count 无内部封顶（在飞 job 晚 settle 可推进到 4、5…），而护栏串的语义
// 是「已到上限」——`4/3` 这种显示自相矛盾。**只改展示**：内部计数仍是真实 count。

test("T-G13 (微修 #4): the guard string CLAMPS the displayed count at the limit (internal count stays truthful)", () => {
  const sid = newSid("fix4")
  const key = designDocKey(["docs/b4-fix4.md"])
  try {
    for (let i = 0; i < 4; i++) recordDesignSettlement(sid, key, "timeout")
    const text = settlementGuardText(sid, key)
    assert.ok(text.startsWith("Advisor: design review blocked by the settlement guard (3/3 for this document set).\n"),
      "显示封顶（既有 3/3 表述不变）：" + text.slice(0, 110))
    assert.ok(!text.includes("4/3"), "不得出现超限显示 4/3")
    assert.equal(designStrikes(sid, key), 4, "内部计数仍是真实 count（只改展示）")
    assert.equal(guardKindsLine(text), "timeout → timeout → timeout", "最近三次 kind 仍只留 3 条（不受封顶影响）")
  } finally { cleanSid(sid) }
})
