// task-commands.mjs — 批 36-补 C 面：**四条用户 slash 命令**（`/task_list` `/task_add` `/task_done` `/task_claim`）。
//
// 设计依据：docs/2026-10-16-task-ledger-design.md **§16.3**（官方命令通道的逐字源码由父侧从宿主
// `app.asar` 里挖出，形如 `@deepseek-ai/dsh-command-compact`）：
//
//   const inject = ["commands", "compaction"];
//   function apply(ctx) {
//     ctx.effect(function* () {
//       yield async () => { await Promise.allSettled(active) };      // teardown
//       yield ctx.commands.register({ definitionId, name, description, handler });
//     }, "command-compact lifecycle");
//   }
//   handler(invocation) => Promise<{ kind: "success" | "error", text }>
//   invocation = { rawInput, agent, signal, commandId }
//
// ★ 三条硬约束（逐条对应设计档 §16.3 的「两条硬约束」＋ 本单铁律）：
//   ① **`inject` 数组一字不扩**：命令服务用 `ctx.get("commands")` 取（cordis 的 `ctx.get` 显式豁免
//      inject 要求）。**绝不能**把 `commands` 写进 `lib/index.mjs` 的 `inject`：声明了但宿主没注册的
//      服务会让**整个插件永不激活**（本仓已踩过 `goals` / `betterSidebar` 两次）。
//      缺服务 ⇒ **不抛**、不注册、只 warn —— **工具与看板照常**（腿 T-19）。
//   ② **不 import 宿主的任何 `@deepseek-ai/*` 包**：`CommandDefinitionId` 只是**类型品牌**，运行时
//      就是**纯字符串**。若某天真做运行时校验而抛错 ⇒ **如实报错**（warn 带原始 message），
//      **不许**为此去加宿主依赖（腿 T-15 的依赖面锁）。
//   ③ **四条命令全部走同一道写门**（`lib/tasks.mjs` 的 `applyTaskCreate` / `applyTaskTransition` /
//      `applyTaskClaim`）：命令层**只做参数切分 + 结果翻译**，**不得**自己校验状态机、不得自己写盘。
//      证据形态：`/task_done` **不带凭据**时代码会一路走到写门、由写门的 `evidence-required` 拒掉，
//      并把写门的拒绝码原样回给用户（腿 T-20）。
//
// 零新增依赖：只 import `node:` 内建（本档一个都不需要）与仓内相对模块。
import {
  applyTaskClaim, applyTaskCreate, applyTaskTransition, readTasksView, sessionIdOf,
} from "./tasks.mjs"
import { buildTasksBoardPayload, renderBoardText } from "./tool-tasks.mjs"

/** 四条命令名（逐字；测试与文档共用这一份清单）。 */
export const TASK_COMMAND_NAMES = Object.freeze(["task_list", "task_add", "task_done", "task_claim"])

/**
 * `definitionId` 的前缀（**纯字符串**，不是品牌类型）。
 * ★ 刻意写成 `@dsh-external/<本插件包名>/<命令名>`：与宿主对自家命令的做法同形
 *   （`@deepseek-ai/dsh-command-compact`），但**不 import 任何宿主包**。
 */
export const TASK_COMMAND_DEFINITION_PREFIX = "@dsh-external/dsh-thincoder-suite/"

/** 命令的用法提示（四条共用的错误文案来源）。 */
export const TASK_COMMAND_USAGE = Object.freeze({
  task_list: "/task_list —— 打印看板（本会话 / 待接手 / 全部；只读）",
  task_add: "/task_add <标题> | <怎么算完成> —— 建一条任务（`|` 后必须写清完成判据）",
  task_done: "/task_done <id> | <凭据> —— 标完成，**必须**写清「跑了什么、看到什么」",
  task_claim: "/task_claim <id> —— 接手（只改归属，不改状态）",
})

/**
 * 从 `invocation.rawInput` 里剥出**参数部分**。
 * 兼容两种输入形态（宿主的 `rawInput` 到底含不含命令名**未经实测** ⇒ 两种都吃，剥不到就原样当参数）：
 *   `"/task_add 标题 | 判据"` 与 `"标题 | 判据"`。
 */
export function commandArgsOf(name, rawInput) {
  const raw = String(rawInput ?? "").trim()
  if (raw === "") return ""
  const m = /^\/?([A-Za-z][A-Za-z0-9_-]*)\s*([\s\S]*)$/.exec(raw)
  // ★ 批 42 ⑨：谓词只认**首个捕获组逐字相等**（不再有 `startsWith("task_")` 兜底）。
  //   旧兜底会把「别的命令名 + 参数」当成自己的参数：`/task_add x` 交给 `/task_done` 时
  //   会把 `x` 剥出来当 id（误匹配 ⇒ 报出与用户输入无关的 `id-missing`）。
  //   名字不匹配 ⇒ **原样返回整串**（含命令名），由写门拒 —— 参数保持用户给的原文。
  if (m && m[1] === name) return m[2].trim()
  return raw
}

/** 按**第一个** `|` 切成两段（只切一次：判据/凭据里再出现 `|` 不会把内容切碎）。 */
export function splitPipe(rest) {
  const s = String(rest ?? "")
  const i = s.indexOf("|")
  if (i < 0) return { head: s.trim(), tail: "" }
  return { head: s.slice(0, i).trim(), tail: s.slice(i + 1).trim() }
}

const okText = (text) => ({ kind: "success", text })
const errText = (text) => ({ kind: "error", text })

/** 写门结果 → 命令回执（**零校验**：只有翻译；拒绝码原样带出，便于用户/测试对齐）。 */
function gateText(command, r) {
  if (!r || r.ok !== true) {
    return errText("/" + command + " 没有写入任何内容：" + String(r?.reason ?? "原因未知") + "（拒绝码 " + String(r?.code ?? "?") + "）")
  }
  if (command === "task_add") return okText("/task_add 已建 " + r.id + "（待办），rev → " + r.rev)
  if (command === "task_claim") {
    return okText("/task_claim " + r.id + " 已接手：owner → " + String(r.owner ?? "（无）")
      + "（旧 owner = " + String(r.claimedFrom ?? "（无归属）") + "；状态仍是 " + r.status + "），rev → " + r.rev)
  }
  return okText("/task_done " + r.id + " → " + r.status + "，rev → " + r.rev)
}

/**
 * 组装四条命令的 **definition**（`{definitionId, name, description, handler}`）。
 * @param {{wsOf: (agent)=>string|null, configOf?: ()=>object, driftOf?: (sessionId)=>object|null,
 *          track?: (p: Promise) => Promise}} deps
 *   `wsOf` 必须返回**会话工作区根**；`track` 由注册器注入（在飞 handler 登记，teardown 等它们落地）。
 * @post 每个 handler ⇒ `Promise<{kind:"success"|"error", text}>`（**永不抛**：异常也翻译成 error 回执）
 */
export function makeTaskCommandDefs(deps) {
  const wsOf = typeof deps?.wsOf === "function" ? deps.wsOf : () => null
  const configOf = typeof deps?.configOf === "function" ? deps.configOf : () => ({})
  const driftOf = typeof deps?.driftOf === "function" ? deps.driftOf : () => null
  const track = typeof deps?.track === "function" ? deps.track : (p) => p
  const noWs = (cmd) => errText("/" + cmd + ": 无法确定工作区根（本会话没有 cwd）——台账按**工作区**落盘，无工作区即不可用。")

  /** 统一的 handler 外壳：解析 → 调写门/读面 → 翻译；任何异常 ⇒ error 回执（**绝不抛**）。 */
  const handlerOf = (name, work) => (invocation) => track((async () => {
    try {
      const agent = invocation?.agent ?? null
      const ws = wsOf(agent)
      if (!ws) return noWs(name)
      return await work({ invocation, agent, ws, sid: sessionIdOf(agent?.session?.id) })
    } catch (e) {
      return errText("/" + name + ": 执行失败（" + String(e?.message ?? e) + "）——没有写入任何内容")
    }
  })())

  const listDef = {
    definitionId: TASK_COMMAND_DEFINITION_PREFIX + "task_list",
    name: "task_list",
    description: "Print the personal task ledger board (this session / 待接手 / all). Read-only.",
    handler: handlerOf("task_list", async ({ ws, sid }) => {
      // 只读：与 `task_list` 工具的 board 模式**同一个载荷**（同一个读函数派生）
      const payload = buildTasksBoardPayload({ ws, sessionId: sid, config: configOf(), drift: driftOf(sid) })
      return okText(renderBoardText(payload))
    }),
  }

  const addDef = {
    definitionId: TASK_COMMAND_DEFINITION_PREFIX + "task_add",
    name: "task_add",
    description: "Add one task: /task_add <title> | <how to verify completion>. Goes through the same write gate as task_add.",
    handler: handlerOf("task_add", async ({ ws, invocation, sid }) => {
      const { head: title, tail: check } = splitPipe(commandArgsOf("task_add", invocation?.rawInput))
      if (title === "" || check === "") {
        // ★ 2026-10-17 **如实订正注释**（独立审计 Q4 指出原注释不准确）：
        //   这**不是**「判定仍由写门做」—— 它确实**先于写门**拦下了空标题/空判据，
        //   把写门的 `title-required` / `check-required` 挡在外面。
        //   性质 = **参数形态**（用户没按 `/task_add <标题> | <怎么算完成>` 的格式写）的前置提示，
        //   **不是**状态机/凭据校验；代价是这一种输入看不到写门的拒绝码。
        //   ⇒ 该例外已**登记**在设计档 §16.5「实现期定死的三处」里，不隐藏。
        return errText("用法：" + TASK_COMMAND_USAGE.task_add + "（`|` 两边都不能为空 —— 没写怎么算完成 = 许愿不是任务）")
      }
      const view = readTasksView(ws) // 先读（拿 rev），再写 —— 与工具面同一形态
      const r = applyTaskCreate(ws, { kind: "work", title, check, expectedRev: view.rev, sessionId: sid })
      return gateText("task_add", r)
    }),
  }

  const doneDef = {
    definitionId: TASK_COMMAND_DEFINITION_PREFIX + "task_done",
    name: "task_done",
    description: "Mark one task done: /task_done <id> | <evidence>. The evidence is required by the write gate.",
    handler: handlerOf("task_done", async ({ ws, invocation }) => {
      const { head: id, tail: evidence } = splitPipe(commandArgsOf("task_done", invocation?.rawInput))
      if (id === "") return errText("用法：" + TASK_COMMAND_USAGE.task_done)
      // ★★ **凭据一律交给写门判**：此处**不做** `evidence === ""` 的前置校验 ——
      //    否则「无凭据 ⇒ 拒且零写入」就变成命令层自己判的，写门的凭据门被绕过（腿 T-20 咬的就是这一条）。
      const view = readTasksView(ws)
      const r = applyTaskTransition(ws, { id, to: "完成", evidence, expectedRev: view.rev })
      return gateText("task_done", r)
    }),
  }

  const claimDef = {
    definitionId: TASK_COMMAND_DEFINITION_PREFIX + "task_claim",
    name: "task_claim",
    description: "Claim one entry for this session (handoff): /task_claim <id>. Changes only the owner.",
    handler: handlerOf("task_claim", async ({ ws, invocation, sid }) => {
      const { head: id } = splitPipe(commandArgsOf("task_claim", invocation?.rawInput))
      if (id === "") return errText("用法：" + TASK_COMMAND_USAGE.task_claim)
      const view = readTasksView(ws)
      const r = applyTaskClaim(ws, { id, sessionId: sid, expectedRev: view.rev })
      return gateText("task_claim", r)
    }),
  }

  return [listDef, addDef, doneDef, claimDef]
}

/**
 * 在宿主上注册四条命令（**缺服务 ⇒ 不抛、不注册、只 warn**）。
 *
 * @param {object} ctx — 宿主 ctx（命令服务经 `ctx.get("commands")` 取；**不写进 inject**）
 * @param {{wsOf, configOf?, driftOf?, warn?: (msg: string) => void}} deps
 * @returns {{registered: string[], skipped: boolean, reason?: string}}
 *   `skipped: true` = 没有命令服务（工具与看板**照常**，腿 T-19）
 *
 * @post 生命周期照官方形态：`ctx.effect(function*(){ yield <teardown>; yield <register>… }, "label")`
 *       —— teardown 先 `Promise.allSettled(在飞的 handler)`，再让各个 disposer 依次收尾
 */
export function registerTaskCommands(ctx, deps) {
  const warn = typeof deps?.warn === "function" ? deps.warn : (m) => console.warn(m)
  let commands = null
  try { commands = ctx?.get?.("commands") ?? null } catch { commands = null }
  if (!commands || typeof commands.register !== "function") {
    warn("[thincoder-suite] commands 服务缺席 ⇒ /task_* 四条命令未注册（工具与看板照常，不影响台账本体）")
    return { registered: [], skipped: true, reason: "no-commands-service" }
  }

  /** 在飞 handler（teardown 要等它们落地，官方 `/compact` 同款语义）。 */
  const active = new Set()
  const track = (p) => {
    active.add(p)
    Promise.resolve(p).then(() => active.delete(p), () => active.delete(p))
    return p
  }
  const defs = makeTaskCommandDefs({ ...deps, track })
  const registered = []
  const failed = []
  const registerOne = (def) => {
    try {
      const d = commands.register(def)
      registered.push(def.name)
      return d
    } catch (e) {
      // ★ **如实报错**（不静默）：典型成因 = 宿主对 `definitionId` 做运行时品牌校验。
      //   处置 = **只 warn、不中断**（其余三条与工具/看板不受影响），**也不**为此去加宿主依赖。
      failed.push(def.name)
      warn("[thincoder-suite] 命令 /" + def.name + " 注册失败（已跳过）：" + String(e?.message ?? e))
      return null
    }
  }

  const lifecycle = function* () {
    // ① teardown（官方形态：先登记清理器，再登记资源）
    yield async () => { await Promise.allSettled([...active]) }
    // ② 四条命令
    for (const def of defs) yield registerOne(def)
  }

  if (typeof ctx?.effect === "function") {
    try {
      ctx.effect(lifecycle, "thincoder-suite: /task_* commands")
    } catch (e) {
      warn("[thincoder-suite] 命令生命周期登记失败（已跳过 /task_*）：" + String(e?.message ?? e))
      return { registered: [], skipped: true, reason: "effect-failed" }
    }
  } else {
    // 兜底（测试缝 / 极简 ctx）：直接跑一遍生命周期，不等 teardown
    const it = lifecycle()
    let step = it.next()
    while (!step.done) step = it.next()
  }
  return { registered, skipped: false, ...(failed.length > 0 ? { failed } : {}) }
}
