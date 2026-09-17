# dsh-thincoder-suite

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-8957e5)](https://github.com/topics/dsh-plugin)

把 [thincoder](https://gitee.com/shanghai-xinbo/thincoder)（[官网](https://thincoder.com/)）的四个自我纪律机制移植为 **DSH（DeepSeek Harness）** 桌面壳的单个 cordis 插件：

| 功能 | 工具 | 一句话 |
|------|------|--------|
| **advisor** 评审收敛 | `advisor` | 会终止、可对账、引用验真的多轮评审 |
| **eng** 工程模式 | `eng` / `eng_coder` | design-before-code 双门禁工作流 |
| **escalate** 飞刀 | `escalate` | 把任务交给更强的模型亲自写 |
| **consult** 会诊 | `consult_start` / `consult_stop` | 多模型并行只读会诊 |

> 本项目基于开源项目 [thincoder](https://gitee.com/shanghai-xinbo/thincoder) 移植改造（上游 MIT 协议），向 ThinCoder 贡献者致谢。

## v0.7+ 架构能力总览

在四机制之上，本插件已内置一套执行/自愈基础设施（全部插件自建，DSH 平台零修改）：

| 能力 | 一句话 |
|------|--------|
| **codex-cli runner** | 四机制均可路由到本地 codex CLI（`runner: codex-cli` 行）——advisor/consult 只读沙箱、escalate/eng_coder 写沙箱，followup 线程续轮 |
| **长任务后台化** | 预算 > `budgetCapMs`（默认 540s）自动派 `ctx.jobs` 后台 job——免平台 600s 墙钟、预算全额生效、完成通知送达；escalate/eng dsh 路径可显式 `background: true`；挂死兜底 `dshBackgroundTimeoutMs`（默认 30min） |
| **失败可归因** | 空响应四形态分类（finish/stop/length/error）+ 流观测（finish.kind/usage/blocks）；codex 信封上浮 usage、stderr 保尾；从不静默截断——同步路径钳制必响亮告警 |
| **自愈与封顶** | codex 连续 2 次失败自动回落 dsh 一轮；回落连败 2 次硬停并输出双路由诊断；空响应重试一次；任何零进度循环有界 |
| **并发与状态安全** | 三机制 per-session single-flight（复合键）；后台完成代际检查（晚到结果不复活已重置状态）；全局 codex 并发准入 `maxConcurrent`（默认 8） |
| **effort 智能校验** | 全部消费点按目标模型实际档位回落到**最近支持档**（等距向上取，绝不秒死）；**`off` 是关闭开关不是力度档——回落不落 `off`（仅退化兜底：模型除 `off` 外无力度档时才用并专属告警）；显式 `off` 关不掉时省略 effort 交还提供方默认并告警**（批 19）；设置页下拉目录化（dsh 行 /catalog、codex 行 codex catalog） |
| **安全模型（D-30）** | design token = 两段式 `uuid:expiresAt`（无签名腿，密钥链已删除）：授权靠**记录全等匹配** + **设计文档集指纹**（续期门控）+ 流程纪律；token/会话状态分文件落盘、回滚独立 |

## 为什么 advisor 不是又一个 code review

普通 AI review 的真实循环是 `while (true) { 找问题 }`：

- **无终止条件** —— 每轮都能报新问题，看似在进步，实际可能空转
- **锚定效应** —— 复审看到上轮结论，倾向于重复深化而非重新验证
- **证据不可验证** —— 报的文件 / 行号可能记错、看旧版本甚至编造
- **运动员兼裁判** —— 同一个模型既写代码又审自己刚写的代码

advisor 把它变成 `for round in 1..5 { 权限递减的对账 }`（**轮次上限只对 code 评审生效**——design 评审豁免 cap，由三振结算护栏兜底，见下）：

| 轮次 | 评审权限 |
|------|----------|
| Round 1 | 全量审查，建立 issue 清单 |
| Round 2 | 核销上轮清单 + 仅限致命新问题（crashes / data loss 级） |
| Round 3–5 | 严格只核销上轮响应表，不再找新问题 |
| 第 6 次调用（**仅 code 评审**） | 不经过 LLM，机械拒绝 |

配套的机械约束：

- **响应表协议** —— 被评审方每轮必须回 `| # | Action | Detail |`（Fixed / Dispatched / Not an issue / Deferred），逐条对账（`Dispatched` = 修复已派给子代理/后台 job、**尚未**返回经验证的结果，属「认领」而非「已解决」；Detail 必须点名派给了什么，未落地的 `Dispatched` 🔴 与未修复 🔴 同待遇）
- **引用验真** —— 评审报告中的 `file:line` 引用逐条与磁盘文件比对，伪造引用直接标注
- **每轮全新上下文** —— prior 输出以原文注入新会话，防锚定
- **预算按类型隔离（F11 + 批 4 成对吸收）** —— code review 与 design review 的**轮次预算不再共享**：5 轮 cap **只对 code 评审生效**（code 侧保留「改 A 报 B」的原始护栏），**design 评审豁免 cap**（第 6、7 次发起照常执行——设计文档天生要反复修订，「改文档 → 重评审」正是本机制的设计意图）；design 侧改由**三振结算护栏**兜底：同一文档集**连续三次跑不出可用结算**（超时 / 上下文截断 / 工具轮上限 / 空响应 / 内部兜底截止 / 陈旧结算 / 凭证落盘失败 / 无可用判决）⇒ 后续同键发起被**零 LLM 直接拒**（工具层与核心层双入口），且**不可自解除**（改配置、回滚文件、编辑文档都不复位；唯一出口 = 新会话）。用户主动中断不计振。**两半必须成对**：只豁免 = 撤掉唯一的界（无结算循环无上界）；只护栏 = 设计评审仍被 cap 误杀。另：**reviewType 切换（code ↔ design）时重置轮次与 prior**，且**设计评审链按文档集作用域**（批 4 D-35 折入：换一份设计文档集等价于类型切换——轮次归 0、prior 清空、走 round-1 提示词，防「第二份文档拿到收敛轮提示词 + 别的文档的 prior」）
- **超时硬生效（F5）** —— 单轮评审硬预算 = 该轮组 `timeoutMs`，绝对截止定时器 + chunk 墙钟双检查，静默流/稳定涓流都在预算时刻被中止（消除 606~699s 超跑）；裁决顺序绝对截止优先，stall 重试不豁免预算

## 工程模式 eng

design-before-code 的运行时门禁：

- `eng`（action: `enter` / `exit`）—— 会话内切换架构师角色
- enter 后模型只做需求澄清和设计文档，**设计评审由用户发起**——agent 不能自己评审自己拿 token
- 设计评审的**每一轮**（round 1 与收敛轮）user 消息都携带 `## Approval Signal`——8 位批准码（`[APPROVE:<8hex>]`；token 每评审会话只铸造一次、每轮同码，token 本体不进提示词）。评审通过且无 🔴 Critical 时，advisor 回显 `[APPROVE:<code>]`，宿主校验命中后注入完整 design token（附有效期提示）；`eng_coder` 携带该 token 派实现子代理（token 机械校验，不消费、可多次 spawn；后续评审不通过则撤销，拒绝消息按「未签发 / 已过期 / 不一致」三态分别提示——**已过期**一态在 D-30 后细分为「自动续期 / 文档已变更 / 无法续期 / 旧版本令牌」四路，见下）
- **双写门禁** —— 工程模式 ON 且主代理无有效 token 时，`write`/`edit` 对产品代码路径的调用被 `tools/pre-execute` 拦截：`src/**` 一律算产品代码，其他目录里非文档扩展名也算；`docs/**` 与根级文档（`.md` / `.txt` 等）豁免——那是架构师的产出物。间接写（shell 等）不拦，靠流程纪律，与上游同款取舍
- 子代理交付后自动触发交付 code review；变更合并回父会话并重置评审预算

### design token 跨重启持久化（F10）

评审签发的 design token 除内存态外还会镜像到 `$DSH_HOME/.thincoder/design-tokens.json`（profile 根下，与 `super-injector/`、`undo-snapshots/` 平级）——DSH 重启后，同一会话的 `eng_coder` 校验在内存无 token 时自动查盘：本 sessionId 有条目且回传 token 与记录全等且形状/有效期校验通过 → 回填内存态并通过，**有效期内无需重新评审**。

- **只增不改签发协议**：签发判定、TTL（`engTokenTtlMs`，缺省 **7d**）、三态拒绝（未签发 / 已过期 / 不一致）语义不变——磁盘只是第二存储，内存态仍是第一存储与签发源；磁盘格式为**纯追加**（新增 `docHash`/`docPaths` 条件字段，无迁移脚本，旧记录读得动）
- **过期续期（D-30 / FR-T5）**：过期时 `eng_coder` 先问「设计文档集变了吗」——`docHash`（路径 **+** 内容双绑的指纹）一致 → **同一 uuid 顺延** `expiresAt`（新令牌串随工具返回文本回传，须**替换你手里的副本**）；文档变了 / 不可读 / 无指纹 → 拒绝并指向重评。**未过期路径不做文档校验**（有意取舍：否则每次合法的文档澄清都要重评）
- **清扫规则（D-30 / FR-T8）**：写入时全量清扫——畸形记录删除；未过期保留；已过期**且带** `docHash` 的记录**保留**（它是续期输入，保留期上限 = `ENG_TOKEN_TTL_MAX_MS` = 30d，锚点 = `expiresAt`）；已过期且无 `docHash` 删除
- **fail-safe**：文件损坏 / 路径不可写 / 被外部删除 → 仅 `console.warn`，签发与校验不崩溃、不误放行（续期时写盘失败 → 内存仍顺延 + 响亮告警）；删除存储文件即回到 F10 前的纯内存行为
- **安全模型（D-30 改写）**：token 是**两段式 `uuid:expiresAt`，无签名腿**——HMAC 签名与整条密钥链已删除（威胁模型见需求档 §2.3：门禁刻意 fail-open 属纪律护栏而非安全边界；真正挡住伪造的是**记录全等匹配**；密钥与 token 镜像同目录，能写后者者几乎必然能读前者）。新论证 = **全等匹配 + 设计文档集指纹 + 流程纪律**，不再依赖「短 TTL 限制暴露面」（TTL 已放宽到 7d，且文档未变即可续期）。**审批码**（`[APPROVE:<code>]`）保留但改为无状态派生 `sha256(uuid).slice(0,8)`——uuid 由宿主生成且从不进提示词，故对主代理不可预测
- **升级注意（D-30）**：旧**三段式**令牌形状已不兼容（干净切换，**不做**旧格式兼容验签）——`eng_coder` 会明确报「旧版本令牌」并指引重跑一次评审。旧密钥环境变量 `THINCODER_TOKEN_SECRET` 已**无任何作用**（启动时一次性弃用告警）；磁盘上的 `.thincoder/token-secret` 成为**孤儿文件，声明不清理、留档**（删除属破坏性动作，不在本批范围）

详细设计见 `docs/2026-09-02-thincoder-suite-extensions-design.md` §2.1。

### 会话级状态持久化（F12）

工程模式与评审协议推进状态（`engineering` tri-state、`advisorRound`/`lastAdvisorOutput`/`lastReviewType`、`mutatedThisRun`、`touchedFiles`、`advisorOverride`、`lastDesignDocKey`——后者 = 设计评审链的**文档集作用域键**的派生摘要，批 4 §12）镜像到 `$DSH_HOME/.thincoder/session-state.json`（与 `design-tokens.json` **分文件**——回滚独立：删 session-state.json 回纯内存行为，token 不受牵连）。宿主恢复会话时 `agent/session-start` 预载恢复：会话 Map 无该 key 且盘上条目在 7d TTL 内 → 白名单校验 + 规范化后整条灌入（**只填空槽**——本进程已活跃/已推进的会话不被盘上陈旧条目覆盖）；`engineering === true` 恢复后自动重挂工程模式人格 section。

- **写点**（§2.3 语义转换点，非每次 mutation）：eng enter/exit 翻转后、advisor 完成分支轮次推进后与 F11 类型切换重置后、eng_coder/escalate 交付后、advisor_config set/reset 与设置页 apply/reset-session 后；`lastAdvisorOutput` 落盘前超 32K 截断 + `[truncated]` 标记、`touchedFiles` 去重封顶 200
- **原子组**：round 与 prior 一起落盘；恢复时 `round>0 且无 prior → round=0`（单存轮次会恢复出「无 prior 的收敛轮」，恢复侧规范化消解）
- **清理**：`session/disposed` 删除条目 + 写时全量清扫 `lastSeen` 超 7d 孤儿（TTL 是防泄漏常量，非用户配置）
- **fail-safe**：文件损坏/缺失/超 TTL → 回落纯内存行为；写失败仅 `console.warn`（丢=回上一写点的内存语义）
- **凭证隔离**：session-state.json **绝不含 designToken**（F10 token-store 单路管理，双盘写=双事实源）
- **边界**：停机期间改了 config 默认 → 恢复的显式翻转值胜出（tri-state 优先级内建，启动日志一行观测）；换 preset 后恢复 engineering=true → 人格段并存（接受并文档化）
- **已知限制**：单宿主进程多会话并发 read-modify-write 为 last-write-wins（写低频 + 丢=回内存行为，接受）

详细设计见 `docs/2026-09-02-session-state-stages-design.md` §2。

### eng_coder 阶段化任务书（F13）

`eng_coder` 新增可选结构化参数 `stages`（每项 `{ goal, files, acceptance, check }` 全必填非空，schema `maxItems: 10`，建议 2–8 个可自查交付增量；渲染前另有代码级防御校验）——大任务按显式阶段执行：统一编号四段渲染（`### Stage N — goal / Files / Acceptance / Self-check`）+ 阶段纪律（按序执行；自查不过不进下一阶段；阶段内只动本阶段 files；同一阶段第二次真修仍失败 → STOP 上报；跨阶段文件需求 → STOP 上报）。

- **单次 spawn 跑完全部阶段**（有意设计，勿改 per-stage：每阶段一 spawn 会触发 advisorRound 清零 + touchedFiles 合并的隐性耦合，且 docs 重复读、上下文断裂）
- **stage 状态表前置**：交付报告必须以 `| Stage | Status (passed/failed/skipped) | check summary |` 开头——输出被 max-tokens 掐断也保住分类账（Touched files 被掐丢可从表内 Files 列重建）；预算将尽 → 停止开启新阶段、跑完当前 check、以 stage 表收尾
- **阶段失败**：父代理裁决后新开一次 eng_coder（从失败阶段起 corrected stages）——token 不消费可多次 spawn；不做整体自动重试
- **漂移探测**：未传 stages 但 task 文本匹配 `/stage|阶段\s*\d/i` → 返回前缀警告（提醒改用结构化参数）
- **零回归**：stages 缺省时任务书逐字节等于现行（fixture 回归锁死——三个历史交付共同依赖的契约）

详细设计见 `docs/2026-09-02-session-state-stages-design.md` §3。

### ★ 同步 vs 后台：长任务必须显式传 `background: true`

**这是调用方唯一需要做的决定，而它的代价是「任务能不能活过 10 分钟」。**

`eng_coder`（以及 `escalate`）的 dsh 路径**默认同步**：父代理**阻塞等待**子代理结束。平台的 **`run_code` 有 600s 硬墙钟**——子代理跑过 10 分钟，**父代理的这次工具调用先死，子代理被连带杀死**，而且**交付报告拿不到**。

| 调用方式 | 谁在等 | 生效的截止 | 结果 |
|---|---|---|---|
| **不传 `background`**（缺省 = 同步） | **父代理阻塞** | `codexCli.budgetCapMs`（内部截止，**缺省 540s——刻意低于平台 600s**） | 插件在平台之前**温柔超时**，你能拿到诊断；**但任务本身活不过 10 分钟** |
| **传 `background: true`** | 父代理**立即返回 job 句柄** | **`dshBackgroundTimeoutMs`**（缺省 **30min**，区间 1–60min） | **不占父代理墙钟**，预算全额生效，完成时**通知**（通知只含一行指针，全文要 `job_output` 读） |

**⚠ 前置：后台依赖 `ctx.jobs` 的运行时装配。** 需要 **`dsh-jobs-local` + `dsh-tool-jobs`** 两个插件。**未装配时 `background: true` 不会报错，而是响亮告警并回落同步执行**（那时仍会撞 600s）——所以**先确认这两个插件在，再依赖后台**。

**⇒ 两个截止键的分工（别配错旋钮）**：

- **`codexCli.budgetCapMs`**——**同步路径**的预算上限。它管的是「同步执行时，插件允许跑多久才自己掐掉」。缺省 540s，**须低于平台 `run_code` 的 `maxWallMs`**。
- **`dshBackgroundTimeoutMs`**——**后台路径**的挂死兜底截止。缺省 1800s。**后台路径不读 `budgetCapMs`。**

**⇒ 常见误配**：为了跑长任务去调大 `budgetCapMs`，**在后台路径上不起作用**（后台读的是 `dshBackgroundTimeoutMs`）；而**同步路径上它也不能超过平台墙钟**。**要跑过 10 分钟，正解是传 `background: true`，不是调 `budgetCapMs`。**

> **登记**：`lib/eng.mjs` 里同步路径的到点文案写的「超内部截止（**budgetCapMs**=…）」把这个 codex 侧的键名用在了 dsh 子代理路径上，**会把人引向错的旋钮**——见 `docs/2026-09-05-defect-registry.md`。

配套 **thincoder-eng 预设**（见下文）：新会话一键从工程模式开始。

## 飞刀 escalate

判断任务超出自己能力时（复杂多文件重构、疑难 bug、精妙算法），把任务连同**写权限**交给 consultModels 池里的更强模型——它亲自改代码，返回术后报告（改了什么 / 为什么 / 怎么验证），你负责验收（读变更文件、跑测试）。

护栏：子代理内不可再飞刀（防递归甩锅）；工程模式下 fail-closed 拒绝（工程模式的实现只能走 `eng_coder`）。

## 会诊 consult

卡在同一个问题上反复失败、没有头绪时：

1. `consult_start(problem)` —— 非阻塞发起：多个配置模型**并行独立**分析同一问题（只读），立即返回会诊 id + 后台 job 句柄
2. **等自动投递** —— 会诊走平台 `jobs`（与 advisor / eng_coder / escalate 同形）：settle 时**你会在会话内被通知**（忙 ⇒ 注入下一个 step；空闲 ⇒ 自动开一个回合）。**不需要轮询，也不需要自己回来**
3. `job_output` —— 完成通知只含一行指针，**先读全 digest**再判断：digest 逐条列出每个模型的原始回复、交付数与**有效数**、会话 id 与纪要落点
4. 逐条处置（采纳 / 不采纳**附理由** / 待定）+ 写纪要裁定层 → **缺省停下向用户汇报**（三档显式豁免见 `lib/prompts/main.md`）
5. `consult_stop(id, n)` —— 某条回复够用了就提前终止剩余会诊，省 token。**早停不再丢东西**：会话照产「墓碑 digest」（已收到的回复 + stop 死亡行）并照常投递

> **纪要默认落档**：机制在 settle 时先写 `docs/consult-minutes/<date>-consult-<id>-minutes.md` 的 §0 汇总 + §1 原始层（**写盘先于 job complete** —— 投递成不成功，纪要都在盘上），§2–§5 的裁定层由主代理写。未消化的会诊会**拦住下一次 `consult_start`**（拒发并内联未消化的 digest）。

会诊子代理**能看主会话历史**——本移植把它实现为**历史尾部直接注入会诊 prompt**（60KB 预算，图片折叠为占位符），**不是**一个 `main_history` 工具（DSH 的工具注册表是会话级、无法隔离给子代理，见 `lib/consult.mjs` 档头）。

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
`advisor.round1/convergence` 组（provider/model/effort/timeoutMs/runner）、`advisor.includeProjectGuide`、`advisor.maxOutputTokens`、
`advisor.contextTokens`、`advisor.standardsDoc`、`advisor.documentMapDoc`、`advisor.criteriaDoc`、`consultModels`（整体替换）、
`engCoderMaxTokens`、`engCoderEffort`、`codexCli`、`dshBackgroundTimeoutMs`、`consultTimeoutMs`、`engTokenTtlMs`——其余字段（`engineering` 等）
只在 base 配。文件示例：

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
        engCoderEffort: medium         # eng_coder 子代理推理档（可选 off|low|medium|high|max；缺省 medium；非法值忽略并警告）
        # dsh 后台任务挂死兜底（R5；可选；缺省 1800000=30min，合法 60000..3600000）
        dshBackgroundTimeoutMs: 1800000
        # codex-cli runner 全局节（可选；配了任何 codex 行/后端才需要）
        codexCli:
          executable: codex            # 可执行名或完整路径（缺省 PATH 上的 codex）
          model: gpt-5.6-sol           # codex 默认模型（可选）
          engCoderRunner: codex-cli    # eng_coder 走 codex 后端（可选；缺省 dsh 子代理）
          defaultTimeoutMs: 600000     # codex 任务默认预算（缺省 600s）
          budgetCapMs: 540000          # 同步执行预算上限——超过则派后台 job（缺省 540s，须低于平台 maxWallMs）
          maxConcurrent: 8             # 全局 codex 并发上限（fail-fast 不排队；缺省 8）
          idleTimeoutMs: 300000        # 写任务假死判定（事件流静默窗口；缺省 300s）
        # 可选：其余开关
        engineering: false              # 所有会话默认进工程模式（默认 false）
        engTokenTtlMs: 604800000       # design token 有效期（ms；合法 600000..2592000000 = 10min..30d；缺省 7d）
        consultTimeoutMs: 1800000       # 会诊子代理超时（ms；合法 30000..3600000 = 30s..1h；本仓库 base 示例值见 cordis.patch.yml）
```

> **D-29**：`engTokenTtlMs` 与 `consultTimeoutMs` 现已可从**设置页**修改（此前只认 entry base 的这份配置，设置页改不动）。两键都进 user 层白名单，优先级 user > base。
> **D-30**：token 缺省有效期改为 **7d**（`cordis.patch.yml` base 同步为 604800000），且**过期 ≠ 必须重评**——设计文档集未变时 `eng_coder` 自动续期（同一 uuid 顺延有效期，新令牌串随返回文本给出，请替换你手里的副本）；文档变了才必须重跑设计评审。TTL 仍是陈旧度护栏，不再是「短 TTL 限制暴露面」式的安全边界。
> `consultTimeoutMs` 是**单个模型**的看门狗：超时只把该模型记成超时失败，不终止整轮会诊。

字段说明（解析链与校验细节见设计文档 §3.2/§3.6）：

- **provider/model 成对解析**：合并后的组字段（会话覆盖 ⊕ 全局组）→ 旧字段 `advisor.provider/model`（仅 round1，兼容迁移）→ 主代理路由；任一步得到完整 provider/model 对即定案，禁止跨层混搭。两组都没配 → 评审跟随当前会话模型。
- **effort**：`off|low|medium|high|max`，映射 `reasoningEffort` 透传；非法值忽略并警告（N4），缺省不传（用适配器默认）。
- **timeoutMs**：单轮评审硬预算（绝对截止，见下）；合法区间 1000~3600000；非法值忽略并警告。
- **includeProjectGuide**：评审是否注入 `AGENTS.md` 项目记忆（默认 false——评审独立于项目记忆，需求/验收标准请显式传 `documents=[...]`；true 时按 16K 截断注入）。
- **engCoderMaxTokens / engCoderEffort**：eng_coder 子代理的输出预算与推理档（F9）。**engCoderEffort 缺省 `medium`**——批 19 起 effort 回落只在力度域内进行：`off` 是关闭开关，不参与距离竞争（**任何力度档都不会再被静默换成 `off`**；仅当模型除 `off` 外无任何力度档时退化兜底到 `off` 并专属告警），显式配 `off` 而模型不支持时省略 effort 交还提供方默认并告警。批 14 当时选 `medium` 的「`low` 可能被静默落到 `off`」理由（**as-of 2026-09-16** 的真值）已随批 19 根修成为历史记述，缺省值维持 `medium` 不变；实现任务仍由 brief 机械执行，普通档足以完成「按文档改文件」，推理档再高只是白白吞噬输出预算。

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

- **host + client 双层** —— host 侧全部是 `.mjs`（advisor / eng / escalate / consult / 设置页 config API；D-30 新增 `lib/doc-hash.mjs`——文档集指纹的单点实现）；client 侧是手写 CJS（`lib/client.js`，设置页「Thincoder」，经 `dsh.client` 声明 + `exports["./client"]` 由 dsh-client-modules 装配）。两层都无 TypeScript、无打包步骤（继承 thincoder 的 zero-dependency 哲学；client 只依赖装配契约 dsh-client-runtime/ui-slots/connection 与壳 seed 的 react）。一期 host-only（交互经对话流工具卡片）；二期（本设置页）引入 client，host 工具不变
- **零 bare import** —— host 不 `import` cordis / schemastery：插件经 junction 安装后 Node 会 realpath 化，从安装目录向上解析不到宿主的包；工具手工构造 ToolDefinition 形状，插件契约只依赖 `export name / inject / apply`
- **advisor** = `ctx.llm.stream` 自管工具循环：每轮完整替换 system prompt，配只读工具集（read / glob / grep）；LLM 调用带 **绝对截止定时器**（单轮剩余预算到点即中止，不依赖 chunk 到达）与 chunk 级看门狗双保险（90s 无输出即中止，最多重试 3 次，仍失败转为可诊断的 `provider_stall` 错误；两类结束消息见设计 §3.4）——DSH 的 GenerateOptions 没有 per-request 超时字段，这是移植侧的替代机制
- **飞刀 / 会诊 / eng-coder** = `ctx.subagents.start`：模型覆盖（agentOptions）、深度限制（maxDepth）、工具过滤（toolFilter）
- **写门禁** = `tools/pre-execute` waterfall 拦截
- **设置页 config API** = `ctx.webServer.register` prefix `/thincoder-suite/api`（super-injector 同款；webServer 缺失时跳过注册仅 console.warn——host 工具不受影响）

## 与上游 thincoder 的差异

> **★ 两类差异要分清**（批 15 的教训）：**「本仓有意偏离」**（下面的 1–5 条，是移植时的**设计决定**）与 **「上游改了而本仓未跟」**（**滞后**，是**欠账**）。**混在一起看会掩盖后者。**
>
> **权威记录不在这里**——在**各批设计档的「上游偏离表」**里（六列：本仓行为 / 上游行为 + **坐标** / 方向 / 理由 / 复检条件 / 锚）。最近一份见 [`docs/2026-09-15-consult-delivery-design.md`](./docs/2026-09-15-consult-delivery-design.md) §10。

**★ 已知滞后（2026-09-15 批 15 发现，已补偿）**：**本仓在 consult 协议上曾落后上游六天**——上游在 **`3e1234b`（2026-09-07 04:10）** 以 digest 自动注入**退役了 `consult_check`**，而**本仓的复制源是 `3e1234b^`、首个提交 `aeffdf7`（2026-09-01）**，且**从未记录这次分叉** ⇒ 直到批 15 才发现并补齐。**⇒ 教训已登记为 R-40**：**移植是抄一个时间点，而源会继续走**；移植物**必须记下被抄的坐标**，否则日后无法判断「是本仓落后还是有意偏离」。

**有意偏离（移植决定）**：

1. **LLM 调用超时**：上游有 per-request `FETCH_TIMEOUT`；DSH 的 GenerateOptions 无超时字段，移植版以 chunk 级看门狗（90s）+ 3 次重试替代，挂起的 provider 调用最终转为有界可诊断错误
2. **子代理宿主**：上游 spawn 独立 CLI 进程；移植版用 DSH 进程内 subagents（spawn / fork provider）
3. **eng 会话状态**：内存态为主 + `$DSH_HOME/.thincoder/session-state.json` 镜像（F12）——`agent/session-start` 预载恢复 engineering/评审轮次（只填空槽，7d TTL，7 天以上未见的孤儿写时清扫）；删除该文件即回纯内存行为
4. **design token 格式**：上游是裸 `uuid:expiresAt` 且 TTL 7d（`design-token.mjs`）——本插件直到 D-30 才与之对齐（此前多一条 HMAC 签名腿与密钥链，D-30 按威胁模型复核整体删除，审批码保留但改无状态派生）；差异收敛后，本插件另加**文档集指纹门控续期**（上游无此机制）
5. **预设入口**：DSH 特有——工程模式的新会话一键入口用 agent preset 实现，机制本体留在插件（运行时状态机装不进静态预设）

## License

MIT —— 见 [LICENSE](./LICENSE)。基于 [thincoder](https://gitee.com/shanghai-xinbo/thincoder)（[thincoder.com](https://thincoder.com/)）移植，向上游贡献者致谢。

## 变更记录

完整变更历史见 [CHANGELOG.md](./CHANGELOG.md)。近期版本：

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.12.0 | 2026-09-13 | **批 4 设计评审豁免 5 轮上限 + 三振结算护栏（成对吸收）+ D-35 折入**：cap 只对 code 生效（消息体逐字节不变）；同文档集连续 3 次无可用结算 ⇒ 拒绝再发起（零 LLM、零状态变更、双入口）；键 = 归一化路径表（非内容哈希）、计数 = 会话内存、清理挂 `session/disposed`；可用判决与显式 FAIL 复位；codex `ABORTED`→`interrupted`（不计振）；**设计评审链按文档集作用域**（换集即等价类型切换，与 F11 合成单一重置谓词）+ `lastDesignDocKey` 落盘（摘要形态）。340 测试全绿 |
| **v0.23.0** | 2026-09-16 | **批 14 配置面与描述面同步**：`engCoderEffort` 默认值 `low` → **`medium`**（`low` 是唯一在一切非退化支持集上都可能被静默落到 `off` 的程度档 = **推理全关且无提示**），且回落目标与初值**同源一个常量**；白名单散文**立常设谓词**（三轴 8/6/2/5 = 21，逐文件 + 先钉基数 + 双向）；F8 假警告**两分支都治**；到点文案补 `codexCli.` 前缀 + **前置告警仅同步路径**；`lib/**` **十处 / 七档悬空引用删指针**。456 测试全绿 |
| **v0.22.0** | 2026-09-15 | **批 15 会诊结果的投递与消化**：consult 改走**平台 `jobs` 投递**（settle 时**先落盘纪要、再 complete**）· **退役 `consult_check`**（上游 `3e1234b` 已删，本仓落后六天）⇒ 家族 **3 工具 → 2** · 消化门禁（未消化的会诊**拦住下一次发起**）· 纪要默认落档 `docs/consult-minutes/` · **`stopped` 会话产墓碑 digest**（不丢已收到的回复）。453 测试全绿 |
| **v0.21.0** | 2026-09-15 | **批 13 登记面与判据面余项**：七条老登记**逐条回盘核**（登记表是快照，它的家只有人眼闸）——**三条描述是错的、两条范围比登记大得多、一条比登记更便宜**。453 测试全绿 |
| **v0.20.0** | 2026-09-15 | **批 12 锁收窄**：`WRITE_GATE_FIXTURE` 原逐字节保存 `makeWriteGate` **整个函数体**（79 行，其中 32 行是注释）⇒ 改一个字注释就要重刷 79 行 ⇒ 收窄为**语义锁**。 |
| **v0.19.0** | 2026-09-13 | **批 11 文档纪律成文**：D1–D7 从「**引用 22 次的未定义编号**」变成可读的七条法律（真正的内容原先只活在上游提示词里）⇒ 落进 `METHODOLOGY.md`。 |
| **v0.18.0** | 2026-09-13 | **批 10 台账纪律 + D-31**：**D-31 实测为数据丢失而非排版问题**——未知顶层配置键原走 `notes` 而非 `errors` ⇒ PUT 返 **200「已保存」** 而 `saveUserConfig` 是**整体替换** ⇒ **整层 user 配置被静默清空**。 |
| **v0.17.0** | 2026-09-13 | **批 9 测试生命周期三层 + 发布门 + `verify` 门禁**：痛点不是「测试太多」，而是「**锁坏了没人知道**」+「**数字漂了没人知道**」（实证：批 7 审计抓到一条静态锁**自称覆盖六子点、实测只证 4 个且一条断言是 tautological**）。 |
| **v0.16.0** | 2026-09-13 | **批 8 提示词公共层（裁减版）**：形态 = **零改面**（四个 advisor 提示词与 `lib/prompts.mjs` **零字节改动**）——交付物 = **一份契约 spec + 一条双向锁测试**。 |
| **v0.15.0** | 2026-09-13 | **批 7 可移植性三件**：让产品提示词**不再绑定任何具体仓库**——评审的判据来源由**项目自己声明**（缺省时**显式降级**而非静默），且「这个路径是文档还是代码」**只有一个权威实现**。 |
| **v0.14.0** | 2026-09-13 | **批 6b 守卫 E**：把「评审窗口内被审文档不得被改动」从**流程纪律**升级为**机制不变式**——窗口开启时**事前拦**、结算时**事后核**（签发前重算指纹，失配则本次不签发）。 |
| **v0.13.0** | 2026-09-13 | **批 6 死亡可诊断**：让**每一种死亡自证来源**（哪一层按下的 + 因为什么）在**一次工具返回里可判**——动机有**生产事故实证**（`consult.mjs` 头注自认会「2 秒内被杀且从未发出模型请求」）。 |
| v0.11.0 | 2026-09-13 | **批 5 评审上下文预算跟随模型窗口 + 估算器 CJK 加权**：`MAX_CONTEXT_TOKENS = 120_000` 退役，改三级链（手配 `advisor.contextTokens` > `llm.resolveModelInfo().context.contextWindow` > 兜底 131072）；两档 = `floor(窗口 × 0.8)` 与再 `× 0.8`；估算器逐消息 `ceil(ascii/4) + 非ASCII`（纯 ASCII 逐值零回归）；新键三面同步（PUT ⊕ merge ⊕ 设置页）。320 测试全绿 |
| v0.10.0 | 2026-09-11 | **D-30 design token 生命周期**：两段式 `uuid:expiresAt`（删签名腿与整条密钥链）、**文档集指纹门控续期**（文档未变 → 同 uuid 顺延，变了才重评）、审批码改无状态派生 `sha256(uuid).slice(0,8)`、缺省 TTL 7d、token-store 两缺口修复（保存路径补 `docHash`/`docPaths` + 清扫保留可续期记录）、旧三段式令牌诚实识别、会诊跨回合口径修正（FR-T7）；同版含 **D-29** 配置面（`consultTimeoutMs`/`engTokenTtlMs` 进 user 层白名单） |
| v0.10.0 | 2026-09-13 | 批 3 **评审协议增强**（未 bump 版本号，随 v0.11.0 起统一）：VERDICT 收尾行成为主信号、Action 四值词表（补 `Dispatched`）、判定规则 R1–R7e、失败可见六路诊断、撤销面收紧（FR-6 守卫：猜出来的 FAIL 不再销毁有效令牌） |
| **v0.9.2** | 2026-09-09 | **D-28 会诊跨回合失效修复（生产缺陷）**：`consult_start` 把调用方 `exec.signal` 直传子代理，而 PTC 模式下它是 `run_code` 程序的 **run-scoped 控制器**——会诊是「本回合 start、后续回合 check」的跨回合协议 ⇒ 子代理**在启动 1~3 秒内被杀**（从未发出模型请求）。**生产实证：21 次尝试 20 次失败**。修复 = 改插件自持 `AbortController`（取消只走 stop / 看门狗 / session 销毁三条显式路径）。235 → **241** 测试全绿 |
| v0.9.1 | 2026-09-07 | **R6 维护轮**：D-26 十项打磨全清（告警对称/签名清理/空输出统一/簿记单一实现/回滚指引/派发告警可见）——登记表 27/27 终态，235 测试全绿 |
| v0.9.0 | 2026-09-06 | **R5 dsh 路径后台化（DP-1 方案 B）**：advisor dsh 自动按预算派后台 job、escalate/eng 显式 `background` 参数、`dshBackgroundTimeoutMs` 挂死兜底——四机制全部免墙钟，平台零修改 |
| v0.8.0 | 2026-09-05/06 | **R1-R4 机制缺陷治理**：effort 最近档收口、流观测/空响应分类、codex 三路径 jobs 迁移、single-flight+代际检查、回落硬停+空响应重试、保存竞态+runner 三面同步、token-secret 安全加固（26 项登记缺陷收口） |
| v0.7.0 | 2026-09-05 | **codex-cli runner 集成**：四机制 codex 路由（读/写沙箱、followup 续轮）、ctx.jobs 后台派发、智能回落、设置页目录化 |
| v0.6 | 2026-09-03 | F12 会话级状态持久化 + F13 eng_coder 阶段化任务书（stages） |
| v0.6 | 2026-09-03 | **F12 会话级状态持久化**：`$DSH_HOME/.thincoder/session-state.json`（与 design-tokens.json 分文件、回滚独立、原子写 tmp+rename）——engineering/评审轮次+prior/lastReviewType/mutatedThisRun/touchedFiles(去重封顶 200)/advisorOverride 跨重启恢复（`agent/session-start` 预载、只填空槽、engineering=true 重挂人格 section、7d TTL 写时清扫、session/disposed 删除、**绝不含 designToken**）；公共路径解析抽 `lib/dsh-home.mjs`（token-store/config-store 两处单一化 + token-store 顺带升级原子写，行为零变化）。**F13 eng_coder 阶段化任务书**：可选 `stages` 结构化参数（schema maxItems 10 + 渲染前防御校验）——统一编号四段渲染、阶段纪律（自查不过不进下一阶段/两败 STOP）、stage 状态表前置（max-tokens 掐断生存性）、预算将尽条款、漂移探测前缀警告；stages 缺省时 brief 逐字节等于现行（fixture 回归锁死）。**D 复核**：评审工具输出预算确认已对齐上游 64K（readonly-tools 不动，新增 T17 截断阈值+续读指针回归锁）；compactMessages keyFiles 去重 + 上限 15（防中段压缩后评审重复读已查文件）；测试 50 → 78 全绿 |
| v0.5 | 2026-09-02 | **设置页 UI 打磨（code review 收敛）**：样式全量换宿主语义 token（`--dsw-alias-*` 深浅色主题随动、不透明卡片表面、字号提升至正文 13.5/提示 12）；code review 2 轮收敛 11 项修复（stateOf 接线/记忆开关显示路径/模型池 poolDirty 语义/草稿从 user 层播种/错误可见可重试等）+ 分歧审计 D1（池保存丢失）/D2（cwdHint 形态）修复；交互与文案（组卡用途说明、字段中文标签、池列头、恢复默认二次确认、术语白话化）；测试 50/50 全绿 |
| v0.4 | 2026-09-02 | **二期设置页 UI（config.json user 层）**：全局默认配置分层（entry base ⊕ `$DSH_HOME/.thincoder/config.json` user 层，字段级白名单合并）；DSH 设置面板「Thincoder」页（手写 CJS client 免构建；round1/收敛组 + 记忆开关 + consult/escalate 池 + engCoder 项；保存即生效）；host config API（`/thincoder-suite/api`：GET/PUT/DELETE config、GET/DELETE session、POST apply-session；webServer 缺失降级仅 warn）；advisor/eng_coder 的 config 消费点统一合并 user 层（每次调用时读，U5）；导出校验 helper 供 host API 复用（评审 #5） |
| v0.3 | 2026-09-02 | **F10** design token 磁盘持久化（`$DSH_HOME/.thincoder/`，重启后 eng_coder 免重评审）；**F11** reviewType 切换重置评审轮次（code↔design 隔离）；thincoder-eng 预设补 PTC（code）工具集（tool-bash/tool-pwsh，native 呈现）；F8 判定启发式迭代至 v4（severity 单元格锚定 + 否定语境扩围）；默认 token TTL 对齐 1h；code review 加固（stream 关闭/超时消息/警告带出） |
| v0.2 | 2026-09-01/02 | **一期 host 机制**：advisor 分层路由（round1 旗舰 / convergence 快档）、effort 透传、评审记忆开关（includeProjectGuide）、会话级覆盖（advisor_config）、预算模型 + 超时硬生效（绝对截止）、旧配置兼容迁移；**F8** 评审通过判定修复（收敛轮 Fixed 表正常签发）；**F9** eng_coder 子代理资源与确认策略（maxTokens/reasoningEffort/禁提问/禁破坏性 git） |
| v0.1 | 2026-09-01 | thincoder 四机制（advisor/eng/escalate/consult）移植为 DSH 插件 |
