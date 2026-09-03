// session-store.mjs — 会话级协议推进状态的磁盘持久化（F12，docs/2026-09-02-session-state-stages-design.md §2.2）。
// 纯 fs helper（零新增依赖）：$DSH_HOME/.thincoder/session-state.json（与 design-tokens.json **分文件**——
// ① 生命周期语义不同：token 内嵌 TTL 按 expiresAt 清扫；state 无自然过期 → lastSeen + 独立 7d TTL，
// 混文件 = 两套清扫规则纠缠且稀释 F10「凭证文件」安全推理；② 回滚独立：删本文件即回纯内存行为，
// token 不受牵连）。
// 状态字段白名单（§2.1）：{ advisorRound, lastAdvisorOutput（超 32K 截断 + 尾部 [truncated] 标记）,
// lastReviewType, engineering（tri-state 原样）, mutatedThisRun, touchedFiles（去重封顶 200）,
// advisorOverride, lastSeen }——**绝不含 designToken/pendingDesignToken**（N4：F10 token-store
// 单路管理凭证，双盘写 = 双事实源，撤销要走双写同步，任何一路失败即「撤销失效/复活」）。
// fail-safe（N3）：损坏/缺失/超 TTL → load 返回 null（回落纯内存行为，不崩溃）；写失败仅 warn 不抛。
// storPathOverride 注入缝（对齐 token-store 先例，测试用临时目录，不碰真实 $DSH_HOME）。
// 原子写 = dsh-home.writeFileAtomic（tmp+rename，评审 #4：多会话单文件直写 = 崩半写丢全部会话状态）。
// 写入时序：语义转换点写盘（advisor 完成分支/F11 类型切换重置、eng 翻转、eng_coder/escalate 交付、
// advisor_config set/reset 与二期 config API apply/reset-session——§2.3 写点全表，调用方各自落点）；
// 写时全量清扫 lastSeen 超 7d 孤儿（§2.4，防崩溃孤儿累积；与 F10 token 1h 清扫互不相干各扫各的）。
// normalizeRestored（恢复规范化，T3）：round>0 且无 lastAdvisorOutput → round=0——单存轮次会恢复出
// 「无 prior 的收敛轮」（round≥1 路由 convergence 组且 round2+ 协议要 prior 表），恢复侧消解。

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pickDshHome, writeFileAtomic } from "./dsh-home.mjs"

const STORE_VERSION = 1
const STORE_SUBDIR = ".thincoder"
const STORE_FILE = "session-state.json"

/** §2.4：孤儿清扫 TTL（7d 常量，勿做成用户配置——防泄漏非调优项）。 */
export const STATE_TTL_MS = 7 * 24 * 3600 * 1000
/** §8 写放大：lastAdvisorOutput 落盘/恢复截断上限（超限截断 + 尾部 [truncated] 标记——上限强制而非期望）。 */
export const LAST_ADVISOR_OUTPUT_MAX_CHARS = 32 * 1024
/** §2.1：touchedFiles 去重封顶。 */
export const TOUCHED_FILES_CAP = 200

const warn = (m) => console.warn("[thincoder-suite] " + m)
const isPlainObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

/**
 * 存储路径解析。优先 dshHomeOverride（测试注入缝 storPathOverride，语义 = DSH_HOME 目录），
 * 其次 process.env.DSH_HOME，最后从 cwdHint/process.cwd() 向上探测 profile 根（dsh-home 共用）。
 * 无可用 home → null（调用方各自 fail-safe：save 仅 warn，load 视为无记录）。
 * @param {string} [dshHomeOverride]
 * @param {string} [cwdHint] — 探测起点的会话 cwd
 * @returns {string|null} 完整存储文件路径
 */
export function resolveSessionStorePath(dshHomeOverride, cwdHint) {
  const home = pickDshHome(dshHomeOverride, cwdHint)
  return home ? join(home, STORE_SUBDIR, STORE_FILE) : null
}

/** 读整个 store 的 sessions 表：缺失/损坏/不可读/结构不对/version 不符 → {}（N3 fail-safe；
 *  评审 #6：version 不符按「无 store」处理——未来 v2 落空存储 = 纯内存行为，不做部分解读）。 */
function readStore(filePath) {
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"))
    if (isPlainObj(data) && data.version === STORE_VERSION && isPlainObj(data.sessions)) return data.sessions
  } catch { /* 缺失/损坏/不可读 → 视为空 */ }
  return {}
}

/**
 * §8 写放大：lastAdvisorOutput 截断（超 32K → 截断 + 尾部 [truncated] 标记）。写侧（save）与
 * 恢复侧（normalizeRestored）共用——写侧截断防文件膨胀；恢复侧截断防外部手改文件绕过写侧上限
 * （截断只影响重启后 prior 注入的尾部，正常路径内存态不受影响）。
 */
export function truncateForStore(text) {
  const s = String(text)
  if (s.length <= LAST_ADVISOR_OUTPUT_MAX_CHARS) return s
  return s.slice(0, LAST_ADVISOR_OUTPUT_MAX_CHARS) + "\n[truncated]"
}

/**
 * advisorOverride 结构白名单（键级）：只认 round1/convergence 组（组内只认 provider/model/
 * effort/timeoutMs）+ includeProjectGuide。值级校验（枚举/数值区间）留在 advisor 解析链——
 * §2.1「白名单校验链已存在」（resolveAdvisorRoute 对 override 字段逐个校验、非法忽略并 N4 警告），
 * 此处不复制值校验逻辑（单一事实源）；结构非法的键直接丢弃。
 */
function sanitizeAdvisorOverride(v) {
  if (!isPlainObj(v)) return null
  const out = {}
  for (const gk of ["round1", "convergence"]) {
    const g = v[gk]
    if (!isPlainObj(g)) continue
    const gOut = {}
    for (const f of ["provider", "model", "effort", "timeoutMs"]) {
      if (g[f] !== undefined && g[f] !== null) gOut[f] = g[f]
    }
    if (Object.keys(gOut).length > 0) out[gk] = gOut
  }
  if (typeof v.includeProjectGuide === "boolean") out.includeProjectGuide = v.includeProjectGuide
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 恢复规范化 + 字段白名单校验（§2.2-1，T3）：把盘上条目（或调用方快照）净化为可灌入的会话状态字段。
 * - advisorRound：非负有限数取整，否则 0；**round>0 且无 lastAdvisorOutput → round=0（T3）**；
 * - lastAdvisorOutput：string（超 32K 截断 + [truncated] 标记）否则 null；
 * - lastReviewType："code"|"design"|null；engineering：tri-state 原样（null/true/false，§2.1）；
 * - mutatedThisRun：boolean；touchedFiles：非空 string 去重封顶 200；
 * - advisorOverride：结构白名单（见 sanitizeAdvisorOverride）；
 * - 非对象条目 → null（调用方按「无记录/无效」处理，不崩溃）。
 * lastSeen 不属于会话状态字段，丢弃（TTL 判定在 loadSessionState）。
 * @returns {object|null} { advisorRound, lastAdvisorOutput, lastReviewType, engineering,
 *   mutatedThisRun, touchedFiles, advisorOverride }
 */
export function normalizeRestored(entry) {
  if (!isPlainObj(entry)) return null
  const lastAdvisorOutput = typeof entry.lastAdvisorOutput === "string"
    ? truncateForStore(entry.lastAdvisorOutput)
    : null
  let advisorRound = typeof entry.advisorRound === "number" && Number.isFinite(entry.advisorRound)
    && entry.advisorRound >= 0 ? Math.floor(entry.advisorRound) : 0
  if (advisorRound > 0 && !lastAdvisorOutput) advisorRound = 0 // T3：无 prior 的轮次不成立
  const touchedFiles = [...new Set(
    (Array.isArray(entry.touchedFiles) ? entry.touchedFiles : [])
      .filter(f => typeof f === "string" && f.trim() !== ""),
  )].slice(0, TOUCHED_FILES_CAP)
  return {
    advisorRound,
    lastAdvisorOutput,
    lastReviewType: entry.lastReviewType === "code" || entry.lastReviewType === "design" ? entry.lastReviewType : null,
    engineering: entry.engineering === true || entry.engineering === false ? entry.engineering : null,
    mutatedThisRun: entry.mutatedThisRun === true,
    touchedFiles,
    advisorOverride: sanitizeAdvisorOverride(entry.advisorOverride),
  }
}

/**
 * 写入/更新某 session 的状态条目（读-改-写 + 写时全量清扫 + 原子写，§2.2/§2.4）。
 * view 经 normalizeRestored 同一净化链（截断/去重封顶/白名单——写侧即净化，脏字段不落盘）。
 * 写盘失败仅 warn 并返回 false，不抛（N3：回落纯内存行为）。
 * @param {string} sessionId
 * @param {object} view — 持久化视图（viewOfSessionState/persistedSessionView 的输出）
 * @param {string} [dshHomeOverride] — 测试注入缝（storPathOverride）
 * @param {string} [cwdHint]
 * @returns {boolean} 是否成功写盘
 */
export function saveSessionState(sessionId, view, dshHomeOverride, cwdHint) {
  const filePath = resolveSessionStorePath(dshHomeOverride, cwdHint)
  if (!filePath) {
    warn("session state store path not resolvable (no DSH_HOME / profile root) — session state kept in memory only")
    return false
  }
  try {
    const v = normalizeRestored(view)
    if (!v) return false // 非对象 view（调用方 bug）——fail-safe 拒写
    const sessions = readStore(filePath)
    sessions[String(sessionId)] = { ...v, lastSeen: Date.now() }
    // 写时全量清扫（§2.4）：非对象条目 / lastSeen 非有限数字 / 超 7d TTL 一律删除（防崩溃孤儿累积）。
    // 本条目刚盖 lastSeen=now，天然幸存。
    const now = Date.now()
    for (const [sid, e] of Object.entries(sessions)) {
      const bad = !isPlainObj(e)
        || !(typeof e.lastSeen === "number" && Number.isFinite(e.lastSeen))
        || now - e.lastSeen > STATE_TTL_MS
      if (bad) delete sessions[sid]
    }
    writeFileAtomic(filePath, JSON.stringify({ version: STORE_VERSION, sessions }, null, 2) + "\n")
    return true
  } catch (e) {
    warn("failed to persist session state to " + filePath + ": " + (e?.message ?? String(e)) + " — session state kept in memory only")
    return false
  }
}

/**
 * 读取某 session 的状态条目（恢复侧）。缺失/损坏/不可读/非对象/超 7d TTL → null（N3 fail-safe：
 * 回落纯内存行为，不崩溃）。命中且 TTL 内有效 → normalizeRestored 净化后返回（含 T3 规范化）。
 * @param {string} sessionId
 * @param {string} [dshHomeOverride] — 测试注入缝（storPathOverride）
 * @param {string} [cwdHint]
 * @returns {object|null}
 */
export function loadSessionState(sessionId, dshHomeOverride, cwdHint) {
  const filePath = resolveSessionStorePath(dshHomeOverride, cwdHint)
  if (!filePath) return null
  const entry = readStore(filePath)[String(sessionId)]
  if (!isPlainObj(entry)) return null
  // TTL 内有效条目才可恢复（§2.2-1）；过期/无 lastSeen 按「无记录」处理（写时清扫的读取面）
  if (!(typeof entry.lastSeen === "number" && Number.isFinite(entry.lastSeen))
    || Date.now() - entry.lastSeen > STATE_TTL_MS) {
    return null
  }
  return normalizeRestored(entry)
}

/**
 * 删除某 session 的状态条目（session/disposed 路径，§2.4——镜像 removeTokenRecord）。
 * 失败仅 warn 不抛；无记录可删 → true。
 * @param {string} sessionId
 * @param {string} [dshHomeOverride]
 * @param {string} [cwdHint]
 * @returns {boolean}
 */
export function removeSessionState(sessionId, dshHomeOverride, cwdHint) {
  const filePath = resolveSessionStorePath(dshHomeOverride, cwdHint)
  if (!filePath) {
    warn("session-state store path not resolvable (no DSH_HOME / profile root) — cannot remove record for " + sessionId)
    return false
  }
  try {
    const sessions = readStore(filePath)
    if (!(String(sessionId) in sessions)) return true // 无记录可删
    delete sessions[String(sessionId)]
    writeFileAtomic(filePath, JSON.stringify({ version: STORE_VERSION, sessions }, null, 2) + "\n")
    return true
  } catch (e) {
    warn("failed to remove session state for " + sessionId + ": " + (e?.message ?? String(e)))
    return false
  }
}
