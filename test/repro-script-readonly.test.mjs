// repro-script-readonly.test.mjs — 批 29 单②（US-3 / A28-6）：复现脚本**只读性**的机验腿。
//
// 为什么是**静态**腿而不是「跑一遍看」（设计 §2.3 明文）：该脚本要读真实 DSH home 与 pnpm
// store，跑一次既慢、在沙箱里还会长时间等待——「跑通」不但不是只读性的证据，反倒把门禁拖进
// 挂死面。静态扫源码字节才是**可失败、可复算、零副作用**的那条腿。
//
// 断言面（A29-5）：
//   ① 纯 ASCII（Windows PowerShell 5.1 的编码安全前提）；
//   ② 零 `git` 调用；
//   ③ 零 `$env:X =` 赋值（只读环境：不改任何环境变量）；
//   ④ 除 `$env:TEMP` 下临时目录的创建/清理外**零写 cmdlet**，且无重定向写（`>` / `>>`）；
//   ⑤ 报告只读声明按 `$tempHomeOk` **分支渲染**（成功分支说 temp dir；降级分支说
//      "no temp dir was created this run"）。
// ★ 上面 ①–④ 的**五条谓词逐条带阳性/阴性自证**（律 3：还原即红）——writeViolations ·
//   redirectionViolations · ENV_ASSIGN_RE · nonAsciiViolations · **gitLines**——见 A29-5a 首段。
// 纪律：零子进程、零真实 PowerShell（只读源码文本 + 纯字符串谓词）。
// 本档是**新增测试档** ⇒ 同批登记在 test/guard-e.test.mjs 的 T-E19 existing 清单
// （台账行 docs/test-lifecycle.md 由主代理同批登记）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT_PATH = join(PLUGIN_DIR, "scripts", "repro-platform-issues.ps1")
const SRC = readFileSync(SCRIPT_PATH, "utf8")
const LINES = SRC.split(/\r?\n/)

// ————————————— 纯谓词（输入 = 源码文本；输出 = 违规行清单，供失败时直接定位） —————————————

/** 写类 cmdlet / .NET 写 API 的**词表**（谓词输入，不是结论）。 */
const WRITE_CMDLET_RE = /\b(?:Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Set-Item|Clear-Item|New-ItemProperty|Set-ItemProperty|Remove-ItemProperty|Copy-Item|Move-Item|Rename-Item|Export-Csv|Export-Clixml|Set-Acl)\b|\b\.NET::(?:WriteAllText|WriteAllBytes|WriteAllLines|CreateDirectory|Delete)\b/i

/** 违例①：写 cmdlet —— 唯一合法例外面 = 含 `$tempHome` 的那一行（TEMP 下临时目录的创建/清理）。 */
function writeViolations(src) {
  const out = []
  src.split(/\r?\n/).forEach((line, i) => {
    if (!WRITE_CMDLET_RE.test(line)) return
    if (line.includes("$tempHome")) return
    out.push({ line: i + 1, text: line.trim() })
  })
  return out
}

/** 违例②：重定向写点（`>` / `>>`；`->` 不算——它是字符串里的箭头）。 */
function redirectionViolations(src) {
  const out = []
  src.split(/\r?\n/).forEach((line, i) => {
    if (/(?<!-)>/.test(line)) out.push({ line: i + 1, text: line.trim() })
  })
  return out
}

/** 违例③：非 ASCII 字符。 */
function nonAsciiViolations(src) {
  const out = []
  src.split(/\r?\n/).forEach((line, i) => {
    if (/[^\x00-\x7F]/.test(line)) out.push({ line: i + 1, text: line.trim() })
  })
  return out
}

/** 违例④：`$env:X =` 赋值（读 `$env:X` 不算；`-ne` / `-eq` 等比较不算）。 */
const ENV_ASSIGN_RE = /\$env:[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/
const gitLines = (src) => src.split(/\r?\n/).filter((l) => /\bgit\b/i.test(l))

test("A29-5a (AC-5): 只读性静态锁——除 TEMP 临时目录外零写 cmdlet / 零 git / 零环境赋值 / 纯 ASCII / 零重定向", () => {
  // —— 谓词自证（律 3：还原即红）——**五条谓词逐条**都必须**能判出违规**，否则断言是恒真量：
  //    writeViolations · redirectionViolations · ENV_ASSIGN_RE · nonAsciiViolations · gitLines ——
  assert.deepEqual(writeViolations('Set-Content -Path .\\x.txt -Value 1').map((v) => v.line), [1],
    "自证：非临时目录的写 cmdlet 必须被点名")
  assert.equal(writeViolations("New-Item -ItemType Directory -Path $tempHome -Force").length, 0,
    "自证：$tempHome 例外面不得被误判")
  assert.equal(writeViolations('$report.Add("x")').length, 0, "自证：纯读取行不得被点名")
  assert.equal(redirectionViolations('"a -> b"').length, 0, "自证：`->` 不是重定向")
  assert.deepEqual(redirectionViolations("Get-Content x > y.txt").map((v) => v.line), [1],
    "自证：真重定向必须被点名")
  assert.ok(ENV_ASSIGN_RE.test("$env:FOO = 1"), "自证：环境赋值必须被识别")
  assert.ok(!ENV_ASSIGN_RE.test("if ($env:DSH_HOME -ne $null)"), "自证：环境读取不得被误判")
  assert.equal(nonAsciiViolations("abc").length, 0, "自证：ASCII 行不违规")
  assert.deepEqual(nonAsciiViolations("a\u4e2db").map((v) => v.line), [1], "自证：非 ASCII 行必须被点名")
  // 第 5 条谓词 `gitLines` 的自证（此前缺：把 /git/i 换成恒不匹配的形态，整档仍会全绿）——
  assert.deepEqual(gitLines("git status"), ["git status"], "自证：含 `git status` 的样本必须被命中")
  const gitMixLines = ["Get-Content a", " git status ", "Write-Host b"]
  const gitHits = gitLines(gitMixLines.join("\n"))
  assert.deepEqual(gitHits, [gitMixLines[1]], "自证：混合样本命中项逐字 = 原**第 2 行**（行号可判）")
  assert.equal(gitMixLines.indexOf(gitHits[0]), 1, "自证：命中项在样本里的 0 基行索引 = 1（即第 2 行）")
  assert.equal(gitLines("gitless").length, 0, "自证：`gitless` 是**子串**（无词边界）不得命中")
  assert.equal(gitLines("a github url").length, 0, "自证：`github` 同样不得命中（词边界，不误伤同前缀词）")
  assert.deepEqual(gitLines("Get-Content x\nRemove-Item y"), [], "自证：无 git 行的样本 ⇒ 空（谓词不得恒真）")

  // —— 真档：四条 ——
  const envWrites = LINES.filter((l) => ENV_ASSIGN_RE.test(l))
  assert.deepEqual(envWrites, [], "零 `$env:X =` 赋值（只读环境）：" + JSON.stringify(envWrites))
  assert.deepEqual(gitLines(SRC), [], "零 git 调用：" + JSON.stringify(gitLines(SRC)))
  assert.deepEqual(nonAsciiViolations(SRC), [], "纯 ASCII（Windows PowerShell 5.1 安全）")
  assert.deepEqual(redirectionViolations(SRC), [], "零重定向写（`>` / `>>`）")
  assert.deepEqual(writeViolations(SRC), [],
    "除 $tempHome（$env:TEMP 下临时目录）的创建/清理外，零写 cmdlet")

  // —— 那**唯一**的例外面本身也要被钉住 ——
  const tempDef = LINES.filter((l) => /\$tempHome\s*=\s*Join-Path\s+\$env:TEMP/.test(l))
  assert.equal(tempDef.length, 1, "$tempHome 必须恰有一处派生自 $env:TEMP：" + JSON.stringify(tempDef))
  assert.equal((SRC.match(/New-Item[^\n]*\$tempHome/g) ?? []).length, 1, "临时目录创建恰一处")
  assert.equal((SRC.match(/Remove-Item[^\n]*\$tempHome/g) ?? []).length, 1, "临时目录清理恰一处")
  assert.match(SRC, /\$tempHomeOk\s*=\s*\$true/, "创建成功才置 $tempHomeOk = $true（降级形态可辨）")
  assert.match(SRC, /if\s*\(\s*\$tempHomeOk\s*\)\s*\{\s*[\s\S]{0,200}?Remove-Item/,
    "清理被 $tempHomeOk 守卫（只清自己建的那个目录）")
})

test("A29-5b (AC-5): 只读声明按 $tempHomeOk 分支渲染——成功分支说 temp dir，降级分支说 no temp dir was created this run", () => {
  const i = SRC.indexOf("READ-ONLY run statement")
  assert.ok(i > 0, "只读声明段可定位")
  const block = SRC.slice(i, i + 900)
  assert.match(block, /if\s*\(\s*\$tempHomeOk\s*\)\s*\{[\s\S]*?Its only write was a temp dir under TEMP[\s\S]*?\}\s*else\s*\{[\s\S]*?no temp dir was created this run/,
    "两分支的文案必须都在 $tempHomeOk 的 if/else 结构里（不得无条件声称写过临时目录）：\n" + block)
  assert.ok(block.includes("Its only write was a temp dir under TEMP"),
    "成功分支保留既有「唯一写点 = TEMP 临时目录」句式（A28-6 的原话）")
  assert.ok(block.includes("no temp dir was created this run"),
    "降级分支的准确话 = no temp dir was created this run（本次运行零写入，不得冒充写过）")
})
