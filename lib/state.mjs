// state.mjs — 会话级状态（内存态）。
// 设计依据 DESIGN-dsh-port.md §5：Map<sessionId, {...}>，会话级隔离；
// 重启回退保守值（advisorRound=0 保守重评、engineering 回退 off、token 清空）——
// 与 thincoder 的差异已诚实标注在 §6。
//
// 注意：本模块被多个 fiber 实例共享（模块只 import 一次），一切状态按 sessionId
// 键控，fiber 级的 config 差异由各 fiber 自己闭包持有，绝不落模块级可变全局。
//
// F12（docs/2026-09-02-session-state-stages-design.md §2.1/§2.2）：新增恢复入口与持久化视图——
// 字段白名单校验下沉到 session-store.normalizeRestored（本模块不反向 import index，sanitize
// 不重复实现）；designToken/pendingDesignToken/engSection/consult* 一律不进持久化视图（N4 +
// §2.1 ❌ 行：engSection 是进程内 disposer 闭包不可序列化——恢复时由 index.mjs session-start
// 路径重挂；designToken 双盘写 = 双事实源）。

import { normalizeRestored } from "./session-store.mjs"

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

// ————————————— F12 会话级状态持久化（§2.1/§2.2） —————————————

/**
 * 持久化视图（§2.1 白名单字段快照，供 session-store 落盘）。从 state 对象组装而非按
 * sessionId 读 Map——调用方（advisor/eng）手里的就是 Map 活对象，但 advisor_config 的
 * 测试语境会传脱离 Map 的 plain 对象，按对象取值两条路径都正确。
 * 深层净化（lastAdvisorOutput 截断 / touchedFiles 去重封顶 / advisorOverride 结构白名单）
 * 在 session-store.normalizeRestored（写侧即净化，单一链）。
 * @param {object} state — sessionState 条目（或同形状对象）
 * @returns {object} 七字段视图（advisorRound/lastAdvisorOutput/lastReviewType/engineering/
 *   mutatedThisRun/touchedFiles/advisorOverride）
 */
export function viewOfSessionState(state) {
  const s = (state && typeof state === "object") ? state : {}
  return {
    advisorRound: typeof s.advisorRound === "number" && Number.isFinite(s.advisorRound)
      ? s.advisorRound : 0,
    lastAdvisorOutput: typeof s.lastAdvisorOutput === "string" ? s.lastAdvisorOutput : null,
    lastReviewType: s.lastReviewType === "code" || s.lastReviewType === "design" ? s.lastReviewType : null,
    engineering: s.engineering === true || s.engineering === false ? s.engineering : null,
    mutatedThisRun: s.mutatedThisRun === true,
    touchedFiles: Array.isArray(s.touchedFiles)
      ? s.touchedFiles.filter(f => typeof f === "string") : [],
    advisorOverride: s.advisorOverride && typeof s.advisorOverride === "object" && !Array.isArray(s.advisorOverride)
      ? { ...s.advisorOverride } : null,
  }
}

/** 持久化视图（按 sessionId 从会话 Map 取活对象组装——index.mjs 持久化钩子用）。 */
export function persistedSessionView(sessionId) {
  return viewOfSessionState(sessionState(sessionId))
}

/**
 * F12 恢复入口（§2.2-1/3，T15 只填空槽）：map 已有该 sessionId（会话在本进程已活跃/已推进）
 * → 跳过不覆盖，内存胜（盘上陈旧条目不得覆盖重启后已推进的内存态）；map 无该 key 且快照
 * 通过字段白名单校验（normalizeRestored，含 T3 规范化）→ 整条灌入新条目。
 * engSection 不落盘（§2.1 ❌ 行）——恢复后 engineering===true 时由调用方（index.mjs
 * session-start 路径）重挂，既有 if (!state.engSection) 守卫消解双挂。
 * @param {string} sessionId
 * @param {object|null} snapshot — loadSessionState 的返回（或其他来源的快照）
 * @returns {{restored: true, advisorRound: number, lastAdvisorOutput: string|null,
 *   lastReviewType: string|null, engineering: boolean|null, mutatedThisRun: boolean,
 *   touchedFiles: string[], advisorOverride: object|null}
 *   |{restored: false, reason: "present"|"invalid"}}
 */
export function restoreSessionState(sessionId, snapshot) {
  const key = keyOf(sessionId)
  if (sessions.has(key)) return { restored: false, reason: "present" } // T15：只填空槽
  const v = normalizeRestored(snapshot)
  if (!v) return { restored: false, reason: "invalid" }
  const s = sessionState(key)
  s.advisorRound = v.advisorRound
  s.lastAdvisorOutput = v.lastAdvisorOutput
  s.lastReviewType = v.lastReviewType
  s.engineering = v.engineering
  s.mutatedThisRun = v.mutatedThisRun
  s.touchedFiles = [...v.touchedFiles] // 独立副本：返回值（观测/日志）与内存态互不串改
  s.advisorOverride = v.advisorOverride // normalizeRestored 已构建全新结构，无输入别名
  // 返回值同样与内存态解耦（评审 #5）：touchedFiles 已是上面那份副本之外的第二份；
  // advisorOverride 浅拷贝（组对象一层）——调用方只读观测，不因持有返回值间接改内存态。
  return {
    restored: true,
    advisorRound: v.advisorRound,
    lastAdvisorOutput: v.lastAdvisorOutput,
    lastReviewType: v.lastReviewType,
    engineering: v.engineering,
    mutatedThisRun: v.mutatedThisRun,
    touchedFiles: [...v.touchedFiles],
    advisorOverride: v.advisorOverride
      ? Object.fromEntries(Object.entries(v.advisorOverride).map(([gk, g]) =>
        [gk, g && typeof g === "object" ? { ...g } : g]))
      : null,
  }
}
