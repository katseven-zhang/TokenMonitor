#requires -Version 5.1
<#
.SYNOPSIS
  TokenMonitor per-user uninstaller with data-preservation defaults.

.DESCRIPTION
  Removes exactly three things: the TokenMonitor install folder
  (<InstallRoot>\TokenMonitor), the TokenMonitor shortcuts, and the product's
  own Task Scheduler entry (TokenMonitor-Server).

  User data (<DataRoot>\TokenMonitor with the SQLite database, pricing and
  config) is PRESERVED by default and its location is printed. Deleting data
  requires the explicit -PurgeData switch plus a second confirmation
  (-ConfirmPurge, or typing DELETE at the prompt).

  Safety guards: the delete targets are resolved and validated (leaf name must
  be exactly TokenMonitor, the root must not be a drive root) before any
  recursive delete; an unresolved or broad path aborts the script.

  All roots can be overridden for automated dry-runs inside temp directories;
  tests pass -SkipScheduledTask so they never touch the real Task Scheduler.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-windows.ps1
  powershell ... -File scripts\uninstall-windows.ps1 -PurgeData -ConfirmPurge
#>
param(
  [string]$InstallRoot = '',
  [string]$DataRoot = '',
  [string]$StartMenuRoot = '',
  [string]$DesktopRoot = '',
  # Delete the user data directory as well (needs a second confirmation).
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
if ([string]::IsNullOrEmpty($DataRoot))     { $DataRoot     = $localAppData }
if ([string]::IsNullOrEmpty($StartMenuRoot)) { $StartMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
if ([string]::IsNullOrEmpty($DesktopRoot))  { $DesktopRoot  = [Environment]::GetFolderPath('Desktop') }

foreach ($rootName in @('InstallRoot', 'DataRoot')) {
  $rootValue = Get-Variable $rootName -ValueOnly
  # string-level guard first: dry-run roots may not exist at all
  if ($rootValue -match '^[A-Za-z]:\\?$') { Fail "$rootName must not be a drive root (got $rootValue)" }
  if (Test-Path -LiteralPath $rootValue) {
    $resolvedRoot = (Resolve-Path -LiteralPath $rootValue).Path
    if ($resolvedRoot -match '^[A-Za-z]:\\?$') { Fail "$rootName must not be a drive root (got $resolvedRoot)" }
  }
}

$installDir = Join-Path $InstallRoot 'TokenMonitor'
$dataDir = Join-Path $DataRoot 'TokenMonitor'

try {
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

  # --- 3. install directory (exact path guard before recursive delete) --------
  if (Test-Path -LiteralPath $installDir) {
    $full = (Resolve-Path -LiteralPath $installDir).Path
    if ((Split-Path -Leaf $full) -cne 'TokenMonitor') { Fail "refusing to delete unexpected install path: $full" }
    if ($full -ieq ((Resolve-Path -LiteralPath $InstallRoot).Path)) { Fail "install path equals its root: $full" }
    Remove-Item -LiteralPath $full -Recurse -Force
    Info "removed install dir: $full"
  } else {
    Info "install dir not present: $installDir"
  }

  # --- 4. user data: preserve by default, purge needs explicit double confirm --
  if (Test-Path -LiteralPath $dataDir) {
    if (-not $PurgeData) {
      Info "user data preserved at: $dataDir (database, pricing and config)"
      Info 'to delete it too, run again with -PurgeData -ConfirmPurge'
    } else {
      if (-not $ConfirmPurge) {
        $answer = Read-Host "Type DELETE to permanently purge user data at $dataDir"
        if ($answer -cne 'DELETE') { Fail 'purge cancelled: confirmation did not match DELETE' }
      }
      $full = (Resolve-Path -LiteralPath $dataDir).Path
      if ((Split-Path -Leaf $full) -cne 'TokenMonitor') { Fail "purge refuses non-TokenMonitor leaf: $full" }
      $rootFull = (Resolve-Path -LiteralPath $DataRoot).Path
      if ($full -ieq $rootFull) { Fail 'purge refuses to delete the data root itself' }
      Remove-Item -LiteralPath $full -Recurse -Force
      Info "user data purged: $full"
    }
  } else {
    Info "data dir not present: $dataDir"
  }

  Info 'uninstall complete'
  exit 0
} catch {
  [Console]::Error.WriteLine(("[uninstall] ERROR " + $_.Exception.Message))
  exit 1
}
