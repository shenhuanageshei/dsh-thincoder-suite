// stage-gate.test.mjs — 阶段门（stageGateNote）三态 + 接线断言（批 9 · 设计档 §6.4 / AC-9/AC-10/AC-11）。
//
// 本档锁三件事：
//   ① **判定三态**（全 passed ⇒ 零横幅 · 任一 failed ⇒ 点名阶段号 · 表缺失/不可解析 ⇒ UNDECLARED）；
//   ② **接线**：每个**成功交付返回点**各调一次（helper 单一实现 —— D-26-⑥），**失败/abort 返回点零接线**
//      （失败交付已是失败，不需声明闸——AGENTS 令牌化的边缘设计，见设计档 §6.4/图 2）；
//   ③ **横幅形态**：置于交付文本**前部**，报告正文**一字不改**（US-9：主代理要读完整报告来发修复轮）。
//
// ★ 计数口径说明（**与设计档 §10.3 / AC-11 的「5 个成功返回点」的差异，如实登记、不静默**）：
//   设计档 / 纪要初稿把「4 个路径（codex 同步 / codex 后台 / dsh 同步 / dsh 后台）**+ 主返回点**」
//   记为 5，并引了 `eng.mjs:665 / :719 / :790 / :918` 四个行号。**实测（接线落地后的当前值）**：
//   `deliverBookkeeping` 的调用点共 **4** 处 —— `lib/eng.mjs:747 / :802 / :874 / :1003`（与设计档
//   首部口径表一致）；初稿那四个行号是**接线前的旧值**（helper 插入后整体下移），**不是实测现值**。
//   而初稿所称「主返回点 :918 一带」与「dsh 同步」**是同一个返回点**（簿记调用与其同属一个
//   返回语句的 `return`）——「5」是把同一处数了两遍的产物。故本档按**实测 4** 接线，并把
//   「接线数 == 簿记数」做成**结构配对断言**（任何一处漏接或劈叉都会红），断言强度不降。
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { stageGateNote, buildCoderBrief, runEngCoder } from "../lib/eng.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"

process.env.DSH_HOME = ""
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const LIB_DIR = join(PLUGIN_DIR, "lib")
const ENG_SRC = readFileSync(join(LIB_DIR, "eng.mjs"), "utf8")

const BANNER_HEAD = "[thincoder-suite] stage verification: "

/** 一份合法的阶段状态表（契约列位：Stage | Status | check summary）。 */
const table = (rows) => ["| Stage | Status (passed/failed/skipped) | check summary |", "|---|---|---|", ...rows].join("\n")
const ALL_PASSED = table(["| 1 | passed | node --check lib/a.mjs |", "| 2 | passed | node --test test/a.test.mjs |"])
const ONE_FAILED = table(["| 1 | passed | ok |", "| 2 | failed | node --test test/b.test.mjs → red |", "| 3 | passed | ok |"])
/** 阶段列表：门只在**派遣带了 stages** 时才核验（§9 边界 1）。 */
const STAGES = [
  { goal: "g1", files: ["lib/a.mjs"], acceptance: "a", check: "node --check lib/a.mjs" },
  { goal: "g2", files: ["lib/b.mjs"], acceptance: "b", check: "node --test test/b.test.mjs" },
]

// ————————————— ① 判定三态 —————————————

test("T-SG1 (AC-9): 全 passed ⇒ 零横幅；任一 failed ⇒ 点名阶段号；表缺失 ⇒ UNDECLARED", () => {
  assert.equal(stageGateNote(STAGES, ALL_PASSED + "\n\nTouched files: lib/a.mjs"), "",
    "全 passed ⇒ **零横幅**（不许有噪声）")
  const failed = stageGateNote(STAGES, ONE_FAILED)
  assert.ok(failed.startsWith(BANNER_HEAD), "横幅必须走响亮通道：" + JSON.stringify(failed))
  assert.ok(failed.includes("FAILED stage 2"), "必须**点名阶段号**（只写「有阶段失败」不可诊断）：" + failed)
  assert.ok(!failed.includes("FAILED stage 1") && !failed.includes("FAILED stage 3"), "不得误伤通过阶段：" + failed)
  const undeclared = stageGateNote(STAGES, "delivered ok\n\nTouched files: lib/a.mjs")
  assert.ok(undeclared.includes("UNDECLARED"), "表缺失 ⇒ UNDECLARED：" + undeclared)
  assert.ok(undeclared.startsWith(BANNER_HEAD), "UNDECLARED 同样是响亮横幅")
})

test("T-SG2 (AC-10): skipped 无 summary ⇒ 横幅；skipped 带 summary ⇒ 零横幅", () => {
  const withReason = table(["| 1 | passed | ok |", "| 2 | skipped | 上游未交付该面，留待批 10 |"])
  assert.equal(stageGateNote(STAGES, withReason), "", "skipped **带** summary ⇒ 合法（不冤杀）")
  const noReason = table(["| 1 | passed | ok |", "| 2 | skipped |  |"])
  const out = stageGateNote(STAGES, noReason)
  assert.ok(out.includes("skipped without a summary 2"), "skipped 无理由必须点名：" + out)
  // 两族同时命中 ⇒ 用 ` · ` 连接（两条信息都不许丢）
  const both = table(["| 1 | failed | red |", "| 2 | skipped |  |", "| 3 | passed | ok |"])
  const bothOut = stageGateNote(STAGES, both)
  assert.ok(bothOut.includes("FAILED stage 1") && bothOut.includes("skipped without a summary 2"),
    "两类不合格必须同时报出：" + bothOut)
})

test("T-SG3 (§9 边界 1+2+3): 未带 stages ⇒ 不核验；缺列 / 超扫描窗 ⇒ UNDECLARED（宁响亮不猜）", () => {
  for (const s of [undefined, null, [], "stages"]) {
    assert.equal(stageGateNote(s, "no table here"), "", "未带 stages ⇒ 不核验（" + JSON.stringify(s) + "）")
  }
  // 断到 AC-9 声明的**确定结果**（都走 UNDECLARED 分支）。**不得**写成「两个调用相等」——
  // 若两者都返回空串，相等照样成立，断言会静默恒真（律 1：谓词必须写全结果，不是写全关系）。
  for (const emptyish of ["", "x"]) {
    const declared = stageGateNote(STAGES, emptyish)
    assert.ok(declared.includes("UNDECLARED"),
      "空报告与无表报告都必须判 UNDECLARED（实测报告 " + JSON.stringify(emptyish) + " ⇒ "
      + JSON.stringify(declared) + "）")
  }
  // 缺 check summary 列 ⇒ 按列位取值失败 ⇒ UNDECLARED（不是「猜成 skipped 无理由」）
  const twoCols = ["| Stage | Status |", "|---|---|", "| 1 | failed |"].join("\n")
  assert.ok(stageGateNote(STAGES, twoCols).includes("UNDECLARED"), "缺列 ⇒ UNDECLARED")
  // 表在头部但超出 4000 字符扫描窗 ⇒ UNDECLARED（契约要求表在**最前**，超窗即违约）
  const late = "x".repeat(4200) + "\n" + ONE_FAILED
  assert.ok(stageGateNote(STAGES, late).includes("UNDECLARED"), "超扫描窗 ⇒ UNDECLARED")
  const early = "pad\n" + ONE_FAILED
  assert.ok(stageGateNote(STAGES, early).includes("FAILED stage 2"), "窗内的表照常解析")
  // 表在头部之后仍能被找到（契约是「最前」，但门按扫描窗找表，不按行号猜）
  const headerless = ["some prose", "| Stage | Status | check summary |", "|---|---|---|", "| 1 | failed | red |"].join("\n")
  assert.ok(stageGateNote(STAGES, headerless).includes("FAILED stage 1"), "带前置散文的表仍可解析")
})

// ————————————— ② 接线（成功返回点全接，失败/abort 返回点零接） —————————————

test("T-SG4 (AC-11 / 锚 N5): 每个成功交付返回点各调一次 stageGateNote；失败/abort 返回点零接线；零新执行面", () => {
  const callSites = (ENG_SRC.match(/stageGateNote\(/g) ?? []).length - 1 // 减去函数定义自身
  const bookkeepingSites = (ENG_SRC.match(/deliverBookkeeping\(/g) ?? []).length - 1
  assert.equal(bookkeepingSites, 4, "簿记调用点实测 = 4（codex 同步/后台 + dsh 同步/后台）")
  assert.equal(callSites, bookkeepingSites,
    "**结构配对**：门必须与簿记**同点同数**（漏接 ⇒ 门按路径劈叉；多接 ⇒ 在无交付处加横幅）")

  // 四个成功返回点的**逐点**接线断言（每个都是独立的返回语句）
  const POINTS = [
    ["codex 后台", "output: stageGateNote(stages, env.text) + deliveryText(env.text)"],
    ["codex 同步", "return stageGateNote(stages, env.text) + deliveryText(env.text) + capNote"],
    ["dsh 后台", 'output: stageGateNote(stages, outputText) + warnPrefix() + "eng_coder delivery:\\n"'],
    ["dsh 同步", 'return stageGateNote(stages, outputText) + warnPrefix() + "eng_coder delivery:\\n"'],
  ]
  for (const [label, needle] of POINTS) {
    assert.ok(ENG_SRC.includes(needle), label + " 成功返回点未接线（缺：" + needle + "）")
  }

  // 反向：失败 / abort 返回点**一律不含**门调用（逐 return 语句判）
  const returns = ENG_SRC.split("\n").filter((l) => /\breturn\b/.test(l))
  const failureish = returns.filter((l) => /status: "failed"|failureText\(|eng_coder error|eng_coder aborted|eng_coder ended|failed to start/.test(l))
  assert.ok(failureish.length >= 8, "失败/abort 返回点应被识别到（实测 " + failureish.length + " 条）")
  for (const l of failureish) {
    assert.ok(!l.includes("stageGateNote"), "失败/abort 返回点不得接门：" + l.trim().slice(0, 120))
  }
  // 门调用只出现在成功返回点上（4 条，且都携带交付文本）
  const wired = returns.filter((l) => l.includes("stageGateNote"))
  assert.equal(wired.length, 4, "门调用点必须恰为 4 条 return/字段语句（实测 " + wired.length + "）")
  for (const l of wired) {
    assert.ok(/deliveryText\(|eng_coder delivery:/.test(l), "接线点必须携带交付文本：" + l.trim().slice(0, 120))
  }

  // 零新执行面：`lib/**` 的子进程调用点计数不变（门**纯解析**，不得 spawn）
  const hits = readdirSync(LIB_DIR).filter((f) => f.endsWith(".mjs"))
    .reduce((n, f) => n + (readFileSync(join(LIB_DIR, f), "utf8").match(/child_process/g) ?? []).length, 0)
  assert.equal(hits, 1, "`lib/**` 的子进程调用点计数必须仍为 1（仅 codex 适配器）——实测 " + hits)
})

// ————————————— ③ 端到端：横幅前置 + 报告正文一字不改 + 失败路径反向 —————————————

const mkHome = () => mkdtempSync(join(tmpdir(), "thincoder-sg-"))
const rmHome = (h) => { try { rmSync(h, { recursive: true, force: true }) } catch { /* 已清理 */ } }

/** eng 会话 fixture：engineering=true + 有效 token（两段式 uuid:expiresAt）。 */
function makeEngState(id) {
  const state = sessionState(id)
  state.engineering = true
  state.designToken = randomUUID() + ":" + (Date.now() + 3600_000)
  return state
}

/** deps stub：subagents.start 收集 request，并按 `report` / `stopReason` 返回交付。 */
function makeDeps(id, home, started, report, stopReason) {
  const subagents = {
    async start(kind, req) {
      started.push(req)
      return {
        result: Promise.resolve({ output: [{ type: "text", text: report }], stopReason, diagnostic: null }),
        dispose: async () => {},
      }
    },
  }
  const llm = {
    async resolveModelInfo() {
      return { reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }], defaultEffort: "low" } }
    },
  }
  return {
    ctx: { subagents, llm },
    agent: { session: { id, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
    config: {}, signal: undefined, configDefaultEngineering: false, storPathOverride: home,
  }
}

test("T-SG5 (US-8 / US-9): 端到端——横幅落在交付文本**前部**，报告正文一字不改；失败交付整条不接门", async () => {
  const home = mkHome()
  try {
    // (1) 成功 + 报告自报 stage 2 failed ⇒ 横幅在前，正文逐字保留
    const sid = "sg-e2e-" + randomUUID()
    makeEngState(sid)
    const report = ONE_FAILED + "\n\nTouched files: lib/a.mjs, docs/x.md"
    const out = await runEngCoder(makeDeps(sid, home, [], report, "completed"), {
      task: "implement the staged design", designToken: sessionState(sid).designToken, stages: STAGES,
    })
    assert.ok(out.startsWith(BANNER_HEAD), "横幅必须在交付文本**最前**：" + JSON.stringify(out.slice(0, 80)))
    assert.ok(out.includes("FAILED stage 2"), "点名阶段号")
    assert.ok(out.includes(report), "报告正文必须**一字不改**地在位（主代理要靠它发修复轮）")
    assert.ok(out.includes("eng_coder delivery:"), "交付信封照旧（不阻断）")
    // 簿记语义零改动：`Touched files:` 尾行仍被簿记解析（touchedFiles 合并照常）
    assert.ok(sessionState(sid).touchedFiles.includes("lib/a.mjs"), "簿记照常消费尾行")
    assert.equal(sessionState(sid).mutatedThisRun, true, "簿记语义零改动（mutated 照常置位）")
    dropSession(sid)

    // (2) 成功 + 报告合规 ⇒ 零横幅（同一条链路，证明横幅不是无条件附加）
    const sid2 = "sg-e2e2-" + randomUUID()
    makeEngState(sid2)
    const clean = ALL_PASSED + "\n\nTouched files: lib/a.mjs"
    const out2 = await runEngCoder(makeDeps(sid2, home, [], clean, "completed"), {
      task: "implement the staged design", designToken: sessionState(sid2).designToken, stages: STAGES,
    })
    assert.ok(out2.startsWith("[thincoder-suite] warning:") || out2.startsWith("eng_coder delivery:"),
      "合规报告 ⇒ 零横幅（文本以既有通道或交付信封开头）：" + JSON.stringify(out2.slice(0, 80)))
    assert.ok(!out2.includes("stage verification:"), "合规报告不得出现门横幅")
    dropSession(sid2)

    // (3) 反向：失败交付（stopReason !== completed）**整条不接门**——即使带 stages 且报告里有 failed 行
    const sid3 = "sg-e2e3-" + randomUUID()
    makeEngState(sid3)
    const out3 = await runEngCoder(makeDeps(sid3, home, [], ONE_FAILED, "failed"), {
      task: "implement the staged design", designToken: sessionState(sid3).designToken, stages: STAGES,
    })
    assert.ok(out3.includes("eng_coder ended: failed"), "失败交付走既有失败路径：" + out3.slice(0, 120))
    assert.ok(!out3.includes("stage verification:"), "失败/abort 返回点不得加门横幅")
    assert.equal(sessionState(sid3).mutatedThisRun, false, "失败交付不簿记（语义零改动）")
    dropSession(sid3)

    // (4) 未带 stages 的派遣 ⇒ 不核验（既有行为逐字不变：报告不合规也不出横幅）
    const sid4 = "sg-e2e4-" + randomUUID()
    makeEngState(sid4)
    const out4 = await runEngCoder(makeDeps(sid4, home, [], ONE_FAILED, "completed"), {
      task: "implement the staged design", designToken: sessionState(sid4).designToken,
    })
    assert.ok(!out4.includes("stage verification:"), "未带 stages ⇒ 不核验（§9 边界 1）")
    assert.ok(out4.includes("eng_coder delivery:"))
    dropSession(sid4)
  } finally {
    rmHome(home)
  }
})

test("T-SG6 (D9-11 / AC-14): 门不碰任务书——T9 fixture 逐字节未动，brief 渲染零改动", () => {
  const fixture = readFileSync(join(PLUGIN_DIR, "test", "fixtures", "coder-brief-with-docs.txt"))
  const actual = Buffer.from(
    buildCoderBrief("implement the design doc", ["docs/2026-09-02-session-state-stages-design.md", "docs/other.md"]),
    "utf8",
  )
  assert.ok(Buffer.compare(actual, fixture) === 0,
    "T9 fixture 必须逐字节不变（批 9 零 brief 改动 ⇒ 零触碰基线锁）：实得 " + actual.length + " 字节 / fixture " + fixture.length + " 字节")
  assert.ok(!ENG_SRC.includes("stageGateNote(task"), "门只读**交付报告与 stages 清单**，不得读任务书")
  // 门函数体切片（到下一个 export 为止）：不得调用任务书渲染 / 不得碰簿记（单一职责）
  const body = ENG_SRC.slice(ENG_SRC.indexOf("export function stageGateNote"), ENG_SRC.indexOf("export function makeWriteGate"))
  assert.ok(body.length > 0, "门函数体切片可定位")
  for (const banned of ["buildCoderBrief", "renderStagesBlock", "deliverBookkeeping", "child_process"]) {
    assert.ok(!body.includes(banned), "门函数体不得出现 " + banned + "（门与任务书/簿记/执行面三者解耦）")
  }
})
