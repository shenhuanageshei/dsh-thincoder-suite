// abort-provenance.mjs — 死亡溯源的**唯一词汇表**（批 6 / FR-AP1–FR-AP6）。
//
// 目的：让每一次 abort/超时死亡自证来源——「哪一层按下的（provider / agent / settle）+ 因为什么
// （user / timeout / cancel / stop / unknown）」——在一次工具返回里可判。本模块**无状态、无 IO**：
// 只做「结构化标注 → 可读死亡行 / 机器短标签」的纯变换；**不改 abort 机制本体**（何时 abort、
// 谁有权 abort 零改动，见设计档 §8.1）。
//
// 词汇表权威（N-3）：TRIGGERS(5) / LAYERS(4) **只在本文件定义**；其他文件一律 import，
// 禁止字面复制第二套 trigger/layer 值集。
//
// ————————————— 实测表（实施首步 `grep` 校准，批 6 开工时 as-of 批 5 交付后）—————————————
//
// A. 裸无参 abort 写点（无参调用 = 写点在源头就丢了「谁按下的」）**实测集合 = 5 处**。
//    ⚠ 下表以 `<无参>` 占位标记无参实参——**刻意不复现无参调用的连续字面**（`.abort` 紧接
//    空实参括号），否则本注释自身会命中 AC-AP7 的裸写点灭绝判据（该 grep 实测集 = 0）：
//    ① lib/consult.mjs:122   const forward = (reason) => { try { ctrl.abort(<无参>) } … }  （会话看门狗 forward）
//    ② lib/consult.mjs:325   for (const c of s.controllers) { try { c.abort(<无参>) } … }  （stopConsultSession）
//    ③ lib/consult.mjs:333   for (const c of s.controllers ?? []) { try { c.abort(<无参>) } … }（cleanupConsultSessions）
//    ④ lib/eng.mjs:773       const forwardSignal = () => { try { dshCtrl.abort(<无参>) } … }  （父信号中继）
//    ⑤ lib/escalate.mjs:554  const forwardSignal = () => { try { dshCtrl.abort(<无参>) } … }  （父信号中继）
//    ⚠ 与设计档 §12 #9 的点名清单**不一致**：其 ⑤「advisor.mjs job 派发侧的 forwardSignal 等价物」
//    **实测不存在**——advisor.mjs 的 `.abort(` 写点全部带参（:1275 abortWith(err) / :2208 :2380
//    cancel(reason) / :2323 兜底 Error）。基数 5 与文档相同、**集合不同**：以本表（实测）为准。
//
// B. 带参写点的 reason **实际形状**（批 6 之前全部是普通 Error 或平台传入值，**无一带机器标记**）：
//    advisor.mjs:1275   wd.abort(deadlineError() | stallError())
//                       → Error{name:"Error", message:"advisor review deadline reached after {N}s
//                         (review budget exhausted)" | "llm call stalled {N}s without a chunk …"}
//    advisor.mjs:2323   ctrl.abort(new Error("dsh background backstop deadline reached"))
//    eng.mjs:707        ctrl.abort(new Error("eng dsh background backstop deadline reached"))
//    eng.mjs:770        dshCtrl.abort(new Error("eng_coder dsh subagent deadline reached"))
//    escalate.mjs:451   ctrl.abort(new Error("escalate dsh background backstop deadline reached"))
//    escalate.mjs:551   dshCtrl.abort(new Error("escalate dsh subagent deadline reached"))
//    **六处** `cancel: (reason) => { try { ctrl.abort(reason) } … }`（批 6 修复轮审计 #6 订正计数：
//    旧注写「三处」，实测 **6 处**）——reason 由平台 hooks.cancel 传入，形状**不由我方定义**
//    （不能假设它带任何标记）：
//      ① lib/advisor.mjs  codex job 派发 ② lib/advisor.mjs  dsh job 派发
//      ③ lib/eng.mjs      codex 后台 job    ④ lib/eng.mjs      dsh 后台 job
//      ⑤ lib/escalate.mjs codex 后台 job    ⑥ lib/escalate.mjs dsh 后台 job
//    ⇒ 这六个面收到的是**未打标**的宿主 reason；按 D-AP3 / §5.1 图 1 W2 该面归
//    `cancel@settle`（宿主结算面），由 `hostAbortInfo` 在结算侧定性（见下方导出）。
//    `grep 'abortInfo|abortTrigger|interrupt ===' lib/` 在批 6 之前 = **零命中**：设计档 §6 预期的
//    三种 reason 形状（`r.abortInfo.trigger` / `r.interrupt === true` / `r.abortTrigger`）是**本批
//    新引入的生产者形状，不是既有证据** → `triggerOf` 必须对形状不匹配显式回落 `unknown`
//    （显式告警态；**绝不静默猜因、绝不静默回落成通用文案**，D-AP2 / P-c）。
//
// ————————————— 导出前置/后置条件（§12 #7）—————————————
//
//  triggerOf(signal)        前置：signal 可为 undefined/null/非 AbortSignal（不做类型断言）。
//                           后置：返回 {trigger, detail}；trigger ∈ TRIGGERS ∪ {null}
//                                 （null 只出现在「signal 未中止且无 reason」），detail 为 string。
//  hostAbortInfo(signal)     前置：signal 可为 undefined/null。后置：命中宿主面（已中止 ∧ reason
//                                 未带我方标注）→ `{trigger:"cancel", layer:"settle"}`；否则 null。
//  hostAbortSource(signal, detail)
//                           前置：signal 可为 undefined/null。后置：命中宿主面 → 携带
//                                 `abortInfo={cancel, settle, detail}` 的 AbortError；否则 **null**。
//  abortError(signal, layer, detail, trigger="cancel")
//                           前置：signal 可为 null（无信号写点）；layer/detail 任意字符串。
//                           后置：返回 name==="AbortError"、abortInfo={trigger,layer,detail} 的 Error；
//                                 message === detail（detail 为空 → "aborted"）。
//  timeoutError(message, layer, detail)
//                           前置：message 可为任意值。后置：返回 name==="TimeoutError"、
//                                 abortInfo.trigger==="timeout" 的 Error；message 逐字 = String(message)。
//  annotateAbort(err, source, layerHint, detail)
//                           前置：err 为对象（非对象 → 包成 Error）。source 可为 AbortSignal 或
//                                 携带 abortInfo 的错误对象或 null。
//                           后置：err.abortInfo 就位（trigger/layer/detail 均已归一）并返回**同一** err。
//                                 注意：本函数**无条件**标注——只应在「已确认是 abort 死亡」的站点调用。
//  deathLine(err, signal, layerHint)
//                           前置：err 可为 Error 或字符串（字符串取其本身为原 message）。signal 可缺省。
//                                 layerHint 为可选第三参：信号无标注时用它定位层（如宿主面 "settle"）。
//                           后置：无标注且非 Abort/TimeoutError → **逐字返回原 message**（零改动）；
//                                 否则返回 `<原 message 逐字>[ ← cause: …][ · abort(trigger@layer[: detail])]`，
//                                 总长 ≤ 300（截断顺序见下）。**前缀逐字保留**（startsWith 判定族依赖）。
//  abortTag(err, signal, layerHint)
//                           前置：同 deathLine。后置：中止类 → `abort(trigger@layer)`（D-AP6 机器短标签，
//                                 不含 detail——它是通知一行的指针）；非中止类 → **null**（调用方保持原 detail）。
//
//  截断顺序（§12 #8，钉死）：**先截 detail（120 → 必要时 60/24/0）→ 再拼装 cause 与 tag →
//  最后整体兜底 `.slice(0, 300)`**——防止整体截断砍进 message 本体或砍断 tag 中段。
//
//  幂等性：对「无 abortInfo 且非 Abort/TimeoutError」的输入，deathLine 逐字返回原 message；
//  对返回值（字符串）再次调用结果不变（字符串既无 abortInfo 也非 Abort/Timeout 名）。

/** 触发源词汇表（5 值，顺序即断言面；`unknown` 是**显式告警态**，不是兜底噪音）。 */
export const TRIGGERS = ["user", "timeout", "cancel", "stop", "unknown"]

/** 层词汇表（4 值）：provider=适配器/CLI 自产的错误面 · agent=我方自持定时器/中继 ·
 *  settle=宿主面（exec.signal abort、job kill → cancel 回调）· unrecorded=无标注。 */
export const LAYERS = ["provider", "agent", "settle", "unrecorded"]

/** 死亡行总长上限（D-AP5）。 */
export const DEATH_LINE_MAX = 300

/** abort 后缀内 detail 的基准截断长度（§12 #8）。 */
export const ABORT_DETAIL_MAX = 120

const ABORT_NAMES = ["AbortError", "TimeoutError"]

const pickTrigger = (v) => (TRIGGERS.includes(v) ? v : "unknown")
const pickLayer = (v) => (LAYERS.includes(v) ? v : "unrecorded")
const str = (v) => (v == null ? "" : String(v))

/**
 * 从信号读触发源（Node ≥17.2 的 `signal.reason` 标准面——**不读 message 文本**，D-AP7）。
 *
 * 前置：signal 可为 undefined/null/非 AbortSignal（不做类型断言）。
 * 后置：`{trigger, detail}`——trigger ∈ TRIGGERS ∪ {null}（null 只出现在「未中止且无 reason」）；
 *      形状不匹配 → `unknown`（显式告警态；见头部实测表 B：预期的 reason 形状是本批新引入的，
 *      存量写点一律不带标记，必须显式归不了因）。
 * @param {AbortSignal|undefined|null} signal
 * @returns {{trigger: string|null, detail: string}}
 */
export function triggerOf(signal) {
  const r = signal?.reason
  if (!r) return { trigger: signal?.aborted ? "unknown" : null, detail: "no reason on signal" }
  if (r.abortInfo?.trigger) {
    return TRIGGERS.includes(r.abortInfo.trigger)
      ? { trigger: r.abortInfo.trigger, detail: str(r.abortInfo.detail) }
      : { trigger: "unknown", detail: "unrecognized abortInfo.trigger: " + str(r.abortInfo.trigger).slice(0, 60) }
  }
  if (r.interrupt === true) return { trigger: "user", detail: "caller interrupt" }
  if (r.name === "TimeoutError" || r.abortTrigger === "timeout") return { trigger: "timeout", detail: "" }
  if (r.abortTrigger === "cancel") return { trigger: "cancel", detail: "" }
  if (r.abortTrigger === "stop") return { trigger: "stop", detail: "" }
  return { trigger: "unknown", detail: String(r.message ?? r).slice(0, 80) }
}

/**
 * 宿主面（settle）归因判定——D-AP3 / §5.1 图 1 W2（批 6 修复轮审计 #3）。
 *
 * 判据是**形状**而非文本：job 的 `hooks.cancel(reason)` 把**平台形状**的 reason 原样 abort 到
 * job 控制器上（头部实测表 A 的六处 cancel 回调），而**我方自持写点**（backstop / budgetCap /
 * 看门狗 / per-call deadline 定时器 / forwardSignal 中继）一律带 `abortInfo` 标注 ⇒
 * 「控制器已中止 ∧ reason **未**带我方标注」只可能是宿主面。归 `settle` 层不可能是 `agent`：
 * 宿主 job kill 不是「我方自持控制器点火」，D-AP3 把它的映射钉死为 settle。
 *
 * 前置：signal 可为 undefined/null（不做类型断言）。
 * 后置：命中宿主面 → `{trigger:"cancel", layer:"settle"}`（图 1 W2 的 `用户/job cancel → cancel`）；
 *      未命中（signal 未中止，或 reason 自带我方 `abortInfo`）→ **null**（调用方走既有归因，零改动）。
 * @param {AbortSignal|undefined|null} signal
 * @returns {{trigger: string, layer: string}|null}
 */
export function hostAbortInfo(signal) {
  if (!signal?.aborted) return null
  const r = signal.reason
  if (r && typeof r === "object" && r.abortInfo) return null // 我方自持写点：交给既有归因
  return { trigger: "cancel", layer: "settle" }
}

/**
 * 宿主面归因**源**：命中宿主面（见 `hostAbortInfo`）时返回一个携带 `abortInfo` 的合成源，
 * 供 `abortTag` / `deathLine` / `annotateAbort` 直接消费（层/触发 = `cancel@settle`）；
 * 未命中宿主面 → **null**（调用方保持既有源，零改动）。
 *
 * ⚠ 只改**归因源**，不改被中止信号自身的 `reason`（宿主载荷原样留在 `signal.reason` 上，
 * 不替换、不包装——不触碰机制本体的任何语义）。
 *
 * 前置：signal 可为 undefined/null；detail 可为任意字符串。
 * 后置：null 或 一个 `name==="AbortError"`、`abortInfo={trigger:"cancel", layer:"settle", detail}` 的 Error。
 * @param {AbortSignal|undefined|null} signal
 * @param {string} [detail]
 * @returns {Error|null}
 */
export function hostAbortSource(signal, detail = "host job cancel") {
  const host = hostAbortInfo(signal)
  if (!host) return null
  const err = new Error(str(detail))
  err.name = "AbortError"
  err.abortInfo = { trigger: host.trigger, layer: host.layer, detail: str(detail) }
  return err
}

/**
 * 造一个带溯源载荷的 abort 原因（写点只加载荷，不改触发条件/时长——§8.1）。
 * trigger 取信号可读到的因；信号读不到（null / 未中止 / 形状不匹配）→ 用 `trigger` 实参；
 * 再不行 → `unknown`（显式）。
 *
 * 前置：signal 可为 null。后置：name==="AbortError"、abortInfo 就位的 Error（message = detail）。
 * @param {AbortSignal|null|undefined} signal
 * @param {string} layer 见 LAYERS
 * @param {string} detail
 * @param {string} [trigger]
 * @returns {Error}
 */
export function abortError(signal, layer, detail, trigger = "cancel") {
  const fromSignal = signal ? triggerOf(signal).trigger : null
  const t = TRIGGERS.includes(fromSignal) ? fromSignal : pickTrigger(trigger)
  const d = str(detail)
  const err = new Error(d || "aborted")
  err.name = "AbortError"
  err.abortInfo = { trigger: t, layer: pickLayer(layer), detail: d }
  return err
}

/**
 * 造一个超时原因（我方自持定时器：backstop / budgetCap / 看门狗 / per-call deadline——
 * §12 #3 一律 `agent` 层；`provider` 只留给适配器与 CLI 自产的错误面）。
 *
 * 前置：message 任意。后置：name==="TimeoutError"、abortInfo.trigger==="timeout" 的 Error。
 * @param {string} message
 * @param {string} layer
 * @param {string} detail
 * @returns {Error}
 */
export function timeoutError(message, layer, detail) {
  const err = new Error(str(message) || "timeout")
  err.name = "TimeoutError"
  err.abortInfo = { trigger: "timeout", layer: pickLayer(layer), detail: str(detail) }
  return err
}

/** 归因信息归一（内部）：按 `err.abortInfo` → `source.abortInfo` → `source.reason.abortInfo`
 *  → `source.aborted`（触发源可从信号读出、层取 layerHint）→ Abort/Timeout 名（显式 unknown）
 *  的顺序取第一个命中；全不命中 → null（= 非中止形态，死亡行零改动）。 */
function infoOf(err, source, layerHint) {
  for (const c of [err, source, source?.reason]) {
    const info = (c && typeof c === "object") ? c.abortInfo : null
    if (info) {
      return { trigger: pickTrigger(info.trigger), layer: pickLayer(info.layer), detail: str(info.detail) }
    }
  }
  if (source?.aborted) {
    const t = triggerOf(source)
    return { trigger: pickTrigger(t.trigger), layer: pickLayer(layerHint), detail: str(t.detail) }
  }
  if (ABORT_NAMES.includes(err?.name) || ABORT_NAMES.includes(source?.name)) {
    return { trigger: "unknown", layer: pickLayer(layerHint), detail: "" }
  }
  return null
}

/**
 * 标注错误对象（结算侧/抛错侧：把「谁按下的」贴上错误，供 deathLine 合成）。
 *
 * ⚠ **无条件标注**——只应在已确认是 abort 死亡的站点调用；非中止错误调用它会凭空造出后缀。
 *
 * 前置：err 为对象（非对象 → 包成 Error）；source 可为 AbortSignal / 携带 abortInfo 的错误 / null。
 * 后置：err.abortInfo = {trigger, layer, detail} 就位，返回**同一** err 引用。
 * @param {object|string} err
 * @param {AbortSignal|Error|null|undefined} source
 * @param {string} layerHint
 * @param {string} [detail]
 * @returns {object}
 */
export function annotateAbort(err, source, layerHint, detail) {
  const target = (err && typeof err === "object") ? err : new Error(str(err))
  const info = infoOf(null, source, layerHint)
  target.abortInfo = info
    ? { trigger: info.trigger, layer: info.layer, detail: info.detail !== "" ? info.detail : str(detail) }
    : { trigger: "unknown", layer: pickLayer(layerHint), detail: str(detail) }
  return target
}

/** 合成 abort 后缀（内部）：先截 detail，再拼 tag（§12 #8 的截断顺序前半段）。 */
function makeTag(trigger, layer, detail, dLen) {
  const d = detail.slice(0, dLen)
  return " · abort(" + trigger + "@" + layer + (d ? ": " + d : "") + ")"
}

/**
 * 死亡行合成器（D-AP5；人可读面 = 工具返回 / job output 尾部）。
 *
 * 前置：err 为 Error 或字符串（字符串取其本身）；signal 可缺省；layerHint 可选。
 * 后置：无标注且非 Abort/TimeoutError → 原 message **逐字**返回（零改动）；
 *      否则 `<原 message>[ ← cause: …][ · abort(<trigger>@<layer>[: <detail>])]`，总长 ≤ 300。
 *      **原 message 前缀逐字保留**（`startsWith("Advisor:")` / `eng_coder aborted.` /
 *      `escalate (…) aborted.` 判定族依赖——只追加，绝不替换）。
 *      幂等：对无标注输入反复调用结果不变。
 * @param {{message?: string, name?: string, abortInfo?: object, cause?: object}|string} err
 * @param {AbortSignal|Error|null} [signal]
 * @param {string} [layerHint]
 * @returns {string}
 */
export function deathLine(err, signal, layerHint) {
  const raw = (err != null && typeof err === "object" && err.message !== undefined)
    ? String(err.message)
    : str(err)
  const info = infoOf(err, signal, layerHint)
  if (!info) return raw
  const detail = str(info.detail)
  const causeRaw = (err && typeof err === "object" && typeof err.cause?.message === "string")
    ? err.cause.message : ""
  // 截断顺序（§12 #8）：detail 逐级缩短 → cause 只在装得下时才拼 → 最后整体兜底 300。
  for (const dLen of [ABORT_DETAIL_MAX, 60, 24, 0]) {
    const tag = makeTag(info.trigger, info.layer, detail, dLen)
    const cause = (causeRaw !== "" && raw.length + causeRaw.slice(0, ABORT_DETAIL_MAX).length + tag.length + 12 <= DEATH_LINE_MAX)
      ? " ← cause: " + causeRaw.slice(0, ABORT_DETAIL_MAX)
      : ""
    const line = raw + cause + tag
    if (line.length <= DEATH_LINE_MAX || dLen === 0) return line.slice(0, DEATH_LINE_MAX)
  }
}

/**
 * 机器短标签（D-AP6）：进 `detail` 字段的**通知一行指针**——保持短（不含 detail）。
 *
 * 前置：同 deathLine。后置：中止类 → `abort(<trigger>@<layer>)`；**非中止类 → null**
 *       （调用方据此保留原 detail，正常失败零污染）。
 * @param {{message?: string, name?: string, abortInfo?: object}|string} err
 * @param {AbortSignal|Error|null} [signal]
 * @param {string} [layerHint]
 * @returns {string|null}
 */
export function abortTag(err, signal, layerHint) {
  const info = infoOf(err, signal, layerHint)
  if (!info) return null
  return "abort(" + info.trigger + "@" + info.layer + ")"
}
