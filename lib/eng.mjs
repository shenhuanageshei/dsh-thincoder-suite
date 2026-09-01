// eng.mjs — 工程模式：enter/exit 翻转 + 写门禁 + eng_coder + designToken 生命周期。
// 移植自 thincoder eng 体系（ENGINEERING-MODE.md）。DSH 映射（DESIGN-dsh-port.md §4.2）：
// - 提示词切换：agent 作用域 systemPrompt.section（enter 注册 / exit 释放）
// - 写门禁：tools/pre-execute waterfall（无 token 写产品代码 → deny）
// - designToken：advisor(design) 裁决通过 ∧ 批准码回显命中时签发（协议 v2，
//   DESIGN-advisor-token-protocol-fix.md）→ eng_coder spawn 时机械校验 → 不消费（多次 spawn OK）
// - token 拒绝消息三态（R3）：never issued / expired / mismatch——排障信号各不相同
// - eng_coder 返回 → 重置 advisor 轮次预算（交付 code review 必然发生）
import { ENGINEERING, ENG_CODER_PERSONA } from "./prompts.mjs"
import { sessionState, engEffective } from "./state.mjs"
import { validateDesignToken } from "./advisor.mjs"
import { parseTouchedFiles } from "./escalate.mjs"

const ENG_SECTION_NAME = "thincoder:engineering"
const ENG_SECTION_ORDER = 3500 // 外部插件有限值区间（3000–4000）

/** 写工具集合（pwsh/run_code 不拦——间接写靠流程纪律，thincoder 同款）。 */
const WRITE_TOOLS = new Set(["write", "edit"])

/** 产品代码判定（对齐 thincoder：/^src[\/]/ 或非文档文件；docs/** 与根级文档豁免）。 */
export function isProductCode(p) {
  const norm = String(p ?? "").replace(/\\/g, "/")
  if (!norm) return false
  if (norm.startsWith("docs/")) return false
  if (/^src\//.test(norm)) return true
  // 根级文档豁免：路径中无 "/"（纯文件名）且是文档扩展名
  if (!norm.includes("/")) {
    return !/\.(md|markdown|mdx|txt|rst|adoc)$/i.test(norm)
  }
  // 其他目录：文档扩展名豁免（设计文档、需求文档可写——架构师产出物）
  return !/\.(md|markdown|mdx|txt|rst|adoc)$/i.test(norm)
}

/** 从工具参数提取目标路径（write/edit 的 file_path）。 */
function targetPathOf(name, args) {
  const a = args ?? {}
  return typeof a.file_path === "string" ? a.file_path
    : typeof a.path === "string" ? a.path
    : null
}

/**
 * 注册 agent 作用域 engineering section（enter 时）。返回 disposer。
 * agent.ctx 是 agent-scoped Context——section 只影响该 agent 的系统提示词装配。
 */
export function attachEngineeringSection(agent) {
  if (!agent?.ctx?.systemPrompt?.section) return null
  return agent.ctx.systemPrompt.section({
    name: ENG_SECTION_NAME,
    order: ENG_SECTION_ORDER,
    text: ENGINEERING,
  })
}

/** eng enter/exit 翻转。返回结果文本。 */
export function engineeringToggle(agent, configDefaultEngineering, action) {
  const state = sessionState(agent.session.id)
  if (action === "enter") {
    state.engineering = true
    if (!state.engSection) {
      try { state.engSection = attachEngineeringSection(agent) } catch { state.engSection = null }
    }
    return "Engineering mode ON — you are now the architect: clarify requirements, write design docs in docs/, and WAIT for the user to initiate the design review (advisor type='design'). Implementation goes through eng_coder with a design token. Use eng(action='exit') to leave."
  }
  if (action === "exit") {
    state.engineering = false
    try { state.engSection?.() } catch { /* already disposed */ }
    state.engSection = null
    return "Engineering mode OFF — standard workflow restored."
  }
  return "Error: action must be 'enter' or 'exit'."
}

/**
 * 写门禁判定（tools/pre-execute waterfall 的一环）。
 * 规则（DESIGN-dsh-port.md §4.2）：eng ON && 主代理（depth 0）&& 无有效 designToken
 * && 工具 ∈ {write, edit} && 目标 isProductCode → deny + 指引。其余 → next()。
 */
export function makeWriteGate(getConfigDefault) {
  return async (exec, next) => {
    try {
      const name = exec?.name
      if (!WRITE_TOOLS.has(name)) return await next()
      const agent = exec?.agent
      if (!agent?.session) return await next()
      // 只拦主代理（depth 0）；子代理是受启动校验保护的实现者（eng_coder 链）
      const depth = agent.session.header?.delegationDepth ?? 0
      if (depth > 0) return await next()
      const state = sessionState(agent.session.id)
      if (!engEffective(state, getConfigDefault())) return await next()
      // 有效 token：state 一致 + 签名/过期校验
      if (state.designToken && validateDesignToken(state.designToken)) return await next()
      const target = targetPathOf(name, exec?.arguments)
      if (!target || !isProductCode(target)) return await next()
      return {
        kind: "deny",
        reason: "denied: engineering mode is ON and no design token — write the design document first, have the user initiate advisor(type='design'), then implement via eng_coder (the designToken parameter). Docs (*.md under docs/ or at the root) stay writable.",
      }
    } catch {
      return await next() // 门禁自身故障 → 放行（fail-open 只在此处：门禁 bug 不能瘫痪整个会话）
    }
  }
}

// ————————————— eng_coder —————————————

/** eng_coder 任务书（对齐 thincoder：Docs involved + 文件清单 + 验收标准 + token 走参数）。 */
function buildCoderBrief(task, docs) {
  const lines = [
    "# Implementation Task (engineering workflow)",
    task,
    "",
  ]
  if (docs && docs.length > 0) {
    lines.push("## Docs involved (read them ALL in full before coding)")
    for (const d of docs) lines.push("- " + d)
    lines.push("")
  }
  lines.push(
    "Implement to the full design — no silent degradation. If a stated design element is missing from the docs above, note it in your report; do not invent.",
    "Do not modify any file not listed in the design.",
    "",
    "Your last message IS the report the parent sees. Make it complete:",
    "1. What you changed and why",
    "2. The path of every file you touched",
    "3. How you verified (checks/tests run, with results)",
    "4. Any deviations from the design or items worth follow-up",
    "",
    "END the report with one line exactly in this format (comma-separated relative paths, or 'none'):",
    "Touched files: <paths>",
  )
  return lines.join("\n")
}

/**
 * 执行一次 eng_coder 派遣。
 * @param deps { ctx, agent, config, signal, configDefaultEngineering }
 */
export async function runEngCoder(deps, args) {
  const { ctx, agent, signal } = deps
  const state = sessionState(agent.session.id)
  const task = String(args?.task ?? "").trim()
  if (!task) return "Error: task is required."
  const docs = Array.isArray(args?.docs) ? args.docs.filter(d => typeof d === "string" && d.trim()) : []

  // token 机械校验：与状态一致 + 签名/过期有效（不符即拒——spawn 时刻的授权门禁）。
  // R3 三态拒绝：never issued（本会话 state.designToken 为空）/ expired（token 第二段
  // expiresAt 已过，提示重跑评审铸新 token）/ mismatch（其余不一致，保持现行文案）。
  // 判序：先看会话有无签发记录，再看存量 token 是否过期（过期优先于不一致——即使回传
  // 正确 token 也已失效，唯一出路就是重跑评审）。
  const token = args?.designToken
  if (!token || token !== state.designToken || !validateDesignToken(token)) {
    if (!state.designToken) {
      return "Error: no design token issued in this session — run advisor(type='design') first (the user initiates it)."
    }
    const expiresAt = Number.parseInt(String(state.designToken).split(":")[1], 10)
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      return "Error: design token expired at " + new Date(expiresAt).toLocaleString() + " (TTL engTokenTtlMs) — re-run the design review to mint a fresh token."
    }
    return "Error: invalid or missing design token — eng_coder requires the token issued by a PASSED advisor(type='design') review. Run the design review first (the user initiates it), then pass its token verbatim."
  }
  if (!engEffective(state, deps.configDefaultEngineering)) {
    return "Error: engineering mode is OFF — eng_coder is the engineering-workflow implementer. Use eng(action='enter') first."
  }

  const agentOpts = agent.options ?? {}
  let run
  try {
    run = await ctx.subagents.start("spawn", {
      prompt: [{ type: "text", text: buildCoderBrief(task, docs) }],
      parent: agent,
      signal: signal ?? null,
      persona: ENG_CODER_PERSONA,
      label: "eng-coder",
      agentOptions: { provider: agentOpts.provider, model: agentOpts.model },
      toolFilter: { deny: ["escalate", "consult_start", "consult_check", "consult_stop", "eng", "eng_coder"] },
    })
  } catch (e) {
    return "eng_coder failed to start: " + (e?.message ?? String(e))
  }

  let result
  try {
    result = await run.result
  } catch (e) {
    if (signal?.aborted || e?.name === "AbortError") return "eng_coder aborted."
    return "eng_coder error: " + (e?.message ?? String(e))
  } finally {
    try { await run.dispose() } catch { /* already disposed */ }
  }

  const outputText = (result?.output ?? [])
    .filter(b => b?.type === "text").map(b => b.text ?? "").join("\n").trim()
  const touched = parseTouchedFiles(outputText)

  // mergeChildMutations 等价物：子交付 → 重置 advisor 预算（交付 code review 必然发生）
  state.advisorRound = 0
  state.lastAdvisorOutput = null
  if (touched.length > 0) {
    const merged = new Set([...(state.touchedFiles ?? []), ...touched])
    state.touchedFiles = [...merged]
  }
  state.mutatedThisRun = true

  const stopReason = result?.stopReason ?? "unknown"
  if (stopReason !== "completed") {
    const diag = result?.diagnostic ? " — " + result.diagnostic : ""
    return "eng_coder ended: " + stopReason + diag + "\nPartial output:\n" + outputText.slice(0, 2000)
  }
  return "eng_coder delivery:\n" + (outputText || "(empty report)") +
    "\n\nNext (automatic flow nodes): verify the delivery against the acceptance criteria, run the divergence audit if this is the FIRST delivery, then run advisor(type='code', documents=[Docs involved])."
}
