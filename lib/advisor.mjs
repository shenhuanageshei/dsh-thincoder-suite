// advisor.mjs — advisor 工具本体：LLM 评审循环 + 收敛协议入口 + design token 生命周期。
// 移植自 thincoder advisor/run.mjs（工具循环/上限/超时/压缩）+ agent-tools/advisor.mjs
//（token 签发与校验）。DSH 适配：LLM 调用走 ctx.llm.stream（GenerateOptions 原生支持
// tools），消息形状为 DSH Message（content 块数组）。
// design token 协议 v2（DESIGN-advisor-token-protocol-fix.md）：token 每评审会话只铸造
// 一次；评审轮只展示 8 位批准码 [APPROVE:<8hex>]（token 本体不进提示词）；签发判定 =
// 裁决通过 ∧ 批准码回显命中，宿主校验命中后自行注入完整 token。
//
// 可配置分层路由（docs/2026-09-01-advisor-config-design.md §3.1–§3.6）：
// - 路由键 = sessionState.advisorRound（缺失视为 0）：0 → round1 组；>= 1 → convergence 组；
// - provider/model 成对解析链（§3.2 单一事实源）：合并后组环（会话覆盖 ⊕ 组字段）→
//   legacy advisor.provider/model（仅 round1，F6）→ 主代理 agent.options → no route；
//   整对下探，禁止跨环混搭；effort/timeoutMs 按字段解析（不要求与模型同环）；
// - effort 透传 reasoningEffort（字段名已对照 dsh-llm GenerateOptions 类型定义核对：
//   call-config.d.ts:19 reasoningEffort?: ReasoningEffortId —— 名称一致，§7 确认项 2）；
// - 预算模型（§3.4）：每轮硬预算 = 该轮组 timeoutMs（round1 缺省 600000 —— REVIEW_TIMEOUT_MS
//   退役为默认值来源；convergence 缺省 300000）。绝对截止（每次 llm.stream 挂 deadline
//   定时器 + chunk 墙钟双检查）优先于 idle 看门狗（90s，窗口 clamp 到 min(90s, deadlineMs)）；
//   裁决顺序：预算到点即 timeout（增强消息，含轮次/已读文件数），stall 仅在预算未耗尽且
//   STREAM_ATTEMPTS 重试全败时返回 provider_stall 诊断。
import { randomUUID, createHmac } from "node:crypto"
import { sessionState, engEffective, viewOfSessionState } from "./state.mjs"
import { advisorToolSchemas, advisorToolImpls } from "./readonly-tools.mjs"
import { saveTokenRecord, removeTokenRecord } from "./token-store.mjs"
import { saveSessionState } from "./session-store.mjs"
import { effectiveGlobalConfig } from "./config-store.mjs"
import {
  buildAdvisorSystemPrompt, buildAdvisorUserMessage, appendCitationReport,
  extractUnfixedIssues,
} from "./advisor-msgs.mjs"

export const MAX_ADVISOR_ROUNDS = 5     // 机械收敛上限：第 6 次调用零 LLM 直接拒
const MAX_ADVISOR_TURNS = 100           // 工具轮硬上限（runaway-loop 守卫）
const MAX_CONTEXT_TOKENS = 120_000      // 上下文窗口预算（预留余量）

// ————————————— 预算模型（docs/2026-09-01-advisor-config-design.md §3.4） —————————————
const REVIEW_TIMEOUT_MS = 600_000               // 退役常量：现在是 round1 组 timeoutMs 的缺省值来源
const CONVERGENCE_TIMEOUT_DEFAULT_MS = 300_000  // convergence 组 timeoutMs 缺省值
/** timeoutMs 合法区间（导出：config-store/API 校验与工具 coercion 的单一事实源，评审 #5）。 */
export const ADVISOR_TIMEOUT_MIN_MS = 1000
export const ADVISOR_TIMEOUT_MAX_MS = 3_600_000
export const EFFORT_LEVELS = ["off", "low", "medium", "high", "max"]
const LLM_CALL_STALL_MS = 90_000        // idle 看门狗窗口（不再配置化，YAGNI，§3.4）
const STREAM_ATTEMPTS = 3               // 看门狗 stall 时的单调用重试次数（瞬时 provider 挂起自愈）
const LLM_MAX_TOKENS = 8192             // advisor 单次 LLM 输出预算（对齐既有值）

// 默认 TTL 1h（评审 #3：对齐设计 N3「短生命周期凭证」——F10 落盘后长 TTL 会放大凭证暴露窗口；
// profile 配置 engTokenTtlMs 可覆盖，本机配置 3600000 即 1h）
const TOKEN_TTL_DEFAULT_MS = 3600 * 1000
const TOKEN_SECRET = process.env.THINCODER_TOKEN_SECRET || "thincoder-default-secret"

// ————————————— 组配置解析辅助（§3.1/§3.2/§3.3） —————————————
// 校验 helper 导出（评审 #5：消除 dead-export 双实现）——host API（config PUT 端点/表单校验）
// 复用本组导出，不重写；数值边界（ADVISOR_TIMEOUT_MIN/MAX_MS）与 effort 枚举同源导出。

/** effort 只认枚举 off|low|medium|high|max。 */
export function isValidEffort(v) { return typeof v === "string" && EFFORT_LEVELS.includes(v) }
/** timeoutMs 只认 1000..3600000 的有限数字。 */
export function isValidTimeoutMs(v) {
  return typeof v === "number" && Number.isFinite(v)
    && v >= ADVISOR_TIMEOUT_MIN_MS && v <= ADVISOR_TIMEOUT_MAX_MS
}
/** provider/model 字段只认非空字符串（注册表检测在二期 API/UI，§3.9）。 */
export function isModelField(v) { return typeof v === "string" && v.trim() !== "" }
/** engCoderMaxTokens 只认正整数（U3：非正整数 → 表单内联报错；运行期解析仍接受正有限数，N4 宽容）。 */
export function isValidEngCoderMaxTokens(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && Number.isInteger(v)
}

/** 会话级覆盖的合法组内字段（advisor_config 工具校验用，§3.6）。 */
export const ADVISOR_OVERRIDE_GROUP_PATHS = ["provider", "model", "effort", "timeoutMs"]

/**
 * 路由键 → 组名（§3.2）：sessionState.advisorRound 缺失/undefined 视为 0 → round1；
 * >= 1 → convergence（round 2/3/4/5 全用同一组）。
 */
export function advisorGroupKey(advisorRound) {
  return (Number(advisorRound) || 0) >= 1 ? "convergence" : "round1"
}

/**
 * 组配置解析（§3.2 单一事实源 + §3.6 字段级浅合并 + §3.3 effort 按字段解析）。
 * 解析链：合并后组环（会话覆盖 ⊕ 组字段）→ legacy advisor.*（仅 round1，F6）→ 主代理路由。
 * - provider/model 成对约束：最终 pair 必须来自同一解析环，禁止跨环混搭；合并后组环缺
 *   provider 或 model 时整对下探下一环（会话覆盖字段被忽略时输出 N4 警告，T20）；
 * - effort/timeoutMs 按字段解析（不要求与模型同环）；非法值（effort 非枚举 / timeoutMs
 *   非 1000..3600000 数）忽略并警告（N4，T3/T13）；effort 与模型环不一致时 N4 跨环警告（T21）；
 * - timeoutMs 缺省：round1 600000（REVIEW_TIMEOUT_MS 退役来源）/ convergence 300000。
 * @returns {ok:true, groupKey, provider, model, pairSource, effort, effortSource,
 *          timeoutMs, timeoutSource, warnings} | {ok:false, groupKey, warnings}
 */
export function resolveAdvisorRoute({ config, override, agentOpts, advisorRound }) {
  const warnings = []
  const warn = (m) => warnings.push("advisor config warning: " + m)
  const groupKey = advisorGroupKey(advisorRound)
  const advisorCfg = (config && typeof config === "object" && config.advisor
    && typeof config.advisor === "object") ? config.advisor : {}
  const overrideG = (override && typeof override === "object" && override[groupKey]
    && typeof override[groupKey] === "object") ? override[groupKey] : {}
  const globalG = (advisorCfg[groupKey] && typeof advisorCfg[groupKey] === "object")
    ? advisorCfg[groupKey] : {}
  // legacy advisor.provider/model/timeoutMs 只在 round1 生效（F6 兼容，§3.1）
  const legacy = groupKey === "round1" ? advisorCfg : null
  const agent = (agentOpts && typeof agentOpts === "object") ? agentOpts : {}

  // —— 合并后组环字段（字段级：override 有效则用，否则 global；非法值忽略并警告）——
  const eff = {}        // 合并后组环的有效字段
  const effSource = {}  // 每个字段的环内来源（session override | global config）
  const validOf = (key) => key === "effort" ? isValidEffort
    : key === "timeoutMs" ? isValidTimeoutMs : isModelField
  const expected = (key) => key === "effort"
    ? "one of off|low|medium|high|max"
    : key === "timeoutMs"
      ? "a number in " + ADVISOR_TIMEOUT_MIN_MS + ".." + ADVISOR_TIMEOUT_MAX_MS
      : "a non-empty string"
  for (const key of ["provider", "model", "effort", "timeoutMs"]) {
    const ok = validOf(key)
    const ro = overrideG[key]
    const rg = globalG[key]
    if (ro !== undefined && ro !== null) {
      if (ok(ro)) { eff[key] = ro; effSource[key] = "session override" }
      else warn("ignoring invalid session override " + groupKey + "." + key + " = "
        + JSON.stringify(ro) + " (expected " + expected(key) + ")")
    }
    if (eff[key] === undefined && rg !== undefined && rg !== null) {
      if (ok(rg)) { eff[key] = rg; effSource[key] = "global config" }
      else warn("ignoring invalid " + groupKey + "." + key + " = " + JSON.stringify(rg)
        + " (expected " + expected(key) + ")")
    }
  }

  // —— provider/model 成对解析（整对下探，禁止跨环混搭）——
  let provider = null, model = null, pairSource = null
  if (eff.provider !== undefined && eff.model !== undefined) {
    provider = eff.provider; model = eff.model
    pairSource = effSource.provider === effSource.model
      ? effSource.provider
      : "session override + global config"
  } else {
    const mergedPartial = eff.provider !== undefined || eff.model !== undefined
    const overridePartial = overrideG.provider !== undefined || overrideG.model !== undefined
    if (mergedPartial && overridePartial) {
      // 组环合并后缺 provider/model 其一 → 整对下探；会话覆盖字段被忽略（§3.2 工作示例第 3 行，T20）
      const dropped = ["provider", "model"].filter(k =>
        overrideG[k] !== undefined && overrideG[k] !== null)
      warn("session override fields " + groupKey + "." + dropped.join("/")
        + " cannot be applied — merged " + groupKey
        + " group has no complete provider/model pair; the whole pair falls through the resolution chain")
    }
    if (legacy) {
      const lp = legacy.provider, lm = legacy.model
      if (lp !== undefined && lp !== null && !isModelField(lp))
        warn("ignoring invalid legacy advisor.provider = " + JSON.stringify(lp) + " (expected a non-empty string)")
      if (lm !== undefined && lm !== null && !isModelField(lm))
        warn("ignoring invalid legacy advisor.model = " + JSON.stringify(lm) + " (expected a non-empty string)")
      if (isModelField(lp) && isModelField(lm)) {
        provider = lp; model = lm; pairSource = "legacy advisor.*"
      } else if (isModelField(agent.provider) && isModelField(agent.model)) {
        provider = agent.provider; model = agent.model; pairSource = "agent route"
      }
    } else if (isModelField(agent.provider) && isModelField(agent.model)) {
      provider = agent.provider; model = agent.model; pairSource = "agent route"
    }
  }
  if (provider === null || model === null) {
    return { ok: false, groupKey, warnings }
  }

  // —— effort（按字段解析；缺省不传，用适配器默认）——
  const effort = eff.effort !== undefined ? eff.effort : null
  const effortSource = eff.effort !== undefined ? effSource.effort : null
  if (effort !== null && pairSource !== "session override" && pairSource !== "global config"
    && pairSource !== "session override + global config") {
    // §3.3 跨环警告：effort 的解析环（组环）≠ provider/model 的解析环（T21）
    warn("effort " + JSON.stringify(effort) + " (from " + effortSource
      + ") applies to a provider/model pair resolved from " + pairSource
      + " — the effort ring differs from the model ring (effort may target a different model's reasoning profile)")
  }

  // —— timeoutMs（按字段解析：组环 → legacy → 缺省）——
  let timeoutMs = eff.timeoutMs
  let timeoutSource = eff.timeoutMs !== undefined ? effSource.timeoutMs : null
  if (timeoutMs === undefined && legacy && legacy.timeoutMs !== undefined && legacy.timeoutMs !== null) {
    if (isValidTimeoutMs(legacy.timeoutMs)) {
      timeoutMs = legacy.timeoutMs
      timeoutSource = "legacy advisor.*"
    } else {
      warn("ignoring invalid legacy advisor.timeoutMs = " + JSON.stringify(legacy.timeoutMs)
        + " (expected a number in " + ADVISOR_TIMEOUT_MIN_MS + ".." + ADVISOR_TIMEOUT_MAX_MS + ")")
    }
  }
  if (timeoutMs === undefined) {
    timeoutMs = groupKey === "convergence" ? CONVERGENCE_TIMEOUT_DEFAULT_MS : REVIEW_TIMEOUT_MS
    timeoutSource = "default"
  }

  return {
    ok: true, groupKey, provider, model, pairSource,
    effort, effortSource,
    timeoutMs, timeoutSource,
    warnings,
  }
}

/**
 * 评审记忆开关（§3.5）：includeProjectGuide 解析——会话覆盖 > 全局组 > 缺省 false。
 */
export function resolveIncludeProjectGuide({ config, override }) {
  const advisorCfg = (config && typeof config === "object" && config.advisor
    && typeof config.advisor === "object") ? config.advisor : {}
  if (override && typeof override.includeProjectGuide === "boolean") {
    return { value: override.includeProjectGuide, source: "session override" }
  }
  if (typeof advisorCfg.includeProjectGuide === "boolean") {
    return { value: advisorCfg.includeProjectGuide, source: "global config" }
  }
  return { value: false, source: "default" }
}

// ————————————— advisor_config 工具（§3.6，一期入口） —————————————

const GROUP_PREFIXES = ["round1", "convergence"]
const isGroupFieldPath = (path) => {
  const [prefix, field] = String(path).split(".")
  return GROUP_PREFIXES.includes(prefix) && ADVISOR_OVERRIDE_GROUP_PATHS.includes(field)
}

function overrideGroupObj(state, prefix) {
  if (!state.advisorOverride || typeof state.advisorOverride !== "object") {
    state.advisorOverride = {}
  }
  if (!state.advisorOverride[prefix] || typeof state.advisorOverride[prefix] !== "object") {
    state.advisorOverride[prefix] = {}
  }
  return state.advisorOverride[prefix]
}

function coerceValue(path, field, value) {
  // 返回 { ok:true, value } | { ok:false, reason }
  const reason = (m) => ({ ok: false, reason: m })
  if (path === "includeProjectGuide") {
    return typeof value === "boolean" ? { ok: true, value }
      : reason("value for includeProjectGuide must be a boolean")
  }
  switch (field) {
    case "provider":
    case "model":
      return (typeof value === "string" && value.trim() !== "")
        ? { ok: true, value }
        : reason("value for " + path + " must be a non-empty string")
    case "effort":
      return (typeof value === "string" && EFFORT_LEVELS.includes(value))
        ? { ok: true, value }
        : reason("value for " + path + " must be one of " + EFFORT_LEVELS.join("|"))
    case "timeoutMs":
      return (typeof value === "number" && Number.isFinite(value)
        && value >= ADVISOR_TIMEOUT_MIN_MS && value <= ADVISOR_TIMEOUT_MAX_MS)
        ? { ok: true, value }
        : reason("value for " + path + " must be a number in "
          + ADVISOR_TIMEOUT_MIN_MS + ".." + ADVISOR_TIMEOUT_MAX_MS)
    default:
      return reason("unknown field")
  }
}

function describeGroup(groupKey, config, override, agentOpts, advisorRound) {
  const r = resolveAdvisorRoute({ config, override, agentOpts, advisorRound })
  if (!r.ok) {
    return "  " + groupKey + ": no LLM route available (provider/model resolution chain exhausted)"
  }
  const effortLine = r.effort !== null
    ? "effort: " + JSON.stringify(r.effort) + " (source: " + r.effortSource + ")"
    : "effort: (not set — adapter default)"
  return "  " + groupKey + ":\n"
    + "    provider: " + r.provider + " (source: " + r.pairSource + ")\n"
    + "    model: " + r.model + " (source: " + r.pairSource + ")\n"
    + "    " + effortLine + "\n"
    + "    timeoutMs: " + r.timeoutMs + " (source: " + r.timeoutSource + ")"
}

/**
 * advisor_config 工具执行（§3.6）。textTool，参数线格式 = JSON 对象文本，JSON.parse 解析；
 * malformed / 未知 action/path / 类型错 / 越界 → 统一 "advisor_config: invalid input — <原因>"，
 * sessionState.advisorOverride 保持原样（N4）。全局写入经二期设置页 config API
 * （PUT /thincoder-suite/api/config → config.json user 层，见 docs/2026-09-02-settings-ui-design.md §3.2）。
 * @param text 工具参数文本（JSON 对象）
 * @param deps { config, agentOpts, state, sessionId? } — state 含可变 advisorOverride
 */
export function runAdvisorConfigTool(text, deps) {
  const state = deps?.state ?? {}
  // 二期（docs/2026-09-02-settings-ui-design.md §3.6-1）：config 来源统一走 effectiveGlobalConfig
  // ——get 显示/解析的「全局 advisor config」= entry base ⊕ config.json user 层（每次调用时读，
  // 保存即生效，U5）；set/reset 只动会话覆盖（state），与本行无关。
  const effectiveCfg = effectiveGlobalConfig(deps?.config, { cwdHint: deps?.cwdHint })
  const invalid = (reason) => "advisor_config: invalid input — " + reason

  let req
  try {
    req = JSON.parse(String(text ?? "").trim() || "{}")
  } catch (e) {
    return invalid("malformed JSON: " + (e?.message ?? String(e)))
  }
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return invalid("request must be a JSON object")
  }
  const action = req.action
  if (action !== "get" && action !== "set" && action !== "reset") {
    return invalid("unknown action " + JSON.stringify(action) + " (expected get|set|reset)")
  }

  if (action === "get") {
    const override = state.advisorOverride ?? null
    const includeProjectGuide = resolveIncludeProjectGuide({ config: effectiveCfg, override })
    const lines = [
      "advisor_config (session " + (deps?.sessionId ?? "?") + "):",
      "session override: " + (override ? JSON.stringify(override) : "(none)"),
      "global advisor config: " + JSON.stringify(effectiveCfg.advisor ?? {}),
      "includeProjectGuide: " + includeProjectGuide.value + " (source: " + includeProjectGuide.source + ")",
      "effective route:",
      describeGroup("round1", effectiveCfg, override, deps?.agentOpts, 0),
      describeGroup("convergence", effectiveCfg, override, deps?.agentOpts, 1),
    ]
    return lines.join("\n")
  }

  if (action === "set") {
    const path = req.path
    const value = req.value
    if (typeof path !== "string" || path === "") {
      return invalid("set requires a path (round1|convergence . provider|model|effort|timeoutMs, or includeProjectGuide)")
    }
    if (path !== "includeProjectGuide" && !isGroupFieldPath(path)) {
      return invalid("path " + JSON.stringify(path)
        + " is not settable (expected round1|convergence . provider|model|effort|timeoutMs, or includeProjectGuide)")
    }
    const [prefix, field] = path === "includeProjectGuide" ? [] : path.split(".")
    const c = coerceValue(path, field ?? null, value)
    if (!c.ok) return invalid(c.reason)
    if (path === "includeProjectGuide") {
      if (!state.advisorOverride || typeof state.advisorOverride !== "object") {
        state.advisorOverride = {}
      }
      state.advisorOverride.includeProjectGuide = c.value
    } else {
      overrideGroupObj(state, prefix)[field] = c.value
    }
    return "advisor_config: set " + path + " = " + JSON.stringify(c.value)
      + " (session override updated)"
  }

  // reset（省略 path = all，与 set 的 path 枚举对称）
  const path = req.path === undefined || req.path === null ? "all" : req.path
  if (path !== "round1" && path !== "convergence" && path !== "includeProjectGuide" && path !== "all") {
    return invalid("path " + JSON.stringify(path)
      + " is not resettable (expected round1|convergence|includeProjectGuide|all)")
  }
  if (!state.advisorOverride || typeof state.advisorOverride !== "object") {
    return "advisor_config: reset " + path + " — session override cleared (nothing to reset)"
  }
  if (path === "all") {
    state.advisorOverride = null
  } else {
    delete state.advisorOverride[path]
    if (Object.keys(state.advisorOverride).length === 0) state.advisorOverride = null
  }
  return "advisor_config: reset " + path + " — session override cleared"
}

// ————————————— design token（对齐 thincoder advisor.mjs，fail-closed） —————————————

function generateDesignToken(config) {
  const uuid = randomUUID()
  const ttl = Number.isFinite(config?.engTokenTtlMs) && config.engTokenTtlMs > 0 ? config.engTokenTtlMs : TOKEN_TTL_DEFAULT_MS
  const expiresAt = Date.now() + ttl
  const payload = uuid + ":" + expiresAt
  const signature = createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex").slice(0, 16)
  return payload + ":" + signature
}

/** 校验：格式/过期/签名全 fail-closed（畸形串一律不通过）。 */
export function validateDesignToken(token) {
  if (!token || typeof token !== "string") return false
  const parts = token.split(":")
  if (parts.length !== 3) return false
  const [uuid, expiresAt, signature] = parts
  const expTime = parseInt(expiresAt, 10)
  if (isNaN(expTime)) return false
  if (Date.now() > expTime) return false
  const payload = uuid + ":" + expiresAt
  const expectedSig = createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex").slice(0, 16)
  return signature === expectedSig
}

/**
 * 批准码派生（R2）：code = HMAC-SHA256(TOKEN_SECRET, designToken).hex.slice(0, 8)。
 * 每评审会话只铸造一次 designToken（存 sessionState.pendingDesignToken），因此每轮
 * （round 1 与收敛轮）的 Approval Signal 展示同一个 code；token 本体绝不进提示词
 * （批准前 LLM 全程不见 token），宿主校验 [APPROVE:<code>] 回显命中后自行注入完整 token。
 * 放在本模块（token 加密域单一归属）并由 advisor-msgs.mjs 反向 import——环状依赖是
 * 有意的且安全：双方仅在函数体内使用对方绑定（Node ESM 活绑定延迟求值；本插件纯
 * .mjs 免构建，无打包器改写），切勿在任何一侧的模块顶层使用对方绑定。
 */
export function designApprovalCode(designToken) {
  return createHmac("sha256", TOKEN_SECRET).update(String(designToken ?? "")).digest("hex").slice(0, 8)
}

/**
 * [APPROVE:<code>] 批准码回显的弹性匹配（允许独立行/代码块/空白包裹）。
 * 旧格式 [DESIGN-TOKEN:<67 字符 token>] 回显路径已废除（v2 干净切换：保留旧格式
 * 等于保留钓鱼通道）——任何 [DESIGN-TOKEN:...] 回显一律不触发签发，与未回显同待遇。
 */
const makeApprovalCodeRegex = (code, flags = "") => {
  const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp("(?:^|\\s|`|\\*)\\[APPROVE:\\s*" + escaped + "\\s*\\](?:\\s|$|`|\\*)", flags + "ms")
}

/**
 * 「裁决通过」启发式判定（R2 + R3.1 修订 + v3 单元格锚定，docs/2026-09-01-advisor-config-design.md §3.8）：
 * ① 无「未解决」🔴 行：只检查 markdown 表格行中 severity 单元格精确 = 🔴（允许 ** 加粗包裹）
 *   的行，且行内无修复标记（Fixed/Resolved/已修复/已解决/已验证/核销等）才视为未通过；
 *   描述/Notes 文本中的 🔴 字样不参与判定（v3 踩坑记录见下）；
 * ② 输出含通过性结论词（通过 / 批准 / approved，忽略大小写），且该词不在否定语境
 *   （不/未/非/没/难以/无法 + 通过|批准，或 not/never + approved——“未通过”、
 *   "not approved" 不算通过）。任一条件不满足 → 按未通过处理（拿不准就不签发）。
 * 注意：结论词清单与 Approval Signal 措辞是配套设计——消息构建（advisor-msgs.mjs）
 * 明确要求通过时「state that the design is approved」，以可靠命中本启发式。
 * 该启发式与 [APPROVE:<code>] 回显是 AND 关系，两者都命中才签发。
 * v3 踩坑记录：v0 任何含 🔴 行 → 收敛轮 Fixed 表误拒；v1 行含 🔴 无修复标记 → "no 🔴"
 * 总结句误拒；v2 只表格行 → 描述文本引用 "🔴" 字样（如 T17 措辞）误拒（2026-09-02 实测）。
 */
const APPROVAL_VERDICT_RE = /((?:不|未|非|没|难以?|无法|未能|没能|没法|不能|不得|不可|不予|未曾|拒绝|驳回|尚不|暂不|没有|不曾|不会|不再)(?:[\u4e00-\u9fa5])?|(?:not|never|no|cannot|can'?t|won'?t|doesn'?t|isn'?t|aren'?t)\s+(?:\w+\s+)?)?(通过|批准|\bapproved\b)/gi
const RESOLVED_MARK_RE = /(?:fixed|resolved|addressed|done|corrected|已修复|已解决|已验证|核销)/i
/** 未解决标记：否定/待定语境下的修复词不算已修复（"not done"、"pending"、"未修复"、"仍…"）。 */
const UNRESOLVED_MARK_RE = /(?:not\s+(?:fixed|done|resolved|addressed|corrected|verified)|unfixed|未修复|尚未修复|仍未|pending|仍\s*(?:未|没有))/i
/** severity 单元格以 🔴 开头（允许 ** 加粗与 "🔴 Critical"/"🔴(must fix)" 后缀）；限短单元格（≤16）避免描述列误伤。 */
const RED_SEVERITY_CELL_RE = /^\s*(?:\*\*)?🔴(?:\*\*)?(?=\s|\(|$)/
export function isApprovalVerdict(text) {
  const s = String(text ?? "")
  for (const line of s.split("\n")) {
    if (!/^\s*\|/.test(line)) continue
    const cells = line.split("|").map(c => c.trim())
    const hasRedSeverity = cells.some(c => c.length <= 16 && RED_SEVERITY_CELL_RE.test(c))
    if (hasRedSeverity && (!RESOLVED_MARK_RE.test(line) || UNRESOLVED_MARK_RE.test(line))) return false
  }
  APPROVAL_VERDICT_RE.lastIndex = 0
  let m
  while ((m = APPROVAL_VERDICT_RE.exec(s)) !== null) {
    if (!m[1]) return true // 至少存在一个非否定语境的结论词
  }
  return false
}

/** token 第二段 expiresAt（毫秒时间戳）；畸形 → null。hhmmFromToken 与 F10 落盘共用同一
 *  解析路径（docs/2026-09-02 §5 确认项 4——避免重复实现）。 */
export function tokenExpiryMs(token) {
  const exp = Number.parseInt(String(token).split(":")[1], 10)
  return Number.isFinite(exp) ? exp : null
}

/** token 第二段 expiresAt → 本地 HH:MM（R3 Approved 消息的有效期提示）。 */
function hhmmFromToken(token) {
  const exp = tokenExpiryMs(token)
  if (exp === null) return "??:??"
  const d = new Date(exp)
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")
}

// ————————————— DSH 消息构造 —————————————

const uid = () => "adv-" + randomUUID()

function userMsg(text) {
  return { id: uid(), role: "user", content: [{ type: "text", text }], source: { kind: "user" } }
}
function assistantMsg(blocks, provider, model) {
  return {
    id: uid(), role: "assistant",
    content: blocks.filter(b => b.type === "text" || b.type === "tool-call"),
    source: { kind: "model", provider, model },
  }
}
function toolResultMsg(callId, text) {
  return {
    id: uid(), role: "user",
    content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }], isError: false }],
    source: { kind: "tool", callId },
  }
}

// ————————————— 上下文压缩（本地裁剪，无 LLM 摘要） —————————————

function estimateTokens(messages) {
  return messages.reduce((sum, m) => sum + Math.ceil(JSON.stringify(m.content ?? []).length / 4), 0)
}

/**
 * 压缩：保首条 user + 最近 20 条，中间以本地摘要替换（对齐 thincoder run.mjs）。
 * 边界守卫：窗口起点若落在 tool-result 上会制造孤儿 tool 消息（违反协议配对），
 * 向前回退到非 tool-result 消息为止。
 * D 复核（docs/2026-09-02-session-state-stages-design.md §4 小改进）：keyFiles **去重 +
 * 上限 15**（原只留 5 且不去重——中段被压缩后评审易重复读已查文件浪费回合；确定性零成本）。
 * 导出供 T13 单测直测（行为对 ≤20 条消息为零变更——messages.length <= 20 早退）。
 */
export function compactMessages(messages) {
  if (messages.length <= 20) return
  const first = messages[0]
  let start = messages.length - 20
  while (start > 1 && messages[start] && messages[start].role === "user"
    && messages[start].content?.[0]?.type === "tool-result") start--
  const recent = messages.slice(start)
  const old = messages.slice(1, start)
  const toolCount = old.filter(m => m.content?.[0]?.type === "tool-result").length
  const keyFiles = [...new Set(
    old
      .filter(m => m.content?.[0]?.type === "tool-result")
      .map(m => (m.content[0].content?.[0]?.text ?? "").split("\n")[0]?.slice(0, 50))
      .filter(Boolean),
  )].slice(0, 15)
  const filesPart = keyFiles.length > 0 ? " Key files examined: " + keyFiles.join(", ") : ""
  const summary = "[Context compacted] Earlier exploration: " + toolCount + " tool calls completed." + filesPart
  messages.splice(0, messages.length, first, userMsg(summary), ...recent)
}

// ————————————— 流收集（绝对截止 + idle 看门狗双机制，§3.4） —————————————

// 单次 LLM 调用的 chunk 级看门狗（thincoder 有 per-request FETCH_TIMEOUT；DSH
// GenerateOptions 无超时字段，挂起的请求会把循环卡到天荒地老——循环顶的整体
// 超时检查在 await 期间永远不执行。看门狗把挂起变成可诊断的错误）。
//
// §3.4 双机制：
// - 绝对截止：每次调用挂一个 setTimeout(deadlineMs) 截止定时器（不依赖 chunk 到达，
//   静默流同样在预算时刻被中止），并在每个 chunk 到达时做墙钟检查双保险；触发即 abort
//   （reason 含 "deadline reached" → 上层按 timeout 处理，不重试）；
// - idle 看门狗：watchdogMs 内无任何 chunk → abort（reason 含 "llm call stalled" → 上层按
//   stall 重试），窗口 clamp 到 min(watchdogMs, deadlineMs)——timeoutMs 小于看门狗窗口时
//   看门狗不喧宾夺主。stallMsOverride 仅测试注入缝（§5.1，非用户配置）。
async function collectStream(llm, streamOpts, cfg = {}) {
  const { watchdogMs = LLM_CALL_STALL_MS, stallMsOverride = null, deadlineMs = null } = cfg
  const blocks = []
  let finish = null
  const wd = new AbortController()
  let wdTimer = null
  const deadlineAt = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Date.now() + deadlineMs : null
  const wdWindow = Number.isFinite(stallMsOverride) && stallMsOverride > 0
    ? stallMsOverride
    : (deadlineAt !== null ? Math.min(watchdogMs, deadlineMs) : watchdogMs)
  const stallError = () => new Error(
    "llm call stalled " + Math.round(wdWindow / 1000) + "s without a chunk (provider or adapter hang)")
  const deadlineError = () => new Error(
    "advisor review deadline reached after " + Math.round(deadlineMs / 1000) + "s (review budget exhausted)")
  const abortWith = (err) => { clearTimeout(wdTimer); try { wd.abort(err) } catch { /* 已中止 */ } }
  const arm = () => {
    clearTimeout(wdTimer)
    if (deadlineAt !== null && Date.now() >= deadlineAt) { abortWith(deadlineError()); return }
    const windowMs = deadlineAt !== null
      ? Math.max(1, Math.min(wdWindow, deadlineAt - Date.now()))
      : wdWindow
    wdTimer = setTimeout(() => {
      abortWith(deadlineAt !== null && Date.now() >= deadlineAt ? deadlineError() : stallError())
    }, windowMs)
    wdTimer.unref?.()
  }
  let deadlineTimer = null
  let iterator = null // round2 #2：外提使 finally 可关闭流（try 内声明的 iterator 在 finally 不可见）
  try {
    arm()
    // 绝对截止定时器：独立于 chunk 到达与看门狗重试，预算到点即中止（§3.4）
    if (deadlineAt !== null) {
      deadlineTimer = setTimeout(() => abortWith(deadlineError()), deadlineMs)
      deadlineTimer.unref?.()
    }
    const combined = streamOpts.signal ? AbortSignal.any([streamOpts.signal, wd.signal]) : wd.signal
    iterator = llm.stream({ ...streamOpts, signal: combined })[Symbol.asyncIterator]()
    const stallP = new Promise((_, reject) => {
      wd.signal.addEventListener("abort", () => reject(wd.signal.reason ?? stallError()), { once: true })
    })
    stallP.catch(() => {}) // 兜底：看门狗迟到 reject 不成为 unhandled rejection（code review #2）
    while (true) {
      const step = await Promise.race([iterator.next(), stallP])
      if (step.done) break
      // chunk 墙钟双检查（绝对截止不依赖看门狗时序）
      if (deadlineAt !== null && Date.now() >= deadlineAt) {
        abortWith(deadlineError())
        throw deadlineError()
      }
      arm()
      const chunk = step.value
      if (chunk?.type === "block-end") blocks.push(chunk.block)
      else if (chunk?.type === "finish") finish = chunk
    }
    return { blocks, finish }
  } finally {
    clearTimeout(wdTimer)
    if (deadlineTimer) clearTimeout(deadlineTimer)
    // 关闭流自身也要有界：async generator 挂在内层 await 时 .return() 永不落定，
    // 无界 await 会让看门狗在清理阶段被击穿。给关闭 2s，超时放弃（残留连接交给 OS/网关回收）。
    let closeP = Promise.resolve()
    try { closeP = Promise.resolve(iterator.return?.()).catch(() => {}) } catch { /* 同步抛出：无可关闭 */ }
    await Promise.race([closeP, new Promise(r => setTimeout(r, 2000))])
  }
}

// ————————————— 工具循环（预算硬生效） —————————————

function classifyStreamError(msg) {
  return /rate limit|429/i.test(msg) ? "rate limit"
    : /timeout/i.test(msg) ? "timeout"
    : /network|ECONNREFUSED/i.test(msg) ? "network"
    : /context length/i.test(msg) ? "context_too_long"
    : /stalled/.test(msg) ? "provider_stall"
    : "unknown"
}

/**
 * 工具循环（单轮评审）。
 * @param deps { llm, stallMs? } — stallMs 非用户配置（内部/测试注入缝）
 * @param opts { provider, model, effort?, system, firstUserText, cwd, signal, timeoutMs,
 *              sessionId, stallMsOverride? } — stallMsOverride 仅测试注入（§5.1）
 * 预算模型（§3.4）：timeoutMs = 该轮组 timeoutMs（resolveAdvisorRoute 输出）。
 * 绝对截止优先于 stall：预算到点（elapsed >= timeoutMs）即返回 timeout（增强消息，
 * 含已完成轮次/已读文件数），无论是否处于 stall 重试中；deadline 计时器跨 stall 重试
 * 持续运行（每次尝试用剩余预算重算 deadlineMs，重试不豁免预算）。stall 错误仅在预算
 * 未耗尽且 STREAM_ATTEMPTS 重试全败时返回（provider_stall 诊断，保持现行为）。
 */
export async function runAdvisorToolLoop(deps, opts) {
  const { provider, model, system, firstUserText, cwd, signal, timeoutMs, sessionId } = opts
  const effort = isValidEffort(opts.effort) ? opts.effort : null // N4 兜底（非法 effort 回落不传）
  const impls = advisorToolImpls(cwd)
  const tools = advisorToolSchemas()
  const messages = [userMsg(firstUserText)]
  let turns = 0           // 已开始的 LLM 工具轮（runaway 守卫）
  let roundsDone = 0      // 已完成（产出 tool calls 并执行完毕）的轮
  let filesRead = 0       // 已成功执行的 read 调用次数（§3.4 超时消息用）
  const startTime = Date.now()
  const timeoutMsg = () => "Advisor: review timeout after "
    + Math.max(0, Math.round((Date.now() - startTime) / 1000))
    + "s (completed " + roundsDone + " tool rounds, " + filesRead
    + " files read). Try again with a narrower scope."

  while (true) {
    if (signal?.aborted) return "Advisor: interrupted."
    if (Date.now() - startTime >= timeoutMs) return timeoutMsg()
    if (++turns > MAX_ADVISOR_TURNS) {
      return "Advisor: stopped after " + MAX_ADVISOR_TURNS + " tool rounds — the review appears to be looping. You may retry with a narrower scope."
    }
    const currentTokens = estimateTokens(messages)
    if (currentTokens > MAX_CONTEXT_TOKENS * 0.8) {
      compactMessages(messages)
      if (estimateTokens(messages) > MAX_CONTEXT_TOKENS) {
        return "Advisor: context window limit reached (" + estimateTokens(messages) + " tokens). Review incomplete — too many tool calls. Try a narrower scope."
      }
    }

    // sessionId/purpose/maxTokens 对齐生态先例（dsh-session-title-llm）：
    // llm/stream 中间件按 sessionId 归因，裸调用有挂起风险
    const stallCfg = deps.stallMs
    const stallMs = Number.isFinite(stallCfg) && stallCfg > 0 ? stallCfg : LLM_CALL_STALL_MS
    const streamOpts = {
      provider, model, system, messages, tools, signal,
      ...(sessionId ? { sessionId } : {}),
      purpose: "thincoder-advisor",
      maxTokens: LLM_MAX_TOKENS,
      ...(effort ? { reasoningEffort: effort } : {}), // §3.3 effort 透传（字段名以 dsh-llm GenerateOptions 为准）
    }
    let result = null
    let lastErr = null
    for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt++) {
      // 预算到点检查（跨 stall 重试的 backoff 睡眠期间同样生效——重试不豁免预算）
      if (Date.now() - startTime >= timeoutMs) return timeoutMsg()
      try {
        result = await collectStream(deps.llm, streamOpts, {
          watchdogMs: stallMs,
          stallMsOverride: opts.stallMsOverride,
          deadlineMs: timeoutMs - (Date.now() - startTime), // 轮内剩余预算（§3.4）
        })
        lastErr = null
        break
      } catch (e) {
        // 裁决顺序：绝对截止优先——预算到点即 timeout（即使适配器以 AbortError 形式抛出
        // 我们的 deadline reason，也先于「interrupted」归类，§3.4）
        if (/deadline reached/.test(e?.message ?? String(e))) return timeoutMsg()
        if (e?.name === "AbortError" || signal?.aborted) return "Advisor: interrupted."
        const msg = e?.message ?? String(e)
        lastErr = e
        // 仅看门狗 stall 走重试：失败调用没有产出可用内容，messages 原样复用
        if (!/stalled/.test(msg)) break
        if (attempt < STREAM_ATTEMPTS) {
          if (Date.now() - startTime >= timeoutMs) return timeoutMsg()
          await new Promise(r => setTimeout(r, 1000 * attempt))
        }
      }
    }
    if (lastErr) {
      // 预算耗尽优先于 stall 诊断（§3.4 裁决顺序）
      if (Date.now() - startTime >= timeoutMs) return timeoutMsg()
      const msg = lastErr?.message ?? String(lastErr)
      const errorType = classifyStreamError(msg)
      const retryAdvice = errorType === "rate limit" ? "Wait a moment and retry. Consider using a cheaper model for advisor."
        : errorType === "timeout" ? "The model took too long. Try with a narrower scope."
        : errorType === "context_too_long" ? "Reduce the scope (fewer files/paths) or use a model with larger context window."
        : errorType === "provider_stall" ? "The provider stream stalled after " + STREAM_ATTEMPTS + " attempts. Retry the advisor call, or configure a different advisor provider/model."
        : "You may retry or proceed to verify manually."
      return "Advisor: review failed (" + errorType + ") — " + msg + ". " + retryAdvice
    }

    const { blocks, finish } = result
    const reason = finish?.reason
    if (reason?.kind === "aborted") return "Advisor: interrupted."
    if (reason?.kind === "error") {
      const failure = reason.failure ?? {}
      return "Advisor: review failed — " + (failure.message ?? "unknown provider error")
    }

    const toolCalls = blocks.filter(b => b.type === "tool-call")
    const text = blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("")
    if (toolCalls.length === 0) {
      return text.trim() || "Advisor: (empty response — review was inconclusive)"
    }

    messages.push(assistantMsg(blocks, provider, model))
    for (const tc of toolCalls) {
      let resultText = null
      let args = {}
      try { args = JSON.parse(tc.arguments || "{}") }
      catch (e) { resultText = "Error: invalid JSON in tool arguments: " + e.message }
      if (resultText === null) {
        const impl = impls.get(tc.name)
        if (!impl) {
          resultText = "Error: unknown tool \"" + tc.name + "\". Available: " + [...impls.keys()].join(", ")
        } else {
          try { resultText = String(await impl(args)) }
          catch (e) { resultText = "Error (execution_error): " + (e?.message ?? String(e)) }
        }
      }
      // 超时消息的「已读文件数」：read 工具调用成功执行即计入（§3.4）
      if (tc.name === "read" && resultText !== null && !String(resultText).startsWith("Error")) {
        filesRead++
      }
      messages.push(toolResultMsg(tc.id, resultText))
    }
    roundsDone++ // 本工具轮（产出 tool calls 并执行完毕）完成
  }
}

// ————————————— 评审入口 —————————————

/**
 * F12（§2.3）写点 helper：语义转换点落盘（advisor 完成分支轮次推进 / F11 类型切换重置）。
 * viewOfSessionState 组装白名单视图 → saveSessionState（原子写 + 截断/封顶净化 + 孤儿清扫，
 * 内部 fail-safe：任何失败仅 warn 不抛——评审/签发流程不依赖持久化成功，内存态兜底）。
 * storPathOverride = opts 注入缝（对齐 F10 saveTokenRecord 先例，测试用临时目录）。
 */
function persistSessionState(agent, state, opts) {
  try {
    saveSessionState(
      agent.session.id,
      viewOfSessionState(state),
      opts?.storPathOverride,
      agent.session?.header?.cwd,
    )
  } catch { /* N3 fail-safe：写盘故障不击穿评审流程（save 内部已 warn） */ }
}

function isDocFile(p) {
  const norm = String(p).replace(/\\/g, "/")
  if (norm.startsWith("docs/")) return true
  return /\.(md|markdown|mdx|txt|rst|adoc)$/i.test(norm)
}

function withTime(prompt) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
  return prompt + "\n\nCurrent time: " + new Date().toLocaleString("sv-SE") + " (" + timeZone + ")."
}

/**
 * 运行一次 advisor 评审（收敛协议入口 + 分层路由）。
 * @param deps  { llm } — 宿主 LlmRuntime
 * @param opts  { agent, config, signal, reviewType, documents, paths, configDefaultEngineering,
 *               storPathOverride? } — storPathOverride = F10 存储路径注入缝（测试用临时目录，
 *               对齐 stallMsOverride 先例，非用户配置；缺省走 token-store 的 DSH_HOME 解析）
 * @returns 评审文本（错误/上限消息以 "Advisor:" 前缀返回）
 */
export async function runAdvisorReview(deps, opts) {
  const { agent, signal } = opts
  // 二期（docs/2026-09-02-settings-ui-design.md §2/§3.6-1）：config 消费点统一合并 user 层——
  // 生效全局 = entry base ⊕ config.json user 层（每次评审调用时读，保存即生效 U5；
  // config.json 缺失/损坏 → 无 user 层回落 base，N3）。agent session cwd 作路径探测起点。
  const config = effectiveGlobalConfig(opts.config ?? {}, { cwdHint: agent?.session?.header?.cwd })
  const state = sessionState(agent.session.id)
  const reviewType = opts.reviewType === "design" ? "design" : "code"
  // F11（2026-09-02 reviewType 隔离）：code ↔ design 切换 → 重置轮次与 prior——
  // 轮次预算跨类型共享，但新设计文档评审必须从 round 1 开始，不得携带 code 评审的 prior
  // （实测事故：code review 3 轮后发起 design 评审走了收敛轮，扩展文档未被 round 1 评审）。
  // F12（§2.3 写点表）：类型切换重置也是语义转换点——重置为 0/清 prior 同样落盘
  // （否则重启后恢复出切换前的旧轮次/prior，跨类型污染复活）。
  const typeSwitched = state.lastReviewType && state.lastReviewType !== reviewType
  if (typeSwitched) {
    state.advisorRound = 0
    state.lastAdvisorOutput = null
  }
  state.lastReviewType = reviewType
  if (typeSwitched) persistSessionState(agent, state, opts)
  const documents = Array.isArray(opts.documents) ? opts.documents : null
  const paths = Array.isArray(opts.paths) && opts.paths.length > 0
    ? opts.paths
    : (state.touchedFiles?.length ? [...state.touchedFiles] : null)

  if (reviewType !== "design" && !paths && !documents) {
    return "Advisor: no review scope specified. Provide paths (files/directories to review) or documents (acceptance criteria context)."
  }
  if (reviewType === "design" && documents) {
    const invalid = documents.filter(d => !isDocFile(String(d)))
    if (invalid.length > 0) {
      return "Advisor: design review documents must be in docs/ directory or be recognized doc files. Invalid: " + invalid.join(", ")
    }
  }

  // 机械收敛上限（第 6 次零 LLM 直接拒；code 与 design 共享预算）
  if ((state.advisorRound || 0) >= MAX_ADVISOR_ROUNDS) {
    const unfixed = extractUnfixedIssues(state.lastAdvisorOutput)
    let message = "Advisor: convergence cap reached after " + MAX_ADVISOR_ROUNDS + " rounds.\n"
    if (unfixed.length > 0) {
      message += "\nUnresolved issues from prior rounds:\n" + unfixed.map(i => "- " + i).join("\n") + "\n"
    } else {
      message += "\nAll prior issues appear resolved.\n"
    }
    message += "\nOptions:\n1. Accept current state and proceed\n2. Manually review specific concerns with read/grep\n3. Start a new session to reset the advisor"
    return message
  }

  const agentOpts = agent.options ?? {}
  const cwd = agent.session?.header?.cwd || process.cwd()

  // 无 prior 且本 run 无代码变更 → 重置轮次预算（对齐 thincoder 2026-08-05 决策）。
  // 先于路由解析执行：重置后 advisorRound=0 → round1 组（§3.2 路由键语义）
  const hasPrior = (state.advisorRound || 0) > 0 && state.lastAdvisorOutput
  if (!hasPrior && !(state.mutatedThisRun ?? false)) state.advisorRound = 0

  // 分层路由（§3.1/§3.2）：组配置解析 + 会话覆盖（§3.6）→ legacy → 主代理路由
  const override = state.advisorOverride ?? null
  const route = resolveAdvisorRoute({ config, override, agentOpts, advisorRound: state.advisorRound })
  for (const w of route.warnings) console.warn("[thincoder-suite] " + w)
  // code review #3：N4 配置警告随工具返回文本带出（主会话可见；不进 lastAdvisorOutput，避免污染 prior 原文）
  const warnPrefix = route.warnings.length > 0
    ? "⚠️ [thincoder-suite] advisor configuration warnings:\n" + route.warnings.join("\n") + "\n\n"
    : ""
  if (!route.ok) {
    return warnPrefix + "Advisor: no LLM route available — configure advisor.round1 / advisor.convergence (or legacy advisor.provider / advisor.model) in the plugin config, or run from a session with a default model route."
  }

  // R2：designToken 每评审会话只铸造一次——首次 design 评审铸造后存 sessionState，
  // 整个 advisor 调用序列（round 1 与收敛轮）复用同一 token → 每轮 Approval Signal
  // 展示同一批准码。存量 token 失效（过期/畸形）时重铸，否则长会话将永远签不出有效 token。
  let designToken = null
  if (reviewType === "design") {
    if (!state.pendingDesignToken || !validateDesignToken(state.pendingDesignToken)) {
      state.pendingDesignToken = generateDesignToken(config)
    }
    designToken = state.pendingDesignToken
  }
  const history = (() => { try { return agent.session?.deriveMessages?.() ?? [] } catch { return [] } })()
  const engineering = engEffective(state, opts.configDefaultEngineering)
  const includeProjectGuide = resolveIncludeProjectGuide({ config, override }).value

  const system = withTime(buildAdvisorSystemPrompt(state, reviewType))
  const userText = buildAdvisorUserMessage({
    cwd, history, state, reviewType, designToken, documents, paths, engineering, includeProjectGuide,
  })

  let result
  try {
    result = await runAdvisorToolLoop(deps, {
      provider: route.provider, model: route.model, effort: route.effort ?? undefined,
      system, firstUserText: userText, cwd, signal, timeoutMs: route.timeoutMs,
      sessionId: agent.session.id,
    })
  } catch (e) {
    if (e?.name === "AbortError" || signal?.aborted) return warnPrefix + "Advisor: interrupted."
    return warnPrefix + "Advisor: review failed — " + (e?.message ?? String(e))
  }

  // 引用机械校验 + 存 prior + 轮次推进（仅完成态推进；"Advisor:" 错误/中断消息不烧轮次）
  let final = result
  const completed = !String(result).trimStart().startsWith("Advisor:")
  if (completed) {
    final = appendCitationReport(result, cwd)
    const trimmed = final.trim()
    const looksLikeReview = /\|.*\|.*\|/.test(trimmed) || trimmed.length >= 200
    if (looksLikeReview) state.lastAdvisorOutput = final
    state.advisorRound = (state.advisorRound || 0) + 1
    // F12（§2.3 写点表）：完成分支轮次推进后写盘（advisorRound/lastAdvisorOutput/
    // lastReviewType 原子组——§2.1：单存轮次会恢复出「无 prior 的收敛轮」；touchedFiles
    // 若有并入同样被本视图覆盖）。失败仅 warn（N3：丢=回内存行为）。
    persistSessionState(agent, state, opts)
  }

  if (reviewType === "design") {
    // R2 签发判定：裁决通过（isApprovalVerdict 启发式）∧ [APPROVE:<code>] 回显命中，
    // 缺一不可。code 展示在每轮 Approval Signal（token 本体不进提示词），宿主校验
    // 命中后自行注入完整 token；非通过轮的任何 code 回显忽略（不签发不报错）；
    // 旧格式 [DESIGN-TOKEN:...] 路径已废除，与未回显同待遇。
    const code = designToken ? designApprovalCode(designToken) : null
    const verdictPassed = completed && isApprovalVerdict(result)
    if (designToken && result && verdictPassed && code && makeApprovalCodeRegex(code).test(result)) {
      state.designToken = designToken
      // F10：签发落盘（docs/2026-09-02 §2.1 写入时序，state.designToken = designToken 之后、
      // 返回前）——token 持久化为第二存储（重启后 eng_coder 仍可用）。saveTokenRecord 内部
      // mkdir/读写失败仅 console.warn 不抛（N2 fail-safe：签发不依赖持久化成功，内存态兜底）；
      // expiresAt 取 token 第二段（tokenExpiryMs，与 hhmmFromToken 同解析路径）。
      saveTokenRecord(agent.session.id, {
        token: designToken,
        issuedAt: Date.now(),
        expiresAt: tokenExpiryMs(designToken),
      }, opts.storPathOverride, agent.session?.header?.cwd)
      const clean = String(result).replace(makeApprovalCodeRegex(code, "g"), "").trim()
      return warnPrefix + clean + "\n\nApproved. Pass this exact token to eng_coder (designToken parameter): " + designToken
        + "\n（有效至 " + hhmmFromToken(designToken) + "，TTL engTokenTtlMs）"
    }
    if (completed) {
      state.designToken = null // 完成但未通过 → 撤销既有签发（pendingDesignToken 保持：下轮同一批准码）
      removeTokenRecord(agent.session.id, opts.storPathOverride, agent.session?.header?.cwd) // 评审 #2：磁盘同步撤销，防重启后复活
    }
    if (result) {
      let out = String(result)
      if (verdictPassed) {
        // R3 诊断行：裁决通过但批准码校验失败（未回显 / 回显不符 / 旧格式）
        out += "\n\n评审通过但批准码校验失败——请重跑评审（本轮 token 未签发）"
      }
      const body = out.trim() || "Advisor: design review did not pass."
      return warnPrefix + body
    }
  }
  return warnPrefix + final
}

