#Requires -Version 5.1
<#
.SYNOPSIS
  Local Windows source smoke with a path that contains CJK and spaces.
  Fails immediately (non-zero) and keeps the log. Does not skip npm test failures.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogDir = Join-Path $env:TEMP "tokenmonitor-verify-$Stamp"
New-Item -ItemType Directory -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'verify.log'
function Log([string]$m) {
  $line = "$(Get-Date -Format o) $m"
  Add-Content -Path $Log -Value $line
  Write-Host $line
}
function Fail([string]$m) {
  Log "FAIL $m"
  Log "log: $Log"
  exit 1
}

$Work = Join-Path $LogDir '源码 验证 Path'
New-Item -ItemType Directory -Path $Work | Out-Null

# 排除集按"相对路径的任意一段"生效。Copy-Item -Exclude 只看 -Path 通配匹配到的顶层
# 条目，对递归进去的子项完全无效（实测：把 target 加进 -Exclude 后，
# src\windows\gui\target\* 依然被复制），所以这里自己走目录树。必须排除的是
# windows\*\target、desktop\src-tauri\target、dist 这些 GB 级构建目录和嵌在
# desktop 下的 node_modules 链接——它们既让副本膨胀，又会把 %TEMP% 里的深路径推到
# MAX_PATH 之外（Windows PowerShell 5.1 没有长路径支持，复制到一半才失败最难查）。
$ExcludedNames = @('node_modules', '.git', 'target', 'dist')

function Copy-VerifySourceTree {
  param([string]$SourceRoot, [string]$TargetRoot, [string[]]$Excluded)
  $pending = New-Object System.Collections.Generic.Queue[string]
  $pending.Enqueue($SourceRoot)
  $files = 0
  while ($pending.Count -gt 0) {
    $dir = $pending.Dequeue()
    foreach ($entry in @(Get-ChildItem -LiteralPath $dir -Force)) {
      if ($Excluded -contains $entry.Name) { continue }
      $destination = Join-Path $TargetRoot $entry.FullName.Substring($SourceRoot.Length + 1)
      if ($entry.PSIsContainer) {
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        $pending.Enqueue($entry.FullName)
      } else {
        Copy-Item -LiteralPath $entry.FullName -Destination $destination -Force
        $files++
      }
    }
  }
  return $files
}

Log "copy $Root -> $Work (excluding path segments: $($ExcludedNames -join ', '))"
$copied = Copy-VerifySourceTree -SourceRoot $Root -TargetRoot $Work -Excluded $ExcludedNames
Log "copied $copied source files"
if ($copied -eq 0) { Fail 'source copy produced no files' }
if (Test-Path -LiteralPath (Join-Path $Work 'windows\gui\target')) { Fail 'build tree leaked into the verification copy' }
if (Test-Path -LiteralPath (Join-Path $Work 'desktop\node_modules')) { Fail 'nested node_modules leaked into the verification copy' }
if (Test-Path (Join-Path $Root 'node_modules')) {
  New-Item -ItemType Junction -Path (Join-Path $Work 'node_modules') -Target (Join-Path $Root 'node_modules') | Out-Null
}

$env:TOKENMONITOR_OFFLINE = '1'
Push-Location $Work
try {
  Log "node --check bin/tokenmonitor.js"
  & node --check .\bin\tokenmonitor.js
  if ($LASTEXITCODE -ne 0) { Fail "node --check failed ($LASTEXITCODE)" }

  Log "ci-smoke"
  & node .\test\windows\ci-smoke.mjs
  if ($LASTEXITCODE -ne 0) { Fail "ci-smoke failed ($LASTEXITCODE)" }

  Log "CLI --help"
  & node .\bin\tokenmonitor.js --help | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "help failed ($LASTEXITCODE)" }
}
catch {
  Fail $_.Exception.Message
}
finally {
  Pop-Location
}
Log "OK log=$Log"
exit 0
