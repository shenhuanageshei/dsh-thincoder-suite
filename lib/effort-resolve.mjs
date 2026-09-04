// effort-resolve.mjs — effort 按目标模型实际支持档位校验/回落（L1 收口层，D-02/D-裁决-2）。
// 背景（用户反馈 2026-09-04）：eng_coder 三连败零产出——engCoderEffort "low" 对
// glm-5.3-flash 不受支持（reasoningEfforts 仅 off/high/max），pi-ai
// resolveReasoningLevel 抛 UNSUPPORTED_REASONING_EFFORT → 子代理首次 LLM 调用即死。
// 此前只校验静态枚举（off|low|medium|high|max），不查目标模型实际档位。
// 旧版头注释「四个 effort 消费点同病同修」与事实不符（consult/escalate 从未接线，
// 实际仅 3 处调用：eng dsh / advisor dsh 主路径 / advisor 回落轮）——R1 修正为下述真实接线。
//
// R1 接线全景（设计 §3.1，9 消费点 L1 全绿）：
// - dsh 侧 resolveSupportedEffort：advisor dsh 主路径 / advisor 智能回落轮 /
//   consult dsh 行（按行 provider+model）/ escalate dsh 行（同）/ eng dsh 分支（父代理路由）；
// - codex 侧 resolveCodexRowEffort（数据源 = discoverCodexModels catalog，非 llm.resolveModelInfo）：
//   advisor codex runner（resolveAdvisorRoute 输出 → buildCodexArgs 前）/ consult codex 行 /
//   escalate codex 行（首次 + followup 复用已解析 runner）/ eng codex 分支。
//
// 回落语义（D-裁决-2，2026-09-05）：最近支持档——档位序距离最近；等距 tie-break 向上取
// （DP-2 终裁：保推理质量，如 medium 缺失且 low/high 皆支持 → 取 high）。
// 指导原则（用户原话）：最重要的就是保证真正能用——元数据/目录不可得 → fail-open 原样透传
// + 响亮告警（console.warn + note），绝不因档位校验砖化。回落与透传都带 note（调用方把告警
// 带进结果尾部，附录 D.3 规则）。

import { discoverCodexModels } from "./codex-adapter.mjs"

/** dsh 侧档位序（pi-ai reasoning efforts）。 */
const DSH_EFFORT_LADDER = ["off", "low", "medium", "high", "max"]
/** codex 侧档位序（codex debug models supported_reasoning_levels 递增序；codex 无 off）。 */
const CODEX_EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"]

const WARN = (m) => console.warn("[thincoder-suite] " + m)

/**
 * 最近支持档：在 ladder 序上取与 requested 距离最近的受支持档；等距向上取（DP-2）。
 * requested 不在 ladder 或受支持档与 ladder 无交集 → null（无法映射，调用方 fail-open 透传）。
 */
function nearestEffort(requested, ladder, supported) {
  const ri = ladder.indexOf(requested)
  if (ri < 0) return null
  let best = null
  let bestIdx = -1
  let bestDist = Infinity
  for (const cand of supported) {
    const ci = ladder.indexOf(cand)
    if (ci < 0) continue
    const dist = Math.abs(ci - ri)
    if (dist < bestDist || (dist === bestDist && ci > bestIdx)) {
      best = cand
      bestIdx = ci
      bestDist = dist
    }
  }
  return best
}

/**
 * dsh 侧行 effort 校验/回落（数据源 = llm.resolveModelInfo 的 reasoning.efforts）。
 * @param {object|undefined} llm — ctx.llm 运行时服务（resolveModelInfo 可缺省 → fail-open 透传+告警）
 * @param {string|undefined} provider — 行自身 provider 路由键
 * @param {string|undefined} model — 行自身模型 id
 * @param {string|undefined} requested — 请求的 effort
 * @returns {Promise<{effort: string|null, note: string|null}>}
 *          effort=null 表示调用方应省略 reasoningEffort（用提供方默认）；
 *          note 非空 = 发生了回落或透传（元数据不可得），调用方应把告警带进结果尾部
 *          （附录 D.3 规则）+ 本函数已 console.warn 响亮留档。
 */
export async function resolveSupportedEffort(llm, provider, model, requested) {
  if (!requested) return { effort: requested ?? null, note: null }
  const passthrough = (note) => {
    WARN(note)
    return { effort: requested, note }
  }
  if (!llm || typeof llm.resolveModelInfo !== "function" || !provider || !model) {
    return passthrough("effort metadata unavailable ("
      + (!llm ? "llm runtime absent"
        : typeof llm.resolveModelInfo !== "function" ? "llm.resolveModelInfo not available"
          : "provider/model unknown (" + provider + ":" + model + ")")
      + ") — effort " + JSON.stringify(requested)
      + " passed through unverified (fail-open，运行时 UNSUPPORTED_REASONING_EFFORT 错误面兜底)")
  }
  let info
  try {
    info = await llm.resolveModelInfo(provider, model)
  } catch (e) {
    return passthrough("effort metadata lookup failed for " + provider + ":" + model + " ("
      + (e?.message ?? String(e)) + ") — effort " + JSON.stringify(requested)
      + " passed through unverified (fail-open)")
  }
  const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts)
    ? info.reasoning.efforts
      .map((e) => (e && typeof e.id === "string" ? e.id : (typeof e === "string" ? e : null)))
      .filter(Boolean)
    : null
  if (!efforts || efforts.length === 0) {
    return passthrough("no reasoning-effort metadata for model " + provider + ":" + model
      + " — effort " + JSON.stringify(requested) + " passed through unverified (fail-open)")
  }
  if (efforts.includes(requested)) return { effort: requested, note: null }
  const nearest = nearestEffort(requested, DSH_EFFORT_LADDER, efforts)
  if (nearest) {
    const note = "effort " + JSON.stringify(requested) + " is not supported by model " + model
      + " (supported: " + efforts.join("|") + ") — falling back to nearest supported effort "
      + JSON.stringify(nearest) + "（D-裁决-2 最近支持档，等距向上取）"
    WARN(note)
    return { effort: nearest, note }
  }
  return passthrough("effort " + JSON.stringify(requested) + " cannot be mapped for model " + model
    + " (supported: " + efforts.join("|") + " — 与已知档位序 off<low<medium<high<max 无交集) — passing through unverified (fail-open)")
}

/**
 * codex 侧行 effort 校验/回落（D-02 L1 收口；数据源 = discoverCodexModels catalog，
 * 审计判定点 ③：不是 llm.resolveModelInfo——codex 模型不经 llm-pi-ai 注册表）。
 * dsh 档位 → codex 档位：同名校验是否在模型 supported_reasoning_levels 内；不在 → 最近档
 * （同 tie-break 向上取）；off → null（不传，codex 无 off）；catalog 不可得 / 模型未命中 /
 * 模型未配置 → fail-open 透传 + 响亮告警。
 * @param {object} deps — 注入缝（spawn/platform/env，透传给 discoverCodexModels；单测假子进程）
 * @param {object} runner — codex runner 行（model/executable 为生效值；model 为空 = codex
 *        自身默认模型，无法按目录校验）
 * @param {string|undefined|null} requested — 请求的 effort（dsh 档位或 codex 档位）
 * @param {object|undefined} [globals] — resolveCodexCliGlobals 输出（executable/model 兜底来源）
 * @returns {Promise<{effort: string|null, note: string|null}>}
 */
export async function resolveCodexRowEffort(deps, runner, requested, globals) {
  if (!requested) return { effort: requested ?? null, note: null }
  if (requested === "off") return { effort: null, note: null } // codex 无 off —— 不传（用 codex 默认档）
  const passthrough = (note) => {
    WARN(note)
    return { effort: requested, note }
  }
  const model = typeof runner?.model === "string" && runner.model.trim() !== ""
    ? runner.model.trim()
    : (typeof globals?.model === "string" && globals.model.trim() !== "" ? globals.model.trim() : null)
  if (!model) {
    return passthrough("codex runner 未配置 model（用 codex 自身默认模型）——effort "
      + JSON.stringify(requested) + " 无法按目录校验，原样透传 (fail-open)")
  }
  const executable = typeof runner?.executable === "string" && runner.executable.trim() !== ""
    ? runner.executable.trim()
    : (typeof globals?.executable === "string" && globals.executable.trim() !== "" ? globals.executable.trim() : "codex")
  let cat
  try {
    cat = await discoverCodexModels(deps ?? {}, { executable })
  } catch (e) {
    cat = { ok: false, error: e?.message ?? String(e) }
  }
  if (!cat || cat.ok !== true || !Array.isArray(cat.models)) {
    return passthrough("codex 模型目录不可得（" + (cat?.error ?? "未知错误") + "）——effort "
      + JSON.stringify(requested) + " 原样透传 (fail-open，绝不砖化)")
  }
  const row = cat.models.filter((m) => m && m.slug === model)[0]
  if (!row) {
    return passthrough("model " + JSON.stringify(model) + " 未命中 codex 模型目录（"
      + cat.models.length + " 个模型）——effort " + JSON.stringify(requested) + " 原样透传 (fail-open)")
  }
  const efforts = Array.isArray(row.efforts) ? row.efforts : []
  if (efforts.length === 0) {
    return passthrough("codex model " + model + " 目录条目无 supported_reasoning_levels——effort "
      + JSON.stringify(requested) + " 原样透传 (fail-open)")
  }
  if (efforts.includes(requested)) return { effort: requested, note: null }
  const nearest = nearestEffort(requested, CODEX_EFFORT_LADDER, efforts)
  if (nearest) {
    const note = "effort " + JSON.stringify(requested) + " is not supported by codex model " + model
      + " (supported: " + efforts.join("|") + ") — falling back to nearest supported effort "
      + JSON.stringify(nearest) + "（D-裁决-2 最近支持档，等距向上取）"
    WARN(note)
    return { effort: nearest, note }
  }
  return passthrough("effort " + JSON.stringify(requested) + " cannot be mapped for codex model "
    + model + " (supported: " + efforts.join("|") + ") — passing through unverified (fail-open)")
}
