// silence-watchdog.test.mjs — 批 29 **单①**（US-1 / D29-2 · D29-3 · D29-6）机验腿。
//
// 覆盖（设计档 docs/dsh017-batch29-design.md §5.1）：
//   · **A29-3**：注入静默（无输出）⇒ 到 ENG_SILENCE_ABORT_MS 即**由既有取消写点** abort，
//     终止文案含「疑似挂死」+ 静默时长 + partial/菜单/取证指路；**有输出 ⇒ 续命**不误杀；
//   · **A29-1**：派发期 toolFilter 生效——执行类工具**不在**子会话可用集、非执行类（读写/检索）
//     **仍在**；**证据口径两种形态必须在断言里区分**：平台回显生效清单 = **强证**，
//     否则以派发载荷 toolFilter.deny 为**弱证**（如实标注）；
//   · **A29-2**：取不到平台工具名清单 ⇒ **如实标注「未生效」**（deny 保持逐字基线，不假装拦住）。
//
// ★ 纪律（本档自持）：
//   ① **全部用注入缝，零真实等待**——假时钟（now）+ 假 setInterval/clearInterval（手动 tick，
//      不注册任何真实定时器）⇒ 到点与续命都由测试驱动，不用 sleep；
//   ② 假 jobs 服务（0.1.7 形态：调 spec.run(handle) 并留存 hooks）+ 桩子代理（零真子进程、
//      零网络、零真实 LLM）；
//   ③ eng.mjs 侧唯一新增注入缝 = deps.silenceWatchdogOpts（{ now, setIntervalImpl,
//      clearIntervalImpl }；生产路径不传 ⇒ 缺省 Date.now + 全局 setInterval）；
//   ④ 本档是**新增测试档** ⇒ 同批登记在 test/guard-e.test.mjs 的 T-E19 existing 清单
//      （台账行 docs/test-lifecycle.md 由主代理同批登记）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { runEngCoder, resolveExecToolDeny, readEffectiveToolEcho, execDenyEvidence, collectRegisteredToolNames } from "../lib/eng.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
import {
  ENG_SILENCE_ABORT_MS, ENG_SILENCE_POLL_MS, resolveEngSilenceAbortMs,
  createSilenceWatchdog, attachRunHeartbeat, watchJobHandle, silenceMinutesLabel,
} from "../lib/silence-watchdog.mjs"

// 与既有档同款隔离：DSH_HOME 置空 ⇒ home 不可解析 ⇒ 不碰真实盘（本档只测机制，不测落盘面）
process.env.DSH_HOME = ""

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** 让作业 run() 体里的 await 链（start → 心跳接驳）跑到底——**微任务级**，不是真实等待。 */
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await null }

/** console.warn 捕获（既有档同款：fail-open 响亮标注的断言用）。 */
async function captureWarn(fn) {
  const warnings = []
  const orig = console.warn
  console.warn = (m) => { warnings.push(String(m)) }
  try { return { value: await fn(), warnings } } finally { console.warn = orig }
}

/** 最小 ctx.llm 桩（生产 LlmRuntime.resolveModelInfo 同形）——避免 effort 回落告警污染返回文本。 */
const llmStub = {
  async resolveModelInfo() {
    return { reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }], defaultEffort: "low" } }
  },
}

/**
 * 一次 dsh 后台派发的夹具（注入缝齐备）：
 *   · 假 jobs（0.1.7：带参 spec.run(handle)）· 句柄（id + append 记录）
 *   · 桩子代理的结果形态由 form 决定（reject-race / resolve-race / 永不 settle）
 *   · 假时钟 + 假 setInterval（手动 tick）· 采到的 spec 请求与子代理 run 对象
 * @param {{form?: "reject"|"resolve"|"hang", eventSurface?: boolean, echoToolNames?: string[]|null,
 *   toolsSurface?: object, abortMs?: number, backstopMs?: number, partialText?: string}} [opts]
 */
function makeFrame(opts = {}) {
  const form = opts.form ?? "reject"
  const eventSurface = opts.eventSurface !== false
  const sid = "b29-sw-" + randomUUID()
  const st = sessionState(sid)
  st.engineering = true
  st.designToken = randomUUID() + ":" + (Date.now() + 3600_000)

  const clock = { t: 0 }
  const ticks = []
  const beats = []
  const cleared = []
  const specs = []
  const requests = []
  const runs = []
  const handle = { id: "eng-dsh-sw-1", calls: [], append(text) { this.calls.push(text) } }
  let aborted = false
  let settleResult = null

  const subagents = {
    async start(_kind, req) {
      requests.push(req)
      req.signal?.addEventListener("abort", () => { aborted = true }, { once: true })
      const run = {
        result: new Promise((res, rej) => {
          settleResult = (payload) => res(payload)
          if (form === "hang") return
          req.signal?.addEventListener("abort", () => {
            if (form === "reject") {
              const e = new Error("subagent aborted by silence watchdog")
              e.name = "AbortError"
              rej(e)
            } else {
              res({ stopReason: "aborted", output: [{ type: "text", text: opts.partialText ?? "" }] })
            }
          }, { once: true })
        }),
        dispose: async () => { /* 无资源 */ },
      }
      if (eventSurface) run.onEvent = (cb) => { beats.push(cb) }
      if (opts.echoToolNames) run.toolNames = opts.echoToolNames
      runs.push(run)
      return run
    },
  }

  const deps = {
    ctx: {
      subagents,
      llm: llmStub,
      tools: opts.toolsSurface,
      get: (s) => (s === "jobs"
        ? { start(spec) { const hooks = spec.run(handle); specs.push({ spec, hooks }); return handle.id } }
        : null),
    },
    agent: { session: { id: sid, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
    config: { dshBackgroundTimeoutMs: opts.backstopMs ?? 3600000, engSilenceAbortMs: opts.abortMs ?? 60000 },
    signal: undefined,
    configDefaultEngineering: false,
    // eng.mjs 侧唯一注入缝：假时钟 + 假定时器（生产路径不传）
    silenceWatchdogOpts: {
      now: () => clock.t,
      setIntervalImpl: (fn) => { ticks.push(fn); return { unref() { /* 假定时器 */ } } },
      clearIntervalImpl: (h) => { cleared.push(h) },
    },
  }
  return {
    sid, st, deps, clock, ticks, beats, cleared, specs, requests, runs, handle,
    isAborted: () => aborted,
    settleResult: (p) => settleResult(p),
    drop: () => dropSession(sid),
  }
}

// ═══════════════ A29-3：静默到点 abort + 文案；有输出续命 ═══════════════

test("A29-3a (D29-2 / AC-2): 注入静默（无输出）⇒ 既有取消写点 abort，终止文案含「疑似挂死」+ 静默时长 + partial/菜单/取证指路；reject-race 与 resolve-race 两形态同判", async () => {
  // ① reject-race（生产形态：abort ⇒ 子代理 result 以 AbortError reject）
  {
    const f = makeFrame({ form: "reject" })
    const dispatch = await runEngCoder(f.deps, { task: "implement the silence leg", designToken: f.st.designToken, docs: [] })
    await flush()
    assert.ok(dispatch.includes("eng-dsh-sw-1"), "前置：确实走了 dsh 后台派发：" + dispatch.slice(0, 120))
    assert.equal(f.specs.length, 1, "恰一次 jobs.start")
    assert.equal(f.beats.length, 1, "看门狗已接上子代理事件面（心跳源在场）")
    assert.equal(f.ticks.length, 1, "恰注册一个轮询定时器（叶子模块），本文件零新增 setTimeout")
    assert.equal(f.isAborted(), false, "前置：尚未到点 ⇒ 未 abort")
    // D9：先送一个**真实事件**——订阅面存在 ≠ 真会发事件；未武装的看门狗不判定（零事件腿见 D9 用例）
    f.beats[0]()
    // 注入静默：推进假时钟到阈值之后，手动 tick（零真实等待）
    f.clock.t = 60000
    f.ticks[0]()
    assert.equal(f.isAborted(), true, "到点 ⇒ 由**既有取消写点** abort 子代理")
    const outcome = await f.specs[0].hooks.done
    assert.equal(outcome.status, "failed", "静默到点 ⇒ failed（与兜底同族）")
    assert.equal(outcome.detail, "silence watchdog (engSilenceAbortMs)", "detail 标明是静默看门狗（不是兜底）")
    assert.ok(outcome.output.includes("疑似挂死"), "终止文案含「疑似挂死」: " + outcome.output.slice(0, 160))
    assert.ok(outcome.output.includes("静默 1 分钟"), "终止文案含静默时长（N 分钟）: " + outcome.output.slice(0, 160))
    assert.ok(outcome.output.includes("Partial output"), "终止文案带 partial 段")
    assert.ok(outcome.output.includes("--- eng_coder 执行已停止 —— **不自动重派**，由用户裁决。---"),
      "静默终止沿用 FAILURE_OPTIONS_BLOCK 常量（不新造 wrapper）")
    assert.ok(outcome.output.includes("取证指路（D-48）"), "静默信封附取证指路句")
    assert.equal(f.cleared.length, 1, "settle 的 finally 清掉轮询定时器（不泄漏）")
    assert.equal(f.handle.calls.length, 1, "正文照常经 handle.append 进输出环（D-46 契约未破）")
    f.drop()
  }
  // ② resolve-race（子代理在到点同刻以结果返回）⇒ 同一静默分支，且**带上已产生的 partial**
  {
    const f = makeFrame({ form: "resolve", partialText: "half done\n\nTouched files: lib/a.mjs" })
    await runEngCoder(f.deps, { task: "implement the silence leg (resolve)", designToken: f.st.designToken, docs: [] })
    await flush()
    f.beats[0]() // D9：真实事件在前（未武装的看门狗不判定）
    f.clock.t = 60000
    f.ticks[0]()
    const outcome = await f.specs[0].hooks.done
    assert.equal(outcome.detail, "silence watchdog (engSilenceAbortMs)", "resolve 侧同走静默分支（不被兜底分支截胡）")
    assert.ok(outcome.output.includes("疑似挂死"), "resolve 侧文案同样含「疑似挂死」")
    assert.ok(outcome.output.includes("half done"), "已产生的 partial 进信封: " + outcome.output.slice(0, 200))
    f.drop()
  }
})

test("A29-3b (AC-2): 有输出 ⇒ 心跳续命，不误杀（累计时长越过阈值、单次静默未越）", async () => {
  const f = makeFrame({ form: "hang" })
  await runEngCoder(f.deps, { task: "implement the keep-alive leg", designToken: f.st.designToken, docs: [] })
  await flush()
  assert.equal(f.beats.length, 1, "心跳源已接上")
  // 每轮：推进 55s（< 60s 阈值）→ 子代理产出（心跳）→ tick。累计 275s ≫ 阈值，但**单次静默**从未越线。
  for (let i = 0; i < 5; i++) {
    f.clock.t += 55000
    f.beats[0]()
    f.ticks[0]()
  }
  assert.equal(f.isAborted(), false, "有输出 ⇒ 续命：不得误杀（与总预算 dshBackgroundTimeoutMs 是两层）")
  f.settleResult({ stopReason: "completed", output: [{ type: "text", text: "did the work\n\nTouched files: lib/a.mjs" }] })
  const outcome = await f.specs[0].hooks.done
  assert.equal(outcome.status, "completed", "续命到位 ⇒ 正常交付")
  assert.ok(!outcome.output.includes("疑似挂死"), "成功交付不得带静默终止文案")
  f.drop()
})

test("A29-3c (D29-6): 看门狗工厂语义——到点回调恰一次（latch）、heartbeat 重置静默计时、dispose 幂等；阈值/周期解析运行时宽容；事件面探测诚实回落", async () => {
  assert.equal(ENG_SILENCE_ABORT_MS, 300000, "缺省阈值 = 5 分钟（D29-2）")
  assert.equal(ENG_SILENCE_POLL_MS, 1000, "轮询周期 = 1s")
  assert.deepEqual(resolveEngSilenceAbortMs({}), { ms: 300000, warning: null }, "缺省不告警")
  assert.deepEqual(resolveEngSilenceAbortMs({ engSilenceAbortMs: 3000 }), { ms: 3000, warning: null }, "正有限数即生效（运行时宽容）")
  for (const bad of ["x", 0, -1, NaN, Infinity]) {
    const r = resolveEngSilenceAbortMs({ engSilenceAbortMs: bad })
    assert.equal(r.ms, ENG_SILENCE_ABORT_MS, "非法值回落缺省：" + String(bad))
    assert.ok(r.warning && r.warning.includes("engSilenceAbortMs"), "非法值返回 warning 供 caller 经 warn() 带出：" + String(bad))
  }
  assert.equal(silenceMinutesLabel(60000), "1", "文案口径：静默 N 分钟")
  assert.equal(silenceMinutesLabel(300000), "5")

  const clock = { t: 0 }
  const ticks = []
  let clearedCount = 0
  const w = createSilenceWatchdog({
    abortMs: 1000, pollMs: 100,
    now: () => clock.t,
    setIntervalImpl: (fn) => { ticks.push(fn); return { unref() { /* 假定时器 */ } } },
    clearIntervalImpl: () => { clearedCount++ },
  })
  const fired = []
  w.onSilence((info) => fired.push(info.silentMs))
  clock.t = 900; ticks[0]()
  assert.deepEqual(fired, [], "未越阈值不触发")
  w.heartbeat()
  clock.t = 1800; ticks[0]()
  assert.deepEqual(fired, [], "心跳续命：累计 1800 > 阈值，但静默只有 900 ⇒ 不触发")
  clock.t = 2901; ticks[0]()
  // 批 29 单①交付验收订正（宿主实测）：最后一次心跳发生在 t=900（:227），本次静默自 900 起算
  // ⇒ 2901 − 900 = **2001**；原写 1101 是错算（当成「自 1800 起算」）。**实现报 2001 是对的**
  // （报真实静默时长，而非阈值），本行只是把期望值对齐到该契约。
  assert.deepEqual(fired, [2001], "到点 ⇒ 回调带**静默时长**（毫秒，自最后一次心跳起算的真实值）")
  clock.t = 99000; ticks[0]()
  assert.deepEqual(fired, [2001], "到点**恰一次**（latch：不重复回调）")
  assert.deepEqual(w.state(), { disposed: false, armed: true, delivered: true, silentMs: 2001, abortMs: 1000 }, "state 如实回报（armed：缺省初始武装 = 既有语义零漂移）")
  w.dispose(); w.dispose()
  assert.equal(clearedCount, 1, "dispose 幂等（只清一次）")
  assert.equal(w.state().disposed, true)

  // 心跳接驳：取不到事件面 ⇒ attached:false（**不假装在看**——caller 据此标注未生效）
  assert.deepEqual(attachRunHeartbeat({ result: Promise.resolve() }, () => {}), { attached: false, via: null },
    "无事件面的 run ⇒ 未接上（诚实回落）")
  assert.deepEqual(attachRunHeartbeat(null, () => {}), { attached: false, via: null })
  let got = 0
  const run = { onEvent: (cb) => { run.cb = cb } }
  assert.deepEqual(attachRunHeartbeat(run, () => { got++ }), { attached: true, via: "onEvent" }, "有事件面 ⇒ 接上并回报渠道")
  run.cb()
  assert.equal(got, 1, "事件 ⇒ 心跳")

  // 句柄心跳装饰：append/updateProgress 亦是心跳源，且**读语义/写语义与原句柄一致**
  const h = { id: "j-1", calls: [], append(text) { this.calls.push(text) }, updateProgress(line) { this.calls.push(line) } }
  let beats = 0
  const wrapped = watchJobHandle(h, () => { beats++ })
  assert.notEqual(wrapped, h, "两个事件方法都在场 ⇒ 装饰件生效")
  assert.equal(wrapped.id, "j-1", "其余成员走原型链照旧读（D-46：jobOutcome 读 id/append）")
  wrapped.append("body")
  wrapped.updateProgress("progress")
  assert.deepEqual(h.calls, ["body", "progress"], "委托调用 this 仍是原句柄（行为逐字不变）")
  assert.equal(beats, 2, "append/updateProgress 各算一次心跳")
  assert.equal(watchJobHandle({ id: "j-2" }, () => {}).id, "j-2", "无事件方法 ⇒ 原样返回（零包装）")
})

// ═══════════════ A29-1 / A29-2：工具面禁执行（两态 + 证据口径） ═══════════════

/**
 * 平台注册面样本：执行类 2（`pwsh` / `bash`）+ **保留传输名 1**（`run_code`——平台注册面里
 * 确实存在，但 `restrict()` 不得命名它：一命名即抛错并打断整个派发，见 D1）+ 非执行类 5。
 * ★ `run_code` 留在样本里**正是为了证明它不被下发**（不是期望被 deny 的成员）。
 */
const SURFACE = ["read", "write", "edit", "grep", "pwsh", "bash", "run_code", "web_search"]
const BASE_DENY = ["escalate", "consult_start", "consult_stop", "eng", "eng_coder", "ask_user_question"]

test("A29-1a (AC-1, 强证): 平台回显的生效工具清单里执行类**不在**、非执行类**仍在**——证据口径标 platform-echo", async () => {
  const echo = ["read", "write", "edit", "grep", "web_search"]      // 平台侧生效清单
  const f = makeFrame({ toolsSurface: { list: () => SURFACE }, echoToolNames: echo })
  const dispatch = await runEngCoder(f.deps, { task: "implement the deny leg", designToken: f.st.designToken, docs: [] })
  await flush()
  assert.ok(dispatch.includes("eng-dsh-sw-1"), "前置：派发了后台作业")
  // 载荷侧（请求）：执行类确实被要求移除
  const payloadDeny = f.requests[0].toolFilter.deny
  // D1：**保留传输名 run_code 绝不下发**（平台 restrict() 命名它直接抛错 ⇒ 会打断整个派发）
  assert.ok(!payloadDeny.includes("run_code"), "保留名不得进 deny：" + JSON.stringify(payloadDeny))
  for (const exec of ["pwsh", "bash"]) assert.ok(payloadDeny.includes(exec), "载荷把执行类列入 deny：" + exec)
  // 强证侧：平台回显的**生效清单**
  const eff = readEffectiveToolEcho(f.runs[0])
  assert.deepEqual(eff, echo, "平台回显生效清单可读（强证来源）")
  for (const exec of ["pwsh", "bash"]) assert.ok(!eff.includes(exec), "强证：执行类不在子会话可用集内：" + exec)
  for (const keep of ["read", "write", "edit", "grep", "web_search"]) assert.ok(eff.includes(keep), "强证：非执行类仍在：" + keep)
  assert.equal(execDenyEvidence(f.runs[0]).evidence, "platform-echo", "有回显 ⇒ 证据口径 = 强证")
  assert.equal(readEffectiveToolEcho({ tools: { read: 1 } }), null,
    "普通对象（工具实现表）不算回显——不得把载荷/实现表误报成强证")
  f.drop()
})

test("A29-1b (AC-1, 弱证): 平台不回显 ⇒ 以派发时接受的 toolFilter 载荷为证并如实标注为弱证（两形态在断言里区分）", async () => {
  const f = makeFrame({ toolsSurface: { list: () => SURFACE } })
  await runEngCoder(f.deps, { task: "implement the deny leg (weak)", designToken: f.st.designToken, docs: [] })
  await flush()
  const deny = f.requests[0].toolFilter.deny
  assert.deepEqual(deny, [...BASE_DENY, "pwsh", "bash"], "弱证：载荷 = 既有基线 + 在册执行类（逐项）")
  assert.ok(!deny.includes("run_code"), "D1：保留传输名不得出现在载荷 deny 里")
  for (const keep of ["read", "write", "edit", "grep", "web_search"]) {
    assert.ok(!deny.includes(keep), "弱证：非执行类**不得**被 deny（子会话仍可用）：" + keep)
  }
  // 两形态**在断言里区分**（不得混同）：无回显 ⇒ evidence 标 dispatch-payload 且 effective 为 null
  assert.equal(execDenyEvidence(f.runs[0]).evidence, "dispatch-payload", "无回显 ⇒ 证据口径 = 弱证（如实标注）")
  assert.equal(readEffectiveToolEcho(f.runs[0]), null, "无回显 ⇒ effective 为 null（不与强证混同）")
  f.drop()
})

test("A29-2 (AC-1 / D29-1): 取不到平台工具名清单 ⇒ 如实标注「未生效」——deny 保持逐字基线（不假装拦住），且标注走裸 console.warn（不进返回文本）", async () => {
  // 单元面：注册面不可得 / 注册面里无执行类 ⇒ applied:false + reason，deny 逐字等于基线
  for (const ctx of [{}, { tools: {} }, { tools: { register() {} } }, { get: () => null }]) {
    const plan = resolveExecToolDeny(ctx)
    assert.equal(plan.applied, false, "取不到清单 ⇒ 未生效（不猜名单）")
    assert.deepEqual(plan.deny, BASE_DENY, "未生效 ⇒ deny 逐字基线（未下发任何执行类名）")
    assert.deepEqual(plan.execNames, [], "未生效 ⇒ 零执行类名")
    assert.equal(typeof plan.reason, "string", "未生效必须给出可读理由")
    assert.ok(plan.reason.length > 0)
    assert.equal(collectRegisteredToolNames(ctx), null, "读取面不可用 ⇒ null（诚实返回，不退化成硬编码名单）")
  }
  const noExec = resolveExecToolDeny({ tools: { list: () => ["read", "write", "grep"] } })
  assert.equal(noExec.applied, false, "注册面里没有执行类谓词命中 ⇒ 同样如实标未生效")
  assert.deepEqual(noExec.deny, BASE_DENY)

  // 行为面：无注册面 ⇒ 实派发的 deny 仍是逐字基线；标注是**裸 console.warn**（不在返回文本里）
  const f = makeFrame({})
  const r = await captureWarn(async () => {
    const dispatch = await runEngCoder(f.deps, { task: "implement the not-effective leg", designToken: f.st.designToken, docs: [] })
    await flush()
    return dispatch
  })
  assert.deepEqual(f.requests[0].toolFilter.deny, BASE_DENY,
    "未生效 ⇒ 派发载荷不得出现执行类名（不假装拦住）：" + JSON.stringify(f.requests[0].toolFilter.deny))
  assert.ok(r.warnings.some((w) => w.includes("工具面禁执行未生效")), "如实标注走 console.warn：" + r.warnings.join(" | "))
  assert.ok(!r.value.includes("[thincoder-suite] warning:"), "标注**不进** warnPrefix 返回文本（T12 锁：干净路径零 warning 前缀）")
  assert.ok(!r.value.includes("未生效"), "返回文本里不出现机制标注")
  f.drop()
})

// ═══════════════ D9：心跳护栏（订阅面在 ≠ 会发事件）· D1/D2：保留名与公开读取面 ═══════════════

test("D9 (AC-2 反例): 事件面**已接上**但零事件 ⇒ 不误杀——看门狗未武装、退回总预算；首个真实事件到达后才判定", async () => {
  const f = makeFrame({ form: "hang" })
  await runEngCoder(f.deps, { task: "implement the zero-event leg", designToken: f.st.designToken, docs: [] })
  await flush()
  assert.equal(f.beats.length, 1, "前置：事件面**已接上**（attached:true）")
  // 零真实事件：推进假时钟远超阈值并 tick——**不得** abort（否则会误杀一个正在正常输出的子代理）
  f.clock.t = 600000
  for (let i = 0; i < 3; i++) f.ticks[0]()
  assert.equal(f.isAborted(), false,
    "attached 但零事件 ⇒ 未武装 ⇒ 不中止（退回总预算 dshBackgroundTimeoutMs）")
  // 单元面：同一事实的工厂级对照（armed:false 在首个心跳前不判定，心跳即武装）
  const clock = { t: 0 }
  const ticks = []
  const w = createSilenceWatchdog({
    abortMs: 1000, armed: false,
    now: () => clock.t,
    setIntervalImpl: (fn) => { ticks.push(fn); return { unref() { /* 假定时器 */ } } },
    clearIntervalImpl: () => { /* noop */ },
  })
  const fired = []
  w.onSilence((info) => fired.push(info.silentMs))
  clock.t = 999999; ticks[0]()
  assert.deepEqual(fired, [], "armed:false ⇒ 首个心跳前不判定（零事件不误杀）")
  assert.equal(w.state().armed, false, "state 如实回报未武装")
  w.heartbeat()
  clock.t += 1000; ticks[0]()
  assert.deepEqual(fired, [1000], "首个真实心跳 ⇒ 武装；此后静默越阈值即到点（机制未被削弱）")
  w.dispose()
  // 派发面：首个真实事件到达 ⇒ 武装 ⇒ 静默越阈值才中止（并走既有取消写点）
  f.beats[0]()
  f.clock.t += 60000
  f.ticks[0]()
  assert.equal(f.isAborted(), true, "首个真实事件后武装 ⇒ 到点仍由既有取消写点 abort")
  f.settleResult({ stopReason: "aborted", output: [{ type: "text", text: "" }] })
  const outcome = await f.specs[0].hooks.done
  assert.equal(outcome.detail, "silence watchdog (engSilenceAbortMs)", "武装后到点分支照常（零事件腿不打折机制）")
  f.drop()
})

test("D1/D2 (AC-1): 平台保留名 run_code 不进 deny + 公开读取面 view(scope).restrictableNames 为唯一名域（取到 ⇒ applied:true 且 deny ⊆ 该集合）", async () => {
  // —— D1（单元面）：run_code 不再命中执行类谓词（一被命名，平台 restrict() 直接抛错 ⇒ 打断派发） ——
  const reserved = resolveExecToolDeny({ tools: { list: () => ["read", "pwsh", "bash", "run_code"] } })
  assert.ok(!reserved.deny.includes("run_code"), "保留名不进 deny：" + JSON.stringify(reserved.deny))
  assert.deepEqual(reserved.execNames, ["pwsh", "bash"], "执行类谓词不再命中 run_code")

  // —— D2：平台公开面优先，且只下发**与 restrictableNames 求交后**的名字 ——
  const restrictable = ["read", "write", "edit", "grep", "pwsh", "bash", "web_search"]
  const viewSurface = {
    view: () => ({
      visible: new Map(restrictable.map((n) => [n, {}])),
      knownNames: new Set([...restrictable, "run_code"]),   // 保留名只在 knownNames 里出现
      restrictableNames: new Set(restrictable),
    }),
    list: () => ["read"],                                    // 陈旧候选面：有 view 时**不得**被采用
  }
  const unit = resolveExecToolDeny({ tools: viewSurface })
  assert.equal(unit.applied, true, "取到 restrictableNames ⇒ 生效（不再恒未生效）")
  assert.equal(unit.source, "view.restrictableNames", "来源 = 平台公开读取面（restrict() 的合法名域）")
  // 订正（宿主验收）：`deny` 还含**插件自身**的基线工具名（BASE_DENY 里的 escalate/consult_* 等）——
  // 它们不是平台工具名、本就不在 restrictableNames 域内 ⇒ 子集谓词只能约束**新追加的执行类名**。
  for (const n of unit.execNames) assert.ok(restrictable.includes(n), "执行类新追加名逐名 ⊆ restrictableNames：" + n)
  for (const n of unit.deny.filter((x) => !BASE_DENY.includes(x))) assert.ok(restrictable.includes(n), "deny 新追加部分 ⊆ restrictableNames：" + n)
  assert.deepEqual(unit.deny, [...BASE_DENY, "pwsh", "bash"], "deny = 基线 + 求交后的执行类")

  const f = makeFrame({ toolsSurface: viewSurface })
  await runEngCoder(f.deps, { task: "implement the view-surface leg", designToken: f.st.designToken, docs: [] })
  await flush()
  const deny = f.requests[0].toolFilter.deny
  for (const n of deny.filter((x) => !BASE_DENY.includes(x))) assert.ok(restrictable.includes(n), "派发载荷**新追加部分** ⊆ restrictableNames：" + n)
  assert.ok(!deny.includes("run_code"), "保留名（knownNames 有 / restrictableNames 无）不得下发")
  f.drop()
})
