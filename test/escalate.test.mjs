// escalate.test.mjs — 飞刀（escalate）的 dsh 子代理路径机验档。
//
// 本档由 **批 42（看门狗硬结算 · docs/2026-10-22-forced-settle-design.md）** 新建：§十 的
// `test/escalate.test.mjs` 行点名它承担 **AC-10**（escalate 后台的假子代理永不 settle ⇒
// 在 `backstopMs + graceMs` 内以 failed 结算，文案含「未响应 abort」），并同批覆盖
// 同步腿（同一模板的第二个等待点）与「正常路径零变化」（AC-2 的 escalate 面）。
//
// ★ 纪律：
//   ① **零真实等待**——宽限计时器走 `deps.forcedSettleOpts` 注入的**假定时器**（手动点火）；
//      既有兜底 / 内部截止两条 `setTimeout`（引擎侧 T-AP7 冻结的字面）由本档**捕获后手动点火**；
//   ② **零真子进程 / 零网络 / 零真实 LLM**——子代理是桩对象，jobs 是假服务；
//   ③ 隔离：`DSH_HOME` 置空 ⇒ 会话状态不落真实盘（失败路径本就不写盘）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { runEscalate } from "../lib/escalate.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"

process.env.DSH_HOME = ""

/** 假 jobs 服务（平台契约：`start(spec)` 调 `spec.run()` 取 `{cancel, done}` 并返回 branded string）。 */
function fakeJobs() {
  const specs = []
  return {
    specs,
    jobs: {
      start(spec) {
        const hooks = spec.run()
        const id = (spec.kind ?? "job") + "-" + (specs.length + 1)
        specs.push({ spec, hooks, id })
        return id
      },
    },
  }
}

/** 假宽限计时器（注入 `deps.forcedSettleOpts`）：不注册真实定时器，到点由测试点火。 */
function makeGraceTimer() {
  const pending = new Map()
  const created = []
  const cleared = []
  const msSeen = []
  let nextId = 0
  return {
    opts: {
      setTimeout: (fn, ms) => {
        nextId += 1
        msSeen.push(ms)
        const hd = { id: nextId, unrefCalls: 0, unref() { this.unrefCalls += 1 } }
        pending.set(hd, fn)
        created.push(hd)
        return hd
      },
      clearTimeout: (hd) => { cleared.push(hd); pending.delete(hd) },
    },
    created,
    cleared,
    msSeen,
    pendingCount: () => pending.size,
    fire() {
      const fns = [...pending.values()]
      pending.clear()
      for (const fn of fns) fn()
    },
  }
}

/** 捕获此后注册的**真实** `setTimeout`（保留回调 + 句柄）——手动点火引擎侧的既有截止定时器。 */
function captureOneTimer(delay) {
  const captured = []
  const orig = globalThis.setTimeout
  globalThis.setTimeout = function (fn, ms, ...rest) {
    const hd = orig(fn, ms, ...rest)
    if (ms === delay) captured.push({ fn, hd })
    return hd
  }
  return { hits: () => captured.slice(), restore: () => { globalThis.setTimeout = orig } }
}

/**
 * 有上界的等待（批 42 修复轮 · 审计 D）：把「等实现落账」变成**有界**的等待 ——
 * 等待点若退化回裸 `await`（race 被去掉），本函数在 `ms` 后**抛错** ⇒ 该腿变红；
 * 没有它时整档会**挂死**（`node --test` 单文件挂死 = 同档其余腿全部连坐，且拿不到失败项名）。
 * 到期定时器 `unref()` 且结算后清理（不吊住进程）。
 * @param {Promise<unknown>} p 被测等待
 * @param {number} ms 上界
 * @param {string} label 失败文案前缀
 */
function withDeadline(p, ms, label) {
  let timer = null
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + "：超过 " + ms + "ms 仍未落账 —— "
      + "等待点很可能退化回裸 await（本应是 race + 强制结算）")), ms)
    timer.unref?.()
  })
  return Promise.race([p, guard]).finally(() => { if (timer !== null) clearTimeout(timer) })
}

/** 条件驱动微任务泵（与 test/silence-watchdog.test.mjs 同款口径：就绪即停，零真实等待）。 */
async function flush(ready, label) {
  for (let i = 0; i <= 64; i++) {
    if (ready()) return
    await null
  }
  assert.fail("微任务泵未到达就绪条件【" + label + "】")
}

/** console.warn 捕获（避免成功路径的落盘告警成为测试输出噪音）。 */
async function captureWarn(fn) {
  const warnings = []
  const orig = console.warn
  console.warn = (m) => { warnings.push(String(m)) }
  try { return { value: await fn(), warnings } } finally { console.warn = orig }
}

/** deps 夹具（`delegationDepth: 0` ⇒ 顶层；`state` 走真实内存态）。 */
function makeDeps({ subagents, config, jobs }) {
  const sid = "esc42-" + randomUUID()
  return {
    sid,
    deps: {
      ctx: {
        subagents,
        get: (s) => (s === "jobs" ? jobs : null),
      },
      agent: { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } },
      config,
      state: sessionState(sid),
      signal: undefined,
    },
  }
}

test("A42-ESC-1 (AC-10 / AC-6): escalate 后台——假子代理永不 settle ⇒ 兜底到点 + 宽限到期仍以 failed 结算，文案含「未响应 abort」", async () => {
  const BACKSTOP = 4411 // 可辨识的兜底延迟（不真的等它）
  const { jobs, specs } = fakeJobs()
  const aborts = []
  let requests = 0
  const subagents = {
    async start(_kind, req) {
      requests += 1
      req.signal?.addEventListener("abort", () => { aborts.push(Date.now()) }, { once: true })
      return {
        // 「永不 settle」的忠实夹具：连 abort 也不响应
        result: new Promise(() => { }),
        dispose: async () => { },
      }
    },
  }
  const { sid, deps } = makeDeps({
    subagents, jobs,
    config: { consultModels: [{ provider: "p", model: "m" }], dshBackgroundTimeoutMs: BACKSTOP },
  })
  const grace = makeGraceTimer()
  deps.forcedSettleOpts = grace.opts
  const cap = captureOneTimer(BACKSTOP)
  try {
    let dispatch = ""
    await captureWarn(async () => {
      dispatch = String(await runEscalate(deps, "long background task", undefined, false, true))
    })
    assert.ok(dispatch.includes("escalate-dsh-1") && dispatch.includes("job_output"),
      "前置：确实派了后台 job（返回句柄 + 接续指针）：" + dispatch.slice(0, 160))
    await flush(() => requests === 1, "A42-ESC-1：ctx.subagents.start（子代理已派发 ⇒ abort 监听已挂）")
    assert.equal(grace.created.length, 0, "前置：兜底未到点 ⇒ 宽限计时器尚未武装（正常路径零资源成本）")
    const t = cap.hits()[0]
    assert.ok(t, "前置：既有兜底 setTimeout 已注册（delay == dshBackgroundTimeoutMs）")
    clearTimeout(t.hd) // 真实兜底定时器不再自己跑（手动点火 ⇒ 零真实等待）
    t.fn()             // 兜底到点：先武装、再发中止
    assert.equal(aborts.length, 1, "前置：兜底经**既有中止写点** abort 了子代理（零新增写点）")
    assert.equal(grace.created.length, 1,
      "★ AC-10 前置：宽限计时器在**既有兜底回调**里武装（删掉 armAfterAbort ⇒ 本行必红）")
    assert.deepEqual(grace.msSeen, [60000], "生产路径宽限缺省 = 60000（D1：用户不可配）")
    // ★ 审计 C：武装后假定时器里**真的挂着一个宽限回调**（pending 非空）——「结算后不再新增」的前置。
    assert.equal(grace.pendingCount(), 1, "★ 前置：武装后宽限回调真的注册在假定时器里（pending 非空）")
    grace.fire()       // 宽限到期 ⇒ 强制结算（子代理永不作答，本段仍必须落账）
    const outcome = await specs[0].hooks.done
    assert.equal(outcome.status, "failed", "★ AC-10：以 failed 结算（不伪造成 completed）")
    assert.equal(outcome.detail, "dshBackgroundTimeoutMs backstop", "detail 逐字不变（既有兜底机器标签）")
    assert.ok(outcome.output.includes("未响应 abort"),
      "★ AC-6：文案含「未响应 abort」：" + outcome.output.slice(0, 260))
    assert.equal(outcome.output.includes("已终止"), false, "★ AC-6 反向：不得声称已终止")
    assert.equal(outcome.output.includes("被终止"), false,
      "★ AC-6 反向（审计 F1 的绕过形态）：也不得写「被终止」")
    assert.ok(outcome.output.includes("job 永悬防护"), "既有兜底文案逐字保留（只追加来源说明）")
    // ★ 审计 C（恒真断言拆除）：原 `pendingCount() === 0` 恒真（假 fire() 自己 pending.clear()，
    //   与实现无关）。改成观察真实事实：**结算后不再新增宽限计时器**（多武装一次 ⇒ created 变 2）。
    assert.equal(grace.created.length, 1, "★ AC-12（escalate 面）：结算后**不再新增**宽限计时器")
  } finally {
    cap.restore()
    dropSession(sid)
  }
})

test("A42-ESC-2 (AC-10 同步腿 / AC-6): escalate 同步（显式 background=false）——内部截止到点 + 宽限到期 ⇒ 在预算+宽限内以失败结算，文案含「未响应 abort」", async () => {
  const CAP = 4412 // 可辨识的内部截止（不真的等它）
  const { jobs, specs } = fakeJobs()
  let requests = 0
  const subagents = {
    async start() {
      requests += 1
      return { result: new Promise(() => { }), dispose: async () => { } } // 永不 settle
    },
  }
  const { sid, deps } = makeDeps({
    subagents, jobs,
    config: { consultModels: [{ provider: "p", model: "m" }], codexCli: { budgetCapMs: CAP } },
  })
  const grace = makeGraceTimer()
  deps.forcedSettleOpts = grace.opts
  const cap = captureOneTimer(CAP)
  try {
    let out = ""
    await captureWarn(async () => {
      const pendingOut = runEscalate(deps, "long sync task", undefined, false, false)
      // 就绪信号 = 内部截止 setTimeout 已注册 + 子代理已派发（⇒ 等待点已挂上）
      await flush(() => cap.hits().length === 1 && requests === 1,
        "A42-ESC-2：同步路径的内部截止 setTimeout + ctx.subagents.start")
      const t = cap.hits()[0]
      clearTimeout(t.hd)
      t.fn() // 内部截止到点：先武装、再发中止
      assert.equal(grace.created.length, 1, "★ 宽限在**同步截止回调**里武装（删掉 armAfterAbort ⇒ 本行必红）")
      assert.equal(grace.pendingCount(), 1, "★ 前置：武装后宽限回调真的注册在假定时器里（pending 非空）")
      grace.fire()
      // ★ 审计 D（有上界）：等待**必须有界** —— 等待点若退化回裸 await，本行在 1500ms 后抛错变红，
      //   而不是让整档挂死（挂死 = 同档其余腿全部连坐，且拿不到失败项名）。
      out = String(await withDeadline(pendingOut, 1500, "A42-ESC-2 escalate 同步强制结算"))
    })
    assert.ok(out.includes("未响应 abort"),
      "★ AC-6：同步路径的强制结算文案含「未响应 abort」：" + out.slice(0, 260))
    assert.ok(out.includes("超内部截止"),
      "保留「超内部截止」这句归因（审计 F1：强制分支的措辞改了——不再声称「被终止」；归因词照旧）")
    assert.ok(out.includes("Partial output:"), "partial 段保留（信封形状不变）")
    assert.equal(out.includes("已终止"), false, "★ AC-6 反向：不得声称已终止")
    // ★ AC-6 反向（审计 F1）：同步强制分支**曾**写「超限任务被终止」——词表扩到「被终止」后，
    //   这条断言在修复前**必红**（它就是 F1 的可执行形态）。
    assert.equal(out.includes("被终止"), false, "★ AC-6 反向：也不得写「被终止」（无法终止就不许说）")
    // ★ 审计 C：原 `pendingCount() === 0` 恒真（假 fire() 自己 clear）⇒ 改成观察「结算后不再新增」。
    assert.equal(grace.created.length, 1, "★ AC-12：结算后**不再新增**宽限计时器（多武装一次本行即红）")
    assert.equal(specs.length, 0, "同步路径不派 job（specs 为空 —— 本腿确实走了同步分支）")
  } finally {
    cap.restore()
    dropSession(sid)
  }
})

test("A42-ESC-3 (AC-2 / AC-8 escalate 面): 正常路径零行为变化——宽限从未武装、输出逐字不含强制说明", async () => {
  const { jobs, specs } = fakeJobs()
  const subagents = {
    async start() {
      return {
        result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "did the work\n\nTouched files: none" }] }),
        dispose: async () => { },
      }
    },
  }
  const { sid, deps } = makeDeps({
    subagents, jobs,
    config: { consultModels: [{ provider: "p", model: "m" }], dshBackgroundTimeoutMs: 60000 },
  })
  const grace = makeGraceTimer()
  deps.forcedSettleOpts = grace.opts
  try {
    const r = await captureWarn(async () => {
      const dispatch = String(await runEscalate(deps, "short task", undefined, false, true))
      assert.ok(dispatch.includes("escalate-dsh-1"), "前置：后台派发")
      return await specs[0].hooks.done
    })
    const outcome = r.value
    assert.equal(outcome.status, "completed", "正常路径照常完成（零行为变化）")
    assert.equal(grace.created.length, 0, "★ AC-2：正常路径**从未**武装宽限截止（armAfterAbort 只在既有中止回调里）")
    assert.equal(outcome.output.includes("未响应 abort"), false, "★ AC-2：正常路径输出逐字不变（无强制说明）")
    assert.ok(outcome.output.includes("post-op report"), "既有术后报告形态在位")
  } finally {
    dropSession(sid)
  }
})
