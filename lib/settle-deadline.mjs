// settle-deadline.mjs — 「到点必落账」的**宽限截止**叶子模块（批 42 · 设计档
// docs/2026-10-22-forced-settle-design.md §五 FR-1 / §六 6.1）。
//
// ★ 为什么必须是**独立叶子模块**（设计决策 D3）：
//   `lib/eng.mjs` 的 `setTimeout` 字面被 **T-AP7(c)** 逐字冻结（第二实参表达式表；
//   同表也冻结 `escalate.mjs` / `consult.mjs` / `advisor.mjs`）⇒ 在那里新增一个字面
//   就会打红结构锁。这与 `lib/silence-watchdog.mjs` 当初被拆出去是**同一个理由**。
//   本模块**零 import**（没有第二个依赖面），因此不可能成环。
//
// ★ 语义（状态机见设计档 §七 图 1 / 图 2）：
//   · 未武装 ⇒ `promise` **永不决议** ⇒ 与任何 `Promise.race` 同场都不影响结果
//     （正常路径因此**零行为变化**：武装只发生在既有中止回调里）；
//   · 武装后宽限到期 ⇒ `promise` 决议为模块私有哨兵 `FORCED`，且 `fired === true`；
//   · **幂等**：重复 `armAfterAbort()` 不新增计时器；`disarm()` 重复调用无副作用；
//   · `disarm()` 是**唯一**的计时器清除点（由调用方最后统一放在 finally 里）。
//
// ★ 本模块**不中止任何东西**（设计决策 D5）：中止写点仍只在四个机制文件里，
//   调用方在**既有的**中止回调里先武装、再发中止；本模块只负责「到期」这一件事。

/** 宽限固定值（设计决策 D1：**用户不可配**，不进配置白名单三面）。 */
export const FORCED_SETTLE_GRACE_MS = 60_000

/**
 * 强制结算的**统一来源说明**（设计档 FR-5：文案用统一常量，三机制同源 ⇒ 杜绝三份漂移）。
 *
 * ★ 诚实口径（D2）：只写「未响应 abort，可能仍在后台运行」——平台没有终止子代理的接口，
 *   所以**不得**声称我们终止了任何东西（AC-6 的反向断言：不含「已终止」/「被终止」——后者是审计 F1
 *   点名的绕过形态：换一个词说同一件不成立的事）。
 * ★ 形态 = **单行、以全角括号起头**：会诊把它直接拼在 `timeoutNote()` 之后（§6.2 的伪代码
 *   逐字形态）；eng / escalate 在信封里自己加换行前缀 ⇒ 一处常量适配三处形态。
 */
export const FORCED_SETTLE_NOTE = "（子代理未响应 abort：宽限期满仍未返回，插件强制结算了本次结果"
  + "——它可能仍在后台运行，且这不是它的真实回复。）"

/** 强制结算哨兵（模块私有：调用方**不得**依赖值的形态，只用 `raceForced` 的 `forced` 位）。 */
const FORCED = Symbol("forced-settle")

/**
 * `graceMs` 归一（设计档 §九「畸形输入」）：非数字 / 非有限 / 非正 ⇒ **回落常量**（绝不抛）。
 * 不接受字符串数字（配置面的宽容不放宽到这里：注入缝只服务测试与显式调用）。
 * @param {unknown} v
 * @returns {number}
 */
function normalizeGraceMs(v) {
  return (typeof v === "number" && Number.isFinite(v) && v > 0) ? v : FORCED_SETTLE_GRACE_MS
}

/**
 * 建一个「abort 之后的宽限截止」。
 *
 * @pre   `opts` 可缺失 / 可为任意值（非对象 ⇒ 当作 `{}`，设计档 §九：`deps.forcedSettleOpts`
 *        非对象 ⇒ 忽略）；`graceMs` 非法 ⇒ 回落 {@link FORCED_SETTLE_GRACE_MS}
 * @post  至多存在**一个**计时器（unref 过，不吊住进程）；`fired === true` 后 `promise`
 *        已决议且不再变化；`fired === false` 时 `promise` **永不决议**
 * @post  `disarm()` 幂等、只清计时器、**不**撤销已发生的事实（`fired` 保持为 true）
 * @param {{graceMs?: number, setTimeout?: Function, clearTimeout?: Function}} [opts]
 *        生产路径不传（= 全局 setTimeout/clearTimeout 与 60s）；`deps.forcedSettleOpts` 是测试注入缝
 * @returns {{armAfterAbort: () => void, disarm: () => void, promise: Promise<symbol>, fired: boolean}}
 */
export function createForcedSettle(opts) {
  const o = (opts !== null && typeof opts === "object") ? opts : {}
  const graceMs = normalizeGraceMs(o.graceMs)
  const st = typeof o.setTimeout === "function" ? o.setTimeout : setTimeout
  const ct = typeof o.clearTimeout === "function" ? o.clearTimeout : clearTimeout
  let timer = null
  let fired = false
  let disarmed = false
  let resolveOnce = null
  const promise = new Promise((resolve) => { resolveOnce = resolve })

  return {
    /** 武装：调用方在**既有中止回调**里先调它、再发中止（D5：不新增中止写点）。 */
    armAfterAbort() {
      if (disarmed || fired || timer !== null) return // 幂等：重复武装无副作用
      timer = st(() => {
        timer = null
        if (disarmed || fired) return
        fired = true
        resolveOnce(FORCED)
      }, graceMs)
      // 自证：宽限计时器绝不吊住进程（与各机制既有的 unref 同一纪律）
      timer?.unref?.()
    },
    /** 解除：幂等；只清计时器（成功 / 既有失败 / 强制三条路径都走这里）。 */
    disarm() {
      if (disarmed) return
      disarmed = true
      if (timer !== null) {
        ct(timer)
        timer = null
      }
    },
    promise,
    get fired() { return fired },
  }
}

/**
 * 等待点统一形态：**真结果与强制结算竞争，先到者赢**（设计决策 D4）。
 *
 * ★ 为什么要这层（而不是各处裸写 `Promise.race` + 查 `forced.fired`）：
 *   ① 判据取**race 的胜者**（哨兵身份），而不是「查已发生的 fired」——两者在**同刻到达**时不同：
 *      查 fired 会把**已经到手的真结果丢掉**（等同把「先到者赢」退化成「强制永远优先」）；
 *   ② 设计档 §九「升级」边界要求：`run.result` 若哪天不再是 thenable ⇒ **直接走强制分支**
 *      （fail-safe：宁可立刻按「无回复 / 超时」落账，也不把等待点变回无界）。
 * ★ 拒绝语义**原样透传**：真结果以 reject 结束时本函数**也 reject** ⇒ 各机制既有的 catch
 *   分支（abort / 超时 / 真错）零改动仍然接管（AC-12 的「abort 后 reject」正走这条）。
 *
 * @pre   `forced` 是 {@link createForcedSettle} 的返回值
 * @post  返回 `{ forced, value }`；`forced === true` ⇒ `value` 无意义（undefined）
 * @param {Promise<unknown>|unknown} settleable 平台子代理的 result（或任何等待对象）
 * @param {{promise: Promise<symbol>, fired: boolean}} forced
 * @returns {Promise<{forced: boolean, value: unknown}>}
 */
export async function raceForced(settleable, forced) {
  if (settleable === null || settleable === undefined || typeof settleable.then !== "function") {
    return { forced: true, value: undefined } // §九：不可等待 ⇒ 强制分支（fail-safe，绝不无界等）
  }
  const winner = await Promise.race([settleable, forced.promise])
  if (winner === FORCED) return { forced: true, value: undefined }
  return { forced: false, value: winner }
}
