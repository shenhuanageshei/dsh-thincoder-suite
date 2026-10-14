// anti-drift.mjs — 批 34「长任务防漂」机制本体（设计档 docs/2026-10-14-anti-drift-design.md）。
//
// 设计令牌：9c126ca2-…（轮次 4 `VERDICT: PASS`，有效至 2026-10-21）。
// 本档是**单点收口**：判据存储 / 每步注入渲染 / 三闸（判据门 · 完成门 · 推回）/ 行为标记 /
// 开工接管摘要 全在此；index.mjs 只做注册与接线（零机制逻辑）。
//
// —— 三条纪律（照抄设计档，实施时不得走样）——
// ① **三域分离**（§7）：落章域（跨回合跨重启）· 回合域（进程内，回合前进复位）·
//    会话域（进程内，跨回合存活）。**每个标记恰好属一域**——出现在两行即 D3 同族的清单不一致。
// ② **失败朝向**（D10）：判据门 / 完成门 / 台账门 **fail-closed**（读不到状态 ⇒ 拒）；
//    注入 / 推回 / 接管 **fail-open**（任何异常 ⇒ 不注入 / 不推回 / 优雅降级）。
//    理由：硬门挡的是"假完成"这类不可逆损失；软面挡不住只是少一层提醒，绝不该让会话崩。
// ③ **绝不抛**：`agent/turn-stopping` 的监听器抛错会把回合变成 `{kind:'error'}`
//    （`contract-regressions.spec.ts:346-363`）；`agent/created` 是 serial 且被 await，
//    抛错会让**创建失败**（`runtime-types.ts:252-255`）⇒ 两个监听器体内全包 try/catch。

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { writeFileAtomic } from "./dsh-home.mjs"
import { isProductCodePath } from "./path-kind.mjs"

// ═══════════════════════════ 一、配置面（FR-8） ═══════════════════════════

/** 连续相同调用达到几次才提醒（**默认 3**，即「第三次做同一件事」；≤0 ⇒ 关该机制）。
 *  ⚠️ 必须**声明在 `ANTI_DRIFT_DEFAULTS` 之前**：默认值对象在模块求值时读它，
 *  放在后面会命中 TDZ（`Cannot access 'STALL_REPEAT_THRESHOLD' before initialization`）。 */
export const STALL_REPEAT_THRESHOLD = 3

/**
 * 六键默认值（**用户 2026-10-14 拍板**：按打扰度分档，不是按机制）。
 * 判据：会改变回合命运的才默认关；只是"多说一句"的默认开。
 * `caps` 只有**三个族键**——没有 `total`（见 `turnSteerHardMax` 的语义注）。
 */
export const ANTI_DRIFT_DEFAULTS = Object.freeze({
  inject: true,               // 每步注入行——低打扰、且是本设计的可见性本体
  completeGate: true,         // 完成门——封闭门，只在"宣告完成"那一刻生效
  pushback: false,            // 回合推回——唯一会阻止模型结束回合的机制
  verifyHeuristic: true,      // shell 命令形启发（只喂推回谓词）
  caps: Object.freeze({ pending: 1, verify: 2, advisor: 3 }),
  stallRepeat: STALL_REPEAT_THRESHOLD, // 停滞检测阈值（0 ⇒ 关该机制）
  ledgerTransitionGate: false, // FR-7 台账写门（team-link 侧读自己的配置）
})

/** caps 子键的闭集（**三族**；腿 A-14） */
export const CAPS_SUBKEYS = Object.freeze(["pending", "verify", "advisor"])
const CAPS_FAMILY_MAX = 6

/** 合法键名闭集（`anti_drift_config` 的键名门；腿 A-13/A-14 + 停滞阈值） */
export const ANTI_DRIFT_KEYS = Object.freeze([
  "inject", "completeGate", "pushback", "verifyHeuristic", "caps", "ledgerTransitionGate", "stallRepeat",
])

/**
 * 会话级诚实句封顶（设计档 FR-4；腿 A-11）
 */
export const SESSION_HONESTY_MAX = 3

/**
 * 单回合 steer 硬上限的**唯一记账**（评审轮 4 🟡1 的矛盾在此终结）：
 *   三族各族有自己的上限 ⇒ 族推回 ≤ `pending + verify + advisor`（默认 **6**）；
 *   诚实句占**其后的第 1 条** ⇒ 硬上限 = **Σ族 + 1**（默认 **7**）。
 * 两个性质同时成立，缺一则记账又自相矛盾：
 *   ① 「三族各自恰好推满」（A-4 的断言）永远可达；
 *   ② 「用尽后仍有 1 条诚实句」（FR-4 的后置）永远可达。
 * 历史教训（勿回退）：曾引入 `caps.total` 作为"族预算"，而默认 `total = Σ族` ⇒
 * 诚实句**永不可达**；若让 `total > Σ族` 又与三族上限语义重叠。故**只留三族上限**。
 */
export const turnSteerHardMax = (caps) => caps.pending + caps.verify + caps.advisor + 1

/**
 * 从插件配置里取 `antiDrift` 段并填默认值（缺省 ⇒ 默认，**不做部分校验**）。
 * `caps` 非法 ⇒ **整段回落默认 caps**（fail-safe 到保守值，不是整段关机制）。
 */
export function resolveAntiDriftConfig(rawConfig) {
  const g = rawConfig && typeof rawConfig === "object" ? rawConfig : {}
  const a = g.antiDrift && typeof g.antiDrift === "object" ? g.antiDrift : {}
  const d = ANTI_DRIFT_DEFAULTS
  const bool = (v, dv) => (typeof v === "boolean" ? v : dv)
  const capsOk = validateCaps(a.caps)
  return {
    inject: bool(a.inject, d.inject),
    completeGate: bool(a.completeGate, d.completeGate),
    pushback: bool(a.pushback, d.pushback),
    verifyHeuristic: bool(a.verifyHeuristic, d.verifyHeuristic),
    caps: capsOk.ok ? { ...capsOk.value } : { ...d.caps },
    // 停滞阈值：非负整数才收（0/负数 ⇒ 关该机制）；非法 ⇒ 回落默认
    stallRepeat: Number.isInteger(a.stallRepeat) && a.stallRepeat >= 0 ? a.stallRepeat : d.stallRepeat,
    ledgerTransitionGate: bool(a.ledgerTransitionGate, d.ledgerTransitionGate),
  }
}

/**
 * `caps` 校验（腿 A-14）：**三族键**各为 0–6 的整数，**全部必填**，**不接受额外子键**。
 * ⚠️ 为什么没有 `total`（**本记账的唯一事实源**，勿再加回）：
 *   轮 4 🟡1 曾把记账写成「三族之和 = 6 ⇒ 用尽后第 6 条给诚实句」，与 A-4
 *   「三族各恰好推满 1/2/3」**数学互斥**（1+2+3+1 = 7 ≠ 6）。若保留一个 `total` 域：
 *     · `total ≤ Σ族` ⇒ 诚实句**永不可达**（族预算先耗尽）⇒ 轮 4 的矛盾原地复活；
 *     · `total > Σ族` ⇒ 它就成了第二套族预算，与三族上限**语义重叠**、徒增歧义。
 *   ⇒ 定案：**只有三族上限**；诚实句占**其后的第 1 条**。见 `turnSteerHardMax`。
 */
export function validateCaps(v) {
  if (v === undefined || v === null) return { ok: false, reason: "caps 缺失" }
  if (typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "caps 必须是对象" }
  const unknown = Object.keys(v).filter((k) => !CAPS_SUBKEYS.includes(k))
  if (unknown.length > 0) {
    return { ok: false, reason: "caps 未知子键：" + unknown.join(", ") + "（合法子键：" + CAPS_SUBKEYS.join(" / ") + "）" }
  }
  const out = {}
  for (const k of CAPS_SUBKEYS) {
    const n = v[k]
    if (n === undefined) return { ok: false, reason: "caps." + k + " 必填（三族上限一个都不能少）" }
    if (!Number.isInteger(n)) return { ok: false, reason: "caps." + k + " 必须是整数" }
    if (n < 0 || n > CAPS_FAMILY_MAX) return { ok: false, reason: "caps." + k + " 必须在 0.." + CAPS_FAMILY_MAX }
    out[k] = n
  }
  return { ok: true, value: out }
}

/** `anti_drift_config` 的单键写入校验（键名闭集 + 取值类型；未知键 ⇒ 拒，零写）。 */
export function validateConfigWrite(key, value) {
  if (!ANTI_DRIFT_KEYS.includes(key)) {
    return { ok: false, reason: "未知键 " + JSON.stringify(key) + "；合法键名：" + ANTI_DRIFT_KEYS.join(" / ") }
  }
  if (key === "caps") {
    const r = validateCaps(value)
    if (!r.ok) return r
    return { ok: true, value: r.value }
  }
  if (key === "stallRepeat") {
    if (!Number.isInteger(value) || value < 0 || value > 20) {
      return { ok: false, reason: "stallRepeat 必须是 0..20 的整数（0 ⇒ 关闭停滞检测）" }
    }
    return { ok: true, value }
  }
  if (typeof value !== "boolean") return { ok: false, reason: key + " 必须是布尔值" }
  return { ok: true, value }
}

// ═══════════════════════════ 二、判据存储（FR-1 / FR-2） ═══════════════════════════

const CRITERIA_FILE = "goal-criteria.json"
const CRITERIA_VERSION = 1
const VERIFY_RECORD_MAX = 20

/** 会话键（与 state.mjs 的 keyOf 同口径——一处漏了就会泄漏一份状态）。 */
const keyOf = (id) => String(id ?? "default")

/** 进程内待绑槽（**仅内存态，绝不落盘**——设计档 §7 的 schema 注）。 */
const pendingSlots = new Map()

/** 会话键 → 宿主 goalId（建目标时绑定；用于把 goalId 键控的记录映射回会话）。 */
const boundGoalId = new Map()

export function resolveCriteriaStorePath(dshHomeOverride, cwdHint) {
  const home = dshHomeOverride || process.env.DSH_HOME || cwdHint
  return join(home, CRITERIA_FILE)
}

/** 读盘（**任何异常 ⇒ 空表**，绝不抛——注入面 fail-open 的读法）。 */
export function readCriteriaStore(dshHomeOverride, cwdHint) {
  try {
    const raw = readFileSync(resolveCriteriaStorePath(dshHomeOverride, cwdHint), "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return { version: CRITERIA_VERSION, goals: {} }
    const goals = parsed.goals && typeof parsed.goals === "object" ? parsed.goals : {}
    return { version: CRITERIA_VERSION, goals }
  } catch {
    return { version: CRITERIA_VERSION, goals: {} }
  }
}

function writeCriteriaStore(store, dshHomeOverride, cwdHint) {
  // 只写盘上有的形态：`{version, goals}`——`pending` **不进文件**（设计档 §7）。
  writeFileAtomic(
    resolveCriteriaStorePath(dshHomeOverride, cwdHint),
    JSON.stringify({ version: CRITERIA_VERSION, goals: store.goals }, null, 2) + "\n",
  )
}

/**
 * `goal_criteria set` 的形状门（**只判"写了"，不判语义**——语义归评审，见 L-6/F-1）。
 * @returns {{ok:true, shape:"pending"|"bound", goalId:string|null} | {ok:false, reason:string}}
 */
export function setCriteria({ sessionId, criteria, check, goalId, hostHasGoal, dshHomeOverride, cwdHint }) {
  const c = String(criteria ?? "").trim()
  const k = String(check ?? "").trim()
  if (c === "") return { ok: false, reason: "criteria（要达成什么）不可为空" }
  if (k === "") return { ok: false, reason: "check（怎么机检才算达成）不可为空——没有可验证判据的目标是愿望不是目标" }
  const gid = goalId === undefined || goalId === null ? "" : String(goalId).trim()
  if (gid === "") {
    // 待绑槽：建目标前的唯一合法形态
    pendingSlots.set(keyOf(sessionId), { criteria: c, check: k, setAt: new Date().toISOString() })
    return { ok: true, shape: "pending", goalId: null }
  }
  // 显式给了 goal_id ⇒ **该目标必须已存在**（不铸幻影绑定；设计档 FR-1，腿 A-1④）
  if (typeof hostHasGoal === "function" && !hostHasGoal(gid)) {
    return { ok: false, reason: "目标 " + gid + " 不存在（不为一个不存在的目标铸绑定）；若它还没建，省略 goal_id 即写入待绑槽" }
  }
  const store = readCriteriaStore(dshHomeOverride, cwdHint)
  store.goals[gid] = { criteria: c, check: k, setAt: new Date().toISOString() }
  writeCriteriaStore(store, dshHomeOverride, cwdHint)
  boundGoalId.set(keyOf(sessionId), gid)
  return { ok: true, shape: "bound", goalId: gid }
}

/** 取在席记录：优先本会话已绑定的 goalId，其次（无绑定时）返回 pending 槽。 */
export function getCriteria({ sessionId, goalId, dshHomeOverride, cwdHint }) {
  const gid = goalId || boundGoalId.get(keyOf(sessionId)) || null
  if (gid) {
    const rec = readCriteriaStore(dshHomeOverride, cwdHint).goals[gid]
    if (rec) return { shape: "bound", goalId: gid, ...rec }
  }
  const p = pendingSlots.get(keyOf(sessionId))
  if (p) return { shape: "pending", goalId: null, ...p }
  return null
}

/** 本会话是否有在席判据（门与谓词用；`bound` ∨ `pending`）。 */
export function hasCriteria(sessionId, dshHomeOverride, cwdHint) {
  return getCriteria({ sessionId, dshHomeOverride, cwdHint }) !== null
}

/** 该 goalId 是否有 `bound` 记录（**P1 谓词用**——只认 bound，不认 pending）。 */
export function hasBoundCriteria(goalId, dshHomeOverride, cwdHint) {
  if (!goalId) return false
  return Boolean(readCriteriaStore(dshHomeOverride, cwdHint).goals[String(goalId)])
}

/** `create_goal` 成功后把待绑槽提升为 `bound`（设计档 FR-1；由 tools/post-execute 调）。 */
export function promotePending({ sessionId, goalId, dshHomeOverride, cwdHint }) {
  const key = keyOf(sessionId)
  const p = pendingSlots.get(key)
  if (!p) return { promoted: false }
  const store = readCriteriaStore(dshHomeOverride, cwdHint)
  store.goals[String(goalId)] = { criteria: p.criteria, check: p.check, setAt: p.setAt }
  writeCriteriaStore(store, dshHomeOverride, cwdHint)
  pendingSlots.delete(key)
  boundGoalId.set(key, String(goalId))
  return { promoted: true, goalId: String(goalId) }
}

export function clearCriteria({ sessionId, goalId, dshHomeOverride, cwdHint }) {
  const key = keyOf(sessionId)
  let cleared = []
  const gid = goalId || boundGoalId.get(key)
  if (gid) {
    const store = readCriteriaStore(dshHomeOverride, cwdHint)
    if (store.goals[gid]) {
      delete store.goals[gid]
      writeCriteriaStore(store, dshHomeOverride, cwdHint)
      cleared.push(gid)
    }
    if (boundGoalId.get(key) === gid) boundGoalId.delete(key)
  }
  if (pendingSlots.delete(key)) cleared.push("pending")
  return { cleared }
}

/** 会话销毁时的内存清理（**落章域的盘上记录不删**——它随目标存活）。 */
export function dropCriteriaSession(sessionId) {
  const key = keyOf(sessionId)
  pendingSlots.delete(key)
  boundGoalId.delete(key)
}

// —— 验证记录薄（FR-2）——

const verifyRecords = new Map() // sessionKey → [{proofRef, command, status, summary, at}]

/** 裁决判据：**大小写不敏感**（协议输出 `VERDICT: PASS`，内部标记 `pass`；轮 3 🟡6）。 */
export const PASS_VERDICT_RE = /^VERDICT:\s*pass$/i

/**
 * `goal_verify`（设计档 FR-2）。
 * @returns {{ok:true, record:object} | {ok:false, reason:string}}
 */
export function recordVerify({ sessionId, proofRef, command, status, summary, dshHomeOverride, cwdHint }) {
  const pr = String(proofRef ?? "").trim()
  if (pr === "") return { ok: false, reason: "proofRef 不可为空（= 在席 bound 记录的 goalId）" }
  if (!["passed", "failed", "skipped"].includes(status)) {
    return { ok: false, reason: "status 必须是 passed / failed / skipped" }
  }
  // ★ 必须把 home/cwd **转发**给 getCriteria：否则它读的是**默认 store**，
  //   在注入 override 的场景（测试夹具 / 非默认 home）下会读到**另一份记录** ⇒ 判据对不上。
  //   （这是一处真实的签名缺口：生产调用点不传 override，故默认 home 下恰好一致、**长期无人发现**；
  //    但"参数不转发"本身就是错，且会让下一个写夹具的人踩坑。）
  const cur = getCriteria({ sessionId, dshHomeOverride, cwdHint })
  const sum = String(summary ?? "").trim()
  // —— 两条 lawful 路径（解 L-11：此前**只有**第一条，导致"旧目标无逃生路"）——
  //   ① **有 bound 记录**：`proofRef` 必须**就是**那个在席 goalId（防转录错、防冒名）。
  //   ② **无 bound 记录**（本插件装配前就存在的旧目标）：**接受任意非空 `proofRef`，但强制要 `summary`**。
  //      为什么强制 summary：`proofRef` 在这里没法被核对（没有可比对的记录）⇒ 若再允许空 summary，
  //      这条路径就变成"随便写一个号就能落章"的**无凭据盖章**。要一句人话说明"验的是什么"，
  //      是这条宽松路径的**最低代价**，也让台账可读。
  //      ★ 这一条与 `gateDecision` 里 `!cur` 分支的注释**意图对齐**（"只判落章域，不因缺判据拒旧目标"）：
  //        此前那句承诺**半兑现**——它允许旧目标走到 complete，却没有允许旧目标**落章**。
  if (cur && cur.shape === "bound") {
    if (cur.goalId !== pr) {
      return { ok: false, reason: "proofRef " + JSON.stringify(pr) + " 与在席 bound 记录（" + JSON.stringify(cur.goalId) + "）不符（记录不存在 / 已清 / 不是它）——先确认目标与判据" }
    }
  } else if (sum === "") {
    return { ok: false, reason: "没有在席 bound 判据记录（旧目标）⇒ 这条路径必须给 summary 说明「你验的是什么」，否则就是无凭据盖章（proofRef=" + JSON.stringify(pr) + " 无法被核对）" }
  }
  if (status === "skipped" && sum === "") {
    return { ok: false, reason: "status=skipped 必须给 summary 说明为什么可以不跑" }
  }
  const key = keyOf(sessionId)
  const arr = verifyRecords.get(key) ?? []
  const rec = { proofRef: pr, command: String(command ?? ""), status, summary: sum, at: new Date().toISOString() }
  arr.push(rec)
  while (arr.length > VERIFY_RECORD_MAX) arr.shift() // 滚动上限 20
  verifyRecords.set(key, arr)
  return { ok: true, record: rec }
}

export function listVerify(sessionId) {
  return [...(verifyRecords.get(keyOf(sessionId)) ?? [])]
}

/** 某 proofRef 是否有 `passed` 记录（完成门用）。 */
export function hasPassed(sessionId, proofRef) {
  return listVerify(sessionId).some((r) => r.proofRef === proofRef && r.status === "passed")
}

// ═══════════════════════════ 三、行为标记（FR-5）与三域状态 ═══════════════════════════

/**
 * 三域状态（设计档 §7；**每个标记恰好属一域**——腿 A-15 的结构锁）：
 *   落章域 stamp：codeMutatedSinceStamp / verifiedSinceStamp / advisorSinceStamp / touchedFiles
 *   回合域 turn ：turn / pending / verify / advisor / steerTotal / honestySent / mutatedThisTurn / verifyRanThisTurn
 *   会话域 sess ：honestyCount / silenceWarned / handoffSent
 */
const domains = new Map() // sessionKey → {stamp, turn, sess}

export function domainState(sessionId) {
  const key = keyOf(sessionId)
  let d = domains.get(key)
  if (!d) {
    d = {
      stamp: { codeMutatedSinceStamp: false, verifiedSinceStamp: false, advisorSinceStamp: false, touchedFiles: [] },
      turn: {
        turn: null, pending: 0, verify: 0, advisor: 0, steerTotal: 0, honestySent: false,
        mutatedThisTurn: false, verifyRanThisTurn: false,
        // 停滞检测（回合域：连续相同调用与"本回合已提醒过"都随回合归零）
        lastToolSig: null, repeatCount: 0, stallNoticed: false,
      },
      sess: { honestyCount: 0, silenceWarned: false, handoffSent: false },
    }
    domains.set(key, d)
  }
  return d
}

/** 惰性回合比较（**不依赖任何未经核实的回合事件名**——设计档 FR-4 的回合边界判据）。 */
export function advanceTurn(sessionId, turn) {
  const d = domainState(sessionId)
  if (d.turn.turn !== turn) {
    d.turn.turn = turn
    d.turn.pending = 0
    d.turn.verify = 0
    d.turn.advisor = 0
    d.turn.steerTotal = 0
    d.turn.honestySent = false
    d.turn.mutatedThisTurn = false
    d.turn.verifyRanThisTurn = false
    // 停滞检测同属回合域：连续计数与"已提醒过"闩都随回合归零
    d.turn.lastToolSig = null
    d.turn.repeatCount = 0
    d.turn.stallNoticed = false
    return true // 本回合首次进入
  }
  return false
}

export function dropDomainSession(sessionId) {
  domains.delete(keyOf(sessionId))
  verifyRecords.delete(keyOf(sessionId))
}

/** 一次合格落章：清落章域（设计档 FR-2/FR-5）。`advisor` 与 `goal_verify passed` 共用。 */
export function stampVerified(sessionId, { byAdvisor = false } = {}) {
  const d = domainState(sessionId)
  d.stamp.verifiedSinceStamp = true
  d.stamp.codeMutatedSinceStamp = false
  d.stamp.touchedFiles = []
  if (byAdvisor) d.stamp.advisorSinceStamp = true
  return d.stamp
}

/** 写类工具命中（`tools/post-execute`）。返回本次是否算产品代码改动。 */
export function noteWrite(sessionId, filePath, touchedBy) {
  const d = domainState(sessionId)
  d.turn.mutatedThisTurn = true
  d.turn.verifyRanThisTurn = false
  const p = String(filePath ?? "")
  if (p && !d.stamp.touchedFiles.includes(p)) {
    d.stamp.touchedFiles.push(p)
    while (d.stamp.touchedFiles.length > 200) d.stamp.touchedFiles.shift()
  }
  const product = isProductCodePath(p)
  if (product) d.stamp.codeMutatedSinceStamp = true
  return { productCode: product, by: touchedBy ?? null }
}

/** shell 类工具命中：命令形匹配 ⇒ 记"这一轮跑过检查"（可单独关）。 */
export const VERIFY_CMD_RE = /test|build|check|typecheck|lint/i
export function noteShell(sessionId, command, verifyHeuristic) {
  if (!verifyHeuristic) return false
  if (!VERIFY_CMD_RE.test(String(command ?? ""))) return false
  domainState(sessionId).turn.verifyRanThisTurn = true
  return true
}

/** 产品代码改动的文件清单（≤3，给 steer 文案点名用）。 */
export function productFilesOf(sessionId) {
  const d = domainState(sessionId)
  return d.stamp.touchedFiles.filter((p) => isProductCodePath(p)).slice(-3)
}

// ═══════════ 三-b、停滞检测（连续 N 次**完全相同**的工具调用；夜班补做 · 吸收清单第 8 项） ═══════════
//
// 为什么算「停滞」而不是「重复」：同一工具 + 同一份参数**连续**再来第三遍，多半是模型在
// 死循环刷步数（读同一个文件、跑同一条命令、重复同一个搜索），而不是在推进任务。
//
// ★ 四条边界（都是刻意收窄，避免误伤）：
//   ① **只在同一回合内累积**（回合域），回合前进即归零——跨回合的"又读了一次"不算停滞；
//   ② **同一次调用只记一次**（由 `tools/post-execute` 在 `next()` 之后调用一次）；
//   ③ 触发后**每回合至多一条提醒**（`stallNoticed` 回合域闩）——这是提醒，**不是拦**，绝不 steer；
//   ④ 参数序列化**剔除易变字段**（signal/timeout/requestId/id/index/seq）并**键排序**，否则
//      同一次调用会因为时间戳或序号不同而永远"不同"，此机制将永不触发（= 恒真断言那一族）。
// ★ `STALL_REPEAT_THRESHOLD` 的声明**在文件上方**（`ANTI_DRIFT_DEFAULTS` 之前）——此处不重复声明。

/**
 * 记一次工具调用并判定是否停滞。
 * @returns {{stalled:boolean, count:number, signature:string|null}}
 */
export function noteToolCall(sessionId, toolName, args, threshold = STALL_REPEAT_THRESHOLD) {
  const d = domainState(sessionId)
  const t = Number(threshold)
  if (!Number.isFinite(t) || t <= 0) return { stalled: false, count: 0, signature: null }
  const sig = signatureOf(toolName, args)
  if (sig === null) return { stalled: false, count: 0, signature: null }
  if (d.turn.lastToolSig === sig) d.turn.repeatCount += 1
  else { d.turn.lastToolSig = sig; d.turn.repeatCount = 1 }
  return { stalled: d.turn.repeatCount >= t, count: d.turn.repeatCount, signature: sig }
}

/** 调用签名 = `工具名|稳定序列化参数`；空工具名 ⇒ null（不参与判定）。 */
function signatureOf(toolName, args) {
  const n = String(toolName ?? "").trim()
  if (n === "") return null
  return n + "|" + stableStringify(args)
}

/** 稳定序列化：键排序 + 剔除易变字段（见上方边界④）。 */
function stableStringify(v) {
  try {
    const drop = new Set(["signal", "timeout", "timeoutMs", "requestId", "id", "index", "seq"])
    const walk = (x) => {
      if (x === null || typeof x !== "object") return x
      if (Array.isArray(x)) return x.map(walk)
      const out = {}
      for (const k of Object.keys(x).sort()) if (!drop.has(k)) out[k] = walk(x[k])
      return out
    }
    const s = JSON.stringify(walk(v ?? null))
    return s.length > 2000 ? s.slice(0, 2000) : s
  } catch { return "(unserializable)" }
}

/** 停滞提醒的固定文案（**确定性**：同一 count 产出同一句，便于断言）。 */
export function stallNotice(toolName, count) {
  return "停滞提醒：你已经连续 " + count + " 次做了**完全相同**的调用（`" + String(toolName ?? "?")
    + "`）。同一输入重复再多遍也不会得到不同结果——换一个输入（读别的文件/换参数/换个工具），"
    + "或先说明为什么它值得重试。"
}

/** 本回合是否已就停滞提醒过（回合域闩；提醒每回合至多一条）。返回 true = 本次是首条。 */
export function markStallNoticed(sessionId) {
  const d = domainState(sessionId)
  if (d.turn.stallNoticed) return false
  d.turn.stallNoticed = true
  return true
}

// ═══════════════════════════ 四、完成门（FR-1 判据门 + FR-2 完成门） ═══════════════════════════

/** 门读到的工具名（宿主工具面；`create_goal` / `update_goal` 是宿主 goal 插件注册的）。 */
const CREATE_GOAL = "create_goal"
const UPDATE_GOAL = "update_goal"

/**
 * 门判定（**纯函数**，便于表驱动直调；腿 A-1/A-2/A-3）。
 * @returns {{decision:"allow"} | {decision:"deny", reason:string}}
 */
export function gateDecision({ toolName, args, sessionId, session, config, dshHomeOverride, cwdHint }) {
  const ad = config ?? ANTI_DRIFT_DEFAULTS
  if (!ad.completeGate) return { decision: "allow" }

  if (toolName === CREATE_GOAL) {
    // **唯一条件 = 有待绑槽**（不设"已有 bound 即放行"的旁路——陈旧绑定漏洞；设计档 FR-1）
    const key = keyOf(sessionId)
    const pend = pendingSlots.get(key)
    if (pend) return { decision: "allow" }
    return {
      decision: "deny",
      reason: "拒建目标：没有可验证判据的目标是愿望不是目标。先调 goal_criteria set 写明判据"
        + "（不填 goal_id 即进待绑槽；建目标成功后自动绑定到新目标）。",
    }
  }

  if (toolName === UPDATE_GOAL && String(args?.action ?? "") === "complete") {
    const cur = getCriteria({ sessionId, dshHomeOverride, cwdHint })
    if (!cur) {
      // 无在场记录：可能是本插件装配前就存在的旧目标 ⇒ 只判落章域，不因"缺判据"拒旧目标。
      const d = domainState(sessionId)
      if (d.stamp.codeMutatedSinceStamp && !d.stamp.verifiedSinceStamp) {
        return {
          decision: "deny",
          reason: "拒宣告完成：自上次落章以来有未验证的产品代码改动。先跑判据的检查并通过 ⇒ 调 goal_verify（status=passed）落章。",
        }
      }
      return { decision: "allow" }
    }
    if (cur.shape === "bound") {
      const gid = cur.goalId
      if (!hasPassed(sessionId, gid)) {
        const d = domainState(sessionId)
        // advisor 落章（D-d）与 goal_verify 落章等价；两者都查。
        if (!d.stamp.verifiedSinceStamp) {
          return {
            decision: "deny",
            reason: "拒宣告完成：判据已写明但**没有跑过的证据**。两条合法路径：① 跑 check 里的检查 ⇒ goal_verify(proofRef="
              + gid + ", status=passed)；② 让 advisor 代码评审结算为 pass（等价落章）。",
          }
        }
      }
    }
    const d = domainState(sessionId)
    if (d.stamp.codeMutatedSinceStamp && !d.stamp.verifiedSinceStamp) {
      return {
        decision: "deny",
        reason: "拒宣告完成：自上次落章以来有未验证的产品代码改动（改完代码必须重新验证）。",
      }
    }
    return { decision: "allow" }
  }

  return { decision: "allow" }
}

// ═══════════════════════════ 五、每步注入行（FR-3） ═══════════════════════════

const LINE_MAX_CHARS = 512
// ★ 字段级截断上限（**2026-10-15 夜班第 4 轮实测标定，L-6 的可测那一半**）：
//   原值 64/64 是**设计取值、无实测依据**。实测（见下）证明它**才是真正会咬人的那道闸**：
//     · `LINE_MAX_CHARS = 512` 从不生效 —— 四种真实场景实测行长 **190 / 268 / 190 / 291 / 233**，
//       最长 291，距 512 还差 221 字符**从未被使用**；
//     · 而 64 的字段上限**在真实输入上就会截断**：本会话真实目标 72 字 ⇒ 截、英文长目标 96 字 ⇒ 截、
//       超长 check 102 字 ⇒ 截。**被截掉的往往是句尾的目的/交付物**（例：「…两个仓自主完成吸收清单第 1+2+3…」），
//       恰恰是这一行最该保住的语义。
//   **预算实测**：固定开销 = 审计句 39 + XML 标签与标题 122 + 换行 2 = **163**；
//   最长欠账行 36 ⇒ 留给 objective+check 的可用额度 = **313**。原值只用掉 128 ⇒ **59% 预算闲置**。
//   ⇒ 取 **140**（两字段合计上限 280 ≤ 313，**且给"欠账行 + 标签"留 33 字符安全余量**）；
//   实测四条真实场景在新值下**全部全额**，而 `512` 那道闸照旧兜底（截断阶梯一字未动）。
const OBJ_MAX_CHARS = 140
const CHECK_MAX_CHARS = 140
const AUDIT_SENTENCE =
  "审计句：只有判据的检查实际跑过并通过才算完成——弱证据、计划、摘要都不算完成。"

// ★ 按**码点**截断，不按 UTF-16 单元（2026-10-15 夜班第 6 轮实测的第三个缺陷）：
//   原实现用 `t.length` / `t.slice(0, n)`，而 JS 的这两个都是 **UTF-16 单元**语义 ⇒
//   当截断点落在**代理对中间**时，会切出**孤立代理**（半个 emoji / 半个星平面汉字）。
//   实测：200 个 `🔵` 的目标在 `OBJ_MAX` 处被切开，产出**含孤立代理的字符串**（位置 174），
//   而这段文本**直接进模型上下文**（渲染成乱码/替换字符）⇒ 属"注入面本身携带非法字符"。
//   本仓已有同族先例：批 F 甲的**单行上限按码点计**（`[...text].length`）——此处取同一口径。
const cut = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  const chars = [...t] // 码点数组（`Array.from` / 展开都按码点迭代）
  return chars.length <= n ? t : chars.slice(0, n - 1).join("") + "…"
}

/** 本会话是否已就「回合标识形态异常」告警过（**一次一行**，不刷屏）。 */
const turnShapeWarned = new Set()

/**
 * 从宿主 `agent/turn-stopping` 的载荷里取一个**可稳定比较**的回合标识。
 *
 * ★ 为什么必须规范化（2026-10-15 夜班第 6 轮实测的失败模式，务必别改回去）：
 *   原实现是内联的 `payload?.turn?.index ?? payload?.turn ?? 0`。若宿主把载荷发成
 *   `{ turn: { id: N } }`（`index` 缺席），那个 `??` 的**兜底值就是对象本身**；
 *   而 `advanceTurn` 用 `!==` 比较、对象**身份每次调用都不同** ⇒
 *   `d.turn.turn !== turn` **恒真** ⇒ **每一步都被当成"新回合"** ⇒ 回合域计数器**每步复位**。
 *   实测后果（三条，全都是**静默**的）：
 *     ① 10 步内判定 10 次「新回合」（正常应为 1）；
 *     ② **停滞检测永不触发**（`repeatCount` 每步被清）；
 *     ③ **会话级诚实句封顶（至多 3 句）可被绕过**（`honestySent` 每步复位）。
 *   ——即"名字都在、机制悄悄不工作"，正是本批次要防的那一族。
 *
 * ⇒ 规范化规则（**只接受稳定原语**）：`index` 优先，其次 `id`；两者都不是有限数字
 *   （例如只给了对象/字符串）⇒ 回落 **0（单回合语义）** 并**告警恰一行**。
 *   回落 0 而不是"用对象"：单回合语义下计数**只累积不复位** ⇒
 *   退化的方向是**更严（推回更容易触发）而非更松**，对纪律机制是安全方向。
 *   且形态一旦异常，候选值恒为 0 ⇒ **跨步稳定**，不再每步复位。
 */
export function turnIndexOf(payload, sessionId) {
  const t = payload?.turn
  const cand = (t && typeof t === "object") ? (t.index ?? t.id) : t
  if (Number.isInteger(cand)) return cand
  const key = keyOf(sessionId)
  if (!turnShapeWarned.has(key)) {
    turnShapeWarned.add(key)
    try {
      console.warn("[thincoder-suite] anti-drift：`agent/turn-stopping` 的回合标识形态异常"
        + "（期望 `payload.turn.index` 为整数，实得 " + JSON.stringify(t ?? null)
        + "）⇒ 按**单回合**语义处理（计数只累积、不按回合复位），并只告警这一行。"
        + "机制仍在工作，但「每回合归零」这套语义此时不生效。")
    } catch { /* noop */ }
  }
  return 0
}

/** 会话销毁时清掉形态告警闩（否则长进程里会话累积）。 */
export function dropTurnShapeWarn(sessionId) {
  turnShapeWarned.delete(keyOf(sessionId))
}

/** 未收口欠账（**P1/P2/P3 的谓词，不看 cap**——设计档 FR-4 的步骤 3/4/5 谓词）。 */
export function outstandingDebts({ sessionId, goalId, dshHomeOverride, cwdHint }) {
  const out = []
  // P1：活跃目标存在 ∧ 该目标无 bound 判据
  if (goalId && !hasBoundCriteria(goalId, dshHomeOverride, cwdHint)) out.push("criteriaMissing")
  const d = domainState(sessionId)
  // P2：有未落章的产品代码改动
  if (d.stamp.codeMutatedSinceStamp && !d.stamp.verifiedSinceStamp) out.push("unverified")
  // P3：未评审
  if (d.stamp.codeMutatedSinceStamp && !d.stamp.advisorSinceStamp) out.push("unreviewed")
  return out
}

/**
 * 渲染每步注入行（**纯确定性函数**：禁时间戳/百分比/步数/随机；同输入 ⇒ 同输出）。
 * @returns {string} 空串 = 本步不贡献上下文
 */
export function renderAntiDriftLine({ sessionId, goal, config, dshHomeOverride, cwdHint }) {
  try {
    const ad = config ?? ANTI_DRIFT_DEFAULTS
    if (!ad.inject) return ""
    const goalId = goal?.id ? String(goal.id) : null
    const debts = outstandingDebts({ sessionId, goalId, dshHomeOverride, cwdHint })
    if (!goal && debts.length === 0) return "" // 无活跃目标 ∧ 无欠账 ⇒ 不贡献

    const cur = getCriteria({ sessionId, dshHomeOverride, cwdHint })
    const objective = goal?.objective ? cut(goal.objective, OBJ_MAX_CHARS) : "（无活跃目标）"
    const checkText = cur ? cut(cur.check, CHECK_MAX_CHARS) : "（无判据记录——按纪律应先调 goal_criteria set）"

    const debtLine = debts.length > 0 ? "欠账：" + debts.map(DEBT_LABEL).join(" · ") : null
    // 截断次序：objective → check → 欠账；**审计句永不截断**
    let objPart = "[thincoder 目标]\n<untrusted_objective>" + objective + "</untrusted_objective>"
    let chkPart = "<untrusted_completion_criterion>" + checkText + "</untrusted_completion_criterion>"
    let assemble = (o, c, dl) => [objPart.replace(objective, o), chkPart.replace(checkText, c), dl, AUDIT_SENTENCE]
      .filter((x) => x !== null && x !== undefined).join("\n")
    let text = assemble(objective, checkText, debtLine)
    if (text.length <= LINE_MAX_CHARS) return text

    // ① 先截 objective 到 32，② 再砍欠账行，③ 最后截 check 到 32
    for (const [o, c, dl] of [
      [cut(objective, 32), checkText, debtLine],
      [cut(objective, 32), checkText, null],
      [cut(objective, 32), cut(checkText, 32), null],
      [cut(objective, 16), cut(checkText, 16), null],
      ["（…）", "（…）", null],
    ]) {
      text = assemble(o, c, dl)
      if (text.length <= LINE_MAX_CHARS) return text
    }
    // 兜底：只留审计句（它永不截断）
    return AUDIT_SENTENCE
  } catch {
    return "" // fail-open：注入面任何异常都不贡献、不影响回合
  }
}

const DEBT_LABEL = (k) => ({
  criteriaMissing: "目标缺判据",
  unverified: "有未验证的产品代码改动",
  unreviewed: "有未评审的产品代码改动",
}[k] ?? k)

// ═══════════════════════════ 六、有界推回（FR-4） ═══════════════════════════

const HONESTY_SENTENCE =
  "我改了代码但未完成验证/评审——不要把这一轮当作已完成。"

/** 谓词（按序取第一个未耗尽项）；导出便于表驱动测试（腿 A-4）。 */
export function pickPushback({ sessionId, goalId, config, dshHomeOverride, cwdHint, includeHonesty = false }) {
  const ad = config ?? ANTI_DRIFT_DEFAULTS
  const d = domainState(sessionId)
  const caps = ad.caps
  const famTotal = caps.pending + caps.verify + caps.advisor
  // 族预算 = Σ族（诚实句**不占**它；诚实句有它自己那第 Σ+1 条名额）
  const famRoom = d.turn.steerTotal < famTotal
  // 诚实句名额 = Σ族 + 1（这正是 turnSteerHardMax 的那条；名额用满则整回合静默）
  const honestyRoom = d.turn.steerTotal < famTotal + 1
  // P1：活跃目标存在 ∧ 该目标无 bound 判据
  if (famRoom && goalId && !hasBoundCriteria(goalId, dshHomeOverride, cwdHint) && d.turn.pending < caps.pending) {
    return { kind: "criteriaMissing", text: "这个目标没有判据：先调 goal_criteria set 写明「怎么算完成」，再继续干活。" }
  }
  // P2：有未落章改动 ∧ 本回合没跑过检查（`verifyRanThisTurn` 是"这一轮已跑过 ⇒ 不再催"，见设计档 FR-5）
  if (famRoom && d.stamp.codeMutatedSinceStamp && !d.stamp.verifiedSinceStamp && !d.turn.verifyRanThisTurn
      && d.turn.verify < caps.verify) {
    const files = productFilesOf(sessionId)
    const named = files.length > 0 ? "（" + files.join(" / ") + "）" : ""
    return { kind: "unverified", text: "你改了产品代码" + named + "但没跑判据的检查：跑一遍并通过 ⇒ 调 goal_verify(status=passed) 落章。" }
  }
  // P3：未评审
  if (famRoom && d.stamp.codeMutatedSinceStamp && !d.stamp.advisorSinceStamp && d.turn.advisor < caps.advisor) {
    return { kind: "unreviewed", text: "这批改动还没过代码评审：调 advisor(type=code) 做一轮（第 " + (d.turn.advisor + 1) + " / " + caps.advisor + " 次）。" }
  }
  // 诚实句（**只有完整守卫 `onTurnStopping` 传 true**）：三族已尽（无族项可推）∧ 有诚实名额
  // ∧ 本回合未诚实过 ∧ 会话封顶未到 ∧ **仍有欠账** ⇒ 占第 Σ+1 条。
  // ★ 放在谓词里而不是调用方：三处"已尽"的判定必须与上面**同源**，
  //   否则调用方会各写一份，正是本批被评审连抓两次的"两处描述不同"。
  if (includeHonesty && !pickFamilyAvailable({ d, caps, goalId, dshHomeOverride, cwdHint, verifyRan: d.turn.verifyRanThisTurn })
      && honestyRoom && !d.turn.honestySent
      && d.sess.honestyCount < SESSION_HONESTY_MAX
      && outstandingDebts({ sessionId, goalId, dshHomeOverride, cwdHint }).length > 0) {
    return { kind: "honesty", text: HONESTY_SENTENCE }
  }
  return null
}

/**
 * "还有没有**族**项可推"（不看名额，只看族上限与谓词）——**诚实句的前置**。
 * 与上面三条 P 谓词共用同一次判定形态；抽成函数是为了让"已尽"只有**一处**定义。
 */
function pickFamilyAvailable({ d, caps, goalId, dshHomeOverride, cwdHint, verifyRan }) {
  if (goalId && !hasBoundCriteria(goalId, dshHomeOverride, cwdHint) && d.turn.pending < caps.pending) return true
  if (d.stamp.codeMutatedSinceStamp && !d.stamp.verifiedSinceStamp && !verifyRan && d.turn.verify < caps.verify) return true
  if (d.stamp.codeMutatedSinceStamp && !d.stamp.advisorSinceStamp && d.turn.advisor < caps.advisor) return true
  return false
}

/**
 * `agent/turn-stopping` 监听体（**serial；绝不 throw**）。
 * 单一记账：族推回 ≤ Σ族（各族自有上限）· 诚实句占其后第 1 条 · 硬上限 Σ+1 · 会话封顶 3。
 * @returns {{steer:string|null, warn:string|null, kind:string|null}}
 */
export function onTurnStopping({ sessionId, turn, goalId, config, dshHomeOverride, cwdHint }) {
  const out = { steer: null, warn: null, kind: null }
  try {
    const ad = config ?? ANTI_DRIFT_DEFAULTS
    if (!ad.pushback) return out
    advanceTurn(sessionId, turn)
    const d = domainState(sessionId)
    const hardMax = turnSteerHardMax(ad.caps)

    // 步骤 2：硬上限短路（**诚实句只在它之前那一条名额里发**，故这里用 >= hardMax）
    if (d.turn.steerTotal >= hardMax) {
      if (!d.sess.silenceWarned) {
        d.sess.silenceWarned = true
        out.warn = "[thincoder-suite] anti-drift 推回已达单回合硬上限 " + hardMax + " 条，本回合不再推回。"
      }
      return out
    }

    // 步骤 3-6：一个谓词链（族 1/2/3 → 可选诚实句），四处"已尽"的判定**同源**
    const pick = pickPushback({
      sessionId, goalId, config: ad, dshHomeOverride, cwdHint, includeHonesty: true,
    })
    if (!pick) return out
    if (pick.kind === "criteriaMissing") d.turn.pending += 1
    else if (pick.kind === "unverified") d.turn.verify += 1
    else if (pick.kind === "unreviewed") d.turn.advisor += 1
    d.turn.steerTotal += 1
    out.kind = pick.kind
    out.steer = pick.text

    if (pick.kind === "honesty") {
      d.turn.honestySent = true
      d.sess.honestyCount += 1
      if (d.sess.honestyCount >= SESSION_HONESTY_MAX && !d.sess.silenceWarned) {
        d.sess.silenceWarned = true
        out.warn = "[thincoder-suite] anti-drift 本会话诚实句已达 " + SESSION_HONESTY_MAX
          + " 次，其后整机静默（不再推回，只留每步注入行）。"
      }
    }
    return out
  } catch (e) {
    // fail-open：绝不因内部异常污染回合（否则回合变 {kind:'error'}）
    return { steer: null, warn: "[thincoder-suite] anti-drift 推回内部异常，已跳过：" + (e?.message ?? e), kind: null }
  }
}

// ═══════════════════════════ 七、开工接管摘要（FR-6） ═══════════════════════════

const HANDOFF_SOURCES = new Set(["startup", "resume"])

/**
 * `agent/created` 监听体（**serial 且被 await；绝不 throw**）。
 * @returns {{inject:string|null, reason:string}}
 */
export function onAgentCreated({ sessionId, source, goalId, config, dshHomeOverride, cwdHint }) {
  try {
    const ad = config ?? ANTI_DRIFT_DEFAULTS
    const d = domainState(sessionId)
    if (d.sess.handoffSent) return { inject: null, reason: "已接管过（闩）" }
    if (!HANDOFF_SOURCES.has(String(source ?? ""))) {
      return { inject: null, reason: "source=" + JSON.stringify(source) + " 不在 {startup,resume} ⇒ 零注入" }
    }
    const debts = outstandingDebts({ sessionId, goalId, dshHomeOverride, cwdHint })
    if (debts.length === 0) {
      d.sess.handoffSent = true
      return { inject: null, reason: "无欠账 ⇒ 零注入" }
    }
    if (!ad.inject) {
      d.sess.handoffSent = true
      return { inject: null, reason: "注入面关闭 ⇒ 零注入" }
    }
    const lines = ["[thincoder 开工接管] 本会话有未收口事项："]
    for (const k of debts.slice(0, 3)) lines.push("- " + DEBT_LABEL(k))
    lines.push("补法：目标缺判据 ⇒ goal_criteria set；改完代码 ⇒ 跑检查 + goal_verify；未评审 ⇒ advisor(type=code)。")
    d.sess.handoffSent = true
    return { inject: lines.join("\n"), reason: "已注入" }
  } catch (e) {
    // fail-open：绝不让创建失败（`agent/created` 抛错 ⇒ 创建失败）
    return { inject: null, reason: "内部异常已吞：" + (e?.message ?? e) }
  }
}

// ═══════════════════════════ 八、装配期探测降级（FR-8；腿 A-12） ═══════════════════════════

/**
 * 装配期一次性探测宿主面（设计档 FR-8）。**缺面 ⇒ 该面关闭 + 恰一行 warn**，绝不阻断装配。
 * 四个面与 warn 一一对应：`systemPrompt.context` · `agent/turn-stopping` 可注册面 ·
 * `tools/post-execute` 可注册面 · 宿主 goal 服务。**面与行数必须 1:1**（腿 A-12 钉死）。
 * @returns {{surfaces:{inject:boolean,pushback:boolean,markers:boolean,goals:boolean},
 *            lines:string[], anyMissing:boolean}}
 */
export function probeAntiDriftSurfaces(ctx) {
  const onFn = typeof ctx?.on === "function"
  const surfaces = {
    inject: Boolean(ctx?.systemPrompt?.context),
    // 推回面需要一个**能用的事件名**：`agent/turn-stopping` 是可注册面存在时的首选；
    // 注册被拒（throw）由装配期 try/catch 兜（此处只判面在不在）。
    pushback: onFn,
    markers: onFn,
    goals: Boolean(ctx?.goals?.get),
  }
  const lines = []
  if (!surfaces.inject) {
    lines.push("[thincoder-suite] anti-drift 降级：宿主无 systemPrompt.context ⇒ **注入面关闭**"
      + "（推回面若在仍可用；这正是 US-7 的降级路径）")
  }
  if (!surfaces.pushback) {
    lines.push("[thincoder-suite] anti-drift 降级：无法注册 agent/turn-stopping ⇒ **推回面关闭**"
      + "（注入行仍在场，本回合只是不被拦截）")
  }
  if (!surfaces.markers) {
    lines.push("[thincoder-suite] anti-drift 降级：无法注册 tools/post-execute ⇒ **行为标记面关闭**"
      + "（谓词恒不命中 = 等价关闭，不是崩溃）")
  }
  if (!surfaces.goals) {
    lines.push("[thincoder-suite] anti-drift 降级：宿主 goal 服务缺席 ⇒ **判据/完成门的 goal 部分静默跳过**")
  }
  return { surfaces, lines, anyMissing: lines.length > 0 }
}

// ═══════════════════════════ 九、测试与降级用的复位 ═══════════════════════════

/** 测试夹具用：清空本模块的全部进程内状态（**不碰盘**）。 */
export function __resetAntiDriftState() {
  pendingSlots.clear()
  boundGoalId.clear()
  verifyRecords.clear()
  domains.clear()
}
