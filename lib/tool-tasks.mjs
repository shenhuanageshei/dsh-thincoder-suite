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
  BOARD_SCOPES, DEFAULT_COPY_TEMPLATE, READONLY_FIELDS, TASK_STATUSES, UPDATABLE_FIELDS,
  applyTaskClaim, applyTaskCreate, applyTaskTransition, applyTaskUpdate,
  isClaimableBy, isOwnedBy, ownerOf, parseChecklistDoc, readTasksView, resolveLedgerConfig,
  sessionIdOf, tasksInScope,
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

/**
 * 本批注册的**五个**工具名（文档、测试与命令面共用这一份清单）。
 * ★ 批 36-补新增 `task_claim`（设计档 §16.2 的交接动作）——它走同一道写门（`applyTaskClaim`）。
 */
export const TASK_TOOL_NAMES = Object.freeze(["task_add", "task_update", "task_done", "task_list", "task_claim"])

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
    + "degraded board (used when the dsh-better-sidebar plugin is absent). Entries are grouped by OWNERSHIP "
    + "(createdBy = who filed it, never changes; owner = who is responsible now; claimedFrom = the previous "
    + "owner). Open entries owned by ANOTHER session (or by nobody) belong to the handoff region — claim them "
    + "with task_claim instead of re-filing them.",
  task_claim:
    "Claim ONE existing ledger entry for THIS session — the handoff action (batch-36). It changes ONLY the "
    + "owner and records the previous owner as claimedFrom: status, evidence, blockedReason, doneAt and "
    + "createdBy stay byte-identical, so the evidence gate, the five-state machine and the rev gate are all "
    + "untouched. Use it when a previous session (or a rotated/predecessor session) left open work behind — "
    + "those entries show up in the board's 待接手 region. Ownership is NEVER changed automatically, and "
    + "nothing is written on any validation failure.",
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
  task_claim: {
    type: "object",
    properties: {
      id: { type: "string", description: "Ledger id to claim for this session, e.g. t-3 (from task_list)" },
    },
    required: ["id"],
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
    // 归属三字段（设计档 §16.1）：看板要显示「这是谁的活」，三区要能分辨本会话 / 待接手
    createdBy: sessionIdOf(t.createdBy),
    owner: ownerOf(t),
    claimedFrom: sessionIdOf(t.claimedFrom),
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
 * @pre  `ws` = 工作区根；`config` = 全局生效配置（`ledger.*` 从它解析）；`sessionId` = 看板所属会话
 * @post **纯函数**：全部字段由 `readTasksView(ws)` 与入参派生（`generatedFrom` 字段即这条结构自证）；
 *       **零写盘、零时间戳**（看板不写任何文件，N-1）
 * @post **三区**（批 36-补 · 设计档 §16.2）：`views.mine`（`owner === 当前会话`）·
 *       `views.claimable`（**未完成 ∧ owner ≠ 当前会话**）· `views.all`；`defaultScope` 默认 `mine`
 *       （无会话 id ⇒ `all`，否则「本会话」永远是空的、看板会骗人）。`scopes[]` 给三个区的标题与计数。
 *       ★ **待接手区不判会话活性**：判据只看 `owner`，**不引入**任何会话活性/投影依赖（用户 2026-10-17 裁定）。
 * @post 每个区里的分区顺序同一套：**决策区置顶**（`sections[0].key === "decisions"`），空集给 `emptyState` 文案
 * @post 顶层 `sections` / `emptyState` / `copyAllDecisions` = **默认区**的那一份（老读者不受影响）；
 *       `ledger` 恒为**全账本**四分区（看板 ≡ 工具读的那条腿比对的就是它 —— 设计-D3）
 * @post `ledger.mode === "off"` ⇒ `ledger: null` + 只有 `drift`（防漂移状态区**仍在**，腿 T-9）
 */
export function buildTasksBoardPayload({ ws, sessionId, config, drift }) {
  const cfg = resolveLedgerConfig(config)
  const view = readTasksView(ws) // ← 唯一读函数（看板/工具/注入三面同源，设计-D3）
  const sid = sessionIdOf(sessionId)
  const rowOf = (t, scope) => ({
    ...boardRowOf(t),
    // 「能不能接手」由**读面谓词**判定（与写门同源），不让浏览器自己算
    canClaim: scope === "claimable" && isClaimableBy(t, sid),
    copyPrompt: buildCopyPrompt(t, cfg.copyTemplate),
    click: buildTaskClickPayload({ task: t, template: cfg.copyTemplate, view, docPaths: cfg.docPaths }),
  })
  const base = {
    ok: true,
    generatedFrom: "readTasksView",
    mode: cfg.mode,
    sessionId: sid,
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
      scopes: [],
      views: {},
      defaultScope: null,
      docs: [],
      emptyState: null,
      // 复制按钮：模式关闭时**决策区不存在** ⇒ 「复制全部待你决策的项」没有内容（空串，前端不渲染该按钮）
      copyAllDecisions: "",
      offNote: "个人任务台账已关闭（ledger.mode=off）——防漂移状态区照常显示（US-9）",
    }
  }
  /**
   * 一个区的完整渲染面（分区顺序与判据**同一套**：完成 → 决策(未完成) → 卡住(work) → 在办(work)）。
   * 分区判据与 `readTasksView` 的分区谓词逐条同源（本函数只对**已按区筛过的**列表重做一次分组）。
   */
  const buildScopeView = (scope) => {
    const scoped = tasksInScope(view.tasks, scope, sid)
    const decisions = scoped.filter((t) => t.status !== "完成" && t.kind === "decision")
    const done = scoped.filter((t) => t.status === "完成")
    const blocked = scoped.filter((t) => t.status !== "完成" && t.kind === "work" && t.status === "卡住")
    const active = scoped.filter((t) => t.status !== "完成" && t.kind === "work" && t.status !== "卡住")
    const sections = [
      { key: "decisions", title: "待你决策", top: true, empty: "没有待你决策的项。", tasks: decisions.map((t) => rowOf(t, scope)) },
      { key: "blocked", title: "卡住", empty: "没有卡住的项。", tasks: blocked.map((t) => rowOf(t, scope)) },
      { key: "active", title: "任务", empty: "没有在办的任务。", tasks: active.map((t) => rowOf(t, scope)) },
      { key: "done", title: "已完成", countOnly: true, count: done.length, tasks: done.map((t) => rowOf(t, scope)) },
    ]
    const label = BOARD_SCOPES.find((s) => s.key === scope)?.title ?? scope
    let emptyState = null
    if (scoped.length === 0) {
      if (view.tasks.length === 0) {
        emptyState = "台账还是空的：让模型用 task_add 记一条（或直接说「记一条：…」，并写清怎么算完成）。"
      } else if (scope === "mine") {
        emptyState = "本会话名下没有任务。切到「待接手」看看前任/别的会话留下的未完成项，或「全部」看整本账。"
      } else if (scope === "claimable") {
        emptyState = "没有待接手的项：其它会话留下的未完成项会出现在这里（判据只看归属，不看会话是否还活着）。"
      } else {
        emptyState = "台账里没有可显示的条目。"
      }
    }
    return {
      key: scope,
      title: label,
      count: scoped.length,
      sections,
      emptyState,
      copyAllDecisions: buildCopyAllPrompt(decisions.map(boardRowOf), cfg.copyTemplate),
    }
  }
  const views = {}
  for (const s of BOARD_SCOPES) views[s.key] = buildScopeView(s.key)
  const defaultScope = sid === null ? "all" : "mine"
  const scopes = BOARD_SCOPES.map((s) => ({ key: s.key, title: s.title, count: views[s.key].count }))
  return {
    ...base,
    ledger: {
      decisions: view.decisions.map((t) => rowOf(t, "all")),
      active: view.active.map((t) => rowOf(t, "all")),
      blocked: view.blocked.map((t) => rowOf(t, "all")),
      done: view.done.map((t) => rowOf(t, "all")),
    },
    scopes,
    views,
    defaultScope,
    // —— 兼容面（既有渲染/腿读的是这三个；= 默认区的那一份）——
    sections: views[defaultScope].sections,
    emptyState: views[defaultScope].emptyState,
    copyAllDecisions: views[defaultScope].copyAllDecisions,
    // FR-8：结构化文档只读源（**只读**渲染勾选态与「验收五件齐没齐」；不可写）
    docs: readChecklistDocs({ ws: view.ws, docPaths: cfg.docPaths }),
  }
}

/**
 * **接手**（交接动作 `task_claim` 的唯一执行体 · 设计档 §16.2）。
 * @pre  `ws` = 工作区根；`sessionId` = **接手方**会话 id；`id` = 台账条目号
 * @post **零状态机**：判定全部在写门 `applyTaskClaim` 里（rev 门 / id 存在 / owner-required）；
 *       本函数只做「读 rev → 调门 → 回新载荷」三件事（工具面、命令面、看板三处**同一个实现**）
 * @post 成功 ⇒ 返回**刷新后的整份看板载荷**（并带 `claim` 摘要）⇒ 调用方无需二次拉取；
 *       失败 ⇒ `{ ok:false, code, error, text }`，**零写入**
 */
export function buildTaskClaimResult({ ws, sessionId, id, config, drift }) {
  const sid = sessionIdOf(sessionId)
  const view = readTasksView(ws) // ← 先读（拿 rev），再写——与工具面同一形态
  const r = applyTaskClaim(ws, { id, sessionId: sid, expectedRev: view.rev })
  if (!r.ok) {
    return { ok: false, code: r.code, error: r.reason, text: refuseText("task_claim", r.code, r.reason) }
  }
  return {
    ...buildTasksBoardPayload({ ws, sessionId: sid, config, drift }),
    claim: { id: r.id, owner: r.owner, claimedFrom: r.claimedFrom, rev: r.rev },
  }
}

/**
 * 工具文本里的台账列表（`task_list` 的 list 模式；**由 `readTasksView` 派生**）。
 * @post **纯确定性**（同 view ⇒ 逐字节同输出；无时间戳/百分比/步数）
 * @post 归属可见（批 36-补）：活任务行尾给「归属：<owner>」，非本会话的未完成项额外标「可接手」
 */
export function renderTaskListText(view, meta) {
  // ★ 2026-10-17 交付评审 #1：原写法 `readTasksView(null)` 是**永真的死分支**
  //   （`workspaceRootOf(null)` → null ⇒ 恒返回空账本），而唯一真实调用方（本档 :486）始终显式传 view。
  //   隐患：将来被误用即成「**静默空输出**」—— 模型会以为台账是空的。故改为**显式空态且自报家门**。
  const v = view && typeof view === "object" ? view : {
    rev: 0, ws: null, malformed: true, trace: "未传入视图 ⇒ 显式空态（**不代表台账为空**）",
    decisions: [], active: [], blocked: [], done: [],
    counts: { total: 0, decisions: 0, active: 0, blocked: 0, done: 0, todo: 0, doing: 0, unknown: 0 },
  }
  const m = meta && typeof meta === "object" ? meta : {}
  const sid = sessionIdOf(m.sessionId)
  const lines = []
  const counts = v.counts ?? {}
  lines.push("[thincoder 任务台账] rev=" + String(v.rev ?? 0) + " · 待你决策 " + (counts.decisions ?? 0)
    // ★ 2026-10-17 标签更正（与客户端同改）：`counts.active` = 待办+已接手+在做 的合计 ⇒ 「在办」。
    + " · 在办 " + (counts.active ?? 0) + " · 卡住 " + (counts.blocked ?? 0) + " · 完成 " + (counts.done ?? 0))
  if (v.ws) lines.push("工作区：" + v.ws)
  if (v.malformed && v.trace) lines.push("⚠ " + v.trace)
  if (m.mode === "off") lines.push("个人任务台账已关闭（ledger.mode=off）——防漂移状态区不受影响（US-9）。")
  /** 归属后缀（批 36-补）：让模型看得见「这是谁的活、谁留下的」。**纯读数**，不改任何判据。 */
  const ownerSuffix = (t) => {
    const o = ownerOf(t)
    const mine = isOwnedBy(t, sid)
    const who = o === null ? "无归属" : mine ? "本会话" : o
    const claim = sid !== null && isClaimableBy(t, sid) ? "，可接手（task_claim）" : ""
    return " — 归属：" + who + claim
  }
  const group = (title, arr) => {
    if (!arr || arr.length === 0) return
    lines.push(title + "（" + arr.length + "）")
    for (const t of arr) {
      lines.push("  " + t.id + " [" + statusTagOf(t) + "] " + single(t.title)
        + " — 怎么算完成：" + single(t.check)
        + (t.evidence ? " — 凭据：" + single(t.evidence) : "")
        + (t.blockedReason ? " — 卡在哪：" + single(t.blockedReason) : "")
        + ownerSuffix(t))
    }
  }
  if (m.mode !== "off") {
    group("待你决策", v.decisions)
    group("卡住", v.blocked)
    group("任务", v.active)
    if (Array.isArray(v.done) && v.done.length > 0) {
      lines.push("已完成（" + v.done.length + "）")
      for (const t of v.done) lines.push("  " + t.id + " [完成] " + single(t.title) + (t.evidence ? " — 凭据：" + single(t.evidence) : "") + ownerSuffix(t))
    }
    if (Array.isArray(v.tasks) && v.tasks.length === 0) {
      lines.push("（空账本）让模型用 task_add 记一条；`check` 必填（没写怎么算完成 = 许愿不是任务）。")
    }
    // 交接提示（批 36-补）：有别人留下的未完成项时，明确告诉模型「别重建，去接手」
    const claimable = Array.isArray(v.tasks) ? v.tasks.filter((t) => isClaimableBy(t, sid)) : []
    if (claimable.length > 0) {
      lines.push("待接手（" + claimable.length + "）：这些是**别的会话/无归属**留下的未完成项 —— "
        + "用 task_claim 接手（只改 owner，不改状态），不要重复建单。")
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

/** 写门结果 → 人话（五工具共用；**零校验逻辑**，只翻译）。 */
function writeResultText(tool, r) {
  if (!r || r.ok !== true) {
    return refuseText(tool, r?.code ?? "?", r?.reason ?? "原因未知")
  }
  const tail = "  （rev → " + r.rev + "；看板与注入行读的都是这一份 tasks.json）"
  if (tool === "task_add") {
    return "task_add: 已建 " + r.id + "（status=" + r.status + "），rev → " + r.rev + "。" + tail
  }
  if (tool === "task_update") return "task_update: 已改 " + r.id + "，" + tail
  if (tool === "task_claim") {
    return "task_claim: " + r.id + " 已接手（owner → " + (r.owner ?? "（无）")
      + "；旧 owner = " + (r.claimedFrom ?? "（无归属）")
      + "；状态仍是 " + r.status + " —— 接手**只改归属**），rev → " + r.rev + "。" + tail
  }
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
 * 组装**五个**工具（返回 `{name, description, parameters, execute}` —— 由 `lib/index.mjs` 逐个注册）。
 * @param {{wsOf: (agent) => string|null, configOf: () => object, driftOf?: (sessionId) => object|null}} deps
 *   `wsOf` 必须返回**会话的工作区根**（无 cwd ⇒ `null`；**绝不**回落到 `process.cwd()`）
 * @post **归属只从 `agent.session.id` 取**（取不到 ⇒ 归 `null`/拒 —— **不编造**，设计档 §16.1）
 */
export function makeTaskTools(deps) {
  const wsOf = typeof deps?.wsOf === "function" ? deps.wsOf : () => null
  const configOf = typeof deps?.configOf === "function" ? deps.configOf : () => ({})
  const driftOf = typeof deps?.driftOf === "function" ? deps.driftOf : () => null

  const noWs = (tool) => tool + ": 无法确定工作区根（本会话没有 cwd）——台账按**工作区**落盘，无工作区即不可用。"
  /** 当前会话 id（工具面唯一的归属来源；**取不到就是 null**）。 */
  const sessionIdOfAgent = (agent) => sessionIdOf(agent?.session?.id)

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
          // ★ 2026-10-17 缺陷修复：schema 的描述面逐字写着 `'work' (default)`，但此前这里直接透传
          //   `args?.kind` ⇒ 模型按描述省略 kind 时会撞上门里的 `kind-invalid`（实测：我第一次调用就被拒）。
          //   默认值落在**工具层**（门仍保持严格，它要求显式枚举是设计意图）；描述面与实现由此一致。
          kind: args?.kind ?? "work",
          title: args?.title,
          check: args?.check,
          why: args?.why,
          priority: args?.priority,
          expectedRev: view.rev,
          // 归属（批 36-补）：建单会话 = createdBy = owner；取不到 ⇒ null（不编造）
          sessionId: sessionIdOfAgent(agent),
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
        const sid = sessionIdOfAgent(agent)
        const cfg = resolveLedgerConfig(configOf())
        const view = readTasksView(ws) // ← 唯一读函数（输出由它派生，腿 T-8③）
        if (args?.view === "board") {
          const payload = buildTasksBoardPayload({ ws, sessionId: sid, config: configOf(), drift: driftOf(sid) })
          return renderBoardText(payload)
        }
        return renderTaskListText(view, { mode: cfg.mode, sessionId: sid })
      },
    },
    // ★ 批 36-补：接手（交接动作）。**工具层零状态机** —— 只取参 / 读 rev / 调门 / 翻译。
    task_claim: {
      name: "task_claim",
      description: taskToolDescriptions.task_claim,
      parameters: taskToolSchemas.task_claim,
      async execute(args, exec) {
        const agent = exec?.agent
        const ws = wsOf(agent)
        if (!ws) return noWs("task_claim")
        const view = readTasksView(ws) // 先读（拿 rev），再写
        const r = applyTaskClaim(ws, { id: args?.id, sessionId: sessionIdOfAgent(agent), expectedRev: view.rev })
        return writeResultText("task_claim", r)
      },
    },
  }
}

/**
 * **看板渲染模式**（FR-6 / US-11）：`dsh-better-sidebar` 缺席时在会话内渲染同源内容。
 * @post 输出**由 `readTasksView()` 派生**（载荷带 `generatedFrom`）；决策区**在任务区之前**（腿 T-14）；
 *       空集给**明确空态**且**不渲染空分区**；`ledger.mode=off` ⇒ 个人台账分区消失、防漂移状态区仍在（T-9）
 * @post **三区**（批 36-补 · 设计档 §16.2）：本会话 / 待接手（N）/ 全部。
 *       本会话沿用完整分区（决策置顶）；待接手**逐条列出 id 并给 `task_claim` 的操作指引**；
 *       全部只给计数与完成数（完整条目在侧栏看板）。★ **待接手区不判会话活性**。
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

  /** 一个区里的分区（决策置顶 / 空分区不渲染）。 */
  const renderSections = (sections) => {
    for (const s of Array.isArray(sections) ? sections : []) {
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
  }

  const views = p.views && typeof p.views === "object" ? p.views : null
  if (!views) {
    // 兼容面（老载荷 / 手工构造的载荷）：只渲染顶层 sections（行为与此前逐字相同）
    if (p.emptyState) {
      lines.push("")
      lines.push("（空）" + single(p.emptyState))
      return lines.join("\n")
    }
    renderSections(p.sections)
    lines.push("")
    lines.push("（只读渲染面：看板**不能**打勾/改进度——完成必须带凭据，写入口只有工具/对话。）")
    lines.push(...renderDocBlock(p.docs))
    return lines.join("\n")
  }

  // —— ② 本会话（默认区；决策置顶）——
  const mine = views.mine ?? { count: 0, sections: [], emptyState: null }
  lines.push("")
  lines.push("—— 本会话（" + (mine.count ?? 0) + "）——")
  if (mine.emptyState) lines.push("  （空）" + single(mine.emptyState))
  else renderSections(mine.sections)

  // —— ③ 待接手（N）：别人 / 前任 / 无归属留下的**未完成**项；判据只看归属，不判会话活性 ——
  const claimable = views.claimable ?? { count: 0, sections: [], emptyState: null, tasks: [] }
  const claimRows = (Array.isArray(claimable.sections) ? claimable.sections : [])
    .flatMap((s) => (s.countOnly ? [] : (Array.isArray(s.tasks) ? s.tasks : [])))
  lines.push("")
  lines.push("—— 待接手（" + (claimable.count ?? 0) + "）——")
  if (claimRows.length === 0) {
    lines.push("  （空）" + single(claimable.emptyState ?? "没有待接手的项。"))
  } else {
    for (const t of claimRows) {
      lines.push("  " + t.id + " [" + t.statusTag + "] " + single(t.title)
        + " — 归属：" + (t.owner === null || t.owner === undefined ? "无归属" : String(t.owner))
        + (t.claimedFrom ? "（接手自 " + String(t.claimedFrom) + "）" : ""))
      lines.push("     接手：task_claim id=" + t.id + "（或 /task_claim " + t.id + "）——只改归属，不改状态")
    }
  }

  // —— ④ 全部（只给计数；完整条目在侧栏看板 / task_list list 模式）——
  const all = views.all ?? { count: 0 }
  lines.push("")
  lines.push("—— 全部（" + (all.count ?? 0) + "）——")
  const doneCount = (Array.isArray(all.sections) ? all.sections : []).find((s) => s.countOnly)
  lines.push("  本会话 " + (mine.count ?? 0) + " · 待接手 " + (claimable.count ?? 0) + " · 已完成 " + (doneCount?.count ?? 0)
    + " · 整本账 " + (all.count ?? 0) + "（明细用 task_list 或侧栏看板）")

  lines.push("")
  lines.push("（看板**不能**打勾/改进度——完成必须带凭据；唯一的归属写入是「接手」，且它只改 owner。）")
  lines.push(...renderDocBlock(p.docs))
  return lines.join("\n")
}

/** 结构化文档只读块（FR-8；两处渲染面共用，避免第二份文案）。 */
function renderDocBlock(docs) {
  const out = []
  const list = Array.isArray(docs) ? docs : []
  if (list.length === 0) return out
  out.push("")
  out.push("—— 结构化文档（只读 · FR-8）——")
  for (const d of list) {
    if (!d.ok) { out.push("  " + d.path + "：⚠ " + d.error); continue }
    const c = d.counts ?? {}
    const complete = (d.rows || []).filter((r) => r.piecesComplete).length
    out.push("  " + d.path + "：共 " + (c.total ?? 0) + " 条 · TODO " + (c.TODO ?? 0) + " · DOING " + (c.DOING ?? 0)
      + " · BLOCKED " + (c.BLOCKED ?? 0) + " · PASS " + (c.PASS ?? 0) + " · FAIL " + (c.FAIL ?? 0)
      + " · 未识别 " + (c.UNKNOWN ?? 0) + " · 验收五件齐 " + complete + " 条")
  }
  return out
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
