// death-provenance.test.mjs — 批 6「死亡可诊断」验收用例（T-AP1…T-AP9 ↔ AC-AP1…AC-AP9）。
// 设计档：docs/2026-09-13-death-diagnosability-design.md（§5 方案 / §6 机制 / §8 防偏离 /
// §10.2 用例表 / §12 评审轮次 1 修正块——冲突时以 §12 为准）。
//
// 纪律：零网络、零真实 LLM、零长等待（全部用例 ≤1.5s）；既有测试文件一个字符都不改
// （T-AP9 以 `git diff HEAD -- test/` 机验）。
//
// 口径（§12 #2）：四分辨构造集 = {user, timeout, cancel, unknown}；**crash 单列第五构造**，
// 其判定 = 「**无** abort 后缀 ∧ 原 message 逐字」。
process.env.DSH_HOME = ""
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import {
  TRIGGERS, LAYERS, triggerOf, abortError, timeoutError, annotateAbort, deathLine, abortTag,
} from "../lib/abort-provenance.mjs"
import { runAdvisorToolLoop, shouldBudgetNudge } from "../lib/advisor.mjs"
import { runEngCoder } from "../lib/eng.mjs"
import { runEscalate } from "../lib/escalate.mjs"
import { startConsultSession, stopConsultSession, cleanupConsultSessions } from "../lib/consult.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const libPath = (f) => join(PLUGIN_DIR, "lib", f)
const libFile = (f) => readFileSync(libPath(f), "utf8")

async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(5)
  }
  throw new Error("waitFor timeout")
}

/** AbortError 形状（适配器/驱动自产；**无声样** = message 不含任何我方标记）。 */
const abortErr = (msg = "The operation was aborted") => {
  const e = new Error(msg)
  e.name = "AbortError"
  return e
}

/** 四种触发构造（§12 #2）——写出点侧形状：user 走 `interrupt`，其余走 abortInfo / 无声样。 */
const construct = {
  user: () => AbortSignal.abort({ interrupt: true }),
  timeout: () => AbortSignal.abort(timeoutError("constructed budget deadline", "agent", "constructed timeout")),
  cancel: () => AbortSignal.abort(abortError(null, "agent", "constructed cancel", "cancel")),
  unknown: () => AbortSignal.abort(new Error("mystery abort")),
}

// ————————————— T-AP1（AC-AP1）：四家族 × 四触发 + unknown 显式 —————————————

// —— advisor 家族（loop 顶的 signal.aborted 站点）——

const textFinish = { type: "finish", reason: { kind: "stop" } }
const textBlocks = (t) => [{ type: "block-end", block: { type: "text", text: t } }, textFinish]

function makeLlm(behaviors) {
  const calls = []
  let n = 0
  return {
    calls,
    stream(opts) {
      calls.push({ opts, snapshot: opts.messages.map((m) => JSON.stringify(m)) })
      return behaviors[Math.min(n++, behaviors.length - 1)](opts)
    },
  }
}

function loopOpts(extra = {}) {
  return {
    provider: "p", model: "m", system: "sys", firstUserText: "review scope",
    cwd: PLUGIN_DIR, signal: undefined, sessionId: "ap-loop", timeoutMs: 5000,
    ...extra,
  }
}

const neverCalled = () => (async function* () { throw new Error("llm must not be called for an already-aborted signal") })()

async function advisorLooped(signal) {
  return runAdvisorToolLoop({ llm: makeLlm([neverCalled]) }, loopOpts({ signal }))
}

test("T-AP1a (AC-AP1): advisor 家族四触发 → 正确的 trigger@layer（含 unknown 显式态）", async () => {
  const out = {
    user: await advisorLooped(construct.user()),
    timeout: await advisorLooped(construct.timeout()),
    cancel: await advisorLooped(construct.cancel()),
    unknown: await advisorLooped(construct.unknown()),
  }
  assert.ok(out.user.includes("abort(user@settle: caller interrupt)"), out.user)
  assert.ok(out.timeout.includes("abort(timeout@agent: constructed timeout)"), out.timeout)
  assert.ok(out.cancel.includes("abort(cancel@agent: constructed cancel)"), out.cancel)
  // 归不了因 → **显式 unknown**（不得静默回落成通用文案，P-c）
  assert.ok(out.unknown.includes("abort(unknown@settle: mystery abort)"), out.unknown)
  for (const k of Object.keys(out)) assert.ok(out[k].includes(" · abort("), k + " 必须带溯源后缀")
})

// —— eng 家族（dsh 同步路径 catch）——

function makeEngDeps(sid, signal, rejectWith) {
  const state = sessionState(sid)
  state.engineering = true
  state.designToken = randomUUID() + ":" + (Date.now() + 3600_000)
  const subagents = {
    async start() {
      return {
        result: rejectWith ? Promise.reject(rejectWith) : Promise.resolve({ output: [], stopReason: "aborted" }),
        dispose: async () => {},
      }
    },
  }
  // 最小 resolveModelInfo（生产 LlmRuntime 实有）——缺它会让 effort 走 fail-open 告警前缀，
  // 干扰「前缀逐字」断言（与 stages.test.mjs 的 harness 同口径）。
  const llm = {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }], defaultEffort: "low" } }
    },
  }
  return {
    state,
    deps: {
      ctx: { subagents, llm },
      agent: { session: { id: sid, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
      config: {}, signal, configDefaultEngineering: false,
    },
  }
}

async function engAborted(trigger) {
  const sid = "ap-eng-" + trigger + "-" + randomUUID()
  const { deps, state } = makeEngDeps(sid, construct[trigger](), abortErr())
  try {
    return await runEngCoder(deps, { task: "implement x", designToken: state.designToken })
  } finally { dropSession(sid) }
}

test("T-AP1b (AC-AP1): eng 家族四触发 → 正确的 trigger@layer（含 unknown 显式态）", async () => {
  const out = await engAborted("user")
  assert.ok(out.includes("abort(user@agent: parent signal relayed)"), out)
  assert.ok((await engAborted("timeout")).includes("abort(timeout@agent: parent signal relayed)"))
  assert.ok((await engAborted("cancel")).includes("abort(cancel@agent: parent signal relayed)"))
  assert.ok((await engAborted("unknown")).includes("abort(unknown@agent: parent signal relayed)"))
})

// —— escalate 家族（dsh 同步路径 catch）——

function makeEscDeps(sid, signal, rejectWith) {
  const state = sessionState(sid)
  const subagents = {
    async start() { return { result: Promise.reject(rejectWith), dispose: async () => {} } },
  }
  return {
    deps: {
      ctx: { subagents },
      agent: { session: { id: sid, header: { cwd: PLUGIN_DIR } }, options: {} },
      config: { consultModels: [{ provider: "p", model: "m" }] },
      state, signal, configDefaultEngineering: false,
    },
  }
}

async function escAborted(trigger) {
  const sid = "ap-esc-" + trigger + "-" + randomUUID()
  const { deps } = makeEscDeps(sid, construct[trigger](), abortErr())
  try {
    return await runEscalate(deps, "task text", undefined, false, false)
  } finally { dropSession(sid) }
}

test("T-AP1c (AC-AP1): escalate 家族四触发 → 正确的 trigger@layer（含 unknown 显式态）", async () => {
  assert.ok((await escAborted("user")).includes("abort(user@agent: parent signal relayed)"))
  assert.ok((await escAborted("timeout")).includes("abort(timeout@agent: parent signal relayed)"))
  assert.ok((await escAborted("cancel")).includes("abort(cancel@agent: parent signal relayed)"))
  assert.ok((await escAborted("unknown")).includes("abort(unknown@agent: parent signal relayed)"))
})

// —— consult 家族（控制器写点 → 结算面）——
// 口径说明（**登记为偏差**）：consult 的 `user` 触发**无构造**——D-28 纪律（consult.mjs 头注）
// 规定「子代理信号不得继承调用方 exec.signal」，调用方的 user 意图只经 consult_stop 表达，
// 而按 §6 伪代码 stop 路径的 trigger 是 `stop`（不是 `user`）。故 consult 的四构造取
// {timeout, stop, cancel, unknown}，user 面以 stop 表达。
//
// ★ 批 15（FR-2 / R-9）：`checkConsultSession` 整体退役（含 `waiters`）⇒ **消费面改指 digest**
// （`composeConsultDigest` 的产物）。断言仍是「死亡行**经生产消费面**可见」——digest 就是新的
// 生产消费面，故批 6 的纪律（不得手搓 `deathLine(...)` 绕过生产站点）零削弱。
// ★ 且该批要求派发走平台 job（D15-1/D15-4）⇒ 这里的 deps 必须带假 jobs 服务；纪要档与台账
// 落点为**临时目录**（不得污染仓库 docs/ 与真实 DSH_HOME）。

/** 假平台 jobs 服务（平台契约：`start(spec)` 调 `spec.run()` 取 `{cancel, done}`）。 */
function consultJobs() {
  const specs = []
  return {
    specs,
    jobs: { start(spec) { const hooks = spec.run(); specs.push({ spec, hooks }); return "consult-" + specs.length } },
  }
}

/** digest 消费面：等 run 体合成（`settleAndDeliver` 在 job complete 之前写）。 */
async function consultDigestOf(state, id, timeoutMs = 3000) {
  const s = state.consultSessions.get(String(id))
  await waitFor(() => !!s?.digest, timeoutMs)
  return s.digest
}

function makeConsultDeps({ config = {}, mode = "abort-resolve" } = {}) {
  const sid = "ap-consult-" + randomUUID()
  const state = sessionState(sid)
  const seen = { req: null }
  const j = consultJobs()
  const subagents = {
    async start(kind, req) {
      seen.req = req
      if (mode === "crash") return { result: Promise.reject(new Error("boom")), dispose: async () => {} }
      if (mode === "resolve-error") {
        return { result: Promise.resolve({ output: [], stopReason: "error", diagnostic: "boom" }), dispose: async () => {} }
      }
      // abort-reject：子代理以 **reject** 结束（AbortError）——批 6 修复轮审计 🔴 #1：只有这条路径
      // 才落到 consult.mjs 的 `catch (e)` → `session.stopped` 分支（生产站点的死亡行）。
      if (mode === "abort-reject") {
        const result = new Promise((_, rej) => {
          const onAbort = () => rej(abortErr())
          if (req.signal.aborted) onAbort()
          else req.signal.addEventListener("abort", onAbort, { once: true })
        })
        return { result, dispose: async () => {} }
      }
      // abort-resolve：复刻 in-process driver——signal abort → **resolve** stopReason=aborted（非 reject）
      let done = false
      const result = new Promise((res) => {
        const onAbort = () => { done = true; res({ output: [], stopReason: "aborted" }) }
        if (req.signal.aborted) onAbort()
        else req.signal.addEventListener("abort", onAbort, { once: true })
        const t = setTimeout(() => { if (!done) res({ output: [{ type: "text", text: "ok" }], stopReason: "completed" }) }, 5000)
        t.unref?.()
      })
      return { result, dispose: async () => {} }
    },
  }
  return {
    sid, state, seen, jobs: j,
    deps: {
      ctx: { subagents, get: (svc) => (svc === "jobs" ? j.jobs : null) },
      // 批 15：纪要档与台账写盘 ⇒ 落点必须在临时目录（不得污染仓库 docs/ 与真实 DSH_HOME）
      agent: { session: { id: sid, header: { cwd: mkdtempSync(join(tmpdir(), "ap-consult-cwd-")) }, deriveMessages: () => [] }, options: {} },
      config: { consultModels: [{ provider: "p", model: "m" }], ...config },
      state, signal: undefined, persona: undefined,
      dshHome: mkdtempSync(join(tmpdir(), "ap-consult-home-")),
    },
  }
}

async function consultStart(h) {
  const s = await startConsultSession(h.deps, "problem", undefined)
  await waitFor(() => h.state.consultSessions.get(s.id)?.controllers?.length === 1)
  return { id: s.id, ctrl: h.state.consultSessions.get(s.id).controllers[0] }
}

const cleanupConsult = (h) => { cleanupConsultSessions(h.state); dropSession(h.sid) }

test("T-AP1d (AC-AP1): consult 家族 {timeout, stop, cancel, unknown} 四构造 → trigger@layer 正确", async () => {
  // timeout：看门狗（我方自持定时器 → layer agent）
  const hT = makeConsultDeps({ config: { consultTimeoutMs: 30 } })
  const { id: idT, ctrl: ctrlT } = await consultStart(hT)
  const dT = await consultDigestOf(hT.state, idT)
  assert.match(dT, /timed out after 1s/, "超时信封可见")
  assert.equal(abortTag(ctrlT.signal.reason), "abort(timeout@agent)",
    "看门狗写点载荷 = timeout@agent" + timingState({ consultTimeoutMs: 30, reason: abortTag(ctrlT.signal.reason) }))
  cleanupConsult(hT)

  // stop：consult_stop 早停 —— **经由消费面断言**（批 6 修复轮审计 🔴 #1：用例不得再手搓
  // `deathLine(...)` 绕过生产站点；批 15 起消费面 = digest，读的仍是生产站点真正合成的载荷）。
  // 子代理以 **reject** 结束（abort-reject）→ 落 consult.mjs `catch (e)` 的 `session.stopped` 分支。
  const hS = makeConsultDeps({ mode: "abort-reject" })
  const { id: idS, ctrl: ctrlS } = await consultStart(hS)
  const sessS = hS.state.consultSessions.get(idS)
  assert.equal(stopConsultSession(hS.state, idS, 1).abandoned, 1)
  await waitFor(() => ctrlS.signal.aborted)
  assert.equal(abortTag(ctrlS.signal.reason), "abort(stop@agent)", "stop 写点载荷")
  const dS = await consultDigestOf(hS.state, idS)
  assert.match(dS, /^aborted · abort\(stop@agent: stop requested\)$/m,
    "stop 死亡行经**消费面**（digest）可见（early-stop 面逐字不包壳）：" + dS.split("\n").slice(-3).join(" / "))
  assert.match(dS.split("\n")[0], /^\[consult #\d+ stopped — 0 of 1 replied \(0 failed, 1 stopped\) before stop\]$/,
    "批 15（D15-3）：stop 产墓碑 digest")
  assert.equal(sessS.terminated, 1, "terminated 计数照旧（T-AP1d 旧断言保留）")
  assert.equal(sessS.requiresReport, false, "墓碑 ⇒ requiresReport=false")
  cleanupConsult(hS)

  // stop（resolve 形态）：子代理以 resolve（stopReason=aborted）结束 → 同样进消费面
  const hR2 = makeConsultDeps({ mode: "abort-resolve" })
  const { id: idR2, ctrl: ctrlR2 } = await consultStart(hR2)
  stopConsultSession(hR2.state, idR2, 1)
  await waitFor(() => ctrlR2.signal.aborted)
  const dR2 = await consultDigestOf(hR2.state, idR2)
  assert.match(dR2, /^child ended: aborted · abort\(stop@agent: stop requested\)$/m,
    "resolve 形态的早停同样经消费面自证来源：" + dR2.split("\n").slice(-3).join(" / "))
  cleanupConsult(hR2)

  // cancel：session 销毁（宿主结算面 → layer **settle**，批 6 修复轮审计 #3）
  const hC = makeConsultDeps({ mode: "abort-reject" })
  const { id: idC, ctrl: ctrlC } = await consultStart(hC)
  const sessC = hC.state.consultSessions.get(idC)
  cleanupConsultSessions(hC.state)
  assert.equal(abortTag(ctrlC.signal.reason), "abort(cancel@settle)",
    "销毁写点载荷（宿主结算面 → settle，不是 agent）")
  await waitFor(() => (sessC.terminated ?? 0) === 1, 3000)
  // ⚠ **如实登记：本面不可经消费面观测**——`cleanupConsultSessions` 尾部
  // `state.consultSessions.clear()` 由宿主销毁路径摘除会话，且批 15（R-9）显式裁定
  // **dispose 不强行造墓碑投递** ⇒ digest 无从合成（run 体返回 killed）。故这里只断言
  // 「结算载荷确实按 cancel@settle 合成」（读会话自身的队列，非手搓等价物）。
  assert.equal(String(sessC.replies[0]?.reply ?? ""), "aborted · abort(cancel@settle: session disposed)",
    "结算载荷 = cancel@settle：" + String(sessC.replies[0]?.reply))
  assert.equal(sessC.digest, null, "dispose 面不合成 digest（R-9 登记例外）")
  dropSession(hC.sid)

  // unknown：控制器以**无声样** reason 中止（显式 unknown，不静默回落）
  const hU = makeConsultDeps({})
  const { id: idU, ctrl: ctrlU } = await consultStart(hU)
  ctrlU.abort(new Error("mystery abort"))
  const dU = await consultDigestOf(hU.state, idU)
  assert.match(dU, /abort\(unknown@agent: mystery abort\)/, dU)
  cleanupConsult(hU)
})

// ————————————— 批 6 修复轮：站群矩阵补齐（审计 🟡 #3 / 🟡 #5） —————————————
//
// 审计实证：原 AC-AP1 矩阵每家族**只走一个站**（`ctx.subagents.start` → dsh 内层 catch），
// codex 路径、dsh 外层 catch、job-kill 面**一条断言都没有** ⇒ 在这些站把 `settle` 换成 `agent`
// 全绿。下面按站补**可失败**断言（假子进程 / 假 jobs / 假子代理，零网络、零真实 codex）。

/** 假 jobs 服务（平台契约：start(p) 调 p.run() 取 {cancel, done}，返回 branded string）。 */
function fakeJobs() {
  const specs = []
  return {
    specs,
    jobs: { start(p) { const hooks = p.run(); specs.push({ payload: p, hooks }); return "app-job-" + specs.length } },
  }
}

/** 假子代理：**父信号一中止即以 AbortError reject**（reject-race 形态——eng/escalate 的 job
 *  catch 面正是接它）。 */
function abortingSubagents() {
  return {
    async start(kind, req) {
      const result = new Promise((_, rej) => {
        const onAbort = () => rej(abortErr())
        if (req.signal.aborted) onAbort()
        else req.signal.addEventListener("abort", onAbort, { once: true })
      })
      return { result, dispose: async () => {} }
    },
  }
}

/** 只读假信号：`aborted` 由测试**事后**翻转，且 addEventListener 从不回调 ⇒ 父信号中继
 *（forwardSignal）永不发射、dshCtrl 保持未中止 ⇒ 走「signal.aborted ⇒ settle」那一臂。 */
function pendingSignal() {
  return {
    aborted: false,
    addEventListener() { /* 永不回调 */ },
    removeEventListener() { /* noop */ },
    fire() { this.aborted = true },
  }
}

// —— 假 codex 子进程（零网络）：--version / debug models 正常应答，exec 调用按用例剧本走 ——
function fakeCodexChild({ stdoutData = null, exitCode = 0, hang = false, abortOnStdout = null } = {}) {
  const child = new EventEmitter()
  child.pid = 424242
  if (abortOnStdout) {
    // 取值即**先中止调用方信号再抛**：时序必须落在 adapter 的 `opts.signal.aborted` 检查**之后**
    //（那里会走 ABORTED 信封），这样异常才真正冒泡到调用方的 catch 面。
    Object.defineProperty(child, "stdout", {
      get() { abortOnStdout.abort({ interrupt: true }); throw new Error("codex plumbing exploded") },
    })
    return child
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write() {}, end() {} }
  child.kill = () => {}
  setImmediate(() => {
    if (stdoutData !== null) child.stdout.emit("data", Buffer.from(stdoutData))
    if (!hang) child.emit("exit", exitCode)
  })
  return child
}

/** codex 面假 spawn：exec 调用返回「取值即中止+抛」的子进程 ⇒ runCodexTask **以抛出**结束
 *（= codex 同步路径的 catch 面，eng.mjs:671 / escalate.mjs:272），且此时调用方信号已中止。 */
function codexThrowSpawn(ctrl) {
  return (file, args) => {
    if (args.includes("--version")) return fakeCodexChild({ stdoutData: "codex-cli 0.150.1\n" })
    if (args.includes("debug") && args.includes("models")) return fakeCodexChild({ stdoutData: JSON.stringify({ models: [] }) })
    return fakeCodexChild({ abortOnStdout: ctrl })
  }
}

/** codex 面假 spawn：exec 调用**挂死**（不发 exit）——等 watchdog / stop 中止（ABORTED 信封面）。 */
function codexHangSpawn() {
  return (file, args) => {
    if (args.includes("--version")) return fakeCodexChild({ stdoutData: "codex-cli 0.150.1\n" })
    if (args.includes("debug") && args.includes("models")) return fakeCodexChild({ stdoutData: JSON.stringify({ models: [] }) })
    return fakeCodexChild({ hang: true })
  }
}

const CODEX_ENV = { CODEX_HOME: join(tmpdir(), "ap-empty-codex-home") } // 无该目录 ⇒ catalog 缓存兜底短路
let codexExeSeq = 0
const codexExe = (p) => "t-ap-" + p + "-" + (++codexExeSeq) // probeCache/modelCache 按 executable 键控

test("T-AP1e (AC-AP1, 审计 #3): 宿主 job kill（cancel 回调）→ `cancel@settle`，不是 `unknown@agent`", async () => {
  // —— eng：dsh 后台 job（eng.mjs 的 `cancel: cancelJob // 批 29 单①：写点具名化（行为逐字相同；原注释写 `ctrl.abort(reason)` 已成陈旧指针，顺手订正）` + 该 job 的 catch 面）——
  const engJobs = fakeJobs()
  const sidE = "ap-eng-jobkill-" + randomUUID()
  const stE = sessionState(sidE)
  stE.engineering = true
  stE.designToken = randomUUID() + ":" + (Date.now() + 3600_000)
  const depsE = {
    ctx: { get: (svc) => (svc === "jobs" ? engJobs.jobs : null), subagents: abortingSubagents() },
    agent: { session: { id: sidE, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
    config: {}, signal: undefined, configDefaultEngineering: false,
  }
  try {
    await runEngCoder(depsE, { task: "implement x", designToken: stE.designToken, background: true })
    assert.equal(engJobs.specs.length, 1, "eng dsh 后台 job 已派发")
    engJobs.specs[0].hooks.cancel({ kind: "parent" }) // 宿主 job kill：**未打标**的宿主形状 reason
    const oE = await engJobs.specs[0].hooks.done
    assert.equal(oE.detail, "abort(cancel@settle)", "机器短标签 = cancel@settle（不是 unknown@agent）")
    assert.ok(oE.output.includes("eng_coder aborted. · abort(cancel@settle: host job cancel)"), oE.output)
    assert.ok(!oE.output.includes("@agent"), "宿主 job-kill 面不得回落成 agent 层：" + oE.output)
  } finally { dropSession(sidE) }

  // —— escalate：dsh 后台 job（escalate.mjs 同款 cancel 回调 + catch 面）——
  const escJobs = fakeJobs()
  const sidS = "ap-esc-jobkill-" + randomUUID()
  const depsS = {
    ctx: { get: (svc) => (svc === "jobs" ? escJobs.jobs : null), subagents: abortingSubagents() },
    agent: { session: { id: sidS, header: { cwd: PLUGIN_DIR } }, options: {} },
    config: { consultModels: [{ provider: "p", model: "m" }] },
    state: sessionState(sidS), signal: undefined, configDefaultEngineering: false,
  }
  try {
    await runEscalate(depsS, "task text", undefined, false, true)
    assert.equal(escJobs.specs.length, 1, "escalate dsh 后台 job 已派发")
    escJobs.specs[0].hooks.cancel({ kind: "parent" })
    const oS = await escJobs.specs[0].hooks.done
    assert.equal(oS.detail, "abort(cancel@settle)", "机器短标签 = cancel@settle")
    assert.ok(oS.output.includes("escalate (p:m) aborted. · abort(cancel@settle: host job cancel)"), oS.output)
  } finally { dropSession(sidS) }
})

test("T-AP1f (AC-AP1, 审计 #5): 未覆盖站点矩阵——codex settle 面 / dsh 外层 catch settle 臂", async () => {
  // —— (1) eng codex 同步路径 catch（eng.mjs:671，layer settle）——
  const ctrlE = new AbortController()
  const sidE = "ap-eng-codex-settle-" + randomUUID()
  const stE = sessionState(sidE)
  stE.engineering = true
  stE.designToken = randomUUID() + ":" + (Date.now() + 3600_000)
  const depsE = {
    ctx: {
      subagents: { start: () => { throw new Error("dsh spawn must not run for codex backend") } },
      llm: { async resolveModelInfo() { return null } },
    },
    agent: { session: { id: sidE, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
    config: { codexCli: { engCoderRunner: "codex-cli", model: "m", executable: codexExe("codex-settle-eng") } },
    signal: ctrlE.signal, configDefaultEngineering: false,
    spawn: codexThrowSpawn(ctrlE), platform: "linux", env: CODEX_ENV,
  }
  try {
    const outE = await runEngCoder(depsE, { task: "implement x", designToken: stE.designToken })
    assert.ok(outE.includes("eng_coder aborted. · abort(user@settle: caller interrupt)"),
      "codex 同步路径的调用方信号面 = settle（换成 agent 即红）：" + outE)
  } finally { dropSession(sidE) }

  // —— (2) escalate codex 同步路径 catch（escalate.mjs:272，layer settle）——
  const ctrlS = new AbortController()
  const sidS = "ap-esc-codex-settle-" + randomUUID()
  const depsS = {
    ctx: {},
    agent: { session: { id: sidS, header: { cwd: PLUGIN_DIR } }, options: {} },
    config: {
      consultModels: [{ runner: { kind: "codex-cli", model: "m", executable: codexExe("codex-settle-esc") } }],
      codexCli: { executable: codexExe("codex-settle-esc-g") },
    },
    state: sessionState(sidS), signal: ctrlS.signal, configDefaultEngineering: false,
    spawn: codexThrowSpawn(ctrlS), platform: "linux", env: CODEX_ENV,
  }
  try {
    const outS = await runEscalate(depsS, "task text", undefined, false, false)
    assert.ok(outS.includes("escalate (codex-cli:m) aborted. · abort(user@settle: caller interrupt)"),
      "escalate codex 同步路径的调用方信号面 = settle：" + outS)
  } finally { dropSession(sidS) }

  // —— (3) eng dsh 外层 catch 的 settle 臂（eng.mjs:831）——
  const sigE = pendingSignal()
  const sidE2 = "ap-eng-outer-settle-" + randomUUID()
  const stE2 = sessionState(sidE2)
  stE2.engineering = true
  stE2.designToken = randomUUID() + ":" + (Date.now() + 3600_000)
  const depsE2 = {
    ctx: {
      subagents: { async start() { return { result: new Promise((_, rej) => { setTimeout(() => { sigE.fire(); rej(abortErr()) }, 5) }), dispose: async () => {} } } },
      llm: { async resolveModelInfo() { return null } },
    },
    agent: { session: { id: sidE2, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
    config: {}, signal: sigE, configDefaultEngineering: false,
  }
  try {
    const outE2 = await runEngCoder(depsE2, { task: "implement x", designToken: stE2.designToken })
    assert.ok(outE2.includes("eng_coder aborted. · abort(unknown@settle: no reason on signal)"),
      "dsh 外层 catch：signal.aborted ∧ dshCtrl 未中止 ⇒ settle（换成 agent 即红）：" + outE2
      + timingState({ rejectDelayMs: 5, head: outE2.slice(0, 60) }))
  } finally { dropSession(sidE2) }

  // —— (4) escalate dsh 外层 catch 的 settle 臂（escalate.mjs:593）——
  const sigS = pendingSignal()
  const sidS2 = "ap-esc-outer-settle-" + randomUUID()
  const depsS2 = {
    ctx: { subagents: { async start() { return { result: new Promise((_, rej) => { setTimeout(() => { sigS.fire(); rej(abortErr()) }, 5) }), dispose: async () => {} } } } },
    agent: { session: { id: sidS2, header: { cwd: PLUGIN_DIR } }, options: {} },
    config: { consultModels: [{ provider: "p", model: "m" }] },
    state: sessionState(sidS2), signal: sigS, configDefaultEngineering: false,
  }
  try {
    const outS2 = await runEscalate(depsS2, "task text", undefined, false, false)
    assert.ok(outS2.includes("escalate (p:m) aborted. · abort(unknown@settle: no reason on signal)"),
      "escalate dsh 外层 catch 的 settle 臂：" + outS2
      + timingState({ rejectDelayMs: 5, head: outS2.slice(0, 60) }))
  } finally { dropSession(sidS2) }
})

test("T-AP1g (AC-AP1, 审计 #5): consult codex 面（ABORTED 信封带溯源 / 真 crash 逐字透传）", async () => {
  // (a) codex 行 + ABORTED 信封：stop 路径 → 死亡行进**消费面**（批 15 起 = digest）
  const sidA = "ap-consult-codex-aborted-" + randomUUID()
  const stateA = sessionState(sidA)
  const jA = consultJobs()
  const depsA = {
    ctx: { subagents: { start: () => { throw new Error("dsh spawn must not run for a codex row") } }, get: (svc) => (svc === "jobs" ? jA.jobs : null) },
    agent: { session: { id: sidA, header: { cwd: mkdtempSync(join(tmpdir(), "ap-consult-cwd-")) }, deriveMessages: () => [] }, options: {} },
    config: {
      consultModels: [{ runner: { kind: "codex-cli", model: "m", executable: codexExe("consult-codex-abort") } }],
      codexCli: { executable: codexExe("consult-codex-abort-g") },
    },
    state: stateA, signal: undefined, persona: undefined,
    spawn: codexHangSpawn(), platform: "linux", env: CODEX_ENV,
    dshHome: mkdtempSync(join(tmpdir(), "ap-consult-home-")),
  }
  try {
    const s = await startConsultSession(depsA, "problem", undefined)
    await waitFor(() => stateA.consultSessions.get(s.id)?.controllers?.length === 1)
    const ctrlA = stateA.consultSessions.get(s.id).controllers[0]
    assert.equal(ctrlA.signal.aborted, false, "子代理已启动且尚未中止")
    stopConsultSession(stateA, s.id, 1)
    const dA = await consultDigestOf(stateA, s.id)
    assert.match(dA, /^aborted · abort\(stop@agent: stop requested\)$/m,
      "codex 面的中止行经消费面自证来源：" + dA.split("\n").slice(-3).join(" / "))
  } finally { cleanupConsultSessions(stateA); dropSession(sidA) }

  // (b) codex 面**真 crash**：逐字透传、无 abort 后缀（AC-AP5 口径）
  const sidB = "ap-consult-codex-crash-" + randomUUID()
  const stateB = sessionState(sidB)
  const ctrlB = new AbortController()
  const jB = consultJobs()
  const depsB = {
    ctx: { subagents: { start: () => { throw new Error("dsh spawn must not run for a codex row") } }, get: (svc) => (svc === "jobs" ? jB.jobs : null) },
    agent: { session: { id: sidB, header: { cwd: mkdtempSync(join(tmpdir(), "ap-consult-cwd-")) }, deriveMessages: () => [] }, options: {} },
    config: {
      consultModels: [{ runner: { kind: "codex-cli", model: "m", executable: codexExe("consult-codex-crash") } }],
      codexCli: { executable: codexExe("consult-codex-crash-g") },
    },
    state: stateB, signal: undefined, persona: undefined,
    spawn: codexThrowSpawn(ctrlB), platform: "linux", env: CODEX_ENV,
    dshHome: mkdtempSync(join(tmpdir(), "ap-consult-home-")),
  }
  try {
    const sB = await startConsultSession(depsB, "problem", undefined)
    const dB = await consultDigestOf(stateB, sB.id)
    assert.match(dB, /consultation failed: codex-cli error: codex plumbing exploded\)$/,
      "codex 面真 crash 逐字透传：" + dB.split("\n").slice(-3).join(" / "))
    assert.ok(!dB.includes("abort("), "非中止错误不得带 abort 后缀：" + dB.split("\n").slice(-3).join(" / "))
  } finally { cleanupConsultSessions(stateB); dropSession(sidB) }
})

// ————————————— T-AP2（AC-AP2）：既有前缀逐字保留（只追加） —————————————

test("T-AP2 (AC-AP2): 四家族既有死亡文案前缀逐字保留——溯源后缀只追加、不替换", async () => {
  // advisor：前缀逐字（既有 startsWith 判定族的字面）
  const adv = await advisorLooped(construct.user())
  assert.ok(adv.startsWith("Advisor: interrupted."), adv)
  assert.equal(adv.split(" · abort(")[0], "Advisor: interrupted.", "后缀之前的部分必须逐字")

  // eng：前缀逐字（warnPrefix 为空时 = 首段）
  const eng = await engAborted("user")
  assert.ok(eng.startsWith("eng_coder aborted."), eng)
  assert.equal(eng.split(" · abort(")[0], "eng_coder aborted.")

  // escalate：前缀逐字（含 (tag)）
  const esc = await escAborted("user")
  assert.ok(esc.startsWith("escalate (p:m) aborted."), esc)
  assert.equal(esc.split(" · abort(")[0], "escalate (p:m) aborted.")

  // consult：consultation failed 包壳内的原 payload 前缀逐字（控制器无声样中止 → 221 站点行）
  const h = makeConsultDeps({})
  const { id, ctrl } = await consultStart(h)
  ctrl.abort(new Error("mystery abort"))
  const d = await consultDigestOf(h.state, id)
  const replyLine = d.split("\n").find((l) => l.startsWith("(consultation failed:")) ?? ""
  assert.ok(replyLine.startsWith("(consultation failed: child ended: aborted"), replyLine)
  assert.equal(replyLine.split(" · abort(")[0], "(consultation failed: child ended: aborted")
  assert.ok(replyLine.endsWith(")"), "结算包壳仍在尾部（只追加、未替换）")
  cleanupConsult(h)
})

// ————————————— T-AP3（AC-AP3）：墙判定绑信号状态/latch，文本嗅探已删 —————————————

/** 静默流：不产 chunk，等 abort 后抛出**无声样** AbortError（复刻适配器竞速）。 */
const silentThenAbortError = (opts) => (async function* () {
  await new Promise((r) => { if (opts.signal.aborted) r(); else opts.signal.addEventListener("abort", r, { once: true }) })
  throw abortErr()
})()

test("T-AP3 (AC-AP3): 无声样 AbortError → 超时尾；用户取消 → interrupted；返回形态同判；源码锁", async () => {
  // (a) 适配器以**不含 "deadline reached" 字样**的 AbortError 抛出 → 仍判超时尾（P2 的核心）
  const outA = await runAdvisorToolLoop({ llm: makeLlm([silentThenAbortError]) }, loopOpts({ timeoutMs: 1200 }))
  assert.ok(outA.startsWith("Advisor: review timeout after "), outA + timingState({ timeoutMs: 1200 }))
  assert.ok(!outA.includes("Advisor: interrupted."),
    "无声样 AbortError 不得被误判 interrupted" + timingState({ timeoutMs: 1200, head: outA.slice(0, 60) }))

  // (b) 用户真取消 → 逐字 "Advisor: interrupted."
  const ctrl = new AbortController()
  const llm = makeLlm([(opts) => (async function* () {
    await new Promise((r) => { if (opts.signal.aborted) r(); else opts.signal.addEventListener("abort", r, { once: true }) })
    throw abortErr()
  })()])
  const p = runAdvisorToolLoop({ llm }, loopOpts({ timeoutMs: 5000, signal: ctrl.signal }))
  await sleep(30)
  ctrl.abort({ interrupt: true })
  const outB = await p
  assert.ok(outB.startsWith("Advisor: interrupted."), outB)
  assert.ok(!outB.includes("review timeout after"), "用户取消 ≠ 超时")
  assert.ok(outB.includes("abort(user@"), "用户取消也要自证来源" + timingState({ timeoutMs: 5000, head: outB.slice(0, 60) }))

  // (c) **返回形态**（流以 resolve 而非 reject 结束，`reason.kind === "aborted"`）：
  // ⚠ 批 6 修复轮（审计 🟡 #2）：AC-AP3 的「返回形态**同判**」正臂（复合信号已中止 ∧ 用户信号
  // **未**中止 → 超时尾）**不可达**——看门狗/截止定时器一 abort，collectStream 的 stallP
  //（`Promise.race([iterator.next(), stallP])`）恒先 settle ⇒ 走抛错形态；`if (!signal?.aborted
  // && deadlineLatch.fired) return timeoutMsg()` 永不执行（已在 advisor.mjs 该行标注「防御式，
  // 当前不可达」；设计口径修正由父侧设计档承担）。故本臂**只证负臂**：用户信号变体
  // （signal.aborted ⇒ 逐字 interrupted + settle 层溯源），它证明「返回形态**确实**会进入该
  // 判定分支并按信号状态归因」——这是本臂实际能证明的东西。
  const ctrlC = new AbortController()
  const abortedFinish = () => (async function* () {
    await sleep(20)
    ctrlC.abort({ interrupt: true }) // 用户信号在**流中途**中止（流顶检查已过，才能进返回形态判定）
    yield { type: "finish", reason: { kind: "aborted" } }
  })()
  const outC = await runAdvisorToolLoop({ llm: makeLlm([abortedFinish]) },
    loopOpts({ timeoutMs: 5000, signal: ctrlC.signal }))
  assert.ok(outC.startsWith("Advisor: interrupted."), outC)
  assert.ok(outC.includes("abort(user@settle: caller interrupt)"),
    "返回形态按**信号状态**归因（settle = 宿主/调用方面）：" + outC
    + timingState({ timeoutMs: 5000, midStreamAbortAfterMs: 20, head: outC.slice(0, 60) }))

  // (d) 源码锁（AC-AP3 口径：**在循环 catch 内**零命中）：文本嗅探已删，超时判定绑 latch/结构化载荷
  const src = libFile("advisor.mjs")
  const loopStart = src.indexOf("for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt++)")
  const loopEnd = src.indexOf("const { blocks, finish } = result")
  assert.ok(loopStart > 0 && loopEnd > loopStart, "循环 catch 区段可定位")
  const loopCatchRegion = src.slice(loopStart, loopEnd)
  assert.ok(!/\/deadline reached\//.test(loopCatchRegion), "循环 catch 内的 /deadline reached/ 文本嗅探必须已删除")
  assert.ok(loopCatchRegion.includes('if (deadlineLatch.fired || e?.abortInfo?.trigger === "timeout") return timeoutMsg()'),
    "超时判定绑定 latch / 结构化载荷")
})

// ————————————— T-AP4（AC-AP4）：0.75 提示一次性、不进正文/prior —————————————

test("T-AP4a (AC-AP4): shouldBudgetNudge 纯函数三态 + 边界", () => {
  assert.equal(shouldBudgetNudge(100, 1000, false), false, "未到 75% → 不提示")
  assert.equal(shouldBudgetNudge(750, 1000, false), true, "恰 75% → 提示")
  assert.equal(shouldBudgetNudge(900, 1000, true), false, "已提示过 → 不再提示（每场至多一次）")
  assert.equal(shouldBudgetNudge(900, 0, false), false, "非法/零预算 → 不提示")
  assert.equal(shouldBudgetNudge(900, NaN, false), false, "非数值预算 → 不提示")
})

/** A29-4a（D-51 ①）：时序类腿的**失败差量**——断言失败时把 actual/expected 与关键状态摘要
 * 一并写进测试输出，使偶发红**当场可诊断**（不靠重跑撞见）。`state` 由调用点给。 */
const timingState = (state) => " · 时序状态摘要=" + JSON.stringify(state)

/** A29-4b（D-51 ②）：**可注入时钟**——只替换 `Date.now`（**不碰任何定时器**），时间只由夹具
 * **显式推进** ⇒ 真实耗时（磁盘 I/O、事件循环争用）不再进入判据，**零真实 sleep**。恢复放在
 * `finally`：本腿之外的一切行为逐字不变。 */
async function withFakeClock(base, fn) {
  const clock = { t: base }
  const savedNow = Date.now
  Date.now = () => clock.t
  try { return await fn(clock) } finally { Date.now = savedNow }
}

test("T-AP4b (AC-AP4, D-51): 同场跨阈多次检查只注入一条提示，且不进返回正文（可注入时钟：零真实等待）", async () => {
  // ★ 批 29 单② / US-2（D-51）：本腿原用**真实 `await sleep(320)`** 去撞 400ms 预算的 75% 阈值
  //   （窗口 = [300,400)，只剩约 80ms 余量）——全量并发跑时，轮内真实开销（工具执行 + 事件循环
  //   争用）一旦越过那 80ms，round 1 就**先**撞上超时分支，而「恰好一条提示」的断言随即转红
  //   （D-51 登记的偶发红）。现在时间**只由夹具显式推进**（假时钟），真实耗时不再进入判据
  //   ⇒ 该腿不再依赖真实等待/并发时序（零 sleep）。剧本：round 1 越 75%（不越 100%）⇒ 注入 →
  //   round 2 复检不重注 → round 3 越预算 ⇒ 超时尾。
  const BASE = 1_700_000_000_000
  const NUDGE = "评审预算已用 75%"
  const TOOL = (id) => ({ type: "block-end", block: { type: "tool-call", id, name: "read", arguments: JSON.stringify({ path: "package.json" }) } })
  /** 跑一场（新 llm + 新假时钟）：返回往返文本、逐轮快照里的提示计数与终态时钟读数。 */
  const runScene = async () => {
    let llm = null
    let out = null
    let clockT = 0
    await withFakeClock(BASE, async (clock) => {
      const round1 = () => (async function* () { clock.t += 320; yield TOOL("c1"); yield textFinish })()
      const round2 = () => (async function* () { yield TOOL("c2"); yield textFinish })()
      const round3 = () => (async function* () { clock.t += 100; yield TOOL("c3"); yield textFinish })()
      llm = makeLlm([round1, round2, round3])
      out = await runAdvisorToolLoop({ llm }, loopOpts({ timeoutMs: 400 }))
      clockT = clock.t
    })
    return { llm, out, clockT }
  }

  const s1 = await runScene()
  const counts1 = s1.llm.calls.map((c) => c.snapshot.filter((m) => m.includes(NUDGE)).length)
  const st1 = { clockT: s1.clockT, calls: s1.llm.calls.length, counts: counts1, head: String(s1.out).slice(0, 60) }
  assert.ok(String(s1.out).startsWith("Advisor: review timeout after "),
    "假时钟推进到 420 > 400 ⇒ 预算到点（走超时尾）：" + timingState(st1))
  assert.equal(counts1.length, 3, "三轮回合（越阈 / 复检 / 越预算）" + timingState(st1))
  assert.equal(counts1[0], 0, "第 1 轮未跨阈 → 不注入" + timingState(st1))
  assert.equal(counts1[counts1.length - 1], 1, "跨阈后（含多次检查）**恰好一条**：" + JSON.stringify(counts1) + timingState(st1))
  assert.ok(s1.llm.calls[s1.llm.calls.length - 1].snapshot.some((m) => m.includes("advisor 组 timeoutMs")),
    "提示含配置键指引" + timingState(st1))
  assert.ok(!String(s1.out).includes(NUDGE), "提示**不进**返回正文（N-5）" + timingState(st1))

  // 两场（两次独立评审）各注入一条——`alreadyNudged` 是**每场**局部量
  const s2 = await runScene()
  const counts2 = s2.llm.calls.map((c) => c.snapshot.filter((m) => m.includes(NUDGE)).length)
  const st2 = { clockT: s2.clockT, calls: s2.llm.calls.length, counts: counts2, head: String(s2.out).slice(0, 60) }
  assert.ok(String(s2.out).startsWith("Advisor: review timeout after "), "第二场同样走到超时尾" + timingState(st2))
  assert.equal(counts2[0], 0, "第二场第 1 轮同样未跨阈" + timingState(st2))
  assert.equal(counts2[counts2.length - 1], 1, "第二场同样恰好一条：" + JSON.stringify(counts2) + timingState(st2))

  // —— A29-4a 注入式负控（D-51 ①）：**断言失败 ⇒ timingState 的状态摘要真的进入输出** ——
  //   此前 timingState 只出现在**成功路径的断言消息**里，没有任何腿证明它在**失败时**也被抛出
  //   （「失败可诊断」可能只是文案承诺）。这里就地造一个**必然失败**的比较并当场捕获，证明
  //   (1) 失败以 AssertionError 抛出（不被静默吞）、(2) 消息里带状态摘要键与逐字内容、
  //   (3) actual/expected 差量同在、(4) 异常不外泄到用例之外。零真实等待（纯同步，无 sleep）。
  const injectedState = { counts: [0, 1], clockT: BASE + 420 }
  let injectedError = null
  try {
    assert.equal(0, 1, "注入式负控（预期失败）：" + timingState(injectedState))
  } catch (e) {
    injectedError = e
  }
  assert.ok(injectedError !== null, "负控的执行点必须可达（失败不得被静默吞掉）")
  assert.match(String(injectedError.name), /AssertionError/, "负控：失败以 AssertionError 抛出")
  assert.equal(injectedError.code, "ERR_ASSERTION", "负控：确是断言失败（不是其它异常）")
  const injectedMsg = String(injectedError.message)
  assert.ok(injectedMsg.includes("时序状态摘要="), "负控：失败消息含 timingState 的状态摘要键：" + injectedMsg)
  assert.ok(injectedMsg.includes('"counts":[0,1]'), "负控：状态摘要**逐字**进入失败消息：" + injectedMsg)
  assert.equal(injectedError.actual, 0, "负控：actual 差量在场")
  assert.equal(injectedError.expected, 1, "负控：expected 差量在场")
})

// ————————————— T-AP5（AC-AP5）：竞态形态（resolve 结束）仍归因 + crash 透传 —————————————

test("T-AP5a (AC-AP5): 子代理以 **resolve**（stopReason=aborted）结束 → 仍从控制器读因（非倒推错误对象）", async () => {
  const h = makeConsultDeps({ mode: "abort-resolve" })
  const { id, ctrl } = await consultStart(h)
  ctrl.abort(abortError(null, "agent", "job killed", "cancel"))
  const d = await consultDigestOf(h.state, id)
  assert.match(d, /child ended: aborted/, "原 message 前缀保留")
  assert.match(d, /abort\(cancel@agent: job killed\)/, "resolve 形态同样自证来源：" + d.split("\n").slice(-3).join(" / "))
  cleanupConsult(h)
})

test("T-AP5b (AC-AP5): crash 第五构造 → **无** abort 后缀 ∧ 原 message 逐字（四家族 + 词汇表）", async () => {
  // 词汇表面
  const crash = new Error("eng_coder error: boom")
  assert.equal(deathLine(crash), "eng_coder error: boom")
  assert.equal(abortTag(crash), null, "非中止错误不得造短标签")

  // advisor：非 abort 错误 → 既有失败文案，零后缀
  const outAdv = await runAdvisorToolLoop(
    { llm: makeLlm([() => (async function* () { throw new Error("boom") })()]) }, loopOpts())
  assert.ok(outAdv.includes("Advisor: review failed"), outAdv)
  assert.ok(!outAdv.includes(" · abort("), "crash 不得带 abort 后缀：" + outAdv)

  // eng：子代理以普通错误 reject → 原 message 逐字
  const sidE = "ap-crash-eng-" + randomUUID()
  const { deps: depsE, state: stateE } = makeEngDeps(sidE, undefined, new Error("boom"))
  const outEng = await runEngCoder(depsE, { task: "implement x", designToken: stateE.designToken })
  assert.ok(outEng.includes("eng_coder error: boom"), outEng)
  assert.ok(!outEng.includes(" · abort("), outEng)
  dropSession(sidE)

  // escalate：同上
  const sidS = "ap-crash-esc-" + randomUUID()
  const { deps: depsS } = makeEscDeps(sidS, undefined, new Error("boom"))
  const outEsc = await runEscalate(depsS, "task", undefined, false, false)
  assert.ok(outEsc.includes("escalate (p:m) error: boom"), outEsc)
  assert.ok(!outEsc.includes(" · abort("), outEsc)
  dropSession(sidS)

  // consult：crash 与「非中止的终止原因」都逐字
  const hR = makeConsultDeps({ mode: "crash" })
  const { id: idR, ctrl: ctrlR } = await consultStart(hR)
  const dR = await consultDigestOf(hR.state, idR)
  assert.match(dR, /consultation failed: boom\)$/, dR.split("\n").slice(-3).join(" / "))
  assert.ok(!dR.includes("abort("), dR.split("\n").slice(-3).join(" / "))
  ctrlR.abort()
  cleanupConsult(hR)

  const hE = makeConsultDeps({ mode: "resolve-error" })
  const { id: idE, ctrl: ctrlE } = await consultStart(hE)
  const dE = await consultDigestOf(hE.state, idE)
  assert.match(dE, /child ended: error — boom/, dE.split("\n").slice(-3).join(" / "))
  assert.ok(!dE.includes("abort("), dE.split("\n").slice(-3).join(" / "))
  ctrlE.abort()
  cleanupConsult(hE)
})

// ————————————— T-AP5c（审计 🟡 #4）：P1 的**第三个站点**——环内 `reason.kind === "error"` —————————————
// 需求档 §2 P1 点名的串 `Advisor: review failed — The operation was aborted` 正是本站点产出；
// 原设计 §5.1 的 advisor 站点清单**漏列**它（属未登记而非与设计冲突）。修法 = 接上死亡行：
// abort 形状的失败带溯源后缀；**普通 provider 错误逐字零改动**（AC-AP5 / §8.2 不得静默回落）。

test("T-AP5c (AC-AP5, 审计 #4): 环内 error 形态的中止失败带溯源；普通 provider 错误零改动", async () => {
  const errorFinish = (failure) => () => (async function* () {
    yield { type: "block-end", block: { type: "text", text: "partial body" } }
    yield { type: "finish", reason: { kind: "error", failure } }
  })()

  // (a) abort 形状（适配器把中止面成 error finish，failure.name = AbortError）→ 前缀逐字 + 溯源后缀
  const outA = await runAdvisorToolLoop(
    { llm: makeLlm([errorFinish({ name: "AbortError", message: "The operation was aborted" })]) }, loopOpts())
  assert.ok(outA.startsWith("Advisor: review failed — The operation was aborted"),
    "原 message 前缀逐字（P1 点名的那条串）：" + outA)
  assert.ok(outA.includes(" · abort(unknown@provider)"),
    "abort 形状必须自证来源（provider 面 = 适配器自产，触发源不可知 ⇒ 显式 unknown）：" + outA)

  // (b) 调用方信号已中止（宿主面）→ settle 层
  const ctrl = new AbortController()
  const errorFinishAfterAbort = () => (async function* () {
    await sleep(20)
    ctrl.abort({ interrupt: true })
    yield { type: "finish", reason: { kind: "error", failure: { message: "The operation was aborted" } } }
  })()
  const outB = await runAdvisorToolLoop({ llm: makeLlm([errorFinishAfterAbort]) },
    loopOpts({ timeoutMs: 5000, signal: ctrl.signal }))
  assert.ok(outB.startsWith("Advisor: review failed — The operation was aborted"), outB)
  assert.ok(outB.includes(" · abort(user@settle: caller interrupt)"), "调用方信号面 = settle：" + outB)

  // (c) 普通 provider 错误（非 abort 形状）→ **零改动**（无后缀、逐字）
  const outC = await runAdvisorToolLoop({ llm: makeLlm([errorFinish({ message: "boom" })]) }, loopOpts())
  assert.ok(outC.startsWith("Advisor: review failed — boom"), outC)
  assert.ok(!outC.includes(" · abort("), "真 crash / 普通错误不得带 abort 后缀：" + outC)
})

// ————————————— T-AP6（AC-AP6）：超时尾三要素 + 预算行 + 第一行前缀逐字 —————————————

test("T-AP6 (AC-AP6): 超时尾含 rounds/tool calls/review text produced + 预算值与配置键；前缀逐字", async () => {
  const textAndToolCall = () => (async function* () {
    yield { type: "block-end", block: { type: "text", text: "partial review body" } }
    yield { type: "block-end", block: { type: "tool-call", id: "c1", name: "read", arguments: JSON.stringify({ path: "package.json" }) } }
    yield textFinish
  })()
  const silent = (opts) => (async function* () {
    while (true) { await sleep(10); if (opts.signal?.aborted) return }
  })()

  const out = await runAdvisorToolLoop({ llm: makeLlm([textAndToolCall, silent]) }, loopOpts({ timeoutMs: 1200 }))
  // §12 #1：既有整段**逐字**——其后才是追加段（以「 · tool calls:」为界，左侧字符不得改动）
  const head = out.split(" · tool calls:")[0]
  assert.match(head, /^Advisor: review timeout after \d+s \(completed 1 tool rounds, 1 files read\)\. Try again with a narrower scope\.$/,
    head + timingState({ timeoutMs: 1200, tailHead: out.slice(-140) }))
  assert.ok(out.includes(" · tool calls: 1"), out)
  assert.ok(out.includes(" · review text produced: yes"), out)
  assert.ok(out.includes(" · budget: 1s（advisor 组 timeoutMs）——收窄范围重发，或上调该组 timeoutMs。"), out)

  // 未产出正文的场次 → no
  const outNo = await runAdvisorToolLoop({ llm: makeLlm([silent]) }, loopOpts({ timeoutMs: 300 }))
  assert.ok(outNo.includes("review text produced: no"), outNo + timingState({ timeoutMs: 300 }))
  assert.ok(outNo.includes("tool calls: 0"), outNo + timingState({ timeoutMs: 300, head: outNo.slice(0, 60) }))
})

// ————————————— T-AP7（AC-AP7）：裸写点灭绝 + 零新增写点 + 零定时器时长变更 —————————————

// 定时器第二实参的**完整表达式**逐字比对（批 6 修复轮审计 🔵 #7 加固）。
// 旧断言只查子串在场（`"}, deadlineMs)"` 之类）——`deadlineMs * 2` 这类改动照样过。这里把每个
// `setTimeout(` 的**第二实参表达式**按括号配平抽全（跳过字符串字面量），与下表的**字面锚**
// **逐字**比对；若机器有 git，再与 `git show HEAD:<file>` 的实测表达式交叉核验（证明字面锚不是
// 事后编的——本批不改任何定时器，故 HEAD 的表达式与本表恒等，提交前后都成立）。
const TIMER_ARGS_PRE_BATCH6 = {
  "advisor.mjs": ["windowMs", "deadlineMs", "2000", "1000 * attempt", "backstopMs"],
  "eng.mjs": ["backstopMs", "budgetCap"],
  "escalate.mjs": ["backstopMs", "budgetCap"],
  "consult.mjs": ["timeoutMs"],
}

/** 抽取源码里所有 `setTimeout(` 调用的第二实参表达式（括号配平 + 字符串字面量跳过），逐字返回。 */
function timerArgExprs(src) {
  const out = []
  const re = /setTimeout\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    const stack = ["("]
    let i = m.index + "setTimeout(".length
    let lastComma = -1
    while (i < src.length && stack.length > 0) {
      const ch = src[i]
      if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch
        i++
        while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++ }
        i++
        continue
      }
      if (ch === "(" || ch === "[" || ch === "{") stack.push(ch)
      else if (ch === ")" || ch === "]" || ch === "}") stack.pop()
      else if (ch === "," && stack.length === 1) lastComma = i
      i++
    }
    if (lastComma > 0) out.push(src.slice(lastComma + 1, i - 1).replace(/\s+/g, " ").trim())
  }
  return out
}

test("T-AP7 (AC-AP7): `grep '\\\\.abort()' lib/` 零命中 + 写点数不增 + 定时器时长/条件逐字未改", () => {
  const files = readdirSync(join(PLUGIN_DIR, "lib")).filter((f) => f.endsWith(".mjs"))
  const src = Object.fromEntries(files.map((f) => [f, libFile(f)]))

  // (a) 裸写点灭绝（无参 abort = 源头丢因）
  const bare = files.filter((f) => /\.abort\(\)/.test(src[f]))
  assert.deepEqual(bare, [], "裸 .abort() 必须零命中，实测：" + bare.join(", "))

  // (b) 零新增写点：写点计数 = 批 6 开工时实测值（只加载荷，不加写点）
  const budget = { "advisor.mjs": 4, "eng.mjs": 5, "escalate.mjs": 5, "consult.mjs": 3 }
  for (const [f, n] of Object.entries(budget)) {
    const got = (src[f].match(/\.abort\(/g) ?? []).length
    assert.equal(got, n, f + " 的 .abort( 写点数必须保持批 6 前实测值（零新增写点）")
  }

  // (c) 定时器时长/条件**逐字**未改（改时长/条件 = 改机制本体，本批禁止）
  for (const [f, expected] of Object.entries(TIMER_ARGS_PRE_BATCH6)) {
    assert.deepEqual(timerArgExprs(src[f]), expected,
      f + " 的 setTimeout 第二实参表达式必须与批 6 前**逐字**一致（`deadlineMs * 2` 这类改动必红）")
  }
  // 与 `git show HEAD:<file>` **逐字**交叉核验——证明上表就是批 6 之前的值（无 git 的机器跳过）
  let headChecked = 0
  for (const f of Object.keys(TIMER_ARGS_PRE_BATCH6)) {
    let head = null
    try {
      head = execFileSync("git", ["show", "HEAD:lib/" + f], { cwd: PLUGIN_DIR, encoding: "utf8" })
    } catch (e) {
      if (e?.code === "ENOENT") break // 无 git 的机器：跳过交叉核验（字面锚仍生效）
      // 批 13（R-4a）：git **已安装但不在仓库内** ⇒ `code = undefined`、`status = 128`（实测），
      // 上一行的 ENOENT 判据挡不住 ⇒ 无 `.git` 的副本里本用例转红。镜像锚 B 的容忍形态：
      // warn + skip。首轮即断 ⇒ headChecked 仍为 0 ⇒ 保住下方「全跑或全跳」不变式。
      //
      // ★ 批 13 修复轮（D13-19）：**`status === 128` 不足以判定「不在仓库内」**——实测同一 status
      // 下有三种 stderr，必须**同时匹配 stderr** 才容忍：
      //   ① `fatal: not a git repository …`   = 真的不在仓库内（环境问题）⇒ 容忍（本分支）
      //   ② `fatal: path '…' does not exist in 'HEAD'` = **在仓库内但该 path 在该 revision 不存在**
      //      ⇒ 真回归（例如新增的 lib 档尚未提交时，本锚失去交叉核验对象）
      //   ③ `fatal: bad object <sha>`          = **浅克隆里真实存在** ⇒ 真故障
      // ② 原本是**红的**：只看 status 会把它降级成「静默 warn」，比本条原问题更糟 ⇒ ②③ 一并
      // 落到下面的 `throw e`（「其余错误仍 throw」对它们为真）。
      if (e?.status === 128 && /not a git repository/.test(String(e?.stderr ?? ""))) {
        console.warn("[thincoder-suite] T-AP7 交叉核验跳过：不在 git 仓库内（"
          + (e?.stderr ?? e?.message ?? e) + "）")
        break
      }
      throw e
    }
    assert.deepEqual(timerArgExprs(head), TIMER_ARGS_PRE_BATCH6[f],
      f + " 的字面锚必须等于 `git show HEAD:lib/" + f + "` 的实测表达式（逐字比对）")
    headChecked++
  }
  assert.ok(headChecked === Object.keys(TIMER_ARGS_PRE_BATCH6).length || headChecked === 0,
    "交叉核验要么全跑要么全跳过，实测 " + headChecked)
})

// ————————————— T-AP8（AC-AP8）：单一词汇表（无第二套字面） —————————————

test("T-AP8 (AC-AP8): TRIGGERS/LAYERS 只在 abort-provenance.mjs 定义；四家族一律 import 该模块", () => {
  const files = readdirSync(join(PLUGIN_DIR, "lib")).filter((f) => f.endsWith(".mjs"))
  assert.deepEqual(TRIGGERS, ["user", "timeout", "cancel", "stop", "unknown"])
  assert.deepEqual(LAYERS, ["provider", "agent", "settle", "unrecorded"])

  const triggerLiteral = JSON.stringify(TRIGGERS)
  const layerLiteral = JSON.stringify(LAYERS)
  for (const f of files) {
    if (f === "abort-provenance.mjs") continue
    const s = libFile(f)
    assert.ok(!s.includes(triggerLiteral), f + " 不得复制 trigger 值表（第二套字面）")
    assert.ok(!s.includes(layerLiteral), f + " 不得复制 layer 值表（第二套字面）")
    assert.ok(!/export\s+(const|let|var)\s+(TRIGGERS|LAYERS)\b/.test(s), f + " 不得重定义词汇表")
  }
  for (const f of ["advisor.mjs", "eng.mjs", "escalate.mjs", "consult.mjs"]) {
    assert.ok(libFile(f).includes('from "./abort-provenance.mjs"'), f + " 必须从唯一词汇表 import")
  }

  // 词汇表自身：形状不匹配 → 显式 unknown（不静默猜因）
  assert.deepEqual(triggerOf(undefined), { trigger: null, detail: "no reason on signal" })
  assert.equal(triggerOf(AbortSignal.abort(new Error("x"))).trigger, "unknown")
  assert.equal(triggerOf(AbortSignal.abort({ abortInfo: { trigger: "bogus", layer: "agent" } })).trigger, "unknown")
})

// ————————————— T-AP9（AC-AP9）：既有测试零修改（**持久锚**）+ deathLine 幂等与 ≤300 边界 —————————————
//
// 批 6 修复轮审计 🔵 #8：原锚 `git diff --name-only HEAD -- test` 是**工作树卫生**——提交后
// trivially 过（什么也证明不了），之后任何未提交的 test/ 改动又会误红。改为两个**持久**锚：
//   锚 A（**历史事实**）：引入本批新增档的提交**自身**改了什么 test 文件——git 历史不可变。
//   锚 B（**工作树 vs 固定历史基线**）：既有测试档相对批 6 开工基线（固定 sha）零 diff。
// 两者都显式标注「断言的是历史还是工作树」。

const AP_TEST_ADDED = "test/death-provenance.test.mjs"
/**
 * 父侧**显式授权**的既有测试改动（本闸的唯一合法通道——基线档改动必须逐档登记在此）。
 *   ① `test/design-review-guard.test.mjs` —— D-37 / T-G9 的不可持久锚修（批 6 修复轮，审计 #8）；
 *   ② `test/codex-runner.test.mjs` —— 移植远端分叉 `7b6a845`（v0.9.3）增量时并入的看门狗预算
 *      resolver 断言（父侧任务书明言「`test/codex-runner.test.mjs` 是授权档，可加断言」）。该档在
 *      基线 `9282882` 时点**已存在**（`git ls-tree 9282882 -- test` 含之）且自基线起零 diff ⇒
 *      **必须**逐档登记，否则锚 B 必红。**本清单自身住基线之后的档**（`death-provenance.test.mjs`
 *      由批 6 `a5f9551` 引入）⇒ 扩清单不触发锚 B
 *      （**授权通道**的实际落点 = `docs/test-lifecycle.md` **§二「退役的合法路径」**——★ 批 15 修复轮同物种订正：
 *      此处原写「§一」，而 §一 是通用三层判据表、**不含授权通道内容**；旁证 =
 *      `docs/2026-09-13-test-lifecycle-consult-minutes.md:26`「授权通道存在：`AP_TEST_AUTHORIZED` 数组住在
 *      `death-provenance.test.mjs`（**基线后档 ⇒ 可改**）」）。
 *   ③ `test/config-api.test.mjs` —— **批 10（D-31）**：该档是**基线档**（`9282882` 时点在册），
 *      U3c 把「未知顶层键 → note + `ok:true` + 静默丢弃」的**旧行为逐字编码成期望值**；D-31 取
 *      **报错**（`unknownTop` → `errors` ⇒ PUT 400 ⇒ 写盘前拦下），故期望值必须**翻转**——这是
 *      T-AP9 存在的意义（不是障碍）。**裁定引用**：用户 2026-09-12 裁定 D-31 单独成批；批 10
 *      决策 **D10-11**（U3c 走 `AP_TEST_AUTHORIZED` 授权通道，先例 = 批 9 的 ②）与 **J10-6**
 *      （取报错、否决回显）；同档**另加** D10-10 白名单一致性锁（`draftToPayload` 键集 ⊆
 *      `topAllowed`，与该档既有面同族）⇒ **本授权同时覆盖这两处改动**（设计档 §11.1 评审 #2）。
 *   ④ `test/consult.test.mjs` —— **批 15（FR-1/FR-2：会诊结果的投递与消化）**：该档在基线
 *      `9282882` 时点**已存在**（`git ls-tree -r 9282882 -- test` 含之）且不在本清单内 ⇒ 任何
 *      改动必红。本批把会诊从「三工具轮询协议」改成「**平台 job 投递 + digest 单一消费面**」：
 *      `consult_check` 注册点与其 `waiters` 机制整体退役 ⇒ **该档的消费面从 `checkConsultSession`
 *      改指 `composeConsultDigest` 合成的 digest**（设计档
 *      `docs/2026-09-15-consult-delivery-design.md` §5.6 / §11.1；纪要 §2 **R-9**）。
 *      **裁定引用**：用户 2026-09-15 的四项裁定「通知并停在必须汇报的断点 / 明确目标·无人值守·
 *      明确授权时可不停 / 会诊结果默认落档可豁免 / 采纳 T-2（stop 产 digest + jobs 缺失拒发）」
 *      （需求档首部「用户裁定（已定）」+ 纪要 §3 T-1…T-3）。
 *      ★ **这不是「退役该档」**：档仍现役、锁仍活——其**存续理由**在本批被改写为「锁**平台 job 投递 +
 *      digest 单一消费面**下的跨回合存活与有界终止」（**理由内联在此，不留悬空指针**）：会话不再「发起后靠
 *      调用方回来轮询」，而是**包一个平台 job**（`dsh-tool-jobs`）并由平台 `onJobDone` 投递（忙时注入下一步 /
 *      空闲开回合）；**唯一消费面 = digest**（`composeConsultDigest` 合成的字符串；`checkConsultSession` 与
 *      `waiters` 已随本批退役）。而**理由正文的实际落点 = `docs/test-lifecycle.md` §三「逐档处置行」的
 *      `consult.test.mjs` 行**。★ 修复轮审计 **F14**：此处原写「见 `docs/test-lifecycle.md` §一」——而 §一 是
 *      **通用三层判据表、没有 consult 行** ⇒ 悬空指针（正是本批要治的 X-1 物种）；现改为**自含理由 + 指向真实落点**）；
 *      §四 退役日志保持为空（T-LC3）——**本清单是「允许改」的通道，不是退役登记**。
 *   ⑤ `test/advisor-config.test.mjs` —— **批 14：默认值锁翻转**：该档是**基线档**（`9282882`
 *      时点在册）且不在本清单内 ⇒ 任何改动必红。批 14 把 `engCoderEffort` 的默认值与回落目标
 *      改为**同源常量 `ENG_CODER_EFFORT_DEFAULT`（值 `medium`）**——T18 里两处**逐字编码旧值
 *      `"low"`** 的断言（默认值腿 + 非法值回落腿）必须随之翻转成 `"medium"`，否则新默认值
 *      一落地该档即红。**裁定引用**：批 14 设计档
 *      `docs/2026-09-15-config-surface-design.md` §5.1 / §11.1 / §11.4（FR-0 授权仪式 =
 *      本批最先做的 stage 0）+ 需求档 N-3「锁面变更必须显式声明」+ 会诊纪要 §2 **R-1**
 *      （改默认值 `medium`，枚举依据：`low` 是唯一在非退化支持集上会静默落到 `off` 的档）
 *      与 **R-8**（本行是**纯追加**，不重写整行）。
 *      ★ **这不是「退役该档」**：档仍现役、锁仍活——它锁的是**默认值与回落目标的值**，
 *      本批只把该值从 `low` 翻到 `medium`，**两条断言的形态一字未改**。
 *   ⑥ `test/advisor-config.test.mjs` · `test/codex-runner.test.mjs` —— **批 21（长任务默认走后台 ·
 *      dsh 子代理路径的三态语义）**：两档**均已在**本清单内（`advisor-config` 见 ⑤、
 *      `codex-runner` 见 ②）⇒ **本批既不扩数组、也不重写数组行**（数组行逐字未动），此处只按
 *      先例补记本次理由。改动 = 两档各新增「默认后台 / 逃生口 / 回落告警随返回可见 / 跨机制护栏」
 *      的验收腿（设计档 `docs/2026-09-17-jobs-default-design.md` **§5.1 FR-1 · §5.2 FR-2 ·
 *      §5.3 FR-3** / §10.3 **AC-1…AC-15**）；被锁行为（省略 `background` ⇒ 派后台 job ·
 *      显式 `false` ⇒ 同步 · `ctx.jobs` 缺失 ⇒ 告警随工具返回）是**对外可感行为**，属 ② 层常驻
 *      断言，不是批次脚手架。**裁定引用**：需求档
 *      `docs/2026-09-17-jobs-default-requirements.md` **N-11**（锁面显式声明：两档已在授权面内
 *      ⇒ 不扩数组，按先例在注释块追加授权理由）+ 用户对该批的三条裁定（范围 = `eng_coder` 与
 *      `escalate` 的 dsh 子代理路径 · `ctx.jobs` 缺失 ⇒ 告警 + 回落同步 · 保留
 *      `background: false` 强制同步的逃生口）。
 *      ★ **这不是「退役该档」**：两档仍现役、锁仍活；`test/session-state.test.mjs` ·
 *      `test/stages.test.mjs` · `test/preset-static.test.mjs` 等**未授权基线档本批零改动**。
 *   ⑦ `test/context-budget.test.mjs` · `test/session-state.test.mjs` —— **批 22（D-39：webServer 路由
 *      接入宿主信任栅栏）**：两档在基线 `9282882` 时点**已存在**且此前不在本清单内 ⇒ 本批**必须扩数组**
 *      （与 ⑥ 的「已在清单内、故只补记理由」形态不同——本行是**新增两项**）。改动 = 两档各有一处
 *      `makeApiHandler({}, …)` 直调夹具改为显式 `fenceCtx()`：D-39 之后 handler **无条件**先问宿主
 *      `ctx.get("connection")` 要拒绝码（取不到 ⇒ 503 fail-closed），**空 ctx 直调会全变 503** ⇒ 那两处
 *      业务断言（context-budget 的 PUT 接受/拒绝语义、session-state 的 apply/reset-session 端点）必须
 *      显式声明「本请求被放行」。**放行从此是白纸黑字，不再靠门缺席**——这正是本批的纪律：安全默认
 *      不迁就夹具。**裁定引用**：用户 2026-09-21 的三项拍板（缺服务 ⇒ 503 · 拒绝体 ⇒ JSON · 版本 ⇒
 *      `0.29.1`）· `docs/consult-minutes/2026-09-21-consult-63-minutes.md` §3 **D-1**（门放 handler 内、
 *      无条件）与 **D-3**（测试缝 = 显式 stub ctx）· 缺陷登记表 **D-39**。
 *      ★ **这不是「退役该档」**：两档仍现役、锁仍活——断言形态一字未改，只换了夹具的注入形态。
 *      ★ 与 ⑥ 末句「`test/session-state.test.mjs` …**本批零改动**」**不矛盾**：那句的「本批」= **批 21**
 *        （历史记述，其时为真）；批 22 首次授权改动该档，故在此显式登记。
 */
/** 批 24（D-41）追加 `test/truncation.test.mjs`：D-41 换的是**消息形状契约**（工具结果从
 *  user+tool-result 块改成独立 tool 角色消息），而该档的 `toolResultMsg` 夹具与 T13-boundary 的
 *  期望值**逐字编码**了旧形状 ⇒ 期望值必须翻转——这正是 T-AP9 存在的意义（不是障碍）。
 *  ★ 同批把 T13-boundary 拆成正反两条腿：a) 回退把配对 assistant 收进窗口（配对完整）；
 *  b) 全 tool 中段且配对前驱不在数组里 ⇒ 孤儿整体丢弃（新契约下的协议要求）。
 *  授权通道 = docs/test-lifecycle.md §二（本条是**修改**授权，非退役）。 */
// 批 29 / 单①（设计 §3「授权例外五档」之一）：D29-3 把 `stages[].check` 语义改为「宿主验收清单」，host 态渲染文本随之改变 ⇒ `test/stages.test.mjs:288` 的 four-part 渲染对位必须同批对齐。**同批登记在此**（不留给「被自家锁打红再临场解释」，先例：批 28 的 D28-6）。
// 批 29 / 单②（设计档 docs/dsh017-batch29-design.md §3「D-37 / T-AP9 基线锁授权例外」）：
// 本单明文授权修改的基线面里，有两条**能**走本清单（它们不是 R0 元锁档）——
//   · `test/job-persistence.test.mjs` —— US-4 🔵①②③ 的对位断言落点（A29-6）；
//   · `test/contract-baseline.test.mjs` —— US-4 🔵④⑤⑥ 的对位断言落点（A29-6）。
// 两条档都**不在**批 6 基线 `9282882`（前者批 27 新增、后者批 28 新增）⇒ 锚 B 本来就不覆盖它们；
// 此处**照本单授权面同批登记**是「白纸黑字」而非「被自家锁打红再临场解释」（先例：批 28 的 D28-6）。
// ★ 本单授权面里的另两条 —— `test/guard-e.test.mjs` 与**本档** `test/death-provenance.test.mjs` ——
//   是 `test/test-lifecycle.test.mjs` 的 **R0 元锁档**，该闸**明令禁止** R0 出现在本清单里
//   （见其 T-LC4 的「授权面不得包含 R0 元锁档」断言）⇒ 它们的授权只能落在**本单任务书明文**与
//   设计档 §7 留痕上，**不可能**也不允许登记在此（登记反而会让 T-LC4 转红）。
const AP_TEST_AUTHORIZED = ["test/design-review-guard.test.mjs", "test/codex-runner.test.mjs", "test/config-api.test.mjs", "test/consult.test.mjs", "test/advisor-config.test.mjs", "test/context-budget.test.mjs", "test/session-state.test.mjs", "test/truncation.test.mjs", "test/stages.test.mjs", "test/job-persistence.test.mjs", "test/contract-baseline.test.mjs"]
/** 批 6 开工基线 = 批 4 交付提交（固定 sha ⇒ 不随新提交漂移，锚的是**历史**）。 */
const AP_BASELINE_SHA = "9282882"

// ————————————— 锚 A 的 git 取数（批 14 / FR-3 · D14-9：两个分支各打**各的**准确话） —————————————
/** 「无 git ⇒ 锚 A 不可判定」——**ENOENT 分支**的准确话（该分支的 `addingSha` 为空是**环境**所致，
 *  不是「本批新增档尚未提交」；在无 git 的机器上后者是无意义的）。 */
const ANCHOR_A_NO_GIT_MSG = "[thincoder-suite] T-AP9 锚 A 不可判定：本机无 git（ENOENT）"
  + "——不产历史提交可比对；本锚断言的是**历史**，不是工作树"
/** 「锚 A 未激活」——只在 **git 可用但 `addingSha` 取不到**时才是**真的**（D14-9）。 */
const ANCHOR_A_NOT_ACTIVE_MSG = "[thincoder-suite] T-AP9 锚 A 未激活：本批新增档尚未提交（无历史提交可锚）"
  + "——提交后自动生效；本锚断言的是**历史**，不是工作树"

/**
 * 取「引入 `AP_TEST_ADDED` 的那个提交」的 sha（锚 A 的取数腿）。
 *
 * @returns `{ addingSha, notRepo }`
 *   - `addingSha` = 提交 sha（取不到 ⇒ `""`）；
 *   - `notRepo`   = **旗标**：`true` ⇔ **本次失败属于「git 不可用/不是仓库」**——此时
 *     「尚未提交」这句话是**假的**，调用方**不得**再打它（批 14 / FR-3 / **D14-9**）。
 *     **两个分支都置位**：ENOENT（无 git）**与** 128+「not a git repository」（git 在但不在仓库内）。
 * @post 其余错误**仍原样 `throw`**（同 status 下还有 `fatal: bad object <sha>`（浅克隆里真实存在）
 *       与 `fatal: your current branch … does not have any commits yet` 这类**真故障/未提交态**
 *       ⇒ **不得**被当成「跳过」）。
 * @param {Function} [runGit] — **测试注入缝**（缺省 = 真 `execFileSync`）。存在的理由只有一个：
 *       「**git 可用但取不到 sha**」这条路径在仓内**没有环境触发器**（本仓永远是可用且有提交的
 *       git 仓库），而 D14-9 要求为它配一条**正控**（证明那句 `else` 没被误关）。注入缝让正控腿
 *       能把**真子进程**的真实形态喂进来（含 `{ encoding: "utf8", env: {...} }` 选项的透传），
 *       而不是假造一个错误对象——后者只能验「我猜的错误形状」，前者验的是真 git 的真形状。
 *       ★ **生产路径不传第二个参数**（见 `reportAnchorA()`）⇒ 缺省即真 `execFileSync`。
 */
export function anchorAProvenance(runGit = execFileSync) {
  let addingSha = ""
  let notRepo = false
  try {
    addingSha = runGit("git", ["log", "--diff-filter=A", "--format=%H", "-1", "--", AP_TEST_ADDED],
      { cwd: PLUGIN_DIR, encoding: "utf8" }).trim()
  } catch (e) {
    // 批 13（R-4a + D13-19）：ENOENT = 无 git；`status 128 + stderr「not a git repository」`
    // = git 在但不在仓库内（实测 `code = undefined`）。其余一律 throw（见上 @post）。
    if (e?.code === "ENOENT") {
      // ★ 批 14（D14-9）：无 git 的机器 ⇒ 打**本分支自己的**准确话，并**置旗标**
      //   （此前它留空 addingSha 后落到「锚 A 未激活」分支，打出一句**无意义**的假警告）。
      notRepo = true
      console.warn(ANCHOR_A_NO_GIT_MSG)
    } else if (e?.status === 128 && /not a git repository/.test(String(e?.stderr ?? ""))) {
      notRepo = true   // ★ 批 14（D14-9）：这一支**已有**自己的准确话（下方那句），旗标只用来**抑制第二句**
      console.warn("[thincoder-suite] T-AP9 锚 A 跳过：不在 git 仓库内（"
        + (e?.stderr ?? e?.message ?? e) + "）")
    } else {
      throw e
    }
  }
  return { addingSha, notRepo }
}

/**
 * 取数 + **报告**（T-AP9 锚 A 的完整两步；`@post` 把「打哪句话」的决定集中在这一处）。
 * ★ 批 14（D14-9）：`else` 分支的抑制条件是 **`!notRepo`** ——「本批新增档尚未提交」那句
 *   **只在 git 可用但取不到 sha 时**才成立；ENOENT 与 not-a-repo 两支各自打过自己的准确话。
 * @pre  `addingSha` 取不到时，它为空串与「真取不到」无法区分 ⇒ 由 `notRepo` 旗标补足语义。
 * @post 三种形态各打**恰好一句**且各不相同；**任何**情况下都不打第二句。
 */
export function reportAnchorA(runGit = execFileSync) {
  const { addingSha, notRepo } = anchorAProvenance(runGit)
  if (addingSha !== "") return { addingSha, notRepo }
  if (!notRepo) console.warn(ANCHOR_A_NOT_ACTIVE_MSG)
  return { addingSha, notRepo }
}

test("T-AP9 (AC-AP9): 既有测试零修改（持久锚：交付提交的历史事实 + 固定基线的 diff）+ deathLine 幂等与 ≤300 边界", () => {
  // —— 锚 A：**历史事实**（提交后自动激活；未提交时如实报「未激活」，不静默假装通过）——
  //    批 14（D14-9）：取数与「打哪句话」两步都在 reportAnchorA 里（两个分支各打各的准确话）
  //    ⇒ 本用例不再自己复制那份决定逻辑（单一实现，免同族两处各自漂移）。
  const { addingSha } = reportAnchorA()
  if (addingSha !== "") {
    const changed = execFileSync("git", ["show", "--name-only", "--format=", addingSha, "--", "test"],
      { cwd: PLUGIN_DIR, encoding: "utf8" }).trim().split("\n").map((s) => s.trim()).filter(Boolean)
    const extra = changed.filter((f) => f !== AP_TEST_ADDED && !AP_TEST_AUTHORIZED.includes(f))
    assert.deepEqual(extra, [],
      "引入提交 " + addingSha.slice(0, 7) + " 不得修改既有 test 文件（实测多出：" + extra.join(", ") + "）")
  }

  // —— 锚 B：**基线时已存在的测试档，零修改**（授权例外之外）——
  // 批 6 收口修正（两次）：① 原用 `--name-only` 会把**新增**档也算「改动」⇒ 提交瞬间自红；
  // ② 只加 `--diff-filter=MD` 仍不够——本档自己**被修改过**（就是这次修正），于是它仍以 M 出现。
  // 语义的正确表述 = 「**在基线 `9282882` 时就已存在**的测试档，除授权例外外零修改」——
  // 故先取基线时点的文件清单，再与「自基线起的 M/D 集合」求交。（同一教训第二次命中：锚的谓词必须写全。）
  let baseDiff = null
  let baselineFiles = null
  try {
    baseDiff = execFileSync("git", ["diff", "--name-only", "--diff-filter=MD", AP_BASELINE_SHA, "--", "test"],
      { cwd: PLUGIN_DIR, encoding: "utf8" }).trim().split("\n").map((s) => s.trim()).filter(Boolean)
    baselineFiles = execFileSync("git", ["ls-tree", "-r", "--name-only", AP_BASELINE_SHA, "--", "test"],
      { cwd: PLUGIN_DIR, encoding: "utf8" }).trim().split("\n").map((s) => s.trim()).filter(Boolean)
  } catch (e) {
    if (e?.code === "ENOENT") baseDiff = null // 无 git 的机器：跳过该锚（其余锚仍生效）
    else { baseDiff = null; console.warn("[thincoder-suite] T-AP9 锚 B 跳过：基线 " + AP_BASELINE_SHA + " 不可解析（" + (e?.message ?? e) + "）") }
  }
  if (baseDiff !== null && baselineFiles !== null) {
    const touchedExisting = baseDiff.filter((f) => baselineFiles.includes(f) && !AP_TEST_AUTHORIZED.includes(f))
    assert.deepEqual(touchedExisting, [],
      "自批 6 基线 " + AP_BASELINE_SHA + " 起**基线时已存在**的测试档零修改（授权例外 = " + AP_TEST_AUTHORIZED.join(", ") + "）")
  }

  // deathLine：幂等（无标注输入反复调用结果不变）+ ≤300 边界 + 截断先截 detail 不砍 message
  const plain = new Error("eng_coder aborted. x")
  const l1 = deathLine(plain)
  assert.equal(l1, "eng_coder aborted. x", "无标注且非 Abort/Timeout → 原 message 零改动")
  assert.equal(deathLine(l1), l1, "幂等：对返回值再次调用结果不变")
  assert.equal(deathLine(l1, undefined, "settle"), l1)

  const long = timeoutError("M".repeat(120), "agent", "D".repeat(400))
  const line = deathLine(long)
  assert.ok(line.length <= 300, "总长 ≤300，实测 " + line.length)
  assert.ok(line.startsWith("M".repeat(120)), "整体兜底不得砍进 message 本体")
  assert.ok(line.endsWith(")"), "tag 不得被砍断中段")

  const huge = deathLine(timeoutError("M".repeat(400), "agent", "D".repeat(400)))
  assert.ok(huge.length <= 300, "message 本体超长时仍 ≤300，实测 " + huge.length)

  // 幂等（带标注）：同一错误反复合成得到同一行
  const tagged = annotateAbort(new Error("escalate (p:m) aborted."), construct.cancel(), "settle")
  assert.equal(deathLine(tagged), deathLine(tagged))
})

// ————————————— T-AP9b（批 14 / FR-3 · D14-9 / 锚 A6）：F8 两分支各打**各的**准确话 —————————————
//
// 病（批 13 审计 F8）：ENOENT（无 git）与 128+not-a-repo **都**留空 `addingSha` ⇒ 都落到
// 「锚 A 未激活：本批新增档尚未提交」那句 —— 而在**无 git 的机器**上那句话是无意义的（它根本
// 不是提交问题）。D14-9 的处置：**两个分支各打各的准确话**，那句留给「git 可用但取不到 sha」。
//
// ★ 三条腿**都走真子进程**（不假造错误对象）：`anchorAProvenance(runGit)` 的注入缝**只**用来
//   把真 git 的**真形态**喂进来——腿 1 用真 `execFileSync` + 清空 PATH（真 ENOENT）；
//   腿 2/正控用真 `execFileSync` + 真 `cwd`/真 `env`（真 128 / 真「退 0 且无输出」）。
//   代码路径只认这些真实形状（`e.code==="ENOENT"` / `e.status===128` + stderr 谓词 / 正常返回）。
//   腿 1 = 真无 git ⇒ 必须打新写的「无 git ⇒ 锚 A 不可判定」；
//   腿 2 = 真 git 在但不在仓库内 ⇒ **维持既有的准确话**，且**不叠**第二句；
//   正控 = 真 git 退 0 且**无输出**（`git show` 一个不存在于 HEAD 的路径）⇒ 合法的「取不到 sha」
//          ⇒ 那句**必须**出现（本仓永远有提交，故这条路径**无现成触发器**，只能这样构造）。
test("T-AP9b (批 14 / FR-3 / 锚 A6): ENOENT 与 not-a-repo 两分支各打各的准确话（都不得打「尚未提交」假话）；git 可用但取不到 sha 时那句必须仍在", () => {
  const M = join(PLUGIN_DIR, "test", "death-provenance.test.mjs")
  const saved = process.env.PATH
  const temps = []
  const run = (runGit) => {
    const warns = [], errs = []
    const ow = console.warn, oe = console.error
    console.warn = (...a) => warns.push(a.map(String).join(" "))
    console.error = (...a) => errs.push(a.map(String).join(" "))
    try { return { r: reportAnchorA(runGit), warns, errs } }
    finally { console.warn = ow; console.error = oe }
  }
  try {
    // —— 腿 1：无 git（真 ENOENT：清空 PATH 后真 execFileSync 起不了子进程）——
    process.env.PATH = ""
    const noGit = run()
    assert.equal(noGit.r.addingSha, "", "无 git ⇒ addingSha 取不到")
    assert.equal(noGit.r.notRepo, true, "★ ENOENT 分支必须置旗标（D14-9：两分支都置位）")
    assert.ok(noGit.warns.some((w) => w.includes("锚 A 不可判定")),
      "ENOENT 必须打**新写的准确那句**（无 git ⇒ 锚 A 不可判定）: " + JSON.stringify(noGit.warns))
    assert.ok(!noGit.warns.some((w) => w.includes("本批新增档尚未提交")),
      "★ 腿 1 不得打「本批新增档尚未提交」（在无 git 的机器上它是假话）: " + JSON.stringify(noGit.warns))

    // —— 腿 2：git 在但不在仓库内（真 128 + 真 stderr「not a git repository」）——
    process.env.PATH = saved
    const outside = mkdtempSync(join(tmpdir(), "thincoder-outside-"))
    temps.push(outside)
    const gitAt = (cwd) => (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd })
    const notRepo = run(gitAt(outside))
    assert.equal(notRepo.r.addingSha, "", "不在仓库内 ⇒ addingSha 取不到")
    assert.equal(notRepo.r.notRepo, true, "★ 128+not-a-repo 分支也必须置旗标")
    assert.ok(notRepo.warns.some((w) => w.includes("锚 A 跳过：不在 git 仓库内")),
      "128 分支维持既有的准确那句（`:980`）: " + JSON.stringify(notRepo.warns))
    assert.ok(!notRepo.warns.some((w) => w.includes("本批新增档尚未提交")),
      "★ 腿 2 也不得叠「本批新增档尚未提交」（它已先打过准确的那句）: " + JSON.stringify(notRepo.warns))
    assert.ok(!notRepo.warns.some((w) => w.includes("锚 A 不可判定")), "腿 2 不得打 ENOENT 的那句（两分支各打各的）")

    // —— 正控：**git 可用但取不到 sha**（真 git 退 0 且无输出）⇒ 那句**必须**出现 ——
    //    `git show --name-only --format= <path外的路径>` 在真仓里退出 0 且无输出——用它造
    //    「真 git、真退 0、真空结果」的合法形态（证明 `:992` 的 else 没被误关）。
    const emptyOut = (cmd, args, opts) => execFileSync(cmd, ["show", "--name-only", "--format=", "HEAD", "--", "docs/__no_such_path__"], { ...opts, cwd: PLUGIN_DIR })
    const ctl = run(emptyOut)
    assert.equal(ctl.r.addingSha, "", "正控前提：取不到 sha")
    assert.equal(ctl.r.notRepo, false, "★ 正控：git 可用 ⇒ 旗标必须为 false（D14-9 的分叉点）")
    assert.ok(ctl.warns.some((w) => w.includes("本批新增档尚未提交")),
      "★ 正控：git 可用但 `addingSha` 取不到 ⇒ 「锚 A 未激活」那句**必须**出现（证明 `:992` 没被误关）: " + JSON.stringify(ctl.warns))
    assert.ok(!ctl.warns.some((w) => w.includes("锚 A 不可判定")), "正控不得打 ENOENT 的那句")

    // —— 其余错误仍 `throw`（真故障不得被静默吞掉）——
    // ① 空仓库形态（真 git：`git init` 后无提交）⇒ 128 + 「does not have any commits yet」
    //    **不是** not-a-repo ⇒ 必须原样 throw（那是真故障/未提交态，不是「跳过」）
    const emptyRepo = mkdtempSync(join(tmpdir(), "thincoder-emptyrepo-"))
    temps.push(emptyRepo)
    execFileSync("git", ["init"], { cwd: emptyRepo, encoding: "utf8" })
    assert.throws(() => run(gitAt(emptyRepo)), /does not have any commits yet/,
      "★ 「git 可用但尚无提交」必须 throw（真故障不得被静默吞掉）")
    // ② `fatal: bad object` 同样必须 throw（浅克隆里真实存在）
    const badObject = (cmd, args, opts) => execFileSync(cmd, ["show", "--name-only", "--format=", "0".repeat(40), "--", "test"], { ...opts, cwd: PLUGIN_DIR })
    assert.throws(() => run(badObject), /bad object|unknown revision|ambiguous argument/,
      "`fatal: bad object` 类真故障必须 throw（不得命中「跳过」谓词）")

    // —— 源码形态锁：else 分支的**抑制条件**必须是 `!notRepo`（改回无条件 ⇒ 红灯）——
    const src = readFileSync(M, "utf8")
    assert.ok(src.includes("} else if (!notRepo) {"),
      "★ `:992` 的 else 必须据旗标跳过（只在 git 可用但取不到 sha 时触发）")
    const elseIdx = src.indexOf("} else if (!notRepo) {")
    assert.ok(src.slice(elseIdx, elseIdx + 400).includes("ANCHOR_A_NOT_ACTIVE_MSG"),
      "该 else 分支的内容必须仍是「锚 A 未激活」那句（D14-9：那句留给 git 可用但取不到 sha 的情形）")
  } finally {
    process.env.PATH = saved
    for (const d of temps) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
  }
})
