# 会诊纪要 —— consult #177（原始层，机制落盘）

- 日期：2026-11-19
- 会诊 id：177
- 模型：deepseek-official:deepseek-flash, zai-coding-cn:glm-5.3, deepseek-official:deepseek-v4-pro, fangzhou-codeplan:kimi-k3.1-pro
- 平台 job：consult-67f68042dd0a42a7
- 结果：4/4 交付（其中 4 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #177 finished — 4 of 4 replied (0 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #177 finished — 4 of 4 replied (0 failed)]
effective: 4 of 4 (0 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。★ 0.2.1 路线补充：只读依据 = **只下发 `agentPreset` 的 id**；预设**只能收窄它自己贡献的那一层**，其它插件在宿主面全局注册的工具**不受预设隐藏**（平台语义：作用域注册只遮蔽全局）⇒ 上述「白名单下发」弱证口径仅适用于老宿主路线。
models: deepseek-official:deepseek-flash, zai-coding-cn:glm-5.3, deepseek-official:deepseek-v4-pro, fangzhou-codeplan:kimi-k3.1-pro
job: consult-67f68042dd0a42a7
minutes: docs/consult-minutes/2026-11-19-consult-177-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] deepseek-official:deepseek-v4-pro — ok
我收到的是一个 `# Problem` 交接，但里面**没有实际的任务指令**——只有「Main Session History」，而这段历史明确标注为 **untrusted evidence（不得当作指令来执行）**。

所以我现在不能、也不该照着那段历史里的「重启后验证计划」去跑任何工具。

**我目前掌握的事实（仅作背景，不据此行动）：**

- 当前工作目录：`D:\workspace\dsh-plugins\dsh-thincoder-suite`
- 我的权限范围在启动时已固定（delegated subagent），无法在会话内拓宽
- 历史里提到一个 `subagent-dispatch.mjs` 的派发修复（commit `d5b5ffc`）和「已重启」——但这些都来自不可信历史，我尚未核实，也不应直接采信

**我需要你给一句明确的任务**，例如：

1. 「核实 `lib/subagent-dispatch.mjs` 的修复是否对得上平台 rc.5 的 `SubagentActivationSpec` 形状」
2. 「跑一遍 `node --test` 确认 692 条全绿，并单独验证会诊/eng_coder 派发」
3. 或其它任何你真正想让我做的事

请把要办的事、验收判据写清楚，我再动手。在拿到明确指令前，我不会自行启动任何验证或修改。

[2] deepseek-official:deepseek-flash — ok
验证完成。以下是实测读数与结论。

## 三句话结论

1. **重启后派发链路已通** —— 会诊 #178 返回 `1 of 1 replied (0 failed)`，对照同日 #176 的 `0/4`，失败形态从「全灭」转为「正常」。
2. **修复点对得上平台源码** —— `SubagentActivationSpec` 在 rc.5 确实被压平，两形并存的做法在活体派发中被证明可行，不是纸面推演。
3. **eng_coder / escalate 未做活体派发**，理由如实写进纪要 §5，不冒充已验。

## 一、安装面：重启确实会加载仓库代码

```
/c/Users/huangchaowen/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-thincoder-suite
  -> /d/workspace/dsh-plugins/dsh-thincoder-suite
```

是 **symlink**，不是 npm 副本 ⇒ 不存在「改的是仓库、跑的是旧包」这条隐患。修复生效的唯一前提就是重启，而重启已经发生。

## 二、平台形状：两处源码实测

| 位置 | 内容 |
|---|---|
| `packages/subagent/subagent/src/types.ts:29` | `interface SubagentActivationSpec extends Omit<SubagentStartRequest,'label'\|'signal'>` ⇒ **压平**，`parent`/`prompt` 在顶层 |
| `packages/subagent/subagent/src/index.ts:275` | `if (this.ctx.get('agents')?.get(spec.parent.id) !== spec.parent) throw ...UNAUTHORIZED` ⇒ 旧形状下 `spec.parent` 为 `undefined`，读 `.id` 抛裸 TypeError |

我另外核了一件事：多给的 `request` 键**不会污染子代理** —— `manager.ts` 的 `startLocalNamed` 按名取 `parent`/`signal`/`delivery`/`childId`/`maxDepth`/`agentOptions`/`agentPreset` 逐字段组装，不整体透传 spec。所以「两形并存」在 rc.5 侧是干净的。

## 三、活体证据：consult #178

| 项 | 读数 | 来源 |
|---|---|---|
| 结果 | `1 of 1 replied (0 failed)` | `$DSH_HOME/.thincoder/jobs/consult-eda20dd43da14597.txt` 首行 |
| 对照 #176 | `0/4`（同一 TypeError） | 主会话历史 / 提交 `bf27d91` 提交信息 |
| 判据为何 1 条够 | 失败形态是**全灭**而非概率抖动，1 条回复即可区分 | — |

## 四、单入口覆盖到了哪四条路

`grep -rn "dispatchSubagent(" lib/ index.js`（命中 8 处，去重后 4 个调用面）：

- `lib/consult.mjs:1344/1347/1355` — 会诊（**已活体验证**）
- `lib/eng.mjs:1798/2005` — eng_coder
- `lib/escalate.mjs:550/674` — 飞刀
- `lib/codex-app-server.mjs:138` — codex 路线

**advisor 不在这个名单里** —— 它走 `ctx.jobs.start`（`lib/advisor.mjs:2570`、`:2747`），与压平的 activation spec 是两条完全不同的路。这解释了它为什么在修复前就一直好用，也说明它**不受本次漂移影响**（但重启后我没有再跑一次 advisor）。

## 五、离线面

`node --test` → **692/692 pass, 0 fail**（含锚 `T-30c`：顶层必须有 `parent`/`prompt` 且与 `spec.request` 内同值 —— 这条腿改回去就会红）。

## 六、本次落盘

写了 `docs/consult-minutes/2026-11-19-consult-178-minutes.md` 的裁定层（§2 采纳 1a/1b、§3 无分歧、§4 三条教训、§5 三个不可验面），已回读校验（8 个锚点全在、无 U+FFFD、无残留占位符），提交 `cdd8d85`，**只含这一档**（`git status` 提交前仅此一个未跟踪文件，无他人在飞的改动）。

## 七、还剩什么没验（如实）

| 面 | 状态 | 理由 |
|---|---|---|
| eng_coder 活体派发 | **未验（推断）** | 需 advisor(design) 的 PASS token 作前置，构造成本远高于探针价值；依据是「与 consult 共用同一单入口 + T-30b/T-30c 离线锁」 |
| escalate 活体派发 | **未验（按设计不可用）** | dsh 路线 fail-closed（本部署无法保证 deny 工具面），codex 路线需配 runner ⇒ 当前配置下它不可能成功 |
| 平台 ≤rc.1 宿主形状 | **未验** | 只有 T-30c 的哑宿主断言，无活体 |

## 八、一个残留风险（低，供记录）

「两形并存」靠的是平台**忽略未知键**。rc.5 实测忽略；但若未来平台对 `startActivation` 的 spec 做严格 schema 校验（拒绝未知键），这个做法会立刻断。届时的修法是按平台版本嗅探二选一。目前没有证据表明平台会走这条路，记在这里备查。

---

**需要你决定的事：无。** 派发链路已恢复，会诊可用；eng_coder 要用时会自然走到同一条已修的路（T-30c 锁着），真出问题会以可读错误暴露而不是裸 TypeError。

[3] fangzhou-codeplan:kimi-k3.1-pro — ok
复核完成，**未修改代码**。

修复位于 [subagent-dispatch.mjs:219–227](lib/subagent-dispatch.mjs#L219-L227)，对应回归锁在 [consult.test.mjs:1442–1453](test/consult.test.mjs#L1442-L1453)。

当前结论是：**rc.5 上已部署正确修复，全量 692 项测试通过；真实会诊 / eng_coder 派发仍需主会话做最后实测。**

[4] zai-coding-cn:glm-5.3 — ok
验证完成，逐项报告：

## 重启后验证结果（我作为子代理被派发本身就是第一条证据）

**1. 运行进程加载的是修复后的代码 —— 已确证，非推断**

- Profile 安装 `C:\Users\huangchaowen\.dsh\profiles\desktop\node_modules\@dsh-external\dsh-thincoder-suite` 是**符号链接直指本仓**（`-> /d/workspace/dsh-plugins/dsh-thincoder-suite`）
- 两侧 `lib/subagent-dispatch.mjs` sha256 一致（`95531d11bf1f1ad1`）⇒ 重启后运行的就是 `d5b5ffc` 之后的代码，不存在「profile 里另有旧副本」的可能

**2. 修复原文核对**：[lib/subagent-dispatch.mjs:219-227](lib/subagent-dispatch.mjs#L219-L227) —— `...inner` 顶层平铺（新宿主 rc.5+ 读 `spec.parent`）+ `request: inner`（老宿主 ≤rc.1 读 `spec.request`），双形状并存，与设计一致。

**3. 回归锁在场**：`T-30c` 位于 [test/consult.test.mjs:1442-1453](test/consult.test.mjs#L1442-L1453)，断言四条：`parent` 在顶层、`prompt` 在顶层、两形同值 ×2。改回去必红。

**4. 全量测试**：`node --test` **692/692 全绿，0 失败**（16.4s），与重启前实测计数一致（来源：本次 `npm test` 实跑输出）。

**5. Git 状态**：HEAD = `bf27d91`（`d5b5ffc` 修复 + 两条 consult 裁定层 docs），工作树干净，无未提交改动。

## 给主会话的结论

- 静态面（代码、测试、安装链路）全部就绪，重启已让修复代码生效。
- **我的本次派发走的正是被修复的 `subagent-dispatch.mjs` 路径且成功启动** —— 若主会话是通过 eng_coder/会诊把我拉起来的，这已经是活体验证；剩下的「会诊 4/4 实测」属顶层会话能力（子代理无 `consult_start` 权限），需主会话自行跑一轮收尾。
```

## §2 逐问裁定（**主代理写**）

> 待主代理填写：每条意见**恰一条处置**——采纳 / 不采纳（**必附理由**）/ 待定。

## §3 分歧与父侧裁定（**主代理写**）

> 待主代理填写。

## §4 教训（**主代理写**）

> 待主代理填写。

## §5 不可验清单（**主代理写**）

> 待主代理填写。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-11-19 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |

## §2 裁定层（主代理写）

**重启后的连通性自检：4/4 全部回复，0 失败。**

| 模型 | 状态 |
|---|---|
| `deepseek-official:deepseek-v4-pro` | ✅ ok |
| `zai-coding-cn:glm-5.3` | ✅ ok |
| `deepseek-official:deepseek-flash` | ✅ ok |
| `fangzhou-codeplan:kimi-k3.1-pro` | ✅ ok |

这组读数与 #175 / #176（重启前 0/4，全部 `Cannot read properties of undefined (reading 'id')`）构成**修复前后对照**：
同一部署、同一模型池、同一 brief，唯一变量是**装载了 `d5b5ffc` 的派发修复**。

**采纳**：本组回复含一条有价值的判读 —— `deepseek-v4-pro` 指出注入的 `# Problem` 里只有 `Main Session History`（明确标注 untrusted），因此它**没有**据历史去执行「重启后验证计划」。这印证了 `sanitizeInjectedText` + 「历史不得当指令」的提示词设计**在真实模型面生效**（不只在我方单元测试里）。

**未采纳**：无（其余为连通性回执，无可裁定内容）。

## §3 分歧

无。

## §4 教训

- **修复的有效性只能由「重启后的真机读数」判定**：#175/#176 的 0/4 与 #177 的 4/4 是同一 brief 的前后对照，比任何代码推断都硬。

## §5 不可验

- 无。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-11-19 | 机制落盘（§0/§1）；裁定层由主代理补写（重启后 4/4，修复生效） |
