// index.mjs — 插件入口：工具注册 + 提示词 section + 写门禁 + 会话清理。
// 零 bare import 工程决策（纯 JS 直发）：
// 当插件经 junction 安装时，Node 会把它 realpath 化，从安装目录向上解析不到
// @deepseek-ai/dsh-tools / schemastery / cordis（实测 ERR_MODULE_NOT_FOUND）；
// dsh-task-status 证明 cordis 插件契约（name/inject/apply）无需 import cordis。
// 因此：工具手工构造 ToolDefinition 形状（JSON Schema parameters + output 契约），
// 配置经 apply(ctx, config) 尽力解析（预设 group config / patch entry config 均可传入）。
import { sessionState, dropSession, dropAllSessions, engEffective, restoreSessionState } from "./state.mjs"
import {
  runAdvisorReview, runAdvisorConfigTool,
  resolveAdvisorRoute, resolveIncludeProjectGuide,
  isValidEffort, isValidTimeoutMs, isModelField, isValidEngCoderMaxTokens,
  isValidAdvisorMaxOutputTokens,
  isValidAdvisorContextTokens,
  ADVISOR_MAX_OUTPUT_TOKENS_MIN, ADVISOR_MAX_OUTPUT_TOKENS_MAX,
  ADVISOR_CONTEXT_TOKENS_MIN, ADVISOR_CONTEXT_TOKENS_MAX,
  EFFORT_LEVELS, ADVISOR_TIMEOUT_MIN_MS, ADVISOR_TIMEOUT_MAX_MS,
  advisorGenerationOf, bumpAdvisorGeneration, sessionStateViewWithGeneration,
  clearCodexFailureCount,
  // 批 4（§5.6 工具层预检）：两入口同判定——工具层给快速指引，核心层做直调防线。
  DESIGN_STRIKE_LIMIT, designDocKey, designStrikes, settlementGuardText,
  clearDesignSettlementStrikes,
  // 批 6b（守卫 E）：预闸的槽位只读访问器（扫全表找武装中的 design 冻结窗口）
  designFreezeSet,
} from "./advisor.mjs"
import {
  startConsultSession, stopConsultSession, cleanupConsultSessions,
  consultDigestionGate, consultLedgerOrphans,
} from "./consult.mjs"
import { runEscalate } from "./escalate.mjs"
import { engineeringToggle, makeWriteGate, makeDocFreezeGate, runEngCoder, attachEngineeringSection } from "./eng.mjs"
import { loadSessionState, saveSessionState, removeSessionState } from "./session-store.mjs"
// 批 7（D-P9/J11）：声明键的前置校验复用**同一个单一权威**（标尺必须是文档）
import { isDocPath } from "./path-kind.mjs"
import {
  loadUserConfig, saveUserConfig, clearUserConfig, mergeGlobalConfig,
  effectiveGlobalConfig,
  DSHS_BACKGROUND_TIMEOUT_MIN_MS, DSHS_BACKGROUND_TIMEOUT_MAX_MS,
  isValidDshBackgroundTimeoutMs,
  CONSULT_TIMEOUT_MIN_MS, CONSULT_TIMEOUT_MAX_MS, isValidConsultTimeoutMs,
  ENG_TOKEN_TTL_MIN_MS, ENG_TOKEN_TTL_MAX_MS, isValidEngTokenTtlMs,
} from "./config-store.mjs"
import { DISCIPLINE, MAIN_EXTRA } from "./prompts.mjs"
import { validateRunnerValue, normalizeRunnerValue, resolveCodexCliGlobals, discoverCodexModels, sweepStaleCodexTempDirs } from "./codex-adapter.mjs"
import { clearCodexThread } from "./escalate.mjs"

/** Cordis 插件名。 */
export const name = "thincoder-suite"

/** 所需服务。webServer 用于设置页 config API（二期 §3.2）；宿主 base 实证可用
 *  （super-injector/client-modules 同款 inject）；缺失时注册路径容错跳过（U8）。 */
export const inject = ["tools", "llm", "subagents", "systemPrompt", "webServer"]

// ————————————— 工具构造 helper（零依赖形状） —————————————

function textTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      schema: { type: "string", description: "Tool output text" },
      render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
    },
    async execute(args, exec) {
      return def.execute(args, exec)
    },
  }
}

const strArr = (description) => ({ type: "array", items: { type: "string" }, description })

/** cwdHint 求值（F12 persistSession 写盘用——与 registerConfigApi opts.cwdHint 同语义，评审 #10）。 */
const cwdHintOf = (ctx) => {
  try { return ctx.get?.("agent")?.session?.header?.cwd ?? process.cwd() } catch { return process.cwd() }
}

// ————————————— 设置页 config API（二期，docs/2026-09-02-settings-ui-design.md §3.1/§3.2） —————————————
// 纯逻辑（校验/apply-session/reset-session/路由摘要）导出为无 ctx 依赖函数——U3/U7/U8 单元测试
// 直接 stub deps 调用；webServer 前缀路由（registerConfigApi/makeApiHandler）在其上薄封装。
// host 校验 helper 全部复用 advisor.mjs 的导出（评审 #5：不重写校验逻辑）。

export const CONFIG_API_PREFIX = "/thincoder-suite/api"

const GROUP_KEYS = ["round1", "convergence"]
const errEffort = (p) => p + ".effort must be one of " + EFFORT_LEVELS.join("|")
const errTimeout = (p) => p + ".timeoutMs must be a number in " + ADVISOR_TIMEOUT_MIN_MS + ".." + ADVISOR_TIMEOUT_MAX_MS
const errProvider = (p) => p + ".provider is required and must be a non-empty string"
const errModel = (p) => p + ".model is required and must be a non-empty string"

/**
 * 校验一个 advisor 组对象（round1/convergence）里「出现的每个字段」；provider/model 不强制成对
 * ——解析链语义允许部分组（缺失 model 的组整对下探，见一期 §3.2，T20），「必填」由表单保证。
 * @param {string} prefix 错误消息前缀，如 "advisor.round1"
 * @param {unknown} group
 * @param {string[]|undefined} knownProviders — undefined = 注册表不可查（跳过存在性）
 * @returns {string[]} errors
 */
export function validateAdvisorGroup(prefix, group, knownProviders) {
  const errors = []
  if (group === undefined || group === null) return errors
  if (typeof group !== "object" || Array.isArray(group)) {
    errors.push(prefix + " must be an object")
    return errors
  }
  const unknown = Object.keys(group).filter((k) => !["provider", "model", "effort", "timeoutMs", "runner"].includes(k))
  for (const k of unknown) errors.push(prefix + "." + k + " is not a supported advisor field")
  if (group.runner !== undefined && group.runner !== null) {
    errors.push(...validateRunnerValue(prefix + ".runner", group.runner))
  }
  if (group.provider !== undefined && group.provider !== null) {
    if (!isModelField(group.provider)) errors.push(errProvider(prefix))
    else if (Array.isArray(knownProviders) && !knownProviders.includes(group.provider)) {
      errors.push(prefix + ".provider " + JSON.stringify(group.provider)
        + " is not in the configured provider registry (llm-pi-ai.providers)")
    }
  }
  if (group.model !== undefined && group.model !== null && !isModelField(group.model)) {
    errors.push(errModel(prefix))
  }
  if (group.effort !== undefined && group.effort !== null && !isValidEffort(group.effort)) {
    errors.push(errEffort(prefix))
  }
  if (group.timeoutMs !== undefined && group.timeoutMs !== null && !isValidTimeoutMs(group.timeoutMs)) {
    errors.push(errTimeout(prefix))
  }
  return errors
}

/** consultModels 行的合法键（provider/model 必填；effort 可选枚举）。 */
function validateConsultModels(list, knownProviders) {
  const errors = []
  if (!Array.isArray(list)) {
    errors.push("consultModels must be an array of { provider, model, effort? }")
    return errors
  }
  if (list.length > 5) {
    errors.push("consultModels supports at most 5 models (got " + list.length + ")")
    return errors
  }
  list.forEach((row, i) => {
    const p = "consultModels[" + i + "]"
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errors.push(p + " must be an object with provider/model")
      return
    }
    const unknown = Object.keys(row).filter((k) => !["provider", "model", "effort", "runner"].includes(k))
    for (const k of unknown) errors.push(p + "." + k + " is not a supported consult-model field")
    errors.push(...validateRunnerValue(p + ".runner", row.runner))
    // codex-cli 行（runner.kind=codex-cli）免 provider/model —— model 透传给 codex，不经 llm-pi-ai 注册表
    const nr = row.runner !== undefined && row.runner !== null ? normalizeRunnerValue(row.runner) : null
    const isCodex = !!(nr && nr.ok && nr.runner.kind === "codex-cli")
    if (!isCodex) {
      if (!isModelField(row.provider)) errors.push(p + ".provider is required and must be a non-empty string")
      else if (Array.isArray(knownProviders) && !knownProviders.includes(row.provider)) {
        errors.push(p + ".provider " + JSON.stringify(row.provider)
          + " is not in the configured provider registry (llm-pi-ai.providers)")
      }
      if (!isModelField(row.model)) errors.push(p + ".model is required and must be a non-empty string")
    }
    if (row.effort !== undefined && row.effort !== null && !isValidEffort(row.effort)) {
      errors.push(p + ".effort must be one of " + EFFORT_LEVELS.join("|"))
    }
  })
  return errors
}

/**
 * 校验 PUT /config 的完整 user 层配置（U3 错误路径；校验 helper 与一期解析链同源，N4）。
 * @param {unknown} userConfig body { config } 的 config
 * @param {string[]|undefined} knownProviders — llm-pi-ai providers 键清单；undefined = 注册表
 *   不可查（ctx.settings 不可用/无该命名空间）→ 跳过存在性校验并附 notes 提示（评审 #8）
 * @returns {{ok: boolean, errors: string[], notes: string[], sanitized?: object}}
 */
export function validateGlobalUserConfig(userConfig, knownProviders) {
  const errors = []
  const notes = []
  const topAllowed = ["advisor", "consultModels", "engCoderMaxTokens", "engCoderEffort", "codexCli", "dshBackgroundTimeoutMs", "consultTimeoutMs", "engTokenTtlMs"]
  if (!userConfig || typeof userConfig !== "object" || Array.isArray(userConfig)) {
    errors.push("config must be an object")
    return { ok: false, errors, notes }
  }
  if (knownProviders === undefined) {
    notes.push("provider registry unavailable (ctx.settings llm-pi-ai not readable) — provider existence not verified")
  }
  // 批 10（D-31 / 决策 D10-9）：未知顶层键**由 `notes` 改入 `errors`**——消息镜像**嵌套分支的
  // 既有形态**（`advisor.nope is not supported (expected …)`，:196）。此前走 notes ⇒ `ok` 仍为
  // true ⇒ PUT 返回 **200「已保存」**而 `sanitized` 不含该键 ⇒ 整体替换写盘 ⇒ **静默清空整个
  // user 层配置**（数据丢失）。改入 errors 后 `ok:false` ⇒ :682 的 `if (!v.ok) return 400`
  // **在写盘之前**拦下 ⇒ 该数据丢失路径灭绝（不引入新严格性：嵌套未知键今天就是报错）。
  // ★ 整体替换语义**未动**（D10-12）：「删除键靠在新全量中缺席表达」不受影响。
  const unknownTop = Object.keys(userConfig).filter((k) => !topAllowed.includes(k))
  for (const k of unknownTop) {
    errors.push(JSON.stringify(k) + " is not a supported top-level field (user-layer whitelist: "
      + topAllowed.join("|") + ")")
  }
  const sanitized = {}
  if (userConfig.advisor !== undefined && userConfig.advisor !== null) {
    const adv = userConfig.advisor
    if (typeof adv !== "object" || Array.isArray(adv)) {
      errors.push("advisor must be an object")
    } else {
      const advUnknown = Object.keys(adv).filter((k) => ![...GROUP_KEYS, "includeProjectGuide", "maxOutputTokens", "contextTokens", "standardsDoc", "documentMapDoc", "criteriaDoc"].includes(k))
      for (const k of advUnknown) errors.push("advisor." + k + " is not supported (expected " + GROUP_KEYS.join("|") + "|includeProjectGuide|maxOutputTokens|contextTokens|standardsDoc|documentMapDoc|criteriaDoc)")
      const advOut = {}
      for (const gk of GROUP_KEYS) {
        if (adv[gk] === undefined || adv[gk] === null) continue
        errors.push(...validateAdvisorGroup("advisor." + gk, adv[gk], knownProviders))
        const g = sanitizeGroup(adv[gk])
        if (g && Object.keys(g).length > 0) advOut[gk] = g
        // 成对不完整是合法配置（解析链整对下探语义，一期 §3.2）——附提示而非报错
        if (!isModelField(adv[gk]?.provider) || !isModelField(adv[gk]?.model)) {
          notes.push("advisor." + gk + " has no complete provider/model pair — its model route falls back down the resolution chain")
        }
      }
      if (adv.includeProjectGuide !== undefined && adv.includeProjectGuide !== null) {
        if (typeof adv.includeProjectGuide !== "boolean") {
          errors.push("advisor.includeProjectGuide must be a boolean")
        } else {
          advOut.includeProjectGuide = adv.includeProjectGuide
        }
      }
      // R1 §3.6（D-01 热修正式化）：PUT 白名单面——advisor.maxOutputTokens 数值区间校验
      if (adv.maxOutputTokens !== undefined && adv.maxOutputTokens !== null) {
        if (isValidAdvisorMaxOutputTokens(adv.maxOutputTokens)) {
          advOut.maxOutputTokens = adv.maxOutputTokens
        } else {
          errors.push("advisor.maxOutputTokens must be an integer in "
            + ADVISOR_MAX_OUTPUT_TOKENS_MIN + ".." + ADVISOR_MAX_OUTPUT_TOKENS_MAX)
        }
      }
      // 批 5（FR-CB5）：PUT 白名单面——advisor.contextTokens（语义 = 模型窗口，**不是**判死线；
      // 与 maxOutputTokens 同款区间校验，校验函数 = lib/advisor.mjs 单一事实源）
      if (adv.contextTokens !== undefined && adv.contextTokens !== null) {
        if (isValidAdvisorContextTokens(adv.contextTokens)) {
          advOut.contextTokens = adv.contextTokens
        } else {
          errors.push("advisor.contextTokens must be an integer in "
            + ADVISOR_CONTEXT_TOKENS_MIN + ".." + ADVISOR_CONTEXT_TOKENS_MAX)
        }
      }
      // 批 7（D-P4/J11）· 批 13（R-6）：PUT 白名单面——三个「项目文档」声明键
      // （advisor.standardsDoc / advisor.documentMapDoc / advisor.criteriaDoc）。
      // 语义 = **该项目把哪份文档交给评审当判据用**（项目属性，global-only）——三类各管一面，
      // 故**不得**并键：standardsDoc = 工程标准文档（两面都注入，且是**独立追加段**）·
      // documentMapDoc = 文档地图（仅 design round 1）· criteriaDoc = **code 评审的判据正文**
      // （替换 `## Review Criteria` 段的**内容**，仅 code round 1 消费）。
      // 路径必须**是文档**：判据复用**同一个单一权威** isDocPath（与写门禁同尺，J11）；这里是
      // **类型校验**不是可读性校验（存在吗）——可读性在注入时判（PUT 层没有会话 cwd，
      // 无法可靠解析相对路径）。
      // ★撤销语义：`""` / `null` ⇒ **删除该 user 层键**并返回成功（**不是** 400）——「已声明」
      // 必须能回到「未声明」（后者是**正常状态**；没有回头路是设计缺陷，AC-P12c/锚 B11）。
      // ★标签**逐键**（D13-17 ②）：下面的 `label` 进类型错误消息的「path to the …」括号 ⇒
      // 复用别键的标签会把新键**叫错名字**（第三个键不是标准文档）。
      for (const [key, label] of [["standardsDoc", "project standards document"], ["documentMapDoc", "document map"], ["criteriaDoc", "review criteria document"]]) {
        const v = adv[key]
        if (v === undefined || v === null || v === "") continue // 撤销声明：不写进 advOut ⇒ 整档落盘即删键
        if (typeof v !== "string") {
          errors.push("advisor." + key + " must be a string (path to the " + label + ", relative to the session cwd)")
          continue
        }
        if (!isDocPath(v)) {
          errors.push("advisor." + key + " must point to a DOCUMENT file — '" + v + "' is not a document path (J11: the declared path is checked with the same single-authority predicate as the write gate)")
          continue
        }
        advOut[key] = v
      }
      if (Object.keys(advOut).length > 0) sanitized.advisor = advOut
    }
  }
  if (userConfig.consultModels !== undefined && userConfig.consultModels !== null) {
    errors.push(...validateConsultModels(userConfig.consultModels, knownProviders))
    if (Array.isArray(userConfig.consultModels)) {
      sanitized.consultModels = userConfig.consultModels.map(sanitizeConsultRow)
        .filter((r) => r !== null)
    }
  }
  if (userConfig.engCoderMaxTokens !== undefined && userConfig.engCoderMaxTokens !== null) {
    if (!isValidEngCoderMaxTokens(userConfig.engCoderMaxTokens)) {
      errors.push("engCoderMaxTokens must be a positive integer")
    } else {
      sanitized.engCoderMaxTokens = userConfig.engCoderMaxTokens
    }
  }
  if (userConfig.engCoderEffort !== undefined && userConfig.engCoderEffort !== null) {
    if (!isValidEffort(userConfig.engCoderEffort)) {
      errors.push("engCoderEffort must be one of " + EFFORT_LEVELS.join("|"))
    } else {
      sanitized.engCoderEffort = userConfig.engCoderEffort
    }
  }
  // codexCli 全局节（一期 codex-runner，§5.2）：字段白名单 + 类型/枚举/范围校验（B10/B12）
  if (userConfig.codexCli !== undefined && userConfig.codexCli !== null) {
    const cc = userConfig.codexCli
    if (typeof cc !== "object" || Array.isArray(cc)) {
      errors.push("codexCli must be an object")
    } else {
      const ccFields = ["executable", "proxyMode", "proxyUrl", "agentsMdPolicy", "model", "defaultTimeoutMs", "idleTimeoutMs", "engCoderRunner", "budgetCapMs", "maxConcurrent"]
      const ccUnknown = Object.keys(cc).filter((k) => !ccFields.includes(k))
      for (const k of ccUnknown) errors.push("codexCli." + k + " is not a supported field")
      const ccOut = {}
      if (cc.executable !== undefined && cc.executable !== null) {
        if (isModelField(cc.executable)) ccOut.executable = cc.executable
        else errors.push("codexCli.executable must be a non-empty string")
      }
      if (cc.proxyMode !== undefined && cc.proxyMode !== null) {
        if (["inherit", "none", "url"].includes(cc.proxyMode)) ccOut.proxyMode = cc.proxyMode
        else errors.push("codexCli.proxyMode must be inherit|none|url")
      }
      if (cc.proxyUrl !== undefined && cc.proxyUrl !== null) {
        if (typeof cc.proxyUrl === "string" && (cc.proxyUrl.indexOf("http://") === 0 || cc.proxyUrl.indexOf("https://") === 0)) ccOut.proxyUrl = cc.proxyUrl
        else errors.push("codexCli.proxyUrl must be an http(s) URL")
      }
      if (cc.agentsMdPolicy !== undefined && cc.agentsMdPolicy !== null) {
        if (["respect", "disable", "clean-cwd"].includes(cc.agentsMdPolicy)) ccOut.agentsMdPolicy = cc.agentsMdPolicy
        else errors.push("codexCli.agentsMdPolicy must be respect|disable|clean-cwd")
      }
      if (cc.model !== undefined && cc.model !== null) {
        if (isModelField(cc.model)) ccOut.model = cc.model
        else errors.push("codexCli.model must be a non-empty string")
      }
      if (cc.defaultTimeoutMs !== undefined && cc.defaultTimeoutMs !== null) {
        if (Number.isInteger(cc.defaultTimeoutMs) && cc.defaultTimeoutMs >= 30000 && cc.defaultTimeoutMs <= 3600000) ccOut.defaultTimeoutMs = cc.defaultTimeoutMs
        else errors.push("codexCli.defaultTimeoutMs must be an integer in 30000..3600000")
      }
      if (cc.idleTimeoutMs !== undefined && cc.idleTimeoutMs !== null) {
        if (Number.isInteger(cc.idleTimeoutMs) && cc.idleTimeoutMs >= 15000 && cc.idleTimeoutMs <= 3600000) ccOut.idleTimeoutMs = cc.idleTimeoutMs
        else errors.push("codexCli.idleTimeoutMs must be an integer in 15000..3600000")
      }
      if (cc.engCoderRunner !== undefined && cc.engCoderRunner !== null) {
        if (["dsh", "codex-cli"].includes(cc.engCoderRunner)) ccOut.engCoderRunner = cc.engCoderRunner
        else errors.push("codexCli.engCoderRunner must be dsh|codex-cli")
      }
      if (cc.budgetCapMs !== undefined && cc.budgetCapMs !== null) {
        if (Number.isInteger(cc.budgetCapMs) && cc.budgetCapMs >= 60000 && cc.budgetCapMs <= 3600000) ccOut.budgetCapMs = cc.budgetCapMs
        else errors.push("codexCli.budgetCapMs must be an integer in 60000..3600000")
      }
      // R2 §4.5（D-14，DP-3 默认 8）：全局 codex 并发上限（PUT 面——与 merge/运行时三面同步）
      if (cc.maxConcurrent !== undefined && cc.maxConcurrent !== null) {
        if (Number.isInteger(cc.maxConcurrent) && cc.maxConcurrent >= 1 && cc.maxConcurrent <= 64) ccOut.maxConcurrent = cc.maxConcurrent
        else errors.push("codexCli.maxConcurrent must be an integer in 1..64")
      }
      if (Object.keys(ccOut).length > 0) sanitized.codexCli = ccOut
    }
  }
  // R5 §7.2（D-27，D-01 热修正式化同款三面收口）：PUT 白名单面——顶层全局
  // dshBackgroundTimeoutMs 数值区间校验（后台 dsh 任务挂死兜底截止；merge 白名单在
  // config-store.mjs、运行时回落告警在 resolveDshBackgroundTimeoutMs——单一事实源）
  if (userConfig.dshBackgroundTimeoutMs !== undefined && userConfig.dshBackgroundTimeoutMs !== null) {
    if (isValidDshBackgroundTimeoutMs(userConfig.dshBackgroundTimeoutMs)) {
      sanitized.dshBackgroundTimeoutMs = userConfig.dshBackgroundTimeoutMs
    } else {
      errors.push("dshBackgroundTimeoutMs must be an integer in "
        + DSHS_BACKGROUND_TIMEOUT_MIN_MS + ".." + DSHS_BACKGROUND_TIMEOUT_MAX_MS)
    }
  }
  // D-29：顶层全局 consultTimeoutMs / engTokenTtlMs 区间校验（会诊看门狗 / design token
  // 有效期——两键此前只在 entry base 可改，设置页改不动；本批并入白名单三面同步）
  if (userConfig.consultTimeoutMs !== undefined && userConfig.consultTimeoutMs !== null) {
    if (isValidConsultTimeoutMs(userConfig.consultTimeoutMs)) {
      sanitized.consultTimeoutMs = userConfig.consultTimeoutMs
    } else {
      errors.push("consultTimeoutMs must be an integer in "
        + CONSULT_TIMEOUT_MIN_MS + ".." + CONSULT_TIMEOUT_MAX_MS)
    }
  }
  if (userConfig.engTokenTtlMs !== undefined && userConfig.engTokenTtlMs !== null) {
    if (isValidEngTokenTtlMs(userConfig.engTokenTtlMs)) {
      sanitized.engTokenTtlMs = userConfig.engTokenTtlMs
    } else {
      errors.push("engTokenTtlMs must be an integer in "
        + ENG_TOKEN_TTL_MIN_MS + ".." + ENG_TOKEN_TTL_MAX_MS)
    }
  }
  return { ok: errors.length === 0, errors, notes, sanitized }
}

/** 组对象净化：只留合法非空字段（白名单字段级）。 */
function sanitizeGroup(group) {
  if (!group || typeof group !== "object" || Array.isArray(group)) return null
  const out = {}
  if (isModelField(group.provider)) out.provider = group.provider
  if (isModelField(group.model)) out.model = group.model
  if (isValidEffort(group.effort)) out.effort = group.effort
  if (isValidTimeoutMs(group.timeoutMs)) out.timeoutMs = group.timeoutMs
  // 一期 codex-runner：仅 codex-cli 形态需要持久化（dsh = 缺省，存了也是噪音）
  if (group.runner !== undefined && group.runner !== null) {
    const nr = normalizeRunnerValue(group.runner)
    if (nr.ok && nr.runner.kind === "codex-cli") out.runner = nr.runner
  }
  return out
}

/** consultModels 行净化：provider/model 必填（codex-cli 行免），effort 可选枚举。 */
function sanitizeConsultRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null
  const nr = row.runner !== undefined && row.runner !== null ? normalizeRunnerValue(row.runner) : null
  if (nr && nr.ok && nr.runner.kind === "codex-cli") {
    const out = { runner: nr.runner }
    if (isValidEffort(row.effort)) out.effort = row.effort
    return out
  }
  if (!isModelField(row.provider) || !isModelField(row.model)) return null
  const out = { provider: row.provider, model: row.model }
  if (isValidEffort(row.effort)) out.effort = row.effort
  if (row.runner !== undefined && row.runner !== null) {
    const r2 = normalizeRunnerValue(row.runner)
    if (r2.ok && r2.runner.kind === "codex-cli") out.runner = r2.runner
  }
  return out
}

/**
 * 会话级 advisor 覆盖净化为 advisorOverride 形状（round1/convergence 部分组 +
 * includeProjectGuide；字段级白名单同 sessionState/advisor_config，§3.6 一期）。
 * @param {unknown} advisorPayload — apply-session body.advisor
 * @returns {{ok: boolean, errors: string[], advisor?: object|null}}
 */
export function sanitizeSessionAdvisor(advisorPayload) {
  const errors = []
  const advisor = {}
  if (advisorPayload === undefined || advisorPayload === null) return { ok: true, errors, advisor: null }
  if (typeof advisorPayload !== "object" || Array.isArray(advisorPayload)) {
    errors.push("advisor must be an object with round1/convergence/includeProjectGuide")
    return { ok: false, errors }
  }
  const allowed = [...GROUP_KEYS, "includeProjectGuide"]
  const unknown = Object.keys(advisorPayload).filter((k) => !allowed.includes(k))
  for (const k of unknown) {
    errors.push("advisor." + k + " is not supported for session apply (expected " + allowed.join("|") + ")")
  }
  for (const gk of GROUP_KEYS) {
    if (advisorPayload[gk] === undefined || advisorPayload[gk] === null) continue
    errors.push(...validateAdvisorGroup("advisor." + gk, advisorPayload[gk], undefined))
    const g = sanitizeGroup(advisorPayload[gk])
    if (g && Object.keys(g).length > 0) advisor[gk] = g
  }
  if (advisorPayload.includeProjectGuide !== undefined && advisorPayload.includeProjectGuide !== null) {
    if (typeof advisorPayload.includeProjectGuide !== "boolean") {
      errors.push("advisor.includeProjectGuide must be a boolean")
    } else {
      advisor.includeProjectGuide = advisorPayload.includeProjectGuide
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, errors, advisor: Object.keys(advisor).length > 0 ? advisor : null }
}

/**
 * POST /apply-session 逻辑（U7）：有效 sessionId → 写 sessionState.advisorOverride
 * （仅 advisor 白名单子集）；无效 → {ok:false, reason:'no-session'} 且不崩溃。
 * F12（§2.3 写点表）：advisorOverride 变更后写盘——deps.persistSession(sessionId) 钩子
 * （可选注入；apply() 注册处接线 saveSessionState，单测 stub 不注入则跳过——不写真实盘）。
 * @param {{sessionExists: (id: string) => boolean, stateOf: (id: string) => object,
 *          persistSession?: (id: string) => void}} deps
 * @param {string} sessionId
 * @param {unknown} advisorPayload
 */
export function applySessionOverride(deps, sessionId, advisorPayload) {
  const sid = String(sessionId ?? "").trim()
  if (!sid || !deps?.sessionExists?.(sid)) return { ok: false, reason: "no-session" }
  const v = sanitizeSessionAdvisor(advisorPayload)
  if (!v.ok) return { ok: false, errors: v.errors }
  const state = deps.stateOf(sid)
  state.advisorOverride = v.advisor // null = 无覆盖（与 reset 语义同）
  // R2 §4.4（D-10）：apply-session 变更 = 语义转换点，代际 +1（在飞 advisor 结果按旧
  // override 路由解析——晚到即弃，不复活已被变更的状态语义）
  bumpAdvisorGeneration(state)
  try { deps?.persistSession?.(sid) } catch { /* N3：写盘失败不阻塞（save 内部已 warn） */ }
  return { ok: true, override: state.advisorOverride }
}

/**
 * DELETE /session 逻辑（U7，与 apply-session 对称）：删该会话 advisorOverride（恢复会话默认）。
 * F12（§2.3）：同 apply-session——变更后经 deps.persistSession 落盘（advisorOverride 持久化）。
 */
export function resetSessionOverride(deps, sessionId) {
  const sid = String(sessionId ?? "").trim()
  if (!sid || !deps?.sessionExists?.(sid)) return { ok: false, reason: "no-session" }
  deps.stateOf(sid).advisorOverride = null
  try { deps?.persistSession?.(sid) } catch { /* N3：写盘失败不阻塞 */ }
  return { ok: true }
}

/**
 * GET /session 摘要（U4：页面顶部当前会话生效摘要 + 覆盖来源标注）。契约：
 * 无会话 → {ok:false, reason:'no-session'}；有会话 → {ok:true, override, effective}。
 * override = advisorOverride 现状（无覆盖 null）；effective = 该会话两组的解析结果
 * （会话覆盖 ⊕ 生效全局 ⊕ 会话 agent route，来源逐字段标注）+ includeProjectGuide 解析。
 */
export function describeSessionView(deps, sessionId) {
  const sid = String(sessionId ?? "").trim()
  if (!sid || !deps?.sessionExists?.(sid)) return { ok: false, reason: "no-session" }
  // 分歧审计 D2：cwdHint 在 apply() 注册处是函数形态——此处统一调用求值
  const cwdHint = typeof deps.cwdHint === "function" ? deps.cwdHint() : deps.cwdHint
  const config = effectiveGlobalConfig(deps.baseConfig, {
    dshHomeOverride: deps.dshHomeOverride,
    cwdHint,
  })
  const override = deps.stateOf(sid).advisorOverride ?? null
  const agentOpts = (deps.agentOptionsOf?.(sid) && typeof deps.agentOptionsOf(sid) === "object")
    ? deps.agentOptionsOf(sid)
    : {}
  const describe = (groupKey, round) => {
    const r = resolveAdvisorRoute({ config, override, agentOpts, advisorRound: round })
    if (!r.ok) return { ok: false, reason: "no LLM route" }
    return {
      ok: true,
      provider: r.provider, model: r.model, pairSource: r.pairSource,
      effort: r.effort, effortSource: r.effortSource,
      timeoutMs: r.timeoutMs, timeoutSource: r.timeoutSource,
      runner: r.runner ?? null,
    }
  }
  const ipg = resolveIncludeProjectGuide({ config, override })
  return {
    ok: true,
    override,
    effective: {
      round1: describe("round1", 0),
      convergence: describe("convergence", 1),
      includeProjectGuide: { value: ipg.value, source: ipg.source },
    },
  }
}

/** settings 可读时的 providers 键清单（评审 #6：getter 经 opts.settingsGet 懒取——settings 不在 inject 列表）；不可用 → undefined。 */
function knownProviderKeys(settingsGet) {
  try {
    const ns = typeof settingsGet === "function" ? settingsGet("llm-pi-ai") : undefined
    const providers = ns && typeof ns === "object" && !Array.isArray(ns) ? ns.providers : null
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined
    return Object.keys(providers)
  } catch {
    return undefined
  }
}

/**
 * 评审反馈修复：provider 存在性校验的权威源 = 运行时注册表（ctx.llm.listProviders ∪
 * listConfigurableProviders——含内置 DeepSeek 适配器与休眠可配置路由）∪ settings 覆盖层
 * （llm-pi-ai.providers）。此前只读 settings.yaml 覆盖层 → "deepseek-official 不在注册表"
 * 假阳性（settings 文件里根本没有内置适配器）。runtime 注册表不可读（含门面 ctx.llm 不透出
 * list* 的 app 构建，实证 2026-09-07）→ undefined（跳过存在性校验，附 note），见函数内注。
 */
async function knownProviderKeysExtended(opts) {
  const keys = new Set()
  let runtimeReadable = false
  try {
    const llm = opts?.llm
    const hasList = !!llm && (typeof llm.listProviders === "function" || typeof llm.listConfigurableProviders === "function")
    if (hasList) runtimeReadable = true
    if (llm && typeof llm.listProviders === "function") {
      const infos = await llm.listProviders()
      for (const info of Array.isArray(infos) ? infos : []) {
        if (info && typeof info.id === "string") keys.add(info.id)
      }
    }
    if (llm && typeof llm.listConfigurableProviders === "function") {
      const rows = await llm.listConfigurableProviders()
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row && typeof row.provider === "string") keys.add(row.provider)
      }
    }
  } catch { /* 运行时读取失败 → 视为不可读 */ }
  try {
    const fromSettings = knownProviderKeys(opts?.settingsGet)
    if (fromSettings) for (const k of fromSettings) keys.add(k)
  } catch { /* ignore */ }
  // 本地部署实证（2026-09-07）：部分 app 构建下插件 ctx.llm 是门面（仅 stream/resolveModel，
  // 不透出 list* 方法）→ 运行时注册表不可读。settings 覆盖层不是权威源（缺内置 DeepSeek
  // 路由，同 /catalog 注释）→ 仅凭 settings 做存在性校验会复活「deepseek-official 不在注册表」
  // 假阳性。runtime 不可读时返回 undefined = 跳过存在性校验（U3b note 路径）：宁可漏校验，
  // 不可错杀；运行时可读时仍维持 runtime ∪ settings 权威并集。
  if (!runtimeReadable) return undefined
  return keys.size > 0 ? [...keys] : undefined
}

/** 读请求体（super-injector 同款）。 */
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * config API prefix 路由 handler（§3.2 全部端点；JSON 往返；500 兜底 {ok:false}）。
 * @param {object} ctx — 宿主 ctx（webServer/settings/agents 经 get 取）
 * @param {{baseConfig: object, sessionExists: (id: string) => boolean,
 *          agentOptionsOf: (id: string) => object|undefined}} opts
 */
export function makeApiHandler(ctx, opts) {
  const baseConfig = opts?.baseConfig ?? {}
  return async (req, res) => {
    const send = (obj, code = 200) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify(obj))
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost")
      const path = url.pathname.replace(/^\/thincoder-suite\/api/, "") || "/"
      const query = url.searchParams

      if (req.method === "GET" && path === "/config") {
        const user = loadUserConfig(opts?.dshHomeOverride, opts?.cwdHint?.())
        return send({ ok: true, base: baseConfig, user, effective: mergeGlobalConfig(baseConfig, user) })
      }

      if (req.method === "GET" && path === "/session") {
        return send(describeSessionView(opts, query.get("sessionId") ?? ""))
      }

      // 一期 codex-runner（5.6）：模型目录发现 —— codex debug models → models_cache.json 兜底。
      // ?executable= 覆盖全局；?refresh=1 绕过进程内缓存。
      if (req.method === "GET" && path === "/codex/models") {
        const user = loadUserConfig(opts?.dshHomeOverride, opts?.cwdHint?.())
        const eff = mergeGlobalConfig(baseConfig, user)
        const g = resolveCodexCliGlobals(eff).globals
        const executable = query.get("executable") ?? g.executable
        const r = await discoverCodexModels({ executable, refresh: query.get("refresh") === "1" })
        if (!r.ok) return send({ ok: false, error: r.error }, 502)
        return send({ ok: true, source: r.source, fetchedAt: r.fetchedAt, executable, models: r.models })
      }

      // dsh provider/model 目录发现（设置页 dsh 行下拉数据源）：权威源 = ctx.llm 运行时
      // 注册表（listProviders/listModels——模型选择器同源，含内置 DeepSeek 适配器等全部
      // 运行时路由）；llm-pi-ai settings 的 reasoningEfforts 作为 effort 档位富化（有则用）。
      // 评审教训：settings.yaml 只是用户覆盖层（缺内置 DeepSeek 等）——不能作为唯一目录源。
      if (req.method === "GET" && path === "/catalog") {
        const llm = opts?.llm ?? null
        const llmReady = !!llm && typeof llm.listProviders === "function"
        const ns = opts?.settingsGet ? opts.settingsGet("llm-pi-ai") : null
        const providersRaw = (ns && typeof ns === "object" && !Array.isArray(ns)
          && ns.providers && typeof ns.providers === "object" && !Array.isArray(ns.providers))
          ? ns.providers : {}
        const effortsOf = (providerKey, modelId) => {
          const p = providersRaw[providerKey]
          const arr = p && Array.isArray(p.models) ? p.models : []
          const m = arr.filter((x) => x && typeof x === "object" && x.id === modelId)[0]
          if (m && m.reasoningEfforts && typeof m.reasoningEfforts === "object") {
            const list = Object.keys(m.reasoningEfforts).filter((k) => m.reasoningEfforts[k] !== null && m.reasoningEfforts[k] !== undefined)
            return list.length > 0 ? list : null
          }
          return null
        }
        const providers = []
        if (llmReady) {
          const infos = await llm.listProviders()
          for (const info of Array.isArray(infos) ? infos : []) {
            const key = info && typeof info.id === "string" ? info.id : null
            if (!key) continue
            let models = []
            try { models = await llm.listModels(key) } catch { models = [] }
            providers.push({
              id: key,
              displayName: info && typeof info.name === "string" ? info.name : key,
              models: (Array.isArray(models) ? models : []).map((m) => ({
                id: m && typeof m.id === "string" ? m.id : null,
                name: m && typeof m.name === "string" ? m.name : null,
                efforts: effortsOf(key, m && m.id),
              })).filter((m) => m.id),
            })
          }
        } else {
          // 门面 ctx.llm（仅 stream）构建的降级路径：settings 覆盖层作目录源（id+models+efforts）。
          // 虽非权威（缺内置路由），但设置页 dsh 行下拉立即可用；下拉外的内置路由键仍可手输
          // （配合 knownProviderKeysExtended 的 runtime 不可读 → 跳过存在性校验语义）。
          for (const [key, p] of Object.entries(providersRaw)) {
            if (!p || typeof p !== "object") continue
            const models = Array.isArray(p.models) ? p.models : []
            providers.push({
              id: key,
              displayName: typeof p.name === "string" && p.name ? p.name : key,
              models: models.map((m) => ({
                id: m && typeof m.id === "string" ? m.id : null,
                name: m && typeof m.name === "string" ? m.name : null,
                efforts: effortsOf(key, m && m.id),
              })).filter((m) => m.id),
            })
          }
        }
        if (providers.length === 0) {
          return send({ ok: false, error: llmReady
            ? "llm 运行时注册表为空（listProviders 返回空）"
            : "llm runtime 不可用（listProviders 缺失）且 settings 无 llm-pi-ai.providers" }, 502)
        }
        return send({ ok: true, providers, source: llmReady ? "runtime" : "settings" })
      }

      if (req.method === "PUT" && path === "/config") {
        let body
        try { body = JSON.parse(await readBody(req) || "{}") } catch (e) {
          return send({ ok: false, error: "invalid JSON body: " + (e?.message ?? String(e)) }, 400)
        }
        const known = await knownProviderKeysExtended(opts)
        const v = validateGlobalUserConfig(body?.config, known)
        if (!v.ok) return send({ ok: false, errors: v.errors }, 400)
        const saved = saveUserConfig(v.sanitized ?? {}, opts?.dshHomeOverride, opts?.cwdHint?.())
        if (!saved) return send({ ok: false, error: "failed to write user config (see console warn)" }, 500)
        const notes = [...v.notes]
        // 评审 #5：consult/escalate 工具注册基于启动时池快照——池从空到有需重启才注册（内容保存已即时生效）
        if (opts?.registeredPoolEmpty && Array.isArray(v.sanitized?.consultModels) && v.sanitized.consultModels.length > 0) {
          notes.push("consult/escalate 工具注册基于启动时池——新增模型池需重启 DSH 后工具才可用（配置已保存生效）")
        }
        return send({
          ok: true,
          user: v.sanitized ?? {},
          ...(notes.length > 0 ? { notes } : {}),
        })
      }

      if (req.method === "DELETE" && path === "/config") {
        clearUserConfig(opts?.dshHomeOverride, opts?.cwdHint?.())
        return send({ ok: true })
      }

      if (req.method === "POST" && path === "/apply-session") {
        let body
        try { body = JSON.parse(await readBody(req) || "{}") } catch (e) {
          return send({ ok: false, error: "invalid JSON body: " + (e?.message ?? String(e)) }, 400)
        }
        const r = applySessionOverride(opts, body?.sessionId, body?.advisor)
        if (r.reason === "no-session") return send({ ok: false, reason: "no-session" }, 404)
        if (!r.ok) return send({ ok: false, errors: r.errors }, 400)
        return send({ ok: true, override: r.override })
      }

      if (req.method === "DELETE" && path === "/session") {
        const r = resetSessionOverride(opts, query.get("sessionId") ?? "")
        if (r.reason === "no-session") return send({ ok: false, reason: "no-session" }, 404)
        return send({ ok: true })
      }

      return send({ ok: false, error: "not found: " + req.method + " " + path }, 404)
    } catch (e) {
      // 500 兜底（§3.2）：未知异常 → 统一 {ok:false}，路由不裸抛
      return send({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500)
    }
  }
}

/**
 * 注册 config API 前缀路由（webServer 可用时）。缺服务 → console.warn 跳过注册并返回
 * null（U8 降级路径：host 功能/工具不受影响——它们不依赖 webServer）。
 * @returns {(() => void)|null} webServer.register 的 disposer（push 进 ctx.effect disposes）
 */
export function registerConfigApi(ctx, opts) {
  if (!ctx?.webServer || typeof ctx.webServer.register !== "function") {
    console.warn("[thincoder-suite] webServer service unavailable — settings config API routes skipped (host tools unaffected)")
    return null
  }
  return ctx.webServer.register({
    kind: "prefix",
    path: CONFIG_API_PREFIX,
    handler: makeApiHandler(ctx, opts),
  })
}

// ————————————— D-30（FR-T2 静默面 ①）：旧密钥环境变量的一次性弃用告警 —————————————
// D-30 删除了 design token 的签名腿与整条密钥链后，THINCODER_TOKEN_SECRET 变为**无声 no-op**——
// 运维会误以为它仍在生效（设计评审 #9 要求显式处理该静默）。启动时检测到该 env 非空 → 打印
// 恰好一次弃用告警（说明密钥链已删除、该变量不再有任何作用）。进程级 once 标记：多次 apply /
// fiber 重建不重复刷屏。
// 静默面 ②（磁盘上的孤儿密钥文件）**声明不清理、留档**——删除属破坏性动作，不在本批范围
// （README 已注明其已被弃用）。
let deprecatedSecretEnvWarned = false

/**
 * 一次性弃用告警（可测入口：AC-26）。
 * @param {object} [env] — 环境（测试注入缝；缺省 process.env）
 * @returns {boolean} 本次是否打印了告警
 */
export function warnDeprecatedTokenSecretEnvOnce(env = process.env) {
  if (deprecatedSecretEnvWarned) return false
  const v = env?.THINCODER_TOKEN_SECRET
  if (typeof v !== "string" || v.trim() === "") return false
  deprecatedSecretEnvWarned = true
  console.warn("[thincoder-suite] THINCODER_TOKEN_SECRET is set but has NO effect anymore — the design-token "
    + "secret chain (HMAC signature leg) was removed in D-30. The design token is now a two-part uuid:expiresAt "
    + "guarded by exact-match + design-document-set fingerprint. This variable can be unset; the orphan key file "
    + "under $DSH_HOME/.thincoder is intentionally left in place.")
  return true
}

/** 测试缝：清一次性标记（使下一轮 apply/调用可再次打印）。 */
export function resetDeprecatedSecretEnvWarnForTests() { deprecatedSecretEnvWarned = false }

// ————————————— apply —————————————

export function apply(ctx, rawConfig) {
  // 配置尽力解析（cordis 可能经 patch entry config / 预设 group config 传入）
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {}
  // 二期（§2/§3.6-1）：注册期可见配置 = entry base ⊕ config.json user 层（consult/escalate
  // 工具的注册判定据此；call-time 每次执行再读一次——user 层保存即生效 U5）。
  const appliedCfg = effectiveGlobalConfig(config)
  const pool = Array.isArray(appliedCfg.consultModels)
    ? appliedCfg.consultModels.filter(m => m && typeof m === "object" && ((m.provider && m.model) || (m.runner && m.runner.kind === "codex-cli")))
    : []
  const configDefaultEngineering = Boolean(config.engineering)

  // R2 §4.5（D-11）：启动清扫陈旧 thincoder-codex-* 临时目录（>24h——宿主硬死孤儿缓解；
  // 进程级清扫无可靠属主标记 = 文档化边界 B9，登记表 D-11）。失败不阻塞装配。
  try { sweepStaleCodexTempDirs() } catch { /* 清扫失败不阻塞 */ }

  // D-30（FR-T2 静默面 ①）：旧密钥环境变量已无任何作用 —— 启动时一次性弃用告警（绝不静默）。
  try { warnDeprecatedTokenSecretEnvOnce() } catch { /* 告警失败不阻塞装配 */ }

  // —— 会话可见性注册表（config API session 端点的 no-session 判定辅助；agents 服务优先） ——
  const sessionRegistry = new Set()
  const markSessionSeen = (id) => { if (id) sessionRegistry.add(String(id)) }

  ctx.effect(() => {
    const disposes = []

    // —— 提示词 section ——
    if (ctx.systemPrompt?.section) {
      disposes.push(ctx.systemPrompt.section({
        name: "thincoder:discipline",
        order: 3000,
        text: DISCIPLINE,
      }))
      if (pool.length > 0) {
        disposes.push(ctx.systemPrompt.section({
          name: "thincoder:main",
          order: 3100,
          text: MAIN_EXTRA,
        }))
      }
    }

    // —— 工具注册 ——
    const register = (tool) => {
      if (typeof ctx.tools?.register === "function") disposes.push(ctx.tools.register(tool))
    }

    register(textTool({
      name: "advisor",
      description:
        "Run an independent review on your work (read-only sub-agent with its own tools). " +
        "type='code' (default): review code changes — pass paths=[...] (files/dirs) and/or documents=[...] (acceptance criteria context). " +
        "type='design': review design documents BEFORE implementation — pass documents=[...] (explicit doc list). " +
        "Round 1 does a full review; round 2 verifies your fix claims + obvious new issues; round 3+ strictly verifies only the prior table. The 5-round convergence cap applies to type='code' only — type='design' is exempt from the cap but is bounded instead by the settlement guard (3 consecutive design reviews of the same document set with no usable settlement block further reviews of that document set: zero LLM, not clearable inside the session — the only exit is a new session). " +
        "After each review you MUST reply with a response table: | # | Action | Detail | (Action in Fixed / Dispatched / Not an issue / Deferred; Dispatched = delegated to a subagent/job and NOT yet verified — name the target in Detail, and an unverified Dispatched 🔴 blocks convergence like an unfixed 🔴). " +
        "A design review that passes returns a design token for eng_coder.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["code", "design"], description: "'design' for design-doc review, 'code' (default) for code review" },
          paths: strArr("Code files/directories to review (code review)"),
          documents: strArr("Doc paths: review scope (design review) or acceptance-criteria context (code review)"),
        },
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "Advisor: no agent context."
        // 批 4（D-G7/§5.6）：**工具层三振预检**——同一判定（同一 designDocKey / 同一计数查询 /
        // 同一护栏串），在进入核心层之前快速返回。零 LLM（runAdvisorReview 根本不被调用）、
        // 零状态变更。核心层 runAdvisorReview 内另有一道直调防线（两级防线：直调不经本工具时
        // 仍被拦），两处共用同一实现，不复制判定逻辑。
        if (args?.type === "design") {
          const docKey = designDocKey(args?.documents)
          if (designStrikes(agent.session.id, docKey) >= DESIGN_STRIKE_LIMIT) {
            return settlementGuardText(agent.session.id, docKey)
          }
        }
        markSessionSeen(agent.session.id)
        // ctx 注入：codex runner 长评审经 ctx.jobs 派后台任务（ advisor.mjs 懒取）
        return runAdvisorReview({ llm: ctx.llm, ctx }, {
          agent,
          config,
          signal: exec?.signal,
          reviewType: args?.type,
          documents: args?.documents,
          paths: args?.paths,
          configDefaultEngineering,
        })
      },
    }))

    register(textTool({
      name: "advisor_config",
      description:
        "Inspect or override the advisor configuration FOR THIS SESSION (design docs/2026-09-01-advisor-config-design.md §3.6). " +
        "The request argument is a JSON object TEXT, e.g. " +
        "{\"action\":\"get\"} | {\"action\":\"set\",\"path\":\"round1.effort\",\"value\":\"low\"} | {\"action\":\"reset\",\"path\":\"round1\"}. " +
        "Settable paths: round1|convergence . provider|model|effort|timeoutMs|runner, or includeProjectGuide (boolean). " +
        "reset path: round1|convergence|includeProjectGuide|all (omit = all). " +
        "Session overrides take priority over the global group config for this session only; effort accepts off|low|medium|high|max; timeoutMs is a number in 1000..3600000.",
      parameters: {
        type: "object",
        properties: {
          request: { type: "string", description: "JSON object text: {action, path?, value?} (see tool description)" },
        },
        required: ["request"],
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "Error: no agent context."
        const out = runAdvisorConfigTool(String(args?.request ?? ""), {
          config,
          agentOpts: agent.options ?? {},
          state: sessionState(agent.session.id),
          sessionId: agent.session.id,
        })
        // F12（§2.3 写点表）：advisor_config set/reset（advisorOverride 变更）后写盘。
        // get/invalid 分支不改状态不写；写盘 fail-safe（N3：仅 warn 不抛，内存态兜底）。
        // R2 §4.4：全部写点经 sessionStateViewWithGeneration（generation 随 F12 视图持久化）。
        if (typeof out === "string" && /^advisor_config: (set|reset) /.test(out)) {
          try {
            saveSessionState(
              agent.session.id,
              sessionStateViewWithGeneration(sessionState(agent.session.id)),
              undefined,
              agent.session?.header?.cwd,
            )
          } catch { /* N3：写盘失败不阻塞 */ }
        }
        return out
      },
    }))

    register(textTool({
      name: "eng",
      description:
        "Toggle engineering mode for this session. enter: you become the architect — clarify requirements, write design docs, WAIT for the user to initiate the design review; implementation goes through eng_coder only. exit: restore standard workflow.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["enter", "exit"], description: "'enter' or 'exit'" },
        },
        required: ["action"],
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "Error: no agent context."
        return engineeringToggle(agent, args?.action)
      },
    }))

    register(textTool({
      name: "eng_coder",
      description:
        "Spawn the implementation sub-agent (engineering mode). Requires the design token from a PASSED advisor(type='design') review — pass it via the designToken parameter, never in the task text. Provide: task (what to implement), docs (the Docs involved list — design doc + requirements), and the token. " +
        "For large tasks pass stages: a structured stage list (2-8 recommended, max 10) — each stage { goal, files, acceptance, check } where check is the self-check command; the brief then enforces ordered execution, per-stage self-checks, STOP on a stage failing twice, and a stage status table at the top of the delivery report. " +
        "If a stage fails, re-spawn ONE new eng_coder with corrected stages starting from the failed stage (the token is not consumed) — that authorization applies ONLY to a stage the sub-agent itself declared failed in a complete report. " +
        "If eng_coder crashes / times out / is aborted (or otherwise returns a non-success status that is not a self-declared stage failure), do NOT re-spawn on your own — stop, report, and let the user decide. " +
        "On return, run the delivery review (advisor type='code').",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Implementation task: goal, constraints, file list, acceptance criteria" },
          designToken: { type: "string", description: "The exact token returned by a passed advisor(type='design') review" },
          docs: strArr("Docs involved: design doc + requirements + referenced docs (paths)"),
          background: { type: "boolean", default: false, description: "dsh 子代理后台执行：预计 >9 分钟的任务用它；返回 job 句柄，等完成通知再继续" },
          // F13（§3.1）：结构化 stages——工具 schema 层校验（不是 task 里写 markdown，防主代理
          // 格式漂移无法机械约束）。空字段由 schema 拒绝（required + minLength 1 / minItems 1，
          // 评审 #13）；渲染前另有代码级防御校验（实施确认项 5，eng.mjs validateStages）。
          stages: {
            type: "array",
            maxItems: 10,
            description: "Structured execution stages (2-8 recommended, max 10). Stage N's check must pass before N+1; a stage failing twice stops the run.",
            items: {
              type: "object",
              properties: {
                goal: { type: "string", minLength: 1, description: "Stage goal" },
                files: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Files this stage may touch" },
                acceptance: { type: "string", minLength: 1, description: "Acceptance criteria for this stage" },
                check: { type: "string", minLength: 1, description: "Self-check command (e.g. a syntax check of the files this stage changes, or the project's test command on a subset)" },
              },
              required: ["goal", "files", "acceptance", "check"],
            },
          },
        },
        required: ["task", "designToken"],
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "Error: no agent context."
        markSessionSeen(agent.session.id)
        // F9 资源项（engCoderMaxTokens/engCoderEffort）在 user 层可配——call-time 合并（U5）
        return runEngCoder({ ctx, agent, config: effectiveGlobalConfig(config), signal: exec?.signal, configDefaultEngineering }, args)
      },
    }))

    if (pool.length > 0) {
      register(textTool({
        name: "escalate",
        description:
          "TERMINOLOGY: 'escalate' is the only technical name; 飞刀 is the Chinese alias. When the user says 飞刀 / escalate / 'fly in <model>', call THIS tool directly. " +
          "Hand an implementation task to a stronger model — it gets WRITE access and does the work itself, then returns a post-op report (changes, why, verification). " +
          "Use it when YOU judge the task needs stronger hands (complex multi-file refactor, intractable bug, intricate algorithms — or beyond your comfortable ability); escalate EARLY, on up-front judgment. " +
          "You review its report (read the changed files, run the tests). For parallel READ-ONLY opinions use consult_start instead. Not available in engineering mode.",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task description with acceptance criteria" },
            model: { type: "string", description: "Candidate 'provider:model' from the consult models (optional, default first)" },
            followup: { type: "boolean", description: "codex rows only: continue the previous codex escalate thread in this session (exec resume; threadId kept in memory, never persisted)" },
            background: { type: "boolean", default: false, description: "dsh 子代理后台执行：预计 >9 分钟的任务用它；返回 job 句柄，等完成通知再继续" },
          },
          required: ["task"],
        },
        async execute(args, exec) {
          const agent = exec?.agent
          if (!agent?.session) return "Error: no agent context."
          markSessionSeen(agent.session.id)
          // consultModels 池在 user 层可配（整体替换）——call-time 合并（U5）
          const out = await runEscalate({ ctx, agent, config: effectiveGlobalConfig(config), state: sessionState(agent.session.id), signal: exec?.signal, configDefaultEngineering }, args?.task, args?.model, args?.followup === true, args?.background === true)
          // F12（§2.3 写点表）：escalate 交付后写盘（mutatedThisRun/touchedFiles 返回并入处）。
          // 写点放调用侧（escalate.mjs 按设计不动——parseTouchedFiles 兼容；§2.3 语义等价：
          // 状态变更已在内存，落盘时机在工具返回前）。fail-safe（N3：仅 warn 不抛）。
          // R2 §4.4：全部写点经 sessionStateViewWithGeneration；后台派发路径的交付簿记
          // 落盘在 escalate done 回调内（此处仅同步交付）。
          try {
            saveSessionState(
              agent.session.id,
              sessionStateViewWithGeneration(sessionState(agent.session.id)),
              undefined,
              agent.session?.header?.cwd,
            )
          } catch { /* N3：写盘失败不阻塞 */ }
          return out
        },
      }))

      register(textTool({
        name: "consult_start",
        description:
          "Start a parallel multi-model consultation (会诊) for a hard problem you are stuck on (repeated failures, no headway). Call it directly when the user asks for 会诊 / consult. " +
          "Several configured models analyze the same problem INDEPENDENTLY in parallel (read-only). Non-blocking: returns the consult id plus a background-job handle. " +
          // 批 15（FR-2）：**逐字反转**批 14 的 A 项那句「There is NO completion notification … you must come back yourself」
          //（提交 37d7eef 写死的那句在本批之后为假——consult 现在**走平台 jobs**，与 advisor / eng_coder / escalate 同形）。
          "★ Delivery is AUTOMATIC: consult now runs as a platform job (exactly like advisor / eng_coder / escalate), so when the session settles you ARE notified in-session — injected into your next step while you are busy, or opening a turn when you are idle. " +
          "Do NOT poll and do NOT end your turn waiting on a channel that does not exist: you no longer need to come back yourself. " +
          // 批 15（FR-3 / P4）：完成通知只有一行指针 ⇒ 正文必须再读一次
          "When the completion notice arrives, read the FULL digest with job_output first (the notice carries a pointer only), then dispose of EVERY reply — adopted / rejected with a reason / pending — and by default STOP and report to the user. " +
          // 批 15（FR-3 / US-9）：门禁 + 三豁免档 + 纪要落档（缺省不是豁免）
          "★ Digestion gate: this call is REFUSED (nothing is dispatched) while a settled consult of this session has neither been digested nor explicitly exempted; the refusal inlines the un-digested digest and shows the ack form. Ack with `digested: [{id, minutesPath}]` after writing the minutes (the file must exist) or `digested: [{id, minutesExempt:{reason}}]` to exempt the minutes with an explicit reason. " +
          "Minutes are the default record; stopping counts as a normal settle and still produces a digest (a tombstone one). " +
          "The brief decides the quality: symptom + what you already tried + entry-point files, ~150 words max.",
        parameters: {
          type: "object",
          properties: {
            problem: { type: "string", description: "Problem brief (symptom + failure trail + entry files)" },
            models: strArr('Optional subset of the pool: "provider:model", bare provider, or bare model (case-insensitive)'),
            // 批 15（FR-3 / D15-8）：**仅「无人值守」在 start 时声明**——「明确目标」与「明确授权」
            // 在**送达时判**（要求引用对话原话 / 既有授权文档），settle 前合成不到它们。
            exemption: {
              type: "object",
              description: "Declared-at-start exemption. ONLY the 'unattended' case belongs here; the 'goal' / 'authorized' cases are judged at delivery time and recorded in the minutes' ruling layer + the ack. Declaring it does NOT exempt you from reading the digest and disposing of every reply.",
              properties: {
                kind: { type: "string", enum: ["unattended"], description: "The only exemption declarable at start (the user is away and cannot be reported to)" },
                note: { type: "string", minLength: 1, description: "Required: why this delivery may continue instead of stopping — this note is the trace" },
              },
              required: ["kind", "note"],
            },
            // 批 15（FR-3 / §5.7）：消化门禁的恢复通道
            digested: {
              type: "array",
              description: "Ack of already-settled consults of this session (clears the digestion gate). One entry per consult: {id, minutesPath} (the file must exist on disk) or {id, minutesExempt:{reason}} (an explicit exemption, reason required).",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", minLength: 1, description: "Consult id (the N in `consult #N`)" },
                  minutesPath: { type: "string", description: "Minutes file you wrote/extended (fs existence is checked)" },
                  minutesExempt: {
                    type: "object",
                    description: "Explicit exemption from writing minutes (reason required — the trace)",
                    properties: { reason: { type: "string", minLength: 1 } },
                    required: ["reason"],
                  },
                },
                required: ["id"],
              },
            },
          },
          required: ["problem"],
        },
        async execute(args, exec) {
          const agent = exec?.agent
          if (!agent?.session) return "Error: no agent context."
          markSessionSeen(agent.session.id)
          const state = sessionState(agent.session.id)
          const deps = { ctx, agent, config: effectiveGlobalConfig(config), state, persona: undefined }
          // ★ 门禁不变量（US-9 / AC-19）：不存在 `settled ∧ ¬digested ∧ ¬minutesExempt` 的会话。
          // 命中 ⇒ **拒发** + 内联未消化 digest + ack 指引 ⇒ **未派发任何子代理**（拒发即恢复通道）。
          const gate = consultDigestionGate(state, args?.digested, deps)
          if (gate.blocked) return gate.text
          const r = await startConsultSession(
            // D-28：不传 signal——consult 子代理自持控制器（继承 PTC run-scoped 信号会在
            // run_code 程序 settle 时被 abort，平台 job 里的会诊永远读不到回复）
            deps,
            String(args?.problem ?? ""), args?.models, args?.exemption,
          )
          // 拒发（jobs 缺失 / jobs.start 抛错 / 池与选择器不合法）⇒ 响亮错误文本，零部分工作
          //（D15-4：**不回落同步**——同步路径接不住 consult 的预算）
          if (r.error) return r.error
          // FR-1（§6.2 @post）：返回 job 句柄文本（复用 jobsDispatchReply 先例）——
          // 投递由平台 onJobDone 承担，本仓不再需要任何「回来读」的动作。
          // FR-3（AC-26）：台账孤儿（有 started 无 settle）⇒ **建议性提示、不阻断**。
          const orphans = consultLedgerOrphans(deps, state)
          const orphanNote = orphans.length === 0 ? "" : "\n\n[thincoder-suite] 台账孤儿（建议性提示，不阻断）："
            + orphans.map((o) => "#" + o.id + "（" + (o.at === null ? "时间未知" : new Date(o.at).toISOString()) + " 发起，未见 settle）").join(" · ")
            + "——可能因重启丢失（`consultSessions` 纯内存）。"
          return r.text + orphanNote
        },
      }))

      register(textTool({
        name: "consult_stop",
        description:
          "Terminate the still-running consultations once a reply is good enough — saves tokens and time. " +
          // 批 15（D15-3 / AC-20）：stop 不再有损——墓碑 digest 保住已收到的回复 + stop 死亡行
          "★ Stopping loses NOTHING: the session still settles into a tombstone digest (the replies received so far plus the stop death line) and that digest is delivered exactly like a normal one. " +
          "Use it also when you must leave the consult unattended — the delivery will find you either way.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Consult id from consult_start (the number in `consult #<id>`)" },
            n: { type: "number", description: "Incrementing call number (next value after the last consult_start/consult_stop)" },
          },
          required: ["id", "n"],
        },
        async execute(args, exec) {
          const agent = exec?.agent
          if (!agent?.session) return "Error: no agent context."
          markSessionSeen(agent.session.id)
          const r = stopConsultSession(sessionState(agent.session.id), args?.id, args?.n,
            { ctx, agent, config: effectiveGlobalConfig(config), state: sessionState(agent.session.id), persona: undefined })
          return JSON.stringify(r)
        },
      }))
    }

    // —— 写门禁（tools/pre-execute waterfall） ——
    const offGate = ctx.on("tools/pre-execute", makeWriteGate(() => configDefaultEngineering))
    disposes.push(offGate)

    // —— 守卫 E 预闸（批 6b §6.4 / D-E1：**独立**监听器，不并进写门禁——两者 fail 朝向相反） ——
    // 两闸拒域**按设计意图**不相交（冻结集 = 文档 vs isProductCode = 非文档）；即便重叠也无害
    //（deny 可复合，注册次序仍无关）。不主张「构造性」——isProductCode 与（批 7 已删除的）isDocFile **曾是**两份
    // 互相矛盾的谓词，现统一于 path-kind.mjs 单一权威。放后侧保持既有门禁位置零移动。
    const offFreezeGate = ctx.on("tools/pre-execute", makeDocFreezeGate(() => designFreezeSet()))
    disposes.push(offFreezeGate)

    // —— 会话销毁清理（abort 会诊控制器 + 会话注册表移除） ——
    // F12（§2.4）：追加 removeSessionState——session-state.json 删除该 sessionId 条目（镜像
    // removeTokenRecord；不阻塞 consult 清理——remove 内部 fail-safe 仅 warn 不抛）。
    // 评审 #1：与各 save 点同源传 session cwd（DSH_HOME 未设时 pickDshHome 从会话 cwd 探测
    // profile 根——清理与写入必须落在同一存储文件，否则条目成孤儿只等 7d 清扫兜底）。
    const offDisposed = ctx.on("session/disposed", (session) => {
      try { if (session?.id) sessionRegistry.delete(String(session.id)) } catch { /* 清理失败不阻塞 */ }
      dropSession(session.id, (s) => cleanupConsultSessions(s))
      try { if (session?.id) removeSessionState(session.id, undefined, session?.header?.cwd) } catch { /* 清理失败不阻塞 */ }
      // 评审 #4：codex escalate 线程内存态随会话销毁清理（B14 生命周期闭环）
      try { if (session?.id) clearCodexThread(session.id) } catch { /* 清理失败不阻塞 */ }
      // R2 §4.5（D-22）：codexFailureCount 会话级内存态随会话销毁清理（防跨会话滞留误回落）
      try { if (session?.id) clearCodexFailureCount(session.id) } catch { /* 清理失败不阻塞 */ }
      // 批 4（D-G9/§5.6）：三振结算护栏计数同生命周期清理（会话级内存态；**唯一**解除路径——
      // 显式声明不可自解除：改配置/回滚文件/编辑文档都不复位，故这里不挂 resetRouteFailureState）。
      try { if (session?.id) clearDesignSettlementStrikes(session.id) } catch { /* 清理失败不阻塞 */ }
    })
    disposes.push(offDisposed)

    // —— thincoder-eng 预设识别（一键入口，DESIGN-dsh-port.md §7.5） ——
    // 预设会话创建即工程模式：header.agentPreset 匹配预设 id → 自动 enter。
    // 预设本身不重复装配本插件（避免 realm 双实例），机制全在此处。
    const PRESET_MATCH = /^(thincoder-eng)$/i
    // —— F12 会话状态预载恢复（§2.2，T0 实证：预载分支） ——
    // T0 实证结论：宿主恢复会话时 agent/session-start **会触发**——dsh-agent-loop 的
    // resume()（冷恢复，api-remotes 按需 agentFor 触发）与 create() 均经 setupAndPublish →
    // publish → emitAgentEvent("agent/session-start", { source: "startup"|"resume" })；
    // 且本插件既有 preset 自动 enter 即经此事件工作（事件确达插件的运行时证据）。sessionId
    // 跨重启稳定（resume 按 resumeSessionId 复用持久化 id）。故按设计 §2.2-1 实现预载路径，
    // 不加工具入口惰性兜底（§2.2-5 为 T0 反证分支）；残余风险：boot 期早于插件装配的恢复
    // 会错过事件——该场景 API 流量驱动的按需 resume 不覆盖，真重启冒烟（T1/T2）确认。
    const offSessionStart = ctx.on("agent/session-start", (payload) => {
      try {
        const agent = payload?.agent
        const session = agent?.session
        markSessionSeen(session?.id)
        // F12：map 无该 key 且盘上 TTL 内有效条目 → 白名单校验 + 规范化后整条灌入（只填空槽，
        // T15——map 已有（本进程会话已活跃/已推进）时 restoreSessionState 自行跳过，盘不覆盖）。
        const sid = session?.id
        if (sid) {
          const snapshot = loadSessionState(sid, undefined, session?.header?.cwd)
          if (snapshot) {
            const r = restoreSessionState(sid, snapshot)
            if (r.restored) {
              const state = sessionState(sid)
              // R2 §4.4（D-10）：恢复 generation（F12 视图条件字段——restoreSessionState 的
              // 固定字段集不含它，此处灌入；快照无该字段按 0 兜底）
              state.advisorGeneration = advisorGenerationOf(snapshot)
              // 批 4 §12（FR-G9/N-7）：恢复链作用域键（同 generation 的模式——它也不在
              // restoreSessionState 的固定字段集内）。**必须恢复**：advisorRound 是落盘的，
              // 链作用域键不恢复会在重启后失配 ⇒ 同一文档集被误判为新链（轮次与 prior 被误重置）
              // 或反之（换集不重置 = D-35 复活）。快照无该字段 → 保持 undefined（无判定）。
              if (typeof snapshot.lastDesignDocKey === "string" && snapshot.lastDesignDocKey !== "") {
                state.lastDesignDocKey = snapshot.lastDesignDocKey
              }
              // §2.2-2：恢复后 engineering === true → 重挂 section（engSection 不落盘——进程内
              // disposer 闭包不可序列化）；既有 if (!state.engSection) 守卫消解与 preset 自动
              // enter 的双挂（§7 确认项 4，恢复先行、preset 兜底）。
              if (state.engineering === true && !state.engSection) {
                try { state.engSection = attachEngineeringSection(agent) } catch { state.engSection = null }
              }
              // §2.2-4 / §2.5：一行 console 观测（含「停机改配置默认后恢复显式值胜出」的呈现面）
              console.log("[thincoder-suite] session state restored: advisorRound=" + r.advisorRound
                + ", lastReviewType=" + (r.lastReviewType ?? "none")
                + ", touchedFiles=" + r.touchedFiles.length
                + (r.engineering === true ? ", restored engineering=on from session state (explicit toggle wins over the config default)"
                  : r.engineering === false ? ", engineering=off (explicit)" : "")
                + (r.advisorOverride ? ", advisorOverride present" : ""))
            }
          }
        }
        const presetId = String(session?.header?.agentPreset ?? "")
        if (presetId && PRESET_MATCH.test(presetId)) {
          engineeringToggle(payload.agent, "enter")
        }
      } catch { /* 识别失败不阻塞会话启动 */ }
    })
    disposes.push(offSessionStart)

    // —— 设置页 config API（二期 §3.2；U8：webServer 缺失 → 仅 warn 跳过，host 功能不受影响） ——
    const agentsSvc = (() => { try { return ctx.get?.("agents") ?? null } catch { return null } })()
    const sessionExists = (id) => {
      const sid = String(id ?? "")
      if (!sid) return false
      try {
        if (agentsSvc && typeof agentsSvc.get === "function" && agentsSvc.get(sid)) return true
      } catch { /* agents 注册表不可用 → 回落事件注册表 */ }
      return sessionRegistry.has(sid)
    }
    const agentOptionsOf = (id) => {
      try {
        const agent = agentsSvc?.get?.(String(id ?? ""))
        return agent?.options && typeof agent.options === "object" ? agent.options : undefined
      } catch { return undefined }
    }
    // 评审 #1：stateOf 必须接线——会话三端点（apply/reset/describe）真实装配依赖它（测试 stub 曾掩盖缺漏）
    const apiDispose = registerConfigApi(ctx, {
      baseConfig: config, sessionExists, agentOptionsOf,
      registeredPoolEmpty: pool.length === 0, // 评审 #5：注册基于启动快照——池从空到有的保存需重启才注册工具
      stateOf: (id) => sessionState(String(id)),
      settingsGet: (ns) => { try { return ctx.get?.("settings")?.get?.(ns) ?? null } catch { return null } }, // 评审 #6：settings 懒取（仿 agents）
      llm: ctx.llm ?? null, // /catalog：运行时注册表（listProviders/listModels——DeepSeek 等内置适配器的权威源）
      cwdHint: () => cwdHintOf(ctx), // 评审 #10：cwdHint 统一（cwdHintOf 单一实现）
      // F12（§2.3 写点表）：apply/reset-session 后写盘（advisorOverride 持久化——
      // sessionStateViewWithGeneration 组装视图，saveSessionState fail-safe 仅 warn 不抛）。
      // 评审 #2：cwdHint 从**目标会话**解析（agentsSvc.get(id).header.cwd）——config API 操作的
      // 会话由 id 标识，正在执行的 agent cwd 可能不同；DSH_HOME 未设时写入必须与恢复时读取
      // 落在同一存储文件（session-start 用目标会话的 cwd 探测）。取不到目标会话回落调用方 cwd。
      persistSession: (id) => {
        const targetCwd = (() => {
          try {
            const a = agentsSvc?.get?.(String(id ?? ""))
            return a?.session?.header?.cwd ?? undefined
          } catch { return undefined }
        })()
        saveSessionState(String(id), sessionStateViewWithGeneration(sessionState(String(id))), undefined, targetCwd ?? cwdHintOf(ctx))
      },
    })
    if (apiDispose) disposes.push(apiDispose)
    console.log("[thincoder-suite] active: advisor/eng/eng_coder" + (pool.length > 0 ? "/escalate/consult (pool: " + pool.length + ")" : " (consult pool empty — configure consultModels to enable)") + (apiDispose ? " + config api" : " (config api skipped — no webServer)"))
    return () => {
      for (const d of disposes) { try { d?.() } catch { /* already disposed */ } }
      // fiber dispose 时清空本插件经手的全部会话状态（评审 #2：模块级 Map 跨 fiber 存活）
      dropAllSessions((s) => cleanupConsultSessions(s))
    }
  })
}
