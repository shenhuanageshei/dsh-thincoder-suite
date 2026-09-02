// state.mjs — 会话级状态（内存态）。
// 设计依据 DESIGN-dsh-port.md §5：Map<sessionId, {...}>，会话级隔离；
// 重启回退保守值（advisorRound=0 保守重评、engineering 回退 off、token 清空）——
// 与 thincoder 的差异已诚实标注在 §6。
//
// 注意：本模块被多个 fiber 实例共享（模块只 import 一次），一切状态按 sessionId
// 键控，fiber 级的 config 差异由各 fiber 自己闭包持有，绝不落模块级可变全局。

/** @type {Map<string, object>} */
const sessions = new Map()

/** 统一键控（评审 #1：sessionState 与 dropSession 的 fallback 必须一致，否则泄漏）。 */
const keyOf = (id) => String(id ?? "default")

export function sessionState(sessionId) {
  const key = keyOf(sessionId)
  let s = sessions.get(key)
  if (!s) {
    s = {
      // —— advisor 收敛协议状态 ——
      advisorRound: 0,          // 已完成的 advisor 调用数（code 与 design 共享 5 轮预算）
      lastAdvisorOutput: null,  // 上一轮评审完整原文（round 2+ 原文注入；仅"像评审"的输出才存）
      lastReviewType: null,     // 上轮评审类型（"code"|"design"|null）——F11：类型切换时重置轮次/prior，防跨类型污染
      mutatedThisRun: false,    // 本 run 是否改过代码（无 prior 且未突变 → 允许重置轮次）
      touchedFiles: [],         // 触碰文件（advisor 无显式 scope 时的兜底；escalate/eng_coder 返回时并入）
      // —— 工程模式状态 ——
      engineering: null,        // null=未翻转（跟 fiber config 默认）；true/false=eng enter/exit 显式值
      engSection: null,         // agent 作用域 engineering section 的 disposer（eng enter 注册）
      designToken: null,        // 当前已签发的设计评审 token（advisor(design) 裁决通过 ∧ [APPROVE:<code>] 回显命中时签发；完成态未通过置 null 作废）
      pendingDesignToken: null, // 本评审会话铸造一次的待批 token（每轮 Approval Signal 派生同一批准码；失效自动重铸；签发后与 designToken 同值）
      // —— advisor 会话级覆盖（docs/2026-09-01-advisor-config-design.md §3.6）——
      // null = 无覆盖；结构 { round1?: {provider?,model?,effort?,timeoutMs?},
      // convergence?: {…同}, includeProjectGuide?: boolean }。优先级高于全局组配置
      // （字段级浅合并，见 mergeAdvisorGroup），经 advisor_config 工具读写，会话销毁即失效。
      advisorOverride: null,
      // —— 会诊状态 ——
      consultSessions: new Map(),
      consultIdCounter: 0,
    }
    sessions.set(key, s)
  }
  return s
}

/** 会话销毁时清理（插件在 'session/disposed' 事件里调用）。 */
export function dropSession(sessionId, onDrop) {
  const key = keyOf(sessionId)
  const s = sessions.get(key)
  if (!s) return
  try { onDrop?.(s) } catch { /* 清理失败不阻塞 */ }
  try { s.engSection?.() } catch { /* 已释放 */ }
  sessions.delete(key)
}

/** 全部会话终止（fiber dispose 时调用——评审 #2：模块级 Map 跨 fiber 存活，须显式清）。 */
export function dropAllSessions(onDrop) {
  for (const key of [...sessions.keys()]) dropSession(key, onDrop)
}

/** 调试/观测：当前会话数。 */
export function sessionCount() {
  return sessions.size
}

/** 有效工程模式标志：显式翻转优先，否则用 fiber config 默认。 */
export function engEffective(state, configDefault) {
  return state.engineering ?? Boolean(configDefault)
}

/**
 * advisor 组对象（round1/convergence）字段级浅合并（设计 §3.6）：
 * 会话覆盖字段覆盖全局组字段，未覆盖字段回落全局组；两侧均为 null/非对象时返回
 * 两侧中唯一的对象（或 null）。只合并已知字段（provider/model/effort/timeoutMs），
 * 未知字段不透传——配置面收敛在 advisor.mjs 的解析/校验链上。
 * 输出恒为普通对象（浅拷贝），调用方修改不会污染 sessionState / config。
 */
export function mergeAdvisorGroup(sessionGroup, globalGroup) {
  const out = {}
  let any = false
  for (const key of ["provider", "model", "effort", "timeoutMs"]) {
    const v = sessionGroup?.[key] ?? globalGroup?.[key]
    if (v !== undefined && v !== null) {
      out[key] = v
      any = true
    }
  }
  return any ? out : null
}
