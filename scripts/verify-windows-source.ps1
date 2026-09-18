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
Log "copy $Root -> $Work"
Copy-Item -Path (Join-Path $Root '*') -Destination $Work -Recurse -Force -Exclude @('node_modules', '.git')
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
