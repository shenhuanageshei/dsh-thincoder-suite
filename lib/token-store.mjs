// token-store.mjs — design token 磁盘持久化（F10，docs/2026-09-02-thincoder-suite-extensions-design.md §2.1）。
// 纯 fs helper（零新增依赖）：token 的「第二存储」= $DSH_HOME/.thincoder/design-tokens.json
// （DSH_HOME = profile 根；与 super-injector/、undo-snapshots/ 平级）。内存态（state.mjs 的
// designToken）仍是第一存储与签发源，本模块只做镜像读写——评审 #9 定案独立模块，保持
// state.mjs 纯内存语义：
// - saveTokenRecord：mkdirSync(dirname, { recursive: true })（评审 #2：目录缺失时 writeFile
//   会 ENOENT 静默失败）→ 读现有文件（try/catch，缺失/损坏/不可读 → 视为空，评审 #1）→
//   更新本 sessionId 条目（含 D-30 的 docHash/docPaths 条件字段）→ 全量清扫所有 session 的
//   过期条目（单次遍历 + D-30 五分支规则，见下）→ 写回；
//   任何失败仅 console.warn 不抛（N2 fail-safe：签发/校验流程不依赖持久化成功）。
// - loadTokenRecord：try/catch，损坏/缺失/不可读 → null（调用方以「无记录」落入三态拒绝，
//   不崩溃）。
// - resolveTokenStorePath(dshHomeOverride)：存储路径解析。dshHomeOverride 为测试注入缝
//   （storPathOverride，对齐 stallMsOverride 先例——测试用临时目录，不碰真实 $DSH_HOME）；
//   缺省回落 process.env.DSH_HOME → 从 process.cwd() 向上探测 profile 根（同时含
//   sessions/ 与 settings.yaml 的最近上级，设计 §5 确认项 1 的兜底）。全部缺失 → null。
// 文件格式：{ "version": 1, "tokens": { "<sessionId>": { "token", "issuedAt", "expiresAt"
//   [, "docHash", "docPaths"] } } }。D-30/FR-T8：docHash（设计文档集指纹，doc-hash.mjs 计算）
//   与 docPaths（归一后路径表）为**条件字段**——空文档集不写；它们是续期（FR-T5）的唯一输入，
//   故已过期但带 docHash 的记录不再被清扫删除（见下方清扫规则）。
// F12（docs/2026-09-02-session-state-stages-design.md §2.2 评审 #4）：路径解析抽公共
// lib/dsh-home.mjs（与 config-store 各一份的重复实现单一化，行为零变化）；写回升级为
// dsh-home.writeFileAtomic 原子写（tmp+rename——多会话单文件直写崩半写会丢全部 token 记录；
// 历史直写是 1h TTL 损失=重评审可接受的选择，统一原子写后无损失）。

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pickDshHome, writeFileAtomic } from "./dsh-home.mjs"
// D-30/FR-T8：保留期上限复用 D-29 既有常量 ENG_TOKEN_TTL_MAX_MS（30d）——不新增旋钮
// （config-store.mjs 是值域常量的单一事实源；本模块只读该常量，不引入反向依赖）。
import { ENG_TOKEN_TTL_MAX_MS } from "./config-store.mjs"

const STORE_VERSION = 1
const STORE_SUBDIR = ".thincoder"
const STORE_FILE = "design-tokens.json"

const warn = (m) => console.warn("[thincoder-suite] " + m)

/**
 * 存储路径解析。优先 dshHomeOverride（测试注入缝 storPathOverride，语义 = DSH_HOME 目录），
 * 其次 process.env.DSH_HOME（宿主 web profile 进程实证可见），最后探测 profile 根兜底
 * （起点 = cwdHint（会话 cwd，评审 #7）?? process.cwd()）。
 * 无可用 home → null（调用方各自 fail-safe：save 仅 warn，load 视为无记录）。
 * 实体在 lib/dsh-home.mjs（F12 抽公共模块，resolveTokenStorePath 保持原签名/行为）。
 * @param {string} [dshHomeOverride]
 * @param {string} [cwdHint] — 探测起点的会话 cwd（宿主进程 cwd 与会话 cwd 可能不一致）
 * @returns {string|null} 完整存储文件路径
 */
export function resolveTokenStorePath(dshHomeOverride, cwdHint) {
  const home = pickDshHome(dshHomeOverride, cwdHint)
  return home ? join(home, STORE_SUBDIR, STORE_FILE) : null
}

/**
 * 写入/更新某 session 的 token 记录（读-改-写 + 全量清扫过期，§2.1 写入时序 1–5）。
 * 写盘失败仅 warn 并返回 false，不抛——签发流程不依赖持久化成功（N2，内存态兜底）。
 * @param {string} sessionId
 * @param {{token: string, issuedAt?: number, expiresAt?: number, docHash?: string, docPaths?: string[]}} entry
 * @param {string} [dshHomeOverride] — 测试注入缝（storPathOverride）
 * @returns {boolean} 是否成功写盘
 */
export function saveTokenRecord(sessionId, entry, dshHomeOverride, cwdHint) {
  const filePath = resolveTokenStorePath(dshHomeOverride, cwdHint)
  if (!filePath) {
    warn("design-token store path not resolvable (no DSH_HOME / profile root) — token kept in memory only")
    return false
  }
  try {
    // 2. 读现有文件（评审 #1：缺失/损坏/不可读 → 视为空）
    let data = null
    try {
      data = JSON.parse(readFileSync(filePath, "utf8"))
    } catch { data = null }
    const tokens = data && typeof data === "object" && !Array.isArray(data)
      && data.tokens && typeof data.tokens === "object" && !Array.isArray(data.tokens)
      ? data.tokens
      : {}
    // 3. 更新本 sessionId 条目（token/issuedAt/expiresAt；D-30/FR-T8：docHash/docPaths 随附）
    const rec = {
      token: String(entry?.token ?? ""),
      issuedAt: typeof entry?.issuedAt === "number" && Number.isFinite(entry.issuedAt)
        ? entry.issuedAt
        : Date.now(),
      expiresAt: typeof entry?.expiresAt === "number" && Number.isFinite(entry.expiresAt)
        ? entry.expiresAt
        : 0,
    }
    // D-30（FR-T8 缺口 G1）：保存路径此前显式重建三字段 → 任何传入的 docHash 被静默丢弃，
    // 续期永远拿不到素材。**缺省不写**（空文档集 = 无 docHash，决策 D6；旧记录无此字段属正常，
    // 见 N7「磁盘格式纯追加」）。
    if (typeof entry?.docHash === "string" && entry.docHash !== "") rec.docHash = entry.docHash
    if (Array.isArray(entry?.docPaths)) {
      const docPaths = entry.docPaths.filter(p => typeof p === "string" && p.trim() !== "")
      if (docPaths.length > 0) rec.docPaths = docPaths
    }
    tokens[String(sessionId)] = rec
    // 4. 全量清扫（评审 #4 扩展；D-30/FR-T8 重写）：单次遍历，五分支规则——
    //    ① 畸形记录（非对象 / expiresAt 非有限数）→ **仍删**（保留原防累积意图）；
    //    ② 未过期 → 保留；
    //    ③ 已过期且**无** docHash → 删除（现状语义：无续期价值）；
    //    ④ 已过期**且有** docHash → **保留**（它是续期判定的唯一输入，决策 D9/G2）——
    //       修复前「过期即删」会顺手扫掉别的会话可续期的记录，让「重启后续期」头号场景
    //       非确定性地失败；保留期上限 = ENG_TOKEN_TTL_MAX_MS（30d，复用 D-29 既有常量，
    //       不新增旋钮），判定锚点 = **expiresAt**（设计评审 #8 钉死；不是 issuedAt）：
    //       now > expiresAt + ENG_TOKEN_TTL_MAX_MS → 删除（防无界累积）。
    const now = Date.now()
    for (const [sid, rec] of Object.entries(tokens)) {
      if (!(rec && typeof rec === "object" && !Array.isArray(rec))
        || !(typeof rec.expiresAt === "number" && Number.isFinite(rec.expiresAt))) {
        delete tokens[sid]
        continue
      }
      if (now <= rec.expiresAt) continue
      const hasDocHash = typeof rec.docHash === "string" && rec.docHash !== ""
      if (!hasDocHash) { delete tokens[sid]; continue }
      if (now > rec.expiresAt + ENG_TOKEN_TTL_MAX_MS) delete tokens[sid]
    }
    // 5. 写回（tmp+rename 原子写，F12 评审 #4；失败仅 warn 不抛——签发不依赖持久化成功）
    writeFileAtomic(filePath, JSON.stringify({ version: STORE_VERSION, tokens }, null, 2) + "\n")
    return true
  } catch (e) {
    warn("failed to persist design token to " + filePath + ": " + (e?.message ?? String(e)) + " — token kept in memory only")
    return false
  }
}

/**
 * 读取某 session 的 token 记录。缺失/损坏/不可读/无此 session → null（fail-safe，评审 #1）——
 * 调用方（eng.mjs 校验路径）以 null = 无记录落入三态拒绝，不崩溃。
 * @param {string} sessionId
 * @param {string} [dshHomeOverride] — 测试注入缝（storPathOverride）
 * @returns {{token?: string, issuedAt?: number, expiresAt?: number, docHash?: string, docPaths?: string[]}|null}
 */
export function loadTokenRecord(sessionId, dshHomeOverride, cwdHint) {
  const filePath = resolveTokenStorePath(dshHomeOverride, cwdHint)
  if (!filePath) return null
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"))
    const tokens = data && typeof data === "object" && !Array.isArray(data) ? data.tokens : null
    const rec = tokens && typeof tokens === "object" && !Array.isArray(tokens)
      ? tokens[String(sessionId)]
      : null
    return rec && typeof rec === "object" && !Array.isArray(rec) ? rec : null
  } catch {
    return null // 损坏/不可读 → 无记录（fail-safe）
  }
}

/**
 * 删除某 session 的 token 记录（撤销分支用，评审 #2：advisor 完成未通过时撤销既有签发，
 * 内存与磁盘同步——否则被撤销 token 经重启后回填路径复活）。失败仅 warn 不抛。
 * @param {string} sessionId
 * @param {string} [dshHomeOverride]
 * @param {string} [cwdHint]
 * @returns {boolean}
 */
export function removeTokenRecord(sessionId, dshHomeOverride, cwdHint) {
  const filePath = resolveTokenStorePath(dshHomeOverride, cwdHint)
  if (!filePath) return false
  try {
    let data = null
    try {
      data = JSON.parse(readFileSync(filePath, "utf8"))
    } catch { data = null }
    const tokens = data && typeof data === "object" && !Array.isArray(data)
      && data.tokens && typeof data.tokens === "object" && !Array.isArray(data.tokens)
      ? data.tokens
      : {}
    if (!(String(sessionId) in tokens)) return true // 无记录可删
    delete tokens[String(sessionId)]
    // tmp+rename 原子写（F12 评审 #4：remove 的读-改-写同样吃崩半写风险）
    writeFileAtomic(filePath, JSON.stringify({ version: STORE_VERSION, tokens }, null, 2) + "\n")
    return true
  } catch (e) {
    warn("failed to remove design token record for " + sessionId + ": " + (e?.message ?? String(e)))
    return false
  }
}
