// dsh-home.mjs — DSH_HOME 路径解析 + 原子写公共 helper（F12，docs/2026-09-02-session-state-stages-design.md §2.2）。
// 抽取自 token-store.mjs / config-store.mjs 的两份重复实现（评审 #2 引导「第三份前抽公共模块」），
// 行为零变化（既有 token/config fixture 测试全绿为证）；新增 writeFileAtomic 供三个 store 共用
// （评审 #4：多会话单文件直写 = 崩半写丢全部状态——tmp+rename 原子替换对齐 config-store 既有惯例，
// token-store 顺带从直写升级为原子写：其现状直写是 1h TTL 损失=重评审可接受的历史选择，统一后无损失）。
// 纯 node:fs/path，零新增依赖。
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * DSH_HOME 解析（原 token-store/config-store 各一份的同名实现，单一化）：
 * 优先 dshHomeOverride（测试注入缝，语义 = DSH_HOME 目录），其次 process.env.DSH_HOME
 * （宿主 web profile 进程实证可见），最后从 cwdHint/process.cwd() 向上探测 profile 根兜底。
 * 无可用 home → null（调用方各自 fail-safe：save 仅 warn，load 视为无记录）。
 * @param {string} [dshHomeOverride]
 * @param {string} [cwdHint] — 探测起点的会话 cwd（宿主进程 cwd 与会话 cwd 可能不一致）
 * @returns {string|null} DSH_HOME 目录
 */
export function pickDshHome(dshHomeOverride, cwdHint) {
  if (typeof dshHomeOverride === "string" && dshHomeOverride.trim() !== "") {
    return dshHomeOverride.trim()
  }
  if (typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== "") {
    return process.env.DSH_HOME.trim()
  }
  return probeProfileRoot(typeof cwdHint === "string" && cwdHint.trim() !== "" ? cwdHint.trim() : process.cwd())
}

/**
 * profile 根特征 = 目录同时含 sessions/ 与 settings.yaml（设计 §5 确认项 1 的兜底探测，
 * 原 token-store/config-store 同名实现单一化）。向上走到根仍未命中 → null。
 */
export function probeProfileRoot(startDir) {
  let dir = startDir
  for (;;) {
    try {
      if (existsSync(join(dir, "sessions")) && existsSync(join(dir, "settings.yaml"))) return dir
    } catch { return null }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 原子写 helper（评审 #4，三 store 共用）：mkdir(recursive) → 写同目录 tmp 文件 → rename 原子替换。
 * tmp 命名带 pid + 时间戳（避免并发写碰撞，对齐 config-store 既有惯例）；任何失败向上抛——
 * 调用方（各 store 的 save/remove）以 try/catch 包裹转 console.warn（N3 fail-safe）。
 * @param {string} filePath 目标文件完整路径
 * @param {string} text 完整文件内容（含结尾换行，由调用方组装）
 */
export function writeFileAtomic(filePath, text) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true }) // 目录缺失时 writeFile ENOENT 会静默失败（评审先例）
  const tmpPath = join(dir, "." + basename(filePath) + ".tmp-" + process.pid + "-" + Date.now())
  writeFileSync(tmpPath, text, "utf8")
  try {
    renameSync(tmpPath, filePath)
  } catch (e) {
    // 评审 #1：rename 失败（Windows 目标被占用等）→ best-effort 清掉孤儿 tmp 再向上抛，防静默累积
    try { unlinkSync(tmpPath) } catch { /* 清理失败也放弃——临时文件由 OS 回收 */ }
    throw e
  }
}
