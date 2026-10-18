/**
 * subagent-dispatch.mjs — 子代理派发的**单一入口**（批 37 / 设计档 2026-10-16-task-ledger-design.md §二十）。
 *
 * 背景（2026-10-18 父侧读平台源码 + 本批实测）：
 *   · DSH `0.2.1-rc.2` **移除了** `ctx.subagents.start(kind, opts)`（`SubagentRuntime` 只剩
 *     `startActivation` / `getProvider` / `prepareContinuable`）。
 *   · 但**不是**「provider 层一律还有 Promise 句柄」：实测 `spawn` provider（装机
 *     `@deepseek-ai/dsh-subagent-spawn-in-process@0.2.1-rc.2`）**没有 `start`**，只有
 *     `prepareContinuable()`；它的 Promise 面在 `startActivation(...)` 的 receipt 上
 *     （`{ childId, result, dispose }` —— 与旧 run 句柄同形，`result` 解 `{ output, stopReason }`）。
 *   · 外部 provider（如 `codex`）仍实现可选 `start?(request)`，但 0.2.1 的
 *     `startActivation` 会替调用方解析 cwd / 校验能力再调它——所以**新宿主优先走
 *     `startActivation`**，裸 `provider.start` 只作没有发布面时的兜底。
 *
 * 三档回退（顺序即证据顺序）：
 *   ① `getProvider(kind)` 拿得到 provider（有 `start` 或 `prepareContinuable`）且
 *      `ctx.subagents.startActivation` 是函数 ⇒ `startActivation`（0.2.1 起的发布面，本地/外部统一）；
 *   ② 只有老宿主 `ctx.subagents.start(kind, request)` ⇒ 原样回退（0.1.x：内含 descriptor / 能力校验）；
 *   ③ 只有裸 `provider.start(request)`（宿主既无 `startActivation` 也无 `start`）⇒ 直接调用；
 *   ④ 三档都没有 ⇒ 抛**可读错误**（含 `getProvider` 与 `subagents.start` 字样 + 「宿主子代理契约断层」），
 *      绝不把裸 `TypeError` 当文案。
 *
 * 组合字段（`persona` / `toolFilter`）的安全语义：
 *   · 0.2.1 的 `SubagentStartRequest` / `SubagentActivationSpec.request` **不含**这两个字段
 *     （本批运行时读 `typert.host.js` 的声明字符串实证），`startLocal` 只组合 `agentPreset`；
 *     `SubagentCapabilities` 也只有 `agentOptions/agentPreset/outputSchema/depthLimit`。
 *   · 因此本助手默认 **fail-closed**：请求里出现 `persona` / `toolFilter` 而当前路线不声明支持
 *     ⇒ 抛错（除非调用方显式传 `allowUnsupportedComposition: true` 表示「我知道并接受降级」）。
 *   · caller 侧的只读/禁名单保证（consult / escalate）必须在派发**之前**用
 *     `subagentDispatchSupport().toolFilter` 判，拿不到就拒绝运行（见两档实现）。
 *
 * @module subagent-dispatch
 */

/** 契约断层的统一标识（可读错误与测试都按它断言）。 */
export const SUBAGENT_CONTRACT_GAP = "宿主子代理契约断层"

/** 可读错误里的三档指引（同时含 getProvider 与 subagents.start，测试按这两个词断言）。 */
const CONTRACT_GAP_HINT = "新宿主需 ctx.subagents.getProvider(name).start(request) 或 "
  + "getProvider(name).prepareContinuable + ctx.subagents.startActivation；老宿主需 ctx.subagents.start(name, request)"

/** 组装契约断层的可读错误文案（绝不裸崩）。 */
function contractGapMessage(kind, detail) {
  return "[thincoder-suite] " + SUBAGENT_CONTRACT_GAP + "：无法派发子代理（provider \""
    + String(kind) + "\"）——" + CONTRACT_GAP_HINT + "；"
    + (detail ? String(detail) + "；" : "")
    + "三档均不可用 ⇒ 拒绝派发（fail-closed）"
}

/** 取 `ctx.subagents` 服务（缺省/畸形 ⇒ null）。 */
function subagentService(ctx) {
  const svc = ctx && typeof ctx === "object" ? ctx.subagents : undefined
  if (svc === undefined || svc === null) return null
  return (typeof svc === "object" || typeof svc === "function") ? svc : null
}

/** 安全地读 provider（`getProvider` 不存在/抛错 ⇒ undefined，由断层文案兜底）。 */
function providerOf(svc, kind) {
  if (!svc || typeof svc.getProvider !== "function") return undefined
  try { return svc.getProvider(kind) } catch { return undefined }
}

/**
 * 解析一次派发应走哪一档（**只读**，不派发）。
 * @param {object|null|undefined} ctx 插件上下文（只读 `ctx.subagents`）
 * @param {string} kind provider 名（`"spawn"` / `"codex"` …）
 * @returns {{route: "startActivation"|"legacy.start"|"provider.start"|null, provider: object|null, reason: string|null}}
 *   `route:null` ⇒ 契约断层，`reason` 是可读归因（会拼进 `dispatchSubagent` 的错误）。
 */
export function resolveSubagentRoute(ctx, kind) {
  const svc = subagentService(ctx)
  if (!svc) {
    return { route: null, provider: null, reason: "ctx.subagents 服务缺失（宿主既无 getProvider 也无 subagents.start）" }
  }
  const provider = providerOf(svc, kind)
  const providerStartable = provider !== undefined && typeof provider.start === "function"
  const providerContinuable = provider !== undefined && typeof provider.prepareContinuable === "function"
  // ① 0.2.1 起的发布面：startActivation（本地/外部统一；返回 {childId,result,dispose}）
  if (provider !== undefined && (providerStartable || providerContinuable)
    && typeof svc.startActivation === "function") {
    return { route: "startActivation", provider, reason: null }
  }
  // ② 老宿主的发布面：subagents.start(kind, request)（0.1.x 内含 descriptor / 能力校验）
  if (typeof svc.start === "function") return { route: "legacy.start", provider: provider ?? null, reason: null }
  // ③ 只有裸 provider.start：仍可救（但调用方需自行承担 cwd / 描述面缺失）
  if (providerStartable) return { route: "provider.start", provider, reason: null }
  // ④ 断层
  const detail = typeof svc.getProvider !== "function"
    ? "ctx.subagents.getProvider 不是函数"
    : (provider === undefined
      ? "getProvider(\"" + String(kind) + "\") 未返回 provider"
      : "provider 的 start / prepareContinuable 都不是函数")
  return { route: null, provider: null, reason: detail }
}

/** 由 route 解析结果派生能力判据（单一实现；`subagentDispatchSupport` 与派发共用）。 */
function supportOf(resolved) {
  if (resolved.route === null) {
    return { ...resolved, dispatchable: false, toolFilter: false, persona: false }
  }
  // 老宿主 `subagents.start`：0.1.x 的 provider 契约声明并应用 persona/toolFilter（spawn provider
  // capabilities = { toolFilter: true, persona: true }），故按**契约**记为遵守。
  if (resolved.route === "legacy.start") {
    return { ...resolved, dispatchable: true, toolFilter: true, persona: true }
  }
  // 0.2.1 的 `startActivation` 路线：`SubagentStartRequest` / `ActivationSpec.request` 不含这两个
  // 字段，本助手的适配层也**剥离**它们 ⇒ 无论能力位怎么写，本路线都**不遵守**（不猜、不降级放行）。
  if (resolved.route === "startActivation") {
    return { ...resolved, dispatchable: true, toolFilter: false, persona: false }
  }
  // 裸 provider.start：能力位来自 provider 自己的 capabilities 声明（0.1.x 的 spawn provider
  // 声明 toolFilter/persona=true；0.2.1 的 SubagentCapabilities 没有这两项 ⇒ 恒 false）。
  const caps = resolved.provider && resolved.provider.capabilities ? resolved.provider.capabilities : null
  return {
    ...resolved,
    dispatchable: true,
    toolFilter: caps !== null && caps.toolFilter === true,
    persona: caps !== null && caps.persona === true,
  }
}

/**
 * 派发前的**能力判据**（不派发、不抛）：route 是否可派，以及 `persona` / `toolFilter` 是否被该路线遵守。
 * @param {object|null|undefined} ctx 插件上下文
 * @param {string} kind provider 名
 * @returns {{route: string|null, provider: object|null, reason: string|null, dispatchable: boolean,
 *   toolFilter: boolean, persona: boolean}}
 */
export function subagentDispatchSupport(ctx, kind) {
  return supportOf(resolveSubagentRoute(ctx, kind))
}

/** 是否至少有一条可派路线（供后台派发前的服务可用性守卫用；不判别组合字段）。 */
export function subagentDispatchAvailable(ctx, kind) {
  return subagentDispatchSupport(ctx, kind).dispatchable
}

/** 请求里是否**实质**带了组合字段（值为 undefined 视同没带）。 */
function wantsComposition(request) {
  return request.persona !== undefined || request.toolFilter !== undefined
}

/** 从请求里剥掉新契约不接受的组合字段 + label/signal（`startActivation` 把它们放在 spec 顶层）。 */
function activationRequestOf(request) {
  const out = { ...request }
  delete out.label
  delete out.signal
  delete out.persona
  delete out.toolFilter
  return out
}

/**
 * 把 `startActivation` 的 receipt 适配成旧 run 句柄（`{ id, result, dispose }`）：
 * `id` ← `childId`（eng 的 seq 主腿 / consult 的落盘取证都按 `run.id` 读）；
 * `localAgent` 尽力从 `ctx.agents.get(childId)` 取（本地 provider 才有；取不到不伪造）。
 */
function adaptActivationReceipt(ctx, receipt) {
  if (!receipt || typeof receipt !== "object") return receipt
  const childId = typeof receipt.childId === "string" && receipt.childId !== "" ? receipt.childId : null
  if (childId === null) return receipt
  const out = { ...receipt, id: childId }
  if (out.localAgent === undefined) {
    try {
      const agents = ctx && typeof ctx === "object" ? ctx.agents : undefined
      if (agents && typeof agents.get === "function") {
        const live = agents.get(childId)
        if (live !== undefined && live !== null) out.localAgent = live
      }
    } catch { /* 读不到就不暴露（不伪造 localAgent） */ }
  }
  return out
}

/** 0.2.1 发布面：`startActivation({ provider, label, request, signal, delivery })` → 适配后的 run 句柄。 */
async function startViaActivation(ctx, kind, request) {
  const svc = subagentService(ctx)
  if (!svc || typeof svc.startActivation !== "function") {
    throw new Error(contractGapMessage(kind, "ctx.subagents.startActivation 在解析后被移除"))
  }
  const label = typeof request.label === "string" && request.label.trim() !== "" ? request.label : String(kind)
  const rawSignal = request.signal
  const signal = rawSignal && typeof rawSignal === "object" && typeof rawSignal.addEventListener === "function"
    ? rawSignal
    : new AbortController().signal
  const receipt = await svc.startActivation({
    provider: kind,
    label,
    request: activationRequestOf(request),
    signal,
    // `delivery: "caller"` = 结果只回调用方、不向父会话插「子代理已结算」通知——
    // 与旧 `subagents.start` 的一次性 await 语义一致（四个调用点都在等 `run.result`）。
    delivery: "caller",
  })
  return adaptActivationReceipt(ctx, receipt)
}

/**
 * **唯一派发入口**：按宿主契约选档并把请求送出去，返回旧式 run 句柄（`{ id, result, dispose }`）。
 *
 * @pre   `request` 是对象；`parent` / `prompt` / `signal` 等既有字段**原样透传**（本助手不改写值）。
 * @pre   带 `persona` / `toolFilter` 时，当前路线必须声明支持二者——否则默认抛错（fail-closed）；
 *        调用方显式传 `options.allowUnsupportedComposition === true` 才允许剥离后继续（必须自行留痕）。
 * @post  成功 ⇒ 返回带 `result`（Promise<{output, stopReason}>）与 `dispose()` 的句柄。
 * @post  失败 ⇒ 抛 Error；契约断层时文案含 `getProvider` 与 `subagents.start`，**不含**裸 TypeError 文案。
 * @param {object|null|undefined} ctx 插件上下文（只读 `ctx.subagents` / `ctx.agents`）
 * @param {string} kind provider 名
 * @param {object} request 子代理请求（旧口径字段）
 * @param {{allowUnsupportedComposition?: boolean}} [options] 组合字段降级的显式授权
 * @returns {Promise<{id?: string, childId?: string, result: Promise<object>, dispose?: Function}>}
 */
export async function dispatchSubagent(ctx, kind, request, options) {
  const req = request && typeof request === "object" ? request : {}
  const resolved = resolveSubagentRoute(ctx, kind)
  if (resolved.route === null) throw new Error(contractGapMessage(kind, resolved.reason))

  const support = supportOf(resolved)
  if (wantsComposition(req) && (!support.persona || !support.toolFilter)) {
    const dropped = [req.persona !== undefined ? "persona" : null, req.toolFilter !== undefined ? "toolFilter" : null]
      .filter(Boolean).join(" / ")
    if (options && options.allowUnsupportedComposition === true) {
      // 显式降级：只 warn、不静默（调用方通常还会自己再发一条带名域来源的告警）。
      console.warn("[thincoder-suite] 子代理派发降级：provider \"" + String(kind) + "\" 的当前路线（"
        + resolved.route + "）不遵守 " + dropped + " —— 已按调用方显式授权剥离后派发（S2 由 Agent Preset 补位）")
    } else {
      throw new Error("[thincoder-suite] 子代理派发被拒：provider \"" + String(kind) + "\" 的当前路线（"
        + resolved.route + "）不遵守 " + dropped + " —— 无法保证组合面（persona / 工具面），拒绝派发（fail-closed）")
    }
  }

  if (resolved.route === "startActivation") return startViaActivation(ctx, kind, req)
  if (resolved.route === "legacy.start") return ctx.subagents.start(kind, req)
  return resolved.provider.start(req)
}
