#requires -Version 5.1
<#
.SYNOPSIS
  TokenMonitor per-user (non-admin) installer.

.DESCRIPTION
  Installs the dist\windows-x64 runtime package (see scripts\build-windows.ps1,
  layout v2: root TokenMonitor.exe + manifest.json + runtime\) into the FIXED
  per-user location %LOCALAPPDATA%\Programs\TokenMonitor. User data lives
  INSIDE the install folder at <install>\data (portable layout, product
  contract v2 s.5) and is preserved across upgrades by moving it aside during
  the swap and moving it back after the new install verifies.

  Upgrade safety: the candidate is staged and validated (node --version and
  tokenmonitor --version both run) BEFORE the existing install is replaced;
  the old install is kept as a rollback copy until the new one verifies, and
  is restored automatically if verification fails.

  Every root can be overridden (-InstallRoot/-StartMenuRoot/-DesktopRoot),
  which is how automated dry-runs run entirely inside temp directories
  without touching the real user profile.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
  powershell ... -File scripts\install-windows.ps1 -DesktopShortcut
#>
param(
  # Candidate package directory; default <repo>\dist\windows-x64.
  [string]$Source = '',
  # Directory that will contain the TokenMonitor install folder.
  [string]$InstallRoot = '',
  # Directory that receives the Start Menu shortcut.
  [string]$StartMenuRoot = '',
  # Directory that receives the optional desktop shortcut.
  [string]$DesktopRoot = '',
  # Also create a desktop shortcut (Start Menu shortcut is always created).
  [switch]$DesktopShortcut,
  # Repo root; derived from this script's location by default.
  [string]$Repo = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Fail([string]$Message) { throw $Message }
function Info([string]$Message) { Write-Host "[install] $Message" }

# --- roots ---------------------------------------------------------------------
$localAppData = $env:LOCALAPPDATA
if ([string]::IsNullOrEmpty($localAppData)) { Fail 'LOCALAPPDATA is not set' }
if ([string]::IsNullOrEmpty($Repo)) { $Repo = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath $Repo)) { Fail "repo not found: $Repo" }
$repoFull = (Resolve-Path -LiteralPath $Repo).Path

if ([string]::IsNullOrEmpty($InstallRoot))  { $InstallRoot  = Join-Path $localAppData 'Programs' }
if ([string]::IsNullOrEmpty($StartMenuRoot)) { $StartMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
if ([string]::IsNullOrEmpty($DesktopRoot))  { $DesktopRoot  = [Environment]::GetFolderPath('Desktop') }

foreach ($rootName in @('InstallRoot')) {
  $rootValue = Get-Variable $rootName -ValueOnly
  # string-level guard first: the root may not exist yet on a fresh install
  if ($rootValue -match '^[A-Za-z]:\\?$') { Fail "$rootName must not be a drive root (got $rootValue)" }
  if (Test-Path -LiteralPath $rootValue) {
    $resolvedRoot = (Resolve-Path -LiteralPath $rootValue).Path
    if ($resolvedRoot -match '^[A-Za-z]:\\?$') { Fail "$rootName must not be a drive root (got $resolvedRoot)" }
  }
}

$installDir = Join-Path $InstallRoot 'TokenMonitor'
$dataDir = Join-Path $installDir 'data'   # portable data dir (contract v2 s.5), travels with the install

# --- candidate (layout v2) -------------------------------------------------------
if ([string]::IsNullOrEmpty($Source)) { $Source = Join-Path $repoFull 'dist\windows-x64' }
if (-not (Test-Path -LiteralPath $Source)) {
  Fail "candidate package not found: $Source - build it first with scripts/build-windows.ps1"
}
$srcFull = (Resolve-Path -LiteralPath $Source).Path
foreach ($rel in @('runtime\node.exe', 'runtime\bin\tokenmonitor.js', 'runtime\package.json', 'manifest.json', 'TokenMonitor.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $srcFull $rel))) { Fail "candidate is missing $rel" }
}

$candNode = Join-Path $srcFull 'runtime\node.exe'
$candScript = Join-Path $srcFull 'runtime\bin\tokenmonitor.js'
$candVersion = (& $candNode $candScript --version)
if ($LASTEXITCODE -ne 0) { Fail 'candidate failed --version validation before install' }
Info "candidate version: $candVersion"

# --- prepare directories --------------------------------------------------------
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$logDir = Join-Path $InstallRoot 'install-logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir ("install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Log([string]$Message) { $Message | Out-File -LiteralPath $logFile -Append -Encoding utf8 }

$isUpgrade = Test-Path -LiteralPath (Join-Path $installDir 'runtime\node.exe')
$staging = "$installDir.new"
$backup = "$installDir.old"
$dataKeep = Join-Path $InstallRoot 'TokenMonitor-data'
$backupActive = $false

# During the upgrade swap the portable data moves to <InstallRoot>TokenMonitor-data
# and moves back once the new install verifies; rollback moves it back too - data never
function Move-DataAside {
  if (Test-Path -LiteralPath (Join-Path $installDir 'data')) {
    if (Test-Path -LiteralPath $dataKeep) { Fail "unexpected leftover data folder: $dataKeep - resolve it and retry" }
    Move-Item -LiteralPath (Join-Path $installDir 'data') -Destination $dataKeep
    return $true
  }
  return $false
}
function Move-DataBack {
  if (Test-Path -LiteralPath $dataKeep) {
    Move-Item -LiteralPath $dataKeep -Destination (Join-Path $installDir 'data')
  }
}

# Detect a running backend before any destructive operation (#31):
# data	okenmonitor-<port>.lock carries the backend PID. A corrupted or
# unparsable lock file is treated as "no running instance" (fault tolerance).
function Assert-BackendStopped {
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
  $dataPath = Join-Path $installDir 'data'
  if (-not (Test-Path -LiteralPath $dataPath)) { return }
  $locks = Get-ChildItem -LiteralPath $dataPath -Filter 'tokenmonitor-*.lock' -ErrorAction SilentlyContinue
  foreach ($lock in $locks) {
    $backendPid = 0
    try {
      $raw = Get-Content -LiteralPath $lock.FullName -Raw -ErrorAction Stop
      $parsed = $raw | ConvertFrom-Json
      $backendPid = [int]$parsed.pid
    } catch { continue }  # corrupted JSON: treat as no running instance
    if ($backendPid -gt 0 -and (Get-Process -Id $backendPid -ErrorAction SilentlyContinue)) {
      Write-Host ''
      Write-Host ("检测到 TokenMonitor 后台正在运行（PID {0}，锁文件 {1}）。" -f $backendPid, $lock.Name)
      Write-Host '请先停止后台，再执行安装/升级/卸载。'
      Write-Host '可通过启动器 TokenMonitor.exe 的「停止」按钮停止后台。'
      throw ("backend is running (pid {0}, lock {1}) - please stop the backend first" -f $backendPid, $lock.Name)
    }
  }
}

try {
  Assert-BackendStopped  # :41
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }

  # --- stage + validate the candidate in final layout --------------------------
  Info "staging candidate -> $staging"
  Copy-Item -LiteralPath $srcFull -Destination $staging -Recurse
  $stagedVersion = (& (Join-Path $staging 'runtime\node.exe') (Join-Path $staging 'runtime\bin\tokenmonitor.js') --version)
  if ($LASTEXITCODE -ne 0) { Fail 'staged candidate failed --version validation' }
  Log "staged candidate version=$stagedVersion"

  if ($isUpgrade) {
    # --- replace with rollback: old copy kept until the new install verifies ---
    Info "upgrading existing install at $installDir"
    $dataAside = Move-DataAside
    Rename-Item -LiteralPath $installDir -NewName 'TokenMonitor.old'
    $backup = Join-Path $InstallRoot 'TokenMonitor.old'
    $backupActive = $true
    try {
      Rename-Item -LiteralPath $staging -NewName 'TokenMonitor'
      if ($dataAside) { Move-DataBack }
      $newVersion = (& (Join-Path $installDir 'runtime\node.exe') (Join-Path $installDir 'runtime\bin\tokenmonitor.js') --version)
      if ($LASTEXITCODE -ne 0) { Fail 'post-install verification failed for the upgraded install' }
      Remove-Item -LiteralPath $backup -Recurse -Force
      $backupActive = $false
      Info "upgrade verified: $newVersion at $installDir (old version removed)"
      Log "upgrade $candVersion verified; old copy removed"
    } catch {
      if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
      if ($backupActive -and (Test-Path -LiteralPath $backup)) {
        Rename-Item -LiteralPath $backup -NewName 'TokenMonitor'
        Move-DataBack
        Info 'post-verification failed; rolled back to the previous install'
        Log 'upgrade failed; rolled back'
      } elseif ($dataAside) {
        Move-DataBack
      }
      throw
    }
  } else {
    Rename-Item -LiteralPath $staging -NewName 'TokenMonitor'
    $newVersion = (& (Join-Path $installDir 'runtime\node.exe') (Join-Path $installDir 'runtime\bin\tokenmonitor.js') --version)
    if ($LASTEXITCODE -ne 0) {
      Remove-Item -LiteralPath $installDir -Recurse -Force
      Fail 'post-install verification failed; broken first install removed'
    }
    Info "installed version: $newVersion at $installDir"
    Log "first install version=$newVersion"
  }

  # --- portable data directory (created on install; app keeps everything here) ---
  New-Item -ItemType Directory -Path (Join-Path $dataDir 'logs') -Force | Out-Null
  Info "data dir ready: $dataDir (database/logs/settings; preserved on uninstall)"

  # --- shortcuts (Start Menu always, desktop optional): target the GUI launcher ---
  $shell = New-Object -ComObject WScript.Shell
  function New-TokenMonitorShortcut([string]$Directory) {
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    $link = Join-Path $Directory 'TokenMonitor.lnk'
    $sc = $shell.CreateShortcut($link)
    $sc.TargetPath = Join-Path $installDir 'TokenMonitor.exe'
    $sc.Arguments = ''
    $sc.WorkingDirectory = $installDir
    $sc.Description = 'TokenMonitor console (start/stop backend, port, logs)'
    $sc.Save()
    Info "shortcut created: $link"
    Log "shortcut $link"
  }
  New-TokenMonitorShortcut $StartMenuRoot
  if ($DesktopShortcut) { New-TokenMonitorShortcut $DesktopRoot }

  Log "install complete"
  Write-Host "[install] log: $logFile"
  exit 0
} catch {
  if (Test-Path -LiteralPath $staging) {
    try { Remove-Item -LiteralPath $staging -Recurse -Force } catch {}
  }
  [Console]::Error.WriteLine(("[install] ERROR " + $_.Exception.Message))
  exit 1
}
