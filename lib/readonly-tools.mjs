// readonly-tools.mjs — advisor 评审会话的内部只读工具集（纯 node:fs，零依赖）。
// 设计依据 DESIGN-dsh-port.md §4.1：不依赖 DSH 工具注册表（评审会话独立于主会话
// 工具体系）；read/glob/grep/ls 四件 + 64K 行感知截断（对齐 thincoder
// advisor/run.mjs 的 MAX_RESULT_CHARS）。工具结果一律为字符串（喂回 LLM）。
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { resolve, sep, relative, join } from "node:path"

export const MAX_RESULT_CHARS = 64 * 1024
const WALK_NODE_BUDGET = 20000   // 目录走访节点预算（防巨型仓库卡死评审）
const MAX_MATCHES = 250          // grep/glob 输出上限
const SKIP_DIRS = new Set(["node_modules", ".git", ".dsh-exports", "dist", ".next", "target", "build", ".venv", "__pycache__"])

/** 行感知截断：保行完整性（对齐 thincoder run.mjs 的截断算法）。 */
export function truncateResult(result) {
  if (result.length <= MAX_RESULT_CHARS) return result
  const lines = result.split("\n")
  let truncated = "", charCount = 0, keptLines = 0
  for (const line of lines) {
    if (charCount + line.length + 1 > MAX_RESULT_CHARS) break
    truncated += line + "\n"; charCount += line.length + 1; keptLines++
  }
  const remainingLines = lines.length - keptLines
  return truncated +
    "\n… (truncated: " + remainingLines + " more lines, " + result.length + " chars total)\n" +
    "To see more content, use: read(path, offset=" + (keptLines + 1) + ", limit=200)"
}

/**
 * 路径规约：相对 cwd 解析 + realpath + 逃逸围栏（对齐 thincoder citations.mjs：
 * LLM 给的路径不可信，链接指向工作区外也算越界）。
 */
function safeResolve(cwd, p) {
  const root = realpathSync(resolve(cwd))
  let abs
  try { abs = realpathSync(resolve(cwd, String(p ?? "."))) }
  catch { return { error: "path not found: " + p } }
  if (abs !== root && !abs.startsWith(root + sep)) return { error: "path outside workspace: " + p }
  return { abs, root, rel: relative(root, abs) || "." }
}

/** 递归走访（预算制；跳过 SKIP_DIRS）。返回相对 rootAbs 的文件路径数组。 */
function walk(rootAbs, startRel, budget) {
  const out = []
  const stack = [startRel]
  while (stack.length > 0 && budget.v > 0) {
    const rel = stack.pop()
    let entries
    try { entries = readdirSync(join(rootAbs, rel), { withFileTypes: true }) }
    catch { continue }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (budget.v-- <= 0) break
      const child = rel === "." ? e.name : rel + "/" + e.name
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(child)
      } else {
        out.push(child)
      }
    }
  }
  return out
}

/** glob 模式 → 正则（支持 ** / * / ?；分隔符统一 /）。 */
function globToRegex(pattern) {
  let p = String(pattern).replace(/\\/g, "/")
  p = p.replace(/\*\*\//g, "\u0000")     // **/ → 可选目录前缀
  p = p.replace(/\*\*/g, "\u0001")        // **   → 任意
  let re = "^"
  for (const ch of p) {
    if (ch === "\u0000") re += "(?:.*/)?"
    else if (ch === "\u0001") re += ".*"
    else if (ch === "*") re += "[^/]*"
    else if (ch === "?") re += "[^/]"
    else re += ch.replace(/[.+^$()|[\]\\{}]/g, "\\$&")
  }
  return new RegExp(re + "$")
}

function looksBinary(text) { return text.includes("\u0000") }

// ————————————————— 工具实现 —————————————————

function readExec(cwd) {
  return ({ path, offset, limit }) => {
    const r = safeResolve(cwd, path)
    if (r.error) return r.error
    let text
    try { text = readFileSync(r.abs, "utf8") }
    catch (e) { return "Error reading " + path + ": " + e.message }
    if (looksBinary(text)) return r.rel + ": binary file (not shown)"
    const lines = text.split("\n")
    const total = lines.length
    const off = Math.max(1, Math.floor(Number(offset) || 1))
    const lim = Math.min(2000, Math.max(1, Math.floor(Number(limit) || 2000)))
    const slice = lines.slice(off - 1, off - 1 + lim)
    const body = slice.map((t, i) => String(off + i).padStart(6) + "\t" + t).join("\n")
    const more = off - 1 + lim < total ? "\n(" + lim + " lines shown of " + total + " — use offset=" + (off + lim) + " for more)" : ""
    return truncateResult("(" + r.rel + ", " + total + " lines total)\n" + body + more)
  }
}

function globExec(cwd) {
  return ({ pattern, path }) => {
    if (!pattern) return "Error: pattern is required"
    const r = safeResolve(cwd, path || ".")
    if (r.error) return r.error
    let re
    try { re = globToRegex(pattern) } catch (e) { return "Error: invalid pattern: " + e.message }
    const files = walk(r.root, r.rel, { v: WALK_NODE_BUDGET })
    const hits = files.filter(f => re.test(f)).slice(0, MAX_MATCHES)
    if (hits.length === 0) return "(no matches)"
    return truncateResult(hits.join("\n") + (hits.length >= MAX_MATCHES ? "\n(… capped at " + MAX_MATCHES + " matches)" : ""))
  }
}

function grepExec(cwd) {
  return ({ pattern, path, include }) => {
    if (!pattern) return "Error: pattern is required"
    let re
    try { re = new RegExp(pattern) } catch (e) { return "Error: invalid regex: " + e.message }
    const r = safeResolve(cwd, path || ".")
    if (r.error) return r.error
    let incRe = null
    if (include) {
      try { incRe = globToRegex(include.includes("/") ? include : "**/" + include) } catch { incRe = null }
    }
    let isFile = false
    try { isFile = statSync(r.abs).isFile() } catch { /* 不存在或不可 stat：按目录扫即可 */ }
    const files = isFile ? [r.rel] : walk(r.root, r.rel, { v: WALK_NODE_BUDGET })
    const matches = []
    let scanned = 0
    for (const f of files) {
      if (matches.length >= MAX_MATCHES || scanned >= 2000) break
      if (incRe && !incRe.test(f)) continue
      let text
      try { text = readFileSync(join(r.root, f), "utf8") }
      catch { continue }
      scanned++
      if (looksBinary(text)) continue
      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= MAX_MATCHES) break
        if (re.test(lines[i])) matches.push(f + ":" + (i + 1) + ": " + lines[i].slice(0, 300))
      }
    }
    if (matches.length === 0) return "(no matches)"
    return truncateResult(matches.join("\n") + (matches.length >= MAX_MATCHES ? "\n(… capped at " + MAX_MATCHES + " matches)" : ""))
  }
}

function lsExec(cwd) {
  return ({ path }) => {
    const r = safeResolve(cwd, path || ".")
    if (r.error) return r.error
    let entries
    try { entries = readdirSync(r.abs, { withFileTypes: true }) }
    catch (e) { return "Error listing " + path + ": " + e.message }
    const rows = entries.sort((a, b) => a.name.localeCompare(b.name))
      .map(e => (e.isDirectory() ? "[dir]  " + e.name : e.isSymbolicLink() ? "[link] " + e.name : "       " + e.name))
    return truncateResult("(" + r.rel + ")\n" + (rows.join("\n") || "(empty)"))
  }
}

// ————————————————— 对外装配 —————————————————

/** ctx.llm.stream 用的 ToolSchema[]（JSON Schema 参数）。 */
export function advisorToolSchemas() {
  return [
    {
      name: "read",
      description: "Read a text file with 1-based line numbers. Use offset/limit for paging large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the workspace root or absolute" },
          offset: { type: "number", description: "First line to return (1-based, default 1)" },
          limit: { type: "number", description: "Max lines to return (default 2000)" },
        },
        required: ["path"],
      },
    },
    {
      name: "glob",
      description: "Find files by glob pattern (** crosses directories). Returns matching paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.mjs" },
          path: { type: "string", description: "Base directory (default workspace root)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "grep",
      description: "Search file contents with a regular expression. Returns path:line: text matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression (e.g. \"export function\")" },
          path: { type: "string", description: "File or directory to search (default workspace root)" },
          include: { type: "string", description: "Glob filter on file names, e.g. *.mjs" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "ls",
      description: "List one directory's entries (with [dir] markers).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory to list (default workspace root)" } },
      },
    },
  ]
}

/** 评审会话的工具实现表（name → execute(args) → string）。 */
export function advisorToolImpls(cwd) {
  return new Map([
    ["read", readExec(cwd)],
    ["glob", globExec(cwd)],
    ["grep", grepExec(cwd)],
    ["ls", lsExec(cwd)],
  ])
}
