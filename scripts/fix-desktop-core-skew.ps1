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
#   .\fix-desktop-core-skew.ps1 -AllCore   # 扩大：移出全部 @deepseek-ai+dsh*（保留 profile 插件依赖）
#   .\fix-desktop-core-skew.ps1 -Restore   # 回退最近一次
param([switch]$AllCore, [switch]$Restore)
$ErrorActionPreference = 'Stop'
$prof = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$nm   = Join-Path $prof 'node_modules'
if (-not (Test-Path $nm)) { Write-Host "找不到 profile node_modules：$nm" -ForegroundColor Red; exit 1 }

# 桌面版在跑就拒绝（避免把运行中的加载路径拆掉）
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'DSH-Desktop|dsh-desktop' }
if ($running) { Write-Host '桌面版仍在运行 —— 请**完全退出**（含托盘）后再运行本脚本。' -ForegroundColor Red; exit 1 }

# 保留集：profile 自己的插件及其依赖（这些是真正被顶层 link 引用的）
$keep = @('dsh-bridge-browser', 'dsh-token-cost', 'cordis', 'cordis-plugin')

if ($Restore) {
  $b = Get-ChildItem $prof -Directory -Filter '_core-skew-backup-*' | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $b) { Write-Host '没有找到备份目录。' -ForegroundColor Red; exit 1 }
  Get-Content (Join-Path $b.FullName 'moved-list.txt') | ForEach-Object {
    $src = Join-Path $b.FullName $_
    if (Test-Path $src) { Move-Item $src (Join-Path $nm $_) }
  }
  Write-Host ("已回退（来自 " + $b.Name + "）：重开桌面版即可。") -ForegroundColor Green
  exit 0
}

$backup = Join-Path $prof ('_core-skew-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($f in @('package.json', 'pnpm-lock.yaml')) { $p = Join-Path $prof $f; if (Test-Path $p) { Copy-Item $p $backup } }
$m = Join-Path $nm '.modules.yaml'; if (Test-Path $m) { Copy-Item $m $backup }

$moved = @()
Get-ChildItem $nm -Directory -Filter '@deepseek-ai+*' | ForEach-Object {
  $n = $_.Name
  $isJobs = ($n -match '^@deepseek-ai\+dsh-(jobs-local|tool-jobs)')
  $isCore = ($n -match '^@deepseek-ai\+dsh' -and ($keep | Where-Object { $n -match [regex]::Escape($_) }).Count -eq 0)
  if ($isJobs -or ($AllCore -and $isCore)) { Move-Item $_.FullName (Join-Path $backup $n); $moved += $n }
}
$moved | Set-Content (Join-Path $backup 'moved-list.txt')
Write-Host ("已移出 " + $moved.Count + " 个目录 → " + $backup) -ForegroundColor Green
$moved | ForEach-Object { Write-Host ('  ' + $_) }
Write-Host ''; Write-Host '下一步：重开桌面版 → 建一个 2 秒后台作业 → 用 job_output 读它。' -ForegroundColor Cyan
Write-Host ('回退：.\fix-desktop-core-skew.ps1 -Restore')
