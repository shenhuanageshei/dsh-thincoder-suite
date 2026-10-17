// tasks.test.mjs — 批 36「个人任务台账 + 侧栏看板」机检腿（设计档 §九 = 权威腿定义）。
//
// 腿清单（**T-1…T-15，T-4 拆 a/b ⇒ 共 16 条**；本档顶层 `test(` 数 = 16，与下方逐条一一对应）：
//   T-1  无凭据 done ⇒ 拒且零写入（sha256 前后相同）
//   T-2  blocked 缺 reason / 缺 blockedBy ⇒ 拒且零写入
//   T-3  非法迁移被拒（**全表 25 组逐对**）＋ 同一道门的另一半：`applyTaskUpdate` 的可改字段**闭集**
//        （直接调写门）＋ **工具路径**同门（越界键 ⇒ 拒且零写入；旧实现在这里**静默丢弃**）
//   T-4a 看板 ≡ 工具读（逐条集合相等）＋ 看板侧零写盘 / 零自解析（N-1 的 grep 证明）
//        ＋ **源码级**自解析断言（两档都不得具备「定位并解析台账」的能力；定点修复 3）
//   T-4b 注入行 ⊆ 看板（有界摘要，**不要求全等**——§13.4 收紧后的口径）
//   T-5  `renderTaskDigest` 纯确定性（逐字节相同）· 无时间戳/百分比/步数 · 有界收尾 · 空集不出段
//   T-6  畸形 tasks.json ⇒ 读面不抛（fail-open）、写面拒（fail-closed）
//   T-7  `parseChecklistDoc`：列数不足 / 无状态列 ⇒ null（不部分解析）；实例验收表条数与状态分布
//        ＋ **读入口边界**：越出工作区的文档路径 ⇒ 拒读，且拒在**读之前**（定点修复 5）
//   T-8  无 better-sidebar ⇒ apply 不抛 + 设置页不受影响 + 会话内降级看板可用（输出由 readTasksView 派生；
//        ★ 判别力 = 载荷定型后改盘，后落的条目**不得**出现在渲染里 —— 定点修复 3）
//   T-9  `ledger.mode = off` ⇒ 个人台账分区消失、防漂移状态区**仍在**
//        ＋ 文档路径清单上限的**写面**：第 9 条 ⇒ 拒（定点修复 5）
//   T-10 evidence/reason 命中疑似凭据 ⇒ 拒写（**非打码**）
//   T-11 rev 冲突 ⇒ 拒且零写入 + fail-loud 文案（＋ 跨会话读回、落点与键控）
//   T-12 tab 注册不抛（有/无服务两态）＋ 点击载荷三要素（人话说明 / 文档清单 / 核验进度）
//   T-13 复制话术含默认模板句且**模板可配置**；两个复制按钮都在（含剪贴板失败退化路径）
//   T-14 决策分区**置顶**（在任务区之前）＋ 空集给明确空态（**不渲染空分区**）
//   T-15 零新增依赖 · 零宿主 import · 零 todo_write 调用点 · 零 todos 投影读取（**三形口径**：
//        引号字面 / 调用形 / **裸属性读**）· 客户端 inject 不变
//
// ★ 每条腿都带「变异自证」注释：说明**去掉哪一处实现会让该腿变红**（本仓纪律：腿必须咬得住实现）。
// ★ 每条腿都带**阳性/阴性对照**（防「恒红断言」与「恒真空断言」两种假绿）。
// ★ 本档只 import 仓内相对模块与 `node:` 内建（零宿主依赖、零新增依赖面——腿 T-15 静态断言）。
// ★ 本档**不执行任何外部命令**：全部是进程内的纯函数 / 文件系统 / 组件渲染断言，零网络、零 spawn。
//   （客户端渲染用 `node:vm` 空载真实 bundle + 一套带状态的 hook 桩——断言的是 `lib/client.js`
//    的**真实渲染分支**，不是复制的第二份实现。）
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createContext, runInContext } from "node:vm"
import {
  ALLOWED_MIGRATIONS, DEFAULT_COPY_TEMPLATE, LEDGER_FILE, LEDGER_SUBDIR, MAX_DOC_PATHS, REJECT_CODES,
  TASK_STATUSES, UPDATABLE_FIELDS, applyTaskCreate, applyTaskTransition, applyTaskUpdate,
  detectSecretShape, isValidDocPathList, parseChecklistDoc, readTasksView, renderTaskDigest,
  resolveLedgerConfig, resolveTasksPath, serializeLedger, tasksFileSha256, workspaceRootOf,
} from "../lib/tasks.mjs"
import { buildTasksBoardPayload, makeTaskTools, readChecklistDocs, renderBoardText } from "../lib/tool-tasks.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// ————————————— 夹具助手（每个用例一个独立工作区；用完即删） —————————————

/** 新建一次性工作区根（**它就是**台账的键 —— `resolveTasksPath` 只认它）。 */
function freshWs() {
  return mkdtempSync(join(tmpdir(), "thincoder-tasks-"))
}

/** 直接落一份台账文件（**仅测试用**：绕过写门造前置态；写门自身的零写入用 sha256 断言）。 */
function seedLedger(ws, tasks, rev = 0) {
  const dir = join(ws, LEDGER_SUBDIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, LEDGER_FILE), serializeLedger({ version: 1, rev, tasks }), "utf8")
}

/** 直接写任意文本（畸形输入腿用）。 */
function seedRaw(ws, text) {
  const dir = join(ws, LEDGER_SUBDIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, LEDGER_FILE), text, "utf8")
}

/** 一条合法条目的最小形状（字段与 `lib/tasks.mjs` 的 schema 对齐）。 */
function task(id, over = {}) {
  return {
    id, kind: "work", title: id + " 标题", status: "待办", check: "跑 X 看到 Y（判据）",
    evidence: null, blockedReason: null, blockedBy: null, priority: 0, why: null,
    createdAt: "2026-10-17T00:00:00.000Z", doneAt: null, ...over,
  }
}

/** 断言：某次写操作**拒绝**且带指定拒绝码，且**文件字节未变**（sha256 前后相同）。 */
function assertRejectNoWrite(ws, result, code) {
  const before = tasksFileSha256(ws)
  assert.equal(result?.ok, false, "该操作必须被拒（实测 " + JSON.stringify(result) + "）")
  if (code) assert.equal(result.code, code, "拒绝码必须点名（实测 " + result?.code + "：" + result?.reason + "）")
  assert.equal(tasksFileSha256(ws), before, "**拒绝路径必须零写入**（文件 sha256 前后相同）")
  assert.ok(REJECT_CODES.includes(result.code), "拒绝码必须在闭集内（实测 " + result.code + "）")
  return result
}

/** 建一条走到 `在做` 的任务（三条腿公用的前置：待办 → 已接手 → 在做）。 */
function toDoing(ws) {
  const c = applyTaskCreate(ws, { kind: "work", title: "修登录", check: "跑 login.test 全绿", expectedRev: 0 })
  assert.equal(c.ok, true, "前置建单必须成功：" + JSON.stringify(c))
  let r = applyTaskTransition(ws, { id: c.id, to: "已接手", expectedRev: c.rev })
  assert.equal(r.ok, true, "待办 → 已接手：" + JSON.stringify(r))
  r = applyTaskTransition(ws, { id: c.id, to: "在做", expectedRev: r.rev })
  assert.equal(r.ok, true, "已接手 → 在做：" + JSON.stringify(r))
  return { id: c.id, rev: r.rev }
}

// ═══════════════ T-1：无凭据 done ⇒ 拒且零写入（US-2） ═══════════════

test("T-1（US-2）: 无凭据的 done 被拒且零写入；有凭据才放行", () => {
  const ws = freshWs()
  try {
    const t = toDoing(ws)
    // 阴性：无凭据 ⇒ 拒
    const bad = applyTaskTransition(ws, { id: t.id, to: "完成", expectedRev: t.rev })
    assertRejectNoWrite(ws, bad, "evidence-required")
    assert.ok(bad.reason.includes("凭据"), "拒写文案必须指路「完成必须留凭据」：" + bad.reason)
    assert.equal(readTasksView(ws).tasks[0].status, "在做", "被拒后状态**不能**前进")

    // 阳性对照（防恒红）：同一调用补上凭据 ⇒ 放行
    const g = applyTaskTransition(ws, { id: t.id, to: "完成", evidence: "跑了 node --test test/login.test.mjs：12/12 绿", expectedRev: t.rev })
    assert.equal(g.ok, true, "有凭据必须放行（否则本腿是恒红断言）：" + JSON.stringify(g))
    const v = readTasksView(ws)
    assert.equal(v.tasks[0].status, "完成")
    assert.ok(v.tasks[0].evidence.includes("12/12"), "凭据必须落盘")
    assert.ok(v.tasks[0].doneAt, "完成时刻必须记下")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：删掉 `applyTaskTransition` 里的 `to === "完成" && evidence === ""` 分支 ⇒ 第一次调用返回 ok:true
// ⇒ 本腿的 assertRejectNoWrite 当场红（且 sha256 断言同时红，因为文件被改写）。

// ═══════════════ T-2：blocked 缺 reason / 缺 blockedBy ⇒ 拒（US-3 / US-4） ═══════════════

test("T-2（US-3 · US-4）: blocked 缺 reason、缺/错 blockedBy 均被拒且零写入", () => {
  const ws = freshWs()
  try {
    const c = applyTaskCreate(ws, { kind: "work", title: "等批 R 落地", check: "对端提交后复核形状", expectedRev: 0 })
    assert.equal(c.ok, true, JSON.stringify(c))
    // ① 缺 reason
    const noReason = applyTaskTransition(ws, { id: c.id, to: "卡住", blockedBy: "external", expectedRev: c.rev })
    assertRejectNoWrite(ws, noReason, "reason-required")
    // ② 有 reason 但 blockedBy 缺失 / 非法
    const noBy = applyTaskTransition(ws, { id: c.id, to: "卡住", reason: "对端还没提交", expectedRev: c.rev })
    assertRejectNoWrite(ws, noBy, "blockedby-required")
    const badBy = applyTaskTransition(ws, { id: c.id, to: "卡住", reason: "对端还没提交", blockedBy: "somebody", expectedRev: c.rev })
    assertRejectNoWrite(ws, badBy, "blockedby-required")
    assert.ok(badBy.reason.includes("external") && badBy.reason.includes("self"), "文案必须给出两个合法朝向：" + badBy.reason)
    // ③ 阳性对照：两个朝向都能落地（先 external）
    const g = applyTaskTransition(ws, { id: c.id, to: "卡住", reason: "对端还没提交", blockedBy: "external", expectedRev: c.rev })
    assert.equal(g.ok, true, "合法 blocked 必须放行：" + JSON.stringify(g))
    const v = readTasksView(ws)
    assert.equal(v.blocked.length, 1, "卡住区必须有这一条")
    assert.equal(v.blocked[0].blockedBy, "external")
    assert.equal(v.blocked[0].blockedReason, "对端还没提交")
    // ④ self 朝向同样合法（解卡后回流程）
    const back = applyTaskTransition(ws, { id: c.id, to: "在做", expectedRev: v.rev })
    assert.equal(back.ok, true, "卡住 → 在做 必须放行：" + JSON.stringify(back))
    assert.equal(readTasksView(ws).tasks[0].blockedReason, null, "离开卡住 ⇒ 清卡住原因（防板面显示陈旧原因）")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：删掉 `to === "卡住"` 的两条前置（reason / blockedBy）⇒ 前两次调用返回 ok:true ⇒ sha256 断言红。

// ═══════════════ T-3：非法迁移被拒（全表逐对） ═══════════════

test("T-3: 非法迁移被拒（25 组逐对断言 = 迁移表本身）＋ 工具路径同门（越界键拒且零写入）", async () => {
  const ws = freshWs()
  try {
    // 谓词自证（防「表读错」的假绿）：待办 → 完成 不在表里，待办 → 已接手 在表里
    assert.ok(!ALLOWED_MIGRATIONS["待办"].includes("完成"), "自证：待办 → 完成 必须不在迁移表")
    assert.ok(ALLOWED_MIGRATIONS["待办"].includes("已接手"), "自证：待办 → 已接手 必须在迁移表")

    let checked = 0
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        // 每个组合用**干净的**一份台账（rev=0），避免前一次成功迁移污染后续判定
        seedLedger(ws, [task("t-1", { status: from })], 0)
        const legal = ALLOWED_MIGRATIONS[from].includes(to)
        const r = applyTaskTransition(ws, { id: "t-1", to, evidence: "凭据", reason: "原因", blockedBy: "self", expectedRev: 0 })
        if (legal) {
          assert.equal(r.ok, true, "合法迁移 " + from + " → " + to + " 必须放行：" + JSON.stringify(r))
        } else {
          assertRejectNoWrite(ws, r, "illegal-migration")
        }
        checked++
      }
    }
    assert.equal(checked, TASK_STATUSES.length * TASK_STATUSES.length, "全表必须逐对走满（实测 " + checked + " 组）")

    // 非法状态名也在同一道门前被拒（不是「静默当成合法值」）
    seedLedger(ws, [task("t-1")], 0)
    const junk = applyTaskTransition(ws, { id: "t-1", to: "已经做完了", expectedRev: 0 })
    assertRejectNoWrite(ws, junk, "status-invalid")

    // —— 同一道门的另一半：`applyTaskUpdate` 的可改字段**闭集**（设计档 §六 FR-3 的后置）——
    // 设计档 §九 没有为 `applyTaskUpdate` 单列腿；它的后置与状态迁移同住一道写门 ⇒ 并入本腿（同一判据域）。
    seedLedger(ws, [task("t-1", { status: "在做" })], 0)
    assert.deepEqual([...UPDATABLE_FIELDS].sort(), ["check", "priority", "title", "why"], "可改字段闭集是契约本身")
    // ① 命中只读字段 ⇒ **拒**（不是静默忽略）
    const roPatch = applyTaskUpdate(ws, { id: "t-1", patch: { status: "完成", evidence: "偷偷写凭据" }, expectedRev: 0 })
    assertRejectNoWrite(ws, roPatch, "field-not-updatable")
    assert.ok(roPatch.reason.includes("status") && roPatch.reason.includes("可改字段闭集"), "文案必须点名不可改字段与可改闭集：" + roPatch.reason)
    // ② 空 patch ⇒ 拒（不空转 rev）
    assertRejectNoWrite(ws, applyTaskUpdate(ws, { id: "t-1", patch: {}, expectedRev: 0 }), "no-fields")
    // ③ 空标题 / 空判据 ⇒ 拒
    assertRejectNoWrite(ws, applyTaskUpdate(ws, { id: "t-1", patch: { title: "   " }, expectedRev: 0 }), "title-required")
    assertRejectNoWrite(ws, applyTaskUpdate(ws, { id: "t-1", patch: { check: "" }, expectedRev: 0 }), "check-required")
    // ④ 不存在的条目 ⇒ 拒
    assertRejectNoWrite(ws, applyTaskUpdate(ws, { id: "t-404", patch: { title: "x" }, expectedRev: 0 }), "id-missing")
    // ⑤ 阳性对照：合法 patch ⇒ 放行且真的改了
    const up = applyTaskUpdate(ws, { id: "t-1", patch: { title: "改过的标题", priority: 7 }, expectedRev: 0 })
    assert.equal(up.ok, true, "合法 patch 必须放行：" + JSON.stringify(up))
    const after = readTasksView(ws).tasks[0]
    assert.equal(after.title, "改过的标题")
    assert.equal(after.priority, 7)
    assert.equal(after.status, "在做", "改单**不得**动状态（状态只能走迁移门）")
    assert.equal(up.rev, 1, "成功改单 ⇒ rev+1")

    // —— ⑥ **工具路径**上的同一道门（定点修复：此前这条检查在工具面**不可达**）——
    // 旧实现把工具入参按白名单搬运成 `patch` ⇒ 越界键被**静默丢掉**、然后**写入成功**
    // （调用方以为改了状态，盘上什么都没发生）。现在工具层先判越界键 ⇒ **拒**。
    seedLedger(ws, [task("t-1", { status: "在做", title: "原标题" })], 0)
    const tools = makeTaskTools({ wsOf: () => ws, configOf: () => ({}), driftOf: () => null })
    const exec = { agent: { session: { id: "s-1" } } }
    const beforeTool = tasksFileSha256(ws)
    // ⑥-a **混合入参**（宿主实测的原始复现形态：合法字段 + 只读字段同来）⇒ 整单拒、**零写入**：
    //     旧实现只搬 `title` ⇒ 会「改标题 + 静默吞掉 status」并返回成功。
    const toolMixText = await tools.task_update.execute({ id: "t-1", title: "被改的标题", status: "完成" }, exec)
    assert.ok(toolMixText.includes("拒写") && toolMixText.includes("没有写入任何内容"),
      "混合入参（合法 + 只读）⇒ 必须**整单拒**（不是「只改合法那个」）：" + toolMixText)
    assert.ok(toolMixText.includes("status"), "拒写文案必须点名越界字段：" + toolMixText)
    assert.equal(tasksFileSha256(ws), beforeTool, "**工具路径零写入**（文件 sha256 前后相同）")
    assert.equal(readTasksView(ws).tasks[0].title, "原标题", "被拒后**合法字段也不得落盘**（整单拒）")
    // ⑥-b 只给只读字段（含 `evidence` —— 它只能由完成迁移写）⇒ 同样拒且点名
    const toolRoText = await tools.task_update.execute({ id: "t-1", status: "完成", evidence: "偷偷写凭据" }, exec)
    assert.ok(toolRoText.includes("拒写") && toolRoText.includes("status") && toolRoText.includes("evidence")
      && toolRoText.includes("可改字段闭集"),
      "拒写文案必须**逐个点名**越界字段与可改闭集：" + toolRoText)
    assert.ok(toolRoText.includes("field-not-updatable"), "拒因必须点名拒绝码（与写门同码）：" + toolRoText)
    assert.equal(tasksFileSha256(ws), beforeTool, "**工具路径同样零写入**（文件 sha256 前后相同）")
    assert.equal(readTasksView(ws).tasks[0].status, "在做", "被拒后状态不得前进")
    // 阳性对照（防「凡工具调用必拒」的假绿）：只给合法字段 ⇒ 工具路径照常放行、且落盘
    const toolOkText = await tools.task_update.execute({ id: "t-1", title: "工具路径改的标题" }, exec)
    assert.ok(toolOkText.includes("已改 t-1"), "合法字段必须照常放行：" + toolOkText)
    assert.equal(readTasksView(ws).tasks[0].title, "工具路径改的标题")
    // ★ 2026-10-17 缺陷修复（用户实测触发）：`task_add` 的 schema 描述面逐字写着 `'work' (default)`，
    //   但工具层曾把 `args?.kind` 原样透传 ⇒ **按描述省略 kind 会被门以 `kind-invalid` 拒**（我第一次调用就撞上）。
    //   ⇒ 省略 kind 必须等价于显式 `kind: "work"`（默认值落在工具层；门仍保持严格枚举，那是设计意图）。
    const addNoKind = await tools.task_add.execute({ title: "省略 kind 的一条", check: "建成即可（默认 work）" }, exec)
    assert.ok(addNoKind.includes("已建"), "省略 kind 必须能建成（schema 承诺了默认值）：" + addNoKind)
    const added = readTasksView(ws).tasks.find((x) => x.title === "省略 kind 的一条")
    assert.ok(added, "省略 kind 的那条必须真的落盘")
    assert.equal(added.kind, "work", "省略 kind ⇒ 必须默认 work（描述面与实现一致）")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：删掉 `ALLOWED_MIGRATIONS` 校验（只留状态合法性与凭据门）⇒ 「待办 → 完成」等非法组合会返回 ok:true
// ⇒ 本腿在这 25 组里必然红。⑥ 的变异自证：把 `strayArgKeys` 换成恒空数组（即退回「白名单静默搬运」）⇒
// 工具路径那次调用会**写入成功** ⇒ 三条断言同时红（拒写文案 / sha256 零写入 / 状态未前进）。

// ═══════════════ T-6：畸形输入（读面 fail-open / 写面 fail-closed） ═══════════════

test("T-6: 畸形 tasks.json ⇒ 读面不抛（fail-open）、写面拒（fail-closed）", () => {
  const ws = freshWs()
  try {
    const cases = [
      ["JSON 解析失败", "{ 这不是 JSON"],
      ["顶层是数组", "[1,2,3]"],
      ["tasks 不是数组", JSON.stringify({ version: 1, rev: 0, tasks: { a: 1 } })],
      ["条目缺 status", serializeLedger({ version: 1, rev: 1, tasks: [{ id: "t-1", kind: "work", title: "x" }] })],
      ["条目 id 重复", serializeLedger({ version: 1, rev: 1, tasks: [task("t-1"), task("t-1", { title: "另一个" })] })],
    ]
    for (const [label, text] of cases) {
      seedRaw(ws, text)
      let view = null
      assert.doesNotThrow(() => { view = readTasksView(ws) }, label + "：读面**绝不抛**（fail-open）")
      assert.ok(view && Array.isArray(view.tasks), label + "：读面必须返回结构")
      assert.equal(view.malformed, true, label + "：必须如实标 malformed（畸形不是静默降级）")
      assert.ok(typeof view.trace === "string" && view.trace.length > 0, label + "：必须有「一行痕」：" + JSON.stringify(view.trace))
      // 写面 fail-closed：拒绝，且**零写入**
      const r = applyTaskCreate(ws, { kind: "work", title: "新任务", check: "判据", expectedRev: view.rev })
      assertRejectNoWrite(ws, r, "malformed")
      assert.equal(readFileSync(resolveTasksPath(ws), "utf8"), text, label + "：畸形文件必须**逐字节**保持原样")
    }
    // 阳性对照（防「恒判畸形」）：合法文件 ⇒ malformed=false 且写门放行
    seedLedger(ws, [task("t-1")], 0)
    const good = readTasksView(ws)
    assert.equal(good.malformed, false, "合法文件不得被判畸形")
    assert.equal(good.trace, null)
    assert.equal(applyTaskCreate(ws, { kind: "work", title: "新任务", check: "判据", expectedRev: 0 }).ok, true,
      "合法文件上的建单必须放行（写门不是恒拒）")
    // 空集边界：文件不存在 ⇒ 合法空账本（不是畸形）
    const ws2 = freshWs()
    try {
      const empty = readTasksView(ws2)
      assert.equal(empty.malformed, false, "文件不存在 ⇒ 合法空账本")
      assert.deepEqual(empty.tasks, [])
      assert.equal(empty.rev, 0, "空账本 rev=0（与设计档 §6 前置一致）")
    } finally { rmSync(ws2, { recursive: true, force: true }) }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：让读面直接 `JSON.parse(text)` 不兜 try/catch（或把 malformed 恒置 false）⇒ 本腿第一个 case 的
// doesNotThrow / malformed 断言红；删掉写门的 `loaded.malformed` 分支 ⇒ 写门会真的落盘覆盖畸形文件
// ⇒ assertRejectNoWrite 的 sha256 断言红。

// ═══════════════ T-10：疑似凭据 ⇒ 拒写（非打码） ═══════════════

test("T-10（N-7）: evidence/reason 命中疑似凭据 ⇒ 拒写（不是打码）", () => {
  const ws = freshWs()
  try {
    // 谓词自证（正负两侧都要能判）
    assert.equal(detectSecretShape("token=abcdefghijklmnop").hit, true, "自证①：赋值形态必须命中")
    assert.equal(detectSecretShape("跑了 node --test：12/12 绿").hit, false, "自证②：正常凭据文本不得命中")
    assert.equal(detectSecretShape("sha256 前后相同 3f2a1b" + "0".repeat(58)).hit, false,
      "自证③：**裸 sha256** 不得命中（本仓工作流鼓励在 evidence 里写 sha，误拒代价高于漏检）")

    const t = toDoing(ws)
    const leak = detectSecretShape("sk-live-ABCDEFGHIJKLMNOPQRSTUVWX")
    assert.equal(leak.hit, true, "自证④：sk- 形态必须命中")
    const before = readFileSync(resolveTasksPath(ws), "utf8")
    const r = applyTaskTransition(ws, {
      id: t.id, to: "完成",
      evidence: "跑了 node --test 后把 sk-live-ABCDEFGHIJKLMNOPQRSTUVWX 贴进来了",
      expectedRev: t.rev,
    })
    assertRejectNoWrite(ws, r, "secret-suspected")
    const after = readFileSync(resolveTasksPath(ws), "utf8")
    assert.equal(after, before, "拒写必须是**零写入**（打码会把疑似凭据留在盘上，本设计明令不做）")
    assert.ok(!after.includes("sk-live"), "盘上不得出现该串（连打码形态都不许出现）")
    assert.ok(r.reason.includes("拒写"), "文案必须说清是「拒写」不是「打码」：" + r.reason)

    // reason 字段同族（卡住原因也是自由文本）
    const b = applyTaskTransition(ws, { id: t.id, to: "卡住", reason: "AKIAIOSFODNN7EXAMPLE 过期了", blockedBy: "external", expectedRev: t.rev })
    assertRejectNoWrite(ws, b, "secret-suspected")

    // 阳性对照：正常凭据照常放行（门不是恒拒）
    const g = applyTaskTransition(ws, { id: t.id, to: "完成", evidence: "跑了 login.test：12/12 绿；sha256 前后相同", expectedRev: t.rev })
    assert.equal(g.ok, true, "正常凭据必须放行：" + JSON.stringify(g))
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：把 `firstSecretHit` 从「拒」改成「打码后写入」⇒ 本腿的 sha256 / 逐字节 / 文案三条断言同时红；
// 把 SECRET_PATTERNS 清空 ⇒ 第一次拒写变成 ok:true ⇒ 红。

// ═══════════════ T-11：rev 冲突（D5 / §13.3 必做项）+ 跨会话读回（N-3） ═══════════════

test("T-11（N-2 · N-3 · D5）: 陈旧 expectedRev ⇒ 拒且零写入 + fail-loud；合法 rev ⇒ 放行；跨会话读回", () => {
  const ws = freshWs()
  try {
    // 两个会话各自读一次（同一 rev）—— 这正是真实部署的形态（用户原话：「还有别的会话在工作」）
    const sessionA = readTasksView(ws).rev
    const sessionB = readTasksView(ws).rev
    assert.equal(sessionA, sessionB, "两个会话冷读同一份空账本 ⇒ 同一 rev")

    const a = applyTaskCreate(ws, { kind: "work", title: "会话 A 建的单", check: "判据 A", expectedRev: sessionA })
    assert.equal(a.ok, true, JSON.stringify(a))
    const afterA = tasksFileSha256(ws)

    // B 拿**陈旧** rev 写 ⇒ 必须拒，且**一个字节都不能动**
    const b = applyTaskCreate(ws, { kind: "work", title: "会话 B 建的单", check: "判据 B", expectedRev: sessionB })
    assertRejectNoWrite(ws, b, "rev-conflict")
    assert.equal(tasksFileSha256(ws), afterA, "冲突写必须零写入（原子写只防半文件，**不防丢更新**——D5）")
    assert.ok(b.reason.includes("其他会话"), "fail-loud 文案必须点名冲突来源：" + b.reason)
    assert.ok(b.reason.includes("你的 rev=" + sessionB), "文案必须给出「你的 rev」：" + b.reason)
    assert.ok(b.reason.includes("盘上 rev=1"), "文案必须给出「盘上 rev」（会话 A 写后 = 1）：" + b.reason)

    // 阳性对照（防「凡写必拒」的假绿）：B 重新读到最新 rev 后写 ⇒ 放行
    const b2 = applyTaskCreate(ws, { kind: "work", title: "会话 B 重试", check: "判据 B", expectedRev: readTasksView(ws).rev })
    assert.equal(b2.ok, true, "读到最新 rev 后必须放行：" + JSON.stringify(b2))

    // rev 号缺失 / 非法 ⇒ 同一族前置拒绝（不猜、不静默用盘上值）
    const noRev = applyTaskCreate(ws, { kind: "work", title: "x", check: "y" })
    assertRejectNoWrite(ws, noRev, "expected-rev-invalid")

    // 跨会话 / 跨重启读回（N-3）：**新的一次读**（等价于另一个进程冷启动）必须看到同一份台账
    const fresh = readTasksView(ws)
    assert.deepEqual(fresh.tasks.map((t) => t.title).sort(), ["会话 A 建的单", "会话 B 重试"])
    assert.equal(fresh.rev, 2, "两次成功写 ⇒ rev 递增到 2（每次都 +1）")

    // 落点断言（设计档 §7.1「严禁照搬 goal-criteria 落点」的机器形态）：
    // 台账必须落在**工作区内**的 `.thincoder/tasks.json`，且**与 DSH_HOME 无关**（profile 根变了也不动）。
    const p = resolveTasksPath(ws)
    assert.equal(p, join(resolve(ws), LEDGER_SUBDIR, LEDGER_FILE), "落点必须是 <工作区根>/.thincoder/tasks.json")
    assert.ok(p.startsWith(resolve(ws)), "台账必须住在工作区内（绑工作区 ⇒ 跨会话/跨重启存活）")
    assert.equal(existsSync(p), true)
    const savedHome = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = join(tmpdir(), "thincoder-not-a-profile-root")
      assert.equal(resolveTasksPath(ws), p, "★ DSH_HOME 变化**不得**影响台账落点（键控按工作区根，自建）")
      assert.equal(workspaceRootOf(ws), resolve(ws))
      assert.equal(workspaceRootOf("   "), null, "空 cwd ⇒ 不可解析（**不得**回落到 process.cwd()）")
      assert.equal(resolveTasksPath(null), null, "无工作区 ⇒ 路径为 null（写门随后拒 ws-unresolvable）")
    } finally {
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
    }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：删掉写门的 `loaded.file.rev !== expectedRev` 分支 ⇒ B 的陈旧写会成功、rev 变成 2 ⇒
// assertRejectNoWrite 与 sha256 两条断言同时红；把键控改成读 DSH_HOME ⇒ 最后一段的 DSH_HOME 断言红。

// ═══════════════ T-4b：注入行 ⊆ 看板（US-5 ② / §13.4 收紧后的口径） ═══════════════

/** 从注入摘要里抽出「id[状态]」条目（摘要的自证形态：每条都自带 id 与状态，故可逐条比对）。 */
function digestEntries(text) {
  return [...String(text ?? "").matchAll(/(t-\d+)\[([^\]]+)\]/g)].map((m) => ({ id: m[1], tag: m[2] }))
}

test("T-4b（US-5 ②）: 注入摘要列出的每条 ∈ 看板集合且状态一致（**不要求全等**）", () => {
  const ws = freshWs()
  try {
    const seeded = []
    for (let i = 1; i <= 14; i++) {
      seeded.push(task("t-" + i, { kind: i % 3 === 0 ? "decision" : "work", title: "第 " + i + " 项：这一条的标题刻意写长一点，用来把注入摘要的预算顶出去", status: i % 4 === 0 ? "在做" : "待办" }))
    }
    seeded.push(task("t-20", { status: "卡住", blockedBy: "self", blockedReason: "手上有别的活", title: "等自己动手" }))
    seeded.push(task("t-21", { status: "完成", evidence: "跑了 12/12 绿", title: "已收口的一条" }))
    seedLedger(ws, seeded, 7)

    const view = readTasksView(ws) // ← **独立再读一次**（渲染用的那一份也是新读的，两者必须一致）
    const digest = renderTaskDigest(readTasksView(ws))
    const entries = digestEntries(digest)
    assert.ok(entries.length > 0, "夹具必须真的产出摘要行（否则本腿是恒真空断言）：" + JSON.stringify(digest))
    assert.ok(entries.length < view.tasks.length,
      "★ 摘要必须**有界**（⊆ 看板，不是全等——§13.4）：列出 " + entries.length + " 条 / 账本 " + view.tasks.length + " 条")

    const byId = new Map(view.tasks.map((t) => [t.id, t]))
    for (const e of entries) {
      const t = byId.get(e.id)
      assert.ok(t, "摘要列出的每条必须 ∈ 看板集合（编造 ⇒ 红）：" + e.id)
      assert.ok(e.tag === t.status || e.tag.startsWith(t.status + "/"),
        "状态必须与看板一致：" + e.id + " 摘要=" + JSON.stringify(e.tag) + " 看板=" + JSON.stringify(t.status))
    }
    // 变异自证（**可执行的负控**）：往摘要里编造一条看板没有的 ⇒ 同一谓词必须判红
    const faked = digest + "\n■ t-999[在做] 编造的任务（看板上没有这一条）"
    const stray = digestEntries(faked).filter((e) => !byId.has(e.id))
    assert.deepEqual(stray.map((e) => e.id), ["t-999"], "自证①：编造条目必须被同一谓词判红")
    // 自证②：把摘要里的状态标签改成与看板不符的值 ⇒ 同一谓词同样判红
    const mismatched = digestEntries(digest)
      .map((e) => ({ id: e.id, tag: "完成" }))
      .filter((e) => { const t = byId.get(e.id); return !(e.tag === t.status || e.tag.startsWith(t.status + "/")) })
    assert.ok(mismatched.length > 0, "自证②：状态错配必须被判红（该夹具里摘要列出的条目都不在『完成』态）")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：让 `renderTaskDigest` 不读 view 而自己编造条目（或把状态标签写成常量）⇒ 上面两条断言红。

// ═══════════════ T-5：摘要纯确定性 + 有界 + 空集不出段（N-5 / FR-4） ═══════════════

test("T-5（N-5）: renderTaskDigest 逐字节确定性、无时间戳/百分比/步数、超预算以『…还有 N 项』收尾", () => {
  const ws = freshWs()
  try {
    // 全序夹具：两条**同优先级**的决策项 t-9 / t-10 ⇒ 必须按 id **数值**升序（t-9 在 t-10 前）
    seedLedger(ws, [
      task("t-10", { kind: "decision", priority: 5, title: "第二决策" }),
      task("t-9", { kind: "decision", priority: 5, title: "第一决策" }),
      task("t-3", { kind: "decision", priority: 9, title: "高优先级决策" }),
      task("t-1", { status: "在做", title: "在办的一条" }),
      task("t-2", { status: "完成", evidence: "跑了 12/12 绿", title: "已完成的一条" }),
    ], 3)
    const v1 = readTasksView(ws)
    const a = renderTaskDigest(v1)
    const b = renderTaskDigest(v1)
    assert.equal(a, b, "同 view 连调两次必须**逐字节相同**")
    assert.equal(renderTaskDigest(readTasksView(ws)), a, "同盘内容的重读 ⇒ 同样输出（不依赖调用时刻）")

    // 禁项：时间戳 / 百分比 / 步数（批 34 A-6 同款口径）
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a), "不得含 ISO 时间戳：" + a)
    assert.ok(!a.includes("%"), "不得含百分比")
    assert.ok(!/(第\s*\d+\s*步|\d+\s*步)/.test(a), "不得含步数")
    assert.ok(!/\b\d{2}:\d{2}\b/.test(a), "不得含时刻")

    // 全序：决策区内 t-3(优先级 9) → t-9 → t-10（同优先级按**数值** id 升序，不是字典序）
    const idsInOrder = [...a.matchAll(/◆ (t-\d+)\[/g)].map((m) => m[1])
    assert.deepEqual(idsInOrder, ["t-3", "t-9", "t-10"], "决策项全列且全序（priority 降序 → id 数值升序）：" + JSON.stringify(idsInOrder))

    // 有界 + 收尾尾巴
    const many = []
    for (let i = 1; i <= 40; i++) many.push(task("t-" + i, { kind: "decision", title: "第 " + i + " 条标题刻意写得足够长，好把 512 的预算顶出去，验证尾巴" }))
    seedLedger(ws, many, 9)
    const long = renderTaskDigest(readTasksView(ws))
    assert.ok(long.length <= 512, "必须有界（≤512 实测 " + long.length + "）：" + long.slice(0, 80))
    assert.ok(/…还有 \d+ 项$/.test(long), "超预算必须以『…还有 N 项』收尾（不是截断半句）：" + long.slice(-40))
    const shown = digestEntries(long).length
    const claimed = Number(/…还有 (\d+) 项$/.exec(long)[1])
    assert.equal(shown + claimed, 40, "「列出 + 还有」必须等于总数（不许静默丢项）：" + shown + " + " + claimed)

    // 空集 / 关闭态 ⇒ 空串（该段**不出现**）
    assert.equal(renderTaskDigest({ tasks: [], decisions: [], active: [], blocked: [], done: [], rev: 0 }), "", "空集 ⇒ 空串")
    assert.equal(renderTaskDigest(null), "", "畸形入参 ⇒ 空串（fail-open）")
    assert.equal(renderTaskDigest(readTasksView(ws), { mode: "off" }), "", "ledger.mode=off ⇒ 该段不出现（US-9）")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：在摘要里混入 `Date.now()`（或百分比/步数）⇒ 前两条确定性/禁项断言之一立刻红；
// 把「…还有 N 项」改成硬 `slice(0, 512)`（截断半句）⇒ 尾巴正则与「列出+还有=总数」两条红。

// ═══════════════ T-15：零新增依赖面 + 零宿主复用（静态断言，FR-10） ═══════════════

/** 递归收集 `lib/` 下的代码档（.mjs / .js）——**代码**面；文档不在本腿域内。 */
function libCodeFiles(dir = join(PLUGIN_DIR, "lib"), out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) libCodeFiles(full, out)
    else if ([".mjs", ".js"].includes(extname(e.name))) out.push(full)
  }
  return out
}

test("T-15（N-6 · FR-10）: 零新增依赖、零宿主 import、零 todo_write 调用点、零 todos 投影读取、客户端 inject 不变", () => {
  // ① 依赖面逐字不变（本仓零依赖：`dependencies` 键必须**不存在**）
  const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8"))
  assert.equal(pkg.dependencies, undefined, "package.json 不得出现 dependencies（零新增运行时依赖，N-6）")
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ["release:check", "test"], "scripts 面不得漂移")

  // ② 宿主半边：批 36 触碰的档里，导入说明符只允许 `node:` 内建与仓内相对路径
  const hostFiles = ["lib/tasks.mjs", "lib/tool-tasks.mjs", "lib/index.mjs"]
  const bare = []
  for (const rel of hostFiles) {
    const src = readFileSync(join(PLUGIN_DIR, rel), "utf8")
    for (const m of src.matchAll(/^\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gm)) {
      const spec = m[1]
      if (!spec.startsWith("node:") && !spec.startsWith(".")) bare.push(rel + " → " + spec)
    }
  }
  assert.deepEqual(bare, [], "宿主半边不得新增宿主/第三方 import 说明符（只许 node: 与相对路径）：" + JSON.stringify(bare))
  // 谓词自证（防「正则写错 ⇒ 恒空」的假绿）
  assert.deepEqual([...'import x from "@deepseek-ai/dsh-tools"'.matchAll(/^\s*import\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]),
    ["@deepseek-ai/dsh-tools"], "自证：裸说明符必须能被同一正则抓到")

  // ③④ 零宿主复用：**代码面**（lib/ 全部代码档）零 todo_write 调用点 / 零 todos 投影读取
  //   ★ 口径（**权威定义 = 设计档 §九 T-15**，三形并列；定点修复 6 补齐第三形）：
  //     ① **引号字面**（把工具名/投影键放进引号里写 = 注册点或投影键的形态）；
  //     ② **调用形**（名字后紧跟左括号）；
  //     ③ **裸属性读**（点号后直接跟名字、不经字符串 —— 旧口径的**漏检面**：点号形态的投影读取）；
  //     另加两个宿主投影面的**裸标识符**（它们本身就是投影面的名字，无引号也照抓）。
  //   散文里点名的裸词（软引导文案）不算调用点——这正是「描述 vs 调用」的差别（见 lib/tasks.mjs 注释）。
  const codeFiles = libCodeFiles()
  assert.ok(codeFiles.length >= 20, "扫描面非空（实测 " + codeFiles.length + " 档）")
  const hits = []
  for (const f of codeFiles) {
    const src = readFileSync(f, "utf8")
    const rel = f.slice(PLUGIN_DIR.length + 1).split("\\").join("/")
    if (/["'`]todo_write["'`]/.test(src)) hits.push(rel + " :: 引号字面 todo_write")
    if (/\btodo_write\s*\(/.test(src)) hits.push(rel + " :: todo_write( 调用")
    if (/["'`]todos["'`]/.test(src)) hits.push(rel + " :: 引号字面 todos（投影键）")
    if (/\.\s*todo_write\b/.test(src)) hits.push(rel + " :: .todo_write 裸属性读")
    if (/\.\s*todos\b/.test(src)) hits.push(rel + " :: .todos 裸属性读（宿主投影）")
    if (/\bsessionProjections\b/.test(src)) hits.push(rel + " :: sessionProjections（会话投影读取）")
    if (/\buseProjection\b/.test(src)) hits.push(rel + " :: useProjection（客户端订阅宿主投影）")
  }
  assert.deepEqual(hits, [], "本仓代码必须零 todo_write 调用点、零 todos 投影读取（FR-10）：" + JSON.stringify(hits))
  // 谓词自证：合成样本必须能命中（否则上面那条是恒真空）
  const probe = 'ctx.tools.register({ name: "todo_write" })'
  assert.ok(/["'`]todo_write["'`]/.test(probe), "自证：引号字面必须能被抓到")
  assert.ok(!/["'`]todo_write["'`]/.test("Use the host todo_write only as this turn's scratchpad."),
    "自证：散文裸词**不**算调用点（这一条是口径本身）")
  // ★ 自证 ③（定点修复 6 的新面）：**旧口径看不见**的裸属性读，必须被新谓词抓到 ——
  assert.ok(/\.\s*todos\b/.test("const list = ctx.todos") && /\.\s*todo_write\b/.test("await ctx.todo_write(args)"),
    "自证③：点号形态的宿主投影读取必须被新谓词抓到（旧口径只认引号字面与调用形 ⇒ 这里是漏检面）")
  assert.ok(!/\.\s*todos\b/.test("the platform clears its todos projection at every turn start"),
    "自证③的反面：散文里的裸词（无点号）不算读取 —— 谓词不得退化成「凡出现该词即红」")

  // ⑤ 客户端 inject 数组**逐字不变**（T-8① 的静态半）：把 betterSidebar 写进去 ⇒ 缺席时客户端半边永久 pending
  const client = readFileSync(join(PLUGIN_DIR, "lib", "client.js"), "utf8")
  const m = /var inject = \[([^\]]*)\]/.exec(client)
  assert.ok(m, "必须能定位客户端的 inject 数组（定位不到 ⇒ 本腿恒真空，必须红）")
  const names = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
  assert.deepEqual(names, ["slots", "connection"], "客户端 inject 不得因本批新增条目（可选依赖一律 ctx.get）：" + JSON.stringify(names))
})
// 变异自证：往 package.json 加一条 dependency ⇒ ① 红；把 `import { x } from "@deepseek-ai/dsh-tools"`
// 写进 tasks.mjs ⇒ ② 红；在 index.mjs 里写 `ctx.tools.register({name:"todo_write",…})` ⇒ ③ 红；
// 在读面加 `ctx.sessionProjections.get("todos")` ⇒ ③④ 红；把 "betterSidebar" 加进客户端 inject ⇒ ⑤ 红。
// ★ 定点修复 6 实测：在读面加一行**裸属性读** `ws.todos`（不经字符串）⇒ ③ 的 `.todos 裸属性读` 命中 ⇒ 红
//   （旧口径在这一形态上**恒绿**——这正是本修复补的漏检面；实测读数见交付报告，坏代码已回退）。

// ═══════════════ T-4a：看板 ≡ 工具读（US-5 ① 核心腿 / N-1 grep 证明） ═══════════════

/** 从**看板/工具文本**里抽「id [状态]」条目（两面共用同一渲染形态，故同一正则）。 */
function textEntries(text) {
  return [...String(text ?? "").matchAll(/(t-\d+) \[([^\]]+)\]/g)].map((m) => ({ id: m[1], tag: m[2] }))
}

/** 断言：一组条目的 (id → 状态) 映射与看板读数**逐条相等**（不是抽样）。 */
function assertSameTaskSet(entries, view, label) {
  const fromView = new Map(view.tasks.map((t) => [t.id, t.status]))
  const got = new Map(entries.map((e) => [e.id, e.tag.split("/")[0]]))
  assert.deepEqual([...got.keys()].sort(), [...fromView.keys()].sort(), label + "：任务集合必须逐条相等")
  for (const [id, status] of got) assert.equal(status, fromView.get(id), label + "：" + id + " 的状态必须一致")
}

/**
 * 「该档**自己定位并解析台账**」的静态形态判据（T-4a④ / T-8⑤ 的静态半；设计-D3 的结构保证）。
 *
 * 口径：① **台账定位 token** —— 出现台账文件名的**引号字面**，或三个台账路径面
 * （`LEDGER_FILE` / `LEDGER_SUBDIR` / `resolveTasksPath`）⇒ 该档**有办法定位台账文件**；
 * ② **解析调用形** —— `JSON.parse(` / `readFileSync(`。**判据取 ①：命中即违规**——
 * 定位不到那个文件，就不可能自解析它。
 *
 * ★ 为什么**不**直接禁 `JSON.parse` / `readFileSync`：那会造假阳性 —— `lib/client.js` 用
 *   `JSON.parse(JSON.stringify(x))` 做深拷贝，`lib/tool-tasks.mjs` 用 `readFileSync` 读
 *   **结构化文档源**（FR-8，与台账无关）。要咬的是「**针对台账文件**的解析」，不是「任何解析」。
 * @returns {string[]} 违规标签（空数组 = 该档不可能自解析台账）
 */
function ledgerSelfParseHits(src, label) {
  const hits = []
  if (/["'`]tasks\.json["'`]/.test(src)) hits.push(label + " :: 台账文件名的引号字面")
  if (/\bLEDGER_FILE\b/.test(src)) hits.push(label + " :: LEDGER_FILE（台账文件名常量）")
  if (/\bLEDGER_SUBDIR\b/.test(src)) hits.push(label + " :: LEDGER_SUBDIR（台账目录常量）")
  if (/\bresolveTasksPath\b/.test(src)) hits.push(label + " :: resolveTasksPath（台账路径解析）")
  return hits
}

test("T-4a（US-5 ① · N-1）: 看板 ≡ 工具读（同一 ws 逐条相等）；看板侧零写盘、零自解析", async () => {
  const ws = freshWs()
  try {
    seedLedger(ws, [
      task("t-1", { status: "在做", title: "在办的一条" }),
      task("t-2", { kind: "decision", title: "等你拍板的一条" }),
      task("t-3", { status: "卡住", blockedBy: "external", blockedReason: "等对端", title: "卡住的一条" }),
      task("t-4", { status: "完成", evidence: "跑了 12/12 绿", title: "已完成的一条" }),
    ], 4)
    const view = readTasksView(ws)

    // ① 看板面（host 载荷 = 浏览器 tab 拉取的那一份）
    const payload = buildTasksBoardPayload({ ws, sessionId: "s-1", config: {}, drift: null })
    assert.equal(payload.generatedFrom, "readTasksView", "载荷必须自证唯一读来源（设计-D3）")
    const boardEntries = ["decisions", "blocked", "active", "done"].flatMap((k) => (payload.ledger[k] || []).map((t) => ({ id: t.id, tag: t.status })))
    assertSameTaskSet(boardEntries, view, "看板载荷")

    // ② 工具面（跑**真实工具**：两种渲染模式）
    const tools = makeTaskTools({ wsOf: () => ws, configOf: () => ({}), driftOf: () => null })
    const listText = await tools.task_list.execute({}, { agent: { session: { id: "s-1" } } })
    const boardText = await tools.task_list.execute({ view: "board" }, { agent: { session: { id: "s-1" } } })
    assertSameTaskSet(textEntries(listText), view, "task_list（list 模式）")
    // 看板渲染模式里「已完成」只给计数 ⇒ 它的条目集 = 全部 **减去** 完成态
    const boardEntriesFromText = textEntries(boardText)
    assertSameTaskSet(boardEntriesFromText, { tasks: view.tasks.filter((t) => t.status !== "完成") }, "task_list（board 模式）")
    assert.ok(boardText.includes("已完成（1）"), "board 模式对完成态只给计数：\n" + boardText)

    // ③ N-1 的**grep 证明**：看板侧零写盘 / 零自解析（静态面）
    //    ★ 判据取**调用形态**（不是裸词）：注释里点名「不用 localStorage」不算违规，
    //      `localStorage.getItem(…)` 这种**调用**才算——两者的差别就是「描述 vs 调用」。
    const clientSrc = readFileSync(join(PLUGIN_DIR, "lib", "client.js"), "utf8")
    const banned = [
      [/readFileSync\s*\(/, "readFileSync( 读盘"],
      [/writeFileSync\s*\(/, "writeFileSync( 写盘"],
      [/createWriteStream\s*\(/, "createWriteStream( 写流"],
      [/localStorage\s*[.[]/, "localStorage 调用"],
      [/sessionStorage\s*[.[]/, "sessionStorage 调用"],
      [/indexedDB\s*[.[]/, "indexedDB 调用"],
      [/document\.cookie\s*=/, "document.cookie 写"],
      [/["'`]tasks\.json["'`]/, "台账文件名的**引号字面**（看板不得自己解析它）"],
    ]
    const staticHits = banned.filter(([re]) => re.test(clientSrc)).map(([, label]) => label)
    assert.deepEqual(staticHits, [], "看板侧必须零写盘、零自解析（N-1）：" + JSON.stringify(staticHits))
    // 谓词自证（防「正则写错 ⇒ 恒空」的假绿）
    assert.ok(/localStorage\s*[.[]/.test("localStorage.getItem('x')"), "自证：调用形必须被抓到")
    assert.ok(!/localStorage\s*[.[]/.test("// 本区块不用 localStorage/sessionStorage"), "自证：注释里的裸词不算调用")
    assert.ok(clientSrc.includes('"/tasks?sessionId="'), "看板侧的唯一数据通路 = host 的 /tasks 端点")

    // ④ **结构保证的静态半**（定点修复 3）：看板载荷与工具文本**只**经 `readTasksView()` 取数 ⇒
    //    这两个档**不得**具备「自己定位并解析 tasks.json」的能力（有 ⇒ 就能长出第二个真源）。
    //    ★ 旧写法（T-8⑤ 的 `boardText.includes("readTasksView")`）命中的是**渲染表头里的字面**，
    //      对「宿主载荷自己解析同一文件」这个变异**零判别力** ⇒ 本块把它换成源码级断言。
    const toolSrc = readFileSync(join(PLUGIN_DIR, "lib", "tool-tasks.mjs"), "utf8")
    const selfParse = [
      ...ledgerSelfParseHits(toolSrc, "lib/tool-tasks.mjs"),
      ...ledgerSelfParseHits(clientSrc, "lib/client.js"),
    ]
    assert.deepEqual(selfParse, [], "看板/工具侧不得自己定位并解析台账（设计-D3）：" + JSON.stringify(selfParse))
    assert.ok(toolSrc.includes("readTasksView(ws)"), "工具侧必须经唯一读函数取数（否则上一条是空断言）")
    // 谓词自证（**变异自证的常驻版**）：同一谓词对「自解析」形态必须报出、对无关形态不得误报。
    assert.ok(ledgerSelfParseHits('const raw = JSON.parse(readFileSync(join(root, ".thincoder", "tasks.json"), "utf8"))', "mutant").length > 0,
      "自证①：自解析形态必须被同一谓词抓到（临时把看板改成自解析 ⇒ 本腿必红，实测见交付报告）")
    assert.deepEqual(ledgerSelfParseHits('const d = JSON.parse(JSON.stringify(x)); const t = readFileSync(p, "utf8")', "probe"), [],
      "自证②：与台账无关的解析（深拷贝 / 读结构化文档源）不得被误报")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：让看板载荷自建一份任务（不经 readTasksView）⇒ ① 的集合比对红；让客户端读盘/自解析 ⇒ ③ 红。

// ═══════════════ 客户端空载夹具（T-8 / T-12 / T-13 / T-14 共用） ═══════════════

/**
 * **带状态的 hook 桩**（让**真实客户端组件**能在 node 里被渲染与交互）：
 *   · `useState` 的值住在逐槽的 store 里，setter 真的写回 ⇒ 点一下按钮、重渲染就看得见变化；
 *   · `useEffect` 每个槽**只执行一次**（与 React 的空依赖表同效）⇒ 组件挂载时的拉取会真的发起；
 *   · 定时器在沙箱里被换成 no-op（测试不留真定时器）。
 * 这不是"模拟一个 React"，而是**给同一份组件源码一套最小可观测宿主**——
 * 被断言的是 `lib/client.js` 的真实渲染分支，不是复制的第二份实现。
 */
function makeHookHarness() {
  const store = []
  let idx = 0
  const React = {
    createElement: function (type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return { type, props: props || {}, children }
    },
    useState: (init) => {
      const i = idx++
      if (!(i in store)) store[i] = init
      return [store[i], (v) => { store[i] = typeof v === "function" ? v(store[i]) : v }]
    },
    useEffect: (cb) => {
      const i = idx++
      if (!(i in store)) { store[i] = "ran"; try { cb() } catch { /* 渲染期异常由断言捕获 */ } }
    },
    useCallback: (fn) => { idx++; return fn },
    useRef: (init) => { const i = idx++; if (!(i in store)) store[i] = { current: init }; return store[i] },
  }
  return { React, render: (comp, props) => { idx = 0; return comp(props) } }
}

/**
 * 空载 `lib/client.js`（浏览器 bundle）并取出 `exports`。
 * @param {{React?: object, fetchImpl?: Function}} opts 注入桩（React / fetch）
 */
function loadClientBundle(opts = {}) {
  const src = readFileSync(join(PLUGIN_DIR, "lib", "client.js"), "utf8")
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (m) => { captured = m } } },
    console,
    // clipboard: null ⇒ 宿主**没有**剪贴板（用来验「退化为可选中区块」那条路径）
    navigator: opts.clipboard === null ? {} : { clipboard: { writeText: () => Promise.resolve() } },
    // 定时器全部 no-op：测试不留真定时器（生产面上它是 15s 的纯拉取）
    setTimeout: (fn) => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    fetch: opts.fetchImpl || (() => Promise.resolve({ json: () => Promise.resolve({ ok: true }) })),
  }
  createContext(sandbox)
  runInContext(src, sandbox, { filename: "lib/client.js" })
  assert.ok(captured && typeof captured.factory === "function", "客户端 bundle 必须经 __ModuleLoader__.load 注册一个 factory")
  const react = opts.React || makeHookHarness().React
  const exportsObj = captured.factory((name) => (name === "react" ? react : {}))
  assert.equal(typeof exportsObj.apply, "function", "客户端 exports 必须有 apply")
  return { exports: exportsObj, src, id: captured.id }
}

/** 假客户端 ctx（`ctx.get` 是**函数**形态；`ctx.effect` 立即执行回调并交回 disposer）。 */
function fakeClientCtx(betterSidebar) {
  const calls = { slots: [], registered: null, tab: null, tabDisposed: 0, effectDispose: null, opened: [] }
  // 只有服务**真带 registerTab** 时才包一层（用于捕获 descriptor）；否则原样透传（保持"形状不认识"这一态）
  let sb = betterSidebar
  if (betterSidebar && typeof betterSidebar.registerTab === "function") {
    sb = Object.assign({}, betterSidebar, {
      registerTab: (d) => {
        calls.tab = d
        const inner = betterSidebar.registerTab(d)
        return () => { calls.tabDisposed++; if (typeof inner === "function") inner() }
      },
      // ★ 2026-10-17 缺口修复：`registerTab` 只注册**类型**（better-sidebar `:1415` 存进 Map），
      //   **不会**让任何东西出现在侧栏；真正摆出来的是 `openTab({type})`（同档 `:1516`）。
      //   夹具必须捕获它，否则「面板可见」这条永远是**空断言** —— T-12 当年就是这么漏的。
      openTab: (seed, scope) => { calls.opened.push({ seed, scope }) },
    })
  }
  const ctx = {
    get: (name) => (name === "connection" ? { api: null } : name === "betterSidebar" ? sb : undefined),
    slots: {
      inject: (slot, fn) => { calls.slots.push(slot); fn(); return () => {} },
      register: (desc) => { calls.registered = desc; return () => {} },
    },
    effect: (fn) => { calls.effectDispose = fn(); return () => {} },
  }
  return { ctx, calls }
}

/** 把桩 React 的元素树摊平成文本序列（函数组件就地求值——hook 全是静态桩）。 */
function treeText(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) treeText(c, out); return out }
  if (typeof node === "object") {
    if (typeof node.type === "function") return treeText(node.type(node.props), out)
    for (const c of node.children || []) treeText(c, out)
    return out
  }
  return out
}

// ═══════════════ T-8：无 better-sidebar ⇒ 降级不崩 + 会话内看板可用（US-11） ═══════════════

test("T-8（US-11 · N-4）: 无 better-sidebar 时 apply 不抛、设置页不受影响；降级看板由 readTasksView 派生", () => {
  const ws = freshWs()
  try {
    const { exports: mod, src } = loadClientBundle()
    // ① 静态半：可选依赖**只能** ctx.get，**不得**进 inject（缺席时会让整个客户端半边永久 pending）
    //    ★ `[...mod.inject]` 的展开**不是**装饰：`mod` 由 `node:vm` 的 `runInContext` 求值得到 ⇒
    //      它的 Array 是**另一个 realm 的原型**，而本档用的是 `node:assert/strict`
    //      （`deepEqual` **就是** `deepStrictEqual`，**比原型**）⇒ 内容相同也会判不等
    //      （宿主实测：`actual` 与 `expected` 印出来一模一样却红）。展开只把值搬进本 realm，
    //      **不改断言强度**（既不换 `==`，也不降级成字符串比较）。
    assert.deepEqual([...mod.inject], ["slots", "connection"], "客户端 inject 必须逐字不变（T-8① / 设计档 §五末）")
    assert.ok(src.includes('ctx.get("betterSidebar")'), "可选服务必须用 ctx.get 取")

    // ② 无 better-sidebar：apply 不抛，设置页 slot 照常注册（机制本体零影响）
    const noSb = fakeClientCtx(undefined)
    assert.doesNotThrow(() => mod.apply(noSb.ctx), "没有 better-sidebar 时 apply **不得抛**")
    assert.deepEqual(noSb.calls.slots, ["settings.section"], "设置页 slot 必须照常注册（降级 ≠ 整体失效）")
    assert.equal(noSb.calls.tab, null, "没有服务 ⇒ 不注册 tab")

    // ③ 服务形状不认识（有对象但没 registerTab）⇒ 同样静默跳过
    const oddSb = fakeClientCtx({ something: true })
    assert.doesNotThrow(() => mod.apply(oddSb.ctx), "服务形状不认识时同样不得抛")

    // ④ registerTab 自己抛错 ⇒ 被吞（只 warn），不影响设置页
    const throwSb = fakeClientCtx({ registerTab: () => { throw new Error("boom") } })
    assert.doesNotThrow(() => mod.apply(throwSb.ctx), "registerTab 抛错必须被吞（不影响其它功能）")

    // ⑤ host 端降级渲染（US-11 的「会话内渲染」）：由 readTasksView 派生，且**不抛**
    seedLedger(ws, [task("t-1", { status: "在做", title: "在办的一条", check: "跑 X 看到 Y" })], 1)
    const payload = buildTasksBoardPayload({ ws, sessionId: "s-1", config: {}, drift: null })
    // ★ **判别力**（定点修复 3）：载荷**定型之后**再改盘。若渲染面自己去解析 tasks.json，盘上后落的
    //   t-9 就会出现在文本里 ⇒ 本腿红。旧写法断言 `boardText.includes("readTasksView")`，命中的是
    //   **渲染表头里的那个字面**——对「自己解析同一文件」这个变异零判别力（表头恒在）。
    seedLedger(ws, [task("t-9", { status: "在做", title: "盘上后落的另一条" })], 5)
    let boardText = ""
    assert.doesNotThrow(() => { boardText = renderBoardText(payload) }, "降级渲染不得抛")
    assert.ok(boardText.includes("t-1"), "降级渲染必须含**载荷里**的台账内容：\n" + boardText)
    assert.ok(!boardText.includes("t-9"),
      "★ 渲染面**不得**自己去解析 tasks.json（盘上后落的 t-9 不得出现）：\n" + boardText)
    assert.equal(payload.generatedFrom, "readTasksView", "载荷必须自证唯一读来源（T-8③）")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：把 "betterSidebar" 加进 inject ⇒ ① 红；让 apply 在服务缺席时抛（去掉 try 或必调 registerTab）⇒ ② 红；
// 让降级渲染自己解析 tasks.json（不认传入的载荷）⇒ ⑤ 的「t-9 不得出现」断言红（实测见交付报告：
// 临时改成自解析 ⇒ 该断言红，随即回退）。
//   ⑤ 的**判别力度**（定点修复 3）：断言的是「载荷定型后改盘，后落的那条**不得**出现在渲染里」——
//   它咬的是「渲染只认传入载荷」这条性质，而占位符式的 `includes("readTasksView")`（表头字面）咬不住任何东西。

// ═══════════════ T-12：tab 注册不抛 + 点击载荷三要素（US-6） ═══════════════

test("T-12（US-6）: tab 注册不抛（有/无服务两态）+ 点击载荷含三要素（人话说明 / 文档清单 / 核验进度）", async () => {
  const ws = freshWs()
  try {
    const { exports: mod } = loadClientBundle()
    // ① 有服务：注册恰一次，descriptor 形状可用
    const withSb = fakeClientCtx({ registerTab: () => () => {} })
    assert.doesNotThrow(() => mod.apply(withSb.ctx), "有服务时注册不得抛")
    const tabDesc = withSb.calls.tab
    assert.ok(tabDesc, "必须真的注册了 tab")
    assert.equal(tabDesc.id, "thincoder:tasks", "tab id 稳定")
    assert.equal(typeof tabDesc.component, "function", "tab 必须带组件")
    assert.equal(tabDesc.single, true, "同一会话内单实例（避免重复看板）")
    assert.equal(typeof tabDesc.title, "function", "标题按语言环境惰性求值（与内置 tab 同款）")
    // ★ 2026-10-17 **缺口修复（用户实测「重启后找不到面板」）**：**注册 ≠ 可见**。
    //   `registerTab` 只把 descriptor 存进 Map（better-sidebar `:1415-1425`），**不会**渲染任何东西；
    //   必须再 `openTab({type})` 一次才会真的开出一个该类型的 tab（同档 `:1516`）。
    //   原 T-12 只断言「注册不抛」⇒ 在「注册成功但无人打开」这个**真实缺口**上**恒绿**。补下面两条。
    assert.equal(withSb.calls.opened.length, 1,
      "注册后必须调用**恰一次** openTab —— 否则面板存在但**永远不可见**（这正是用户实测到的现象）")
    // ★ 比**字段**而不是整个对象：`seed` 是在 `node:vm` 沙箱里造的 ⇒ 原型与本 realm 不同，
    //   而本档 `import assert from "node:assert/strict"` 的 `deepEqual` **比原型**（同一个坑 T-8① 踩过一次）。
    assert.equal(withSb.calls.opened[0].seed.type, "thincoder:tasks",
      "openTab 必须按**已注册的 tab 类型**打开")
    // 变异自证：删掉 openTab 调用 ⇒ 上一条 opened.length 变 0 ⇒ 红；把 seed.type 写错 ⇒ deepEqual 红
    // 无服务态（T-12 的「无 better-sidebar 时亦然」）——与 T-8 各自独立断言
    const noSb = fakeClientCtx(undefined)
    assert.doesNotThrow(() => mod.apply(noSb.ctx), "无服务时注册同样不得抛")

    // ② 点任务的载荷三要素（host 侧产出，浏览器只渲染 ⇒ 三要素可机检）
    seedLedger(ws, [task("t-1", { kind: "decision", title: "确认 OCR 方案", why: "识别率不达标", status: "在做" })], 1)
    const payload = buildTasksBoardPayload({ ws, sessionId: "s-1", config: {}, drift: { goal: null, criteria: null, debts: [], pushback: 0 } })
    const click = payload.ledger.decisions[0].click
    for (const k of ["plain", "docs", "progress"]) {
      assert.ok(Array.isArray(click[k]) ? click[k].length > 0 : String(click[k] ?? "").trim() !== "",
        "点击载荷必须含非空的「" + k + "」：" + JSON.stringify(click[k]))
    }
    assert.ok(click.docs.some((p) => p.endsWith("tasks.json")), "文档清单至少含台账真源路径：" + JSON.stringify(click.docs))
    assert.ok(click.plain.includes("确认 OCR 方案"), "人话说明必须讲这一项本身：" + click.plain)

    // ③ 渲染面（拿**真实客户端组件**渲染）：默认折叠 + 展开后详情里能看到三段
    const r = await renderClientBoard(payload, { detail: true })
    assert.ok(r.collapsedText.includes("任务台账"), "折叠态必须有状态栏（不必展开就知道有没有待决策的项）")
    assert.ok(!r.collapsedText.includes("待你决策（"), "★ 默认**折叠**（与宿主 TodoPanel 一致，设计-D12）")
    for (const seg of ["人话说明", "相关文档", "核验进度"]) {
      assert.ok(r.text.includes(seg), "点击详情必须渲染「" + seg + "」段：\n" + r.text)
    }
    assert.ok(r.text.includes("防漂移状态区"), "看板顶部必须有防漂移状态区（FR-11）")
    assert.ok(r.text.includes("确认 OCR 方案"), "看板必须列出该条目")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：去掉 buildTaskClickPayload 里的任一要素（如 docs 恒空数组）⇒ ② 红；组件不渲染某一段 ⇒ ③ 红；
// 默认展开（初值 true）⇒ ③ 的折叠断言红。

/**
 * 用**真实客户端组件**渲染看板：首渲染 → 放行 fetch 的微任务 → 点「展开」→（可选）点某按钮 / 点「看详情」。
 * @param {{detail?: boolean, clickLabel?: string, clipboard?: null}} [opts]
 * @returns {Promise<{text, collapsedText, tree, tab}>}
 */
async function renderClientBoard(payload, { detail = false, clickLabel = null, clipboard } = {}) {
  const harness = makeHookHarness()
  const { exports: mod } = loadClientBundle({
    React: harness.React,
    fetchImpl: () => Promise.resolve({ json: () => Promise.resolve(payload) }),
    clipboard,
  })
  let tabDesc = null
  mod.apply(fakeClientCtx({ registerTab: (d) => { tabDesc = d; return () => {} } }).ctx)
  assert.ok(tabDesc && typeof tabDesc.component === "function", "必须先注册出可渲染的 tab descriptor")
  const props = { ctx: {}, scope: { sessionId: "s-1" }, tab: { id: "thincoder:tasks" }, visible: true }
  const first = harness.render(tabDesc.component, props) // 挂载：effect 发起拉取（promise 尚未落地）
  const collapsedText = treeText(first).join("\n")
  for (let i = 0; i < 8; i++) await Promise.resolve() // 放行 fetch → json → setState 的微任务链
  clickButton(first, "展开") // 折叠 → 展开（默认折叠，设计-D12）
  let tree = harness.render(tabDesc.component, props)
  assert.ok(!treeText(tree).join("\n").includes("看板数据不可得"), "展开后不得是「数据不可得」态：" + treeText(tree).join("\n").slice(0, 200))
  if (detail) {
    clickButton(tree, "看详情")
    tree = harness.render(tabDesc.component, props)
  }
  if (clickLabel) {
    clickButton(tree, clickLabel)
    tree = harness.render(tabDesc.component, props)
  }
  return { text: treeText(tree).join("\n"), collapsedText, tree, tab: tabDesc }
}

/** 在元素树里按**可见文本**找按钮（找不到 ⇒ `null`；函数组件就地求值）。 */
function findButton(node, label) {
  if (node === null || node === undefined || typeof node === "boolean") return null
  if (Array.isArray(node)) { for (const c of node) { const r = findButton(c, label); if (r) return r } return null }
  if (typeof node !== "object") return null
  if (typeof node.type === "function") return findButton(node.type(node.props), label)
  const kids = node.children || []
  const own = kids.filter((c) => typeof c === "string").join("")
  if (node.type === "button" && own.trim() === label) return node
  for (const c of kids) { const r = findButton(c, label); if (r) return r }
  return null
}

/** 找到按钮并点它（找不到 ⇒ **断言失败**，绝不静默跳过）。 */
function clickButton(tree, label) {
  const btn = findButton(tree, label)
  assert.ok(btn, "必须存在按钮「" + label + "」（实测渲染文本：\n" + treeText(tree).join("\n").slice(0, 300) + "）")
  assert.equal(typeof btn.props.onClick, "function", "按钮「" + label + "」必须带 onClick")
  btn.props.onClick()
  return btn
}

// ═══════════════ T-13：复制话术（默认模板句 + 可配置，US-7） ═══════════════

test("T-13（US-7）: 复制话术含默认模板句且**模板可配置**；两个复制按钮都在", async () => {
  const ws = freshWs()
  try {
    seedLedger(ws, [
      task("t-1", { kind: "decision", title: "等你拍板的一条" }),
      task("t-2", { status: "在做", title: "在办的一条" }),
    ], 2)
    const dflt = buildTasksBoardPayload({ ws, sessionId: "s-1", config: {}, drift: null })
    const one = dflt.ledger.decisions[0]
    assert.ok(one.copyPrompt.includes(DEFAULT_COPY_TEMPLATE), "默认话术必须含默认模板句：" + one.copyPrompt.slice(0, 60))
    assert.ok(one.copyPrompt.includes("t-1") && one.copyPrompt.includes("等你拍板的一条"), "话术必须点名是哪一项")
    assert.ok(dflt.copyAllDecisions.includes(DEFAULT_COPY_TEMPLATE), "「复制全部待你决策的项」同样带模板句")
    assert.ok(dflt.copyAllDecisions.includes("t-1"), "全部话术必须逐条列出决策项")

    // 可配置：改配置 ⇒ 输出随之变（腿 T-13 的关键判据：不得硬编码模板）
    const custom = buildTasksBoardPayload({
      ws, sessionId: "s-1", config: { ledger: { copyTemplate: "请用两句话讲清进度，并给出你的建议。" } }, drift: null,
    })
    assert.ok(custom.ledger.decisions[0].copyPrompt.includes("请用两句话讲清进度"), "模板必须可配置")
    assert.ok(!custom.ledger.decisions[0].copyPrompt.includes(DEFAULT_COPY_TEMPLATE), "配置生效后不得再出现默认句")

    // 两个复制按钮都在**真实渲染面**上（node 内渲染 `lib/client.js` 的组件）
    const r = await renderClientBoard(dflt)
    assert.ok(r.text.includes("问这一项"), "必须有「问这一项」按钮：" + r.text.slice(0, 300))
    assert.ok(r.text.includes("复制全部待你决策的项"), "必须有「复制全部待你决策的项」按钮")
    // 剪贴板失败 ⇒ 退化为可选中区块（行为面：把 navigator.clipboard 去掉后点「问这一项」，出现可选中文本块）
    const noClip = await renderClientBoard(dflt, { clickLabel: "问这一项", clipboard: null })
    assert.ok(noClip.text.includes("剪贴板不可用"), "剪贴板不可用时必须退化为可选中文本块：" + noClip.text.slice(-300))
    assert.ok(noClip.text.includes(DEFAULT_COPY_TEMPLATE), "退化区块里必须是可复制的**话术全文**")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：把模板硬编码进 buildCopyPrompt（忽略入参）⇒ 「模板必须可配置」红；去掉 manual 回退分支 ⇒ 最后一段红。

// ═══════════════ T-14：决策区置顶 + 空集明确空态（US-8） ═══════════════

test("T-14（US-8）: 决策分区在任务区**之前**且空集给明确空态（不渲染空分区）", async () => {
  const ws = freshWs()
  try {
    // ① 有内容：分区顺序 + **真实渲染**顺序
    seedLedger(ws, [
      task("t-1", { kind: "decision", title: "等你拍板的一条" }),
      task("t-2", { status: "在做", title: "在办的一条" }),
    ], 2)
    const payload = buildTasksBoardPayload({ ws, sessionId: "s-1", config: {}, drift: null })
    assert.equal(payload.sections[0].key, "decisions", "决策分区必须置顶（sections[0]）")
    assert.equal(payload.sections[0].top, true)
    const r = await renderClientBoard(payload)
    const iDec = r.text.indexOf("待你决策")
    const iTask = r.text.indexOf("任务（")
    assert.ok(iDec >= 0 && iTask >= 0, "两段都必须渲染：\n" + r.text)
    assert.ok(iDec < iTask, "决策区必须排在任务区**之前**（T-14）")
    assert.ok(r.text.includes("待你决策（1）"), "有内容时必须渲染决策段")

    // ② 空集：明确空态 + **不渲染空分区**
    const ws2 = freshWs()
    try {
      const empty = buildTasksBoardPayload({ ws: ws2, sessionId: "s-1", config: {}, drift: null })
      assert.ok(typeof empty.emptyState === "string" && empty.emptyState.trim() !== "", "空集必须给明确空态文案")
      const er = await renderClientBoard(empty)
      assert.ok(er.text.includes(empty.emptyState), "空态文案必须真的渲染出来：\n" + er.text)
      for (const seg of ["待你决策（", "卡住（", "任务（"]) {
        assert.ok(!er.text.includes(seg), "空集**不得**渲染空分区：" + seg + "\n" + er.text)
      }
    } finally { rmSync(ws2, { recursive: true, force: true }) }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：把决策分区排到任务区之后（sections 顺序对调）⇒ ① 红；空集也渲染分区壳 ⇒ ② 红。

// ═══════════════ T-7：结构化文档只读源（US-10 / D10「不猜、不部分解析」） ═══════════════

test("T-7（US-10 · D10）: parseChecklistDoc —— 列数不足/无状态列 ⇒ null；实例验收表解析出条数与状态分布", () => {
  // ① 阴性：不达标一律 null（**不部分解析**）
  assert.equal(parseChecklistDoc("| ID | 项目 | 证据 |\n|---|---|---|\n| 1 | a | b |"), null, "3 列 ⇒ null")
  assert.equal(parseChecklistDoc("| ID | 项目 | 说明 | 证据 |\n|---|---|---|---|\n| 1 | a | b | c |"), null, "4 列但**无状态列** ⇒ null")
  assert.equal(parseChecklistDoc("这是一段自由文本，没有表格。"), null, "无表格 ⇒ null")
  assert.equal(parseChecklistDoc(""), null, "空文本 ⇒ null")
  assert.equal(parseChecklistDoc(null), null, "非文本 ⇒ null")
  // 分隔线缺失（表头 + 直接数据行）也不认（形状不对 ⇒ 不猜）
  assert.equal(parseChecklistDoc("| ID | 项目 | 状态 | 证据 |\n| 1 | a | TODO | b |"), null, "缺分隔线 ⇒ null")

  // ② 阳性：**实例风格**的验收表（ID / 项目 / 状态 / 证据 ＋ 验收五件的列）
  const fixture = [
    "| ID | 项目 | 状态 | 证据 | 命令 | 预期 | 实际 | 基线 |",
    "|---|---|---|---|---|---|---|---|",
    "| A-1 | 登录流程 | TODO | — |  |  |  |  |",
    "| A-2 | 会话恢复 | doing | 已跑通 | node --test x | 12/12 | 12/12 | e4aae98 |",
    "| A-3 | 并发写 | BLOCKED | 等对端 | node --test y | 绿 | 红 | e4aae98 |",
    "| A-4 | 写门 | **PASS** | 前后 sha256 相同 | node --test z | 拒 | 拒 | e4aae98 |",
    "| A-5 | 冲突检测 | FAIL | 未实现 | node --test w | 拒 | 通过 | e4aae98 |",
    "| A-6 | 未知形态 | 待定 | 无 |  |  |  |  |",
  ].join("\n")
  const p = parseChecklistDoc(fixture)
  assert.ok(p, "实例风格的验收表必须被识别")
  assert.equal(p.rows.length, 6, "条数必须逐行数准")
  assert.deepEqual(p.counts, { TODO: 1, DOING: 1, BLOCKED: 1, PASS: 1, FAIL: 1, UNKNOWN: 1, total: 6 },
    "状态分布必须准确（`doing` 大小写不敏感 ⇒ DOING；`待定` 不认识 ⇒ UNKNOWN，**不猜**）")
  assert.equal(p.rows[3].status, "PASS", "`**PASS**` 去装饰后必须识别为 PASS")
  assert.equal(p.rows[5].status, null, "不认识的写法必须如实为 null（不猜）")
  assert.equal(p.rows[5].rawStatus, "待定", "原文必须保留（可读可查）")
  assert.equal(p.rows[1].piecesComplete, true, "五件齐全的行必须判「齐」")
  assert.equal(p.rows[0].piecesComplete, false, "有空格的行必须判「不齐」")
  assert.equal(p.rows[0].pieces.command, false, "空格子不算「有命令」（`—` 也不算）")
  assert.equal(p.rows[1].pieces.command, true)

  // ③ **真实验收档**（本仓实例）：条数与**独立数出**的数据行数相等
  const realText = readFileSync(join(PLUGIN_DIR, "docs", "2026-09-05-defect-registry.md"), "utf8")
  const real = parseChecklistDoc(realText)
  assert.ok(real, "本仓真实登记表必须能被识别（≥4 列且含状态列）")
  assert.equal(real.rows.length, firstTableDataRows(realText),
    "解析出的条数必须 == 独立数出的数据行数（两处不同算法互证）")
  assert.equal(real.counts.total, real.rows.length)
  // ★ 2026-10-17 交付评审 #5：原断言 (=="UNKNOWN 恰等于行数") 把这条腿**钉死在该档当前的列形状**上
  //   （状态列是中文长句 ⇒ 全部「未识别」）；该档将来把状态列改成英文枚举就会红 —— 那是
  //   「对**不属于本契约**的文档形状的依赖」（R4 脆弱测试形态）。改为**守恒式**：
  //   每一行必须恰好落进一个状态桶；UNKNOWN 作为**读数**打印，不再作断言。
  const bucketSum = ["TODO", "DOING", "BLOCKED", "PASS", "FAIL", "UNKNOWN"]
    .reduce((a, k) => a + (real.counts[k] ?? 0), 0)
  assert.equal(bucketSum, real.rows.length,
    "守恒式：各行必须恰好落进一个状态桶（桶和 == 行数）—— 实测桶和 " + bucketSum + " / 行数 "
    + real.rows.length + " / UNKNOWN = " + (real.counts.UNKNOWN ?? 0) + "（读数，不作断言）")
  assert.ok(real.columns.length >= 4, "列数 ≥4：实测 " + real.columns.length)

  // ④ 文档**读入口**的边界（`readChecklistDocs`；定点修复 5 的安全型扩张，已登记设计档 §15.2）：
  //    **越出工作区的路径一律拒读** —— 配置不能变成任意文件读；且拒绝必须发生在**读之前**。
  const ws = freshWs()
  try {
    const seen = []
    const loader = (p) => { seen.push(p); return fixture }
    const outsideAbs = join(tmpdir(), "thincoder-outside-fixture.md")
    const got = readChecklistDocs({
      ws,
      docPaths: ["../escape.md", outsideAbs, "docs/in-workspace.md"],
      loader,
    })
    assert.equal(got.length, 3, "逐条给结果（不静默丢条目）")
    assert.equal(got[0].ok, false, "相对越界路径必须被拒：" + JSON.stringify(got[0]))
    assert.ok(got[0].error.includes("越出工作区"), "拒绝文案必须说清原因：" + got[0].error)
    assert.equal(got[1].ok, false, "**绝对路径越界**同样被拒：" + JSON.stringify(got[1]))
    assert.equal(got[2].ok, true, "工作区内的路径必须照常读（否则本腿是恒拒断言）：" + JSON.stringify(got[2]))
    assert.deepEqual(seen, [resolve(ws, "docs/in-workspace.md")],
      "★ 越界路径必须**在读之前**被拒（loader 只应看到工作区内那一条）：实测 " + JSON.stringify(seen))
    // 谓词自证（防「凡路径皆拒」的假绿）：把同一份内容放到工作区**内** ⇒ 解析成功且拿到要数
    assert.ok(got[2].counts && got[2].counts.total === 6, "工作区内那条必须真的解析出 6 条：" + JSON.stringify(got[2].counts))
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：允许 3 列也解析（把 `columns.length < 4` 改成 `< 1`）⇒ ① 红；把不认识的写法猜成默认状态
// （如 `status = status ?? "TODO"`）⇒ ② 的 UNKNOWN 与 null 断言红；④ 把 `readChecklistDocs` 的越界
// 分支删掉（`continue` 换成直接读）⇒ 越界两条断言 + `seen` 那条同时红。

/** 独立数法（与 `parseChecklistDoc` 不同的实现）：文档**第一张表**的数据行数（去掉表头与分隔线）。 */
function firstTableDataRows(doc) {
  const lines = String(doc).split(/\r?\n/)
  let start = -1
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    const isRow = lines[i].trim().startsWith("|")
    if (!isRow) { if (start >= 0) break; continue }
    if (start < 0) { start = i; continue }
    if (i === start + 1) continue // 分隔线
    if (lines[i].trim().replace(/\|/g, "").trim() === "") continue // 空行
    n++
  }
  return n
}

// ═══════════════ T-9：ledger.mode = off（US-9） ═══════════════

test("T-9（US-9）: ledger.mode = off ⇒ 个人台账分区消失、**防漂移状态区仍在**", async () => {
  const ws = freshWs()
  try {
    seedLedger(ws, [
      task("t-1", { kind: "decision", title: "等你拍板的一条" }),
      task("t-2", { status: "在做", title: "在办的一条" }),
    ], 2)
    const drift = { goal: { id: "g-1", objective: "把台账做出来" }, criteria: { criteria: "16 条腿全绿", check: "node --test test/tasks.test.mjs" }, debts: ["有未验证的产品代码改动"], pushback: 2 }
    const off = buildTasksBoardPayload({ ws, sessionId: "s-1", config: { ledger: { mode: "off" } }, drift })
    assert.equal(off.mode, "off", "mode 必须如实透出")
    assert.equal(off.ledger, null, "个人台账分区必须消失")
    assert.deepEqual(off.sections, [], "分区列表必须为空（不渲染空分区）")
    assert.ok(off.offNote && off.offNote.includes("ledger.mode=off"), "必须给关闭说明：" + off.offNote)
    assert.ok(off.drift && off.drift.goal && off.drift.criteria, "★ 防漂移状态区**仍在**（读数照旧送达）")

    // 渲染面：状态区在、台账分区不在（真实客户端组件 + host 降级渲染两处都验）
    const r = await renderClientBoard(off)
    assert.ok(r.text.includes("防漂移状态区"), "渲染面必须仍有防漂移状态区：\n" + r.text)
    assert.ok(r.text.includes("把台账做出来"), "状态区的读数必须真的渲染出来")
    assert.ok(r.text.includes("ledger.mode=off"), "必须显示关闭说明")
    for (const seg of ["待你决策（", "卡住（", "任务（"]) {
      assert.ok(!r.text.includes(seg), "关闭后不得渲染台账分区：" + seg)
    }
    const hostText = renderBoardText(off)
    assert.ok(hostText.includes("防漂移状态区") && !hostText.includes("待你决策（"), "host 降级渲染同样：状态区在、台账分区不在")
    assert.equal(renderTaskDigest(readTasksView(ws), { mode: "off" }), "", "注入行同批消失（US-9 的另一半）")

    // 反向自证（防「关了就什么都没了」的过度解释）：默认 standalone 时两段都在
    const on = buildTasksBoardPayload({ ws, sessionId: "s-1", config: {}, drift })
    assert.ok(on.ledger && on.sections.length > 0, "默认 standalone ⇒ 台账分区照常")
    assert.ok(on.drift, "默认态也带状态区")

    // 配置面归一（单一解析点 `resolveLedgerConfig`）：非法值回落默认、数组去空、条数封顶、模板回落
    assert.equal(resolveLedgerConfig({}).mode, "standalone", "缺省 mode = standalone（US-9 的默认档）")
    assert.equal(resolveLedgerConfig({ ledger: { mode: "wat" } }).mode, "standalone", "非法 mode ⇒ 回落默认")
    assert.equal(resolveLedgerConfig({ ledger: { mode: "off" } }).mode, "off")
    assert.equal(resolveLedgerConfig({ ledger: { copyTemplate: "  " } }).copyTemplate, DEFAULT_COPY_TEMPLATE, "空模板 ⇒ 回落默认句")
    assert.deepEqual(resolveLedgerConfig({ ledger: { docPaths: ["a.md", "  ", "b.md"] } }).docPaths, ["a.md", "b.md"], "文档清单去空")
    assert.equal(resolveLedgerConfig({ ledger: { docPaths: Array.from({ length: 20 }, (_, i) => "d" + i + ".md") } }).docPaths.length,
      MAX_DOC_PATHS, "文档清单条数封顶（防把整仓 md 塞进看板）")
    // ★ 上限的**另一面**（定点修复 5 的安全型扩张，已登记设计档 §15.2）：读面是**截断**（fail-open，
    //   上面那条），**写面（配置 PUT 的校验器）是拒**（fail-closed）—— 两面朝向不同，必须分别钉住。
    assert.equal(isValidDocPathList(Array.from({ length: MAX_DOC_PATHS }, (_, i) => "d" + i + ".md")), true,
      "恰在上限（8 条）⇒ 放行")
    assert.equal(isValidDocPathList(Array.from({ length: MAX_DOC_PATHS + 1 }, (_, i) => "d" + i + ".md")), false,
      "**第 9 条 ⇒ 拒**（写面不是截断，是拒）")
    assert.equal(isValidDocPathList([]), true, "空清单合法（不设下限）")
    assert.equal(isValidDocPathList([""]), false, "空串项 ⇒ 拒（去空在读面做，写面只认合法形状）")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：把 `off` 分支改成整段返回（连 drift 一起丢）⇒ 状态区两条断言红；默认值改成 off ⇒ 反向自证红。

// ═══════════════ 腿部收口（16 条 = T-1…T-15，T-4 拆 a/b） ═══════════════
