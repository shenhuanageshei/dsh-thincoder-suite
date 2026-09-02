# dsh-thincoder-suite

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-8957e5)](https://github.com/topics/dsh-plugin)

把 [thincoder](https://gitee.com/shanghai-xinbo/thincoder)（[官网](https://thincoder.com/)）的四个自我纪律机制移植为 **DSH（DeepSeek Harness）** 桌面壳的单个 cordis 插件：

| 功能 | 工具 | 一句话 |
|------|------|--------|
| **advisor** 评审收敛 | `advisor` | 会终止、可对账、引用验真的多轮评审 |
| **eng** 工程模式 | `eng` / `eng_coder` | design-before-code 双门禁工作流 |
| **escalate** 飞刀 | `escalate` | 把任务交给更强的模型亲自写 |
| **consult** 会诊 | `consult_start` / `consult_check` / `consult_stop` | 多模型并行只读会诊 |

> 本项目基于开源项目 [thincoder](https://gitee.com/shanghai-xinbo/thincoder) 移植改造（上游 MIT 协议），向 ThinCoder 贡献者致谢。

## 为什么 advisor 不是又一个 code review

普通 AI review 的真实循环是 `while (true) { 找问题 }`：

- **无终止条件** —— 每轮都能报新问题，看似在进步，实际可能空转
- **锚定效应** —— 复审看到上轮结论，倾向于重复深化而非重新验证
- **证据不可验证** —— 报的文件 / 行号可能记错、看旧版本甚至编造
- **运动员兼裁判** —— 同一个模型既写代码又审自己刚写的代码

advisor 把它变成 `for round in 1..5 { 权限递减的对账 }`：

| 轮次 | 评审权限 |
|------|----------|
| Round 1 | 全量审查，建立 issue 清单 |
| Round 2 | 核销上轮清单 + 仅限致命新问题（crashes / data loss 级） |
| Round 3–5 | 严格只核销上轮响应表，不再找新问题 |
| 第 6 次调用 | 不经过 LLM，机械拒绝 |

配套的机械约束：

- **响应表协议** —— 被评审方每轮必须回 `| # | Action | Detail |`（Fixed / Not an issue / Deferred），逐条对账
- **引用验真** —— 评审报告中的 `file:line` 引用逐条与磁盘文件比对，伪造引用直接标注
- **每轮全新上下文** —— prior 输出以原文注入新会话，防锚定
- **预算共享 + 类型隔离（F11）** —— code review 与 design review 共用 5 轮预算，修完复审不重新计数；但 **reviewType 切换（code ↔ design）时重置轮次与 prior**——新设计文档评审总是从 round 1 开始，不携带 code 评审的收敛上下文（2026-09-02 实测事故修复：code 3 轮后 design 评审误走收敛轮、新文档未被全量评审）
- **超时硬生效（F5）** —— 单轮评审硬预算 = 该轮组 `timeoutMs`，绝对截止定时器 + chunk 墙钟双检查，静默流/稳定涓流都在预算时刻被中止（消除 606~699s 超跑）；裁决顺序绝对截止优先，stall 重试不豁免预算

## 工程模式 eng

design-before-code 的运行时门禁：

- `eng`（action: `enter` / `exit`）—— 会话内切换架构师角色
- enter 后模型只做需求澄清和设计文档，**设计评审由用户发起**——agent 不能自己评审自己拿 token
- 设计评审的**每一轮**（round 1 与收敛轮）user 消息都携带 `## Approval Signal`——8 位批准码（`[APPROVE:<8hex>]`；token 每评审会话只铸造一次、每轮同码，token 本体不进提示词）。评审通过且无 🔴 Critical 时，advisor 回显 `[APPROVE:<code>]`，宿主校验命中后注入完整 design token（附有效期提示）；`eng_coder` 携带该 token 派实现子代理（token 机械校验，不消费、可多次 spawn；后续评审不通过则撤销，拒绝消息按「未签发 / 已过期 / 不一致」三态分别提示）
- **双写门禁** —— 工程模式 ON 且主代理无有效 token 时，`write`/`edit` 对产品代码路径的调用被 `tools/pre-execute` 拦截：`src/**` 一律算产品代码，其他目录里非文档扩展名也算；`docs/**` 与根级文档（`.md` / `.txt` 等）豁免——那是架构师的产出物。间接写（shell 等）不拦，靠流程纪律，与上游同款取舍
- 子代理交付后自动触发交付 code review；变更合并回父会话并重置评审预算

### design token 跨重启持久化（F10）

评审签发的 design token 除内存态外还会镜像到 `$DSH_HOME/.thincoder/design-tokens.json`（profile 根下，与 `super-injector/`、`undo-snapshots/` 平级）——DSH 重启后，同一会话的 `eng_coder` 校验在内存无 token 时自动查盘：本 sessionId 有条目且回传 token 与记录全等且签名/有效期校验通过 → 回填内存态并通过，**有效期内无需重新评审**。

- **只增不改签发协议**：签发判定、TTL（`engTokenTtlMs`）、三态拒绝（未签发 / 已过期 / 不一致）语义不变——磁盘只是第二存储，内存态仍是第一存储与签发源
- **过期全量清扫**：每次写入时清理所有 session 的过期条目（不只本 session）；过期 token 在 `eng_coder` 校验路径自然落入 expired 拒绝（提示重跑评审铸新 token）
- **fail-safe**：文件损坏 / 路径不可写 / 被外部删除 → 仅 `console.warn`，签发与校验不崩溃、不误放行；删除存储文件即回到 F10 前的纯内存行为
- **安全模型**：token 短生命周期（TTL 1h 级）+ HMAC 绑定本机 `THINCODER_TOKEN_SECRET`，明文落盘基于本机信任模型（N3）

详细设计见 `docs/2026-09-02-thincoder-suite-extensions-design.md` §2.1。

配套 **thincoder-eng 预设**（见下文）：新会话一键从工程模式开始。

## 飞刀 escalate

判断任务超出自己能力时（复杂多文件重构、疑难 bug、精妙算法），把任务连同**写权限**交给 consultModels 池里的更强模型——它亲自改代码，返回术后报告（改了什么 / 为什么 / 怎么验证），你负责验收（读变更文件、跑测试）。

护栏：子代理内不可再飞刀（防递归甩锅）；工程模式下 fail-closed 拒绝（工程模式的实现只能走 `eng_coder`）。

## 会诊 consult

卡在同一个问题上反复失败、没有头绪时：

1. `consult_start(problem)` —— 非阻塞发起：多个配置模型**并行独立**分析同一问题（只读），立即返回 consult id。brief 质量决定回复质量：症状 + 已试过的路 + 入口文件
2. `consult_check(id, n)` —— 按到达顺序逐条读回复（n 从 1 递增）；回复是原始未采纳的，你自己验证取舍
3. `consult_stop(id, n)` —— 某条回复够用了就提前终止剩余会诊，省 token

会诊子代理可通过 `main_history` 工具回看主会话历史（60KB 预算，图片折叠为占位符）。

## 安装

要求：DSH 桌面壳（cordis `^4.0.0-rc.7`）+ web profile 标准服务（tools / llm / subagents / systemPrompt / webServer——webServer 缺失时仅设置页 API 降级，host 工具不受影响）。

```bash
git clone https://github.com/shenhuanageshei/dsh-thincoder-suite.git
```

在你的 web profile 目录（`~/.dsh/profiles/web`）：

```bash
pnpm add link:<克隆路径>/dsh-thincoder-suite
```

然后编辑 profile 的 `package.json`，把包名加进 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@dsh-external/dsh-thincoder-suite"
      ]
    }
  }
}
```

重启 DSH。启动日志出现

```
[thincoder-suite] active: advisor/eng/eng_coder ...
```

即装配成功。

## 配置（二层）

全局配置分两层（详见 `docs/2026-09-02-settings-ui-design.md` §2）：

| 层 | 位置 | 编辑方式 | 生效时机 |
|---|---|---|---|
| **base** | `cordis.patch.yml` 的 `config`（启动快照） | 手编本文件 / profile 部署副本 | 重启 DSH |
| **user 层** | `$DSH_HOME/.thincoder/config.json`（`.config` 字段） | **DSH 设置面板 →「Thincoder」页**（也可手编 JSON） | **保存即生效**（评审/工具每次调用时读取合并） |

生效全局 = user 层（字段级覆盖 base）⊕ base；user 层缺失/损坏 → 回落 base。user 层可配字段白名单：
`advisor.round1/convergence` 组（provider/model/effort/timeoutMs）、`advisor.includeProjectGuide`、
`consultModels`（整体替换）、`engCoderMaxTokens`、`engCoderEffort`——其余字段（engineering /
engTokenTtlMs / consultTimeoutMs 等）只在 base 配。文件示例：

```json
{ "version": 1, "config": { "advisor": { "round1": { "provider": "…", "model": "…" } } } }
```

> 部署侧 bundle 安装时 cordis.patch.yml 会作为默认 patch 应用——本仓库文件是 base 示例（单
> 一事实源）；`link:` 安装直接编辑克隆目录即可。两层的示例值关系见下方 `cordis.patch.yml`
> 头部注释。

### DSH 设置面板「Thincoder」页（二期 UI）

设置 →「Thincoder」：round1 / 收敛轮两组卡片（provider/model 下拉——数据来自官方
`llm.providers/models` RPC，目录不可用时降级文本输入；effort 下拉；timeoutMs 数字输入）、
includeProjectGuide 开关、consult/escalate 共用模型池可编辑行、engCoderMaxTokens /
engCoderEffort 输入。**保存全局默认** → 写 user 层（`config.json`）；**恢复默认** → 清 user 层
回落 base。非法值表单内联报错不提交（与一期解析链同源校验）。顶部为**当前会话视图**：
生效摘要（含覆盖来源标注）→「应用到当前会话」写该会话 `advisorOverride`（仅 advisor 子集，
优先级高于全局，见下方会话级覆盖）/「恢复会话默认」清除；活动会话 id 取不到时降级为
「复制 advisor_config 命令」文本框。host API 前缀：`/thincoder-suite/api`
（GET/PUT/DELETE `/config`、GET/DELETE `/session`、POST `/apply-session`；loopback 信任模型）。

### base 配置示例（cordis.patch.yml）

配置经插件 `cordis.patch.yml` 的 insert 行传入（link: 安装直接编辑克隆目录里的文件即可）——分组结构见设计文档 `docs/2026-09-01-advisor-config-design.md` §3.1：

```yaml
- insert:
    - id: thincoder-suite
      name: '@dsh-external/dsh-thincoder-suite'
      config:
        # 会诊 / 飞刀模型池（最多 5 个）。
        # 不配置则 escalate / consult 工具不注册；advisor / eng / eng_coder 始终可用。
        consultModels:
          - provider: provider-a        # 你 settings.yaml 里已配置的 provider
            model: strong-model-x
          - provider: provider-b
            model: strong-model-y
            effort: high                # 可选，映射 reasoningEffort
        # advisor 评审路由（不配置则跟随当前会话模型）——按轮次分层：
        advisor:
          round1:                      # 首次全量评审（advisorRound == 0；建议旗舰组）
            provider: provider-a
            model: reviewer-model
            effort: medium             # 可选 off|low|medium|high|max；缺省不传（适配器默认）
            timeoutMs: 900000          # round1 缺省 600000
          convergence:                 # 收敛轮（advisorRound >= 1，round 2+ 共用；建议快档）
            provider: provider-a
            model: fast-reviewer-model
            effort: low
            timeoutMs: 300000          # convergence 缺省 300000
          includeProjectGuide: false   # 评审是否注入 AGENTS.md（默认 false；评审只认显式 documents）
        # F9：eng_coder 子代理资源（缺省即安全值，一般无需配置）
        engCoderMaxTokens: 65536       # eng_coder 子代理输出预算（可选；缺省 65536）
        engCoderEffort: low            # eng_coder 子代理推理档（可选 off|low|medium|high|max；缺省 low；非法值忽略并警告）
        # 可选：其余开关
        engineering: false              # 所有会话默认进工程模式（默认 false）
        engTokenTtlMs: 3600000          # design token 有效期
        consultTimeoutMs: 600000        # 会诊子代理超时
```

字段说明（解析链与校验细节见设计文档 §3.2/§3.6）：

- **provider/model 成对解析**：合并后的组字段（会话覆盖 ⊕ 全局组）→ 旧字段 `advisor.provider/model`（仅 round1，兼容迁移）→ 主代理路由；任一步得到完整 provider/model 对即定案，禁止跨层混搭。两组都没配 → 评审跟随当前会话模型。
- **effort**：`off|low|medium|high|max`，映射 `reasoningEffort` 透传；非法值忽略并警告（N4），缺省不传（用适配器默认）。
- **timeoutMs**：单轮评审硬预算（绝对截止，见下）；合法区间 1000~3600000；非法值忽略并警告。
- **includeProjectGuide**：评审是否注入 `AGENTS.md` 项目记忆（默认 false——评审独立于项目记忆，需求/验收标准请显式传 `documents=[...]`；true 时按 16K 截断注入）。
- **engCoderMaxTokens / engCoderEffort**：eng_coder 子代理的输出预算与推理档（F9）——实现任务机械执行，低推理档把输出预算留给正文。

### 会话级覆盖（advisor_config 工具）

一期经对话内 `advisor_config` 工具操作当前会话的临时覆盖（`{ action: "get" }` 查看生效配置与来源标注；set/reset 见设计 §3.6）：

```
advisor_config request={"action":"get"}
advisor_config request={"action":"set","path":"round1.effort","value":"low"}
advisor_config request={"action":"reset","path":"convergence"}
```

会话覆盖优先于全局组配置（字段级合并，未覆盖字段回落全局——含 user 层与 base 的合并结果），会话销毁即失效；非法输入返回 `advisor_config: invalid input — <原因>` 且不改动现有覆盖。全局默认的二层编辑见上文（二期设置页写 user 层；恢复默认回落 base）。

### 迁移说明（v0.2 分组配置）

- 旧字段 `advisor.provider / advisor.model / advisor.timeoutMs` **仅映射 round1 组**（首次全量评审；timeoutMs 亦只作 round1 缺省来源）；**收敛轮（round 2+）不会沿用旧字段**——未配置 `advisor.convergence` 时收敛轮回落主代理路由（缺失组视为未配置，属正常回落而非错误）。
- 升级到分组配置后建议显式配置两组（round1 旗舰保质量、convergence 快档核销提速）：
  ```yaml
  advisor:
    round1:                 # 首次全量评审（旗舰）
      provider: provider-a
      model: strong-model
      effort: medium
      timeoutMs: 900000
    convergence:            # 收敛轮（快档）
      provider: provider-a
      model: fast-model
      effort: low
      timeoutMs: 300000
    includeProjectGuide: false   # 评审是否注入 AGENTS.md（默认 false）
  ```
- 详细设计见 `docs/2026-09-01-advisor-config-design.md`。

## thincoder-eng 预设（可选）

[`preset/thincoder-eng/`](./preset/thincoder-eng/) 是工程模式的一键入口：用它创建的会话从第一句起就是工程模式（架构师角色 + 门禁全开）。工具集 = DSH 内置 code（PTC）预设工具集 − Code-Mode 呈现（native 直调，含 `tool-bash`/`tool-pwsh` shell 工具，平台条件禁用与 code preset 逐字一致）。

**安装 / 同步**：把两个文件复制到 `~/.dsh/.agent-presets/thincoder-eng/`（本机 = `D:\DSH-Portable\profile\.agent-presets\thincoder-eng\`）：

```bash
mkdir -p ~/.dsh/.agent-presets/thincoder-eng
cp preset/thincoder-eng/* ~/.dsh/.agent-presets/thincoder-eng/
```

**preset 源文件变更后需重新同步**：改动发生在插件仓库的 `preset/thincoder-eng/*`（本仓库是单一事实源），部署副本不会自动跟随——再跑一次上面的复制命令；**新会话**生效（已运行会话不重装 preset）。

新建会话时选择 "Thincoder Eng" 预设即可。插件监听 `agent/session-start` 识别预设 id 自动进入工程模式——预设本身不重复装配插件（避免双实例）。

## 架构说明

- **host + client 双层** —— host 侧全部是 `.mjs`（advisor / eng / escalate / consult / 设置页 config API）；client 侧是手写 CJS（`lib/client.js`，设置页「Thincoder」，经 `dsh.client` 声明 + `exports["./client"]` 由 dsh-client-modules 装配）。两层都无 TypeScript、无打包步骤（继承 thincoder 的 zero-dependency 哲学；client 只依赖装配契约 dsh-client-runtime/ui-slots/connection 与壳 seed 的 react）。一期 host-only（交互经对话流工具卡片）；二期（本设置页）引入 client，host 工具不变
- **零 bare import** —— host 不 `import` cordis / schemastery：插件经 junction 安装后 Node 会 realpath 化，从安装目录向上解析不到宿主的包；工具手工构造 ToolDefinition 形状，插件契约只依赖 `export name / inject / apply`
- **advisor** = `ctx.llm.stream` 自管工具循环：每轮完整替换 system prompt，配只读工具集（read / glob / grep）；LLM 调用带 **绝对截止定时器**（单轮剩余预算到点即中止，不依赖 chunk 到达）与 chunk 级看门狗双保险（90s 无输出即中止，最多重试 3 次，仍失败转为可诊断的 `provider_stall` 错误；两类结束消息见设计 §3.4）——DSH 的 GenerateOptions 没有 per-request 超时字段，这是移植侧的替代机制
- **飞刀 / 会诊 / eng-coder** = `ctx.subagents.start`：模型覆盖（agentOptions）、深度限制（maxDepth）、工具过滤（toolFilter）
- **写门禁** = `tools/pre-execute` waterfall 拦截
- **设置页 config API** = `ctx.webServer.register` prefix `/thincoder-suite/api`（super-injector 同款；webServer 缺失时跳过注册仅 console.warn——host 工具不受影响）

## 与上游 thincoder 的差异

1. **LLM 调用超时**：上游有 per-request `FETCH_TIMEOUT`；DSH 的 GenerateOptions 无超时字段，移植版以 chunk 级看门狗（90s）+ 3 次重试替代，挂起的 provider 调用最终转为有界可诊断错误
2. **子代理宿主**：上游 spawn 独立 CLI 进程；移植版用 DSH 进程内 subagents（spawn / fork provider）
3. **eng 会话状态**：内存态（会话内 enter / exit 翻转），DSH 重启后回到配置默认值
4. **预设入口**：DSH 特有——工程模式的新会话一键入口用 agent preset 实现，机制本体留在插件（运行时状态机装不进静态预设）

## License

MIT —— 见 [LICENSE](./LICENSE)。基于 [thincoder](https://gitee.com/shanghai-xinbo/thincoder)（[thincoder.com](https://thincoder.com/)）移植，向上游贡献者致谢。

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.5 | 2026-09-02 | **设置页 UI 打磨（code review 收敛）**：样式全量换宿主语义 token（`--dsw-alias-*` 深浅色主题随动、不透明卡片表面、字号提升至正文 13.5/提示 12）；code review 2 轮收敛 11 项修复（stateOf 接线/记忆开关显示路径/模型池 poolDirty 语义/草稿从 user 层播种/错误可见可重试等）+ 分歧审计 D1（池保存丢失）/D2（cwdHint 形态）修复；交互与文案（组卡用途说明、字段中文标签、池列头、恢复默认二次确认、术语白话化）；测试 50/50 全绿 |
| v0.4 | 2026-09-02 | **二期设置页 UI（config.json user 层）**：全局默认配置分层（entry base ⊕ `$DSH_HOME/.thincoder/config.json` user 层，字段级白名单合并）；DSH 设置面板「Thincoder」页（手写 CJS client 免构建；round1/收敛组 + 记忆开关 + consult/escalate 池 + engCoder 项；保存即生效）；host config API（`/thincoder-suite/api`：GET/PUT/DELETE config、GET/DELETE session、POST apply-session；webServer 缺失降级仅 warn）；advisor/eng_coder 的 config 消费点统一合并 user 层（每次调用时读，U5）；导出校验 helper 供 host API 复用（评审 #5） |
| v0.3 | 2026-09-02 | **F10** design token 磁盘持久化（`$DSH_HOME/.thincoder/`，重启后 eng_coder 免重评审）；**F11** reviewType 切换重置评审轮次（code↔design 隔离）；thincoder-eng 预设补 PTC（code）工具集（tool-bash/tool-pwsh，native 呈现）；F8 判定启发式迭代至 v4（severity 单元格锚定 + 否定语境扩围）；默认 token TTL 对齐 1h；code review 加固（stream 关闭/超时消息/警告带出） |
| v0.2 | 2026-09-01/02 | **一期 host 机制**：advisor 分层路由（round1 旗舰 / convergence 快档）、effort 透传、评审记忆开关（includeProjectGuide）、会话级覆盖（advisor_config）、预算模型 + 超时硬生效（绝对截止）、旧配置兼容迁移；**F8** 评审通过判定修复（收敛轮 Fixed 表正常签发）；**F9** eng_coder 子代理资源与确认策略（maxTokens/reasoningEffort/禁提问/禁破坏性 git） |
| v0.1 | 2026-09-01 | thincoder 四机制（advisor/eng/escalate/consult）移植为 DSH 插件 |
