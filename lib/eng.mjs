// eng.mjs — 工程模式：enter/exit 翻转 + 写门禁 + eng_coder + designToken 生命周期。
// 移植自 thincoder eng 体系（ENGINEERING-MODE.md）。DSH 映射（DESIGN-dsh-port.md §4.2）：
// - 提示词切换：agent 作用域 systemPrompt.section（enter 注册 / exit 释放）
// - 写门禁：tools/pre-execute waterfall（无 token 写产品代码 → deny）
// - designToken：advisor(design) 裁决通过 ∧ 批准码回显命中时签发（协议 v2，
//   DESIGN-advisor-token-protocol-fix.md）→ eng_coder spawn 时机械校验 → 不消费（多次 spawn OK）
// - token 拒绝消息三态（R3）：never issued / expired / mismatch——排障信号各不相同
// - eng_coder 返回 → 重置 advisor 轮次预算（交付 code review 必然发生）
// F12（docs/2026-09-02-session-state-stages-design.md §2.3）：eng enter/exit 翻转与 eng_coder
// 交付后写盘（session-state.json——engineering/advisorRound 等跨重启恢复）。
// F13（§3.1/§3.2/§3.3）：eng_coder 可选 stages 结构化参数——阶段化任务书（统一编号四段渲染
// + 阶段纪律 + stage 状态表前置指令 + 预算将尽条款 + 漂移探测 + 渲染前防御校验）；stages 缺省时
// buildCoderBrief 输出逐字节等于现行（T9 fixture 锁死）。
import { ENGINEERING, ENG_CODER_PERSONA } from "./prompts.mjs"
import { sessionState, engEffective, viewOfSessionState } from "./state.mjs"
import { validateDesignToken, EFFORT_LEVELS, tokenExpiryMs } from "./advisor.mjs"
import { parseTouchedFiles } from "./escalate.mjs"
import { loadTokenRecord } from "./token-store.mjs"
import { saveSessionState } from "./session-store.mjs"

const ENG_SECTION_NAME = "thincoder:engineering"
const ENG_SECTION_ORDER = 3500 // 外部插件有限值区间（3000–4000）

// —— F9 子代理资源（§3.10）：engCoderMaxTokens 缺省 65536；effort 枚举与 advisor 单一事实源（评审 #6）——
const ENG_CODER_MAX_TOKENS_DEFAULT = 65536
const ENG_CODER_EFFORT_LEVELS = new Set(EFFORT_LEVELS)

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

/**
 * eng enter/exit 翻转。返回结果文本。
 * F12（§2.3 写点表）：翻转后写盘（engineering tri-state 落盘——恢复显式值延续用户当时意图；
 * 停机期间改了 config 默认 → 恢复显式值胜出，tri-state 优先级已内建）。
 * @param opts { storPathOverride?: string } — F12 存储路径注入缝（测试用临时目录，
 *        缺省走 session-store 的 DSH_HOME 解析；cwdHint 取 agent.session.header.cwd）
 */
export function engineeringToggle(agent, configDefaultEngineering, action, opts) {
  const state = sessionState(agent.session.id)
  if (action === "enter") {
    state.engineering = true
    if (!state.engSection) {
      try { state.engSection = attachEngineeringSection(agent) } catch { state.engSection = null }
    }
    persistSessionState(agent, state, opts) // F12（§2.3）：翻转后写盘
    return "Engineering mode ON — you are now the architect: clarify requirements, write design docs in docs/, and WAIT for the user to initiate the design review (advisor type='design'). Implementation goes through eng_coder with a design token. Use eng(action='exit') to leave."
  }
  if (action === "exit") {
    state.engineering = false
    try { state.engSection?.() } catch { /* already disposed */ }
    state.engSection = null
    persistSessionState(agent, state, opts) // F12（§2.3）：翻转后写盘
    return "Engineering mode OFF — standard workflow restored."
  }
  return "Error: action must be 'enter' or 'exit'."
}

/**
 * F12（§2.3）写点 helper：语义转换点落盘。viewOfSessionState 组装白名单视图 →
 * saveSessionState（原子写 + 净化 + 孤儿清扫，内部 fail-safe：任何失败仅 warn 不抛——
 * 翻转/交付流程不依赖持久化成功，内存态兜底）。storPathOverride 优先取 opts（deps）注入缝。
 */
function persistSessionState(agent, state, opts) {
  try {
    saveSessionState(
      agent.session.id,
      viewOfSessionState(state),
      opts?.storPathOverride,
      agent.session?.header?.cwd,
    )
  } catch { /* N3 fail-safe：写盘故障不击穿工具流程（save 内部已 warn） */ }
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

// ————————————— F13 阶段化任务书（§3.1/§3.2/§3.3） —————————————

/** §3.1 漂移探测正则（verbatim）：stages 缺省但 task 匹配 → 前缀警告（N4 先例，不阻塞）。 */
const STAGE_DRIFT_RE = /stage|阶段\s*\d/i
/** §3.1/§8：阶段数上限（schema maxItems 10 拒 + description 引导 2–8 个可自查交付增量）。 */
export const STAGES_MAX = 10

/**
 * stages 渲染前防御校验（设计 §7 实施确认项 5：host tool schema 对嵌套数组 items 的
 * required/minLength/minItems 强制力未证实 → 代码级兜底；schema 层另有同款约束，双保险）。
 * 每项必须 { goal: 非空 string, files: ≥1 个非空 string[], acceptance: 非空 string,
 * check: 非空 string }——required + minLength 1（空串/空数组不通过，评审 #13：不存在
 * 「缺段渲染」歧义）；超 10 项拒。通过时返回净化副本（字段照抄、files 复制）。
 * @returns {{ok: true, stages: object[]}|{ok: false, error: string}}
 */
export function validateStages(stages) {
  if (!Array.isArray(stages)) {
    return { ok: false, error: "stages must be an array of { goal, files, acceptance, check } objects" }
  }
  if (stages.length === 0) {
    return { ok: false, error: "stages must contain at least one stage" }
  }
  if (stages.length > STAGES_MAX) {
    return { ok: false, error: "stages supports at most " + STAGES_MAX + " stages (got " + stages.length + ")" }
  }
  const norm = []
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i]
    const p = "stages[" + i + "]"
    if (!st || typeof st !== "object" || Array.isArray(st)) {
      return { ok: false, error: p + " must be an object with goal/files/acceptance/check" }
    }
    const clean = {}
    for (const f of ["goal", "acceptance", "check"]) {
      if (typeof st[f] !== "string" || st[f].trim() === "") {
        return { ok: false, error: p + "." + f + " must be a non-empty string" }
      }
      clean[f] = st[f]
    }
    if (!Array.isArray(st.files) || st.files.length === 0) {
      return { ok: false, error: p + ".files must be a non-empty array of file paths" }
    }
    const files = []
    for (const fp of st.files) {
      if (typeof fp !== "string" || fp.trim() === "") {
        return { ok: false, error: p + ".files entries must be non-empty strings" }
      }
      files.push(fp)
    }
    clean.files = files
    norm.push(clean)
  }
  return { ok: true, stages: norm }
}

/**
 * F13 Staged execution 块渲染（§3.1/§3.2/§3.3，stages 存在时插入 Docs 段之后）：
 * - 纪律段（§3.1）：按序执行；stage N 自查不过不得进入 N+1；阶段内只动本阶段 files
 *   （文档同步例外）；跨阶段文件需求 = STOP 上报；同一阶段第二次真修后仍失败 → STOP（§3.2：
 *   check 失败 ≠ 立即停——阶段内有限自修是自查的意义；硬停条件）；
 * - 预算将尽条款（§3.3-3）：意识到输出预算将尽 → 立即停止开启新阶段、跑完当前阶段 check、
 *   以 stage 表开头收尾；
 * - stage 状态表前置指令（§3.1）：| Stage | Status (passed/failed/skipped) | check summary |
 *   置于报告最前——F9 max-tokens 掐断事故的生存性设计：输出被掐也保住分类账；Touched files
 *   被掐丢可从表内 Files 列重建；
 * - 逐阶段四段（§3.1 统一编号）：### Stage N — goal / Files / Acceptance / Self-check。
 * 单次 spawn 跑完全部阶段（§3.2 有意设计——docs 只读一遍、上下文延续、失败报告天然定位；
 * 每阶段一 spawn 的被否方案有隐性耦合：每次 spawn 触发 advisorRound 清零 + touchedFiles
 * 合并（本模块交付后重置逻辑）——勿改 per-stage）。
 */
function renderStagesBlock(stages) {
  const lines = [
    "## Staged execution",
    "Execute the stages in order: stage N's self-check must pass before you enter stage N+1. Within a stage, touch only that stage's files (keeping the docs listed above in sync is the only exception). If a change outside the current stage's file list becomes necessary, STOP and report it.",
    "A failed self-check means fix-and-retry within the stage (re-run the check after fixing — the context is still warm). If a stage's check still fails after a second genuine fix attempt, STOP: never advance a failing stage.",
    "Budget survival clause: the moment you notice the output budget is nearly exhausted, stop opening new stages, finish the current stage's self-check, and close out with the stage status table at the top of your report.",
    "Your report MUST START with the stage status table (before any other content), one row per stage: | Stage | Status (passed/failed/skipped) | check summary |. If you stop on a failed stage, follow the table with the failure detail: the check command verbatim, its output tail, and your hypothesis. If the Touched files line gets cut off, the table's Files columns are the recovery source.",
    "",
  ]
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i]
    lines.push("### Stage " + (i + 1) + " — " + st.goal)
    lines.push("Files:")
    for (const f of st.files) lines.push("- " + f)
    lines.push("Acceptance:")
    lines.push(st.acceptance)
    lines.push("Self-check:")
    lines.push(st.check)
    lines.push("")
  }
  return lines
}

/**
 * eng_coder 任务书（对齐 thincoder：Docs involved + 文件清单 + 验收标准 + token 走参数）。
 * F13（§3.1）：第三个参数 stages（可选结构化阶段列表）——**stages 缺省时输出逐字节等于现行**
 * （T9 fixture 回归锁死：现行 brief 是三个历史交付共同依赖的契约，parseTouchedFiles 从尾部
 * 解析的尾行约定不动）；有 stages 时在 Docs 段后插入 renderStagesBlock（其余行零改动）。
 */
export function buildCoderBrief(task, docs, stages) {
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
  if (stages && stages.length > 0) {
    lines.push(...renderStagesBlock(stages))
  }
  lines.push(
    "Implement to the full design — no silent degradation. If a stated design element is missing from the docs above, note it in your report; do not invent.",
    "Do not modify any file not listed in the design.",
    "Do NOT run destructive git commands (rebase / reset --hard / clean -f / push --force) — the parent session owns git history operations.",
    "Do NOT ask the user questions (ask_user_question is disabled for you). If a user decision is needed, list it under 'Decisions needed from the parent session' in your report.",
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
 * @param deps { ctx, agent, config, signal, configDefaultEngineering, storPathOverride? }
 *              — storPathOverride = F10/F12 存储路径注入缝（测试用临时目录，非用户配置；
 *                缺省走 token-store/session-store 的 DSH_HOME 解析）
 * @param args { task, designToken, docs?, stages? } — stages 为 F13 结构化阶段列表
 */
export async function runEngCoder(deps, args) {
  const { ctx, agent, signal } = deps
  const config = (deps?.config && typeof deps.config === "object") ? deps.config : {}
  const state = sessionState(agent.session.id)
  const task = String(args?.task ?? "").trim()
  if (!task) return "Error: task is required."
  const docs = Array.isArray(args?.docs) ? args.docs.filter(d => typeof d === "string" && d.trim()) : []

  // 警告通道（F9 先例 + F13 复用）：console.warn + 随工具返回文本带出（主会话可见）。
  // 提前到 token 校验之前——F13 漂移警告要能附着在早期拒绝返回上。
  const warnings = []
  const warn = (m) => {
    console.warn("[thincoder-suite] " + m)
    warnings.push("[thincoder-suite] warning: " + m)
  }
  const warnPrefix = () => warnings.length > 0 ? warnings.join("\n") + "\n\n" : ""

  // F13（§3.1）：stages 结构化参数——渲染前防御校验（实施确认项 5：host schema 对嵌套 items
  // 的 required/minItems 强制力未证实，代码级兜底；schema 层另有同款约束，双保险）。
  let stages = null
  if (args?.stages !== undefined && args?.stages !== null) {
    const v = validateStages(args.stages)
    if (!v.ok) return "Error: invalid stages — " + v.error
    stages = v.stages
  }
  // F13 漂移探测（§3.1，verbatim /stage|阶段\s*\d/i）：stages 缺省但 task 文本疑似描述阶段
  // → 前缀警告（N4 先例：警告不阻塞执行，主代理可见后可改用 corrected stages 重派）。
  if (!stages && STAGE_DRIFT_RE.test(task)) {
    warn("task text mentions stages (stage/阶段 N) but no structured stages parameter was passed — pass stages=[{ goal, files, acceptance, check }] to get ordered stage self-checks in the brief")
  }

  // token 机械校验：与状态一致 + 签名/过期有效（不符即拒——spawn 时刻的授权门禁）。
  // R3 三态拒绝：never issued（本会话 state.designToken 为空）/ expired（token 第二段
  // expiresAt 已过，提示重跑评审铸新 token）/ mismatch（其余不一致，保持现行文案）。
  // 判序：先看会话有无签发记录，再看存量 token 是否过期（过期优先于不一致——即使回传
  // 正确 token 也已失效，唯一出路就是重跑评审）。
  const token = args?.designToken
  // F10（docs/2026-09-02 §2.1 读取时序）：内存态无 token（重启后）→ 查磁盘——本 sessionId
  // 有签发记录即回填 state.designToken，由下方既有三态校验统一裁决（有效 → 放行并维持回填；
  // 过期 → expired 提示；与回传 token 不一致 → mismatch 提示）。loadTokenRecord 内部 try/catch：
  // 文件缺失/损坏/不可读 → null（fail-safe，评审 #1），落入三态拒绝不崩溃。
  if (!state.designToken && token) {
    const rec = loadTokenRecord(agent.session.id, deps.storPathOverride, agent.session?.header?.cwd)
    // 回填收窄为「传入 token === 盘上记录 token」（分歧审计 D1）：错 token 不回填——
    // 避免有效盘 token 驻留 state 间接打开主代理写门禁；过期记录经 token 全等仍进三态 expired。
    if (rec && token === rec.token) {
      state.designToken = rec.token
    } else if (rec) {
      // 评审 #4：盘上有签发记录但传入 token 不匹配 → mismatch 文案（比 never-issued 信息更准）
      return warnPrefix() + "Error: invalid design token — it does not match the latest issued record for this session. Re-run the design review to mint a fresh token."
    }
  }
  if (!token || token !== state.designToken || !validateDesignToken(token)) {
    if (!state.designToken) {
      return warnPrefix() + "Error: no design token issued in this session — run advisor(type='design') first (the user initiates it)."
    }
    const expiresAt = tokenExpiryMs(state.designToken) // 评审 #5：与 advisor.mjs tokenExpiryMs 单一事实源
    if (expiresAt !== null && Date.now() > expiresAt) {
      return warnPrefix() + "Error: design token expired at " + new Date(expiresAt).toLocaleString() + " (TTL engTokenTtlMs) — re-run the design review to mint a fresh token."
    }
    return warnPrefix() + "Error: invalid or missing design token — eng_coder requires the token issued by a PASSED advisor(type='design') review. Run the design review first (the user initiates it), then pass its token verbatim."
  }
  if (!engEffective(state, deps.configDefaultEngineering)) {
    return warnPrefix() + "Error: engineering mode is OFF — eng_coder is the engineering-workflow implementer. Use eng(action='enter') first."
  }

  const agentOpts = agent.options ?? {}
  // F9：显式子代理资源——maxTokens 与 reasoningEffort 必须显式传（DSH resolveChildAgentOptions
  // 只在父级已配置时才继承 maxTokens，且不继承 effort；缺失会落适配器默认→reasoning 吞噬
  // 输出预算→text 被 max-tokens 掐断，实测见 docs/2026-09-01-advisor-config-design.md §3.10）。
  // N4 校验（§3.10、评审 #7）：engCoderMaxTokens 非法（非有限正数）→ 警告并回落默认 65536；
  // engCoderEffort 非枚举 → 警告并回落 "low"；警告 console.warn + 随工具返回文本带出（主会话可见）。
  const cfgMax = config.engCoderMaxTokens
  let engCoderMaxTokens
  if (cfgMax === undefined || cfgMax === null) {
    // §3.10 取值优先级：engCoderMaxTokens > 父代理 maxTokens（继承）> 默认 65536
    engCoderMaxTokens = Number.isFinite(agentOpts.maxTokens) && agentOpts.maxTokens > 0
      ? agentOpts.maxTokens
      : ENG_CODER_MAX_TOKENS_DEFAULT
  } else if (typeof cfgMax === "number" && Number.isFinite(cfgMax) && cfgMax > 0) {
    engCoderMaxTokens = cfgMax
  } else {
    // 评审 #5：非法配置值回落父级有效 maxTokens（保持 §3.10 优先级链），无父级才落默认
    warn("invalid engCoderMaxTokens " + JSON.stringify(cfgMax)
      + " (expected a finite positive number) — falling back to parent maxTokens or default " + ENG_CODER_MAX_TOKENS_DEFAULT)
    engCoderMaxTokens = Number.isFinite(agentOpts.maxTokens) && agentOpts.maxTokens > 0
      ? agentOpts.maxTokens
      : ENG_CODER_MAX_TOKENS_DEFAULT
  }
  let engCoderEffort = "low"
  const effCfg = config.engCoderEffort
  if (effCfg !== undefined && effCfg !== null) {
    // 评审 #4：任何非 undefined/null 的非法值（含非字符串类型）都警告
    if (typeof effCfg === "string" && ENG_CODER_EFFORT_LEVELS.has(effCfg)) {
      engCoderEffort = effCfg
    } else {
      warn("invalid engCoderEffort " + JSON.stringify(effCfg)
        + " (expected one of off|low|medium|high|max) — falling back to \"low\"")
    }
  }
  let run
  try {
    run = await ctx.subagents.start("spawn", {
      // F13：有 stages 时渲染 Staged execution 块（缺省 → 现行 brief，逐字节不变）
      prompt: [{ type: "text", text: buildCoderBrief(task, docs, stages) }],
      parent: agent,
      signal: signal ?? null,
      persona: ENG_CODER_PERSONA,
      label: "eng-coder",
      agentOptions: {
        provider: agentOpts.provider,
        model: agentOpts.model,
        maxTokens: engCoderMaxTokens,
        reasoningEffort: engCoderEffort,
      },
      // F9：实现者子代理不打断用户（确认 UI 按 agent 路由，主会话无感会死等）
      toolFilter: { deny: ["escalate", "consult_start", "consult_check", "consult_stop", "eng", "eng_coder", "ask_user_question"] },
    })
  } catch (e) {
    return warnPrefix() + "eng_coder failed to start: " + (e?.message ?? String(e))
  }

  let result
  try {
    result = await run.result
  } catch (e) {
    if (signal?.aborted || e?.name === "AbortError") return warnPrefix() + "eng_coder aborted."
    return warnPrefix() + "eng_coder error: " + (e?.message ?? String(e))
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
  // F12（§2.3 写点表）：交付后写盘（mutatedThisRun/touchedFiles 并入 + advisorRound 重置/清
  // prior——同一视图落盘；touchedFiles 去重封顶 200 由 session-store 净化链兜底）。失败仅 warn
  // （N3：丢=回内存行为，重启后恢复上一写点状态）。
  persistSessionState(agent, state, deps)

  const stopReason = result?.stopReason ?? "unknown"
  if (stopReason !== "completed") {
    const diag = result?.diagnostic ? " — " + result.diagnostic : ""
    return warnPrefix() + "eng_coder ended: " + stopReason + diag + "\nPartial output:\n" + outputText.slice(0, 2000)
  }
  return warnPrefix() + "eng_coder delivery:\n" + (outputText || "(empty report)") +
    "\n\nNext (automatic flow nodes): verify the delivery against the acceptance criteria, run the divergence audit if this is the FIRST delivery, then run advisor(type='code', documents=[Docs involved])."
}
