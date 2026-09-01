// advisor.mjs — advisor 工具本体：LLM 评审循环 + 收敛协议入口 + design token 生命周期。
// 移植自 thincoder advisor/run.mjs（工具循环/上限/超时/压缩）+ agent-tools/advisor.mjs
//（token 签发与校验）。DSH 适配：LLM 调用走 ctx.llm.stream（GenerateOptions 原生支持
// tools），消息形状为 DSH Message（content 块数组）。
// design token 协议 v2（DESIGN-advisor-token-protocol-fix.md）：token 每评审会话只铸造
// 一次；评审轮只展示 8 位批准码 [APPROVE:<8hex>]（token 本体不进提示词）；签发判定 =
// 裁决通过 ∧ 批准码回显命中，宿主校验命中后自行注入完整 token。
import { randomUUID, createHmac } from "node:crypto"
import { sessionState, engEffective } from "./state.mjs"
import { advisorToolSchemas, advisorToolImpls } from "./readonly-tools.mjs"
import {
  buildAdvisorSystemPrompt, buildAdvisorUserMessage, appendCitationReport,
  extractUnfixedIssues,
} from "./advisor-msgs.mjs"

export const MAX_ADVISOR_ROUNDS = 5     // 机械收敛上限：第 6 次调用零 LLM 直接拒
const MAX_ADVISOR_TURNS = 100           // 工具轮硬上限（runaway-loop 守卫）
const MAX_CONTEXT_TOKENS = 120_000      // 上下文窗口预算（预留余量）
const REVIEW_TIMEOUT_MS = 600_000       // 整次评审超时（10 分钟）
const TOKEN_TTL_DEFAULT_MS = 7 * 24 * 3600 * 1000
const TOKEN_SECRET = process.env.THINCODER_TOKEN_SECRET || "thincoder-default-secret"

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
 * 「裁决通过」启发式判定（R2。设计未钉死机械定义——最简实现 + 保守方向）：
 * ① 无 🔴 表格行：/\|[^|]*🔴/ 不命中（评审表里任何 🔴 行都视为未通过）；
 * ② 输出含通过性结论词（通过 / 批准 / approved，忽略大小写），且该词不在否定语境
 *   （不/未/非/没/难以/无法 + 通过|批准，或 not/never + approved——“未通过”、
 *   "not approved" 不算通过）。任一条件不满足 → 按未通过处理（拿不准就不签发）。
 * 注意：结论词清单与 Approval Signal 措辞是配套设计——消息构建（advisor-msgs.mjs）
 * 明确要求通过时「state that the design is approved」，以可靠命中本启发式。
 * 该启发式与 [APPROVE:<code>] 回显是 AND 关系，两者都命中才签发。
 */
const APPROVAL_VERDICT_RE = /((?:不|未|非|没|难以?|无法)|(?:not|never)\s+)?(通过|批准|approved)/gi
function isApprovalVerdict(text) {
  const s = String(text ?? "")
  if (/\|[^|]*🔴/.test(s)) return false
  APPROVAL_VERDICT_RE.lastIndex = 0
  let m
  while ((m = APPROVAL_VERDICT_RE.exec(s)) !== null) {
    if (!m[1]) return true // 至少存在一个非否定语境的结论词
  }
  return false
}

/** token 第二段 expiresAt → 本地 HH:MM（R3 Approved 消息的有效期提示）。 */
function hhmmFromToken(token) {
  const exp = Number.parseInt(String(token).split(":")[1], 10)
  if (!Number.isFinite(exp)) return "??:??"
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
 */
function compactMessages(messages) {
  if (messages.length <= 20) return
  const first = messages[0]
  let start = messages.length - 20
  while (start > 1 && messages[start] && messages[start].role === "user"
    && messages[start].content?.[0]?.type === "tool-result") start--
  const recent = messages.slice(start)
  const old = messages.slice(1, start)
  const toolCount = old.filter(m => m.content?.[0]?.type === "tool-result").length
  const keyFiles = old
    .filter(m => m.content?.[0]?.type === "tool-result")
    .map(m => (m.content[0].content?.[0]?.text ?? "").split("\n")[0]?.slice(0, 50))
    .filter(Boolean).slice(0, 5)
  const filesPart = keyFiles.length > 0 ? " Key files examined: " + keyFiles.join(", ") : ""
  const summary = "[Context compacted] Earlier exploration: " + toolCount + " tool calls completed." + filesPart
  messages.splice(0, messages.length, first, userMsg(summary), ...recent)
}

// ————————————— 流收集 —————————————

// 单次 LLM 调用的 chunk 级看门狗（thincoder 有 per-request FETCH_TIMEOUT；DSH
// GenerateOptions 无超时字段，挂起的请求会把循环卡到天荒地老——循环顶的整体
// 超时检查在 await 期间永远不执行。看门狗把挂起变成可诊断的错误）。
const LLM_CALL_STALL_MS = 90_000  // 单次 LLM 调用无 chunk 上限（首 chunk 一般数秒；90s 覆盖慢 prefill）
const STREAM_ATTEMPTS = 3          // 看门狗 stall 时的单调用重试次数（瞬时 provider 挂起自愈）

async function collectStream(llm, opts, stallMs = LLM_CALL_STALL_MS) {
  const blocks = []
  let finish = null
  const wd = new AbortController()
  let wdTimer = null
  const arm = () => {
    clearTimeout(wdTimer)
    wdTimer = setTimeout(() => wd.abort(new Error("llm call stalled " + Math.round(stallMs / 1000) + "s without a chunk (provider or adapter hang)")), stallMs)
    wdTimer.unref?.()
  }
  arm()
  const combined = opts.signal ? AbortSignal.any([opts.signal, wd.signal]) : wd.signal
  const iterator = llm.stream({ ...opts, signal: combined })[Symbol.asyncIterator]()
  const stallP = new Promise((_, reject) => {
    wd.signal.addEventListener("abort", () => reject(wd.signal.reason ?? new Error("llm call stalled")), { once: true })
  })
  try {
    while (true) {
      const step = await Promise.race([iterator.next(), stallP])
      if (step.done) break
      const chunk = step.value
      arm()
      if (chunk?.type === "block-end") blocks.push(chunk.block)
      else if (chunk?.type === "finish") finish = chunk
    }
    return { blocks, finish }
  } finally {
    clearTimeout(wdTimer)
    // 关闭流自身也要有界：async generator 挂在内层 await 时 .return() 永不落定，
    // 无界 await 会让看门狗在清理阶段被击穿。给关闭 2s，超时放弃（残留连接交给 OS/网关回收）。
    let closeP = Promise.resolve()
    try { closeP = Promise.resolve(iterator.return?.()).catch(() => {}) } catch { /* 同步抛出：无可关闭 */ }
    await Promise.race([closeP, new Promise(r => setTimeout(r, 2000))])
  }
}

// ————————————— 工具循环 —————————————

async function runAdvisorToolLoop(deps, opts) {
  const { provider, model, system, firstUserText, cwd, signal, timeoutMs, sessionId } = opts
  const impls = advisorToolImpls(cwd)
  const tools = advisorToolSchemas()
  const messages = [userMsg(firstUserText)]
  let turns = 0
  const startTime = Date.now()

  while (true) {
    if (signal?.aborted) return "Advisor: interrupted."
    if (Date.now() - startTime > timeoutMs) {
      return "Advisor: review timeout after " + Math.round(timeoutMs / 1000) + "s. Partial results may be available. Try again with a narrower scope."
    }
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
    let result = null
    let lastErr = null
    for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt++) {
      try {
        result = await collectStream(deps.llm, {
          provider, model, system, messages, tools, signal,
          ...(sessionId ? { sessionId } : {}),
          purpose: "thincoder-advisor",
          maxTokens: 8192,
        }, stallMs)
        lastErr = null
        break
      } catch (e) {
        if (e?.name === "AbortError" || signal?.aborted) return "Advisor: interrupted."
        lastErr = e
        // 仅看门狗 stall 走重试：失败调用没有产出可用内容，messages 原样复用
        if (!/stalled/.test(e?.message ?? String(e))) break
        if (attempt < STREAM_ATTEMPTS) await new Promise(r => setTimeout(r, 1000 * attempt))
      }
    }
    if (lastErr) {
      const msg = lastErr?.message ?? String(lastErr)
      const errorType = /rate limit|429/i.test(msg) ? "rate limit"
        : /timeout/i.test(msg) ? "timeout"
        : /network|ECONNREFUSED/i.test(msg) ? "network"
        : /context length/i.test(msg) ? "context_too_long"
        : /stalled/.test(msg) ? "provider_stall"
        : "unknown"
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
      messages.push(toolResultMsg(tc.id, resultText))
    }
  }
}

// ————————————— 评审入口 —————————————

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
 * 运行一次 advisor 评审（收敛协议入口）。
 * @param deps  { llm } — 宿主 LlmRuntime
 * @param opts  { agent, config, signal, reviewType, documents, paths, configDefaultEngineering }
 * @returns 评审文本（错误/上限消息以 "Advisor:" 前缀返回）
 */
export async function runAdvisorReview(deps, opts) {
  const { agent, signal } = opts
  const config = opts.config ?? {}
  const state = sessionState(agent.session.id)
  const reviewType = opts.reviewType === "design" ? "design" : "code"
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

  // 模型路由：config.advisor 覆盖，否则主代理路由
  const agentOpts = agent.options ?? {}
  const provider = config.advisor?.provider || agentOpts.provider
  const model = config.advisor?.model || agentOpts.model
  if (!provider || !model) {
    return "Advisor: no LLM route available — configure advisor.provider / advisor.model in the plugin config, or run from a session with a default model route."
  }
  const cwd = agent.session?.header?.cwd || process.cwd()

  // 无 prior 且本 run 无代码变更 → 重置轮次预算（对齐 thincoder 2026-08-05 决策）
  const hasPrior = (state.advisorRound || 0) > 0 && state.lastAdvisorOutput
  if (!hasPrior && !(state.mutatedThisRun ?? false)) state.advisorRound = 0

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

  const system = withTime(buildAdvisorSystemPrompt(state, reviewType))
  const userText = buildAdvisorUserMessage({ cwd, history, state, reviewType, designToken, documents, paths, engineering })
  const timeoutCfg = config.advisor?.timeoutMs
  const timeoutMs = Number.isFinite(timeoutCfg) && timeoutCfg > 0 ? timeoutCfg : REVIEW_TIMEOUT_MS

  let result
  try {
    result = await runAdvisorToolLoop(deps, { provider, model, system, firstUserText: userText, cwd, signal, timeoutMs, sessionId: agent.session.id })
  } catch (e) {
    if (e?.name === "AbortError" || signal?.aborted) return "Advisor: interrupted."
    return "Advisor: review failed — " + (e?.message ?? String(e))
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
      const clean = String(result).replace(makeApprovalCodeRegex(code, "g"), "").trim()
      return clean + "\n\nApproved. Pass this exact token to eng_coder (designToken parameter): " + designToken
        + "\n（有效至 " + hhmmFromToken(designToken) + "，TTL engTokenTtlMs）"
    }
    if (completed) state.designToken = null // 完成但未通过 → 撤销既有签发（pendingDesignToken 保持：下轮同一批准码）
    if (result) {
      let out = String(result)
      if (verdictPassed) {
        // R3 诊断行：裁决通过但批准码校验失败（未回显 / 回显不符 / 旧格式）
        out += "\n\n评审通过但批准码校验失败——请重跑评审（本轮 token 未签发）"
      }
      return out.trim() || "Advisor: design review did not pass."
    }
  }
  return final
}
