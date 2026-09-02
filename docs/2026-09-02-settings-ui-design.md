# thincoder-suite 二期：DSH 设置页 UI（全局配置编辑器）— 设计

- 日期：2026-09-02
- 状态：✅ 已实施（2026-09-02 eng_coder 交付；U1–U9 验收，U1/U4 手动冒烟待重启后执行；code review 2 轮：round 1 抓 11 项（stateOf 接线/开关路径等）全部修复，round 2 因收敛轮 300s 预算限制以分歧审计 + 50/50 测试替代核销——校准建议见 METHODOLOGY）
- 范围：DSH 设置面板「Thincoder」页——可视化编辑全局默认配置（advisor round1/convergence 组、includeProjectGuide、consultModels、engCoder 项）
- 关联文档：`../METHODOLOGY.md`、`2026-09-01-advisor-config-design.md`（一期 host 机制 §3；**其 §4 二期概要/§5.2 P 系列已由本档取代**）、`2026-09-02-thincoder-suite-extensions-design.md`（F10/F11）
- 前置调研：2026-09-02 宿主调研（settings seam / client 装配 / RPC 契约，见 §0）

---

## 0. 调研事实（2026-09-02 实证）

> 调研执行：subagent 会话（2026-09-02，只读宿主代码审计，未落盘独立报告）；关键事实与 file:line 证据已摘要于此（宿主路径均在 `D:\DSH-Portable\profile\profiles\web\node_modules\@deepseek-ai\` 下），实施时如需复核可直接对照。

- 宿主 `ctx.settings` 服务常驻（dsh-base 挂载 dsh-settings-file → `$DSH_HOME/settings.yaml`），register 需**真 schemastery schema 实例**（schema.toJSON()）——与插件零 bare import 冲突，动态绝对路径 import 耦合 profile 布局。
- **用户决策（2026-09-02）**：全局默认持久化走**自有 JSON** `$DSH_HOME/.thincoder/config.json`（延续 F10/token-store 先例与零依赖哲学），不走宿主 settings seam；client 形态 = **轻量 imperative**（零 react/tsdown）。
- client bundle：`dsh.client{inject:[...], platform:'web'}` + `exports['./client']` → bundle 已装配即自动被发现（dsh-client-modules 扫 loader.entries + 重启/增量刷新）；产物为 CJS 闭包经 `window.__ModuleLoader__.load({id, factory})`。
- settings.section slot：`slots.inject('settings.section', () => slots.register({name, id, order, label, inject}, Component))`；渲染方给 owner `{close}`；页面 inject 按需（`slots` 必需）。
- provider/model 下拉数据：官方 RPC `llm.providers` + `llm.models`（client `connection.api.llm.*`，同源 POST /api/），比解析 settings.yaml 完备。
- host 自定义 HTTP：`ctx.webServer.register({kind:'prefix', path:'/thincoder-suite/api', handler})`（dsh-host-webserver；宿主 inject 'webServer'）。
- 一期事实源：全局默认 = cordis.patch.yml entry config（插件 rawConfig，启动快照）；会话级覆盖 = `state.advisorOverride` + `advisor_config` 工具（lib/index.mjs 注册）。

---

## 1. 需求（三层）

### 1.1 总体目标

把「全局默认配置」从手编 cordis.patch.yml 提升为 **DSH 设置面板可视化编辑**（读取 → 表单 → 保存 → 即时生效提示），同时保持一期语义不变：生效配置 = 会话覆盖 ⊕（config.json 全局覆盖 ⊕ entry base）⊕ 解析链（§3.2/§3.6）。

### 1.2 功能用户故事

- **U1 设置页渲染**：作为用户，我在 DSH 设置面板能看到「Thincoder」页：round1/收敛轮两张组卡片（provider/model/effort/timeoutMs）、includeProjectGuide 开关、consult/escalate 共享模型池列表（可编辑行：provider/model/effort）、engCoderMaxTokens/engCoderEffort 输入。
- **U2 全局默认读写**：作为用户，我编辑后点「保存全局默认」→ 写入 config.json（user 层）；「恢复默认」→ 清空 user 层回落到 entry base；页面刷新后显示当前生效值（标注来源：全局覆盖 / entry base）。
- **U3 校验拦截**：非法值（provider/model 必填且存在于 provider 注册表（host 可查时）、effort 非枚举、timeoutMs 越界、engCoderMaxTokens 非正整数）表单内联报错不提交（N4 延续）。
- **U4 会话视图与应用（尽力而为）**：页面顶部显示**当前会话**生效摘要（含会话覆盖来源标注）；「应用到当前会话」写该会话 advisorOverride（仅 advisor 子集，见 §3.2）；「恢复会话默认」删该会话 advisorOverride——client 能取活动会话 id 时提供按钮，取不到则提供「复制 advisor_config 命令」替代交互（实施确认项 4 定案，见 §3.6）。
- **U5 全局配置对评审即时生效**：config.json 保存后无需重启——host 在每次评审/工具调用读取时合并（§2）。

### 1.3 非功能标准

- **N1** host 侧保持零 bare import 零新增依赖（client 侧允许 dsh-client-* 运行时依赖——那是装配契约而非代码依赖）；**无构建步骤**（client 直接手写 CJS 产物）。
- **N2** 一期语义零回归：解析链/会话覆盖/校验/超时全部不动；config.json 只新增「全局 user 层」。
- **N3** fail-safe：config.json 缺失/损坏 → 视为无 user 层（回落 entry base）；写失败仅提示不崩溃。
- **N4** 配置校验与一期同源（effort/timeoutMs/boolean 校验逻辑复用 advisor.mjs 的导出，不重写）。
- **N5** 部署兼容：cordis.patch.yml entry config 仍是 base（旧用户不配 config.json 一切照旧）；README 说明两层关系。

---

## 2. 配置分层模型（全局 user 层）

```
生效全局 = entry base(cordis.patch.yml rawConfig，启动快照)
        ⊕ config.json user 层（UI 可编辑；字段级覆盖 base）
生效会话 = sessionState.advisorOverride（一期，会话级，最高）
         ⊕ 生效全局
→ 解析链（advisor.mjs resolveAdvisorRoute）语义不变：会话覆盖 > 组字段(合并后组环) > legacy > agent route
```

- **base**：cordis.patch.yml 的 config（现状，插件 apply 收到的 rawConfig——**注意 rawConfig 是启动快照**；config.json 改动不重载 base，只叠加 user 层，避免 fiber 重启）。
- **user 层文件**：`$DSH_HOME/.thincoder/config.json`（F10 token-store 同目录不同文件；沿用其路径解析：注入缝 → DSH_HOME → 探测）。
  ```json
  { "version": 1, "config": { "advisor": { "round1": {...}, "convergence": {...}, "includeProjectGuide": false }, "consultModels": [...], "engCoderMaxTokens": 65536, "engCoderEffort": "low" } }
  ```
- **合并实现**：新 `lib/config-store.mjs`（load/save/merge，字段级浅合并同 mergeAdvisorGroup 语义；损坏 → null = 无 user 层）；host 消费点 = `resolveAdvisorRoute` 的 config 输入处（advisor.mjs 内做 `merged = mergeGlobalUserLayer(config, configStore.load())`——**实施确认项 1**：最小侵入点，倾向在 runAdvisorReview/runEngCoder 拿 config 时合并一次，避免改 resolveAdvisorRoute 签名）。
- **改动立即生效**：config.json 是进程内读取（每次评审/工具调用时 load——文件小，读廉价）；保存后无需重启（对比 entry base 需重启——README 说明）。

---

## 3. 设计

### 3.1 host：config-store.mjs（新，纯 fs，仿 token-store）

- `resolveConfigStorePath(dshHomeOverride, cwdHint)`、`loadUserConfig(...)`（try/catch → null）、`saveUserConfig(cfg, ...)`（mkdir + 原子写（tmp+rename，对齐 super-injector 惯例）+ try/catch warn）、`clearUserConfig(...)`。
- `mergeGlobalConfig(baseConfig, userCfg)`：字段级——`advisor.round1/convergence/includeProjectGuide`、`consultModels`（整体替换——增删列表语义）、`engCoderMaxTokens/engCoderEffort`；未知字段不合并（白名单）。

### 3.2 host：config-api 端点（lib/index.mjs 内注册）

`ctx.webServer.register({ kind: 'prefix', path: '/thincoder-suite/api', handler })`（**需 inject 'webServer'**——实施确认项 2：webServer 服务在宿主 base 可用（super-injector 同款）；不可用则跳过注册并 console.warn，功能降级为仅 host 工具——降级路径纳入验收 U8）。

- `GET /thincoder-suite/api/config` → `{ base, user, effective }`——base = entry base 原文（cordis.patch.yml 启动快照）；user = config.json user 层（无则 null）；effective = 字段级合并结果。
- `GET /thincoder-suite/api/session`（query `sessionId`）→ 该会话 `advisorOverride` 现状（评审 #11 契约收敛）：sessionId 无对应会话 → `{ ok:false, reason:'no-session' }`；已知会话但无覆盖 → `{ ok:true, override:null }`；有覆盖 → `{ ok:true, override }`。
- `PUT /thincoder-suite/api/config` → body `{ config }` → 校验（复用 advisor.mjs **导出的**校验 helper（§4 变更项：`isValidEffort`/`isValidTimeoutMs`/… 由 advisor.mjs export，消除 dead-export 双实现，评审 #5）；provider 存在性：`ctx.settings.get('llm-pi-ai')` 可用时对照 `providers` 清单，不可用则跳过存在性校验并提示（评审 #8））→ 失败 `{ ok:false, errors:[...] }`；成功写 user 层 → `{ ok:true }`。
- `DELETE /thincoder-suite/api/config` → 清 user 层（恢复 base）。
- `POST /thincoder-suite/api/apply-session` → body `{ sessionId, advisor }`——**只写 advisor 子集**（round1/convergence/includeProjectGuide，§3.1 白名单；consultModels/engCoder 字段仅全局层，不写会话——评审 #4）；sessionId 无对应会话 → `{ ok:false, reason:'no-session' }`（纳入验收 U8）。
- `DELETE /thincoder-suite/api/session`（query `sessionId`）→ 删该会话 `advisorOverride`（恢复会话默认，与 apply-session 对称）。
- handler 鉴权：loopback 信任模型（与 super-injector api 同款，本机 GUI）——记录于风险。

### 3.3 client：lib/client.js（新，手写 CJS，零构建）

- `module.exports = { inject: [...], async apply(ctx) {...} }` 形态以 dsh-client-modules 契约为准（**实施确认项 3**：对照 super-injector 产物头部 5 行实证 CJS wrapper 写法）。
- 注册：`ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'thincoder', order: 40, label: () => 'Thincoder', inject: [...] }, ...))`。
- 页面（纯 DOM，仿 super-injector settings 页）：两张组卡片 + 开关 + 列表 + 保存/恢复按钮；校验提示行；保存成功 toast/状态文本。
- 数据流：进入页面 `fetch('/thincoder-suite/api/config')` 拿 base/user/effective；provider/model 下拉经 `connection.api.llm.providers/models`（inject 'connection'——若手写 DOM 不想引 connection，可退化为 host 端点转发 llm 数据？**倾向直接 inject connection**（官方 RPC），实施确认项 5）；保存 `PUT`。
- 会话覆盖按钮/复制命令（P4）按实施确认项 4 定案实现。

### 3.4 装配（package.json）

```jsonc
"dsh": { "bundle": { ...既有... }, "client": { "inject": ["dsh-client-runtime", "dsh-client-ui-slots", "dsh-client-connection"], "platform": "web" } },
"exports": { "./client": "./lib/client.js" }
```

- bundle 已装配 → 重启后 dsh-client-modules 自动发现（lib/client.js 出现即生效；无需单独注册）。README 同步。

### 3.5 定案记录（取代 2026-09-01 设计 §4）

**Superseded 声明**：`docs/2026-09-01-advisor-config-design.md` §4（二期概要）与 §5.2 的 P 系列已被本文档取代（2026-09-02 用户定案）——该文档仅保留历史。

| [OPEN] 项 / 范围决策 | 定案 |
|---|---|
| 全局持久化目标 | **自有 JSON** `$DSH_HOME/.thincoder/config.json`（user 层；entry base 不动）——零依赖保持；宿主 settings seam 因 schemastery 依赖冲突放弃 |
| provider 下拉数据源 | **client RPC llm.providers/models**（官方，完备） |
| 测试一次评审按钮 | 不做（YAGNI） |
| client 形态 | 轻量 imperative 手写 CJS，无构建 |
| 会话生效摘要 + 恢复会话默认（评审 🔴 #2） | **补回**（2026-09-02 用户决策）：页面顶部当前会话生效摘要（覆盖来源标注）+ apply/reset-session 端点（§3.2）；活动会话 id 取不到时降级为复制命令 |
| consult/escalate 池展示 | 共用 consultModels 池（escalate 读同一配置），列表编辑已覆盖 escalate——无需独立池 UI |

### 3.6 实施确认项

1. host 合并最小侵入点：`resolveAdvisorRoute` 的 config 输入处合并 user 层（runAdvisorReview/runEngCoder/advisor_config get 的 config 来源统一走一处 helper `effectiveGlobalConfig(config)`）；
2. `ctx.webServer` 在宿主 base 的可用性与 inject 声明方式（lib/index.mjs inject 数组加 'webServer'，缺服务时容错跳过）；
3. client.js CJS wrapper 的确切形态（对照 super-injector `lib/client.js` 头部 + dsh-client-modules 加载路径）；
4. client 获取活动会话 id 途径（scope.sessions/connection）——不可行则 P4 降级为「复制 advisor_config 命令」；
5. `connection.api.llm.providers/models` 在 client 页注入的可用性（inject 'connection' vs 仅 'slots' 的最小集）；
6. config.json 与 F10 token-store 的目录并发（同目录不同文件，无冲突）。

---

## 4. 受影响文件

| 文件 | 状态 | 改动 |
|---|---|---|
| `lib/config-store.mjs` | 待实施（新） | user 层 load/save/clear/merge（3.1） |
| `lib/advisor.mjs` | 待实施 | config 消费点合并 user 层（helper `effectiveGlobalConfig`，3.6-1）；**导出校验 helper**（isValidEffort/isValidTimeoutMs/…——消除 mergeAdvisorGroup 类 dead-export 双实现，评审 #5） |
| `lib/index.mjs` | 待实施 | inject webServer + config-api prefix 路由（3.2） |
| `lib/client.js` | 待实施（新） | 设置页（3.3：组卡片/开关/池列表/engCoder 项/会话视图 + apply-reset） |
| `package.json` | 待实施 | dsh.client + exports['./client']（3.4） |
| `cordis.patch.yml`（仓库示例） | 待实施 | 注释说明 base/user 两层 |
| `README.md` | 待实施 | 二层配置说明 + 设置页入口 |
| `docs/2026-09-01-advisor-config-design.md` | 本次 | §4 标 superseded（指针化）+ §5.2 P 系列标注被取代 |
| `docs/README.md` | 本次 | 登记本设计 |
| `test/` | 待实施 | config-store 单测 + 校验复用单测 + apply-session handler 单测（stub sessionState，U7）+ webServer 降级路径用例（U8） |

## 5. 验收标准（U 系列——不与一期 P 系列冲突，评审 #1）

| # | 验收标准 | 验证方式 |
|---|---|---|
| U1 | 设置页在 DSH 设置面板出现（id thincoder）：两卡片 + 记忆开关 + consult/escalate 池行（provider/model/effort 可编辑）+ engCoder 输入 | 手动冒烟（重启后） |
| U2 | 保存全局默认 → config.json user 层写入；刷新保持；恢复默认 → user 层清空回落 base | 手动 + 单元（config-store save/clear/merge） |
| U3 | 非法值（effort 枚举外/timeoutMs 越界/provider/model 空/engCoderMaxTokens 非正整数）→ 表单内联报错不提交；provider 存在性（host 可查注册表时）校验 | 单元（host 校验 helper）+ 手动 |
| U4 | 会话视图：页面顶部当前会话生效摘要（覆盖来源标注）；「应用到当前会话」写 advisorOverride（仅 advisor 子集）；「恢复会话默认」删 advisorOverride | 手动冒烟（或复制命令降级方案） |
| U5 | 会话覆盖（advisor_config）优先级仍高于全局 user 层 | 单元（合并顺序断言） |
| U6 | config.json 损坏/缺失 → effective = base 不崩溃；写失败 → 提示不崩溃 | 单元 |
| U7 | apply-session/reset-session handler：有效 sessionId 写/删 advisorOverride；无效 sessionId → `{ok:false, reason:'no-session'}` 且不崩溃 | 单元（stub sessionState） |
| U8 | webServer 不可用降级路径：不注册路由仅 console.warn，host 功能（评审/工具）不受影响 | 单元（stub 无 webServer） |
| U9 | 一期现有全部用例（实施时以 node --test 实际数为准，≥28）全绿回归 | node --test |

## 6. 风险与回滚

- **user 层与 entry base 分叉**：base 是启动快照——保存 user 层后，改 cordis.patch.yml 需重启（现状不变）；两层关系 README 说明。
- **webServer 路由无鉴权**：loopback 信任模型（同 super-injector 既有 api）；如远程暴露需加鉴权（记录）。
- **client 手写 CJS 与宿主契约漂移**：dsh-client-modules 升级可能改 wrapper 契约——实施确认项 3 实证 + 冒烟兜底。
- **回滚**：config.json 删除即回纯 base 行为；client 代码 git 回退。
