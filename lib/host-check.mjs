// host-check.mjs — 批 26 / D48-2 ⊕ D48-5：宿主验收回执的**执行面**（leaf 模块）。
//
// 为什么单独一个模块（D48-5，分歧审计 ②-D2 的裁定）：常驻锁 T-AP7 把
// lib/{advisor,eng,escalate,consult}.mjs 四档的定时器时长标识**逐字**钉死，且同时与 HEAD 源
// 交叉核验 ⇒ 若把本执行面（含其 setTimeout 与子进程调用点）留在 eng.mjs，则「当前源 == 表」
// 与「HEAD 源 == 表」**结构上不可同时成立**。抽成 leaf 模块 ⇒ 四档锁**零改动**、T-AP7 自动绿；
// 改 T-AP7 属锁弱化，本批不取。stage-gate T-SG4 的 lib/** 执行面计数基线 2 不变——第二处
// 随本模块迁入（决策 D26-5 有意改锁的同一处执行面，只是落点换成 leaf）。
//
// 执行信封（设计档 docs/dsh017-batch26-design.md §2.5，评审 #3 钉死）：
// - cwd = 会话 cwd（调用方传 agent.session.header.cwd；空/缺回落 process.cwd()）；
// - shell = 宿主既有执行面（spawn 的 shell 模式——宿主进程可用的那一个，命令里不引入对
//   特定 shell 的依赖；Windows 上实测为 %ComSpec% = cmd.exe）；
// - 独立超时 HOST_CHECK_TIMEOUT_MS = 120000，到点杀进程并收敛为 timedOut 形态（回执文案
//   为 "check timed out"）——background 路径下回执在 job 内、不占调用回合；同步路径下回执在
//   return 前 await，最坏 120s × host 阶段数（审计 ④-3 要求写明这一语义）；
// - 命令失败 ⇒ 回执 FAIL，但**不改作业状态**（验收回执不是作业终态——eng.mjs 的调用点只把
//   回执拼进交付文本，jobOutcome 的 status 参数原样）；
// - 任何异常吞成回执行（兜底不得成为新的失败源——D26-2 同向）：runHostStageChecks 只 resolve，
//   绝不 reject，否则 dsh 后台成功路径的 catch 会把一次成功交付翻转成 failed。
//
// A26-8 可注入缝：runOneHostCheck / runHostStageChecks 的第三参 opts = { timeoutMs?, spawnImpl? }
// ——测试注入毫秒级超时与假子进程（零真进程、绝不真等 120s）。生产调用点不传 opts，
// 取默认值，行为与注入前逐字一致。
import { spawn } from "node:child_process"

/**
 * 宿主验收的单条命令独立超时（设计档 §2.5 D48-2 执行信封）：到点收敛为 "check timed out" 回执
 * （不阻塞交付回合）；命令失败 ⇒ 回执 FAIL，但**作业状态不变**（验收回执不是作业终态）。
 */
export const HOST_CHECK_TIMEOUT_MS = 120000

/**
 * 执行信封的单条命令：cwd = 会话 cwd · shell = 宿主既有执行面（spawn 的 shell 模式——宿主进程
 * 可用的那一个，命令里不引入对特定 shell 的依赖）· 独立超时（默认 HOST_CHECK_TIMEOUT_MS，
 * opts.timeoutMs 可注入），到点杀进程并收敛为 timedOut 形态。输出只留尾部（回执语义 =「尾部
 * 输出」，8KB 滚动窗口，结算时再收窄到 2KB）。
 * @param {string} command stages[].check 的命令原文
 * @param {string} cwd 会话 cwd（调用方传 agent.session.header.cwd）
 * @param {{timeoutMs?: number, spawnImpl?: Function}} [opts] A26-8 测试注入缝（生产不传）
 */
export function runOneHostCheck(command, cwd, opts) {
  const timeoutMs = opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : HOST_CHECK_TIMEOUT_MS
  const spawnImpl = opts && typeof opts.spawnImpl === "function" ? opts.spawnImpl : spawn
  return new Promise((settle) => {
    const out = { code: null, timedOut: false, tail: "" }
    let child = null
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { if (child) child.kill() } catch { /* 已退出 */ }
      out.tail = out.tail.slice(-2000)
      settle(out)
    }
    const timer = setTimeout(() => { out.timedOut = true; finish() }, timeoutMs)
    timer.unref?.()
    try {
      child = spawnImpl(String(command), { shell: true, cwd, windowsHide: true })
    } catch (e) {
      out.code = -1
      out.tail = String(e && e.message ? e.message : e)
      finish()
      return
    }
    const grab = (d) => {
      out.tail += String(d)
      if (out.tail.length > 8000) out.tail = out.tail.slice(-8000)
    }
    child.stdout?.on?.("data", grab)
    child.stderr?.on?.("data", grab)
    child.on("error", (e) => { out.code = -1; out.tail += "\n" + String(e && e.message ? e.message : e); finish() })
    child.on("close", (code) => { out.code = typeof code === "number" ? code : -1; finish() })
  })
}

/**
 * 宿主验收回执：对生效 checkMode === "host" 的阶段，在**宿主侧**按 check 命令逐条执行，产出
 * 「退出码 + 尾部输出 + 验收：PASS/FAIL」回执文本（追加在交付报告之后、随 jobOutcome 进交付
 * 报告与落盘文件同一处）。无 host 态阶段 ⇒ 空串（返回点行为逐字不变）。失败/超时 ⇒ 回执
 * FAIL/timed out，但**不改作业状态**；任何异常吞成回执行（兜底不得成为新的失败源——D26-2 同向）。
 * @param {object[]|null|undefined} stages 生效阶段表（checkMode 已由 eng.mjs 的路径缺省预填）
 * @param {string|undefined} sessionCwd 会话 cwd（agent.session.header.cwd）
 * @param {{timeoutMs?: number, spawnImpl?: Function}} [opts] A26-8 测试注入缝（透传 runOneHostCheck）
 */
export async function runHostStageChecks(stages, sessionCwd, opts) {
  const list = (Array.isArray(stages) ? stages : [])
    .map((s, i) => ({ s, n: i + 1 }))
    .filter(({ s }) => s && s.checkMode === "host" && typeof s.check === "string" && s.check.trim() !== "")
  if (list.length === 0) return ""
  const cwd = typeof sessionCwd === "string" && sessionCwd.trim() !== "" ? sessionCwd : process.cwd()
  const lines = ["", "--- 宿主验收回执（D-48：验证命令由宿主执行；本回执不是作业终态，作业状态不变） ---"]
  let anyFail = false
  for (const { s, n } of list) {
    let r
    try {
      r = await runOneHostCheck(s.check, cwd, opts)
    } catch (e) {
      r = { code: -1, timedOut: false, tail: String(e && e.message ? e.message : e) }
    }
    if (r.timedOut) {
      anyFail = true
      lines.push("stage " + n + " check timed out（>" + timeoutMsOf(opts) + "ms，到点收敛不再等待）: " + s.check)
      continue
    }
    if (r.code !== 0) anyFail = true
    lines.push("stage " + n + " check " + (r.code === 0 ? "PASS" : "FAIL") + "（exit " + r.code + "）: " + s.check
      + "\n尾部输出：\n" + (r.tail === "" ? "(no output)" : r.tail))
  }
  lines.push("验收：" + (anyFail ? "FAIL" : "PASS"))
  return lines.join("\n")
}

/** 回执文案里的超时标注取**生效值**（注入缝的小值如实显示；生产 = HOST_CHECK_TIMEOUT_MS）。 */
function timeoutMsOf(opts) {
  return opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : HOST_CHECK_TIMEOUT_MS
}
