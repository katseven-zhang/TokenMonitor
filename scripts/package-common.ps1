# Shared desktop packaging and lifecycle guards. User data is never deleted.
$ErrorActionPreference = 'Stop'
$PackageFiles = @('TokenMonitor.exe','LICENSE','README.md','LICENSE.codex-usage-desktop','prices.example.json','THIRD-PARTY-NOTICES.txt','install-windows.ps1','uninstall-windows.ps1','package-common.ps1')
function Assert-PlainTree([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point is not allowed: $cursor" }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
    if (Test-Path -LiteralPath $full -PathType Container) {
        foreach ($item in Get-ChildItem -LiteralPath $full -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point is not allowed: $($item.FullName)" }
            if ($item.PSIsContainer) { Assert-PlainTree $item.FullName }
        }
    }
}
function Get-InstallDirectory([string]$Root) {
    $full = [IO.Path]::GetFullPath($Root).TrimEnd('\','/')
    if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\','/')) { throw 'InstallRoot must not be a drive root' }
    Assert-PlainTree $full
    return Join-Path $full 'TokenMonitor'
}
function Assert-DesktopPackage([string]$Directory) {
    Assert-PlainTree $Directory
    $expected = @($PackageFiles + 'manifest.json')
    if (Compare-Object $expected @(Get-ChildItem -LiteralPath $Directory -Force | ForEach-Object Name)) { throw 'Desktop package whitelist mismatch' }
    $manifest = Get-Content -LiteralPath (Join-Path $Directory 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.product -ne 'TokenMonitor' -or $manifest.platform -ne 'windows-x64') { throw 'Not a TokenMonitor desktop package' }
    if (@($manifest.files).Count -ne $PackageFiles.Count -or (Compare-Object $PackageFiles @($manifest.files.name))) { throw 'Manifest whitelist mismatch' }
    foreach ($entry in $manifest.files) {
        $path = Join-Path $Directory $entry.name
        if ((Get-Item -LiteralPath $path).Length -ne $entry.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Package hash mismatch: $($entry.name)" }
    }
}
function Remove-ProgramTree([string]$Path, [string]$InstallDirectory) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -notin @($InstallDirectory, "$InstallDirectory.new", "$InstallDirectory.old")) { throw "Unexpected removal target: $full" }
    if (-not (Test-Path -LiteralPath $full)) { return }
    Assert-PlainTree $full
    foreach ($item in Get-ChildItem -LiteralPath $full -Force) {
        if ($item.Name -notin @($PackageFiles + 'manifest.json') -or $item.PSIsContainer) { throw "Preserve unrecognized content before retrying: $($item.FullName)" }
    }
    Remove-Item -LiteralPath $full -Recurse -Force
}
function Assert-InstallStopped([string]$Directory) {
    foreach ($process in Get-Process -Name TokenMonitor,TokenMonitorTray,node -ErrorAction SilentlyContinue) {
        try { $path = $process.Path } catch { throw 'Cannot establish running TokenMonitor path; exit it first' }
        if ($path -and [IO.Path]::GetFullPath($path).StartsWith($Directory + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Exit TokenMonitor and its background service before installing or uninstalling' }
    }
}
function Remove-OwnedAutostart([string]$Directory, [string]$RegistryPath) {
    if (-not (Test-Path -LiteralPath $RegistryPath)) { return }
    foreach ($name in @('TokenMonitor','tokenmonitor-desktop')) {
        $property = (Get-ItemProperty -LiteralPath $RegistryPath).PSObject.Properties[$name]
        $value = if ($property) { $property.Value } else { $null }
        $exe = Join-Path $Directory 'TokenMonitor.exe'
        if ($value -and ($value -eq ('"' + $exe + '" --background') -or $value -eq ('"' + $exe + '" "--background"') -or $value -eq ($exe + ' --background'))) {
            $approval = if ($RegistryPath -eq 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run' } else { Join-Path $RegistryPath 'StartupApproved' }
            if (Test-Path -LiteralPath $approval) { Remove-ItemProperty -LiteralPath $approval -Name $name -ErrorAction SilentlyContinue }
            Remove-ItemProperty -LiteralPath $RegistryPath -Name $name
        }
    }
}
