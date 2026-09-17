#requires -Version 5.1
<#
.SYNOPSIS
  TokenMonitor per-user (non-admin) installer.

.DESCRIPTION
  Installs the dist\windows-x64 runtime package (see scripts\build-windows.ps1)
  into the FIXED per-user location %LOCALAPPDATA%\Programs\TokenMonitor and
  prepares the project data directory %LOCALAPPDATA%\TokenMonitor.

  Upgrade safety: the candidate is staged and validated (node --version and
  tokenwatcher --version both run) BEFORE the existing install is replaced;
  the old install is kept as a rollback copy until the new one verifies, and
  is restored automatically if verification fails.

  Every root can be overridden (-InstallRoot/-DataRoot/-StartMenuRoot/
  -DesktopRoot), which is how automated dry-runs run entirely inside temp
  directories without touching the real user profile.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
  powershell ... -File scripts\install-windows.ps1 -DesktopShortcut
#>
param(
  # Candidate package directory; default <repo>\dist\windows-x64.
  [string]$Source = '',
  # Directory that will contain the TokenMonitor install folder.
  [string]$InstallRoot = '',
  # Directory that will contain the TokenMonitor data folder.
  [string]$DataRoot = '',
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
if ([string]::IsNullOrEmpty($DataRoot))     { $DataRoot     = $localAppData }
if ([string]::IsNullOrEmpty($StartMenuRoot)) { $StartMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
if ([string]::IsNullOrEmpty($DesktopRoot))  { $DesktopRoot  = [Environment]::GetFolderPath('Desktop') }

foreach ($rootName in @('InstallRoot', 'DataRoot')) {
  $rootValue = Get-Variable $rootName -ValueOnly
  # string-level guard first: the root may not exist yet on a fresh install
  if ($rootValue -match '^[A-Za-z]:\\?$') { Fail "$rootName must not be a drive root (got $rootValue)" }
  if (Test-Path -LiteralPath $rootValue) {
    $resolvedRoot = (Resolve-Path -LiteralPath $rootValue).Path
    if ($resolvedRoot -match '^[A-Za-z]:\\?$') { Fail "$rootName must not be a drive root (got $resolvedRoot)" }
  }
}

$installDir = Join-Path $InstallRoot 'TokenMonitor'
$dataDir = Join-Path $DataRoot 'TokenMonitor'

# --- candidate -----------------------------------------------------------------
if ([string]::IsNullOrEmpty($Source)) { $Source = Join-Path $repoFull 'dist\windows-x64' }
if (-not (Test-Path -LiteralPath $Source)) {
  Fail "candidate package not found: $Source - build it first with scripts/build-windows.ps1"
}
$srcFull = (Resolve-Path -LiteralPath $Source).Path
foreach ($rel in @('node.exe', 'bin\tokenwatcher.js', 'package.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $srcFull $rel))) { Fail "candidate is missing $rel" }
}

$candVersion = (& (Join-Path $srcFull 'node.exe') (Join-Path $srcFull 'bin\tokenwatcher.js') --version)
if ($LASTEXITCODE -ne 0) { Fail 'candidate failed --version validation before install' }
Info "candidate version: $candVersion"

# --- prepare directories --------------------------------------------------------
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$logDir = Join-Path $dataDir 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir ("install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Log([string]$Message) { $Message | Out-File -LiteralPath $logFile -Append -Encoding utf8 }

$isUpgrade = Test-Path -LiteralPath (Join-Path $installDir 'node.exe')
$staging = "$installDir.new"
$backup = "$installDir.old"
$backupActive = $false

try {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }

  # --- stage + validate the candidate in final layout --------------------------
  Info "staging candidate -> $staging"
  Copy-Item -LiteralPath $srcFull -Destination $staging -Recurse
  $stagedVersion = (& (Join-Path $staging 'node.exe') (Join-Path $staging 'bin\tokenwatcher.js') --version)
  if ($LASTEXITCODE -ne 0) { Fail 'staged candidate failed --version validation' }
  Log "staged candidate version=$stagedVersion"

  if ($isUpgrade) {
    # --- replace with rollback: old copy kept until the new install verifies ---
    Info "upgrading existing install at $installDir"
    Rename-Item -LiteralPath $installDir -NewName 'TokenMonitor.old'
    $backup = Join-Path $InstallRoot 'TokenMonitor.old'
    $backupActive = $true
    try {
      Rename-Item -LiteralPath $staging -NewName 'TokenMonitor'
      $newVersion = (& (Join-Path $installDir 'node.exe') (Join-Path $installDir 'bin\tokenwatcher.js') --version)
      if ($LASTEXITCODE -ne 0) { Fail 'post-install verification failed for the upgraded install' }
      Remove-Item -LiteralPath $backup -Recurse -Force
      $backupActive = $false
      Info "upgrade verified: $newVersion at $installDir (old version removed)"
      Log "upgrade $candVersion verified; old copy removed"
    } catch {
      if (Test-Path -LiteralPath $installDir) { Remove-Item -LiteralPath $installDir -Recurse -Force }
      if ($backupActive -and (Test-Path -LiteralPath $backup)) {
        Rename-Item -LiteralPath $backup -NewName 'TokenMonitor'
        Info 'post-verification failed; rolled back to the previous install'
        Log 'upgrade failed; rolled back'
      }
      throw
    }
  } else {
    Rename-Item -LiteralPath $staging -NewName 'TokenMonitor'
    $newVersion = (& (Join-Path $installDir 'node.exe') (Join-Path $installDir 'bin\tokenwatcher.js') --version)
    if ($LASTEXITCODE -ne 0) {
      Remove-Item -LiteralPath $installDir -Recurse -Force
      Fail 'post-install verification failed; broken first install removed'
    }
    Info "installed version: $newVersion at $installDir"
    Log "first install version=$newVersion"
  }

  # --- shortcuts (Start Menu always, desktop optional) --------------------------
  $shell = New-Object -ComObject WScript.Shell
  function New-TokenMonitorShortcut([string]$Directory) {
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    $link = Join-Path $Directory 'TokenMonitor.lnk'
    $sc = $shell.CreateShortcut($link)
    $sc.TargetPath = Join-Path $installDir 'node.exe'
    $sc.Arguments = 'bin\tokenwatcher.js serve'
    $sc.WorkingDirectory = $installDir
    $sc.Description = 'TokenMonitor local token usage panel'
    $sc.Save()
    Info "shortcut created: $link"
    Log "shortcut $link"
  }
  New-TokenMonitorShortcut $StartMenuRoot
  if ($DesktopShortcut) { New-TokenMonitorShortcut $DesktopRoot }

  Info "data dir ready: $dataDir (database/pricing/config; preserved on uninstall)"
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
