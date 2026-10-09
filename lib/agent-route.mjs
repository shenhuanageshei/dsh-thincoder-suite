// agent-route.mjs — 批 32 / D-62：**活动路由（live route）的单一事实源**。
//
// 为什么要有这个模块（一句话）：`agent.options` 是**创建期**的选项快照，**不是**「这个会话现在
// 在用什么模型」；把前者当成后者，就会把子代理钉死在一条用户早已切换掉的旧通道上。
//
// 平台原文（`dsh-subagent/lib/index.js:406-424` 的 `parentAgentOptionsForDelegation` 及其 JSDoc）：
//   「The latest request header owns provider, model, and reasoning effort after request-time
//    selection; creation options remain the fallback before the first request and retain the
//    configured output-token limit.」
// ⇒ 两条可直接落地的规则：
//   ① **路由**（provider / model / reasoningEffort）= `agent.session.requestHeader()?.config`；
//      `agent.options` 只在**首次请求之前**（没有 request header）才代表路由；
//   ② **maxTokens（输出预算）**仍取**创建期选项**（平台同款：header 里的 maxTokens 不参与继承）。
//
// 真机事故（2026-10-09，本模块的直接由来）：父会话 `session-9fdfe32c…` 于 18:12:19 创建
//（创建期路由 = 部署默认 `minimax-cn/M3.1-Flash-Preview`），用户 18:12:29 把会话切到
// `deepseek-official/deepseek-flash`——此后该会话三次 eng_coder 派发都拿 `agent.options` 的
// **旧路由**显式覆写子代理（平台的 `resolveChildAgentOptions` 里 `requested` 覆盖继承面），
// 子代理于是跑在一条额度已耗尽的通道上：首次模型请求即 429，重试 5 次 ~19 秒后
// `turn/end.reason = RATE_LIMIT`，而报告面只剩 `eng_coder ended: error` + 空 partial。
// ⇒ 路由读取一律走本模块；**不得**再以 `agent.options` 充当「会话当前路由」。
//
// 读面形状（防御性，**永不抛**）：任何一步不可得 ⇒ 逐级回落，并在 `source` 里如实标注来源，
// 供证据行/诊断行自证「这个路由是从哪儿读来的」。

/** 空串与非字符串一律视为「读不到」（平台配置里 provider/model 只会是非空字符串）。 */
function asName(v) {
  return (typeof v === "string" && v !== "") ? v : null
}

/**
 * 读取一个代理的**活动路由**（会话当前在用的 provider/model/effort）+ 输出预算。
 * @param {object|null|undefined} agent Agent 对象（`deps.agent`——与派发处传给 `parent` 的同一对象）
 * @returns {{provider: string|null, model: string|null, reasoningEffort: string|null,
 *   maxTokens: number|null, source: "request-header"|"creation-options"|"none"}}
 *   `source`：路由三元组的**来源面**——`request-header` = 会话当前路由（平台权威面）；
 *   `creation-options` = 首次请求之前的创建期兜底（平台同款）；`none` = 两处都读不到。
 *   `maxTokens` **恒取创建期选项**（平台同款；与 `source` 无关）。
 */
export function liveAgentRoute(agent) {
  // ★ 交付评审 #2（0.30.1 修复轮）：`agent.options` 的属性读**也**包进 try——若某部署把它实现成
  //   抛错的 getter，本函数必须仍然满足「永不抛」（设计 §六 @post）；平台现形（普通属性）不可达，
  //   这里是与 `agent?.session` 同款的防御性加固。
  let created = {}
  try {
    const o = agent && agent.options
    created = (o && typeof o === "object") ? o : {}
  } catch { created = {} }
  let header = null
  try {
    const session = agent?.session
    if (session && typeof session.requestHeader === "function") {
      const h = session.requestHeader()
      header = (h && typeof h === "object" && h.config && typeof h.config === "object") ? h.config : null
    }
  } catch { header = null } // 读面抛错 ⇒ 退创建期兜底（取证面绝不成为新的失败源）
  const hp = asName(header?.provider)
  const hm = asName(header?.model)
  const cp = asName(created.provider)
  const cm = asName(created.model)
  // ★ 交付评审 #1（🟡，0.30.1 修复轮）：**整对语义**——只有 header 的 provider 与 model **两键都非空**
  //   才算「读到了活动路由」；单侧空串 ⇒ **整对**回落创建期选项。为什么不能逐键回落：那会产出
  //   「header 的 model ⊕ 创建期的 provider」这种**从未存在过**的跨源混搭对 —— ① 取证件会展示一条
  //   假路由；② 该对象喂给 advisor 兜底路由第 4 优先级时，会绕过 `resolveAdvisorRoute` 自己的
  //   「provider/model 成对、禁跨环混搭」纪律（`lib/advisor.mjs` 的 `isModelField` 整对采纳），
  //   把一个无效组合发给网关。effort 与路由对**同源**（不混源）。
  const fromHeader = hp !== null && hm !== null
  return {
    provider: fromHeader ? hp : cp,
    model: fromHeader ? hm : cm,
    reasoningEffort: fromHeader ? (asName(header?.reasoningEffort) ?? asName(created.reasoningEffort)) : asName(created.reasoningEffort),
    maxTokens: Number.isFinite(created.maxTokens) ? created.maxTokens : null,
    source: fromHeader ? "request-header" : ((cp !== null || cm !== null) ? "creation-options" : "none"),
  }
}

/**
 * 路由的单行标签（证据行/诊断行用；缺失面如实写「未定」，不编造）。
 * @param {ReturnType<typeof liveAgentRoute>|null|undefined} route
 * @returns {string} 形如 `deepseek-official/deepseek-flash（request-header）`
 */
export function routeLabel(route) {
  if (!route || typeof route !== "object") return "未定（读取面不可用）"
  const pair = (route.provider ?? "?") + "/" + (route.model ?? "?")
  const src = route.source === "request-header" ? "request-header"
    : (route.source === "creation-options" ? "creation-options（首次请求之前的兜底）" : "无读取面")
  return pair + "（" + src + "）"
}
