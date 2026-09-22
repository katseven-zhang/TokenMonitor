#requires -Version 7.2
[CmdletBinding()]
param([string]$Source = '', [string]$InstallRoot = '', [string]$StartMenuRoot = '', [string]$DesktopRoot = '', [switch]$DesktopShortcut, [switch]$SkipScheduledTask)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-common.ps1')
if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs' }
if (-not $StartMenuRoot) { $StartMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
if (-not $DesktopRoot) { $DesktopRoot = [Environment]::GetFolderPath('Desktop') }
if (-not $Source) {
    $Source = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'manifest.json')) { $PSScriptRoot } else { Join-Path $PSScriptRoot '..\dist\desktop-windows-x64' }
}
$install = Get-InstallDirectory $InstallRoot
$stage = "$install.new"; $backup = "$install.old"
$sourceFull = [IO.Path]::GetFullPath($Source).TrimEnd('\','/')
if ($sourceFull -eq $install -or $sourceFull.StartsWith($install + '\',[StringComparison]::OrdinalIgnoreCase) -or $sourceFull -in @($stage,$backup)) { throw 'Source overlaps installation' }
Assert-DesktopPackage $sourceFull
Assert-InstallStopped $install
foreach ($path in @($install,$stage,$backup)) { Assert-PlainTree $path }
if (Test-Path -LiteralPath $backup) { throw "Previous rollback copy preserved at $backup; recover it before retrying" }
if (Test-Path -LiteralPath $stage) { throw "Previous staging copy preserved at $stage; inspect it before retrying" }
# Archive the old product with ALL portable data; never open its DB as desktop data.
$legacy = Test-Path -LiteralPath (Join-Path $install 'runtime\node.exe')
$archive = Join-Path ([IO.Path]::GetFullPath($InstallRoot)) 'TokenMonitor-legacy'
if ($legacy -and (Test-Path -LiteralPath $archive)) { throw "Legacy archive already exists: $archive" }
if ((Test-Path -LiteralPath $install) -and -not $legacy) { Assert-DesktopPackage $install }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$swapped = $false; $hadInstall = Test-Path -LiteralPath $install
try {
    foreach ($name in @($PackageFiles + 'manifest.json')) { Copy-Item -LiteralPath (Join-Path $sourceFull $name) -Destination $stage }
    Assert-DesktopPackage $stage
    $probe = Start-Process -FilePath (Join-Path $stage 'TokenMonitor.exe') -ArgumentList '--version' -PassThru -WindowStyle Hidden
    if (-not $probe.WaitForExit(15000)) { $probe.Kill(); throw 'Desktop version check timed out' }
    if ($probe.ExitCode -ne 0) { throw 'Desktop version check failed' }
    if ($hadInstall) { Move-Item -LiteralPath $install -Destination $backup }
    Move-Item -LiteralPath $stage -Destination $install
    $swapped = $true
    Assert-DesktopPackage $install
    $shell = New-Object -ComObject WScript.Shell
    $shortcutRoots = @($StartMenuRoot)
    if ($DesktopShortcut) { $shortcutRoots += $DesktopRoot }
    foreach ($directory in $shortcutRoots) {
        Assert-PlainTree $directory
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $link = $shell.CreateShortcut((Join-Path $directory 'TokenMonitor.lnk'))
        $link.TargetPath = Join-Path $install 'TokenMonitor.exe'; $link.WorkingDirectory = $install
        $link.Description = 'TokenMonitor'; $link.Save()
    }
} catch {
    if ($swapped) { Remove-ProgramTree $install $install }
    if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $install }
    if (Test-Path -LiteralPath $stage) { Remove-ProgramTree $stage $install }
    throw
}
if ($hadInstall) {
    if ($legacy) {
        Move-Item -LiteralPath $backup -Destination $archive
        if (-not $SkipScheduledTask) {
            $task = Get-ScheduledTask -TaskName 'TokenMonitor-Server' -ErrorAction SilentlyContinue
            if ($task) {
                $owned = @($task.Actions | Where-Object { $_.Execute -and ([IO.Path]::GetFullPath($_.Execute.Trim('"'))).StartsWith($install + '\',[StringComparison]::OrdinalIgnoreCase) })
                if ($owned.Count -eq @($task.Actions).Count -and $owned.Count -gt 0) {
                    Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Set-Content -LiteralPath (Join-Path $archive 'scheduled-task.xml')
                    Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Confirm:$false
                }
            }
        }
        Write-Output "Legacy installation and all data preserved at $archive. Enable desktop login startup in Settings."
    }
    else { Remove-ProgramTree $backup $install }
}
Write-Output "Installed desktop at $install. User data remains separate; enable login startup in Settings."
