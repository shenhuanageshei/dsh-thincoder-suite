// tasks.test.mjs — 批 36「个人任务台账 + 侧栏看板」机检腿（设计档 §九 = 权威腿定义）。
//
// 腿清单（**T-1…T-20，T-4 拆 a/b ⇒ 共 21 条**；本档顶层 `test(` 数 = 21，与下方逐条一一对应。
// ★ 批36-补3 的 T-21/T-22 **并入既有块**（T-12 ④ 段 / T-4a ⑤ 段），**不新开顶层 `test(`** ⇒ 仍是 21 条；
//   ★ 批43 的 T-4c/T-4d/T-4e/T-4f 同样**并入既有块**（T-4b / T-5）⇒ 计数与枚举仍为 21 条，不新增顶层 `test(`）；
//   ★ 批44 的 T-9d/T-9e/T-9h/T-9f/T-9g 同样**并入 T-9 块** ⇒ 计数与枚举仍为 21 条，不新增顶层 `test(`）
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
//        ＋ ④ 的去重/上限三条腿（T-9a/T-9b/T-9c）与修复轮 3 补的两腿（稀疏数组不得绕过上限 ·
//          无 ToPrimitive 值不得抛）**都在本块**（不在 T-4a：那是看板块）
//        ＋ 批44（t-8）的**五条新腿**在本块：T-9d（规则源按去重后判）/ T-9e（读面先去重再截断）/
//          T-9h（文案 n、界面「已填 N / 8」与「文档清单 N 条」都钉去重后数字）/ T-9f·T-9g（源码片段锁）
//          ★ **第六条是既有 C-L4**（两侧逐夹具等值），它留在 `test/config-api.test.mjs` 的 U3c2 块，**不在本块**
//          （2026-10-19 代码评审 #3 订正：原写「六条腿也在本块」，与枚举不符）
//   T-10 evidence/reason 命中疑似凭据 ⇒ 拒写（**非打码**）
//   T-11 rev 冲突 ⇒ 拒且零写入 + fail-loud 文案（＋ 跨会话读回、落点与键控）
//   T-12 tab 注册不抛（有/无服务两态）＋ 点击载荷三要素（人话说明 / 文档清单 / 核验进度）
//   T-13 复制话术含默认模板句且**模板可配置**；两个复制按钮都在（含剪贴板失败退化路径）
//   T-14 决策分区**置顶**（在任务区之前）＋ 空集给明确空态（**不渲染空分区**）
//   T-15 零新增依赖 · 零宿主 import · 零 todo_write 调用点 · 零 todos 投影读取（**三形口径**：
//        引号字面 / 调用形 / **裸属性读**）· 客户端 inject 不变
//   —— 批 36-补（归属与交接 + 用户命令；设计档 §十六）——
//   T-16 `applyTaskClaim` **只改 owner/claimedFrom**（status/evidence/createdBy 逐字不变）
//   T-17 **两会话互不淹没**：本会话视图只看到自己的 · 待接手看到对方未完成的 · 接手按钮走同一道门
//   T-18 **旧台账兼容**：无 owner/createdBy ⇒ null，不抛、不迁移、不改写文件
//   T-19 命令面：缺 `commands` 服务 ⇒ 不抛/不注册/只 warn（工具与看板照常）；有则四条全注册
//   T-20 命令走**同一道写门**：`/task_done` 无凭据 ⇒ 拒且零写入（拒绝码由写门产出）
//   —— 批 36-补3（§18.4 / §19.9；**并入既有块，不新开顶层 test(**）——
//   T-21a 优先级徽标渲染（0 与负数不渲染）                          ⇒ 并入 T-12 块（④-a；文案面由批38 T-32 接管）
//   T-21b 优先级徽标源码面（渲染判据 priority>=1）                  ⇒ 并入 T-4a 块（⑤；档位映射由批38 T-32 接管）
//   环图腿 五态环图（从 ledger 行自己数 · 中心总数 · 图例 · 五段配色；总数 0 不渲染） ⇒ 并入 T-12 块（④-b）
//   默认展开腿 面板默认展开 · 折叠分支保留且可切换                  ⇒ 并入 T-12 块（③）
//   T-22 毛玻璃：变量必须 color-mix 派生 · 卡片级 backdrop-filter · 行/嵌套详情不模糊 · `.tc-` 内无硬编码白/黑底
//        ⇒ 并入 T-4a 块（⑤）
//   —— 批38（§21.2 / §21.4；同样**并入既有块** ⇒ 本档顶层 `test(` 数仍为 21）——
//   T-31 可滚动：内容区 overflow-y:auto + min-height:0 + 常显细滚动条 ⇒ 并入 T-4a 块（⑥）
//   T-32 优先级语义化：档位词（紧急/高/中/低）· 0/负数不渲染 · 台账仍存数字 ⇒ 并入 T-4a（源码）/ T-12（④-a）
//   T-33 全部展开/全部收起：两控件 · 收起态不渲染 meta 与按钮 · 默认展开 ⇒ 并入 T-12 块（④-c）
//   T-34 五态显眼：行色条 · 实心 pill · 分区色条 · 五态图例          ⇒ 并入 T-12 块（④-d）
//   —— 批42（t-4 七条 🔵 除尘；同样**并入既有块** ⇒ 本档顶层 `test(` 数仍为 21）——
//   ④ 文档路径清单：**去重后**判上限（含重复 ⇒ 通过 / 非字符串 ⇒ false 不抛 / 稀疏数组 `Array(9)`
//      与无 ToPrimitive 的值 ⇒ false **且不抛**〔修复轮 3〕）⇒ T-9a/T-9b/T-9c ＋ 两腿，并入 **T-9** 块
//   ⑥ task_update 契约文本锁（描述与 schema 都写 createdBy / owner / claimedFrom 只读）⇒ 并入 T-3 块
//   ⑦ 零写入包装器 withZeroWrite：旧的 assertRejectNoWrite 调用点**全部**改成「包装 + 独立拒绝码断言」
//      （旧 grep 命中 21 行 = 1 处定义 + 20 处调用点，20 处全改）；抛错分支自证 ⇒ 并入 T-1 块（⑦）
//   ⑧ T-7③ 真实档改「能解析才断言」+ diagnostic 留痕；**读档路径可注入**（套件内跑到 diagnostic 分支 +
//      真档缺失不红，③-b）；loader 注入的不可解析腿 ⇒ 并入 T-7 块（④-b）
//   ⑨ commandArgsOf 谓词逐字（只认 m[1] === name，无 startsWith 兜底）⇒ 并入 T-20 块（**谓词层 + handler 层**）
//   ⑩ 注入行成本注释（`lib/index.mjs`，**纯注释**、行为零变化）—— 无新腿（既有 T-15 注入点断言照旧）
//   ⑤ 无代码改动（`lib/client.js` 早已拆 propsScope / scopeKey）—— 无腿
//   —— 批43（台账 t-3：摘要预算标定；同样**并入既有块** ⇒ 本档顶层 `test(` 数仍为 21）——
//   T-4c Top-N 截断可见（30 条活任务 ⇒ 「…还有 25 项」）        ⇒ 并入 T-4b 块
//   T-4d 预算边界（**768 标定锁**：≤768 全列 / >768 出尾串）    ⇒ 并入 T-5 块
//   T-4e 注入合计上限（**1150 标定值**；四分支逐条）            ⇒ 并入 T-5 块
//        ＋ 修复轮 3：④ 贴顶守卫 · 边界三腿 · 空段三腿 · 尾串计入预算腿 · ① 加固（保留 ≥2 行）
//   T-4f 跨模块契约锁（合法最坏 512 + 768 = 1281 > 1150 仍被裁）⇒ 并入 T-5 块
//   —— 批44（台账 t-8：docPaths 的「去重」补齐规则源 + 浏览器镜像 + 读面；同样**并入既有块** ⇒ 顶层 `test(` 仍 21）——
//   T-9d 规则源草稿校验：9 行含 1 重复 ⇒ 不报上限；9 行互异 ⇒ 报            ⇒ 并入 **T-9** 块
//   T-9e 读面：9 项含 1 重复 ⇒ 先去重再 slice ⇒ 8 条唯一路径                ⇒ 并入 **T-9** 块
//   T-9h 数字锁：10 行含 1 重复 ⇒「（当前 9 条）」；界面「已填 9 / 8」/「已填 8 / 8」⇒ 并入 **T-9** 块
//   T-9f/T-9g 静态文本锁：规则源 + 浏览器镜像 + 两处展示都含去重调用（不 eval bundle）⇒ 并入 **T-9** 块
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
  ALLOWED_MIGRATIONS, DEFAULT_COPY_TEMPLATE, DIGEST_MAX_CHARS, LEDGER_FILE, LEDGER_SUBDIR, MAX_DOC_PATHS, REJECT_CODES,
  TASK_STATUSES, UPDATABLE_FIELDS, applyTaskClaim, applyTaskCreate, applyTaskTransition, applyTaskUpdate,
  detectSecretShape, isClaimableBy, isOwnedBy, isValidDocPathList, ownerOf, parseChecklistDoc, readTasksView,
  renderTaskDigest, resolveLedgerConfig, resolveTasksPath, serializeLedger, tasksFileSha256, workspaceRootOf,
} from "../lib/tasks.mjs"
import { INJECT_TOTAL_MAX_CHARS, assembleInjection } from "../lib/index.mjs"
import { buildTaskClaimResult, buildTasksBoardPayload, makeTaskTools, readChecklistDocs, renderBoardText } from "../lib/tool-tasks.mjs"
import { TASK_COMMAND_DEFINITION_PREFIX, TASK_COMMAND_NAMES, commandArgsOf, registerTaskCommands } from "../lib/task-commands.mjs"
// 批 44（台账 t-8）：规则源的草稿校验（上限按**去重后**条数）——T-9d/T-9h 直测它。
import { ledgerDraftErrors as lgDraftErrors } from "../lib/ledger-config-text.mjs"

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

/**
 * **零写入包装器**（批 42 ⑦；替换旧 helper「先跑完再核对」的事后形态）。
 * @pre  `ws` = 会话工作区；`fn` = **会尝试写盘**的函数（同步或异步都吃；抛错也照测）
 * @post 返回 `fn()` 的结果（thenable 则 await 后的值）
 * @post 期间文件字节变了 ⇒ 抛断言错误（腿红）；**`fn` 抛错时同样先断言零写入再把错误抛出去**
 *       （否则抛错分支上的 sha 断言被整个跳过 ⇒ 假绿）
 * @post 判据是**期间不变**（先取 sha → 跑 → 再取），不是「跑完之后再比一次」
 * 变异自证：删掉任一分支里的 `assert.equal(tasksFileSha256(ws), before, …)` ⇒ 让某条拒绝路径
 * 真写一次即红（catch 分支的删除 ⇒ 本档 T-1 ⑦ 的「先写再抛」腿红）。
 */
const withZeroWrite = async (ws, fn) => {
  const before = tasksFileSha256(ws)
  try {
    let r = fn()
    if (r && typeof r.then === "function") r = await r
    assert.equal(tasksFileSha256(ws), before, "**拒绝路径必须零写入**（文件 sha256 期间相同）")
    return r
  } catch (e) {
    assert.equal(tasksFileSha256(ws), before, "**拒绝路径（抛错分支）同样必须零写入**")
    throw e
  }
}

/** 拒绝断言（零写入不在这里 —— 它由上面的包装器在**操作期间**结构性保证）。 */
function assertRejectCode(result, code) {
  assert.equal(result?.ok, false, "该操作必须被拒（实测 " + JSON.stringify(result) + "）")
  if (code) assert.equal(result.code, code, "拒绝码必须点名（实测 " + result?.code + "：" + result?.reason + "）")
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

test("T-1（US-2）: 无凭据的 done 被拒且零写入；有凭据才放行", async () => {
  const ws = freshWs()
  try {
    const t = toDoing(ws)
    // 阴性：无凭据 ⇒ 拒（操作**整个**包进零写入包装器 ⇒ 断言覆盖「期间不变」，不是事后核对）
    const bad = await withZeroWrite(ws, () => applyTaskTransition(ws, { id: t.id, to: "完成", expectedRev: t.rev }))
    assertRejectCode(bad, "evidence-required")
    assert.ok(bad.reason.includes("凭据"), "拒写文案必须指路「完成必须留凭据」：" + bad.reason)
    assert.equal(readTasksView(ws).tasks[0].status, "在做", "被拒后状态**不能**前进")

    // 阳性对照（防恒红）：同一调用补上凭据 ⇒ 放行
    const g = applyTaskTransition(ws, { id: t.id, to: "完成", evidence: "跑了 node --test test/login.test.mjs：12/12 绿", expectedRev: t.rev })
    assert.equal(g.ok, true, "有凭据必须放行（否则本腿是恒红断言）：" + JSON.stringify(g))
    const v = readTasksView(ws)
    assert.equal(v.tasks[0].status, "完成")
    assert.ok(v.tasks[0].evidence.includes("12/12"), "凭据必须落盘")
    assert.ok(v.tasks[0].doneAt, "完成时刻必须记下")

    // ⑦ 包装器自身的**抛错分支**自证（批 42 · 评审 #4）：`fn` **先写再抛** ⇒ 包装器必须先断言
    //   零写入、再把错误抛出去。变异：删掉 catch 里的那条断言 ⇒ 抛出去的是原始的 "boom" ⇒ 本段红。
    const wsThrow = freshWs()
    try {
      seedLedger(wsThrow, [task("t-1")], 0)
      await assert.rejects(
        async () => { await withZeroWrite(wsThrow, () => { seedRaw(wsThrow, "被写坏了"); throw new Error("boom") }) },
        /零写入/,
        "fn 抛错时必须**先断言零写入**（否则 sha 断言被跳过 = 假绿）",
      )
      assert.equal(readFileSync(resolveTasksPath(wsThrow), "utf8"), "被写坏了", "夹具自证：fn 确实写过盘（否则本段恒真空）")
    } finally { rmSync(wsThrow, { recursive: true, force: true }) }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：删掉 `applyTaskTransition` 里的 `to === "完成" && evidence === ""` 分支 ⇒ 第一次调用返回 ok:true
// ⇒ 本腿的 assertRejectCode 当场红（且包装器的零写入断言同时红，因为文件被改写）。

// ═══════════════ T-2：blocked 缺 reason / 缺 blockedBy ⇒ 拒（US-3 / US-4） ═══════════════

test("T-2（US-3 · US-4）: blocked 缺 reason、缺/错 blockedBy 均被拒且零写入", async () => {
  const ws = freshWs()
  try {
    const c = applyTaskCreate(ws, { kind: "work", title: "等批 R 落地", check: "对端提交后复核形状", expectedRev: 0 })
    assert.equal(c.ok, true, JSON.stringify(c))
    // ① 缺 reason
    const noReason = await withZeroWrite(ws, () => applyTaskTransition(ws, { id: c.id, to: "卡住", blockedBy: "external", expectedRev: c.rev }))
    assertRejectCode(noReason, "reason-required")
    // ② 有 reason 但 blockedBy 缺失 / 非法
    const noBy = await withZeroWrite(ws, () => applyTaskTransition(ws, { id: c.id, to: "卡住", reason: "对端还没提交", expectedRev: c.rev }))
    assertRejectCode(noBy, "blockedby-required")
    const badBy = await withZeroWrite(ws, () => applyTaskTransition(ws, { id: c.id, to: "卡住", reason: "对端还没提交", blockedBy: "somebody", expectedRev: c.rev }))
    assertRejectCode(badBy, "blockedby-required")
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
        const runMigration = () => applyTaskTransition(ws, { id: "t-1", to, evidence: "凭据", reason: "原因", blockedBy: "self", expectedRev: 0 })
        if (legal) {
          const r = runMigration()
          assert.equal(r.ok, true, "合法迁移 " + from + " → " + to + " 必须放行：" + JSON.stringify(r))
        } else {
          assertRejectCode(await withZeroWrite(ws, runMigration), "illegal-migration")
        }
        checked++
      }
    }
    assert.equal(checked, TASK_STATUSES.length * TASK_STATUSES.length, "全表必须逐对走满（实测 " + checked + " 组）")

    // 非法状态名也在同一道门前被拒（不是「静默当成合法值」）
    seedLedger(ws, [task("t-1")], 0)
    const junk = await withZeroWrite(ws, () => applyTaskTransition(ws, { id: "t-1", to: "已经做完了", expectedRev: 0 }))
    assertRejectCode(junk, "status-invalid")

    // —— 同一道门的另一半：`applyTaskUpdate` 的可改字段**闭集**（设计档 §六 FR-3 的后置）——
    // 设计档 §九 没有为 `applyTaskUpdate` 单列腿；它的后置与状态迁移同住一道写门 ⇒ 并入本腿（同一判据域）。
    seedLedger(ws, [task("t-1", { status: "在做" })], 0)
    assert.deepEqual([...UPDATABLE_FIELDS].sort(), ["check", "priority", "title", "why"], "可改字段闭集是契约本身")
    // ① 命中只读字段 ⇒ **拒**（不是静默忽略）
    const roPatch = await withZeroWrite(ws, () => applyTaskUpdate(ws, { id: "t-1", patch: { status: "完成", evidence: "偷偷写凭据" }, expectedRev: 0 }))
    assertRejectCode(roPatch, "field-not-updatable")
    assert.ok(roPatch.reason.includes("status") && roPatch.reason.includes("可改字段闭集"), "文案必须点名不可改字段与可改闭集：" + roPatch.reason)
    // ② 空 patch ⇒ 拒（不空转 rev）
    assertRejectCode(await withZeroWrite(ws, () => applyTaskUpdate(ws, { id: "t-1", patch: {}, expectedRev: 0 })), "no-fields")
    // ③ 空标题 / 空判据 ⇒ 拒
    assertRejectCode(await withZeroWrite(ws, () => applyTaskUpdate(ws, { id: "t-1", patch: { title: "   " }, expectedRev: 0 })), "title-required")
    assertRejectCode(await withZeroWrite(ws, () => applyTaskUpdate(ws, { id: "t-1", patch: { check: "" }, expectedRev: 0 })), "check-required")
    // ④ 不存在的条目 ⇒ 拒
    assertRejectCode(await withZeroWrite(ws, () => applyTaskUpdate(ws, { id: "t-404", patch: { title: "x" }, expectedRev: 0 })), "id-missing")
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

    // —— ⑥ **契约文本锁**（批 42 · 设计档 §八「⑥ 的契约文本锁」）——
    // 上面两条拒写断言证明「越界键确实被拒」；这里钉住**模型可见面**也说了同一件事
    // （描述面与实现一致）：描述必须含「只读」+ createdBy / owner / claimedFrom 三个字段名。
    // 变异自证：删掉 tool-tasks.mjs 里那句「createdBy / owner / claimedFrom 只读」⇒ 本段红。
    const updDesc = String(tools.task_update.description ?? "")
    for (const word of ["只读", "createdBy", "owner", "claimedFrom"]) {
      assert.ok(updDesc.includes(word), "task_update 的**描述**必须含「" + word + "」（只读字段声明）：" + updDesc)
    }
    assert.ok(updDesc.includes("createdBy / owner / claimedFrom 只读"),
      "描述必须**逐字**写明这三个字段只读、本工具不接受：" + updDesc)
    // schema 面同一句（parameters 的 description）—— 工具描述与 schema 不许各说一套
    const updParamDesc = String(tools.task_update.parameters?.description ?? "")
    for (const word of ["只读", "createdBy", "owner", "claimedFrom"]) {
      assert.ok(updParamDesc.includes(word), "task_update 的 **schema** 也必须含「" + word + "」：" + updParamDesc)
    }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：删掉 `ALLOWED_MIGRATIONS` 校验（只留状态合法性与凭据门）⇒ 「待办 → 完成」等非法组合会返回 ok:true
// ⇒ 本腿在这 25 组里必然红。⑥ 的变异自证：把 `strayArgKeys` 换成恒空数组（即退回「白名单静默搬运」）⇒
// 工具路径那次调用会**写入成功** ⇒ 三条断言同时红（拒写文案 / sha256 零写入 / 状态未前进）。

// ═══════════════ T-6：畸形输入（读面 fail-open / 写面 fail-closed） ═══════════════

test("T-6: 畸形 tasks.json ⇒ 读面不抛（fail-open）、写面拒（fail-closed）", async () => {
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
      const r = await withZeroWrite(ws, () => applyTaskCreate(ws, { kind: "work", title: "新任务", check: "判据", expectedRev: view.rev }))
      assertRejectCode(r, "malformed")
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
// ⇒ 包装器的零写入断言（sha256 期间相同）红。

// ═══════════════ T-10：疑似凭据 ⇒ 拒写（非打码） ═══════════════

test("T-10（N-7）: evidence/reason 命中疑似凭据 ⇒ 拒写（不是打码）", async () => {
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
    const r = await withZeroWrite(ws, () => applyTaskTransition(ws, {
      id: t.id, to: "完成",
      evidence: "跑了 node --test 后把 sk-live-ABCDEFGHIJKLMNOPQRSTUVWX 贴进来了",
      expectedRev: t.rev,
    }))
    assertRejectCode(r, "secret-suspected")
    const after = readFileSync(resolveTasksPath(ws), "utf8")
    assert.equal(after, before, "拒写必须是**零写入**（打码会把疑似凭据留在盘上，本设计明令不做）")
    assert.ok(!after.includes("sk-live"), "盘上不得出现该串（连打码形态都不许出现）")
    assert.ok(r.reason.includes("拒写"), "文案必须说清是「拒写」不是「打码」：" + r.reason)

    // reason 字段同族（卡住原因也是自由文本）
    const b = await withZeroWrite(ws, () => applyTaskTransition(ws, { id: t.id, to: "卡住", reason: "AKIAIOSFODNN7EXAMPLE 过期了", blockedBy: "external", expectedRev: t.rev }))
    assertRejectCode(b, "secret-suspected")

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

test("T-11（N-2 · N-3 · D5）: 陈旧 expectedRev ⇒ 拒且零写入 + fail-loud；合法 rev ⇒ 放行；跨会话读回", async () => {
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
    const b = await withZeroWrite(ws, () => applyTaskCreate(ws, { kind: "work", title: "会话 B 建的单", check: "判据 B", expectedRev: sessionB }))
    assertRejectCode(b, "rev-conflict")
    assert.equal(tasksFileSha256(ws), afterA, "冲突写必须零写入（原子写只防半文件，**不防丢更新**——D5）")
    assert.ok(b.reason.includes("其他会话"), "fail-loud 文案必须点名冲突来源：" + b.reason)
    assert.ok(b.reason.includes("你的 rev=" + sessionB), "文案必须给出「你的 rev」：" + b.reason)
    assert.ok(b.reason.includes("盘上 rev=1"), "文案必须给出「盘上 rev」（会话 A 写后 = 1）：" + b.reason)

    // 阳性对照（防「凡写必拒」的假绿）：B 重新读到最新 rev 后写 ⇒ 放行
    const b2 = applyTaskCreate(ws, { kind: "work", title: "会话 B 重试", check: "判据 B", expectedRev: readTasksView(ws).rev })
    assert.equal(b2.ok, true, "读到最新 rev 后必须放行：" + JSON.stringify(b2))

    // rev 号缺失 / 非法 ⇒ 同一族前置拒绝（不猜、不静默用盘上值）
    const noRev = await withZeroWrite(ws, () => applyTaskCreate(ws, { kind: "work", title: "x", check: "y" }))
    assertRejectCode(noRev, "expected-rev-invalid")

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
// assertRejectCode 与包装器的零写入断言同时红；把键控改成读 DSH_HOME ⇒ 最后一段的 DSH_HOME 断言红。

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

    // ——— T-4c（批 43 / 台账 t-3 · FR-2/D-3）：**Top-N 截断必须可见**（并入本块，不新开顶层 test）———
    // 30 条活任务 ⇒ 列 5 条 + 「…还有 25 项」。旧口径 `listable = candidates.length`（= Top-N 后的 5）
    // ⇒ pending 恒 0 ⇒ 尾串消失（25 条静默丢失）⇒ 本段红。
    const thirty = []
    for (let i = 1; i <= 30; i++) thirty.push(task("t-" + i, { title: "第 " + i + " 条活任务" }))
    seedLedger(ws, thirty, 11)
    const capped = renderTaskDigest(readTasksView(ws))
    assert.ok(capped.includes("\n…还有 25 项"),
      "Top-N 之外的 25 条必须**可见**（不得静默消失）：" + JSON.stringify(capped.slice(-40)))
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
    for (let i = 1; i <= 40; i++) many.push(task("t-" + i, { kind: "decision", title: "第 " + i + " 条标题刻意写得足够长，好把 768 的预算顶出去，验证尾巴" }))
    seedLedger(ws, many, 9)
    const long = renderTaskDigest(readTasksView(ws))
    assert.ok(long.length <= DIGEST_MAX_CHARS, "必须有界（≤" + DIGEST_MAX_CHARS + " 实测 " + long.length + "）：" + long.slice(0, 80))
    assert.ok(/…还有 \d+ 项$/.test(long), "超预算必须以『…还有 N 项』收尾（不是截断半句）：" + long.slice(-40))
    const shown = digestEntries(long).length
    const claimed = Number(/…还有 (\d+) 项$/.exec(long)[1])
    assert.equal(shown + claimed, 40, "「列出 + 还有」必须等于总数（不许静默丢项）：" + shown + " + " + claimed)

    // ——— T-4d（批 43 · FR-1）：**768 是标定锁**（与 T-5 的「有界锁」<= DIGEST_MAX_CHARS 不是一回事）———
    // 边界两向都要：≤768 全列（无尾串）/ >768 出尾串。这里**有意写 768 字面量**：改常量必须同步改本腿。
    // 变异自证：把 DIGEST_MAX_CHARS 改回 512 ⇒ 恰好 768 的样本立刻出尾串 ⇒ 第一条断言红。
    /** 造一个输出恰好 target 字符的摘要视图（单条决策项，标题长度到输出长度是线性的）。 */
    const digestOfLength = (target) => {
      const baseView = (title) => ({
        tasks: [task("t-1", { kind: "decision", title })],
        decisions: [task("t-1", { kind: "decision", title })],
        active: [], blocked: [], done: [], rev: 0,
      })
      const probe = renderTaskDigest(baseView(""))
      const titleLen = target - probe.length
      assert.ok(titleLen >= 0, "目标长度不得小于摘要头（" + target + " < " + probe.length + "）")
      return renderTaskDigest(baseView("x".repeat(titleLen)))
    }
    const atCap = digestOfLength(768)
    assert.equal(atCap.length, 768, "标定锁：恰好 768 字符的样本必须原样全列（实测 " + atCap.length + "）")
    assert.ok(!atCap.includes("…还有"), "≤768 必须**全列**（不得出尾串）：" + atCap.slice(-40))
    const overCap = digestOfLength(769)
    assert.ok(/…还有 \d+ 项$/.test(overCap), ">768 必须以尾串收尾（768 是标定锁）：" + overCap.slice(-40))

    // ——— T-4f（批 43 · 副轨评审 #2）：**跨模块契约锁** —— 合法最坏组合 1281 > 1150 仍被裁剪 ———
    // 两侧硬顶：anti-drift `LINE_MAX_CHARS = 512`（`lib/anti-drift.mjs:820`，**未导出**）与摘要
    // `DIGEST_MAX_CHARS = 768`（本档已 import）。**两段都合法**时和 = 512 + 1 + 768 = 1281 > 1150
    // ⇒ 合计上限必须咬得住这个组合（512 只能在此复述字面量：对侧常量未导出）。
    // 变异自证：把 `INJECT_TOTAL_MAX_CHARS` 改回 1281 ⇒ 1281 不再超限、裁剪分支消失 ⇒ 本段红
    //   （夹具前提 1281 > 上限先报，其后的「长度 ≤ 1150」与「带尾串」两条也会各自红）。
    //   ★ 本段**排在最前**：变异①（1281）时它先报红，定位直接指向「合计上限没咬住两侧硬顶」。
    const adF = "F".repeat(512)
    const taskF = digestOfLength(768)
    assert.equal(adF.length, 512, "夹具锁：anti-drift 行硬顶 512（与 lib/anti-drift.mjs:820 同步）")
    assert.equal(taskF.length, 768, "夹具锁：摘要硬顶 768（与 DIGEST_MAX_CHARS 同步）")
    assert.ok(adF.length + 1 + taskF.length > INJECT_TOTAL_MAX_CHARS,
      "夹具前提：合法最坏组合必须超过合计上限（" + (adF.length + 1 + taskF.length) + " > " + INJECT_TOTAL_MAX_CHARS + "）")
    const rF = assembleInjection(adF, taskF)
    assert.ok(rF.length <= 1150, "合法最坏组合也必须被裁到 1150 内（实测 " + rF.length + " ≤ 1150）")
    assert.ok(rF.includes("（摘要已截断）"), "合法最坏组合必须触发裁剪并带尾串：" + JSON.stringify(rF.slice(-30)))

    // ——— T-4e（批 43 · FR-3 / D-4）：注入行合计上限 = **1150（标定值，非派生量）** ———
    // 为什么不是 768 + 512 + 1 = 1281：两段各有硬顶（adLine ≤ 512、摘要 ≤ 768）⇒ 合法和恒 ≤ 1281
    // ⇒ 以 1281 为上限时裁剪分支**生产永远不可达 = 假保护**（旧夹具只能用 896〔> 摘要硬顶〕才触发）。
    // 1150 才咬得住：adLine 512 时摘要可用 628；adLine 典型 245 时摘要仍可拿满 768；500 + 700 = 1201 > 1150。
    // ① 合法两段 500 + 700 = 1201 > 1150 ⇒ **真触发裁剪**（首行必留 · 不切半行 · 不跳行）+ 单行尾串；
    //   adLine 整行保留。★ 两段都合法（500 ≤ 512、700 ≤ 768）—— 副轨评审 #1 明令不得再用 896：
    //   896 > 摘要硬顶 768 是**非法输入**，那种腿只证明函数对非法输入可用。
    //   变异自证：把上限改回 1281 ⇒ 1201 不再超限 ⇒ 本段红（夹具前提先报，尾串断言其后也会红）。
    const adA = "A".repeat(500)
    const taskA = ["[摘要头]", ...Array.from({ length: 5 }, () => "y".repeat(138))].join("\n")
    assert.equal(taskA.length, 700, "夹具锁：摘要侧必须恰好 700 字符（实测 " + taskA.length + "）")
    assert.ok(adA.length + 1 + taskA.length > INJECT_TOTAL_MAX_CHARS,
      "夹具前提：500 + 1 + 700 = 1201 必须真的超过合计上限（实测 " + (adA.length + 1 + taskA.length) + "）")
    const rA = assembleInjection(adA, taskA)
    assert.ok(rA.length <= INJECT_TOTAL_MAX_CHARS, "合计必须 ≤" + INJECT_TOTAL_MAX_CHARS + "（实测 " + rA.length + "）")
    assert.ok(rA.startsWith(adA + "\n"), "adLine 必须**逐字完整**且排在最前（不砍 anti-drift 行）")
    assert.ok(rA.endsWith("\n…（摘要已截断）"), "裁剪后的摘要必须带单行尾串「（摘要已截断）」：" + JSON.stringify(rA.slice(-30)))
    const keptText = rA.slice(adA.length + 1).replace(/\n…（摘要已截断）$/, "")
    const keptLines = keptText.split("\n")
    const budgetA = INJECT_TOTAL_MAX_CHARS - adA.length - 1 - 1 - "…（摘要已截断）".length
    assert.equal(keptLines[0], "[摘要头]", "首行必须保留（rev/计数那行）")
    assert.ok(keptLines.length < 6, "必须真的裁掉至少一行（否则尾串就是假裁剪）：保留 " + keptLines.length + " / 6 行")
    // ★ 加固（修复轮 3 · 评审指出的测试盲区）：旧断言「只留首行」也全绿（1 < 6）⇒ 必须证明
    //   **真的按行装填**：保留 ≥2 行，且保留字符数落在 (首行长度, 扣尾串预算] 区间。
    //   变异自证：把裁剪循环退化成「只保留首行」⇒ 下面第一条立刻红；把预算放宽到 ≥ 两行的容量
    //   但仍只装首行 ⇒ 第二条红。
    assert.ok(keptLines.length >= 2,
      "必须真的按行装填（保留的行数 ≥ 2，不是退化到只留首行）：保留 " + keptLines.length + " 行")
    assert.ok(keptText.length > keptLines[0].length && keptText.length <= budgetA,
      "保留部分的字符数必须落在 (首行 " + keptLines[0].length + ", 预算 " + budgetA + "] 区间（实测 " + keptText.length + "）")
    for (const line of keptLines.slice(1)) assert.equal(line.length, 138, "不得切半行（每行都必须是完整的 138 字符）：" + line.length)
    // ② 反向腿（评审 #5）：575 + 400 ⇒ 976 ≤ 1150 **未超限** ⇒ 摘要部分与 renderTaskDigest 输出**逐字相同**
    //   （防裁剪器误伤正常路径）。变异自证：把上限改成 900 ⇒ 976 被误裁 ⇒ 本段红
    //   （上限 900 时 T-4f 与 ① 仍绿 ⇒ 红点正落在反向腿上，定位直接）。
    const adB = "B".repeat(575)
    const taskB = digestOfLength(400)
    assert.equal(taskB.length, 400, "反向腿夹具必须是 400 字符的真实摘要（实测 " + taskB.length + "）")
    const rB = assembleInjection(adB, taskB)
    assert.equal(rB, adB + "\n" + taskB, "未超限 ⇒ 必须**原样拼接**（逐字），裁剪器不得碰正常路径")
    assert.equal(rB.slice(adB.length + 1), taskB, "摘要部分必须与 renderTaskDigest 输出**逐字相同**")
    // ③ adLine 自身 ≥ 上限 ⇒ 输出**恰为 adLine**（不拼半行、不留残句）
    const adC = "C".repeat(INJECT_TOTAL_MAX_CHARS + 1) // 构造在上限之上（1150 时 = 1151 ≥ 1150）
    assert.ok(adC.length >= 1150, "夹具锁：adLine 长度必须 ≥ 1150（实测 " + adC.length + "）")
    assert.equal(assembleInjection(adC, digestOfLength(200)), adC, "adLine 自身超限 ⇒ 只返回 adLine")
    // ④ taskLine 首行就放不下 ⇒ 输出 = adLine + 单行「（摘要已截断）」（不带残行）
    const adD = "D".repeat(500)
    const taskD = "z".repeat(800) + "\n次行"
    assert.equal(assembleInjection(adD, taskD), adD + "\n…（摘要已截断）", "首行放不下 ⇒ adLine + 单行尾串")

    // ——— 修复轮 3（🔴 分支④ 贴顶仍超上限）：边界腿 · 空段腿 · 尾串预算腿 ———
    // 尾串逐字与 `lib/index.mjs` 的 `INJECT_CLIP_TAIL` 同步（该常量未导出）。
    const CLIP_TAIL = "…（摘要已截断）"
    // (a) **边界腿**：adLine ∈ [上限−8, 上限−1] 是危险区间 —— budget = 上限 − ad − sep − 1 − 尾串
    //   为负，旧实现分支④ 直接返回「ad + 换行 + 尾串」⇒ 总长 > 上限（1150 实测：1142→1151 / 1149→1158），
    //   违反函数头自己的 @post。新守卫：连「ad + 分隔 + 尾串」都超上限 ⇒ 直接返回 adLine。
    //   变异自证：删掉分支④ 的贴顶守卫 ⇒ 循环首次迭代的长度腿即红（三条上限−k 同构；断言中止于首条）。
    for (const back of [5, 8, 1]) {
      const adEdge = "E".repeat(INJECT_TOTAL_MAX_CHARS - back)
      const rEdge = assembleInjection(adEdge, digestOfLength(200))
      assert.ok(rEdge.length <= INJECT_TOTAL_MAX_CHARS,
        "贴顶 adLine（上限−" + back + " = " + adEdge.length + "）也必须 ≤ 上限（实测 " + rEdge.length + "）")
      assert.equal(rEdge, adEdge, "贴顶时宁可没有摘要，也不留超限串（上限−" + back + "）")
    }
    // (b) **空段腿**：不加分隔符、不留悬空换行（与旧 filter+join 注入点逐字相同）。
    //   变异自证：把空段处理改回无脑 `join("\n")` ⇒ 下面三条相等腿各自红。
    const taskEmpty = digestOfLength(120)
    assert.equal(assembleInjection("", taskEmpty), taskEmpty, "adLine 为空 ⇒ 直接返回 taskLine（无前导换行）")
    const adEmpty = "G".repeat(300)
    assert.equal(assembleInjection(adEmpty, ""), adEmpty, "taskLine 为空 ⇒ 直接返回 adLine（无尾随换行）")
    assert.equal(assembleInjection("", ""), "", "两段皆空 ⇒ 空串（不是换行）")
    // (c) **尾串预算腿**：budget **必须扣掉尾串**（上限 − ad − sep − 1 − 尾串长度）——
    //   夹具让「不扣尾串」会多保留一行（8 字符 = 尾串长度）：
    //   ad = 512 ⇒ 扣尾串预算 628 / 不扣尾串 636；「首行 1 + 第二行 300 + 第三行 330」= 633
    //   ⇒ 恰好落在 (628, 636] 窗口 ⇒ 扣尾串只留 2 行，不扣尾串会多留第三行。
    //   变异自证：budget 不扣尾串 ⇒ 本组必红（实测首个命中是总长断言：1155 > 1150）。
    const adH = "H".repeat(512)
    const hLine2 = "2".repeat(300)
    const hLine3 = "3".repeat(330)
    const taskH = ["R", hLine2, hLine3, "4".repeat(50)].join("\n")
    const budgetH = INJECT_TOTAL_MAX_CHARS - adH.length - 1 - 1 - CLIP_TAIL.length
    assert.equal(budgetH, 628, "夹具锁：ad=512 时扣掉尾串后的摘要预算 = 628（实测 " + budgetH + "）")
    assert.ok(adH.length + 1 + taskH.length > INJECT_TOTAL_MAX_CHARS,
      "夹具前提：512 + 1 + " + taskH.length + " 必须真的超过合计上限")
    const rH = assembleInjection(adH, taskH)
    const keptH = rH.slice(adH.length + 1).replace(/\n…（摘要已截断）$/, "")
    const keptHLines = keptH.split("\n")
    assert.ok(rH.length <= INJECT_TOTAL_MAX_CHARS, "尾串预算夹具也必须 ≤ 上限（实测 " + rH.length + "）")
    assert.equal(keptHLines.length, 2,
      "尾串必须计入预算：第三行按扣尾串预算（" + budgetH + "）放不下 ⇒ 只保留 2 行（实测 " + keptHLines.length + " 行；不扣尾串会多留一行）")
    assert.ok(keptH.length <= budgetH, "保留部分必须 ≤ 扣掉尾串后的预算（实测 " + keptH.length + " ≤ " + budgetH + "）")
    const threeLines = keptH.length + 1 + hLine3.length
    assert.ok(threeLines > budgetH && threeLines <= budgetH + CLIP_TAIL.length,
      "夹具判别力：三行合计必须落在 (" + budgetH + ", " + (budgetH + CLIP_TAIL.length) + "]（实测 " + threeLines + "）")
    // ★ 标定锁放最后：上面每条腿先按自己的机制报红（变异定位更准），本行再把数值钉死
    //   （只改数值不动机制 ⇒ 前面的腿可能全绿，例如 1100；本行必红 ⇒ 标定值不可漂移）。
    assert.equal(INJECT_TOTAL_MAX_CHARS, 1150, "合计上限必须是**标定值** 1150（派生量 1281 恒不可触发 = 假保护，见 D-4）")

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

/**
 * 从 `lib/client.js` 源码的 **STYLE_CSS 字符串字面量**里取一条规则的选择器体（`...{}` 里那段）。
 * 定位不到 ⇒ `null` —— 调用方必须断言非空，否则断言会退化成恒真空（本仓纪律：假腿要能红）。
 * ★ 用**源码**而不是运行时 `getComputedStyle`：node 里没有浏览器，且本仓既有静态腿同款口径。
 */
function styleBodyOf(src, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp(esc + "\\{([^}]*)\\}").exec(src)
  return m ? m[1] : null
}

test("T-4a（US-5 ① · N-1）: 看板 ≡ 工具读（同一 ws 逐条相等）；看板侧零写盘、零自解析", async () => {
  const ws = freshWs()
  try {
    // ★ 批 36-补：夹具补 `owner` —— 看板自本批起有**归属维度**，默认区是「本会话」。
    //   这不是放宽判据，而是「世界变了」：看板的默认视图 = 本会话的活（设计档 §16.2）。
    seedLedger(ws, [
      task("t-1", { status: "在做", owner: "s-1", createdBy: "s-1", title: "在办的一条" }),
      task("t-2", { kind: "decision", owner: "s-1", createdBy: "s-1", title: "等你拍板的一条" }),
      task("t-3", { status: "卡住", blockedBy: "external", blockedReason: "等对端", owner: "s-1", createdBy: "s-1", title: "卡住的一条" }),
      task("t-4", { status: "完成", evidence: "跑了 12/12 绿", owner: "s-1", createdBy: "s-1", title: "已完成的一条" }),
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
    // ★ 2026-10-17 **取代关系**（用户实测「看板里只有待办、没有已完成，不是 5 态吗？」）：
    //   本单之前，「已完成」是 `countOnly` 分区 —— 只打一个数字、**不列条目**；
    //   用户指出那让完成态**看不见内容**（完成凭据本身就是这套机制的核心产物）⇒ 改为**正常分区**。
    //   ⇒ 这里的期望值随之从「board 模式的条目集 = 全部**减去**完成态」改为「= 全部」。
    //   **判据没有放宽**：仍是「看板渲染出的条目集与 `readTasksView` 逐条相等」。
    const boardEntriesFromText = textEntries(boardText)
    assertSameTaskSet(boardEntriesFromText, view, "task_list（board 模式）")
    // 「已完成」分区必须**真的列出**完成项（id + 标题 + 凭据），而不只是一个计数
    assert.ok(boardText.includes("已完成（1）"), "board 模式必须有「已完成」分区：\n" + boardText)
    assert.ok(boardText.includes("已完成的一条"),
      "完成项的**标题**必须看得见（不能只给一个数字）：\n" + boardText)
    assert.ok(boardText.includes("跑了 12/12 绿"),
      "完成项的**凭据**必须看得见 —— 完成凭据是这套机制的核心产物：\n" + boardText)

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

    // ⑤ 批36-补3（§十八 ② · T-22）：毛玻璃必须**从主题基底色 color-mix 派生**（绝不硬编码白/黑），
    //    卡片级元素才加 `backdrop-filter`，任务行**不加模糊**（长列表性能，§18.5）。
    //    变异自证：把 `.tc-tasks-sec` 的 `background:var(--tc-glass-bg)` 换成 `#ffffff` ⇒ 下面两条同时红
    //    （卡片毛玻璃断言 + `.tc-` 硬编码底色负向断言），实测报文见交付报告。
    const glassVars = styleBodyOf(clientSrc, ".tc-page,.tc-tasks")
    assert.ok(glassVars, "必须能定位毛玻璃变量块（定位不到 ⇒ 本段恒真空，必须红）")
    assert.ok(glassVars.includes("--tc-glass-bg:color-mix(in srgb, var(--dsw-alias-bg-base, #ffffff) 62%, transparent)"),
      "★ 底色必须 color-mix 从 --dsw-alias-bg-base 派生（深色主题随动）：" + glassVars)
    assert.ok(glassVars.includes("--tc-glass-brd:color-mix(in srgb, var(--dsw-alias-label-primary, #111111) 14%, transparent)"),
      "边框同样走 color-mix 派生：" + glassVars)
    assert.ok(glassVars.includes("--tc-glass-blur:blur(14px) saturate(1.08)"),
      "模糊强度必须逐字 = §18.3 ②：" + glassVars)
    for (const sel of [".tc-card", ".tc-tasks-sec", ".tc-tasks-drift", ".tc-tasks-donut"]) {
      const body = styleBodyOf(clientSrc, sel)
      assert.ok(body, "必须能定位 " + sel + " 的规则（定位不到 ⇒ 断言恒真空）")
      assert.ok(body.includes("background:var(--tc-glass-bg)"), sel + " 的底色必须走毛玻璃变量：" + body)
      assert.ok(body.includes("backdrop-filter:var(--tc-glass-blur)"), sel + " 是卡片级元素，必须有 backdrop-filter：" + body)
    }
    const rowBody = styleBodyOf(clientSrc, ".tc-tasks-row")
    assert.ok(rowBody && rowBody.includes("background:var(--tc-glass-bg)"), "任务行用纯半透明底：" + rowBody)
    assert.ok(!String(rowBody).includes("backdrop-filter"), "★ 任务行**不得**加模糊（长列表掉帧，§18.5）")
    // 详情块：嵌在已模糊的分区里 ⇒ 用半透明底但**不重复模糊**（评审 #5 的文档张力在此落成明文断言）
    const detailBody = styleBodyOf(clientSrc, ".tc-tasks-detail")
    assert.ok(detailBody && detailBody.includes("background:var(--tc-glass-bg)"), "详情块用纯半透明底：" + detailBody)
    assert.ok(!String(detailBody).includes("backdrop-filter"),
      "★ 详情块嵌在已模糊的 section 内 ⇒ **不重复模糊**（§18.5 的性能口径）")
    // 负向断言：`.tc-` 规则里**不得**出现硬编码白/黑的**底色**（硬编码会在深色主题下变成刺眼白板）
    const hardcodedBg = (body) => /(^|;)background(?:-color)?:\s*(#fff(?:fff)?|white|#000(?:000)?|black)\b/i.test(String(body || ""))
    const tcRules = [...clientSrc.matchAll(/"(\.tc-[^"]*?)\{([^}]*)\}"/g)]
    assert.ok(tcRules.length >= 25, "提取面必须非空（否则下面那条是恒真空）：实测 " + tcRules.length + " 条 `.tc-` 规则")
    const bgHits = tcRules.filter((m) => hardcodedBg(m[2])).map((m) => m[1])
    assert.deepEqual(bgHits, [], "`.tc-` 选择器内不得把白/黑硬编码成卡片底色：" + JSON.stringify(bgHits))
    // 谓词自证（防「正则写错 ⇒ 恒空」的假绿）：合成样本必须命中；color-mix 里的 #ffffff **回退值**不得误报
    assert.ok(hardcodedBg("background:#ffffff"), "自证①：硬编码白底必须被同一谓词判红")
    assert.ok(hardcodedBg("border-radius:8px;background:#000"), "自证②：硬编码黑底必须被判红")
    assert.ok(!hardcodedBg(glassVars), "自证③：color-mix 里的 #ffffff 是回退值，不是硬编码底色 —— 不得误报")
    // P 徽标（§21.2 FR-2 · **T-32 的源码半**；`client.js` 无法被单测 import ⇒ 只能源码级断言；
    //   渲染半在 T-12 ④-a）：
    //   ① 四档「类名 ↔ 色值」映射逐条在场；② 档位词（紧急/高/中/低）代替裸数字；
    //   ③ 渲染判据仍是 `priority >= 1`（0 与负数同待遇 —— T-21a 继续生效）。
    //   变异自证：把 `"紧急"` 改回 `"P" + p` ⇒ T-12 ④-a 的「不含 P10」与档位词断言同时红；
    //   把 `>=9` 改成 `>=8` ⇒ T-12 ④-a 的边界夹具（9 与 8）档位断言红。
    const prioRule = (sel) => {
      const body = styleBodyOf(clientSrc, sel)
      assert.ok(body, "必须能定位 " + sel + " 的规则")
      return body
    }
    const prioBase = prioRule(".tc-tasks-prio")
    assert.ok(prioBase.includes("font-size:11px") && prioBase.includes("padding:1px 6px")
      && prioBase.includes("border-radius:999px") && prioBase.includes("font-weight:600"),
      "徽标尺寸/字形必须 = §18.3 ①：" + prioBase)
    // §21.3：优先级 = **软底 + 同色描边 + 同色字**（轻），与实心状态 pill 分工
    assert.ok(prioBase.includes("border:1px solid currentColor"), "优先级徽标必须同色描边：" + prioBase)
    for (const [sel, color] of [[".tc-prio-urgent", "#DC2626"], [".tc-prio-high", "#EA580C"], [".tc-prio-mid", "#D97706"], [".tc-prio-low", "#64748B"]]) {
      const body = prioRule(sel)
      assert.ok(body.includes("color:" + color), sel + " 的档位字色必须 = " + color + "：" + body)
      assert.ok(body.includes("background:color-mix(in srgb," + color + " 12%,transparent)"),
        sel + " 的软底必须由同色 color-mix 派生：" + body)
    }
    // ② 类名 ↔ 阈值映射（改错任一档阈值 ⇒ 红；T-12 ④-a 的边界夹具会同时红）
    assert.ok(/if \(p >= 9\) return \{ cls: "tc-prio-urgent", label: "紧急" \};/.test(clientSrc),
      ">=9 ⇒ 紧急（tc-prio-urgent）")
    assert.ok(/if \(p >= 6\) return \{ cls: "tc-prio-high", label: "高" \};/.test(clientSrc),
      "6..8 ⇒ 高（tc-prio-high）")
    assert.ok(/if \(p >= 3\) return \{ cls: "tc-prio-mid", label: "中" \};/.test(clientSrc),
      "3..5 ⇒ 中（tc-prio-mid）")
    assert.ok(/return \{ cls: "tc-prio-low", label: "低" \};/.test(clientSrc), "1..2 回落低档")
    // ③ 渲染判据 = `priority >= 1`（删掉 `p < 1` ⇒ P0 / P-3 都会渲染 ⇒ T-12 ④-a 与本条同时红）
    assert.ok(/if \(!isFinite\(p\) \|\| p < 1\) return null;/.test(clientSrc),
      "渲染判据必须是 priority>=1（0 与负数同待遇）")
    // ★ 反证：源码里不得再出现「裸数字徽标」的拼法（P10/P15 是用户点名的看不懂来源）
    assert.ok(!/"P" \+ p/.test(clientSrc), "徽标不得再拼裸数字（用户实测：P10/P15 看不懂）")

    // ⑥ 批38（§21.2 FR-1 · **T-31**）：看板**内容区**必须可滚动 + 常显细滚动条。
    //   ★ 两级断言：① 内容区自身 `overflow-y:auto` + `min-height:0`（弹性容器里没它滚不动）；
    //   ② 同一条链路里必须有 `scrollbar-width:thin`、`::-webkit-scrollbar` 9px、
    //      thumb `border:2px solid transparent` + `background-clip:padding-box`，且颜色走 light-dark（不硬编码）。
    //   变异自证：删掉内容区的 `overflow-y:auto` ⇒ 第一条红；去掉 `min-height:0` ⇒ 第二条红；
    //   把滚动条宽改成 0 / 去掉 thumb 的 padding-box ⇒ 对应断言红（实测报文见交付报告）。
    const scrollBody = styleBodyOf(clientSrc, ".tc-tasks-scroll")
    assert.ok(scrollBody, "必须能定位看板内容区 .tc-tasks-scroll（定位不到 ⇒ 本段恒真空，必须红）")
    assert.ok(scrollBody.includes("overflow-y:auto"),
      "内容区必须可纵向滚动（用户实测「任务超过 4 个就看不到」）：" + scrollBody)
    assert.ok(scrollBody.includes("min-height:0"),
      "★ 弹性子项必须有 min-height:0，否则内容撑高后滚不动：" + scrollBody)
    assert.ok(scrollBody.includes("scrollbar-width:thin"), "常显细滚动条（Firefox 面）：" + scrollBody)
    assert.ok(scrollBody.includes("scrollbar-color:light-dark("),
      "滚动条颜色必须走 light-dark()（深色主题随动，不许硬编码）：" + scrollBody)
    assert.ok(clientSrc.includes(".tc-tasks-scroll::-webkit-scrollbar{width:9px}"),
      "Chromium 侧滚动条宽必须 = 9px（§21.3）")
    assert.ok(/\.tc-tasks-scroll::-webkit-scrollbar-thumb\{[^}]*border:2px solid transparent/.test(clientSrc),
      "thumb 必须 border:2px solid transparent（视觉 5px 圆角条，§21.3）")
    assert.ok(/\.tc-tasks-scroll::-webkit-scrollbar-thumb\{[^}]*background-clip:padding-box/.test(clientSrc),
      "thumb 必须 background-clip:padding-box（§21.3）")
    // 根容器：撑满面板且**自己不滚**（滚动交给内容区）
    const tasksRoot = /"\.tc-tasks\{([^}]*)\}"/.exec(clientSrc)
    assert.ok(tasksRoot, "必须能定位 .tc-tasks 根规则（定位不到 ⇒ 本段恒真空，必须红）")
    assert.ok(tasksRoot[1].includes("flex:1 1 auto") && tasksRoot[1].includes("min-height:0"),
      "根容器必须 flex:1 1 auto + min-height:0（面板高度约束才能传到内容区）：" + tasksRoot[1])
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：让看板载荷自建一份任务（不经 readTasksView）⇒ ① 的集合比对红；让客户端读盘/自解析 ⇒ ③ 红；
// 把毛玻璃变量换成 #ffffff 字面量（或把 `.tc-tasks-sec` 的底色写死 #ffffff）⇒ ⑤ 红（实测报文见交付报告）。

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


/**
 * 渲染设置页的「个人任务台账」卡片（真实客户端组件；批 44 腿 T-9h 的「界面」半边）。
 *
 * ★ 手法与 `test/config-api.test.mjs` 的 `loadClientLedgerMirror` 同款：只在内存里于
 *   `exports.apply = apply;` 之前注入一行导出，**不改 `lib/client.js` 一个字节**。
 *   `ledgerCard()` 在每次 `ThincoderPage` 渲染时都会被调用（tab 内容先全部构建），把
 *   `activeTab` 预置为 `"ledger"` 后它的产物才进入返回树 ⇒ 能读到「已填 N / 8」那一行。
 * ★ 预置槽位（顺序 = `ThincoderPage` 顶部 hook 段，as-of 2026-10-19）：
 *   `0 = view` · `5 = draft` · `9 = activeTab`；其余槽走各自初值。锁定这个顺序是本腿的前提，
 *   页面的 hook 段一改就该重核本夹具。
 * @param {object} effective 全局 effective 层（`{ledger:{mode,docPaths,copyTemplate}}`）
 * @returns {string} 渲染出的**整页文本**（含台账卡片的「已填 N / 8」行）
 */
function renderSettingsLedger(effective) {
  const src = readFileSync(join(PLUGIN_DIR, "lib", "client.js"), "utf8")
  const ANCHOR = "exports.apply = apply;"
  assert.equal(src.split(ANCHOR).length - 1, 1, "工厂尾部导出锚唯一（注入点可定位）")
  const injected = src.replace(ANCHOR,
    "exports.__settingsProbe = { ThincoderPage: ThincoderPage, effectiveToDraft: effectiveToDraft };\n"
    + ANCHOR)
  let spec = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (m) => { spec = m } } },
    console,
    navigator: {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) }),
  }
  createContext(sandbox)
  runInContext(injected, sandbox, { filename: "lib/client.js" })
  assert.ok(spec && typeof spec.factory === "function", "客户端 bundle 必须经 __ModuleLoader__.load 注册一个 factory")
  const store = {}
  let idx = 0
  const React = {
    createElement: function (type, props) {
      return { type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
    },
    useState: (init) => {
      const i = idx++
      if (!(i in store)) store[i] = init
      return [store[i], (v) => { store[i] = typeof v === "function" ? v(store[i]) : v }]
    },
    // 组件挂载时的拉取会真的发起；异步落地不参与本次同步渲染（断言只读首屏）。
    useEffect: (cb) => { const i = idx++; if (!(i in store)) { store[i] = "ran"; try { cb() } catch { /* 异常由断言捕获 */ } } },
    useCallback: (fn) => { idx++; return fn },
    useRef: (init) => { const i = idx++; if (!(i in store)) store[i] = { current: init }; return store[i] },
  }
  const mod = spec.factory((name) => (name === "react" ? React : {}))
  const probe = mod.__settingsProbe
  assert.ok(probe && typeof probe.ThincoderPage === "function", "设置页探针导出成功（注入点存在）")
  const layer = effective && typeof effective === "object" ? effective : {}
  store[0] = { base: {}, user: {}, effective: layer }
  store[5] = probe.effectiveToDraft(layer)
  store[9] = "ledger"
  idx = 0
  return treeText(probe.ThincoderPage({ api: {}, sessions: null, useSessions: null })).join("\n")
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

/**
 * 在元素树里按谓词收集元素（**与 `treeText` 同一套递归**：函数组件就地求值）。
 * 用于断言「某个元素渲染了 / 带什么 props」——`treeText` 只能给文本，给不了 className / stroke。
 */
function collectElements(node, pred, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out
  if (Array.isArray(node)) { for (const c of node) collectElements(c, pred, out); return out }
  if (typeof node !== "object") return out
  if (typeof node.type === "function") return collectElements(node.type(node.props), pred, out)
  if (pred(node)) out.push(node)
  for (const c of node.children || []) collectElements(c, pred, out)
  return out
}

/** 按 className 的**某一个 token** 收集元素（例：`tc-tasks-prio`）。 */
function collectByClass(node, cls, out = []) {
  return collectElements(node, (el) => typeof el.props.className === "string"
    && el.props.className.split(/\s+/).includes(cls), out)
}

/** 按标签名收集元素（SVG 的 `circle` / `text` 等）。 */
function collectByTag(node, tag, out = []) {
  return collectElements(node, (el) => el.type === tag, out)
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
    //    ★ 批 36-补：夹具补 `owner: "s-1"`（看板默认区 = 本会话；设计档 §16.2 的「世界变了」）
    seedLedger(ws, [task("t-1", { kind: "decision", title: "确认 OCR 方案", why: "识别率不达标", status: "在做", owner: "s-1", createdBy: "s-1" })], 1)
    const payload = buildTasksBoardPayload({ ws, sessionId: "s-1", config: {}, drift: { goal: null, criteria: null, debts: [], pushback: 0 } })
    const click = payload.ledger.decisions[0].click
    for (const k of ["plain", "docs", "progress"]) {
      assert.ok(Array.isArray(click[k]) ? click[k].length > 0 : String(click[k] ?? "").trim() !== "",
        "点击载荷必须含非空的「" + k + "」：" + JSON.stringify(click[k]))
    }
    assert.ok(click.docs.some((p) => p.endsWith("tasks.json")), "文档清单至少含台账真源路径：" + JSON.stringify(click.docs))
    assert.ok(click.plain.includes("确认 OCR 方案"), "人话说明必须讲这一项本身：" + click.plain)

    // ③ 渲染面（拿**真实客户端组件**渲染）：**默认展开**（用户定调；§19.9「默认展开腿」）＋ 折叠分支保留 ＋ 详情三段
    const r = await renderClientBoard(payload, { detail: true })
    assert.ok(r.collapsedText.includes("任务台账"), "折叠态必须有状态栏（不必展开就知道有没有待决策的项）")
    assert.ok(!r.collapsedText.includes("待你决策（"), "折叠后正文必须收起（「折叠分支保留」，按钮仍可切换）")
    assert.ok(r.defaultText.includes("待你决策（1）"),
      "★ 默认**展开**（用户定调；§19.9「默认展开腿」）：数据落地后**不用点任何按钮**就渲染正文：\n" + r.defaultText.slice(0, 300))
    assert.ok(r.text.includes("待你决策（1）"), "「收起 → 展开」之后正文必须回来（按钮仍可切换）")
    for (const seg of ["人话说明", "相关文档", "核验进度"]) {
      assert.ok(r.text.includes(seg), "点击详情必须渲染「" + seg + "」段：\n" + r.text)
    }
    assert.ok(r.text.includes("防漂移状态区"), "看板顶部必须有防漂移状态区（FR-11）")
    // ★ 2026-10-17 U-1 实测后的新增动作：条目上必须有「在侧边聊」（= 复制话术 + 开一个 sidechat 会话）。
    //   实测结论：`sidechat` 可开，但种子只携带 threadId ⇒ **不能预填**，故按钮文案是「聊」而不是「自动发」。
    assert.ok(r.text.includes("在侧边聊"),
      "US-6 的侧边会话入口必须渲染（U-1 已实测：能开、不能预填）—— 删掉它等于把这一点退回成「什么都不发生」")
    assert.ok(r.text.includes("确认 OCR 方案"), "看板必须列出该条目")

    // ④ 批38（§21.2 FR-2/FR-3/FR-4 · T-32/T-33/T-34）—— **真实客户端组件**渲染面
    //
    // ④-a T-32 · 优先级语义化（§21.2 FR-2）：priority>=1 才渲染（**0 与负数同待遇：一律不渲染**）；
    //      文案 = **档位词**（不是裸数字）；四档边界逐条验（10/9 紧急 · 8/6 高 · 5/3 中 · 2/1 低）。
    //   变异自证：删掉 PriorityBadge 里 `if (!isFinite(p) || p < 1) return null;` ⇒ 出现 P0 / P-3、
    //      徽标变 10 枚 ⇒ 红；把档位词改回 `"P" + p` ⇒ 档位词与「不含 P10」两条同时红。
    const wsPri = freshWs()
    try {
      seedLedger(wsPri, [
        task("t-1", { priority: 0, owner: "s-1", createdBy: "s-1", title: "零权重的活" }),
        task("t-2", { priority: 10, owner: "s-1", createdBy: "s-1", title: "最高权重的活" }),
        task("t-3", { priority: 5, owner: "s-1", createdBy: "s-1", title: "中档权重的活" }),
        task("t-4", { priority: 2, owner: "s-1", createdBy: "s-1", title: "低档权重的活" }),
        // ★ 设计档 §18.4 T-21a（评审 #5）：负数一律不渲染，与 0 同待遇。
        task("t-5", { priority: -3, owner: "s-1", createdBy: "s-1", title: "负权重的活" }),
        // 档位边界（§21.2 FR-2）：≥9 紧急 / 6–8 高 / 3–5 中 / 1–2 低
        task("t-6", { priority: 9, owner: "s-1", createdBy: "s-1", title: "紧急下界" }),
        task("t-7", { priority: 8, owner: "s-1", createdBy: "s-1", title: "高档上界" }),
        task("t-8", { priority: 6, owner: "s-1", createdBy: "s-1", title: "高档下界" }),
        task("t-9", { priority: 3, owner: "s-1", createdBy: "s-1", title: "中档下界" }),
        task("t-10", { priority: 1, owner: "s-1", createdBy: "s-1", title: "低档下界" }),
      ], 1)
      const pPri = buildTasksBoardPayload({ ws: wsPri, sessionId: "s-1", config: {}, drift: null })
      const rPri = await renderClientBoard(pPri)
      const badges = collectByClass(rPri.tree, "tc-tasks-prio")
      const badgeTexts = badges.map((b) => treeText(b).join(""))
      assert.equal(badges.length, 8,
        "★ priority=0 与 priority=-3 的条目**都不渲染徽标元素**（只该有其余 8 枚；实测 " + JSON.stringify(badgeTexts) + "）")
      // 文案 = 档位词：每条各两枚（10/9 紧急 · 8/6 高 · 5/3 中 · 2/1 低）
      const labelCount = badgeTexts.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m }, {})
      assert.deepEqual(labelCount, { "紧急": 2, "高": 2, "中": 2, "低": 2 },
        "徽标文案必须是**档位词**（不是裸数字）：" + JSON.stringify(badgeTexts))
      for (const raw of ["P10", "P5", "P2", "P0", "P-3"]) {
        assert.ok(!rPri.text.includes(raw), "★ 看板文本里**不得**再出现裸数字徽标「" + raw + "」")
      }
      const classNameOf = (label) => {
        const b = badges.find((x) => treeText(x).join("") === label)
        assert.ok(b, "必须有徽标「" + label + "」（实测 " + JSON.stringify(badgeTexts) + "）")
        return String(b.props.className)
      }
      assert.ok(classNameOf("紧急").includes("tc-prio-urgent"), "≥9 ⇒ 紧急（tc-prio-urgent）：" + classNameOf("紧急"))
      assert.ok(classNameOf("高").includes("tc-prio-high"), "6–8 ⇒ 高（tc-prio-high）：" + classNameOf("高"))
      assert.ok(classNameOf("中").includes("tc-prio-mid"), "3–5 ⇒ 中（tc-prio-mid）：" + classNameOf("中"))
      assert.ok(classNameOf("低").includes("tc-prio-low"), "1–2 ⇒ 低（tc-prio-low）：" + classNameOf("低"))
      // 0 / 负数**行上**不得有徽标元素（不是「文本里没有 P0」那么弱）
      const rowsPri = collectByClass(rPri.tree, "tc-tasks-row")
      const rowOfPri = (id) => {
        const r = rowsPri.find((x) => collectByClass(x, "tc-tasks-id").some((e) => treeText(e).join("") === id))
        assert.ok(r, "必须能定位 " + id + " 的行")
        return r
      }
      assert.equal(collectByClass(rowOfPri("t-1"), "tc-tasks-prio").length, 0, "priority=0 的行**不得有**徽标元素")
      assert.equal(collectByClass(rowOfPri("t-5"), "tc-tasks-prio").length, 0, "priority=-3 的行**不得有**徽标元素（负数与 0 同待遇）")
    } finally { rmSync(wsPri, { recursive: true, force: true }) }

    // ④-c T-33 · 全部展开 / 全部收起（§21.2 FR-3）：顶栏两个控件；**默认展开**；
    //   收起态每行只留「状态色条 · 编号 · 标题 · 优先级徽标 · 状态 pill」——meta 与动作按钮**不渲染**。
    //   变异自证：把 rowsCollapsed 初值改成 `useState(true)` ⇒ 「默认展开」断言红；
    //   收起态不判 `collapsed`（照渲染 meta / actions）⇒ 收起态两条「不得出现」断言红。
    const wsFold = freshWs()
    try {
      seedLedger(wsFold, [
        task("t-1", { status: "在做", priority: 10, owner: "s-1", createdBy: "s-1", title: "可折叠的一条", check: "跑 X 看到 Y" }),
      ], 1)
      const pFold = buildTasksBoardPayload({ ws: wsFold, sessionId: "s-1", config: {}, drift: null })
      const rFold = await renderClientBoard(pFold)
      assert.ok(findButton(rFold.tree, "全部展开"), "顶栏必须有「全部展开」控件")
      assert.ok(findButton(rFold.tree, "全部收起"), "顶栏必须有「全部收起」控件")
      // 默认展开：不点任何按钮，meta 与动作按钮就在（§18.3 ⑤ 的默认展开继续生效）
      assert.ok(rFold.defaultText.includes("怎么算完成："),
        "★ 默认必须是**展开**（不用点就看得见 meta）：\n" + rFold.defaultText)
      assert.ok(rFold.defaultText.includes("看详情"), "默认展开时动作按钮必须在")
      // 点「全部收起」⇒ 只留色条 / 编号 / 标题 / 优先级徽标 / 状态 pill
      const rCollapsed = await renderClientBoard(pFold, { clicks: ["全部收起"] })
      assert.ok(rCollapsed.text.includes("可折叠的一条"), "收起态**标题**必须留着：" + rCollapsed.text)
      assert.ok(rCollapsed.text.includes("t-1"), "收起态**编号**必须留着")
      assert.ok(rCollapsed.text.includes("在做"), "收起态**状态 pill**必须留着")
      assert.equal(collectByClass(rCollapsed.tree, "tc-tasks-prio").length, 1, "收起态**优先级徽标**必须留着")
      assert.equal(collectByClass(rCollapsed.tree, "tc-tasks-stripe").length, 1, "收起态**状态色条**必须留着")
      assert.ok(!rCollapsed.text.includes("怎么算完成："),
        "★ 收起态**不渲染** meta（怎么算完成）：\n" + rCollapsed.text)
      assert.ok(!rCollapsed.text.includes("归属："), "★ 收起态**不渲染**归属行")
      for (const act of ["看详情", "问这一项", "在侧边聊"]) {
        assert.equal(findButton(rCollapsed.tree, act), null, "★ 收起态**不渲染**动作按钮「" + act + "」")
      }
      // 点「全部展开」⇒ 回来（按钮可切换，不是单向）
      const rExpanded = await renderClientBoard(pFold, { clicks: ["全部收起", "全部展开"] })
      assert.ok(rExpanded.text.includes("怎么算完成：") && rExpanded.text.includes("看详情"),
        "「全部展开」必须把 meta 与动作按钮带回来")
    } finally { rmSync(wsFold, { recursive: true, force: true }) }

    // ④-b 环图腿 · 五态环图（设计档 §19.9「环图腿」）：五段 / 中心总数 / 图例（名 · 计数 · 百分比）/ 五条配色。
    //   ★★ 计数必须**从 `payload.ledger` 的行自己数**：本夹具刻意让 `counts.doing`（在做+已接手合并）
    //      ≠ 任一单态 —— 若实现改读 `payload.counts`，「已接手 1」会变成 0 ⇒ 下面图例断言当场红。
    //   变异自证：把计数循环改成「已接手并入在做」（`if (st==="已接手") st="在做"`）⇒ 图例与弧数红。
    const wsRing = freshWs()
    try {
      seedLedger(wsRing, [
        task("t-1", { status: "待办", owner: "s-1", createdBy: "s-1" }),
        task("t-2", { status: "待办", owner: "s-1", createdBy: "s-1" }),
        task("t-3", { status: "已接手", owner: "s-1", createdBy: "s-1" }),
        task("t-4", { status: "在做", owner: "s-1", createdBy: "s-1" }),
        task("t-5", { status: "卡住", blockedBy: "self", blockedReason: "等自己动手", owner: "s-1", createdBy: "s-1" }),
        task("t-6", { status: "完成", evidence: "跑了 node --test：12/12 绿", owner: "s-1", createdBy: "s-1" }),
      ], 2)
      const pRing = buildTasksBoardPayload({ ws: wsRing, sessionId: "s-1", config: {}, drift: null })
      assert.equal(pRing.counts.doing, 2,
        "自证：counts.doing = 「已接手 + 在做」的**合并**数（lib/tasks.mjs:387-388）——用它数五态会默默少一段")
      const rRing = await renderClientBoard(pRing)
      const donut = collectByClass(rRing.tree, "tc-tasks-donut")
      assert.equal(donut.length, 1, "有任务时必须渲染五态环图")
      const legendRows = collectByClass(rRing.tree, "tc-tasks-legend-row")
      assert.equal(legendRows.length, 5, "图例必须列**五态**（含计数为 0 的态也照列）：实测 " + legendRows.length)
      const legendText = legendRows.map((x) => treeText(x).join(""))
      assert.deepEqual(legendText,
        ["待办 · 2 · 33%", "已接手 · 1 · 17%", "在做 · 1 · 17%", "卡住 · 1 · 17%", "完成 · 1 · 17%"],
        "图例 = 名 · 计数 · 百分比（五态逐条；百分比为四舍五入）：" + JSON.stringify(legendText))
      const totalEls = collectByClass(rRing.tree, "tc-tasks-donut-total")
      assert.equal(totalEls.length, 1, "环图中心必须显示总数")
      assert.equal(treeText(totalEls[0]).join(""), "6", "中心总数 = 五态之和")
      const circles = collectByTag(donut[0], "circle")
      assert.deepEqual(circles.map((c) => c.props.stroke), ["#94A3B8", "#6366F1", "#0EA5E9", "#EF4444", "#22C55E"],
        "五段配色必须逐条 = 本腿钉住的色板（待办 #94A3B8 · 已接手 #6366F1 · 在做 #0EA5E9 · 卡住 #EF4444 · 完成 #22C55E）")
      assert.ok(circles.every((c) => c.props.strokeWidth === 14), "每段必须显式给出线宽（不靠渲染器默认）")
      const dashSum = circles.reduce((a, c) => a + Number(String(c.props.strokeDasharray).split(" ")[0]), 0)
      assert.ok(Math.abs(dashSum - 2 * Math.PI * 46) < 0.5,
        "五段弧长之和必须等于整圈（按占比切段，半径 46）：实测 " + dashSum.toFixed(2))
      // 空集边界（§19.9「环图腿」）：总数 0 ⇒ **不渲染**环图
      const wsEmptyRing = freshWs()
      try {
        const pEmpty = buildTasksBoardPayload({ ws: wsEmptyRing, sessionId: "s-1", config: {}, drift: null })
        const rEmpty = await renderClientBoard(pEmpty)
        assert.equal(collectByClass(rEmpty.tree, "tc-tasks-donut").length, 0, "总数 0 ⇒ **不渲染**环图")
        assert.ok(!rEmpty.text.includes("总数"), "空账本不得出现环图的中心文案")
      } finally { rmSync(wsEmptyRing, { recursive: true, force: true }) }
    } finally { rmSync(wsRing, { recursive: true, force: true }) }

    // ④-d T-34 · 五态更显眼（§21.2 FR-4）：① 每行左侧 4px 状态色条 ② 状态 pill 实心彩色（白字）
    //   ③ 分区标题带状态色条 ④ 顶栏（看板正文顶部）五态图例行。
    //   变异自证：删掉 TaskRow 的 `.tc-tasks-stripe` 元素 ⇒ 色条断言红；把状态 pill 的 `tc-st-*` 类去掉
    //   ⇒ 实心类断言红；删掉分区色条 / 图例 ⇒ 对应断言红。
    const wsVis = freshWs()
    try {
      seedLedger(wsVis, [
        task("t-1", { kind: "decision", status: "待办", owner: "s-1", createdBy: "s-1" }),
        task("t-2", { status: "待办", owner: "s-1", createdBy: "s-1" }),
        task("t-3", { status: "已接手", owner: "s-1", createdBy: "s-1" }),
        task("t-4", { status: "在做", owner: "s-1", createdBy: "s-1" }),
        task("t-5", { status: "卡住", blockedBy: "self", blockedReason: "等自己动手", owner: "s-1", createdBy: "s-1" }),
        task("t-6", { status: "完成", evidence: "跑了 12/12 绿", owner: "s-1", createdBy: "s-1" }),
      ], 2)
      const pVis = buildTasksBoardPayload({ ws: wsVis, sessionId: "s-1", config: {}, drift: null })
      const rVis = await renderClientBoard(pVis)
      const VIS_COLORS = { "待办": "#94A3B8", "已接手": "#6366F1", "在做": "#0EA5E9", "卡住": "#EF4444", "完成": "#22C55E" }
      const VIS_CLASSES = { "待办": "tc-st-todo", "已接手": "tc-st-claim", "在做": "tc-st-doing", "卡住": "tc-st-block", "完成": "tc-st-done" }
      const STATUS_BY_ID = { "t-1": "待办", "t-2": "待办", "t-3": "已接手", "t-4": "在做", "t-5": "卡住", "t-6": "完成" }
      // ① 每行一条状态色条，颜色 = 该行状态色；② 状态 pill 带实心色类且文案仍是状态词
      const rowsVis = collectByClass(rVis.tree, "tc-tasks-row")
      assert.equal(rowsVis.length, 6, "六条各一行（实测 " + rowsVis.length + "）")
      for (const row of rowsVis) {
        const idEl = collectByClass(row, "tc-tasks-id")[0]
        assert.ok(idEl, "每行必须有编号元素")
        const id = treeText(idEl).join("")
        assert.ok(STATUS_BY_ID[id], "夹具外的行：" + id)
        const stripes = collectByClass(row, "tc-tasks-stripe")
        assert.equal(stripes.length, 1, id + " 必须恰有一条状态色条（FR-4 ①）")
        assert.equal(stripes[0].props.style.background, VIS_COLORS[STATUS_BY_ID[id]],
          id + " 的色条颜色必须 = 状态色（实测 " + JSON.stringify(stripes[0].props.style) + "）")
        const pills = collectByClass(row, "tc-tasks-status")
        assert.equal(pills.length, 1, id + " 必须恰有一个状态 pill")
        const cls = String(pills[0].props.className)
        assert.ok(cls.includes(VIS_CLASSES[STATUS_BY_ID[id]]),
          id + " 的状态 pill 必须带实心色类 " + VIS_CLASSES[STATUS_BY_ID[id]] + "（实测 " + cls + "）")
        assert.ok(treeText(pills[0]).join("").startsWith(STATUS_BY_ID[id]),
          id + " 的 pill 文案必须仍是状态词（T-4a/T-17 依赖，不改文案；实测 " + JSON.stringify(treeText(pills[0])) + "）")
      }
      // 实心 pill 的样式面：类 ↔ 色值逐条在场 + 白字
      const cSrcVis = readFileSync(join(PLUGIN_DIR, "lib", "client.js"), "utf8")
      for (const [st, cls] of Object.entries(VIS_CLASSES)) {
        const body = styleBodyOf(cSrcVis, "." + cls)
        assert.ok(body && body.includes("background:" + VIS_COLORS[st]),
          "." + cls + " 必须是实心底色 " + VIS_COLORS[st] + "（实测 " + body + "）")
      }
      assert.ok(styleBodyOf(cSrcVis, ".tc-tasks-status").includes("color:#FFFFFF"),
        "状态 pill 必须白字（实心底色上可读，FR-4 ②）")
      // ③ 分区标题色条：四个分区（待你决策/卡住/任务/已完成）各一条
      const secbars = collectByClass(rVis.tree, "tc-tasks-secbar")
      assert.equal(secbars.length, 4, "四个分区标题都必须带状态色条（实测 " + secbars.length + "）")
      assert.deepEqual(secbars.map((b) => b.props.style.background).sort(),
        ["#0EA5E9", "#22C55E", "#94A3B8", "#EF4444"], "分区色条 = 分区语义对应的五态色（FR-4 ③）")
      // ④ 五态图例行（FR-4 ④）
      const legendEls = collectByClass(rVis.tree, "tc-tasks-legend5")
      // ★ 2026-10-18 交付评审 #1 订正：原断言只验「图例存在」，咬不住**位置** ——
  //   图例曾被挂在滚动区里，任务一多就滚走（恰恰在这个它本该解决问题的场景失效）。
  //   现判据：图例存在 **且** 它渲染在 `tc-tasks-legendwrap` 固定层里（不在 TasksBoardBody 的滚动子树内）。
  assert.equal(legendEls.length, 1, "看板顶部必须有五态图例行")
  assert.ok(!/nodes\.push\(h\(StatusLegend/.test(cSrcVis), "★ 五态图例不得再挂在滚动区（TasksBoardBody）里")
  assert.ok(/className: "tc-tasks-legendwrap"[\s\S]{0,80}StatusLegend/.test(cSrcVis)
    || /h\(StatusLegend, \{\}\)/.test(cSrcVis), "★ 五态图例必须在固定层（tc-tasks-legendwrap）渲染")
      const legendItems = collectByClass(legendEls[0], "tc-tasks-legend5-item")
      assert.deepEqual(legendItems.map((x) => treeText(x).join("")), ["待办", "已接手", "在做", "卡住", "完成"],
        "图例必须逐条列出五态（顺序 = 环图/色板顺序）")
      assert.deepEqual(legendItems.map((x) => collectByClass(x, "tc-tasks-legend5-dot")[0].props.style.background),
        ["#94A3B8", "#6366F1", "#0EA5E9", "#EF4444", "#22C55E"], "图例色点 = 五态色板")
    } finally { rmSync(wsVis, { recursive: true, force: true }) }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：去掉 buildTaskClickPayload 里的任一要素（如 docs 恒空数组）⇒ ② 红；组件不渲染某一段 ⇒ ③ 红；
// 把默认态改回折叠（`useState(false)`）⇒ ③ 的 `defaultText`（不点按钮）断言红；把「收起/展开」的切换删掉 ⇒
// 助手拿不到 collapsedText / 文本回不来 ⇒ 红。
// ④（T-32 优先级 / 环图 / T-33 收展 / T-34 五态）的变异自证见 ④-a / ④-b / ④-c / ④-d 四段的内联注
// （0 不显示 / 计数读 counts / 配色改动 / 默认改收起 / 删色条 都要能红）。

/**
 * 用**真实客户端组件**渲染看板：首渲染 → 放行 fetch 的微任务 → 记下**默认态** →
 * 显式「收起」再「展开」（验证折叠分支仍在、按钮仍可切换）→（可选）点某按钮 / 点「看详情」/ 点一串按钮。
 * ★ 设计档 §19.9「默认展开腿」：看板自批36-补3 起**默认展开**；折叠分支**保留**——本助手对这两面都取证。
 * @param {{detail?: boolean, clickLabel?: string, clipboard?: null, fetchImpl?: Function, clicks?: string[]}} [opts]
 *   `fetchImpl` 覆盖默认的「永远返回同一份载荷」（批 36-补：接手的 POST 要能落到真实 host 实现上）；
 *   `clicks` = 依次点击的按钮文案（每点一次都放行微任务并重渲染）。
 * @returns {Promise<{text, defaultText, collapsedText, tree, tab}>}
 *   `defaultText` = 数据落地后的**默认态**（不点任何按钮）；`collapsedText` = 显式点「收起」后的折叠态。
 */
async function renderClientBoard(payload, { detail = false, clickLabel = null, clipboard, fetchImpl, clicks, sessionId = "s-1" } = {}) {
  const harness = makeHookHarness()
  const { exports: mod } = loadClientBundle({
    React: harness.React,
    fetchImpl: fetchImpl || (() => Promise.resolve({ json: () => Promise.resolve(payload) })),
    clipboard,
  })
  let tabDesc = null
  mod.apply(fakeClientCtx({ registerTab: (d) => { tabDesc = d; return () => {} } }).ctx)
  assert.ok(tabDesc && typeof tabDesc.component === "function", "必须先注册出可渲染的 tab descriptor")
  const props = { ctx: {}, scope: { sessionId }, tab: { id: "thincoder:tasks" }, visible: true }
  harness.render(tabDesc.component, props) // 挂载：effect 发起拉取（promise 尚未落地）
  for (let i = 0; i < 8; i++) await Promise.resolve() // 放行 fetch → json → setState 的微任务链
  let tree = harness.render(tabDesc.component, props)
  // ★ 默认态（§19.9「默认展开腿」：应为**展开**）—— 必须在任何点击之前取，才能证明「不用点就看得见」。
  const defaultText = treeText(tree).join("\n")
  // 兼容分支：若默认态是折叠（按钮文案「展开」），先点开再继续（本批之外的人改回折叠也不崩）。
  if (findButton(tree, "展开")) {
    clickButton(tree, "展开")
    tree = harness.render(tabDesc.component, props)
  }
  // 折叠分支必须仍在且可切换：显式「收起」取折叠态文本，再点回「展开」。
  let collapsedText = null
  if (findButton(tree, "收起")) {
    clickButton(tree, "收起")
    const collapsedTree = harness.render(tabDesc.component, props)
    collapsedText = treeText(collapsedTree).join("\n")
    clickButton(collapsedTree, "展开")
    tree = harness.render(tabDesc.component, props)
  }
  assert.ok(!treeText(tree).join("\n").includes("看板数据不可得"), "展开后不得是「数据不可得」态：" + treeText(tree).join("\n").slice(0, 200))
  if (detail) {
    clickButton(tree, "看详情")
    tree = harness.render(tabDesc.component, props)
  }
  if (clickLabel) {
    clickButton(tree, clickLabel)
    tree = harness.render(tabDesc.component, props)
  }
  for (const label of Array.isArray(clicks) ? clicks : []) {
    clickButton(tree, label)
    for (let i = 0; i < 8; i++) await Promise.resolve() // 放行 POST → 载荷 → setState
    tree = harness.render(tabDesc.component, props)
  }
  return { text: treeText(tree).join("\n"), defaultText, collapsedText, tree, tab: tabDesc }
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
      task("t-1", { kind: "decision", title: "等你拍板的一条", owner: "s-1", createdBy: "s-1" }),
      task("t-2", { status: "在做", title: "在办的一条", owner: "s-1", createdBy: "s-1" }),
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
    //    ★ 批 36-补：夹具补 `owner: "s-1"`（看板默认区 = 本会话；设计档 §16.2 的「世界变了」）
    seedLedger(ws, [
      task("t-1", { kind: "decision", title: "等你拍板的一条", owner: "s-1", createdBy: "s-1" }),
      task("t-2", { status: "在做", title: "在办的一条", owner: "s-1", createdBy: "s-1" }),
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
      // ★ 2026-10-17 补（规则统一）：空分区规则**同样适用于 `countOnly` 分区**（「已完成」）。
      //   ⚠ **实测教训**：最初我把这条断言写在上面的空账本分支里 —— **变异不红**，
      //   因为**空账本走的是 `emptyState` 分支，压根不渲染任何分区**，断言恒真。
      //   ⇒ 必须用「**有任务、但没有已完成项**」的账本，才能真验到 countOnly 分支。
      const ws3 = freshWs()
      try {
        seedLedger(ws3, [task("t-1", { status: "待办", owner: "s-1", createdBy: "s-1", title: "在办的一条", check: "看得到" })], 0)
        const one = buildTasksBoardPayload({ ws: ws3, sessionId: "s-1", config: {}, drift: null })
        const tr = await renderClientBoard(one)
        assert.ok(tr.text.includes("任务（"), "有任务时必须渲染任务分区（否则本腿恒真）：\n" + tr.text)
        // 变异自证：把 client.js 的 countOnly 分支里 `if ((s.count || 0) === 0) continue;` 删掉
        // ⇒ 下面这条红（文本里重新出现「已完成（0）」）。
        assert.ok(!tr.text.includes("已完成（"),
          "没有已完成项时**不得**渲染「已完成（0）」（T-14 空分区规则的 countOnly 版）：\n" + tr.text)
      } finally { rmSync(ws3, { recursive: true, force: true }) }
    } finally { rmSync(ws2, { recursive: true, force: true }) }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：把决策分区排到任务区之后（sections 顺序对调）⇒ ① 红；空集也渲染分区壳 ⇒ ② 红。

// ── T-7③ 真实档读取的**可注入缝**（批 42 修复轮 ⑧；设计档 §八 T-7 / §九） ──
const REAL_DOC_PATH = join(PLUGIN_DIR, "docs", "2026-09-05-defect-registry.md")

/**
 * 读「真实验收档」并尝试解析 —— **路径可注入**（默认本仓真档），因此 diagnostic 分支能在套件内被跑到。
 * @pre  `path` 任意路径（不存在 / 不可读 / 不可解析文本都允许 —— 这不是错误前提）
 * @post 返回 `{ path, text, parsed, diagnostic }`：
 *        · 可解析 ⇒ `parsed` 非 null、`diagnostic === null`（调用方做条数断言 + 留痕）
 *        · 不可解析 / 文件缺失 ⇒ `parsed === null`、`diagnostic` 为**非空**说明串（含路径与原因）
 * @post **绝不抛**（ENOENT / 读失败 / 畸形文本都落到 diagnostic —— 设计档 §九「腿不红」）
 */
function readRealChecklist(path = REAL_DOC_PATH) {
  let text = null
  let readError = null
  try { text = readFileSync(path, "utf8") } catch (e) { readError = e }
  const parsed = readError === null && text !== null ? parseChecklistDoc(text) : null
  const diagnostic = parsed !== null ? null
    : "T-7③ 真实验收档**不可解析**（" + path
      + (readError !== null
        ? (readError.code === "ENOENT" ? "：文件不存在" : "：读取失败 " + String(readError.code ?? readError.message))
        : "：未找到 ≥4 列且含状态列的表格")
      + "）—— 条数断言按设计（D-3）跳过；诊断留痕见本条 diagnostic"
  return { path, text, parsed, diagnostic }
}

/**
 * 跑一条「真实验收档」腿（③ 与 ③-b 共用 —— **分支代码只有这一处**，注入路径复用的就是它）。
 * @param {(msg: string) => void} diag 诊断出口（真实腿传 `t.diagnostic`，注入腿传记录器）
 * @post 可解析 ⇒ 条数 / 守恒 / 列数三条断言生效，并经 diag 留痕；不可解析/缺档 ⇒ 经 diag 留痕，**不抛**
 * @post 返回 `{ path, text, parsed, diagnostic, branch }`，`branch ∈ "if" | "else"`（便于套件断言真的走到哪支）
 */
function runRealChecklistLeg(diag, path = REAL_DOC_PATH) {
  const real = readRealChecklist(path)
  if (real.parsed !== null) {
    assert.equal(real.parsed.rows.length, firstTableDataRows(real.text),
      "解析出的条数必须 == 独立数出的数据行数（两处不同算法互证）")
    assert.equal(real.parsed.counts.total, real.parsed.rows.length)
    // ★ 2026-10-17 交付评审 #5：原断言 (=="UNKNOWN 恰等于行数") 把这条腿**钉死在该档当前的列形状**上
    //   （状态列是中文长句 ⇒ 全部「未识别」）；该档将来把状态列改成英文枚举就会红 —— 那是
    //   「对**不属于本契约**的文档形状的依赖」（R4 脆弱测试形态）。改为**守恒式**：
    //   每一行必须恰好落进一个状态桶；UNKNOWN 作为**读数**打印，不再作断言。
    const bucketSum = ["TODO", "DOING", "BLOCKED", "PASS", "FAIL", "UNKNOWN"]
      .reduce((a, k) => a + (real.parsed.counts[k] ?? 0), 0)
    assert.equal(bucketSum, real.parsed.rows.length,
      "守恒式：各行必须恰好落进一个状态桶（桶和 == 行数）—— 实测桶和 " + bucketSum + " / 行数 "
      + real.parsed.rows.length + " / UNKNOWN = " + (real.parsed.counts.UNKNOWN ?? 0) + "（读数，不作断言）")
    assert.ok(real.parsed.columns.length >= 4, "列数 ≥4：实测 " + real.parsed.columns.length)
    diag("T-7③ 真实验收档可解析：" + real.path + " ⇒ 条数断言已生效（" + real.parsed.rows.length + " 条）")
    return { ...real, branch: "if" }
  }
  // 不可解析 / 档不存在：**留痕不静默**（批 42 ⑧ 的 diagnostic 分支；本节不得变成静默跳过）
  diag(real.diagnostic)
  return { ...real, branch: "else" }
}

// ═══════════════ T-7：结构化文档只读源（US-10 / D10「不猜、不部分解析」） ═══════════════

test("T-7（US-10 · D10）: parseChecklistDoc —— 列数不足/无状态列 ⇒ null；实例验收表解析出条数与状态分布", (t) => {
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

  // ③ **真实验收档**（本仓实例）：**能解析才断言**（批 42 ⑧ / 设计档 §四 D-3）
  //    ★ 为什么改：原写法要求「本仓这份文档此刻恰好可解析」—— 档一变（哪怕只加一行）或导出环境里
  //      根本没有这份档，腿就红，且红的原因与本插件无关（R4 脆弱测试形态）。
  //    ⇒ 现在：可解析 ⇒ 条数必须与**独立数出的**数据行数相等（判据**没有**放宽）；
  //      不可解析/不存在 ⇒ **明确留痕**（t.diagnostic）而**不是**静默跳过（静默跳过 = 假腿）。
  //    ★ 辨析：diagnostic 只记录「这条腿这次没跑」，不是「通过」—— 留痕不等于断言。
  //    ★ 批 42 修复轮：读哪个档做成**可注入**（`readRealChecklist(path = REAL_DOC_PATH)`），
  //      ⇒ diagnostic 分支与「真档缺失」都能**在套件内**被真正跑到并断言（见 ③-b）。
  const realDiags = []
  const real = runRealChecklistLeg((m) => { realDiags.push(m); t.diagnostic(m) })
  assert.equal(realDiags.length, 1,
    "真实腿必须恰留一条 diagnostic（可解析/不可解析两支都留痕；静默跳过 = 假腿）")

  // ③-b（批 42 修复轮 ⑧ · **套件内**跑 diagnostic 分支 + 缺档不红）：
  //   同一注入缝喂两份坏输入 —— ① 临时文件里放**不可解析文本**；② **不存在的路径**（ENOENT）。
  //   两者都必须：不抛、parsed === null、diagnostic **非空且含关键信息**（路径 + 原因），
  //   并且照真实分支那样交给 `t.diagnostic`（留痕，不静默）。
  //   变异自证：把 `readRealChecklist` 的路径参数改回**写死真档** ⇒ 两份坏输入都会走 if 分支
  //   ⇒ 下面的 `branch === "else"` / parsed / text 断言红；把 diagnostic 改回 null / 空串 ⇒ 也红。
  const badDir = freshWs()
  try {
    const badPath = join(badDir, "unparseable.md")
    writeFileSync(badPath, "这是一段自由文本：没有 ≥4 列且含状态列的表格。", "utf8")
    const badDiags = []
    const bad = runRealChecklistLeg((m) => badDiags.push(m), badPath)
    assert.equal(bad.branch, "else", "注入不可解析文本 ⇒ 必须真的走 **else（diagnostic）分支**")
    assert.equal(bad.parsed, null, "注入不可解析文本 ⇒ parsed === null（不部分解析）")
    assert.equal(badDiags.length, 1, "else 分支必须恰留**一条** diagnostic（不许静默跳过 —— 静默 = 假腿）")
    assert.equal(badDiags[0], bad.diagnostic, "留痕内容必须就是 readRealChecklist 产出的诊断")
    assert.ok(typeof bad.diagnostic === "string" && bad.diagnostic.length > 0,
      "diagnostic 分支必须给出**非空**说明")
    assert.ok(bad.diagnostic.includes("不可解析") && bad.diagnostic.includes(badPath),
      "diagnostic 必须含关键信息（「不可解析」+ 注入的路径）：" + bad.diagnostic)
    t.diagnostic(bad.diagnostic)

    const missingPath = join(badDir, "does-not-exist.md")
    const missingDiags = []
    const missing = runRealChecklistLeg((m) => missingDiags.push(m), missingPath)
    assert.equal(missing.text, null, "真档缺失 ⇒ text 为 null（读取失败被吞成诊断，而不是抛）")
    assert.equal(missing.branch, "else", "缺档 ⇒ 同一注入路径走 else 分支（**不抛**）")
    assert.equal(missingDiags.length, 1, "缺档同样必须留痕（恰一条）")
    assert.ok(typeof missing.diagnostic === "string" && missing.diagnostic.includes("文件不存在"),
      "缺档必须留痕且原因明确（设计档 §九：腿不红）：" + missing.diagnostic)
    assert.ok(missing.diagnostic.includes(missingPath), "缺档诊断必须点名路径：" + missing.diagnostic)
    t.diagnostic(missing.diagnostic)
  } finally {
    rmSync(badDir, { recursive: true, force: true })
  }

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

    // ④-b（批 42 ⑧ · **套件内**跑 diagnostic 分支）：用 readChecklistDocs 的 **loader 注入缝**
    //   （lib/tool-tasks.mjs:31 第三个参数，已导出）喂一份**不可解析**的文本 ⇒ 必须 ok:false 且
    //   error 非空 —— **不许静默**（静默 = 不可解析的文档看起来像「没有待办」）。
    //   ★ 不需要临时目录：loader 就是那条可注入的读取口（设计档 §八 T-7 的「做成可注入路径」）。
    //   变异自证：把 if (!parsed) 分支写成「跳过该项」（不 push 结果）或回填 ok:true ⇒ 本段红。
    const unparseable = readChecklistDocs({
      ws,
      docPaths: ["docs/unparseable.md"],
      loader: () => "这是一段自由文本：没有 ≥4 列且含状态列的表格。",
    })
    assert.equal(unparseable.length, 1, "逐条给结果（不可解析也必须留下一条**结果项**，不能消失）")
    assert.equal(unparseable[0].ok, false, "不可解析 ⇒ ok:false（不许静默当作成功）：" + JSON.stringify(unparseable[0]))
    assert.ok(typeof unparseable[0].error === "string" && unparseable[0].error.length > 0,
      "不可解析 ⇒ error 必须非空（留痕，不许静默）：" + JSON.stringify(unparseable[0]))
    assert.equal(unparseable[0].rows, undefined, "不可解析 ⇒ **不部分解析**（不得回填空 rows 冒充成功）")
    // 阳性对照（防「凡注入必拒」的假绿）：同一注入缝换成可解析文本 ⇒ ok:true
    const okViaLoader = readChecklistDocs({ ws, docPaths: ["docs/ok.md"], loader: () => fixture })
    assert.equal(okViaLoader.length, 1, "逐条给结果")
    assert.equal(okViaLoader[0].ok, true, "同一注入缝喂可解析文本必须 ok:true：" + JSON.stringify(okViaLoader[0]))
    assert.equal(okViaLoader[0].counts.total, 6, "可解析时条数照常给出：" + JSON.stringify(okViaLoader[0].counts))
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：允许 3 列也解析（把 `columns.length < 4` 改成 `< 1`）⇒ ① 红；把不认识的写法猜成默认状态
// （如 `status = status ?? "TODO"`）⇒ ② 的 UNKNOWN 与 null 断言红；④ 把 `readChecklistDocs` 的越界
// 分支删掉（`continue` 换成直接读）⇒ 越界两条断言 + `seen` 那条同时红。
// ★ 批 42 ⑧：③ 改成「能解析才断言」后，**删掉真实档**或把它换成无表文档 ⇒ 本腿**不红**，
//   但会打印一条 diagnostic（留痕，不静默）；③-b 的注入腿（不可解析文本 / 缺档）在套件内**必红**
//   （branch / parsed / text / diagnostic 四条断言）；④-b 的 loader 注入腿仍**必红**（不可解析 ⇒ ok:false）。

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
    // 批 42 ④（腿名 T-9a/T-9b/T-9c；**并入本 T-9 块** —— 与上面「写面是拒」的既有上限断言同块，
    //   修复轮 3 订正：原先误放在 T-4a（看板块）——设计档 §八 说「并入 T-9」）：文档路径清单 —— 判上限读**去重后**的条数
    //   T-9a：9 条但**含重复** ⇒ 去重后 ≤ MAX_DOC_PATHS ⇒ **通过**
    //     （旧实现先判 v.length=9 ⇒ 会拒 —— 这是本批**唯一**的用户可见放宽，设计档 §0-1 / §三-2）
    //   T-9b：数组含非字符串（42 / null）⇒ 返回 false **且不抛**
    //     （纯函数后置；String() 强转**只用于算去重**，合法性仍要求每项本身是非空字符串）
    //   T-9c：9 条**互不相同** ⇒ 仍拒（上限没被放宽；阴性对照，防「凡含重复必过」的过度放宽）
    //   变异自证：把 isValidDocPathList 改回「先判 v.length」⇒ T-9a 红；把 every 里的 typeof 判断删掉
    //   改成直接 p.trim() ⇒ T-9b 抛 TypeError ⇒ 红；删掉上限判断 ⇒ T-9c 红。
    const dup9 = ["a.md", "a.md", "b.md", "b.md", "c.md", "c.md", "d.md", "d.md", "e.md"]
    assert.equal(dup9.length, 9, "夹具自证：9 项（> 上限 " + MAX_DOC_PATHS + "）")
    assert.equal(new Set(dup9).size, 5, "夹具自证：去重后只有 5 个互异项")
    assert.equal(isValidDocPathList(dup9), true,
      "★ 9 条**含重复** ⇒ 去重后 5 条 ≤ 上限 ⇒ 必须**通过**（旧实现按 v.length=9 拒）")
    // T-9c 阴性对照（防「凡含重复必过」的过度放宽）：9 条**互异** ⇒ 仍拒（上限没被放宽）
    assert.equal(isValidDocPathList(Array.from({ length: MAX_DOC_PATHS + 1 }, (_, i) => "u" + i + ".md")), false,
      "9 条互异 ⇒ 仍拒（去重只免掉重复项的配额，上限不变）")
    // T-9b 非字符串元素：**不抛**且 false（不得因 String() 强转而变成合法项）
    assert.doesNotThrow(() => isValidDocPathList([42]), "非字符串元素 ⇒ 绝不抛（纯函数后置）")
    assert.equal(isValidDocPathList([42]), false, "数字项 ⇒ false（不抛）")
    assert.equal(isValidDocPathList([null]), false, "null 项 ⇒ false（不抛）")
    assert.equal(isValidDocPathList(["a.md", 42, "b.md"]), false, "混合数组里有一个非字符串 ⇒ false")
    // ★ 批 42 修复轮 3（交付代码评审 🔵 ×2）：同一片代码的**另外两个洞**，各自补一腿
    //   （不新增 T 编号 —— 设计档 §八 只定义 T-9a/T-9b/T-9c；这两腿挂在该组末尾、同处一个块）
    //   腿 A（稀疏数组绕过上限）：`Array(9)` 是 9 个**空洞**，`map`/`every` 都会跳过它们 ⇒ 旧写法
    //     「0 个互异项 + 真空真」= **true** ⇒ 上限被整个绕过（`Array(100)` 同理）。稠密化后空洞 =
    //     `undefined` ⇒ 逐项判据 false ⇒ 必须返回 false。
    //     变异自证：把 `const list = Array.from(v)` 换回直接用 `v`（去重与 every 都读 v）⇒ 本腿红。
    assert.equal(isValidDocPathList(Array(9)), false,
      "★ 9 个**空洞**的稀疏数组 ⇒ 必须 false（跳过空洞会让上限被整个绕过：旧形态在这里返回 true）")
    assert.equal(isValidDocPathList(Array(100)), false, "100 个空洞同样 ⇒ false（不是「恰 9 个」才特殊）")
    //   腿 B（`String(p)` 会抛）：`Object.create(null)` **没有 ToPrimitive** ⇒ 旧写法 `String(p)` 抛
    //     `TypeError`，推翻同段 JSDoc 的「纯函数不抛」与 T-9b 的「绝不抛」。
    //     变异自证：把 `typeof p === "string" ? p.trim() : null` 用回 `String(p).trim()` ⇒ 本腿红（抛错）。
    const nullProtoItem = Object.create(null)
    assert.doesNotThrow(() => isValidDocPathList([nullProtoItem]),
      "★ 无 ToPrimitive 的值 ⇒ **绝不抛**（纯函数后置；旧 `String(p)` 在这里抛 TypeError）")
    assert.equal(isValidDocPathList([nullProtoItem]), false, "无原型的对象项 ⇒ false（不抛）")
    // ————— 批 44（台账 t-8）：docPaths 的「去重」补齐镜像（设计档 docs/2026-10-19-t8-docpaths-mirror-design.md §八） —————
    // ★ 本批**五条新腿**（T-9d / T-9e / T-9h / T-9f / T-9g）并入本 T-9 块（不新增顶层 test(）。
    //   第六条是**既有的 C-L4**（两侧逐夹具等值），它留在 `test/config-api.test.mjs` 的 U3c2 块 ——
    //   ★ 2026-10-19 偏离审计 #2 订正：原注释写「六条腿全部并入本 T-9 块」，与实际位置不符。
    //   T-9f/T-9g 是**静态文本锁**：读 lib/client.js 源码字节断言片段 —— 锁的是**源码形状**；
    //   bundle 本身需 React/DOM 桩才能加载（同档 `loadClientBundle`、本块 T-9h 的
    //   `renderSettingsLedger` 都在 node 里用 React 桩加载执行）⇒ **行为面由 T-9h 与 C-L4 覆盖**。
    // ★ 夹具（9 项含 1 重复 ⇒ 去重后 8 条唯一；重复项放在第 2 位 —— 「先截后去重」会把 h.md 截掉）：
    const nineWithDup = ["a.md", "a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md"]
    const nineDistinct = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md", "i.md"]
    const tenWithDup = ["a.md", "a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md", "i.md"]
    assert.equal(nineWithDup.length, 9, "夹具自证：9 行（其中 1 行重复）")
    assert.equal(new Set(nineWithDup).size, 8, "夹具自证：去重后 8 条唯一")
    assert.equal(nineDistinct.length, 9, "夹具自证：9 行互异")
    assert.equal(tenWithDup.length, 10, "夹具自证：10 行（其中 1 行重复）")
    assert.equal(new Set(tenWithDup).size, 9, "夹具自证：去重后 9 条唯一（> 上限 " + MAX_DOC_PATHS + "）")
    const draftOf = (lines) => ({ ledger: { mode: "standalone", docPathsText: lines.join("\n"), copyTemplate: "话术" } })
    const hasCountError = (errs) => errs.some((e) => e.includes("最多 " + MAX_DOC_PATHS + " 条"))

    // T-9d（规则源草稿校验）：9 行含 1 重复 ⇒ 去重后 8 ⇒ **不报**「最多 8 条」；9 行互异 ⇒ **报**。
    //   变异自证：把 FR-1 的 dedupePaths(paths).length 改回 paths.length ⇒ 第一条断言红。
    const errsDup9 = lgDraftErrors(draftOf(nineWithDup))
    assert.ok(!hasCountError(errsDup9),
      "T-9d：9 行含 1 重复 ⇒ 去重后 8 条 ≤ 上限 ⇒ **不得**报「最多 8 条」（实测 " + JSON.stringify(errsDup9) + "）")
    const errsDistinct9 = lgDraftErrors(draftOf(nineDistinct))
    assert.ok(hasCountError(errsDistinct9),
      "T-9d：9 行互异 ⇒ 去重后 9 条 > 上限 ⇒ 必须报「最多 8 条」（实测 " + JSON.stringify(errsDistinct9) + "）")

    // T-9e（读面）：9 项含 1 重复 ⇒ 读面必须**先去重再截断**，保留 8 条**唯一**路径。
    //   变异自证：删掉 FR-4 的 Set 去重 ⇒ 实测 ["a.md","a.md","b.md",…]（长度仍是 8，但内容不等）⇒ 红。
    const resolved9 = resolveLedgerConfig({ ledger: { docPaths: nineWithDup } }).docPaths
    assert.equal(resolved9.length, MAX_DOC_PATHS, "T-9e：9 项含 1 重复 ⇒ 读面保留 8 条唯一路径")
    assert.deepEqual(resolved9, nineDistinct.slice(0, MAX_DOC_PATHS),
      "T-9e：读面必须等于**去重后的前 8 条唯一路径**（重复项不吃配额，也不挤掉第 8 条唯一路径）")

    // T-9h（数字也钉）：错误文案里的 n 与界面「已填 N / 8」都必须是**去重后**的条数。
    //   10 行含 1 重复 ⇒ 去重后 9 > 8 ⇒ 文案「（当前 9 条）」；旧口径（原始行数）会写 10。
    const errs10 = lgDraftErrors(draftOf(tenWithDup))
    assert.ok(errs10.some((e) => e.includes("（当前 9 条）")),
      "T-9h：10 行含 1 重复 ⇒ 去重后 9 ⇒ 文案必须含「（当前 9 条）」（实测 " + JSON.stringify(errs10) + "）")
    assert.ok(!errs10.some((e) => e.includes("（当前 10 条）")),
      "T-9h：不得再出现按**原始行数**的「（当前 10 条）」")
    assert.ok(errsDistinct9.some((e) => e.includes("（当前 9 条）")),
      "T-9h：9 行互异 ⇒ 文案同样「（当前 9 条）」（实测 " + JSON.stringify(errsDistinct9) + "）")
    // 界面半边（真实组件渲染）：9 行互异 ⇒ 已填 9 / 8（已超上限…）；9 行含 1 重复 ⇒ 已填 8 / 8（不劝退）。
    const uiDistinct9 = renderSettingsLedger({ ledger: { mode: "standalone", docPaths: nineDistinct, copyTemplate: "话术" } })
    assert.ok(uiDistinct9.includes("已填 9 / 8（已超上限——保存会被后端拒绝）"),
      "T-9h：9 行互异 ⇒ 界面必须显示「已填 9 / 8（已超上限——保存会被后端拒绝）」（实测尾部：" + uiDistinct9.slice(-400) + "）")
    const uiDup9 = renderSettingsLedger({ ledger: { mode: "standalone", docPaths: nineWithDup, copyTemplate: "话术" } })
    assert.ok(uiDup9.includes("已填 8 / 8"),
      "T-9h：9 行含 1 重复 ⇒ 界面必须按去重后显示「已填 8 / 8」（实测尾部：" + uiDup9.slice(-400) + "）")
    assert.ok(!uiDup9.includes("已填 8 / 8（已超上限"),
      "T-9h：重复项不占配额 ⇒ 界面**不得**再劝退（去重后 8 条未超上限）")
    // 同屏**第二处**数字（effective 面「文档清单 N 条」）必须同口径（批 44 修复轮 2 · 交付代码评审 #1）：
    //   旧形态读 `effPaths.length`（原始数组）⇒ 同一屏出现「已填 8 / 8」与「文档清单 9 条」，
    //   而看板实际只用 8 条 ⇒ 数字自相矛盾。
    //   变异自证：把 `effPaths` 改回原始数组 ⇒ 第二条断言红（实测出现「文档清单 9 条」）。
    assert.ok(uiDup9.includes("文档清单 8 条"),
      "T-9h：effective 面「文档清单 N 条」必须按去重后计数（9 行含 1 重复 ⇒ 8 条；实测尾部：" + uiDup9.slice(-400) + "）")
    assert.ok(!uiDup9.includes("文档清单 9 条"),
      "T-9h：同屏两个数字必须一致 —— 不得再按**原始** 9 条显示「文档清单 9 条」")

    // T-9f（静态文本锁）：浏览器镜像的上限判定必须**含去重调用**，且与规则源**同一口径**。
    //   变异自证：把 client.js 的 dedupePaths(paths).length 改回 paths.length ⇒ 第一条断言红。
    const clientSrc = readFileSync(join(PLUGIN_DIR, "lib", "client.js"), "utf8")
    const ruleSrc = readFileSync(join(PLUGIN_DIR, "lib", "ledger-config-text.mjs"), "utf8")
    assert.ok(clientSrc.includes("var n = dedupePaths(paths).length;"),
      "T-9f：浏览器镜像的上限判定必须按**去重后**计数（片段 var n = dedupePaths(paths).length; 不在 ⇒ 红）")
    assert.ok(/function dedupePaths\(paths\) \{/.test(clientSrc),
      "T-9f：镜像必须自带一份局部 dedupePaths（client.js 无法 import ESM，不是没实现）")
    assert.ok(clientSrc.includes("条（当前 \" + n + \" 条）"),
      "T-9f：镜像的错误文案里 n 必须是去重后的计数（与规则源同一模板）")
    assert.ok(ruleSrc.includes("const n = dedupePaths(paths).length"),
      "T-9f：规则源（单一源）同样按**去重后**计数")
    assert.ok(ruleSrc.includes("条（当前 \" + n + \" 条）"),
      "T-9f：规则源与浏览器镜像的错误模板必须逐字相同（C-L4 之外不再留一处漂移面）")
    assert.ok(clientSrc.includes("if (n > LEDGER_MAX_DOC_PATHS) {"),
      "T-9f：计数级判定读的必须是那个 n（改回 LEDGER_MAX_DOC_PATHS < paths.length 之类 ⇒ 红）")
    assert.ok(ruleSrc.includes("if (n > MAX_DOC_PATHS) {"),
      "T-9f：规则源的计数级判定同样读 n（与镜像同形）")

    // T-9g（静态文本锁）：pathsOver 与「已填 N / 8」必须都用**去重后**长度。
    //   变异自证：把 pathsOver 那行改回 pathsArr.length ⇒ 第一条断言红；把「已填」那行改回 ⇒ 第二条红。
    assert.ok(clientSrc.includes("var pathsOver = dedupePaths(pathsArr).length > LEDGER_MAX_DOC_PATHS;"),
      "T-9g：pathsOver 必须按去重后计数（改回 pathsArr.length ⇒ 红）")
    assert.ok(clientSrc.includes("\"已填 \" + dedupePaths(pathsArr).length + \" / \" + LEDGER_MAX_DOC_PATHS"),
      "T-9g：「已填 N / 8」必须用去重后计数（改回 pathsArr.length ⇒ 红）")
    assert.ok(clientSrc.includes("var tplOver = tpl.length > LEDGER_COPY_MAX_CHARS;"),
      "T-9g：话术模板超限（tplOver，原 :1841）属另一主题，必须保持原样（被误改 ⇒ 红）")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：把 `off` 分支改成整段返回（连 drift 一起丢）⇒ 状态区两条断言红；默认值改成 off ⇒ 反向自证红。

// ═══════════════ T-16：claim **只改 owner**（设计档 §16.4；交接 = 改归属不改状态） ═══════════════

test("T-16（§16.2 · §16.4）: applyTaskClaim 只改 owner/claimedFrom，status/evidence/createdBy 逐字不变", async () => {
  const ws = freshWs()
  try {
    // 夹具：一条「旧会话留在在做」的活 + 一条已完成（带凭据）的条目 —— 两条都要经得起 claim
    seedLedger(ws, [
      task("t-1", { status: "在做", owner: "s-old", createdBy: "s-old" }),
      task("t-2", { status: "完成", owner: "s-old", createdBy: "s-old", evidence: "跑了 12/12 绿", doneAt: "2026-10-17T01:00:00.000Z" }),
    ], 5)
    const before = readTasksView(ws).tasks

    // ① 阳性：接手 t-1（新会话 s-new）
    const r = applyTaskClaim(ws, { id: "t-1", sessionId: "s-new", expectedRev: 5 })
    assert.equal(r.ok, true, "合法接手必须放行：" + JSON.stringify(r))
    assert.equal(r.rev, 6, "接手是一次真实写 ⇒ rev+1（否则并发检测会失效）")
    assert.equal(r.owner, "s-new")
    assert.equal(r.claimedFrom, "s-old", "返回值必须回传旧 owner")

    const after = readTasksView(ws)
    const t1 = after.tasks.find((t) => t.id === "t-1")
    assert.equal(t1.owner, "s-new", "owner 必须改成接手方会话")
    assert.equal(t1.claimedFrom, "s-old", "claimedFrom 必须记下旧 owner")
    assert.equal(t1.createdBy, "s-old", "★ createdBy 是审计事实，**任何写路都不许改**")
    // ② 逐字不变：除 owner/claimedFrom 外的**每个字段**都必须与 claim 前完全相同
    const prev = before.find((t) => t.id === "t-1")
    const changedKeys = Object.keys(t1).filter((k) => JSON.stringify(t1[k]) !== JSON.stringify(prev[k])).sort()
    assert.deepEqual(changedKeys, ["claimedFrom", "owner"],
      "★ claim **只许动这两个字段**（实测动了：" + JSON.stringify(changedKeys) + "）")
    assert.equal(t1.status, "在做", "★ 接手**不改状态**（凭据门 / 五态 / rev 全不破）")
    assert.equal(t1.evidence, null, "接手**不得**写凭据（凭据只由完成迁移写）")
    // ③ 另一条（完成态）同样只改归属，evidence/doneAt 逐字不变
    assert.equal(applyTaskClaim(ws, { id: "t-2", sessionId: "s-new", expectedRev: after.rev }).ok, true)
    const t2 = readTasksView(ws).tasks.find((t) => t.id === "t-2")
    assert.equal(t2.owner, "s-new")
    assert.equal(t2.status, "完成", "完成态不会因接手而回退")
    assert.equal(t2.evidence, "跑了 12/12 绿", "evidence 逐字不变")
    assert.equal(t2.doneAt, "2026-10-17T01:00:00.000Z", "doneAt 逐字不变")

    // ④ 阴性（同一道门）：缺会话 id / 条目不存在 / 陈旧 rev ⇒ 拒且**零写入**
    const cur = readTasksView(ws).rev
    assertRejectCode(await withZeroWrite(ws, () => applyTaskClaim(ws, { id: "t-1", expectedRev: cur })), "owner-required")
    assertRejectCode(await withZeroWrite(ws, () => applyTaskClaim(ws, { id: "t-404", sessionId: "s-new", expectedRev: cur })), "id-missing")
    assertRejectCode(await withZeroWrite(ws, () => applyTaskClaim(ws, { id: "t-1", sessionId: "s-new", expectedRev: cur - 1 })), "rev-conflict")

    // ⑤ 归属只有 claim 一条路：改单 / 状态迁移**都不得**动 owner（含试图直接写）
    assertRejectCode(await withZeroWrite(ws, () => applyTaskUpdate(ws, { id: "t-1", patch: { owner: "s-evil" }, expectedRev: cur })), "field-not-updatable")
    assert.equal(applyTaskTransition(ws, { id: "t-1", to: "完成", evidence: "跑完了", expectedRev: cur }).ok, true)
    const t1b = readTasksView(ws).tasks.find((t) => t.id === "t-1")
    assert.equal(t1b.owner, "s-new", "状态迁移**不**改归属")
    assert.equal(t1b.createdBy, "s-old", "createdBy 依然不变")

    // ⑥ 三区的谓词与写门同源（`isOwnedBy` / `isClaimableBy`）
    assert.equal(isOwnedBy(t1b, "s-new"), true, "本会话视图认 owner")
    assert.equal(isClaimableBy(t1b, "s-other"), false, "**完成**的条目不可接手（待接手区 = 未完成）")
    assert.equal(isClaimableBy({ ...t1b, status: "在做" }, "s-other"), true, "未完成 + 别人的 ⇒ 可接手")
    assert.equal(isClaimableBy({ ...t1b, status: "在做" }, null), false, "无会话 id ⇒ 不可接手（按钮点不动的东西不许算作可接手）")
    assert.equal(ownerOf({}), null, "缺 owner 字段 ⇒ null（旧台账语义）")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：让 `applyTaskClaim` 顺手把 status 推成「已接手」（把 `{ ...cur, owner }` 改成
// `{ ...cur, owner, status: "已接手" }`）⇒ ② 的 `changedKeys` 会变成 ["claimedFrom","owner","status"]
// ⇒ deepEqual 当场红；让 claim 沿用 `applyTaskTransition` 的凭据门 ⇒ ③ 的完成态那条被 `evidence-required` 拒 ⇒ 红；
// 删掉 `owner-required` 分支（缺会话 id 时落 null）⇒ ④ 第一条红。

// ═══════════════ T-17：两会话互不淹没（三区）＋ 待接手的「接手」按钮 ═══════════════

test("T-17（§16.2 · US-12）: 两会话各看各的（本会话 / 待接手 / 全部）＋ 接手按钮走同一道门", async () => {
  const ws = freshWs()
  try {
    seedLedger(ws, [
      task("t-1", { status: "在做", owner: "s-A", createdBy: "s-A", title: "A 会话的活" }),
      task("t-2", { status: "在做", owner: "s-B", createdBy: "s-B", title: "B 会话的活" }),
      task("t-3", { status: "完成", owner: "s-B", createdBy: "s-B", title: "B 会话做完的", evidence: "跑过了" }),
      task("t-4", { status: "待办", title: "旧台账里无归属的一条" }),
      // ★ 「待接手区不判会话活性」的直接证据：这个 owner **从未存在过**（没有这个会话），
      //   它照样出现在待接手列表里 —— 说明判据只看归属，不看谁还活着。
      task("t-5", { status: "在做", owner: "s-ghost", createdBy: "s-ghost", title: "上辈子会话留下的活" }),
    ], 3)
    const ids = (rows) => rows.map((r) => r.id).sort()

    // ① 两个会话各拿一份载荷：本会话视图**只看到自己的**
    const a = buildTasksBoardPayload({ ws, sessionId: "s-A", config: {}, drift: null })
    const b = buildTasksBoardPayload({ ws, sessionId: "s-B", config: {}, drift: null })
    const rowsOf = (p, scope) => (p.views[scope].sections || []).flatMap((s) => s.tasks || [])
    assert.deepEqual(ids(rowsOf(a, "mine")), ["t-1"], "A 的本会话视图只看到 t-1")
    assert.deepEqual(ids(rowsOf(b, "mine")), ["t-2", "t-3"], "B 的本会话视图只看到自己的两条（含已完成）")
    // ② 待接手 = 未完成 ∧ owner ≠ 当前会话（完成的不算；无归属的算；**不存在的会话留下的也算**）
    assert.deepEqual(ids(rowsOf(a, "claimable")), ["t-2", "t-4", "t-5"], "A 的待接手：B 的 + 无归属的 + 幽灵会话的")
    assert.deepEqual(ids(rowsOf(b, "claimable")), ["t-1", "t-4", "t-5"], "B 的待接手：A 的 + 无归属的 + 幽灵会话的")
    assert.ok(ids(rowsOf(a, "all")).length === 5, "全部区 = 整本账（5 条）")
    assert.equal(a.defaultScope, "mine", "默认区 = 本会话")
    assert.deepEqual(a.scopes.map((s) => [s.key, s.count]), [["mine", 1], ["claimable", 3], ["all", 5]], "三区计数由 host 给")
    // ③ 待接手行**带 canClaim**；本会话行不带（按钮只在能落地的地方出现）
    assert.ok(rowsOf(a, "claimable").every((r) => r.canClaim === true), "待接手区每条都可接手")
    assert.ok(rowsOf(a, "mine").every((r) => r.canClaim === false), "本会话区不显示接手")
    assert.equal(buildTasksBoardPayload({ ws, sessionId: null, config: {}, drift: null }).defaultScope, "all",
      "无会话 id ⇒ 默认「全部」（否则永远是空看板）")

    // ④ 真实渲染面（`lib/client.js`）：默认显示本会话 → 点「待接手」切区 → 点「接手」调 `task_claim`
    const claimCalls = []
    const fetchImpl = (url, init) => {
      if (init && init.method === "POST") {
        const body = JSON.parse(init.body)
        claimCalls.push({ url: String(url), body })
        const r = buildTaskClaimResult({ ws, sessionId: body.sessionId, id: body.id, config: {}, drift: null })
        return Promise.resolve({ json: () => Promise.resolve(r) })
      }
      return Promise.resolve({ json: () => Promise.resolve(a) })
    }
    const r1 = await renderClientBoard(a, { fetchImpl, sessionId: "s-A" })
    assert.ok(r1.text.includes("A 会话的活"), "本会话区必须显示自己的活：\n" + r1.text)
    assert.ok(!r1.text.includes("B 会话的活"), "★ 别的会话的活**不得**出现在本会话区：\n" + r1.text)
    for (const label of ["本会话（1）", "待接手（3）", "全部（5）"]) {
      assert.ok(r1.text.includes(label), "三区切换按钮必须渲染「" + label + "」")
    }
    const r2 = await renderClientBoard(a, { fetchImpl, sessionId: "s-A", clicks: ["待接手（3）"] })
    assert.ok(r2.text.includes("B 会话的活"), "切到待接手后必须看到对方未完成的活：\n" + r2.text)
    assert.ok(r2.text.includes("接手"), "待接手区每条必须带「接手」按钮")
    assert.ok(!r2.text.includes("B 会话做完的"), "完成的条目不进待接手区")
    // 点「接手」⇒ 走 host 的 `/tasks/claim`（同一道写门），页面用**回来的新载荷**重渲染
    const r3 = await renderClientBoard(a, { fetchImpl, sessionId: "s-A", clicks: ["待接手（3）", "接手"] })
    assert.equal(claimCalls.length, 1, "点「接手」必须**真的**发出一次 claim 请求（实测 " + claimCalls.length + " 次）")
    assert.equal(claimCalls[0].url, "/thincoder-suite/api/tasks/claim", "请求必须打到看板写入口：" + claimCalls[0].url)
    assert.equal(claimCalls[0].body.sessionId, "s-A", "接手方 = 当前看板会话")
    assert.equal(claimCalls[0].body.id, "t-2", "接手的是被点的那一条")
    const claimed = readTasksView(ws).tasks.find((t) => t.id === "t-2")
    assert.equal(claimed.owner, "s-A", "★ 接手必须真的落盘（owner 改成当前会话）")
    assert.equal(claimed.claimedFrom, "s-B", "claimedFrom 记下旧 owner")
    assert.equal(claimed.status, "在做", "接手不改状态")
    assert.ok(r3.text.includes("待接手（2）"),
      "接手后必须用**回来的新载荷**重渲染（待接手从 3 掉到 2）：\n" + r3.text)
    assert.ok(!r3.text.includes("B 会话的活"), "已接手的 t-2 不再属于待接手区")

    // ⑤ 失败降级（如实，不假装成功）：写门拒绝 ⇒ 把等价命令交到用户手里，且**零写入**
    const shaBefore = tasksFileSha256(ws)
    const failing = (url, init) => {
      if (init && init.method === "POST") {
        return Promise.resolve({ json: () => Promise.resolve({ ok: false, code: "rev-conflict", text: "task_claim 拒写：账本已被其他会话改动" }) })
      }
      return Promise.resolve({ json: () => Promise.resolve(buildTasksBoardPayload({ ws, sessionId: "s-B", config: {}, drift: null })) })
    }
    const bNull = buildTasksBoardPayload({ ws, sessionId: "s-B", config: {}, drift: null })
    // 剪贴板缺席（`clipboard: null`）⇒ 走「可选中文本块」的降级面 ⇒ 断言才看得见那段话术
    const r4 = await renderClientBoard(bNull, { fetchImpl: failing, sessionId: "s-B", clipboard: null, clicks: ["待接手（4）", "接手"] })
    assert.ok(r4.text.includes("/task_claim t-1"), "失败时必须给出**等价命令**让用户自己走一遍：\n" + r4.text.slice(-400))
    assert.ok(r4.text.includes("账本已被其他会话改动"), "写门的拒绝原文必须原样送达（不吞、不改写）")
    assert.equal(tasksFileSha256(ws), shaBefore, "失败路径**零写入**")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：让三区筛选恒返回全部（`tasksInScope` 去掉 mine/claimable 分支）⇒ ① 的「只看到自己的」当场红；
// 把 `canClaim` 恒置 true ⇒ ③ 的「本会话区不显示接手」红；让看板的「接手」按钮改成只复制话术、
// 不发请求（删掉 claimTask 调用）⇒ ④ 的 claimCalls.length === 1 红；
// 让失败分支假装成功（照样 setState 成 payload）⇒ ⑤ 的「等价命令」与「拒绝原文」两条红。

// ═══════════════ T-18：旧台账向后兼容（无 owner ⇒ null，不抛、不迁移、不改写） ═══════════════

test("T-18（§16.1 向后兼容）: 无 owner/createdBy 的旧台账能读（=null）、不抛、不迁移、不改写；写后才补字段", () => {
  const ws = freshWs()
  try {
    // 旧的**原始**落盘形态（本批之前的 schema：没有归属三字段）
    const legacyText = JSON.stringify({
      version: 1,
      rev: 3,
      tasks: [{
        id: "t-1", kind: "work", title: "旧台账里的一条", status: "在做", check: "跑 X 看到 Y",
        evidence: null, blockedReason: null, blockedBy: null, priority: 0, why: null,
        createdAt: "2026-10-16T00:00:00.000Z", doneAt: null,
      }],
    }, null, 2) + "\n"
    seedRaw(ws, legacyText)
    const sha = tasksFileSha256(ws)

    // ① 读面：不抛、字段视 null、**不改写文件**（读是纯函数）
    let view = null
    assert.doesNotThrow(() => { view = readTasksView(ws) }, "旧台账**绝不许**让读面抛（T-18）")
    assert.equal(view.malformed, false, "缺归属字段**不是**畸形（旧台账是合法输入）")
    assert.equal(view.tasks.length, 1, "旧条目必须照常读出来")
    assert.equal(view.tasks[0].owner, null, "缺 owner ⇒ null（= 无归属）")
    assert.equal(view.tasks[0].createdBy, null, "缺 createdBy ⇒ null")
    assert.equal(view.tasks[0].claimedFrom, null, "缺 claimedFrom ⇒ null")
    assert.equal(tasksFileSha256(ws), sha, "★ 读面**不得改写文件**（不迁移、不回填）")
    // ② 三区判定对旧条目的行为（未完成 + owner=null ⇒ 不是任何人的 ⇒ 可被接手）
    assert.equal(isOwnedBy(view.tasks[0], "s-new"), false, "无归属的旧条目不属于任何会话")
    assert.equal(isClaimableBy(view.tasks[0], "s-new"), true, "无归属且未完成 ⇒ 出现在「待接手」")

    // ③ 旧条目**照常可写**（写门不是「见旧格式就拒」）：一次真实写成功后才补上归属字段
    const c = applyTaskCreate(ws, { kind: "work", title: "新会话建的一条", check: "建成就行", sessionId: "s-new", expectedRev: 3 })
    assert.equal(c.ok, true, "旧台账上建单必须放行：" + JSON.stringify(c))
    const after = readTasksView(ws)
    const legacy = after.tasks.find((t) => t.id === "t-1")
    const fresh = after.tasks.find((t) => t.id === c.id)
    assert.equal(legacy.owner, null, "★ 建单**不得**顺手把旧条目的归属改成当前会话（绝不自动改归属）")
    assert.equal(legacy.createdBy, null, "旧条目的 createdBy 也不许被编造")
    assert.equal(fresh.owner, "s-new", "新条目落在建单会话名下")
    assert.equal(fresh.createdBy, "s-new")

    // ④ 接手旧条目 ⇒ claimedFrom = null（旧 owner 真的是 null，不编造）
    const claim = applyTaskClaim(ws, { id: "t-1", sessionId: "s-new", expectedRev: after.rev })
    assert.equal(claim.ok, true, "旧条目必须能被接手：" + JSON.stringify(claim))
    const claimed = readTasksView(ws).tasks.find((t) => t.id === "t-1")
    assert.equal(claimed.owner, "s-new")
    assert.equal(claimed.claimedFrom, null, "旧 owner 是 null ⇒ claimedFrom 如实记 null（不编造一个假前任）")
    assert.equal(claimed.createdBy, null, "createdBy 仍是未知（审计事实不因接手而编造）")
    assert.equal(claimed.status, "在做", "接手不改状态")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：让 `normalizeTask` 在缺 owner 时抛（或把缺字段判成畸形）⇒ ① 的 doesNotThrow / malformed 断言红；
// 让读面「顺手回填」归属（parse 后写回文件）⇒ ① 的 sha256 断言红；
// 让 `applyTaskCreate` 把同账本里其它条目的 owner 改成当前会话 ⇒ ③ 的「不得顺手改归属」断言红。

// ═══════════════ 命令面夹具（T-19 / T-20 共用） ═══════════════

/**
 * 假宿主 ctx（**只**提供 `get` 与 `effect`）。
 * `effect` 按官方形态执行**生成器**生命周期：收集它 yield 出来的 disposer（teardown 与四个 register 返回值）。
 */
function fakeCommandCtx(hasService = true) {
  const calls = { registered: [], effects: [], yielded: [] }
  const commands = hasService
    ? { register: (def) => { calls.registered.push(def); return () => { /* disposer */ } } }
    : undefined
  const ctx = {
    get: (name) => (name === "commands" ? commands : undefined),
    effect: (fn, label) => {
      calls.effects.push(label)
      if (typeof fn !== "function") return () => {}
      const it = fn()
      let step = it.next()
      while (!step.done) {
        calls.yielded.push(step.value)
        step = it.next()
      }
      return () => {}
    },
  }
  return { ctx, calls }
}

// ═══════════════ T-19：命令面的降级与注册（缺服务不抛；有则四条全注册） ═══════════════

test("T-19（§16.3）: 缺 commands 服务 ⇒ 不抛/不注册/只 warn（工具与看板照常）；有则四条全注册（名字逐字）", async () => {
  // ① 缺服务：**不抛**、**不注册**、连 effect 都不碰（也就不会留下半条生命周期）
  const warnMsgs = []
  const none = fakeCommandCtx(false)
  let r1 = null
  assert.doesNotThrow(() => {
    r1 = registerTaskCommands(none.ctx, { wsOf: () => null, warn: (m) => warnMsgs.push(m) })
  }, "缺 commands 服务时**绝不许抛**（否则整个插件装配会断）")
  assert.deepEqual(r1.registered, [], "缺服务 ⇒ 一条都没注册")
  assert.equal(r1.skipped, true)
  assert.equal(none.calls.effects.length, 0, "缺服务 ⇒ 不登记生命周期（避免留下空 effect）")
  assert.equal(none.calls.registered.length, 0)
  assert.ok(warnMsgs.length === 1 && warnMsgs[0].includes("commands"), "必须**留痕**（warn 一条，不静默）：" + JSON.stringify(warnMsgs))

  // ② 工具与看板照常：命令面缺席**不影响**台账本体（工具照旧可用）
  const ws = freshWs()
  try {
    seedLedger(ws, [task("t-1", { owner: "s-1", createdBy: "s-1", title: "命令面缺席也照常" })], 0)
    const tools = makeTaskTools({ wsOf: () => ws, configOf: () => ({}), driftOf: () => null })
    const text = await tools.task_list.execute({}, { agent: { session: { id: "s-1" } } })
    assert.ok(text.includes("t-1"), "缺命令服务时 task_list 工具必须照常（命令是附属面）：" + text)

    // ③ 有服务 ⇒ 四条**全**注册（名字 / definitionId 逐字 / handler / description）
    const { ctx, calls } = fakeCommandCtx(true)
    const r2 = registerTaskCommands(ctx, { wsOf: () => ws })
    assert.equal(r2.skipped, false)
    assert.deepEqual(r2.registered, ["task_list", "task_add", "task_done", "task_claim"], "四条必须**全**注册（名字逐字）")
    assert.deepEqual(calls.registered.map((d) => d.name), [...TASK_COMMAND_NAMES], "注册出去的就是那四条")
    assert.equal(calls.registered.length, 4)
    // 官方契约：register({ definitionId, name, description, handler })
    for (const def of calls.registered) {
      assert.equal(def.definitionId, TASK_COMMAND_DEFINITION_PREFIX + def.name,
        "definitionId 必须是**纯字符串** `" + TASK_COMMAND_DEFINITION_PREFIX + "<name>`（不 import 宿主品牌类型）")
      assert.equal(typeof def.definitionId, "string", "definitionId 运行时就是字符串")
      assert.equal(typeof def.handler, "function", "每条命令必须带 handler")
      assert.ok(typeof def.description === "string" && def.description.trim() !== "", "每条命令必须有描述")
    }
    // 生命周期：官方形态 = 先 yield teardown（函数），再 yield 四个 register 的返回值
    assert.equal(calls.effects.length, 1, "恰登记一次生命周期（ctx.effect(label)）")
    assert.ok(String(calls.effects[0]).includes("thincoder-suite"), "生命周期要带可辨识的 label：" + calls.effects[0])
    assert.equal(calls.yielded.length, 5, "1 个 teardown + 4 个 disposer（实测 " + calls.yielded.length + "）")
    assert.equal(typeof calls.yielded[0], "function", "第一个 yield 必须是 teardown（官方 /compact 同款）")
    // ④ 铁律 1：宿主的 inject 数组**一字不扩**（commands 只能 ctx.get）
    const hostSrc = readFileSync(join(PLUGIN_DIR, "lib", "index.mjs"), "utf8")
    const m = /export const inject = \[([^\]]*)\]/.exec(hostSrc)
    assert.ok(m, "必须能定位宿主半边的 inject 数组（定位不到 ⇒ 本腿恒真空）")
    const names = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
    assert.deepEqual(names, ["tools", "systemPrompt", "webServer", "llm", "subagents"],
      "★ 宿主 inject 不得因命令面而新增条目（声明了但宿主没注册的服务 ⇒ 整个插件永不激活）：" + JSON.stringify(names))
    // 服务**只**经 ctx.get 取（不得出现 `ctx.commands` 属性读——那会因白名单当场抛）
    // ★ 扫描面 = **代码行**（剥掉 `//` 注释）：本档头注里**逐字引用**了官方 `/compact` 源码，
    //   那段引用里本来就有 `ctx.commands.register(...)` —— 那是文档，不是属性读。
    const cmdSrc = readFileSync(join(PLUGIN_DIR, "lib", "task-commands.mjs"), "utf8")
    const cmdCode = cmdSrc.replace(/^\s*\/\/.*$/gm, "")
    assert.ok(!/ctx\.commands\b/.test(cmdCode), "命令服务不得用属性读（cordis 白名单会当场抛）：只许 ctx.get")
    assert.ok(/ctx\.commands\b/.test('const it = ctx.commands.register(def)'), "自证：代码里的属性读必须能被同一谓词抓到")
    assert.ok(/ctx\?\.get\?\.\("commands"\)/.test(cmdCode), "必须能定位到 `ctx.get(\"commands\")` 这一行（语义锚点）")

    // ⑤ ★ 2026-10-17 **独立审计 Q6/Q8 补的腿**：本单新增的**写入通道**
    //    `POST /thincoder-suite/api/tasks/claim` —— 之前**零机检**（T-17 只断言了 URL 字符串，
    //    而 fetch 是 stub ⇒ 真路由与信任栅栏只靠"结构上应该对"）。这里用**源码级结构断言**钉住两条：
    //    (a) 该路由的注册位置**必须在信任栅栏之后**（否则未鉴权就能改归属）；
    //    (b) 它的回调里**不得直接写盘**（判定全在写门）—— 用「回调体内零 writeFile/commit 直调」取证。
    const fenceIdx = hostSrc.search(/connection\s*\.\s*requestRejection|requestRejection\s*\(/)
    assert.ok(fenceIdx > 0, "必须能定位到信任栅栏（定位不到 ⇒ 下面两条是真空断言）：" + fenceIdx)
    const claimRouteIdx = hostSrc.search(/["'][^"']*\/tasks\/claim["']/)
    assert.ok(claimRouteIdx > 0, "必须能定位到 POST /tasks/claim 路由注册（定位不到 ⇒ 本腿恒真空）")
    assert.ok(claimRouteIdx > fenceIdx,
      "★ /tasks/claim 必须注册在**信任栅栏之后**（fence@" + fenceIdx + " vs route@" + claimRouteIdx + "）"
      + " —— 否则未鉴权就能改归属")
    // (b) 回调体：从路由串到下一个 `}` 的粗切片里，不得出现直写（writeFileAtomic / commit( / fs 写）
    const slice = hostSrc.slice(claimRouteIdx, claimRouteIdx + 900)
    assert.ok(!/writeFileAtomic\s*\(/.test(slice), "claim 回调不得直接写盘（判定必须在写门里）：\n" + slice.slice(0, 400))
    assert.ok(!/\bcommit\s*\(/.test(slice), "claim 回调不得直调内部 commit（那就是绕过写门）：\n" + slice.slice(0, 400))
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：把缺服务分支改成 `throw`（或直接 `commands.register(...)` 不判空）⇒ ① 的 doesNotThrow 当场红；
// 把 `commands` 加进宿主 inject 数组 ⇒ ④ 的 deepEqual 红；只注册三条 ⇒ ② 的 registered deepEqual 红。

// ═══════════════ T-20：命令走**同一道写门**（无凭据 ⇒ 拒且零写入） ═══════════════

test("T-20（§16.3 · 铁律 4）: /task_done 无凭据 ⇒ 写门拒且零写入；命令层不自己判状态机", async () => {
  const ws = freshWs()
  try {
    seedLedger(ws, [task("t-1", { status: "在做", owner: "s-1", createdBy: "s-1", title: "命令要完成的活" })], 0)
    const { ctx, calls } = fakeCommandCtx(true)
    registerTaskCommands(ctx, { wsOf: () => ws, configOf: () => ({}), driftOf: () => null })
    const byName = new Map(calls.registered.map((d) => [d.name, d]))
    const agent = { session: { id: "s-1", header: { cwd: ws } } }
    const sha0 = tasksFileSha256(ws)

    // ★ 批 42 ⑨ **谓词逐字**（并入 T-20 命令块，不新开顶层用例）：commandArgsOf 只认首个捕获组
    //   逐字相等，**不再**有 startsWith("task_") 兜底。
    //   ① 名字匹配 ⇒ 仍正确剥出参数（回归；下面端到端的 ① 也依赖它）
    //   ② 名字**不匹配** ⇒ **不剥**（旧兜底会把 /task_add x 的 x 当成 /task_done 的参数 ⇒
    //      报出与用户输入无关的 id-missing，用户看不出是自己打错了命令）
    //   变异自证：把谓词改回 m[1] === name || m[1].startsWith("task_") ⇒ ② 红。
    assert.equal(commandArgsOf("task_done", "/task_done t-1"), "t-1", "① 名字匹配 ⇒ 必须剥出 t-1")
    assert.equal(commandArgsOf("task_done", "/task_add x"), "/task_add x",
      "② 名字不匹配 ⇒ **不剥**（原文整串交给写门去拒）")
    assert.equal(commandArgsOf("task_done", "t-1"), "t-1", "无命令名的裸参数 ⇒ 原样当参数")

    // ②-b（批 42 修复轮 ⑨ · **handler 层**断言；设计档 §八 T-20② 的例子就是走 handler，
    //   而不是只调谓词）：`rawInput: "/task_add x"` 交给 **task_done 的 handler** ⇒ 参数**保持原文**，
    //   写门按 id-missing 拒（回执里点名的是原文 `"/task_add x"`，不是被剥出来的 `x`）。
    //   第二例用**合法 id** 证明危害真实存在：`/task_add t-1 | <凭据>` 交给 task_done 的 handler
    //   ⇒ 新谓词保持原文 ⇒ id-missing 拒、t-1 仍「在做」；**旧兜底**会把 t-1 剥出来当 id，带凭据
    //   那次会**真的完成**它（kind=success / 状态前进 / sha 变化）⇒ 三条断言同时红。
    //   ★ 独立工作区夹具：不给主夹具加条目（本块后面按 `tasks[0]` 索引断言 t-1）。
    //   变异自证：把 handler 里的 `commandArgsOf("task_done", invocation?.rawInput)` 改成
    //   「自行剥命令名」/ 把谓词改回 startsWith 兜底 ⇒ 下面 kind / 原文 / t-1 仍「在做」/ 零写入必红；
    //   若 handler **完全不调用谓词**（直接透传 rawInput）⇒ 末尾**阳性对照**的 kind 红
    //   （匹配路径会把 "/task_done t-1" 整串当 id ⇒ id-missing）。
    const wsX = freshWs()
    try {
      seedLedger(wsX, [task("t-1", { status: "在做", owner: "s-1", createdBy: "s-1", title: "名字误配的自证夹具" })], 0)
      const { ctx: ctxX, calls: callsX } = fakeCommandCtx(true)
      registerTaskCommands(ctxX, { wsOf: () => wsX, configOf: () => ({}), driftOf: () => null })
      const doneX = new Map(callsX.registered.map((d) => [d.name, d]))
      const agentX = { session: { id: "s-1", header: { cwd: wsX } } }
      const shaBeforeWrongName = tasksFileSha256(wsX)
      const wrongName = await doneX.get("task_done").handler({ rawInput: "/task_add x", agent: agentX })
      assert.equal(wrongName.kind, "error", "名字不匹配 ⇒ 必须被写门拒：" + JSON.stringify(wrongName))
      assert.ok(wrongName.text.includes('"/task_add x"'),
        "②（handler 层）参数必须保持**原文**（旧兜底把 x 剥出来当 id，回执里就不会有这段原文）：" + wrongName.text)
      const wrongNameWithEvidence = await doneX.get("task_done").handler({ rawInput: "/task_add t-1 | 跑了 node --test：12/12 绿", agent: agentX })
      assert.equal(wrongNameWithEvidence.kind, "error",
        "名字不匹配 + 带凭据 ⇒ 仍必须拒（旧兜底会拿 t-1 当 id 而真的完成它）：" + JSON.stringify(wrongNameWithEvidence))
      assert.equal(readTasksView(wsX).tasks[0].status, "在做",
        "名字误配**不得**推进 t-1 的状态（旧兜底会把它完成）")
      assert.equal(tasksFileSha256(wsX), shaBeforeWrongName, "名字误配的两次调用都必须零写入")
      // 阳性对照（防「凡调用必拒」的假绿；同时锁住「handler 必须真的调用谓词」）：
      //   **匹配**路径仍要剥出 t-1 并放行 ⇒ 若 handler 完全不解析、直接透传 rawInput，
      //   id 会变成 "/task_done t-1" ⇒ id-missing ⇒ 本条的 kind / 状态断言红。
      const matched = await doneX.get("task_done").handler({ rawInput: "/task_done t-1 | 跑了 node --test：12/12 绿", agent: agentX })
      assert.equal(matched.kind, "success", "匹配路径必须照常放行（防恒拒假绿）：" + JSON.stringify(matched))
      assert.equal(readTasksView(wsX).tasks[0].status, "完成", "匹配路径必须真的完成 t-1")
    } finally {
      rmSync(wsX, { recursive: true, force: true })
    }

    // ① 无凭据 ⇒ **写门**拒（拒绝码 `evidence-required` 只有写门会产出 ⇒ 命令层确实把判定交出去了）
    const bad = await byName.get("task_done").handler({ rawInput: "/task_done t-1", agent })
    assert.equal(bad.kind, "error", "无凭据的完成必须失败：" + JSON.stringify(bad))
    assert.ok(bad.text.includes("evidence-required"), "拒绝码必须是**写门**的（命令层不得自己判）：" + bad.text)
    assert.ok(bad.text.includes("没有写入任何内容"), "回执必须说清零写入：" + bad.text)
    assert.equal(tasksFileSha256(ws), sha0, "**拒绝路径零写入**（文件 sha256 前后相同）")
    assert.equal(readTasksView(ws).tasks[0].status, "在做", "被拒后状态不得前进")

    // ② 带凭据 ⇒ 同一条路放行（阳性对照，防「凡命令必拒」的假绿）
    const g = await byName.get("task_done").handler({ rawInput: "/task_done t-1 | 跑了 node --test：12/12 绿", agent })
    assert.equal(g.kind, "success", "带凭据必须放行：" + JSON.stringify(g))
    const done = readTasksView(ws).tasks[0]
    assert.equal(done.status, "完成")
    assert.ok(done.evidence.includes("12/12"), "凭据必须落盘")

    // ③ 非法迁移同样由写门拒（命令层没有第二份状态机）
    const ill = await byName.get("task_done").handler({ rawInput: "/task_done t-1 | 再跑一次", agent })
    assert.equal(ill.kind, "error")
    assert.ok(ill.text.includes("illegal-migration"), "完成 → 完成 必须由迁移表拒：" + ill.text)

    // ④ `/task_add` 的 `|` 缺失 ⇒ 命令层只做**参数形态**提示（不写盘）
    const sha1 = tasksFileSha256(ws)
    const noPipe = await byName.get("task_add").handler({ rawInput: "/task_add 只有标题没有判据", agent })
    assert.equal(noPipe.kind, "error")
    assert.ok(noPipe.text.includes("怎么算完成"), "用法提示必须讲清「怎么算完成」：" + noPipe.text)
    assert.equal(tasksFileSha256(ws), sha1, "参数不合法 ⇒ 零写入")
    // 合法形态 ⇒ 与工具面同一个建单门（含归属）
    const created = await byName.get("task_add").handler({ rawInput: "/task_add 命令建的单 | 跑 node --test", agent })
    assert.equal(created.kind, "success", JSON.stringify(created))
    const fresh = readTasksView(ws).tasks.find((t) => t.title === "命令建的单")
    assert.ok(fresh, "命令建的条目必须真的落盘")
    assert.equal(fresh.owner, "s-1", "命令建单同样落归属（建单会话 = owner）")
    assert.equal(fresh.createdBy, "s-1")

    // ⑤ `/task_claim` 也走同一道门（只改 owner，不改状态）
    const claim = await byName.get("task_claim").handler({ rawInput: "/task_claim t-1", agent: { session: { id: "s-2", header: { cwd: ws } } } })
    assert.equal(claim.kind, "success", JSON.stringify(claim))
    const claimed = readTasksView(ws).tasks.find((t) => t.id === "t-1")
    assert.equal(claimed.owner, "s-2", "命令接手必须真的改归属")
    assert.equal(claimed.claimedFrom, "s-1")
    assert.equal(claimed.status, "完成", "接手不改状态（连完成态也不回退）")

    // ⑥ `/task_list` 只读：输出含三区，且**零写入**
    const sha2 = tasksFileSha256(ws)
    const listed = await byName.get("task_list").handler({ rawInput: "/task_list", agent })
    assert.equal(listed.kind, "success")
    assert.ok(listed.text.includes("本会话") && listed.text.includes("待接手"), "看板回执必须带三区：" + listed.text.slice(0, 200))
    assert.equal(tasksFileSha256(ws), sha2, "只读命令**零写入**")
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
// 变异自证：在 `/task_done` 的 handler 里自己先判 `evidence === ""` 并直接返回 error ⇒ ① 的
// `evidence-required` 断言红（拒绝码变成命令层自造的，写门的凭据门被绕过）；让命令层直接写盘
// （绕过 applyTaskTransition）⇒ ① 的 sha256 与状态两条同时红。

// ═══════════════ 腿部收口（21 条 = T-1…T-20 整 20 条 + T-4 拆 a/b 多出 1 条 = 21；**T-19 未拆**；批 43 的 T-4c/T-4d/T-4e/T-4f 并入 T-4b/T-5，批 44 的 T-9d/T-9e/T-9h/T-9f/T-9g 并入 T-9，均不新增顶层 `test(`） ═══════════════
