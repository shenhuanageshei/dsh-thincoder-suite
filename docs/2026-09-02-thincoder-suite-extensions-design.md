# thincoder-suite 扩展：F10 design token 持久化 + thincoder-eng PTC 工具集

- 日期：2026-09-02
- 状态：PROPOSED（待用户发起设计评审）
- 范围：F10（token 跨重启存活）+ thincoder-eng 预设工具集补齐（PTC/code preset 工具集 + native 呈现）
- 关联文档：`../METHODOLOGY.md`（工程工作流）、`../docs/2026-09-01-advisor-config-design.md`（一期交付，F8/F9 先例）、`README.md`

---

## 0. 背景与问题陈述

**F10（token 内存态脆弱）**：design token 存于 `state.mjs` 模块级 Map（内存态），进程重启/崩溃即丢失 → `eng_coder` 校验（`token === state.designToken`）拒绝 → 必须重新发起设计评审。2026-09-02 一期流程实证：为加载 F8/F9 hotfix 多次重启，**同一设计被评审 5+ 次**，每次 1-3 分钟纯消耗。DSH 崩溃恢复频繁（死亡取证：单日 10 次非正常结束）。

**thincoder-eng 预设缺 shell 工具**：`preset/thincoder-eng/agent.cordis.yml` 的组成是「router-standard 裁剪版，minus win32 Git Bash seam」——**无 `tool-bash`/`tool-pwsh` 行**，工程模式会话无任何 shell 能力（读文件靠 fs 工具、验证靠 eng_coder 子代理——子代理也受限）。DSH 内置 **PTC 模式**（`@deepseek-ai/dsh/config/agent-presets/code/`，name「PTC 模式」）提供完整标准工具集（含 `tool-bash`/`tool-pwsh` 平台条件禁用 + Code Mode SDK 呈现）；用户要求 thincoder-eng 采用 **PTC 工具集 + native 呈现**（架构师角色以对话/文档为主，保留 native 直调）。

---

## 1. 需求（三层）

### 1.1 总体目标

- F10：评审通过签发的 design token 在进程重启后仍可被 `eng_coder` 使用——终结「重启丢 token 必须重评审」循环（不改变 TTL 语义与签发协议）。
- PTC：工程模式会话（thincoder-eng 预设）获得与 DSH 内置 PTC 模式一致的工具集（含 shell），工具呈现保持 native。

### 1.2 功能用户故事

- **F10-1**：作为用户，我希望评审签发 token 后即使 DSH 重启，`eng_coder` 仍能直接使用该 token（有效期内），无需重新评审。
- **F10-2**：作为用户，我希望过期的 token 记录被自动清理，且磁盘记录损坏/不可写时不影响评审与签发（fail-safe）。
- **PTC-1**：作为用户，我希望 thincoder-eng 预设的会话拥有 bash/pwsh shell 工具（与 PTC 一致），能直接运行命令验证。
- **PTC-2**：作为用户，我希望工具呈现保持 native（不加 Code Mode SDK/run_code 呈现）。

### 1.3 非功能标准

- **N1** 不改变 design token 协议：签发判定（裁决通过 ∧ 批准码回显）、TTL（engTokenTtlMs）、三态拒绝语义全部保持；持久化只是**第二存储**。
- **N2** fail-safe：磁盘读写失败仅警告（console.warn），签发/评审流程不因持久化故障失败；token 仍存内存态（现行为兜底）。
- **N3** 安全：token 是短生命周期凭证（TTL 1h）+ HMAC 绑定本机 `THINCODER_TOKEN_SECRET`；明文落盘基于本机信任模型（与 DSH profile 其他机制文件同级）。
- **N4** PTC 工具集对齐只增不改：只补 shell 行与呈现说明，不动 thincoder-eng 既有工具行与 persona；compaction 配置差异（thresholdRatio/retainRatio）保留现状。
- **N5** 改动范围：插件仓库文件 + preset 源文件；部署副本 `profile/.agent-presets/thincoder-eng/` 由用户按交付说明同步（设计文档不直接改部署侧）。

---

## 2. 设计

### 2.1 F10：design token 磁盘持久化

**存储位置**：`$DSH_HOME/.thincoder/design-tokens.json`（`DSH_HOME` = profile 根，实证 `D:\DSH-Portable\profile`；与 `super-injector/`、`undo-snapshots/` 平级）。宿主进程通过 `process.env.DSH_HOME` 读取（沙箱已实证可见）；不可见时实施确认项兜底（见 §5）。

**文件格式**：

```json
{ "version": 1, "tokens": { "<sessionId>": { "token": "<完整 token>", "issuedAt": 1788329460544, "expiresAt": 1788333060544 } } }
```

**写入时序**（`lib/advisor.mjs` design 签发路径，`state.designToken = designToken` 之后、返回前）：
1. 确保目录存在：`mkdirSync(dirname, { recursive: true })`（评审 #2——目录缺失时 writeFile ENOENT 会静默失败）；
2. 读现有文件：**try/catch 包裹**，缺失/损坏/不可读 → 视为空（评审 #1——`JSON.parse` 抛错不得击穿签发）；
3. 更新本 sessionId 条目（token/issuedAt/expiresAt = token 第二段）；
4. **全量清扫**所有 session 的过期条目（单次遍历，评审 #4——不只本 session，防无限累积）；
5. 写回（对齐 super-injector `registry.json` 的直写惯例；失败仅 `console.warn`，不抛错——签发不依赖持久化成功）。

**读取时序**（`lib/eng.mjs` 校验路径）：现有校验 `!token || token !== state.designToken || !validateDesignToken(token)` 扩展为：
1. 内存命中（现行为）→ 通过；
2. 内存无（重启后）→ 查磁盘（**同样 try/catch**：损坏/不可读 → 视为无记录，落入三态拒绝，不崩溃）：本 sessionId 有条目 且 传入 token === 条目.token 且 `validateDesignToken(token)` 通过 → **回填 `state.designToken`** 并通过；
3. 其余 → 保持三态拒绝（never issued / expired / mismatch）。

**清理**：每次写入时**全量清扫**所有 session 的过期条目（`Date.now() > expiresAt`，单次遍历，评审 #4）；过期 token 在 eng_coder 校验路径自然落入 expired 拒绝（validateDesignToken 已查过期），提示重评审。

**测试缝**：存储路径可注入（`storPathOverride`，对齐 `stallMsOverride` 先例）——测试用临时目录，不碰真实 `$DSH_HOME`；**T1 的临时路径父目录不预创建**（验证 mkdir recursive 真被调用，评审 #2）。

### 2.2 thincoder-eng：PTC 工具集（native 呈现）

**改动文件**：`preset/thincoder-eng/agent.cordis.yml`（插件仓库源文件）。

**shell 区补齐**（与 DSH 内置 code/PTC preset `agent.cordis.yml:51-57` 逐字一致）：

```yaml
# ── shell ───────────────────────────────────────────────────────────────────
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'
```

（替换现有 shell 区的单行注释「渐进披露路由…」；executor 是 host 平面 `bash-sandbox`/`pwsh-sandbox`，preset 只贡献模型侧工具行。）

**呈现**：不加 `tool-presentation`（mode: code）——native 呈现为 DSH 默认；头部注释更新说明「PTC 工具集 + native 呈现」。

**保留不动**：persona（架构师）、agent-instructions、fs/jobs/skills/goals/planning/compaction/delegation/ask-user/todo/web 全部行、compaction 自定义参数（thresholdRatio/retainRatio——与 code preset 默认的差异保留，无功能影响）。

**头部注释更新**：说明组成来源 = DSH 内置 code（PTC）预设工具集 − code 呈现 + native；插件机制注释不变。

**部署同步说明**（README 增补）：preset 源文件变更后，复制 `preset/thincoder-eng/*` 到 `~/.dsh/.agent-presets/thincoder-eng/`（本机 = `D:\DSH-Portable\profile\.agent-presets\thincoder-eng\`），**新会话**生效（已运行会话不重装 preset）。

---

## 3. 受影响文件

| 文件 | 状态 | 改动 |
|---|---|---|
| `lib/advisor.mjs` | 待实施 | F10：签发路径写盘（2.1 写入时序，含 mkdir/清扫） |
| `lib/eng.mjs` | 待实施 | F10：校验路径查盘 + 回填（2.1 读取时序，含 try/catch） |
| `lib/token-store.mjs` | 待实施（新） | F10：token 磁盘读写 helper（load/save/clean，评审 #9 定案独立模块——保持 state.mjs 纯内存语义） |
| `preset/thincoder-eng/agent.cordis.yml` | 待实施 | PTC shell 行补齐 + 头部注释（2.2） |
| `README.md` | 待实施 | F10 说明 + preset 同步说明更新 |
| `docs/README.md` | 本次 | 登记本设计 + 所有权标注（评审 #10） |
| `docs/2026-09-02-thincoder-suite-extensions-design.md` | 本次 | 本文件 |
| `test/advisor-config.test.mjs` | 待实施 | F10 用例（T1–T5）+ 既有回归 |
| `test/preset-static.test.mjs` | 待实施（新） | preset 静态断言（T6/T7 + 既有行 fixture 对比，评审 #5/#6） |
| `package.json` | 不动 | — |

## 4. 验收标准

| # | 验收标准 | 验证方式 |
|---|---|---|
| T1 | mock 评审签发后，存储文件（注入路径）含本 sessionId 记录（token/issuedAt/expiresAt） | 单元测试（storPathOverride） |
| T2 | 新 sessionState（空内存）下 eng_coder 校验盘上有效 token → 通过并回填 state.designToken | 单元测试 |
| T3 | 盘上记录过期 → eng_coder 拒绝（expired 提示），不误放行 | 单元测试 |
| T4 | 过期记录（含**其他 session** 的）在写入时被全量清扫删除 | 单元测试 |
| T5 | 存储路径不可写/文件损坏 → 签发仍成功（warn 不抛）；**损坏文件 + 空内存 → eng_coder 拒绝且不崩溃**（评审 #1） | 单元测试 |
| T6 | `preset/thincoder-eng/agent.cordis.yml` 含 tool-bash/tool-pwsh 行且平台禁用条件正确；**既有行（persona/fs/planning/compaction 等）与当前文件 fixture 对比无变化**（评审 #6） | 静态断言（preset-static.test.mjs） |
| T7 | preset 无 tool-presentation（mode: code）行 | 静态断言 |
| T8 | thincoder-eng 新会话装配成功，shell 工具可用（手动冒烟：新会话跑 `pwsh -c "echo ok"`） | 手动/冒烟 |
| T9 | 一期 20 用例全绿回归 | node --test |

## 5. 实施确认项

1. `process.env.DSH_HOME` 在宿主（web profile）进程的可见性——沙箱 pwsh 实证可见；宿主进程实施时确认；不可见则探测 `ctx.baseDir` 或 `process.cwd()` 上行找 `profiles/` 上级（profile 根特征：含 `sessions/`、`settings.yaml`）；
2. token 文件写入惯例——对齐 super-injector `registry.json` 直写；若宿主有原子写工具则用之；
3. 签发写盘的精确插入点（`advisor.mjs` design 签发 return 前，`state.designToken = designToken` 之后）；
4. `expiresAt` 解析：token 第二段（同 `hhmmFromToken` 的解析路径），避免重复实现；
5. **sessionId 跨重启稳定性**（评审 #3）：验证工具上下文（agent.session.id）在宿主重启后恢复会话时是否保持同一 id——保持则按 sessionId 键控即生效；若恢复铸新 id 则 F10 退化为 no-op（无回归），需改键控策略或记录限制。

## 6. 风险与回滚

- **token 明文落盘**：TTL 1h + 本机 secret 绑定；如部署在共享环境需加密存储（超出本期，记录为后续项）。
- **磁盘状态与内存态分叉**：文件被外部删除/篡改 → 校验回落内存态（现行为）；篡改 token 无效（HMAC 校验失败）。
- **并发 read-modify-write**（评审 #7）：单宿主进程内两个会话同时签发 → 后者覆盖前者条目（last-write-wins），失败方回落纯内存行为——单进程 + 签发低频，接受为已知限制。
- **PTC preset 增量同步**：DSH 升级若 code preset 增工具行，thincoder-eng 需手动跟进（文件头注释说明来源与同步方法）。
- **回滚**：F10 删除存储文件即回到纯内存行为；preset 改动 git 回退 + 部署副本还原。
