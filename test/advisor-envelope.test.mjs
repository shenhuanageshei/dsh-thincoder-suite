// advisor-envelope.test.mjs — 批 46 / FR-1·FR-2 的 **advisor 失败信封**机验档（新档）。
// 设计档：docs/2026-11-07-failure-diagnostics-design.md §五 FR-1/FR-2 · §8.1 AC-1…AC-4 · §十。
// 需求档：docs/2026-11-07-failure-diagnostics-requirements.md §2.1 / §2.2 / US-1 / US-2。
//
// 为什么单开一档（设计评审 #1 折入）：六处 `userMessage || diagnostics` 二选一里，advisor 独占三处
// （`lib/advisor.mjs` 的 :2598 jobs 结算 / :2686 超 cap 降级 / :2710 同步直跑 · 行号 as-of 批 46 收口）——它们是**三条不同
// 代码路径**，只测其中一条等于给另外两条留漂移窗口。本档逐条走到，使 AC-1 对六处**全部**具备
// 可变异锚点（AC-8）：任一处退回 `||` ⇒ 该处腿红。
//
// ★ 纪律：零网络 / 零真实子进程（`deps.spawn` 假进程）/ 零真实 LLM；`DSH_HOME` 置空 ⇒ 不碰真实盘。
// ★ 本档**不做**去重腿的站点级夹具：真实信封不存在 `userMessage === diagnostics` 的形态
//   （PROCESS_ERROR 的 userMessage 是固定人话、diagnostics 是 `exit=… | stderr: …`），故 AC-3 的
//   可变异锚点落在单点 helper `failureDetail` 上——见 `test/codex-runner.test.mjs` 的
//   「B46 FR-1: failureDetail」用例（D1 的意图就是**单点**，站点级夹具只会是假锁）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { runAdvisorReview, runAdvisorToolLoop } from "../lib/advisor.mjs"
import { dropSession } from "../lib/state.mjs"

process.env.DSH_HOME = ""

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ————————————— 假子进程（与 codex-runner 档同款契约，本档自足不跨档借夹具） —————————————
// script(args) → { events: [{stream?, data?, delay?}], exitCode?, exitDelay?, hang? }
function fakeSpawnFactory(script) {
  return (file, args) => {
    const spec = script(args) ?? { events: [], exitCode: 0 }
    const child = new EventEmitter()
    child.pid = 424242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { write() {}, end() {} }
    child.kill = () => { child.killed = true; setImmediate(() => child.emit("exit", null, "SIGKILL")) }
    ;(async () => {
      for (const ev of spec.events ?? []) {
        await sleep(ev.delay ?? 0)
        ;(child[ev.stream ?? "stdout"] ?? child.stdout).emit("data", Buffer.from(ev.data ?? ""))
      }
      if (spec.hang === true) return
      await sleep(spec.exitDelay ?? 5)
      child.emit("exit", spec.exitCode ?? 0)
    })()
    return child
  }
}

const PROBE = { events: [{ data: "codex-cli 0.150.1\n" }], exitCode: 0 }
/** 失败夹具：**人话**（PROCESS_ERROR 的固定 userMessage）+ **机械事实**（stderr 尾部）两段都非空。 */
const STDERR_TEXT = "boom: provider rejected the request"
const failingSpawn = () => fakeSpawnFactory((args) => {
  if (args.includes("--version")) return PROBE
  return { events: [{ stream: "stderr", data: STDERR_TEXT }], exitCode: 1 }
})
/** 平台假 jobs（0.1.7 契约：start(p) 调 p.run() 取 {cancel, done}，返回 branded string）。 */
function fakeJobs() {
  const specs = []
  const jobs = {
    start(p) {
      const hooks = p.run()
      const id = (p.kind ?? "job") + "-" + (specs.length + 1)
      specs.push({ payload: p, hooks, id })
      return id
    },
  }
  return { jobs, specs }
}

/** 捕获 console.warn（观测行每轮都打——本档只断言**返回文本**里那一行，避免测试输出噪音）。 */
async function captureWarn(fn) {
  const warns = []
  const orig = console.warn
  console.warn = (m) => { warns.push(String(m)) }
  try { return { value: await fn(), warns } } finally { console.warn = orig }
}

let seq = 0
function freshSid(tag) { seq += 1; return "b46-" + tag + "-" + seq }
function agentOf(sid) {
  return { session: { id: sid, header: { cwd: PLUGIN_DIR }, deriveMessages: () => [] }, options: {} }
}
/** deps：llm 一旦被调用即判失败（codex 路径不得触碰 llm）；spawn 为假进程。 */
function codexDeps(spawn, extra = {}) {
  return {
    llm: { stream: () => { throw new Error("codex 路径不得调用 llm.stream") } },
    spawn, platform: "linux", env: {},
    ...extra,
  }
}
/** codex-cli 行配置：round1 走 codex（timeoutMs 决定落哪条代码路径）。 */
function codexConfig(timeoutMs) {
  return {
    advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs } },
    codexCli: { executable: process.execPath },
  }
}

/** 一次评审（code 型，scope = package.json）——三个信封站点共用的驱动器。
 * ★ `signal` 必须走 **opts**（`runAdvisorReview` 从 opts 解构它；deps.signal 不被读取）。 */
async function runReview(sid, config, deps, signal) {
  return runAdvisorReview(deps, {
    agent: agentOf(sid),
    config,
    reviewType: "code",
    paths: ["package.json"],
    documents: [],
    signal,
    configDefaultEngineering: false,
  })
}

// 失败信封的**两段断言**（AC-1）：人话在 + 机械事实在。两条分别断言，任一段被吞都指名到腿。
const USER_MSG = "codex 进程失败（非零退出且无有效输出）"
function assertDoubleDisplay(text, where) {
  assert.ok(String(text).includes(USER_MSG), where + "：人话段缺失（" + USER_MSG + "）——实得: " + String(text).slice(0, 320))
  assert.ok(String(text).includes("stderr: " + STDERR_TEXT), where + "：机械事实段（stderr 尾部）缺失——实得: " + String(text).slice(0, 320))
  assert.ok(String(text).includes(USER_MSG + " · exit=1 | stderr: " + STDERR_TEXT),
    where + "：两段必须以 ' · ' 连接、且 diagnostics 原样可见（双显示形态）——实得: " + String(text).slice(0, 320))
}

// ═════════ AC-1 逐处：advisor 三处失败信封（:2598 jobs / :2686 超 cap 降级 / :2710 同步） ═════════

test("B46 AC-1 ①(:2710 同步直跑): codex PROCESS_ERROR ⇒ 失败正文同时含 userMessage 与 diagnostics", async () => {
  const sid = freshSid("sync")
  try {
    const out = await captureWarn(() => runReview(sid, codexConfig(300000), codexDeps(failingSpawn())))
    assert.ok(out.value.includes("Advisor: review failed (codex-cli PROCESS_ERROR)"), "失败前缀保持既有形态: " + out.value.slice(0, 200))
    assertDoubleDisplay(out.value, ":2710 同步直跑")
  } finally { dropSession(sid) }
})

test("B46 AC-1 ②(:2686 超 cap 且 jobs 缺失 → 同步降级): 同一信封同样双显示", async () => {
  const sid = freshSid("degrade")
  try {
    // timeoutMs 900000 > codexCli.budgetCapMs(540000) 且 deps 无 ctx.jobs ⇒ 降级同步路径
    // （该路径的「已截断」提示只在**成功**分支追加，故这里用 console.warn 留档确证落到哪条路）
    const out = await captureWarn(() => runReview(sid, codexConfig(900000), codexDeps(failingSpawn())))
    assert.ok(out.warns.some((w) => w.includes("ctx.jobs 不可用") && w.includes("codex 评审预算")),
      "确证走的是超 cap 降级同步路径: " + JSON.stringify(out.warns.slice(0, 4)))
    assertDoubleDisplay(out.value, ":2686 超 cap 降级")
  } finally { dropSession(sid) }
})

test("B46 AC-1 ③(:2598 jobs 结算): 后台 job 的 outcome.output 同样双显示", async () => {
  const sid = freshSid("jobs")
  try {
    const { jobs, specs } = fakeJobs()
    const handle = await captureWarn(() => runReview(sid, codexConfig(900000), codexDeps(failingSpawn(), { ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } })))
    assert.ok(String(handle.value).includes("started as background job"), "确证走的是 jobs 派发路径: " + String(handle.value).slice(0, 200))
    assert.equal(specs.length, 1, "恰一个 advisor-codex job")
    const outcome = await specs[0].hooks.done
    assert.equal(outcome.status, "failed")
    assertDoubleDisplay(outcome.output, ":2598 jobs 结算")
    assert.ok(outcome.output.includes("review failed"), "失败 detail 语义不变: " + String(outcome.detail))
  } finally { dropSession(sid) }
})

// ═════════ AC-2 空壳两向：只余一侧时不得出现 undefined / 前导或尾随分隔符 ═════════

test("B46 AC-2 空壳①: diagnostics 为空（codex ABORTED）⇒ 失败正文只剩人话，无 'undefined'、无尾随 ' · '", async () => {
  const sid = freshSid("aborted")
  try {
    const ctrl = new AbortController()
    ctrl.abort()
    // proxyMode=none ⇒ codex-adapter 不追加代理三态 ⇒ diagnostics 保持空串（空壳形态②的构造条件）
    const config = { ...codexConfig(300000), codexCli: { executable: process.execPath, proxyMode: "none" } }
    const out = await captureWarn(() => runReview(sid, config, codexDeps(failingSpawn()), ctrl.signal))
    const text = String(out.value)
    assert.ok(/Advisor: review failed \(codex-cli ABORTED\) — 已取消/.test(text), "只剩人话段（无 diagnostics 时不留分隔符）: " + text.slice(0, 240))
    assert.ok(!text.includes("undefined"), "不得出现 undefined: " + text.slice(0, 240))
    assert.ok(!text.includes("已取消 ·"), "不得留尾随分隔符: " + text.slice(0, 240))
  } finally { dropSession(sid) }
})

test("B46 AC-2 空壳②: userMessage 为空（app-server 行）⇒ 只剩机械事实，无前导 ' · '", async () => {
  const sid = freshSid("appfail")
  try {
    const deps = {
      llm: { stream: () => { throw new Error("app-server 行不得调用 llm.stream") } },
      spawn: () => { throw new Error("app-server 行不得 spawn 本地 codex") },
      platform: "linux", env: {},
      ctx: {
        subagents: {
          async start() {
            return { result: Promise.resolve({ output: [], stopReason: "max-tokens" }), dispose: async () => {} }
          },
        },
      },
    }
    const config = { advisor: { round1: { runner: { kind: "codex-app-server" }, timeoutMs: 300000 } } }
    const out = await captureWarn(() => runReview(sid, config, deps))
    const text = String(out.value)
    const head = text.slice(0, text.indexOf("\n") < 0 ? text.length : text.indexOf("\n"))
    const after = head.split(" — ").slice(1).join(" — ")
    assert.ok(after.length > 0, "人话段为空时必须由机械事实补位（不得剩一个空壳）: " + head)
    assert.ok(!after.startsWith("·"), "不得出现前导分隔符: " + head)
    assert.ok(!text.includes("—  · "), "不得出现 ' —  · ' 空壳: " + head)
  } finally { dropSession(sid) }
})

// ═════════ AC-4 观测行与失败正文的 code/status/requestId（dsh 直连面；FR-2） ═════════

/** 直连 llm 失败流：finish.reason = { kind: "error", failure }（advisor 的 LLM 直连面只有这里）。 */
function failingLlm(failure) {
  return {
    stream() {
      return (async function* () {
        yield { type: "finish", reason: { kind: "error", failure } }
      })()
    },
  }
}
const loopOptsOf = () => ({
  provider: "p", model: "m", system: "sys", firstUserText: "review scope",
  cwd: PLUGIN_DIR, signal: undefined, sessionId: "b46-ac4", timeoutMs: 5000,
})

test("B46 AC-4 ①: 三键齐备 ⇒ 观测行逐项出现且失败正文带括号段（status 渲染成 HTTP n）", async () => {
  const failure = {
    message: "DeepSeek Messages request failed (400)",
    code: "INVALID_REQUEST",
    status: 400,
    requestId: "req-abc123",
  }
  const out = await captureWarn(() => runAdvisorToolLoop({ llm: failingLlm(failure) }, loopOptsOf()))
  const text = String(out.value)
  assert.ok(text.includes("code=INVALID_REQUEST"), "观测行 code 键: " + text.slice(0, 400))
  assert.ok(text.includes("status=400"), "观测行 status 键: " + text.slice(0, 400))
  assert.ok(text.includes("requestId=req-abc123"), "观测行 requestId 键: " + text.slice(0, 400))
  assert.ok(
    text.includes("Advisor: review failed — DeepSeek Messages request failed (400) (INVALID_REQUEST · HTTP 400 · requestId=req-abc123)"),
    "失败正文括号段（不读日志也能判读）: " + text.slice(0, 400),
  )
})

test("B46 AC-4 ②: 字段缺失 ⇒ **不输出该键**（无 code=/status=/requestId=，正文无括号段、无 undefined）", async () => {
  const out = await captureWarn(() => runAdvisorToolLoop({ llm: failingLlm({ message: "boom" }) }, loopOptsOf()))
  const text = String(out.value)
  for (const key of ["code=", "status=", "requestId="]) {
    assert.ok(!text.includes(key), "缺字段不得输出 " + key + ": " + text.slice(0, 400))
  }
  assert.ok(!text.includes("undefined"), "不得出现 undefined: " + text.slice(0, 400))
  assert.ok(text.includes("Advisor: review failed — boom\n"), "无机械事实 ⇒ 正文不带括号段（整段不追加）: " + JSON.stringify(text.slice(0, 200)))
})

test("B46 AC-4 ③: requestId 截断 64 字符（NA-3）；status 非有限数 ⇒ 不输出该键（§九）", async () => {
  const longId = "r".repeat(120)
  const out = await captureWarn(() => runAdvisorToolLoop(
    { llm: failingLlm({ message: "x", requestId: longId, status: Number.NaN, code: "" }) },
    loopOptsOf(),
  ))
  const text = String(out.value)
  assert.ok(text.includes("requestId=" + "r".repeat(64)), "requestId 截断到 64 字符")
  assert.ok(text.includes("requestId=" + "r".repeat(64) + " "), "截断后不得再有多余字符（64 位整）: " + text.slice(-200))
  assert.ok(!text.includes("r".repeat(65)), "不得输出 65 位以上")
  assert.ok(!text.includes("status="), "NaN status 不输出该键: " + text.slice(0, 300))
  assert.ok(!text.includes("code="), "空 code 不输出该键: " + text.slice(0, 300))
})

// sessionState 条目由 runAdvisorReview 内部建；本档所有 codex/app-server 用例都在 finally 里 dropSession。
