// tasks.mjs — 批 36「个人任务台账」核心（设计档 docs/2026-10-16-task-ledger-design.md §6 伪代码 / §7.1 落点）。
//
// 三条结构性纪律（设计-D3 / 需求 N-1）：
//   ① **唯一写门**：`applyTaskCreate` / `applyTaskUpdate` / `applyTaskTransition` / `applyTaskClaim`
//      —— 台账只能经这四个函数变；命令面（`/task_*`）与工具面**一律**走这里，**不得**自己校验状态机或自己写盘；
//   ② **唯一读函数**：`readTasksView()` —— 看板 / 注入行 / 工具三面**只调它**，不得各自解析 `tasks.json`；
//   ③ **任何拒绝路径文件字节不变**：先读、后校验、最后才写一次（`writeFileAtomic`），拒绝分支零写入。
//
// 归属三字段（设计档 §16.1，批 36-补）——这是「交接轮换新会话怎么办」的答案：
//   · `createdBy` **不可变**（谁建的：审计事实，任何写路都不许改）；
//   · `owner`     **可改，且只能经 `applyTaskClaim`**（现在归谁负责；建单时 = createdBy）；
//   · `claimedFrom` 接手时记下的**旧 owner**（只由 claim 写一次）。
//   ★ **向后兼容**：旧台账（本批之前写的）没有这三个字段 ⇒ 读面视为 `null`（=「无归属」），
//     **不报错、不迁移、不改写文件**（腿 T-18）。文件只在**一次真实写**之后才会带上新字段。
//   ★ **绝不自动改归属**：没有任何路径会「顺手」把 owner 改成当前会话（悄悄吞掉别人的活比断层更糟）。
//   ★ **待接手区不判会话活性**（用户 2026-10-17 裁定）：只看 `owner !== 当前会话`，**不引入**任何
//     会话活性 / 投影依赖（那会让判据 flaky，也会把本模块拖进宿主服务面）。
//
// 落点与键控（★ 设计档 §7.1 评审第二轮 N1 明文禁止照搬 goal-criteria 的做法）：
//   · 路径 = `<工作区根>/.thincoder/tasks.json` —— 「约定复用」（本仓既有的项目侧 `.thincoder/` 目录），
//     **不是实现复用**；`.thincoder/` 目录在**用户工作区内**，随仓走 ⇒ 满足需求 N-3「绑工作区、跨会话跨重启」。
//   · 键控 = **按工作区根绝对路径**，本台账**自建**（`resolveTasksPath` / `workspaceRootOf`）。
//     ★ 明确**不用** `lib/anti-drift.mjs` 的 `resolveCriteriaStorePath`：那一处的 `home` 是
//     **DSH profile 根**（`pickDshHome` 的返回），不是工作区根；该档 `:227` 自陈照搬的后果是
//     「回落到会话 cwd ⇒ 把文件写进用户工作区（污染仓库，每个 cwd 一份碎片）」。本台账要的**正是**
//     「住进工作区」，但必须由**工作区根**这一个键决定，不能靠 profile 根探测或 cwd 兜底。
//   · 原子写 = **只复用** `lib/dsh-home.mjs` 的 `writeFileAtomic`（tmp + rename + 有界重试）。
//
// 零新增运行时依赖：只 import `node:` 内建与仓内相对模块（腿 T-15 静态断言）。
// 零宿主复用：本模块**不读**宿主 todos 投影、**零** todo_write 调用点（FR-10 / 腿 T-15）。
//   ★ 腿 T-15 的扫描口径（**权威定义 = 设计档 §九 T-15**；域 = `lib/**` 的全部代码档）——三形并列：
//     ① **引号字面**：把宿主工具名 / 投影键名放进引号里写（注册点与投影键的形态）；
//     ② **调用形**：名字后紧跟左括号（真正的调用点）；
//     ③ **裸属性读**：点号后直接跟名字、不经字符串（点号形态的投影读取）——
//        外加两个宿主投影面的**裸标识符**（它们本身就是投影面的名字，无引号也照抓）。
//     本次定点修复**补齐了 ③**：旧口径只覆盖 ①②，点号形态的宿主投影读取会**漏检**。
//     散文里点名的裸词（如本行上方那句「宿主 todos 投影」）**不算**调用点——那正是「描述 vs 调用」的差别。
//     ★ 自指陷阱：本注释**刻意不逐字写出**那两串工具名/键名（写了就会被 ① 抓到 ⇒ 腿自红）。
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { writeFileAtomic } from "./dsh-home.mjs"

/** schema 版本（设计档 §7.1 字段表首行）。 */
export const LEDGER_SCHEMA_VERSION = 1
/** 项目侧目录约定（`.thincoder/` 住**工作区**内——与 profile 侧的 `$DSH_HOME/.thincoder/` 是两处）。 */
export const LEDGER_SUBDIR = ".thincoder"
/** 台账文件名。 */
export const LEDGER_FILE = "tasks.json"

/** 五态（需求-D4：比三态多「已接手」与「卡住」）。 */
export const TASK_STATUSES = Object.freeze(["待办", "已接手", "在做", "完成", "卡住"])
/** 条目种类：普通任务 / 待用户拍板的决策项（需求-D8，同一账本两个分区）。 */
export const TASK_KINDS = Object.freeze(["work", "decision"])
/** 「卡住」的两个朝向（需求-D4 / US-4：等外部 vs 等自己动手）。 */
export const BLOCKED_BY_VALUES = Object.freeze(["external", "self"])

/**
 * 五态迁移表（设计档 §6 逐行；**可退回**是刻意设计：接手后发现不该做要能退、做一半要能换法）。
 * 一切状态变更**只**经此表 —— 工具层不得自建第二份判定（FR-3）。
 */
export const ALLOWED_MIGRATIONS = Object.freeze({
  待办: Object.freeze(["已接手", "卡住"]),
  已接手: Object.freeze(["在做", "待办", "卡住"]), // 可退回（接手后发现不该做）
  在做: Object.freeze(["完成", "卡住", "已接手"]), // 可退回（做了一半换人/换法）
  卡住: Object.freeze(["待办", "已接手", "在做"]), // 解卡后回到流程
  完成: Object.freeze(["待办"]), // 可重开（但完成时留下的 evidence **不清空**）
})

/** `applyTaskUpdate` 的**可改字段闭集**（设计档 §6：命中不可改字段 ⇒ **拒**，不是静默忽略）。 */
export const UPDATABLE_FIELDS = Object.freeze(["title", "check", "why", "priority"])
/**
 * 明确不可改的字段（闭集；给拒绝文案与文档用）。
 * ★ 批 36-补：归属三字段也在这里 —— `createdBy` **任何写路都不许改**；`owner` / `claimedFrom`
 *   **只能经 `applyTaskClaim`**（改单路径命中它们 ⇒ 与 `status` 同款拒绝，不是静默忽略）。
 */
export const READONLY_FIELDS = Object.freeze([
  "id", "kind", "status", "evidence", "blockedReason", "blockedBy", "createdAt", "doneAt",
  "createdBy", "owner", "claimedFrom",
])

/** 拒绝码闭集（工具面文案与测试共用单一事实源）。 */
export const REJECT_CODES = Object.freeze([
  "ws-unresolvable", // 工作区根解析不出来（无 cwd / 非法输入）
  "malformed", // 盘上文件畸形 ⇒ 写面 fail-closed（读面 fail-open）
  "expected-rev-invalid", // 调用方没给合法修订号（必须先 readTasksView 再写）
  "rev-conflict", // 修订号冲突 ⇒ 账本已被其他会话改动（D5 / 腿 T-11）
  "id-missing", // 条目不存在
  "kind-invalid", // kind ∉ {work, decision}
  "title-required", // 标题空
  "check-required", // 「怎么算完成」空 —— 没写就是许愿不是任务
  "status-invalid", // to ∉ 五态
  "illegal-migration", // to ∉ ALLOWED_MIGRATIONS[from]（腿 T-3）
  "evidence-required", // 转「完成」无凭据（腿 T-1 / US-2）
  "reason-required", // 转「卡住」无原因（腿 T-2 / US-3）
  "blockedby-required", // 转「卡住」的 blockedBy 非 external|self（腿 T-2 / US-4）
  "field-not-updatable", // patch 命中不可改字段（闭集外一律拒）
  "field-invalid", // 可改字段的类型/取值非法（如 priority 给了非数字）
  "no-fields", // patch 是空对象（没有要改的东西 ⇒ 拒，不空转 rev）
  "owner-required", // 接手（claim）没给**接手方会话 id** ⇒ 拒（**不编造归属**）
  "secret-suspected", // 自由文本命中疑似凭据形态（腿 T-10 / N-7，**拒写不是打码**）
  "write-failed", // 原子写失败（上层 warn，台账保持原样）
])

// ————————————— 落点与键控（自建；见档头「落点与键控」） —————————————

/**
 * 工作区根归一：接受字符串（会话 cwd / 显式根）或带 `cwd`/`root`/`workspaceRoot` 的对象。
 * @post 合法 ⇒ 绝对路径；否则 `null`（调用方各自 fail-safe，本函数**不抛**）
 */
export function workspaceRootOf(ws) {
  try {
    if (typeof ws === "string") {
      const s = ws.trim()
      return s === "" ? null : resolve(s)
    }
    if (ws && typeof ws === "object") {
      for (const k of ["cwd", "root", "workspaceRoot"]) {
        const v = ws[k]
        if (typeof v === "string" && v.trim() !== "") return resolve(v.trim())
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 台账文件路径 = `<工作区根>/.thincoder/tasks.json`。
 * @post 根不可解析 ⇒ `null`（**绝不**回落到 process.cwd() —— 那正是设计档 §7.1 点名禁止的错法）
 */
export function resolveTasksPath(ws) {
  const root = workspaceRootOf(ws)
  return root === null ? null : join(root, LEDGER_SUBDIR, LEDGER_FILE)
}

/** 空账本（文件不存在时的语义，设计档 §6 前置：不存在 ⇒ version:1, rev:0, tasks:[]）。 */
export function emptyLedger() {
  return { version: LEDGER_SCHEMA_VERSION, rev: 0, tasks: [] }
}

/** 台账序列化（唯一落盘文本形态：2 空格缩进 + 结尾换行，与仓内 config-store 同惯例）。 */
export function serializeLedger(file) {
  return JSON.stringify(file, null, 2) + "\n"
}

/**
 * 盘上文件字节的 sha256（`null` = 文件不存在/不可读）。
 * 用途：① 腿 T-1/T-2/T-6/T-11 的「拒绝路径零写入」判据（前后同值）；
 *       ② 交付报告里的读数（报告要能让宿主独立复核）。
 */
export function tasksFileSha256(ws) {
  const p = resolveTasksPath(ws)
  if (p === null) return null
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex")
  } catch {
    return null
  }
}

// ————————————— 读面（fail-open） —————————————

/** 条目归一（读面 fail-open：单条畸形 ⇒ 丢弃该条并留痕，**不抛**）。 */
function normalizeTask(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const id = typeof raw.id === "string" && /^t-\d+$/.test(raw.id.trim()) ? raw.id.trim() : null
  if (id === null) return null
  const status = TASK_STATUSES.includes(raw.status) ? raw.status : null
  if (status === null) return null
  const kind = raw.kind === "decision" ? "decision" : raw.kind === "work" ? "work" : null
  if (kind === null) return null
  const title = typeof raw.title === "string" ? raw.title.trim() : ""
  if (title === "") return null
  const str = (v) => (typeof v === "string" ? v : "")
  const optStr = (v) => (typeof v === "string" && v.trim() !== "" ? v : null)
  return {
    id,
    kind,
    title,
    status,
    check: str(raw.check).trim(),
    evidence: optStr(raw.evidence),
    blockedReason: optStr(raw.blockedReason),
    blockedBy: BLOCKED_BY_VALUES.includes(raw.blockedBy) ? raw.blockedBy : null,
    priority: Number.isFinite(raw.priority) ? raw.priority : 0,
    why: optStr(raw.why),
    createdAt: optStr(raw.createdAt),
    doneAt: optStr(raw.doneAt),
    // ★ 批 36-补 归属三字段：**缺字段 ⇒ `null`**（旧台账兼容，腿 T-18）——**不抛、不迁移、不改写**。
    //   之所以用 `optStr`（空串也归 `null`）：归属只认「一个非空会话 id」，空串没有语义。
    createdBy: optStr(raw.createdBy),
    owner: optStr(raw.owner),
    claimedFrom: optStr(raw.claimedFrom),
  }
}

/**
 * 装载盘上账本（**所有写门与读面的唯一入口**；每次调用返回**全新对象** ⇒ 拒绝路径不可能污染内存态）。
 * @post `{ ok, path, file, malformed, trace }`：
 *   · 路径解析不出 ⇒ `ok:false` + `code:"ws-unresolvable"`
 *   · 文件不存在 ⇒ 空账本（合法，不是畸形）
 *   · 读/解析失败、顶层结构非法、条目被丢弃 ⇒ `malformed:true` + `trace`（**读面照常返回已解析部分**）
 *   · 写门看到 `malformed:true` ⇒ fail-closed 拒写（否则读-改-写会**静默丢**那些没解析出来的数据）
 */
function loadLedger(ws) {
  const path = resolveTasksPath(ws)
  if (path === null) {
    return { ok: false, code: "ws-unresolvable", reason: "工作区根不可解析（没有可用的 cwd / 会话工作区）", path: null, file: emptyLedger(), malformed: true, trace: null }
  }
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch (e) {
    // ★ 2026-10-17 **交付评审 #3 修**：原实现把「文件不存在」与「读失败」**混为一谈**，一律当空账本
    //   且 `malformed:false`。那在生产上是**静默丢更新**：POSIX 下存在「不可读但可写」的文件（如 mode 0200），
    //   读面按空账本降级 ⇒ 写门带着 expectedRev=0 通过 ⇒ writeFileAtomic 把**读不到的原内容**覆盖掉。
    //   这违背 D5「冲突 fail-loud、不静默丢更新」的精神 ⇒ **只有 ENOENT 才算合法空账本**；
    //   其余读错（EACCES/EPERM/EISDIR…）一律 `malformed:true`（读面 fail-open、写面 fail-closed，与畸形文件同款）。
    if (e && e.code === "ENOENT") {
      return { ok: true, path, file: emptyLedger(), malformed: false, trace: null }
    }
    return {
      ok: true, path, file: emptyLedger(), malformed: true,
      trace: "tasks.json 读失败（" + String(e?.code ?? e?.message ?? e) + "）⇒ 读面按空账本降级、写面 fail-closed（**不静默覆盖**）",
    }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: true, path, file: emptyLedger(), malformed: true, trace: "tasks.json 畸形：JSON 解析失败（" + String(e?.message ?? e) + "）⇒ 读面按空账本降级、写面 fail-closed" }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: true, path, file: emptyLedger(), malformed: true, trace: "tasks.json 畸形：顶层不是对象 ⇒ 读面按空账本降级、写面 fail-closed" }
  }
  if (!Array.isArray(data.tasks)) {
    return { ok: true, path, file: emptyLedger(), malformed: true, trace: "tasks.json 畸形：tasks 不是数组 ⇒ 读面按空账本降级、写面 fail-closed" }
  }
  const rev = Number.isInteger(data.rev) && data.rev >= 0 ? data.rev : 0
  // 边界：本批只有 version 1（无迁移）。`version` 字段读面不暴露、写门一律改写为 1 —— 若将来真需要
  // 多版本，必须先在写门上做迁移，而不是靠这里静默改写（登记为边界，见交付报告）。
  const version = LEDGER_SCHEMA_VERSION
  const tasks = []
  let dropped = 0
  const seen = new Set()
  for (const raw of data.tasks) {
    const t = normalizeTask(raw)
    if (t === null || seen.has(t.id)) { dropped++; continue }
    seen.add(t.id)
    tasks.push(t)
  }
  const trace = dropped > 0
    ? "tasks.json 有 " + dropped + " 条条目无法解析（缺 id/kind/status/标题，或 id 重复）⇒ 已在读数中丢弃，写面 fail-closed"
    : null
  return { ok: true, path, file: { version, rev, tasks }, malformed: dropped > 0, trace }
}

/** 条目排序键（设计档 §6 FR-4 的全序：① priority 降序 ② id 数值升序 ③ createdAt 升序）。 */
function compareTasks(a, b) {
  const pa = Number.isFinite(a.priority) ? a.priority : 0
  const pb = Number.isFinite(b.priority) ? b.priority : 0
  if (pa !== pb) return pb - pa
  const na = taskNumber(a.id)
  const nb = taskNumber(b.id)
  if (na !== nb) return na - nb
  const ca = a.createdAt ?? ""
  const cb = b.createdAt ?? ""
  return ca < cb ? -1 : ca > cb ? 1 : 0
}

/** `t-<n>` 的数值部分（非 `t-<n>` 形态 ⇒ 0；排序用，不参与合法性判定）。 */
export function taskNumber(id) {
  const m = /^t-(\d+)$/.exec(String(id ?? "").trim())
  return m ? Number(m[1]) : 0
}

// ————————————— 归属三区（批 36-补 · 设计档 §16.2） —————————————
//
// ★ **待接手区不判会话活性**（用户 2026-10-17 裁定）：判据只有一条 ——「未完成 ∧ owner ≠ 当前会话」。
//   **刻意不引入**任何会话活性 / 会话投影依赖（宿主那类按会话聚合的读数）：那会让判据随宿主投影
//   形状漂移而 flaky，而本模块的全部读面必须是**纯函数**（同一份盘上字节 ⇒ 同一份读数）。
//   ★ 腿 T-15 的口径会把「点号形态的投影读取」判红 ⇒ 本注释**刻意不写出**那个投影面名字。

/** 会话 id 归一（写门、三区判定、命令面共用）：非空字符串 ⇒ trim 后原样；否则 `null`（**不编造**）。 */
export function sessionIdOf(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

/** 条目的 owner（缺字段 / 空串 ⇒ `null` = 「无归属」；旧台账兼容）。 */
export function ownerOf(t) {
  return t && typeof t === "object" ? sessionIdOf(t.owner) : null
}

/** 未完成 = `status !== "完成"`（**唯一**「待接手」在状态侧的判据）。 */
export function isOpenTask(t) {
  return !!t && typeof t === "object" && t.status !== "完成"
}

/** 是不是**这个会话**的（`owner === sessionId`；两边归一后比较，缺字段一律不等）。 */
export function isOwnedBy(t, sessionId) {
  const sid = sessionIdOf(sessionId)
  if (sid === null) return false
  return ownerOf(t) === sid
}

/**
 * 能不能被这个会话**接手**：未完成 ∧ 不是自己的 ∧ **有接手方会话 id**。
 * ★ 最后一条不是吹毛求疵：没有会话 id 就没法落 owner（写门会以 `owner-required` 拒），
 *   此时把它算成「可接手」等于在看板上给了一个**点不动的按钮** —— 那才是骗人。
 */
export function isClaimableBy(t, sessionId) {
  const sid = sessionIdOf(sessionId)
  if (sid === null) return false
  if (!isOpenTask(t)) return false
  return ownerOf(t) !== sid
}

/** 看板三区（顺序即界面顺序；`mine` 是默认区）。 */
export const BOARD_SCOPES = Object.freeze([
  Object.freeze({ key: "mine", title: "本会话" }),
  Object.freeze({ key: "claimable", title: "待接手" }),
  Object.freeze({ key: "all", title: "全部" }),
])

/**
 * 按区筛条目（**纯函数**；谓词与 `isOwnedBy` / `isClaimableBy` 同源，不写第二份判据）。
 * @post 未登记 / 畸形 scope ⇒ 按「全部」处理（fail-open：看板绝不因一个坏参数而空掉）
 */
export function tasksInScope(tasks, scope, sessionId) {
  const list = Array.isArray(tasks) ? tasks.filter((t) => t && typeof t === "object") : []
  if (scope === "mine") return list.filter((t) => isOwnedBy(t, sessionId))
  if (scope === "claimable") return list.filter((t) => isClaimableBy(t, sessionId))
  return list.slice()
}

/**
 * **唯一读函数**（FR-2 / 设计-D3）：看板、注入行、工具三面**只调它**。
 * @post **纯函数**（不写盘、不改任何模块级状态）；畸形文件 ⇒ 空/部分结构 + `trace`（fail-open），**不抛**。
 * @returns {{ws, path, rev, malformed, trace, tasks: object[], decisions: object[], active: object[],
 *   blocked: object[], done: object[], counts: object}}
 *   四分区**互斥且穷尽**（优先级：完成 → 卡住(work) → 决策 → 活任务）：
 *     · `decisions` = kind=decision ∧ status≠完成（**决策项永在决策区**——需求-D8「待你决策的项单独成区」）
 *     · `blocked`   = kind=work ∧ status=卡住
 *     · `active`    = kind=work ∧ status ∈ {待办,已接手,在做}
 *     · `done`      = status=完成（两种 kind 都进）
 */
export function readTasksView(ws) {
  const loaded = loadLedger(ws)
  if (!loaded.ok) {
    return {
      ws: null, path: null,
      rev: 0, malformed: true, trace: loaded.reason,
      tasks: [], decisions: [], active: [], blocked: [], done: [],
      counts: { total: 0, decisions: 0, active: 0, blocked: 0, done: 0, todo: 0, doing: 0, unknown: 0 },
    }
  }
  const tasks = [...loaded.file.tasks].sort(compareTasks)
  const decisions = []
  const active = []
  const blocked = []
  const done = []
  for (const t of tasks) {
    if (t.status === "完成") done.push(t)
    else if (t.kind === "decision") decisions.push(t)
    else if (t.status === "卡住") blocked.push(t)
    else active.push(t)
  }
  return {
    ws: workspaceRootOf(ws),
    path: loaded.path,
    rev: loaded.file.rev,
    malformed: loaded.malformed,
    trace: loaded.trace,
    tasks,
    decisions,
    active,
    blocked,
    done,
    counts: {
      total: tasks.length,
      decisions: decisions.length,
      active: active.length,
      blocked: blocked.length,
      done: done.length,
      todo: tasks.filter((t) => t.status === "待办").length,
      doing: tasks.filter((t) => t.status === "在做" || t.status === "已接手").length,
      unknown: 0,
    },
  }
}

// ————————————— 凭据形态检测（N-7 / 腿 T-10：**拒写**，不是打码） —————————————
//
// 为什么是「拒写」而不是「打码」：打码会把疑似凭据**留在盘上**（只是看不见），而台账是自由文本、
// 且被看板与注入行多处渲染 ⇒ 只要落盘过一次就再没有收口点。拒写把风险挡在门外（代价如实说：
// 用户得改写那句凭据再提交一次）。
// 主战场 = `evidence`（「跑了什么、看到什么」是最容易粘贴 token 的自由文本，会诊 D-83-8）；
// 本实现同样覆盖 `reason` / `title` / `check` / `why`（凡经本门写入的自由文本，口径统一）。
// ★ 精度取舍：只认**有前缀/有形状**的形态 —— 每种形态**自带阈值**（`sk-` 取 **≥16 位** `[A-Za-z0-9_-]`；
//   GitHub 家族 `ghp_/gho_/ghu_/ghs_/ghr_` 与 `github_pat_` 取 **≥20 位**；逐条见下表）。
//   **刻意不认「裸 hex」**（**无前缀**的 ≥32 位十六进制串）—— 本仓的工作流恰恰鼓励在 evidence 里写
//   sha256 前后对照，把裸 hex 判成凭据会造成大量误拒（**假阳性比漏检更伤**）。
//   ★ 2026-10-17 交付评审 #2：原注释把「≥32 位十六进制」与 `sk-` 的 `{16,}` 写在同一句，口径含混
//   （易被读成「所有形态都按 32 位 hex 判」）⇒ 此处改为**按形态逐条写清阈值**，与下表正则一致。
const SECRET_PATTERNS = [
  ["sk-", /\bsk-[A-Za-z0-9_-]{16,}\b/],
  ["gh-", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["aws-akid", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["pem", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["assigned-secret", /\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|bearer)\s*[:=]\s*\S{12,}/i],
]

/**
 * 疑似凭据形态检测（纯函数）。
 * @returns {{hit: boolean, label: string|null}} 命中 ⇒ `hit:true` + 命中族名（文案不回声命中内容）
 */
export function detectSecretShape(text) {
  const s = typeof text === "string" ? text : ""
  if (s === "") return { hit: false, label: null }
  for (const [label, re] of SECRET_PATTERNS) {
    if (re.test(s)) return { hit: true, label }
  }
  return { hit: false, label: null }
}

/** 对一组自由文本做凭据检测（返回第一个命中）。 */
function firstSecretHit(fields) {
  for (const [name, value] of fields) {
    const r = detectSecretShape(value)
    if (r.hit) return { field: name, label: r.label }
  }
  return null
}

// ————————————— 写门（唯一写入口；fail-closed） —————————————

const reject = (code, reason, path = null) => ({ ok: false, code, reason, path })
const ok = (extra) => ({ ok: true, ...extra })

/** 修订号合法性（写门前置：调用方必须先 `readTasksView` 拿到 rev）。 */
const isRev = (v) => Number.isInteger(v) && v >= 0

/** 写门共用的前置（路径/畸形/rev 三重）。返回 `{ok:true, path, file}` 或拒绝结果。 */
function preflight(ws, expectedRev) {
  const loaded = loadLedger(ws)
  if (!loaded.ok) return { rejected: reject(loaded.code, loaded.reason, null) }
  if (loaded.malformed) {
    return { rejected: reject("malformed", "台账文件畸形，写面 fail-closed（" + (loaded.trace ?? "原因未知") + "）——请人工修复或删除该文件后重试", loaded.path) }
  }
  if (!isRev(expectedRev)) {
    return { rejected: reject("expected-rev-invalid", "缺少合法的 expectedRev（请先 task_list 读到 rev 再写）", loaded.path) }
  }
  if (loaded.file.rev !== expectedRev) {
    return {
      rejected: reject("rev-conflict",
        "账本已被其他会话改动（你的 rev=" + expectedRev + "，盘上 rev=" + loaded.file.rev
        + "）——**没有写入任何内容**；请重新 task_list 读到最新 rev 再提交", loaded.path),
    }
  }
  return { ok: true, path: loaded.path, file: loaded.file }
}

/** 落盘（唯一的写点；失败不抛，返回拒绝结果）。 */
function commit(file, path) {
  try {
    writeFileAtomic(path, serializeLedger(file))
    return ok({ rev: file.rev, path })
  } catch (e) {
    return reject("write-failed", "原子写失败：" + String(e?.message ?? e), path)
  }
}

/**
 * 建单（FR-3，与写门**同一道门**）。
 * @post 无 rev 冲突 · `kind` 合法 · 标题非空 · `check` 非空（「没写怎么算完成 = 许愿不是任务」）
 *       · id 分配 `t-<max(现有数值)+1>`（**同一次读-改-写内**计算）· status=待办 · createdAt=now · rev+1
 *       · **归属**（批 36-补）：`createdBy = owner = input.sessionId`（**取不到 ⇒ `null`，不编造**）、
 *         `claimedFrom = null`
 *       · 任何拒绝 ⇒ 零写入（文件字节不变）
 */
export function applyTaskCreate(ws, input = {}) {
  const pre = preflight(ws, input.expectedRev)
  if (pre.rejected) return pre.rejected
  const kind = input.kind === "decision" ? "decision" : input.kind === "work" ? "work" : null
  if (kind === null) {
    return reject("kind-invalid", "kind 必须是 work|decision（决策项用 kind=decision，看板会把它放进置顶区）", pre.path)
  }
  const title = typeof input.title === "string" ? input.title.trim() : ""
  const check = typeof input.check === "string" ? input.check.trim() : ""
  const why = typeof input.why === "string" && input.why.trim() !== "" ? input.why.trim() : null
  if (title === "") return reject("title-required", "标题不能为空（Nothing was written）", pre.path)
  if (check === "") {
    return reject("check-required", "必须写清「怎么算完成」（check）——写不出完成判据的任务是愿望，不是任务（Nothing was written）", pre.path)
  }
  if (input.priority !== undefined && input.priority !== null && !Number.isFinite(input.priority)) {
    return reject("field-invalid", "priority 必须是数字（Nothing was written）", pre.path)
  }
  const secret = firstSecretHit([["title", title], ["check", check], ["why", why]])
  if (secret) {
    return reject("secret-suspected",
      "疑似凭据形态（族=" + secret.label + "，字段=" + secret.field + "）——**拒写，不是打码**：请改写该句后重试（Nothing was written）", pre.path)
  }
  const file = { version: LEDGER_SCHEMA_VERSION, rev: pre.file.rev + 1, tasks: [...pre.file.tasks] }
  let max = 0
  for (const t of file.tasks) max = Math.max(max, taskNumber(t.id))
  const id = "t-" + (max + 1)
  // 归属：建单方会话 id（**取不到就是 null** —— 不编造）。`owner` 此后**只能**经 `applyTaskClaim` 变。
  const creator = sessionIdOf(input.sessionId)
  file.tasks.push({
    id,
    kind,
    title,
    status: "待办",
    check,
    evidence: null,
    blockedReason: null,
    blockedBy: null,
    priority: Number.isFinite(input.priority) ? input.priority : 0,
    why,
    createdAt: nowIso(),
    doneAt: null,
    createdBy: creator,
    owner: creator,
    claimedFrom: null,
  })
  const done = commit(file, pre.path)
  return done.ok ? ok({ id, rev: file.rev, status: "待办", owner: creator, path: pre.path }) : done
}

/**
 * 改单（FR-3）。可改字段面 = **闭集** `UPDATABLE_FIELDS`；命中不可改字段 ⇒ **拒**（不是静默忽略）。
 * @post 标题非空 · check 非空 · 凭据形态拒 · 成功 ⇒ rev+1 · 任何拒绝 ⇒ 零写入
 */
export function applyTaskUpdate(ws, input = {}) {
  const pre = preflight(ws, input.expectedRev)
  if (pre.rejected) return pre.rejected
  const id = typeof input.id === "string" ? input.id.trim() : ""
  const idx = pre.file.tasks.findIndex((t) => t.id === id)
  if (idx < 0) return reject("id-missing", "台账里没有 " + JSON.stringify(id) + " 这一条（Nothing was written）", pre.path)
  const patch = input.patch && typeof input.patch === "object" && !Array.isArray(input.patch) ? input.patch : null
  if (patch === null) return reject("no-fields", "patch 必须是对象（Nothing was written）", pre.path)
  const keys = Object.keys(patch)
  if (keys.length === 0) return reject("no-fields", "patch 是空的：没有要改的字段（Nothing was written）", pre.path)
  const bad = keys.filter((k) => !UPDATABLE_FIELDS.includes(k))
  if (bad.length > 0) {
    const ro = bad.filter((k) => READONLY_FIELDS.includes(k))
    return reject("field-not-updatable",
      "以下字段不可改：" + bad.join(" / ")
      + (ro.length > 0
        ? "（" + ro.join(" / ") + " 属只读面：`status` 只能走 task_done / 状态迁移门，`evidence` 与 `blockedReason`/`blockedBy` 只能由那次迁移写入）"
        : "")
      + "。可改字段闭集 = " + UPDATABLE_FIELDS.join(" / ") + "（Nothing was written）", pre.path)
  }
  const cur = pre.file.tasks[idx]
  const next = { ...cur }
  const str = (v) => (typeof v === "string" ? v.trim() : null)
  if ("title" in patch) {
    const v = str(patch.title)
    if (v === null || v === "") return reject("title-required", "标题不能为空（Nothing was written）", pre.path)
    next.title = v
  }
  if ("check" in patch) {
    const v = str(patch.check)
    if (v === null || v === "") return reject("check-required", "「怎么算完成」不能为空（Nothing was written）", pre.path)
    next.check = v
  }
  if ("why" in patch) {
    if (patch.why === null || patch.why === "") next.why = null
    else {
      const v = str(patch.why)
      if (v === null || v === "") return reject("field-invalid", "why 必须是字符串或 null（Nothing was written）", pre.path)
      next.why = v
    }
  }
  if ("priority" in patch) {
    if (!Number.isFinite(patch.priority)) return reject("field-invalid", "priority 必须是数字（Nothing was written）", pre.path)
    next.priority = patch.priority
  }
  const secret = firstSecretHit([["title", next.title], ["check", next.check], ["why", next.why]])
  if (secret) {
    return reject("secret-suspected",
      "疑似凭据形态（族=" + secret.label + "，字段=" + secret.field + "）——**拒写，不是打码**（Nothing was written）", pre.path)
  }
  const file = { version: LEDGER_SCHEMA_VERSION, rev: pre.file.rev + 1, tasks: pre.file.tasks.map((t, i) => (i === idx ? next : t)) }
  const done = commit(file, pre.path)
  return done.ok ? ok({ id, rev: file.rev, path: pre.path }) : done
}

/**
 * 状态迁移（FR-1 **唯一写门**）。
 * @post 校验次序（与设计档 §6 逐条对齐，**先算后写**）：
 *   rev 冲突 → id 不存在 → `to` 合法 → 迁移表 → 完成需凭据 → 卡住需 reason+blockedBy → 凭据形态
 *   → 成功：rev+1 / 写 doneAt / 清或写卡住字段 → 原子替换
 * @post **任何拒绝路径文件字节不变**
 * @post **归属三字段不受影响**（`createdBy` / `owner` / `claimedFrom` 原样带过 —— 状态迁移**不**改归属；
 *       改归属只有 `applyTaskClaim` 一条路）
 *
 * ★ 两处设计档未明写、本实现定死的语义 —— **已登记**（登记点见下，不是「只在报告里说说」）：
 *   ① 离开「卡住」⇒ 清 `blockedReason`/`blockedBy`（否则板面会给在做的任务显示陈旧卡住原因）；
 *   ② 离开「完成」⇒ 清 `doneAt`（同上理由）。
 *   ⇒ 登记点 = `docs/2026-10-16-task-ledger-design.md` **§15.2**（含 file:line 与理由）+ `CHANGELOG.md`
 *     批 36 条目的诚实清单（两处同批写入；设计档 §十五 是实施期发现面的登记表）。
 *   `evidence` **不清空**（设计档 §6 明文：「完成 可重开（但完成时留下的 evidence 不清空）」）。
 */
export function applyTaskTransition(ws, input = {}) {
  const pre = preflight(ws, input.expectedRev)
  if (pre.rejected) return pre.rejected
  const id = typeof input.id === "string" ? input.id.trim() : ""
  const idx = pre.file.tasks.findIndex((t) => t.id === id)
  if (idx < 0) return reject("id-missing", "台账里没有 " + JSON.stringify(id) + " 这一条（Nothing was written）", pre.path)
  const cur = pre.file.tasks[idx]
  const to = typeof input.to === "string" ? input.to.trim() : ""
  if (!TASK_STATUSES.includes(to)) {
    return reject("status-invalid", "目标状态必须是 " + TASK_STATUSES.join("/") + "（Nothing was written）", pre.path)
  }
  const allowed = ALLOWED_MIGRATIONS[cur.status] ?? []
  if (!allowed.includes(to)) {
    return reject("illegal-migration",
      "非法迁移：" + cur.status + " → " + to + "（" + cur.status + " 只允许 → " + (allowed.join(" / ") || "（终态）")
      + "）（Nothing was written）", pre.path)
  }
  const evidence = typeof input.evidence === "string" ? input.evidence.trim() : ""
  const reason = typeof input.reason === "string" ? input.reason.trim() : ""
  const blockedBy = typeof input.blockedBy === "string" ? input.blockedBy.trim() : ""
  if (to === "完成" && evidence === "") {
    return reject("evidence-required",
      "完成必须留凭据（evidence）："
      + (cur.kind === "decision"
        ? "决策项的凭据 = **结论是什么 + 谁拍的**（例：「等批 R 落地后再提 —— 用户 2026-10-17 拍板」）"
        : "写下「跑了什么、看到什么」")
      + "（Nothing was written）", pre.path)
  }
  if (to === "卡住" && reason === "") {
    return reject("reason-required", "标「卡住」必须写原因（reason）——卡住却不说是最需要显眼的信息（Nothing was written）", pre.path)
  }
  if (to === "卡住" && !BLOCKED_BY_VALUES.includes(blockedBy)) {
    return reject("blockedby-required",
      "标「卡住」必须区分 blockedBy=external（等外部）或 self（等自己动手）（Nothing was written）", pre.path)
  }
  const secret = firstSecretHit([["evidence", evidence], ["reason", reason]])
  if (secret) {
    return reject("secret-suspected",
      "疑似凭据形态（族=" + secret.label + "，字段=" + secret.field + "）——**拒写，不是打码**：台账不记凭据值（T-10 / N-7）（Nothing was written）", pre.path)
  }
  const next = { ...cur, status: to }
  if (to === "完成") {
    next.evidence = evidence
    next.doneAt = nowIso()
    next.blockedReason = null
    next.blockedBy = null
  } else {
    if (cur.status === "完成") next.doneAt = null // 重开：清完成时刻（evidence 保留——设计档 §6 明文）
    if (to === "卡住") {
      next.blockedReason = reason
      next.blockedBy = blockedBy
    } else {
      next.blockedReason = null
      next.blockedBy = null
    }
  }
  const file = { version: LEDGER_SCHEMA_VERSION, rev: pre.file.rev + 1, tasks: pre.file.tasks.map((t, i) => (i === idx ? next : t)) }
  const done = commit(file, pre.path)
  return done.ok ? ok({ id, rev: file.rev, status: to, path: pre.path }) : done
}

/**
 * **接手**（批 36-补 · 设计档 §16.2 的交接动作）：把 `owner` 改成接手方会话，并记下 `claimedFrom`。
 *
 * @post **只改两个字段**：`owner` = 接手方会话 id · `claimedFrom` = 旧 owner（可能为 `null`）。
 *       `status` / `evidence` / `blockedReason` / `blockedBy` / `doneAt` / `createdBy` **逐字不变**
 *       ⇒ 凭据门、五态迁移表、rev 门全部原封不动（腿 T-16）。
 * @post 走**同一道写门**：rev 冲突 / 条目不存在 / 台账畸形 / 无接手方会话 id ⇒ **拒且零写入**。
 * @post 成功 ⇒ rev+1（与其它写动作同款；交接也是一次真实写，不能白改 rev 让并发检测失效）。
 *
 * ★ 为什么「无接手方会话 id ⇒ 拒」而不是落 `null`：建单时落 `null` 是**诚实**（那台机器真的不知道
 *   会话是谁）；接手时落 `null` 则是**静默把归属抹掉**——用户点一下「接手」反而变成「没人管」。
 *   ⇒ 缺 id 一律 `owner-required` 拒（不编造，也不吞掉旧的 owner）。
 */
export function applyTaskClaim(ws, input = {}) {
  const pre = preflight(ws, input.expectedRev)
  if (pre.rejected) return pre.rejected
  const id = typeof input.id === "string" ? input.id.trim() : ""
  const idx = pre.file.tasks.findIndex((t) => t.id === id)
  if (idx < 0) return reject("id-missing", "台账里没有 " + JSON.stringify(id) + " 这一条（Nothing was written）", pre.path)
  const nextOwner = sessionIdOf(input.sessionId)
  if (nextOwner === null) {
    return reject("owner-required",
      "接手必须知道**接手方会话 id**（本会话没有可用的 session id）——归属不能凭空写，**没有写入任何内容**", pre.path)
  }
  const cur = pre.file.tasks[idx]
  const prevOwner = ownerOf(cur)
  const next = { ...cur, owner: nextOwner, claimedFrom: prevOwner }
  const file = { version: LEDGER_SCHEMA_VERSION, rev: pre.file.rev + 1, tasks: pre.file.tasks.map((t, i) => (i === idx ? next : t)) }
  const done = commit(file, pre.path)
  return done.ok
    ? ok({ id, rev: file.rev, status: cur.status, owner: nextOwner, claimedFrom: prevOwner, path: pre.path })
    : done
}

/** ISO 时刻（仅**写门**使用；注入摘要与看板渲染一律不碰时间——腿 T-5）。 */
function nowIso() {
  return new Date().toISOString()
}

// ————————————— FR-4 同源注入摘要（纯确定性 · 有界 · 空集不出段） —————————————

/** 摘要默认字符预算（沿用批 34 注入行的 `LINE_MAX_CHARS = 512` 同款量级；精确 N 已在实施期标定，见 U-4）。 */
export const DIGEST_MAX_CHARS = 512
/** 活任务默认展示条数（Top-N；决策项**全列**——它们是用户最需要看见的）。 */
export const DIGEST_TOP_N = 5
/** 摘要首行标记（稳定可 grep）。 */
export const DIGEST_HEAD = "[thincoder 任务台账]"

const STATUS_TAG = (t) => (t.status === "卡住" && t.blockedBy ? t.status + "/" + (t.blockedBy === "external" ? "等外部" : "等自己动手") : t.status)

/**
 * **同源注入摘要**（FR-4；并入既有 `systemPrompt.context` 那一行——**不新开通道**）。
 * @pre 无
 * @post **纯确定性**：同 `view` + 同 `opts` ⇒ **逐字节相同**；禁时间戳 / 百分比 / 步数 / 随机
 * @post **全序**：排序键 = ① priority 降序 ② id 数值升序 ③ createdAt 升序（`readTasksView` 已排好）
 * @post 策略 = 决策项全列 + 活任务 Top-N + 卡住 Top-N + 完成只给计数
 * @post 超预算 ⇒ 以 `…还有 N 项` 收尾（**有界，不是截断半句**）
 * @post `view` 为空 / `opts.mode === "off"` ⇒ 返回**空串**（该段不出现）
 * @post 任何内部异常 ⇒ 空串（fail-open：注入面绝不影响回合）
 */
export function renderTaskDigest(view, opts) {
  try {
    const o = opts && typeof opts === "object" ? opts : {}
    if (o.mode === "off") return ""
    const maxChars = Number.isInteger(o.maxChars) && o.maxChars >= 80 ? o.maxChars : DIGEST_MAX_CHARS
    const topN = Number.isInteger(o.topN) && o.topN >= 0 ? o.topN : DIGEST_TOP_N
    const v = view && typeof view === "object" ? view : null
    if (!v || !Array.isArray(v.tasks) || v.tasks.length === 0) return ""

    const decisions = Array.isArray(v.decisions) ? v.decisions : []
    const blocked = Array.isArray(v.blocked) ? v.blocked : []
    const active = Array.isArray(v.active) ? v.active : []
    const done = Array.isArray(v.done) ? v.done : []

    const head = DIGEST_HEAD + " rev=" + String(v.rev ?? 0)
      + "｜待你决策 " + decisions.length
      + "·在做 " + active.length
      + "·卡住 " + blocked.length
      + "·完成 " + done.length
    const safeHead = "…还有 N 项" // 尾部预留（N 占位，定型时再替换）

    // 候选行（**顺序即优先级**：决策 → 卡住 → 活任务），每行自带 id 与状态 ⇒ 腿 T-4b 可逐条比对
    const candidates = []
    for (const t of decisions) candidates.push({ id: t.id, line: "◆ " + t.id + "[" + STATUS_TAG(t) + "] " + oneLine(t.title) })
    for (const t of blocked) candidates.push({ id: t.id, line: "▲ " + t.id + "[" + STATUS_TAG(t) + "] " + oneLine(t.title) + (t.blockedReason ? "（" + oneLine(t.blockedReason) + "）" : "") })
    for (const t of active.slice(0, topN)) candidates.push({ id: t.id, line: "■ " + t.id + "[" + STATUS_TAG(t) + "] " + oneLine(t.title) })

    const lines = []
    const listed = new Set()
    // ★ 2026-10-17 **交付评审 #2 修**：原先「…还有 N 项」拿**全账本**当分母（`v.tasks.length`），
    //   而 `done` 永远不会进 candidates（策略 = 完成只给计数，首行已报「完成 N」）⇒
    //   **同一批完成项被二次报成"还有"**（极端例：全完成的账本会输出「完成 3 …还有 3 项」）。
    //   ⇒ 分母改成「**可列出而未列出**」= candidates 总数 − 已列出数（完成项不在 candidates 里，天然不被计入）。
    const listable = candidates.length
    for (const c of candidates) {
      const pending = listable - (listed.size + 1)
      const tail = pending > 0 ? "\n…还有 " + pending + " 项" : ""
      const attempt = head + "\n" + [...lines, c.line].join("\n") + tail
      if (attempt.length <= maxChars) {
        lines.push(c.line)
        listed.add(c.id)
      } else {
        break
      }
    }
    // 预算兜底：连首行都放不下（极端：maxChars 很小 / 标题极长）⇒ 只留首行与尾行，必要时安全截断
    if (lines.length === 0) {
      const pending = listable
      const tail = pending > 0 ? "…还有 " + pending + " 项" : ""
      const attempt = head + (tail === "" ? "" : "\n" + tail)
      if (attempt.length <= maxChars) return attempt
      // ★ 评审 #2 第二处：尾行实际长度随 N 的位数变（`…还有 3 项` 6 字符 vs `…还有 10 项` 7 字符），
      //   原先按 7 字符固定预留 ⇒ 两位数时可能超出预算 1 字符。改为**按实际尾行长度**预留。
      const reserve = tail === "" ? 0 : tail.length + 1
      return cutText(head, Math.max(0, maxChars - reserve)) + (tail === "" ? "" : "\n" + tail)
    }
    const rest = listable - listed.size
    const tail = rest > 0 ? ["…还有 " + rest + " 项"] : []
    return [head, ...lines, ...tail].join("\n")
  } catch {
    return "" // fail-open：摘要面任何异常都不贡献上下文
  }
}

/** 单行化（摘要是单行一条；换行/多余空白折叠，防把结构撑坏）。 */
function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim()
}

/**
 * 按 **码点** 截断并加省略号（与批 34 的 `cut` 同口径：JS 的 `slice` 是 UTF-16 单元语义，
 * 直接切会把代理对切成半个字符）。
 */
function cutText(t, n) {
  const s = String(t ?? "")
  if (n <= 0) return ""
  const chars = Array.from(s)
  if (chars.length <= n) return s
  return chars.slice(0, Math.max(0, n - 1)).join("") + "…"
}

// ————————————— 台账配置解析（ledger.mode / 文档路径清单 / 话术模板） —————————————
//
// 配置面落点（实施第一步实测，见交付报告）：本仓配置读写集中在 **`lib/config-store.mjs`**
// （`loadUserConfig` / `mergeGlobalConfig` 白名单 / `saveUserConfig`）与 **`lib/index.mjs`**
// （`validateGlobalUserConfig` 的 PUT 校验 + `makeApiHandler` 路由）。解析链（含默认值与归一化）
// 归本模块 —— 它是台账域的一部分，三面（看板 / 工具 / 注入）共用同一份归一结果。

/** `ledger.mode` 闭集（需求-D7 / FR-9）：默认 `standalone`。 */
export const LEDGER_MODES = Object.freeze(["off", "standalone"])
/**
 * 结构化文档路径清单上限（防把整仓 md 都塞进来当看板数据源）。
 * ★ **安全型扩张**（设计档 §十四 / §九 均未写它，由实施期定死）⇒ **已登记**设计档 **§15.2**
 *   （行内带 file:line 与理由，as-of 2026-10-17）。语义**两面不同朝向**：
 *   · 读面 `resolveLedgerConfig` ⇒ 超限**截断**到上限（fail-open，看板照常出）；
 *   · 写面 `isValidDocPathList`（配置 PUT 的校验器，见 `lib/index.mjs`）⇒ 超限**拒**（fail-closed）。
 */
export const MAX_DOC_PATHS = 8
/** 默认复制话术模板（需求-D10：默认带「说人话大白话，说清楚前因后果，给建议」，且**可配置**）。 */
export const DEFAULT_COPY_TEMPLATE = "说人话大白话，说清楚前因后果，给建议。"

/** `ledger.mode` 合法性。 */
export function isValidLedgerMode(v) {
  return typeof v === "string" && LEDGER_MODES.includes(v)
}

/** 复制话术模板合法性（非空字符串且长度有界）。 */
export function isValidCopyTemplate(v) {
  return typeof v === "string" && v.trim() !== "" && v.length <= 500
}

/**
 * 结构化文档路径清单合法性（字符串数组、每项非空、**去重后** ≤ MAX_DOC_PATHS）。
 * @pre  `v` 任意值 —— 本函数是**纯函数、不抛**（非数组 ⇒ false；非字符串元素 ⇒ false）
 * @post 判上限读的是 `String(p).trim()` **去重后**的条数（批 42 ④）：重复项不再吃配额，
 *       但上限**没有放宽**（9 个互异项仍拒）
 * @post `String()` 强转**只用于算去重**（非字符串元素不得因强转变成合法项 —— 合法性仍要求
 *       每一项**本身**是非空字符串）
 */
export function isValidDocPathList(v) {
  if (!Array.isArray(v)) return false
  const uniq = [...new Set(v.map((p) => String(p).trim()).filter((s) => s !== ""))]
  if (uniq.length > MAX_DOC_PATHS) return false
  return v.every((p) => typeof p === "string" && p.trim() !== "")
}

/**
 * 归一 `ledger` 配置（**三面共用的唯一解析点**）。
 * @post 恒返回 `{mode, docPaths, copyTemplate}`：非法值一律**回落默认**（读面 fail-open；
 *       写面（PUT）另有严格校验，不依赖本函数的宽容）
 */
export function resolveLedgerConfig(rawGlobal) {
  const g = rawGlobal && typeof rawGlobal === "object" && !Array.isArray(rawGlobal) ? rawGlobal : {}
  const raw = g.ledger && typeof g.ledger === "object" && !Array.isArray(g.ledger) ? g.ledger : {}
  const mode = isValidLedgerMode(raw.mode) ? raw.mode : "standalone"
  const docPaths = Array.isArray(raw.docPaths)
    ? raw.docPaths.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim()).slice(0, MAX_DOC_PATHS)
    : []
  const copyTemplate = isValidCopyTemplate(raw.copyTemplate) ? raw.copyTemplate.trim() : DEFAULT_COPY_TEMPLATE
  return { mode, docPaths, copyTemplate }
}

// ————————————— FR-8 结构化文档只读源（`parseChecklistDoc`） —————————————
//
// 设计档 §六：**列数 < 4 ∨ 无状态列 ⇒ 返回 `null`**（不猜、不部分解析）——靠猜列名解析自由文本
// 必然产出假读数（设计-D10）。本函数**只读**：不写回、不改文档、不缓存。
// 状态枚举只认设计档钉死的那五个（大小写不敏感）：TODO / DOING / BLOCKED / PASS / FAIL。
// 「验收五件齐没齐」是**存在性判读**：某件的列存在且该行该格非空 ⇒ 该件齐（缺列或缺格 ⇒ 不齐）。

/** 状态枚举（设计档 §六钉死的五个；大小写不敏感）。 */
export const CHECK_STATUSES = Object.freeze(["TODO", "DOING", "BLOCKED", "PASS", "FAIL"])
/** 验收五件的键（命令 / 预期 / 实际 / 证据 / 基线身份）。 */
export const CHECK_PIECES = Object.freeze(["command", "expected", "actual", "evidence", "baseline"])

/** 表头归一（去装饰字符与空白；只看列名本身）。 */
const headerNorm = (s) => String(s ?? "").replace(/[*`\s]/g, "").trim()
/** 状态列候选（**先精确后包含**：精确匹配能躲开「根因状态（含证据）」这类复合列名）。 */
const STATUS_EXACT = /^(状态|status|state)$/i
const STATUS_LOOSE = /(状态|status)/i
/** 五件的列名前缀表（`证据` 能配 `证据（必填）`，但配不上 `根因状态（含证据）`）。 */
const PIECE_HEADERS = Object.freeze({
  command: ["命令", "command", "check", "自检"],
  expected: ["预期", "expected"],
  actual: ["实际", "actual"],
  evidence: ["证据", "evidence"],
  baseline: ["基线", "baseline"],
})

/** 一行的单元格切分（`| a | b |` ⇒ `["a","b"]`）。 */
const cellsOf = (line) => String(line).trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
/** 分隔线（`|---|---|` / `|:--|--:|`）。 */
const isSeparator = (line) => /^\|[\s:|-]+\|$/.test(String(line).trim())

/**
 * 解析「验收表」式的结构化文档（FR-8 / US-10）。
 * @pre  `text` = 整份文档文本（只读）
 * @post 找到**第一张**满足「≥4 列 ∧ 含状态列」的表格 ⇒ 返回
 *       `{ columns, rows, counts, tableIndex }`；**没有任何一张满足 ⇒ 返回 `null`**（不猜、不部分解析）
 * @post 每行：`{ id, title, status, rawStatus, cells, pieces }`——`status` 只取那五个枚举之一，
 *       其它一律 `null`（诚实：不认识的写法**不猜**），`pieces` = 五件的存在性判读
 * @post **不可写**：本函数不产生任何副作用（零写盘、零缓存）
 */
export function parseChecklistDoc(text) {
  const src = typeof text === "string" ? text : ""
  if (src === "") return null
  const lines = src.split(/\r?\n/)
  let block = []
  const blocks = []
  for (const line of lines) {
    if (String(line).trim().startsWith("|")) block.push(line)
    else if (block.length > 0) { blocks.push(block); block = [] }
  }
  if (block.length > 0) blocks.push(block)

  for (let bi = 0; bi < blocks.length; bi++) {
    const rows = blocks[bi]
    if (rows.length < 2) continue
    const columns = cellsOf(rows[0])
    if (columns.length < 4) continue
    if (!isSeparator(rows[1])) continue
    let si = columns.findIndex((c) => STATUS_EXACT.test(headerNorm(c)))
    if (si < 0) si = columns.findIndex((c) => STATUS_LOOSE.test(headerNorm(c)))
    if (si < 0) continue // 没有可识别的状态列 ⇒ 这张表不算（继续找下一张；全都不算 ⇒ null）
    const pieceCols = {}
    for (const key of CHECK_PIECES) {
      const keys = PIECE_HEADERS[key]
      pieceCols[key] = columns.findIndex((c) => {
        const h = headerNorm(c).toLowerCase()
        return keys.some((k) => h.startsWith(k.toLowerCase()))
      })
    }
    const counts = { TODO: 0, DOING: 0, BLOCKED: 0, PASS: 0, FAIL: 0, UNKNOWN: 0, total: 0 }
    const outRows = []
    for (const raw of rows.slice(2)) {
      const cells = cellsOf(raw)
      if (cells.every((c) => c === "")) continue
      const rawStatus = cells[si] ?? ""
      // 单元格式：去装饰字符（`*` / 反引号）后取**首个词**，大写后比对枚举。
      // 认不出来 ⇒ `status = null` + `counts.UNKNOWN`（**不猜**：长句状态列如实记为未识别）。
      const token = rawStatus.replace(/[*`]/g, "").trim().split(/\s+/)[0]?.toUpperCase() ?? ""
      const status = CHECK_STATUSES.includes(token) ? token : null
      counts[status ?? "UNKNOWN"]++
      counts.total++
      const pieces = {}
      for (const key of CHECK_PIECES) {
        const idx = pieceCols[key]
        const cell = idx >= 0 ? (cells[idx] ?? "") : ""
        pieces[key] = idx >= 0 && cell.replace(/[*`\s]/g, "") !== "" && !/^[-—]+$/.test(cell.replace(/[*`\s]/g, ""))
      }
      outRows.push({
        id: cells[0] ?? "",
        title: cells[1] ?? "",
        status,
        rawStatus,
        cells,
        pieces,
        piecesComplete: CHECK_PIECES.every((k) => pieces[k]),
      })
    }
    return { columns, rows: outRows, counts, tableIndex: bi, statusColumn: si }
  }
  return null
}
