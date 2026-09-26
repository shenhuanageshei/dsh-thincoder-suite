// platform-surface.test.mjs — 批 26：契约面常设锁（设计档 docs/dsh017-batch26-design.md §2.3）。
//
// ★ 批 28 迁移登记（docs/dsh017-batch28-design.md §2.3 / D28-2 / A28-5）：九条触点谓词的**实现**
//   已整体迁往 lib/contract-baseline.mjs（单一事实源；contractWatch 工具与本档共用同一份，
//   不存在第二份字面——A28-5 静态锁在该基线档的机验锚档里守护）。本档保留：
//   ① 九条锁的**独立断言腿**（每条一个 test——A26-4「各自独立转红」；夹具文本腿由本档把
//     自己的源文本传给 #6——夹具形状也是契约面）；
//   ② 行为腿 A26-6 / A26-7 / A26-8（逐字未动）。
// 纪律不变：零网络、零真实 LLM、零子进程（A26-7 行为腿只桩服务面，兜底定时器用毫秒级小值；
// A26-8 宿主验收腿走 deps.hostCheckOpts 注入缝——假 spawnImpl + 毫秒级超时，绝不真等 120s）。
// ★ #7 基线上调（D28-6；先例 = 批 26 §2.5 对 T-SG4 的同批改锁处理）：textTool 注册点 **7 → 8**
//   ——本批新增只读巡检工具 contractWatch（新工具 ⇒ 计数 +1，不同批上调即「被自家锁打红后
//   临场解释」）。上调与理由的登记处 = lib/contract-baseline.mjs 的 REGISTRATION_SURFACE_BASELINE
//   注释 + docs/dsh017-batch28-design.md §3/D28-6。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { runEngCoder, buildCoderBrief, validateStages } from "../lib/eng.mjs"
import { runHostStageChecks } from "../lib/host-check.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
// 批 28（A28-5）：九条谓词的唯一实现——本档是消费方，不是第二份字面。
import { evaluatePlatformSurfaceLocks, LOCK_IDS } from "../lib/contract-baseline.mjs"

// 隔离契约（对齐既有测试档）：A26-7 的驱动会 settle 一个真 job ⇒ jobOutcome 尝试落盘（D-45）
// ——显式置空 ⇒ home 不可解析 ⇒ 不落盘（本档只测契约面，不测落盘面；落盘面在 dsh017-compat）。
process.env.DSH_HOME = ""

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** 本档源文本（#6 夹具文本腿的输入——夹具形状也是契约面，批 26 评审 #9 实谓词口径的延伸）。 */
const selfSrc = () => readFileSync(fileURLToPath(import.meta.url), "utf8")
const allLocks = () => evaluatePlatformSurfaceLocks({ fixtureText: selfSrc() })

/** 独立断言腿的共用体：取该 id 的锁结果并断言全绿（实现见 lib/contract-baseline.mjs）。 */
function assertLock(id) {
  const lock = allLocks().find((l) => l.id === id)
  assert.ok(lock, "锁 id 在场（单一事实源返回）：" + id)
  assert.equal(lock.ok, true, id + " 转红：" + (lock && lock.evidence))
  assert.equal(typeof lock.evidence, "string", "evidence 为字符串：" + id)
  assert.ok(lock.evidence.length > 0, "evidence 非空（读自哪个文件/片段）：" + id)
}

// ————————————— 九条触点：独立断言腿（谓词实现 = lib/contract-baseline.mjs，A28-5 同源） —————————————

test("#1 llm 工具结果消息: advisor 构造独立 tool 角色消息（消息级 toolCallId/isError/source），全档零处旧形状", () => {
  assertLock("ps1-llm-tool-result-msg")
})

test("#2 jobs.start owner (derived, 与 D-42b 两处同改): 四档 jobs.start 处数 === ownerIdOf(agent) 处数（= 7），零处直传 Agent 对象", () => {
  assertLock("ps2-jobs-start-owner")
})

test("#3 jobs 输出契约 (derived, 与 D-46-static 两处同改): run 形参收 handle（4 档合计 7、零处无参），jobOutcome 被四处派发调用", () => {
  assertLock("ps3-jobs-output-contract")
})

test("#4 home 兜底探测 (derived, 与 U6d 两处同改): probeProfileRoot 同时接受 settings.yaml 与 settings.yaml.imported", () => {
  assertLock("ps4-home-probe-dual-name")
})

test("#5 subagents.start 形状: 全部调用点的参数键集合 ⊆ 平台已知形状（出现集合外键即红）", () => {
  assertLock("ps5-subagents-start-shape")
})

test("#6 agent/session 形状: 实谓词——lib 消费面逐点消费 session.id/header.cwd/delegationDepth/options.provider·model；夹具文本腿随本档传入", () => {
  assertLock("ps6-agent-session-fields")
})

test("#7 注册面: 期望计数 = 实测基线（批 28 上调 textTool 7→8：新增 contractWatch，D28-6；谓词实现 = lib/contract-baseline.mjs）", () => {
  assertLock("ps7-registration-surface")
})

test("#8 webServer 信任栅栏: 处理函数首个业务调用是 requestRejection 栅栏；栅栏自身先取 connection 且不可核验即 503", () => {
  assertLock("ps8-request-rejection-fence")
})

test("#9 读取面插件侧取向: 派发文案首选落盘文件、job_output 降为附加（文本锁）", () => {
  assertLock("ps9-dispatch-copy-persisted-path")
})

// ═══════════════ A26-7（D48-3）：兜底信封自带 check 命令原文与取证指路（行为腿） ═══════════════

test("A26-7 (D48-3): 构造一次 dshBackgroundTimeoutMs 兜底超时 ⇒ 信封含 stages 的 check 命令原文与取证指路句", async () => {
  const sid = "a26-7-" + randomUUID()
  const st = sessionState(sid)
  st.engineering = true
  st.designToken = randomUUID() + ":" + (Date.now() + 3600_000)
  const CHECK = "node --check lib/a26-7-target.mjs"
  // 子代理挂起直到 abort（复现「起跑即挂死」面：只有兜底能杀它）
  const subagents = {
    async start(kind, req) {
      return {
        result: new Promise((_res, rej) => {
          const sig = req.signal
          const die = () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))
          if (sig?.aborted) return die()
          sig?.addEventListener("abort", die, { once: true })
        }),
        dispose: async () => {},
      }
    },
  }
  const handle = { id: "eng-dsh-a26-7", calls: [], append(text) { this.calls.push(text) } }
  const specs = []
  const deps = {
    ctx: {
      subagents,
      llm: { async resolveModelInfo() { return { reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }], defaultEffort: "low" } } } },
      // 0.1.7 形态的假 jobs：调 spec.run(handle) 并留存 hooks（done 携带 jobOutcome 的结算信封）
      get: (s) => (s === "jobs" ? { start(spec) { const hooks = spec.run(handle); specs.push({ spec, hooks }); return "eng-dsh-a26-7" } } : null),
    },
    agent: { session: { id: sid, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
    config: { dshBackgroundTimeoutMs: 60 },
    signal: undefined,
    configDefaultEngineering: false,
  }
  try {
    const out = await runEngCoder(deps, {
      task: "implement the a26-7 design",
      designToken: st.designToken,
      stages: [{ goal: "g", files: ["lib/a26-7-target.mjs"], acceptance: "a", check: CHECK }],
    })
    assert.ok(out.includes("eng-dsh-a26-7"), "前置：确实走了 dsh 后台派发（job 句柄可见）：" + out.slice(0, 140))
    const outcome = await specs[0].hooks.done
    assert.equal(outcome.status, "failed", "兜底掐死 ⇒ failed")
    assert.equal(outcome.detail, "dshBackgroundTimeoutMs backstop")
    assert.ok(outcome.output.includes(CHECK), "信封含 stages 的 check 命令原文（A26-7 主判据）")
    assert.ok(outcome.output.includes("宿主可直接执行"), "信封标注命令可直接执行")
    assert.ok(outcome.output.includes("取证指路（D-48）"), "信封含取证指路句")
    assert.ok(outcome.output.includes("沙箱禁子进程"), "取证指路点名根因方向（沙箱禁子进程 ⇒ 宿主执行）")
    assert.ok(outcome.output.includes("请宿主执行上述 check 命令"), "指路句给出宿主动作")
  } finally {
    dropSession(sid)
  }
})

// ═══════════════ A26-6（D48-1）：checkMode:"host" 的任务书——验证门归位到宿主（AC-7） ═══════════════

test('A26-6 (D48-1): checkMode:"host" 任务书不含「子代理跑 check」措辞，check 命令标注「由宿主执行」；schema 拒非法枚举', () => {
  // 渲染腿：host 态阶段（= dsh 路径经 stagesWithModeDefault 预填后的同一形状）经 buildCoderBrief 渲染
  const hostStages = [
    { goal: "g1", files: ["lib/a.mjs"], acceptance: "acc-1", check: "node --test test/a.test.mjs", checkMode: "host" },
    { goal: "g2", files: ["lib/b.mjs"], acceptance: "acc-2", check: "node --check lib/b.mjs", checkMode: "host" },
  ]
  const brief = buildCoderBrief("implement the design", [], hostStages)
  // 每个 host 阶段的 Self-check 命令后各带一条「由宿主执行」注记（恰 = host 阶段数）
  const marks = (brief.match(/验证命令（由宿主执行/g) ?? []).length
  assert.equal(marks, hostStages.length, "每条 check 命令各带「由宿主执行」注记（实测 " + marks + "）")
  assert.ok(brief.includes("本阶段不要求你执行命令"), "阶段纪律改为「本阶段不要求你执行命令」")
  assert.ok(brief.includes("不要执行任何验证/测试命令"), "host 态任务书明确禁止子代理执行验证命令")
  // 反向（AC-7 主判据）：要求子代理执行 check 的措辞在 host 态任务书零出现
  for (const banned of [
    "stage N's self-check must pass before you enter stage N+1",
    "A failed self-check means fix-and-retry",
    "re-run the check after fixing",
    "finish the current stage's self-check",
  ]) {
    assert.ok(!brief.includes(banned), "host 态不得出现「子代理跑 check」措辞：" + JSON.stringify(banned))
  }
  // 对照：全 subagent 态零注记（默认路径渲染零漂移）；混合态只标注 host 阶段
  const subBrief = buildCoderBrief("implement the design", [], hostStages.map((s) => ({ ...s, checkMode: "subagent" })))
  assert.equal((subBrief.match(/由宿主执行/g) ?? []).length, 0, "subagent 态零「由宿主执行」字样")
  const mixed = buildCoderBrief("implement the design", [], [...hostStages,
    { goal: "g3", files: ["lib/c.mjs"], acceptance: "acc-3", check: "pytest -q", checkMode: "subagent" }])
  assert.equal((mixed.match(/验证命令（由宿主执行/g) ?? []).length, hostStages.length, "混合态只标注 host 阶段")
  // schema 腿：validateStages 枚举——两合法值放行、非法值拒收（不静默丢）、缺省不写键
  const okHost = validateStages([{ goal: "g", files: ["f"], acceptance: "a", check: "c", checkMode: "host" }])
  assert.equal(okHost.ok, true, 'checkMode:"host" 合法')
  assert.equal(okHost.stages[0].checkMode, "host", "合法值保留在净化副本")
  const okSub = validateStages([{ goal: "g", files: ["f"], acceptance: "a", check: "c", checkMode: "subagent" }])
  assert.equal(okSub.ok, true, 'checkMode:"subagent" 合法')
  const bad = validateStages([{ goal: "g", files: ["f"], acceptance: "a", check: "c", checkMode: "self" }])
  assert.equal(bad.ok, false, "非法 checkMode 被拒（不静默丢）")
  assert.ok(bad.error.includes('checkMode must be "subagent" or "host"'), "拒绝文案点名枚举：" + bad.error)
  const noMode = validateStages([{ goal: "g", files: ["f"], acceptance: "a", check: "c" }])
  assert.equal(noMode.ok, true, "缺省 checkMode 合法")
  assert.equal(noMode.stages[0].checkMode, undefined, "缺省不写键（净化副本形状与既有用例兼容）")
})

// ═══════════════ A26-8（D48-2）：宿主验收回执——可注入缝，零真进程、绝不真等 120s ═══════════════

/** 极简假子进程：只长出执行面消费的接口（stdout/stderr.on + on(error/close) + kill）；
 *  behavior 在微任务里拿到发射器（此时执行面已同步挂好监听）。 */
function fakeHostChild(behavior) {
  const outFns = []
  const errFns = []
  const evFns = {}
  const bus = (arr) => ({ on: (_t, fn) => { arr.push(fn) } })
  const child = {
    stdout: bus(outFns),
    stderr: bus(errFns),
    on: (t, fn) => { (evFns[t] ??= []).push(fn) },
    kill: () => { child.killed = true },
    killed: false,
  }
  queueMicrotask(() => behavior({
    out: (d) => outFns.forEach((fn) => fn(d)),
    err: (d) => errFns.forEach((fn) => fn(d)),
    close: (code) => (evFns.close ?? []).forEach((fn) => fn(code)),
    error: (e) => (evFns.error ?? []).forEach((fn) => fn(e)),
  }))
  return child
}

test("A26-8 (D48-2): 宿主验收回执进交付文本（退出码+尾部输出）；失败 ⇒ FAIL 而作业 status 不变；超时 ⇒ 收敛 timed out（注入缝，零真进程）", async () => {
  const CHECK = "node --test test/a26-8-never-run.test.mjs"
  const mk = (spawnImpl) => {
    const sid = "a26-8-" + randomUUID()
    const st = sessionState(sid)
    st.engineering = true
    st.designToken = randomUUID() + ":" + (Date.now() + 3600_000)
    const handle = { id: "eng-dsh-a26-8", calls: [], append(text) { this.calls.push(text) } }
    const specs = []
    const deps = {
      ctx: {
        subagents: { async start() { return { result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "A26-8 delivery body" }] }), dispose: async () => {} } } },
        llm: { async resolveModelInfo() { return { reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }], defaultEffort: "low" } } } },
        get: (s) => (s === "jobs" ? { start(spec) { const hooks = spec.run(handle); specs.push({ spec, hooks }); return "eng-dsh-a26-8" } } : null),
      },
      agent: { session: { id: sid, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
      config: { dshBackgroundTimeoutMs: 1000 },
      signal: undefined,
      configDefaultEngineering: false,
      // A26-8 注入缝：假子进程 + 毫秒级超时——生产路径不传 hostCheckOpts，行为不变
      hostCheckOpts: { timeoutMs: 40, spawnImpl },
    }
    return { sid, deps, specs }
  }
  const drive = async (f) => {
    const out = await runEngCoder(f.deps, {
      task: "implement the a26-8 design",
      designToken: sessionState(f.sid).designToken,
      stages: [{ goal: "g", files: ["lib/a26-8-target.mjs"], acceptance: "a", check: CHECK, checkMode: "host" }],
    })
    assert.ok(out.includes("eng-dsh-a26-8"), "前置：确实走了 dsh 后台派发：" + out.slice(0, 140))
    return { out, outcome: await f.specs[0].hooks.done }
  }

  // ① 成功腿：exit 0 + 尾部输出 ⇒ PASS 回执（含退出码与尾部输出）进交付文本
  {
    const f = mk((cmd, opts) => fakeHostChild((x) => {
      if (cmd !== CHECK) throw new Error("执行面必须拿 stages 的 check 原文：" + cmd)
      if (opts.cwd !== PLUGIN_DIR) throw new Error("执行信封 cwd = 会话 cwd：" + opts.cwd)
      x.out("all green\n"); x.close(0)
    }))
    try {
      const { outcome } = await drive(f)
      assert.equal(outcome.status, "completed", "交付本身成功")
      assert.ok(outcome.output.includes("宿主验收回执"), "回执进交付文本")
      assert.ok(outcome.output.includes("PASS（exit 0）"), "回执含退出码（exit 0）")
      assert.ok(outcome.output.includes("all green"), "回执含尾部输出")
      assert.ok(outcome.output.includes("验收：PASS"), "回执给出验收：PASS")
    } finally { dropSession(f.sid) }
  }
  // ② 失败腿：exit 2 ⇒ 回执 FAIL，但**作业 status 不变**（验收回执不是作业终态）
  {
    const f = mk((cmd) => fakeHostChild((x) => { x.err("boom at line 1\n"); x.close(2) }))
    try {
      const { outcome } = await drive(f)
      assert.equal(outcome.status, "completed", "失败 ⇒ 回执 FAIL 而**作业 status 不变**（仍 completed）")
      assert.ok(outcome.output.includes("宿主验收回执"), "回执照常进交付文本")
      assert.ok(outcome.output.includes("FAIL（exit 2）"), "回执含失败退出码（exit 2）")
      assert.ok(outcome.output.includes("boom at line 1"), "回执含失败尾部输出")
      assert.ok(outcome.output.includes("验收：FAIL"), "回执给出验收：FAIL")
    } finally { dropSession(f.sid) }
  }
  // ③ 超时腿：假子进程永不 close + 注入 40ms 超时 ⇒ 收敛为 timed out（绝不真等 120s）
  {
    const f = mk((cmd) => fakeHostChild(() => { /* 永不 close——复现挂死面 */ }))
    try {
      const { outcome } = await drive(f)
      assert.equal(outcome.status, "completed", "超时同样不改作业 status")
      assert.ok(outcome.output.includes("check timed out"), "超时收敛为 timed out 回执")
      assert.ok(outcome.output.includes("验收：FAIL"), "超时计 FAIL")
    } finally { dropSession(f.sid) }
  }
  // ④ 单元腿：无 host 态阶段 ⇒ 空串（返回点行为逐字不变）；spawnImpl 同步抛 ⇒ 只 resolve 成回执、绝不 reject
  assert.equal(await runHostStageChecks([{ checkMode: "subagent", check: CHECK }], PLUGIN_DIR), "", "无 host 态阶段 ⇒ 空回执")
  assert.equal(await runHostStageChecks([], PLUGIN_DIR), "", "空 stages ⇒ 空回执")
  const rThrow = await runHostStageChecks([{ checkMode: "host", check: CHECK }], PLUGIN_DIR, {
    timeoutMs: 40,
    spawnImpl: () => { throw new Error("spawn exploded synchronously") },
  })
  assert.ok(rThrow.includes("验收：FAIL"), "spawnImpl 同步抛 ⇒ 回执 FAIL（兜底不得成为新的失败源）")
  assert.ok(rThrow.includes("spawn exploded synchronously"), "异常信息进尾部输出（可诊断）")
})
