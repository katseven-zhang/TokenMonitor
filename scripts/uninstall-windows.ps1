#requires -Version 5.1
<#
.SYNOPSIS
  TokenMonitor per-user uninstaller with data-preservation defaults.

.DESCRIPTION
  Removes exactly three things: the TokenMonitor install folder
  (<InstallRoot>\TokenMonitor, layout v2: root TokenMonitor.exe + runtime\),
  the TokenMonitor shortcuts, and the product's own Task Scheduler entry
  (TokenMonitor-Server).

  User data lives INSIDE the install folder at <install>\data (portable
  layout, product contract v2 s.5). On uninstall it is MOVED to
  <InstallRoot>\TokenMonitor-data and PRESERVED by default; its location is
  printed. Deleting it requires the explicit -PurgeData switch plus a second
  confirmation (-ConfirmPurge, or typing DELETE at the prompt).

  Safety guards: the delete targets are resolved and validated (leaf name
  must be exactly TokenMonitor / TokenMonitor-data, the root must not be a
  drive root) before any recursive delete; an unresolved or broad path aborts
  the script.

  All roots can be overridden for automated dry-runs inside temp directories;
  tests pass -SkipScheduledTask so they never touch the real Task Scheduler.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-windows.ps1
  powershell ... -File scripts\uninstall-windows.ps1 -PurgeData -ConfirmPurge
#>
param(
  [string]$InstallRoot = '',
  [string]$StartMenuRoot = '',
  [string]$DesktopRoot = '',
  # Delete the preserved user data folder as well (needs a second confirmation).
  [switch]$PurgeData,
  # Second confirmation for -PurgeData (skips the interactive DELETE prompt).
  [switch]$ConfirmPurge,
  # Skip the Task Scheduler step (used by automated dry-runs).
  [switch]$SkipScheduledTask
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Fail([string]$Message) { throw $Message }
function Info([string]$Message) { Write-Host "[uninstall] $Message" }

$localAppData = $env:LOCALAPPDATA
if ([string]::IsNullOrEmpty($localAppData)) { Fail 'LOCALAPPDATA is not set' }
if ([string]::IsNullOrEmpty($InstallRoot))  { $InstallRoot  = Join-Path $localAppData 'Programs' }
if ([string]::IsNullOrEmpty($StartMenuRoot)) { $StartMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
if ([string]::IsNullOrEmpty($DesktopRoot))  { $DesktopRoot  = [Environment]::GetFolderPath('Desktop') }

foreach ($rootName in @('InstallRoot')) {
  $rootValue = Get-Variable $rootName -ValueOnly
  # string-level guard first: dry-run roots may not exist at all
  if ($rootValue -match '^[A-Za-z]:\\?$') { Fail "$rootName must not be a drive root (got $rootValue)" }
  if (Test-Path -LiteralPath $rootValue) {
    $resolvedRoot = (Resolve-Path -LiteralPath $rootValue).Path
    if ($resolvedRoot -match '^[A-Za-z]:\\?$') { Fail "$rootName must not be a drive root (got $resolvedRoot)" }
  }
}

$installDir = Join-Path $InstallRoot 'TokenMonitor'
$dataDir = Join-Path $installDir 'data'                  # portable data (inside the install folder)
$dataKeep = Join-Path $InstallRoot 'TokenMonitor-data'   # where uninstall keeps the data

# Detect a running backend before any destructive operation (#31).
# Corrupted lock JSON is treated as "no running instance".
function Assert-BackendStopped {
  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
  if (-not (Test-Path -LiteralPath $dataDir)) { return }
  $locks = Get-ChildItem -LiteralPath $dataDir -Filter 'tokenmonitor-*.lock' -ErrorAction SilentlyContinue
  foreach ($lock in $locks) {
    $backendPid = 0
    try {
      $raw = Get-Content -LiteralPath $lock.FullName -Raw -ErrorAction Stop
      $parsed = $raw | ConvertFrom-Json
      $backendPid = [int]$parsed.pid
    } catch { continue }
    if ($backendPid -gt 0 -and (Get-Process -Id $backendPid -ErrorAction SilentlyContinue)) {
      Write-Host ''
      Write-Host ("检测到 TokenMonitor 后台正在运行（PID {0}，锁文件 {1}）。" -f $backendPid, $lock.Name)
      Write-Host '请先停止后台，再执行安装/升级/卸载。'
      throw ("backend is running (pid {0}, lock {1}) - please stop the backend first" -f $backendPid, $lock.Name)
    }
  }
}

try {
  Assert-BackendStopped  # :31 refuse to touch data while the backend is running
  # --- 1. this product's scheduled task only ---------------------------------
  if ($SkipScheduledTask) {
    Info 'scheduled task step skipped (-SkipScheduledTask)'
  } else {
    $taskName = 'TokenMonitor-Server'
    $null = & schTasks.exe /Delete /TN $taskName /F 2>&1
    if ($LASTEXITCODE -eq 0) { Info "removed scheduled task $taskName" }
    else { Info "scheduled task $taskName not present (nothing to remove)" }
  }

  # --- 2. shortcuts -----------------------------------------------------------
  foreach ($link in @((Join-Path $StartMenuRoot 'TokenMonitor.lnk'), (Join-Path $DesktopRoot 'TokenMonitor.lnk'))) {
    if (Test-Path -LiteralPath $link) {
      Remove-Item -LiteralPath $link -Force
      Info "removed shortcut: $link"
    }
  }

  # --- 3. user data: move out of the install folder first ----------------------
  if (Test-Path -LiteralPath $dataDir) {
    if (Test-Path -LiteralPath $dataKeep) {
      Fail "both $dataDir and $dataKeep exist; resolve the leftover folder and retry"
    }
    Move-Item -LiteralPath $dataDir -Destination $dataKeep
    Info "user data moved to: $dataKeep"
  }

  # --- 4. install directory (exact path guard before recursive delete) --------
  if (Test-Path -LiteralPath $installDir) {
    $full = (Resolve-Path -LiteralPath $installDir).Path
    if ((Split-Path -Leaf $full) -cne 'TokenMonitor') { Fail "refusing to delete unexpected install path: $full" }
    if ($full -ieq ((Resolve-Path -LiteralPath $InstallRoot).Path)) { Fail "install path equals its root: $full" }
    Remove-Item -LiteralPath $full -Recurse -Force
    Info "removed install dir: $full"
  } else {
    Info "install dir not present: $installDir"
  }

  # --- 5. preserved data: keep by default, purge needs explicit double confirm --
  if (Test-Path -LiteralPath $dataKeep) {
    if (-not $PurgeData) {
      Info "user data preserved at: $dataKeep (database, logs and settings)"
      Info 'to delete it too, run again with -PurgeData -ConfirmPurge'
    } else {
      if (-not $ConfirmPurge) {
        $answer = Read-Host "Type DELETE to permanently purge user data at $dataKeep"
        if ($answer -cne 'DELETE') { Fail 'purge cancelled: confirmation did not match DELETE' }
      }
      $full = (Resolve-Path -LiteralPath $dataKeep).Path
      if ((Split-Path -Leaf $full) -cne 'TokenMonitor-data') { Fail "purge refuses unexpected leaf: $full" }
      $rootFull = (Resolve-Path -LiteralPath $InstallRoot).Path
      if ($full -ieq $rootFull) { Fail 'purge refuses to delete the install root itself' }
      Remove-Item -LiteralPath $full -Recurse -Force
      Info "user data purged: $full"
    }
  } else {
    Info "user data folder not present: $dataKeep"
  }

  Info 'uninstall complete'
  exit 0
} catch {
  [Console]::Error.WriteLine(("[uninstall] ERROR " + $_.Exception.Message))
  exit 1
}
