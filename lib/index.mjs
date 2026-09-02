// index.mjs — 插件入口：工具注册 + 提示词 section + 写门禁 + 会话清理。
// 零 bare import 工程决策（纯 JS 直发）：
// 当插件经 junction 安装时，Node 会把它 realpath 化，从安装目录向上解析不到
// @deepseek-ai/dsh-tools / schemastery / cordis（实测 ERR_MODULE_NOT_FOUND）；
// dsh-task-status 证明 cordis 插件契约（name/inject/apply）无需 import cordis。
// 因此：工具手工构造 ToolDefinition 形状（JSON Schema parameters + output 契约），
// 配置经 apply(ctx, config) 尽力解析（预设 group config / patch entry config 均可传入）。
import { sessionState, dropSession, dropAllSessions, engEffective } from "./state.mjs"
import {
  runAdvisorReview, runAdvisorConfigTool,
  resolveAdvisorRoute, resolveIncludeProjectGuide,
  isValidEffort, isValidTimeoutMs, isModelField, isValidEngCoderMaxTokens,
  EFFORT_LEVELS, ADVISOR_TIMEOUT_MIN_MS, ADVISOR_TIMEOUT_MAX_MS,
} from "./advisor.mjs"
import {
  startConsultSession, checkConsultSession, stopConsultSession, cleanupConsultSessions,
} from "./consult.mjs"
import { runEscalate } from "./escalate.mjs"
import { engineeringToggle, makeWriteGate, runEngCoder } from "./eng.mjs"
import {
  loadUserConfig, saveUserConfig, clearUserConfig, mergeGlobalConfig,
  effectiveGlobalConfig,
} from "./config-store.mjs"
import { DISCIPLINE, MAIN_EXTRA } from "./prompts.mjs"

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
  const unknown = Object.keys(group).filter((k) => !["provider", "model", "effort", "timeoutMs"].includes(k))
  for (const k of unknown) errors.push(prefix + "." + k + " is not a supported advisor field")
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
    const unknown = Object.keys(row).filter((k) => !["provider", "model", "effort"].includes(k))
    for (const k of unknown) errors.push(p + "." + k + " is not a supported consult-model field")
    if (!isModelField(row.provider)) errors.push(p + ".provider is required and must be a non-empty string")
    else if (Array.isArray(knownProviders) && !knownProviders.includes(row.provider)) {
      errors.push(p + ".provider " + JSON.stringify(row.provider)
        + " is not in the configured provider registry (llm-pi-ai.providers)")
    }
    if (!isModelField(row.model)) errors.push(p + ".model is required and must be a non-empty string")
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
  const topAllowed = ["advisor", "consultModels", "engCoderMaxTokens", "engCoderEffort"]
  if (!userConfig || typeof userConfig !== "object" || Array.isArray(userConfig)) {
    errors.push("config must be an object")
    return { ok: false, errors, notes }
  }
  if (knownProviders === undefined) {
    notes.push("provider registry unavailable (ctx.settings llm-pi-ai not readable) — provider existence not verified")
  }
  const unknownTop = Object.keys(userConfig).filter((k) => !topAllowed.includes(k))
  for (const k of unknownTop) {
    notes.push("ignoring unknown top-level field " + JSON.stringify(k) + " (user-layer whitelist: " + topAllowed.join("|") + ")")
  }
  const sanitized = {}
  if (userConfig.advisor !== undefined && userConfig.advisor !== null) {
    const adv = userConfig.advisor
    if (typeof adv !== "object" || Array.isArray(adv)) {
      errors.push("advisor must be an object")
    } else {
      const advUnknown = Object.keys(adv).filter((k) => ![...GROUP_KEYS, "includeProjectGuide"].includes(k))
      for (const k of advUnknown) errors.push("advisor." + k + " is not supported (expected " + GROUP_KEYS.join("|") + "|includeProjectGuide)")
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
  return out
}

/** consultModels 行净化：provider/model 必填，effort 可选枚举。 */
function sanitizeConsultRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null
  if (!isModelField(row.provider) || !isModelField(row.model)) return null
  const out = { provider: row.provider, model: row.model }
  if (isValidEffort(row.effort)) out.effort = row.effort
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
 * @param {{sessionExists: (id: string) => boolean, stateOf: (id: string) => object}} deps
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
  return { ok: true, override: state.advisorOverride }
}

/**
 * DELETE /session 逻辑（U7，与 apply-session 对称）：删该会话 advisorOverride（恢复会话默认）。
 */
export function resetSessionOverride(deps, sessionId) {
  const sid = String(sessionId ?? "").trim()
  if (!sid || !deps?.sessionExists?.(sid)) return { ok: false, reason: "no-session" }
  deps.stateOf(sid).advisorOverride = null
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

      if (req.method === "PUT" && path === "/config") {
        let body
        try { body = JSON.parse(await readBody(req) || "{}") } catch (e) {
          return send({ ok: false, error: "invalid JSON body: " + (e?.message ?? String(e)) }, 400)
        }
        const v = validateGlobalUserConfig(body?.config, knownProviderKeys(opts?.settingsGet))
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

// ————————————— apply —————————————

export function apply(ctx, rawConfig) {
  // 配置尽力解析（cordis 可能经 patch entry config / 预设 group config 传入）
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {}
  // 二期（§2/§3.6-1）：注册期可见配置 = entry base ⊕ config.json user 层（consult/escalate
  // 工具的注册判定据此；call-time 每次执行再读一次——user 层保存即生效 U5）。
  const appliedCfg = effectiveGlobalConfig(config)
  const pool = Array.isArray(appliedCfg.consultModels)
    ? appliedCfg.consultModels.filter(m => m && typeof m === "object" && m.provider && m.model)
    : []
  const configDefaultEngineering = Boolean(config.engineering)

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
        "Round 1 does a full review; round 2 verifies your fix claims + obvious new issues; round 3+ strictly verifies only the prior table; max 5 rounds. " +
        "After each review you MUST reply with a response table: | # | Action | Detail | (Action in Fixed / Not an issue / Deferred). " +
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
        return runAdvisorReview({ llm: ctx.llm }, {
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
        "Settable paths: round1|convergence . provider|model|effort|timeoutMs, or includeProjectGuide (boolean). " +
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
        return runAdvisorConfigTool(String(args?.request ?? ""), {
          config,
          agentOpts: agent.options ?? {},
          state: sessionState(agent.session.id),
          sessionId: agent.session.id,
        })
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
        return engineeringToggle(agent, configDefaultEngineering, args?.action)
      },
    }))

    register(textTool({
      name: "eng_coder",
      description:
        "Spawn the implementation sub-agent (engineering mode). Requires the design token from a PASSED advisor(type='design') review — pass it via the designToken parameter, never in the task text. Provide: task (what to implement), docs (the Docs involved list — design doc + requirements), and the token. On return, run the delivery review (advisor type='code').",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Implementation task: goal, constraints, file list, acceptance criteria" },
          designToken: { type: "string", description: "The exact token returned by a passed advisor(type='design') review" },
          docs: strArr("Docs involved: design doc + requirements + referenced docs (paths)"),
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
          },
          required: ["task"],
        },
        async execute(args, exec) {
          const agent = exec?.agent
          if (!agent?.session) return "Error: no agent context."
          markSessionSeen(agent.session.id)
          // consultModels 池在 user 层可配（整体替换）——call-time 合并（U5）
          return runEscalate({ ctx, agent, config: effectiveGlobalConfig(config), state: sessionState(agent.session.id), signal: exec?.signal, configDefaultEngineering }, args?.task, args?.model)
        },
      }))

      register(textTool({
        name: "consult_start",
        description:
          "Start a parallel multi-model consultation (会诊) for a hard problem you are stuck on (repeated failures, no headway). Call it directly when the user asks for 会诊 / consult. " +
          "Several configured models analyze the same problem INDEPENDENTLY in parallel (read-only). Non-blocking: returns a consult id immediately. " +
          "Then call consult_check(id, n) alone in a turn to read each reply as it arrives, judge/verify with your own tools, and consult_stop(id, n) once a reply is good enough. " +
          "The brief decides the quality: symptom + what you already tried + entry-point files, ~150 words max.",
        parameters: {
          type: "object",
          properties: {
            problem: { type: "string", description: "Problem brief (symptom + failure trail + entry files)" },
            models: strArr('Optional subset of the pool: "provider:model", bare provider, or bare model (case-insensitive)'),
          },
          required: ["problem"],
        },
        async execute(args, exec) {
          const agent = exec?.agent
          if (!agent?.session) return "Error: no agent context."
          markSessionSeen(agent.session.id)
          const r = await startConsultSession(
            { ctx, agent, config: effectiveGlobalConfig(config), state: sessionState(agent.session.id), signal: exec?.signal, persona: undefined },
            String(args?.problem ?? ""), args?.models,
          )
          if (r.error) return r.error
          return JSON.stringify({ id: r.id, models: r.models })
        },
      }))

      register(textTool({
        name: "consult_check",
        description:
          "Read the NEXT consultation reply (whichever model answered first). Blocks until a reply arrives or all models have settled. The reply is raw and unjudged — verify/adopt it with your own tools. " +
          "Call it ALONE in a turn — never batch it with calls that depend on its reply. Replies arrive in arrival order: call repeatedly (n = 1, 2, 3, …) until done is true.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Consult id from consult_start" },
            n: { type: "number", description: "1-based read number: 1 for the first check, incrementing each subsequent check" },
          },
          required: ["id", "n"],
        },
        async execute(args, exec) {
          const agent = exec?.agent
          if (!agent?.session) return "Error: no agent context."
          const r = await checkConsultSession(sessionState(agent.session.id), args?.id, exec?.signal)
          return JSON.stringify(r)
        },
      }))

      register(textTool({
        name: "consult_stop",
        description:
          "Terminate the still-running consultations once a reply is good enough — saves tokens and time. Already-answered replies stay available for consult_check.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Consult id from consult_start" },
            n: { type: "number", description: "Incrementing call number (next value after the last consult_check/consult_stop)" },
          },
          required: ["id", "n"],
        },
        async execute(args, exec) {
          const agent = exec?.agent
          if (!agent?.session) return "Error: no agent context."
          const r = stopConsultSession(sessionState(agent.session.id), args?.id, args?.n)
          return JSON.stringify(r)
        },
      }))
    }

    // —— 写门禁（tools/pre-execute waterfall） ——
    const offGate = ctx.on("tools/pre-execute", makeWriteGate(() => configDefaultEngineering))
    disposes.push(offGate)

    // —— 会话销毁清理（abort 会诊控制器 + 会话注册表移除） ——
    const offDisposed = ctx.on("session/disposed", (session) => {
      try { if (session?.id) sessionRegistry.delete(String(session.id)) } catch { /* 清理失败不阻塞 */ }
      dropSession(session.id, (s) => cleanupConsultSessions(s))
    })
    disposes.push(offDisposed)

    // —— thincoder-eng 预设识别（一键入口，DESIGN-dsh-port.md §7.5） ——
    // 预设会话创建即工程模式：header.agentPreset 匹配预设 id → 自动 enter。
    // 预设本身不重复装配本插件（避免 realm 双实例），机制全在此处。
    const PRESET_MATCH = /^(thincoder-eng)$/i
    const offSessionStart = ctx.on("agent/session-start", (payload) => {
      try {
        const session = payload?.agent?.session
        markSessionSeen(session?.id)
        const presetId = String(session?.header?.agentPreset ?? "")
        if (presetId && PRESET_MATCH.test(presetId)) {
          engineeringToggle(payload.agent, configDefaultEngineering, "enter")
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
      cwdHint: () => { try { return ctx.get?.("agent")?.session?.header?.cwd ?? process.cwd() } catch { return process.cwd() } }, // 评审 #10：cwdHint 统一
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
