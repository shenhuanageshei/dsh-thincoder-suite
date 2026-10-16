// tool-tasks.mjs — 批 36 工具面（task_add / task_update / task_done / task_list）+ 看板数据通道
// （设计档 docs/2026-10-16-task-ledger-design.md FR-3 / §7.4 的 C-1 与 C-2）。
//
// ★ 三层职责**严格分开**（这是本批的结构性决定 设计-D3 的落点）：
//   ① `lib/tasks.mjs`  —— 唯一写门 + 唯一读函数（一切前置/后置都在那里）；
//   ② **本模块**       —— 只做「翻译」：工具参数 → 写门入参 · 写门结果 → 人话 · `readTasksView()` 读数
//                          → 工具文本 / 看板载荷。**零状态机**（工具层**不得**自建第二份迁移表 / 凭据门 /
//                          五态判定）；唯一一处自持的判定是 `task_update` 的**非法键前置**（见该节注释）——
//                          它只把越界键送到写门的同一道检查上，不改任何状态语义。
//   ③ `lib/client.js`  —— 只渲染本模块产出的载荷（浏览器半边**零存储、零写盘**，N-1）。
//
// ★ 写路径唯一：四个工具里凡是要改台账的，**全部**经 `applyTaskCreate` / `applyTaskUpdate` /
//   `applyTaskTransition`（同一个 rev 门、同一张迁移表、同一条凭据门）。
// ★ 读路径唯一：`task_list` 与看板载荷**只**经 `readTasksView()`（不得各自解析 tasks.json）。
import { readFileSync } from "node:fs"
import { isAbsolute, resolve, sep } from "node:path"
import {
  DEFAULT_COPY_TEMPLATE, READONLY_FIELDS, TASK_STATUSES, UPDATABLE_FIELDS,
  applyTaskCreate, applyTaskTransition, applyTaskUpdate,
  parseChecklistDoc, readTasksView, resolveLedgerConfig,
} from "./tasks.mjs"

/**
 * 读**结构化文档源**（FR-8 / US-10：只读渲染勾选态与「验收五件齐没齐」）。
 * @pre  `docPaths` = **显式登记**的路径清单（设计-D11：不自动发现——自动发现必然猜错）
 * @post 路径相对**工作区根**解析；**越出工作区的路径一律拒读**（配置不能变成任意文件读）
 * @post **只读**：不写回、不改文档、不缓存；读不到 / 无验收表 ⇒ 如实标注（不猜、不部分解析）
 */
export function readChecklistDocs({ ws, docPaths, loader }) {
  const read = typeof loader === "function" ? loader : (p) => readFileSync(p, "utf8")
  const root = typeof ws === "string" && ws.trim() !== "" ? resolve(ws.trim()) : null
  const out = []
  for (const rel of Array.isArray(docPaths) ? docPaths : []) {
    const p = String(rel)
    if (root === null) { out.push({ path: p, ok: false, error: "无工作区根，无法解析相对路径" }); continue }
    const abs = isAbsolute(p) ? p : resolve(root, p)
    if (abs !== root && !abs.startsWith(root + sep)) {
      out.push({ path: p, ok: false, error: "路径越出工作区，已拒绝读取" })
      continue
    }
    let text
    try { text = read(abs) } catch (e) { out.push({ path: p, ok: false, error: "读不到：" + String(e?.message ?? e) }); continue }
    const parsed = parseChecklistDoc(text)
    if (!parsed) {
      out.push({ path: p, ok: false, error: "没有可识别的验收表（需 ≥4 列且含状态列）——按设计**不猜、不部分解析**" })
      continue
    }
    out.push({ path: p, ok: true, columns: parsed.columns, counts: parsed.counts, rows: parsed.rows })
  }
  return out
}

/** 本批注册的四个工具名（文档、测试与注入行共用这一份清单）。 */
export const TASK_TOOL_NAMES = Object.freeze(["task_add", "task_update", "task_done", "task_list"])

/**
 * **软引导**（设计档 §2.2 / 需求档 §13.6.1 D-15）：任务台账走 `task_*`；宿主原生 todo_write
 * 只是**本回合草稿**（宿主 todos 投影每逢 turn start 清空，平台不把清单回喂模型）⇒ 写进它的任务
 * **在看板上看不到**。★ 代价如实说：软引导只降概率、不阻断（本批**刻意不加** pre-execute 硬拦）。
 */
export const SOFT_GUIDANCE = "Task ledger = the task_* tools. The host's native todo_write is only THIS turn's "
  + "scratchpad (the platform clears its todos projection at every turn start and never feeds the list back "
  + "to the model) — anything written there does NOT show up on the user's board."

/** 四个工具的描述（模型可见面；与实现逐条一致——状态机在写门里，这里只讲怎么用）。 */
export const taskToolDescriptions = Object.freeze({
  task_add:
    "Add ONE task to the user's personal task ledger (batch-36; a workspace-scoped tasks.json — the SAME ledger "
    + "the user's sidebar board renders). " + SOFT_GUIDANCE + " "
    + "`check` is REQUIRED: it is the machine-checkable statement of what \"done\" means (a task without it is a "
    + "wish, not a task). kind='decision' marks an item that waits for the USER to decide (it is pinned to the top "
    + "of the board). The gate refuses and writes nothing on any validation failure.",
  task_update:
    "Edit ONE existing ledger entry's CLOSED field set — title / check / why / priority only. Everything else "
    + "(id, kind, status, evidence, blockedReason, blockedBy, createdAt, doneAt) is read-only by design: status "
    + "moves only through task_done, and evidence/blocked fields are written only by that transition. A patch "
    + "naming a read-only field is REFUSED (not silently ignored) and nothing is written.",
  task_done:
    "Move ONE ledger entry's state (five states: 待办 / 已接手 / 在做 / 完成 / 卡住) through the single write gate. "
    + "to='完成' REQUIRES a non-empty evidence (\"what you ran, what you saw\" — for kind='decision' the evidence "
    + "means \"what was decided and who decided it\"). to='卡住' REQUIRES both reason and blockedBy "
    + "(external = waiting on someone else, self = waiting on your own hands). Illegal transitions are refused "
    + "and nothing is written.",
  task_list:
    "Read the user's personal task ledger (batch-36). The output is derived from the SAME read function the "
    + "sidebar board uses, so what you read here is what the user sees. Pass view='board' to render the board "
    + "layout (decision section pinned on top + blocked + tasks + a done count) — that is the in-session "
    + "degraded board (used when the dsh-better-sidebar plugin is absent).",
})

/** 四个工具的 JSON Schema（`parameters`）。 */
export const taskToolSchemas = Object.freeze({
  task_add: {
    type: "object",
    properties: {
      title: { type: "string", description: "One-line task title (non-empty)" },
      check: { type: "string", description: "REQUIRED: how to verify completion — the exact command/output/file to inspect" },
      kind: { type: "string", enum: ["work", "decision"], description: "'work' (default) or 'decision' (waits for the user's ruling; pinned to the top of the board)" },
      why: { type: "string", description: "Optional: why this task exists (the reason behind it)" },
      priority: { type: "number", description: "Optional: higher shows first (default 0)" },
    },
    required: ["title", "check"],
  },
  task_update: {
    type: "object",
    properties: {
      id: { type: "string", description: "Ledger id, e.g. t-3 (from task_list)" },
      title: { type: "string", description: "New title (non-empty)" },
      check: { type: "string", description: "New completion criterion (non-empty)" },
      why: { type: "string", description: "New 'why' (empty string clears it)" },
      priority: { type: "number", description: "New priority" },
    },
    required: ["id"],
  },
  task_done: {
    type: "object",
    properties: {
      id: { type: "string", description: "Ledger id, e.g. t-3 (from task_list)" },
      to: { type: "string", enum: [...TASK_STATUSES], description: "Target state (default 完成)" },
      evidence: { type: "string", description: "REQUIRED for 完成: what you ran / what you saw (for a decision: what was decided and who decided it)" },
      reason: { type: "string", description: "REQUIRED for 卡住: why it is stuck" },
      blockedBy: { type: "string", enum: ["external", "self"], description: "REQUIRED for 卡住: waiting on someone else (external) or on your own hands (self)" },
    },
    required: ["id"],
  },
  task_list: {
    type: "object",
    properties: {
      view: { type: "string", enum: ["list", "board"], description: "'list' (default) or 'board' (the in-session degraded board layout)" },
    },
  },
})

/** 状态标签（卡住时带上朝向——看板与工具文本共用同一份渲染）。 */
export function statusTagOf(t) {
  if (!t || typeof t !== "object") return ""
  if (t.status === "卡住" && t.blockedBy) {
    return t.status + "/" + (t.blockedBy === "external" ? "等外部" : "等自己动手")
  }
  return String(t.status ?? "")
}

/** 看板/工具共用的**行**视图（只挑载荷需要的字段；**不新增**任何状态）。 */
export function boardRowOf(t) {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    status: t.status,
    statusTag: statusTagOf(t),
    check: t.check,
    evidence: t.evidence,
    blockedReason: t.blockedReason,
    blockedBy: t.blockedBy,
    priority: Number.isFinite(t.priority) ? t.priority : 0,
    why: t.why,
    createdAt: t.createdAt,
    doneAt: t.doneAt,
  }
}

const single = (s) => String(s ?? "").replace(/\s+/g, " ").trim()

/**
 * **问这一项的话术**（FR-7 / US-7）：默认模板（可配置）只提供「怎么问」的语气与要求，
 * 具体条目由台账读数拼出——**同一条话术**既是复制按钮的载荷，也是「点任务」降级路径的第二步。
 * @post **纯函数**（同 task + 同模板 ⇒ 逐字节同输出）；模板为空 ⇒ 回落 DEFAULT_COPY_TEMPLATE
 */
export function buildCopyPrompt(row, template) {
  const t = row && typeof row === "object" ? row : {}
  const tpl = typeof template === "string" && template.trim() !== "" ? template.trim() : DEFAULT_COPY_TEMPLATE
  const lines = [
    tpl,
    "",
    "要问的这一项：" + (t.id ?? "（无 id）") + " " + single(t.title ?? ""),
    "当前状态：" + (t.statusTag ?? t.status ?? "未知"),
    "怎么算完成：" + single(t.check ?? "（未写）"),
  ]
  if (t.why) lines.push("为什么做这件事：" + single(t.why))
  if (t.blockedReason) lines.push("卡在哪：" + single(t.blockedReason) + "（" + (t.blockedBy === "external" ? "等外部" : "等自己动手") + "）")
  if (t.evidence) lines.push("已有凭据：" + single(t.evidence))
  lines.push("", "请按上面这条的实际情况回答：现在进度到哪了、卡在哪、下一步是什么。")
  return lines.join("\n")
}

/**
 * **复制全部待你决策的项**（FR-7 / US-7）：决策区**全列**（它们是"等你拍板"的队列）。
 * @post 空集 ⇒ 返回空串（调用方不渲染该按钮的复制结果，改为空态文案）
 */
export function buildCopyAllPrompt(rows, template) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === "object") : []
  if (list.length === 0) return ""
  const tpl = typeof template === "string" && template.trim() !== "" ? template.trim() : DEFAULT_COPY_TEMPLATE
  const lines = [tpl, "", "下面是我当前**待决策**的 " + list.length + " 项，请逐项说清：这一项在等什么、有哪些选择、你建议选哪个、代价是什么。", ""]
  for (const r of list) {
    lines.push("- " + (r.id ?? "?") + " " + single(r.title ?? ""))
    lines.push("    怎么算完成：" + single(r.check ?? "（未写）"))
    if (r.why) lines.push("    为什么：" + single(r.why))
    if (r.blockedReason) lines.push("    卡在哪：" + single(r.blockedReason))
  }
  return lines.join("\n")
}

/**
 * **点任务的载荷**（US-6 / 腿 T-12）：三要素 = 人话说明 · 相关文档 · 核验进度。
 * ★ U-1（「点一下就在侧边开一个会话」）**未经端到端实测** ⇒ 本批**不假装支持**：点击走的是
 *   「点开看详情 + 一键复制话术」这条**设计档明写的降级路径**（见交付报告的 U-1 登记）。
 * @post 三个要素**恒非空**（文档清单至少含台账真源路径——它就是"这一项存在哪"的答案）
 */
export function buildTaskClickPayload({ task, template, view, docPaths }) {
  const t = task && typeof task === "object" ? task : {}
  const v = view && typeof view === "object" ? view : {}
  const docs = []
  if (v.path) docs.push(v.path)
  for (const p of Array.isArray(docPaths) ? docPaths : []) docs.push(p)
  const plain = [
    "这一项是「" + single(t.title ?? "") + "」。",
    "它的状态是「" + (t.statusTag ?? t.status ?? "未知") + "」。",
    t.why ? "当初做它的理由：" + single(t.why) + "。" : "",
    "怎么算做完：" + single(t.check ?? "") + "。",
    t.blockedReason ? "现在卡在：" + single(t.blockedReason) + "。" : "",
    t.evidence ? "已经留下的凭据：" + single(t.evidence) + "。" : "还没有凭据——完成时必须留一句「跑了什么、看到什么」。",
  ].filter((s) => s !== "").join("")
  const progress = [
    "状态：" + (t.statusTag ?? t.status ?? "未知"),
    "怎么算完成：" + single(t.check ?? "（未写）"),
    t.evidence ? "已有凭据：" + single(t.evidence) : "已有凭据：无（完成时必填）",
    "账本 rev=" + String(v.rev ?? 0) + "（看板 / 注入行 / 工具三面读的是同一份 tasks.json）",
  ]
  return {
    id: t.id ?? null,
    title: t.title ?? "",
    status: t.status ?? null,
    statusTag: t.statusTag ?? t.status ?? null,
    plain,
    docs: [...new Set(docs)],
    progress,
    copyPrompt: buildCopyPrompt(t, template),
  }
}

/**
 * **看板载荷**（§7.4 的 C-2 数据通道——浏览器半边拉取的就是它）。
 * @pre  `ws` = 工作区根；`config` = 全局生效配置（`ledger.*` 从它解析）
 * @post **纯函数**：全部字段由 `readTasksView(ws)` 与入参派生（`generatedFrom` 字段即这条结构自证）；
 *       **零写盘、零时间戳**（看板不写任何文件，N-1）
 * @post 分区顺序**决策区置顶**（`sections[0].key === "decisions"`），空集给 `emptyState` 文案
 * @post `ledger.mode === "off"` ⇒ `ledger: null` + 只有 `drift`（防漂移状态区**仍在**，腿 T-9）
 */
export function buildTasksBoardPayload({ ws, sessionId, config, drift }) {
  const cfg = resolveLedgerConfig(config)
  const view = readTasksView(ws) // ← 唯一读函数（看板/工具/注入三面同源，设计-D3）
  const rowOf = (t) => ({
    ...boardRowOf(t),
    copyPrompt: buildCopyPrompt(t, cfg.copyTemplate),
    click: buildTaskClickPayload({ task: t, template: cfg.copyTemplate, view, docPaths: cfg.docPaths }),
  })
  const base = {
    ok: true,
    generatedFrom: "readTasksView",
    mode: cfg.mode,
    sessionId: sessionId ?? null,
    workspace: view.ws,
    path: view.path,
    rev: view.rev,
    malformed: view.malformed,
    trace: view.trace,
    counts: view.counts,
    drift: drift ?? null,
    copyTemplate: cfg.copyTemplate,
    docPaths: cfg.docPaths,
  }
  if (cfg.mode === "off") {
    return {
      ...base,
      ledger: null,
      sections: [],
      docs: [],
      emptyState: null,
      // 复制按钮：模式关闭时**决策区不存在** ⇒ 「复制全部待你决策的项」没有内容（空串，前端不渲染该按钮）
      copyAllDecisions: "",
      offNote: "个人任务台账已关闭（ledger.mode=off）——防漂移状态区照常显示（US-9）",
    }
  }
  const sections = [
    { key: "decisions", title: "待你决策", top: true, empty: "没有待你决策的项。", tasks: view.decisions.map(rowOf) },
    { key: "blocked", title: "卡住", empty: "没有卡住的项。", tasks: view.blocked.map(rowOf) },
    { key: "active", title: "任务", empty: "没有在办的任务。", tasks: view.active.map(rowOf) },
    { key: "done", title: "已完成", countOnly: true, count: view.done.length, tasks: view.done.map(rowOf) },
  ]
  return {
    ...base,
    ledger: {
      decisions: view.decisions.map(rowOf),
      active: view.active.map(rowOf),
      blocked: view.blocked.map(rowOf),
      done: view.done.map(rowOf),
    },
    sections,
    // FR-8：结构化文档只读源（**只读**渲染勾选态与「验收五件齐没齐」；不可写）
    docs: readChecklistDocs({ ws: view.ws, docPaths: cfg.docPaths }),
    copyAllDecisions: buildCopyAllPrompt(view.decisions.map(boardRowOf), cfg.copyTemplate),
    emptyState: view.tasks.length === 0
      ? "台账还是空的：让模型用 task_add 记一条（或直接说「记一条：…」，并写清怎么算完成）。"
      : null,
  }
}

/**
 * 工具文本里的台账列表（`task_list` 的 list 模式；**由 `readTasksView` 派生**）。
 * @post **纯确定性**（同 view ⇒ 逐字节同输出；无时间戳/百分比/步数）
 */
export function renderTaskListText(view, meta) {
  const v = view && typeof view === "object" ? view : readTasksView(null)
  const m = meta && typeof meta === "object" ? meta : {}
  const lines = []
  const counts = v.counts ?? {}
  lines.push("[thincoder 任务台账] rev=" + String(v.rev ?? 0) + " · 待你决策 " + (counts.decisions ?? 0)
    + " · 在做 " + (counts.active ?? 0) + " · 卡住 " + (counts.blocked ?? 0) + " · 完成 " + (counts.done ?? 0))
  if (v.ws) lines.push("工作区：" + v.ws)
  if (v.malformed && v.trace) lines.push("⚠ " + v.trace)
  if (m.mode === "off") lines.push("个人任务台账已关闭（ledger.mode=off）——防漂移状态区不受影响（US-9）。")
  const group = (title, arr) => {
    if (!arr || arr.length === 0) return
    lines.push(title + "（" + arr.length + "）")
    for (const t of arr) {
      lines.push("  " + t.id + " [" + statusTagOf(t) + "] " + single(t.title)
        + " — 怎么算完成：" + single(t.check)
        + (t.evidence ? " — 凭据：" + single(t.evidence) : "")
        + (t.blockedReason ? " — 卡在哪：" + single(t.blockedReason) : ""))
    }
  }
  if (m.mode !== "off") {
    group("待你决策", v.decisions)
    group("卡住", v.blocked)
    group("任务", v.active)
    if (Array.isArray(v.done) && v.done.length > 0) {
      lines.push("已完成（" + v.done.length + "）")
      for (const t of v.done) lines.push("  " + t.id + " [完成] " + single(t.title) + (t.evidence ? " — 凭据：" + single(t.evidence) : ""))
    }
    if (Array.isArray(v.tasks) && v.tasks.length === 0) {
      lines.push("（空账本）让模型用 task_add 记一条；`check` 必填（没写怎么算完成 = 许愿不是任务）。")
    }
  }
  return lines.join("\n")
}

/**
 * 拒写文案（四工具共用；**唯一形态** —— 写门拒绝与工具层前置拒绝长得一模一样，调用方无需分辨来源）。
 * 与旧实现的逐字形态相同（`single` 折叠空白，理由串本是单行）。
 */
function refuseText(tool, code, reason) {
  return tool + " 拒写（**没有写入任何内容**）：" + single(reason ?? "原因未知") + "（拒绝码 " + String(code ?? "?") + "）"
}

/** 写门结果 → 人话（四工具共用；**零校验逻辑**，只翻译）。 */
function writeResultText(tool, r) {
  if (!r || r.ok !== true) {
    return refuseText(tool, r?.code ?? "?", r?.reason ?? "原因未知")
  }
  const tail = "  （rev → " + r.rev + "；看板与注入行读的都是这一份 tasks.json）"
  if (tool === "task_add") {
    return "task_add: 已建 " + r.id + "（status=" + r.status + "），rev → " + r.rev + "。" + tail
  }
  if (tool === "task_update") return "task_update: 已改 " + r.id + "，" + tail
  return "task_done: " + r.id + " → " + r.status + "，" + tail
}

// ————————————— 工具层前置：`task_update` 的非法键（设计档 §六 FR-3 后置） —————————————
//
// ★ 为什么工具层要自己先判一次：工具入参**不是** `patch` 对象。旧实现按白名单搬运
//   `["title","check","why","priority"]` ⇒ 调用方显式给出的 `status` / `evidence` 会被**静默丢弃**，
//   然后**写入成功**：调用方以为改了状态，盘上什么都没发生（正是本项目最忌的「静默劣化」）。
//   写门里的同一道检查（`lib/tasks.mjs` 的 `applyTaskUpdate`）**是对的，只是在工具路径上此前不可达**；
//   本前置把它接上 —— 判定所依据的闭集仍取自 `lib/tasks.mjs`（`UPDATABLE_FIELDS` / `READONLY_FIELDS`），
//   此处**不新建第二份状态机**，只把越界键送到门口。工具描述
//   （`taskToolDescriptions.task_update`）已写明 `is REFUSED (not silently ignored)` ⇒ 本前置就是
//   让那句描述成立的那一半（描述面与实现一致）。

/** `task_update` 的工具入参闭集：`id` 是指路参数，其余四个 = 写门的可改字段闭集。 */
const TASK_UPDATE_ARG_KEYS = Object.freeze(["id", ...UPDATABLE_FIELDS])

/** 工具入参里的**越界键**（保持调用方给的顺序 ⇒ 文案可预期、可断言）。 */
function strayArgKeys(args) {
  if (!args || typeof args !== "object") return []
  return Object.keys(args).filter((k) => !TASK_UPDATE_ARG_KEYS.includes(k))
}

/** 越界键的拒写文案（与写门**同码同形**：`field-not-updatable`；点名每个越界字段）。 */
function refuseStrayArgs(tool, stray) {
  const ro = stray.filter((k) => READONLY_FIELDS.includes(k))
  return refuseText(tool, "field-not-updatable",
    "以下字段不可改：" + stray.join(" / ")
    + (ro.length > 0
      ? "（" + ro.join(" / ") + " 属只读面：`status` 只能走 task_done / 状态迁移门，`evidence` 与 `blockedReason`/`blockedBy` 只能由那次迁移写入）"
      : "")
    + "。可改字段闭集 = " + UPDATABLE_FIELDS.join(" / ") + "（Nothing was written）")
}

/**
 * 组装四个工具（返回 `{name, description, parameters, execute}` —— 由 `lib/index.mjs` 逐个注册）。
 * @param {{wsOf: (agent) => string|null, configOf: () => object, driftOf?: (sessionId) => object|null}} deps
 *   `wsOf` 必须返回**会话的工作区根**（无 cwd ⇒ `null`；**绝不**回落到 `process.cwd()`）
 */
export function makeTaskTools(deps) {
  const wsOf = typeof deps?.wsOf === "function" ? deps.wsOf : () => null
  const configOf = typeof deps?.configOf === "function" ? deps.configOf : () => ({})
  const driftOf = typeof deps?.driftOf === "function" ? deps.driftOf : () => null

  const noWs = (tool) => tool + ": 无法确定工作区根（本会话没有 cwd）——台账按**工作区**落盘，无工作区即不可用。"

  return {
    task_add: {
      name: "task_add",
      description: taskToolDescriptions.task_add,
      parameters: taskToolSchemas.task_add,
      async execute(args, exec) {
        const agent = exec?.agent
        const ws = wsOf(agent)
        if (!ws) return noWs("task_add")
        const view = readTasksView(ws) // 先读（拿 rev），再写
        const r = applyTaskCreate(ws, {
          kind: args?.kind,
          title: args?.title,
          check: args?.check,
          why: args?.why,
          priority: args?.priority,
          expectedRev: view.rev,
        })
        return writeResultText("task_add", r)
      },
    },
    task_update: {
      name: "task_update",
      description: taskToolDescriptions.task_update,
      parameters: taskToolSchemas.task_update,
      async execute(args, exec) {
        const ws = wsOf(exec?.agent)
        if (!ws) return noWs("task_update")
        // ★ 先判非法键：越界键**拒写**（不是静默丢弃）—— 此处的「零写入」是结构性的（连读都没读）。
        const stray = strayArgKeys(args)
        if (stray.length > 0) return refuseStrayArgs("task_update", stray)
        const patch = {}
        for (const k of UPDATABLE_FIELDS) {
          if (args && Object.prototype.hasOwnProperty.call(args, k)) patch[k] = args[k]
        }
        const view = readTasksView(ws)
        const r = applyTaskUpdate(ws, { id: args?.id, patch, expectedRev: view.rev })
        return writeResultText("task_update", r)
      },
    },
    task_done: {
      name: "task_done",
      description: taskToolDescriptions.task_done,
      parameters: taskToolSchemas.task_done,
      async execute(args, exec) {
        const ws = wsOf(exec?.agent)
        if (!ws) return noWs("task_done")
        const view = readTasksView(ws)
        const r = applyTaskTransition(ws, {
          id: args?.id,
          to: typeof args?.to === "string" && args.to.trim() !== "" ? args.to : "完成",
          evidence: args?.evidence,
          reason: args?.reason,
          blockedBy: args?.blockedBy,
          expectedRev: view.rev,
        })
        return writeResultText("task_done", r)
      },
    },
    task_list: {
      name: "task_list",
      description: taskToolDescriptions.task_list,
      parameters: taskToolSchemas.task_list,
      async execute(args, exec) {
        const agent = exec?.agent
        const ws = wsOf(agent)
        if (!ws) return noWs("task_list")
        const sid = agent?.session?.id ?? null
        const cfg = resolveLedgerConfig(configOf())
        const view = readTasksView(ws) // ← 唯一读函数（输出由它派生，腿 T-8③）
        if (args?.view === "board") {
          const payload = buildTasksBoardPayload({ ws, sessionId: sid, config: configOf(), drift: driftOf(sid) })
          return renderBoardText(payload)
        }
        return renderTaskListText(view, { mode: cfg.mode })
      },
    },
  }
}

/**
 * **看板渲染模式**（FR-6 / US-11）：`dsh-better-sidebar` 缺席时在会话内渲染同源内容。
 * @post 输出**由 `readTasksView()` 派生**（载荷带 `generatedFrom`）；决策区**在任务区之前**（腿 T-14）；
 *       空集给**明确空态**且**不渲染空分区**；`ledger.mode=off` ⇒ 个人台账分区消失、防漂移状态区仍在（T-9）
 * @post **纯确定性**（无时间戳）
 */
export function renderBoardText(payload) {
  const p = payload && typeof payload === "object" ? payload : {}
  const lines = []
  lines.push("════ thincoder 看板（会话内渲染 · 与侧栏同源：readTasksView） ════")
  // —— ① 防漂移状态区（FR-11：当前目标 / 判据 / 欠账 / 本回合被推回次数；复用批 34 既有读数）——
  lines.push(...renderDriftBlock(p.drift))
  if (p.offNote) {
    lines.push("")
    lines.push(p.offNote)
    return lines.join("\n")
  }
  lines.push("")
  lines.push("账本：rev=" + String(p.rev ?? 0) + (p.malformed ? "（⚠ 畸形：写面已 fail-closed）" : "") + " · " + String(p.path ?? "（无路径）"))
  if (p.malformed && p.trace) lines.push("⚠ " + single(p.trace))
  if (p.emptyState) {
    lines.push("")
    lines.push("（空）" + single(p.emptyState))
    return lines.join("\n")
  }
  const sections = Array.isArray(p.sections) ? p.sections : []
  for (const s of sections) {
    if (s.countOnly) {
      lines.push("")
      lines.push("—— " + s.title + "（" + (s.count ?? 0) + "）——")
      continue
    }
    if (!Array.isArray(s.tasks) || s.tasks.length === 0) continue // 空分区**不渲染**（T-14）
    lines.push("")
    lines.push("—— " + s.title + "（" + s.tasks.length + "）" + (s.top ? " · 置顶" : "") + " ——")
    for (const t of s.tasks) {
      lines.push("  " + t.id + " [" + t.statusTag + "] " + single(t.title))
      lines.push("     怎么算完成：" + single(t.check))
      if (t.why) lines.push("     为什么做：" + single(t.why))
      if (t.blockedReason) lines.push("     卡在哪：" + single(t.blockedReason) + "（" + (t.blockedBy === "external" ? "等外部" : "等自己动手") + "）")
      if (t.evidence) lines.push("     凭据：" + single(t.evidence))
    }
  }
  lines.push("")
  lines.push("（只读渲染面：看板**不能**打勾/改进度——完成必须带凭据，写入口只有工具/对话。）")
  const docs = Array.isArray(p.docs) ? p.docs : []
  if (docs.length > 0) {
    lines.push("")
    lines.push("—— 结构化文档（只读 · FR-8）——")
    for (const d of docs) {
      if (!d.ok) { lines.push("  " + d.path + "：⚠ " + d.error); continue }
      const c = d.counts ?? {}
      const complete = (d.rows || []).filter((r) => r.piecesComplete).length
      lines.push("  " + d.path + "：共 " + (c.total ?? 0) + " 条 · TODO " + (c.TODO ?? 0) + " · DOING " + (c.DOING ?? 0)
        + " · BLOCKED " + (c.BLOCKED ?? 0) + " · PASS " + (c.PASS ?? 0) + " · FAIL " + (c.FAIL ?? 0)
        + " · 未识别 " + (c.UNKNOWN ?? 0) + " · 验收五件齐 " + complete + " 条")
    }
  }
  return lines.join("\n")
}

/** 防漂移状态区（FR-11；**只读**批 34 的既有读数，不新建状态）。 */
export function renderDriftBlock(drift) {
  const d = drift && typeof drift === "object" ? drift : null
  if (!d) return ["【防漂移状态区】读数不可得（本会话无批 34 状态或宿主 goal 服务缺席）——不影响任务台账。"]
  const out = ["【防漂移状态区】（复用批 34 既有读数，不新建状态）"]
  out.push("  当前目标：" + (d.goal?.objective ? single(d.goal.objective) : "（无活跃目标）") + (d.goal?.id ? "（" + d.goal.id + "）" : ""))
  out.push("  判据：" + (d.criteria?.check ? single(d.criteria.check) : "（无判据记录——按纪律应先调 goal_criteria set）"))
  out.push("  欠账：" + (Array.isArray(d.debts) && d.debts.length > 0 ? d.debts.join(" · ") : "无"))
  out.push("  本回合被推回次数：" + String(Number.isFinite(d.pushback) ? d.pushback : 0))
  return out
}
