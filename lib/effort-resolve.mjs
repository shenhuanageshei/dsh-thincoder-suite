// effort-resolve.mjs — reasoningEffort 按目标模型实际支持档位校验/回落（共享 helper）。
// 背景（用户反馈 2026-09-04）：eng_coder 三连败零产出——engCoderEffort "low" 对
// glm-5.3-flash 不受支持（reasoningEfforts 仅 off/high/max），pi-ai
// resolveReasoningLevel 抛 UNSUPPORTED_REASONING_EFFORT → 子代理首次 LLM 调用即死。
// 此前只校验静态枚举（off|low|medium|high|max），不查目标模型实际档位——四个 effort
// 消费点（eng_coder / advisor dsh 循环 / 智能回落轮 / consult 子代理）同病同修。
// 语义：requested 受支持 → 原样；不受支持 → 回落模型 defaultEffort；无 default → null
// （调用方不传 reasoningEffort = 用提供方默认）。元数据不可得 → 原样透传（fail-open：
// 运行时有明确的 UNSUPPORTED_REASONING_EFFORT 错误面，不会无声错档）。

/**
 * @param {object|undefined} llm — ctx.llm 运行时服务（resolveModelInfo 可缺省→透传）
 * @param {string|undefined} provider — 目标 provider 路由键
 * @param {string|undefined} model — 目标模型 id
 * @param {string|undefined} requested — 请求的 effort（off 表示"关闭推理"，原样透传）
 * @returns {Promise<{effort: string|null, note: string|null}>}
 *          effort=null 表示调用方应省略 reasoningEffort（用提供方默认）；
 *          note 非空 = 发生了回落，调用方应把告警带进结果尾部（附录 D.3 规则）。
 */
export async function resolveSupportedEffort(llm, provider, model, requested) {
  if (!requested || requested === "off") return { effort: requested ?? null, note: null }
  try {
    if (llm && typeof llm.resolveModelInfo === "function" && provider && model) {
      const info = await llm.resolveModelInfo(provider, model)
      const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts)
        ? info.reasoning.efforts.map((e) => (e && typeof e.id === "string" ? e.id : null)).filter(Boolean)
        : null
      if (efforts && efforts.length > 0 && !efforts.includes(requested)) {
        const fb = info.reasoning && typeof info.reasoning.defaultEffort === "string" ? info.reasoning.defaultEffort : null
        return {
          effort: fb,
          note: "effort " + JSON.stringify(requested) + " is not supported by model " + model
            + " (supported: " + efforts.join("|") + ") — falling back to " + (fb ?? "provider default"),
        }
      }
    }
  } catch { /* 元数据不可得 → 透传（fail-open，运行时错误面兜底） */ }
  return { effort: requested, note: null }
}
