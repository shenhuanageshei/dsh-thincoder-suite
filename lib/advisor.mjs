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
import { normalizeRunnerValue, resolveCodexCliGlobals, runCodexTask } from "./codex-adapter.mjs"
import { resolveSupportedEffort, resolveCodexRowEffort } from "./effort-resolve.mjs"
import {
  buildAdvisorSystemPrompt, buildAdvisorUserMessage, appendCitationReport,
  extractUnfixedIssues,
} from "./advisor-msgs.mjs"

export const MAX_ADVISOR_ROUNDS = 5     // 机械收敛上限：第 6 次调用零 LLM 直接拒
const MAX_ADVISOR_TURNS = 100           // 工具轮硬上限（runaway-loop 守卫）
const MAX_CONTEXT_TOKENS = 120_000      // 上下文窗口预算（预留余量）

// ————————————— codex runner 平台墙钟与智能回落（二期评审反馈，2026-09-04） —————————————
// DSH 平台对单次同步工具调用有 600s 墙钟（实证：advisor 调用 600000ms 整被
// "wall-clock ceiling reached" 截断，与 thincoder 预算无关）。因此：
// ① codex 评审预算 >540s 一律截到 540s（留 60s 余量给 envelope 返回）——超出部分
//    永远跑不完，截断并告警比无声被平台杀死诚实；
// ② 连续 2 次 codex 失败（TIMEOUT/PROCESS_ERROR/NO_OUTPUT/RUNNER_UNAVAILABLE）→
//    下一轮自动回落 dsh 路由一轮（响亮告警，非静默）；回落成功后计数清零、codex 下轮
//    重试。回落失败不清零（R3 D-07 顺序修正——旧代码在回落执行前清零致 codex↔dsh 无界
//    交替），连续 2 次回落失败硬停（双路由诊断 + 修正指引，不再交替重试——D-裁决-3）。
const CODEX_FAILURE_FALLBACK_THRESHOLD = 2
// 连续失败计数：会话级内存态（不落盘；会话销毁即弃——失败计数不是需要持久化的状态）
const codexFailureCount = new Map() // sessionId → 连续失败次数

// ————————————— R3 §5.1（D-07 / D-裁决-3）：回落封顶与硬停 —————————————
// 计数器语义（设计 §5.1 精确版）：
// - codexFailureCount：codex 路由失败 +1、任一路由成功清零、回落轮结果产出后才执行
//   delete（顺序修正：旧代码在回落执行前 delete——回落失败后计数已清，codex↔dsh 无界
//   交替；新语义下回落失败不清零 → 下一调用直接再进回落轮，连续 2 次回落失败即硬停）；
// - fallbackFailureCount：回落轮失败 +1（含「回落 dsh 路由不可达」形态）、任一路由成功清零；
// - 两计数器独立于 advisorRound（失败不烧轮次）；任何组合的零进度循环在「连续 2 次回落
//   失败」硬停处终止（不再交替重试，D-裁决-3）；
// - 硬停状态（advisorHardStops）需显式动作解除：armed 后同会话后续 advisor 调用持续返回
//   硬停指引而非静默重试，直到配置变更（路由指纹失配自动解除）或会话重置（D-22 清理组）。
const FALLBACK_HARD_STOP_THRESHOLD = 2
const fallbackFailureCount = new Map() // sessionId → 连续回落失败次数
const codexLastFailure = new Map()     // sessionId → 最近一次 codex 失败码（硬停诊断「最近失败码」）
const fallbackLastFailure = new Map()  // sessionId → 最近一次回落失败原因（硬停诊断用）
const advisorHardStops = new Map()     // sessionId → { fingerprint, at }（armed 硬停状态）

/** 任一路由成功 / 会话销毁 → 回落自愈状态全部清零（双计数器 + 最近失败码 + 硬停——硬停防御性同清）。 */
function resetRouteFailureState(sid) {
  codexFailureCount.delete(sid)
  fallbackFailureCount.delete(sid)
  codexLastFailure.delete(sid)
  fallbackLastFailure.delete(sid)
  advisorHardStops.delete(sid)
}

/**
 * R2 §4.5（D-22）：codexFailureCount 会话销毁清理（index.mjs session/disposed 既有清理组
 * 接线——与 clearCodexThread 同生命周期语义：会话死即弃，防进程级滞留跨会话误回落）。
 * R3 §5.1（D-07）：清理范围扩展到回落计数/最近失败码/硬停状态（同一生命周期语义——
 * 硬停随会话重置解除；index.mjs 挂点零改动）。
 */
export function clearCodexFailureCount(sessionId) {
  resetRouteFailureState(String(sessionId ?? ""))
}

/**
 * R3 §5.1（D-07）：advisor 路由配置指纹（硬停解除判据——「配置变更」）。覆盖双路由解析的
 * 全部输入：advisor 组配置（含 legacy / 组内 runner / provider/model/effort/timeoutMs）⊕
 * codexCli 全局节 ⊕ 会话覆盖 ⊕ 主代理路由。任一变更（advisor_config set/reset、全局设置页
 * 保存、agent 路由变化）→ 指纹失配 → 硬停自动解除。
 */
function advisorRouteFingerprint(config, override, agentOpts) {
  try {
    return JSON.stringify({
      advisor: config?.advisor ?? null,
      codexCli: config?.codexCli ?? null,
      override: override ?? null,
      agent: { provider: agentOpts?.provider ?? null, model: agentOpts?.model ?? null },
    })
  } catch { return "unserializable" } // 病态不可序列化配置：恒等指纹（硬停持续——诚实保守）
}

/** 回落轮失败 +1 并记录最近失败原因（硬停诊断用）。返回新计数（封顶 99）。 */
function bumpFallbackFailure(sid, reason) {
  const n = Math.min((fallbackFailureCount.get(sid) ?? 0) + 1, 99)
  fallbackFailureCount.set(sid, n)
  fallbackLastFailure.set(sid, String(reason ?? "").slice(0, 200))
  return n
}

/**
 * R3 §5.1（D-07 / D-裁决-3）：硬停文本——「双路由皆不可用」+ 配置诊断（codex 路由与 dsh
 * 回落路由各自状态、最近失败码）+ 修正指引（网络/代理、runner 切换、provider 检查）+
 * 解除方式。arm 时与 held 时共用（held 期间路由指纹未变，诊断等价；路由按当前
 * advisorRound 现解析——诊断保持新鲜）。
 */
function fallbackHardStopText(sid, { config, override, agentOpts, advisorRound }) {
  const route = resolveAdvisorRoute({ config, override, agentOpts, advisorRound })
  const fbRoute = resolveAdvisorRoute({ config, override, agentOpts, advisorRound, ignoreRunner: true })
  const lines = [
    "Advisor: 回落硬停——codex 与 dsh 双路由皆不可用（连续 " + FALLBACK_HARD_STOP_THRESHOLD
      + " 次回落失败，D-裁决-3：自愈循环终止，不再交替重试）。",
    "",
    "双路由配置诊断：",
  ]
  if (route.ok && route.runner?.kind === "codex-cli") {
    lines.push("- codex 路由: runner=codex-cli" + (route.model ? " model=" + route.model : "")
      + "，timeoutMs=" + route.timeoutMs + " —— 连续失败 " + (codexFailureCount.get(sid) ?? 0)
      + " 次，最近失败码: " + (codexLastFailure.get(sid) ?? "未知"))
  } else if (route.ok) {
    lines.push("- codex 路由: 当前组未配 codex runner（走 " + route.provider + ":" + route.model
      + "）—— 硬停源于回落轮连续失败")
  } else {
    lines.push("- codex 路由: 路由解析失败（provider/model 解析链耗尽）")
  }
  if (fbRoute.ok) {
    lines.push("- dsh 回落路由: " + fbRoute.provider + ":" + fbRoute.model + " —— 回落轮连续失败 "
      + (fallbackFailureCount.get(sid) ?? 0) + " 次，最近失败: " + (fallbackLastFailure.get(sid) ?? "未知"))
  } else {
    lines.push("- dsh 回落路由: 不可用（组内未配 provider/model、无 legacy、主代理无默认路由）")
  }
  lines.push(
    "",
    "修正指引：",
    "1. 网络/代理：检查出网与代理配置（codexCli.proxyMode/proxyUrl、环境代理变量）——TIMEOUT/PROCESS_ERROR 的常见根因；",
    "2. runner 切换：codex 持续不可用可把 advisor 组 runner 改回 dsh（或清空 runner 走 provider/model）；",
    "3. provider 检查：确认 dsh 回落路由的 provider/model 在运行时可用（advisor_config set round1.provider/round1.model，或全局设置页）。",
    "",
    "硬停解除：变更 advisor 相关配置（advisor_config set/reset 或全局设置页保存）或重置会话后自动恢复；配置未变更前，本会话后续 advisor 调用将持续返回本指引（不静默重试）。",
  )
  return lines.join("\n")
}

/**
 * R3 §5.1（D-07 / D-裁决-3）：武装硬停（记录路由指纹供「配置变更」解除判据）并返回硬停
 * 文本。armed 后同会话后续 advisor 调用在 runAdvisorReview 入口被 held（见入口检查）。
 */
function armFallbackHardStop(sid, ctx) {
  advisorHardStops.set(sid, {
    fingerprint: advisorRouteFingerprint(ctx.config, ctx.override, ctx.agentOpts),
    at: Date.now(),
  })
  console.warn("[thincoder-suite] advisor 回落硬停（连续 " + FALLBACK_HARD_STOP_THRESHOLD
    + " 次回落失败——codex 与 dsh 双路由皆不可用，自愈循环终止；配置变更或会话重置后恢复）")
  return fallbackHardStopText(sid, ctx)
}

// ————————————— 预算模型（docs/2026-09-01-advisor-config-design.md §3.4） —————————————
const REVIEW_TIMEOUT_MS = 600_000               // 退役常量：现在是 round1 组 timeoutMs 的缺省值来源
const CONVERGENCE_TIMEOUT_DEFAULT_MS = 300_000  // convergence 组 timeoutMs 缺省值
/** timeoutMs 合法区间（导出：config-store/API 校验与工具 coercion 的单一事实源，评审 #5）。 */
export const ADVISOR_TIMEOUT_MIN_MS = 1000
export const ADVISOR_TIMEOUT_MAX_MS = 3_600_000
export const EFFORT_LEVELS = ["off", "low", "medium", "high", "max"]
const LLM_CALL_STALL_MS = 90_000        // idle 看门狗窗口（不再配置化，YAGNI，§3.4）
const STREAM_ATTEMPTS = 3               // 看门狗 stall 时的单调用重试次数（瞬时 provider 挂起自愈）
// D-01 热修正式化（R1 §3.6，2026-09-05 热修 8192→16384 的配置化收口）：单次 LLM 输出预算
// 可配 advisor.maxOutputTokens（缺省 16384；合法 4096..65536）。三面白名单同步（N-5/US-10）：
// index.mjs PUT 校验 ⊕ config-store.mjs merge 白名单 ⊕ 本模块运行时读取（越界回落缺省+告警）。
export const ADVISOR_MAX_OUTPUT_TOKENS_MIN = 4096
export const ADVISOR_MAX_OUTPUT_TOKENS_MAX = 65536
export const ADVISOR_MAX_OUTPUT_TOKENS_DEFAULT = 16384
const LLM_MAX_TOKENS = ADVISOR_MAX_OUTPUT_TOKENS_DEFAULT // 缺省值来源（运行时经 resolveAdvisorMaxOutputTokens 读取配置）

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
/** advisor.maxOutputTokens 只认 4096..65536 整数（D-01/R1 §3.6：PUT 校验与运行时回落共用单一事实源）。 */
export function isValidAdvisorMaxOutputTokens(v) {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)
    && v >= ADVISOR_MAX_OUTPUT_TOKENS_MIN && v <= ADVISOR_MAX_OUTPUT_TOKENS_MAX
}

/**
 * 运行时解析 advisor.maxOutputTokens（§3.6）：未配 → 缺省 16384；越界/非法 → 回落缺省并
 * console.warn 响亮告警（N4 先例：非法配置值不砖化评审，回落+可见）。
 * @param {object} config — 生效全局配置（effectiveGlobalConfig 输出）
 * @returns {number} 生效的单次 LLM 输出预算
 */
export function resolveAdvisorMaxOutputTokens(config) {
  const adv = (config && typeof config.advisor === "object" && !Array.isArray(config.advisor)) ? config.advisor : {}
  const raw = adv.maxOutputTokens
  if (raw === undefined || raw === null) return LLM_MAX_TOKENS
  if (isValidAdvisorMaxOutputTokens(raw)) return raw
  console.warn("[thincoder-suite] advisor.maxOutputTokens " + JSON.stringify(raw)
    + " 非法（需要 " + ADVISOR_MAX_OUTPUT_TOKENS_MIN + ".." + ADVISOR_MAX_OUTPUT_TOKENS_MAX + " 的整数）——回落缺省 " + LLM_MAX_TOKENS)
  return LLM_MAX_TOKENS
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
export function resolveAdvisorRoute({ config, override, agentOpts, advisorRound, ignoreRunner }) {
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
    : key === "timeoutMs" ? isValidTimeoutMs
    : key === "runner" ? ((v) => normalizeRunnerValue(v).ok)
    : isModelField
  const expected = (key) => key === "effort"
    ? "one of off|low|medium|high|max"
    : key === "timeoutMs"
      ? "a number in " + ADVISOR_TIMEOUT_MIN_MS + ".." + ADVISOR_TIMEOUT_MAX_MS
      : key === "runner"
        ? "\"codex-cli\" or an object { kind: \"codex-cli\", model?, effort?, sandbox?, timeoutMs?, proxy?, agentsMd? }"
        : "a non-empty string"
  for (const key of ["provider", "model", "effort", "timeoutMs", "runner"]) {
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

  // —— codex runner 分支（一期 codex-runner）：runner.kind=codex-cli 时整组走 codex 子进程，
  // 不要求 llm-pi-ai 的 provider/model 成对（model 缺省回落 codexCli.model 或 codex 自身默认）。
  // ignoreRunner=true（智能回落）时跳过本分支走既有链。runner 生效但组内显式配了
  // provider/model → 告警（用户反馈的 UX 陷阱：改 provider/model 以为切回 glm，实际被 runner 覆盖）。
  let runner = null, runnerSource = null
  if (eff.runner !== undefined && !ignoreRunner) {
    const nr = normalizeRunnerValue(eff.runner)
    if (nr.ok) { runner = nr.runner; runnerSource = effSource.runner ?? null }
  }
  if (runner && runner.kind === "codex-cli") {
    if (eff.provider !== undefined || eff.model !== undefined) {
      warnings.push("runner=codex-cli 生效中——组内 provider/model（"
        + [eff.provider, eff.model].filter(Boolean).join(":")
        + "）被忽略：codex 行不走 HTTP 路由；要切回 glm 等 dsh 模型，请把 runner 改回 dsh 或清空")
    }
    // R1 code review 折入（R2 §4.5）：resolveCodexCliGlobals 的 warnings 并入 route.warnings
    //（手编 config 的非法 codexCli 值在 codex 路由下运行时同样响亮告警——此前该分支只取
    // model 字段，非法值静默；warnings 经 runAdvisorReview 的 console.warn + warnPrefix 上浮）
    const cg = resolveCodexCliGlobals(config)
    for (const w of cg.warnings) warnings.push(w)
    const codexModel = runner.model ?? cg.globals.model
    const rEffort = runner.effort !== undefined
      ? runner.effort
      : (eff.effort !== undefined ? eff.effort : null)
    const rEffortSource = rEffort === null
      ? null
      : (runner.effort !== undefined ? "codex runner" : (effSource.effort ?? null))
    // timeout：runner.timeoutMs > 组环 > legacy(round1) > 缺省
    let timeoutMs, timeoutSource
    if (runner.timeoutMs !== undefined && isValidTimeoutMs(runner.timeoutMs)) {
      timeoutMs = runner.timeoutMs; timeoutSource = "codex runner"
    } else if (eff.timeoutMs !== undefined) {
      timeoutMs = eff.timeoutMs; timeoutSource = effSource.timeoutMs ?? null
    } else if (legacy && legacy.timeoutMs !== undefined && legacy.timeoutMs !== null && isValidTimeoutMs(legacy.timeoutMs)) {
      timeoutMs = legacy.timeoutMs; timeoutSource = "legacy advisor.*"
    } else {
      timeoutMs = groupKey === "convergence" ? CONVERGENCE_TIMEOUT_DEFAULT_MS : REVIEW_TIMEOUT_MS
      timeoutSource = "default"
    }
    return {
      ok: true, groupKey, provider: "codex-cli", model: codexModel, pairSource: "codex runner",
      effort: rEffort, effortSource: rEffortSource,
      timeoutMs, timeoutSource,
      runner, runnerSource, warnings,
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

// ————————————— D-18/D-01 结构化观测（R1 诊断层） —————————————

/**
 * 流结束观测行（N-2：finish.reason.kind + failure.message + block 计数 + finish 携带的
 * usage——失败可归因，不单独依赖单一信号）。流结束即 console.warn 留档；失败/空响应
 * 文本追加本行（D-18）。
 */
function streamObservationLine(finish, blocks) {
  const textBlocks = blocks.filter((b) => b && b.type === "text").length
  const toolBlocks = blocks.filter((b) => b && b.type === "tool-call").length
  const kind = finish?.reason?.kind ?? null
  const parts = [
    "finish=" + (kind === null ? "null" : String(kind)),
    "blocks(text=" + textBlocks + ",tool-call=" + toolBlocks + ")",
  ]
  const failureMsg = finish?.reason?.failure?.message
  if (typeof failureMsg === "string" && failureMsg !== "") {
    parts.push("failure.message=" + JSON.stringify(failureMsg.slice(0, 200)))
  }
  const usage = finish?.usage
  parts.push("usage=" + (usage !== undefined && usage !== null ? JSON.stringify(usage) : "none"))
  return "[thincoder-suite] stream observation: " + parts.join(" | ")
}

/**
 * D-01 空响应/错误无消息分类行（R1 观测 + R3 重试适用域判定）。
 * 三形态区分（登记表 D-01：finish null / stop 零块 / error 无 message）+ finish=length
 * 显式分类（生产复现根因：maxTokens 在推理阶段耗尽 → length 零文本块）。非基础设施
 * 形态（本函数所有空产出形态——error 提前返回不达）触发 R3 自动重试一次（D-裁决-1）。
 */
function emptyResponseClassification(finish, blocks, maxTokens) {
  if (!finish || !finish.reason) {
    return "finish-null（流结束未收到 finish 事件——传输层或适配器中断，无 finish 观测可归因）"
  }
  const kind = finish.reason.kind
  if (kind === "stop") {
    return "stop-zero-text-blocks（finish=stop 且零文本块——模型真空输出或推理吞尽输出预算，检查 advisor.maxOutputTokens=" + maxTokens + "）"
  }
  if (kind === "length") {
    return "length（输出 token 预算耗尽——推理烧光 maxTokens=" + maxTokens + " 后零正文；上调全局配置 advisor.maxOutputTokens）"
  }
  if (kind === "error") {
    const msg = finish.reason.failure?.message
    return (typeof msg === "string" && msg !== "")
      ? "error（" + String(msg).slice(0, 120) + "）"
      : "error-no-message（错误形态但无诊断信息——provider 错误面缺 failure.message）"
  }
  return String(kind) + "（非预期 finish 形态，零文本产出）"
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
 * 空响应重试（R3 D-01/D-裁决-1）：非基础设施形态空产出自动重试一次（复用 messages、
 * 与 stall 通道独立计数）；再空 → "Advisor:" 前缀失败（不烧轮次/不写 prior）。
 */
export async function runAdvisorToolLoop(deps, opts) {
  const { provider, model, system, firstUserText, cwd, signal, timeoutMs, sessionId } = opts
  const effort = isValidEffort(opts.effort) ? opts.effort : null // N4 兜底（非法 effort 回落不传）
  // §3.6：单次 LLM 输出预算（调用方传 effectiveGlobalConfig 解析值；缺省回落 LLM_MAX_TOKENS）
  const maxTokens = (Number.isFinite(opts.maxTokens) && opts.maxTokens > 0) ? Math.floor(opts.maxTokens) : LLM_MAX_TOKENS
  const impls = advisorToolImpls(cwd)
  const tools = advisorToolSchemas()
  const messages = [userMsg(firstUserText)]
  let turns = 0           // 已开始的 LLM 工具轮（runaway 守卫）
  let roundsDone = 0      // 已完成（产出 tool calls 并执行完毕）的轮
  let filesRead = 0       // 已成功执行的 read 调用次数（§3.4 超时消息用）
  // D-01（R3 / D-裁决-1）：空响应自动重试资格——非基础设施形态每次空产出重试一次
  //（有产出的轮重置资格；与 stall 重试通道（STREAM_ATTEMPTS）独立计数，互不挤占）。
  let emptyRetryArmed = true
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
      maxTokens,
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
    // D-18：流结束结构化观测——console.warn 留档（每轮流结束都记录，含成功轮：观测连续性）
    const obsLine = streamObservationLine(finish, blocks)
    console.warn(obsLine)
    const reason = finish?.reason
    if (reason?.kind === "aborted") return "Advisor: interrupted."
    if (reason?.kind === "error") {
      const failure = reason.failure ?? {}
      const hasMsg = typeof failure.message === "string" && failure.message !== ""
      // D-01 观测（R1）：error 无 message 形态的分类行 + 观测字段（返回语义不变，重试留 R3）
      const clsLine = hasMsg ? "" : "[thincoder-suite] empty-response classification: "
        + emptyResponseClassification(finish, blocks, maxTokens) + "\n"
      return "Advisor: review failed — " + (failure.message ?? "unknown provider error") + "\n" + clsLine + obsLine
    }

    const toolCalls = blocks.filter(b => b.type === "tool-call")
    const text = blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("")
    if (toolCalls.length === 0) {
      const body = text.trim()
      if (body) return body
      // D-01（R3 / D-裁决-1）：空响应自动重试一次。适用形态 = R1 分类中的非基础设施
      // 形态（finish-null / stop 零文本块 / length / 非预期 finish 形态的零产出）；
      // 基础设施形态不走空重试——error（含无 message）在上方 reason.kind 检查处提前
      // 返回，stall 走看门狗 STREAM_ATTEMPTS 通道（既有失败路径）。
      // 重试 = 复用 messages 重新发起同一调用（同 stall 重试通道语义）、独立计数（不占
      // STREAM_ATTEMPTS）；continue 回循环顶 → 预算/turns 守卫照常生效（重试不豁免预算）。
      if (emptyRetryArmed) {
        emptyRetryArmed = false
        console.warn("[thincoder-suite] advisor 空响应（"
          + emptyResponseClassification(finish, blocks, maxTokens) + "）——自动重试一次（复用 messages，D-01/D-裁决-1）")
        continue
      }
      // 再空 → "Advisor:" 前缀的可归因失败（分类 + 观测字段 + 重试标记）：不烧轮次、
      // 不写 prior（finalize completed 判定按前缀失败——空响应占位文本自 R1 起即带前缀，
      // R3 将措辞收敛为显式失败语义）。
      return "Advisor: review failed (empty response — 重试一次仍空)。\n"
        + "[thincoder-suite] empty-response classification: " + emptyResponseClassification(finish, blocks, maxTokens)
        + "\n" + obsLine
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
    emptyRetryArmed = true // 有产出的轮 → 重置空响应重试资格（D-01：每次空产出可重试一次）
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
      sessionStateViewWithGeneration(state), // R2 §4.4（D-10）：generation 随 F12 视图持久化
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

// ————————————— R2 §4.1 共享 jobs 派发模式（escalate/eng codex 整体复制本模块先例） —————————————
// 平台契约（登记表「平台契约要点」）：jobs.start(spec) 返回 branded string `<kind>-N`（非对象）；
// 完成通知只含一行指针（全文经 job_output 读取，保尾截断）；cancel → hooks.cancel → ctrl.abort；
// run() 内无墙钟（jobs 免疫 600s——预算由 run() 自有 watchdog 生效）。

/** UI-2（设计 §7）：后台派发返回文本的接续指令——句柄之外的唯一承诺（D-09：不承诺通知含全文）。 */
export const JOBS_CONTINUATION_INSTRUCTION =
  "等待完成通知后再继续；长任务勿用 job_output wait 阻塞等待（平台等待上限 600s）——完成通知只含一行指针，全文经 job_output 读取。"

/**
 * codexCli.budgetCapMs 解析（未配/非法 → 540000，低于平台 run_code 默认墙钟 600s 留
 * envelope 返回余量）。R2 抽共享：advisor/escalate/eng 三处派发判定与钳制告警的单一实现。
 */
export function resolveCodexBudgetCapMs(config) {
  const cc = (config && typeof config === "object" && config.codexCli
    && typeof config.codexCli === "object") ? config.codexCli : {}
  const v = cc.budgetCapMs
  return Number.isInteger(v) && v > 0 ? v : 540000
}

/** ctx.jobs 服务懒取（缺失/宿主未装配 → null；调用方走同步钳制降级 + 响亮告警）。 */
export function getJobsService(deps) {
  try { return deps?.ctx?.get?.("jobs") ?? null } catch { return null }
}

/**
 * 派发返回文本（UI-2）：机制前缀 + job 句柄 + 预算 + 接续指令。D-05：jobs.start 返回
 * branded string——直接渲染（非对象无 .id；异常形态回落 "?" 而非崩溃）。
 * D-16（R2 §4.5）：派发时 budgetCapMs ≥ 600000 输出一次不变式提醒（「确认已同步提高平台
 * maxWallMs 且 cap < wall」——插件读不到 maxWallMs〔平台唯一消费者无注入面〕，只能提醒
 * 不可强制；登记表 D-16 标注不可完全强制）。
 * @param {{prefix: string, jobId: string, budgetMs: number, budgetCapMs?: number, detail?: string}} p
 */
export function codexJobsDispatchReply(p) {
  const id = typeof p.jobId === "string" && p.jobId !== "" ? p.jobId : "?"
  let text = p.prefix + " started as background job " + id
    + "（预算 " + Math.round(p.budgetMs / 1000) + "s" + (p.detail ? " · " + p.detail : "") + "）。"
    + JOBS_CONTINUATION_INSTRUCTION
  if (Number.isFinite(p.budgetCapMs) && p.budgetCapMs >= 600000) {
    const reminder = "不变式提醒（D-16）：budgetCapMs=" + p.budgetCapMs
      + " ≥ 600000——确认已同步提高平台 run_code maxWallMs 且 budgetCap < maxWallMs；"
      + "否则 jobs 缺失时的同步降级路径仍会在平台墙钟处被截断"
    text += "\n\n[thincoder-suite] " + reminder + "。"
    console.warn("[thincoder-suite] " + reminder)
  }
  return text
}

// ————————————— R2 §4.3（D-06）：single-flight 在飞表（复合键 sessionId + mechanism） —————————————
// 每机制独立单飞槽位：同会话 advisor 在飞不阻塞 escalate/eng 派发，反之亦然（US-4/N-3 的
// per-session-**per-mechanism** 语义；平台每 owner 10 job 上限不是替代）。命中 → 拒绝并
// 告知在飞 job id 与接续方式；settle 时清除（done 回调成功/失败两分支都清——cancel/abort
// 经平台 cancel 链路同样落 done settle，槽位必然释放）。
const inFlightJobs = new Map() // "sessionId:mechanism" → { jobId, mechanism }

const inFlightKeyOf = (sessionId, mechanism) => String(sessionId ?? "") + ":" + mechanism

/**
 * 派发前检查在飞槽位（advisor/escalate/eng codex 派发路径共用）。
 * @returns {string|null} 命中 → 拒绝文本（含在飞 job id 与接续方式）；未命中 → null
 */
export function checkInFlightJob(sessionId, mechanism) {
  const existing = inFlightJobs.get(inFlightKeyOf(sessionId, mechanism))
  if (!existing) return null
  return "Error: 该会话已有在飞的 " + existing.mechanism + " 后台任务（job " + existing.jobId
    + "）——等待完成通知后再继续（完成通知只含一行指针，全文经 job_output 读取；长任务勿用 "
    + "job_output wait 阻塞等待）。本次请求未派发。"
}

/** jobs.start 成功后登记槽位（与 start 同一同步块——单线程无竞态窗口）。 */
export function setInFlightJob(sessionId, mechanism, jobId) {
  inFlightJobs.set(inFlightKeyOf(sessionId, mechanism), { jobId: String(jobId ?? "?"), mechanism })
}

/** done settle（成功/失败/中止皆算 settle）时清除槽位。 */
export function clearInFlightJob(sessionId, mechanism) {
  inFlightJobs.delete(inFlightKeyOf(sessionId, mechanism))
}

// ————————————— R2 §4.4（D-10）：advisorGeneration 代际检查 —————————————
// sessionState.advisorGeneration（整数，随 F12 视图持久化）。语义转换点 +1：eng 交付重置、
// F11 类型切换、config apply-session 变更；job 派发时捕获代际，finalize 应用前校验——
// 不匹配 → 丢弃状态变更 + 完成通知注明（晚到的完成不得复活已被重置的状态，N-3）。

/** 生效代际（未设/非法 → 0）。 */
export function advisorGenerationOf(state) {
  const v = state?.advisorGeneration
  return Number.isInteger(v) && v >= 0 ? v : 0
}

/** 代际 +1（语义转换点调用）。返回新代际。 */
export function bumpAdvisorGeneration(state) {
  state.advisorGeneration = advisorGenerationOf(state) + 1
  return state.advisorGeneration
}

/**
 * F12 视图 + advisorGeneration：advisorGeneration 不在 viewOfSessionState 七字段视图内——
 * 经本 helper 在调用侧拼入（session-store.normalizeRestored 白名单收口）。**所有**
 * saveSessionState 写点统一经此组装：saveSessionState 是整条目替换写，任一写点漏带
 * generation 即丢代际（D-10 守卫弱化为仅内存态）。
 */
export function sessionStateViewWithGeneration(state) {
  return { ...viewOfSessionState(state), advisorGeneration: advisorGenerationOf(state) }
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
  const sid = agent.session.id
  // R3 §5.4（D-06 同步路径单飞扩展）：single-flight 检查提前到 advisor 机制全部入口——
  // 同会话 advisor 后台 job 在飞期间任何新调用被拒（含 ≤cap 同步调用 / dsh 主路径 /
  // 智能回落轮；拒绝文本含在飞 job id 与接续指引），关闭轮次/prior 双写窗口。派发点的
  // 二次检查保留：入口 → jobs.start 之间的 await 窗口（effort 解析等）内仍可能被他方
  // 派发占位。
  const inFlightAtEntry = checkInFlightJob(sid, "advisor")
  if (inFlightAtEntry) return inFlightAtEntry
  // R3 §5.1（D-07 / D-裁决-3）硬停 held 检查：armed 状态下同会话后续 advisor 调用持续返回
  // 硬停指引而非静默重试（不烧轮次/不跑任何路由——held 判定先于全部状态变更）；advisor
  // 相关配置已变更（路由指纹失配）→ 自动解除恢复常规执行。会话重置经 D-22 清理组
  //（clearCodexFailureCount 已扩展清硬停状态）解除。
  const hsEntry = advisorHardStops.get(sid)
  if (hsEntry) {
    if (advisorRouteFingerprint(config, state.advisorOverride ?? null, agent.options ?? {}) !== hsEntry.fingerprint) {
      advisorHardStops.delete(sid)
      resetRouteFailureState(sid)
      console.warn("[thincoder-suite] advisor 回落硬停解除——advisor 相关配置已变更（路由指纹失配），恢复常规执行")
    } else {
      return fallbackHardStopText(sid, {
        config, override: state.advisorOverride ?? null, agentOpts: agent.options ?? {},
        advisorRound: state.advisorRound,
      })
    }
  }
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
    bumpAdvisorGeneration(state) // R2 §4.4（D-10）：类型切换 = 语义转换点，代际 +1（在飞 advisor 结果按旧类型解析，晚到即弃）
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

  // —— 结果收尾抽为闭包（评审反馈落地）：同步/异步（jobs 后台）路径共用同一 finalize，
  // 保证 completed 判定/轮次推进/prior/design token「恰好一次」且两路语义不漂移。 —————————————
  const finalize = (result) => {
    let final = result
    const completed = !String(result).trimStart().startsWith("Advisor:")
    if (completed) {
      // R3 §5.1（D-07）：任一路由成功 → 双计数器/最近失败码/硬停状态全部清零（正向清零）。
      // 成功清零与轮次推进同点（finalize 恰好一次）——回落轮的 delete 因此天然满足「回落轮
      // 结果产出后才执行」（旧代码在回落执行前 delete 的顺序错误就此消除：回落失败不清零
      // → 下一调用直接再进回落轮，连续 2 次回落失败即硬停）。
      resetRouteFailureState(sid)
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

  // §3.6 maxOutputTokens 运行时读取（effectiveGlobalConfig 已合并 user 层；越界回落缺省+告警）
  const advisorMaxTokens = resolveAdvisorMaxOutputTokens(config)
  // D-02 L1（R1）：codex 行 effort 收口——resolveAdvisorRoute 输出（runner.effort ?? 组 effort）
  // → buildCodexArgs 之前统一走 resolveCodexRowEffort（codex models catalog 校验，最近支持档
  // 回落 / off→不传 / 目录未命中→透传+告警）。codexRunner 在下方 codex 分支解析后生效。
  let codexRunner = route.runner
  let codexEffNote = null
  const runTask = (timeoutMs, signal) => runCodexTask(deps, {
    taskText: "You are performing an independent review. Follow the review protocol below exactly.\n\n"
      + "=== REVIEW PROTOCOL (system instructions) ===\n" + system + "\n\n"
      + "=== REVIEW REQUEST (user message) ===\n" + userText,
    cwd,
    sandbox: "read-only",
    timeoutMs,
    runner: codexRunner,
    config,
    signal,
  })

  let result
  try {
    // —— 智能回落（二期评审反馈）：codex runner 连续 2 次失败 → 本轮自动回落 dsh 路由
    // 一轮（响亮告警非静默；回落成功后计数清零、codex 下轮重试——网络类瞬态故障可自愈）。
    // 预算上限 codexCli.budgetCapMs（默认 540000）须低于 run_code maxWallMs——用户提墙钟
    // 时同步上调（另一会话 40 分钟预算反馈：截断 + 告警比无声被平台墙钟杀死诚实）。
    const failCount = codexFailureCount.get(sid) ?? 0
    const codexWanted = route.runner && route.runner.kind === "codex-cli"
    // 预算上限 codexCli.budgetCapMs（R2 抽共享 resolveCodexBudgetCapMs——escalate/eng 同源）
    const budgetCap = resolveCodexBudgetCapMs(config)

    // —— 智能回落（R3 §5.1 D-07 精确计数器语义）：codex 连续 2 次失败 → 本轮自动回落 dsh
    // 路由（响亮告警非静默）。回落轮失败不清零 codex 计数（旧代码在回落执行前 delete——
    // 顺序修正为「结果产出后、仅成功时」经 finalize completed 分支 resetRouteFailureState）
    // → 下一调用直接再进回落轮；连续 2 次回落失败 → 硬停（双路由诊断，不再交替重试）。
    if (codexWanted && failCount >= CODEX_FAILURE_FALLBACK_THRESHOLD) {
      const fbRoute = resolveAdvisorRoute({ config, override, agentOpts, advisorRound: state.advisorRound, ignoreRunner: true })
      // 评审教训（附录 D.3）：失败/通知文本放后缀——"Advisor:" 必须是失败结果的第一个 token
      if (!fbRoute.ok) {
        // 回落路由不可达 = 回落失败（D-07：任何零进度组合同经「连续 2 次回落失败」硬停终止）
        const fbFails = bumpFallbackFailure(sid, "回落 dsh 路由不可用（组内未配 provider/model、无 legacy、主代理无默认路由）")
        if (fbFails >= FALLBACK_HARD_STOP_THRESHOLD) {
          return armFallbackHardStop(sid, { config, override, agentOpts, advisorRound: state.advisorRound })
        }
        return "Advisor: codex runner 连续 " + failCount + " 次失败，且回落 dsh 路由不可用（组内未配 provider/model、无 legacy、主代理无默认路由）。请修正配置。"
          + "\n[thincoder-suite] 回落失败 " + fbFails + "/" + FALLBACK_HARD_STOP_THRESHOLD
          + "——再失败一次将硬停整个自愈循环（D-07/D-裁决-3）。"
      }
      // 评审反馈：回落模型的 effort 按其实际档位校验/回落（resolveSupportedEffort）
      // D-17：回落轮预算钳制（与 codex 路径对称——超 budgetCap 部分在平台墙钟内跑不完）
      const effRes = await resolveSupportedEffort(deps.llm ?? null, fbRoute.provider, fbRoute.model, fbRoute.effort ?? undefined)
      const fbTimeout = Math.min(fbRoute.timeoutMs, budgetCap)
      const fbCapNote = fbRoute.timeoutMs > budgetCap
        ? "\n\n[thincoder-suite] warning: 回落轮预算 " + fbRoute.timeoutMs + "ms 已按 codexCli.budgetCapMs=" + budgetCap + "ms 截断执行（平台 run_code 墙钟内；镜像 codex 同步路径钳制）"
        : ""
      const fb = await runAdvisorToolLoop(deps, {
        provider: fbRoute.provider, model: fbRoute.model, effort: effRes.effort ?? undefined,
        system, firstUserText: userText, cwd, signal, timeoutMs: fbTimeout,
        sessionId: sid, maxTokens: advisorMaxTokens,
      })
      const fbCompleted = !String(fb).trimStart().startsWith("Advisor:")
      if (!fbCompleted) {
        // 回落轮失败 +1（codex 计数不清零——任一路由成功才清零）：回落轮连败可累积到硬停
        const fbFails = bumpFallbackFailure(sid, String(fb).split("\n")[0].slice(0, 200))
        if (fbFails >= FALLBACK_HARD_STOP_THRESHOLD) {
          // 连续 2 次回落失败 → 硬停：双路由诊断 + 修正指引（armed——后续调用入口 held）
          return armFallbackHardStop(sid, { config, override, agentOpts, advisorRound: state.advisorRound })
        }
      }
      // D-17/D-19 截断告警与机制性后缀在 finalize 之后追加：插件元数据不参与 completed 判定/
      // prior 存储（looksLikeReview 启发式不该被后缀推过 200 字符阈值；prior 只存评审正文）
      return finalize(fb)
        + (effRes.note ? "\n\n[thincoder-suite] " + effRes.note : "")
        + "\n\n[thincoder-suite] warning: codex runner 连续 " + failCount + " 次失败——本轮已自动回落 dsh 路由（"
        + fbRoute.provider + ":" + fbRoute.model + "）；回落成功后计数清零、下一轮重试 codex，回落连续失败 "
        + FALLBACK_HARD_STOP_THRESHOLD + " 次将硬停（D-07）。"
        + fbCapNote
    }

    if (codexWanted) {
      // D-02 L1：codex 行 effort 解析（resolveAdvisorRoute 输出 → buildCodexArgs 之前）。
      // route.effort = runner.effort ?? 组环 effort——解析结果写回传给 runCodexTask 的 runner
      //（组 effort 因此对 codex 行真正生效，消灭「组 effort 被 runner 静默丢弃」的旧漂移）；
      // off → null（不传）；note 尾部并入结果（附录 D.3 规则）。
      if (route.effort !== null && route.effort !== undefined) {
        const effRes = await resolveCodexRowEffort(
          deps,
          { ...route.runner, model: route.model },
          route.effort,
          resolveCodexCliGlobals(config).globals,
        )
        codexRunner = { ...route.runner, effort: effRes.effort ?? undefined }
        codexEffNote = effRes.note
      }
      // 预算 > budgetCap：同步跑会被平台 run_code 墙钟（默认 600s）砍掉 → 派后台 job
      //（ctx.jobs 已装配时零成本；finalize 在 done settle 前执行——轮次推进/prior/token
      // 恰好一次；完成通知由平台唤醒主代理，无需轮询）。jobs 缺失 → 同步降级（预算截为
      // budgetCap 并响亮告警，绝不无声）。
      if (route.timeoutMs > budgetCap) {
        // D-06（§4.3）：single-flight 派发前检查（复合键 sessionId+mechanism——advisor 槽位）
        const inFlight = checkInFlightJob(sid, "advisor")
        if (inFlight) return inFlight
        const jobs = getJobsService(deps)
        if (jobs && typeof jobs.start === "function") {
          // D-10（§4.4）：派发时捕获代际——finalize 应用前校验（不匹配 → 丢弃状态变更 + 注明）
          const genAtDispatch = advisorGenerationOf(state)
          const ctrl = new AbortController()
          try {
            const started = jobs.start({
              kind: "advisor-codex",
              label: "codex review (" + (route.model ?? "default") + ", " + Math.round(route.timeoutMs / 1000) + "s)",
              outputLimitBytes: 131072,
              owner: agent,
              run: () => {
                const done = runTask(route.timeoutMs, ctrl.signal).then((env) => {
                  clearInFlightJob(sid, "advisor")
                  // D-19（R3 §5.3）：机制性后缀（effort note）在 finalize 之后追加——
                  // lastAdvisorOutput 只存评审正文（prior 纯净化）；返回文本照常带后缀。
                  const effNote = codexEffNote ? "\n\n[thincoder-suite] " + codexEffNote : ""
                  let result
                  if (env.ok && env.text) {
                    // R3 §5.1（D-07）：任一路由成功清零（含回落计数/硬停——语义：运行确实发生）
                    resetRouteFailureState(sid)
                    result = env.text // 纯正文（机制后缀在 finalize 后追加——D-19）
                  } else {
                    const newCount = Math.min((codexFailureCount.get(sid) ?? 0) + 1, 99)
                    codexFailureCount.set(sid, newCount)
                    codexLastFailure.set(sid, env.code) // D-07：最近失败码（硬停诊断用）
                    const fallbackNote = newCount >= CODEX_FAILURE_FALLBACK_THRESHOLD
                      ? "\n[thincoder-suite] codex runner 已连续 " + newCount + " 次失败——下一轮 advisor start 将自动回落 dsh 路由一轮"
                      : ""
                    const partial = env.text ? "\n--- partial output (not counted as a review) ---\n" + env.text.slice(0, 2000) : ""
                    // 失败结果 "Advisor:" 开头（附录 D.3 规则）
                    result = "Advisor: review failed (codex-cli " + env.code + ") — " + (env.userMessage || env.diagnostics || "unknown error") + partial + fallbackNote
                  }
                  // D-10（§4.4）：finalize 应用前代际校验——不匹配 → 丢弃状态变更（轮次推进/
                  // prior/token 一律不并入），评审原文仍可读 + 完成通知注明
                  if (advisorGenerationOf(state) !== genAtDispatch) {
                    return {
                      status: env.ok ? "completed" : "failed",
                      detail: env.ok ? "review delivered (stale generation)" : ("codex-cli " + env.code),
                      output: result + effNote + "\n\n[thincoder-suite] 状态代际已变更（dispatch 时 " + genAtDispatch
                        + " → 当前 " + advisorGenerationOf(state) + "），本轮结果不并入会话状态（原文可读）。",
                    }
                  }
                  // finalize 在 done settle 前执行：轮次推进/prior/token 恰好一次
                  return { status: env.ok ? "completed" : "failed", detail: env.ok ? "review delivered" : ("codex-cli " + env.code), output: finalize(result) + effNote }
                }, (e) => {
                  clearInFlightJob(sid, "advisor")
                  return { status: "failed", detail: String(e && e.message ? e.message : e), output: "Advisor: review failed — " + String(e && e.message ? e.message : e) }
                })
                done.catch(() => { /* 观察者兜底：reject 已转为 outcome */ })
                return { cancel: (reason) => { try { ctrl.abort(reason) } catch { /* noop */ } }, done }
              },
            })
            setInFlightJob(sid, "advisor", started)
            // D-05：jobs.start 返回 branded string——直接渲染（旧代码取 .id 落空恒显 "?"）。
            // D-09（UI-2）：句柄 + 接续指令——完成通知只含一行指针，全文经 job_output 读取
            //（保尾），不承诺「通知含评审全文」。D-16：budgetCapMs ≥ 600000 时附不变式提醒。
            return codexJobsDispatchReply({
              prefix: "Advisor: codex review",
              jobId: started,
              budgetMs: route.timeoutMs,
              budgetCapMs: budgetCap,
              detail: "模型 " + (route.model ?? "codex 默认"),
            })
          } catch (e) {
            console.warn("[thincoder-suite] ctx.jobs 派发失败（" + (e && e.message ? e.message : String(e)) + "）——回落同步执行（预算按 budgetCap 截断）")
          }
        }
        // jobs 设施缺失 → 同步降级（预算截为 budgetCap，响亮告警——绝不无声延长）
        console.warn("[thincoder-suite] ctx.jobs 不可用——codex 评审预算 " + route.timeoutMs + "ms 截为 " + budgetCap + "ms 同步执行（建议装配 dsh-jobs-local + dsh-tool-jobs）")
        const env = await runTask(Math.min(route.timeoutMs, budgetCap), signal)
        const effNote = codexEffNote ? "\n\n[thincoder-suite] " + codexEffNote : ""
        let result
        if (env.ok && env.text) {
          // R3 §5.1（D-07）：任一路由成功清零
          resetRouteFailureState(sid)
          result = env.text // 纯正文（机制后缀在 finalize 后追加——D-19）
        } else {
          const newCount = Math.min((codexFailureCount.get(sid) ?? 0) + 1, 99)
          codexFailureCount.set(sid, newCount)
          codexLastFailure.set(sid, env.code) // D-07：最近失败码（硬停诊断用）
          const fallbackNote = newCount >= CODEX_FAILURE_FALLBACK_THRESHOLD
            ? "\n[thincoder-suite] codex runner 已连续 " + newCount + " 次失败——下一轮 advisor start 将自动回落 dsh 路由一轮"
            : ""
          const partial = env.text ? "\n--- partial output (not counted as a review) ---\n" + env.text.slice(0, 2000) : ""
          // 失败结果必须以 "Advisor:" 开头（不烧轮次、不存 prior；附录 D.3 规则）
          result = "Advisor: review failed (codex-cli " + env.code + ") — " + (env.userMessage || env.diagnostics || "unknown error") + partial + fallbackNote
        }
        // D-19（R3 §5.3）：机制性后缀（截断告警 / effort note）在 finalize 之后追加——
        // lastAdvisorOutput 只存评审正文（prior 纯净化）；返回文本照常带后缀（可见性不变）。
        return finalize(result)
          + (env.ok ? "\n\n[thincoder-suite] warning: 预算已按 codexCli.budgetCapMs=" + budgetCap + "ms 截断执行（平台墙钟内）" : "")
          + effNote
      }
      // 预算 ≤ budgetCap → 同步执行（现行为）
      const env = await runTask(route.timeoutMs, signal)
      const effNote = codexEffNote ? "\n\n[thincoder-suite] " + codexEffNote : ""
      let result
      if (env.ok && env.text) {
        // R3 §5.1（D-07）：任一路由成功清零
        resetRouteFailureState(sid)
        result = env.text // 纯正文（机制后缀在 finalize 后追加——D-19）
      } else {
        const newCount = Math.min((codexFailureCount.get(sid) ?? 0) + 1, 99)
        codexFailureCount.set(sid, newCount)
        codexLastFailure.set(sid, env.code) // D-07：最近失败码（硬停诊断用）
        const fallbackNote = newCount >= CODEX_FAILURE_FALLBACK_THRESHOLD
          ? "\n[thincoder-suite] codex runner 已连续 " + newCount + " 次失败——下一轮 advisor start 将自动回落 dsh 路由一轮"
          : ""
        const partial = env.text ? "\n--- partial output (not counted as a review) ---\n" + env.text.slice(0, 2000) : ""
        result = "Advisor: review failed (codex-cli " + env.code + ") — " + (env.userMessage || env.diagnostics || "unknown error") + partial + fallbackNote
      }
      // D-19（R3 §5.3）：机制性后缀（effort note）在 finalize 之后追加——prior 只存评审正文
      return finalize(result) + effNote
    }

    // dsh 同步路径
    // 评审反馈：dsh 主路径的 effort 同样按模型实际档位校验/回落
    // D-17：dsh 主路径预算钳制（与 codex 路径对称——超 budgetCap 部分在平台墙钟内跑不完）
    const effRes = await resolveSupportedEffort(deps.llm ?? null, route.provider, route.model, route.effort ?? undefined)
    const dshTimeout = Math.min(route.timeoutMs, budgetCap)
    const dshCapNote = route.timeoutMs > budgetCap
      ? "\n\n[thincoder-suite] warning: 评审预算 " + route.timeoutMs + "ms 已按 codexCli.budgetCapMs=" + budgetCap + "ms 截断执行（平台 run_code 墙钟内；镜像 codex 同步路径钳制）"
      : ""
    const loop = await runAdvisorToolLoop(deps, {
      provider: route.provider, model: route.model, effort: effRes.effort ?? undefined,
      system, firstUserText: userText, cwd, signal, timeoutMs: dshTimeout,
      sessionId: sid, maxTokens: advisorMaxTokens,
    })
    // D-17 截断告警在 finalize 之后追加：插件元数据不参与 completed 判定/prior 存储。
    // D-19（R3 §5.3）：effort note 同为机制性后缀——一并移到 finalize 之后（prior 只存
    // 评审正文；looksLikeReview 启发式不再被后缀推过 200 字符阈值——设计 §5.3 收口）。
    return finalize(loop)
      + (effRes.note ? "\n\n[thincoder-suite] " + effRes.note : "")
      + dshCapNote
  } catch (e) {
    if (e?.name === "AbortError" || signal?.aborted) return warnPrefix + "Advisor: interrupted."
    return warnPrefix + "Advisor: review failed — " + (e?.message ?? String(e))
  }
}

