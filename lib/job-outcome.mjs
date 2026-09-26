// job-outcome.mjs — D-46（0.1.7 作业输出契约）的**单点收口** ⊕ D-45（批 26：报告全文自持落盘）。
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
// 单行小写入的追加语义（O_APPEND）足够；扫目录/轮转不在本批（D26-9）。
// 作业**永不结算**（宿主硬死）⇒ 没有终态就没有正文 ⇒ 不落盘（无 handle 调用即该形态）。
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pickDshHome } from "./dsh-home.mjs"

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
 */
function persistJobReport(jobId, text, pathForm, dshHomeOverride) {
  try {
    const home = pickDshHome(dshHomeOverride)
    if (typeof home !== "string" || home === "") {
      if (!warnedNoHome) {
        warnedNoHome = true
        console.warn("[thincoder-suite] job 报告落盘跳过：DSH_HOME 不可解析——job_output 之外暂无第二可读路径（D-45 兜底未生效）")
      }
      return
    }
    const dir = join(home, ".thincoder", "jobs")
    mkdirSync(dir, { recursive: true })
    // 空报告也写文件（批 26 §2.1.2：AC 判据是「文件存在」）；直写即可（撞名 = 后写覆盖，§2.1.6）
    writeFileSync(join(dir, safeId(jobId) + ".txt"), text, "utf8")
    const line = JSON.stringify({ jobId, kind: kindOf(jobId), at: Date.now(), bytes: Buffer.byteLength(text, "utf8"), pathForm })
    appendFileSync(join(dir, "index.jsonl"), line + "\n", "utf8")
  } catch (e) {
    console.warn("[thincoder-suite] job 报告落盘失败（只 warn 不抛，作业终态不变——D26-2）：" + (e && e.message ? e.message : String(e)))
  }
}

/**
 * 把「生产者 outcome」收口成 0.1.7 + 0.1.6 双可读形态，把正文写进输出环，并把全文落盘
 * （`$DSH_HOME/.thincoder/jobs/<jobId>.txt` + `index.jsonl` 追加一行——D-45）。
 * @param {{id?: string, append?: (text: string, options?: object) => void}|null|undefined} handle 平台传给 `spec.run(handle)` 的句柄（旧运行时为 undefined ⇒ 不落盘）
 * @param {{output?: unknown, [k: string]: unknown}} outcome 生产者结算信封（`output` = 正文）
 * @param {{pathForm?: string, dshHomeOverride?: string}} [opts]
 *   pathForm：advisor 传 "session-state"、consult 传 "consult-minutes"（批 26 §2.1.4）；缺省按正文推断
 *   （空串 ⇒ "none"，其余 ⇒ "result"）。dshHomeOverride：测试注入缝。
 * @returns {object} 同一信封 + `result`（= output 的同值别名）——落盘不改 outcome（D26-2）
 */
export function jobOutcome(handle, outcome, opts) {
  const text = typeof outcome?.output === "string" ? outcome.output : String(outcome?.output ?? "")
  handle?.append?.(text)                      // 0.1.7：正文必须经 handle.append 进输出环
  const jobId = handle?.id
  if (typeof jobId === "string" && jobId !== "") {
    const given = opts?.pathForm
    const pathForm = PATH_FORMS.includes(given) ? given : (text === "" ? "none" : "result")
    persistJobReport(jobId, text, pathForm, opts?.dshHomeOverride)
  }
  return { ...outcome, result: text }   // result=0.1.7 读的字段；output 留给 0.1.6/rc.1，同值别名
  // 注：result 取**与 append 同源的 text**（不是 outcome.output 的原值）——退化输入（漏写 output / 传非字符串）下
  // 「同值别名」依然成立，否则 job.result 可能是 undefined 而环里已写空串（交付评审 🔵4）。
}
