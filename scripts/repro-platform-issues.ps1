# repro-platform-issues.ps1 - dsh017 batch 28 (US-1 / A28-6): read-only reproduction
# helper for the three upstream platform issues documented in
# docs/upstream-2026-09-26-platform-issues.md.
#
# READ-ONLY CONTRACT (A28-6, review round #4 narrowed):
#   - This script never modifies this repository's files, config, or environment.
#     It only reads (Test-Path / Get-Content / Get-ChildItem) and prints a report.
#   - The 2-second background job used for the job_output leg is bound to an INDEPENDENT
#     TEMP DSH_HOME under the TEMP dir (job artifacts would otherwise land in
#     the real home's .thincoder/jobs/, which the batch-27 sweep deliberately cannot
#     clean for foreign kinds). The temp dir is removed at the end (self-cleaning).
#   - The sandbox-hang leg CANNOT run inside this script: the host cannot enter the dsh
#     subagent sandbox, and a real hang would hang this script too (review round #5).
#     That leg is emitted as a DISPATCHED (plugin-mediated) step with its own independent
#     timeout (HOST_CHECK_TIMEOUT_MS magnitude = 120000 ms, lib/host-check.mjs); on
#     timeout record SUSPECTED HANG and continue - never hang along.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\repro-platform-issues.ps1
# Output: one paste-ready markdown report on stdout. ASCII only (Windows PowerShell 5.1 safe).

$ErrorActionPreference = "Continue"

function Read-TextSafe([string]$Path) {
  try {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      return [System.IO.File]::ReadAllText($Path)
    }
  } catch { }
  return $null
}

# ---- locate the DSH home (read-only probing; same features as the plugin probe) ----
$dshHome = $null
if (($env:DSH_HOME -ne $null) -and ($env:DSH_HOME -ne "") -and (Test-Path -LiteralPath $env:DSH_HOME)) {
  $dshHome = $env:DSH_HOME
}
if (-not $dshHome) {
  $cands = @( (Join-Path $env:USERPROFILE ".dsh"), "D:\DSH-Portable" )
  foreach ($c in $cands) {
    if (-not $c) { continue }
    if (-not (Test-Path -LiteralPath $c)) { continue }
    $hasSessions = Test-Path -LiteralPath (Join-Path $c "sessions")
    $hasSettings = (Test-Path -LiteralPath (Join-Path $c "settings.yaml")) -or (Test-Path -LiteralPath (Join-Path $c "settings.yaml.imported"))
    if ($hasSessions -and $hasSettings) { $dshHome = $c; break }
  }
}

# ---- version-skew scan over the profile pnpm stores (read-only; fixed candidate paths) ----
$skewLines = New-Object System.Collections.Generic.List[string]
$scanRoots = New-Object System.Collections.Generic.List[string]
if ($dshHome) { $scanRoots.Add($dshHome) }
$portableRoot = "D:\DSH-Portable"
if ((-not $scanRoots.Contains($portableRoot)) -and (Test-Path -LiteralPath $portableRoot)) { $scanRoots.Add($portableRoot) }
foreach ($root in $scanRoots) {
  $storeCandidates = @( (Join-Path $root "node_modules\.pnpm") )
  $profilesDir = Join-Path $root "profiles"
  if (Test-Path -LiteralPath $profilesDir) {
    foreach ($p in (Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue)) {
      $storeCandidates += (Join-Path $p.FullName "node_modules\.pnpm")
    }
  }
  foreach ($store in $storeCandidates) {
    if (-not (Test-Path -LiteralPath $store)) { continue }
    $tally = @{}
    foreach ($d in (Get-ChildItem -LiteralPath $store -Directory -ErrorAction SilentlyContinue)) {
      if ($d.Name -like "@deepseek-ai+dsh*") {
        $idx = $d.Name.LastIndexOf("@")
        if ($idx -ge 0) {
          $ver = $d.Name.Substring($idx + 1)
          if ($tally.ContainsKey($ver)) { $tally[$ver] = $tally[$ver] + 1 } else { $tally[$ver] = 1 }
        }
      }
    }
    foreach ($k in $tally.Keys) {
      $skewLines.Add("- " + $store + " -> version " + $k + " x " + $tally[$k] + " package dirs")
    }
  }
}

# ---- jobs dir + pathForm ledger (read-only) ----
$jobsDirUsed = $null
$jobsFiles = 0
$jobsBytes = 0
$formTally = @{}
if ($dshHome) {
  $jobsDirUsed = Join-Path $dshHome ".thincoder\jobs"
  if (Test-Path -LiteralPath $jobsDirUsed) {
    foreach ($f in (Get-ChildItem -LiteralPath $jobsDirUsed -File -ErrorAction SilentlyContinue)) {
      $jobsFiles = $jobsFiles + 1
      $jobsBytes = $jobsBytes + $f.Length
    }
    $idxText = Read-TextSafe (Join-Path $jobsDirUsed "index.jsonl")
    if ($idxText) {
      $lines = $idxText -split "\r?\n"
      foreach ($line in $lines) {
        $t = $line.Trim()
        if ($t -eq "") { continue }
        try {
          $row = $t | ConvertFrom-Json
          $form = [string]$row.pathForm
          if ($form -eq "") { $form = "(missing)" }
          if ($formTally.ContainsKey($form)) { $formTally[$form] = $formTally[$form] + 1 } else { $formTally[$form] = 1 }
        } catch { }
      }
    }
  }
}

# ---- independent temp DSH_HOME for the job_output leg (created + removed by this script) ----
$tempHome = Join-Path $env:TEMP ("dsh017-repro-home-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$tempHomeOk = $false
try {
  New-Item -ItemType Directory -Path $tempHome -Force -ErrorAction Stop | Out-Null
  $tempHomeOk = $true
} catch {
  $tempHome = "(temp dir could not be created - use any empty temp dir as the independent DSH_HOME)"
}

$report = New-Object System.Collections.Generic.List[string]
$report.Add("# Upstream platform issues - reproduction report (dsh017 batch 28)")
$report.Add("")
$report.Add("Generated: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " | Machine: " + $env:COMPUTERNAME + " | User: " + $env:USERNAME)
$repoRoot = Split-Path -Parent $PSScriptRoot
$report.Add("Repo root: " + $repoRoot)
$report.Add("")
$report.Add("READ-ONLY run statement (A28-6): this script only read; it did not modify repo files,")
$report.Add("config, or environment. Its only write was a temp dir under TEMP for the job_output")
$report.Add("leg (" + $tempHome + "), removed when this report finishes.")
$report.Add("")
$report.Add("## Environment context")
if ($dshHome) { $report.Add("- DSH home located: " + $dshHome) } else { $report.Add("- DSH home located: NOT FOUND (guided legs below remain valid; ledger leg skipped)") }
if ($skewLines.Count -gt 0) {
  $report.Add("- DeepSeek dsh package copies found in pnpm stores (read-only tally):")
  foreach ($s in $skewLines) { $report.Add("    " + $s) }
} else {
  $report.Add("- DeepSeek dsh package copies found in pnpm stores: none in the scanned stores")
}
$report.Add("")
$report.Add("## Issue 1 - job_output full-text read crashes for every job (platform reader defect)")
$report.Add("Recorded evidence: the same error for platform-produced and plugin-produced jobs; still")
$report.Add("crashes after cleanly removing the profile-bundled rc.1 copies (batch 26 falsification).")
$report.Add("Full write-up: docs/upstream-2026-09-26-platform-issues.md (issue 1).")
$report.Add("")
$report.Add("Guided repro (performed INSIDE a DSH session - assisted step):")
$report.Add("  1) Start a 2-second background job: pwsh tool, command: Start-Sleep -Seconds 2,")
$report.Add("     run_in_background = true.")
$report.Add("  2) After the completion notice, call job_output with that job id.")
$report.Add('  3) Expected on this deployment: "Cannot read properties of undefined (reading ''output'')".')
$report.Add("Artifact hygiene (A28-6): perform this leg in a session whose DSH_HOME points at an")
$report.Add("independent temp home (this run prepared: " + $tempHome + "), or delete exactly the report")
$report.Add("files you produced afterwards; the batch-27 sweep only recognizes advisor/consult/eng/")
$report.Add("escalate kinds and will never clean foreign kinds.")
$report.Add("Clean falsification (rules out the rc.1 leftovers): run scripts/fix-desktop-core-skew.ps1")
$report.Add("(minimal scope: moves out only the profile-bundled dsh-jobs-local and dsh-tool-jobs),")
$report.Add("restart the desktop app, retry job_output. Rollback: scripts/fix-desktop-core-skew.ps1 -Restore.")
$report.Add("")
$report.Add("## Issue 2 - sandboxed subprocess neither errors nor returns (should fail closed)")
$report.Add("This leg is DISPATCHED (plugin-mediated) and is NEVER run by this script: the host cannot")
$report.Add("enter the subagent sandbox, and a real hang would hang this script too (review round #5).")
$report.Add("  1) From the DSH session, dispatch an eng_coder (or any plugin-mediated subagent job)")
$report.Add("     whose stage check is a cheap command, e.g.: node --check lib/index.mjs")
$report.Add("  2) Bound the dispatch with an INDEPENDENT timeout of HOST_CHECK_TIMEOUT_MS magnitude")
$report.Add("     (120000 ms per lib/host-check.mjs), or the plugin backstop dshBackgroundTimeoutMs.")
$report.Add("  3) Verdict:")
$report.Add("     - returns within seconds with green output -> leg does NOT reproduce today")
$report.Add("     - neither error nor return until the backstop fires, log 0 bytes ->")
$report.Add("       record: SUSPECTED HANG (sandbox denies subprocess without failing closed)")
$report.Add("  4) Never wait beyond the independent timeout; on timeout record SUSPECTED HANG and")
$report.Add("     continue. Host comparison: the same command on the host finishes in seconds.")
$report.Add("")
$report.Add("## Issue 3 - advisor delivery forms vary (coord timeout / main truncation / bce inline)")
$report.Add("Query the persisted ledger (read-only): the .thincoder/jobs dir of the DSH home,")
$report.Add("index.jsonl rows carry jobId, kind, at, bytes, pathForm.")
if ($dshHome) {
  if (Test-Path -LiteralPath $jobsDirUsed) {
    $report.Add("- jobs dir: " + $jobsDirUsed + " -> " + $jobsFiles + " file(s), " + $jobsBytes + " byte(s)")
  } else {
    $report.Add("- jobs dir not present yet: " + $jobsDirUsed)
  }
  if ($formTally.Count -gt 0) {
    $report.Add("- pathForm distribution:")
    foreach ($k in ($formTally.Keys | Sort-Object)) {
      $report.Add("    - " + $k + " = " + $formTally[$k])
    }
  } else {
    $report.Add("- pathForm distribution: no readable ledger rows yet (dispatch a few advisor runs first)")
  }
} else {
  $report.Add("- ledger leg skipped: no DSH home located")
}
$report.Add("Interpretation: three coexisting delivery forms with unknown inline conditions; the")
$report.Add("distribution over a few advisor runs is the evidence the upstream fix needs.")
$report.Add("")
$report.Add("## Paste-ready note")
$report.Add("Produced by scripts/repro-platform-issues.ps1 (read-only). Full write-ups:")
$report.Add("docs/upstream-2026-09-26-platform-issues.md. Plugin-side contract authority:")
$report.Add("lib/contract-baseline.mjs (nine contact-point locks + version sentinel); run the")
$report.Add("contractWatch tool for a one-call inspection.")

try {
  $report -join [Environment]::NewLine | Write-Output
} finally {
  if ($tempHomeOk) {
    try { Remove-Item -LiteralPath $tempHome -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  }
}
exit 0
