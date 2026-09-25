// job-outcome.mjs — D-46（0.1.7 作业输出契约）的**单点收口**。
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

/**
 * 把「生产者 outcome」收口成 0.1.7 + 0.1.6 双可读形态，并把正文写进输出环。
 * @param {{append?: (text: string, options?: object) => void}|null|undefined} handle 平台传给 `spec.run(handle)` 的句柄（旧运行时为 undefined）
 * @param {{output?: unknown, [k: string]: unknown}} outcome 生产者结算信封（`output` = 正文）
 * @returns {object} 同一信封 + `result`（= output 的同值别名）
 */
export function jobOutcome(handle, outcome) {
  const text = typeof outcome?.output === "string" ? outcome.output : String(outcome?.output ?? "")
  handle?.append?.(text)                      // 0.1.7：正文必须经 handle.append 进输出环
  return { ...outcome, result: outcome?.output }   // result=0.1.7 读的字段；output 留给 0.1.6/rc.1，同值别名
}
