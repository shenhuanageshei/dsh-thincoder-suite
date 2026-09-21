# 会诊纪要 —— consult #63（原始层，机制落盘）

- 日期：2026-09-21
- 会诊 id：63
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, fangzhou-codingplan:kimi-k3
- 平台 job：consult-2
- 结果：4/4 交付（其中 4 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #63 finished — 4 of 4 replied (0 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #63 finished — 4 of 4 replied (0 failed)]
effective: 4 of 4 (0 failed · 0 without content)
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, fangzhou-codingplan:kimi-k3
job: consult-2
minutes: docs/consult-minutes/2026-09-21-consult-63-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] fangzhou-codingplan:kimi-k3 — ok
方案已成型，全部依据本机核实过的行级事实。以下是待评审的修复方案。

```dsh-ui
{"title":"修复方案：/thincoder-suite/api 接入 requestRejection 栅栏","gap":14,"items":[{"type":"callout","tone":"success","title":"设计定型：opts 钩子注入 + 请求时惰性解析 + fail-closed","content":"鉴权钩子做成 `makeApiHandler` 的显式参数 `opts.requestRejection(req)`（测试缝显式化），由生产唯一注册入口 `registerConfigApi` 注入；闭包内每次请求经 `ctx.get?.(\"connection\")` 惰性解析——cordis 文档确认 `ctx.get` 在服务未就绪时返回 undefined（cordis/lib/index.js:760），==不存在启动顺序陷阱==；解析不到 connection → 拒绝 503 + warn-once，绝不放行。"},{"type":"steps","steps":[{"title":"① makeApiHandler 加门（lib/index.mjs:594 handler 顶部）","desc":"`const rejection = opts?.requestRejection?.(req)`；返回非 undefined → `send({ok:false,error}, rejection)` 直接应答，不进任何路由分支。opts 无钩子 → 跳过（仅测试直调场景，注释写明）。"},{"title":"② registerConfigApi 注入钩子（lib/index.mjs:750）","desc":"闭包内定义 requestRejection：惰性 `ctx.get?.(\"connection\")` → 有则转发 `connection.requestRejection(req)`（403 Host/Origin 栅栏 / 401 浏览器鉴权，dsh-client-connection/lib/index.js:553 契约原样透传）；无则 503 + 进程内 warn-once（沿用 :776 warnDeprecatedTokenSecretEnvOnce 先例）。"},{"title":"③ 不改 inject 列表（lib/index.mjs:52 维持现状）","desc":"connection 不进 inject——否则无 connection 服务的 profile 整个插件起不来，违反 U8「host 功能不依赖 webServer」纪律。惰性 ctx.get 与 :1231 agents、:1251 settings 的既有插件惯用法同款。"},{"title":"④ 新增测试 + 文档同步","desc":"test/config-api.test.mjs 加 4 个用例（见下表）；design doc :86/:161「loopback 信任模型」改写为「已接 requestRejection，理由：DNS rebinding 下同源化」；README:210 端点清单补「需浏览器鉴权」；:1230 注释同步。"}]}]}
```

## 关键代码形态（示意，待你评审后落地）

```diff
 export function makeApiHandler(ctx, opts) {
   const baseConfig = opts?.baseConfig ?? {}
   return async (req, res) => {
     const send = (obj, code = 200) => { ... }
+    // 信任栅栏（生产路径由 registerConfigApi 注入；直连 handler 的测试不含此 opts → 跳过）
+    const rejection = opts?.requestRejection?.(req)
+    if (rejection !== undefined) return send({ ok: false, error: "request rejected (" + rejection + ")" }, rejection)
     try {
       const url = new URL(req.url ?? "/", "http://localhost")
       ...
```

```diff
 export function registerConfigApi(ctx, opts) {
   if (!ctx?.webServer || typeof ctx.webServer.register !== "function") { ...return null }
+  let warnedNoConnection = false
+  // 每次请求惰性解析：规避 apply 时 connection 未就绪的误杀；缺席 = 无法核验信任 → fail-closed
+  const requestRejection = (req) => {
+    const conn = (() => { try { return ctx.get?.("connection") ?? null } catch { return null } })()
+    if (!conn || typeof conn.requestRejection !== "function") {
+      if (!warnedNoConnection) { warnedNoConnection = true
+        console.warn("[thincoder-suite] connection service unavailable — config API failing closed (503)") }
+      return 503
+    }
+    return conn.requestRejection(req)
+  }
   return ctx.webServer.register({
     kind: "prefix", path: CONFIG_API_PREFIX,
-    handler: makeApiHandler(ctx, opts),
+    handler: makeApiHandler(ctx, { ...opts, requestRejection }),
   })
 }
```

## 测试影响盘点

| 对象 | 现状 | 方案下 | 依据 |
|---|---|---|---|
| ~10 处 `makeApiHandler({}, …)` 直调（codex-runner ×7、config-api ×3、context-budget/session-state 各 1） | 无 opts.requestRejection | ==零改动==，钩子缺席 → 跳过 | 逐处 grep 核实 |
| `U8a`/`U8b`（config-api.test.mjs:701/:719） | ctx 无 `get` | ==零改动==：U8b 只注册不调 handler；即使调也是 503 而非崩 | 已读全两个用例 |
| 新增用例 ×4 | — | 401 透传 / 403 透传 / 拒绝先于路由逻辑（PUT 非法 JSON 得 401 而非 400）/ connection 缺席 → 503 + warn 恰好一次 | 挂在 U8 区块后 |

## 已排除的备选（附理由）

- **`inject` 加 `"connection"`**：无 connection 的 profile 插件整体拒起，违反 U8 —— 排除。
- **注册期门控（`ctx.inject(["connection","webServer"], …)`，api-gateway:457 先例）**：要改 `registerConfigApi` 同步返回 disposer 的签名与 U8b 测试，且 apply 时序下无误杀保护收益（请求时惰性解析已覆盖）—— 排除，收益不配改动面。
- **「warn + 放行」**：web profile 里静默失守，与本插件「绝不静默降级」纪律冲突 —— 排除（与主会话结论一致）。
- **裸 `res.end()`（open-in-app:1321 形态）**：设置页 `fetchJson`（client.js:72）无条件 `r.json()`，空体会落成 `Unexpected end of JSON input` 误导错误 —— 改用本 API 自己的 JSON 约定 `{ok:false}`。

## 复验步骤（实施后）

1. `node --test` 全量（重点 config-api / codex-runner / context-budget / session-state 四文件）。
2. 活体验证矩阵：无 token → 401；`Host: evil.example` → 403；带 cookie 同源 → 200；PUT 非法 JSON 无 token → 401（不再是 400，证明门在路由前）。
3. 设置页真实打开一次，确认加载/保存正常（同源 + cookie，预期无感）。

## 留给你拍板的三处

1. **connection 缺席的状态码**：我取 503（信任无法核验，语义最准）；你若想更硬可换 403。
2. **拒绝应答体**：我取 JSON `{ok:false}`（对齐 §3.2 与客户端解析）；若想与平台先例完全对齐可换裸 end，代价是设置页报错文案变丑。
3. **版本与发版**：package.json 0.29.0 是否随本修复 bump（建议 0.29.1 + CHANGELOG 一条），还是攒批。

评审通过后我按「①→②→④测试→文档→复验」顺序落地，一次提交。

[2] zai-coding-cn:glm-5.3 — ok
会诊完成。我把三处平台先例、栅栏语义、注入方式、测试面、文档钉点全部独立核实过了，**没有改动任何文件**——以下是供评审的修复方案。

---

## 修复方案（评审稿）

**一句话**：在 [lib/index.mjs:592](lib/index.mjs#L592) `makeApiHandler` 返回的 handler 闭包最前面加一道 `connection.requestRejection` 栅栏，服务经 `ctx.get("connection")` 每请求懒取；服务缺席 → **503 fail-closed + 一次性 warn**。不改 `inject` 数组，不动 `registerConfigApi` 结构。

```dsh-ui
{"title":"thincoder-suite API 鉴权修复 — 会诊方案","gap":14,"items":[{"type":"callout","tone":"success","title":"推荐设计 R：handler 内单一咽点","content":"栅栏放在 `makeApiHandler` 闭包首部：8 个端点 + 未来新增**自动继承**，不存在「忘包一层」。每请求 `ctx.get(\"connection\")` 懒取——服务晚于插件启动也不怕；与 `cwdHintOf`（lib/index.mjs:74）既有模式同款。"}, {"type":"table","columns":["维度","R：handler 内栅栏（推荐）","G：ctx.inject 门控注册"],"rows":[["服务缺席时","503 + 一次性 warn（可观测、留痕）","路由不注册 → 404，无日志（静默）"],["未来新端点","自动继承栅栏","忘走包装即重新裸奔"],["改动面","makeApiHandler 一处 ~15 行","apply() 注册结构重排"],["测试","11 处补 stub + gate 单测","现有测试不动，但 gate 无单测入口"],["同栈先例","open-in-app rejected()（per-request）","api-gateway"]]}, {"type":"steps","steps":[{"title":"加栅栏","desc":"makeApiHandler 闭包首部：requestRejection → 401/403；connection 缺席 → 503 fail-closed + warn 一次"},{"title":"补测试","desc":"11 处 makeApiHandler({},→authCtx()) stub；新增 4 个 gate 用例；node --test 全量"},{"title":"同步文档","desc":"settings-ui-design.md:86/:161 旧声明 + README.md:210 + JSDoc"},{"title":"真机复验","desc":"无 cookie→401；evil Host→403；设置页全链路 200"}]}]}
```

### 补丁草图（lib/index.mjs:592 起）

```js
export function makeApiHandler(ctx, opts) {
  const baseConfig = opts?.baseConfig ?? {}
  return async (req, res) => {
    const send = (obj, code = 200) => { /* 原样 */ }
    // ——— 鉴权栅栏：先于一切业务逻辑（平台契约 dsh-host-webserver/README.md:113：
    //     路由所有者自管请求策略；同栈先例 dsh-client-connection register() 自有
    //     prefix 路由同款 gate、open-in-app rejected() per-request 懒取）———
    const conn = (() => { try { return ctx?.get?.("connection") ?? null } catch { return null } })()
    let rejection
    if (conn && typeof conn.requestRejection === "function") {
      rejection = conn.requestRejection(req)   // 403 Host/Origin 栅栏 | 401 未认证 | undefined 放行
    } else {
      warnConnectionMissingOnce()               // 一次性留痕（先例：deprecatedSecretEnvWarned，lib/index.mjs:769）
      rejection = 503                           // fail-closed：无栅栏绝不放行
    }
    if (rejection !== undefined) {
      return send({ ok: false, error: rejection === 401 ? "unauthorized"
        : rejection === 403 ? "forbidden" : "connection service unavailable" }, rejection)
    }
    try { /* 原逻辑一行不动 */ }
```

关键语义（均已核实）：`requestRejection(request)` 是**同步**的，返回 `403 | 401 | undefined`（[dsh-client-connection/lib/index.js:553](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js#L553)）；Host 栅栏在 [：201](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js#L201) 同时挡 `sec-fetch-site: cross-site` 与异源 `Origin`——DNS rebinding 场景 Host=attacker.example 直接 403，正好封住「绑 127.0.0.1 ≠ 安全」的口子。错误体用 JSON 是为了让设置页 `fetchJson`（[lib/client.js:68](lib/client.js#L68)）的 `r.json()` 统一解析。

### 两个关键决策的理由

1. **不把 `connection` 加进 [inject 数组（lib/index.mjs:52）](lib/index.mjs#L52)**：`webServer` 已是 required，`connection` 若也 required，任何「有 webServer 无 client-connection」的组合会**整个插件不启动**——advisor/eng/escalate/consult 四个 host 工具全失。主体功能是 host 工具，不能为 web 附属面陪葬（open-in-app 敢 required 是因为它整个功能就是 web 的）。
2. **fail-closed 503 而非 warn+放行**：与主代理判断一致——「服务取不到必须留痕、绝不静默降级」是本插件既有纪律；503 比门控注册的 404 更可观测（能区分「路由在但服务缺」与「无此路由」）。

### 测试计划

- **更新 11 处直调**（`{}` → `authCtx()`，`authCtx = (r = undefined) => ({ get: (n) => n === "connection" ? { requestRejection: () => r } : undefined })`）：
  [config-api.test.mjs:767](test/config-api.test.mjs#L767)、[:823](test/config-api.test.mjs#L823)、[:860](test/config-api.test.mjs#L860)；[codex-runner.test.mjs:784](test/codex-runner.test.mjs#L784)、[:816](test/codex-runner.test.mjs#L816)、[:831](test/codex-runner.test.mjs#L831)、[:1593](test/codex-runner.test.mjs#L1593)、[:3411](test/codex-runner.test.mjs#L3411)、[:3460](test/codex-runner.test.mjs#L3460)；[context-budget.test.mjs:552](test/context-budget.test.mjs#L552)；[session-state.test.mjs:792](test/session-state.test.mjs#L792)
- **新增 gate 用例**（放 config-api.test.mjs，沿用 [:771-778](test/config-api.test.mjs#L771-L778) 现有伪造 req/res harness）：① `rejection=401` → 401 + PUT 路径**盘字节不变**（T-D31 判据风格，证明栅栏先于业务逻辑）② `rejection=403` → 403 ③ `{}` 无 connection → 503 + `console.warn` 恰好一次 ④ U8a/U8b 不改仍绿（栅栏不动 `registerConfigApi` 的 webServer 检查，U8b 构造时不触服务）
- `node --test` 全量回归（`package.json` scripts.test）

### 文档同步（实现与描述同批改）

[docs/2026-09-02-settings-ui-design.md:86](docs/2026-09-02-settings-ui-design.md#L86)「loopback 信任模型」与 [:161](docs/2026-09-02-settings-ui-design.md#L161)「webServer 路由无鉴权」风险条目改为栅栏语义；[README.md:210](README.md#L210) 端点清单补一句鉴权（401/403/503）；`makeApiHandler` JSDoc（lib/index.mjs:586-591）——ctx 参数此前**实际未被使用**，如今真正承担栅栏，注释同步。

### 真机复验清单（评审通过、实现后执行）

无 cookie `GET /config` → 401；`Host: evil.example` → 403；浏览器设置页加载/保存/清空全链路 200（同源自动带 cookie）；`node --test` 全绿。代码改动会自动存快照，改错可 undo 回退。

### 遗留（不在本批）

- `dsh-super-injector` 同款缺陷（prefix 路由无栅栏）——另行报障；
- `POST /apply-session` 不校验 Content-Type：栅栏落地后无安全影响（跨站/rebound 请求死在 403），纯规范性问题可不动。

**改动规模**：lib/index.mjs +~15 行；测试 5 文件 11 处 stub + 新增 ~60 行；文档 3 处。等你评审——批了我就按此实施。

[3] deepseek-official:deepseek-v4-pro — ok
核实完毕，方案所需的所有事实我已独立读码确认（cordis `ctx.get`/`ctx.inject` 语义、`dsh-client-connection.requestRejection` 的两段式逻辑、`dsh-host-open-in-app` 的 `rejected()` 先例、`dsh-api-gateway` 的门控注册先例、插件全部 11 处 `makeApiHandler({}, …)` 测试调用点、client.js 消费面）。以下是修复方案，供评审。

# 修复方案：`/thincoder-suite/api/*` 接入宿主 requestRejection 栅栏

## 0. 方案结论（一页版）

**双层 fail-closed，不碰 `inject` 列表，不动 client.js：**

| 层 | 位置 | 动作 | 效果 |
|---|---|---|---|
| Gate 1 注册门控 | [lib/index.mjs](lib/index.mjs) `apply()` :1247 一带 | 改用 `ctx.inject(["connection","webServer"], …)` 门控注册（[dsh-api-gateway](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js) :457 同款先例）；connection 缺席 → 路由**不注册** + `console.warn` | 无栅栏宿主：404 + 留痕，host 工具不受影响 |
| Gate 2 请求栅栏 | `makeApiHandler` :592 | 每个请求先 `connection.requestRejection(req)`：403（Host/Origin 越界）/ 401（无会话 cookie）/ undefined（放行）；connection 缺失 → 全端点 **503** `{ok:false}` | 修掉漏洞本体（同 `open-in-app` :1317 `rejected()` 先例） |

**核心事实链（已独立复读）**：`dsh-client-connection` 的 `requestRejection`（:553）= `isTrustedApiRequest` Host/Origin/`sec-fetch-site` 栅栏（:201）→ 403，再 `browserAuth.isAuthenticated` 权威绑定签名 cookie `dsh-auth-*`（:431）→ 401。设置页请求同源带 cookie，理论不受影响，但**真实页面复验是发版门槛**。

## 1. 代码改动（lib/index.mjs，共 3 处）

**① `makeApiHandler`（:592-594）** — 在创建处取一次栅栏，缺则返回 fail-closed handler：

```js
const connection = ctx?.connection ?? null
const fence = connection && typeof connection.requestRejection === "function" ? connection : null
if (!fence) {
  console.warn("[thincoder-suite] config API handler created without connection fence — all requests fail-closed (503)")
  return async (_req, res) => { res.writeHead(503, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ ok: false, error: "auth fence unavailable (fail-closed)" })) }
}
return async (req, res) => {
  const rejection = fence.requestRejection(req)   // 原始 Node req 透传——Host/Origin/Cookie 头直达栅栏
  if (rejection !== undefined) return send({ ok: false, error: "rejected by host request fence", status: rejection }, rejection)
  …（现有全部业务逻辑不动）
}
```

拒绝响应用 `send()` 发 JSON（与本插件「全端点 JSON 往返」契约一致；`client.js:68` 的 `fetchJson` 无条件 `r.json()`，空 body 反而会抛解析错）。

**② `registerConfigApi`（:750-760）** — 加 connection 前置检查（webServer 检查保留）：

```js
const connection = ctx?.connection ?? null
if (!connection || typeof connection.requestRejection !== "function") {
  console.warn("[thincoder-suite] connection service unavailable — settings config API routes NOT registered (fail-closed; host tools unaffected)")
  return null
}
```

**③ `apply()`（:1246-1270）** — 门控注册 + 状态行修正：

```js
const probe = (name) => { try { return typeof ctx.get === "function" ? ctx.get(name) : ctx[name] } catch { return undefined } }
const apiReady = !!(probe("webServer") && probe("connection"))
if (probe("webServer") && !probe("connection"))
  console.warn("[thincoder-suite] connection service unavailable — settings config API routes NOT registered (fail-closed; host tools unaffected)")
const apiDispose = typeof ctx.inject === "function"
  ? (() => { const apiFiber = ctx.inject(["connection", "webServer"], (webCtx) => {
        const d = registerConfigApi(webCtx, opts); return () => { try { d?.() } catch { /* disposed */ } } })
      return () => { try { apiFiber.dispose?.() } catch { /* disposed */ } } })()
  : registerConfigApi(ctx, opts)   // 测试 fakeCtx（无 inject）回落直调，registerConfigApi 自检 fail-closed
if (apiDispose) disposes.push(apiDispose)
// :1270 状态行改用 apiReady："+ config api (connection-fenced)" / "config api not registered (fence unavailable)"
```

依据：cordis `ctx.get(name)` 对未提供服务**返回 undefined 不抛**（cordis :762-764）；`ctx.inject(deps, cb)` 返回 fiber，`fiber.dispose()` 可用（cordis :1599/:1569）；`cb` 返回函数即 fiber 的 disposer。

## 2. 测试改动

**既有调用点（共 12 处，全部机械改：`makeApiHandler({}` → `makeApiHandler({ connection: { requestRejection: () => undefined } }`）**：

| 文件 | 行 |
|---|---|
| codex-runner.test.mjs | 784 · 816 · 831 · 1593 · 3411 · 3460 |
| config-api.test.mjs | 767 · 823 · 860（另 :722 U8b 的 `registerConfigApi` ctx 需补 connection stub） |
| context-budget.test.mjs | 552 |
| session-state.test.mjs | 792 |

**新增 `test/api-auth.test.mjs`（7 用例）**：AUTH-1 connection 缺失 → GET/PUT 全 503 + `ok:false` + 盘不动；AUTH-2 栅栏返 403 → 403 且 PUT 不触达业务逻辑（盘字节不变）；AUTH-3 栅栏返 401；AUTH-4 栅栏放行 → 业务 200 正常；AUTH-5 handler 把**原始 req 同一引用**交给 `requestRejection`；AUTH-6 `registerConfigApi` 有 webServer 无 connection → null + warn（U8c）；AUTH-7 `apply()` 门控：有 `inject` 的 fakeCtx → 断言 deps 为 `["connection","webServer"]` 且回调内注册；无 `inject` 的 fakeCtx → 回落直调不抛（保护 session-state/stages/codex-runner/design-review-guard/consult 5 个文件里所有 `apply(fakeCtx, …)` 接线用例——它们都没 `inject`）。

## 3. 文档改动（描述面与实现同步）

- `docs/2026-09-02-settings-ui-design.md:78`（注册形态）、`:86`（handler 鉴权条目重写为 connection 栅栏）、`:155`（U8 验收扩展 webServer/connection 双缺失）、验收表加 U10（401/403/503 三态）、`:161`（风险表「webServer 路由无鉴权」条目改记为已修复——原「loopback 信任模型」前提已证伪：DNS rebinding 下同源伪装成立）。
- `README.md:210` 补一句：该前缀受宿主 requestRejection 栅栏保护（无会话 cookie → 401，跨站/非受信 Host → 403）。
- `lib/index.mjs:50-52`、`:746-748`、`:586-591` 注释同步。
- 按仓库惯例在缺陷登记表（`docs/2026-09-05-defect-registry.md` 系列）记一条本次安全修复（D-xx 续号，编号待实施时定）。

## 4. 验证矩阵（实施后）

| 项 | 命令/动作 | 期望 |
|---|---|---|
| 全量回归 | `node --test`（[package.json:32](package.json)） | 全绿 |
| 无 token | `curl /thincoder-suite/api/config` | **401**（改前 200） |
| 恶意 Host | `curl -H "Host: evil.example" …/config` | **403**（改前 200） |
| 控制组 | `curl /`、`/open-in-app/apps` | 仍 401/403（不回归） |
| **发版门槛** | 真实 GUI 打开 Thincoder 设置页：config/catalog/session 拉取、保存 PUT、apply-session | 全 200（cookie 生效） |
| 日志 | 重启后 | `+ config api (connection-fenced)` |

## 5. 取舍与风险（评审点）

1. **不采用「connection 缺席 → warn 再放行」**：那等于静默失守，且与本插件「服务取不到必须留痕、绝不静默降级」纪律冲突。本方案缺席即 404/503，写路径零暴露。
2. **不把 "connection" 加进 `inject` 列表**：避免让无 connection 的宿主整个插件起不来（工具功能无谓受损）；`ctx.inject` 门控同时覆盖 connection 迟绑定场景。
3. **已排查无被误伤方**：全仓（插件 lib + web profile node_modules）grep 无任何服务端/脚本消费 `thincoder-suite/api`；client.js 的「复制命令」降级（:704-718）复制的是**对话内 slash 命令**，不是 curl，不受 401 影响。
4. **旧洞一并关闭**：`POST /apply-session` 曾可借 `text/plain` 简单请求绕过 CORS 预检——修复后不依赖预检，`sec-fetch-site`/Origin/Host 在栅栏内直接 403。
5. **客户端理论自洽**：同源 `fetch` 默认带 cookie，client.js 无需改；但浏览器行为以真实页面复验为准，未复验不发版。
6. **范围外**：`dsh-team-link` 不动（按您要求）；`dsh-super-injector` 同款缺陷不在本方案（文档引用处仅标注其非范本）。

方案到此为止、**不动手**，等您评审。批准后按「①改 lib → ②改 12 处测试 + 新增 api-auth 测试 → ③改文档 → ④`node --test` → ⑤重启 + 真实页面复验」顺序实施。

[4] codex-cli:gpt-6-astra — ok
会诊结论：必须修复 `/thincoder-suite/api/*` 的鉴权缺口，并采用 fail-closed。

建议方案：

1. 保持 `webServer` 可选注册，不把 `connection` 加入模块级 `inject`，避免整个插件被服务依赖绑死。
2. API handler 每次请求实时读取 `ctx.get("connection")`。
   - 服务缺失或没有 `requestRejection`：返回 503，立即结束。
   - `requestRejection(req)` 返回 403/401：直接返回对应状态，不解析 URL、读文件、访问 LLM 或执行写操作。
   - 返回 `undefined` 后才进入现有业务逻辑。
3. 401/403 响应与宿主 `dsh-client-connection` 契约一致；缺服务的 503 留一次警告并拒绝服务。
4. 补测试：
   - 恶意 Host/Origin → 403，业务探针未执行。
   - 合法 Host、无登录 cookie → 401，业务探针未执行。
   - 合法已认证请求 → 原有 GET/PUT/POST 行为不变。
   - 缺少 connection 或缺少 `requestRejection` → 503。
   - 迁移现有约 13 处 `makeApiHandler({}, …)` 测试夹具，显式提供允许请求的 connection stub。
5. 更新设置页设计文档：删除“loopback 即信任、远程暴露才需鉴权”的表述，改为宿主统一 Host/Origin 与浏览器会话门控；服务不可用时 fail-closed。
6. 验证：先运行新增失败测试，再实现；随后运行 `node --test` 全量回归，并复验真实设置页同源请求。
```

## §2 逐问裁定（**主代理写**）

> 口径：每条回复的**每项主张恰一条**处置——采纳 / 不采纳（**必附理由**）/ 待定。计数取自父侧实测（§3 D-0），不采信任何一席的自报估值。

### §2.1 [1] `fangzhou-codingplan:kimi-k3` — 处置：**采纳 4 条 / 不采纳 2 条 / 待定 1 条**（共 7 条）

| # | 它主张什么 | 处置 |
|---|---|---|
| **[1]-1** | 请求期**惰性** `ctx.get(connection)` 解析（引 cordis:760：未就绪返回 undefined，"不存在启动顺序陷阱"） | **采纳** —— 父侧独立读到 cordis `get(name, strict = true)` 的 JSDoc 原文「Read a service from the store **without the inject requirement**」（`cordis/lib/index.js:762-764`） |
| **[1]-2** | 解析不到 connection → **503 + warn-once，绝不放行** | **采纳**（4/4 一致；落为 D-4） |
| **[1]-3** | 鉴权钩子做成 `opts.requestRejection`，由 `registerConfigApi` 注入；**handler 侧无钩子即跳过**（自述"仅测试直调场景"） | **不采纳（附理由）**：这是**默认 fail-open** 的形态——任何不经 `registerConfigApi` 创建 handler 的路径会**静默无门**，而本次修的正是"漏做一步"。安全默认必须反过来：门在 handler 内**无条件**，测试侧显式提供 stub ctx，把**放行**写成白纸黑字（D-3） |
| **[1]-4** | **不把 `connection` 加进模块级 `inject` 列表**（否则无 connection 的 profile 整个插件起不来，四个 host 工具陪葬） | **采纳**（4/4 一致；落为 D-2） |
| **[1]-5** | 现有 11 处直调**零改动**（钩子缺席 → 跳过） | **不采纳（附理由）**：随 [1]-3 一并否掉——"零改动"恰建立在"门可以缺席"之上，是本方案要消灭的形态。且夹具面实测为 **12 处**（D-0-1） |
| **[1]-6** | 排除四项：①静态 inject ②`ctx.inject` 门控注册 ③warn + 放行 ④裸 `res.end()`（`client.js:72` 无条件 `r.json()`，空体抛 `Unexpected end of JSON input`） | **采纳**（四项父侧复核同意；②另附独立理由，见 D-1） |
| **[1]-7** | 留待拍板：缺服务取 503 还是 403；拒绝体 JSON 还是裸 end；`0.29.1` + CHANGELOG 是否随本修复 bump | **待定**（前两项父侧已裁定：503 + JSON，见 D-4 / D-5；版本号属用户裁决，见 D-6） |

### §2.2 [2] `zai-coding-cn:glm-5.3` — 处置：**采纳 8 条 / 部分采纳 1 条 / 待定 1 条**（共 10 条）

| # | 它主张什么 | 处置 |
|---|---|---|
| **[2]-1** | 设计 R：门放 `makeApiHandler` 闭包首部，8 个端点 + 未来新增**自动继承** | **采纳**（= 父侧裁定 D-1） |
| **[2]-2** | R/G 对照：G（注册期门控）服务缺席 → 路由不注册 → **404 且无日志**（静默，比 503 更不可观测） | **采纳**（作为 D-1 的加分证据） |
| **[2]-3** | 补丁草图：闭包内 `ctx.get` 懒取；`warnConnectionMissingOnce()` 沿用 :769 `deprecatedSecretEnvWarned` 先例 | **采纳并细化**：warn 标记改放 **handler 闭包内**（随实例生命周期），不用模块级全局——理由见 D-3 注 |
| **[2]-4** | 不进 inject；fail-closed 503 而非 warn + 放行 | **采纳** |
| **[2]-5** | 11 处直调改 `authCtx()` stub（逐行点名）+ 4 个新用例 | **部分采纳**：11 处直调点名**与父侧实测完全一致**；**但总数应为 12**——它漏掉 `test/design-review-guard.test.mjs` 的 `apply()` + 捕获路径（D-0-1） |
| **[2]-6** | 新用例断言：`rejection=401` 时 PUT 路径**盘字节不变**（证明门先于业务逻辑） | **采纳**（落为 D-3 的验收判据） |
| **[2]-7** | `{}` 无 connection → 503 + `console.warn` **恰好一次** | **采纳** |
| **[2]-8** | `makeApiHandler` 的 `ctx` 参数**此前实际未被使用**，如今真正承担栅栏 ⇒ JSDoc 同步 | **采纳**（父侧复核：:588 JSDoc 已写"webServer/settings/agents 经 get 取"，:1231 agents / :1251 settings 确有 `ctx.get` 惯例，但 `makeApiHandler` 函数体内确实一处未用 `ctx`） |
| **[2]-9** | 文档同批：design doc :86/:161 改判 + README:210 补鉴权 | **采纳**（并入 D-6 写域） |
| **[2]-10** | 遗留：super-injector 另行报障；`POST` 不校验 Content-Type 纯规范性问题可不动 | **待定**（超范围项，见 D-6）。**★ 2026-09-21 父侧订正：super-injector 的「报障」撤销**——该插件在本部署**未装配**（活体探测 `/super-injector/api` ⇒ 404）⇒ **零实况暴露**；按**用户 2026-09-21 裁定**收口为「**第三方插件 + 已不启用 ⇒ 不在本仓跟踪范围**」（只登记事实，零义务；原引的 `:7020` 是脚手架模板，真路由 `:9633-9635`） |

### §2.3 [3] `deepseek-official:deepseek-v4-pro` — 处置：**不采纳 4 条 / 部分采纳 1 条 / 采纳 3 条**（共 8 条）

| # | 它主张什么 | 处置 |
|---|---|---|
| **[3]-1** | **双层**：Gate1 `ctx.inject(["connection","webServer"], …)` 门控注册 + Gate2 请求栅栏 | **不采纳（附理由）**：Gate1 技术上成立（`ctx.inject` 正是为异步服务就绪而设），但**收益不配改动面**——Gate2 的 fail-closed 503 已把"无栅栏即无服务"封死，Gate1 的边际收益只是把 503 换成 404（且如 [2]-2 所指出：404 无日志，**更不可观测**）；代价是 apply() 结构重排、`registerConfigApi` 契约变化、U8 降级语义改写、disposer 接线、fakeCtx 的 `typeof ctx.inject` 回落与状态行——六处并发改动（详见 D-1） |
| **[3]-2** | `makeApiHandler` **创建处**取一次 `const connection = ctx?.connection ?? null`，缺则返回 503-only handler | **不采纳（附理由，且实测为缺陷）**：① `ctx.connection` 属性读在 cordis 里**会抛**——插件 `inject` 列表（lib/index.mjs:52）不含 connection，代理陷阱抛 `cannot get property "connection" without inject`（`cordis/lib/index.js:675`）；正确形态是 `ctx.get("connection")`（不经 inject，:762），而它的片段没有 try/catch。② 创建时快照严格劣于请求期惰性解析（服务晚就绪 / HMR 重载） |
| **[3]-3** | `registerConfigApi` 加 connection 前置检查 → 缺席 return null + warn | **不采纳**（G 路线同族，见 D-1；且会改 U8a/U8b 的降级契约，收益为零——请求期门已覆盖） |
| **[3]-4** | apply() 探针 + 门控注册 + 状态行 | **不采纳**（随 [3]-1） |
| **[3]-5** | 12 处夹具补显式 stub + 新增 `test/api-auth.test.mjs` 7 用例（AUTH-1..7） | **部分采纳**：**用例清单采纳**（AUTH-1/2/3/4/5/6 并入 D-3 的测试面，含"handler 把**原始 req 同一引用**交给栅栏"；AUTH-7 随 Gate1 弃）；**计数不采纳**——12 这个数它算的是"11 直调 + U8b `registerConfigApi`"，而本设计下 U8b **不需要改**，真正漏掉的是 design-review-guard 的 apply 捕获路径（D-0-1） |
| **[3]-6** | 文档同批 + 缺陷登记表记一条 D-xx | **采纳**（登记表文件存在：`docs/2026-09-05-defect-registry.md`） |
| **[3]-7** | 真机验证矩阵 + **真实 GUI 复验作为发版门槛** | **采纳**（落为 D-6 与 §5-2） |
| **[3]-8** | 已排查无被误伤方：全仓 grep 只有 client.js 消费；"复制命令"复制的是对话内 slash 命令而非 curl | **采纳**（父侧独立 grep 复核同结论，见 D-0-4） |

### §2.4 [4] `codex-cli:gpt-6-astra` — 处置：**采纳 5 条 / 部分采纳 1 条**（共 6 条）

| # | 它主张什么 | 处置 |
|---|---|---|
| **[4]-1** | 必须修复，且采用 fail-closed | **采纳** |
| **[4]-2** | 每请求实时 `ctx.get("connection")`；缺席或没有 `requestRejection` → 503；403/401 直接返回且**不解析 URL / 不读文件 / 不访问 LLM / 不执行写操作** | **采纳**（"不触碰业务面"落为门的验收基准，D-3） |
| **[4]-3** | 401/403 与宿主契约一致；503 留一次告警并拒服务 | **采纳**（状态码并入 D-4） |
| **[4]-4** | 测试：恶意 Host/Origin→403 且业务探针未执行；合法 Host 无 cookie→401；已认证→原行为不变；缺服务/缺方法→503；**迁移现有约 13 处**夹具 | **部分采纳**：四类用例全采纳；**计数更正为 12**——"约 13"是估数，不采信估值（D-0-1） |
| **[4]-5** | 删掉"loopback 即信任、远程暴露才需鉴权"的表述，改为宿主统一 Host/Origin 与浏览器会话门控 | **采纳**（并入 D-6 写域） |
| **[4]-6** | **先写失败测试再实现**（TDD）+ 全量 `node --test` + 真实页面复验 | **采纳**（落为实施顺序） |

## §3 分歧与父侧裁定（**主代理写**）

### D-0 父侧独立回盘核（裁定所依据的自测事实——不采信任何一方的自报）

- **D-0-1 夹具面 = 12 处**（实测 grep + 逐行读档）：11 处 `makeApiHandler({}, …)` 直调（config-api :767/:823/:860 · codex-runner :784/:816/:831/:1593/:3411/:3460 · context-budget :552 · session-state :792），**全部传空对象 `{}`（连 `get` 都没有）**；第 12 处是 `test/design-review-guard.test.mjs` 经 `apply(fakeCtx, {})` + 捕获 `webServer.register` 拿到 handler（:130-134、:349-352），其 fake ctx **有** `get: () => null`（:124），并在 :359/:367 **真的断言了 handler 的响应体** ⇒ 本修复会使它变红。四席自报的 10 / 11 / 12 / 13 无一对上：12 这个**个数** v4-pro 报对了，却算错了**成员**（它算的是"11 直调 + U8b `registerConfigApi`"，而本设计下 U8b **不需要改**）。
- **D-0-2 服务名与跨插件可达性**：服务名由 `super(ctx, "connection")` 确定（`dsh-client-connection/lib/index.js:535`）——**模块导出的 `name = "client-connection"`（:726）是插件名，不是服务名**，这是本档最易混的一处。跨插件可达性由两个内置消费者反证：`dsh-host-open-in-app` 的 inject 含 `"connection"`（:1215）且用 `Reflect.get(ctx, "connection")`（:1226）；`dsh-api-gateway` 用 `ctx.inject(["connection","webServer"], …)`（:457）后 `webCtx.connection.requestRejection(req)`（:463）。该服务**未 isolate**（该文件无 `isolate` 字样）。
- **D-0-3 母本形态**：`connection` 自己的 `/api` 路由（:768-781）就是 `kind: "prefix"` + handler 首行 `connection.requestRejection(req)` + 非 undefined 直接应答——与本方案**同形**，唯一差别是它回**纯文本**（:775）；open-in-app 则用裸 `end()`（:1320）。故 D-5 取 JSON 是**有意偏离**，不是疏漏。
- **D-0-4 消费面**：父侧全仓 grep `thincoder-suite/api` ⇒ 非测试消费者**只有** `lib/client.js`（浏览器同源）；其余全为 docs / README / CHANGELOG / tests 记述。加门不误伤本机脚本（复核 [3]-8 的结论）。
- **D-0-5 计数纪律**：本档所有计数（12 夹具 · 11 直调 · 8 端点 · 4 席 · 31 条主张）均出自本次实测，不抄任何一席的自报值。

### D-1 ★ 门落在哪：**handler 闭包内（请求期解析、无条件、单咽点）**

**裁定：采纳 [2] / [4] 的形态；不采纳 [1]-3 的 opts 钩子；不采纳 [3]-1 的双层门控注册。**

理由（三条可测）：

1. **默认值方向**：门在 handler 内 ⇒ 任何拿得到 handler 的人都要过门；opts 钩子 ⇒ 不传就无门（**fail-open 默认**）。本次缺陷的成因就是"漏做一步"，修法不能把"记得传钩子"变成新的漏点。
2. **可观测性**：缺服务时本方案回 **503 + 一条 warn**；注册期门控回 **404 且无日志**（[2]-2 指出）——后者把"装了但没门"伪装成"没这个路由"，与插件「服务取不到必须留痕」的纪律相悖。
3. **改动面**：门控注册要动 apply() 结构、`registerConfigApi` 契约、U8 降级语义、disposer 接线、fakeCtx 回落与状态行（[3]-4），而它相对请求期门的**唯一**边际收益是 404 与 503 之差——收益不配风险。

> 记录为**已考虑并否决的备选**，理由进档，免得后人当 bug 改回去（参照 consult #16 的 [4]-10 教训）。

### D-2 `connection` **不进**模块级 `inject` 列表

**裁定：维持 `lib/index.mjs:52` 现状。** 4/4 一致，父侧同意：`inject` 是 required 语义，把 connection 放进去等于"无 connection 的 profile 整个插件拒起"，四个 host 工具（advisor / eng / eng_coder / escalate-consult）为 web 附属面陪葬。取服务一律走 `ctx.get`。

### D-3 测试缝：**显式 stub ctx**（把放行写成白纸黑字），夹具 12 处

**裁定：** ① 12 处夹具显式补 connection stub；② 新增 gate 用例：403 透传 · 401 透传 · 403/401 时**业务面未被触碰**（PUT 后盘字节不变）· 缺服务 503 + warn **恰好一次** · 有服务但无 `requestRejection` → 503 · 放行 → 原行为 200 · 栅栏收到的是**原始 req 同一引用**；③ **先写失败测试再实现**（[4]-6）。

> **注（对 [2]-3 的细化）**：warn-once 标记放 **handler 闭包内**（每次 `registerConfigApi` 得到独立标记），不用模块级全局——模块级标记跨 fiber / HMR 存活，测试还得额外清（现有 `resetDeprecatedSecretEnvWarnForTests` 就是被这件事逼出来的）；随实例则天然可测、可复位。

### D-4 缺服务的状态码 = **503**

**裁定：[1]-7 的选项取 503。** "信任无法核验"是 503（service unavailable）的语义；403 说"你不被允许"，会与真正的 Host/Origin 拒绝混淆；404 无日志（见 D-1 理由 2）。

### D-5 拒绝响应体 = **JSON `{ok:false,error}`**

**裁定：[1]-6 ④ / [2] / [3] / [4] 一致取 JSON。** 论据（父侧复核）：`lib/client.js:68-72` 的 `fetchJson` **无条件** `r.json()`，裸 `res.end()` 的空体会被 `apiCall` 的 `.catch` 收成 `Unexpected end of JSON input`——一个把"未授权"伪装成"解析失败"的误导文案；且与本插件全端点 JSON 往返契约一致。与平台先例（:775 纯文本 / open-in-app :1320 裸 end）的偏离是**有意**的（D-0-3）。

### D-6 范围与版本

**裁定：** 本批 = 栅栏 + 夹具/用例 + 文档同批；**不做** Content-Type 415 纵深防御（栅栏落地后跨站请求死在 403，当前收益 0——登记为可选加固，见 §5）；**不动** `dsh-team-link`（另有会话处理）；`dsh-super-injector` **不报障**——**★ 2026-09-21 父侧订正（原写「同款缺陷另行报障」，两处不准）**：① 原引 `lib/index.js:7020` 是它的**脚手架模板**（`path: '/${pkgName}/api'`），真路由在 **`:9633-9635`** 的 `/super-injector/api`（同款无栅栏）；② 该插件在本部署**未装配**（不在 bundles、不在 `node_modules`、活体 `/super-injector/api` ⇒ 404）⇒ **零实况暴露**，按**用户 2026-09-21 的裁定**收口为「**非本仓所有 + 已不启用 ⇒ 不在本仓跟踪范围**」（只登记事实，不承担前置校验或报障义务）；版本号 bump（`0.29.1` + CHANGELOG）**留用户拍板**。

## §4 教训（**主代理写**）

1. **结论层 4/4 收敛，分歧只在"门的位置"与"测试缝"** —— 这正是会诊该产出的东西：四席都独立核到了 cordis `ctx.get` 的免 inject 语义、`requestRejection` 的两段式、open-in-app 的正例，而对"门放 handler 还是放注册期"给出了真分歧。
2. **最容易踩的坑是测试，不是代码。** 11 处空 ctx 直调制造了"门一加就红"的压力，两席各自提出了一个"让测试不变红"的形态（[1] 的 opts 钩子、[3] 的门控注册），**两者都以弱化生产默认或加大改动面为代价**。教训：**安全默认不得迁就夹具，夹具该改**。
3. **只有读 cordis 源码才发现的缺陷**：[3]-2 的 `ctx.connection` 属性读会抛（`cannot get property "connection" without inject`，cordis:675）——"看起来更直白"的写法在 cordis 代理下是错的，必须 `ctx.get`。
4. **计数不能采信任何一席**：4 席给出 10 / 11 / 12 / 13 四个不同的夹具数，实测 **12**，且 v4-pro 的 12 是"数对了、点错了"。凡"N 处"必须自测（**R-43 同族**）。
5. **正例就在同一份源码里**：`connection` 自己的 `/api` 路由（:768-781）与本方案同形，比 open-in-app 更近。教训：**先找同栈母本，再设计**——[1]/[2]/[4] 都只引了 open-in-app。

## §5 不可验清单（**主代理写**）

1. **运行时能否真的解析到 `connection` 服务** —— 源码层已确证（D-0-2），但**未在运行时验**（需改代码 + 重启进程）。由实施后的活体矩阵补验；这是本档最大的残留不确定。
2. **真实浏览器设置页在同源 cookie 下是否仍 200** —— 需真实会话（cookie 按 authority 绑定签名），本档未验。列为本批**发版门槛**（D-6），不通过不发版。
3. **DNS rebinding 未在真实浏览器打通 PoC** —— 原报告的复现停在 Host 头层 + 代码阅读，本档同样至此（[1] 自陈"不是打成功的 PoC"同此）。
4. **`node --test` 全量基线与修复后的绿度** —— 实施时跑；本档只给出夹具盘点（D-0-1），不含绿度承诺。
5. **`sec-fetch-site` / `Origin` 在真实跨站场景的实际取值** —— 父侧只在 curl 层验过 Host 与 OPTIONS，浏览器实际会送什么头未在真实浏览器验。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-21 | 机制落盘（§0 汇总 + §1 原始层） |
| 2026-09-21 | 父侧裁定层补写：§2 逐条处置（4 席 / 31 条主张）、§3 D-0 回盘核 + D-1..D-6 裁定、§4 教训、§5 不可验清单 |
