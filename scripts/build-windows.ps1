#requires -Version 5.1
<#
.SYNOPSIS
  TokenMonitor Windows x64 runtime package builder (task #12 Win-Package; layout v2 by #25).

.DESCRIPTION
  Builds a self-contained runtime package into the FIXED directory dist\windows-x64.
  Root layout keeps only user-facing entries; all runtime files live under runtime\:
    TokenMonitor.exe   GUI launcher (published from windows\gui, root entry)
    manifest.json      version/arch/layout/sizes/SHA-256 for every file
    runtime\node.exe   copied from the local Node >= 22.13 (ESM + node:sqlite OK)
    runtime\bin\src\web  application code and static panel assets
    runtime\package.json version + ESM marker
    runtime\node_modules\ echarts (package.json + dist/echarts.min.js) and fzstd
    runtime\tokenmonitor.cmd  CLI launcher: tokenmonitor serve --port 8787
  Runtime data lands in <package>\data on first run (portable layout, #23).

  Guarantees:
  - Only dist\windows-x64 is ever cleaned; the exact path is validated first.
  - A failed build removes the partial output so stale artifacts can never pose
    as a fresh build; exit code is non-zero on failure.
  - Output is scanned for secrets/runtime artifacts (.agentchatroom, .workbuddy,
    acr.credential_ tokens, *.db/*.log); any hit fails the build.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows.ps1
#>
param(
  # Optional explicit node.exe to package; defaults to the first node.exe on PATH.
  [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Fail([string]$Message) { throw $Message }

# --- 1. locate repo root (script lives in <repo>\scripts) ---------------------
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $repo 'package.json'))) {
  Fail "repo root not found above scripts dir: $repo"
}
$repoFull = (Resolve-Path -LiteralPath $repo).Path

# --- 2. resolve and validate node.exe -----------------------------------------
if ([string]::IsNullOrEmpty($NodeExe)) {
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $found) { Fail 'node.exe not found on PATH; pass -NodeExe <path>' }
  $NodeExe = $found.Source
}
if (-not (Test-Path -LiteralPath $NodeExe)) { Fail "node.exe not found: $NodeExe" }

$nodeVersionRaw = (& $NodeExe --version).Trim()
if ($LASTEXITCODE -ne 0) { Fail 'node --version failed' }
$parts = $nodeVersionRaw.TrimStart('v').Split('.') | ForEach-Object { [int]$_ }
if ($parts.Count -lt 2 -or $parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 13)) {
  Fail "Node >= 22.13 required (node:sqlite without flags); got $nodeVersionRaw"
}
$nodeArch = (& $NodeExe -p 'process.arch')
if ($LASTEXITCODE -ne 0 -or $nodeArch -ne 'x64') {
  Fail "expected an x64 node.exe, got arch='$nodeArch'"
}
Write-Host "[build] node $nodeVersionRaw ($nodeArch): $NodeExe"

# --- 3. package version --------------------------------------------------------
$pkg = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$version = [string]$pkg.version
if ([string]::IsNullOrEmpty($version)) { Fail 'package.json has no version' }

# --- 4. runtime deps: echarts + fzstd (npm ci from a clean checkout) -----------
$nm = Join-Path $repoFull 'node_modules'
$echartsMin = Join-Path $nm 'echarts\dist\echarts.min.js'
$fzstdDir = Join-Path $nm 'fzstd'
if (-not ((Test-Path -LiteralPath $echartsMin) -and (Test-Path -LiteralPath $fzstdDir))) {
  Write-Host '[build] node_modules incomplete, running: npm ci --omit=dev'
  Push-Location $repoFull
  try {
    & npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { Fail 'npm ci --omit=dev failed' }
  } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $echartsMin)) { Fail "missing $echartsMin after npm ci" }

# --- 4b. GUI launcher exe (#24): use the published artifact, else dotnet publish now ---
$guiExe = Join-Path $repoFull 'windows\gui\publish\TokenMonitorGui.exe'
if (-not (Test-Path -LiteralPath $guiExe)) {
  Write-Host '[build] GUI exe missing, publishing windows\gui (dotnet 8 SDK required)...'
  & dotnet publish (Join-Path $repoFull 'windows\gui\TokenMonitorGui.csproj') `
    -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    -o (Join-Path $repoFull 'windows\gui\publish')
  if ($LASTEXITCODE -ne 0) { Fail 'GUI publish failed (dotnet 8 SDK required; or run windows\gui\build.ps1 first)' }
}
if (-not (Test-Path -LiteralPath $guiExe)) { Fail "GUI launcher missing after publish: $guiExe" }

# --- 5. clean ONLY the fixed output directory (path validated first) -----------
$dist = Join-Path $repoFull 'dist\windows-x64'
if (Test-Path -LiteralPath $dist) {
  $existing = (Resolve-Path -LiteralPath $dist).Path
  if ($existing -ine $dist) { Fail "refusing to clean unexpected path: $existing" }
  Remove-Item -LiteralPath $dist -Recurse -Force
}
New-Item -ItemType Directory -Path $dist -Force | Out-Null

try {
  # --- 6. assemble the package (root: GUI exe only; everything else under runtime\) ---
  $runtime = Join-Path $dist 'runtime'
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null

  Copy-Item -LiteralPath $guiExe -Destination (Join-Path $dist 'TokenMonitor.exe')
  Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $runtime 'node.exe')

  foreach ($dir in @('bin', 'src', 'web')) {
    Copy-Item -Path (Join-Path $repoFull $dir) -Destination (Join-Path $runtime $dir) -Recurse
  }
  Copy-Item -LiteralPath (Join-Path $repoFull 'package.json') -Destination (Join-Path $runtime 'package.json')

  # echarts: the server resolves 'echarts/dist/echarts.min.js' at runtime; the
  # exports map's "./*" passthrough makes package.json + the min bundle enough.
  New-Item -ItemType Directory -Path (Join-Path $runtime 'node_modules\echarts\dist') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $nm 'echarts\package.json') -Destination (Join-Path $runtime 'node_modules\echarts\package.json')
  Copy-Item -LiteralPath $echartsMin -Destination (Join-Path $runtime 'node_modules\echarts\dist\echarts.min.js')
  Copy-Item -Path $fzstdDir -Destination (Join-Path $runtime 'node_modules\fzstd') -Recurse

  # CLI launcher inside runtime\: %~dp0 resolves to runtime\, where node.exe and
  # bin\ both live, so the script keeps working from the new layout.
  $lines = @('@echo off', '"%~dp0node.exe" "%~dp0bin\tokenwatcher.js" %*', 'exit /b %ERRORLEVEL%')
  [System.IO.File]::WriteAllText((Join-Path $runtime 'tokenmonitor.cmd'), ($lines -join "`r`n") + "`r`n", [System.Text.Encoding]::ASCII)

  # --- 7. forbidden content scan (runtime artifacts / secrets must not ship) ---
  # Path level: no collaboration metadata dirs/files (.agentchatroom/.workbuddy).
  # Content level: no credential tokens. (Source code legitimately references the
  # WorkBuddy app's data directory - that is the collector's job - so the string
  # "workbuddy" in code is not a violation.)
  $forbiddenNames = @('.agentchatroom', '.workbuddy')
  $nameHits = Get-ChildItem -LiteralPath $dist -Recurse -Force |
    Where-Object { $forbiddenNames -contains $_.Name }
  if ($nameHits) { Fail ("forbidden metadata dirs/files in output: " + (($nameHits | ForEach-Object FullName) -join '; ')) }

  $scanHits = @()
  # scan text content only (.exe files are self-contained binaries; ReadAllText on 161MB is slow and pointless)
  $appFiles = Get-ChildItem -LiteralPath $dist -Recurse -File | Where-Object { $_.Extension -ine '.exe' }
  foreach ($f in $appFiles) {
    $text = [System.IO.File]::ReadAllText($f.FullName)
    if ($text -match 'acr\.credential_[a-f0-9]') { $scanHits += "credential token -> $($f.FullName)" }
    if ($text -match 'Authorization["''\s:=]+Bearer\s+[A-Za-z0-9._~-]{20,}') { $scanHits += "bearer credential -> $($f.FullName)" }
  }
  if ($scanHits.Count -gt 0) { Fail ("forbidden content in output: " + ($scanHits -join '; ')) }

  $badFiles = Get-ChildItem -LiteralPath $dist -Recurse -File |
    Where-Object { $_.Name -match '\.(db|db-shm|db-wal|log)$' }
  if ($badFiles) { Fail ("forbidden artifact files in output: " + (($badFiles | ForEach-Object FullName) -join '; ')) }

  # --- 8. manifest with sizes and SHA-256 --------------------------------------
  $fileEntries = @()
  $allFiles = Get-ChildItem -LiteralPath $dist -Recurse -File | Sort-Object FullName
  foreach ($f in $allFiles) {
    $rel = $f.FullName.Substring($dist.Length + 1).Replace('\', '/')
    $hash = Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256
    $fileEntries += [ordered]@{
      path   = $rel
      bytes  = $f.Length
      sha256 = $hash.Hash.ToLowerInvariant()
    }
  }
  $totalBytes = [int64]0
  foreach ($e in $fileEntries) { $totalBytes += [int64]$e['bytes'] }
  $manifest = [ordered]@{
    name         = 'TokenMonitor'
    version      = $version
    os           = 'windows'
    arch         = 'x64'
    layout       = 2          # root GUI exe + runtime libs (#25); data in <pkg> data dir
    nodeVersion  = $nodeVersionRaw
    generatedAt  = (Get-Date).ToUniversalTime().ToString('o')
    fileCount    = $fileEntries.Count
    totalBytes   = $totalBytes
    files        = $fileEntries
  }
  $manifestPath = Join-Path $dist 'manifest.json'
  $json = $manifest | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

  Write-Host ("[build] OK dist/windows-x64 version={0} files={1} totalBytes={2}" -f $version, $fileEntries.Count, $totalBytes)
  exit 0
} catch {
  # $ErrorActionPreference is Stop, so Write-Error here would rethrow and skip
  # cleanup; write to stderr directly instead.
  [Console]::Error.WriteLine(("[build] ERROR " + $_.Exception.Message))
  if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
  [Console]::Error.WriteLine('[build] FAILED; partial output removed so stale artifacts cannot pose as a fresh build')
  exit 1
}
