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
  - The two native exes taken from windows\*\publish\ are rebuilt when missing OR
    when older than any source they build from, so a leftover publish artifact can
    never be packaged silently (#101).
  - Output is scanned for secrets/runtime artifacts (.agentchatroom, .workbuddy,
    acr.credential_ tokens, *.db/*.log); any hit fails the build.
  - The application code that ships is exactly what git tracks under bin\, src\ and
    web\: a file present in those trees that git neither tracks nor ignores fails the
    build by name, so no untracked local leftover can ever ride along in a package.

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

# --- 4b. native Rust exes (#28 GUI launcher, #32 tray): never ship a stale artifact ----
# Both are consumed from windows\<app>\publish\ and are only rebuilt when MISSING.
# Before this change a leftover publish exe from an earlier commit was packaged
# silently, so the shipped exe could lag the source it was built from - and nothing
# in the package (or its manifest) said so. Staleness is now decided by comparing
# the exe against the newest source the build actually reads, and a stale exe is
# rebuilt through its own build.ps1 (same entry point a human would run).
function Get-NewestSourceWrite([string]$AppDir) {
  $dir = Join-Path $repoFull "windows\$AppDir"
  $newest = [datetime]::MinValue
  foreach ($f in @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue)) {
    # publish\ is the artifact itself and target\ is cargo's scratch space - neither
    # is a source input, and including them would make the exe look newer than itself.
    $rel = $f.FullName.Substring($dir.Length + 1)
    if ($rel -match '^(publish|target)[\\]') { continue }
    if ($f.LastWriteTime -gt $newest) { $newest = $f.LastWriteTime }
  }
  return $newest
}
function Resolve-PublishedExe([string]$AppDir, [string]$ExeName, [string]$Label) {
  $exe = Join-Path $repoFull "windows\$AppDir\publish\$ExeName"
  $why = ''
  if (-not (Test-Path -LiteralPath $exe)) {
    $why = 'missing'
  } else {
    $srcNewest = Get-NewestSourceWrite $AppDir
    if ($srcNewest -gt (Get-Item -LiteralPath $exe).LastWriteTime) {
      $why = ("stale (newest source {0} is newer than the exe {1})" -f `
        $srcNewest.ToString('yyyy-MM-dd HH:mm:ss'), (Get-Item -LiteralPath $exe).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
    }
  }
  if ($why -ne '') {
    Write-Host ("[build] {0} exe {1}, building windows\{2} (Rust toolchain required)..." -f $Label, $why, $AppDir)
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoFull "windows\$AppDir\build.ps1")
    if ($LASTEXITCODE -ne 0) { Fail "$Label build failed ($why; or run windows\$AppDir\build.ps1 first)" }
  }
  if (-not (Test-Path -LiteralPath $exe)) { Fail "$Label missing after build: $exe" }
  return $exe
}
$guiExe = Resolve-PublishedExe 'gui' 'TokenMonitorGui.exe' 'GUI launcher'

# --- 4c. packaged source whitelist: only git-tracked files may ship ----------------
# Step 6 used to do `Copy-Item -Recurse` over bin\, src\ and web\. Everything living
# in those trees therefore rode along - including local build leftovers that git has
# never seen. Step 7's content scan only looks for credential tokens and
# *.db/*.log, so "one extra file that is not a source file" was invisible: the
# shipped package could contain content nobody reviewed. The package face is now
# defined by git's index: tracked files are copied one by one, a file present in the
# tree that git neither tracks nor ignores fails the build by name, and
# .gitignore-excluded content is reported as not packaged.
$PACKAGED_DIRS = @('bin', 'src', 'web')

function New-RelativePathSet([string[]]$Paths) {
  $set = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($p in $Paths) { if ($p) { [void]$set.Add($p.Replace('\', '/')) } }
  return ,$set
}

# $null means "git could not tell us what the source tree is" (no git on PATH, or a
# source export rather than a checkout). Callers must fail rather than fall back to
# the old whole-directory copy - a silent fallback is exactly the hole being closed.
function Get-PackagedFileSets {
  Push-Location $repoFull
  try {
    $preference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $tracked = @(& git -c core.quotePath=false ls-files -- $PACKAGED_DIRS)
    $trackedCode = $LASTEXITCODE
    $others = @(& git -c core.quotePath=false ls-files --others --exclude-standard -- $PACKAGED_DIRS)
    $othersCode = $LASTEXITCODE
    $ErrorActionPreference = $preference
  } finally { Pop-Location }
  if ($trackedCode -ne 0 -or $othersCode -ne 0) { return $null }
  return @{ tracked = (New-RelativePathSet $tracked); untracked = (New-RelativePathSet $others) }
}

function Copy-TrackedSourceTree([string]$Dir, [string]$Runtime, $Sets) {
  $source = Join-Path $repoFull $Dir
  if (-not (Test-Path -LiteralPath $source)) { Fail "packaged source directory is missing: $source" }
  $prefix = "$Dir/"
  $copied = 0
  $ignored = 0
  $strays = @()
  foreach ($file in @(Get-ChildItem -LiteralPath $source -Recurse -File -Force)) {
    $rel = $prefix + $file.FullName.Substring($source.Length + 1).Replace('\', '/')
    if ($Sets.tracked.Contains($rel)) {
      $target = Join-Path $Runtime $rel
      $parent = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      Copy-Item -LiteralPath $file.FullName -Destination $target -Force
      $copied++
    } elseif ($Sets.untracked.Contains($rel)) {
      $strays += $rel
    } else {
      $ignored++
    }
  }
  # git's index says a file belongs to the source tree but it is not on disk: the
  # whitelist copy would otherwise hand out a package that quietly lacks a source
  # file (staged-but-not-committed deletion, half-finished checkout).
  $absent = @()
  foreach ($rel in $Sets.tracked) {
    if (-not $rel.StartsWith($prefix)) { continue }
    $probe = Join-Path $source $rel.Substring($prefix.Length).Replace('/', '\')
    if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) { $absent += $rel }
  }
  Write-Host ("[build] packaged {0} git-tracked file(s) from {1}\ (.gitignore-excluded, not packaged: {2})" -f $copied, $Dir, $ignored)
  if ($strays.Count -gt 0) {
    Fail ("untracked local files are sitting in the packaged tree " + $Dir + "\ (they would ship without ever being committed or reviewed): " + ($strays -join '; ') + ' - delete them, or git add them and rebuild')
  }
  if ($absent.Count -gt 0) {
    Fail ("git tracks these files under " + $Dir + "\ but they are missing from this checkout: " + ($absent -join '; '))
  }
}

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

  # --- tray (#32): native Rust tray exe into the package at tray\TokenMonitorTray.exe,
  # matching src/bar.js trayExeCandidates' second candidate (<root>\tray\). Before this
  # task the packager never built/copied the tray, so the packaged `bar` command could
  # never find it. Missing *or stale* -> rebuilt (4b), so the packaged tray always
  # matches the source tree it was cut from.
  $trayExe = Resolve-PublishedExe 'tray' 'TokenMonitorTray.exe' 'tray'
  New-Item -ItemType Directory -Path (Join-Path $dist 'tray') -Force | Out-Null
  Copy-Item -LiteralPath $trayExe -Destination (Join-Path $dist 'tray\TokenMonitorTray.exe')

  $packagedSets = Get-PackagedFileSets
  if ($null -eq $packagedSets) {
    Fail 'cannot read the git index for bin/src/web (git missing or this is not a checkout); the package must be built from git-tracked sources, so the whole-directory fallback is deliberately refused'
  }
  foreach ($dir in $PACKAGED_DIRS) {
    Copy-TrackedSourceTree $dir $runtime $packagedSets
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
  $lines = @('@echo off', '"%~dp0node.exe" "%~dp0bin\tokenmonitor.js" %*', 'exit /b %ERRORLEVEL%')
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
  # -Force: hidden files ship too (they are in the manifest), so they get scanned as well.
  $appFiles = Get-ChildItem -LiteralPath $dist -Recurse -File -Force | Where-Object { $_.Extension -ine '.exe' }
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
  # -Force: the installer (#101) verifies EVERY file in the package against this
  # list and refuses unlisted content; a hidden file skipped here would make a
  # legitimately built package fail its own integrity check on install.
  $fileEntries = @()
  $allFiles = Get-ChildItem -LiteralPath $dist -Recurse -File -Force | Sort-Object FullName
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
