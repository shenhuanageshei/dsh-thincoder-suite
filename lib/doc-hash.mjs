// doc-hash.mjs — 设计文档集指纹（D-30 / FR-T5）：docs/2026-09-11-token-lifecycle-design.md §3 FR-T5。
// 纯 helper（零新增依赖：只吃 node 内置 crypto/fs）——**单点实现**：token 续期判定（eng.mjs 过期
// 子分支）与测试用例共用本模块，禁止两处各写一份（规则漂移会让「文档变了吗」的答案分裂）。
//
// 指纹定义（设计档 §3 FR-T5 钉死）：对文档集**路径 + 内容**同时绑定——
//   sorted(normalize(path) + "\0" + sha256(content))  →  整体 sha256
// 仅内容会把「改名/移位」判为未变（评审的指向物已消失而 hash 还绿）；仅路径会漏掉编辑。
//
// D-44（基座显式化）：normalize 的基座**由调用方给**（`baseCwd`），叶子模块不猜 process.cwd()——
// 宿主进程的 cwd 是 profile 目录（实测 H-42 现场：令牌记录写的是 profiles/desktop/docs/… 那种不存在的
// 路径），相对路径的 documents 一律读不到 ⇒ 指纹恒 fail-closed ⇒ 续期门控从未生效（设计档 §2.2/§3.2）。
// **缺基座（undefined/null/空串/非字符串）时行为与改动前逐字一致**：走 `resolve(p)`（= process.cwd()）。
// 之所以还要挡非字符串：`list.map(normalizeDocPath)` 这种写法会把**下标**当第二参传进来，
// 若照单全收，`resolve(1, p)` 会直接抛（把既有调用点变成故障）——这不是兼容，是破坏。
//
// normalize(path) 规则（钉死）：path.resolve(p) → 反斜杠统一为 "/" → **不做**大小写折叠
// （Windows 上 Docs/A.md 与 docs/a.md 视为不同条目；本仓文档路径大小写稳定，折叠反而会把两处
// 不同文件误判为同一处。若将来出现大小写不一致引起的续期误拒，按「视为已变更」处理 = fail-closed
// 方向，可接受）。
//
// 失败方向（N3 fail-closed）：任一文档读不到 → 不返回 hash（ok:false + missing 清单）——
// 调用方（续期判定）据此按「已变更」拒绝续期；铸造侧据此不写 docHash（= 续期一律拒绝）。
//
// sha256Hex：本插件唯一的 SHA-256 实现点（本模块的 docHash 与 advisor.mjs 的无状态审批码
// FR-T3 共用同一函数——advisor.mjs 自身不再 import 任何 node:crypto 摘要 API，其 crypto 面
// 仅剩 randomUUID）。

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/** SHA-256 → 小写 hex（单点实现，供 docHash 与审批码派生共用）。 */
export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex")
}

/**
 * 路径归一（钉死规则，见文件头）：resolve（有基座则以基座为锚）→ 反斜杠统一 "/" → 不做大小写折叠。
 * @param {string} p
 * @param {string} [baseCwd] 显式基座（会话 cwd）。缺省/非字符串 ⇒ 与改动前逐字一致（resolve(p)）
 * @returns {string}
 */
export function normalizeDocPath(p, baseCwd) {
  const raw = String(p ?? "")
  // 只认「非空字符串」为基座：undefined/null/空串（含 .map 传进来的下标）一律回落旧行为。
  const base = typeof baseCwd === "string" && baseCwd !== "" ? baseCwd : null
  return (base === null ? resolve(raw) : resolve(base, raw)).replace(/\\/g, "/")
}

/**
 * 文档集指纹。
 * @param {string[]} paths — 文档路径（原始形态；内部逐条 normalize）
 * @param {string} [baseCwd] 显式基座（会话 cwd，D-44）。缺省 ⇒ 与改动前逐字一致（含 fail-closed 方向）
 * @returns {{ok: true, hash: string, docPaths: string[]}
 *          |{ok: false, reason: "unreadable", missing: string[], docPaths: string[]}}
 *   ok:true  → hash = 指纹；docPaths = 归一并排序后的路径表（落盘 docPaths 字段用同一份）。
 *   ok:false → 至少一份文档缺失/不可读（fail-closed：调用方按「已变更」处理）；
 *              missing = 读失败的**归一后**路径表（诊断用）。
 */
export function computeDocHash(paths, baseCwd) {
  const list = Array.isArray(paths) ? paths.filter(p => typeof p === "string" && p.trim() !== "") : []
  // 显式箭头（不是 list.map(normalizeDocPath)）：那条写法会把**下标**当基座传进去
  const docPaths = [...new Set(list.map(p => normalizeDocPath(p, baseCwd)))].sort()
  const entries = []
  const missing = []
  for (const docPath of docPaths) {
    try {
      entries.push(docPath + "\0" + sha256Hex(readFileSync(docPath)))
    } catch {
      missing.push(docPath) // 缺失/权限/目录 → fail-closed
    }
  }
  if (missing.length > 0) return { ok: false, reason: "unreadable", missing, docPaths }
  return { ok: true, hash: sha256Hex(entries.join("\n")), docPaths }
}
