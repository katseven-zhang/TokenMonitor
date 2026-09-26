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
        # #129：与安装侧同一条 Unicode 安全读取（package-common 的 IShellLinkW 封装）。
        # WScript.Shell 的 TargetPath 读回系统 ANSI 代码页外的路径时会把字符替换成
        # '?'，判等恒 False，卸载后快捷方式残留——25eb7d6 修创建侧时的同一机制，
        # 读取侧在此一并迁移。读不动的链接不算本产品的，保持不动。
        try { $link = Get-DesktopShortcut $path } catch { $link = $null }
        if ($link -and $link.TargetPath -eq (Join-Path $install 'TokenMonitor.exe')) { Remove-Item -LiteralPath $path -Force }
    }
}
Remove-ProgramTree $install $install
Write-Output 'Uninstalled desktop. All user data and legacy archives are preserved.'
