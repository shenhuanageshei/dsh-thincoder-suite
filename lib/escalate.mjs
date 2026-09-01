// escalate.mjs — 飞刀（把实现任务交给更强模型亲自操刀）。移植自 thincoder escalate.mjs。
// 同步工具：await 子代理 → 术后病历（改动/理由/验证 + Touched files）。
// 护栏：① 不能再飞刀（delegationDepth>0 拒 + maxDepth:1 双保险）② eng 模式 fail-closed
// 指向 eng_coder ③ 无墙钟看门狗（thincoder 同款理由：固定超时会杀死慢而正常的手术；
// 保护 = 子代理 turn 体系 + 用户 Stop 经 signal 直传）。
import { ESCALATE_PERSONA } from "./prompts.mjs"
import { sessionState, engEffective } from "./state.mjs"

const label = (m) => m.provider + ":" + m.model

/** 从术后报告解析 Touched files（任务书约定最后一行 "Touched files: a, b, c"）。 */
export function parseTouchedFiles(report) {
  const text = String(report ?? "")
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^Touched files:\s*(.+)$/i)
    if (m) {
      return m[1].split(",").map(s => s.trim()).filter(Boolean)
    }
  }
  return []
}

/** 飞刀任务书（对齐 thincoder：goal/constraints/entry files/acceptance + Touched files 约定）。 */
function buildTaskBrief(task) {
  return [
    "# Task (flown-in expert engagement)",
    task,
    "",
    "You have WRITE access and do the work yourself — read, edit, verify. Work independently; the parent only sees your final report.",
    "",
    "Your last message IS the post-op report the parent reads. Make it complete:",
    "1. What you changed and why",
    "2. How you verified (commands run, tests, with results)",
    "3. Any caveats or follow-ups",
    "",
    "END the report with one line exactly in this format (comma-separated relative paths, or 'none'):",
    "Touched files: <paths>",
  ].join("\n")
}

/**
 * 执行一次飞刀。
 * @param deps { ctx, agent, config, state, signal }
 * @returns 术后病历文本
 */
export async function runEscalate(deps, task, model) {
  const { ctx, agent, config, state, signal } = deps

  // 护栏 1：深度（子代理不能再飞刀）
  const depth = agent.session?.header?.delegationDepth ?? 0
  if (depth > 0) {
    return "Error: escalate is only available at the top level (a flown-in expert's work cannot be delegated again)."
  }
  // 护栏 2：工程模式 fail-closed
  if (engEffective(state, deps.configDefaultEngineering)) {
    return "Error: engineering mode is ON — escalate is unavailable (it spawns a coder sub-agent, which engineering mode forbids). Use eng_coder with a designToken from advisor(type='design') instead."
  }
  const pool = Array.isArray(config.consultModels) ? config.consultModels : []
  if (pool.length === 0) {
    return "Error: no escalate candidates — configure at least one consult model (consultModels) in the plugin config."
  }

  const wanted = typeof model === "string" ? model.replace(/\s+\([^)]*\)\s*$/, "").trim() : model
  const pick = wanted ? pool.find(m => label(m) === wanted) : pool[0]
  if (!pick) {
    return "Error: \"" + model + "\" is not a consult candidate. Available: " + pool.map(label).join(", ")
  }
  const tag = label(pick)

  let run
  try {
    const request = {
      prompt: [{ type: "text", text: buildTaskBrief(task) }],
      parent: agent,
      signal: signal ?? null,
      persona: ESCALATE_PERSONA,
      label: "escalate " + tag,
      agentOptions: pick.effort
        ? { provider: pick.provider, model: pick.model, reasoningEffort: pick.effort }
        : { provider: pick.provider, model: pick.model },
      maxDepth: 1, // 防套娃双保险：飞刀的子代理不能再派子代理
      toolFilter: { deny: ["escalate", "consult_start", "consult_check", "consult_stop", "eng", "eng_coder"] },
    }
    run = await ctx.subagents.start("spawn", request)
  } catch (e) {
    return "escalate (" + tag + ") failed to start: " + (e?.message ?? String(e))
  }

  let result
  try {
    result = await run.result
  } catch (e) {
    if (signal?.aborted || e?.name === "AbortError") return "escalate (" + tag + ") aborted."
    return "escalate (" + tag + ") error: " + (e?.message ?? String(e))
  } finally {
    try { await run.dispose() } catch { /* already disposed */ }
  }

  const stopReason = result?.stopReason ?? "unknown"
  const outputText = (result?.output ?? [])
    .filter(b => b?.type === "text").map(b => b.text ?? "").join("\n").trim()

  // 飞刀改动并入父级评审范围（对齐 thincoder mergeChildMutations 语义：
  // advisor 的 touchedFiles 兜底必须看到飞刀的改动）
  const touched = parseTouchedFiles(outputText)
  if (touched.length > 0) {
    const merged = new Set([...(state.touchedFiles ?? []), ...touched])
    state.touchedFiles = [...merged]
    state.mutatedThisRun = true
  }

  if (stopReason !== "completed") {
    const diag = result?.diagnostic ? " — " + result.diagnostic : ""
    return "escalate (" + tag + ") ended: " + stopReason + diag + "\nPartial output:\n" + outputText.slice(0, 2000)
  }
  return "escalate (" + tag + ") post-op report:\n" + (outputText || "(empty report)")
}
