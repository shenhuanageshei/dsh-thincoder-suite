// write-atomic.test.mjs — 批 20：writeFileAtomic / renameSyncWithRetry 的重试与失败可见性单元测试
// （docs/2026-09-17-writefileatomic-design.md §8.2 锚 A6…A11 · §10.4 stage 2）。
// 覆盖：A6 rename 缝前 k 次 EPERM ⇒ 落地 + 零 tmp 残留 · A6b ENOENT（tmp 被外部清走）⇒ onEnoent
// 重铸自愈 / 回调自身抛错 ⇒ 原对象直抛（D20-3 / §5.1b#4）· A7 持续 EPERM ⇒ 重抛原对象 + code
// 保留 + 耗尽遥测（D20-6）+ 目标未生成（不假成功）· A8 非白名单（ENOSPC / ENOTDIR / 无 code）⇒
// 单次快失败、无环内 sleep（D20-3 fail-closed）· A9 首写失败 ⇒ 零 tmp 残留 + 抛（修 P-4「留半个
// tmp」）· A10 孤儿清扫：龄 >10min 的 .tmp-/.del- 被扫、刚建的 tmp 与异前缀幸存（D20-10）·
// A11 clearUserConfig 幂等（缺失 = 已清空；TOCTOU 腿依赖原语 ENOENT 原样上抛）（D20-9）·
// A11b TOCTOU 真腿（N7 修复轮 · 审计🟡6：前置检查后、rename 前删走活文件 ⇒ catch 幂等分支被真覆盖）·
// A2 源码级锁（N7 修复轮 · 审计🟡7：clearUserConfig 函数体走 renameSyncWithRetry，不退化为裸 renameSync）·
// M1 阴性对照：常态写一次成功、零环内 sleep（重试不付常态路径代价）· A1 导出常量值锁。
// 失败注入全部走 opts 缝（delays / maxAttempts / write / onEnoent / rename——§5.1/§5.1c），
// 零 mock.module、零 test.skip、零真机持锁（「另一进程持有句柄」面 = §9.4 残差 #10，不进套件）。
// 隔离：process.env.DSH_HOME 置空（既有档同款契约）+ 每用例仓外 mkdtemp 临时目录，
// try/finally 全清（零残留）。负控 N2/N3（RENAME_MAX_ATTEMPTS 改 1 / ENOSPC 加进白名单 ⇒
// 各自真红）为会话期仓外副本上的变异验证，不落仓内——原始输出见交付报告。
import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
  unlinkSync, utimesSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import {
  renameSyncWithRetry, writeFileAtomic, RENAME_MAX_ATTEMPTS, RENAME_BACKOFF_MS,
} from "../lib/dsh-home.mjs"
import { clearUserConfig } from "../lib/config-store.mjs"

// 隔离契约（对齐既有测试档）：空串 = 显式无 env → 本档全部用例走显式路径 / override 临时目录。
process.env.DSH_HOME = ""

const mkDir = () => mkdtempSync(join(tmpdir(), "thincoder-b20-"))
const rmDir = (d) => { try { rmSync(d, { recursive: true, force: true }) } catch { /* 已清理 */ } }
/** 构造带 code 的注入错误（rename/write 缝的失败注入；errno 仅遥测断言用例需要）。 */
const fsErr = (code, msg) => { const e = new Error(msg ?? code + " (injected)"); e.code = code; return e }

test("A1 (常量值锁): RENAME_MAX_ATTEMPTS=8 · RENAME_BACKOFF_MS=30（D20-2 探针包络）", () => {
  assert.equal(RENAME_MAX_ATTEMPTS, 8, "8 次（锁中途释放实测第 6 次成功 + 余量）")
  assert.equal(RENAME_BACKOFF_MS, 30, "平铺 30ms（否决未实测的爬升曲线）")
})

test("M1 (阴性对照): 无注入常态写 ⇒ 一次成功、零环内 sleep、零 tmp 残留", () => {
  const dir = mkDir()
  try {
    const target = join(dir, "state.json")
    const t0 = Date.now()
    writeFileAtomic(target, "plain\n", { delays: [500, 500, 500] }) // delays=500 ⇒ 若发生环内 sleep，耗时必超 500ms
    assert.equal(readFileSync(target, "utf8"), "plain\n", "内容落地")
    assert.ok(Date.now() - t0 < 500, "无失败 ⇒ 零 sleep（重试不付常态路径代价）")
    assert.deepEqual(readdirSync(dir), ["state.json"], "零 tmp 残留（缺省 rename = renameSync，行为逐字等价）")
  } finally { rmDir(dir) }
})

test("A6 (AC-1): rename 缝前 2 次 EPERM 后放开 ⇒ 第 3 次落地 + 零 tmp 残留", () => {
  const dir = mkDir()
  try {
    const target = join(dir, "state.json")
    let calls = 0
    writeFileAtomic(target, "payload\n", {
      delays: [1, 1, 1],
      rename: (from, to) => { if (calls++ < 2) throw fsErr("EPERM"); renameSync(from, to) },
    })
    assert.equal(calls, 3, "前 2 次 EPERM 后放开 ⇒ 恰 3 次调用后落地（父侧实测值）")
    assert.equal(readFileSync(target, "utf8"), "payload\n", "内容落地")
    assert.deepEqual(readdirSync(dir), ["state.json"], "零 tmp 残留（成功路径 tmp 被 rename 消费）")
  } finally { rmDir(dir) }
})

test("A6b (D20-3/§5.1b#4): ENOENT（tmp 被外部清走）⇒ 重铸自愈；onEnoent 自身抛错 ⇒ 原对象直抛", () => {
  const dir = mkDir()
  const dir2 = mkDir()
  try {
    // ① 重铸自愈：rename 缝第 1 次删掉 tmp 并抛 ENOENT（模拟外部清走），第 2 次真改名
    const target = join(dir, "state.json")
    let calls = 0
    writeFileAtomic(target, "recast\n", {
      delays: [1, 1, 1],
      rename: (from, to) => {
        if (calls++ === 0) { unlinkSync(from); throw fsErr("ENOENT") }
        renameSync(from, to)
      },
    })
    assert.equal(calls, 2, "ENOENT ⇒ onEnoent 重铸 tmp（writeFileAtomic 传「重写 tmp」回调）后第 2 次落地")
    assert.equal(readFileSync(target, "utf8"), "recast\n", "内容落地")
    assert.deepEqual(readdirSync(dir), ["state.json"], "零 tmp 残留")

    // ② 回调自身抛错 ⇒ fail-closed：次生错误被吞，原错误对象直抛（保 .code）
    const from = join(dir2, ".state.json.tmp-9-9")
    const to = join(dir2, "state.json")
    writeFileSync(from, "live")
    const enoent = fsErr("ENOENT")
    let thrown = null
    try {
      renameSyncWithRetry(from, to, {
        delays: [1, 1, 1],
        rename: () => { throw enoent },
        onEnoent: () => { throw new Error("recast hook boom") },
      })
    } catch (e) { thrown = e }
    assert.ok(thrown === enoent, "回调次生错误被吞 ⇒ 原错误对象上抛（保 .code）")
    assert.ok(!thrown.message.includes("rename-retry-exhausted"), "立即抛（非耗尽）⇒ 无遥测拼接")
    assert.equal(existsSync(from), true, "无 write 钩子 ⇒ from 原样保留（clearUserConfig 活文件语义）")
  } finally { rmDir(dir); rmDir(dir2) }
})

test("A7 (AC-2/AC-5): 持续 EPERM（maxAttempts:4）⇒ 重抛原对象 + code 保留 + 遥测在场 + 目标未生成", () => {
  const dir = mkDir()
  try {
    const target = join(dir, "state.json")
    const boom = fsErr("EPERM")
    boom.errno = -4048 // Windows EPERM 的 errno 形态（遥测按 String 落 message）
    let calls = 0
    let thrown = null
    try {
      writeFileAtomic(target, "x\n", {
        maxAttempts: 4,
        delays: [1, 1, 1],
        rename: () => { calls++; throw boom },
      })
    } catch (e) { thrown = e }
    assert.ok(thrown === boom, "耗尽 ⇒ 重抛原对象（同一引用，非 wrap——调用方依赖 .code）")
    assert.equal(thrown.code, "EPERM", "code 保留")
    assert.equal(calls, 4, "预算 4 ⇒ 恰 4 次调用")
    assert.match(thrown.message,
      /\[thincoder-suite\] rename-retry-exhausted code=EPERM errno=-4048 attempts=4 elapsedMs=\d+/,
      "遥测齐备：code/errno/次数/耗时 + 可 grep 签名（D20-6 / N-12 同值）")
    assert.equal(existsSync(target), false, "不假成功：目标未生成")
    assert.deepEqual(readdirSync(dir), [], "零 tmp 残留（每次失败 best-effort unlink）")

    // §9.1 空集：预算 0（注入缝）⇒ 立即抛普通 Error（无原错误对象可重抛 ⇒ 无耗尽遥测拼接）
    let zeroErr = null
    try { renameSyncWithRetry(join(dir, "a"), join(dir, "b"), { maxAttempts: 0 }) } catch (e) { zeroErr = e }
    assert.ok(zeroErr instanceof Error, "maxAttempts=0 ⇒ 立即抛")
    assert.match(zeroErr.message, /maxAttempts=0/, "零预算的失败签名")
    assert.ok(!zeroErr.message.includes("rename-retry-exhausted"), "非耗尽路径 ⇒ 无耗尽遥测")
  } finally { rmDir(dir) }
})

test("A8 (AC-3): 非白名单（ENOSPC / 无 code / ENOTDIR）⇒ 单次快失败（无环内 sleep）", () => {
  const dir = mkDir()
  try {
    const cases = [
      { name: "ENOSPC（非白名单）", mk: () => fsErr("ENOSPC"), wantCode: "ENOSPC" },
      { name: "e.code 缺失（非 fs 错误 ⇒ fail-closed）", mk: () => new Error("plain boom"), wantCode: undefined },
    ]
    for (const c of cases) {
      const sub = mkdtempSync(join(dir, "a8-"))
      const target = join(sub, "state.json")
      let calls = 0
      const t0 = Date.now()
      let thrown = null
      try {
        writeFileAtomic(target, "x\n", {
          delays: [500, 500, 500], // 若走重试必先 sleep 500ms ⇒ 耗时断言必红
          rename: () => { calls++; throw c.mk() },
        })
      } catch (e) { thrown = e }
      assert.equal(calls, 1, c.name + " ⇒ 单次调用（不重试）")
      assert.ok(Date.now() - t0 < 500, c.name + " ⇒ 无环内 sleep")
      assert.equal(thrown && thrown.code, c.wantCode, c.name + " ⇒ code 原样")
      assert.ok(!thrown.message.includes("rename-retry-exhausted"), c.name + " ⇒ 立即抛（非耗尽）无遥测")
      assert.deepEqual(readdirSync(sub), [], c.name + " ⇒ 零 tmp 残留 + 目标未生成")
    }
    // ENOTDIR 直测（原语层；F12-T5 badHome 契约的同源错误类）
    const enotdir = fsErr("ENOTDIR")
    assert.throws(
      () => renameSyncWithRetry(join(dir, "from"), join(dir, "to"), { rename: () => { throw enotdir } }),
      (e) => e === enotdir,
      "ENOTDIR ⇒ 原对象直抛（不重试、不 wrap）",
    )
  } finally { rmDir(dir) }
})

test("A9 (AC-4): 首写失败 ⇒ 零 tmp 残留 + 抛（部分写入也被 best-effort unlink 清掉）", () => {
  const dir = mkDir()
  try {
    // ① 原语层：write 钩子部分写入后抛（改前该形态必留半个 tmp——A9 的「改前红」面）
    const sub1 = mkdtempSync(join(dir, "a9-"))
    const from = join(sub1, ".state.json.tmp-1-1")
    const to = join(sub1, "state.json")
    const writeBoom = fsErr("ENOSPC", "simulated partial write failure")
    let thrown1 = null
    try {
      renameSyncWithRetry(from, to, {
        delays: [1, 1, 1],
        write: () => { writeFileSync(from, "partial-"); throw writeBoom },
      })
    } catch (e) { thrown1 = e }
    assert.ok(thrown1 === writeBoom, "写失败原样上抛（ENOSPC 非白名单 ⇒ 不重试）")
    assert.equal(existsSync(from), false, "半个 tmp 被清（P-4：写步骤失败也在环内 try ⇒ unlink 兜底）")
    assert.equal(existsSync(to), false, "目标未生成")
    assert.deepEqual(readdirSync(sub1), [], "目录零残留")

    // ①b 写步骤白名单失败：与 rename 同入环内 try ⇒ 同一预算耗尽（D20-5）+ 遥测
    const sub1b = mkdtempSync(join(dir, "a9b-"))
    const werr = fsErr("EPERM")
    werr.errno = -4048
    let wcalls = 0
    let thrownB = null
    try {
      renameSyncWithRetry(join(sub1b, ".s.tmp-2-2"), join(sub1b, "s.json"), {
        maxAttempts: 3,
        delays: [1, 1, 1],
        write: () => { wcalls++; throw werr },
      })
    } catch (e) { thrownB = e }
    assert.equal(wcalls, 3, "写失败消耗同一预算（写与 rename 同入环内 try——D20-5）")
    assert.match(thrownB.message, /rename-retry-exhausted code=EPERM errno=-4048 attempts=3/, "耗尽遥测在场")
    assert.deepEqual(readdirSync(sub1b), [], "零残留")

    // ② 端到端：writeFileAtomic 的写步骤真抛（ERR_INVALID_ARG_TYPE：非 fs 白名单）⇒ 零残留 + 抛
    const sub2 = mkdtempSync(join(dir, "a9c-"))
    const target = join(sub2, "state.json")
    let thrown2 = null
    try { writeFileAtomic(target, {}) } catch (e) { thrown2 = e }
    assert.ok(thrown2 instanceof Error, "端到端写失败向上抛（code=" + (thrown2 && thrown2.code) + "）")
    assert.deepEqual(readdirSync(sub2), [], "零 tmp 残留（写步骤失败在环内 try ⇒ unlink 兜底）")
  } finally { rmDir(dir) }
})

test("A10 (AC-6): 孤儿清扫——龄 >10min 的 .tmp-/.del- 被扫；刚建的与异前缀幸存（阴性对照）", () => {
  const dir = mkDir()
  try {
    const target = join(dir, "state.json")
    const oldMs = Date.now() - 11 * 60 * 1000
    const oldTmp = join(dir, ".state.json.tmp-111-1")
    const oldDel = join(dir, ".state.json.del-111-1")
    const freshTmp = join(dir, ".state.json.tmp-222-2")
    const otherBase = join(dir, ".other.json.tmp-333-3") // 同目录但异基名前缀 ⇒ 不在清扫面
    for (const p of [oldTmp, oldDel, freshTmp, otherBase]) writeFileSync(p, "orphan")
    // freshTmp 的 mtime 保持「刚建」；Date 对象走毫秒精度（裸数字会被当 epoch 秒 ⇒ Windows filetime 越界 EINVAL）
    for (const p of [oldTmp, oldDel, otherBase]) utimesSync(p, new Date(oldMs), new Date(oldMs))
    writeFileAtomic(target, "data\n")
    assert.equal(existsSync(oldTmp), false, "龄 >10min 的旧 .tmp- 被扫（P-6 有界兜底）")
    assert.equal(existsSync(oldDel), false, "龄 >10min 的旧 .del- 被扫（clear 崩在 rename→rm 之间的残留）")
    assert.equal(existsSync(freshTmp), true, "刚建的 tmp 幸存（阈值把误杀面降到零——阴性对照）")
    assert.equal(existsSync(otherBase), true, "异基名前缀不扫（清扫面 = 同目录 + 同前缀）")
    assert.deepEqual(readdirSync(dir).sort(),
      [".other.json.tmp-333-3", ".state.json.tmp-222-2", "state.json"],
      "清扫面恰为同目录 + 同前缀（.<base>.tmp- / .<base>.del-）+ 龄 ≥ 10min")
  } finally { rmDir(dir) }
})

test("A11 (AC-7): clearUserConfig 幂等——目标缺失 ⇒ true；TOCTOU 腿的原语面 ENOENT 原样上抛；活文件清掉零残留", () => {
  const home = mkDir()
  try {
    // ① 目标已删（缺失）⇒ 判「已清空」返回 true
    assert.equal(clearUserConfig(home), true, "缺失 = 已清空（D20-9 幂等）")
    // ② happy path：活文件被原子清掉（rename → .del- → rm），零 .del- 残留
    mkdirSync(join(home, ".thincoder"), { recursive: true })
    const cfg = join(home, ".thincoder", "config.json")
    writeFileSync(cfg, JSON.stringify({ version: 1, config: {} }))
    assert.equal(clearUserConfig(home), true, "清除成功 ⇒ true")
    assert.equal(existsSync(cfg), false, "user 层文件已删")
    assert.deepEqual(readdirSync(join(home, ".thincoder")), [], "零 .del- 残留（rmSync force 收尾）")
    // ③ TOCTOU 腿的原语面：无 onEnoent ⇒ ENOENT 原样上抛（clearUserConfig 的 catch 据此判「已清空」；
    //    existsSync→rename 之间的真竞态窗口无法在单进程内确定性构造——见交付报告自白 ①）
    const sub = mkdtempSync(join(home, "a11-"))
    const enoent = fsErr("ENOENT")
    let thrown = null
    try { renameSyncWithRetry(join(sub, "gone"), join(sub, "to"), { rename: () => { throw enoent } }) } catch (e) { thrown = e }
    assert.ok(thrown === enoent, "ENOENT 不在主白名单且无回调 ⇒ 原对象直抛（不重试）")
    assert.ok(!thrown.message.includes("rename-retry-exhausted"), "立即抛（非耗尽）⇒ 无遥测拼接")
  } finally { rmDir(home) }
})

test("A11b (N7 修复轮 · AC-7): TOCTOU 真腿——前置检查后、rename 前活文件被删走 ⇒ catch 幂等分支返回 true", () => {
  const home = mkDir()
  try {
    mkdirSync(join(home, ".thincoder"), { recursive: true })
    const cfg = join(home, ".thincoder", "config.json")
    writeFileSync(cfg, JSON.stringify({ version: 1, config: {} }))
    // 手法（确定性，非竞态；自白①）：clearUserConfig 零 opts 调原语（opts.rename 注入缝够不到），
    // 而 node:fs 的具名导入是链接期快照（仓外探针实测：patch 默认导出对象不生效）⇒ 唯一确定性缝
    // = delPath 计算处的 Date.now()——它恰在 existsSync 前置检查与 renameSyncWithRetry 之间，即
    // TOCTOU 窗口本身。定向 patch：首次调用（即窗口内）删走活文件、恒返回定值 ⇒ rename 对真缺失
    // 的源抛真 ENOENT（A11 ③ 已锁原语直抛面）⇒ catch 的 TOCTOU 分支被真实进入。
    const origNow = Date.now
    let deleted = false
    Date.now = () => { if (!deleted) { deleted = true; unlinkSync(cfg) } return 9 }
    try {
      assert.equal(clearUserConfig(home), true,
        "TOCTOU：existsSync 见「在」而 rename 时已被删走 ⇒ ENOENT ⇒ 判「已清空」返回 true（D20-9 幂等）"
          + "——前置 existsSync 对活文件为真 ⇒ 本 true 只能出自 catch 的 ENOENT 分支（非前置早返回）")
      assert.equal(deleted, true, "窗口内删除确实发生（Date.now 缝被走到 ⇒ 非前置早返回的旁证）")
    } finally {
      Date.now = origNow
    }
    assert.ok(Date.now === origNow, "Date.now 补丁已还原（零泄漏）")
  } finally { rmDir(home) }
})

test("A2 源码级锁 (N7 修复轮 · AC-7): clearUserConfig 函数体调 renameSyncWithRetry，不退化为裸 renameSync", () => {
  // 先例形态（test/config-api.test.mjs 的 U3c2：从源码字节解析并断言）：「两个消费者共用原语」是
  // 纯静态事实（审计实测：换成正确 import 的裸 renameSync ⇒ 全套件 0 红）⇒ 唯一锁得住它的面是
  // 源码文本本身。EOL 归一（config-store.mjs 为 CRLF——散文面解析先例的既知陷阱）。
  const src = readFileSync(new URL("../lib/config-store.mjs", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
  const i0 = src.indexOf("export function clearUserConfig(")
  assert.ok(i0 >= 0, "clearUserConfig 定义不可定位（形态变了 ⇒ 本锁必须随之复核）")
  const i1 = src.indexOf("\n}\n", i0) // 列 0 的收口大括号 = 函数体边界（体内收口皆缩进）
  assert.ok(i1 > i0, "clearUserConfig 函数体边界不可定位")
  const body = src.slice(i0, i1)
  assert.ok(body.includes("existsSync("), "切片自证：确为 clearUserConfig 本体（含前置存在性检查，防恒真空切片）")
  assert.ok(body.includes("renameSyncWithRetry("),
    "rename 必须走 renameSyncWithRetry（A2/D20-9：与 writeFileAtomic 共用同一重试原语）")
  // 口径（自白①）：先把 renameSyncWithRetry 整体替换为占位符、再以词边界查裸调用（容忍函数名与
  // 括号间的空白）——排除「renameSyncWithRetry(」与「renameSync(」的前缀口径歧义。
  const deRetry = body.replaceAll("renameSyncWithRetry", "RR")
  assert.ok(!/\brenameSync\s*\(/.test(deRetry),
    "clearUserConfig 不得退化为裸 renameSync（丢了白名单重试原语 ⇒ A2 静态锚失守）")
})
