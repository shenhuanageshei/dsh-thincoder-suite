# fix-desktop-core-skew.ps1 —— 桌面 profile 的 DSH core 包「两代并存」清理
#
# 背景：桌面 profile 的 node_modules/.pnpm 里残留着与 app 不同代的 @deepseek-ai/dsh* 包（实测 39 个
# v0.1.7-rc.1，而 app 是 v0.1.7-rc.2）。worker 里的 job_output 报
# `Cannot read properties of undefined (reading 'output')`（平台自产作业与插件作业同错）⇒ 怀疑
# 「读的一方与被读的一方不同代」。本脚本做**最小可证伪实验**：把 profile 自带的那两份 jobs 包移出
# 解析面，重启后复测 job_output。
#
# 可回退：**只移动、不删除**，并写 moved-list.txt；-Restore 原样移回。
# 必须在**完全关闭桌面版**（含托盘）时运行 —— 本脚本会拒绝在桌面版运行中执行。
#
# 用法：
#   .\fix-desktop-core-skew.ps1            # 最小实验：只移 dsh-jobs-local / dsh-tool-jobs
#   .\fix-desktop-core-skew.ps1 -AllCore   # 扩大：移出全部 @deepseek-ai+dsh*（只保留 $keep 名单，见下）
#                                        ⚠ $keep 是硬编码子串名单，**不含** dsh-base / dsh-web-app 等
#                                          profile bundle 层 ⇒ -AllCore 会移走它们，慎用（本实验不需要它）
#   .\fix-desktop-core-skew.ps1 -Restore   # 回退最近一次**有内容的**备份
# 提示：本文件含中文，须存为 UTF-8 **带 BOM**（否则 Windows PowerShell 5.1 在 ANSI 936 下解析失败）；
#       ExecutionPolicy 为 Restricted 时用：powershell -ExecutionPolicy Bypass -File .\fix-desktop-core-skew.ps1
param([switch]$AllCore, [switch]$Restore)
$ErrorActionPreference = 'Stop'
$prof = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$nm   = Join-Path $prof 'node_modules'
$pn   = Join-Path $nm '.pnpm'   # pnpm 的真实包目录：'@scope+name@ver' 形式只存在于这里
if (-not (Test-Path $nm)) { Write-Host "找不到 profile node_modules：$nm" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $pn)) { Write-Host "找不到 pnpm 包目录（布局可能已变）：$pn" -ForegroundColor Red; exit 1 }

# 桌面版在跑就拒绝（避免把运行中的加载路径拆掉）
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DSH-Desktop|dsh-desktop' }
if ($running) { Write-Host '桌面版仍在运行 —— 请**完全退出**（含托盘）后再运行本脚本。' -ForegroundColor Red; exit 1 }

# 保留集：**硬编码子串名单**（对目录名与内层真实包名做子串匹配，故 'cordis' 也会命中 dsh-cordis-*）。
# 只覆盖这里列出的包，**不覆盖它们的传递性 @deepseek-ai 依赖**；仅供 -AllCore 使用，默认模式不看它。
$keep = @('dsh-bridge-browser', 'dsh-token-cost', 'cordis', 'cordis-plugin')

if ($Restore) {
  # 取「moved-list 非空」的最新备份：空跑一次就会生成一个更新的空备份，不得让它遮住真正存有目录的那份
  $b = Get-ChildItem $prof -Directory -Filter '_core-skew-backup-*' |
       Where-Object { @(Get-Content (Join-Path $_.FullName 'moved-list.txt') -ErrorAction SilentlyContinue | Where-Object { $_.Trim() }).Count -gt 0 } |
       Sort-Object Name -Descending | Select-Object -First 1
  if (-not $b) { Write-Host '没有找到含 moved-list 的备份目录（无需回退，或已回退过）。' -ForegroundColor Red; exit 1 }
  $ok = 0; $fail = @()
  Get-Content (Join-Path $b.FullName 'moved-list.txt') | Where-Object { $_.Trim() } | ForEach-Object {
    $name = $_.Trim()
    $src  = Join-Path $b.FullName $name
    $dst  = Join-Path $pn $name
    if (Test-Path $dst) { $fail += ($name + ' —— 目标已存在，跳过'); return }
    if (Test-Path $src) { Move-Item $src $dst; $ok++ } else { $fail += ($name + ' —— 备份中已无此目录') }
  }
  Write-Host ("已回退 " + $ok + " 个目录（来自 " + $b.Name + "）") -ForegroundColor Green
  if ($fail.Count -gt 0) {
    Write-Host ('未回退 ' + $fail.Count + ' 个：') -ForegroundColor Yellow
    $fail | ForEach-Object { Write-Host ('  ' + $_) -ForegroundColor Yellow }
  }
  Write-Host '重开桌面版即可。' -ForegroundColor Green
  exit 0
}

$backup = Join-Path $prof ('_core-skew-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($f in @('package.json', 'pnpm-lock.yaml')) { $p = Join-Path $prof $f; if (Test-Path $p) { Copy-Item $p $backup } }
$m = Join-Path $nm '.modules.yaml'; if (Test-Path $m) { Copy-Item $m $backup }

$moved = @()
Get-ChildItem $pn -Directory -Filter '@deepseek-ai+*' | ForEach-Object {
  $n = $_.Name
  # pnpm 会截断长目录名（如 @deepseek-ai+dsh-bridge-bro…）。取出**包本体**的真实名：内层名里以「目录名主干」
  # 为前缀的那个（pnpm 是前缀截断）；其余内层名都是它的依赖，**不可**参与保留判定——否则任何「依赖里有 cordis」
  # 的包都会被误判为保留，-AllCore 退化成几乎不动（实测 281 个候选只移 1 个）。
  $inner = @(Get-ChildItem (Join-Path $_.FullName 'node_modules\@deepseek-ai') -Directory -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  $stem = (($n -replace '^@deepseek-ai\+', '') -split '[@_]')[0]
  $self = @($inner | Where-Object { $_ -like ($stem + '*') })
  # ★ $isJobs 只看外层目录名：内层名会把 dsh-base / dsh / dsh-sdk-minima 一并误判
  #   （它们的虚拟店里同样挂着 dsh-jobs-local / dsh-tool-jobs 的 junction），默认实验就会多移核心包
  $isJobs = ($n -match '^@deepseek-ai\+dsh-(jobs-local|tool-jobs)')
  $hit = @($keep | Where-Object { $k = $_; ($n -match [regex]::Escape($k)) -or @($self | Where-Object { $_ -match [regex]::Escape($k) }).Count -gt 0 })
  $isCore = ($n -match '^@deepseek-ai\+dsh') -and ($hit.Count -eq 0)
  if ($isJobs -or ($AllCore -and $isCore)) { Move-Item $_.FullName (Join-Path $backup $n); $moved += $n }
}
$moved | Set-Content (Join-Path $backup 'moved-list.txt')
if ($moved.Count -eq 0) {
  Write-Host '已移出 0 个目录 —— 未做任何改动。' -ForegroundColor Yellow
  Write-Host ('  扫描位置：' + $pn + '（@deepseek-ai+* 候选目录数：' + @(Get-ChildItem $pn -Directory -Filter '@deepseek-ai+*').Count + '）') -ForegroundColor Yellow
  Write-Host '  候选数为 0 说明 pnpm 布局又变了（历史上就是因此空跑）；上面的备份目录是空跑产物，可直接删除。' -ForegroundColor Yellow
  exit 1
}
Write-Host ("已移出 " + $moved.Count + " 个目录 → " + $backup) -ForegroundColor Green
$moved | ForEach-Object { Write-Host ('  ' + $_) }
Write-Host ''; Write-Host '下一步：重开桌面版 → 建一个 2 秒后台作业 → 用 job_output 读它。' -ForegroundColor Cyan
Write-Host ('回退：.\fix-desktop-core-skew.ps1 -Restore')
