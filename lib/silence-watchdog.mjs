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
//      走**裸 `console.warn`**（`attachRunHeartbeat` 只回报 `{ attached, via }`、不写任何日志；
//      US-A① 的**首次接线留档** `archiveWatchdogAttach` 是本模块唯一的写日志入口，且必须由
//      caller **显式调用**——同走裸 `console.warn`、同不进返回文本）；
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
 * 非法值的**双口径**渲染（批 29 §2.9 🔵1 / A29-15）：`JSON.stringify` 口径 + `String` 口径。
 * ★ 两者**不同**时并列显示（`null / String: NaN` 形态），**相同**时只显一份（如 `0` / `-1`）——
 *   单用 `JSON.stringify` 会把 `NaN` / `Infinity` 串成 `"null"` ⇒ 告警读成
 *   「invalid engSilenceAbortMs null」，把排障引向「谁配了 null」的错方向；双口径让结构化面
 *   与人读两边的账都对得上，且相同口径不重复出声。
 * @param {unknown} raw 非法的配置原值
 * @returns {string} 两口径不同 ⇒ `null / String: NaN`；相同 ⇒ 单形态（如 `"0"`）
 */
function renderInvalidValue(raw) {
  const jsonForm = JSON.stringify(raw)
  const stringForm = String(raw)
  return jsonForm === stringForm ? jsonForm : jsonForm + " / String: " + stringForm
}

/**
 * 配置解析（**运行时宽容口径**，与 `resolveDshBackgroundTimeoutMs` 同族先例）：键
 * `engSilenceAbortMs` 为**正有限数**即生效（含测试注入的小值）；缺失 ⇒ 缺省；非法 ⇒
 * 回落缺省 + 返回 `warning` 供 caller 经 `warn()`（console.warn + 随工具返回文本）带出。
 * ★ null 视同缺失（批 29 §2.9 🔵2 钉死的口径）：显式 `engSilenceAbortMs: null` 与 `undefined`
 *   同走缺省分支——**零告警**；「非法」= 其余一切形态（null 不归「非法 ⇒ warning」类）。
 * ★ 非法值告警用**双口径**渲染（批 29 §2.9 🔵1，见上方 `renderInvalidValue`）——`NaN` /
 *   `Infinity` 不再被串成孤零零的 `null`。
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
    warning: "invalid engSilenceAbortMs " + renderInvalidValue(raw)
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

// ————— 批 29 / §2.6 US-A①（D-53 **一次性留档**）：接线结果的首次采样 —————
// 目的（设计 §2.6④）：真机放**一次**就能拿到「平台到底给了什么」（run 对象暴露了哪些成员、
// 哪个候选方法真管用），据此**收敛候选表**——而不是继续猜事件名。刻意**不**在本单顺手猜新名。

/** 键名清单渲染的**上界**（超过即只报总数——留档绝不刷屏）。 */
export const KEY_LIST_MAX = 24

/**
 * 键名清单的**有界 / 去重 / 截断安全**渲染（US-A 两条留档共用这一份实现——单一事实源）。
 * ★ 三条硬要求（设计 §2.6③ 逐字）：① **有界**——至多列 `KEY_LIST_MAX` 个键，超出只报总数；
 *   ② **去重**——同名键只留首次出现；③ **截断安全**——任何入参形态（null / 原始值 / 属性枚举
 *   抛错的 Proxy / 超长键名）都**只返回字符串、绝不抛**：留档是诊断设施，自身不得成为新的失败源
 *   （与心跳 / 看门狗同一条纪律）。
 * ★ 批 29 §2.9 🔵3 / A29-15 追加第四条：**单行性**——键名内嵌换行/控制符会把一条 warn 顶成
 *   多行、破坏「单行可 grep」⇒ 键名**先**把全部空白（\s+）折叠为单空格，**再**截断（截断
 *   长度按折叠后的形态计）。
 * @param {unknown} value 待列的宿主对象（`run` / `ctx.tools` 等）
 * @returns {string} 形如 `result, dispose, onEvent (共 3 项)`；零键 ⇒ `(零键) (共 0 项)`
 */
export function formatKeyList(value) {
  let raw = []
  try { raw = (value && typeof value === "object") ? Object.keys(value) : [] } catch { raw = [] }
  const seen = new Set()
  const uniq = []
  for (const k of raw) {
    if (typeof k !== "string" || k === "" || seen.has(k)) continue
    seen.add(k)
    uniq.push(k)
  }
  // §2.9 🔵3：折叠**先于**截断——「单行可 grep」不被键名内嵌换行/控制符破坏（截断长度按折叠后形态计）。
  const clip = (k) => {
    const folded = k.replace(/\s+/g, " ")
    return folded.length > 48 ? folded.slice(0, 48) + "…" : folded
  }
  const body = uniq.length > 0 ? uniq.slice(0, KEY_LIST_MAX).map(clip).join(", ") : "(零键)"
  return body + (uniq.length > KEY_LIST_MAX ? " …(截断，共 " + uniq.length + " 项)" : " (共 " + uniq.length + " 项)")
}

/** 首次接线留档的**进程内一次闩**（US-A①；缺省合上状态 = 未打印）。 */
let attachArchiveLatched = false

/**
 * 测试缝：复位「首次接线留档」闩。
 * ★ 可见性机制（设计 §2.4 评审 #8）：本仓无私有导出 ⇒ 以**命名约定 + JSDoc `@internal`** 为准
 *   —— `__` 前缀 + `ForTest` 后缀 + 本标注，三者同时在场才构成「测试缝」。
 * ★ 生产路径零引用：`lib/**` 内除本档自身外的任何模块引用本缝，都会让
 *   `test/silence-watchdog.test.mjs` 的静态锁转红。
 * @internal 仅测试使用；不属于插件对外契约，可随时改名/删除。
 */
export function __resetWatchdogAttachArchiveForTest() { attachArchiveLatched = false }

/**
 * ★ US-A①（D-53 一次性留档 / 设计 §2.6①）：**看门狗接线结果的首次留档**——进程内**恰一条**裸
 * `console.warn`，如实记下「真机上平台到底给了什么」，据此收敛候选表（而不是继续猜）。
 *   · `attached:true` ⇒ 记下**命中的候选方法名**（哪个键真管用）；
 *   · `attached:false` ⇒ 记下 `Object.keys(run)`（有界、去重、截断安全）。
 * 两形态都附 `run` 的键名清单——一次性采样，信息量最大的一笔。
 * ★ **只在首次**：闩是本模块级布尔 ⇒ 生产路径（全程一个进程一份）恰一条，不逐次刷屏。
 * ★ **不进返回文本**：本函数只写裸 `console.warn`，**不碰** `warnPrefix`（`test/stages.test.mjs`
 *   T12 锁「干净路径零 warning 前缀」）。
 * ★ 边界如实写明：接线**当刻**还观测不到「订阅型方法在场但**零事件**」（D9 形态）——本留档记的是
 *   接线结果；零事件的后果由 `armed:false`（首次真实事件前不判定、不误杀）兜底，两者互补，
 *   不得互相替代。
 * @param {object|null|undefined} run `ctx.subagents.start` 的返回对象
 * @param {{attached?: boolean, via?: string|null}|null|undefined} probe `attachRunHeartbeat` 的返回值
 * @returns {boolean} true = 本次真的打印了（进程内首次）；false = 闩已合上（不再打印）
 */
export function archiveWatchdogAttach(run, probe) {
  if (attachArchiveLatched) return false
  attachArchiveLatched = true
  const attached = !!(probe && probe.attached)
  const via = (probe && typeof probe.via === "string" && probe.via !== "") ? probe.via : "(未知渠道)"
  const message = "[thincoder-suite] 静默看门狗接线留档（进程内首次，D-53）：attached=" + (attached ? "true" : "false")
    + (attached ? "，命中候选事件面「" + via + "」" : "，零候选事件面")
    + "；run 键清单 = " + formatKeyList(run)
  // 批 29 / §2.8①：入队（**同一条**文案，键清单口径与进程内一次闩逐字不变）——裸告警**保留**
  // （人盯终端时仍可见），但**不再是唯一通道**：本部署上告警按构造落不了盘（见下方小节说明）。
  enqueueArchiveLine(message)
  console.warn(message)
  return true
}

// ————— 批 29 / §2.8（D-53 **可读通道**）：一次性留档缓冲（把证据搬进读得到的面）—————
//
// ★ 为什么需要这一段（设计 §2.8，**实测发现的设计缺陷**，不是推断）：§2.6 的两条留档原本**只走**
//   裸 console 告警，而本部署上 ① 死亡日志只在**进程死亡时**记 stderr 尾部（实测：全是历史
//   EXITED 条目，零「接线留档」）；② 作业报告文件里**只有**经作业句柄 append 的字符（实测：
//   真机区零插件告警，所有形似证据的行都在**宿主验收回执**区 = 宿主验收命令的尾输出）⇒ **那个
//   证据通道按构造不可读**，D-53 无法闭合。**修通道，不是改文案。**
//
// ★ 三条硬约束（设计 §2.8①③·④，逐条在此落实）：
//   ① **入队**取代「只走告警」：生产者把**同一条**文案入队（键清单口径与进程内一次闩**逐字不变**）；
//      裸告警**保留**（人盯终端时仍可见），但**不再是唯一通道**——证据面以回执区为准。
//   ② **搬运只发一次**（进程内）：**真搬到了行**后永久返回空串 ⇒ 重复派发不重复追加；**空搬运不算
//      搬过**（不关闩，见 `drainArchiveBlock` 的 JSDoc「关闩的时机」/ §2.8 审计 🔴D1）。
//   ③ **绝不前插**：搬运工的返回值由 caller（lib/eng.mjs）追加在**交付正文之后**——阶段门是
//      **前缀式**判定，前插会**破坏门禁**；也**绝不**进子代理的任务正文（指令面零污染）。

/** 留档缓冲的**上界**（条数）——留档是诊断设施，不得挤占交付正文（设计 §2.8①「有界」）。 */
export const ARCHIVE_BUFFER_MAX = 8

/** 回执区里承载留档的**小节标题**（逐字常量；实现与断言都按它定位）。 */
export const HOST_ARCHIVE_HEADER = "--- 宿主留档（机制首派观测；非交付内容） ---"

const archiveBuffer = []
let archiveDrained = false

/**
 * 留档**入队**（设计 §2.8①）：生产者（接线首派结果 / 工具面首派裁决）把**同一条**文案交给本缓冲。
 * ★ 三条取舍：
 *   ① **有界**：至多 ARCHIVE_BUFFER_MAX 条，超出即**丢弃新条**（先到先得）——留档绝不刷屏、
 *      绝不挤占交付正文；
 *   ② **搬运过一次后拒收**：缓冲区被搬空后永久关闭 ⇒ 留档**只发一次**（重复派发不重复追加，
 *      也避免「搬运后迟到的入队永远躺在内存里」这种无出口状态）；
 *   ③ **绝不抛**：非串入参归一为串、纯空白拒收（留档是诊断设施，自身永不成为新的失败源）。
 * ★ 批 29 §2.9 🔵4 / A29-16：trim **只做纯空白判定**，入缓冲的是**原文**——配对的裸
 *   `console.warn` 打的也是同一原文 ⇒ §2.8①「同一条文案逐字不变」由**构造**保证（不靠
 *   两边恰好都没有首尾空白；含首尾空白的入参两通道仍逐字相同）。
 * @param {string} line 逐字告警文案（与裸告警**同一条**，不另造第二份；原文入缓冲、不做边缘 trim）
 * @returns {boolean} true = 真的入队了；false = 纯空白 / 已搬空 / 已满
 */
export function enqueueArchiveLine(line) {
  if (archiveDrained) return false
  const text = typeof line === "string" ? line : String(line ?? "")
  if (text.trim() === "") return false
  if (archiveBuffer.length >= ARCHIVE_BUFFER_MAX) return false
  archiveBuffer.push(text)
  return true
}

/**
 * 留档**搬运**（设计 §2.8②）：把缓冲区渲染成**一整段**回执小节，供 caller 追加在**交付正文之后**。
 * ★ 返回值以两个换行起头 ⇒ 与正文之间**天然留白**，读者一眼看得出「这是机器加的观测，不是交付内容」。
 * ★ **只发一次**（进程内）：**真搬到了行**即关闭缓冲；此后恒返回空串（空串拼接对既有返回点
 *   **零影响**，即四个回执书写处在「本进程此前没有留档」时行为逐字节不变）。
 * ★ **关闩的时机（§2.8 审计 🔴D1，2026-09-27 合并修复轮）**：「**空手而归不算搬过**」——
 *   判空先于置闩。四个回执书写点里，**codex 两路与 dsh 同步路**在成功返回点都可能**零入队**
 *   （工具面 `applied:true` ⇒ 不入队；codex 分支全程无入队点）⇒ 若空搬运也关闩，**首次交付**
 *   就把可读通道永久关死，之后的首派证据（接线留档 / 工具面「未生效」）永远进不了回执区——
 *   那正是 §2.8 要消灭的「证据按构造不可读」形态。空搬运仍返回空串（行为逐字节不变），只是不关闩。
 * ★ 批 29 §2.9 🔵5（设计边界，**有意不改**）：一次真搬运后通道即永久关闭 ⇒ 若首个证据来自早先一次派发，之后才首次发生的接线留档只剩裸 console——与「进程内只发一次」（A29-14 有意锁死）一致，收窄属下一批裁定。
 * @returns {string} 两换行 + 小节标题 + 逐行留档 + 尾换行；无可搬 ⇒ 空串
 */
export function drainArchiveBlock() {
  if (archiveDrained) return ""
  // ★ §2.8 审计 🔴D1（2026-09-27 合并修复轮）：**判空必须先于闩**——本进程「暂无留档」的一次空搬运
  //   **不算搬过**（先置闩会让后续首派证据永远进不了回执区：codex 分支与 dsh 同步路径都在成功
  //   返回点零入队地搬运一次，首次交付即把通道永久关死）。见本函数 JSDoc 的「关闩的时机」。
  if (archiveBuffer.length === 0) return ""
  archiveDrained = true
  const lines = archiveBuffer.splice(0, archiveBuffer.length)
  return "\n\n" + HOST_ARCHIVE_HEADER + "\n" + lines.join("\n") + "\n"
}

/**
 * 测试缝：复位留档缓冲（清空 + 重新打开「只发一次」闩）。
 * ★ 可见性机制同 §2.4 评审 #8（命名约定 + JSDoc @internal）：双下划线前缀 + ForTest 后缀 + 本标注，
 *   三者同时在场才构成「测试缝」；生产路径（lib 内除本模块自身外）零引用，由
 *   test/silence-watchdog.test.mjs 的静态锁守住。
 * @internal 仅测试使用；不属于插件对外契约，可随时改名/删除。
 */
export function __resetArchiveChannelForTest() {
  archiveBuffer.length = 0
  archiveDrained = false
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
