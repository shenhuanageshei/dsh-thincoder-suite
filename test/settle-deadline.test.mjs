// settle-deadline.test.mjs — 批 42（看门狗硬结算 · 设计档 §五 FR-1 / §六 6.1 /
// §十 的 `test/settle-deadline.test.mjs` 行）的**模块级**机验腿。
//
// 锁的对外可感行为（每一条都能被「删掉对应实现」变红——§八 锚 A-4 的纪律）：
//   · 未武装 ⇒ `promise` **永不决议**（⇒ 正常路径与任何 race 同场都零影响）；
//   · `armAfterAbort()` 幂等（重复武装只有一个计时器）；
//   · 到期 ⇒ `promise` 决议**哨兵**且 `fired === true`；
//   · `disarm()` 幂等、清计时器、不伪造「已到期」；
//   · 计时器 `unref()`（不吊住进程）；
//   · 非法 `graceMs` ⇒ 回落常量 60000（设计档 §九 畸形输入）；
//   · `raceForced`：**先到者赢**（D4）+ 拒绝语义透传（AC-12 的底座）+ 非 thenable 的 fail-safe（§九）。
//
// ★ 纪律：**零真实等待**——本档不注册任何真实定时器，全部用注入的假 setTimeout，
//   到点由测试自己「点火」；未决议性用「与一个已决议的哨兵 promise race」判定（微任务级）。

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createForcedSettle, raceForced, FORCED_SETTLE_GRACE_MS, FORCED_SETTLE_NOTE,
} from "../lib/settle-deadline.mjs"
// 设计档 §八 的三条结构锚（A-1 / A-2 / A-3）要读三个机制文件的源码字节
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** 已决议哨兵：用来判定「另一个 promise 在若干微任务内**仍未**决议」。 */
const PENDING = Symbol("still-pending")

/**
 * 注入用假定时器（**不注册任何真实定时器**）：记录第二实参（毫秒）与 unref 调用，
 * 到点由测试显式 `fire()` 驱动。
 * @returns {{opts: object, created: object[], cleared: object[], msSeen: number[], fire: Function}}
 */
function makeFakeTimer() {
  const pending = new Map()
  const created = []
  const cleared = []
  const msSeen = []
  let nextId = 0
  const setTimeoutImpl = (fn, ms) => {
    nextId += 1
    msSeen.push(ms)
    const handle = { id: nextId, unrefCalls: 0, unref() { this.unrefCalls += 1 } }
    pending.set(handle, fn)
    created.push(handle)
    return handle
  }
  const clearTimeoutImpl = (handle) => {
    cleared.push(handle)
    pending.delete(handle)
  }
  return {
    opts: { setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl },
    created,
    cleared,
    msSeen,
    /** 点火：把当前挂着的计时器回调全部执行一次（模拟「宽限到期」）。 */
    fire() {
      const fns = [...pending.values()]
      pending.clear()
      for (const fn of fns) fn()
    },
    /** 挂着的计时器数（disarm 后必须归零）。 */
    pendingCount: () => pending.size,
  }
}

test("SD-1 (FR-1): 常量口径——宽限 60000 · 来源说明含「未响应 abort」且不含「已终止」/「被终止」", () => {
  assert.equal(FORCED_SETTLE_GRACE_MS, 60000, "宽限固定 60s（设计决策 D1：用户不可配）")
  assert.ok(FORCED_SETTLE_NOTE.includes("未响应 abort"),
    "AC-6：强制结算文案必须含「未响应 abort」：" + JSON.stringify(FORCED_SETTLE_NOTE))
  assert.ok(FORCED_SETTLE_NOTE.includes("可能仍在后台运行"),
    "D2：必须写明「可能仍在后台运行」（不声称已终止）")
  // AC-6 的反向断言：平台没有终止子代理的接口 ⇒ 文案**不得**出现「已终止」
  assert.equal(FORCED_SETTLE_NOTE.includes("已终止"), false,
    "AC-6：不得声称「已终止」（我们无法终止它）：" + JSON.stringify(FORCED_SETTLE_NOTE))
  // ★ 审计 F1：绕过形态 = 换一个词说同一件不成立的事（「被终止」）——词表必须把两个词一起关住
  //   （AC-6：不含「已终止」/「被终止」；三机制的强制分支由各自的集成腿再各证一次）。
  assert.equal(FORCED_SETTLE_NOTE.includes("被终止"), false,
    "AC-6：也不得写「被终止」（同一句谎话的绕过形态）：" + JSON.stringify(FORCED_SETTLE_NOTE))
  assert.equal(FORCED_SETTLE_NOTE.includes("\n"), false,
    "形态 = 单行（会诊直接拼在 timeoutNote() 之后）：" + JSON.stringify(FORCED_SETTLE_NOTE))
})

test("SD-2 (FR-1 / §6.1 后置): 未武装 ⇒ promise 永不决议（正常路径与任何 race 同场都零影响）", async () => {
  const f = makeFakeTimer()
  const forced = createForcedSettle(f.opts)
  // 「永不决议」的判据 = 与一个**已决议**的哨兵 race ⇒ 胜者必是哨兵（微任务级，零真实等待）
  const winner = await Promise.race([forced.promise, Promise.resolve(PENDING)])
  assert.equal(winner, PENDING, "未武装时 promise 必须保持 pending（否则 race 会抢走真实结果）")
  assert.equal(forced.fired, false, "未武装 ⇒ fired 恒 false")
  assert.equal(f.created.length, 0, "未武装 ⇒ **不得**创建任何计时器（零资源成本）")
})

test("SD-3 (FR-1): armAfterAbort 幂等 —— 重复武装只存在一个计时器；到期 resolve 哨兵且 fired 冻结", async () => {
  const f = makeFakeTimer()
  const forced = createForcedSettle({ ...f.opts, graceMs: 4242 })
  forced.armAfterAbort()
  forced.armAfterAbort()
  forced.armAfterAbort()
  assert.equal(f.created.length, 1, "重复武装不得新增计时器（幂等闩）")
  assert.deepEqual(f.msSeen, [4242], "注入缝生效：计时器用的是 graceMs（测试可驱动，不等 60s）")
  assert.equal(forced.fired, false, "尚未到点 ⇒ fired 为 false")

  f.fire()
  const value = await forced.promise
  assert.equal(typeof value, "symbol", "到期 ⇒ promise 决议为**哨兵**（模块私有，调用方只看 forced 位）")
  assert.match(String(value), /forced-settle/, "哨兵身份可辨识：" + String(value))
  assert.equal(forced.fired, true, "到期 ⇒ fired 变 true")
  // 已到期后再次武装：不得再开第二个计时器（fired 已冻结）
  forced.armAfterAbort()
  assert.equal(f.created.length, 1, "已到期 ⇒ armAfterAbort 无副作用（fired 闩）")
})

test("SD-4 (FR-1 / §6.2 后置): disarm 幂等且清计时器 —— 清掉后到点也不得伪造「已到期」", async () => {
  const f = makeFakeTimer()
  const forced = createForcedSettle(f.opts)
  forced.armAfterAbort()
  assert.equal(f.pendingCount(), 1, "前置：武装后恰好一个挂着的计时器")
  forced.disarm()
  forced.disarm()
  assert.equal(f.cleared.length, 1, "disarm 幂等：clearTimeout 恰好一次")
  assert.equal(f.pendingCount(), 0, "disarm 后无残留计时器（AC-12 的模块级底座）")
  assert.equal(forced.fired, false, "disarm 不得伪造「已到期」")
  f.fire() // 已清掉的回调不会再跑；即便被外部误跑，也不得改状态
  const winner = await Promise.race([forced.promise, Promise.resolve(PENDING)])
  assert.equal(winner, PENDING, "disarm 后 promise 仍永不决议（清除 ≠ 到期）")
  forced.armAfterAbort()
  assert.equal(f.created.length, 1, "disarm 之后再武装同样无副作用（disarmed 闩：一个对象只武装一次）")
})

test("SD-5 (FR-1 / 需求档 §三 资源): 计时器必须 unref —— 宽限待机绝不吊住进程", () => {
  const f = makeFakeTimer()
  const forced = createForcedSettle(f.opts)
  forced.armAfterAbort()
  assert.equal(f.created.length, 1, "前置：已武装")
  assert.equal(f.created[0].unrefCalls, 1, "armAfterAbort 必须对计时器调 unref()（删掉该行 ⇒ 本行必红）")
})

test("SD-6 (§九 畸形输入): 非法 graceMs 一律回落常量 60000；非对象 opts 当作未传", () => {
  // ① 各类非法 graceMs
  for (const bad of [-1, 0, NaN, Infinity, -Infinity, "1000", null, undefined, {}, [], () => 1]) {
    const f = makeFakeTimer()
    const forced = createForcedSettle({ ...f.opts, graceMs: bad })
    forced.armAfterAbort()
    assert.deepEqual(f.msSeen, [60000],
      "非法 graceMs 必须回落常量（实得 " + JSON.stringify(bad) + " ⇒ " + JSON.stringify(f.msSeen) + "）")
  }
  // ② 合法值原样生效（对照：不是「恒回落到 60000」的恒真断言）
  for (const good of [1, 7, 60000, 1.5]) {
    const f = makeFakeTimer()
    const forced = createForcedSettle({ ...f.opts, graceMs: good })
    forced.armAfterAbort()
    assert.deepEqual(f.msSeen, [good], "合法 graceMs 原样生效：" + JSON.stringify(good))
  }
  // ③ 非对象 opts（`deps.forcedSettleOpts` 被误传）⇒ 忽略、不抛；用全局定时器 + 常量
  for (const junk of [null, undefined, "x", 42, true]) {
    const forced = createForcedSettle(junk)
    assert.equal(typeof forced.armAfterAbort, "function", "非对象 opts 不得抛（当作未传）：" + String(junk))
    assert.equal(forced.fired, false)
    forced.disarm()
  }
})

test("SD-7 (D4 / §九): raceForced —— 先到者赢；非 thenable 走强制分支（fail-safe）；拒绝原样透传", async () => {
  // ① 真结果先到 ⇒ forced:false + 值（**不得**因为「之后 fired 也可能为 true」而丢掉真实结果）
  {
    const f = makeFakeTimer()
    const forced = createForcedSettle(f.opts)
    const r = await raceForced(Promise.resolve({ stopReason: "completed", marker: 7 }), forced)
    assert.deepEqual(r, { forced: false, value: { stopReason: "completed", marker: 7 } },
      "真结果先到 ⇒ 原样返回（先到者赢；丢真结果 = 违反 D4）")
  }
  // ② 强制先到 ⇒ forced:true
  {
    const f = makeFakeTimer()
    const forced = createForcedSettle(f.opts)
    const hang = new Promise(() => {}) // 真子代理「永不 settle」
    forced.armAfterAbort()
    f.fire()
    const r = await raceForced(hang, forced)
    assert.equal(r.forced, true, "强制结算先到 ⇒ forced:true（等待点因此不可能无界）")
    assert.equal(r.value, undefined, "forced:true 时不得伪造一个「值」")
  }
  // ③ 非 thenable ⇒ 直接强制分支（§九 升级边界：宁可立刻落账，也不让等待点变回无界）
  for (const nonThenable of [undefined, null, { stopReason: "completed" }, "text", 0]) {
    const forced = createForcedSettle()
    const r = await raceForced(nonThenable, forced)
    assert.deepEqual(r, { forced: true, value: undefined },
      "非 thenable ⇒ fail-safe 强制分支（实得 " + JSON.stringify(nonThenable) + "）")
  }
  // ④ 拒绝语义原样透传（AC-12 的「abort 后 reject」依赖它：既有 catch 分支必须仍然接管）
  {
    const forced = createForcedSettle()
    await assert.rejects(raceForced(Promise.reject(new Error("boom-reject")), forced),
      /boom-reject/, "真结果 reject ⇒ raceForced 也必须 reject（不得被吞成 forced:true）")
  }
})

test("SD-8 (FR-1): 到期后 disarm 不改变事实 —— fired 保持 true（消费方可安全地在 finally 统一清除）", async () => {
  const f = makeFakeTimer()
  const forced = createForcedSettle(f.opts)
  forced.armAfterAbort()
  f.fire()
  await forced.promise
  assert.equal(forced.fired, true, "前置：已到期")
  forced.disarm()
  assert.equal(forced.fired, true, "disarm 只清计时器，**不撤销**已发生的事实（§6.1 后置）")
  // 与 §6.2 的 finally 形态对位：到期后 disarm 时计时器已自行置空 ⇒ 不得再 clearTimeout 一个已消费的句柄
  assert.equal(f.cleared.length, 0, "计时器已自行置空 ⇒ disarm 不再对它调 clearTimeout（防误清已消费句柄）")
})

// ═══════════════ 批 42 · 设计档 §八 的**结构锚**（A-1 / A-2 / A-3）═══════════════
//
// 三条锚都是**跨文件**的正向枚举（设计档 §八 逐字要求「正向枚举；不写成『全部调用点都在回调内』
// ——后者在零调用点时空洞成立」）：
//   · A-1：六个既有中止回调内**各恰好一次** forced.armAfterAbort()（判据 = 该回调的中止调用之上、
//     跳过注释的**第一行非注释代码**就是武装行）；
//   · A-2：五个等待点全部是 await raceForced( 形态，且三个机制文件里**零**裸 await run.result /
//     await sub.result 的赋值代码行（旧形态会被本腿逐点抓到）；
//   · A-3：lib/eng.mjs 的 setTimeout 字面数量不变（= 2；时长/条件由 T-AP7(c) 逐字冻结）。
// ★ 与行为腿的分工：行为腿证明「到点真的落账」，本腿证明「**落点**没有被挪出既有中止回调」
//   （把 arm 挪进叶子模块 / 新造一个中止回调 ⇒ 行为腿可能照样绿，本腿必红）。
const SETTLE_PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SETTLE_LIB = (name) => readFileSync(join(SETTLE_PLUGIN_DIR, "lib", name), "utf8")

test("SD-9 (§八 锚 A-1 / A-2 / A-3): 六个既有中止回调内各恰一次 armAfterAbort；五个等待点全为 race 形态；eng 的 setTimeout 字面数不变", () => {
  const files = {
    "consult.mjs": SETTLE_LIB("consult.mjs"),
    "eng.mjs": SETTLE_LIB("eng.mjs"),
    "escalate.mjs": SETTLE_LIB("escalate.mjs"),
  }
  /** 逐行视图（去掉行尾 CR：本仓部分文件是 CRLF，逐字比较前先归一）。 */
  const linesOf = (src) => src.split("\n").map((l) => l.replace(/\r$/, ""))

  // —— A-1：六个回调（锚点 = 该回调里的**中止调用**那一行）——
  const armSites = [
    { file: "consult.mjs", anchor: 'forward(timeoutError("consult watch dog deadline reached"', label: "会诊看门狗" },
    { file: "eng.mjs", anchor: 'cancelJob(timeoutError("eng_coder dsh subagent silence watchdog deadline reached"', label: "eng 后台静默看门狗" },
    { file: "eng.mjs", anchor: 'ctrl.abort(timeoutError("eng dsh background backstop deadline reached"', label: "eng 后台兜底" },
    { file: "eng.mjs", anchor: 'dshCtrl.abort(timeoutError("eng_coder dsh subagent deadline reached"', label: "eng 同步截止" },
    { file: "escalate.mjs", anchor: 'ctrl.abort(timeoutError("escalate dsh background backstop deadline reached"', label: "escalate 后台兜底" },
    { file: "escalate.mjs", anchor: 'dshCtrl.abort(timeoutError("escalate dsh subagent deadline reached"', label: "escalate 同步截止" },
  ]
  let armTotal = 0
  for (const src of Object.values(files)) armTotal += (src.match(/forced\.armAfterAbort\(\)/g) ?? []).length
  assert.equal(armTotal, 6, "A-1：三个机制文件里 forced.armAfterAbort() 合计恰 6 处——多一处 = 新增中止回调，少一处 = 漏武装")
  for (const site of armSites) {
    const lines = linesOf(files[site.file])
    const hits = []
    for (let i = 0; i < lines.length; i++) if (lines[i].includes(site.anchor)) hits.push(i)
    assert.equal(hits.length, 1, "A-1（" + site.label + "）：锚点必须在 " + site.file + " 里恰命中一行（实测 " + JSON.stringify(hits) + "）")
    let j = hits[0] - 1
    while (j >= 0 && /^\s*(\/\/|\*|\/\*)/.test(lines[j])) j -= 1
    assert.ok(j >= 0, "A-1（" + site.label + "）：锚点之上必须存在武装行")
    assert.equal(lines[j].trim(), "forced.armAfterAbort()",
      "A-1（" + site.label + "）：中止调用之上（跳过注释）的**第一行代码必须是武装行**——把 arm 挪走/删掉 ⇒ 本行必红。实测："
        + JSON.stringify(lines[j].trim()))
  }

  // —— A-2：五个等待点全是 race 形态；裸 await 赋值行零残留（逐点）——
  const raceCount = {
    "consult.mjs": (files["consult.mjs"].match(/await raceForced\(/g) ?? []).length,
    "eng.mjs": (files["eng.mjs"].match(/await raceForced\(/g) ?? []).length,
    "escalate.mjs": (files["escalate.mjs"].match(/await raceForced\(/g) ?? []).length,
  }
  assert.deepEqual(raceCount, { "consult.mjs": 1, "eng.mjs": 2, "escalate.mjs": 2 },
    "A-2：五个等待点（consult 1 · eng 2 · escalate 2）全部改 race 形态——少一点 ⇒ 那一点仍可能无界等待")
  // 裸 await 的**旧形态**（const result = await sub.result / result = await run.result）：
  // 只认「整行就是一条 await 赋值」的代码行 ⇒ 注释与字符串字面量（eng 的失败阶段表里有引号形态）零误伤。
  const BARE_AWAIT = /^\s*(?:const\s+[A-Za-z_$][\w$]*\s*=\s*|result\s*=\s*)await\s+(?:run|sub)\.result\s*;?\s*$/
  const bare = []
  for (const [file, src] of Object.entries(files)) {
    linesOf(src).forEach((l, i) => { if (BARE_AWAIT.test(l)) bare.push(file + ":" + (i + 1) + " " + l.trim()) })
  }
  assert.deepEqual(bare, [], "A-2：五个等待点必须不再出现裸 await <run|sub>.result 赋值行（实测：" + JSON.stringify(bare) + "）")
  // 谓词自证（律 3）：旧形态字面必须能被同一条谓词抓到（否则本腿是恒真）
  assert.equal(BARE_AWAIT.test("    const result = await sub.result"), true, "A-2 谓词自证：旧形态判真")
  assert.equal(BARE_AWAIT.test('      "await run.result",      // 子代理在跑'), false, "A-2 谓词自证：字符串字面量不被误伤")
  assert.equal(BARE_AWAIT.test("    // const result = await run.result"), false, "A-2 谓词自证：注释行不被误伤")

  // —— A-3：eng.mjs 的 setTimeout 字面数量不变（= 2：backstopMs / budgetCap）——
  assert.equal((files["eng.mjs"].match(/setTimeout\(/g) ?? []).length, 2,
    "A-3：lib/eng.mjs 的 setTimeout 字面恰 2 处（宽限计时器住 lib/settle-deadline.mjs ⇒ 本文件不得新增）")
})
