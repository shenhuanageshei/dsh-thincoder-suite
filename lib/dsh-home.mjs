// dsh-home.mjs — DSH_HOME 路径解析 + 原子写公共 helper（F12，docs/2026-09-02-session-state-stages-design.md §2.2）。
// 抽取自 token-store.mjs / config-store.mjs 的两份重复实现（评审 #2 引导「第三份前抽公共模块」），
// 行为零变化（既有 token/config fixture 测试全绿为证）；新增 writeFileAtomic 供三个 store 共用
// （评审 #4：多会话单文件直写 = 崩半写丢全部状态——tmp+rename 原子替换对齐 config-store 既有惯例，
// token-store 顺带从直写升级为原子写：其现状直写是 1h TTL 损失=重评审可接受的历史选择，统一后无损失）。
// 批 20（docs/2026-09-17-writefileatomic-design.md）：writeFileAtomic 的 rename 升级为白名单错误有界
// 重试（抽 renameSyncWithRetry 原语，单一事实源——config-store.clearUserConfig 同用）+ 耗尽遥测
// message + 成功后孤儿清扫；失败仍向上抛（store 侧 warn + return false 契约零变更）。
// 纯 node:fs/path，零新增依赖。
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"

/**
 * DSH_HOME 解析（原 token-store/config-store 各一份的同名实现，单一化）：
 * 优先 dshHomeOverride（测试注入缝，语义 = DSH_HOME 目录），其次 process.env.DSH_HOME
 * （宿主 web profile 进程实证可见），最后从 cwdHint/process.cwd() 向上探测 profile 根兜底，
 * env **完全缺失**时再探测 DSH 标准 home ~/.dsh（2026-09-07 本地实证：desktop 构建插件进程
 * 无 DSH_HOME 且 cwd 与真实 home 无祖先关系；显式置空 = 测试隔离契约，不加该兜底）。
 * 无可用 home → null（调用方各自 fail-safe：save 仅 warn，load 视为无记录）。
 * @param {string} [dshHomeOverride]
 * @param {string} [cwdHint] — 探测起点的会话 cwd（宿主进程 cwd 与会话 cwd 可能不一致）
 * @returns {string|null} DSH_HOME 目录
 */
export function pickDshHome(dshHomeOverride, cwdHint) {
  if (typeof dshHomeOverride === "string" && dshHomeOverride.trim() !== "") {
    return dshHomeOverride.trim()
  }
  const start = typeof cwdHint === "string" && cwdHint.trim() !== "" ? cwdHint.trim() : process.cwd()
  if ("DSH_HOME" in process.env) {
    const envVal = process.env.DSH_HOME
    if (typeof envVal === "string" && envVal.trim() !== "") return envVal.trim()
    // 显式置空（测试隔离契约，2026-09-07 实证）：保持既有语义——走 cwd 探测，不加 ~/.dsh 兜底
    return probeProfileRoot(start)
  }
  const viaProbe = probeProfileRoot(start)
  if (viaProbe) return viaProbe
  // env 完全缺失（生产实证 2026-09-07：desktop app 进程无 DSH_HOME，且其 cwd——应用目录——
  // 与真实 home 无祖先关系）→ 设置页保存 user 配置失败（"config store path not resolvable"）。
  // 兜底：探测 DSH 标准 home ~/.dsh（含 sessions/ 且含 settings.yaml **或其 0.1.7 改名后的
  // settings.yaml.imported** 即视为 profile 根，与 token-store 特征一致；portable/有 env 的部署
  // 不受影响，仍走 override/env/cwd 优先路径）。
  return probeProfileRoot(join(homedir(), ".dsh"))
}

/**
 * profile 根特征 = 目录同时含 sessions/ 与 settings.yaml **或 settings.yaml.imported**
 * （设计 §5 确认项 1 的兜底探测，原 token-store/config-store 同名实现单一化）。
 * 0.1.7 起宿主会把 settings.yaml 改名为 settings.yaml.imported（2026-09-25 本机便携版与
 * 桌面版两处 home 实测），只认旧名会让本兜底永不命中 ⇒ 无 DSH_HOME 的部署（桌面版 app 进程）
 * 拿不到 home ⇒ saveUserConfig 返回 false ⇒ 设置页报 500 "failed to write user config"。
 * 向上走到根仍未命中 → null。
 */
export function probeProfileRoot(startDir) {
  let dir = startDir
  for (;;) {
    try {
      if (
        existsSync(join(dir, "sessions")) &&
        (existsSync(join(dir, "settings.yaml")) || existsSync(join(dir, "settings.yaml.imported")))
      ) return dir
    } catch { return null }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ————————————— 批 20（docs/2026-09-17-writefileatomic-design.md §5.1/§5.2）：有界重试 rename 原语 —————————————
// 单一事实源（锚 A2）：writeFileAtomic 与 config-store.clearUserConfig 两个消费者共用。
// 机制（D20-2/D20-3/D20-6）：8 次 × 平铺 30ms、首试零延迟（最坏 ~210ms，与父侧探针包络对齐）；
// 可重试集按 e.code 字符串判（Windows 的 errno 为负 / POSIX 为正，只有 code 跨平台稳定）：
// EPERM / EACCES / EBUSY——刻意不含 EAGAIN（R-61：未实测，白名单是显式动作）；ENOENT 不进
// 主白名单，交 opts.onEnoent 裁定；耗尽重抛最后一个原对象（不 wrap——调用方依赖 .code）
// + message 追加遥测（复发时宿主日志可判真伪）。

/** 重试预算（D20-2：探针包络——锁中途释放实测第 6 次成功——加余量）。 */
export const RENAME_MAX_ATTEMPTS = 8
/** 平铺退避间隔（毫秒；D20-2：8×30ms ≈ 210ms，否决未实测的爬升曲线）。 */
export const RENAME_BACKOFF_MS = 30
/** 耗尽失败签名（D20-6：稳定可 grep——store 的 warn 拼接 e.message，宿主日志可据此检索）。 */
const RENAME_RETRY_EXHAUSTED_SIGNATURE = "[thincoder-suite] rename-retry-exhausted"
/** 可重试错误码白名单（D20-3：按 e.code 字符串；不含 EAGAIN——R-61）。 */
const RENAME_RETRYABLE_CODES = ["EPERM", "EACCES", "EBUSY"]

/**
 * 同步 sleep（D20-2）：Atomics.wait 不占 CPU、不依赖事件循环；环境禁用（SharedArrayBuffer /
 * Atomics.wait 抛错）⇒ 外包 try/catch 退化为立即重试（不同步等待）。
 * @param {number} ms
 */
function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch { /* feature-detect 失败 ⇒ 立即重试 */ }
}

/**
 * 第 gapIndex 次失败后的退避间隔（§5.1 注入缝）：opts.delays 提供时按下标取（1 基），
 * 数组耗尽则复用最后一项（测试传 [1,1,1]）；未提供/为空 ⇒ 平铺 RENAME_BACKOFF_MS（§9.1 畸形输入）。
 * @param {number[]|null} delays
 * @param {number} gapIndex 第几次失败后的间隔（1 基）
 * @returns {number} 本次间隔毫秒数
 */
function backoffDelayMs(delays, gapIndex) {
  const pick = (i) => {
    const v = delays[i]
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
  }
  if (Array.isArray(delays) && delays.length > 0) {
    const direct = pick(gapIndex - 1)
    if (direct !== null) return direct
    const last = pick(delays.length - 1)
    if (last !== null) return last
  }
  return RENAME_BACKOFF_MS
}

/**
 * FR-1：有界重试的 rename（原语单一事实源；writeFileAtomic 与 clearUserConfig 共用——A2/D20-9）。
 * @pre   from 存在且可读；to 的父目录存在（mkdir 由调用方在环外负责——D20-4 保 F12-T5 快失败）
 * @post  成功 ⇒ 返回；白名单错误（EPERM/EACCES/EBUSY，按 e.code 字符串）在预算内重试
 *        （RENAME_MAX_ATTEMPTS 次 × 平铺 RENAME_BACKOFF_MS，首试零延迟）；非白名单（含
 *        e.code 缺失——非 fs 错误）⇒ 立即抛（fail-closed）；ENOENT 不在主白名单：由
 *        opts.onEnoent 裁定——真值 ⇒ 视为可重试、消耗同一预算，否则（含未提供回调）立即抛；
 *        耗尽 ⇒ 重抛最后一个原对象（保 .code，不 wrap）+ message 追加遥测：code / errno /
 *        已试次数 / 总耗时 / 可 grep 签名（D20-6）。
 *        opts.write（writeFileAtomic 提供）⇒ 每次尝试先写 from（写与 rename 同入环内 try——
 *        D20-5），任何失败先 best-effort unlink from 再判重试（修 P-4 首写失败留半个 tmp）；
 *        不提供 ⇒ 不写也不 unlink（clearUserConfig 的 from 是活配置文件，重试间绝不能被清）。
 * @param {string} from 源路径
 * @param {string} to 目标路径
 * @param {{delays?: number[], maxAttempts?: number, write?: () => void, onEnoent?: (e: Error) => boolean, rename?: (from: string, to: string) => void}} [opts]
 *   注入缝：delays（退避序列）、maxAttempts（预算；§9.1 空集——0 ⇒ 立即抛）；钩子：write、onEnoent、
 *   rename（rename 阶段注入缝，§5.1c——缺省 = renameSync；测试用它在不 mock.module 的前提下
 *   注入前 k 次 EPERM / 持续 EPERM / 非白名单错误）。
 */
export function renameSyncWithRetry(from, to, opts) {
  const o = opts && typeof opts === "object" ? opts : {}
  const rawMax = o.maxAttempts
  const maxAttempts = Number.isInteger(rawMax) && rawMax >= 0 ? rawMax : RENAME_MAX_ATTEMPTS
  if (maxAttempts === 0) {
    // §9.1 空集：预算为 0 次（注入缝）⇒ 立即抛（尚无失败错误对象可重抛，不进遥测拼接）
    throw new Error("[thincoder-suite] renameSyncWithRetry: maxAttempts=0 — 零预算立即抛")
  }
  const delays = Array.isArray(o.delays) ? o.delays : null
  const hasWrite = typeof o.write === "function"
  const rename = typeof o.rename === "function" ? o.rename : renameSync
  const t0 = Date.now()
  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (hasWrite) o.write() // D20-5：写与 rename 同入环内 try（首写失败也走同一清理与同一预算）
      rename(from, to)
      return
    } catch (e) {
      lastErr = e
      // FR-2/D20-5：失败先 best-effort unlink from，再判是否重试；仅 write 形消费者（from 是本轮
      // 临时文件）——clearUserConfig 不传 write，其 from（活配置）在任何失败后都必须原样保留
      if (hasWrite) {
        try { unlinkSync(from) } catch { /* best-effort：清理失败也放弃——临时文件由 OS 回收 */ }
      }
      let retryable = false
      if (e && e.code === "ENOENT" && typeof o.onEnoent === "function") {
        // D20-3：ENOENT 不进主白名单——交给调用方（writeFileAtomic 传「重铸 tmp」）；回调自身
        // 抛错 ⇒ 按不可重试（fail-closed，保住原错误对象向上抛）
        let verdict = false
        try { verdict = o.onEnoent(e) } catch { verdict = false }
        retryable = !!verdict
      } else {
        retryable = !!(e && typeof e.code === "string" && RENAME_RETRYABLE_CODES.includes(e.code))
      }
      if (!retryable) throw e
      if (attempt === maxAttempts) break // 耗尽 ⇒ 统一走下方「重抛原对象 + 遥测」
      sleepSync(backoffDelayMs(delays, attempt))
    }
  }
  // 耗尽（D20-6）：重抛最后一个原对象（不 wrap——调用方依赖 .code），message 追加遥测：
  // code / errno / 已试次数 / 总耗时 / 稳定可 grep 的失败签名
  try {
    lastErr.message = String(lastErr.message ?? "") + " " + RENAME_RETRY_EXHAUSTED_SIGNATURE
      + " code=" + String(lastErr.code)
      + " errno=" + String(lastErr.errno)
      + " attempts=" + maxAttempts
      + " elapsedMs=" + (Date.now() - t0)
  } catch { /* message 不可追加不改变重抛语义（原对象照抛） */ }
  throw lastErr
}

/** 孤儿清扫阈值（D20-10）：龄 ≥ 10min 才扫——在飞 tmp 的生命是秒级，阈值把误杀面降到零。 */
const ORPHAN_SWEEP_AGE_MS = 10 * 60 * 1000

/**
 * 成功写后的 best-effort 孤儿清扫（D20-10/锚 A5）：同目录 + 同前缀（.<基名>.tmp- 与
 * .<基名>.del- 两形）+ 龄 ≥ 10min 才删——硬崩在 write→rename 之间留 .tmp-*、clear 崩在
 * rename→rm 之间留 .del-* 的有界兜底。清扫面零命中 / 目录不可读 ⇒ 静默通过（§9.1 空集）。
 * @param {string} dir 目标文件所在目录
 * @param {string} base 目标文件基名（前缀 = .<base>.tmp- / .<base>.del-）
 */
function sweepStaleTempFiles(dir, base) {
  const prefixes = ["." + base + ".tmp-", "." + base + ".del-"]
  let names
  try { names = readdirSync(dir) } catch { return }
  const cutoff = Date.now() - ORPHAN_SWEEP_AGE_MS
  for (const name of names) {
    if (!prefixes.some((p) => name.startsWith(p))) continue
    const full = join(dir, name)
    try {
      if (statSync(full).mtimeMs <= cutoff) unlinkSync(full)
    } catch { /* best-effort：stat/unlink 失败都放弃（残留由下次成功写再扫） */ }
  }
}

/**
 * 原子写 helper（评审 #4，三 store 共用）：mkdir(recursive)（环外——D20-4：确定性失败快抛，
 * 保 F12-T5 的 ENOTDIR 契约）→ 环内 try「写同目录 tmp → rename 原子替换」（D20-5：写与
 * rename 同入一个 try、失败先 best-effort unlink 再判重试，修「首写失败留半个 tmp」；tmp
 * 命名带 pid + 时间戳且环外定格一次——跨进程 pid 不同、进程内全同步不可自交错，不为已实测
 * 证伪的碰撞面加机制）。rename 走 renameSyncWithRetry（FR-1）：白名单错误（EPERM/EACCES/
 * EBUSY，按 e.code 字符串）有界重试、首试零延迟；ENOENT ⇒ 重铸 tmp 继续同一预算；非白名单
 * 立即抛、耗尽重抛原对象 + 遥测 message 向上抛——调用方（各 store 的 save/remove）以
 * try/catch 包裹转 console.warn（N3 fail-safe，契约零变更）。成功后 best-effort 清扫同目录
 * 同前缀、龄 ≥ 10min 的孤儿 tmp/.del（D20-10）。
 * @param {string} filePath 目标文件完整路径
 * @param {string} text 完整文件内容（含结尾换行，由调用方组装）
 * @param {{delays?: number[], maxAttempts?: number, rename?: (from: string, to: string) => void}} [opts]
 *   注入缝（§5.1：测试传 delays [1,1,1]；§5.1c：rename 透传给 renameSyncWithRetry——rename 阶段注入缝）
 */
export function writeFileAtomic(filePath, text, opts) {
  const o = opts && typeof opts === "object" ? opts : {}
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true }) // 目录缺失时 writeFile ENOENT 会静默失败（评审先例）；环外（D20-4）
  // tmp 命名带 pid + 时间戳（避免并发写碰撞，对齐 config-store 既有惯例）；环外定格一次（D20-5）
  const tmpPath = join(dir, "." + basename(filePath) + ".tmp-" + process.pid + "-" + Date.now())
  const writeTmp = () => writeFileSync(tmpPath, text, "utf8")
  // 写（writeTmp）与 rename 同入 renameSyncWithRetry 的环内 try；失败即 best-effort unlink（修 P-4）
  renameSyncWithRetry(tmpPath, filePath, {
    delays: o.delays,
    maxAttempts: o.maxAttempts,
    write: writeTmp,
    onEnoent: () => { writeTmp(); return true }, // D20-3：tmp 被外部清走 ⇒ 重铸即自愈，继续同一预算
    rename: o.rename, // §5.1c：rename 阶段注入缝透传（缺省 = renameSync，行为逐字等价）
  })
  sweepStaleTempFiles(dir, basename(filePath))
}
