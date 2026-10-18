// system-proxy.mjs — Windows 系统代理（WinINET 注册表）读取与「inherit」注入（批 40 · FR-1）。
// 设计档：docs/2026-10-18-codex-system-proxy-design.md §五 FR-1 / §六 伪代码 / §九 边界。
//
// 为什么存在：codexCli.proxyMode 默认的 inherit 只继承**环境变量**，而 Windows 的「系统代理」
// 住在注册表 HKCU\…\Internet Settings（ProxyEnable / ProxyServer / ProxyOverride /
// AutoConfigURL），不是环境变量 ⇒ 开了系统代理的机器上 codex 子进程等于没有代理（t-7）。
//
// 边界（设计档 §九，逐条落地）：
// - 只认 deps.platform === "win32"（**绝不用 process.platform 兜底**：任何没带 platform 的夹具
//   在任何机器上都「零读取」，测试与机器无关）。
// - 任何失败（reg.exe 不存在 / 被策略禁 / 超时 / 输出畸形）⇒ null，行为回到「没有代理」，
//   绝不把异常抛给调用方（fail-open 到现状）。
// - socks-only / 未知协议 ⇒ 告警且不注入（applied 形状固定 {https,http,noProxy}，没有 ALL_PROXY）。
// - PAC（AutoConfigURL）不求值 ⇒ 告警且不注入。
// - 环境里已有代理变量 ⇒ 用户环境优先，一个字节都不动。

import { execFileSync } from "node:child_process"

const WARN = (m) => console.warn("[thincoder-suite:codex] " + m)

/** 注册表路径常量（单一事实源：读取与测试夹具都从此处取）。 */
export const WINDOWS_PROXY_REG_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"

/** 结果缓存 TTL（D-3：60s 足够让用户改完设置后自愈；缓存不落盘，重启即丢）。 */
const CACHE_TTL_MS = 60000

/** reg.exe 读取超时（D-2：不阻塞 codex 任务；超时 ⇒ catch ⇒ null）。 */
const REG_QUERY_TIMEOUT_MS = 1500

/** 代理环境变量名（大小写各一份——Windows 上两者都可能被消费）。 */
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]

// 模块级状态（§七）：进程内缓存 + warn 恰一次记录。不落盘、无迁移。
let systemProxyCache = { raw: null, at: null }
let inheritedProxyWarned = false
const onceWarnings = new Set()

/** 测试专用：清缓存 + 清「warn 恰一次」记录（否则 warn 腿会因前一用例已消费而恒真）。 */
export function _resetSystemProxyCacheForTests() {
  systemProxyCache = { raw: null, at: null }
  inheritedProxyWarned = false
  onceWarnings.clear()
}

/** 当前时刻（deps.now 注入缝：支持函数与数字两种形态；缺省 Date.now）。 */
function nowOf(deps) {
  const n = deps && deps.now
  if (typeof n === "function") {
    const v = n()
    return Number.isFinite(v) ? v : Date.now()
  }
  return Number.isFinite(n) ? n : Date.now()
}

/** REG_DWORD 值解析（0x0 / 0x00000001 / 十进制）。畸形 ⇒ null。 */
function parseRegInt(raw) {
  if (typeof raw !== "string") return null
  const v = raw.trim()
  if (v === "") return null
  if (/^0x[0-9a-f]+$/i.test(v)) return parseInt(v.slice(2), 16)
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  return null
}

/**
 * reg query 文本 → 四个字段（**纯函数**，空/畸形文本不抛）。
 * 输入形态（reg.exe 的真实输出，键行顶格、值行缩进）：
 *
 *   HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 *       ProxyEnable    REG_DWORD    0x1
 *       ProxyServer    REG_SZ    127.0.0.1:7897
 *       ProxyOverride  REG_SZ    localhost;127.*;<local>
 *       AutoConfigURL  REG_SZ    http://wpad/proxy.pac
 *
 * @param {string|null|undefined} text
 * @returns {{proxyEnable: number|null, proxyServer: string|null, proxyOverride: string|null, autoConfigURL: string|null}}
 */
export function parseRegQueryOutput(text) {
  const out = { proxyEnable: null, proxyServer: null, proxyOverride: null, autoConfigURL: null }
  if (typeof text !== "string" || text === "") return out
  for (const line of text.split(/\r?\n/)) {
    // 只认「缩进 + 值名 + REG_类型 + 值」的值行；键路径行（顶格 HKEY_…）与空行跳过。
    const m = /^\s+(.+?)\s+(REG_[A-Za-z_]+)\s*(.*)$/.exec(line)
    if (!m) continue
    const name = m[1].trim()
    const value = m[3].trim()
    if (name === "ProxyEnable") out.proxyEnable = parseRegInt(value)
    else if (name === "ProxyServer") out.proxyServer = value === "" ? null : value
    else if (name === "ProxyOverride") out.proxyOverride = value === "" ? null : value
    else if (name === "AutoConfigURL") out.autoConfigURL = value === "" ? null : value
  }
  return out
}

/** 单个代理地址 → URL。显式 http(s):// 前缀保留；裸 host:port 按 http 代理补全。 */
function proxyHostToUrl(raw) {
  const v = String(raw ?? "").trim()
  if (v === "") return null
  const lower = v.toLowerCase()
  if (lower.indexOf("http://") === 0 || lower.indexOf("https://") === 0) return v
  // socks= / socks5:// / 其它协议 ⇒ 不在本批支持面（§三 非目标，评审 #1 定案 B）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return null
  if (v.indexOf(":") < 0) return null // 没有端口的裸主机不是合法代理地址
  // 注意：这里补 http:// 而不是 scheme:// —— 注册表里的 scheme 是**目标协议**，
  // 而 HTTP(S)_PROXY 的 URL scheme 是**与代理本身说话的方式**（Windows 系统代理一律是
  // HTTP 代理；写成 https:// 会变成对明文代理端口的 TLS 握手 ⇒ 必然连不上）。
  return "http://" + v
}

/**
 * 注册表的 ProxyServer → 单协议 URL（**纯函数**）。
 * 支持两种形态：单值 host:port（所有协议同址）与分协议 http=a;https=b（各取各的）。
 * 只认 http / https 两个协议名；socks= / 未知协议 ⇒ null（§九：socks-only 只告警不注入）。
 *
 * @param {string|null|undefined} serverSpec
 * @param {"http"|"https"} scheme
 * @returns {string|null}
 */
export function proxyUrlForScheme(serverSpec, scheme) {
  if (typeof serverSpec !== "string") return null
  const spec = serverSpec.trim()
  if (spec === "") return null
  const want = String(scheme ?? "").toLowerCase()
  if (want !== "http" && want !== "https") return null
  const entries = spec.split(";").map((s) => s.trim()).filter((s) => s !== "")
  if (entries.length === 0) return null
  const perScheme = entries.some((e) => e.indexOf("=") >= 0)
  if (!perScheme) return proxyHostToUrl(spec)
  for (const e of entries) {
    const i = e.indexOf("=")
    if (i < 0) continue
    if (e.slice(0, i).trim().toLowerCase() !== want) continue
    return proxyHostToUrl(e.slice(i + 1))
  }
  return null
}

/**
 * ProxyOverride → NO_PROXY（**纯函数**，规则见设计档 D-5）：
 * 分号→逗号 · <local> → loopback 列表 · 尾部 * 的 IP 前缀折成 CIDR
 * （127.* → 127.0.0.0/8，192.168.* → 192.168.0.0/16，172.16.* → 172.16.0.0/16，10.* → 10.0.0.0/8）·
 * 折不了的**原样保留**（多数工具认不出 127.* 这种写法）· 输出**去重且保序**（首次出现的顺序；
 * localhost 不得因「原文一条 + <local> 展开一条」出现两次）。
 *
 * @param {string|null|undefined} override
 * @returns {string|null} 空/无条目 ⇒ null（调用方据此不写 NO_PROXY）
 */
export function noProxyFromOverride(override) {
  if (typeof override !== "string") return null
  const items = []
  // 去重（**保序**：首次出现的顺序即输出顺序）。必要性（批 40 收口 · 设计档 §13.5 第 2 条）：
  // 真实的 ProxyOverride 常常既写 localhost、又写 <local> ⇒ 展开后 localhost 会重复两次。
  const seen = new Set()
  const add = (v) => { if (!seen.has(v)) { seen.add(v); items.push(v) } }
  for (const raw of override.split(";")) {
    const item = raw.trim()
    if (item === "") continue
    if (item.toLowerCase() === "<local>") {
      add("localhost")
      add("127.0.0.1")
      add("::1")
      continue
    }
    const m = /^(\d{1,3}(?:\.\d{1,3}){0,2})\.\*$/.exec(item)
    if (m) {
      const parts = m[1].split(".")
      const ok = parts.every((p) => {
        const n = Number(p)
        return String(n) === p && n >= 0 && n <= 255
      })
      if (ok) {
        const octets = parts.concat(new Array(4 - parts.length).fill("0"))
        add(octets.join(".") + "/" + (parts.length * 8))
        continue
      }
    }
    add(item) // 折不了 ⇒ 原样保留
  }
  return items.length === 0 ? null : items.join(",")
}

/** applied 的 https/http 双向回退（评审 N4）：两侧都空 ⇒ null（调用方按「解析失败」处理）。 */
function resolveAppliedPair(proxyServer) {
  const https = proxyUrlForScheme(proxyServer, "https") ?? proxyUrlForScheme(proxyServer, "http")
  const http = proxyUrlForScheme(proxyServer, "http") ?? https
  if (!https && !http) return null
  return { https: https ?? http, http: http ?? https }
}

/**
 * reg 文本 → 要注入的环境（**纯函数**；§六 伪代码逐行落地）。
 * @param {string|null|undefined} text
 * @returns {{applied: {https: string, http: string, noProxy: string|null}|null, warning: string|null}}
 */
export function systemProxyEnvFromReg(text) {
  const reg = parseRegQueryOutput(text)
  const PAC_WARNING = "系统代理是 PAC 脚本（AutoConfigURL），codex 通道无法自动使用 —— 请在 codexCli.proxyUrl 手动填地址"
  if (reg.proxyEnable !== 1) {
    // 没开代理 = 正常态；但只有 PAC 时如实告警（D-4：静默不注入会让用户再次掉进「为什么还是连不上」）
    if (reg.autoConfigURL) return { applied: null, warning: PAC_WARNING }
    return { applied: null, warning: null }
  }
  if (!reg.proxyServer) {
    // ProxyEnable=1 但地址在 PAC 里（真实 PAC 配置常是这个形态）⇒ 仍按 PAC 告警（设计档 §九）
    if (reg.autoConfigURL) return { applied: null, warning: PAC_WARNING }
    return { applied: null, warning: "系统代理已启用但 ProxyServer 为空 —— 忽略" }
  }
  const pair = resolveAppliedPair(reg.proxyServer)
  if (!pair) {
    // socks-only / 未知协议落这里（§九；applied 没有 ALL_PROXY 字段，不假装支持）
    return { applied: null, warning: "系统代理地址无法解析（只支持 http/https 代理；socks-only 或未知协议不注入）：" + reg.proxyServer }
  }
  return { applied: { https: pair.https, http: pair.http, noProxy: noProxyFromOverride(reg.proxyOverride) }, warning: null }
}

/** 默认读取：reg.exe（D-2：零依赖、Windows 自带、路径稳定）。任何失败向上抛给调用方 catch。 */
function defaultRegQuery() {
  return execFileSync("reg", ["query", WINDOWS_PROXY_REG_PATH], {
    encoding: "utf8",
    timeout: REG_QUERY_TIMEOUT_MS,
    windowsHide: true,
  })
}

/**
 * 唯一有副作用的读取（§六 伪代码）：reg.exe + 60s 缓存 + 注入缝（deps.regQuery / deps.now）。
 * 前置：deps 可含 { platform, regQuery, now }。
 * 后置：返回 reg 文本 | null；**任何失败 ⇒ null**（fail-open 到「没有系统代理」= 今天的行为）。
 * @param {{platform?: string, regQuery?: () => string, now?: number|(() => number)}} [deps]
 * @returns {string|null}
 */
export function readWindowsSystemProxyRaw(deps = {}) {
  // ★ 平台门控在最前（评审 #3 / N1）：只认 deps.platform === "win32"，绝不用 process.platform 兜底。
  //   任何没带 platform 的夹具 ⇒ 零读取（与机器无关）。
  if (!deps || deps.platform !== "win32") {
    systemProxyCache = { raw: null, at: null }
    return null
  }
  const now = nowOf(deps)
  if (systemProxyCache.at !== null && now - systemProxyCache.at < CACHE_TTL_MS) return systemProxyCache.raw
  let raw = null
  try {
    const read = typeof deps.regQuery === "function" ? deps.regQuery : defaultRegQuery
    const text = read()
    raw = typeof text === "string" ? text : null
  } catch {
    raw = null // reg.exe 不存在 / 被策略禁 / 超时 / 任何异常 ⇒ 今天的行为（不注入、不报错）
  }
  systemProxyCache = { raw, at: now }
  return raw
}

/** 环境里是否已有**任一**代理变量（空串不算——它不构成代理）。 */
function hasAnyProxyEnv(env) {
  for (const k of PROXY_ENV_KEYS) {
    const v = env[k]
    if (typeof v === "string" && v.trim() !== "") return true
  }
  return false
}

/**
 * inherit 分支的注入（§六 伪代码）。
 * 前置：env 是「已展开的环境变量」副本。
 * 后置：**任一**代理变量已存在 ⇒ 原样返回（applied=null, note="env"），不覆盖用户环境；
 *       任何异常路径都不抛给调用方（最坏回到「没有代理」）。
 * @param {Record<string, string>} env
 * @param {{platform?: string, regQuery?: () => string, now?: number|(() => number)}} [deps]
 * @returns {{env: Record<string,string>, applied: {https: string, http: string, noProxy: string|null}|null, warning: string|null, note: string}}
 *          note 是三态字面的**去前缀**部分：env / none / system(url)（FR-3 的 proxy= 由调用方拼）。
 */
export function applyInheritedSystemProxy(env, deps = {}) {
  const base = env && typeof env === "object" ? env : {}
  // 用户环境优先（D-1）：环境里已有代理 ⇒ 一个字节都不动
  if (hasAnyProxyEnv(base)) return { env: base, applied: null, warning: null, note: "env" }
  let raw = null
  try {
    raw = readWindowsSystemProxyRaw(deps)
  } catch {
    raw = null
  }
  let r
  try {
    r = systemProxyEnvFromReg(raw)
  } catch {
    r = { applied: null, warning: null }
  }
  const warning = r && r.warning ? String(r.warning) : null
  if (warning && !onceWarnings.has(warning)) {
    onceWarnings.add(warning)
    WARN(warning)
  }
  const applied = r && r.applied ? r.applied : null
  // N4 守卫：两侧都空 ⇒ 视为没读到（绝不写一个半截环境）
  if (!applied || (!applied.https && !applied.http)) {
    return { env: base, applied: null, warning, note: "none" }
  }
  const https = applied.https || applied.http
  const http = applied.http || applied.https
  base.HTTPS_PROXY = https
  base.https_proxy = https
  base.HTTP_PROXY = http
  base.http_proxy = http
  if (applied.noProxy) {
    base.NO_PROXY = applied.noProxy
    base.no_proxy = applied.noProxy
  }
  // D-6：成功注入必留痕——每进程恰一次（评审 #6 上腿：T-P4 ③）
  if (!inheritedProxyWarned) {
    inheritedProxyWarned = true
    WARN("继承系统代理：HTTPS_PROXY=" + https + "（来源：Windows 系统设置）")
  }
  return { env: base, applied: { https, http, noProxy: applied.noProxy ?? null }, warning: null, note: "system(" + https + ")" }
}
