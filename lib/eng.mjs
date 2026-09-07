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
// R3 §5.4 补丁轮（D-06 同步路径单飞扩展）：机制入口（授权门禁之后、任何 spawn/
// runCodexTask 之前）checkInFlightJob——同会话 eng_coder 在飞（>cap job 或任何已占位
// 形态）期间任何新调用（codex ≤cap 同步/dsh 子代理路径）被拒；jobs 派发点二次检查保留。
// R5 §7.2（D-27）：dsh 子代理路径加 background 可选参数（默认 false）——background=true →
// 派后台 job〔kind eng-dsh，免平台墙钟：run() 闭包内 ctx.subagents.start + await run.result、
// dshBackgroundTimeoutMs 兜底 deadline abort + 超时信封 partial 保留、cancel → 子代理 abort〕；
// background=false/缺省 = 现状同步快路径（DP-1 方案 A budgetCap 内部截止 + 响亮告警，
// R2 §4.2）。codex 后端（engCoderRunner=codex-cli）同接受 background（强制后台派发）。
import { ENGINEERING, ENG_CODER_PERSONA } from "./prompts.mjs"
import { sessionState, engEffective } from "./state.mjs"
import { validateDesignToken, EFFORT_LEVELS, tokenExpiryMs, resolveCodexBudgetCapMs, getJobsService, jobsDispatchReply, codexJobsDispatchReply, checkInFlightJob, setInFlightJob, clearInFlightJob, bumpAdvisorGeneration, sessionStateViewWithGeneration, resolveDshBackgroundTimeoutMs } from "./advisor.mjs"
import { parseTouchedFiles, codexFailureAdvisory } from "./escalate.mjs"
import { loadTokenRecord } from "./token-store.mjs"
import { saveSessionState } from "./session-store.mjs"
import { runCodexTask, resolveCodexCliGlobals, CODEX_TASK_PREAMBLE } from "./codex-adapter.mjs"
import { resolveSupportedEffort, resolveCodexRowEffort } from "./effort-resolve.mjs"

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
export function engineeringToggle(agent, action, opts) {
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
      sessionStateViewWithGeneration(state), // R2 §4.4（D-10）：generation 随 F12 视图持久化
      opts?.storPathOverride,
      agent.session?.header?.cwd,
    )
  } catch { /* N3 fail-safe：写盘故障不击穿工具流程（save 内部已 warn） */ }
}

/**
 * D-20 交付簿记（codex/dsh × 同步/后台 四路共用单一实现——D-26-⑥ 单一事实源纪律）：
 * 仅成功分支调用恰好一次。子交付 → 重置 advisor 预算（交付 code review 必然发生）：
 * advisorRound=0 + lastAdvisorOutput=null；R2 §4.4（D-10）：eng 交付重置 = 语义转换点，
 * advisorGeneration +1（晚到的在飞 advisor 结果经 finalize 代际校验丢弃，不复活已重置的
 * 轮次/prior）；touched 合并 + mutatedThisRun 置位；F12（§2.3 写点表）：交付后写盘（同一
 * 视图落盘；touchedFiles 去重封顶 200 由 session-store 净化链兜底）。失败仅 warn（N3：
 * 丢=回内存行为，重启后恢复上一写点状态）。
 */
function deliverBookkeeping(state, agent, deps, outputText) {
  state.advisorRound = 0
  state.lastAdvisorOutput = null
  bumpAdvisorGeneration(state)
  const touched = parseTouchedFiles(outputText)
  if (touched.length > 0) {
    const merged = new Set([...(state.touchedFiles ?? []), ...touched])
    state.touchedFiles = [...merged]
  }
  state.mutatedThisRun = true
  persistSessionState(agent, state, deps)
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
 * @param args { task, designToken, docs?, stages?, background? } — background 为 dsh 子代理后台执行开关
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
  if (!state.designToken) {
    const rec = loadTokenRecord(agent.session.id, deps.storPathOverride, agent.session?.header?.cwd)
    // 回填收窄为「传入 token === 盘上记录 token」（分歧审计 D1）：错 token 不回填——
    // 避免有效盘 token 驻留 state 间接打开主代理写门禁；过期记录经 token 全等仍进三态 expired。
    if (rec && token && token === rec.token) {
      state.designToken = rec.token
    } else if (rec && token) {
      // 评审 #4：盘上有签发记录但传入 token 不匹配 → mismatch 文案（比 never-issued 信息更准）
      return warnPrefix() + "Error: invalid design token — it does not match the latest issued record for this session. Re-run the design review to mint a fresh token."
    } else if (rec && !token) {
      return warnPrefix() + "Error: design token was issued in this session but was not provided this time（本会话已签发但本次未传 token）— pass the designToken from the PASSED advisor(type='design') review."
    }
  }
  if (!token || token !== state.designToken || !validateDesignToken(token)) {
    if (!state.designToken) {
      return warnPrefix() + "Error: no design token issued in this session（从未签发）— run advisor(type='design') first (the user initiates it)."
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

  // R3 §5.4（D-06 同步路径单飞扩展，补丁轮）：single-flight 检查提前到 eng 机制全部入口
  //（codex ≤cap 同步 / dsh 子代理路径）——同会话 eng_coder 后台 job 在飞（>cap job 或任何
  // 已占位形态）期间任何新调用被拒（R2 同款拒绝文本，含在飞 job id 与接续指引），关闭
  // 轮次/prior 双写窗口。派发点二次检查保留（下方 codex jobs 分支）：入口 → jobs.start
  // 之间的 await 窗口（effort 解析等）内仍可能被他方派发占位。
  const inFlightAtEntry = checkInFlightJob(agent.session.id, "eng")
  if (inFlightAtEntry) return warnPrefix() + inFlightAtEntry

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
  // —— T2.2：codex runner 后端（codexCli.engCoderRunner === "codex-cli"）——
  // 8.4 三边界落地：① 写权限治理后移（codex 沙箱 workspace-write 限定写入范围 + 反套娃
  // 前缀 + 交付评审照常 + Touched files 对账——DSH 写门禁管不到子进程内部）；② idle 活性
  // 信号替代纯墙钟（长实现任务不误杀）；③ 验证证据 = 任务书强制验证命令/结果 + 报告留档。
  // F9 maxTokens 不适用（codex 自管预算）；effort 复用 engCoderEffort（off → 不传）。
  // D-02 L1（R1）：codex 分支 effort 走 resolveCodexRowEffort（codex models catalog）；
  // 下方 resolveSupportedEffort（dsh 侧，按父代理路由模型）只在 dsh 分支执行——
  // 消除「codex 分支跑 dsh 解析产生误导告警」的旧缺陷（登记表 D-02：eng:385/:399）。
  // R2 §4.1（D-03/D-20）：预算 > budgetCap 且 ctx.jobs 可用 → jobs 后台派发（owner 绑定
  // agent、cancel 走 ctrl.abort、run() 内全预算 + 自有 watchdog）；≤ cap 或 jobs 缺失 →
  // 同步钳制 + 响亮告警。交付簿记（轮次重置/mutatedThisRun/touched 合并 + F12 落盘）在
  // 任务完成回调的成功分支恰好一次（D-20：失败交付不销毁评审预算、不断言可能不存在的
  // 变更——partial 内 Touched 行仅 advisory 解析，D-11）。
  const cliCfg = (config.codexCli && typeof config.codexCli === "object") ? config.codexCli : {}
  if (cliCfg.engCoderRunner === "codex-cli") {
    const globalRes = resolveCodexCliGlobals(config)
    for (const warning of globalRes.warnings ?? []) warn(warning)
    const globals = globalRes.globals
    const runner = {
      kind: "codex-cli",
      model: (typeof cliCfg.model === "string" && cliCfg.model.trim() !== "") ? cliCfg.model.trim() : null,
    }
    const effRes = await resolveCodexRowEffort(deps, runner, engCoderEffort, globals)
    if (effRes.note) warn(effRes.note)
    const effRunner = { ...runner, effort: effRes.effort ?? undefined }
    const brief = CODEX_TASK_PREAMBLE + "\n\n" + buildCoderBrief(task, docs, stages)
    const cwd = agent.session?.header?.cwd || process.cwd()
    const budgetCap = resolveCodexBudgetCapMs(config)
    // 8.4：长任务默认放大 30min（值域校验对齐 adapter 常量——手编 config 垃圾值不进毫秒级误杀）
    const validBaseTimeout = Number.isInteger(cliCfg.defaultTimeoutMs) && cliCfg.defaultTimeoutMs >= 30000 && cliCfg.defaultTimeoutMs <= 3600000
    if (!validBaseTimeout && cliCfg.defaultTimeoutMs !== undefined && cliCfg.defaultTimeoutMs !== null) warn("codexCli.defaultTimeoutMs 非法，回落 1800000ms")
    const baseTimeout = validBaseTimeout ? cliCfg.defaultTimeoutMs : 1800000
    const validIdleTimeout = Number.isInteger(cliCfg.idleTimeoutMs) && cliCfg.idleTimeoutMs >= 15000 && cliCfg.idleTimeoutMs <= 3600000
    if (!validIdleTimeout && cliCfg.idleTimeoutMs !== undefined && cliCfg.idleTimeoutMs !== null) warn("codexCli.idleTimeoutMs 非法，回落 300000ms")
    const idleTimeoutMs = validIdleTimeout ? cliCfg.idleTimeoutMs : 300000

    // —— D-20 交付簿记 = 模块级 deliverBookkeeping（codex/dsh、同步/后台四路单一实现——
    // 成功分支恰好一次；R5 §7.2 抬到模块作用域，D-26-⑥ 单一事实源）。文本构建局部闭包：
    const deliveryText = (outputText) => warnPrefix() + "eng_coder delivery (codex-cli):\n" + (outputText || "(empty report)") +
      "\n\nNext (automatic flow nodes): verify the delivery against the acceptance criteria, run the divergence audit if this is the FIRST delivery, then run advisor(type='code', documents=[Docs involved])."
    const failureText = (env) => {
      const partial = env.text ? "\nPartial output:\n" + env.text.slice(0, 2000) : ""
      return warnPrefix() + "eng_coder ended: codex-cli " + env.code + " — " + (env.userMessage || env.diagnostics || "unknown")
        + partial + codexFailureAdvisory(env)
    }

    // 预算 > budgetCap 或显式 background=true（R5 §7.2：长任务强制后台，无视预算）→ 派发
    if (baseTimeout > budgetCap || args?.background === true) {
      const jobs = getJobsService(deps)
      if (jobs && typeof jobs.start === "function") {
        // D-06（§4.3）：single-flight 派发前检查（复合键 sessionId+mechanism——eng 槽位）
        const sid = agent.session.id
        const inFlight = checkInFlightJob(sid, "eng")
        if (inFlight) return inFlight
        const ctrl = new AbortController()
        try {
          const started = jobs.start({
            kind: "eng-codex",
            label: "eng_coder codex (" + (runner.model ?? "default") + ", " + Math.round(baseTimeout / 1000) + "s)",
            outputLimitBytes: 131072,
            owner: agent,
            run: () => {
              const done = runCodexTask(deps, {
                taskText: brief,
                cwd,
                sandbox: "workspace-write", // B5：eng_coder 固定写沙箱（不透传更宽配置）
                timeoutMs: baseTimeout, // jobs 免疫平台墙钟：全预算生效（run() 内自有 watchdog）
                idleTimeoutMs,
                runner: effRunner,
                config,
                signal: ctrl.signal, // cancel → hooks.cancel → ctrl.abort
              }).then((env) => {
                clearInFlightJob(sid, "eng")
                if (env.ok) {
                  deliverBookkeeping(state, agent, deps, env.text)
                  return { status: "completed", detail: "eng_coder delivery", output: deliveryText(env.text) }
                }
                return { status: "failed", detail: "codex-cli " + env.code, output: failureText(env) }
              }, (e) => {
                clearInFlightJob(sid, "eng")
                return {
                  status: "failed",
                  detail: String(e?.message ?? e),
                  output: warnPrefix() + "eng_coder error: " + (e?.message ?? String(e)),
                }
              })
              done.catch(() => { /* 观察者兜底：reject 已转为 outcome */ })
              return { cancel: (reason) => { try { ctrl.abort(reason) } catch { /* noop */ } }, done }
            },
          })
          // D-06：登记槽位（settle 时经 done 回调清除）；D-05：branded string 直接渲染；
          // D-16：budgetCapMs ≥ 600000 时附不变式提醒（共享 codexJobsDispatchReply）。
          // R6 code review 跟进：N4 配置警告（warnPrefix()）并入派发返回——advisor.mjs R4 收尾
          // #4 先例（后台派发时配置告警即时可见，此前只在 job 完成文本可见；空串时行为不变）。
          setInFlightJob(sid, "eng", started)
          return warnPrefix() + codexJobsDispatchReply({ prefix: "eng_coder (codex-cli)", jobId: started, budgetMs: baseTimeout, budgetCapMs: budgetCap, detail: runner.model ?? "codex 默认模型" })
        } catch (e) {
          console.warn("[thincoder-suite] ctx.jobs 派发失败（" + (e?.message ?? String(e)) + "）——eng_coder 回落同步执行"
            + (baseTimeout > budgetCap ? "（预算按 budgetCap 截断）" : ""))
        }
      } else {
        // jobs 缺失降级（响亮告警——绝不无声）；background=true 且预算 ≤cap 时不截断（预算本就合规）
        console.warn("[thincoder-suite] ctx.jobs 不可用——eng_coder codex "
          + (args?.background === true && baseTimeout <= budgetCap
            ? "background=true 请求后台但 jobs 缺失——回落同步执行（预算 " + baseTimeout + "ms 未超 budgetCap，不截断）"
            : "预算 " + baseTimeout + "ms 截为 " + budgetCap + "ms 同步执行")
          + "（建议装配 dsh-jobs-local + dsh-tool-jobs 走后台全预算派发）")
      }
    }

    // —— ≤ budgetCap 或 jobs 缺失/派发失败：同步执行（> cap 时钳制 + 尾部告警，绝不无声）——
    const effTimeout = Math.min(baseTimeout, budgetCap)
    const capNote = baseTimeout > budgetCap
      ? "\n[thincoder-suite] warning: eng_coder codex 预算 " + baseTimeout + "ms 超过 codexCli.budgetCapMs=" + budgetCap
        + "ms——已截断同步执行（平台 run_code 墙钟内；装配 dsh-jobs 可走后台全预算派发）"
      : ""
    try {
      const env = await runCodexTask(deps, {
        taskText: brief,
        cwd,
        sandbox: "workspace-write", // B5：eng_coder 固定写沙箱（不透传更宽配置）
        timeoutMs: effTimeout,
        idleTimeoutMs,
        runner: effRunner,
        config,
        signal,
      })
      if (env.ok) {
        deliverBookkeeping(state, agent, deps, env.text)
        return deliveryText(env.text) + capNote
      }
      // D-20：失败交付不簿记（不重置轮次/不置 mutated/不并 touched）
      return failureText(env) + capNote
    } catch (e) {
      if (signal?.aborted) return warnPrefix() + "eng_coder aborted." + capNote
      return warnPrefix() + "eng_coder error: " + (e?.message ?? String(e)) + capNote
    }
  }

  // —— F9-2（D-02 L1）：dsh 分支 effort 按父代理路由模型校验/回落（共享 helper
  // effort-resolve.mjs；"low" 对 glm-5.3-flash 会 UNSUPPORTED_REASONING_EFFORT 秒死——
  // 2026-09-04 eng_coder 三连败根因）。只在 dsh 分支执行（codex 分支已走 codex resolver）。 —————————————
  const effResolved = await resolveSupportedEffort(deps.ctx?.llm ?? null, agentOpts.provider, agentOpts.model, engCoderEffort)
  const engCoderEffortFinal = effResolved.effort
  if (effResolved.note) warn(effResolved.note)

  // DP-1 方案 A（R2 §4.2，已终裁）：dsh 子代理路径内部截止——await run.result 此前无界
  // 等待（600s 平台墙钟下超限被静默截断且无交付报告）。到点 abort + 响亮告警；如需长
  // 任务请走 codex runner（engCoderRunner=codex-cli + jobs 后台派发）或拆分 stages。
  const budgetCap = resolveCodexBudgetCapMs(config)
  if (args?.background === true) {
    const jobs = getJobsService(deps)
    if (jobs && typeof jobs.start === "function") {
      const sid = agent.session.id
      const inFlight = checkInFlightJob(sid, "eng")
      if (inFlight) return inFlight
      const ctrl = new AbortController()
      const backstopMs = resolveDshBackgroundTimeoutMs(config)
      let settled = false
      let slotReady = false
      const settle = () => { settled = true; if (slotReady) clearInFlightJob(sid, "eng") }
      try {
        const started = jobs.start({
          kind: "eng-dsh",
          label: "eng_coder dsh (background)",
          outputLimitBytes: 131072,
          owner: agent,
          run: () => {
            let timer = null
            let timedOut = false
            if (Number.isFinite(backstopMs) && backstopMs > 0) {
              timer = setTimeout(() => {
                timedOut = true
                console.warn("[thincoder-suite] eng_coder dsh 后台子代理超兜底截止（dshBackgroundTimeoutMs=" + backstopMs + ")——abort 子代理")
                try { ctrl.abort(new Error("eng dsh background backstop deadline reached")) } catch { /* noop */ }
              }, backstopMs)
              timer.unref?.()
            }
            const done = (async () => {
              let sub
              try {
                if (!ctx?.subagents || typeof ctx.subagents.start !== "function") {
                  return { status: "failed", detail: "ctx.subagents unavailable", output: warnPrefix() + "eng_coder failed: ctx.subagents is unavailable inside background job (cannot recover after dispatch)" }
                }
                sub = await ctx.subagents.start("spawn", {
                  prompt: [{ type: "text", text: buildCoderBrief(task, docs, stages) }], parent: agent, signal: ctrl.signal,
                  persona: ENG_CODER_PERSONA, label: "eng-coder",
                  agentOptions: { provider: agentOpts.provider, model: agentOpts.model, maxTokens: engCoderMaxTokens,
                    ...(engCoderEffortFinal !== null ? { reasoningEffort: engCoderEffortFinal } : {}) },
                  toolFilter: { deny: ["escalate", "consult_start", "consult_check", "consult_stop", "eng", "eng_coder", "ask_user_question"] },
                })
                const result = await sub.result
                const outputText = (result?.output ?? []).filter(b => b?.type === "text").map(b => b.text ?? "").join("\n").trim()
                if (timedOut) return { status: "failed", detail: "dshBackgroundTimeoutMs backstop", output: warnPrefix() + "eng_coder ended: dsh 后台子代理超兜底截止（dshBackgroundTimeoutMs=" + backstopMs + ")到点，子代理已 abort—— Partial output:\n" + outputText.slice(0, 2000) + codexFailureAdvisory({ text: outputText, code: "ABORTED" }) }
                const stopReason = result?.stopReason ?? "unknown"
                if (stopReason !== "completed") return { status: "failed", detail: stopReason, output: warnPrefix() + "eng_coder ended: " + stopReason + "\nPartial output:\n" + outputText.slice(0, 2000) + codexFailureAdvisory({ text: outputText, code: null }) }
                deliverBookkeeping(state, agent, deps, outputText)
                return { status: "completed", detail: "eng_coder delivery", output: warnPrefix() + "eng_coder delivery:\n" + (outputText || "(empty report)") + "\n\nNext (automatic flow nodes): verify the delivery against the acceptance criteria, run the divergence audit if this is the FIRST delivery, then run advisor(type='code', documents=[Docs involved])." }
              } catch (e) {
                // R6 code review 跟进：reject-race 分支（sub.result 以 reject 结束 → await 抛出落
                // catch，而非 resolve 落上方 if(timedOut) 兜底信封）同带 ABORTED 回滚指引——与
                // resolve-race 分支和 escalate timeoutEnvelope("") 先例对称；catch 作用域无
                // outputText → 空串形态（escalate.mjs 同款）。
                if (timedOut) return { status: "failed", detail: "dshBackgroundTimeoutMs backstop", output: warnPrefix() + "eng_coder ended: dsh 后台子代理超兜底截止（dshBackgroundTimeoutMs=" + backstopMs + ")到点，子代理已 abort—— ABORTED" + codexFailureAdvisory({ text: "", code: "ABORTED" }) }
                if (ctrl.signal.aborted || e?.name === "AbortError") return { status: "failed", detail: "aborted", output: warnPrefix() + "eng_coder aborted." }
                return { status: "failed", detail: String(e?.message ?? e), output: warnPrefix() + "eng_coder failed: " + (e?.message ?? String(e)) }
              } finally {
                if (timer) clearTimeout(timer)
                settle()
                try { if (sub) await sub.dispose() } catch { /* noop */ }
              }
            })()
            done.catch(() => {})
            return { cancel: (reason) => { try { ctrl.abort(reason) } catch { /* noop */ } }, done }
          },
        })
        setInFlightJob(sid, "eng", started)
        slotReady = true
        if (settled) clearInFlightJob(sid, "eng")
        return jobsDispatchReply({ prefix: "eng_coder", jobId: started, budgetMs: backstopMs, detail: "dsh 子代理后台执行（挂死兜底 dshBackgroundTimeoutMs）" })
      } catch (e) {
        console.warn("[thincoder-suite] ctx.jobs 派发失败（" + (e?.message ?? String(e)) + "）——eng_coder background=true 回落同步执行（budgetCap 内部截止）")
      }
    } else {
      console.warn("[thincoder-suite] ctx.jobs 不可用——eng_coder background=true 回落同步执行（budgetCap 内部截止）")
    }
  }
  const dshCtrl = new AbortController()
  let dshTimedOut = false
  const dshTimer = setTimeout(() => {
    dshTimedOut = true
    console.warn("[thincoder-suite] eng_coder dsh 子代理路径超内部截止（budgetCapMs=" + budgetCap
      + "）——abort 子代理（dsh 路径受平台墙钟约束；如需长任务请走 codex runner 或拆分 stages）")
    try { dshCtrl.abort(new Error("eng_coder dsh subagent deadline reached")) } catch { /* already aborted */ }
  }, budgetCap)
  dshTimer.unref?.()
  const forwardSignal = () => { try { dshCtrl.abort() } catch { /* already aborted */ } }
  if (signal) {
    if (signal.aborted) forwardSignal()
    else signal.addEventListener("abort", forwardSignal, { once: true })
  }

  let run
  try {
    run = await ctx.subagents.start("spawn", {
      // F13：有 stages 时渲染 Staged execution 块（缺省 → 现行 brief，逐字节不变）
      prompt: [{ type: "text", text: buildCoderBrief(task, docs, stages) }],
      parent: agent,
      signal: dshCtrl.signal, // 截止 + 父级 abort 二合一（父 signal 经 forwardSignal 汇入）
      persona: ENG_CODER_PERSONA,
      label: "eng-coder",
      agentOptions: {
        provider: agentOpts.provider,
        model: agentOpts.model,
        maxTokens: engCoderMaxTokens,
        // F9-2：engCoderEffortFinal=null 表示模型不支持该档——不传（用提供方默认）
        ...(engCoderEffortFinal !== null ? { reasoningEffort: engCoderEffortFinal } : {}),
      },
      // F9：实现者子代理不打断用户（确认 UI 按 agent 路由，主会话无感会死等）
      toolFilter: { deny: ["escalate", "consult_start", "consult_check", "consult_stop", "eng", "eng_coder", "ask_user_question"] },
    })
  } catch (e) {
    clearTimeout(dshTimer)
    return warnPrefix() + "eng_coder failed to start: " + (e?.message ?? String(e))
  }

  let result
  try {
    result = await run.result
  } catch (e) {
    if (dshTimedOut) {
      return warnPrefix() + "eng_coder ended: dsh 子代理路径超内部截止（budgetCapMs=" + budgetCap
        + "）到点，子代理已 abort—— dsh 子代理路径受平台墙钟约束，超限任务被终止；如需长任务请走 codex runner 或拆分 stages。"
    }
    if (signal?.aborted || e?.name === "AbortError") return warnPrefix() + "eng_coder aborted."
    return warnPrefix() + "eng_coder error: " + (e?.message ?? String(e))
  } finally {
    clearTimeout(dshTimer)
    try { await run.dispose() } catch { /* already disposed */ }
  }

  const outputText = (result?.output ?? [])
    .filter(b => b?.type === "text").map(b => b.text ?? "").join("\n").trim()
  const stopReason = result?.stopReason ?? "unknown"

  if (dshTimedOut) {
    // D-20：截止 abort = 失败交付——不簿记（不重置轮次/不置 mutated/不并 touched）
    return warnPrefix() + "eng_coder ended: dsh 子代理路径超内部截止（budgetCapMs=" + budgetCap
      + "）到点，子代理已 abort—— dsh 子代理路径受平台墙钟约束，超限任务被终止；如需长任务请走 codex runner 或拆分 stages。"
      + "\nPartial output:\n" + outputText.slice(0, 2000) + codexFailureAdvisory({ text: outputText, code: null })
  }

  if (stopReason !== "completed") {
    // D-20（R2 §4.1）：失败交付不簿记（不重置轮次/不置 mutated/不并 touched——与 codex 路径
    // 同语义）；partial 内 Touched 行仅 advisory 解析（不并入审计范围）
    const diag = result?.diagnostic ? " — " + result.diagnostic : ""
    return warnPrefix() + "eng_coder ended: " + stopReason + diag
      + "\nPartial output:\n" + outputText.slice(0, 2000) + codexFailureAdvisory({ text: outputText, code: null })
  }

  deliverBookkeeping(state, agent, deps, outputText)

  return warnPrefix() + "eng_coder delivery:\n" + (outputText || "(empty report)") +
    "\n\nNext (automatic flow nodes): verify the delivery against the acceptance criteria, run the divergence audit if this is the FIRST delivery, then run advisor(type='code', documents=[Docs involved])."
}
