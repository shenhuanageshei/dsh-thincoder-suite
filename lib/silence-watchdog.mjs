// silence-watchdog.mjs — 批 29 / US-1（D29-2 · D29-6）：eng_coder **静默看门狗**叶子模块。
//
// ★ 为什么必须是**独立叶子模块**（D29-6，如实留痕）：批 26 已证「`lib/eng.mjs` 里再加定时器 /
//   写点 ⇒ 撞 T-AP7 **结构上不可满足**」（当时把宿主验收执行面抽成 `lib/host-check.mjs` 才解决，
//   D48-5）；批 29 单①首轮把看门狗写进 `eng.mjs` ⇒ 实测再撞 T-AP7 + `stages.test` 集成腿。
//   本模块承载**全部轮询定时器**与**到点判定**；`lib/eng.mjs` 只 import 使用。
//
// ★ 五条锁交互（设计 §2.1「已知锁交互清单」，逐条遵守——改前请先读这五行）：
//   ① T-AP7(c) 冻结 `eng.mjs` 既有 `setTimeout` 第二实参 ⇒ 本模块用 `setInterval`；
//      `eng.mjs` 仍只有 `backstopMs` / `budgetCap` 两个 setTimeout，**一字未动**；
//   ② T-AP7(b) 冻结中止写点数（`eng.mjs` 恒 5）⇒ 本模块**不含任何中止写点**：
//      到点只把「到点」交回 caller（`onSilence(cb)`），中止由 `eng.mjs` **既有**写点执行
//      （不新造中止闭包、不新增写点）；
//   ③ 失败后缀 wrapper 计数恒 18 ⇒ 静默终止信封在 `eng.mjs` **沿用 `FAILURE_OPTIONS_BLOCK` 常量**
//      （本模块不碰信封）；
//   ④ `test/stages.test.mjs` T12「干净路径零 warning 前缀」⇒ 「看门狗未生效」类标注由 caller
//      走**裸 `console.warn`**（本模块只回报 `{ attached:false, via:null }`，不写任何日志）；
//   ⑤ `stages[].check` 语义改名（D29-3）不在本模块。
//
// ★ 心跳来源（设计 §2.1② / 评审 #1，钉死）：心跳取自**作业 `run()` 内对子代理运行事件的观察**
//   （子代理工具调用落定 / 模型输出流帧）；`handle.append` / `handle.updateProgress` 亦然。
//   **不得**用 `job_output` 轮询（该读取面在本机实测是坏的，正是 D-45 立项前提）。
//   **取不到事件流 ⇒ 退回总预算并如实标注「静默看门狗未生效」**（caller 侧标注，不许假装在看）。
//   与 `dshBackgroundTimeoutMs` 是**两层**：静默看门狗管「卡住」，总预算管「长任务」。
// ★ 心跳**必须真到**（D9，分歧审计 #3）：**订阅型方法存在 ≠ 真会发事件**——接上了事件面却零事件
//   （平台事件名与假设不符）时，若照旧计时 ⇒ 到点会**误杀一个正在正常输出的子代理**（比现状更糟）。
//   故看门狗**创建时不武装**（`eng.mjs` 传 `armed:false`），`heartbeat()` 收到首次真实心跳才武装；
//   零事件 ⇒ 永不中止，退回总预算 `dshBackgroundTimeoutMs`（宁可晚掐，不误杀）。

/** 静默阈值缺省值（D29-2：300000ms = 5 分钟——实测两次卡住的静默段为约 8 分钟 / 60 分钟）。 */
export const ENG_SILENCE_ABORT_MS = 300000
/** 轮询周期（1s；看门狗的每次开销 = 一次减法，与静默阈值无关）。 */
export const ENG_SILENCE_POLL_MS = 1000

/**
 * 配置解析（**运行时宽容口径**，与 `resolveDshBackgroundTimeoutMs` 同族先例）：键
 * `engSilenceAbortMs` 为**正有限数**即生效（含测试注入的小值）；缺失 ⇒ 缺省；非法 ⇒
 * 回落缺省 + 返回 `warning` 供 caller 经 `warn()`（console.warn + 随工具返回文本）带出。
 * ★ 值域常量不在本模块写死第二份给 PUT 面用——本单未把该键注册进三面白名单
 *   （PUT / merge / 设置页）：授权面不含 `lib/config-store.mjs` 与 `lib/client.js`，
 *   半套登记会让「PUT 接受而运行时收不到」成为静默无效。生产可配面 = entry base
 *   （`mergeGlobalConfig` 原样保留 base 键）+ 本解析器。
 * @param {{engSilenceAbortMs?: unknown}} config 生效全局配置
 * @returns {{ms: number, warning: string|null}}
 */
export function resolveEngSilenceAbortMs(config) {
  const raw = (config && typeof config === "object") ? config.engSilenceAbortMs : undefined
  if (raw === undefined || raw === null) return { ms: ENG_SILENCE_ABORT_MS, warning: null }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return { ms: raw, warning: null }
  return {
    ms: ENG_SILENCE_ABORT_MS,
    warning: "invalid engSilenceAbortMs " + JSON.stringify(raw)
      + " (expected a finite positive number) — falling back to default " + ENG_SILENCE_ABORT_MS + "ms",
  }
}

/** 「静默 N 分钟」的 N（≥1 位小数，去尾零）；终止文案的唯一口径（§2.1② 逐字要求该措辞）。 */
export function silenceMinutesLabel(silentMs) {
  const n = Number(silentMs)
  const m = Number.isFinite(n) && n > 0 ? Math.round((n / 60000) * 10) / 10 : 0
  return String(m)
}

/**
 * 静默看门狗工厂（设计 §2.1②：`heartbeat()` 续命 / `onSilence(cb)` 把「到点」交回 caller /
 * `dispose()`）。**到点不自中止**——只回调；中止由 caller 的**既有**写点执行（锁②）。
 *
 * @param {object} [opts]
 *   - `abortMs`：静默阈值（非法 ⇒ 缺省）；
 *   - `pollMs`：轮询周期（非法 ⇒ `ENG_SILENCE_POLL_MS`）；
 *   - `armed`：**初始武装态**（缺省 `true` = 既有语义零漂移；`eng.mjs` 传 `false`——D9：首次真实
 *     心跳前不做静默判定，零事件 ⇒ 永不中止并退回总预算）；
 *   - `@internal` 注入缝（测试用，生产路径一律不传）：
 *     `now`（时钟，缺省 `Date.now`）· `setIntervalImpl` / `clearIntervalImpl`（定时器实现，
 *     缺省全局 `setInterval` / `clearInterval`）——注入后测试可**零真实等待**地驱动到点与续命。
 * @returns {{heartbeat: () => void, onSilence: (cb: Function) => Function, dispose: () => void,
 *   state: () => {disposed: boolean, armed: boolean, delivered: boolean, silentMs: number|null, abortMs: number}}}
 */
export function createSilenceWatchdog(opts) {
  const o = (opts && typeof opts === "object") ? opts : {}
  const abortMs = (typeof o.abortMs === "number" && Number.isFinite(o.abortMs) && o.abortMs > 0)
    ? o.abortMs : ENG_SILENCE_ABORT_MS
  const pollMs = (typeof o.pollMs === "number" && Number.isFinite(o.pollMs) && o.pollMs > 0)
    ? o.pollMs : ENG_SILENCE_POLL_MS
  const now = typeof o.now === "function" ? o.now : Date.now
  const setIntervalImpl = typeof o.setIntervalImpl === "function"
    ? o.setIntervalImpl : (fn, ms) => setInterval(fn, ms)
  const clearIntervalImpl = typeof o.clearIntervalImpl === "function"
    ? o.clearIntervalImpl : (h) => clearInterval(h)

  let lastBeat = now()
  // D9：`armed` = 「至少收到过一次**真实**心跳」。缺省 true（既有调用方零漂移）；`eng.mjs` 传
  // `armed:false` ⇒ 首次真实事件前 tick 直接返回（不判定、不中止——零事件退回总预算）。
  let armed = o.armed !== false
  let delivered = false
  let silentMs = null
  let disposed = false
  let onSilent = null

  const tick = () => {
    if (disposed || delivered) return
    if (!armed) return // D9：首次真实心跳前不启动静默判定（订阅面在 ≠ 会发事件）
    const gap = now() - lastBeat
    if (!(typeof gap === "number" && Number.isFinite(gap)) || gap < abortMs) return
    delivered = true
    silentMs = gap
    const cb = onSilent
    if (typeof cb === "function") {
      // caller 回调内的异常不得击穿轮询（心跳/看门狗是兜底设施，自身永不成为故障源）
      try { cb({ silentMs: gap, abortMs }) } catch { /* caller 自负其责 */ }
    }
  }
  const handle = setIntervalImpl(tick, pollMs)
  // 定时器不钉住进程（与既有兜底 setTimeout 的 unref 先例同款）
  try { handle?.unref?.() } catch { /* 非 Node 定时器对象 */ }

  return {
    /** 续命：把「最后一次心跳时刻」推到当下，并**武装**看门狗（D9：首次真实事件即解除「不判定」态）。 */
    heartbeat() { if (!disposed) { armed = true; lastBeat = now() } },
    /** 注册到点回调（返回注销函数）；到点**恰一次**（latch）。 */
    onSilence(cb) {
      onSilent = typeof cb === "function" ? cb : null
      return () => { onSilent = null }
    },
    /** 清定时器（幂等）——作业 settle 的 finally 必定调用。 */
    dispose() {
      if (disposed) return
      disposed = true
      try { clearIntervalImpl(handle) } catch { /* 已清 */ }
    },
    state() { return { disposed, armed, delivered, silentMs, abortMs } },
  }
}

/**
 * 子代理运行事件面的**心跳接驳**（设计 §2.1② 的「子代理运行事件观察」）。
 * ★ 平台是否**真的**暴露下列事件面，本机无法取证（平台包在 asar 内）⇒ 采用**显式探测 + 诚实回落**：
 *   探测到任一面即接上（`attached:true`），一个都探测不到 ⇒ `attached:false`，由 caller
 *   **如实标注「静默看门狗未生效」**并退回总预算（`dshBackgroundTimeoutMs`）。**绝不假装在看**。
 * @param {object|null|undefined} run `ctx.subagents.start` 的返回对象
 * @param {() => void} beat 心跳回调（caller 传 `watchdog.heartbeat`）
 * @returns {{attached: boolean, via: string|null}}
 */
export function attachRunHeartbeat(run, beat) {
  if (!run || typeof run !== "object" || typeof beat !== "function") return { attached: false, via: null }
  const safeBeat = () => { try { beat() } catch { /* 心跳失败不得击穿作业 */ } }
  const attempts = [
    ["onEvent", () => (typeof run.onEvent === "function") ? (run.onEvent(safeBeat), true) : false],
    ["on", () => (typeof run.on === "function") ? (run.on("event", safeBeat), true) : false],
    ["events.subscribe", () => (run.events && typeof run.events.subscribe === "function")
      ? (run.events.subscribe(safeBeat), true) : false],
    ["onUpdate", () => (typeof run.onUpdate === "function") ? (run.onUpdate(safeBeat), true) : false],
    ["subscribe", () => (typeof run.subscribe === "function") ? (run.subscribe(safeBeat), true) : false],
  ]
  for (const [via, attempt] of attempts) {
    try { if (attempt()) return { attached: true, via } } catch { /* 该面不可用 ⇒ 试下一面 */ }
  }
  return { attached: false, via: null }
}

/**
 * 作业句柄的**心跳装饰**（设计 §2.1② 的「`handle.append` / `handle.updateProgress` 亦然」）。
 * ★ 实现口径：`Object.create(handle)` **只覆盖**这两个事件方法，其余成员（`id` 等）走原型链照旧读，
 *   委托调用一律 `fn.apply(handle, args)` ⇒ `this` 仍是原句柄（D-46 输出环契约零改动：
 *   `jobOutcome` 收到的仍是「正文恰 append 一次」的同一句柄语义）。
 *   两个事件方法都不存在 ⇒ 原样返回（零包装，零风险）。
 * @param {object|null|undefined} handle `spec.run(handle)` 的句柄
 * @param {() => void} beat 心跳回调
 * @returns {object|null|undefined} 装饰后的句柄（读语义与写语义与原句柄一致）
 */
export function watchJobHandle(handle, beat) {
  if (!handle || typeof handle !== "object" || typeof beat !== "function") return handle
  const decorate = (name) => {
    const fn = handle[name]
    if (typeof fn !== "function") return null
    return function (...args) {
      try { beat() } catch { /* 心跳失败不得击穿输出环 */ }
      return fn.apply(handle, args)
    }
  }
  const append = decorate("append")
  const updateProgress = decorate("updateProgress")
  if (append === null && updateProgress === null) return handle
  const out = Object.create(handle)
  if (append !== null) out.append = append
  if (updateProgress !== null) out.updateProgress = updateProgress
  return out
}
