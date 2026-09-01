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
- **预算共享** —— code review 与 design review 共用 5 轮预算，修完复审不重新计数

## 工程模式 eng

design-before-code 的运行时门禁：

- `eng`（action: `enter` / `exit`）—— 会话内切换架构师角色
- enter 后模型只做需求澄清和设计文档，**设计评审由用户发起**——agent 不能自己评审自己拿 token
- 设计评审的**每一轮**（round 1 与收敛轮）user 消息都携带 `## Approval Signal`——8 位批准码（`[APPROVE:<8hex>]`；token 每评审会话只铸造一次、每轮同码，token 本体不进提示词）。评审通过且无 🔴 Critical 时，advisor 回显 `[APPROVE:<code>]`，宿主校验命中后注入完整 design token（附有效期提示）；`eng_coder` 携带该 token 派实现子代理（token 机械校验，不消费、可多次 spawn；后续评审不通过则撤销，拒绝消息按「未签发 / 已过期 / 不一致」三态分别提示）
- **双写门禁** —— 工程模式 ON 且主代理无有效 token 时，`write`/`edit` 对产品代码路径的调用被 `tools/pre-execute` 拦截：`src/**` 一律算产品代码，其他目录里非文档扩展名也算；`docs/**` 与根级文档（`.md` / `.txt` 等）豁免——那是架构师的产出物。间接写（shell 等）不拦，靠流程纪律，与上游同款取舍
- 子代理交付后自动触发交付 code review；变更合并回父会话并重置评审预算

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

要求：DSH 桌面壳（cordis `^4.0.0-rc.7`）+ web profile 标准服务（tools / llm / subagents / systemPrompt）。

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

## 配置

配置经插件 `cordis.patch.yml` 的 insert 行传入（link: 安装直接编辑克隆目录里的文件即可）：

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
        # 可选：advisor 评审路由（缺省跟随当前会话模型）
        advisor:
          provider: provider-a
          model: reviewer-model
          timeoutMs: 600000
        # 可选：其余开关
        engineering: false              # 所有会话默认进工程模式（默认 false）
        engTokenTtlMs: 3600000          # design token 有效期
        consultTimeoutMs: 600000        # 会诊子代理超时
```

## thincoder-eng 预设（可选）

[`preset/thincoder-eng/`](./preset/thincoder-eng/) 是工程模式的一键入口：用它创建的会话从第一句起就是工程模式（架构师角色 + 门禁全开）。

安装：把两个文件复制到 `~/.dsh/.agent-presets/thincoder-eng/`：

```bash
mkdir -p ~/.dsh/.agent-presets/thincoder-eng
cp preset/thincoder-eng/* ~/.dsh/.agent-presets/thincoder-eng/
```

新建会话时选择 "Thincoder Eng" 预设即可。插件监听 `agent/session-start` 识别预设 id 自动进入工程模式——预设本身不重复装配插件（避免双实例）。

## 架构说明

- **纯 JS 免构建** —— host 侧全部是 `.mjs`，无 TypeScript、无打包步骤（继承 thincoder 的 zero-dependency 哲学）
- **零 bare import** —— 不 `import` cordis / schemastery：插件经 junction 安装后 Node 会 realpath 化，从安装目录向上解析不到宿主的包；工具手工构造 ToolDefinition 形状，插件契约只依赖 `export name / inject / apply`
- **advisor** = `ctx.llm.stream` 自管工具循环：每轮完整替换 system prompt，配只读工具集（read / glob / grep）；LLM 调用带 chunk 级看门狗（90s 无输出即中止，最多重试 3 次，仍失败转为可诊断的 `provider_stall` 错误——DSH 的 GenerateOptions 没有 per-request 超时字段，这是移植侧的替代机制）
- **飞刀 / 会诊 / eng-coder** = `ctx.subagents.start`：模型覆盖（agentOptions）、深度限制（maxDepth）、工具过滤（toolFilter）
- **写门禁** = `tools/pre-execute` waterfall 拦截
- **host-only** —— 无 client bundle，前端零变更，全部交互经对话流中的工具卡片呈现

## 与上游 thincoder 的差异

1. **LLM 调用超时**：上游有 per-request `FETCH_TIMEOUT`；DSH 的 GenerateOptions 无超时字段，移植版以 chunk 级看门狗（90s）+ 3 次重试替代，挂起的 provider 调用最终转为有界可诊断错误
2. **子代理宿主**：上游 spawn 独立 CLI 进程；移植版用 DSH 进程内 subagents（spawn / fork provider）
3. **eng 会话状态**：内存态（会话内 enter / exit 翻转），DSH 重启后回到配置默认值
4. **预设入口**：DSH 特有——工程模式的新会话一键入口用 agent preset 实现，机制本体留在插件（运行时状态机装不进静态预设）

## License

MIT —— 见 [LICENSE](./LICENSE)。基于 [thincoder](https://gitee.com/shanghai-xinbo/thincoder)（[thincoder.com](https://thincoder.com/)）移植，向上游贡献者致谢。
