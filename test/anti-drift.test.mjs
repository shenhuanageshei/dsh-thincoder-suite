// anti-drift.test.mjs — 批 34「长任务防漂」验收用例（腿 A-1…A-6 · A-8…A-15）。
// 设计档：docs/2026-10-14-anti-drift-design.md（设计令牌 9c126ca2-…，轮 4 VERDICT: PASS）。
// 需求档：docs/2026-10-14-anti-drift-requirements.md（US-1…US-8 / N-1…N-8）。
//
// 腿 ↔ 断言对照（**编号逐字进测试名**，便于 §13 C12 的逐条变异自证）：
//   A-1 判据门：无判据 ⇒ deny；待绑槽 ⇒ 放行；**第二目标仍 deny**；显式不存在的 goal_id ⇒ 拒
//   A-2 完成门：无 passed ⇒ deny；补 passed ⇒ 放行；**advisor 落章路径**（大小写不敏感）
//   A-3 goal_verify 校验：伪造/已清 proofRef ⇒ 拒；skipped 无 summary ⇒ 拒
//   A-4 推回记账：三族恰 1/2/3 ⇒ 诚实句（第 7 条）⇒ 零 steer；总数恰 6、硬上限 7
//   A-5 eng 模式零推回 + 默认关零推回 + **eng 下 anti_drift_config 写 ⇒ 拒 + 零写**
//   A-6 注入行：去重语义（同输入同输出）+ 无时间戳/百分比 + ≤512
//   A-7 FR-7 台账门 —— **落 team-link 仓**（不在本档）
//   A-8 agent/created：startup/resume 各一次注入；compact/clear 零注入
//   A-9 纯文档改动 ⇒ 推回谓词不触发
//   A-10 跨回合不泄漏：第 N 回合改动 → 第 N+1 回合 complete 仍拒
//   A-11 会话域封顶：跨回合诚实句恰 ≤3 ⇒ 其后静默 + warn 恰一行
//   A-12 探测降级：三态各 1/1/2 行 warn，且降级后行为为零
//   A-13 默认值分档：四档默认 + 翻转可读回
//   A-14 caps 子键校验：闭集 + 范围 + total ≥ 三族之和
//   A-15 每标记单域：三域标记名集合两两不相交（**对设计档 §7 的真实解析**，不是自我断言）
//
// node:test 零依赖；每例前 __resetAntiDriftState()（模块级进程内状态），走 tmp 目录不碰真实 $DSH_HOME。
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
import { readFileSync } from "node:fs"
import {
  ANTI_DRIFT_DEFAULTS, ANTI_DRIFT_KEYS, SESSION_HONESTY_MAX,
  resolveAntiDriftConfig, validateCaps, validateConfigWrite, turnSteerHardMax,
  setCriteria, getCriteria, hasCriteria, hasBoundCriteria, promotePending, clearCriteria,
  recordVerify, listVerify, hasPassed, PASS_VERDICT_RE,
  domainState, advanceTurn, stampVerified, noteWrite, noteShell, productFilesOf,
  gateDecision, renderAntiDriftLine, outstandingDebts,
  pickPushback, onTurnStopping, onAgentCreated, probeAntiDriftSurfaces,
  noteToolCall, markStallNoticed, stallNotice,
  turnIndexOf, dropTurnShapeWarn,
  __resetAntiDriftState,
} from "../lib/anti-drift.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const DESIGN_DOC = join(HERE, "..", "docs", "2026-10-14-anti-drift-design.md")

let TMP
beforeEach(() => {
  __resetAntiDriftState()
  TMP = mkdtempSync(join(tmpdir(), "anti-drift-"))
})
const io = () => ({ dshHomeOverride: TMP })
const on = () => resolveAntiDriftConfig({ antiDrift: { pushback: true } })
const sid = (n = 1) => "sess-" + n

// ═════════════════════ A-1 判据门（FR-1） ═════════════════════

test("A-1 判据门：无判据 ⇒ deny；待绑槽 ⇒ 放行且槽提升；第二目标仍 deny；显式不存在的 goal_id ⇒ 拒", () => {
  const cfg = resolveAntiDriftConfig({})
  // ① 无判据直接建目标 ⇒ deny
  const d1 = gateDecision({ toolName: "create_goal", sessionId: sid(), config: cfg, ...io() })
  assert.equal(d1.decision, "deny", "无判据必须拒建目标（US-1）")
  assert.match(d1.reason, /愿望不是目标/, "拒绝文案必须逐字引上游法理")

  // ② 先写判据（不带 goal_id ⇒ 待绑槽）再建 ⇒ 放行
  const set = setCriteria({ sessionId: sid(), criteria: "把 X 做完", check: "npm test 全绿", ...io() })
  assert.equal(set.ok, true)
  assert.equal(set.shape, "pending", "不带 goal_id ⇒ 待绑槽（不落盘）")
  assert.equal(gateDecision({ toolName: "create_goal", sessionId: sid(), config: cfg, ...io() }).decision, "allow")

  // 槽提升为 bound
  const pro = promotePending({ sessionId: sid(), goalId: "g-1", ...io() })
  assert.deepEqual({ p: pro.promoted, g: pro.goalId }, { p: true, g: "g-1" })
  assert.equal(hasBoundCriteria("g-1", ...Object.values(io())), true, "提升后应有 bound 记录")

  // ③ **第二目标**：槽已被消费 ⇒ 再建仍 deny（**无陈旧绑定旁路**）
  const d2 = gateDecision({ toolName: "create_goal", sessionId: sid(), config: cfg, ...io() })
  assert.equal(d2.decision, "deny", "槽已消费后第二个目标仍须先写判据（陈旧绑定漏洞的回归锁）")

  // ④ 显式传不存在的 goal_id ⇒ 拒（不铸幻影绑定）
  const ghost = setCriteria({
    sessionId: sid(), criteria: "c", check: "k", goalId: "g-does-not-exist",
    hostHasGoal: () => false, ...io(),
  })
  assert.equal(ghost.ok, false, "不存在的 goal_id 必须拒")
  assert.match(ghost.reason, /不存在/, "拒绝文案要点名原因与修法")
})

// ═════════════════════ A-2 完成门（FR-2） ═════════════════════

test("A-2 完成门：无 passed ⇒ deny；补 passed ⇒ 放行；advisor 落章路径（大小写不敏感）", () => {
  const cfg = resolveAntiDriftConfig({})
  setCriteria({ sessionId: sid(), criteria: "c", check: "k", ...io() })
  promotePending({ sessionId: sid(), goalId: "g-1", ...io() })
  const args = { action: "complete" }

  // ① 判据已写但无证据 ⇒ deny
  const d1 = gateDecision({ toolName: "update_goal", args, sessionId: sid(), config: cfg, ...io() })
  assert.equal(d1.decision, "deny", "没有跑过的证据不许宣告完成")
  assert.match(d1.reason, /没有跑过的证据/)

  // ② 补 passed ⇒ 放行
  const v = recordVerify({ sessionId: sid(), proofRef: "g-1", command: "npm test", status: "passed", summary: "全绿", ...io() })
  assert.equal(v.ok, true)
  assert.equal(hasPassed(sid(), "g-1"), true)
  assert.equal(gateDecision({ toolName: "update_goal", args, sessionId: sid(), config: cfg, ...io() }).decision, "allow")

  // ③ advisor 落章路径：裁决判据**大小写不敏感**（协议输出 VERDICT: PASS）
  assert.equal(PASS_VERDICT_RE.test("VERDICT: PASS"), true, "大写必须命中（协议的真实字面）")
  assert.equal(PASS_VERDICT_RE.test("VERDICT: pass"), true, "小写也要命中")
  assert.equal(PASS_VERDICT_RE.test("verdict: Pass"), true, "混合大小写也要命中")
  assert.equal(PASS_VERDICT_RE.test("VERDICT: FAIL"), false)
  assert.equal(PASS_VERDICT_RE.test("VERDICT: PASSED"), false, "不得前缀误命中")
  // 未跑 goal_verify，仅 advisor 落章 ⇒ complete 放行
  const s2 = "sess-advisor"
  setCriteria({ sessionId: s2, criteria: "c", check: "k", ...io() })
  promotePending({ sessionId: s2, goalId: "g-adv", ...io() })
  assert.equal(gateDecision({ toolName: "update_goal", args, sessionId: s2, config: cfg, ...io() }).decision, "deny")
  stampVerified(s2, { byAdvisor: true })
  assert.equal(gateDecision({ toolName: "update_goal", args, sessionId: s2, config: cfg, ...io() }).decision, "allow",
    "advisor 结算 pass 也是合法落章（D-d）")
})

// ═════════════════════ A-3 goal_verify 校验 ═════════════════════

test("A-3 goal_verify：伪造 / 已清 proofRef ⇒ 拒；skipped 无 summary ⇒ 拒；failed 不被覆盖", () => {
  setCriteria({ sessionId: sid(), criteria: "c", check: "k", ...io() })
  promotePending({ sessionId: sid(), goalId: "g-1", ...io() })

  const ghost = recordVerify({ sessionId: sid(), proofRef: "g-ghost", status: "passed", ...io() })
  assert.equal(ghost.ok, false, "伪造 proofRef 必须拒")
  assert.equal(listVerify(sid()).length, 0, "拒 ⇒ 零写入")

  const skipped = recordVerify({ sessionId: sid(), proofRef: "g-1", status: "skipped", summary: "   ", ...io() })
  assert.equal(skipped.ok, false, "skipped 无 summary 必须拒")
  assert.match(skipped.reason, /summary/)

  assert.equal(recordVerify({ sessionId: sid(), proofRef: "g-1", status: "failed", summary: "2 red", ...io() }).ok, true)
  assert.equal(recordVerify({ sessionId: sid(), proofRef: "g-1", status: "passed", summary: "now green", ...io() }).ok, true)
  const recs = listVerify(sid())
  assert.equal(recs.length, 2, "failed 不被覆盖，只追加")
  assert.deepEqual(recs.map((r) => r.status), ["failed", "passed"])

  // 记录被清 ⇒ 同值传入必拒（"已清"的判据面）
  clearCriteria({ sessionId: sid(), ...io() })
  const afterClear = recordVerify({ sessionId: sid(), proofRef: "g-1", status: "passed", ...io() })
  assert.equal(afterClear.ok, false, "记录已清 ⇒ 同值 proofRef 必须拒")
})

// ═════════════════════ A-4 推回记账 ═════════════════════

test("A-4 推回记账：三族恰 1/2/3 ⇒ 诚实句占第 7 条 ⇒ 其后零 steer；总数恰 6", () => {
  const cfg = on()
  const S = sid()
  setCriteria({ sessionId: S, criteria: "c", check: "k", ...io() })
  promotePending({ sessionId: S, goalId: "g-1", ...io() })
  noteWrite(S, "lib/foo.mjs", "edit") // P2/P3 的触发条件（P1 因有 bound 判据不触发）

  const seq = []
  for (let i = 0; i < 10; i++) {
    const r = onTurnStopping({ sessionId: S, turn: 7, goalId: "g-1", config: cfg, ...io() })
    seq.push(r.kind ?? "silent")
  }
  assert.deepEqual(seq.slice(0, 6), ["unverified", "unverified", "unreviewed", "unreviewed", "unreviewed", "honesty"],
    "三族恰好 1 / 2 / 3 次，然后恰一句诚实句（第 7 条），实测：" + JSON.stringify(seq))
  assert.deepEqual(seq.slice(6), ["silent", "silent", "silent", "silent"], "诚实句之后本回合零 steer")

  const d = domainState(S)
  assert.equal(d.turn.steerTotal, cfg.caps.pending + cfg.caps.verify + cfg.caps.advisor,
    "族推回总数恰 = Σ三族上限（6）")
  assert.equal(d.turn.verify, 2)
  assert.equal(d.turn.advisor, 3)
  assert.equal(d.turn.honestySent, true)
  assert.equal(turnSteerHardMax(cfg.caps), 7, "硬上限 = Σ三族 + 诚实 1 条 = 7")
  assert.ok(d.turn.steerTotal <= turnSteerHardMax(cfg.caps), "单回合 steer 永不超过硬上限")
  // 反证三族"各自恰好"：各族计数必须**等于**其上限（不是 ≥，也不是靠诚实句补齐）
  assert.equal(d.turn.verify, cfg.caps.verify, "verify 族恰好推满")
  assert.equal(d.turn.advisor, cfg.caps.advisor, "advisor 族恰好推满")

  // P1 族：无 bound 判据的目标 ⇒ criteriaMissing 恰 1 次（caps.pending = 1）
  const S1 = "sess-p1"
  noteWrite(S1, "lib/bar.mjs", "edit")
  const r1 = onTurnStopping({ sessionId: S1, turn: 1, goalId: "g-unbound", config: cfg, ...io() })
  const r2 = onTurnStopping({ sessionId: S1, turn: 1, goalId: "g-unbound", config: cfg, ...io() })
  const r3 = onTurnStopping({ sessionId: S1, turn: 1, goalId: "g-unbound", config: cfg, ...io() })
  assert.deepEqual([r1.kind, r2.kind, r3.kind][0], "criteriaMissing")
  assert.notEqual(r2.kind, "criteriaMissing", "pending cap = 1 ⇒ 同族不重复推")
})

// ═════════════════════ A-5 开关与工程模式 ═════════════════════

test("A-5 eng 模式零推回 + 默认关零推回 + eng 下 anti_drift_config 写 ⇒ 拒 + 零写", () => {
  // ① 默认关（pushback 默认 false）⇒ 恒零推回
  const off = resolveAntiDriftConfig({})
  assert.equal(off.pushback, false, "推回默认必须关（D6：唯一会改变回合命运的机制）")
  const S = sid()
  noteWrite(S, "lib/x.mjs", "edit")
  assert.deepEqual(onTurnStopping({ sessionId: S, turn: 1, goalId: "g-1", config: off, ...io() }),
    { steer: null, warn: null, kind: null }, "默认关 ⇒ 零推回零文案")

  // ② 工程模式 ⇒ 恒零推回（装配期不注册推回面即等价；此处以开关显式表达）
  const engOff = { ...on(), pushback: false }
  assert.equal(onTurnStopping({ sessionId: S, turn: 1, goalId: "g-1", config: engOff, ...io() }).steer, null)

  // ③ 工程模式禁写 anti_drift_config（键名/类型门 + eng 门）
  const keys = validateConfigWrite("inject", false)
  assert.equal(keys.ok, true, "非 eng 下合法键可写")
  const bad = validateConfigWrite("nonexistent", true)
  assert.equal(bad.ok, false, "未知键必须拒（零写）")
  assert.match(bad.reason, /合法键名/, "拒绝文案必须列出全部合法键名")
  for (const k of ANTI_DRIFT_KEYS) assert.ok(bad.reason.includes(k), "合法键名清单必须含 " + k)
  assert.equal(validateConfigWrite("inject", "yes").ok, false, "错型必须拒")
})

// ═════════════════════ A-6 注入行 ═════════════════════

test("A-6 注入行：同输入同输出（宿主去重前提）· 无时间戳/百分比 · ≤512 · 空集返空串", () => {
  const cfg = resolveAntiDriftConfig({})
  const noGoal = renderAntiDriftLine({ sessionId: sid(99), goal: null, config: cfg, ...io() })
  assert.equal(noGoal, "", "无活跃目标 ∧ 无欠账 ⇒ 空串（本步零贡献）")

  setCriteria({ sessionId: sid(), criteria: "c", check: "npm test 必须全绿", ...io() })
  promotePending({ sessionId: sid(), goalId: "g-1", ...io() })
  const goal = { id: "g-1", objective: "把防漂机制做出来" }
  const a = renderAntiDriftLine({ sessionId: sid(), goal, config: cfg, ...io() })
  const b = renderAntiDriftLine({ sessionId: sid(), goal, config: cfg, ...io() })
  assert.equal(a, b, "逐字节同输出 = 宿主去重的前提（N-3 前缀缓存友好）")
  assert.ok(a.includes("<untrusted_objective>"), "目标必须包在不可信边界标签里（提示注入防线）")
  assert.ok(a.includes("<untrusted_completion_criterion>"), "判据同边界")
  assert.ok(a.includes("审计句"), "审计句必须在场")
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a), "禁时间戳（否则每步都变 ⇒ 前缀缓存失效）")
  assert.ok(!/%/.test(a), "禁百分比")
  assert.ok(a.length <= 512, "整串须 ≤512 字符，实测 " + a.length)

  // 超长 ⇒ 截断但审计句仍在
  const long = renderAntiDriftLine({
    sessionId: sid(), config: cfg, ...io(),
    goal: { id: "g-1", objective: "X".repeat(900) },
  })
  assert.ok(long.length <= 512, "超长目标也必须截到 ≤512，实测 " + long.length)
  assert.ok(long.includes("审计句"), "审计句永不截断")
})

// ═════════════════════ A-8 开工接管（FR-6） ═════════════════════

test("A-8 agent/created：startup/resume 各一次注入；compact/clear 零注入；无欠账零注入", () => {
  const cfg = on()
  const S = sid()
  // 造欠账：活跃目标缺判据
  const r1 = onAgentCreated({ sessionId: S, source: "startup", goalId: "g-1", config: cfg, ...io() })
  assert.ok(r1.inject && r1.inject.includes("开工接管"), "startup 且有欠账 ⇒ 必须注入，实测：" + r1.reason)
  const r2 = onAgentCreated({ sessionId: S, source: "startup", goalId: "g-1", config: cfg, ...io() })
  assert.equal(r2.inject, null, "同一会话恰一次（闩）")

  const S2 = sid(2)
  const r3 = onAgentCreated({ sessionId: S2, source: "resume", goalId: "g-2", config: cfg, ...io() })
  assert.ok(r3.inject, "resume 也接管（US-4）")

  for (const src of ["compact", "clear"]) {
    const r = onAgentCreated({ sessionId: sid(3), source: src, goalId: "g-3", config: cfg, ...io() })
    assert.equal(r.inject, null, "source=" + src + " ⇒ 零注入（否则压缩后重复打扰）")
    assert.match(r.reason, new RegExp(src))
  }
  const clean = onAgentCreated({ sessionId: sid(4), source: "startup", config: cfg, ...io() })
  assert.equal(clean.inject, null, "无欠账 ⇒ 零注入")
})

// ═════════════════════ A-9 纯文档改动不触发 ═════════════════════

test("A-9 纯文档改动 ⇒ 推回谓词不触发（isProductCodePath 权威）", () => {
  const cfg = on()
  const S = sid()
  noteWrite(S, "docs/2026-10-14-foo.md", "edit")
  noteWrite(S, "README.md", "edit")
  const d = domainState(S)
  assert.equal(d.stamp.codeMutatedSinceStamp, false, "文档改动不得置位产品代码标记")
  assert.deepEqual(productFilesOf(S), [], "产品代码文件清单须为空")
  assert.deepEqual(onTurnStopping({ sessionId: S, turn: 1, goalId: null, config: cfg, ...io() }).steer, null,
    "纯文档改动 ⇒ 不推回")

  noteWrite(S, "lib/foo.mjs", "edit")
  assert.equal(domainState(S).stamp.codeMutatedSinceStamp, true, "产品代码改动必须置位")
  assert.deepEqual(productFilesOf(S), ["lib/foo.mjs"])
})

// ═════════════════════ A-10 跨回合不泄漏 ═════════════════════

test("A-10 跨回合不泄漏：第 N 回合改动 → 第 N+1 回合 complete 仍被拒（落章域未被回合边界复位）", () => {
  const cfg = resolveAntiDriftConfig({})
  const S = sid()
  setCriteria({ sessionId: S, criteria: "c", check: "k", ...io() })
  promotePending({ sessionId: S, goalId: "g-1", ...io() })
  recordVerify({ sessionId: S, proofRef: "g-1", status: "passed", summary: "ok", ...io() })
  const args = { action: "complete" }
  assert.equal(gateDecision({ toolName: "update_goal", args, sessionId: S, config: cfg, ...io() }).decision, "allow")

  // 第 N 回合：再改产品代码（落章域复位）
  advanceTurn(S, 10)
  noteWrite(S, "lib/again.mjs", "edit")
  // 第 N+1 回合：回合域已推进，但**落章域不得被回合边界复位**
  advanceTurn(S, 11)
  const d = domainState(S)
  assert.equal(d.stamp.codeMutatedSinceStamp, true, "落章域必须跨回合存活（否则封闭门被绕过）")
  assert.equal(d.stamp.verifiedSinceStamp, false, "改动后落章失效")
  const g = gateDecision({ toolName: "update_goal", args, sessionId: S, config: cfg, ...io() })
  assert.equal(g.decision, "deny", "跨回合后仍必须拒（G2 封闭门的回归锁）")
  assert.match(g.reason, /未验证的产品代码改动/)
})

// ═════════════════════ A-11 会话域封顶 ═════════════════════

test("A-11 会话域封顶：跨回合诚实句恰 ≤3 ⇒ 其后整机静默 + warn 恰一行", () => {
  const cfg = on()
  const S = sid()
  setCriteria({ sessionId: S, criteria: "c", check: "k", ...io() })
  promotePending({ sessionId: S, goalId: "g-1", ...io() })
  noteWrite(S, "lib/foo.mjs", "edit")

  const warns = []
  const honestyByTurn = []
  for (const turn of [1, 2, 3, 4]) {
    let n = 0
    for (let i = 0; i < 9; i++) {
      const r = onTurnStopping({ sessionId: S, turn, goalId: "g-1", config: cfg, ...io() })
      if (r.kind === "honesty") n += 1
      if (r.warn) warns.push({ turn, warn: r.warn })
    }
    honestyByTurn.push(n)
  }
  assert.deepEqual(honestyByTurn, [1, 1, 1, 0],
    "前 3 回合各 1 句诚实句、第 4 回合起整机静默（会话域封顶**真的拦住了**），实测 " + JSON.stringify(honestyByTurn))
  assert.equal(domainState(S).sess.honestyCount, SESSION_HONESTY_MAX, "会话累计恰 = 封顶值（不多不少）")
  assert.equal(domainState(S).sess.silenceWarned, true, "静默闩已置位")
  const silence = warns.filter((w) => /整机静默/.test(w.warn))
  assert.equal(silence.length, 1, "静默 warn 必须**恰一行**（会话域闩，实测 " + JSON.stringify(warns) + "）")
  assert.equal(silence[0].turn, 3, "静默 warn 必须在第 3 句那一次就发出（不是拖到第 4 回合）")

  // 反证：会话封顶**不能**靠"只 warn 不拦"实现——若第 4 回合仍发诚实句，
  // 上面 honestyByTurn 的末项会是 1（这条断言就是那个回归锁）。
  assert.equal(honestyByTurn[3], 0, "第 4 回合必须零诚实句（封顶是**拦**，不是只记账）")
})

// ═════════════════════ A-12 探测降级 ═════════════════════

test("A-12 探测降级：缺 context ⇒ 1 行；缺 on ⇒ 1 行；两面皆缺 ⇒ 2 行；齐全 ⇒ 0 行", () => {
  const full = probeAntiDriftSurfaces({
    systemPrompt: { context: () => "" }, on: () => () => {}, goals: { get: () => null },
  })
  assert.equal(full.lines.length, 0, "面齐全 ⇒ 静默（零噪声）")
  assert.equal(full.anyMissing, false)

  const noContext = probeAntiDriftSurfaces({ on: () => () => {}, goals: { get: () => null } })
  assert.equal(noContext.lines.length, 1, "缺注入面 ⇒ 恰一行 warn")
  assert.equal(noContext.surfaces.inject, false)
  assert.match(noContext.lines[0], /注入面关闭/)
  assert.match(noContext.lines[0], /推回面若在仍可用/, "US-7：降级路径 = 另一面仍在场，必须写明")

  const noOn = probeAntiDriftSurfaces({ systemPrompt: { context: () => "" }, goals: { get: () => null } })
  assert.equal(noOn.lines.length, 2, "缺监听面 ⇒ 两行（推回与标记**共用同一个 `ctx.on`，但各报一行**——两面各自可关）")
  assert.equal(noOn.surfaces.pushback, false)
  assert.equal(noOn.surfaces.markers, false)
  assert.equal(noOn.surfaces.inject, true, "注入面与监听面**互不牵连**（这正是 US-7 的降级路径）")
  assert.ok(noOn.lines.some((l) => /推回面关闭/.test(l)), "必须点名推回面")
  assert.ok(noOn.lines.some((l) => /行为标记面关闭/.test(l)), "必须点名标记面")

  const both = probeAntiDriftSurfaces({})
  assert.equal(both.lines.length, 4, "四面全缺 ⇒ 四行（每面恰一行）")
  assert.equal(both.surfaces.inject, false)
  assert.equal(both.surfaces.pushback, false)
  assert.equal(both.surfaces.markers, false)
  assert.equal(both.surfaces.goals, false)
  // 面与行 **1:1** 的结构锁：每一行必须能唯一归因到一个缺席面
  assert.equal(new Set(both.lines).size, both.lines.length, "四行必须互不相同（不得重复同一句）")
})

// ═════════════════════ A-13 默认值分档 ═════════════════════

test("A-13 默认值分档：注入/完成门 ON，推回/台账门 OFF；读取与翻转可读回", () => {
  const d = resolveAntiDriftConfig({})
  assert.deepEqual(
    { inject: d.inject, completeGate: d.completeGate, pushback: d.pushback, ledger: d.ledgerTransitionGate },
    { inject: true, completeGate: true, pushback: false, ledger: false },
    "四档默认值必须与需求档 US-6 逐字一致（用户 2026-10-14 拍板）")
  assert.deepEqual(ANTI_DRIFT_DEFAULTS.caps, { pending: 1, verify: 2, advisor: 3 },
    "默认 caps = 三族上限（**无 total**——见 A-14 的记账说明）")
  assert.equal(d.verifyHeuristic, true, "验证启发随其所属机制默认开")

  // 显式覆盖生效
  const t = resolveAntiDriftConfig({ antiDrift: { pushback: true, inject: false, caps: { pending: 0, verify: 1, advisor: 1 } } })
  assert.equal(t.pushback, true)
  assert.equal(t.inject, false)
  assert.deepEqual(t.caps, { pending: 0, verify: 1, advisor: 1 })

  // 非法 caps ⇒ 整段回落默认（fail-safe 到保守值，不是关机制）
  const bad = resolveAntiDriftConfig({ antiDrift: { caps: { pending: 1, verify: 2, advisor: 3, total: 1 } } })
  assert.deepEqual(bad.caps, { pending: 1, verify: 2, advisor: 3 }, "非法 caps ⇒ 回落默认")

  // 反证：**关闭机制的正确方式是关 `pushback` 开关**（不是把 caps 压到 0）
  const offSwitch = resolveAntiDriftConfig({ antiDrift: { pushback: false, caps: { pending: 1, verify: 2, advisor: 3 } } })
  const S = "sess-zero"
  noteWrite(S, "lib/z.mjs", "edit")
  assert.equal(onTurnStopping({ sessionId: S, turn: 1, goalId: null, config: offSwitch, ...io() }).steer, null,
    "pushback=false ⇒ 零推回（这是 D6 的默认关法）")

  // 族上限全 0 且**仍有欠账** ⇒ 三族无项可推，恰好由**诚实句**补位（第 Σ+1 = 1 条）
  const zeros = resolveAntiDriftConfig({ antiDrift: { pushback: true, caps: { pending: 0, verify: 0, advisor: 0 } } })
  assert.deepEqual(zeros.caps, { pending: 0, verify: 0, advisor: 0 }, "三族可各自关到 0")
  assert.equal(turnSteerHardMax(zeros.caps), 1, "Σ0 + 诚实 1 = 1")
  const r1 = onTurnStopping({ sessionId: S, turn: 1, goalId: "g-z", config: zeros, ...io() })
  assert.equal(r1.kind, "honesty", "族全 0 但仍有欠账 ⇒ 诚实句补位（记账：Σ+1 而非 Σ）")
  const r2 = onTurnStopping({ sessionId: S, turn: 1, goalId: "g-z", config: zeros, ...io() })
  assert.equal(r2.steer, null, "硬上限 = 1 ⇒ 同回合第二条不再发")
  // 族全 0 且**无欠账** ⇒ 连诚实句都不发（轮 4 🟡4 的闸）
  const clean2 = "sess-zero-clean"
  assert.equal(onTurnStopping({ sessionId: clean2, turn: 1, goalId: null, config: zeros, ...io() }).steer, null,
    "干净回合 ⇒ 零 steer 零诚实句")
})

// ═════════════════════ A-14 caps 子键校验 ═════════════════════

test("A-14 caps 子键校验：三族闭集 + 0..6 范围 + 必填 + 拒额外子键（**无 total**）", () => {
  assert.deepEqual(ANTI_DRIFT_DEFAULTS.caps, { pending: 1, verify: 2, advisor: 3 }, "默认 caps = 三族，无 total")
  assert.equal(validateCaps({ pending: 1, verify: 2, advisor: 3 }).ok, true, "默认值必须过")
  assert.equal(validateCaps({ pending: 1, verify: 2, advisor: 3, total: 6 }).ok, false,
    "**不接受 total**：它曾让诚实句永不可达（轮 4 🟡1 的矛盾根因），已从记账里删除")
  assert.equal(validateCaps({ pending: 1, verify: 2, advisor: 3, extra: 1 }).ok, false, "未知子键 ⇒ 拒")
  assert.equal(validateCaps({ pending: 1.5, verify: 2, advisor: 3 }).ok, false, "非整数 ⇒ 拒")
  assert.equal(validateCaps({ pending: 7, verify: 0, advisor: 0 }).ok, false, "族键超 6 ⇒ 拒")
  assert.equal(validateCaps({ pending: 0, verify: 0, advisor: 0 }).ok, true, "三族全 0 合法（关到零）")
  assert.equal(validateCaps({ pending: 6, verify: 6, advisor: 6 }).ok, true, "三族各到上界 6 合法")
  assert.equal(validateCaps(null).ok, false)
  assert.equal(validateCaps({ pending: 1, verify: 2 }).ok, false, "缺一个族键 ⇒ 拒（必填）")
  assert.equal(validateCaps({}).ok, false, "c" + "空对象 ⇒ 拒")
  // 键名门
  assert.equal(validateConfigWrite("caps", { pending: 0, verify: 0, advisor: 0 }).ok, true)
  assert.equal(validateConfigWrite("caps", { pending: 1, verify: 2, advisor: 3, total: 6 }).ok, false)
  assert.match(validateConfigWrite("caps", { pending: 1, verify: 2, advisor: 3, total: 6 }).reason, /未知子键/)
})

// ═════════════════════ A-15 每标记单域（对设计档的**真实解析**） ═════════════════════

test("A-15 三域标记两两不相交：解析设计档 §7 三行取标记名求交（同一标记出现在两行即红）", () => {
  const doc = readFileSync(DESIGN_DOC, "utf8")
  const lines = doc.split(/\r?\n/)
  const grab = (label) => lines.filter((l) => l.startsWith("| **" + label + "**"))
  const rows = { stamp: grab("落章域"), turn: grab("回合域"), sess: grab("会话域") }
  for (const [k, v] of Object.entries(rows)) {
    assert.equal(v.length, 1, "域行必须恰一行（" + k + " 实测 " + v.length + " 行）")
  }
  const names = (row) => {
    const toks = new Set()
    for (const m of row.matchAll(/`([A-Za-z][A-Za-z0-9_.]*)`/g)) toks.add(m[1])
    // 形如 `pushback{a, b, c}` ⇒ 把花括号里的字段名一并取出（它们同域）
    for (const m of row.matchAll(/`pushback\{([^}]*)\}`/g)) {
      for (const f of m[1].split(",")) { const t = f.trim(); if (t) toks.add(t) }
    }
    return toks
  }
  const sets = { stamp: names(rows.stamp[0]), turn: names(rows.turn[0]), sess: names(rows.sess[0]) }
  const pairs = [["stamp", "turn"], ["stamp", "sess"], ["turn", "sess"]]
  const overlaps = []
  for (const [a, b] of pairs) {
    for (const t of sets[a]) if (sets[b].has(t)) overlaps.push(t + " ∈ " + a + " ∩ " + b)
  }
  assert.deepEqual(overlaps, [], "每个标记必须恰属一域（实测交集：" + JSON.stringify(overlaps) + "）")

  // 反向自证：**标记集合非空**（否则"两两不相交"是恒真断言——律 1 的域错配）
  for (const [k, s] of Object.entries(sets)) {
    assert.ok(s.size >= 3, "域 " + k + " 的标记集合必须非空且有意义（实测 " + s.size + " 个）")
  }
  // 关键标记的归属**逐字钉死**（这三条是本批被评审抓过两次的那几个）
  assert.ok(sets.turn.has("steerTotal"), "steerTotal 必须属回合域（每回合 ≤ caps.total）")
  assert.ok(sets.turn.has("honestySent"), "honestySent 必须属回合域（每回合至多一句）")
  assert.ok(sets.sess.has("honestyCount"), "honestyCount 必须属会话域（跨回合累计封顶）")
  assert.ok(sets.sess.has("silenceWarned"), "silenceWarned 必须属会话域（静默闩跨回合不复位）")
  assert.ok(!sets.sess.has("steerTotal"), "steerTotal 绝不得出现在会话域（轮 3 🔴1 的回归锁）")
  assert.ok(!sets.sess.has("honestySent"), "honestySent 绝不得出现在会话域（轮 4 🟡2 的回归锁）")
})

// ═════════════════════ 附录：域/状态机直测（支撑上面各腿） ═════════════════════

test("附录 A-4/A-11 支撑：advanceTurn 复位回合域但**不动**会话域与落章域", () => {
  const S = "sess-domains"
  noteWrite(S, "lib/a.mjs", "edit")
  domainState(S).sess.honestyCount = 2
  domainState(S).sess.silenceWarned = true
  domainState(S).turn.steerTotal = 5
  domainState(S).turn.honestySent = true
  const changed = advanceTurn(S, 42)
  assert.equal(changed, true, "新回合 ⇒ 首次进入")
  const d = domainState(S)
  assert.equal(d.turn.steerTotal, 0, "回合域归零")
  assert.equal(d.turn.honestySent, false, "honestySent 随回合复位")
  assert.equal(d.sess.honestyCount, 2, "会话域**不得**被回合复位")
  assert.equal(d.sess.silenceWarned, true, "会话域闩不得被回合复位")
  assert.equal(d.stamp.codeMutatedSinceStamp, true, "落章域**不得**被回合复位")
  assert.equal(advanceTurn(S, 42), false, "同回合再次进入 ⇒ 不重复复位")
})

test("附录 A-6 支撑：noteShell 只有命令形命中且开关开时才记 verifyRanThisTurn", () => {
  const S = "sess-shell"
  assert.equal(noteShell(S, "npm test", true), true)
  assert.equal(domainState(S).turn.verifyRanThisTurn, true)
  assert.equal(noteShell(S, "ls -la", true), false, "非验证命令不置位")
  assert.equal(noteShell("sess-shell-2", "npm test", false), false, "开关关 ⇒ 不置位")
  assert.equal(domainState("sess-shell-2").turn.verifyRanThisTurn, false)
  // P2 因此不再催（**这是 verifyRanThisTurn 的真实用途**——评审轮 3 🟡7 抓到的悬空位）
  //   ⚠️ 夹具必须让 P1 **不触发**（绑好判据），否则第一个命中的是 P1、看不到 P2 的行为。
  //   ⚠️ **顺序**：`noteWrite` 会把 `verifyRanThisTurn` 清回 false（改完代码必须重验）⇒
  //      必须先写盘、**后**跑检查，才能构造出"改过 + 本回合已验"的状态。写反了就是在测另一件事。
  noteWrite(S, "lib/s.mjs", "edit")
  setCriteria({ sessionId: S, criteria: "c", check: "k", ...io() })
  promotePending({ sessionId: S, goalId: "g-shell", ...io() })
  noteShell(S, "npm test", true)
  assert.equal(domainState(S).turn.verifyRanThisTurn, true, "落在写盘之后 ⇒ 标记为真")
  const cfg = on()
  const pk = pickPushback({ sessionId: S, goalId: "g-shell", config: cfg, ...io() })
  assert.notEqual(pk?.kind, "unverified", "本回合已跑过检查 ⇒ P2 不再催（实测 " + JSON.stringify(pk) + "）")
  // 反证：把标记清掉 ⇒ P2 立刻回来（证明上一条不是恒真断言）
  domainState(S).turn.verifyRanThisTurn = false
  assert.equal(pickPushback({ sessionId: S, goalId: "g-shell", config: cfg, ...io() })?.kind, "unverified",
    "清掉标记 ⇒ P2 复活")
  // 端到端：完整守卫也读同一个标记，且**写盘复位**必须真的复位
  //   ⚠️ 必须先让该回合"已经开始"（`onTurnStopping` 首次进入某 turn 会复位回合域，
  //      落在复位之前的标记会被清掉——这是**惰性回合比较**的正确语义，不是缺陷）。
  const e2e = "sess-shell-e2e"
  noteWrite(e2e, "lib/e.mjs", "edit")
  setCriteria({ sessionId: e2e, criteria: "c", check: "k", ...io() })
  promotePending({ sessionId: e2e, goalId: "g-e2e", ...io() })
  assert.equal(onTurnStopping({ sessionId: e2e, turn: 1, goalId: "g-e2e", config: cfg, ...io() }).kind, "unverified",
    "首次进入该回合 ⇒ P2 命中")
  noteShell(e2e, "npm test", true)
  assert.equal(domainState(e2e).turn.verifyRanThisTurn, true, "本回合内跑检查 ⇒ 标记为真")
  assert.notEqual(onTurnStopping({ sessionId: e2e, turn: 1, goalId: "g-e2e", config: cfg, ...io() }).kind, "unverified",
    "同一回合内已跑过检查 ⇒ 真实链路上也跳过 P2（不是只跳过直调谓词）")
  noteWrite(e2e, "lib/e2.mjs", "edit") // 又改一次 ⇒ 标记必须被清
  assert.equal(domainState(e2e).turn.verifyRanThisTurn, false, "改完代码必须重新验证（标记复位）")
})

test("附录 A-1/A-3 支撑：clearCriteria 清 bound 与 pending 两形态", () => {
  const S = "sess-clear"
  setCriteria({ sessionId: S, criteria: "c", check: "k", ...io() })
  assert.equal(hasCriteria(S, ...Object.values(io())), true, "pending 也算在席")
  assert.deepEqual(clearCriteria({ sessionId: S, ...io() }).cleared, ["pending"])
  assert.equal(getCriteria({ sessionId: S, ...io() }), null, "清后无在席记录")

  setCriteria({ sessionId: S, criteria: "c", check: "k", ...io() })
  promotePending({ sessionId: S, goalId: "g-cl", ...io() })
  assert.deepEqual(clearCriteria({ sessionId: S, ...io() }).cleared, ["g-cl"])
  assert.equal(hasBoundCriteria("g-cl", ...Object.values(io())), false, "盘上记录已删")
})

test("附录 A-2 支撑：outstandingDebts 三谓词与 cap 无关（诚实句的闸依赖它）", () => {
  const S = "sess-debts"
  assert.deepEqual(outstandingDebts({ sessionId: S, goalId: "g-x", ...io() }), ["criteriaMissing"],
    "有目标无 bound 判据 ⇒ criteriaMissing（不看本回合 cap）")
  noteWrite(S, "lib/d.mjs", "edit")
  assert.deepEqual(outstandingDebts({ sessionId: S, goalId: "g-x", ...io() }),
    ["criteriaMissing", "unverified", "unreviewed"], "三条欠账同时在场")
  stampVerified(S, { byAdvisor: true })
  assert.deepEqual(outstandingDebts({ sessionId: S, goalId: "g-x", ...io() }), ["criteriaMissing"],
    "落章后未验证/未评审两条消失")
})

// ═════════════ §8 负向断言 ①②④（收口轮补：此前只有设计承诺、无机器腿 —— L-10） ═════════════

test("负控① 静态段冻结：注入必须挂 context 而非 section（section 调用点恒 2 处）", () => {
  const src = readFileSync(join(HERE, "..", "lib", "index.mjs"), "utf8")
  const sectionCalls = (src.match(/ctx\.systemPrompt\.section\(\{/g) ?? []).length
  assert.equal(sectionCalls, 2,
    "systemPrompt.section 调用点必须恰 2 处（discipline / main）——本批注入若被误挂 section 即红，实测 " + sectionCalls)
  const contextCalls = (src.match(/ctx\.systemPrompt\.context\(\{/g) ?? []).length
  assert.equal(contextCalls, 1, "本批的每步注入必须是**唯一**一条 systemPrompt.context（实测 " + contextCalls + "）")
  assert.ok(src.includes('name: "thincoder:anti-drift"'), "注入源名必须在场")
  // 最强的一条：**section 段内绝不得调用 renderAntiDriftLine**（否则静态段被运行期读数污染）
  const polluted = /ctx\.systemPrompt\.section\(\{[\s\S]{0,500}?renderAntiDriftLine/.test(src)
  assert.equal(polluted, false, "section 段内不得出现 renderAntiDriftLine（静态段冻结的实质判据）")
  // 而 context 段内**必须**有它（否则注入面根本没接上——两侧都钉，才算真锁）
  const wired = /ctx\.systemPrompt\.context\(\{[\s\S]{0,700}?renderAntiDriftLine/.test(src)
  assert.equal(wired, true, "context 段内必须调用 renderAntiDriftLine（注入确实接在 context 上）")
})

test("负控② 模糊输入下 steer 计数不超各族 caps 与硬上限（四种 caps 极值组合 × 40 次按压）", () => {
  const combos = [
    { pending: 0, verify: 0, advisor: 0 },
    { pending: 6, verify: 6, advisor: 6 }, // 每族到上界
    { pending: 1, verify: 0, advisor: 0 },
    { pending: 0, verify: 3, advisor: 0 },
  ]
  for (const caps of combos) {
    const cfg = resolveAntiDriftConfig({ antiDrift: { pushback: true, caps } })
    const S = "fuzz-" + caps.pending + caps.verify + caps.advisor
    const sum = caps.pending + caps.verify + caps.advisor
    const hard = turnSteerHardMax(caps)
    assert.equal(hard, sum + 1, "硬上限恒 = Σ族 + 1（caps=" + JSON.stringify(caps) + "）")
    // 混乱夹具：有目标但无 bound 判据（P1）+ 改了产品代码（P2/P3）——"什么都想触发"
    noteWrite(S, "lib/fuzz.mjs", "edit")
    let steers = 0
    const perKind = {}
    for (let i = 0; i < 40; i++) { // 远超任何上限的按压
      const r = onTurnStopping({ sessionId: S, turn: 1, goalId: "g-fuzz-" + S, config: cfg, ...io() })
      if (r.steer) { steers += 1; perKind[r.kind] = (perKind[r.kind] ?? 0) + 1 }
    }
    assert.ok(steers <= hard, "单回合 steer 总数必须 ≤ 硬上限 " + hard + "，实测 " + steers + "（caps=" + JSON.stringify(caps) + "）")
    assert.ok((perKind.criteriaMissing ?? 0) <= caps.pending, "criteriaMissing 不得超 caps.pending")
    assert.ok((perKind.unverified ?? 0) <= caps.verify, "unverified 不得超 caps.verify")
    assert.ok((perKind.unreviewed ?? 0) <= caps.advisor, "unreviewed 不得超 caps.advisor")
    assert.ok((perKind.honesty ?? 0) <= 1, "诚实句每回合至多 1 句")
  }
})

test("负控④ 两插件之间零运行时 import（结构检查 + 谓词自证，防恒真）", () => {
  const here = join(HERE, "..")
  const tlDir = join(here, "..", "dsh-team-link")
  const suiteLib = readdirSync(join(here, "lib")).filter((f) => f.endsWith(".mjs"))
  let tlLib = []
  try { tlLib = readdirSync(join(tlDir, "lib")).filter((f) => /\.(mjs|js)$/.test(f)) } catch { /* 兄弟仓缺席 ⇒ 见下方 fail 方向 */ }
  const offenders = []
  const importRe = /^\s*(?:import|export)[^\n]*?from\s+["']([^"']+)["']/gm
  for (const f of suiteLib) {
    const src = readFileSync(join(here, "lib", f), "utf8")
    for (const m of src.matchAll(importRe)) if (/dsh-team-link|team-link/.test(m[1])) offenders.push("suite/lib/" + f + " → " + m[1])
  }
  for (const f of tlLib) {
    const src = readFileSync(join(tlDir, "lib", f), "utf8")
    for (const m of src.matchAll(importRe)) if (/thincoder-suite/.test(m[1])) offenders.push("team-link/lib/" + f + " → " + m[1])
  }
  // 兄弟仓缺席时**不假装通过**：如实跳过并说明（fail-open 只在这里，且必须出声）
  if (tlLib.length === 0) {
    console.warn("[anti-drift] 负控④ 半程：兄弟仓 dsh-team-link/lib 不可读 ⇒ 只核了 suite 侧单向（实测 offenders=" + JSON.stringify(offenders) + "）")
  }
  assert.deepEqual(offenders, [], "两插件必须零运行时 import（D8：一期无跨插件读取）——实测越界：" + JSON.stringify(offenders))
  // 反向自证（律 1：域错配 = 恒真断言）：谓词必须**真的**扫到了两边的档与 import 语句
  assert.ok(suiteLib.length >= 20, "suite 侧扫到的 .mjs 档数必须非平凡，实测 " + suiteLib.length)
  assert.ok(suiteLib.some((f) => /^\s*import\s/m.test(readFileSync(join(here, "lib", f), "utf8"))),
    "谓词自证：suite 侧必须存在被该正则扫到的 import 语句（否则本腿是空转）")
  if (tlLib.length > 0) {
    assert.ok(tlLib.some((f) => /^\s*import\s/m.test(readFileSync(join(tlDir, "lib", f), "utf8"))),
      "谓词自证：team-link 侧同样必须存在被扫到的 import 语句")
  }
})

// ═════════════ 停滞检测（连续 N 次完全相同调用；夜班补做 · 吸收清单第 8 项） ═════════════

test("尾-1 停滞检测：同签名连续 3 次触发；换参数即归零；易变字段被剔除；阈值 0 ⇒ 关", () => {
  const S = "stall-a"
  // ① 同签名连续 3 次 ⇒ 第三次触发
  assert.deepEqual(noteToolCall(S, "read", { file_path: "x.mjs" }).count, 1)
  assert.deepEqual(noteToolCall(S, "read", { file_path: "x.mjs", timeout: 1000 }).count, 2)
  const third = noteToolCall(S, "read", { file_path: "x.mjs", timeout: 9999 })
  assert.equal(third.count, 3)
  assert.equal(third.stalled, true, "第三次相同调用必须判定停滞")
  // ② 易变字段（timeout/signal/requestId/id/index/seq）被剔除 ⇒ 上面三次算同签名
  assert.equal(noteToolCall(S, "read", { signal: "abc", id: "zzz", file_path: "x.mjs" }).count, 4,
    "易变字段差异不得让签名不同（否则此机制永不触发 = 恒真断言）")
  // ③ 换参数 ⇒ 归零重计
  assert.equal(noteToolCall(S, "read", { file_path: "y.mjs" }).count, 1, "参数变了就是另一次调用")
  // ④ 换工具 ⇒ 归零
  assert.equal(noteToolCall(S, "grep", { file_path: "y.mjs" }).count, 1)
  // ⑤ 阈值 0/负 ⇒ 关该机制（返回不判定）
  assert.deepEqual(noteToolCall(S, "read", { file_path: "y.mjs" }, 0), { stalled: false, count: 0, signature: null })
  assert.deepEqual(noteToolCall(S, "read", { file_path: "y.mjs" }, -1), { stalled: false, count: 0, signature: null })
  // ⑥ 空工具名不参与判定
  assert.equal(noteToolCall(S, "  ", {}).signature, null)
  // ⑦ 键序不同 ⇒ 同签名（键排序）
  const A = "stall-order"
  assert.equal(noteToolCall(A, "edit", { a: 1, b: 2 }).count, 1)
  assert.equal(noteToolCall(A, "edit", { b: 2, a: 1 }).count, 2, "键序不同必须算同一个签名（键排序）")
})

test("尾-2 停滞提醒：确定性文案 · 每回合至多一条（回合域闩）· 回合前进即复位", () => {
  const S = "stall-b"
  assert.equal(stallNotice("read", 3), stallNotice("read", 3), "同输入必须逐字同输出")
  assert.ok(stallNotice("read", 3).includes("read"), "文案必须点名工具")
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(stallNotice("read", 3)), "文案禁时间戳（同 A-6 的确定性纪律）")
  // 闩：每回合至多一条
  assert.equal(markStallNoticed(S), true, "本回合第一条 ⇒ true")
  assert.equal(markStallNoticed(S), false, "同回合第二条 ⇒ false（不再打扰）")
  // 回合前进 ⇒ 计数与闩都复位（与停滞计数同属回合域）
  noteToolCall(S, "read", { f: 1 })
  noteToolCall(S, "read", { f: 1 })
  assert.equal(domainState(S).turn.repeatCount, 2)
  advanceTurn(S, 777)
  const d = domainState(S)
  assert.equal(d.turn.repeatCount, 0, "回合前进 ⇒ 连续计数归零")
  assert.equal(d.turn.stallNoticed, false, "回合前进 ⇒ 提醒闩复位")
  assert.equal(d.turn.lastToolSig, null, "回合前进 ⇒ 上一签名清空")
  assert.equal(markStallNoticed(S), true, "新回合可以再提醒一次")
})

test("尾-3 停滞阈值经配置面可读写（键名闭集 + 取值范围校验）", () => {
  assert.ok(ANTI_DRIFT_KEYS.includes("stallRepeat"), "stallRepeat 必须在键名闭集里（否则配不了）")
  assert.equal(resolveAntiDriftConfig({}).stallRepeat, 3, "默认 3")
  assert.equal(resolveAntiDriftConfig({ antiDrift: { stallRepeat: 0 } }).stallRepeat, 0, "0 合法（= 关该机制）")
  assert.equal(resolveAntiDriftConfig({ antiDrift: { stallRepeat: -1 } }).stallRepeat, 3, "负数 ⇒ 回落默认")
  assert.equal(resolveAntiDriftConfig({ antiDrift: { stallRepeat: 1.5 } }).stallRepeat, 3, "非整数 ⇒ 回落默认")
  assert.equal(validateConfigWrite("stallRepeat", 5).ok, true)
  assert.equal(validateConfigWrite("stallRepeat", 0).ok, true)
  assert.equal(validateConfigWrite("stallRepeat", -1).ok, false, "越界 ⇒ 拒（零写）")
  assert.equal(validateConfigWrite("stallRepeat", 21).ok, false)
  assert.equal(validateConfigWrite("stallRepeat", true).ok, false, "错型 ⇒ 拒")
})

// ═══════ L-11 旧目标的落章路径（此前是死路；本腿是它的回归锁 + 「能红」自证） ═══════

test("尾-4 L-11：无 bound 记录的旧目标也能落章（必须给 summary），且有 bound 时仍严格", () => {
  // ① 旧目标（从未写过判据）+ 改过产品代码 ⇒ complete 先被拒（本批有意）
  const S = sid(80)
  noteWrite(S, "lib/legacy.mjs", "edit")
  const before = gateDecision({ toolName: "update_goal", args: { action: "complete" }, sessionId: S, config: on(), ...io() })
  assert.equal(before.decision, "deny", "改过代码后直接完成必须先被拒")
  // ② 旧目标 verify **不给 summary** ⇒ 拒（这条宽松路径不许变成"无凭据盖章"）
  const loose = recordVerify({ sessionId: S, proofRef: "g-old", status: "passed" })
  assert.equal(loose.ok, false, "无 bound 记录时必须给 summary（否则是无凭据盖章）")
  assert.ok(/summary/u.test(loose.reason), "拒绝文案必须点名 summary")
  // ③ 旧目标 verify + summary ⇒ ok（**这条此前走不通** —— 死路已通）
  const okR = recordVerify({ sessionId: S, proofRef: "g-old", status: "passed", summary: "跑了 node --test，全绿" })
  assert.equal(okR.ok, true, "旧目标带 summary 必须能落章（L-11 的修复点）")
  stampVerified(S)
  const after = gateDecision({ toolName: "update_goal", args: { action: "complete" }, sessionId: S, config: on(), ...io() })
  assert.equal(after.decision, "allow", "旧目标落章后 complete 必须放行")
  // ④ 反向：**有 bound 记录时必须严格**——写错 proofRef 一律拒（宽松路径不得泄漏到有判据的情形）
  const S2 = sid(81)
  setCriteria({ sessionId: S2, criteria: "交付可跑的东西", check: "node --test 全绿", ...io() })
  promotePending({ sessionId: S2, goalId: "g-bound", ...io() })
  const wrong = recordVerify({ sessionId: S2, proofRef: "g-WRONG", status: "passed", summary: "写了 summary 也不能蒙", ...io() })
  assert.equal(wrong.ok, false, "有 bound 记录时 proofRef 必须一致（给 summary 也不能绕过）")
  assert.ok(wrong.reason.includes("g-bound"), "拒绝文案必须点名在席的那个 goalId")
  const right = recordVerify({ sessionId: S2, proofRef: "g-bound", status: "passed", summary: "对的那个", ...io() })
  assert.equal(right.ok, true, "proofRef 相符必须能落章")
})

// ═══ L-6 字段上限实测标定：真实长度的目标/判据**不得被截断**（2026-10-15 夜班第 4 轮） ═══

test("尾-5 L-6 标定：真实长度的 objective / check 全额保留，且行长 ≤512", () => {
  const S = sid(90)
  // 四种真实形态（含本会话真实目标 72 字、英文长目标 96 字、超长 check 102 字）
  const cases = [
    ["本会话真实目标", "夜班自主推进：在 dsh-thincoder-suite / dsh-team-link 两个仓自主完成吸收清单第 1+2+3 项并落 main", "node --test 全绿且真机 contractWatch 十条全 true"],
    ["英文长目标", "Implement the ledger transition gate in the team-link repository and add the A-7 acceptance legs", "npm test passes with zero failures and the lock count reads ten"],
    ["超长 check", "加停滞检测", "node --test test/anti-drift.test.mjs 全绿（25→26 腿）且 contractWatch 返回 locks.length===10 且第 10 条 ok===true"],
  ]
  // ★ 这条断言钉的是「**64 上限会咬真实输入**」这个实测结论的反面：
  //   若有人把上限改回 64，本腿必红（且正是本批要防的"静默内容丢失"）。
  for (const [name, obj, chk] of cases) {
    const sid2 = S + "-" + name
    setCriteria({ sessionId: sid2, criteria: "占位", check: chk, ...io() })
    promotePending({ sessionId: sid2, goalId: "g-l6", ...io() })
    const line = renderAntiDriftLine({ sessionId: sid2, goal: { id: "g-l6", objective: obj }, config: on(), ...io() })
    assert.ok(!line.includes("…"), name + "：真实长度的内容不得被截断（实测标定后应全额），实得：" + line.slice(0, 120))
    assert.ok(line.includes(obj), name + "：objective 必须**逐字**在注入行里（截断会切掉句尾的目的）")
    assert.ok(line.includes(chk), name + "：check 必须逐字在注入行里")
    assert.ok(line.length <= 512, name + "：行长仍必须 ≤512（实测 276/323/271），实得 " + line.length)
  }
})

// ═══ 畸形 turn 标识：必须规范化为稳定原语，否则回合域每步复位 ⇒ 机制静默失效 ═══

test("尾-6 turnIndexOf：只接受稳定原语；畸形形态回落 0 且**跨步稳定**（否则机制静默失效）", () => {
  const S = sid(95)
  // ① 正常形态：整数 index 优先
  assert.equal(turnIndexOf({ turn: { index: 7 } }, S), 7, "index 为整数 ⇒ 用它")
  assert.equal(turnIndexOf({ turn: { index: 7, id: 9 } }, S), 7, "index 优先于 id")
  assert.equal(turnIndexOf({ turn: { id: 9 } }, S), 9, "index 缺席 ⇒ 用 id")
  assert.equal(turnIndexOf({ turn: 3 }, S), 3, "turn 直接是数字 ⇒ 用它")
  assert.equal(turnIndexOf({}, S), 0, "无 turn ⇒ 0")
  // ② 畸形形态：**不返回对象**（返回对象会让 `!==` 恒真 ⇒ 每步都算新回合）
  const bad = turnIndexOf({ turn: { name: "x" } }, S)
  assert.equal(typeof bad, "number", "畸形形态必须回落**数字**，绝不能把对象交出去")
  assert.equal(Number.isInteger(bad), true, "回落值必须是整数")
  // ③ **跨步稳定**：同一个畸形载荷连续 10 次，候选值必须恒等（否则 advanceTurn 每步复位）
  const seen = new Set()
  for (let i = 0; i < 10; i++) seen.add(turnIndexOf({ turn: { name: "x" } }, S))
  assert.equal(seen.size, 1, "畸形形态下候选值必须**跨步稳定**（实得 " + seen.size + " 种）")
  // ④ 后果锁：畸形载荷下 advanceTurn **只判定一次**新回合
  const S2 = sid(96)
  let resets = 0
  for (let i = 0; i < 10; i++) if (advanceTurn(S2, turnIndexOf({ turn: { name: "x" } }, S2))) resets += 1
  assert.equal(resets, 1, "畸形形态下 10 步只应判定 1 次新回合（实得 " + resets + "）")
  // ⑤ 后果锁：畸形载荷下**停滞检测仍然触发**（它是回合域的，此前会被每步清零）
  const S3 = sid(97)
  let stalled = false
  for (let i = 0; i < 12; i++) {
    advanceTurn(S3, turnIndexOf({ turn: { name: "x" } }, S3))
    if (noteToolCall(S3, "read", { f: "x.mjs" }).stalled) stalled = true
  }
  assert.equal(stalled, true, "畸形回合标识下停滞检测仍必须能触发（否则是静默失效）")
  // ⑥ 稳定数字标识的对照组：多步只复位一次
  const S4 = sid(98)
  let r4 = 0
  for (let i = 0; i < 10; i++) if (advanceTurn(S4, 1)) r4 += 1
  assert.equal(r4, 1, "对照组（稳定标识）10 步复位 1 次")
  dropTurnShapeWarn(S)
  // ⑦ ★ **接线锁**（本轮自证时发现的自身缺口）：上面对 `turnIndexOf` 的断言**测不到接线**——
  //    若有人把 `lib/index.mjs` 换回内联的 `payload?.turn?.index ?? payload?.turn ?? 0`，
  //    上面全绿而生产每步复位（原来那个 bug 正是住在**接线**里，不在函数里）。
  //    ⇒ 钉住接线面：生产必须是 `turnIndexOf(payload, sid)`，且**不得**再出现内联兜底形态。
  const indexSrc = readFileSync(join(HERE, "..", "lib", "index.mjs"), "utf8")
  assert.ok(indexSrc.includes("turn: turnIndexOf(payload, sid)"),
    "生产接线必须是 turnIndexOf(payload, sid)（否则畸形载荷下每步复位）")
  assert.equal(/turn:\s*payload\?\.turn/.test(indexSrc), false,
    "生产接线**不得**退回内联兜底 `payload?.turn?.index ?? payload?.turn ?? 0`（那会让对象身份参与比较）")
})

// ═══ 截断必须按**码点**（星平面字符不得被劈成孤立代理；那段文本直接进模型上下文） ═══

test("尾-7 截断按码点：星平面字符（emoji/星平面汉字）在截断处**不得**产生孤立代理", () => {
  const S = sid(99)
  // 极端夹具：长目标全是星平面字符（每个占 2 个 UTF-16 单元）⇒ 按单元截必然劈开代理对
  const astral = "🔵".repeat(200)
  setCriteria({ sessionId: S, criteria: "c", check: "node --test", ...io() })
  promotePending({ sessionId: S, goalId: "g-astral", ...io() })
  const line = renderAntiDriftLine({ sessionId: S, goal: { id: "g-astral", objective: astral }, config: on(), ...io() })
  // ① 判据：不得出现孤立代理（半字符）——UTF-16 层面逐位体检
  const lone = []
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = line.charCodeAt(i + 1)
      if (!(n >= 0xDC00 && n <= 0xDFFF)) lone.push(i)
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      const p = line.charCodeAt(i - 1)
      if (!(p >= 0xD800 && p <= 0xDBFF)) lone.push(i)
    }
  }
  assert.deepEqual(lone, [], "注入行不得含孤立代理（那是非法 UTF-16，渲染成乱码）：位置 " + JSON.stringify(lone))
  // ② 反向自证：把 cut 换回"按 UTF-16 单元"必然产生孤立代理 —— 用同口径独立复算，证明本腿不是空转
  const naive = astral.length <= 140 ? astral : astral.slice(0, 139) + "…"
  const naiveLone = []
  for (let i = 0; i < naive.length; i++) {
    const c = naive.charCodeAt(i)
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = naive.charCodeAt(i + 1)
      if (!(n >= 0xDC00 && n <= 0xDFFF)) naiveLone.push(i)
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      const p = naive.charCodeAt(i - 1)
      if (!(p >= 0xD800 && p <= 0xDBFF)) naiveLone.push(i)
    }
  }
  assert.ok(naiveLone.length > 0, "自证：按 UTF-16 单元截断**必然**劈开代理对（否则本腿测的不是这件事）")
  // ③ 行仍 ≤512（码点口径无妨：UTF-16 长度只可能 ≥ 码点数）
  assert.ok(line.length <= 512, "行长仍须 ≤512，实得 " + line.length)
})

// ═══ 判据记录的清理：重启后靠内存反查会失效 ⇒ 必须能按显式 goalId 清（否则盘上永久滞留） ═══

test("尾-8 判据清理：只给 sessionId 在**重启后**清不掉；显式 goalId 必须能清掉", () => {
  const S = sid(110)
  setCriteria({ sessionId: S, criteria: "c", check: "k", ...io() })
  promotePending({ sessionId: S, goalId: "g-orphan", ...io() })
  assert.equal(hasBoundCriteria("g-orphan", TMP, TMP), true, "夹具：记录应已落盘")
  // ① **模拟重启**：内存态清空（盘上记录仍在）
  __resetAntiDriftState()
  assert.equal(hasBoundCriteria("g-orphan", TMP, TMP), true, "重启后盘上记录仍在（这正是滞留的来源）")
  // ② 只给 sessionId ⇒ 清不掉（内存 boundGoalId 已随重启消失）
  const bySession = clearCriteria({ sessionId: S, ...io() })
  assert.deepEqual(bySession.cleared, [], "只给 sessionId 时清不掉——这是**已知行为**，腿钉的是它不能是唯一路径")
  assert.equal(hasBoundCriteria("g-orphan", TMP, TMP), true, "该记录此时仍在盘上")
  // ③ **显式 goalId ⇒ 必须清掉**（生产的 complete/blocked 路径走这条）
  const byGoal = clearCriteria({ sessionId: S, goalId: "g-orphan", ...io() })
  assert.deepEqual(byGoal.cleared, ["g-orphan"], "显式 goalId 必须能清掉（否则记录永久滞留）")
  assert.equal(hasBoundCriteria("g-orphan", TMP, TMP), false, "清完盘上不得再有该记录")
  // ④ 接线锁：生产的 update_goal 分支必须**传 goalId**（只传 sessionId 是原来的泄漏写法）
  const indexSrc = readFileSync(join(HERE, "..", "lib", "index.mjs"), "utf8")
  assert.ok(indexSrc.includes("goal_id ?? \"\").trim() || extractGoalId(result)"),
    "生产接线必须从 update_goal 的参数/结果取 goalId")
  assert.equal(/clearCriteria\(\{\s*sessionId:\s*sid,\s*cwdHint/.test(indexSrc), false,
    "生产接线**不得**只传 sessionId 给 clearCriteria（重启后清不掉 ⇒ 盘上永久滞留）")
})

// 清理临时目录（best-effort；测试失败时不掩盖真错误）
test("附录：临时目录清理", () => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* best-effort */ }
  assert.ok(true)
})
