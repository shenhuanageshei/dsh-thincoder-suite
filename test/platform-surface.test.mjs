// platform-surface.test.mjs — 批 26：契约面常设锁（设计档 docs/dsh017-batch26-design.md §2.3）。
//
// 九条平台触点各一条**可独立转红**的断言：平台「下次再换契约」时，第二处、第三处断裂在改的
// 当下就红，不再靠人撞（US-4）。三条 derived 锁（#2/#3/#4）与既有锁同锁——未来新增派发点 /
// 改动同名判定时须**两处同改**（行内注记点名既有档）；#7 的期望计数为**实测基线写死**
// （fresh grep 实测日期见行内注，批 26 实施时点）。
// 纪律：零网络、零真实 LLM、零子进程（A26-7 行为腿只桩服务面，兜底定时器用毫秒级小值；
// A26-8 宿主验收腿走 deps.hostCheckOpts 注入缝——假 spawnImpl + 毫秒级超时，绝不真等 120s）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { runEngCoder, buildCoderBrief, validateStages } from "../lib/eng.mjs"
import { runHostStageChecks } from "../lib/host-check.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"

// 隔离契约（对齐既有测试档）：A26-7 的驱动会 settle 一个真 job ⇒ jobOutcome 尝试落盘（D-45）
// ——显式置空 ⇒ home 不可解析 ⇒ 不落盘（本档只测契约面，不测落盘面；落盘面在 dsh017-compat）。
process.env.DSH_HOME = ""

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const LIB = (f) => join(PLUGIN_DIR, "lib", f)
const src = (f) => readFileSync(LIB(f), "utf8")

// ————————————— #1 llm 工具结果消息（批 25 矩阵 #1 / D-41 的常设复述） —————————————

test("#1 llm 工具结果消息: advisor 构造独立 tool 角色消息（消息级 toolCallId/isError/source），全档零处旧形状", () => {
  const advisor = src("advisor.mjs")
  assert.equal((advisor.match(/role: "tool",/g) ?? []).length, 1, "tool 角色消息构造点恰 1 处（toolResultMsg——出现第二处即形状漂移）")
  // 构造点切片（函数体）：三条消息级字段必须同点在场（0.1.7 契约 = 字段在**消息级**，不在块内）
  const iFn = advisor.indexOf("function toolResultMsg(")
  assert.ok(iFn > 0, "toolResultMsg 可定位")
  const body = advisor.slice(iFn, advisor.indexOf("\n}", iFn))
  for (const field of ["toolCallId: callId", "isError: false", "source: { kind: \"tool\", callId }"]) {
    assert.ok(body.includes(field), "构造点含消息级字段：" + field)
  }
  // 负控：全档零处 0.1.6 旧形状（user 消息内的 tool-result 块）
  assert.equal((advisor.match(/type: "tool-result"/g) ?? []).length, 0, "0.1.6 的 user+tool-result 形状必须零残留")
})

// ————————————— #2 jobs.start 的 owner（derived：与 test/dsh017-compat.test.mjs 的 D-42b 同锁，两处同改） —————————————

test("#2 jobs.start owner (derived, 与 D-42b 两处同改): 四档 jobs.start 处数 === ownerIdOf(agent) 处数（= 7），零处直传 Agent 对象", () => {
  const files = ["advisor.mjs", "consult.mjs", "eng.mjs", "escalate.mjs"]
  let starts = 0
  let owners = 0
  for (const f of files) {
    const s = src(f)
    const st = (s.match(/jobs\.start\(\{/g) ?? []).length
    const ow = (s.match(/owner: ownerIdOf\(agent\)/g) ?? []).length
    assert.equal(ow, st, f + ": jobs.start 与 ownerIdOf 一一对应（" + st + " vs " + ow + "）")
    assert.equal((s.match(/owner:\s*agent\s*,/g) ?? []).length, 0, f + ": 不得直传 Agent 对象（0.1.7 报 no live agent）")
    starts += st
    owners += ow
  }
  assert.equal(starts, 7, "四档 jobs.start 合计 = 7（derived 登记值；新增派发点须两处同改：本档 + dsh017-compat D-42b）")
  assert.equal(owners, 7)
})

// ————————————— #3 jobs 输出契约（derived：与 test/dsh017-compat.test.mjs 的 D-46-static 同锁，两处同改） —————————————

test("#3 jobs 输出契约 (derived, 与 D-46-static 两处同改): run 形参收 handle（4 档合计 7、零处无参），jobOutcome 被四处派发调用", () => {
  const files = ["advisor.mjs", "consult.mjs", "eng.mjs", "escalate.mjs"]
  let starts = 0
  let handles = 0
  for (const f of files) {
    const s = src(f)
    const st = (s.match(/jobs\.start\(\{/g) ?? []).length
    const h = (s.match(/run:\s*\(handle\)\s*=>/g) ?? []).length
    assert.equal(h, st, f + ": run: (handle) 数 = jobs.start 数（收 0.1.7 句柄）")
    assert.equal((s.match(/run:\s*\(\)\s*=>/g) ?? []).length, 0, f + ": 零处无参 run（0.1.6 形态）")
    assert.ok(s.includes('from "./job-outcome.mjs"'), f + ": 正文经 jobOutcome 收口（单点，D-46/D-45）")
    assert.ok((s.match(/jobOutcome\(handle,/g) ?? []).length > 0, f + ": 至少一处 jobOutcome(handle, …) 调用")
    starts += st
    handles += h
  }
  assert.equal(starts, 7, "四档 jobs.start 合计 = 7（derived 登记值；两处同改：本档 + dsh017-compat D-46-static）")
  assert.equal(handles, 7)
})

// ————————————— #4 settings.yaml 改名（derived：与 D-40 的 U6d 同锁，两处同改） —————————————

test("#4 home 兜底探测 (derived, 与 U6d 两处同改): probeProfileRoot 同时接受 settings.yaml 与 settings.yaml.imported", () => {
  const home = src("dsh-home.mjs")
  // 判定行逐字在场（只加 OR、不改「必须有 sessions/」——D-40 的修复面；任何一侧被删即红）
  assert.ok(home.includes('existsSync(join(dir, "settings.yaml")) || existsSync(join(dir, "settings.yaml.imported"))'),
    "双名特征判定行在场（0.1.7 起旧名会被宿主改名 ⇒ 只认旧名 = 无 env 部署设置页 500）")
  assert.ok(home.includes('existsSync(join(dir, "sessions"))'), "sessions/ 特征仍在（判定不得被放宽成「有 sessions 就算」的反向：门必须仍要它）")
})

// ————————————— #5 subagents.start 形状（批 25 矩阵 #5：0.1.6/0.1.7 逐字一致的平台面） —————————————
//
// ★ 与设计档 §2.3 #5 的偏差**如实登记**：设计给的键集合 {prompt,parent,signal,agentOptions,
// toolFilter,outputSchema} 漏了现有调用点实际在传的 persona / label / maxDepth（consult/eng/
// escalate 三档都在传——批 24 会诊 #6 的逐项 diff 确认它们两版皆收、0.1.7 上装配成功为证）。
// 若按设计的六键字面实现，本锁**出生即红**。故锁钉**实测并集**（六键 ∪ 三个在传键）：出现
// 并集之外的键（= 平台从未确认过的新形状）即红；outputSchema 现无人传，保留在允许集内备将来。

/** 字符串感知的花括号配平：返回 start（指向“{”）对应的闭括号下标。 */
function objectEnd(source, start) {
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch
      i++
      while (i < source.length && source[i] !== q) i += source[i] === "\\" ? 2 : 1
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 在 [start, end) 内按**顶层深度**收参数键（depth 1 = 对象第一层）；展开语法回查同名 const 定义。 */
function collectKeys(source, start, end, keys, followSpreads) {
  let depth = 0
  let i = start
  while (i < end) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch
      i++
      while (i < end && source[i] !== q) i += source[i] === "\\" ? 2 : 1
    } else if (ch === "{" || ch === "(" || ch === "[") {
      depth++
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth--
    } else if (depth === 1 && ch === "." && source[i + 1] === "." && source[i + 2] === ".") {
      let j = i + 3
      let name = ""
      while (j < end && /[\w$]/.test(source[j])) name += source[j++]
      if (followSpreads && name) {
        const defAt = source.indexOf("const " + name + " = {")
        if (defAt >= 0) {
          const objAt = defAt + ("const " + name + " = ").length // 指向“{”本身（与主调用同口径：起点在括号上）
          collectKeys(source, objAt, objectEnd(source, objAt), keys, false)
        }
      }
    } else if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      let j = i
      let name = ""
      while (j < end && /[\w$]/.test(source[j])) name += source[j++]
      let k = j
      while (k < end && source[k] === " ") k++
      if (source[k] === ":") keys.add(name)
      i = j
      continue
    }
    i++
  }
}

test("#5 subagents.start 形状: 全部调用点的参数键集合 ⊆ 平台已知形状（出现集合外键即红）", () => {
  const ALLOWED = new Set(["prompt", "parent", "signal", "agentOptions", "toolFilter", "outputSchema", "persona", "label", "maxDepth"])
  let siteCount = 0
  for (const f of ["consult.mjs", "eng.mjs", "escalate.mjs"]) {
    const s = src(f)
    const keys = new Set()
    const re = /ctx\.subagents\.start\("spawn",\s*\{/g
    let m
    while ((m = re.exec(s)) !== null) {
      siteCount++
      const objAt = m.index + m[0].length - 1
      collectKeys(s, objAt, objectEnd(s, objAt), keys, true)
    }
    const extra = [...keys].filter((k) => !ALLOWED.has(k))
    assert.deepEqual(extra, [], f + ": subagents.start 出现平台未知键 " + JSON.stringify(extra) + "——换契约时最先红在这里")
    if (keys.size > 0) assert.ok(keys.has("prompt") && keys.has("parent"), f + ": 基本形状（prompt+parent）在场")
  }
  // advisor 不经 subagents.start（dsh 主路径走 llm 循环）——调用点恰在另外三档，合计 6
  //（consult 2 = 白名单降级腿 · eng 2 = 后台/同步 · escalate 2 = 后台/同步）
  assert.equal(siteCount, 6, "subagents.start 调用点合计 = 6（consult 2 + eng 2 + escalate 2）——实测 " + siteCount)
})

// ————————————— #6 agent/session 字段（批 25 矩阵 #6；评审 #9：实谓词，非「存在性」） —————————————

test("#6 agent/session 形状: 实谓词——lib 消费面逐点消费 session.id/header.cwd/delegationDepth/options.provider·model；行为腿夹具满足同一契约", () => {
  // ★ AC-4 补实（分歧审计）：原稿的 4 条谓词打在**自建 stub** 上（stub 长什么样断言就什么样
  //   ——同义反复，零边际检测力）。改为对**实际消费面**的实断言：0.1.6/0.1.7 的 enter() 逐字
  //   相同（批 25 矩阵 #6 的定论）落到「lib 真的按这些字段消费」上——平台再改形状、lib 适配
  //   时丢掉任何一个消费点，这里当场红。
  const eng = src("eng.mjs")
  const advisor = src("advisor.mjs")
  const consult = src("consult.mjs")
  const escalate = src("escalate.mjs")
  // ① 会话键 = session.id（sessionState 按 id 键；jobs owner 按 id 查活代理——D-42 同一判据）
  assert.ok(eng.includes("sessionState(agent.session.id)"), "eng: 会话状态按 agent.session.id 键")
  assert.ok(advisor.includes("agent.session.id"), "advisor: 消费 agent.session.id")
  assert.ok(consult.includes("agent.session.id"), "consult: 消费 agent.session.id")
  assert.ok(escalate.includes("agent.session.id"), "escalate: 消费 agent.session.id")
  // ② depth 门 = header.delegationDepth（只拦主代理的判据面；0.1.6/0.1.7 逐字同）
  assert.ok(eng.includes("agent.session.header?.delegationDepth"), "eng: depth 门消费 header.delegationDepth")
  // ③ cwd 基座消费（D-44 指纹基座 / D-47 冻结基座 / D48-2 验收 cwd 的同一来源）
  assert.ok(advisor.includes("session?.header?.cwd"), "advisor 消费 session.header.cwd")
  assert.ok(eng.includes("agent.session?.header?.cwd"), "eng 消费会话 cwd（D-44/D-47/D48-2 同一来源）")
  // ④ options.provider/model 消费链：agent.options ?? {} 收敛 → 子代理 agentOptions 显式透传（F9）
  assert.ok(eng.includes("const agentOpts = agent.options ?? {}"), "eng: agent.options 收敛到 agentOpts")
  assert.ok(eng.includes("provider: agentOpts.provider") && eng.includes("model: agentOpts.model"),
    "eng: provider/model 经 agentOpts 显式传子代理")
  assert.ok(eng.includes("agentOpts.maxTokens"), "eng: maxTokens 经 agentOpts 消费（F9 预算链）")
  // ⑤ 夹具形状实断言：本档行为腿（A26-7/A26-8）的 deps.agent 夹具满足同一契约——夹具缺
  //    header.cwd 之类会让行为腿在错误的 cwd 语义下假绿（夹具形状也是契约面）
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8")
  assert.ok(self.includes("header: { cwd: PLUGIN_DIR }"), "本档行为腿夹具带 header.cwd（cwd 语义实流）")
  assert.ok(self.includes('options: { provider: "p", model: "m" }'), "本档行为腿夹具带 options.provider/model")
})

// ————————————— #7 注册面（期望计数 = fresh grep 实测基线写死；实测日期 2026-09-26，批 26 实施时点） —————————————

test("#7 注册面: ctx.tools.register / systemPrompt.section / textTool 注册点的期望计数 = 实测基线（不变以该数字为准）", () => {
  let toolsRegister = 0
  let section = 0
  let textTool = 0
  for (const f of readdirSync(join(PLUGIN_DIR, "lib"))) {
    if (!f.endsWith(".mjs")) continue
    const s = src(f)
    toolsRegister += (s.match(/ctx\.tools\.register\(/g) ?? []).length
    section += (s.match(/systemPrompt\.section\(/g) ?? []).length
    if (f === "index.mjs") textTool += (s.match(/register\(textTool\(\{/g) ?? []).length
  }
  // 实测基线（fresh grep @2026-09-26，批 26 实施时点；「不变」以这些数字为准，评审 #9）：
  assert.equal(toolsRegister, 1, "ctx.tools.register 消费点 = 1（index.mjs 的统一 register helper；新增注册面须两处同改：本档 + 设计 §2.3 #7）")
  assert.equal(section, 3, "systemPrompt.section 合计 = 3（index.mjs 2 处全局组 + eng.mjs 1 处 agent 作用域 engineering section）")
  assert.equal(textTool, 7, "register(textTool({ 注册点 = 7（index.mjs；增删工具即红——防注册面静默漂移）")
})

// ————————————— #8 connection.requestRejection（批 25 矩阵 #8 / D-39 腿复述） —————————————

test("#8 webServer 信任栅栏: 处理函数首个业务调用是 requestRejection 栅栏；栅栏自身先取 connection 且不可核验即 503", () => {
  const index = src("index.mjs")
  // handler 头部切片：栅栏必须先于一切业务逻辑（不解析 URL、不读盘——D-39）
  const iHandler = index.indexOf("return async (req, res) => {")
  assert.ok(iHandler > 0, "api handler 可定位")
  const iFence = index.indexOf("const rejection = rejectionOf(req)", iHandler)
  const iUrl = index.indexOf("new URL(", iHandler)
  assert.ok(iFence > 0, "栅栏判定调用在场")
  assert.ok(iUrl > iFence, "栅栏先于 URL 解析（处理函数首个业务调用 = 信任栅栏，D-39）")
  // 栅栏本体：先取 connection 服务、再问 requestRejection；取不到/契约外 ⇒ 503 fail-closed
  const iRej = index.indexOf("const rejectionOf = (req) => {")
  assert.ok(iRej > 0 && iRej < iHandler, "rejectionOf 定义在 handler 之前")
  const rejBody = index.slice(iRej, index.indexOf("return 503", iRej))
  const iGet = rejBody.indexOf('ctx?.get?.("connection")')
  const iAsk = rejBody.indexOf("connection.requestRejection(req)")
  assert.ok(iGet >= 0 && iAsk > iGet, "栅栏先取 connection 服务、再问 requestRejection（顺序不可反）")
})

// ————————————— #9 读取面（不在本仓）⇒ 插件侧取向：派发文案含首选落盘路径（文本锁，D-45） —————————————

test("#9 读取面插件侧取向: 派发文案首选落盘文件、job_output 降为附加（文本锁）", () => {
  const advisor = src("advisor.mjs")
  const i = advisor.indexOf("JOBS_CONTINUATION_INSTRUCTION =")
  assert.ok(i > 0, "共享接续指令可定位")
  const lit = advisor.slice(i, advisor.indexOf("\n", advisor.indexOf("job_output 作为附加", i)))
  assert.ok(lit.includes("$DSH_HOME/.thincoder/jobs/<jobId>.txt"), "派发文案含落盘路径字面（US-2：不必再问怎么绕）")
  assert.ok(lit.includes("首选读落盘文件"), "文案以落盘为首选")
  assert.ok(lit.includes("job_output 作为附加"), "job_output 降为附加（读取面不在本仓、实测会崩——D-45 的前提）")
  // 四条机制的派发回复都汇到该常量（一处改全改的结构保证）
  for (const f of ["consult.mjs", "eng.mjs", "escalate.mjs"]) {
    assert.ok(src(f).includes("jobsDispatchReply"), f + ": 派发回复经共享 helper（含首选落盘文案）")
  }
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
