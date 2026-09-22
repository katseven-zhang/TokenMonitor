#requires -Version 7.2
[CmdletBinding()]
param([string]$InstallRoot = '', [string]$StartMenuRoot = '', [string]$DesktopRoot = '',
      [string]$AutostartRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'package-common.ps1')
if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs' }
if (-not $StartMenuRoot) { $StartMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
if (-not $DesktopRoot) { $DesktopRoot = [Environment]::GetFolderPath('Desktop') }
$install = Get-InstallDirectory $InstallRoot
Assert-InstallStopped $install
if (Test-Path -LiteralPath $install) { Assert-DesktopPackage $install }
Remove-OwnedAutostart $install $AutostartRegistryPath
foreach ($directory in @($StartMenuRoot,$DesktopRoot)) {
    Assert-PlainTree $directory
    $path = Join-Path $directory 'TokenMonitor.lnk'
    if (Test-Path -LiteralPath $path) {
        $shell = New-Object -ComObject WScript.Shell
        if ($shell.CreateShortcut($path).TargetPath -eq (Join-Path $install 'TokenMonitor.exe')) { Remove-Item -LiteralPath $path -Force }
    }
}
Remove-ProgramTree $install $install
Write-Output 'Uninstalled desktop. All user data and legacy archives are preserved.'
