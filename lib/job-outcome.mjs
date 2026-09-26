// job-outcome.mjs — D-46（0.1.7 作业输出契约）的**单点收口** ⊕ D-45（批 26：报告全文自持落盘）
// ⊕ 批 27（US-1 清扫/轮转 · US-2 非法 pathForm 可见 · US-5 cwdHint 透传）。
//
// 为什么要单独一个模块：0.1.7 的 settle 面不再读 job.output —— 模型可见正文改由**输出环**承载
// （生产者侧唯一入口 = `handle.append(text)`），而 job 只写 `job.result = outcome.result`；
// 0.1.6/rc.1 读的仍是 `outcome.output`/job.output。四处派发（advisor · consult · eng ·
// escalate）共七处 jobs.start，若各自手写「append + 双字段」，一次契约变更就要改七处、
// 漏一处即**静默丢报告正文**（不报错、读得到状态行、正文却空）⇒ 收口到本函数一处。
//
// 为什么 `result` 与 `output` 同值只是**别名**（不是两套契约）：两者承载的是**同一段正文**，
// 写两处只为让两代运行时都读得到（设计档 §3.1.3 / 决策 D25-1）；一旦确认部署运行时版本可对齐，
// `output` 一行可整体删除而无需触碰任何调用点。
//
// 为什么 `handle` 走**可选链**（`handle?.append?.`）：旧运行时的 `spec.run()` **无参**（不传
// handle）。缺它时必须静默跳过而不是抛——0.1.6 上的一次抛错会把整个派发变成故障，那比不写环更糟
// （决策 D25-2）。`append` 本身也走可选链：宿主只保证 0.1.7 的 handle 形状，防御性写法零成本。
//
// 入参 `outcome` 仍以 `output` 为**正文的承载字段**（调用方照旧只写 `output`，不写两处）。
//
// ————————————— 批 26 / D-45：全文自持落盘（`$DSH_HOME/.thincoder/jobs/<jobId>.txt`） —————————————
// 为什么落盘也放收口点（D26-1）：job_output 的读取面不在本仓且实测会崩（平台自产作业同错）——
// 派发侧唯一能自保的位置就是「正文必然流经的这一个函数」；放各派发点则四档 28 处都要重复。
// 为什么 **只 warn 不抛、不改 outcome**（D26-2）：落盘是兜底，兜底不得成为新的失败源——
// 写盘故障若上抛，会把一个已成功的作业结算翻转成 failed（比不落盘更糟）。
// 为什么 jobId 自取 `handle?.id`（D26-7）：0.1.7 的 handle 自带 id；旧运行时不传 handle
// ⇒ 无 id ⇒ 不落盘（兼容代价，如实写明）。不做 28 处调用点透传。
// 为什么 `index.jsonl` 用单行 JSON + append 追加、不做锁：多会话共用 DSH_HOME 时并发追加，
// 单行小写入的追加语义（O_APPEND）足够——写入侧 append-only 语义批 27 不变；重写侧（清扫）
// 接受「窗口内他方行可能永久丢于索引」这一并发边界，**不做行合成**（见 sweepJobReports）。
// 作业**永不结算**（宿主硬死）⇒ 没有终态就没有正文 ⇒ 不落盘（无 handle 调用即该形态）。
//
// ————————————— 批 27 / US-1：清扫与轮转（sweepJobReports，D27-1…D27-3） —————————————
// 落盘目录只增不减是批 26 明确划出的边界，批 27 收干：双重上限（maxAgeDays=7 防长期、
// maxFiles=200 防突发，D27-2）+ `index.jsonl` 同步重写。三条纪律：
// ① **只清自己的**（D27-3）：清扫面钉死正则 `/^(advisor|consult|eng|escalate)-[A-Za-z0-9._-]+\.txt$/`
//   ——平台 kind（`pwsh-*` 等）与任何其它文件**永不触碰**（A27-3 的负控正是它）；副作用 =
//   「他形态产物（如一次性 smoke）需人工清」，可接受并如实写明（批 27 设计档 §1⑥）。
//   `index.jsonl` 本身是本插件自己的索引（设计 §2.1 明文的同步重写对象，不在该正则辖域）；
//   分歧修复 D3+D6：其原子写复用 `lib/dsh-home.mjs` 的 `writeFileAtomic`（单一事实源），陈旧
//   tmp 的清理随该 helper 既有 `.<基名>.tmp-`/`.del-` 前缀孤儿清扫（龄 ≥ 10min，D20-10）——
//   本模块**不再**手写任何 tmp 循环（首版的手写 `.index.jsonl.tmp-*` 清理与「只处理四类 kind
//   命中文件」的声明相左，已删，描述面与实现自此逐字一致）。
// ② **尽力而为**（D27-1）：每次 persist 成功后触发一次；任何失败只 warn，绝不向上抛——
//   清扫是兜底，兜底不得成为新的失败源（与 D26-2 同一条纪律）。
// ③ **并发边界如实接受（§2.1）**：共享 DSH_HOME 的其它会话在重写窗口内追加的行可能永久
//   丢于索引（正文文件仍在磁盘上，丢的只是追溯元数据）；**不做行合成**——`{at, bytes,
//   pathForm}` 无法从文件本身还原，凭文件合成只会伪造 `pathForm`（违反批 26 §2.1「记录
//   实际携带正文的通道」那条契约）。不引入锁。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pickDshHome, writeFileAtomic } from "./dsh-home.mjs"

/**
 * pathForm 的**钉死枚举**（批 26 设计档 §2.1 评审 #8）：记录本次报告正文是从哪条路径产出/在哪可读。
 * - `result`：0.1.7 的 `job.result`（eng / escalate 的正文只此一份可读处）
 * - `ring`：输出环（0.1.7 生产契约通道；本收口点的正文总是先经 append 入环，保留枚举位以备
 *   「只入环、不落 result」的将来形态）
 * - `session-state`：advisor 的 `session-state.lastAdvisorOutput`（评审正文另存一份在该处）
 * - `consult-minutes`：会诊纪要文件（digest 落档在纪要原始层）
 * - `none`：无正文（空报告——文件照写、内容为空串，AC 判据是「文件存在」）
 */
export const PATH_FORMS = Object.freeze(["result", "ring", "session-state", "consult-minutes", "none"])

/** home 不可解析时的告警去重（进程内一次即可——每个作业 settle 都喊一遍只是噪声）。 */
let warnedNoHome = false

/** 平台 branded job id = `<kind>-N`：kind 直接从 id 前缀取（平台契约要点 #1）。 */
function kindOf(jobId) {
  return jobId.replace(/-\d+$/, "")
}

/** 文件名只留安全字符（jobId 来自平台，防御性收窄防路径穿越；index.jsonl 里保留原值）。 */
function safeId(jobId) {
  return jobId.replace(/[^A-Za-z0-9._-]/g, "_")
}

/**
 * 把正文落盘 + 追加追溯行。**全程 try → console.warn**（D26-2）：任何失败只留痕，绝不向上抛。
 * @param {string} jobId 平台 branded job id（handle.id）
 * @param {string} text 报告正文（空串也写文件）
 * @param {string} pathForm PATH_FORMS 之一
 * @param {string|undefined} dshHomeOverride 测试注入缝（语义 = DSH_HOME 目录，对齐各 store 先例）
 * @param {string|undefined} cwdHint 会话 cwd（批 27 / US-5：透传给 pickDshHome 作探测基座；
 *   缺省 undefined ⇒ 行为与批 26 逐字一致）
 * @returns {boolean} 是否落盘成功（清扫触发时机用——失败不触发，D27-1）
 */
function persistJobReport(jobId, text, pathForm, dshHomeOverride, cwdHint) {
  try {
    const home = pickDshHome(dshHomeOverride, cwdHint)
    if (typeof home !== "string" || home === "") {
      if (!warnedNoHome) {
        warnedNoHome = true
        console.warn("[thincoder-suite] job 报告落盘跳过：DSH_HOME 不可解析——job_output 之外暂无第二可读路径（D-45 兜底未生效）")
      }
      return false
    }
    const dir = join(home, ".thincoder", "jobs")
    mkdirSync(dir, { recursive: true })
    // 空报告也写文件（批 26 §2.1.2：AC 判据是「文件存在」）；直写即可（撞名 = 后写覆盖，§2.1.6）
    writeFileSync(join(dir, safeId(jobId) + ".txt"), text, "utf8")
    const line = JSON.stringify({ jobId, kind: kindOf(jobId), at: Date.now(), bytes: Buffer.byteLength(text, "utf8"), pathForm })
    appendFileSync(join(dir, "index.jsonl"), line + "\n", "utf8")
    return true
  } catch (e) {
    console.warn("[thincoder-suite] job 报告落盘失败（只 warn 不抛，作业终态不变——D26-2）：" + (e && e.message ? e.message : String(e)))
    return false
  }
}

/**
 * 清扫面**钉死**（批 27 设计档 §2.1 评审 #1）：只认本插件四条机制自己派发的作业文件——
 * 平台 kind（`pwsh-*` 等）与任何其它文件**永不触碰**（D27-3 / A27-3 负控）。
 */
const SWEEPABLE_JOB_FILE = /^(advisor|consult|eng|escalate)-[A-Za-z0-9._-]+\.txt$/

/**
 * 批 27 / US-1：作业报告目录的**清扫/轮转**（D27-1…D27-3）。先按 mtime 删超龄、再按条数从旧
 * 到新截断（双重上限，D27-2）；随后把 `index.jsonl` 同步重写为**仍存在的文件**对应行——原子写
 * 复用 `lib/dsh-home.mjs` 的 `writeFileAtomic`（同目录 tmp + rename 原子替换 + 成功后自带陈旧
 * tmp 孤儿清扫，D6/D20-10）。只处理 SWEEPABLE_JOB_FILE 命中的文件；home 不可解析/目录不可读
 * ⇒ 静默返回 null（调用点在 persist 成功之后，此时的不可解析只可能是测试注入形态，不值得 warn）。
 * @param {{maxAgeDays?: number, maxFiles?: number, dshHomeOverride?: string, cwdHint?: string}} [opts]
 *   maxAgeDays：超龄阈值（天，默认 7）· maxFiles：保留条数上限（默认 200）·
 *   dshHomeOverride/cwdHint：与 persistJobReport 同源的注入缝（测试定向临时目录）。
 * @returns {{deletedAge: number, deletedCount: number, kept: number, indexRewritten: boolean}|null}
 *   尽力而为的清扫摘要；静默形态返回 null。
 */
export function sweepJobReports(opts) {
  const o = opts && typeof opts === "object" ? opts : {}
  try {
    const maxAgeDays = Number.isFinite(o.maxAgeDays) && o.maxAgeDays >= 0 ? o.maxAgeDays : 7
    const maxFiles = Number.isInteger(o.maxFiles) && o.maxFiles >= 0 ? o.maxFiles : 200
    const home = pickDshHome(o.dshHomeOverride, o.cwdHint)
    if (typeof home !== "string" || home === "") return null
    const dir = join(home, ".thincoder", "jobs")
    let names
    try { names = readdirSync(dir) } catch { return null }
    const cutoff = Date.now() - maxAgeDays * 86400000
    const survivors = []
    let deletedAge = 0
    let deletedCount = 0
    for (const name of names) {
      if (!SWEEPABLE_JOB_FILE.test(name)) continue // 平台 kind（pwsh-* 等）与任何其它文件永不触碰（D27-3）
      let mtimeMs
      try { mtimeMs = statSync(join(dir, name)).mtimeMs } catch { continue }
      if (mtimeMs <= cutoff) {
        try { unlinkSync(join(dir, name)); deletedAge++; continue }
        catch { /* 删不掉（目录/占用）⇒ 视为仍在盘：进保留面，索引行也保留 */ }
      }
      survivors.push({ name, mtimeMs })
    }
    const kept = []
    if (survivors.length > maxFiles) {
      survivors.sort((a, b) => b.mtimeMs - a.mtimeMs) // 从新到旧
      for (let i = 0; i < survivors.length; i++) {
        if (i < maxFiles) { kept.push(survivors[i].name); continue }
        try { unlinkSync(join(dir, survivors[i].name)); deletedCount++ }
        catch { kept.push(survivors[i].name) } // 截断删失败 ⇒ 同样视为仍在盘
      }
    } else {
      for (const s of survivors) kept.push(s.name)
    }
    // index.jsonl 同步重写 = 只留「文件仍存在」的行（§2.1：解析不了的行不对应可证明存在的
    // 文件 ⇒ 丢弃；**不做行合成**——凭文件合成 {at,bytes,pathForm} 只会伪造 pathForm）。
    const indexPath = join(dir, "index.jsonl")
    let prior = null
    try { prior = readFileSync(indexPath, "utf8") } catch { prior = null }
    const deletions = deletedAge + deletedCount
    if (prior === null && deletions === 0) {
      // 零删除且无索引 ⇒ 不凭空造索引
      return { deletedAge, deletedCount, kept: kept.length, indexRewritten: false }
    }
    const keptRows = []
    if (prior !== null) {
      for (const raw of prior.split("\n")) {
        const line = raw.trim()
        if (line === "") continue
        let row = null
        try { row = JSON.parse(line) } catch { row = null }
        if (row && typeof row.jobId === "string" && row.jobId !== ""
          && existsSync(join(dir, safeId(row.jobId) + ".txt"))) keptRows.push(line)
      }
    }
    // 原子替换复用单一事实源（D6）：writeFileAtomic = 同目录 tmp + rename 原子替换（§2.1）+
    // 有界重试 + 成功后孤儿清扫（陈旧 `.index.jsonl.tmp-*` 残留随成功写自清——D20-10 语义）；
    // 失败向上抛，由本函数外层 try 收敛为 warn（D27-1 兜底语义不变）。
    writeFileAtomic(indexPath, keptRows.length > 0 ? keptRows.join("\n") + "\n" : "")
    return { deletedAge, deletedCount, kept: kept.length, indexRewritten: true }
  } catch (e) {
    console.warn("[thincoder-suite] job 报告清扫失败（尽力而为，只 warn 不抛——D27-1）：" + (e && e.message ? e.message : String(e)))
    return null
  }
}

/**
 * 把「生产者 outcome」收口成 0.1.7 + 0.1.6 双可读形态，把正文写进输出环，并把全文落盘
 * （`$DSH_HOME/.thincoder/jobs/<jobId>.txt` + `index.jsonl` 追加一行——D-45）；落盘成功后
 * 尽力而为触发一次清扫（批 27 / US-1 · D27-1）。
 * @param {{id?: string, append?: (text: string, options?: object) => void}|null|undefined} handle 平台传给 `spec.run(handle)` 的句柄（旧运行时为 undefined ⇒ 不落盘）
 * @param {{output?: unknown, [k: string]: unknown}} outcome 生产者结算信封（`output` = 正文）
 * @param {{pathForm?: string, dshHomeOverride?: string, cwdHint?: string}} [opts]
 *   pathForm：advisor 传 "session-state"、consult 传 "consult-minutes"（批 26 §2.1.4）；**显式
 *   传入枚举外的值 ⇒ warn 一行（列出合法值）后按正文推断，不抛**（批 27 / US-2）；缺省（未传）
 *   按正文推断（空串 ⇒ "none"，其余 ⇒ "result"）。dshHomeOverride：测试注入缝。cwdHint：会话
 *   cwd（批 27 / US-5 · D27-4，四档派发点传 `agent.session?.header?.cwd`；可选，缺省行为逐字不变）。
 * @returns {object} 同一信封 + `result`（= output 的同值别名）——落盘不改 outcome（D26-2）
 */
export function jobOutcome(handle, outcome, opts) {
  const text = typeof outcome?.output === "string" ? outcome.output : String(outcome?.output ?? "")
  handle?.append?.(text)                      // 0.1.7：正文必须经 handle.append 进输出环
  const jobId = handle?.id
  if (typeof jobId === "string" && jobId !== "") {
    const given = opts?.pathForm
    let pathForm
    if (PATH_FORMS.includes(given)) {
      pathForm = given
    } else {
      // 批 27 / US-2（A27-6）：显式传入的非法 pathForm 不再静默回落——warn 一行（列合法值）、
      // 不抛（维持 D26-2），写入的仍是合法枚举值（按正文推断）。未传（undefined）不是非法。
      if (given !== undefined) {
        console.warn("[thincoder-suite] job 报告落盘：非法 pathForm " + String(given)
          + "——忽略并按正文推断（合法值：" + PATH_FORMS.join(" | ") + "）")
      }
      pathForm = text === "" ? "none" : "result"
    }
    if (persistJobReport(jobId, text, pathForm, opts?.dshHomeOverride, opts?.cwdHint)) {
      // 批 27 / US-1（D27-1）：persist 成功后尽力而为清扫一次——失败只 warn，绝不抛。
      try {
        sweepJobReports({ dshHomeOverride: opts?.dshHomeOverride, cwdHint: opts?.cwdHint })
      } catch (e) {
        console.warn("[thincoder-suite] job 报告清扫触发失败（尽力而为——D27-1）：" + (e && e.message ? e.message : String(e)))
      }
    }
  }
  return { ...outcome, result: text }   // result=0.1.7 读的字段；output 留给 0.1.6/rc.1，同值别名
  // 注：result 取**与 append 同源的 text**（不是 outcome.output 的原值）——退化输入（漏写 output / 传非字符串）下
  // 「同值别名」依然成立，否则 job.result 可能是 undefined 而环里已写空串（交付评审 🔵4）。
}
