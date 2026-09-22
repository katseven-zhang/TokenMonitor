#requires -Version 7.2
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$source = Join-Path $repo 'dist/desktop-windows-x64'
. (Join-Path $source 'package-common.ps1')
# Include characters outside both Western and Chinese ANSI code pages.
$root = Join-Path ([IO.Path]::GetTempPath()) ('TokenMonitor 安装 العربية 🚀 smoke-' + [guid]::NewGuid())
$registry = 'HKCU:\Software\TokenMonitor-Install-Test-' + [guid]::NewGuid()
New-Item -ItemType Directory -Path $root | Out-Null
$programs = Join-Path $root 'Programs'; $menu = Join-Path $root 'Menu'; $desktop = Join-Path $root 'Desktop'
$install = Join-Path $programs 'TokenMonitor'
$sentinel = Join-Path $root 'user-data'; New-Item -ItemType Directory -Path $sentinel | Out-Null
Set-Content -LiteralPath (Join-Path $sentinel 'database') -Value 'preserve-user-data'
$dataHash = (Get-FileHash -LiteralPath (Join-Path $sentinel 'database')).Hash
$env:TOKENMONITOR_DATA_DIR = $sentinel
function Check([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; Write-Output "PASS: $Message" }
function Install([string]$Candidate = $source) {
    & (Join-Path $source 'install-windows.ps1') -Source $Candidate -InstallRoot $programs -StartMenuRoot $menu -DesktopRoot $desktop -DesktopShortcut -SkipScheduledTask
}
function Reject([scriptblock]$Action, [string]$Message, [string]$Expected = '') {
    $rejected = $false; try { & $Action } catch {
        if ($Expected -and $_.Exception.Message -notmatch $Expected) { throw }
        $rejected = $true
    }
    Check $rejected $Message
}
try {
    Assert-DesktopPackage $source
    Install
    Assert-DesktopPackage $install
    # #100: execute the version failure branch after staging, before replacement.
    function Start-Process { param($FilePath,$ArgumentList,[switch]$PassThru,$WindowStyle)
        $probe = [pscustomobject]@{ ExitCode = 1 }
        $probe | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($Timeout) return $true }
        return $probe
    }
    try { Reject { Install } 'version probe failure leaves old installation intact' 'version check failed' }
    finally { Remove-Item Function:Start-Process }
    Assert-DesktopPackage $install
    Check ((Get-FileHash -LiteralPath (Join-Path $sentinel 'database')).Hash -eq $dataHash) 'failed version probe preserves data bytes'
    Check (-not (Test-Path -LiteralPath "$install.new")) 'failed version probe removes only staged program files'
    foreach ($shortcutDirectory in @($menu, $desktop)) {
        $link = Get-DesktopShortcut (Join-Path $shortcutDirectory 'TokenMonitor.lnk')
        Check ($link.TargetPath -eq (Join-Path $install 'TokenMonitor.exe')) 'saved Unicode shortcut points to installed desktop'
        Check ($link.WorkingDirectory -eq $install) 'saved Unicode shortcut preserves working directory'
    }
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
    # #122: same crash with no current installation must also preserve .old.
    Move-Item -LiteralPath $install -Destination (Join-Path $root 'saved-install')
    try {
        Reject { Install } 'orphan rollback copy blocks fresh install' 'Previous rollback copy preserved'
        Check ((Get-Content -LiteralPath "$install.old/data/sentinel") -eq 'recovery') 'orphan rollback data remains byte-identical'
    } finally { Move-Item -LiteralPath (Join-Path $root 'saved-install') -Destination $install }
    # Only the test-owned sentinel tree, verified beneath its unique temp root.
    $recovery = [IO.Path]::GetFullPath("$install.old")
    if (-not $recovery.StartsWith($root + '\')) { throw 'Unexpected recovery target' }
    Remove-Item -LiteralPath $recovery -Recurse -Force
    New-Item -ItemType Directory -Path "$install.new/data" -Force | Out-Null
    Set-Content -LiteralPath "$install.new/data/sentinel" 'staged-data'
    Reject { Install } 'leftover staging data blocks install' 'Previous staging copy preserved'
    Check ((Get-Content -LiteralPath "$install.new/data/sentinel") -eq 'staged-data') 'staging data preserved'
    $stagingRecovery = [IO.Path]::GetFullPath("$install.new")
    if (-not $stagingRecovery.StartsWith($root + '\')) { throw 'Unexpected staging recovery target' }
    Remove-Item -LiteralPath $stagingRecovery -Recurse -Force
    # Force an error after swap: a file cannot become a shortcuts directory.
    $blockedMenu = Join-Path $root 'blocked-menu'; Set-Content -LiteralPath $blockedMenu 'file'
    Reject { & (Join-Path $source 'install-windows.ps1') -Source $source -InstallRoot $programs -StartMenuRoot $blockedMenu } 'post-swap failure rolls back'
    Assert-DesktopPackage $install
    # #101: a real running image must block both operations before any deletion.
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start()
    $servicePort = $listener.LocalEndpoint.Port; $listener.Stop()
    @{port=$servicePort;refreshSeconds=86400;roots=@{};disabledAgents=@('codex','claude-code','ccmr','zcode','dsh','workbuddy','grok','pi','opencode','antigravity','qoder','xiaomi-mimo')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sentinel 'settings.json') -Encoding utf8NoBOM
    $running = Start-Process -FilePath (Join-Path $install 'TokenMonitor.exe') -ArgumentList '--service' -PassThru -WindowStyle Hidden
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while (-not (Test-Path -LiteralPath (Join-Path $sentinel 'service-token')) -and -not $running.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
        Check (-not $running.HasExited -and (Test-Path -LiteralPath (Join-Path $sentinel 'service-token'))) 'isolated installed service is running'
        Reject { Install } 'running install rejected before replacement' 'Exit TokenMonitor'
        Reject { & (Join-Path $source 'uninstall-windows.ps1') -InstallRoot $programs -StartMenuRoot $menu -DesktopRoot $desktop -AutostartRegistryPath $registry } 'running uninstall rejected before deletion' 'Exit TokenMonitor'
        Assert-DesktopPackage $install
        Check ((Get-Content -LiteralPath (Join-Path $sentinel 'database')) -eq 'preserve-user-data') 'running-process rejection preserves complete package and data'
    } finally { if (-not $running.HasExited) { $running.Kill(); $running.WaitForExit() } }
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
    $legacyHash = (Get-FileHash -LiteralPath (Join-Path $install 'data/old.db')).Hash
    # WScript COM error text is localized; assert rollback state, not English text.
    Reject { & (Join-Path $source 'install-windows.ps1') -Source $source -InstallRoot $programs -StartMenuRoot $blockedMenu -SkipScheduledTask } 'legacy post-swap failure restores original data'
    Check ((Get-FileHash -LiteralPath (Join-Path $install 'data/old.db')).Hash -eq $legacyHash) 'legacy rollback preserves portable data bytes'
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
    if (-not $full.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $full) -notlike 'TokenMonitor 安装 العربية 🚀 smoke-*') { throw 'Unsafe test cleanup target' }
    Assert-PlainTree $full
    Remove-Item -LiteralPath $full -Recurse -Force
}
