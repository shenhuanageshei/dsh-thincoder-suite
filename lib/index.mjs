// index.mjs — 插件入口：工具注册 + 提示词 section + 写门禁 + 会话清理。
// 零 bare import 工程决策（纯 JS 直发）：
// 当插件经 junction 安装时，Node 会把它 realpath 化，从安装目录向上解析不到
// @deepseek-ai/dsh-tools / schemastery / cordis（实测 ERR_MODULE_NOT_FOUND）；
// dsh-task-status 证明 cordis 插件契约（name/inject/apply）无需 import cordis。
// 因此：工具手工构造 ToolDefinition 形状（JSON Schema parameters + output 契约），
// 配置经 apply(ctx, config) 尽力解析（预设 group config / patch entry config 均可传入）。
import { sessionState, dropSession, dropAllSessions, engEffective } from "./state.mjs"
import { runAdvisorReview, runAdvisorConfigTool } from "./advisor.mjs"
import {
  startConsultSession, checkConsultSession, stopConsultSession, cleanupConsultSessions,
} from "./consult.mjs"
import { runEscalate } from "./escalate.mjs"
import { engineeringToggle, makeWriteGate, runEngCoder } from "./eng.mjs"
import { DISCIPLINE, MAIN_EXTRA } from "./prompts.mjs"

/** Cordis 插件名。 */
export const name = "thincoder-suite"

/** 所需服务。 */
export const inject = ["tools", "llm", "subagents", "systemPrompt"]

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

// ————————————— apply —————————————

export function apply(ctx, rawConfig) {
  // 配置尽力解析（cordis 可能经 patch entry config / 预设 group config 传入）
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {}
  const pool = Array.isArray(config.consultModels)
    ? config.consultModels.filter(m => m && typeof m === "object" && m.provider && m.model)
    : []
  const configDefaultEngineering = Boolean(config.engineering)

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
        return runEngCoder({ ctx, agent, config, signal: exec?.signal, configDefaultEngineering }, args)
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
          return runEscalate({ ctx, agent, config, state: sessionState(agent.session.id), signal: exec?.signal, configDefaultEngineering }, args?.task, args?.model)
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
          const r = await startConsultSession(
            { ctx, agent, config, state: sessionState(agent.session.id), signal: exec?.signal, persona: undefined },
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

    // —— 会话销毁清理（abort 会诊控制器） ——
    const offDisposed = ctx.on("session/disposed", (session) => {
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
        const presetId = String(session?.header?.agentPreset ?? "")
        if (presetId && PRESET_MATCH.test(presetId)) {
          engineeringToggle(payload.agent, configDefaultEngineering, "enter")
        }
      } catch { /* 识别失败不阻塞会话启动 */ }
    })
    disposes.push(offSessionStart)

    console.log("[thincoder-suite] active: advisor/eng/eng_coder" + (pool.length > 0 ? "/escalate/consult (pool: " + pool.length + ")" : " (consult pool empty — configure consultModels to enable)"))
    return () => {
      for (const d of disposes) { try { d?.() } catch { /* already disposed */ } }
      // fiber dispose 时清空本插件经手的全部会话状态（评审 #2：模块级 Map 跨 fiber 存活）
      dropAllSessions((s) => cleanupConsultSessions(s))
    }
  })
}
