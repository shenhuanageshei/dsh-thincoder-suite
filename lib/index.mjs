// index.mjs — 插件入口：工具注册 + 提示词 section + 写门禁 + 会话清理。
// 零 bare import 工程决策（纯 JS 直发）：
// 当插件经 junction 安装时，Node 会把它 realpath 化，从安装目录向上解析不到
// @deepseek-ai/dsh-tools / schemastery / cordis（实测 ERR_MODULE_NOT_FOUND）；
// 同类零依赖插件（只导出 name/inject/apply 三件套、不 import cordis）在本机生态里已有先例。
// ★ 2026-09-28：此处原先点名引证的是 dsh-task-status——它因未适配 0.1.7 且改写
// `ctx.jobs.read`（见 docs/job-output-fallback.md §0）已被卸载，作为先例不再合适，故不再点名。
// 因此：工具手工构造 ToolDefinition 形状（JSON Schema parameters + output 契约），
// 配置经 apply(ctx, config) 尽力解析（预设 group config / patch entry config 均可传入）。
import { sessionState, dropSession, dropAllSessions, engEffective, restoreSessionState } from "./state.mjs"
import {
  runAdvisorReview, runAdvisorConfigTool,
  resolveAdvisorRoute, resolveIncludeProjectGuide,
  isValidEffort, isValidTimeoutMs, isModelField, isValidEngCoderMaxTokens,
  isValidAdvisorMaxOutputTokens,
  isValidAdvisorContextTokens,
  ADVISOR_MAX_OUTPUT_TOKENS_MIN, ADVISOR_MAX_OUTPUT_TOKENS_MAX,
  ADVISOR_CONTEXT_TOKENS_MIN, ADVISOR_CONTEXT_TOKENS_MAX,
  EFFORT_LEVELS, ADVISOR_TIMEOUT_MIN_MS, ADVISOR_TIMEOUT_MAX_MS,
  advisorGenerationOf, bumpAdvisorGeneration, sessionStateViewWithGeneration,
  clearCodexFailureCount,
  // 批 4（§5.6 工具层预检）：两入口同判定——工具层给快速指引，核心层做直调防线。
  DESIGN_STRIKE_LIMIT, designDocKey, designStrikes, settlementGuardText,
  clearDesignSettlementStrikes,
  // 批 6b（守卫 E）：预闸的槽位只读访问器（扫全表找武装中的 design 冻结窗口）
  designFreezeSet,
} from "./advisor.mjs"
import {
  startConsultSession, stopConsultSession, cleanupConsultSessions,
  consultDigestionGate, consultLedgerOrphans,
} from "./consult.mjs"
import { runEscalate } from "./escalate.mjs"
import { engineeringToggle, makeWriteGate, makeDocFreezeGate, runEngCoder, attachEngineeringSection, targetPathOf } from "./eng.mjs"
// 批 32 / D-62：**活动路由**（会话当前路由）单一事实源——`agent.options` 是创建期快照，
// 拿它当「主代理路由」会让 advisor 兜底路由与硬停指纹都看不见中途换模型（真机事故见该档头）。
import { liveAgentRoute } from "./agent-route.mjs"
import { loadSessionState, saveSessionState, removeSessionState } from "./session-store.mjs"
// 批 7（D-P9/J11）：声明键的前置校验复用**同一个单一权威**（标尺必须是文档）
import { isDocPath } from "./path-kind.mjs"
import {
  loadUserConfig, saveUserConfig, clearUserConfig, mergeGlobalConfig,
  effectiveGlobalConfig,
  DSHS_BACKGROUND_TIMEOUT_MIN_MS, DSHS_BACKGROUND_TIMEOUT_MAX_MS,
  isValidDshBackgroundTimeoutMs,
  CONSULT_TIMEOUT_MIN_MS, CONSULT_TIMEOUT_MAX_MS, isValidConsultTimeoutMs,
  ENG_TOKEN_TTL_MIN_MS, ENG_TOKEN_TTL_MAX_MS, isValidEngTokenTtlMs,
} from "./config-store.mjs"
import { DISCIPLINE, MAIN_EXTRA } from "./prompts.mjs"
import { validateRunnerValue, normalizeRunnerValue, resolveCodexCliGlobals, discoverCodexModels, sweepStaleCodexTempDirs } from "./codex-adapter.mjs"
import { clearCodexThread } from "./escalate.mjs"
// 批 28（D28-2 / A28-5）：契约面基线单一事实源——版本哨兵与 contractWatch 巡检工具共用同一份；
// 十条触点谓词的唯一实现住在该模块（批 34 C11 起 9→10：ps10 = anti-drift 的四个宿主面）（test/platform-surface.test.mjs 亦是它的消费方，不存在第二份字面）。
import {
  runVersionSentinel, readPlatformVersion, evaluatePlatformSurfaceLocks, jobsDirStats,
  PLATFORM_VERSION_BASELINE, BASELINE_RECORDED_AT,
} from "./contract-baseline.mjs"
// 批 34（长任务防漂，设计令牌 9c126ca2-… 轮 4 VERDICT: PASS）：机制本体单点收口在本模块；
// 本档只 import，**零机制逻辑**（探测降级 / 门 / 标记 / 推回 / 接管 全在那边实现与自测）。
import {
  resolveAntiDriftConfig, validateConfigWrite, probeAntiDriftSurfaces,
  setCriteria, getCriteria, clearCriteria, recordVerify, stampVerified,
  noteWrite, noteShell, gateDecision, renderAntiDriftLine, onTurnStopping, onAgentCreated,
  dropDomainSession, dropCriteriaSession, turnIndexOf, dropTurnShapeWarn,
  noteToolCall, markStallNoticed, stallNotice, producerSource, producerContent, promotePending,
  antiDriftStateView, restoreAntiDriftState,
  // 批 36（个人任务台账）：看板「防漂移状态区」（FR-11）**只读**复用这两个既有读数——不新建状态。
  outstandingDebts, domainState,
} from "./anti-drift.mjs"
// 批 36（个人任务台账 + 侧栏看板，设计档 docs/2026-10-16-task-ledger-design.md）：
//   机制本体在 `lib/tasks.mjs`（唯一写门 + 唯一读函数），工具面与看板载荷在 `lib/tool-tasks.mjs`。
//   本模块**只注册接线 + 把任务摘要并入既有注入行**（零机制逻辑；**不新开 systemPrompt.context**——FR-4/T-15）。
import { readTasksView, renderTaskDigest, resolveLedgerConfig, isValidLedgerMode, isValidCopyTemplate, isValidDocPathList, MAX_DOC_PATHS } from "./tasks.mjs"
import { makeTaskTools, buildTasksBoardPayload, buildTaskClaimResult } from "./tool-tasks.mjs"
// 批 36-补（C 面：用户命令）：四条 `/task_*` slash 命令。**命令服务一律 `ctx.get("commands")`** ——
// 绝不写进本档的 `inject` 数组（声明了但宿主没注册的服务会让整个插件永不激活）。
import { registerTaskCommands } from "./task-commands.mjs"

/** Cordis 插件名。 */
export const name = "thincoder-suite"

/** 所需服务（**硬依赖**；cordis 白名单语义 —— 读一个未在此声明的服务属性会**当场抛错**）。
 *
 * ★ 2026-10-15 修复：插件"bundle 装上了、客户端也在、但 11 个工具一个都不可用"的真因。
 *   探针实测的异常原文 = `Error: cannot get property "goals" without inject`。
 *   cordis 的属性读取是**白名单**：读未声明的服务**当场抛**，且**可选链 `?.` 救不了**（抛在读取
 *   那一刻）⇒ 该异常把整个 `apply` 打断，工具/路由/监听器全部注册不上；而模块本身仍被 import
 *   （所以现象是"模块有痕、功能全无"，探测模块是否被加载根本无法定位到它）。
 *
 *   **本仓早已写死这条纪律**——先例见 :717-720（取 connection 那一处）：
 *     服务一律 `ctx.get("X")`（cordis 原文：Read a service from the store **without the inject
 *     requirement**），**不**用属性读；且**不把可选服务写进 inject**——required 语义会让没有该
 *     服务的宿主**整个插件拒起**。夜班新增的反漂移档在探 goal 服务时改回了属性读 ⇒ 本次修复。
 *
 * ★ 声明集合 =「代码确实按**属性**读取」∩「宿主确实注册」。两边都必须精确：
 *   多一个 ⇒ 没有该服务的宿主整个插件永久 pending；少一个 ⇒ 当场抛错打断 apply。**都是全挂。**
 *     · `tools` / `systemPrompt` / `webServer` / `llm` / `subagents` —— 本插件的功能本体
 *       （advisor/consult 要 `llm`，eng_coder 要 `subagents`），探针实测五个服务均已注册
 *     · `goals` **刻意不声明**：插件对它只有一处**探测**用途（anti-drift 的 FR-8 面探测），
 *       且本来就写了 goals 缺席的降级路径（腿 A-12 的『宿主 goal 服务缺席』行）；运行时取值
 *       `goalViewOf` 早已走 `ctx.get("goals")`。把它写成硬依赖 = 同一类缺陷复发。
 *     · 不声明 `pkg` / `settings` / `connection` / `jobs`：真实**属性**读取 0 处 ——
 *       `ctx.settings` / `ctx.connection` / `ctx.jobs` 只出现在注释与日志字符串里；
 *       `ctx.pkg.version`（contract-baseline.mjs:352）在 try/catch 内，读抛被捕获后降级为 unknown
 *     · `ctx.on` / `ctx.effect` 是上下文自带的事件与方法面，非服务，不声明
 *
 * ★ 充分性证据（为什么"5 个声明"够）：本次 boot 探针实测 `[apply OK]` ⇒ 整个 apply 调用图的
 *   属性读取集合 ⊆ 当时声明的六个；而 `ctx.goals` 的**属性**读取全仓仅 3 处
 *   （anti-drift.mjs 的 FR-8 探测 + 本次删除的两处临时探针/warn），本次已全部改为安全取值或删除
 *   ⇒ 去掉 `goals` 后不存在未被覆盖的属性读取。
 * ★ 回归锚：test/anti-drift.test.mjs 的 A-12 —— 用"读未声明服务即抛"的白名单代理直接驱动探测函数。
 */
export const inject = ["tools", "systemPrompt", "webServer", "llm", "subagents"]

// ————————————— FR-3 注入行合计上限（批 43 / 台账 t-3 / 设计档 §六） —————————————
//
// 问题（设计档 §二-4）：注入行 = anti-drift 行 + 任务摘要**直接拼接**，两段各自有预算
// （anti-drift `LINE_MAX_CHARS = 512`，见 `lib/anti-drift.mjs`；摘要 `DIGEST_MAX_CHARS`），
// **合计没有任何一处管**。本节补上合计上限，并把「超限时怎么办」收敛成一个可导出的纯函数
// （可被 `test/tasks.test.mjs` 的 T-4e / T-4f 直接对拍；设计档 FR-3 / 评审 #3）。

/**
 * 注入行合计字符上限（设计档 D-4）= **1150，标定值 —— 不是派生量**。
 * ★ 为什么不用派生量 768 + 512 + 1 = 1281（副轨评审 #1 判为致命）：
 *   两段**各自**都有硬顶（adLine ≤ anti-drift `LINE_MAX_CHARS` 512、摘要 ≤ `DIGEST_MAX_CHARS` 768）
 *   ⇒ 合法入参的和**恒 ≤ 1281** ⇒ 以 1281 为上限时，裁剪分支**生产永远不可达 = 假保护**
 *   （此前那条腿只能用 896 字符的 taskLine〔> 摘要硬顶 768〕这种**非法**输入才触发）。
 * ★ 1150 才咬得住（前两个读数按「上限 − adLine − 1〔分隔符〕− 9〔换行 + 8 字符尾串〕」算）：
 *   · adLine 实测典型 245 ⇒ 摘要可用 895 > 768 ⇒ **拿满预算、不裁剪**（典型场景零损失）；
 *   · adLine 硬顶 512（最坏）⇒ 摘要被裁到 628 ⇒ **裁剪只在这种情况发生**；
 *   · 合法两段 500 + 700 = 1201 > 1150 ⇒ **两段都合法也真触发裁剪**（T-4e① 的夹具）。
 * 计量口径 = **字符**（JS `String#length`，即 UTF-16 长度；**不是字节**；与 `DIGEST_MAX_CHARS` 同口径）。
 */
export const INJECT_TOTAL_MAX_CHARS = 1150

/** 摘要被合计上限裁剪后的单行尾串（与预算尾串 `…还有 N 项` 区分：这是「整段被裁」的标记）。 */
const INJECT_CLIP_TAIL = "…（摘要已截断）"

/**
 * **注入行装配**（FR-3；纯函数 · 无 IO · 确定性 —— 同入参 ⇒ 逐字节同输出）。
 * @pre  `adLine` / `taskLine` 都是字符串（可能为空）
 * @post 总长 ≤ `INJECT_TOTAL_MAX_CHARS`，**除非 `adLine` 自身已超上限**（此时只返回 `adLine`，
 *       后置条件对该分支不适用 —— 设计档 §六 评审 #4：宁可没有摘要，不留残句）
 * @post 未超限 ⇒ 与旧注入点的 `[adLine, taskLine].filter(非空).join("\n")` **逐字相同**（空段不占行）
 * @post 超限 ⇒ **先砍摘要、不砍 anti-drift 行**（纪律面优先）；摘要按**行**裁剪：
 *       首行必留 · 不切半行 · 不跳行续接；尾部加单行 `…（摘要已截断）`
 * @post 连摘要首行都放不下 ⇒ `adLine` + 单行尾串（不带残行）
 * @post 若连「adLine + 分隔 + 尾串」都已超上限（`adLine` 贴近上限 ⇒ budget 为负）⇒ **直接返回
 *       `adLine`**（宁可没有摘要，也不留超限串 —— 这是后置条件「总长 ≤ 上限」的硬保证；修复轮 3）
 */
export function assembleInjection(adLine, taskLine) {
  const ad = typeof adLine === "string" ? adLine : ""
  const task = typeof taskLine === "string" ? taskLine : ""
  // 空段沿用旧注入点的 filter 语义：不占行、不留悬空换行（空账本 ⇒ 只出 anti-drift 行）
  if (task === "") return ad
  // ③ anti-drift 行自身超上限 ⇒ 摘要整段让位（当前不可达：LINE_MAX_CHARS=512 硬顶；将来放宽才可能）
  if (ad.length >= INJECT_TOTAL_MAX_CHARS) return ad
  const sep = ad === "" ? "" : "\n"
  // ① 未超限 ⇒ 原样拼接（**逐字**，不做任何裁剪/归一化）
  if (ad.length + sep.length + task.length <= INJECT_TOTAL_MAX_CHARS) return ad + sep + task
  // ② 超限 ⇒ 按行裁剪摘要 + 单行尾串；预算 = 上限 − adLine − 分隔 − 尾串（含尾串前换行）
  const budget = INJECT_TOTAL_MAX_CHARS - ad.length - sep.length - 1 - INJECT_CLIP_TAIL.length
  const lines = task.split("\n")
  const first = lines.length > 0 ? lines[0] : ""
  // ④ 首行（摘要头：rev/计数）必留，放不下就整段让位、只留尾串（不切半行）
  // ④a 贴顶守卫（修复轮 3）：adLine + 分隔 + 尾串**本身**就超上限时 budget 为负（如上限 1150、
  //   adLine 1142 ⇒ budget = −2）⇒ 连单行尾串都放不进去；旧实现硬拼「ad + 换行 + 尾串」会**超上限**
  //   （1142→1151 / 1149→1158），违反函数头的 @post。此处直接返回 adLine：宁可没有摘要，不留超限串。
  if (ad.length + sep.length + INJECT_CLIP_TAIL.length > INJECT_TOTAL_MAX_CHARS) return ad
  if (first.length > budget) return ad + sep + INJECT_CLIP_TAIL
  let kept = first
  let used = first.length
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    // 一旦某行放不下 ⇒ **停止**（不切半行、不跳行续接）
    if (used + 1 + line.length > budget) break
    kept += "\n" + line
    used += 1 + line.length
  }
  return ad + sep + kept + "\n" + INJECT_CLIP_TAIL
}

// ————————————— 工具构造 helper（零依赖形状） —————————————

function textTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      schema: { type: "string", description: "Tool output text" },
      render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
    },
    async execute(args, exec) {
      return def.execute(args, exec)
    },
  }
}

const strArr = (description) => ({ type: "array", items: { type: "string" }, description })

/** cwdHint 求值（F12 persistSession 写盘用——与 registerConfigApi opts.cwdHint 同语义，评审 #10）。 */
const cwdHintOf = (ctx) => {
  try { return ctx.get?.("agent")?.session?.header?.cwd ?? process.cwd() } catch { return process.cwd() }
}

// —— 批 34（anti-drift）接线用两个**纯读取**助手（零机制逻辑；机制全在 anti-drift.mjs） ——

/**
 * 当前活跃目标的视图（`{id, objective}`；取不到 ⇒ `null`）。
 * 读法**两级回落**（与 cwdHintOf 同风格）：先问宿主 goal 服务；服务不在或抛错 ⇒ `null`
 * （注入/推回/接管三面都按"无活跃目标"降级，属 §9 的 fail-open 面）。
 */
const goalViewOf = (ctx, agent) => {
  try {
    const goals = ctx?.get?.("goals")
    const g = goals?.get?.(agent) ?? goals?.get?.()
    if (!g || typeof g !== "object") return null
    const id = g.id ?? g.goalId ?? null
    if (!id) return null
    return { id: String(id), objective: g.objective ?? g.text ?? "" }
  } catch { return null }
}

/**
 * 从 `create_goal` 的返回里抠出 goal id（**defensive：先服务面、再形态**）。
 * 为什么需要它：`tools/post-execute` 拿到的是宿主工具的返回值，而宿主对结果的**精确形状**
 * 未进我方契约矩阵 ⇒ 不赌单一形状。三级取法：
 *   ① 结果对象自带的 `id` / `goalId` / `goal.id` 字段；
 *   ② 文本里第一个像 id 的 token（`g-…` / `goal-…` / `goal_<hex>` / 裸 uuid）；
 *   ③ 都没有 ⇒ `null`（**此时槽不提升**——判据留在待绑槽里，用户可显式再 set 一次；
 *      宁可漏提升也不猜一个错 id 去污判据存储）。
 */
const extractGoalId = (result) => {
  try {
    const r = result?.value ?? result?.output ?? result
    if (r && typeof r === "object") {
      const direct = r.id ?? r.goalId ?? r.goal_id ?? r.goal?.id
      if (direct) return String(direct)
    }
    const text = typeof r === "string" ? r : JSON.stringify(r ?? "")
    const m = /"?(?:goal[_-]?id|goalId|id)"?\s*[:=]\s*"([^"]{4,})"/i.exec(text)
      ?? /\b(goal[_-][A-Za-z0-9-]{4,}|g-[A-Za-z0-9-]{4,})\b/.exec(text)
      ?? /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(text)
    return m ? String(m[1]) : null
  } catch { return null }
}

/** 工具结果里是否含**裁决通过**（`/^VERDICT:\s*pass$/i` 的任意行；协议输出大写）。 */
const hasPassVerdict = (result) => {
  try {
    const r = result?.value ?? result?.output ?? result
    const text = typeof r === "string" ? r : JSON.stringify(r ?? "")
    return text.split(/\r?\n/).some((l) => /^VERDICT:\s*pass\s*$/i.test(l.trim()))
  } catch { return false }
}

// ————————————— 设置页 config API（二期，docs/2026-09-02-settings-ui-design.md §3.1/§3.2） —————————————
// 纯逻辑（校验/apply-session/reset-session/路由摘要）导出为无 ctx 依赖函数——U3/U7/U8 单元测试
// 直接 stub deps 调用；webServer 前缀路由（registerConfigApi/makeApiHandler）在其上薄封装。
// host 校验 helper 全部复用 advisor.mjs 的导出（评审 #5：不重写校验逻辑）。

export const CONFIG_API_PREFIX = "/thincoder-suite/api"

const GROUP_KEYS = ["round1", "convergence"]
const errEffort = (p) => p + ".effort must be one of " + EFFORT_LEVELS.join("|")
const errTimeout = (p) => p + ".timeoutMs must be a number in " + ADVISOR_TIMEOUT_MIN_MS + ".." + ADVISOR_TIMEOUT_MAX_MS
const errProvider = (p) => p + ".provider is required and must be a non-empty string"

/**
 * 批 33（设计档 §8 负向腿 / §9 守卫行）：**写任务档位**被配上只读通道时的**具名 fail-closed 拒绝**文案。
 * 为什么在此处（而不是散在工具体里）：`codexCli.engCoderRunner` 的两条入口——配置面（PUT 校验）与
 * 工具入口（手编 config.json 绕过 PUT 的运行时面）——必须是**同一句话**（判定族字面单点化）。
 * escalate 侧的同类守卫住在 `lib/escalate.mjs` 的行分派（它的「档位」是 consultModels 的行 runner）。
 */
export const ENG_APP_SERVER_RUNNER_REFUSAL = "codexCli.engCoderRunner 不接受 codex-app-server："
  + "本通道只读、不可用于写任务（平台无人值守对审批一律拒绝/cancel）——eng_coder 请改回 codex-cli（本地 Codex CLI 写沙箱）或 dsh"

const errModel = (p) => p + ".model is required and must be a non-empty string"

/**
 * 校验一个 advisor 组对象（round1/convergence）里「出现的每个字段」；provider/model 不强制成对
 * ——解析链语义允许部分组（缺失 model 的组整对下探，见一期 §3.2，T20），「必填」由表单保证。
 * @param {string} prefix 错误消息前缀，如 "advisor.round1"
 * @param {unknown} group
 * @param {string[]|undefined} knownProviders — undefined = 注册表不可查（跳过存在性）
 * @returns {string[]} errors
 */
export function validateAdvisorGroup(prefix, group, knownProviders) {
  const errors = []
  if (group === undefined || group === null) return errors
  if (typeof group !== "object" || Array.isArray(group)) {
    errors.push(prefix + " must be an object")
    return errors
  }
  const unknown = Object.keys(group).filter((k) => !["provider", "model", "effort", "timeoutMs", "runner"].includes(k))
  for (const k of unknown) errors.push(prefix + "." + k + " is not a supported advisor field")
  if (group.runner !== undefined && group.runner !== null) {
    errors.push(...validateRunnerValue(prefix + ".runner", group.runner))
  }
  if (group.provider !== undefined && group.provider !== null) {
    if (!isModelField(group.provider)) errors.push(errProvider(prefix))
    else if (Array.isArray(knownProviders) && !knownProviders.includes(group.provider)) {
      errors.push(prefix + ".provider " + JSON.stringify(group.provider)
        + " is not in the configured provider registry (llm-pi-ai.providers)")
    }
  }
  if (group.model !== undefined && group.model !== null && !isModelField(group.model)) {
    errors.push(errModel(prefix))
  }
  if (group.effort !== undefined && group.effort !== null && !isValidEffort(group.effort)) {
    errors.push(errEffort(prefix))
  }
  if (group.timeoutMs !== undefined && group.timeoutMs !== null && !isValidTimeoutMs(group.timeoutMs)) {
    errors.push(errTimeout(prefix))
  }
  return errors
}

/** consultModels 行的合法键（provider/model 必填；effort 可选枚举）。 */
function validateConsultModels(list, knownProviders) {
  const errors = []
  if (!Array.isArray(list)) {
    errors.push("consultModels must be an array of { provider, model, effort? }")
    return errors
  }
  if (list.length > 5) {
    errors.push("consultModels supports at most 5 models (got " + list.length + ")")
    return errors
  }
  list.forEach((row, i) => {
    const p = "consultModels[" + i + "]"
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errors.push(p + " must be an object with provider/model")
      return
    }
    const unknown = Object.keys(row).filter((k) => !["provider", "model", "effort", "runner"].includes(k))
    for (const k of unknown) errors.push(p + "." + k + " is not a supported consult-model field")
    errors.push(...validateRunnerValue(p + ".runner", row.runner))
    // codex 行（runner.kind = codex-cli **或** codex-app-server）免 provider/model —— codex-cli 的
    // model 透传给 CLI，codex-app-server 的 model 只入展示标签（批 33：两条通道都不经
    // llm-pi-ai 注册表，故都不要求 pair）。
    const nr = row.runner !== undefined && row.runner !== null ? normalizeRunnerValue(row.runner) : null
    const isCodex = !!(nr && nr.ok && (nr.runner.kind === "codex-cli" || nr.runner.kind === "codex-app-server"))
    if (!isCodex) {
      if (!isModelField(row.provider)) errors.push(p + ".provider is required and must be a non-empty string")
      else if (Array.isArray(knownProviders) && !knownProviders.includes(row.provider)) {
        errors.push(p + ".provider " + JSON.stringify(row.provider)
          + " is not in the configured provider registry (llm-pi-ai.providers)")
      }
      if (!isModelField(row.model)) errors.push(p + ".model is required and must be a non-empty string")
    }
    if (row.effort !== undefined && row.effort !== null && !isValidEffort(row.effort)) {
      errors.push(p + ".effort must be one of " + EFFORT_LEVELS.join("|"))
    }
  })
  return errors
}

/**
 * 校验 PUT /config 的完整 user 层配置（U3 错误路径；校验 helper 与一期解析链同源，N4）。
 * @param {unknown} userConfig body { config } 的 config
 * @param {string[]|undefined} knownProviders — llm-pi-ai providers 键清单；undefined = 注册表
 *   不可查（ctx.settings 不可用/无该命名空间）→ 跳过存在性校验并附 notes 提示（评审 #8）
 * @returns {{ok: boolean, errors: string[], notes: string[], sanitized?: object}}
 */
export function validateGlobalUserConfig(userConfig, knownProviders) {
  const errors = []
  const notes = []
  const topAllowed = ["advisor", "consultModels", "engCoderMaxTokens", "engCoderEffort", "codexCli", "dshBackgroundTimeoutMs", "consultTimeoutMs", "engTokenTtlMs", "ledger"]
  // ★ 批 36：`ledger`（个人任务台账的 mode / 文档路径清单 / 话术模板）进白名单 ⇒ 三面同步
  //   （本处 PUT 校验 · config-store 的 merge 白名单 · tasks.mjs 的 resolveLedgerConfig）；
  //   基数钉在 `test/config-api.test.mjs` 的 U3c2b（TOP 8 → 9、合计 21 → 22），散文面三处同改。
  if (!userConfig || typeof userConfig !== "object" || Array.isArray(userConfig)) {
    errors.push("config must be an object")
    return { ok: false, errors, notes }
  }
  if (knownProviders === undefined) {
    notes.push("provider registry unavailable (ctx.settings llm-pi-ai not readable) — provider existence not verified")
  }
  // 批 10（D-31 / 决策 D10-9）：未知顶层键**由 `notes` 改入 `errors`**——消息镜像**嵌套分支的
  // 既有形态**（`advisor.nope is not supported (expected …)`，:196）。此前走 notes ⇒ `ok` 仍为
  // true ⇒ PUT 返回 **200「已保存」**而 `sanitized` 不含该键 ⇒ 整体替换写盘 ⇒ **静默清空整个
  // user 层配置**（数据丢失）。改入 errors 后 `ok:false` ⇒ :682 的 `if (!v.ok) return 400`
  // **在写盘之前**拦下 ⇒ 该数据丢失路径灭绝（不引入新严格性：嵌套未知键今天就是报错）。
  // ★ 整体替换语义**未动**（D10-12）：「删除键靠在新全量中缺席表达」不受影响。
  const unknownTop = Object.keys(userConfig).filter((k) => !topAllowed.includes(k))
  for (const k of unknownTop) {
    errors.push(JSON.stringify(k) + " is not a supported top-level field (user-layer whitelist: "
      + topAllowed.join("|") + ")")
  }
  const sanitized = {}
  if (userConfig.advisor !== undefined && userConfig.advisor !== null) {
    const adv = userConfig.advisor
    if (typeof adv !== "object" || Array.isArray(adv)) {
      errors.push("advisor must be an object")
    } else {
      const advUnknown = Object.keys(adv).filter((k) => ![...GROUP_KEYS, "includeProjectGuide", "maxOutputTokens", "contextTokens", "standardsDoc", "documentMapDoc", "criteriaDoc"].includes(k))
      for (const k of advUnknown) errors.push("advisor." + k + " is not supported (expected " + GROUP_KEYS.join("|") + "|includeProjectGuide|maxOutputTokens|contextTokens|standardsDoc|documentMapDoc|criteriaDoc)")
      const advOut = {}
      for (const gk of GROUP_KEYS) {
        if (adv[gk] === undefined || adv[gk] === null) continue
        errors.push(...validateAdvisorGroup("advisor." + gk, adv[gk], knownProviders))
        const g = sanitizeGroup(adv[gk])
        if (g && Object.keys(g).length > 0) advOut[gk] = g
        // 成对不完整是合法配置（解析链整对下探语义，一期 §3.2）——附提示而非报错
        if (!isModelField(adv[gk]?.provider) || !isModelField(adv[gk]?.model)) {
          notes.push("advisor." + gk + " has no complete provider/model pair — its model route falls back down the resolution chain")
        }
      }
      if (adv.includeProjectGuide !== undefined && adv.includeProjectGuide !== null) {
        if (typeof adv.includeProjectGuide !== "boolean") {
          errors.push("advisor.includeProjectGuide must be a boolean")
        } else {
          advOut.includeProjectGuide = adv.includeProjectGuide
        }
      }
      // R1 §3.6（D-01 热修正式化）：PUT 白名单面——advisor.maxOutputTokens 数值区间校验
      if (adv.maxOutputTokens !== undefined && adv.maxOutputTokens !== null) {
        if (isValidAdvisorMaxOutputTokens(adv.maxOutputTokens)) {
          advOut.maxOutputTokens = adv.maxOutputTokens
        } else {
          errors.push("advisor.maxOutputTokens must be an integer in "
            + ADVISOR_MAX_OUTPUT_TOKENS_MIN + ".." + ADVISOR_MAX_OUTPUT_TOKENS_MAX)
        }
      }
      // 批 5（FR-CB5）：PUT 白名单面——advisor.contextTokens（语义 = 模型窗口，**不是**判死线；
      // 与 maxOutputTokens 同款区间校验，校验函数 = lib/advisor.mjs 单一事实源）
      if (adv.contextTokens !== undefined && adv.contextTokens !== null) {
        if (isValidAdvisorContextTokens(adv.contextTokens)) {
          advOut.contextTokens = adv.contextTokens
        } else {
          errors.push("advisor.contextTokens must be an integer in "
            + ADVISOR_CONTEXT_TOKENS_MIN + ".." + ADVISOR_CONTEXT_TOKENS_MAX)
        }
      }
      // 批 7（D-P4/J11）· 批 13（R-6）：PUT 白名单面——三个「项目文档」声明键
      // （advisor.standardsDoc / advisor.documentMapDoc / advisor.criteriaDoc）。
      // 语义 = **该项目把哪份文档交给评审当判据用**（项目属性，global-only）——三类各管一面，
      // 故**不得**并键：standardsDoc = 工程标准文档（两面都注入，且是**独立追加段**）·
      // documentMapDoc = 文档地图（仅 design round 1）· criteriaDoc = **code 评审的判据正文**
      // （替换 `## Review Criteria` 段的**内容**，仅 code round 1 消费）。
      // 路径必须**是文档**：判据复用**同一个单一权威** isDocPath（与写门禁同尺，J11）；这里是
      // **类型校验**不是可读性校验（存在吗）——可读性在注入时判（PUT 层没有会话 cwd，
      // 无法可靠解析相对路径）。
      // ★撤销语义：`""` / `null` ⇒ **删除该 user 层键**并返回成功（**不是** 400）——「已声明」
      // 必须能回到「未声明」（后者是**正常状态**；没有回头路是设计缺陷，AC-P12c/锚 B11）。
      // ★标签**逐键**（D13-17 ②）：下面的 `label` 进类型错误消息的「path to the …」括号 ⇒
      // 复用别键的标签会把新键**叫错名字**（第三个键不是标准文档）。
      for (const [key, label] of [["standardsDoc", "project standards document"], ["documentMapDoc", "document map"], ["criteriaDoc", "review criteria document"]]) {
        const v = adv[key]
        if (v === undefined || v === null || v === "") continue // 撤销声明：不写进 advOut ⇒ 整档落盘即删键
        if (typeof v !== "string") {
          errors.push("advisor." + key + " must be a string (path to the " + label + ", relative to the session cwd)")
          continue
        }
        if (!isDocPath(v)) {
          errors.push("advisor." + key + " must point to a DOCUMENT file — '" + v + "' is not a document path (J11: the declared path is checked with the same single-authority predicate as the write gate)")
          continue
        }
        advOut[key] = v
      }
      if (Object.keys(advOut).length > 0) sanitized.advisor = advOut
    }
  }
  if (userConfig.consultModels !== undefined && userConfig.consultModels !== null) {
    errors.push(...validateConsultModels(userConfig.consultModels, knownProviders))
    if (Array.isArray(userConfig.consultModels)) {
      sanitized.consultModels = userConfig.consultModels.map(sanitizeConsultRow)
        .filter((r) => r !== null)
    }
  }
  if (userConfig.engCoderMaxTokens !== undefined && userConfig.engCoderMaxTokens !== null) {
    if (!isValidEngCoderMaxTokens(userConfig.engCoderMaxTokens)) {
      errors.push("engCoderMaxTokens must be a positive integer")
    } else {
      sanitized.engCoderMaxTokens = userConfig.engCoderMaxTokens
    }
  }
  if (userConfig.engCoderEffort !== undefined && userConfig.engCoderEffort !== null) {
    if (!isValidEffort(userConfig.engCoderEffort)) {
      errors.push("engCoderEffort must be one of " + EFFORT_LEVELS.join("|"))
    } else {
      sanitized.engCoderEffort = userConfig.engCoderEffort
    }
  }
  // codexCli 全局节（一期 codex-runner，§5.2）：字段白名单 + 类型/枚举/范围校验（B10/B12）
  if (userConfig.codexCli !== undefined && userConfig.codexCli !== null) {
    const cc = userConfig.codexCli
    if (typeof cc !== "object" || Array.isArray(cc)) {
      errors.push("codexCli must be an object")
    } else {
      const ccFields = ["executable", "proxyMode", "proxyUrl", "agentsMdPolicy", "model", "defaultTimeoutMs", "idleTimeoutMs", "engCoderRunner", "budgetCapMs", "maxConcurrent"]
      const ccUnknown = Object.keys(cc).filter((k) => !ccFields.includes(k))
      for (const k of ccUnknown) errors.push("codexCli." + k + " is not a supported field")
      const ccOut = {}
      if (cc.executable !== undefined && cc.executable !== null) {
        if (isModelField(cc.executable)) ccOut.executable = cc.executable
        else errors.push("codexCli.executable must be a non-empty string")
      }
      if (cc.proxyMode !== undefined && cc.proxyMode !== null) {
        if (["inherit", "none", "url"].includes(cc.proxyMode)) ccOut.proxyMode = cc.proxyMode
        else errors.push("codexCli.proxyMode must be inherit|none|url")
      }
      if (cc.proxyUrl !== undefined && cc.proxyUrl !== null) {
        if (typeof cc.proxyUrl === "string" && (cc.proxyUrl.indexOf("http://") === 0 || cc.proxyUrl.indexOf("https://") === 0)) ccOut.proxyUrl = cc.proxyUrl
        else errors.push("codexCli.proxyUrl must be an http(s) URL")
      }
      if (cc.agentsMdPolicy !== undefined && cc.agentsMdPolicy !== null) {
        if (["respect", "disable", "clean-cwd"].includes(cc.agentsMdPolicy)) ccOut.agentsMdPolicy = cc.agentsMdPolicy
        else errors.push("codexCli.agentsMdPolicy must be respect|disable|clean-cwd")
      }
      if (cc.model !== undefined && cc.model !== null) {
        if (isModelField(cc.model)) ccOut.model = cc.model
        else errors.push("codexCli.model must be a non-empty string")
      }
      if (cc.defaultTimeoutMs !== undefined && cc.defaultTimeoutMs !== null) {
        if (Number.isInteger(cc.defaultTimeoutMs) && cc.defaultTimeoutMs >= 30000 && cc.defaultTimeoutMs <= 3600000) ccOut.defaultTimeoutMs = cc.defaultTimeoutMs
        else errors.push("codexCli.defaultTimeoutMs must be an integer in 30000..3600000")
      }
      if (cc.idleTimeoutMs !== undefined && cc.idleTimeoutMs !== null) {
        if (Number.isInteger(cc.idleTimeoutMs) && cc.idleTimeoutMs >= 15000 && cc.idleTimeoutMs <= 3600000) ccOut.idleTimeoutMs = cc.idleTimeoutMs
        else errors.push("codexCli.idleTimeoutMs must be an integer in 15000..3600000")
      }
      if (cc.engCoderRunner !== undefined && cc.engCoderRunner !== null) {
        if (["dsh", "codex-cli"].includes(cc.engCoderRunner)) ccOut.engCoderRunner = cc.engCoderRunner
        else if (cc.engCoderRunner === "codex-app-server") errors.push(ENG_APP_SERVER_RUNNER_REFUSAL)
        else errors.push("codexCli.engCoderRunner must be dsh|codex-cli")
      }
      if (cc.budgetCapMs !== undefined && cc.budgetCapMs !== null) {
        if (Number.isInteger(cc.budgetCapMs) && cc.budgetCapMs >= 60000 && cc.budgetCapMs <= 3600000) ccOut.budgetCapMs = cc.budgetCapMs
        else errors.push("codexCli.budgetCapMs must be an integer in 60000..3600000")
      }
      // R2 §4.5（D-14，DP-3 默认 8）：全局 codex 并发上限（PUT 面——与 merge/运行时三面同步）
      if (cc.maxConcurrent !== undefined && cc.maxConcurrent !== null) {
        if (Number.isInteger(cc.maxConcurrent) && cc.maxConcurrent >= 1 && cc.maxConcurrent <= 64) ccOut.maxConcurrent = cc.maxConcurrent
        else errors.push("codexCli.maxConcurrent must be an integer in 1..64")
      }
      if (Object.keys(ccOut).length > 0) sanitized.codexCli = ccOut
    }
  }
  // R5 §7.2（D-27，D-01 热修正式化同款三面收口）：PUT 白名单面——顶层全局
  // dshBackgroundTimeoutMs 数值区间校验（后台 dsh 任务挂死兜底截止；merge 白名单在
  // config-store.mjs、运行时回落告警在 resolveDshBackgroundTimeoutMs——单一事实源）
  if (userConfig.dshBackgroundTimeoutMs !== undefined && userConfig.dshBackgroundTimeoutMs !== null) {
    if (isValidDshBackgroundTimeoutMs(userConfig.dshBackgroundTimeoutMs)) {
      sanitized.dshBackgroundTimeoutMs = userConfig.dshBackgroundTimeoutMs
    } else {
      errors.push("dshBackgroundTimeoutMs must be an integer in "
        + DSHS_BACKGROUND_TIMEOUT_MIN_MS + ".." + DSHS_BACKGROUND_TIMEOUT_MAX_MS)
    }
  }
  // D-29：顶层全局 consultTimeoutMs / engTokenTtlMs 区间校验（会诊看门狗 / design token
  // 有效期——两键此前只在 entry base 可改，设置页改不动；本批并入白名单三面同步）
  if (userConfig.consultTimeoutMs !== undefined && userConfig.consultTimeoutMs !== null) {
    if (isValidConsultTimeoutMs(userConfig.consultTimeoutMs)) {
      sanitized.consultTimeoutMs = userConfig.consultTimeoutMs
    } else {
      errors.push("consultTimeoutMs must be an integer in "
        + CONSULT_TIMEOUT_MIN_MS + ".." + CONSULT_TIMEOUT_MAX_MS)
    }
  }
  if (userConfig.engTokenTtlMs !== undefined && userConfig.engTokenTtlMs !== null) {
    if (isValidEngTokenTtlMs(userConfig.engTokenTtlMs)) {
      sanitized.engTokenTtlMs = userConfig.engTokenTtlMs
    } else {
      errors.push("engTokenTtlMs must be an integer in "
        + ENG_TOKEN_TTL_MIN_MS + ".." + ENG_TOKEN_TTL_MAX_MS)
    }
  }
  // 批 36（个人任务台账）：`ledger` 节（mode / docPaths / copyTemplate）——**PUT 面严格校验**。
  // 三面同源：本处（写面拒）· `lib/config-store.mjs` 的白名单合并 · `lib/tasks.mjs` 的运行时归一。
  if (userConfig.ledger !== undefined && userConfig.ledger !== null) {
    const lg = userConfig.ledger
    if (typeof lg !== "object" || Array.isArray(lg)) {
      errors.push("ledger must be an object")
    } else {
      const LEDGER_FIELDS = ["mode", "docPaths", "copyTemplate"]
      for (const k of Object.keys(lg)) {
        if (!LEDGER_FIELDS.includes(k)) errors.push("ledger." + k + " is not a supported field")
      }
      const lgOut = {}
      if (lg.mode !== undefined && lg.mode !== null) {
        if (isValidLedgerMode(lg.mode)) lgOut.mode = lg.mode
        else errors.push("ledger.mode must be off|standalone")
      }
      if (lg.docPaths !== undefined && lg.docPaths !== null) {
        if (isValidDocPathList(lg.docPaths)) lgOut.docPaths = lg.docPaths.map((p) => p.trim())
        else errors.push("ledger.docPaths must be an array of at most " + MAX_DOC_PATHS + " non-empty strings")
      }
      if (lg.copyTemplate !== undefined && lg.copyTemplate !== null) {
        if (isValidCopyTemplate(lg.copyTemplate)) lgOut.copyTemplate = lg.copyTemplate.trim()
        else errors.push("ledger.copyTemplate must be a non-empty string of at most 500 chars")
      }
      if (Object.keys(lgOut).length > 0) sanitized.ledger = lgOut
    }
  }
  return { ok: errors.length === 0, errors, notes, sanitized }
}

/** 组对象净化：只留合法非空字段（白名单字段级）。 */
function sanitizeGroup(group) {
  if (!group || typeof group !== "object" || Array.isArray(group)) return null
  const out = {}
  if (isModelField(group.provider)) out.provider = group.provider
  if (isModelField(group.model)) out.model = group.model
  if (isValidEffort(group.effort)) out.effort = group.effort
  if (isValidTimeoutMs(group.timeoutMs)) out.timeoutMs = group.timeoutMs
  // 一期 codex-runner / 批 33：两个 codex kind 都需要持久化（dsh = 缺省，存了也是噪音）
  if (group.runner !== undefined && group.runner !== null) {
    const nr = normalizeRunnerValue(group.runner)
    if (nr.ok && (nr.runner.kind === "codex-cli" || nr.runner.kind === "codex-app-server")) out.runner = nr.runner
  }
  return out
}

/** consultModels 行净化：provider/model 必填（codex 行免），effort 可选枚举。 */
function sanitizeConsultRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null
  const nr = row.runner !== undefined && row.runner !== null ? normalizeRunnerValue(row.runner) : null
  if (nr && nr.ok && (nr.runner.kind === "codex-cli" || nr.runner.kind === "codex-app-server")) {
    const out = { runner: nr.runner }
    if (isValidEffort(row.effort)) out.effort = row.effort
    return out
  }
  if (!isModelField(row.provider) || !isModelField(row.model)) return null
  const out = { provider: row.provider, model: row.model }
  if (isValidEffort(row.effort)) out.effort = row.effort
  if (row.runner !== undefined && row.runner !== null) {
    const r2 = normalizeRunnerValue(row.runner)
    if (r2.ok && (r2.runner.kind === "codex-cli" || r2.runner.kind === "codex-app-server")) out.runner = r2.runner
  }
  return out
}

/**
 * 会话级 advisor 覆盖净化为 advisorOverride 形状（round1/convergence 部分组 +
 * includeProjectGuide；字段级白名单同 sessionState/advisor_config，§3.6 一期）。
 * @param {unknown} advisorPayload — apply-session body.advisor
 * @returns {{ok: boolean, errors: string[], advisor?: object|null}}
 */
export function sanitizeSessionAdvisor(advisorPayload) {
  const errors = []
  const advisor = {}
  if (advisorPayload === undefined || advisorPayload === null) return { ok: true, errors, advisor: null }
  if (typeof advisorPayload !== "object" || Array.isArray(advisorPayload)) {
    errors.push("advisor must be an object with round1/convergence/includeProjectGuide")
    return { ok: false, errors }
  }
  const allowed = [...GROUP_KEYS, "includeProjectGuide"]
  const unknown = Object.keys(advisorPayload).filter((k) => !allowed.includes(k))
  for (const k of unknown) {
    errors.push("advisor." + k + " is not supported for session apply (expected " + allowed.join("|") + ")")
  }
  for (const gk of GROUP_KEYS) {
    if (advisorPayload[gk] === undefined || advisorPayload[gk] === null) continue
    errors.push(...validateAdvisorGroup("advisor." + gk, advisorPayload[gk], undefined))
    const g = sanitizeGroup(advisorPayload[gk])
    if (g && Object.keys(g).length > 0) advisor[gk] = g
  }
  if (advisorPayload.includeProjectGuide !== undefined && advisorPayload.includeProjectGuide !== null) {
    if (typeof advisorPayload.includeProjectGuide !== "boolean") {
      errors.push("advisor.includeProjectGuide must be a boolean")
    } else {
      advisor.includeProjectGuide = advisorPayload.includeProjectGuide
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, errors, advisor: Object.keys(advisor).length > 0 ? advisor : null }
}

/**
 * POST /apply-session 逻辑（U7）：有效 sessionId → 写 sessionState.advisorOverride
 * （仅 advisor 白名单子集）；无效 → {ok:false, reason:'no-session'} 且不崩溃。
 * F12（§2.3 写点表）：advisorOverride 变更后写盘——deps.persistSession(sessionId) 钩子
 * （可选注入；apply() 注册处接线 saveSessionState，单测 stub 不注入则跳过——不写真实盘）。
 * @param {{sessionExists: (id: string) => boolean, stateOf: (id: string) => object,
 *          persistSession?: (id: string) => void}} deps
 * @param {string} sessionId
 * @param {unknown} advisorPayload
 */
export function applySessionOverride(deps, sessionId, advisorPayload) {
  const sid = String(sessionId ?? "").trim()
  if (!sid || !deps?.sessionExists?.(sid)) return { ok: false, reason: "no-session" }
  const v = sanitizeSessionAdvisor(advisorPayload)
  if (!v.ok) return { ok: false, errors: v.errors }
  const state = deps.stateOf(sid)
  state.advisorOverride = v.advisor // null = 无覆盖（与 reset 语义同）
  // R2 §4.4（D-10）：apply-session 变更 = 语义转换点，代际 +1（在飞 advisor 结果按旧
  // override 路由解析——晚到即弃，不复活已被变更的状态语义）
  bumpAdvisorGeneration(state)
  try { deps?.persistSession?.(sid) } catch { /* N3：写盘失败不阻塞（save 内部已 warn） */ }
  return { ok: true, override: state.advisorOverride }
}

/**
 * DELETE /session 逻辑（U7，与 apply-session 对称）：删该会话 advisorOverride（恢复会话默认）。
 * F12（§2.3）：同 apply-session——变更后经 deps.persistSession 落盘（advisorOverride 持久化）。
 */
export function resetSessionOverride(deps, sessionId) {
  const sid = String(sessionId ?? "").trim()
  if (!sid || !deps?.sessionExists?.(sid)) return { ok: false, reason: "no-session" }
  deps.stateOf(sid).advisorOverride = null
  try { deps?.persistSession?.(sid) } catch { /* N3：写盘失败不阻塞 */ }
  return { ok: true }
}

/**
 * GET /session 摘要（U4：页面顶部当前会话生效摘要 + 覆盖来源标注）。契约：
 * 无会话 → {ok:false, reason:'no-session'}；有会话 → {ok:true, override, effective}。
 * override = advisorOverride 现状（无覆盖 null）；effective = 该会话两组的解析结果
 * （会话覆盖 ⊕ 生效全局 ⊕ 会话 agent route，来源逐字段标注）+ includeProjectGuide 解析。
 */
export function describeSessionView(deps, sessionId) {
  const sid = String(sessionId ?? "").trim()
  if (!sid || !deps?.sessionExists?.(sid)) return { ok: false, reason: "no-session" }
  // 分歧审计 D2：cwdHint 在 apply() 注册处是函数形态——此处统一调用求值
  const cwdHint = typeof deps.cwdHint === "function" ? deps.cwdHint() : deps.cwdHint
  const config = effectiveGlobalConfig(deps.baseConfig, {
    dshHomeOverride: deps.dshHomeOverride,
    cwdHint,
  })
  const override = deps.stateOf(sid).advisorOverride ?? null
  const agentOpts = (deps.agentOptionsOf?.(sid) && typeof deps.agentOptionsOf(sid) === "object")
    ? deps.agentOptionsOf(sid)
    : {}
  const describe = (groupKey, round) => {
    const r = resolveAdvisorRoute({ config, override, agentOpts, advisorRound: round })
    if (!r.ok) return { ok: false, reason: "no LLM route" }
    return {
      ok: true,
      provider: r.provider, model: r.model, pairSource: r.pairSource,
      effort: r.effort, effortSource: r.effortSource,
      timeoutMs: r.timeoutMs, timeoutSource: r.timeoutSource,
      runner: r.runner ?? null,
    }
  }
  const ipg = resolveIncludeProjectGuide({ config, override })
  return {
    ok: true,
    override,
    effective: {
      round1: describe("round1", 0),
      convergence: describe("convergence", 1),
      includeProjectGuide: { value: ipg.value, source: ipg.source },
    },
  }
}

/** settings 可读时的 providers 键清单（评审 #6：getter 经 opts.settingsGet 懒取——settings 不在 inject 列表）；不可用 → undefined。 */
function knownProviderKeys(settingsGet) {
  try {
    const ns = typeof settingsGet === "function" ? settingsGet("llm-pi-ai") : undefined
    const providers = ns && typeof ns === "object" && !Array.isArray(ns) ? ns.providers : null
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return undefined
    return Object.keys(providers)
  } catch {
    return undefined
  }
}

/**
 * 评审反馈修复：provider 存在性校验的权威源 = 运行时注册表（ctx.llm.listProviders ∪
 * listConfigurableProviders——含内置 DeepSeek 适配器与休眠可配置路由）∪ settings 覆盖层
 * （llm-pi-ai.providers）。此前只读 settings.yaml 覆盖层 → "deepseek-official 不在注册表"
 * 假阳性（settings 文件里根本没有内置适配器）。runtime 注册表不可读（含门面 ctx.llm 不透出
 * list* 的 app 构建，实证 2026-09-07）→ undefined（跳过存在性校验，附 note），见函数内注。
 */
async function knownProviderKeysExtended(opts) {
  const keys = new Set()
  let runtimeReadable = false
  try {
    const llm = opts?.llm
    const hasList = !!llm && (typeof llm.listProviders === "function" || typeof llm.listConfigurableProviders === "function")
    if (hasList) runtimeReadable = true
    if (llm && typeof llm.listProviders === "function") {
      const infos = await llm.listProviders()
      for (const info of Array.isArray(infos) ? infos : []) {
        if (info && typeof info.id === "string") keys.add(info.id)
      }
    }
    if (llm && typeof llm.listConfigurableProviders === "function") {
      const rows = await llm.listConfigurableProviders()
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row && typeof row.provider === "string") keys.add(row.provider)
      }
    }
  } catch { /* 运行时读取失败 → 视为不可读 */ }
  try {
    const fromSettings = knownProviderKeys(opts?.settingsGet)
    if (fromSettings) for (const k of fromSettings) keys.add(k)
  } catch { /* ignore */ }
  // 本地部署实证（2026-09-07）：部分 app 构建下插件 ctx.llm 是门面（仅 stream/resolveModel，
  // 不透出 list* 方法）→ 运行时注册表不可读。settings 覆盖层不是权威源（缺内置 DeepSeek
  // 路由，同 /catalog 注释）→ 仅凭 settings 做存在性校验会复活「deepseek-official 不在注册表」
  // 假阳性。runtime 不可读时返回 undefined = 跳过存在性校验（U3b note 路径）：宁可漏校验，
  // 不可错杀；运行时可读时仍维持 runtime ∪ settings 权威并集。
  if (!runtimeReadable) return undefined
  return keys.size > 0 ? [...keys] : undefined
}

/** 读请求体（super-injector 同款）。 */
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * config API prefix 路由 handler（§3.2 全部端点；JSON 往返；500 兜底 {ok:false}）。
 *
 * ★ 信任栅栏（批 22 / D-39）：本 handler 的**第一件事**是问宿主的 `connection` 服务要一个拒绝码
 * ——它的 `requestRejection` = Host/Origin 栅栏（403，挡 DNS rebinding 与跨站）+ 浏览器会话鉴权（401）。
 * **不接这道门的后果是实测过的**：加门前 `GET /config` 无 token 返 200、`Host: evil.example` 也返 200，
 * 而 loopback 绑定**挡不住浏览器**（rebinding 后同源 ⇒ 响应可读）。
 * 平台契约：`dsh-host-webserver/README.md:113`「route owners such as dsh-client-connection enforce
 * their own request policy」——平台不替你套栅栏，路由所有者自负其责。
 * 同栈母本：`dsh-client-connection` 自己的 `/api` 路由与 `dsh-host-open-in-app` 的 `rejected()` 都是这个形状。
 *
 * 取服务用 `ctx.get("connection")` 而**不是** `ctx.connection`：cordis 的 `ctx.get` 明确「Read a service
 * from the store **without the inject requirement**」，而属性读 `ctx.connection` 在本插件（`inject` 不含
 * connection）会抛 `cannot get property "connection" without inject`。也**刻意不把 connection 加进**
 * `inject`：required 语义会让无该服务的 profile 整个插件拒起，四个 host 工具为 web 附属面陪葬（U8 同款纪律）。
 *
 * 服务取不到 = 信任无法核验 ⇒ **一律 503，绝不放行**（与既有「服务取不到必须留痕」同一纪律）。
 * warn-once 标记放本闭包内（随 handler 实例）：模块级全局会跨 fiber / HMR 存活，测试还得额外清。
 *
 * @param {object} ctx — 宿主 ctx（webServer/settings/agents/connection 经 get 取）
 * @param {{baseConfig: object, sessionExists: (id: string) => boolean,
 *          agentOptionsOf: (id: string) => object|undefined}} opts
 */
export function makeApiHandler(ctx, opts) {
  const baseConfig = opts?.baseConfig ?? {}
  let warnedNoFence = false
  /**
   * 信任栅栏判定：`undefined` = 放行；401 / 403 = 宿主拒绝码；503 = 服务不可核验（fail-closed）。
   * @param {import("node:http").IncomingMessage} req
   * @returns {number|undefined}
   */
  const rejectionOf = (req) => {
    try {
      const connection = ctx?.get?.("connection") ?? null
      if (connection && typeof connection.requestRejection === "function") {
        const verdict = connection.requestRejection(req)
        // 宿主契约 = 403（Host/Origin 栅栏）/ 401（未鉴权）/ undefined（放行）。**契约外形态**
        // （`true` / 字符串 / `0` / 超范围码）不得直接喂给 `res.writeHead`——那会在下面的 `try`
        // **之外**抛 TypeError，连 503 都拿不到（交付评审 #2）。故一律按「不可核验」收口，绝不放行。
        if (verdict === undefined) return undefined
        if (Number.isInteger(verdict) && verdict >= 400 && verdict <= 599) return verdict
      }
    } catch { /* 取服务或栅栏自身抛错 ⇒ 落到下面的 fail-closed */ }
    if (!warnedNoFence) {
      warnedNoFence = true
      console.warn("[thincoder-suite] connection trust fence unavailable or returned a contract-external verdict — "
        + "config API fails closed (503); no setting is served without the host request policy (lib/index.mjs makeApiHandler)")
    }
    return 503
  }
  return async (req, res) => {
    const send = (obj, code = 200) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" })
      res.end(JSON.stringify(obj))
    }
    // ★ 栅栏必须先于一切业务逻辑：不解析 URL、不读盘、不写盘（D-39）。
    const rejection = rejectionOf(req)
    if (rejection !== undefined) {
      return send({
        ok: false,
        error: rejection === 401 ? "unauthorized" : rejection === 403 ? "forbidden" : "auth fence unavailable (fail-closed)",
      }, rejection)
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost")
      const path = url.pathname.replace(/^\/thincoder-suite\/api/, "") || "/"
      const query = url.searchParams

      if (req.method === "GET" && path === "/config") {
        const user = loadUserConfig(opts?.dshHomeOverride, opts?.cwdHint?.())
        return send({ ok: true, base: baseConfig, user, effective: mergeGlobalConfig(baseConfig, user) })
      }

      if (req.method === "GET" && path === "/session") {
        return send(describeSessionView(opts, query.get("sessionId") ?? ""))
      }

      // —— 批 36（FR-5/FR-6 的数据通道 C-2）：任务台账看板载荷 ——
      // 浏览器半边的 tab 拉取的就是这一份；它**只**由 `readTasksView()` 派生（`generatedFrom` 字段即结构自证）。
      // ★ 工作区根只从**目标会话的 cwd** 取（不让调用方指定路径——那是任意文件读的口子）。
      // ★ 信任栅栏已在函数首部生效（本分支在栅栏之后），不重复实现。
      if (req.method === "GET" && path === "/tasks") {
        if (typeof opts?.tasksRoute !== "function") {
          return send({ ok: false, error: "tasks route unavailable (no ledger wiring)" }, 503)
        }
        return send(opts.tasksRoute(query))
      }

      // —— 批 36-补（交接动作）：看板「接手」按钮的**唯一写入口** ——
      // 与 GET /tasks 走**同一道信任栅栏**（在函数首部），并复用同一份载荷构造：本 handler 只解析
      // body / 取会话 / 调 `opts.tasksClaimRoute`，**零状态机**（判定全在写门 `applyTaskClaim`）。
      if (req.method === "POST" && path === "/tasks/claim") {
        if (typeof opts?.tasksClaimRoute !== "function") {
          return send({ ok: false, error: "tasks claim route unavailable (no ledger wiring)" }, 503)
        }
        let body
        try { body = JSON.parse(await readBody(req) || "{}") } catch (e) {
          return send({ ok: false, error: "invalid JSON body: " + (e?.message ?? String(e)) }, 400)
        }
        return send(opts.tasksClaimRoute(body))
      }

      // 一期 codex-runner（5.6）：模型目录发现 —— codex debug models → models_cache.json 兜底。
      // ?executable= 覆盖全局；?refresh=1 绕过进程内缓存。
      if (req.method === "GET" && path === "/codex/models") {
        const user = loadUserConfig(opts?.dshHomeOverride, opts?.cwdHint?.())
        const eff = mergeGlobalConfig(baseConfig, user)
        const g = resolveCodexCliGlobals(eff).globals
        const executable = query.get("executable") ?? g.executable
        const r = await discoverCodexModels({ executable, refresh: query.get("refresh") === "1" })
        if (!r.ok) return send({ ok: false, error: r.error }, 502)
        return send({ ok: true, source: r.source, fetchedAt: r.fetchedAt, executable, models: r.models })
      }

      // dsh provider/model 目录发现（设置页 dsh 行下拉数据源）：权威源 = ctx.llm 运行时
      // 注册表（listProviders/listModels——模型选择器同源，含内置 DeepSeek 适配器等全部
      // 运行时路由）；llm-pi-ai settings 的 reasoningEfforts 作为 effort 档位富化（有则用）。
      // 评审教训：settings.yaml 只是用户覆盖层（缺内置 DeepSeek 等）——不能作为唯一目录源。
      if (req.method === "GET" && path === "/catalog") {
        const llm = opts?.llm ?? null
        const llmReady = !!llm && typeof llm.listProviders === "function"
        const ns = opts?.settingsGet ? opts.settingsGet("llm-pi-ai") : null
        const providersRaw = (ns && typeof ns === "object" && !Array.isArray(ns)
          && ns.providers && typeof ns.providers === "object" && !Array.isArray(ns.providers))
          ? ns.providers : {}
        const effortsOf = (providerKey, modelId) => {
          const p = providersRaw[providerKey]
          const arr = p && Array.isArray(p.models) ? p.models : []
          const m = arr.filter((x) => x && typeof x === "object" && x.id === modelId)[0]
          if (m && m.reasoningEfforts && typeof m.reasoningEfforts === "object") {
            const list = Object.keys(m.reasoningEfforts).filter((k) => m.reasoningEfforts[k] !== null && m.reasoningEfforts[k] !== undefined)
            return list.length > 0 ? list : null
          }
          return null
        }
        const providers = []
        if (llmReady) {
          const infos = await llm.listProviders()
          for (const info of Array.isArray(infos) ? infos : []) {
            const key = info && typeof info.id === "string" ? info.id : null
            if (!key) continue
            let models = []
            try { models = await llm.listModels(key) } catch { models = [] }
            providers.push({
              id: key,
              displayName: info && typeof info.name === "string" ? info.name : key,
              models: (Array.isArray(models) ? models : []).map((m) => ({
                id: m && typeof m.id === "string" ? m.id : null,
                name: m && typeof m.name === "string" ? m.name : null,
                efforts: effortsOf(key, m && m.id),
              })).filter((m) => m.id),
            })
          }
        } else {
          // 门面 ctx.llm（仅 stream）构建的降级路径：settings 覆盖层作目录源（id+models+efforts）。
          // 虽非权威（缺内置路由），但设置页 dsh 行下拉立即可用；下拉外的内置路由键仍可手输
          // （配合 knownProviderKeysExtended 的 runtime 不可读 → 跳过存在性校验语义）。
          for (const [key, p] of Object.entries(providersRaw)) {
            if (!p || typeof p !== "object") continue
            const models = Array.isArray(p.models) ? p.models : []
            providers.push({
              id: key,
              displayName: typeof p.name === "string" && p.name ? p.name : key,
              models: models.map((m) => ({
                id: m && typeof m.id === "string" ? m.id : null,
                name: m && typeof m.name === "string" ? m.name : null,
                efforts: effortsOf(key, m && m.id),
              })).filter((m) => m.id),
            })
          }
        }
        if (providers.length === 0) {
          return send({ ok: false, error: llmReady
            ? "llm 运行时注册表为空（listProviders 返回空）"
            : "llm runtime 不可用（listProviders 缺失）且 settings 无 llm-pi-ai.providers" }, 502)
        }
        return send({ ok: true, providers, source: llmReady ? "runtime" : "settings" })
      }

      if (req.method === "PUT" && path === "/config") {
        let body
        try { body = JSON.parse(await readBody(req) || "{}") } catch (e) {
          return send({ ok: false, error: "invalid JSON body: " + (e?.message ?? String(e)) }, 400)
        }
        const known = await knownProviderKeysExtended(opts)
        const v = validateGlobalUserConfig(body?.config, known)
        if (!v.ok) return send({ ok: false, errors: v.errors }, 400)
        const saved = saveUserConfig(v.sanitized ?? {}, opts?.dshHomeOverride, opts?.cwdHint?.())
        if (!saved) return send({ ok: false, error: "failed to write user config (see console warn)" }, 500)
        const notes = [...v.notes]
        // 评审 #5：consult/escalate 工具注册基于启动时池快照——池从空到有需重启才注册（内容保存已即时生效）
        if (opts?.registeredPoolEmpty && Array.isArray(v.sanitized?.consultModels) && v.sanitized.consultModels.length > 0) {
          notes.push("consult/escalate 工具注册基于启动时池——新增模型池需重启 DSH 后工具才可用（配置已保存生效）")
        }
        return send({
          ok: true,
          user: v.sanitized ?? {},
          ...(notes.length > 0 ? { notes } : {}),
        })
      }

      if (req.method === "DELETE" && path === "/config") {
        // 批 20 修复轮（D20-8 / AC-8 / US-8）：接住 clearUserConfig 的返回值——清除失败不得谎报成功
        //（对齐 PUT 路径既有先例：失败 ⇒ ok:false + 500；改前此处丢弃返回值并无条件 ok:true）。
        const cleared = clearUserConfig(opts?.dshHomeOverride, opts?.cwdHint?.())
        if (!cleared) return send({ ok: false, error: "failed to clear user config (see console warn)" }, 500)
        return send({ ok: true })
      }

      if (req.method === "POST" && path === "/apply-session") {
        let body
        try { body = JSON.parse(await readBody(req) || "{}") } catch (e) {
          return send({ ok: false, error: "invalid JSON body: " + (e?.message ?? String(e)) }, 400)
        }
        const r = applySessionOverride(opts, body?.sessionId, body?.advisor)
        if (r.reason === "no-session") return send({ ok: false, reason: "no-session" }, 404)
        if (!r.ok) return send({ ok: false, errors: r.errors }, 400)
        return send({ ok: true, override: r.override })
      }

      if (req.method === "DELETE" && path === "/session") {
        const r = resetSessionOverride(opts, query.get("sessionId") ?? "")
        if (r.reason === "no-session") return send({ ok: false, reason: "no-session" }, 404)
        return send({ ok: true })
      }

      return send({ ok: false, error: "not found: " + req.method + " " + path }, 404)
    } catch (e) {
      // 500 兜底（§3.2）：未知异常 → 统一 {ok:false}，路由不裸抛
      return send({ ok: false, error: String(e instanceof Error ? e.message : e) }, 500)
    }
  }
}

/**
 * 注册 config API 前缀路由（webServer 可用时）。缺服务 → console.warn 跳过注册并返回
 * null（U8 降级路径：host 功能/工具不受影响——它们不依赖 webServer）。
 * @returns {(() => void)|null} webServer.register 的 disposer（push 进 ctx.effect disposes）
 */
export function registerConfigApi(ctx, opts) {
  if (!ctx?.webServer || typeof ctx.webServer.register !== "function") {
    console.warn("[thincoder-suite] webServer service unavailable — settings config API routes skipped (host tools unaffected)")
    return null
  }
  return ctx.webServer.register({
    kind: "prefix",
    path: CONFIG_API_PREFIX,
    handler: makeApiHandler(ctx, opts),
  })
}

// ————————————— D-30（FR-T2 静默面 ①）：旧密钥环境变量的一次性弃用告警 —————————————
// D-30 删除了 design token 的签名腿与整条密钥链后，THINCODER_TOKEN_SECRET 变为**无声 no-op**——
// 运维会误以为它仍在生效（设计评审 #9 要求显式处理该静默）。启动时检测到该 env 非空 → 打印
// 恰好一次弃用告警（说明密钥链已删除、该变量不再有任何作用）。进程级 once 标记：多次 apply /
// fiber 重建不重复刷屏。
// 静默面 ②（磁盘上的孤儿密钥文件）**声明不清理、留档**——删除属破坏性动作，不在本批范围
// （README 已注明其已被弃用）。
let deprecatedSecretEnvWarned = false

/**
 * 一次性弃用告警（可测入口：AC-26）。
 * @param {object} [env] — 环境（测试注入缝；缺省 process.env）
 * @returns {boolean} 本次是否打印了告警
 */
export function warnDeprecatedTokenSecretEnvOnce(env = process.env) {
  if (deprecatedSecretEnvWarned) return false
  const v = env?.THINCODER_TOKEN_SECRET
  if (typeof v !== "string" || v.trim() === "") return false
  deprecatedSecretEnvWarned = true
  console.warn("[thincoder-suite] THINCODER_TOKEN_SECRET is set but has NO effect anymore — the design-token "
    + "secret chain (HMAC signature leg) was removed in D-30. The design token is now a two-part uuid:expiresAt "
    + "guarded by exact-match + design-document-set fingerprint. This variable can be unset; the orphan key file "
    + "under $DSH_HOME/.thincoder is intentionally left in place.")
  return true
}

/** 测试缝：清一次性标记（使下一轮 apply/调用可再次打印）。 */
export function resetDeprecatedSecretEnvWarnForTests() { deprecatedSecretEnvWarned = false }

// ————————————— apply —————————————

export function apply(ctx, rawConfig) {
  // 配置尽力解析（cordis 可能经 patch entry config / 预设 group config 传入）
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {}
  // 二期（§2/§3.6-1）：注册期可见配置 = entry base ⊕ config.json user 层（consult/escalate
  // 工具的注册判定据此；call-time 每次执行再读一次——user 层保存即生效 U5）。
  const appliedCfg = effectiveGlobalConfig(config)
  const pool = Array.isArray(appliedCfg.consultModels)
    ? appliedCfg.consultModels.filter(m => m && typeof m === "object" && ((m.provider && m.model)
      // 批 33：app-server 行同样是**可用的一行**（否则「池里只有 app-server 行」时 consult 工具
      // 根本不会注册——US-1 直接失效）。字符串简写形态也收（归一化后语义相同）。
      || (m.runner && (m.runner.kind === "codex-cli" || m.runner.kind === "codex-app-server" || m.runner === "codex-app-server"))))
    : []
  const configDefaultEngineering = Boolean(config.engineering)

  // R2 §4.5（D-11）：启动清扫陈旧 thincoder-codex-* 临时目录（>24h——宿主硬死孤儿缓解；
  // 进程级清扫无可靠属主标记 = 文档化边界 B9，登记表 D-11）。失败不阻塞装配。
  try { sweepStaleCodexTempDirs() } catch { /* 清扫失败不阻塞 */ }

  // D-30（FR-T2 静默面 ①）：旧密钥环境变量已无任何作用 —— 启动时一次性弃用告警（绝不静默）。
  try { warnDeprecatedTokenSecretEnvOnce() } catch { /* 告警失败不阻塞装配 */ }

  // 批 28（US-2 / D28-1）：装配期版本哨兵——三态：与基线一致 ⇒ 静默；不一致 ⇒ **一条响亮告警**
  // 且**不阻断装配**；四源皆取不到 ⇒ 按 unknown 告警（不猜、不崩，A28-3）。「只警告」是纪律
  // （D28-1）：拒启动会变成新的砖化源。进程级 once（模块内标记）：多次 apply / fiber 重建不刷屏。
  // 用户侧的常驻提示落点 = 下方 contractWatch 的**工具描述**（A28-2 评审 #8：设置页无可挂载点则不设）。
  // ★ 批 31：硬门槛**不靠本哨兵**——组合包在 package.json 声明 peerDependencies @deepseek-ai/dsh，
  //   低版平台由**平台自己的**组合兼容闸门（evaluatePluginCompatibility）在装配前拦下并给出指引；
  //   本哨兵只负责「同区间内的契约漂移」告警（只警告不阻断）。
  //   ★ 评审 #1：与 contractWatch 同基座——cwdHint 统一走 cwdHintOf(ctx)（源② 的 home 探测不再退化到进程 cwd）。
  try { runVersionSentinel(ctx, { cwdHint: cwdHintOf(ctx) }) } catch { /* 哨兵自身的任何故障都不得阻断装配 */ }

  // —— 会话可见性注册表（config API session 端点的 no-session 判定辅助；agents 服务优先） ——
  const sessionRegistry = new Set()
  const markSessionSeen = (id) => { if (id) sessionRegistry.add(String(id)) }

  ctx.effect(() => {
    const disposes = []

    // —— 提示词 section ——
    if (ctx.systemPrompt?.section) {
      disposes.push(ctx.systemPrompt.section({
        name: "thincoder:discipline",
        order: 3000,
        text: DISCIPLINE,
      }))
      if (pool.length > 0) {
        disposes.push(ctx.systemPrompt.section({
          name: "thincoder:main",
          order: 3100,
          text: MAIN_EXTRA,
        }))
      }
    }

    // —— 工具注册 ——
    const register = (tool) => {
      if (typeof ctx.tools?.register === "function") disposes.push(ctx.tools.register(tool))
    }

    register(textTool({
      name: "advisor",
      description:
        "Run an independent review on your work (read-only sub-agent with its own tools). " +
        "type='code' (default): review code changes — pass paths=[...] (files/dirs) and/or documents=[...] (acceptance criteria context). " +
        "type='design': review design documents BEFORE implementation — pass documents=[...] (explicit doc list). " +
        "Round 1 does a full review; round 2 verifies your fix claims + obvious new issues; round 3+ strictly verifies only the prior table. The 5-round convergence cap applies to type='code' only — type='design' is exempt from the cap but is bounded instead by the settlement guard (3 consecutive design reviews of the same document set with no usable settlement block further reviews of that document set: zero LLM, not clearable inside the session — the only exit is a new session). " +
        "After each review you MUST reply with a response table: | # | Action | Detail | (Action in Fixed / Dispatched / Not an issue / Deferred; Dispatched = delegated to a subagent/job and NOT yet verified — name the target in Detail, and an unverified Dispatched 🔴 blocks convergence like an unfixed 🔴). " +
        "A design review that passes returns a design token for eng_coder.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["code", "design"], description: "'design' for design-doc review, 'code' (default) for code review" },
          paths: strArr("Code files/directories to review (code review)"),
          documents: strArr("Doc paths: review scope (design review) or acceptance-criteria context (code review)"),
        },
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "Advisor: no agent context."
        // 批 4（D-G7/§5.6）：**工具层三振预检**——同一判定（同一 designDocKey / 同一计数查询 /
        // 同一护栏串），在进入核心层之前快速返回。零 LLM（runAdvisorReview 根本不被调用）、
        // 零状态变更。核心层 runAdvisorReview 内另有一道直调防线（两级防线：直调不经本工具时
        // 仍被拦），两处共用同一实现，不复制判定逻辑。
        if (args?.type === "design") {
          const docKey = designDocKey(args?.documents)
          if (designStrikes(agent.session.id, docKey) >= DESIGN_STRIKE_LIMIT) {
            return settlementGuardText(agent.session.id, docKey)
          }
        }
        markSessionSeen(agent.session.id)
        // ctx 注入：codex runner 长评审经 ctx.jobs 派后台任务（ advisor.mjs 懒取）
        // 批 40（FR-2 的**生产侧**接线）：显式带平台——lib/system-proxy.mjs 只认 deps.platform，
        // 不用 process.platform 兜底 ⇒ 漏这一处 = 该机制的 codex 行永远读不到系统代理。
        return runAdvisorReview({ llm: ctx.llm, ctx, platform: process.platform }, {
          agent,
          config,
          signal: exec?.signal,
          reviewType: args?.type,
          documents: args?.documents,
          paths: args?.paths,
          configDefaultEngineering,
        })
      },
    }))

    register(textTool({
      name: "advisor_config",
      description:
        "Inspect or override the advisor configuration FOR THIS SESSION (design docs/2026-09-01-advisor-config-design.md §3.6). " +
        "The request argument is a JSON object TEXT, e.g. " +
        "{\"action\":\"get\"} | {\"action\":\"set\",\"path\":\"round1.effort\",\"value\":\"low\"} | {\"action\":\"reset\",\"path\":\"round1\"}. " +
        "Settable paths: round1|convergence . provider|model|effort|timeoutMs|runner, or includeProjectGuide (boolean). " +
        "reset path: round1|convergence|includeProjectGuide|all (omit = all). " +
        "Session overrides take priority over the global group config for this session only; effort accepts off|low|medium|high|max; timeoutMs is a number in 1000..3600000.",
      parameters: {
        type: "object",
        properties: {
          request: { type: "string", description: "JSON object text: {action, path?, value?} (see tool description)" },
        },
        required: ["request"],
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "Error: no agent context."
        const out = runAdvisorConfigTool(String(args?.request ?? ""), {
          config,
          // 批 32 / D-62：显示面同样取**活动路由**（否则设置页会展示一条用户早已不用的旧通道；
          // 且与硬停指纹的输入面保持一致——同一份读取面，不该两处各读各的）。
          agentOpts: liveAgentRoute(agent),
          state: sessionState(agent.session.id),
          sessionId: agent.session.id,
        })
        // F12（§2.3 写点表）：advisor_config set/reset（advisorOverride 变更）后写盘。
        // get/invalid 分支不改状态不写；写盘 fail-safe（N3：仅 warn 不抛，内存态兜底）。
        // R2 §4.4：全部写点经 sessionStateViewWithGeneration（generation 随 F12 视图持久化）。
        if (typeof out === "string" && /^advisor_config: (set|reset) /.test(out)) {
          try {
            saveSessionState(
              agent.session.id,
              sessionViewFor(agent.session.id, agent.session?.header?.cwd),
              undefined,
              agent.session?.header?.cwd,
            )
          } catch { /* N3：写盘失败不阻塞 */ }
        }
        return out
      },
    }))

    register(textTool({
      name: "eng",
      description:
        "Toggle engineering mode for this session. enter: you become the architect — clarify requirements, write design docs, WAIT for the user to initiate the design review; implementation goes through eng_coder only. exit: restore standard workflow.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["enter", "exit"], description: "'enter' or 'exit'" },
        },
        required: ["action"],
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "Error: no agent context."
        return engineeringToggle(agent, args?.action)
      },
    }))

    register(textTool({
      name: "eng_coder",
      description:
        "Spawn the implementation sub-agent (engineering mode). Requires the design token from a PASSED advisor(type='design') review — pass it via the designToken parameter, never in the task text. Provide: task (what to implement), docs (the Docs involved list — design doc + requirements), and the token. " +
        "For large tasks pass stages: a structured stage list (2-8 recommended, max 10) — each stage { goal, files, acceptance, check } where check is the HOST acceptance recipe (the host runs it after delivery; on the dsh path you must NOT run it yourself — report the command verbatim instead); the brief then enforces ordered execution, STOP on a stage failing twice, and a stage status table at the top of the delivery report. " +
        "If a stage fails, re-spawn ONE new eng_coder with corrected stages starting from the failed stage (the token is not consumed) — that authorization applies ONLY to a stage the sub-agent itself declared failed in a complete report. " +
        "If eng_coder crashes / times out / is aborted (or otherwise returns a non-success status that is not a self-declared stage failure), do NOT re-spawn on your own — stop, report, and let the user decide. " +
        "The dsh sub-agent path runs as a BACKGROUND job by default (omit background or pass true; pass false to force synchronous execution): the tool return is a job handle, NOT the delivery — wait for the completion notice, then read the FULL report PREFERABLY from the persisted file $DSH_HOME/.thincoder/jobs/<jobId>.txt (batch-26 self-persisted copy, D-45; job_output is an additional reader — the reading-'output' failure once blamed on the platform was traced on 2026-09-28 to a third-party plugin shadowing ctx.jobs.read; that plugin is uninstalled and reading works again), verify it, and run the delivery review (advisor type='code').",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Implementation task: goal, constraints, file list, acceptance criteria" },
          designToken: { type: "string", description: "The exact token returned by a passed advisor(type='design') review" },
          docs: strArr("Docs involved: design doc + requirements + referenced docs (paths)"),
          background: { type: "boolean", description: "dsh 子代理路径默认后台执行（返回 job 句柄，等完成通知后首选读落盘文件 $DSH_HOME/.thincoder/jobs/<jobId>.txt——批 26 自持落盘（D-45），job_output 作为附加）；传 false 强制同步（内部截止 codexCli.budgetCapMs，受平台墙钟约束）" },
          // F13（§3.1）：结构化 stages——工具 schema 层校验（不是 task 里写 markdown，防主代理
          // 格式漂移无法机械约束）。空字段由 schema 拒绝（required + minLength 1 / minItems 1，
          // 评审 #13）；渲染前另有代码级防御校验（实施确认项 5，eng.mjs validateStages）。
          stages: {
            type: "array",
            maxItems: 10,
            description: "Structured execution stages (2-8 recommended, max 10). A stage's check is the HOST acceptance recipe (host-executed by default on the dsh path; checkMode: the host runs it after delivery and appends the receipt) — on the dsh path the sub-agent must NOT execute it. A stage failing twice stops the run.",
            items: {
              type: "object",
              properties: {
                goal: { type: "string", minLength: 1, description: "Stage goal" },
                files: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "Files this stage may touch" },
                acceptance: { type: "string", minLength: 1, description: "Acceptance criteria for this stage" },
                check: { type: "string", minLength: 1, description: "Host acceptance recipe: the command the HOST runs after delivery (e.g. a syntax check of the files this stage changes, or the project's test command on a subset). On the dsh path the sub-agent must not run it — it reports the command verbatim." },
                // 批 26 / D48-1（US-6）：验证门归位——「谁来跑 check」由派发参数决定，不再靠任务书里
                // 一句可能被忽略的免责声明。dsh 路径缺省 host（宿主交付后执行并回写验收回执），
                // codex 路径缺省 subagent；显式值永远优先。
                checkMode: { type: "string", enum: ["subagent", "host"], description: 'Who runs the check: "host" (default on the dsh path — the host executes it after delivery and appends the receipt to the report) or "subagent" (default on the codex path)' },
              },
              required: ["goal", "files", "acceptance", "check"],
            },
          },
        },
        required: ["task", "designToken"],
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "Error: no agent context."
        markSessionSeen(agent.session.id)
        // F9 资源项（engCoderMaxTokens/engCoderEffort）在 user 层可配——call-time 合并（U5）
        const effCfg = effectiveGlobalConfig(config)
        // ★ 批 33（设计档 §8 负向腿 / §9 守卫行）：写任务档位 = 只读通道 ⇒ **本地具名 fail-closed
        // 拒绝**（不派发、不消耗 design token、不写工作区）。为什么在这一层：PUT 校验拦得住设置页与
        // config API，但**手编 config.json** 绕过 PUT —— 运行时这一道是同一句话的第二入口（单一事实源）。
        if (effCfg?.codexCli && typeof effCfg.codexCli === "object" && effCfg.codexCli.engCoderRunner === "codex-app-server") {
          console.warn("[thincoder-suite] " + ENG_APP_SERVER_RUNNER_REFUSAL)
          return "Error: " + ENG_APP_SERVER_RUNNER_REFUSAL
        }
        return runEngCoder({ ctx, agent, config: effCfg, signal: exec?.signal, configDefaultEngineering, platform: process.platform }, args)
      },
    }))

    if (pool.length > 0) {
      register(textTool({
        name: "escalate",
        description:
          "TERMINOLOGY: 'escalate' is the only technical name; 飞刀 is the Chinese alias. When the user says 飞刀 / escalate / 'fly in <model>', call THIS tool directly. " +
          "Hand an implementation task to a stronger model — it gets WRITE access and does the work itself, then returns a post-op report (changes, why, verification). " +
          "Use it when YOU judge the task needs stronger hands (complex multi-file refactor, intractable bug, intricate algorithms — or beyond your comfortable ability); escalate EARLY, on up-front judgment. " +
          "You review its report (read the changed files, run the tests). For parallel READ-ONLY opinions use consult_start instead. Not available in engineering mode.",
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task description with acceptance criteria" },
            model: { type: "string", description: "Candidate 'provider:model' from the consult models (optional, default first)" },
            followup: { type: "boolean", description: "codex rows only: continue the previous codex escalate thread in this session (exec resume; threadId kept in memory, never persisted)" },
            background: { type: "boolean", description: "dsh 子代理路径默认后台执行（返回 job 句柄，等完成通知后首选读落盘文件 $DSH_HOME/.thincoder/jobs/<jobId>.txt——批 26 自持落盘（D-45），job_output 作为附加）；传 false 强制同步（内部截止 codexCli.budgetCapMs，受平台墙钟约束）" },
          },
          required: ["task"],
        },
        async execute(args, exec) {
          const agent = exec?.agent
          if (!agent?.session) return "Error: no agent context."
          markSessionSeen(agent.session.id)
          // consultModels 池在 user 层可配（整体替换）——call-time 合并（U5）
          // 批 21（FR-1④ / 设计档 §5.1 ④）：三态透传 args?.background——此前 `=== true` 把 undefined
          // 压成 false，escalate 的默认后台翻转会完全静默失效（会诊 G5④ 抓到的父侧漏洞）。
          const out = await runEscalate({ ctx, agent, config: effectiveGlobalConfig(config), state: sessionState(agent.session.id), signal: exec?.signal, configDefaultEngineering, platform: process.platform }, args?.task, args?.model, args?.followup === true, args?.background)
          // F12（§2.3 写点表）：escalate 交付后写盘（mutatedThisRun/touchedFiles 返回并入处）。
          // 写点放调用侧（escalate.mjs 按设计不动——parseTouchedFiles 兼容；§2.3 语义等价：
          // 状态变更已在内存，落盘时机在工具返回前）。fail-safe（N3：仅 warn 不抛）。
          // R2 §4.4：全部写点经 sessionStateViewWithGeneration；后台派发路径的交付簿记
          // 落盘在 escalate done 回调内（此处仅同步交付）。
          try {
            saveSessionState(
              agent.session.id,
              sessionViewFor(agent.session.id, agent.session?.header?.cwd),
              undefined,
              agent.session?.header?.cwd,
            )
          } catch { /* N3：写盘失败不阻塞 */ }
          return out
        },
      }))

      register(textTool({
        name: "consult_start",
        description:
          "Start a parallel multi-model consultation (会诊) for a hard problem you are stuck on (repeated failures, no headway). Call it directly when the user asks for 会诊 / consult. " +
          "Several configured models analyze the same problem INDEPENDENTLY in parallel (read-only). Non-blocking: returns the consult id plus a background-job handle. " +
          // 批 15（FR-2）：**逐字反转**批 14 的 A 项那句「There is NO completion notification … you must come back yourself」
          //（提交 37d7eef 写死的那句在本批之后为假——consult 现在**走平台 jobs**，与 advisor / eng_coder / escalate 同形）。
          "★ Delivery is AUTOMATIC: consult now runs as a platform job (exactly like advisor / eng_coder / escalate), so when the session settles you ARE notified in-session — injected into your next step while you are busy, or opening a turn when you are idle. " +
          "Do NOT poll and do NOT end your turn waiting on a channel that does not exist: you no longer need to come back yourself. " +
          // 批 15（FR-3 / P4）：完成通知只有一行指针 ⇒ 正文必须再读一次
          "When the completion notice arrives, read the FULL digest — preferred: the persisted file $DSH_HOME/.thincoder/jobs/<jobId>.txt (batch-26 self-persisted copy, D-45), job_output as an additional reader (the notice carries a pointer only) — then dispose of EVERY reply — adopted / rejected with a reason / pending — and by default STOP and report to the user. " +
          // 批 15（FR-3 / US-9）：门禁 + 三豁免档 + 纪要落档（缺省不是豁免）
          "★ Digestion gate: this call is REFUSED (nothing is dispatched) while a settled consult of this session has neither been digested nor explicitly exempted; the refusal inlines the un-digested digest and shows the ack form. Ack with `digested: [{id, minutesPath}]` after writing the minutes (the file must exist) or `digested: [{id, minutesExempt:{reason}}]` to exempt the minutes with an explicit reason. " +
          "Minutes are the default record; stopping counts as a normal settle and still produces a digest (a tombstone one). " +
          "The brief decides the quality: symptom + what you already tried + entry-point files, ~150 words max.",
        parameters: {
          type: "object",
          properties: {
            problem: { type: "string", description: "Problem brief (symptom + failure trail + entry files)" },
            models: strArr('Optional subset of the pool: "provider:model", bare provider, or bare model (case-insensitive)'),
            // 批 15（FR-3 / D15-8）：**仅「无人值守」在 start 时声明**——「明确目标」与「明确授权」
            // 在**送达时判**（要求引用对话原话 / 既有授权文档），settle 前合成不到它们。
            exemption: {
              type: "object",
              description: "Declared-at-start exemption. ONLY the 'unattended' case belongs here; the 'goal' / 'authorized' cases are judged at delivery time and recorded in the minutes' ruling layer + the ack. Declaring it does NOT exempt you from reading the digest and disposing of every reply.",
              properties: {
                kind: { type: "string", enum: ["unattended"], description: "The only exemption declarable at start (the user is away and cannot be reported to)" },
                note: { type: "string", minLength: 1, description: "Required: why this delivery may continue instead of stopping — this note is the trace" },
              },
              required: ["kind", "note"],
            },
            // 批 15（FR-3 / §5.7）：消化门禁的恢复通道
            digested: {
              type: "array",
              description: "Ack of already-settled consults of this session (clears the digestion gate). One entry per consult: {id, minutesPath} (the file must exist on disk) or {id, minutesExempt:{reason}} (an explicit exemption, reason required).",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", minLength: 1, description: "Consult id (the N in `consult #N`)" },
                  minutesPath: { type: "string", description: "Minutes file you wrote/extended (fs existence is checked)" },
                  minutesExempt: {
                    type: "object",
                    description: "Explicit exemption from writing minutes (reason required — the trace)",
                    properties: { reason: { type: "string", minLength: 1 } },
                    required: ["reason"],
                  },
                },
                required: ["id"],
              },
            },
          },
          required: ["problem"],
        },
        async execute(args, exec) {
          const agent = exec?.agent
          if (!agent?.session) return "Error: no agent context."
          markSessionSeen(agent.session.id)
          const state = sessionState(agent.session.id)
          // 批 40（FR-2 / 评审 #3）：显式带平台——lib/system-proxy.mjs **只认 deps.platform === "win32"**，
          // 不用 process.platform 兜底 ⇒ 任何没带 platform 的夹具在任何机器上都「零读取」。
          const deps = { ctx, agent, config: effectiveGlobalConfig(config), state, persona: undefined, platform: process.platform }
          // ★ 门禁不变量（US-9 / AC-19）：不存在 `settled ∧ ¬digested ∧ ¬minutesExempt` 的会话。
          // 命中 ⇒ **拒发** + 内联未消化 digest + ack 指引 ⇒ **未派发任何子代理**（拒发即恢复通道）。
          const gate = consultDigestionGate(state, args?.digested, deps)
          if (gate.blocked) return gate.text
          const r = await startConsultSession(
            // D-28：不传 signal——consult 子代理自持控制器（继承 PTC run-scoped 信号会在
            // run_code 程序 settle 时被 abort，平台 job 里的会诊永远读不到回复）
            deps,
            String(args?.problem ?? ""), args?.models, args?.exemption,
          )
          // 拒发（jobs 缺失 / jobs.start 抛错 / 池与选择器不合法）⇒ 响亮错误文本，零部分工作
          //（D15-4：**不回落同步**——同步路径接不住 consult 的预算）
          if (r.error) return r.error
          // FR-1（§6.2 @post）：返回 job 句柄文本（复用 jobsDispatchReply 先例）——
          // 投递由平台 onJobDone 承担，本仓不再需要任何「回来读」的动作。
          // FR-3（AC-26）：台账孤儿（有 started 无 settle）⇒ **建议性提示、不阻断**。
          const orphans = consultLedgerOrphans(deps, state)
          const orphanNote = orphans.length === 0 ? "" : "\n\n[thincoder-suite] 台账孤儿（建议性提示，不阻断）："
            + orphans.map((o) => "#" + o.id + "（" + (o.at === null ? "时间未知" : new Date(o.at).toISOString()) + " 发起，未见 settle）").join(" · ")
            + "——可能因重启丢失（`consultSessions` 纯内存）。"
          return r.text + orphanNote
        },
      }))

      register(textTool({
        name: "consult_stop",
        description:
          "Terminate the still-running consultations once a reply is good enough — saves tokens and time. " +
          // 批 15（D15-3 / AC-20）：stop 不再有损——墓碑 digest 保住已收到的回复 + stop 死亡行
          "★ Stopping loses NOTHING: the session still settles into a tombstone digest (the replies received so far plus the stop death line) and that digest is delivered exactly like a normal one. " +
          "Use it also when you must leave the consult unattended — the delivery will find you either way.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Consult id from consult_start (the number in `consult #<id>`)" },
            n: { type: "number", description: "Incrementing call number (next value after the last consult_start/consult_stop)" },
          },
          required: ["id", "n"],
        },
        async execute(args, exec) {
          const agent = exec?.agent
          if (!agent?.session) return "Error: no agent context."
          markSessionSeen(agent.session.id)
          const r = stopConsultSession(sessionState(agent.session.id), args?.id, args?.n,
            { ctx, agent, config: effectiveGlobalConfig(config), state: sessionState(agent.session.id), persona: undefined })
          return JSON.stringify(r)
        },
      }))
    }

    // —— 批 28（US-3 / D28-4）：契约面只读巡检工具 ——
    // 十条谓词与 test/platform-surface.test.mjs 同源（批 34 C11 起 9→10）（import 自 lib/contract-baseline.mjs，
    // A28-5：不存在第二份字面）；返回形状钉死（A28-4）：{ platformVersion, versionSource, locks, jobsDir }。
    // locks = 9 条 { id, ok: true|false|"unknown", evidence }（一律源码文本求值：零网络、零真实
    // LLM、零子进程；取不到文本记 "unknown" 而非 false——D28-7）。
    // ★ 版本哨兵的用户提示**钉死落在本工具描述**（A28-2 评审 #8）：文案含基线档（lib/contract-baseline.mjs）
    //   与 docs/dsh017- 设计档字样；设置页无可挂载点则不设。
    register(textTool({
      name: "contractWatch",
      description:
        "Read-only contract-surface inspection (batch 28, US-3; source chain widened in batch 31): one call returns { platformVersion, versionSource, versionEvidence, locks, jobsDir }. " +
        "platformVersion = the resolved platform version ('unknown' when none of the FOUR sources is readable — ctx.pkg / profile manifest / the pluginManager service's platform bundle version / a platform package under the desktop Electron layout); " +
        "versionSource = which source produced it (ctx.pkg | profile-manifest | plugin-manager | package-json | unknown); " +
        "versionEvidence = where that value came from — and, when the version is 'unknown', the PER-SOURCE diagnostic of why each source missed (read this first after a platform upgrade); " +
        "locks = the NINE platform contact-point locks, each { id, ok: true|false|\"unknown\", evidence } — the same predicates as test/platform-surface.test.mjs (single source of truth lib/contract-baseline.mjs), evaluated over source text only (zero network, zero LLM, zero subprocesses); " +
        "jobsDir = the persisted job-report directory stats { files, bytes, oldestDays }. " +
        "SUPPORTED PLATFORM: this release supports DSH " + PLATFORM_VERSION_BASELINE + " and newer within the declared peer range. " +
          "On an OLDER DSH the bundle is refused by the platform's own peer-dependency compatibility gate — install an older release of this plugin instead (v0.29.11 supports DSH 0.1.7-rc.2). " +
        "★ Version sentinel (batch 28): when the detected platform version differs from the verified baseline ("
          + PLATFORM_VERSION_BASELINE + ", recorded " + BASELINE_RECORDED_AT + " in lib/contract-baseline.mjs), the plugin prints one loud NON-blocking warning at assembly — " +
        "the contract matrix lives in docs/dsh017-program-closeout.md, with per-batch details in docs/dsh017-batch26-design.md / docs/dsh017-batch27-design.md / docs/dsh017-batch28-design.md. " +
        "Run THIS tool first whenever a platform upgrade is suspected (it shows all nine lock verdicts plus the version evidence); if any lock turned red, open a new batch instead of patching ad hoc.",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        // ★ 批 31 评审 #1：版本读数与 jobsDir **用同一个 home 探测基座**（原先 readPlatformVersion 裸调，
        //   源② 便只能拿插件进程 cwd 去探 profile 根——同一工具两条腿基座不一致，恰好削弱「下一轮真机
        //   读数直接判读」的目标：源② 本可命中却 miss，只留一行 note）。
        const v = readPlatformVersion(ctx, { cwdHint: cwdHintOf(ctx) })
        const locks = evaluatePlatformSurfaceLocks()
        // cwdHint：home 探测基座（与各 store 同语义——DSH_HOME 未设时从会话 cwd 向上探测 profile 根）
        const jobsDir = jobsDirStats({ cwdHint: cwdHintOf(ctx) })
        return JSON.stringify({ platformVersion: v.version, versionSource: v.source, versionEvidence: v.evidence, locks, jobsDir }, null, 2)
      },
    }))

    // —— 写门禁（tools/pre-execute waterfall） ——
    const offGate = ctx.on("tools/pre-execute", makeWriteGate(() => configDefaultEngineering))
    disposes.push(offGate)

    // —— 守卫 E 预闸（批 6b §6.4 / D-E1：**独立**监听器，不并进写门禁——两者 fail 朝向相反） ——
    // 两闸拒域**按设计意图**不相交（冻结集 = 文档 vs isProductCode = 非文档）；即便重叠也无害
    //（deny 可复合，注册次序仍无关）。不主张「构造性」——isProductCode 与（批 7 已删除的）isDocFile **曾是**两份
    // 互相矛盾的谓词，现统一于 path-kind.mjs 单一权威。放后侧保持既有门禁位置零移动。
    const offFreezeGate = ctx.on("tools/pre-execute", makeDocFreezeGate(() => designFreezeSet()))
    disposes.push(offFreezeGate)

    // —— 会话销毁清理（abort 会诊控制器 + 会话注册表移除） ——
    // F12（§2.4）：追加 removeSessionState——session-state.json 删除该 sessionId 条目（镜像
    // removeTokenRecord；不阻塞 consult 清理——remove 内部 fail-safe 仅 warn 不抛）。
    // 评审 #1：与各 save 点同源传 session cwd（DSH_HOME 未设时 pickDshHome 从会话 cwd 探测
    // profile 根——清理与写入必须落在同一存储文件，否则条目成孤儿只等 7d 清扫兜底）。
    const offDisposed = ctx.on("session/disposed", (session) => {
      try { if (session?.id) sessionRegistry.delete(String(session.id)) } catch { /* 清理失败不阻塞 */ }
      dropSession(session.id, (s) => cleanupConsultSessions(s))
      try { if (session?.id) removeSessionState(session.id, undefined, session?.header?.cwd) } catch { /* 清理失败不阻塞 */ }
      // 评审 #4：codex escalate 线程内存态随会话销毁清理（B14 生命周期闭环）
      try { if (session?.id) clearCodexThread(session.id) } catch { /* 清理失败不阻塞 */ }
      // R2 §4.5（D-22）：codexFailureCount 会话级内存态随会话销毁清理（防跨会话滞留误回落）
      try { if (session?.id) clearCodexFailureCount(session.id) } catch { /* 清理失败不阻塞 */ }
      // 批 4（D-G9/§5.6）：三振结算护栏计数同生命周期清理（会话级内存态；**唯一**解除路径——
      // 显式声明不可自解除：改配置/回滚文件/编辑文档都不复位，故这里不挂 resetRouteFailureState）。
      try { if (session?.id) clearDesignSettlementStrikes(session.id) } catch { /* 清理失败不阻塞 */ }
    })
    disposes.push(offDisposed)

    // ═══════════════════════════ 批 34 · 长任务防漂（anti-drift） ═══════════════════════════
    // 设计档 docs/2026-10-14-anti-drift-design.md（设计令牌 9c126ca2-…，轮 4 `VERDICT: PASS`）。
    // 机制本体**全在 `anti-drift.mjs`**（单点收口）；本区块只做**注册与接线**，零机制逻辑。
    // 三条纪律：① 三域分离（§7）② 失败朝向（判据/完成门 fail-closed；注入/推回/接管 fail-open）
    // ③ 两个监听器体内**绝不抛**（`agent/turn-stopping` 抛错 ⇒ 回合变 error；
    //   `agent/created` 抛错 ⇒ **创建失败**——runtime-types.ts:252-255）。
    // ★ 2026-10-15 热修（评审 #1 · 🔴）：防漂开关的**本会话覆盖层**。
    //   原实现把开关写进 **user 层** config.json —— 两处都错：
    //     ① 违反设计档 :239「本批不碰任何用户层写入面（零新增用户层键）」；
    //     ② `mergeGlobalConfig`（config-store.mjs:281-363）的白名单里**没有 `antiDrift` 分支**
    //        ⇒ 那份写入在读取链上被**静默丢弃**，工具却回「已写入（本会话即时生效）」= **假声明**。
    //   设计档 :241 要的语义本就是「写入在本会话内即时生效…不需要重启」⇒ 覆盖层放在**装配实例内**
    //   （随 fiber 销毁，不跨 HMR 泄漏），**零落盘、零新增用户层键**。
    const adOverrides = {}
    const antiDriftCfg = () => {
      const base = effectiveGlobalConfig(config)
      const baseAd = base && typeof base.antiDrift === "object" && base.antiDrift !== null ? base.antiDrift : {}
      return resolveAntiDriftConfig({ ...base, antiDrift: { ...baseAd, ...adOverrides } })
    }
    const adHint = (agent) => agent?.session?.header?.cwd ?? process.cwd()

    /**
     * F12 持久化视图 = 既有视图 **+ 落章域/验证证据**（用户 2026-10-15 裁定「该记」）。
     * ★ **每一处写盘都必须经它**：`saveSessionState` 是**整条替换**（`sessions[id] = {...v}`），
     *   所以 advisor 路径的一次保存若不带落章域，就会把落章域与验证记录**静默抹掉**。
     *   这条纪律由 `test/anti-drift.test.mjs` 的负控①结构锁守护（写盘调用点不得绕过本函数）。
     */
    const sessionViewFor = (id, cwd) => ({
      ...sessionStateViewWithGeneration(sessionState(String(id))),
      ...antiDriftStateView(String(id)),
    })
    /** 落章域/证据发生变化后立刻落盘（写完即持久，不等下一个语义转换点）。 */
    const persistAntiDrift = (id, cwd) => {
      try { saveSessionState(String(id), sessionViewFor(id, cwd), undefined, cwd ?? cwdHintOf(ctx)) } catch { /* N3：写盘失败仅内存兜底 */ }
    }

    // —— 装配期探测降级（FR-8 / 腿 A-12）：缺面 ⇒ 该面关闭 + **恰一行** warn，绝不阻断装配 ——
    const adProbe = probeAntiDriftSurfaces(ctx)
    for (const line of adProbe.lines) { try { console.warn(line) } catch { /* 告警失败不阻断 */ } }

    // —— FR-3 每步注入行（`systemPrompt.context` 单条贡献；**绝不动 section**）——
    // `text` 是零参闭包 ⇒ 只能捕获**注册时**的 agent。宿主 `AssembleContext` 无 agent 字段
    // （TL 实证 lib/index.js:4846-4849）⇒ 闭包形态是唯一可行解；无活跃目标 ∧ 无欠账 ⇒ 空串。
    // ★ 批 36：任务台账摘要**并入同一条贡献**（FR-4 / 设计-D6：**不新开**第二条 context ——
    //   多开一条 = 多牺牲一份前缀缓存收益。「context 恰 1 处」由**下面两把锁**钉住（**不是腿 T-15** ——
    //   `test/tasks.test.mjs` 的 T-15 没有这条断言）：① `lib/contract-baseline.mjs` 的 **ps10**
    //   （EXPECT 表里对 `systemPrompt.context(` 的调用恰 1 处 —— ★ 注意：**本注释刻意省略 `ctx.` 前缀**，
    //   因为 ps10 与负控① 都是**按源码子串计数**的静态锁，把整串原样写进注释会被它当成第二处；
    //   实测：写全串 ⇒ `#10 anti-drift 宿主面` 与 `负控①` 同时红）；② `test/anti-drift.test.mjs` **负控①**
    //   （`contextCalls === 1`）。
    if (adProbe.surfaces.inject) {
      try {
        const agentAtRegister = ctx.get?.("agent") ?? null
        const sidAtRegister = agentAtRegister?.session?.id
        disposes.push(ctx.systemPrompt.context({
          name: "thincoder:anti-drift",
          order: 3400, // 静态纪律 3000 / main 3100 之后
          text: () => {
            if (!sidAtRegister) return ""
            const adLine = renderAntiDriftLine({
              sessionId: sidAtRegister,
              goal: goalViewOf(ctx, agentAtRegister),
              config: antiDriftCfg(),
              cwdHint: adHint(agentAtRegister),
            })
            // 任务摘要（纯确定性 · 有界 · 空集不出段）——**同一个读函数**（设计-D3 三面同源）
            let taskLine = ""
            try {
              const cwd = adHint(agentAtRegister)
              if (typeof cwd === "string" && cwd.trim() !== "") {
                // ★ 批 42 ⑩ **成本口径**（修复轮订正：设计档 §十二-1d）—— 本行**每回合读两次盘**：
                //   ① `readTasksView(cwd)` 读 `<cwd>/.thincoder/tasks.json`（**fs 读 + JSON 解析各一遍**，
                //      之后全是内存分桶）；② `effectiveGlobalConfig(config)` → `loadUserConfig` 读
                //      `$DSH_HOME/.thincoder/config.json`（`lib/config-store.mjs:181`；缺失/损坏 ⇒ null，
                //      回落 entry base）。`renderTaskDigest` **不做文档解析**（结构化文档只读源
                //      `readChecklistDocs` 只在看板载荷里跑，不在注入面跑）。
                //   为何可接受：两个文件都体量有界、写路径是原子写 ⇒ 每回合两次读盘的代价远小于
                //   **新开**第二条 context 贡献所牺牲的前缀缓存收益（设计-D6）。「context 恰 1 处」的锁是
                //   `lib/contract-baseline.mjs` 的 ps10 与 `test/anti-drift.test.mjs` 负控①（`contextCalls === 1`）
                //   —— **不是腿 T-15**（T-15 只钉依赖/import/todo_write/投影/inject 五面）。
                //   失败方向：任何异常 ⇒ fail-open（下方 catch ⇒ 该段缺席，绝不阻断注入）。
                taskLine = renderTaskDigest(readTasksView(cwd.trim()), {
                  ...resolveLedgerConfig(effectiveGlobalConfig(config)),
                })
              }
            } catch { taskLine = "" } // fail-open：摘要面任何异常都只是「该段缺席」
            // ★ 批 43（FR-3 / D-4）：两段各自有预算、合计也必须封顶 —— **先砍摘要、不砍 anti-drift 行**
            //   （`assembleInjection` 是导出的纯函数；未超限时与旧的 filter+join **逐字相同**）。
            return assembleInjection(adLine, taskLine)
          },
        }))
      } catch (e) { try { console.warn("[thincoder-suite] anti-drift 注入面注册失败（已跳过）：" + (e?.message ?? e)) } catch { /* noop */ } }
    }

    // —— 工具面：goal_criteria（FR-1）+ goal_verify（FR-2）+ anti_drift_config（FR-8）——
    register(textTool({
      name: "goal_criteria",
      description:
        "Record a goal's machine-checkable completion criterion (batch-34 anti-drift, FR-1). "
        + "A goal without a machine-checkable proof of completion is a wish, not a goal — create_goal is "
        + "DENIED unless a criterion slot is set first. Call with action='set' and BOTH criteria (what must "
        + "be achieved) and check (the exact command/output/file to inspect); OMIT goal_id to park it as a "
        + "pending slot that binds to the NEXT goal created in this session. Passing a goal_id requires that "
        + "goal to already exist. action='get' reads the current record; 'clear' removes it.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set", "get", "clear"], description: "'set' (default) writes, 'get' reads, 'clear' removes" },
          criteria: { type: "string", description: "What must be achieved (non-empty; required for set)" },
          check: { type: "string", description: "How to machine-verify it — command / output / file to inspect (non-empty; required for set)" },
          goal_id: { type: "string", description: "Optional. Omit to park as a pending slot for the next create_goal; pass only an EXISTING goal id" },
        },
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "goal_criteria: no agent context."
        const a = String(args?.action ?? "set")
        const hint = adHint(agent)
        if (a === "get") {
          const cur = getCriteria({ sessionId: agent.session.id, cwdHint: hint })
          return cur ? JSON.stringify(cur, null, 2) : "goal_criteria: 无在席记录（建目标前应先 set 一个待绑判据）。"
        }
        if (a === "clear") {
          const r = clearCriteria({ sessionId: agent.session.id, goalId: args?.goal_id, cwdHint: hint })
          return r.cleared.length > 0 ? "goal_criteria: 已清 " + r.cleared.join(" / ") : "goal_criteria: 无记录可清。"
        }
        const hasGoal = (gid) => {
          // ★ 2026-10-15 热修（评审 #7）：读**抛错**（拿不到校验器）⇒ **拒**，与 setCriteria 的结构门
          //   fail-closed 同向（anti-drift.mjs 第 9 轮收紧口径）。此前 catch 返回 `true` 会让
          //   "读不到"变成"放行铸绑定"——与"服务缺席 ⇒ false ⇒ 拒"两个失败面朝向相反。
          try { return Boolean(ctx.get?.("goals")?.get?.(gid)) } catch { return false }
        }
        const r = setCriteria({
          sessionId: agent.session.id,
          criteria: args?.criteria,
          check: args?.check,
          goalId: args?.goal_id,
          hostHasGoal: hasGoal,
          cwdHint: hint,
        })
        if (!r.ok) return "goal_criteria 拒写：" + r.reason
        return r.shape === "pending"
          ? "goal_criteria: 已写入**待绑槽**（建 create_goal 时自动绑定）。现在可以建目标了。"
          : "goal_criteria: 已绑定到目标 " + r.goalId + "。"
      },
    }))

    register(textTool({
      name: "goal_verify",
      description:
        "Record proof that a goal's completion criterion was actually CHECKED (batch-34 anti-drift, FR-2). "
        + "This is the ONLY evidence that lets update_goal(action='complete') pass — weak evidence, plans and "
        + "summaries never count. proofRef must equal the goalId of the currently bound criterion record; "
        + "if there is NO bound record (a goal that predates this plugin), any non-empty proofRef is accepted "
        + "but a summary is then REQUIRED saying what was checked. "
        + "status='passed' stamps the goal as verified; 'failed' is always honoured and can never be overwritten; "
        + "'skipped' requires a summary saying why it need not run. Any later code change invalidates the stamp.",
      parameters: {
        type: "object",
        properties: {
          proofRef: { type: "string", description: "The bound criterion record's goalId; for a goal with no bound record, any non-empty value plus a summary" },
          command: { type: "string", description: "The command actually run (or the inspection performed)" },
          status: { type: "string", enum: ["passed", "failed", "skipped"], description: "Outcome of this check" },
          summary: { type: "string", description: "Short evidence summary; REQUIRED when status='skipped', and also REQUIRED when the goal has no bound criterion record" },
        },
        required: ["proofRef", "status"],
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "goal_verify: no agent context."
        const r = recordVerify({
          sessionId: agent.session.id,
          proofRef: args?.proofRef,
          command: args?.command,
          status: args?.status,
          summary: args?.summary,
          // ★ 2026-10-15 热修（评审 #5）：与 goal_criteria（同档用 `hint`）对齐——此前这里**不转发**
          //   `cwdHint`，非默认 home / 注入 override 的场景下 `getCriteria` 会读到**另一份 store**、
          //   `proofRef` 永远判不匹配。同族缺陷在 L-11 登记过一次（`recordVerify` **内部**那处），
          //   这次是**生产调用点**这一处——两处必须都转发才算闭合。
          cwdHint: adHint(agent),
        })
        if (!r.ok) return "goal_verify 拒写：" + r.reason
        if (r.record.status === "passed") {
          stampVerified(agent.session.id)
          return "goal_verify: 已落章（status=passed）——complete 门现在放行。后续任何代码改动会使本次落章失效。"
        }
        return "goal_verify: 已记录（status=" + r.record.status + "）。"
      },
    }))

    register(textTool({
      name: "anti_drift_config",
      description:
        "Read or flip the batch-34 anti-drift switches (FR-8). Keys (closed set): inject (default true), "
        + "completeGate (default true), pushback (default false), verifyHeuristic (default true), "
        + "ledgerTransitionGate (default false), stallRepeat (default 3 — integer 0-20; how many IDENTICAL "
        + "consecutive tool calls trigger one stall reminder per turn; 0 disables that reminder), "
        + "caps (default {pending:1,verify:2,advisor:3} — three family "
        + "caps, each 0-6, all required; the honesty sentence takes the slot AFTER their sum). "
        + "Writes are SESSION-SCOPED (an in-memory override for this plugin instance): a flip takes effect "
        + "on the next read within this session and is NOT persisted — a restart falls back to the configured "
        + "values. DISABLED in "
        + "engineering mode. NOTE: ledgerTransitionGate is read by dsh-team-link from ITS OWN config surface — "
        + "flipping it here does NOT open that gate.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get", "set"], description: "'get' (default) reads all keys; 'set' writes one" },
          key: { type: "string", description: "Key to write (set only) — must be in the closed set" },
          value: { description: "New value for `key`: boolean, the number 0-20 (stallRepeat), or the caps object", type: ["boolean", "object", "number"] },
        },
      },
      async execute(args, exec) {
        const agent = exec?.agent
        if (!agent?.session) return "anti_drift_config: no agent context."
        const cur = antiDriftCfg()
        const a = String(args?.action ?? "get")
        if (a === "get") return JSON.stringify(cur, null, 2)
        // 工程模式禁写（避免在纪律最重的模式下被临时关掉机制）
        const engOn = Boolean(sessionState(agent.session.id).engineering ?? configDefaultEngineering)
        if (engOn) return "anti_drift_config 拒写：工程模式禁止改动防漂开关（先把工程模式关掉）。"
        const v = validateConfigWrite(args?.key, args?.value)
        if (!v.ok) return "anti_drift_config 拒写：" + v.reason + "（Nothing was written）"
        // ★ 2026-10-15 热修（评审 #1 · 🔴）：**不再写 user 层**——那份写入会被 mergeGlobalConfig
        //   的缺失白名单静默丢弃（写了等于没写，却回报"已生效"）。改为本会话覆盖层：
        //   零落盘、零新增用户层键（设计档 :239），语义与设计档 :241 逐字一致。
        adOverrides[args.key] = v.value
        return "anti_drift_config: " + args.key + " = " + JSON.stringify(v.value)
          + " 已生效（**本会话**；覆盖层不落盘，重启后回到配置文件的值）。"
      },
    }))

    // —— FR-1/FR-2 门（`tools/pre-execute`）：**独立注册**，不并入既有写门/冻结门的函数体 ——
    if (adProbe.surfaces.pushback) {
      try {
        const offAntiDriftGate = ctx.on("tools/pre-execute", async (exec, next) => {
          try {
            const d = await next()
            if (d && d.kind && d.kind !== "accept") return d // 已被既有门拒 ⇒ 原样传下去
            const name = exec?.name
            if (name !== "create_goal" && name !== "update_goal") return d
            const agent = exec?.agent
            const sid = agent?.session?.id
            if (!sid) return d
            const g = gateDecision({
              toolName: name,
              args: exec?.arguments,
              sessionId: sid,
              config: antiDriftCfg(),
              cwdHint: adHint(agent),
            })
            if (g.decision === "deny") return { kind: "deny", reason: g.reason }
            return d
          } catch (e) {
            // fail-open：门自身故障不该锁死会话（设计档 D10 的朝向表）
            try { console.warn("[thincoder-suite] anti-drift 完成门内部异常，本次放行：" + (e?.message ?? e)) } catch { /* noop */ }
            return { kind: "accept" }
          }
        })
        disposes.push(offAntiDriftGate)
      } catch (e) { try { console.warn("[thincoder-suite] anti-drift 完成门注册失败（已跳过）：" + (e?.message ?? e)) } catch { /* noop */ } }

      // —— FR-5 行为标记 + FR-1 槽绑定（`tools/post-execute`）：**只记不拦**，永不改 decision ——
      try {
        const offAntiDriftMarks = ctx.on("tools/post-execute", async (exec, result, next) => {
          // ★ 2026-10-15 热修（评审 #1 · 🔴）：`d` 提到 try **外**。
          //   FR-5 的设计原文（设计档 :204 / :299）：本监听器**永不改 decision**。
          //   此前 `const d = await next()` 与标记段同在一个 try 里，catch 统一
          //   `return { kind: "accept" }` ⇒ 标记段一旦抛错就**改写了下游决定**（违反 FR-5）。
          //   现在：`next()` 的决定原样带出；只有 `next()` 自身抛错（`d` 仍为 undefined）才回落 accept。
          let d
          try {
            d = await next()
            const agent = exec?.agent
            const sid = agent?.session?.id
            if (!sid) return d
            if (result && result.isError === true) return d // 失败的工具不算"改过代码"
            const name = exec?.name
            const cfg = antiDriftCfg()
            if (name === "write" || name === "edit") {
              noteWrite(sid, targetPathOf(name, exec?.arguments))
            } else if (name === "create_goal") {
              // 建目标成功 ⇒ 待绑槽提升为 bound（FR-1）
              const gid = extractGoalId(result)
              if (gid) promotePending({ sessionId: sid, goalId: gid, cwdHint: adHint(agent) })
            } else if (name === "update_goal") {
              const act = String(exec?.arguments?.action ?? "")
              if (act === "complete" || act === "blocked") {
                // ★ 必须把**本次收掉的那个 goalId** 显式传进去（2026-10-15 夜班第 8 轮实测的泄漏）：
                //   `clearCriteria` 只给 sessionId 时靠**内存** `boundGoalId` 反查；
                //   而**重启会清掉那张内存表、盘上记录却还在** ⇒ 恢复后 complete/blocked
                //   会 `cleared=[]` 而盘上记录**永久滞留**（实测复现）。
                //   目标 id 有两个来源，按可靠性取：① 本次 update_goal 的参数（最权威——
                //   它就是"被收掉的那个目标"）；② 调用结果里抠（`extractGoalId` 的两级回落）。
                const gid = String(exec?.arguments?.goal_id ?? "").trim() || extractGoalId(result)
                clearCriteria(gid
                  ? { sessionId: sid, goalId: gid, cwdHint: adHint(agent) }
                  : { sessionId: sid, cwdHint: adHint(agent) })
              }
            } else if (name === "advisor") {
              // advisor 结算置位按**裁决**判定（大小写不敏感；协议输出大写 VERDICT: PASS）
              if (hasPassVerdict(result)) stampVerified(sid, { byAdvisor: true })
            } else if (name === "goal_verify") {
              const st = exec?.arguments?.status
              if (st === "passed") stampVerified(sid)
            } else if (name === "shell" || name === "run_shell" || name === "bash" || name === "pwsh") {
              noteShell(sid, exec?.arguments?.command ?? exec?.arguments?.cmd, cfg.verifyHeuristic)
            }
            // ★ 落章域 / 验证证据变更后**立刻落盘**（用户 2026-10-15 裁定「该记」）。
            //   只在这四个真会改到落章域或证据的工具上写盘（避免每次工具调用都同步写文件）。
            //   位置刻意在**停滞检测之前**：停滞提醒走异步写盘，不能把落章落盘挡在后面。
            if (name === "write" || name === "edit" || name === "advisor" || name === "goal_verify") {
              persistAntiDrift(sid, adHint(agent))
            }
            // —— 停滞检测（连续 N 次**完全相同**的调用；横跨所有工具，故放最后不做分派）——
            // 四条边界见 anti-drift.mjs 的模块注释（同回合累积 · 每次调用只记一次 · 每回合至多提醒一条 ·
            // 参数序列化剔除易变字段）。提醒走 `agent.inject`（**下一步可见、不唤醒驱动**）——
            // 它是**提醒不是拦**：与推回（steer，会改变回合命运）刻意分开，
            // 避免"重复读一个文件"这种无害行为把回合钉住。
            const rep = noteToolCall(sid, name, exec?.arguments, cfg.stallRepeat)
            if (rep.stalled && markStallNoticed(sid)) {
              try {
                agent.inject?.({
                  role: "user",
                  content: producerContent(stallNotice(name, rep.count)),
                  source: producerSource(),
                })
              } catch { /* 提醒失败不影响工具结果 */ }
            }
            return d
          } catch (e) {
            try { console.warn("[thincoder-suite] anti-drift 标记面内部异常（已跳过）：" + (e?.message ?? e)) } catch { /* noop */ }
          }
          // FR-5「只记不拦」：把**下游原决定**原样带回（`next()` 自己抛错时 d 才是 undefined）。
          return d ?? { kind: "accept" }
        })
        disposes.push(offAntiDriftMarks)
      } catch (e) { try { console.warn("[thincoder-suite] anti-drift 标记面注册失败（已跳过）：" + (e?.message ?? e)) } catch { /* noop */ } }

      // —— FR-4 有界推回（`agent/turn-stopping`，serial）：**绝不 throw**（抛错 ⇒ 回合变 error）——
      try {
        const offAntiDriftPush = ctx.on("agent/turn-stopping", (payload) => {
          try {
            const agent = payload?.agent
            const sid = agent?.session?.id
            if (!sid) return
            const cfg = antiDriftCfg()
            if (!cfg.pushback) return
            // 工程模式禁用（D6）
            if (Boolean(sessionState(sid).engineering ?? configDefaultEngineering)) return
            // ★ 2026-10-15 收口（评审 #5）：设计档 :184 **明令移除** `depth === 0` 守卫，替代判据
            //   是「**存在活跃目标**」——宿主 goal-round-driver 只驱动顶层会话，故"有活跃目标"
            //   天然排除子代理。该前置已落在 `onTurnStopping` 内部（单一事实源，且只此一处）；
            //   这里再读一次 `delegationDepth` 是纯冗余，且它正是设计档点名"已移除"的那个未核实读数。
            const r = onTurnStopping({
              sessionId: sid,
              turn: turnIndexOf(payload, sid),
              goalId: goalViewOf(ctx, agent)?.id ?? null,
              config: cfg,
              cwdHint: adHint(agent),
              signal: payload?.signal, // 设计档 :183 前置：!signal.aborted
            })
            if (r.warn) { try { console.warn(r.warn) } catch { /* noop */ } }
            if (r.steer) {
              try { agent.steer({ role: "user", content: producerContent(r.steer), source: producerSource() }) } catch { /* steer 失败不改回合命运 */ }
            }
          } catch (e) {
            // fail-open：**绝不**让回合变 error
            try { console.warn("[thincoder-suite] anti-drift 推回内部异常，已跳过：" + (e?.message ?? e)) } catch { /* noop */ }
          }
        })
        disposes.push(offAntiDriftPush)
      } catch (e) { try { console.warn("[thincoder-suite] anti-drift 推回面注册失败（已跳过）：" + (e?.message ?? e)) } catch { /* noop */ } }
    }

    // —— FR-6 开工接管摘要（`agent/created`）：register 在既有 C10 块内（同事件、同守卫族） ——
    try {
      const offAntiDriftHandoff = ctx.on("agent/created", (payload) => {
        try {
          const agent = payload?.agent
          const sid = agent?.session?.id
          if (!sid) return
          const cfg = antiDriftCfg()
          if (!cfg.inject) return
          const r = onAgentCreated({
            sessionId: sid,
            source: payload?.source,
            goalId: goalViewOf(ctx, agent)?.id ?? null,
            config: cfg,
            cwdHint: adHint(agent),
          })
          if (r.inject) {
            try { agent.inject({ role: "user", content: producerContent(r.inject), source: producerSource() }) } catch { /* inject 失败不影响创建 */ }
          }
        } catch (e) {
          // fail-open：`agent/created` 抛错 ⇒ **创建失败** ⇒ 必须吞
          try { console.warn("[thincoder-suite] anti-drift 接管面内部异常，已跳过：" + (e?.message ?? e)) } catch { /* noop */ }
        }
      })
      disposes.push(offAntiDriftHandoff)
    } catch (e) { try { console.warn("[thincoder-suite] anti-drift 接管面注册失败（已跳过）：" + (e?.message ?? e)) } catch { /* noop */ } }

    // —— anti-drift 会话销毁清理（进程内三域状态 + 判据槽） ——
    const offAdDisposed = ctx.on("session/disposed", (session) => {
      try {
        if (!session?.id) return
        dropDomainSession(session.id)
        dropCriteriaSession(session.id)
        dropTurnShapeWarn(session.id)
      } catch { /* 清理失败不阻塞 */ }
    })
    disposes.push(offAdDisposed)

    // —— thincoder-eng 预设识别（一键入口） ——
    // 预设会话创建即工程模式：header.agentPreset 匹配预设 id → 自动 enter。
    // 预设本身不重复装配本插件（避免 realm 双实例），机制全在此处。
    const PRESET_MATCH = /^(thincoder-eng)$/i
    // —— F12 会话状态预载恢复（§2.2）+ preset 自动 enter ——
    // ★ C10 修正（2026-10-14，批 34）：原实现只挂 `agent/session-start`，并在注释里称其为
    //   「T0 实证结论」。父侧独立复核（装机 0.2.0-rc.2 = profile dist；开发树 0.2.1-alpha.2
    //   = deepseek-harness）证伪：该事件名**两个版本都不存在**（装机包字节扫描 0 命中；
    //   开发树 packages/ 全仓 grep 0 命中）⇒ 本恢复链与 preset 自动 enter 在真机上从未触发。
    //   平台真名 = `agent/created`（`runtime-types.ts:261`，serial 且被 await，payload 带
    //   `source: 'startup'|'resume'|'clear'|'compact'`）。
    //   故本处**同时登记两个事件名**：`agent/created` = 现行平台的真实入口；
    //   `agent/session-start` = 跨版本兼容垫片（若某历史/未来版本确有该名则一并生效）。
    //   两者在任何单一平台上不会同时触发（一名必不存在），且下方两条守卫使重复触发无害：
    //   ① `restoreSessionState` 只填空槽（map 已有该 key ⇒ 跳过，防盘覆盖内存）；
    //   ② `if (state.engineering === true && !state.engSection)` 消解双挂（与 preset 兜底共存）。
    //   `source` **不设白名单**：`compact` / `clear` 属「该会话仍需工程态」，与 resume 同义；
    //   而恢复本身由「键未在内存」守卫收口，故无需按 source 分支。
    //   残余风险（沿原文保留）：boot 期早于插件装配的恢复会错过事件——该场景 API 流量驱动的
    //   按需 resume 不覆盖，真重启冒烟确认。sessionId 跨重启稳定（resume 按 resumeSessionId
    //   复用持久化 id）。
    const onAgentSessionStart = (payload) => {
      try {
        const agent = payload?.agent
        const session = agent?.session
        markSessionSeen(session?.id)
        // F12：map 无该 key 且盘上 TTL 内有效条目 → 白名单校验 + 规范化后整条灌入（只填空槽，
        // T15——map 已有（本进程会话已活跃/已推进）时 restoreSessionState 自行跳过，盘不覆盖）。
        const sid = session?.id
        if (sid) {
          const snapshot = loadSessionState(sid, undefined, session?.header?.cwd)
          if (snapshot) {
            // ★ 2026-10-15（用户裁定「该记」）：落章域 + 验证证据同批恢复。
            //   刻意在 `restoreSessionState` **之外**调用：后者只在 state.mjs 的会话 Map
            //   无该 key 时才恢复，而落章域有自己的 Map ⇒ 两者的"空槽"是分开的（各自守卫）。
            try { restoreAntiDriftState(sid, snapshot) } catch { /* 恢复失败不阻塞会话 */ }
            const r = restoreSessionState(sid, snapshot)
            if (r.restored) {
              const state = sessionState(sid)
              // R2 §4.4（D-10）：恢复 generation（F12 视图条件字段——restoreSessionState 的
              // 固定字段集不含它，此处灌入；快照无该字段按 0 兜底）
              state.advisorGeneration = advisorGenerationOf(snapshot)
              // 批 4 §12（FR-G9/N-7）：恢复链作用域键（同 generation 的模式——它也不在
              // restoreSessionState 的固定字段集内）。**必须恢复**：advisorRound 是落盘的，
              // 链作用域键不恢复会在重启后失配 ⇒ 同一文档集被误判为新链（轮次与 prior 被误重置）
              // 或反之（换集不重置 = D-35 复活）。快照无该字段 → 保持 undefined（无判定）。
              if (typeof snapshot.lastDesignDocKey === "string" && snapshot.lastDesignDocKey !== "") {
                state.lastDesignDocKey = snapshot.lastDesignDocKey
              }
              // §2.2-2：恢复后 engineering === true → 重挂 section（engSection 不落盘——进程内
              // disposer 闭包不可序列化）；既有 if (!state.engSection) 守卫消解与 preset 自动
              // enter 的双挂（§7 确认项 4，恢复先行、preset 兜底）。
              if (state.engineering === true && !state.engSection) {
                try { state.engSection = attachEngineeringSection(agent) } catch { state.engSection = null }
              }
              // §2.2-4 / §2.5：一行 console 观测（含「停机改配置默认后恢复显式值胜出」的呈现面）
              console.log("[thincoder-suite] session state restored: advisorRound=" + r.advisorRound
                + ", lastReviewType=" + (r.lastReviewType ?? "none")
                + ", touchedFiles=" + r.touchedFiles.length
                + (r.engineering === true ? ", restored engineering=on from session state (explicit toggle wins over the config default)"
                  : r.engineering === false ? ", engineering=off (explicit)" : "")
                + (r.advisorOverride ? ", advisorOverride present" : ""))
            }
          }
        }
        const presetId = String(session?.header?.agentPreset ?? "")
        if (presetId && PRESET_MATCH.test(presetId)) {
          engineeringToggle(payload.agent, "enter")
        }
      } catch { /* 识别失败不阻塞会话启动 */ }
    }
    // 两个事件名同时登记（见上方 C10 说明）：任一平台至多命中一个，未注册名对 ctx.on 无害。
    disposes.push(ctx.on("agent/created", onAgentSessionStart))
    disposes.push(ctx.on("agent/session-start", onAgentSessionStart))

    // —— 设置页 config API（二期 §3.2；U8：webServer 缺失 → 仅 warn 跳过，host 功能不受影响） ——
    const agentsSvc = (() => { try { return ctx.get?.("agents") ?? null } catch { return null } })()

    // ═══════════════════════════ 批 36 · 个人任务台账 + 看板（FR-1…FR-11 的接线） ═══════════════════════════
    // 设计档 docs/2026-10-16-task-ledger-design.md §十四 把 `lib/index.mjs` 列为受影响文件。
    // 四条纪律（本区块逐条照做）：
    //   ① **三面同源**：看板载荷 / 注入摘要 / 工具输出**只调 `readTasksView()`**（设计-D3 结构保证）；
    //   ② **工具层零校验**：四个工具全部经 `lib/tasks.mjs` 的同一道写门（本区块只注册，不判定）；
    //   ③ **新服务一律 `ctx.get`**：**不扩 `inject`**（声明一个宿主没注册的服务会让整个插件拒起，
    //      客户端半边更是会永久 pending——设计档 §五末的「可选依赖怎么表达」注）；
    //   ④ **不新开注入通道**：摘要并入上面那一条 `systemPrompt.context`（见该处注释）。
    const ledgerCfg = () => resolveLedgerConfig(effectiveGlobalConfig(config))
    /**
     * 工作区根 = **会话 cwd**（台账的键，设计档 §7.1）。
     * ★ 取不到 ⇒ `null`（工具如实拒绝、看板给空态）——**绝不**回落到 `process.cwd()`：那会把台账写到
     *   DSH 进程自己的工作目录，正是设计档 §7.1 点名禁止的错法（评审第二轮 #16）。
     */
    const ledgerWsOf = (agent) => {
      try {
        const cwd = agent?.session?.header?.cwd
        return typeof cwd === "string" && cwd.trim() !== "" ? cwd.trim() : null
      } catch { return null }
    }
    /**
     * 欠账码 → 人话。码来自 `anti-drift.mjs` 的 `outstandingDebts`（**单一事实源**），
     * 本映射只做**呈现**（该档的 `DEBT_LABEL` 未导出，本批不碰该档 ⇒ 呈现层自持一份字面）。
     */
    const DEBT_LABEL_OF = (k) => ({
      criteriaMissing: "目标缺判据", unverified: "有未验证的产品代码改动", unreviewed: "有未评审的产品代码改动",
    }[k] ?? String(k))
    /**
     * 看板「防漂移状态区」的材料（FR-11）：**只读**批 34 既有读数 + 宿主 goal 服务，**零新建状态**。
     * `domainState` / `outstandingDebts` 是批 34 注入行**本来就在用**的读法（惰性建域是该档既有惯例）。
     */
    const driftStatusOf = (sessionId) => {
      const sid = String(sessionId ?? "")
      if (!sid) return null
      try {
        const agent = agentsSvc?.get?.(sid) ?? null
        const goal = goalViewOf(ctx, agent)
        const goalId = goal?.id ?? null
        const hint = adHint(agent)
        const rec = getCriteria({ sessionId: sid, goalId, cwdHint: hint })
        const debts = outstandingDebts({ sessionId: sid, goalId, cwdHint: hint })
        const d = domainState(sid)
        return {
          goal: goal ? { id: goal.id, objective: goal.objective } : null,
          criteria: rec ? { criteria: rec.criteria, check: rec.check } : null,
          debts: Array.isArray(debts) ? debts.map(DEBT_LABEL_OF) : [],
          pushback: Number.isFinite(d?.turn?.steerTotal) ? d.turn.steerTotal : 0,
        }
      } catch { return null } // fail-open：状态区读数失败**不影响**台账本体
    }
    const taskTools = makeTaskTools({ wsOf: ledgerWsOf, configOf: ledgerCfg, driftOf: driftStatusOf })

    // —— 四个工具（每个一个注册点——**不要**改成循环：`textTool` 注册点计数是常设锁，见契约基线 #7）——
    register(textTool({
      name: "task_add",
      description: taskTools.task_add.description,
      parameters: taskTools.task_add.parameters,
      execute: (args, exec) => taskTools.task_add.execute(args, exec),
    }))
    register(textTool({
      name: "task_update",
      description: taskTools.task_update.description,
      parameters: taskTools.task_update.parameters,
      execute: (args, exec) => taskTools.task_update.execute(args, exec),
    }))
    register(textTool({
      name: "task_done",
      description: taskTools.task_done.description,
      parameters: taskTools.task_done.parameters,
      execute: (args, exec) => taskTools.task_done.execute(args, exec),
    }))
    register(textTool({
      name: "task_list",
      description: taskTools.task_list.description,
      parameters: taskTools.task_list.parameters,
      execute: (args, exec) => taskTools.task_list.execute(args, exec),
    }))
    // ★ 批 36-补：**接手**（设计档 §16.2 的交接动作）。与其余四个工具同族 —— 一个 `textTool` 一个注册点，
    //   **不要放进循环**：`textTool` 注册点计数是常设锁（契约基线 #7）。
    register(textTool({
      name: "task_claim",
      description: taskTools.task_claim.description,
      parameters: taskTools.task_claim.parameters,
      execute: (args, exec) => taskTools.task_claim.execute(args, exec),
    }))

    // —— 四条用户命令（C 面）：`/task_list` `/task_add` `/task_done` `/task_claim` ——
    // 缺 `commands` 服务 ⇒ 只 warn、不注册（工具与看板照常）；注册走官方 `ctx.effect(function*…)` 形态。
    // ★ 本块**不中断装配**：任何异常都被 registerTaskCommands 内部吞成 warn（命令面是附属面）。
    try {
      registerTaskCommands(ctx, { wsOf: ledgerWsOf, configOf: ledgerCfg, driftOf: driftStatusOf })
    } catch (e) {
      console.warn("[thincoder-suite] /task_* 命令接线失败（已跳过，工具与看板照常）：" + String(e?.message ?? e))
    }

    const sessionExists = (id) => {
      const sid = String(id ?? "")
      if (!sid) return false
      try {
        if (agentsSvc && typeof agentsSvc.get === "function" && agentsSvc.get(sid)) return true
      } catch { /* agents 注册表不可用 → 回落事件注册表 */ }
      return sessionRegistry.has(sid)
    }
    const agentOptionsOf = (id) => {
      try {
        const agent = agentsSvc?.get?.(String(id ?? ""))
        if (!agent) return undefined
        // 批 32 / D-62：**活动路由**（`requestHeader().config`，回落 `agent.options`）——
        // 本读取面喂 `resolveAdvisorRoute` 的第 4 优先级与硬停指纹，必须是「会话当前路由」。
        return liveAgentRoute(agent)
      } catch { return undefined }
    }
    // 评审 #1：stateOf 必须接线——会话三端点（apply/reset/describe）真实装配依赖它（测试 stub 曾掩盖缺漏）
    const apiDispose = registerConfigApi(ctx, {
      baseConfig: config, sessionExists, agentOptionsOf,
      registeredPoolEmpty: pool.length === 0, // 评审 #5：注册基于启动快照——池从空到有的保存需重启才注册工具
      stateOf: (id) => sessionState(String(id)),
      settingsGet: (ns) => { try { return ctx.get?.("settings")?.get?.(ns) ?? null } catch { return null } }, // 评审 #6：settings 懒取（仿 agents）
      llm: ctx.llm ?? null, // /catalog：运行时注册表（listProviders/listModels——DeepSeek 等内置适配器的权威源）
      cwdHint: () => cwdHintOf(ctx), // 评审 #10：cwdHint 统一（cwdHintOf 单一实现）
      // 批 36（FR-5 FR-6 的数据通道 C-2）：看板 tab（浏览器半边）拉取的那一份载荷。
      // **由 `readTasksView()` 派生**；工作区根只取**目标会话的 cwd**（不接受调用方指定路径）。
      tasksRoute: (query) => {
        const sid = String(query.get("sessionId") ?? "")
        const agent = sid ? (agentsSvc?.get?.(sid) ?? null) : null
        const ws = agent ? ledgerWsOf(agent) : null
        return buildTasksBoardPayload({
          ws,
          sessionId: sid || null,
          config: effectiveGlobalConfig(config),
          drift: sid ? driftStatusOf(sid) : null,
        })
      },
      // 批 36-补（交接动作 §16.2）：看板「接手」按钮 → `POST /tasks/claim`。
      // ★ **零状态机**：本回调只做「取会话 → 定工作区 → 调 `buildTaskClaimResult`（读 rev + 同一道写门）」
      //   —— 判定、零写入承诺、拒绝码全在 `lib/tasks.mjs` 的 `applyTaskClaim` 里。
      // ★ 工作区根只从**目标会话的 cwd** 取（与 GET /tasks 同一条纪律：不接受调用方指定路径）。
      tasksClaimRoute: (body) => {
        const sid = String(body?.sessionId ?? "")
        const agent = sid ? (agentsSvc?.get?.(sid) ?? null) : null
        const ws = agent ? ledgerWsOf(agent) : null
        if (!ws) {
          return { ok: false, code: "ws-unresolvable", text: "接手失败：无法确定该会话的工作区根（台账按**工作区**落盘）。" }
        }
        return buildTaskClaimResult({
          ws,
          sessionId: sid,
          id: body?.id,
          config: effectiveGlobalConfig(config),
          drift: driftStatusOf(sid),
        })
      },
      // F12（§2.3 写点表）：apply/reset-session 后写盘（advisorOverride 持久化——
      // sessionStateViewWithGeneration 组装视图，saveSessionState fail-safe 仅 warn 不抛）。
      // 评审 #2：cwdHint 从**目标会话**解析（agentsSvc.get(id).header.cwd）——config API 操作的
      // 会话由 id 标识，正在执行的 agent cwd 可能不同；DSH_HOME 未设时写入必须与恢复时读取
      // 落在同一存储文件（session-start 用目标会话的 cwd 探测）。取不到目标会话回落调用方 cwd。
      persistSession: (id) => {
        const targetCwd = (() => {
          try {
            const a = agentsSvc?.get?.(String(id ?? ""))
            return a?.session?.header?.cwd ?? undefined
          } catch { return undefined }
        })()
        saveSessionState(String(id), sessionViewFor(id, targetCwd ?? cwdHintOf(ctx)), undefined, targetCwd ?? cwdHintOf(ctx))
      },
    })
    if (apiDispose) disposes.push(apiDispose)
    console.log("[thincoder-suite] active: advisor/eng/eng_coder" + (pool.length > 0 ? "/escalate/consult (pool: " + pool.length + ")" : " (consult pool empty — configure consultModels to enable)") + (apiDispose ? " + config api" : " (config api skipped — no webServer)"))
    return () => {
      for (const d of disposes) { try { d?.() } catch { /* already disposed */ } }
      // fiber dispose 时清空本插件经手的全部会话状态（评审 #2：模块级 Map 跨 fiber 存活）
      dropAllSessions((s) => cleanupConsultSessions(s))
    }
  })
}
