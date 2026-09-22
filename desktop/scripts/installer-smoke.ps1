#requires -Version 7.2
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$source = Join-Path $repo 'dist/desktop-windows-x64'
. (Join-Path $source 'package-common.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('TokenMonitor 安装 smoke-' + [guid]::NewGuid())
$registry = 'HKCU:\Software\TokenMonitor-Install-Test-' + [guid]::NewGuid()
New-Item -ItemType Directory -Path $root | Out-Null
$programs = Join-Path $root 'Programs'; $menu = Join-Path $root 'Menu'; $desktop = Join-Path $root 'Desktop'
$install = Join-Path $programs 'TokenMonitor'
$sentinel = Join-Path $root 'user-data'; New-Item -ItemType Directory -Path $sentinel | Out-Null
Set-Content -LiteralPath (Join-Path $sentinel 'database') -Value 'preserve-user-data'
$env:TOKENMONITOR_DATA_DIR = $sentinel
function Check([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; Write-Output "PASS: $Message" }
function Install([string]$Candidate = $source) {
    & (Join-Path $source 'install-windows.ps1') -Source $Candidate -InstallRoot $programs -StartMenuRoot $menu -DesktopRoot $desktop -DesktopShortcut -SkipScheduledTask
}
function Reject([scriptblock]$Action, [string]$Message) {
    $rejected = $false; try { & $Action } catch { $rejected = $true }
    Check $rejected $Message
}
try {
    Assert-DesktopPackage $source
    Install
    Assert-DesktopPackage $install
    $shell = New-Object -ComObject WScript.Shell
    Check ($shell.CreateShortcut((Join-Path $menu 'TokenMonitor.lnk')).TargetPath -eq (Join-Path $install 'TokenMonitor.exe')) 'start menu points to installed desktop'
    Install
    Check (-not (Test-Path -LiteralPath "$install.old")) 'upgrade removes verified old program copy'
    Check ((Get-Content -LiteralPath (Join-Path $sentinel 'database')) -eq 'preserve-user-data') 'upgrade preserves separate data'
    $bad = Join-Path $root 'bad-package'; Copy-Item -LiteralPath $source -Destination $bad -Recurse
    Add-Content -LiteralPath (Join-Path $bad 'README.md') 'corruption'
    Reject { Install $bad } 'corrupt candidate rejected before replacement'
    Assert-DesktopPackage $install
    New-Item -ItemType Directory -Path "$install.old/data" -Force | Out-Null
    Set-Content -LiteralPath "$install.old/data/sentinel" 'recovery'
    Reject { Install } 'leftover rollback data blocks install without deletion'
    Check ((Get-Content -LiteralPath "$install.old/data/sentinel") -eq 'recovery') 'crash-window data preserved'
    # Only the test-owned sentinel tree, verified beneath its unique temp root.
    $recovery = [IO.Path]::GetFullPath("$install.old")
    if (-not $recovery.StartsWith($root + '\')) { throw 'Unexpected recovery target' }
    Remove-Item -LiteralPath $recovery -Recurse -Force
    # Force an error after swap: a file cannot become a shortcuts directory.
    $blockedMenu = Join-Path $root 'blocked-menu'; Set-Content -LiteralPath $blockedMenu 'file'
    Reject { & (Join-Path $source 'install-windows.ps1') -Source $source -InstallRoot $programs -StartMenuRoot $blockedMenu } 'post-swap failure rolls back'
    Assert-DesktopPackage $install
    New-Item -Path $registry -Force | Out-Null
    New-ItemProperty -LiteralPath $registry -Name TokenMonitor -Value ('"' + (Join-Path $install 'TokenMonitor.exe') + '" --background') | Out-Null
    New-ItemProperty -LiteralPath $registry -Name unrelated -Value 'keep' | Out-Null
    New-Item -Path (Join-Path $registry 'StartupApproved') -Force | Out-Null
    New-ItemProperty -LiteralPath (Join-Path $registry 'StartupApproved') -Name TokenMonitor -Value ([byte[]]@(2,0,0,0,0,0,0,0,0,0,0,0)) -PropertyType Binary | Out-Null
    & (Join-Path $source 'uninstall-windows.ps1') -InstallRoot $programs -StartMenuRoot $menu -DesktopRoot $desktop -AutostartRegistryPath $registry
    Check (-not (Test-Path -LiteralPath $install)) 'uninstall removes program'
    Check (-not (Get-ItemProperty -LiteralPath $registry).PSObject.Properties['TokenMonitor']) 'uninstall removes only owned autostart command'
    Check (-not (Get-ItemProperty -LiteralPath (Join-Path $registry 'StartupApproved')).PSObject.Properties['TokenMonitor']) 'owned task-manager startup metadata removed'
    Check ((Get-ItemPropertyValue -LiteralPath $registry -Name unrelated) -eq 'keep') 'unrelated registry entry preserved'
    Check ((Get-Content -LiteralPath (Join-Path $sentinel 'database')) -eq 'preserve-user-data') 'uninstall preserves data'
    # Legacy portable data survives replacement as a fixed archive.
    New-Item -ItemType Directory -Path (Join-Path $install 'runtime'),(Join-Path $install 'data') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $install 'runtime/node.exe') 'synthetic legacy'
    Set-Content -LiteralPath (Join-Path $install 'data/old.db') 'legacy-data'
    # Mock only the Task Scheduler adapter; no actual machine task is queried/changed.
    $taskProbe = @{ Removed = $false }
    function Get-ScheduledTask { [CmdletBinding()]param($TaskName) [pscustomobject]@{TaskName=$TaskName;TaskPath='\';Actions=@([pscustomobject]@{Execute=(Join-Path $install 'runtime/node.exe')})} }
    function Export-ScheduledTask { param($TaskName,$TaskPath) '<Task>synthetic</Task>' }
    function Unregister-ScheduledTask { [CmdletBinding(SupportsShouldProcess)]param($TaskName,$TaskPath) $taskProbe.Removed=$true }
    & (Join-Path $source 'install-windows.ps1') -Source $source -InstallRoot $programs -StartMenuRoot $menu -DesktopRoot $desktop
    Check $taskProbe.Removed 'owned legacy scheduled action retired through mocked adapter'
    Check ((Get-Content -LiteralPath (Join-Path $programs 'TokenMonitor-legacy/data/old.db')) -eq 'legacy-data') 'legacy data archived without conversion or deletion'
    Assert-DesktopPackage $install
    Check (-not (Test-Path -LiteralPath (Join-Path $install 'runtime'))) 'installed package has no Node runtime'
    Reject { Get-InstallDirectory ([IO.Path]::GetPathRoot($root)) } 'drive root rejected'
    $junction = Join-Path $root 'junction'
    New-Item -ItemType Junction -Path $junction -Target $sentinel | Out-Null
    try { Reject { Get-InstallDirectory $junction } 'junction install root rejected' }
    finally { Remove-Item -LiteralPath $junction -Force }
    Check ((Get-Content -LiteralPath (Join-Path $sentinel 'database')) -eq 'preserve-user-data') 'junction target data untouched'
    Write-Output 'PASS: isolated installer lifecycle smoke'
} finally {
    Remove-Item Env:TOKENMONITOR_DATA_DIR -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $registry) { Remove-Item -LiteralPath $registry -Recurse -Force }
    $full = [IO.Path]::GetFullPath($root)
    if (-not $full.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $full) -notlike 'TokenMonitor 安装 smoke-*') { throw 'Unsafe test cleanup target' }
    Assert-PlainTree $full
    Remove-Item -LiteralPath $full -Recurse -Force
}
