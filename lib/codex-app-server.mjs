// codex-app-server.mjs — codex app-server 通道（批 33，新 runner kind `codex-app-server`）。
// 设计档：docs/2026-10-14-codex-app-server-design.md（FR-2/FR-3 分派 · FR-5 失败面 · §6 机制
// 伪代码 · §8 防偏离 · §9 边界）；需求档：docs/2026-10-14-codex-app-server-requirements.md。
//
// ★ 本档 = 设计档 §8「负向断言」的 **grep 作用域**：app-server 腿**独立成档**，档内**不得**出现
//   CLI 腿的三个形状字面（临时输出文件开关 · 事件流开关 · codexCli 全局节的**可执行字段**名）——
//   那三样都属于 `lib/codex-adapter.mjs` 的子进程通道。本档**只**经平台 provider 的 app-server
//   传输面：不建临时文件、不组装 argv、不探测本机可执行文件（因此也不依赖 CLI 腿的可用性预检）。
//
// ★ 契约（N-1，硬约束）：平台 `codex` provider 的 `capabilities` = NO_START_CAPABILITIES（**不声明
//   任何可选能力**）⇒ 请求**只发** `prompt` / `parent` / `signal` / `label` 四键；**绝不**带
//   agentOptions / toolFilter / persona / maxDepth / outputSchema（多传即被平台的
//   `assertCapabilities` 拒绝——见 `@deepseek-ai/dsh-subagent` 的同名方法）。
//
// ★ 无人值守边界（N-6）：该 provider 对审批**一律拒绝/cancel** ⇒ 本通道是**只读定位**，不可用于
//   写任务；eng_coder / escalate 侧有**具名 fail-closed 守卫**（`lib/index.mjs` 的工具入口与
//   `lib/escalate.mjs` 的行分派），本档不承担守卫职责（它只负责「怎么问」）。
//
// ★ 本通道**不提供 usage**：provider 不回显 token 计数 ⇒ 调用方**不得**渲染空占位
//  （设计档 §6 @post 的明写约束）。

import { resolveCodexCliGlobals } from "./codex-adapter.mjs"

/** 平台 provider 注册名（设计档 §2 E4 实测 = `codex`；换版时由 contractWatch 的版本哨兵先告警）。 */
export const CODEX_APP_SERVER_PROVIDER = "codex"

/**
 * FR-4 的**告知句**（单一事实源）：行里配了 `model` / `effort` 而 kind 是本通道 ⇒ 不消费，但
 * **如实告知**（用户可见面：行展示标签旁 · digest 行 · 设置页提示），**绝不静默忽略**。
 * ★ 该句只进**用户可见面**，**不进外发 prompt**（进了会白烧 token 且用户看不见——FR-4 明写）。
 */
export const CODEX_APP_SERVER_MODEL_EFFORT_NOTE = "本通道（codex-app-server）不消费 model/effort——模型由本机 Codex 配置决定（行里这两个字段只用于展示标签，不参与请求）"

/** 从注入缝取平台 subagents 服务（`deps.subagents` 优先，其次 `deps.ctx.subagents`）。 */
function pickSubagents(deps) {
  const direct = deps ? deps.subagents : null
  if (direct && typeof direct.start === "function") return direct
  const viaCtx = deps && deps.ctx ? deps.ctx.subagents : null
  if (viaCtx && typeof viaCtx.start === "function") return viaCtx
  return null
}

/** 平台错误码（`SubagentError.code`：NO_PROVIDER / UNSUPPORTED_CAPABILITY…）；无码 ⇒ `"error"`。 */
function platformCode(e) {
  return e && typeof e.code === "string" && e.code !== "" ? e.code : "error"
}

/** 平台错误原文（**逐字**——失败面必须可诊断，不吞、不改写成空话）。 */
function platformMessage(e) {
  const m = e && e.message !== undefined && e.message !== null ? String(e.message) : String(e)
  return m === "" ? String(e) : m
}

/** 子代理结果 → 正文（平台把最终答复放在 `output` 的文本块序列里）。 */
function collectText(result) {
  const blocks = result && Array.isArray(result.output) ? result.output : []
  return blocks.filter((b) => b && b.type === "text").map((b) => b.text ?? "").join("\n").trim()
}

/**
 * 失败证据串（FR-5）：把平台**原样**给出的东西带进失败行——`stopReason` 原文、
 * provider 回传的 `diagnostic`（若有）以及平台错误码映射关系。**不得**出现「不可诊断」这类
 * 无信息量的空话（设计档 §5 FR-5 明写）。
 * @param {object|undefined} result 平台子代理终局结果
 * @returns {string} 单行证据（调用方按自己的面渲染，本档不做截断——截断是各消费面的事）
 */
function failureEvidence(result) {
  const stopReason = result && typeof result.stopReason === "string" ? result.stopReason : null
  const parts = ["platform stopReason=" + (stopReason === null ? "(none)" : stopReason)]
  const diag = result && result.diagnostic
  if (diag !== undefined && diag !== null && String(diag) !== "") parts.push("platform diagnostic: " + String(diag))
  if (stopReason === "max-tokens") {
    parts.push("平台把 codexErrorInfo=contextWindowExceeded 映射为本值（上下文窗口超限）")
  }
  if (stopReason === "error") {
    // 诚实指向唯一还能拿到原文的地方：provider 自己的错误日志（`subagent-codex: child run failed`）
    parts.push("provider 未回传诊断文本——该轮次错误原文见宿主日志 provider 的 child run failed 行")
  }
  if (stopReason === "aborted") parts.push("本地取消（平台把本地取消映射为 aborted）")
  if (stopReason === "completed") parts.push("平台报 completed 但没有任何最终正文（文本块为空）")
  return parts.join("；")
}

/**
 * 跑一次 codex app-server 行任务（**只读定位**用；不建临时文件、不组装 argv）。
 *
 * @pre   `opts.parent` 是带 `session.header.cwd` 的父 agent 对象（平台 provider 取子进程工作目录）
 * @pre   调用方**已按 runner.kind 分派**到本腿（本函数不读 runner、不校验 kind——分派是调用方的职责）
 * @post  请求**只发** `{ prompt, parent, signal, label }` 四键（键集合逐字：多一个键即违约）
 * @post  返回 `{ ok, text, stopReason, errorInfo }`：平台失败**原样上浮**（stopReason / 诊断原文），
 *        不吞、不映射成新枚举；**不含 `usage`**（平台不回显，调用方不得渲染空占位）
 * @post  拿到 run 句柄时**必定 dispose**（整个 app-server 进程树的拆除）——派发成功之后的
 *        成功 / 平台失败 / 抛错三条退出路径都经 finally（派发本身抛错时没有句柄可拆）
 * @param {object} deps 注入缝：`{ subagents }` 或 `{ ctx: { subagents } }`
 * @param {{taskText: string, parent: object, signal?: AbortSignal, label?: string}} opts
 * @returns {Promise<{ok: boolean, text: string, stopReason: string|null, errorInfo: string|null}>}
 */
export async function runCodexAppServerRow(deps, opts) {
  const o = opts && typeof opts === "object" ? opts : {}
  const taskText = typeof o.taskText === "string" ? o.taskText : ""
  const label = typeof o.label === "string" && o.label.trim() !== "" ? o.label : "codex app-server"
  // §9 空/畸形 prompt：**请求前本地校验**（非空文本块），失败即回、不下发。
  if (taskText.trim() === "") {
    return {
      ok: false, text: "", stopReason: null,
      errorInfo: "本地校验未通过：任务文本为空（本通道只接受非空文本块）——未下发任何请求",
    }
  }
  const subagents = pickSubagents(deps)
  if (!subagents) {
    // §9 平台未装配：**fail-closed 具名原因**（provider 名 + 指引）。绝不静默降级到别的通道。
    return {
      ok: false, text: "", stopReason: null,
      errorInfo: "平台 subagents 服务不可用（ctx.subagents 缺失）⇒ 无法派发 provider \"" + CODEX_APP_SERVER_PROVIDER
        + "\"；本通道只读，请装配平台 subagent provider（@deepseek-ai/dsh-subagent-codex）"
        + "，或把该行的 runner 改回 codex-cli",
    }
  }
  let run = null
  try {
    // ★ 四键逐字（见档头 N-1 契约）；label 走平台 descriptor（不受能力闸约束）
    run = await subagents.start(CODEX_APP_SERVER_PROVIDER, {
      prompt: [{ type: "text", text: taskText }],
      parent: o.parent,
      signal: o.signal,
      label,
    })
  } catch (e) {
    return {
      ok: false, text: "", stopReason: platformCode(e),
      errorInfo: "provider \"" + CODEX_APP_SERVER_PROVIDER + "\" 派发失败：" + platformMessage(e),
    }
  }
  try {
    const pending = run && run.result !== undefined && run.result !== null ? run.result : run
    const result = await pending
    const text = collectText(result)
    const stopReason = result && typeof result.stopReason === "string" ? result.stopReason : null
    if (stopReason === "completed" && text !== "") return { ok: true, text, stopReason, errorInfo: null }
    // 平台终局非正常 / 无正文 ⇒ 失败面**原样上浮**（stopReason 原文 + 诊断，见 failureEvidence）
    return { ok: false, text, stopReason: stopReason === null ? "error" : stopReason, errorInfo: failureEvidence(result) }
  } catch (e) {
    // 平台约定 result 发布后不再 reject；此处是防御面（夹具/换版都可能走到）
    return {
      ok: false, text: "", stopReason: platformCode(e),
      errorInfo: "provider \"" + CODEX_APP_SERVER_PROVIDER + "\" 轮次失败：" + platformMessage(e),
    }
  } finally {
    // 进程树拆除（不 dispose 会把 codex app-server 进程留在系统里）；teardown 失败不覆盖上面的结果
    try {
      if (run && typeof run.dispose === "function") await run.dispose()
    } catch { /* teardown 失败不改变已达成的终局 */ }
  }
}

/**
 * consult / advisor 行的**展示标签**（app-server 行 → `codex-app-server:<model|default>`）。
 * @pre  `runner` 已归一化；`runner.kind === "codex-app-server"`
 * @post 返回值恰为 `"codex-app-server:" + (runner.model ?? globals.model ?? "default")`
 *        —— **model 只用于标签**，不参与任何请求（设计档 §6 @post 逐字）
 * @param {object} runner 归一化后的 runner 行
 * @param {object} [globals] `resolveCodexCliGlobals` 的 globals（行未配 model 时的展示兜底）
 * @returns {string}
 */
export function codexAppServerRowLabel(runner, globals) {
  const g = resolveCodexCliGlobals(globals ? { codexCli: globals } : {}).globals
  return "codex-app-server:" + (runner && runner.model ? runner.model : (g.model ?? "default"))
}
