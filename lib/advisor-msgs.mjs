// advisor-msgs.mjs — advisor 消息构建 + 历史提取 + 引用机械校验 + 未修复项提取。
// 移植自 thincoder：advisor/messages.mjs + convergence.mjs + history.mjs + citations.mjs
// + run.mjs 的 extractUnfixedIssues，按 DESIGN-dsh-port.md §4.1 合并为单模块。
// 差异（诚实标注）：Project Guide 预算取固定 16K（DSH 侧无模型 spec 表，无法按窗口 5% 缩放）。
// design token 协议 v2（DESIGN-advisor-token-protocol-fix.md）：Approval Signal 改为展示
// 8 位批准码 [APPROVE:<8hex>]（不再展示 token 本体），并随每个 design 评审轮（round 1
// 与收敛轮）携带；批准码派生 designApprovalCode 反向 import 自 advisor.mjs——环状依赖
// 有意且安全（双方仅在函数体内使用对方绑定，见该函数注释）。
import { readFileSync, existsSync, realpathSync } from "node:fs"
import { resolve, join, dirname, sep, relative } from "node:path"
import { ADVISOR_ROUND1, ADVISOR_ROUND2, ADVISOR_ROUND3, ADVISOR_DESIGN } from "./prompts.mjs"
import { designApprovalCode } from "./advisor.mjs"

const PROJECT_GUIDE_BUDGET = 16384 // AGENTS.md 注入预算（固定值，DSH 无 specForModel）
// 批 7（D-P8/J12）：项目标准文档与文档地图的注入预算——对齐 PROJECT_GUIDE_BUDGET 先例。
// 今日旧的标准段注入**无预算**（判据被悄悄截断 = 评审按半份标准放行），本批补齐。
const STANDARDS_BUDGET = 16384
const DOC_MAP_BUDGET = 16384
const AGENT_RESPONSE_HEADER = "| # | Action | Detail |"
const MAX_UNFIXED_DISPLAY = 10
const MAX_KEY_FILES_IN_COMPACTION = 5

const DEFAULT_CRITERIA = [
  "Review the code changes, focusing on:",
  "1. Correctness: logic errors, edge cases, off-by-one, incomplete modifications",
  "2. Security: unhandled exceptions, null references, resource leaks, race conditions",
  "3. Consistency: alignment with existing project patterns and conventions",
  "4. Completeness: missing callers, imports, or follow-up changes",
  "5. Maintainability: vague naming, missing comments, overly complex logic",
].join("\n")

// ————————————— 历史提取（输入为 DSH Message[]） —————————————

/** 取消息文本（拼接 text 块）。 */
function messageText(m) {
  if (!Array.isArray(m?.content)) return typeof m?.content === "string" ? m.content : ""
  return m.content.filter(b => b?.type === "text").map(b => b.text ?? "").join("\n")
}

/** 向后扫最近一条含响应表（| # | Action | Detail |）的 assistant 消息全文。 */
export function extractAgentResponseTable(messages) {
  const entries = Array.isArray(messages) ? messages : []
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i]
    if (m?.role !== "assistant") continue
    const text = messageText(m)
    if (text.includes(AGENT_RESPONSE_HEADER)) return text
  }
  return null
}

/** 最近 user↔assistant 交流（背景意图；最多 maxTurns 轮，每条 400 字符）。 */
export function extractConversationBackground(messages, maxTurns = 3) {
  const entries = Array.isArray(messages) ? messages : []
  const lines = []
  let turns = 0
  for (let i = entries.length - 1; i >= 0 && turns < maxTurns; i--) {
    const m = entries[i]
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue
    const text = messageText(m)
    if (!text) continue
    if (text.startsWith("[System reminder:") || text.startsWith("[System mode:")) continue
    lines.unshift((m.role === "user" ? "User: " : "Assistant: ") + text.slice(0, 400))
    if (m.role === "user") turns++
  }
  return lines.length > 0 ? lines.join("\n\n") : null
}

// ————————————— Project Guide（AGENTS.md） —————————————

/**
 * 项目根发现（对齐 thincoder messages.mjs）：从每个 scope 文件的目录向上走到 cwd
 * 边界，最近的 AGENTS.md 胜（monorepo 里子项目指南优先）；没有则 cwd 自身。
 */
function findProjectRoot(cwd, scopeFiles) {
  const norm = p => String(p).replaceAll("\\", "/")
  const isInside = dir => {
    const d = norm(dir), c = norm(resolve(cwd))
    return d === c || d.startsWith(c + "/")
  }
  for (const f of scopeFiles ?? []) {
    let dir = dirname(resolve(cwd, f))
    while (isInside(dir) && dir !== dirname(dir)) {
      if (existsSync(join(dir, "AGENTS.md"))) return dir
      dir = dirname(dir)
    }
  }
  if (existsSync(join(resolve(cwd), "AGENTS.md"))) return resolve(cwd)
  return null
}

function injectProjectGuide(cwd, parts, scopeFiles) {
  parts.push("## Project Guide (AGENTS.md)")
  const root = findProjectRoot(cwd, scopeFiles)
  const path = root ? join(root, "AGENTS.md") : null
  let text = null
  if (path) {
    try { text = readFileSync(path, "utf8") } catch { text = null }
  }
  if (!text) {
    parts.push("(No AGENTS.md found — neither at the working directory root nor in any review-scope subdirectory. Judge the user's requirements from the conversation background, and say so explicitly if the requirements are unclear.)")
    parts.push("")
    return null
  }
  const shown = text.length <= PROJECT_GUIDE_BUDGET
    ? text
    : [...text].slice(0, PROJECT_GUIDE_BUDGET).join("") + "\n\n…(truncated at " + PROJECT_GUIDE_BUDGET + " chars — read the full file if you need more)"
  parts.push("This file defines the project's structure and where its requirements/design documents live. Read the documents it points to — the user's requirements live THERE, not only in the conversation background.")
  parts.push("")
  parts.push(shown)
  parts.push("")
  return root
}

// ————————————— 收敛轮消息（round 2+） —————————————

function buildConvergenceInstructions(round, scopeFiles) {
  const fileList = scopeFiles?.length
    ? " The review surface is: " + scopeFiles.slice(0, 10).join(", ") + "."
    : ""
  return [
    "1. IMPORTANT: verify EVERY item of the prior review output against the CURRENT FILE STATE with read — never decide based on earlier snapshots alone." + fileList,
    "2. STALE-CONTEXT WARNING: any diff or file content from earlier messages is a historical snapshot — treat it as expired. Only fresh read results describe the current state.",
    "3. You have no git tool; git output in earlier messages is historical and untrustworthy (committed fixes never show in a diff).",
    "4. read the files named in the prior review output (or the review surface above) in full — ALWAYS. Batch reads/greps in a single reply.",
    "5. Evidence rule: every 'Unfixed'/'New' finding MUST quote the exact line content from THIS round's read output (e.g. run.mjs:180: timeoutId = setTimeout(...)). Line numbers alone are NOT evidence — they may be stale or fabricated. Findings without a fresh quoted line are treated as unverified and will not be accepted.",
    "6. Produce your verification table. Do not re-read content you already have.",
    round === 2
      ? "7. You may flag obvious NEW issues introduced by the fixes (crashes, data loss, logic errors — not style)."
      : "7. Do NOT look for new issues.",
  ]
}

export function buildConvergenceBody(p, response, round, scopeFiles, designToken) {
  const label = round === 2 ? "Verify Prior Table + Flag New Issues" : "Strict Verification"
  const reminder = round === 2
    ? "verify every item in the prior review output and flag only obvious new issues introduced by the fixes"
    : "strictly verify only the prior review output — do NOT look for new issues"
  const parts = [
    "## Round " + round + " — " + label,
    "",
    "[System reminder: this is round " + round + " of the convergence protocol. The system prompt for this round has already narrowed the review scope — follow it: " + reminder + ".]",
    "",
    "## Prior Review Output (verify every item it raises)",
    p,
    "",
    "## Agent Response (fix claims — reference only)",
    response,
    "",
    "## Instructions",
    ...buildConvergenceInstructions(round, scopeFiles),
    "",
  ]
  // R1：审批信号随每个 design 评审轮携带——收敛轮同样有效（round 1 与收敛轮共享同一
  // 签发路径，消除「收敛轮物理上无法签发 token」的结构性死路）。design 收敛轮的 system
  // prompt（round2/3）不含审批规则，本段自足。批准码每会话恒定（同 round 1 展示的 code）。
  if (designToken) {
    parts.push(
      "## Approval Signal",
      "This approval signal is EQUALLY VALID in this round (round " + round + " of the same design review): if — and ONLY if — your verification finds NO unresolved 🔴 (Critical) issues, state that the design is approved, then end your reply with this exact approval code: [APPROVE:" + designApprovalCode(designToken) + "]",
      "Ordering: put that code on its OWN line, immediately ABOVE the `VERDICT:` line — the verdict line is always the LAST line of your reply. (The host does not require the order, but the verdict must terminate the reply.)",
      "🟡 (Advisory) and 🔵 (Note) findings do NOT block approval — list them if present, but still include the approval code. If any 🔴 issue remains unfixed, do NOT include it.",
      "Exception: a row whose severity cell is literally `🟡 must-fix` **does** block approval — exactly like an unresolved 🔴. A plain 🟡 or 🔵 never blocks.",
      "",
    )
  }
  return parts.join("\n")
}

// ————————————— System prompt 选择（确定性轮次判定） —————————————

/** 追加本地时间（评审员需要"现在"的锚点）。 */
function withTime(prompt) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
  return prompt + "\n\nCurrent time: " + new Date().toLocaleString("sv-SE") + " (" + timeZone + ")."
}

/**
 * 轮次判定确定性（对齐 thincoder 2026-08-08 决策）：advisorRound>0 且有 prior 输出
 * = 收敛轮（round 2+）；否则 round 1。不做任何表头/短语解析。
 * design round 1 用专属设计评审 prompt；design round 2+ 与 code 一样收敛。
 */
export function buildAdvisorSystemPrompt(state, reviewType) {
  const hasPrior = (state.advisorRound || 0) > 0 && state.lastAdvisorOutput
  if (reviewType === "design") {
    if (!hasPrior) return ADVISOR_DESIGN
    return (state.advisorRound || 0) + 1 === 2 ? ADVISOR_ROUND2 : ADVISOR_ROUND3
  }
  if (!hasPrior) return ADVISOR_ROUND1
  return (state.advisorRound || 0) + 1 === 2 ? ADVISOR_ROUND2 : ADVISOR_ROUND3
}

// ————————————— 评审范围解析 —————————————

/** 显式 paths 优先；否则 touchedFiles（存的是 cwd 相对路径）去重。 */
export function resolveScopeFiles(cwd, paths, touchedFiles) {
  if (Array.isArray(paths)) {
    return [...new Set(paths.filter(p => typeof p === "string" && p.trim()))]
  }
  if (touchedFiles?.length) {
    return [...new Set(touchedFiles.filter(p => typeof p === "string" && p.trim()))]
  }
  return null
}

// ————————————— User message 构建 —————————————

function loadAdvisorMd(cwd) {
  try {
    return readFileSync(join(resolve(cwd), ".thincoder", "advisor.md"), "utf8")
  } catch {
    return DEFAULT_CRITERIA
  }
}

/**
 * 项目标准段（批 7 / D-P3–D-P8）：**三态显式**，零静默。
 * 门 = **声明键存在**（J7/D-P5）——**不再**看模式标志（旧实现挂在模式标志的短路分支上，
 * 会造出「已声明却被模式静默压制」的静默洞）。
 * 态 ① 声明且可读 → `## Project Standards` 段 + 声明说明句 + 全文（超预算截断 + 标记）
 * 态 ② 声明但不可读 → 与态 ③ 可区分的响亮句，且**点名配置键**
 * 态 ③ 未声明 → 显式降级句，且**明说不要自己去磁盘找文件**（防「review ONLY」违例）
 * 三种失态的标志串互不相同（机验锚 B5）。
 */
function injectProjectStandards(cwd, parts, standardsDoc) {
  if (typeof standardsDoc !== "string" || standardsDoc.trim() === "") {
    // 态 ③ 未声明 —— 显式降级句（逐字可断言）
    parts.push("(No project standards document declared — set advisor.standardsDoc to the project's standards file to have it evaluated. Until then, review against the documents list and general engineering practice. Do not attempt to locate or read any standards file on disk — the review scope is exactly the files listed above.)")
    parts.push("")
    return
  }
  let text
  try {
    const path = resolve(cwd ?? process.cwd(), standardsDoc)
    text = readFileSync(path, "utf8")
  } catch {
    // 态 ② 声明但不可读（含路径不可解析）—— **与态 ③ 可区分**，且点名配置键（D-P7）
    parts.push("(Declared project standards document '" + standardsDoc + "' could not be read — check the advisor.standardsDoc setting. Proceeding without it.)")
    parts.push("")
    return
  }
  // 态 ① 声明且可读
  if (text.length > STANDARDS_BUDGET) {
    text = text.slice(0, STANDARDS_BUDGET) + "\n…(truncated at " + STANDARDS_BUDGET + " chars — read the full file if you need more)"
  }
  parts.push("## Project Standards")
  parts.push("The project declares the following standards document. Evaluate the reviewed artifacts against it where applicable:")
  parts.push(text)
  parts.push("")
}

/**
 * 文档地图段（批 7 / J8：**同走声明键机制**，键 `advisor.documentMapDoc`）：**三态显式**，零静默。
 * 与标准段同构；**只在 design round 1 注入**（地图是「文档归属怎么判」的判据，对 code 评审无意义）。
 * 旧实现把路径写死成仓内某个具体位置且**静默 catch** ⇒ 该功能恒不生效而无人察觉（缺陷物种活标本）。
 */
function injectDocumentMap(cwd, parts, documentMapDoc) {
  if (typeof documentMapDoc !== "string" || documentMapDoc.trim() === "") {
    // 态 ③ 未声明 —— 显式降级句（与标准段的降级句**逐字不同**）
    parts.push("(No document map declared — set advisor.documentMapDoc to the project's document map file to have it used for the Document ownership criterion. Until then, judge ownership from the documents list. Do not attempt to locate or read any document map on disk — the review scope is exactly the files listed above.)")
    parts.push("")
    return
  }
  let text
  try {
    const path = resolve(cwd ?? process.cwd(), documentMapDoc)
    text = readFileSync(path, "utf8")
  } catch {
    // 态 ② 声明但不可读（含路径不可解析）—— 点名配置键
    parts.push("(Declared document map '" + documentMapDoc + "' could not be read — check the advisor.documentMapDoc setting. Proceeding without it.)")
    parts.push("")
    return
  }
  // 态 ① 声明且可读
  if (text.length > DOC_MAP_BUDGET) {
    text = text.slice(0, DOC_MAP_BUDGET) + "\n…(truncated at " + DOC_MAP_BUDGET + " chars — read the full file if you need more)"
  }
  parts.push("## Document Map")
  parts.push("The document map below registers which document files exist per section. Use it for the Document ownership criterion: a change for an existing section must amend that section's document, not create a new file for it.")
  parts.push(text)
  parts.push("")
}

/**
 * 构建 advisor 会话的 user 消息（对齐 thincoder messages.mjs 的三路径：
 * design round1 / code round1 / 收敛轮由 buildConvergenceBody 承担）。
 * includeProjectGuide（§3.5，缺省 false）：评审默认不注入项目记忆（AGENTS.md）——
 * 跳过 injectProjectGuide 并追加说明行；true 时保持现有 16K 截断注入行为。
 */
export function buildAdvisorUserMessage(opts) {
  // 批 7（D-P5/J7）：opts.engineering **不再参与**注入门——注入门 = 声明键存在。
  // opts.standardsDoc / opts.documentMapDoc = 生效全局配置里声明的两个文档路径（可缺省）。
  const { cwd, history, state, reviewType, designToken, documents, paths, standardsDoc, documentMapDoc } = opts
  const docList = Array.isArray(documents) ? documents.filter(d => typeof d === "string" && d.trim()) : []
  const pathList = Array.isArray(paths) ? [...new Set(paths.filter(p => typeof p === "string" && p.trim()))] : []
  const parts = []
  // F3 评审记忆开关（§3.5）：false（缺省）不注入 AGENTS.md，以保评审独立（显式 documents 为唯一需求来源）
  const includeProjectGuide = opts.includeProjectGuide === true
  const guideRoot = includeProjectGuide
    ? injectProjectGuide(cwd, parts, [...pathList, ...docList])
    : null
  if (!includeProjectGuide) {
    parts.push("(Project guide not injected — review is based on the documents list only. Pass requirement/design docs explicitly via documents=[...].)")
    parts.push("")
  }

  // —— 设计评审 round 1 ——
  if (reviewType === "design" && (state.advisorRound || 0) === 0) {
    parts.push("## Design Review")
    if (docList.length > 0) {
      parts.push("The documents below are the review scope. Review ONLY these files — do not scan git diff or read any other files.")
      parts.push("")
      parts.push("## Documents to Review")
      parts.push(docList.map(d => "- " + d + " — Read this file in full").join("\n"))
      parts.push("")
    } else {
      parts.push("(No documents provided — the design review needs an explicit documents list: pass documents=[...] with the requirements + design + referenced doc paths.)")
      parts.push("")
    }
    injectProjectStandards(cwd, parts, opts.standardsDoc)
    injectDocumentMap(cwd, parts, opts.documentMapDoc) // 仅 design：地图是文档归属判据
    parts.push("## Instructions")
    if (docList.length > 0) {
      parts.push("1. Read every document in the Documents to Review list in full — review ONLY those files. If a ## Project Standards section is present above, it states the project's standards — evaluate against it.")
    } else {
      parts.push("1. Ask the caller to provide the documents list — a design review without documents has no review scope.")
    }
    parts.push("2. Review against: completeness (all requirements covered?), feasibility (can this be built?), standards compliance (does it follow the project standards provided in this review context?), clarity (specific enough?), acceptance criteria (verifiable?), scope (appropriate?).")
    // requirement-fit 只在 Project Guide 实际注入时检查（includeProjectGuide=false 时无该段，
    // 评审以显式 documents 为唯一需求来源——条件化措辞避免消息中出现不存在的章节引用）
    if (guideRoot) {
      parts.push("3. If the ## Project Guide (AGENTS.md) section above is present, also check requirement fit: does the design match what the requirements documents it points to actually ask for?")
      parts.push("4. Do NOT run git diff or look for code changes — there are none at this stage.")
      parts.push("5. If you find issues, produce your review table with the format: | # | Category | Severity | Issue | Suggestion |. If the design passes, no table is needed.")
    } else {
      parts.push("3. Do NOT run git diff or look for code changes — there are none at this stage.")
      parts.push("4. If you find issues, produce your review table with the format: | # | Category | Severity | Issue | Suggestion |. If the design passes, no table is needed.")
    }
    if (designToken) {
      // R2：只展示批准码（token 本体不进提示词）。措辞与宿主端裁决启发式配套：
      // 通过时要求「state that the design is approved」→ 可靠命中通过性结论词。
      parts.push("")
      parts.push("## Approval Signal")
      parts.push("If — and ONLY if — your review finds NO 🔴 (Critical) issues, state that the design is approved, then end your reply with this exact approval code: [APPROVE:" + designApprovalCode(designToken) + "]")
      parts.push("Ordering: put that code on its OWN line, immediately ABOVE the `VERDICT:` line — the verdict line is always the LAST line of your reply.")
      parts.push("🟡 (Advisory) and 🔵 (Note) findings do NOT block approval — list them if present, but still include the approval code. If there are any 🔴 issues, do NOT include it.")
      parts.push("Exception: a row whose severity cell is literally `🟡 must-fix` **does** block approval — exactly like an unresolved 🔴. A plain 🟡 or 🔵 never blocks.")
    }
    return parts.join("\n")
  }

  // —— code 评审 round 1（无 prior）——
  const hasPrior = (state.advisorRound || 0) > 0 && state.lastAdvisorOutput
  if (!hasPrior) {
    if (pathList.length > 0 || docList.length > 0) parts.push("## Review Scope")
    if (pathList.length > 0) {
      parts.push("Review these code files/directories — read them in full for context:")
      parts.push("")
      parts.push(pathList.map(p => "- " + p).join("\n"))
      parts.push("")
    }
    if (docList.length > 0) {
      parts.push("The documents below define acceptance criteria and review context. Read them for context, then read the code files specified in the review scope. Judge the implementation against these documents.")
      parts.push("")
      parts.push("## Documents to Review")
      parts.push(docList.map(d => "- " + d + " — Read this file in full").join("\n"))
      parts.push("")
    }
    const background = extractConversationBackground(history)
    if (background) {
      parts.push("## Conversation Background (recent turns)")
      parts.push(background)
      parts.push("")
    }
    parts.push("## Review Criteria")
    parts.push(loadAdvisorMd(cwd))
    if (guideRoot) {
      parts.push("")
      parts.push("Additional criterion: **requirement fit** — does the implementation match what the requirements documents (referenced by the Project Guide above) actually ask for?")
    }
    parts.push("")
    injectProjectStandards(cwd, parts, opts.standardsDoc)
    parts.push("## Instructions")
    parts.push("1. IMPORTANT: the review scope lists the files under review — always verify current file state with read before judging. Never decide based on earlier snapshots alone.")
    parts.push("2. " + (guideRoot
      ? "The ## Project Guide (AGENTS.md) section above maps the project — read the requirements/design documents it points to (they are the primary reference for requirement-fit). Use read to load those documents."
      : !includeProjectGuide
        ? "The project guide (AGENTS.md) was intentionally NOT injected (includeProjectGuide=false) — judge the requirements from the review scope / documents list above; read every listed file in full."
        : "No AGENTS.md was found at the project root — rely on the conversation background for the user's requirements. If the requirements are unclear, state so explicitly."))
    parts.push("3. read the files in the Review Scope in full — they define exactly what to inspect. Batch independent reads/greps in a single reply instead of one call per round-trip.")
    parts.push("4. Use grep to trace callers, imports, and dependencies — only where genuine doubt remains.")
    parts.push("5. Produce your review table based on the review criteria above. Do not re-read content you already have.")
    parts.push("6. You may also flag other issues: crashes, data loss, logic errors — anything obvious. This is the convergence protocol: round 1 is the full review, later rounds only re-verify.")
    parts.push("")
    parts.push("Return your review as a markdown table (or a clear statement that everything is fine).")
    return parts.join("\n")
  }

  // —— 收敛轮（round 2+，code 与 design 共用）——
  const scopeFiles = resolveScopeFiles(cwd, pathList.length > 0 ? pathList : null, state.touchedFiles)
  const response = extractAgentResponseTable(history)
    || (scopeFiles?.length
      ? "(Agent did not provide a response table — perform a fresh review of: " + scopeFiles.slice(0, 10).join(", ") + ")"
      : "(Agent did not provide a response table — perform a fresh full review; the review surface is unknown, ask the user for the file list)")
  const round = (state.advisorRound || 0) + 1
  // R1：designToken 传入收敛轮——design 收敛轮同样携带 Approval Signal（code 评审时为 null，不附）
  return buildConvergenceBody(state.lastAdvisorOutput, response, round, scopeFiles, designToken)
}

// ————————————— 引用机械校验（host-verified citations） —————————————

// file:line: content 引用；扩展名白名单防 URL 误报（对齐 thincoder citations.mjs）
const CITATION_RE = /([\w./\\-]+\.(?:mjs|cjs|js|ts|jsx|tsx|mts|cts|py|rs|go|c|h|cpp|hpp|java|rb|php|sh|bash|json|md|markdown|mdx|yaml|yml|toml|css|html)):(\d+):\s*([^`\n]{4,})/g

export function extractCitations(text) {
  const out = []
  for (const m of String(text ?? "").matchAll(CITATION_RE)) {
    out.push({ file: m[1], line: Number(m[2]), content: m[3].trim() })
  }
  return out
}

export function verifyCitations(text, cwd) {
  const citations = extractCitations(text)
  const matched = []
  const failed = []
  const root = resolve(cwd) + sep
  for (const c of citations) {
    try {
      // 路径围栏：LLM 生成的路径不可信（realpath 解链接，防链接逃逸）
      const resolved = realpathSync(resolve(cwd, c.file))
      if (!resolved.startsWith(root)) {
        failed.push({ ...c, reason: "path traversal" })
        continue
      }
      const line = readFileSync(resolved, "utf8").split("\n")[c.line - 1] ?? ""
      if (line.includes(c.content)) matched.push(c)
      else failed.push(c)
    } catch {
      failed.push({ ...c, reason: "file unreadable" })
    }
  }
  return { total: citations.length, matched, failed }
}

export function appendCitationReport(text, cwd) {
  const { total, matched, failed } = verifyCitations(text, cwd)
  if (total === 0) return text
  const lines = [
    "",
    "---",
    "[host-verified] " + matched.length + "/" + total + " citations match current file state.",
  ]
  if (failed.length > 0) {
    lines.push("Citations that do NOT match the current file state (treat their claims as unverified):")
    for (const f of failed.slice(0, 10)) {
      lines.push("- " + f.file + ":" + f.line + ": " + f.content.slice(0, 80) + (f.reason ? " (" + f.reason + ")" : ""))
    }
  }
  return text + lines.join("\n")
}

// ————————————— 未修复项提取（上限消息用） —————————————

export function extractUnfixedIssues(priorText) {
  if (!priorText) return []
  const lines = String(priorText).split("\n")
  const resolvedRe = /\b(?:fixed|resolved|done|addressed|corrected)\b|✓|✔/i
  return lines
    .filter(line => /\|\s*\d+\s*\|/.test(line))
    .filter(line => !resolvedRe.test(line))
    .map(line => line.trim().replace(/^\|/, "").replace(/\|$/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_UNFIXED_DISPLAY)
}

export { MAX_KEY_FILES_IN_COMPACTION }
