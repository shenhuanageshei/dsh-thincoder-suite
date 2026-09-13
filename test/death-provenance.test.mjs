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
import { readdirSync, readFileSync } from "node:fs"
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
import { startConsultSession, checkConsultSession, stopConsultSession, cleanupConsultSessions } from "../lib/consult.mjs"
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

function makeConsultDeps({ config = {}, mode = "abort-resolve" } = {}) {
  const sid = "ap-consult-" + randomUUID()
  const state = sessionState(sid)
  const seen = { req: null }
  const subagents = {
    async start(kind, req) {
      seen.req = req
      if (mode === "crash") return { result: Promise.reject(new Error("boom")), dispose: async () => {} }
      if (mode === "resolve-error") {
        return { result: Promise.resolve({ output: [], stopReason: "error", diagnostic: "boom" }), dispose: async () => {} }
      }
      // abort-reject：子代理以 **reject** 结束（AbortError）——批 6 修复轮审计 🔴 #1：只有这条路径
      // 才落到 consult.mjs 的 `catch (e)` → `session.stopped` 分支（生产站点 :250-251 的死亡行）。
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
    sid, state, seen,
    deps: {
      ctx: { subagents },
      agent: { session: { id: sid, header: { cwd: PLUGIN_DIR }, deriveMessages: () => [] }, options: {} },
      config: { consultModels: [{ provider: "p", model: "m" }], ...config },
      state, signal: undefined, persona: undefined,
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
  const rT = await checkConsultSession(hT.state, idT, undefined)
  assert.match(String(rT.reply), /timed out after 1s/, "超时信封可见")
  assert.equal(abortTag(ctrlT.signal.reason), "abort(timeout@agent)", "看门狗写点载荷 = timeout@agent")
  cleanupConsult(hT)

  // stop：consult_stop 早停 —— **经由消费面断言**（批 6 修复轮审计 🔴 #1：用例不得再手搓
  // `deathLine(...)` 绕过生产站点；本条经 consult_check 读的是生产站点真正合成的载荷）。
  // 子代理以 **reject** 结束（abort-reject）→ 落 consult.mjs `catch (e)` 的 `session.stopped` 分支。
  const hS = makeConsultDeps({ mode: "abort-reject" })
  const { id: idS, ctrl: ctrlS } = await consultStart(hS)
  const sessS = hS.state.consultSessions.get(idS)
  assert.equal(stopConsultSession(hS.state, idS, 1).abandoned, 1)
  await waitFor(() => ctrlS.signal.aborted)
  assert.equal(abortTag(ctrlS.signal.reason), "abort(stop@agent)", "stop 写点载荷")
  const rS = await checkConsultSession(hS.state, idS, undefined)
  assert.equal(String(rS.reply), "aborted · abort(stop@agent: stop requested)",
    "stop 死亡行经**消费面**（consult_check）可见：" + String(rS.reply))
  assert.equal(rS.failedReply, true, "早停行按失败面读出（不冒充成功回复）")
  assert.equal(rS.terminated, 1, "terminated 计数照旧（T-AP1d 旧断言保留）")
  cleanupConsult(hS)

  // stop（resolve 形态）：子代理以 resolve（stopReason=aborted）结束 → 同样进消费面
  const hR2 = makeConsultDeps({ mode: "abort-resolve" })
  const { id: idR2, ctrl: ctrlR2 } = await consultStart(hR2)
  stopConsultSession(hR2.state, idR2, 1)
  await waitFor(() => ctrlR2.signal.aborted)
  const rR2 = await checkConsultSession(hR2.state, idR2, undefined)
  assert.equal(String(rR2.reply), "child ended: aborted · abort(stop@agent: stop requested)",
    "resolve 形态的早停同样经消费面自证来源：" + String(rR2.reply))
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
  // `state.consultSessions.clear()` 由宿主销毁路径摘除会话，`consult_check` 之后只回
  // `unknown consult id`。故这里只断言「结算载荷确实按 cancel@settle 合成」（读会话自身的
  // 队列，非手搓等价物）。该面仍值得保留：abort 照常发生、载荷照常合成，任何未来的终态回显
  // 消费者（墓碑最小形态 A-1）直接可读；写点载荷本身也仍可观测（上一行 abortTag）。
  assert.equal(String(sessC.replies[0]?.reply ?? ""), "aborted · abort(cancel@settle: session disposed)",
    "结算载荷 = cancel@settle：" + String(sessC.replies[0]?.reply))
  dropSession(hC.sid)

  // unknown：控制器以**无声样** reason 中止（显式 unknown，不静默回落）
  const hU = makeConsultDeps({})
  const { id: idU, ctrl: ctrlU } = await consultStart(hU)
  ctrlU.abort(new Error("mystery abort"))
  const rU = await checkConsultSession(hU.state, idU, undefined)
  assert.match(String(rU.reply), /abort\(unknown@agent: mystery abort\)/, String(rU.reply))
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
  // —— eng：dsh 后台 job（eng.mjs 的 `cancel: (reason) => ctrl.abort(reason)` + 该 job 的 catch 面）——
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
      "dsh 外层 catch：signal.aborted ∧ dshCtrl 未中止 ⇒ settle（换成 agent 即红）：" + outE2)
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
      "escalate dsh 外层 catch 的 settle 臂：" + outS2)
  } finally { dropSession(sidS2) }
})

test("T-AP1g (AC-AP1, 审计 #5): consult codex 面（ABORTED 信封带溯源 / 真 crash 逐字透传）", async () => {
  // (a) codex 行 + ABORTED 信封（consult.mjs:179-180）：stop 路径 → 死亡行进**消费面**
  const sidA = "ap-consult-codex-aborted-" + randomUUID()
  const stateA = sessionState(sidA)
  const depsA = {
    ctx: { subagents: { start: () => { throw new Error("dsh spawn must not run for a codex row") } } },
    agent: { session: { id: sidA, header: { cwd: PLUGIN_DIR }, deriveMessages: () => [] }, options: {} },
    config: {
      consultModels: [{ runner: { kind: "codex-cli", model: "m", executable: codexExe("consult-codex-abort") } }],
      codexCli: { executable: codexExe("consult-codex-abort-g") },
    },
    state: stateA, signal: undefined, persona: undefined,
    spawn: codexHangSpawn(), platform: "linux", env: CODEX_ENV,
  }
  try {
    const s = await startConsultSession(depsA, "problem", undefined)
    await waitFor(() => stateA.consultSessions.get(s.id)?.controllers?.length === 1)
    const ctrlA = stateA.consultSessions.get(s.id).controllers[0]
    assert.equal(ctrlA.signal.aborted, false, "子代理已启动且尚未中止")
    stopConsultSession(stateA, s.id, 1)
    const rA = await checkConsultSession(stateA, s.id, undefined)
    assert.equal(String(rA.reply), "aborted · abort(stop@agent: stop requested)",
      "codex 面的中止行经消费面自证来源：" + String(rA.reply))
  } finally { cleanupConsultSessions(stateA); dropSession(sidA) }

  // (b) codex 面**真 crash**（consult.mjs:185）：逐字透传、无 abort 后缀（AC-AP5 口径）
  const sidB = "ap-consult-codex-crash-" + randomUUID()
  const stateB = sessionState(sidB)
  const ctrlB = new AbortController()
  const depsB = {
    ctx: { subagents: { start: () => { throw new Error("dsh spawn must not run for a codex row") } } },
    agent: { session: { id: sidB, header: { cwd: PLUGIN_DIR }, deriveMessages: () => [] }, options: {} },
    config: {
      consultModels: [{ runner: { kind: "codex-cli", model: "m", executable: codexExe("consult-codex-crash") } }],
      codexCli: { executable: codexExe("consult-codex-crash-g") },
    },
    state: stateB, signal: undefined, persona: undefined,
    spawn: codexThrowSpawn(ctrlB), platform: "linux", env: CODEX_ENV,
  }
  try {
    const sB = await startConsultSession(depsB, "problem", undefined)
    const rB = await checkConsultSession(stateB, sB.id, undefined)
    assert.match(String(rB.reply), /consultation failed: codex-cli error: codex plumbing exploded\)$/,
      "codex 面真 crash 逐字透传：" + String(rB.reply))
    assert.ok(!String(rB.reply).includes("abort("), "非中止错误不得带 abort 后缀：" + String(rB.reply))
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
  const r = await checkConsultSession(h.state, id, undefined)
  assert.ok(String(r.reply).startsWith("(consultation failed: child ended: aborted"), String(r.reply))
  assert.equal(String(r.reply).split(" · abort(")[0], "(consultation failed: child ended: aborted")
  assert.ok(String(r.reply).endsWith(")"), "结算包壳仍在尾部（只追加、未替换）")
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
  assert.ok(outA.startsWith("Advisor: review timeout after "), outA)
  assert.ok(!outA.includes("Advisor: interrupted."), "无声样 AbortError 不得被误判 interrupted")

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
  assert.ok(outB.includes("abort(user@"), "用户取消也要自证来源")

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
    "返回形态按**信号状态**归因（settle = 宿主/调用方面）：" + outC)

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

test("T-AP4b (AC-AP4): 同场跨阈多次检查只注入一条提示，且不进返回正文", async () => {
  // 第 1 轮慢（320ms > 75%×400ms=300ms）→ 第 2 轮循环顶跨阈注入；第 2 轮再产出一轮工具调用
  //（第二次跨阈检查不得再注入）；第 3 轮静默 → 预算到点超时。
  const slowToolCallThenSilent = () => (async function* () {
    await sleep(320)
    yield { type: "block-end", block: { type: "tool-call", id: "c1", name: "read", arguments: JSON.stringify({ path: "package.json" }) } }
    yield textFinish
  })()
  const toolCallThenSilent = () => (async function* () {
    yield { type: "block-end", block: { type: "tool-call", id: "c2", name: "read", arguments: JSON.stringify({ path: "package.json" }) } }
    yield textFinish
  })()
  const silent = (opts) => (async function* () {
    while (true) { await sleep(10); if (opts.signal?.aborted) return }
  })()

  const llm = makeLlm([slowToolCallThenSilent, toolCallThenSilent, silent])
  const out = await runAdvisorToolLoop({ llm }, loopOpts({ timeoutMs: 400 }))
  assert.ok(out.startsWith("Advisor: review timeout after "), out)

  const NUDGE = "评审预算已用 75%"
  const counts = llm.calls.map((c) => c.snapshot.filter((m) => m.includes(NUDGE)).length)
  assert.equal(counts[0], 0, "第 1 轮未跨阈 → 不注入")
  assert.equal(counts[counts.length - 1], 1, "跨阈后（含多次检查）**恰好一条**：" + JSON.stringify(counts))
  assert.ok(llm.calls[llm.calls.length - 1].snapshot.some((m) => m.includes("advisor 组 timeoutMs")), "提示含配置键指引")
  assert.ok(!out.includes(NUDGE), "提示**不进**返回正文（N-5）")

  // 两场（两次独立评审）各注入一条——`alreadyNudged` 是**每场**局部量
  const llm2 = makeLlm([slowToolCallThenSilent, toolCallThenSilent, silent])
  const out2 = await runAdvisorToolLoop({ llm: llm2 }, loopOpts({ timeoutMs: 400 }))
  assert.ok(out2.startsWith("Advisor: review timeout after "), out2)
  const counts2 = llm2.calls.map((c) => c.snapshot.filter((m) => m.includes(NUDGE)).length)
  assert.equal(counts2[counts2.length - 1], 1, "第二场同样恰好一条：" + JSON.stringify(counts2))
})

// ————————————— T-AP5（AC-AP5）：竞态形态（resolve 结束）仍归因 + crash 透传 —————————————

test("T-AP5a (AC-AP5): 子代理以 **resolve**（stopReason=aborted）结束 → 仍从控制器读因（非倒推错误对象）", async () => {
  const h = makeConsultDeps({ mode: "abort-resolve" })
  const { id, ctrl } = await consultStart(h)
  ctrl.abort(abortError(null, "agent", "job killed", "cancel"))
  const r = await checkConsultSession(h.state, id, undefined)
  assert.match(String(r.reply), /child ended: aborted/, "原 message 前缀保留")
  assert.match(String(r.reply), /abort\(cancel@agent: job killed\)/, "resolve 形态同样自证来源：" + String(r.reply))
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
  const rR = await checkConsultSession(hR.state, idR, undefined)
  assert.match(String(rR.reply), /consultation failed: boom\)$/, String(rR.reply))
  assert.ok(!String(rR.reply).includes("abort("), String(rR.reply))
  ctrlR.abort()
  cleanupConsult(hR)

  const hE = makeConsultDeps({ mode: "resolve-error" })
  const { id: idE, ctrl: ctrlE } = await consultStart(hE)
  const rE = await checkConsultSession(hE.state, idE, undefined)
  assert.match(String(rE.reply), /child ended: error — boom/, String(rE.reply))
  assert.ok(!String(rE.reply).includes("abort("), String(rE.reply))
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
  assert.match(head, /^Advisor: review timeout after \d+s \(completed 1 tool rounds, 1 files read\)\. Try again with a narrower scope\.$/, head)
  assert.ok(out.includes(" · tool calls: 1"), out)
  assert.ok(out.includes(" · review text produced: yes"), out)
  assert.ok(out.includes(" · budget: 1s（advisor 组 timeoutMs）——收窄范围重发，或上调该组 timeoutMs。"), out)

  // 未产出正文的场次 → no
  const outNo = await runAdvisorToolLoop({ llm: makeLlm([silent]) }, loopOpts({ timeoutMs: 300 }))
  assert.ok(outNo.includes("review text produced: no"), outNo)
  assert.ok(outNo.includes("tool calls: 0"), outNo)
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
/** 本批**父侧显式授权**的唯一既有测试改动（D-37 / T-G9 的不可持久锚修，审计 #8）。 */
const AP_TEST_AUTHORIZED = ["test/design-review-guard.test.mjs"]
/** 批 6 开工基线 = 批 4 交付提交（固定 sha ⇒ 不随新提交漂移，锚的是**历史**）。 */
const AP_BASELINE_SHA = "2e6ca8b"

test("T-AP9 (AC-AP9): 既有测试零修改（持久锚：交付提交的历史事实 + 固定基线的 diff）+ deathLine 幂等与 ≤300 边界", () => {
  // —— 锚 A：**历史事实**（提交后自动激活；未提交时如实报「未激活」，不静默假装通过）——
  let addingSha = ""
  try {
    addingSha = execFileSync("git", ["log", "--diff-filter=A", "--format=%H", "-1", "--", AP_TEST_ADDED],
      { cwd: PLUGIN_DIR, encoding: "utf8" }).trim()
  } catch (e) {
    if (e?.code !== "ENOENT") throw e
  }
  if (addingSha !== "") {
    const changed = execFileSync("git", ["show", "--name-only", "--format=", addingSha, "--", "test"],
      { cwd: PLUGIN_DIR, encoding: "utf8" }).trim().split("\n").map((s) => s.trim()).filter(Boolean)
    const extra = changed.filter((f) => f !== AP_TEST_ADDED && !AP_TEST_AUTHORIZED.includes(f))
    assert.deepEqual(extra, [],
      "引入提交 " + addingSha.slice(0, 7) + " 不得修改既有 test 文件（实测多出：" + extra.join(", ") + "）")
  } else {
    console.warn("[thincoder-suite] T-AP9 锚 A 未激活：本批新增档尚未提交（无历史提交可锚）"
      + "——提交后自动生效；本锚断言的是**历史**，不是工作树")
  }

  // —— 锚 B：**基线时已存在的测试档，零修改**（授权例外之外）——
  // 批 6 收口修正（两次）：① 原用 `--name-only` 会把**新增**档也算「改动」⇒ 提交瞬间自红；
  // ② 只加 `--diff-filter=MD` 仍不够——本档自己**被修改过**（就是这次修正），于是它仍以 M 出现。
  // 语义的正确表述 = 「**在基线 `2e6ca8b` 时就已存在**的测试档，除授权例外外零修改」——
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
