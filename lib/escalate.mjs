// escalate.mjs — 飞刀（把实现任务交给更强模型亲自操刀）。移植自 thincoder escalate.mjs。
// 同步工具：await 子代理 → 术后病历（改动/理由/验证 + Touched files）。
// 护栏：① 不能再飞刀（delegationDepth>0 拒 + maxDepth:1 双保险）② eng 模式 fail-closed
// 指向 eng_coder ③ dsh 子代理路径无墙钟（turn 体系保护）；codex 路径（T2.1）为子进程，
// 带 wall-clock watchdog + idle 活性信号（B9——进程会变孤儿，必须可杀）+ budgetCap 截断
// （平台 run_code 墙钟 600s——超预算部分跑不完，截断 + 尾部告警，T2.1b jobs 迁移待办）。
// T2.4：codex 行交付后 threadId 存本模块内存 Map（B14 不落盘），followup 续轮消费。
import { ESCALATE_PERSONA } from "./prompts.mjs"
import { sessionState, engEffective } from "./state.mjs"
import { normalizeRunnerValue, runCodexTask, codexRowLabel, resolveCodexCliGlobals, CODEX_TASK_PREAMBLE } from "./codex-adapter.mjs"
import { resolveSupportedEffort, resolveCodexRowEffort } from "./effort-resolve.mjs"

// T2.4 线程连续性：threadId 只存进程内存（B14——禁止进持久化配置/日志），abort/完成即弃。
// 键 = DSH 会话 id（统一 String 归一——评审 #5：与 clearCodexThread 对称，防泄漏）；
// escalate codex 行成功交付时写入（评审 #3：失败/中止即删；followup 成功刷新），followup 消费。
// 评审 #4：会话销毁经 clearCodexThread 清理（index.mjs session/disposed 接线），防进程级滞留。
const codexThreads = new Map()
const threadKeyOf = (id) => String(id ?? "")

/** 会话销毁清理（index.mjs session/disposed 接线）。 */
export function clearCodexThread(sessionId) {
  codexThreads.delete(threadKeyOf(sessionId))
}

/** 从术后报告解析 Touched files（任务书约定最后一行 "Touched files: a, b, c"）。
 *  评审 #2：哨兵值 "none"/"n/a"（无改动）不是路径——过滤掉，防止污染 touchedFiles 审计范围。
 *  评审 #9：容忍尾随标点/说明（"None."、"n/a (nothing)"）——按词边界匹配前缀即可。 */
export function parseTouchedFiles(report) {
  const text = String(report ?? "")
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^Touched files:\s*(.+)$/i)
    if (m) {
      return m[1].split(",").map(s => s.trim()).filter(Boolean)
        .filter(s => !/^(none|n\/a)\b/i.test(s))
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
export async function runEscalate(deps, task, model, followup) {
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

  // 评审 #6：codex 行标签带全局 codexCli.model 兜底（与 consult.mjs 一致——否则
  // consult_check 显示的标签与 escalate 候选列表对不上，用户点名会落空）。
  const cliCfg = (config && typeof config === "object" && config.codexCli
    && typeof config.codexCli === "object") ? config.codexCli : {}
  const labelOf = (m) => (m && m.runner && m.runner.kind === "codex-cli")
    ? codexRowLabel(m.runner, cliCfg)
    : m.provider + ":" + m.model
  // 评审 #5：线程键统一 String 归一（set/get/delete/clear 四处对称）。
  const threadKey = threadKeyOf(agent.session?.id)

  // —— T2.4：followup 优先走交付时保存的 runner/label/线程（评审 #5：省略 model 的
  // followup 用保存行而非 pool[0]；评审 #8：不依赖池——池清空后已存线程仍可续轮）——
  if (followup) {
    const prev = codexThreads.get(threadKey)
    if (!prev || !prev.threadId) {
      return "Error: no codex escalate thread in this session — run a codex escalate task first (followup continues that thread)."
    }
    // 评审 #3：followup 沙箱沿用交付时配置——显式 danger-full-access 续轮保留（D3 一致性），
    // 其余固定 workspace-write（B5：read-only 不作实现沙箱）。
    // D-02：followup 复用首次交付时已解析的 runner（effort 已按 codex 目录校验回落，
    // 同名档位重校验幂等——不重复解析，避免 followup 平添目录依赖）。
    const sandbox = prev.runner && prev.runner.sandbox === "danger-full-access" ? "danger-full-access" : "workspace-write"
    try {
      const env = await runCodexTask(deps, {
        taskText: buildTaskBrief(task),
        cwd: agent.session?.header?.cwd || process.cwd(),
        sandbox,
        timeoutMs: prev.runner && prev.runner.timeoutMs ? prev.runner.timeoutMs : undefined,
        // 评审 #4：idle 兜底与首次路径对齐（cliCfg 兜底不丢——写任务续轮保持假死防护）
        idleTimeoutMs: (prev.runner && prev.runner.idleTimeoutMs) ?? cliCfg.idleTimeoutMs ?? 300000,
        runner: prev.runner,
        config,
        signal,
        resumeThreadId: prev.threadId,
      })
      const touched = parseTouchedFiles(env.text)
      if (touched.length > 0) {
        const merged = new Set([...(state.touchedFiles ?? []), ...touched])
        state.touchedFiles = [...merged]
        state.mutatedThisRun = true
      }
      if (env.ok && env.text) {
        // 评审 #2：resume 后刷新 threadId（codex 新版本可能回报新线程 id——保持连续性）
        if (env.threadId) codexThreads.set(threadKey, { threadId: env.threadId, runner: prev.runner, label: prev.label })
        return "escalate (" + prev.label + ", resume) post-op report:\n" + env.text
      }
      // 评审 #3：失败/中止 → 弃 thread（abort 即弃）
      codexThreads.delete(threadKey)
      const partial = env.text ? "\nPartial output:\n" + env.text.slice(0, 2000) : ""
      return "escalate (" + prev.label + ") ended: codex-cli " + env.code + " — " + (env.userMessage || env.diagnostics || "unknown") + partial
    } catch (e) {
      codexThreads.delete(threadKey)
      if (signal?.aborted) return "escalate (" + prev.label + ") aborted."
      return "escalate (" + prev.label + ") error: " + (e?.message ?? String(e))
    }
  }

  const pool = Array.isArray(config.consultModels) ? config.consultModels : []
  if (pool.length === 0) {
    return "Error: no escalate candidates — configure at least one consult model (consultModels) in the plugin config."
  }

  const wanted = typeof model === "string" ? model.replace(/\s+\([^)]*\)\s*$/, "").trim() : model
  const pick = wanted ? pool.find(m => labelOf(m) === wanted) : pool[0]
  if (!pick) {
    return "Error: \"" + model + "\" is not a consult candidate. Available: " + pool.map(labelOf).join(", ")
  }
  const tag = labelOf(pick)

  // —— T2.1：codex-cli 行走子进程写任务（D3 显式全权 + 来源日志；idle watchdog）——
  // 评审 #1：escalate 语义 = 写任务——read-only 被拒/纠正为 workspace-write（B5），
  // danger-full-access 仅显式配置时许可并留痕（T2.5/D3）。
  // 评审 #1（回落评审）：预算护栏——budgetCap 截断 + 尾部告警（T2.1b jobs 迁移待办，
  // 迁移前 > budgetCap 的预算会被平台 run_code 墙钟砍掉并产生孤儿进程，B9）。
  const nr = normalizeRunnerValue(pick.runner)
  if (nr.ok && nr.runner.kind === "codex-cli") {
    const runner = nr.runner
    let sandbox = "workspace-write" // B5：escalate 默认且最低写沙箱
    if (runner.sandbox === "danger-full-access") {
      // T2.5/D3：全权沙箱必须显式配置；来源（哪一行）随日志留痕
      sandbox = "danger-full-access"
      console.warn("[thincoder-suite] escalate codex runner sandbox=danger-full-access explicitly configured (source: consultModels row \"" + tag + "\")")
    } else if (runner.sandbox && runner.sandbox !== "workspace-write") {
      console.warn("[thincoder-suite] escalate codex runner sandbox=" + runner.sandbox + " ignored — escalate requires workspace-write (B5)")
    }
    const budgetCap = Number.isInteger(cliCfg.budgetCapMs) && cliCfg.budgetCapMs > 0 ? cliCfg.budgetCapMs : 540000
    const baseTimeout = runner.timeoutMs ?? cliCfg.defaultTimeoutMs ?? 600000
    const effTimeout = Math.min(baseTimeout, budgetCap)
    // 评审 #1：截断告警放结果尾部（附录 D.3 规则）；T2.1b jobs 迁移后此告警退役
    const capNote = baseTimeout > budgetCap
      ? "\n[thincoder-suite] warning: escalate 预算 " + baseTimeout + "ms 超过 codexCli.budgetCapMs=" + budgetCap + "ms——已截断（平台 run_code 墙钟；jobs 迁移 T2.1b 待办）"
      : ""
    // D-02 L1（R1）：codex 行 effort 统一走 resolveCodexRowEffort（codex models catalog；
    // 同名→保持 / 非法→最近支持档（等距向上取）/ off→不传 / 目录未命中→透传+告警）。
    // 交付后保存已解析 runner（followup 复用，见上）。
    const effRes = await resolveCodexRowEffort(deps, runner, runner.effort, resolveCodexCliGlobals(config).globals)
    const effNote = effRes.note ? "\n[thincoder-suite] " + effRes.note : ""
    // off → null（不传，codex 无 off）——effort 解析结果整体写回 runner（off 必须被清掉）；
    // 交付后保存已解析 runner（followup 复用，见上）
    const effRunner = { ...runner, effort: effRes.effort ?? undefined }
    const cwd = agent.session?.header?.cwd || process.cwd()
    try {
      const env = await runCodexTask(deps, {
        taskText: CODEX_TASK_PREAMBLE + "\n\n" + buildTaskBrief(task),
        cwd,
        sandbox,
        timeoutMs: effTimeout,
        idleTimeoutMs: runner.idleTimeoutMs ?? cliCfg.idleTimeoutMs ?? 300000,
        runner: effRunner,
        config,
        signal,
      })
      const touched = parseTouchedFiles(env.text)
      if (touched.length > 0) {
        const merged = new Set([...(state.touchedFiles ?? []), ...touched])
        state.touchedFiles = [...merged]
        state.mutatedThisRun = true
      }
      // T2.4：仅成功交付记录 threadId（评审 #3：ABORTED/TIMEOUT 等失败即弃）；内存态 B14 不落盘
      if (env.ok && env.text) {
        if (env.threadId) codexThreads.set(threadKey, { threadId: env.threadId, runner: effRunner, label: tag })
        return "escalate (" + tag + ") post-op report:\n" + env.text + capNote + effNote
      }
      codexThreads.delete(threadKey)
      const partial = env.text ? "\nPartial output:\n" + env.text.slice(0, 2000) : ""
      return "escalate (" + tag + ") ended: codex-cli " + env.code + " — " + (env.userMessage || env.diagnostics || "unknown") + partial + capNote + effNote
    } catch (e) {
      codexThreads.delete(threadKey)
      if (signal?.aborted) return "escalate (" + tag + ") aborted."
      return "escalate (" + tag + ") error: " + (e?.message ?? String(e))
    }
  }

  // D-02 L1（R1）：dsh 行 effort 按行自身 provider/model 解析（不是父代理路由）——
  // 非法档 → 最近支持档回落 + note；元数据不可得 → fail-open 透传 + 响亮告警。
  const effRes = await resolveSupportedEffort(deps.ctx?.llm ?? null, pick.provider, pick.model, pick.effort ?? undefined)
  const effNote = effRes.note ? "\n[thincoder-suite] " + effRes.note : ""

  let run
  try {
    const request = {
      prompt: [{ type: "text", text: buildTaskBrief(task) }],
      parent: agent,
      signal: signal ?? null,
      persona: ESCALATE_PERSONA,
      label: "escalate " + tag,
      agentOptions: effRes.effort
        ? { provider: pick.provider, model: pick.model, reasoningEffort: effRes.effort }
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
    return "escalate (" + tag + ") ended: " + stopReason + diag + "\nPartial output:\n" + outputText.slice(0, 2000) + effNote
  }
  return "escalate (" + tag + ") post-op report:\n" + (outputText || "(empty report)") + effNote
}
