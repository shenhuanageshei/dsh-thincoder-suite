// config-store.mjs — 全局 user 层配置的磁盘存储与合并（二期，docs/2026-09-02-settings-ui-design.md §2/§3.1）。
// 纯 fs helper（零新增依赖）：user 层 = $DSH_HOME/.thincoder/config.json（与 F10 token-store
// 同目录不同文件，实施确认项 6 已核对无并发冲突——设计-tokens.json 键控 sessionId，本文件
// 是单一整配置，写入互不接触）。语义：
// - base = 插件 cordis.patch.yml entry config（启动快照，apply 收到的 rawConfig）——本模块不动它；
// - user 层 = config.json 的 .config（UI 可编辑，字段级覆盖 base；缺失/损坏 → null = 无 user 层，
//   回落 base，N3 fail-safe）；
// - effective = mergeGlobalConfig(base, user)（字段级白名单合并）——所有 host 消费点经
//   effectiveGlobalConfig() 在每次评审/工具调用时读取合并（改动立即生效，U5）。
//
// 仿 token-store 的结构与惯例：
// - resolveConfigStorePath(dshHomeOverride, cwdHint)：路径解析注入缝（dshHomeOverride = 测试注入
//   的 DSH_HOME 目录；缺省 process.env.DSH_HOME → 从 cwdHint/process.cwd() 向上探测 profile 根
//   （同含 sessions/ 与 settings.yaml 的最近上级）→ 全缺 null（调用方各自 fail-safe）。
// - loadUserConfig：try/catch，缺失/损坏/非对象 → null（N3：损坏视为无 user 层，不崩溃）。
// - saveUserConfig：mkdir + tmp+rename 原子写（对齐 super-injector 惯例）+ try/catch warn 不抛。
// - clearUserConfig：删文件（缺失视为已清空）。
// - mergeGlobalConfig(base, user)：字段级白名单浅合并（不动 base 对象）：
//     advisor.round1/convergence（组内字段级 provider/model/effort/timeoutMs）、
//     advisor.includeProjectGuide、consultModels（整体替换）、engCoderMaxTokens/engCoderEffort；
//   未知字段不合并（白名单）；base 的非白名单键（engineering/engTokenTtlMs/consultTimeoutMs/
//   legacy advisor.provider 等）原样保留——合并只叠加 user 层，不改 entry base 语义。
// 文件格式：{ "version": 1, "config": { ... } }（§2 示例）。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const STORE_VERSION = 1
const STORE_SUBDIR = ".thincoder"
const STORE_FILE = "config.json"

const warn = (m) => console.warn("[thincoder-suite] " + m)

/** 组内可合并字段（与 mergeAdvisorGroup / advisor 解析链单一事实源同列）。 */
const GROUP_FIELDS = ["provider", "model", "effort", "timeoutMs"]

/**
 * 存储路径解析。优先 dshHomeOverride（测试注入缝，语义 = DSH_HOME 目录），其次
 * process.env.DSH_HOME（宿主 web profile 进程实证可见），最后从 cwdHint/process.cwd()
 * 向上探测 profile 根（同含 sessions/ 与 settings.yaml，F10 token-store 同款）。
 * @param {string} [dshHomeOverride]
 * @param {string} [cwdHint] — 探测起点的会话 cwd
 * @returns {string|null} 完整存储文件路径
 */
export function resolveConfigStorePath(dshHomeOverride, cwdHint) {
  const home = pickDshHome(dshHomeOverride, cwdHint)
  return home ? join(home, STORE_SUBDIR, STORE_FILE) : null
}

function pickDshHome(dshHomeOverride, cwdHint) {
  if (typeof dshHomeOverride === "string" && dshHomeOverride.trim() !== "") {
    return dshHomeOverride.trim()
  }
  if (typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== "") {
    return process.env.DSH_HOME.trim()
  }
  return probeProfileRoot(typeof cwdHint === "string" && cwdHint.trim() !== "" ? cwdHint.trim() : process.cwd())
}

/** profile 根特征 = 目录同时含 sessions/ 与 settings.yaml（F10 同款探测）。 */
function probeProfileRoot(startDir) {
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
 * 读取 user 层配置对象（文件 .config）。缺失/损坏/非对象 → null（N3：无 user 层，
 * 回落 entry base；不崩溃）。
 * @param {string} [dshHomeOverride] — 测试注入缝
 * @param {string} [cwdHint]
 * @returns {object|null}
 */
export function loadUserConfig(dshHomeOverride, cwdHint) {
  const filePath = resolveConfigStorePath(dshHomeOverride, cwdHint)
  if (!filePath) return null
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"))
    const cfg = data && typeof data === "object" && !Array.isArray(data) ? data.config : null
    return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : null
  } catch {
    return null // 缺失/损坏/不可读 → 无 user 层（fail-safe）
  }
}

/**
 * 写入/整体替换 user 层配置。mkdir(recursive) → 读现有（无需）→ 写 tmp 文件 → rename 原子
 * 替换（同一目录，rename 原子；tmp 命名带 pid，避免并发写碰撞）。写盘失败仅 warn 并返回
 * false，不抛（N3：写失败提示不崩溃，调用方保持原 user 层）。
 * @param {object} cfg 完整 user 层配置（白名单之外的键照存，merge 时忽略）
 * @param {string} [dshHomeOverride] — 测试注入缝
 * @param {string} [cwdHint]
 * @returns {boolean} 是否成功写盘
 */
export function saveUserConfig(cfg, dshHomeOverride, cwdHint) {
  const filePath = resolveConfigStorePath(dshHomeOverride, cwdHint)
  if (!filePath) {
    warn("config store path not resolvable (no DSH_HOME / profile root) — user-layer config not saved")
    return false
  }
  try {
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true }) // 目录缺失时 writeFile ENOENT 会静默失败（评审先例）
    const tmpPath = join(dir, "." + STORE_FILE + ".tmp-" + process.pid + "-" + Date.now())
    writeFileSync(tmpPath, JSON.stringify({ version: STORE_VERSION, config: cfg ?? {} }, null, 2) + "\n", "utf8")
    renameSync(tmpPath, filePath)
    return true
  } catch (e) {
    warn("failed to save user config to " + filePath + ": " + (e?.message ?? String(e)) + " — previous user layer kept")
    return false
  }
}

/**
 * 清空 user 层（恢复回落 entry base）。缺失文件视为已清空。失败仅 warn 不抛。
 * @param {string} [dshHomeOverride] — 测试注入缝
 * @param {string} [cwdHint]
 * @returns {boolean}
 */
export function clearUserConfig(dshHomeOverride, cwdHint) {
  const filePath = resolveConfigStorePath(dshHomeOverride, cwdHint)
  if (!filePath) return false
  try {
    if (!existsSync(filePath)) return true
    // 原子删除先 rename 成 .del 再删：进程崩溃也不留半删状态（同 tmp+rename 惯例的尽力而为）
    const dir = dirname(filePath)
    const delPath = join(dir, "." + STORE_FILE + ".del-" + process.pid + "-" + Date.now())
    renameSync(filePath, delPath)
    try { rmSync(delPath, { force: true }) } catch { /* 清理失败不阻塞（遗留 .del 无害） */ }
    return true
  } catch (e) {
    warn("failed to clear user config at " + filePath + ": " + (e?.message ?? String(e)))
    return false
  }
}

/** 组对象字段级浅合并（user 覆盖 base 同名字段；unknown 字段不合并）。 */
function mergeGroup(baseGroup, userGroup) {
  const out = { ...(baseGroup && typeof baseGroup === "object" && !Array.isArray(baseGroup) ? baseGroup : {}) }
  if (userGroup && typeof userGroup === "object" && !Array.isArray(userGroup)) {
    for (const key of GROUP_FIELDS) {
      const v = userGroup[key]
      if (v !== undefined && v !== null) out[key] = v
    }
  }
  return out
}

/**
 * 字段级白名单合并 base（entry base 快照）⊕ user（config.json user 层）→ 新对象（不 mutate 入参）。
 * - advisor：round1/convergence 组字段级（user 覆盖 base 同名字段；只认
 *   provider/model/effort/timeoutMs）；includeProjectGuide 布尔覆盖；base advisor 的其余键
 *   （legacy advisor.provider/model 等一期兼容字段）原样保留；
 * - consultModels：user 是数组 → 整体替换（增删列表语义）；否则保留 base；
 * - engCoderMaxTokens / engCoderEffort：user 定义（非 null）即覆盖；
 * - 未知顶层/组内字段不合并（白名单）；base 的非白名单键（engineering / engTokenTtlMs /
 *   consultTimeoutMs 等）原样保留——user 层只叠加白名单，不改 entry base 其他语义。
 * 语义层面不重复值校验（校验在 PUT config 端点与解析链的 N4 警告处——单一事实源），
 * 本函数只做「字段级」与「白名单」。
 * @param {object} [baseConfig]
 * @param {object|null} [userCfg] — loadUserConfig 的返回值（null = 无 user 层）
 * @returns {object} 合并后的全局生效配置
 */
export function mergeGlobalConfig(baseConfig, userCfg) {
  const base = (baseConfig && typeof baseConfig === "object" && !Array.isArray(baseConfig)) ? baseConfig : {}
  const user = (userCfg && typeof userCfg === "object" && !Array.isArray(userCfg)) ? userCfg : {}
  const out = { ...base }

  // advisor 组（字段级）+ includeProjectGuide + base advisor 其余键保留
  if (user.advisor && typeof user.advisor === "object" && !Array.isArray(user.advisor)) {
    const baseAdvisor = (base.advisor && typeof base.advisor === "object" && !Array.isArray(base.advisor))
      ? base.advisor
      : {}
    const mergedAdvisor = { ...baseAdvisor }
    for (const groupKey of ["round1", "convergence"]) {
      const mergedGroup = mergeGroup(baseAdvisor[groupKey], user.advisor[groupKey])
      // 只落有内容的组：base 未定义且 user 无字段（或净化为空）→ 不引入空组键，
      // 否则合并输出会带 { round1:{}, convergence:{} } 噪音
      if (baseAdvisor[groupKey] !== undefined || Object.keys(mergedGroup).length > 0) {
        mergedAdvisor[groupKey] = mergedGroup
      }
    }
    if (typeof user.advisor.includeProjectGuide === "boolean") {
      mergedAdvisor.includeProjectGuide = user.advisor.includeProjectGuide
    }
    out.advisor = mergedAdvisor
  }

  if (Array.isArray(user.consultModels)) {
    // 整体替换（增删列表语义）；评审 #11：浅拷贝——返回值归调用方只读，防原地改动污染 user 层
    out.consultModels = user.consultModels.map((r) => (r && typeof r === "object" ? { ...r } : r))
  }
  if (user.engCoderMaxTokens !== undefined && user.engCoderMaxTokens !== null) {
    out.engCoderMaxTokens = user.engCoderMaxTokens
  }
  if (user.engCoderEffort !== undefined && user.engCoderEffort !== null) {
    out.engCoderEffort = user.engCoderEffort
  }
  return out
}

/**
 * 读取 user 层并与 base 合并（host 每次评审/工具调用时调用的统一 helper，§3.6-1：
 * config 来源统一走这一处，避免各消费点各自 load/merge 的重复实现与漂移）。
 * @param {object} [baseConfig] — entry base（cordis.patch.yml 启动快照）
 * @param {{dshHomeOverride?: string, cwdHint?: string}} [opts] — 测试注入缝 / 探测起点
 * @returns {object} 生效全局配置（base ⊕ user）
 */
export function effectiveGlobalConfig(baseConfig, opts) {
  const o = opts && typeof opts === "object" ? opts : {}
  const user = loadUserConfig(o.dshHomeOverride, o.cwdHint)
  return mergeGlobalConfig(baseConfig, user)
}
