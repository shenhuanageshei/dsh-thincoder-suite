// escalate.mjs — 飞刀（把实现任务交给更强模型亲自操刀）。移植自 thincoder escalate.mjs。
// 同步工具：await 子代理 → 术后病历（改动/理由/验证 + Touched files）。
// 护栏：① 不能再飞刀（delegationDepth>0 拒 + maxDepth:1 双保险）② eng 模式 fail-closed
// 指向 eng_coder ③ dsh 子代理路径受平台墙钟约束（run_code 600s——DP-1 方案 A〔R2 §4.2，
// 已终裁〕：await run.result 加 budgetCap 内部截止，到点 abort + 响亮告警；如需长任务请走
// codex runner〔jobs 后台派发〕或拆分 stages）；codex 路径（T2.1）为子进程，带
// wall-clock watchdog + idle 活性信号（B9——进程会变孤儿，必须可杀）。
// R2 §4.1（D-03/D-04）：codex 行预算 > budgetCap 且 ctx.jobs 可用 → jobs 后台派发（owner
// 绑定 agent、cancel 走 ctrl.abort、run() 内自有 watchdog——jobs 免疫平台墙钟）；≤ cap 或
// jobs 缺失 → 同步钳制 + 响亮告警。首次与 followup 同链预算解析（D-04：followup 不再
// 绕过 budgetCap 零余量撞墙）。D-20：交付簿记（touchedFiles 合并 + codexThreads 记录）
// 在任务完成回调的成功分支恰好一次；失败分支只输出诊断 + partial 的 advisory touched
// 提示（D-11：截断杀路径追加回滚指引）。
// R3 §5.4 补丁轮（D-06 同步路径单飞扩展）：机制入口（护栏之后、任何 spawn/runCodexTask
// 之前）checkInFlightJob——同会话 escalate 在飞（>cap job 或任何已占位形态）期间任何新
// 调用（followup 续轮/≤cap 同步/dsh 子代理路径）被拒；jobs 派发点二次检查保留。
// T2.4：codex 行交付后 threadId 存本模块内存 Map（B14 不落盘），followup 续轮消费。
import { ESCALATE_PERSONA } from "./prompts.mjs"
import { sessionState, engEffective } from "./state.mjs"
import { saveSessionState } from "./session-store.mjs"
import { normalizeRunnerValue, runCodexTask, codexRowLabel, resolveCodexCliGlobals, CODEX_TASK_PREAMBLE } from "./codex-adapter.mjs"
import { resolveSupportedEffort, resolveCodexRowEffort } from "./effort-resolve.mjs"
import { resolveCodexBudgetCapMs, getJobsService, codexJobsDispatchReply, checkInFlightJob, setInFlightJob, clearInFlightJob, sessionStateViewWithGeneration } from "./advisor.mjs"

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

/**
 * D-11/D-20 失败分支提示（escalate/eng codex 共用）：partial 输出内 Touched 行作 advisory
 * 解析（提示可见但不并入 touchedFiles 审计范围）；截断杀路径（TIMEOUT/ABORTED/
 * CLEANUP_FAILED——进程树被 watchdog/abort 强杀，写任务可能半途残留）追加回滚指引。
 * @param {{text?: string, code?: string}} env — codex envelope（或同形状对象）
 * @returns {string} 追加到失败文本尾部的提示（无内容 → 空串）
 */
export function codexFailureAdvisory(env) {
  const parts = []
  const touched = parseTouchedFiles(env?.text)
  if (touched.length > 0) {
    parts.push("partial 输出含 Touched 行（advisory 解析，未并入审计范围）: " + touched.join(", "))
  }
  if (env && (env.code === "TIMEOUT" || env.code === "ABORTED" || env.code === "CLEANUP_FAILED")) {
    parts.push("半途写入可能残留：对照 partial 输出与 Touched 提示检查工作区，必要时 git 回滚。")
  }
  return parts.length > 0 ? "\n[thincoder-suite] " + parts.join("\n[thincoder-suite] ") : ""
}

/**
 * D-20 成功分支簿记：Touched files 并入父级评审范围（对齐 thincoder mergeChildMutations
 * 语义：advisor 的 touchedFiles 兜底必须看到飞刀的改动）+ 置 mutatedThisRun。
 */
function mergeEscalateTouched(state, touched) {
  if (touched.length > 0) {
    const merged = new Set([...(state.touchedFiles ?? []), ...touched])
    state.touchedFiles = [...merged]
    state.mutatedThisRun = true
  }
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
 * R2 §4.1：escalate codex 行统一执行（首次 + followup 同链）。
 * 预算解析：runner.timeoutMs → cliCfg.defaultTimeoutMs → 600000（D-04：followup 与首次
 * 同链——不再把 runner.timeoutMs 原样透传绕过 budgetCap）；预算 > budgetCap 且 ctx.jobs
 * 可用 → jobs 派发（run() 内全预算 + 自有 watchdog；cancel 走 ctrl.abort）；≤ cap 或 jobs
 * 缺失/派发抛错 → 同步钳制（budgetCap）+ 响亮告警。D-20：簿记在 done 成功分支恰好一次。
 * @param deps — runEscalate 的 deps（ctx/agent/config/state/signal + spawn 注入缝）
 * @param p { cliCfg, tag, runner, sandbox, taskText, resumeThreadId, effNote }
 */
async function runEscalateCodex(deps, p) {
  const { agent, config, state, signal } = deps
  const { cliCfg, tag, runner, sandbox, taskText, resumeThreadId } = p
  const effNote = p.effNote ?? ""
  const threadKey = threadKeyOf(agent.session?.id)
  const cwd = agent.session?.header?.cwd || process.cwd()
  const resumeTag = resumeThreadId ? ", resume" : ""
  const budgetCap = resolveCodexBudgetCapMs(config)
  // 预算链（值域校验对齐 adapter 常量：defaultTimeoutMs 30000..3600000——手编 config 的
  // 垃圾值不进 watchdog 毫秒级误杀）
  const defTimeout = Number.isInteger(cliCfg.defaultTimeoutMs) && cliCfg.defaultTimeoutMs >= 30000 && cliCfg.defaultTimeoutMs <= 3600000
    ? cliCfg.defaultTimeoutMs : 600000
  const baseTimeout = Number.isInteger(runner.timeoutMs) && runner.timeoutMs > 0 ? runner.timeoutMs : defTimeout
  const idleOf = (v) => (Number.isInteger(v) && v >= 15000 && v <= 3600000 ? v : null)
  const idleTimeoutMs = idleOf(runner.idleTimeoutMs) ?? idleOf(cliCfg.idleTimeoutMs) ?? 300000

  // —— 预算 > budgetCap 且 ctx.jobs 可用 → 后台派发（advisor 先例整体复制）——
  if (baseTimeout > budgetCap) {
    const jobs = getJobsService(deps)
    if (jobs && typeof jobs.start === "function") {
      // D-06（§4.3）：single-flight 派发前检查（复合键 sessionId+mechanism——escalate 槽位）
      const inFlight = checkInFlightJob(threadKey, "escalate")
      if (inFlight) return inFlight
      const ctrl = new AbortController()
      try {
        const started = jobs.start({
          kind: "escalate-codex",
          label: "escalate codex (" + tag + ", " + Math.round(baseTimeout / 1000) + "s" + resumeTag + ")",
          outputLimitBytes: 131072,
          owner: agent,
          run: () => {
            const done = runCodexTask(deps, {
              taskText,
              cwd,
              sandbox,
              timeoutMs: baseTimeout, // jobs 免疫平台墙钟：全预算生效（run() 内自有 watchdog）
              idleTimeoutMs,
              runner,
              config,
              signal: ctrl.signal, // cancel → hooks.cancel → ctrl.abort
              ...(resumeThreadId ? { resumeThreadId } : {}),
            }).then((env) => {
              clearInFlightJob(threadKey, "escalate")
              // D-20：簿记在 done 回调成功分支恰好一次（失败不并 touched/不置 mutated）
              if (env.ok && env.text) {
                mergeEscalateTouched(state, parseTouchedFiles(env.text))
                // T2.4：成功交付记录/刷新 threadId（内存态 B14；失败/中止即弃——下方 delete）
                if (env.threadId) codexThreads.set(threadKey, { threadId: env.threadId, runner, label: tag })
                // F12（§2.3 写点）：交付簿记后落盘（工具返回早于簿记发生；fail-safe 仅 warn）。
                // R3 §5.4 注：落盘语义与同步/dsh 路径刻意不对称（jobs 路径落盘、sync/dsh
                // 内存由 advisor finalize 兜底——完整说明见下方同步路径成功分支注释）。
                try {
                  saveSessionState(agent.session.id, sessionStateViewWithGeneration(state), undefined, agent.session?.header?.cwd)
                } catch { /* N3 fail-safe */ }
                return {
                  status: "completed",
                  detail: "escalate delivered",
                  output: "escalate (" + tag + resumeTag + ") post-op report:\n" + env.text + effNote,
                }
              }
              codexThreads.delete(threadKey)
              const partial = env.text ? "\nPartial output:\n" + env.text.slice(0, 2000) : ""
              return {
                status: "failed",
                detail: "codex-cli " + env.code,
                output: "escalate (" + tag + ") ended: codex-cli " + env.code + " — "
                  + (env.userMessage || env.diagnostics || "unknown") + partial + codexFailureAdvisory(env) + effNote,
              }
            }, (e) => {
              clearInFlightJob(threadKey, "escalate")
              return {
                status: "failed",
                detail: String(e?.message ?? e),
                output: "escalate (" + tag + ") error: " + (e?.message ?? String(e)),
              }
            })
            done.catch(() => { /* 观察者兜底：reject 已转为 outcome */ })
            return { cancel: (reason) => { try { ctrl.abort(reason) } catch { /* noop */ } }, done }
          },
        })
        // D-06：登记槽位（settle 时经 done 回调清除）；D-05：branded string 直接渲染；
        // D-16：budgetCapMs ≥ 600000 时附不变式提醒（共享 codexJobsDispatchReply）
        setInFlightJob(threadKey, "escalate", started)
        return codexJobsDispatchReply({ prefix: "escalate", jobId: started, budgetMs: baseTimeout, budgetCapMs: budgetCap, detail: tag + (resumeThreadId ? " (resume)" : "") })
      } catch (e) {
        console.warn("[thincoder-suite] ctx.jobs 派发失败（" + (e?.message ?? String(e)) + "）——escalate 回落同步执行（预算按 budgetCap 截断）")
      }
    } else {
      console.warn("[thincoder-suite] ctx.jobs 不可用——escalate codex 预算 " + baseTimeout + "ms 截为 "
        + budgetCap + "ms 同步执行（建议装配 dsh-jobs-local + dsh-tool-jobs 走后台全预算派发）")
    }
  }

  // —— ≤ budgetCap 或 jobs 缺失/派发失败：同步执行（> cap 时钳制 + 尾部告警，绝不无声）——
  const effTimeout = Math.min(baseTimeout, budgetCap)
  const capNote = baseTimeout > budgetCap
    ? "\n[thincoder-suite] warning: escalate 预算 " + baseTimeout + "ms 超过 codexCli.budgetCapMs=" + budgetCap
      + "ms——已截断同步执行（平台 run_code 墙钟内；装配 dsh-jobs 可走后台全预算派发）"
    : ""
  try {
    const env = await runCodexTask(deps, {
      taskText,
      cwd,
      sandbox,
      timeoutMs: effTimeout,
      idleTimeoutMs,
      runner,
      config,
      signal,
      ...(resumeThreadId ? { resumeThreadId } : {}),
    })
    if (env.ok && env.text) {
      // D-20：成功分支簿记（同步路径与 done 回调同语义）。
      // R3 §5.4 注（簿记落盘语义——与 jobs 路径刻意不对称）：jobs 路径在 done 回调内
      // 簿记后即 saveSessionState 落盘（后台完成晚于工具返回，advisor 的 F12 写点不会
      // 再跑，必须自查落盘）；本同步/dsh 路径簿记只写内存态（state.touchedFiles /
      // mutatedThisRun），落盘由 advisor 的下一次 finalize（F12 写点 persistSessionState）
      // 兜底——同回合后续评审/收敛轮完成时一并带出。
      mergeEscalateTouched(state, parseTouchedFiles(env.text))
      // T2.4：仅成功交付记录 threadId（评审 #3：ABORTED/TIMEOUT 等失败即弃）；内存态 B14 不落盘
      if (env.threadId) codexThreads.set(threadKey, { threadId: env.threadId, runner, label: tag })
      return "escalate (" + tag + resumeTag + ") post-op report:\n" + env.text + capNote + effNote
    }
    codexThreads.delete(threadKey)
    const partial = env.text ? "\nPartial output:\n" + env.text.slice(0, 2000) : ""
    return "escalate (" + tag + ") ended: codex-cli " + env.code + " — " + (env.userMessage || env.diagnostics || "unknown")
      + partial + capNote + codexFailureAdvisory(env) + effNote
  } catch (e) {
    codexThreads.delete(threadKey)
    if (signal?.aborted) return "escalate (" + tag + ") aborted." + capNote
    return "escalate (" + tag + ") error: " + (e?.message ?? String(e)) + capNote
  }
}

/**
 * 执行一次飞刀。
 * @param deps { ctx, agent, config, state, signal }
 * @returns 术后病历文本（预算超 cap 且 jobs 可用时 = job 句柄 + UI-2 接续指令）
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

  // R3 §5.4（D-06 同步路径单飞扩展，补丁轮）：single-flight 检查提前到 escalate 机制全部
  // 入口（followup 续轮 / codex ≤cap 同步 / dsh 子代理路径）——同会话 escalate 后台 job
  // 在飞（>cap job 或任何已占位形态）期间任何新调用被拒（R2 同款拒绝文本，含在飞 job id
  // 与接续指引），关闭轮次/prior 双写窗口。派发点二次检查保留（runEscalateCodex jobs 分支）：
  // 入口 → jobs.start 之间的 await 窗口（effort 解析等）内仍可能被他方派发占位。
  const inFlightAtEntry = checkInFlightJob(threadKeyOf(agent.session?.id), "escalate")
  if (inFlightAtEntry) return inFlightAtEntry

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
    // D-02（R1）：followup 复用首次交付时已解析的 runner（effort 已按 codex 目录校验回落，
    // 不重复解析——避免 followup 平添目录依赖；语义由回归用例锁死）。
    // D-04（R2 §4.1）：followup 预算与首次同链解析（runner.timeoutMs → budgetCap 钳制/
    // jobs 判定）——不再把 runner.timeoutMs 原样透传（零余量撞墙）。
    const sandbox = prev.runner && prev.runner.sandbox === "danger-full-access" ? "danger-full-access" : "workspace-write"
    return runEscalateCodex(deps, {
      cliCfg,
      tag: prev.label,
      runner: prev.runner,
      sandbox,
      taskText: buildTaskBrief(task),
      resumeThreadId: prev.threadId,
      effNote: "",
    })
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
    // D-02 L1（R1）：codex 行 effort 统一走 resolveCodexRowEffort（codex models catalog；
    // 同名→保持 / 非法→最近支持档（等距向上取）/ off→不传 / 目录未命中→透传+告警）。
    // 交付后保存已解析 runner（followup 复用，见上）。
    // R1 code review 折入（R2 §4.5）：effort-note 前缀统一 "\n\n[thincoder-suite] "。
    const effRes = await resolveCodexRowEffort(deps, runner, runner.effort, resolveCodexCliGlobals(config).globals)
    const effNote = effRes.note ? "\n\n[thincoder-suite] " + effRes.note : ""
    // off → null（不传，codex 无 off）——effort 解析结果整体写回 runner（off 必须被清掉）
    const effRunner = { ...runner, effort: effRes.effort ?? undefined }
    return runEscalateCodex(deps, {
      cliCfg,
      tag,
      runner: effRunner,
      sandbox,
      taskText: CODEX_TASK_PREAMBLE + "\n\n" + buildTaskBrief(task),
      resumeThreadId: null,
      effNote,
    })
  }

  // D-02 L1（R1）：dsh 行 effort 按行自身 provider/model 解析（不是父代理路由）——
  // 非法档 → 最近支持档回落 + note；元数据不可得 → fail-open 透传 + 响亮告警。
  const effRes = await resolveSupportedEffort(deps.ctx?.llm ?? null, pick.provider, pick.model, pick.effort ?? undefined)
  // R1 code review 折入（R2 §4.5）：effort-note 前缀统一 "\n\n[thincoder-suite] "（与其余消费点对齐）
  const effNote = effRes.note ? "\n\n[thincoder-suite] " + effRes.note : ""

  // DP-1 方案 A（R2 §4.2，已终裁）：dsh 子代理路径内部截止——await run.result 此前无界等待
  //（旧注释「无墙钟」与平台事实矛盾：600s 墙钟下超限会被静默截断且无术后报告）。到点
  // abort + 响亮告警；如需长任务请走 codex runner（jobs 后台派发）或拆分 stages。
  const budgetCap = resolveCodexBudgetCapMs(config)
  const dshCtrl = new AbortController()
  let dshTimedOut = false
  const dshTimer = setTimeout(() => {
    dshTimedOut = true
    console.warn("[thincoder-suite] escalate dsh 子代理路径超内部截止（budgetCapMs=" + budgetCap
      + "）——abort 子代理（dsh 路径受平台墙钟约束；如需长任务请走 codex runner 或拆分 stages）")
    try { dshCtrl.abort(new Error("escalate dsh subagent deadline reached")) } catch { /* already aborted */ }
  }, budgetCap)
  dshTimer.unref?.()
  const forwardSignal = () => { try { dshCtrl.abort() } catch { /* already aborted */ } }
  if (signal) {
    if (signal.aborted) forwardSignal()
    else signal.addEventListener("abort", forwardSignal, { once: true })
  }

  let run
  try {
    const request = {
      prompt: [{ type: "text", text: buildTaskBrief(task) }],
      parent: agent,
      signal: dshCtrl.signal, // 截止 + 父级 abort 二合一（父 signal 经 forwardSignal 汇入）
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
    clearTimeout(dshTimer)
    return "escalate (" + tag + ") failed to start: " + (e?.message ?? String(e))
  }

  let result
  try {
    result = await run.result
  } catch (e) {
    if (dshTimedOut) {
      return "escalate (" + tag + ") ended: dsh 子代理路径超内部截止（budgetCapMs=" + budgetCap
        + "）到点，子代理已 abort——dsh 子代理路径受平台墙钟约束，超限任务被终止；如需长任务请走 codex runner 或拆分 stages。"
    }
    if (signal?.aborted || e?.name === "AbortError") return "escalate (" + tag + ") aborted."
    return "escalate (" + tag + ") error: " + (e?.message ?? String(e))
  } finally {
    clearTimeout(dshTimer)
    try { await run.dispose() } catch { /* already disposed */ }
  }

  const stopReason = result?.stopReason ?? "unknown"
  const outputText = (result?.output ?? [])
    .filter(b => b?.type === "text").map(b => b.text ?? "").join("\n").trim()

  if (dshTimedOut) {
    return "escalate (" + tag + ") ended: dsh 子代理路径超内部截止（budgetCapMs=" + budgetCap
      + "）到点，子代理已 abort——dsh 子代理路径受平台墙钟约束，超限任务被终止；如需长任务请走 codex runner 或拆分 stages。"
      + "\nPartial output:\n" + outputText.slice(0, 2000) + effNote
  }

  if (stopReason !== "completed") {
    // D-20：失败交付不簿记（不并 touched/不置 mutated）——partial 内 Touched 行仅 advisory
    const diag = result?.diagnostic ? " — " + result.diagnostic : ""
    return "escalate (" + tag + ") ended: " + stopReason + diag
      + "\nPartial output:\n" + outputText.slice(0, 2000) + codexFailureAdvisory({ text: outputText, code: null }) + effNote
  }
  // D-20：成功分支簿记——飞刀改动并入父级评审范围（advisor 的 touchedFiles 兜底必须看到）
  mergeEscalateTouched(state, parseTouchedFiles(outputText))
  return "escalate (" + tag + ") post-op report:\n" + (outputText || "(empty report)") + effNote
}
