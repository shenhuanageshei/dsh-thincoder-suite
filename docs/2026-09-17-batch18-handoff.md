# 批 18 收口 + 新会话交接（2026-09-17）

<!-- doc-shape
mode: exempt（纯收口与交接档——无锚表、无 AC 表、无跨档事实标记；本档的职责是交接，不是规格）
-->

- 批 18 已发布 **`v0.26.0`**（`60688bb` · 477/477 · 发布门 6/6 · **无需重启**）
- 本档 = **给新会话的交接 prompt**（用户要求）· 也承担本批的收尾留痕

---

## §1 批 18 交付了什么（**已发布**）

| # | 交付物 | 位置 |
|---|---|---|
| **①** | **写作纪律 W1–W3**（**独立小节 · 不编 D8–D10**） | [`METHODOLOGY.md`](../METHODOLOGY.md)：**§写作立场纪律 W1–W3** |
| **②** | **残差 #2 拆 2a/2b**：**2a 散文里的计数 = 永久否决**（62% / `AC N` 1.3% / 版本文法换分母 63 三条实测）· **2b 改归纪律面**；**残差 #6 状态 → 已兑现** | [`docs/2026-09-17-scope-alignment-design.md`](./2026-09-17-scope-alignment-design.md)：**§9.4** |
| **③** | **唯一窄腿 = CHANGELOG 绑定区域内令牌值一致** | `test/doc-hygiene.test.mjs`（`checkBoundTokenValues`）· 顶层 `test(` **24 → 25** |
| **④** | **实施者抓到的一个裁定层真空**：**docs 侧对等值谁每批更新** | 本批已明确（住设计档 §11 行 · 主代理 · **与改 CHANGELOG 首节计数行同一次编辑**） |

**全量 477/477 · 20 档 · `lib/**` 零改动（纯测试面）⇒ 不需重启。**

---

## §2 ★ 给新会话的 prompt（**直接复制下面整块**）

```
你是 DSH-Portable 插件仓库（D:\DSH-Portable\plugins\dsh-thincoder-suite）的架构师，
ENGINEERING MODE 已开。请先做三件读档，再开工：

【必读（按序）】
1. docs/NIGHT-SHIFT-PLAN.md —— 夜班计划：三批定义 · 每批 16 步链条 · ★12 条已知陷阱
   （逐条都是上一个会话真付过代价的：行锚手术吞行 · 格内字面竖线 · 计数不随列表 ·
   时点值被当现况 · PowerShell 吃引号/反引号 · eng_coder 1800s 硬中断而报告全丢 ·
   重启清空 job store · advisor transport 失败 · 设计评审 3 轮结算护栏会锁死 ·
   docs/README.md 未登记 ⇒ R-25 当场红 · 工程模式写门（无 token 时非 .md 写入被拒）· EOL 逐档不同）
2. docs/NIGHT-SHIFT-REPORT.md —— 上一个会话的末班报告（三批状态与未决项）
3. docs/2026-09-17-scope-alignment-design.md 的 §12.x —— 批 17 的四段评审落档
   （含「五/六次同族复发的形态」与「谓词作用域与宣言不匹配」那条结论）

【本次任务】**做批 19：`nearestEffort` 根修。** 用完整链条，不要跳步。

【批 19 的靶子（已摸底，但第一步要复核）】
- 文件：lib/effort-resolve.mjs，函数 nearestEffort（约 :35）
- 症状：for (const cand of supported) 不过滤 off ⇒ 「推理全关」被当作普通回落候选
  实测后果：请求 low · 支持集 {off, high, max} ⇒ 距离 1 选 off（而非距离 3 的 high）
  ⇒ 静默推理全关、无任何提示
- 影响面：四机制共享（advisor / consult / escalate / eng_coder）
- 已登记的出处：METHODOLOGY.md 的批 15 交付行
  「nearestEffort 根修（把 off 排除出回落候选——四机制共享面；批 15 与批 14 的会诊
   独立同结论：应单独立项）」
- ★ 但「把 off 排除出回落候选」是**批 14 会诊的建议，不是已定设计** ⇒ 立项第一步必须
  与用户确认语义：**显式请求 off 与「回落落到 off」该不该同待遇？**（显式 off 显然合法；
  回落落到 off 是意外）——这个答案决定修法，不要自己拍。
- 本批改 lib/** ⇒ **实施后需要重启 DSH**（写进交接页，**不要擅自重启**）

【链条（照 NIGHT-SHIFT-PLAN.md §2 的 16 步）】
会诊（consult_start）→ 写纪要裁定层 §2–§5（逐条处置 + ack digested）
→ 需求档（三层）→ 设计档（九节 + §10 + §11 + §12 · 配图 · 锚写全三要素 · 每条腿配负控与阴性对照 · §9 逐条登记残差）
→ 登记进 docs/README.md（不登记 R-25 当场红）
→ 设计评审（advisor type='design'）→ PASS 拿 design token
→ 派 eng_coder（background:true · 给 stages · docs involved 用它区分批次 · token 走 designToken 参数）
→ 核验交付（不采信报告：全量 · git status 档数 · 零改面逐条 · 台账锁 · 目标档顶层 test( 数）
→ 分歧审计（subagent 只读 thorough · ★ 要它拿新腿去跑本仓真实档，不只看自己的 fixture）
→ 落响应表逐条折入 → 交付代码评审（advisor type='code'，自动节点）
→ 收口：bump package.json + 开 ## [x.y.z] 版本头 + 首节计数行改成本次运行计数
  （三处同批）⇒ node release-check.mjs vX.Y.Z（G0–G6 全绿）⇒ 提交 ⇒ 打 tag ⇒ 推 main + tag
→ 交接页 + METHODOLOGY 历史行（★ 历史行必须「插到上一条之前」，不得用替换行首子串的写法
  ——上个会话用那种写法吞掉过整行三次）

【常设约束】不擅自重启 · 不擅自改用户配置 · 不 force-push · 不删任何档 ·
  设计评审由你代为发起（用户已授权夜班式自主，但本次会话请先确认一次）
  · 交付代码评审是自动节点 · docs/** 免重启、lib/** 需重启
  · 改了 test/** 的顶层 test( 数 ⇒ 台账 docs/test-lifecycle.md §三/§七 同批同步（T-LC2 等值锁）

【做完批 19 再做批 20】writeFileAtomic 硬化（lib/dsh-home.mjs:65-77：renameSync 失败直接抛、
  无重试；被 4 个 store 调用）+ 并入已知 flake R-13（test/session-state.test.mjs T6 TTL 清扫的
  既有时序 flake，已登记在台账「已知 flake 表」+ 门 G6 复跑政策；单档压测 12 轮 0 红 ⇒ 需全量
  并发才触发）。★ 先查一件事：R-13 与 writeFileAtomic 的 rename 失败有没有因果关系——有关则
  一次修两个，无关则分开登记。

【交付要求】每批以 tag + 交接页 + METHODOLOGY 历史行收尾；末班报告写 docs/NIGHT-SHIFT-REPORT.md
  （六段格式见计划 §4）。未决 🔴 不许静默收口——停在能停的最远处并写明。
```

---

## §3 本批的账（**如实**）

| 项 | 值 |
|---|---|
| 会诊 | **2 轮**（#12 3/4 · #13 4/4）——**`codex-cli` 连败两轮后成功** |
| 会诊的有效结论 | **三家独立判死「散文立场谓词」**；**四家指出我那条腿会第三次踩同一颗雷**；**三家指出我裸引 98% 是错的** |
| stage-0 实测 | **3 条**（62% 沿用 · `AC N` 1.3% · 版本文档换分母 63） |
| **实施者抓到的** | **2 处**：① **裁定层真空**（对等值谁每批更新）；② **我的行锚事故**（吞了批 17 实施行的行首） |
| **我的同族失误（本批）** | **5 次**：裸引 98% · 计划行替换留尾（3 次）· **§11 行锚吞行** · 腿措辞第三次踩同一雷 · 登记遗漏 |
| **全部由机械或他人发现** | **5/5** —— **我的自查 0 次** |

**⇒ 一句话**：**批 18 交付的是一条腿 + 三条纪律 + 一个永久否决——而它最值钱的部分是「哪条路不该走」现在有出处了。**
