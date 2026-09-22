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
        if ($path -and [IO.Path]::GetFullPath($path).StartsWith($Directory + '\',[StringComparison]::OrdinalIgnoreCase)) { throw "Exit TokenMonitor and its background service before installing or uninstalling (PID $($process.Id): $path)" }
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

# Use the explicit Unicode shell-link interface. WScript.Shell's automation
# TargetPath setter can reject a Unicode install path on non-Chinese Windows.
# https://learn.microsoft.com/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishelllinkw
function Initialize-DesktopShortcuts {
    if ('TokenMonitor.DesktopShortcuts' -as [type]) { return }
    Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace TokenMonitor {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    internal class ShellLink { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr findData, uint flags);
        void GetIDList(out IntPtr list);
        void SetIDList(IntPtr list);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int count);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int count);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short key);
        void SetHotkey(short key);
        void GetShowCmd(out int command);
        void SetShowCmd(int command);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }
    public static class DesktopShortcuts {
        public static void Save(string shortcut, string target, string directory) {
            object instance = new ShellLink();
            try {
                var link = (IShellLinkW)instance;
                link.SetPath(target);
                link.SetWorkingDirectory(directory);
                link.SetDescription("TokenMonitor");
                ((IPersistFile)instance).Save(shortcut, true);
            } finally { Marshal.FinalReleaseComObject(instance); }
        }
        public static string[] Read(string shortcut) {
            object instance = new ShellLink();
            try {
                ((IPersistFile)instance).Load(shortcut, 0);
                var link = (IShellLinkW)instance;
                var target = new StringBuilder(32768);
                var directory = new StringBuilder(32768);
                link.GetPath(target, target.Capacity, IntPtr.Zero, 4); // SLGP_RAWPATH
                link.GetWorkingDirectory(directory, directory.Capacity);
                return new[] { target.ToString(), directory.ToString() };
            } finally { Marshal.FinalReleaseComObject(instance); }
        }
    }
}
"@
}
function New-DesktopShortcut([string]$Path, [string]$TargetPath, [string]$WorkingDirectory) {
    Initialize-DesktopShortcuts
    [TokenMonitor.DesktopShortcuts]::Save($Path, $TargetPath, $WorkingDirectory)
}
function Get-DesktopShortcut([string]$Path) {
    Initialize-DesktopShortcuts
    $values = [TokenMonitor.DesktopShortcuts]::Read($Path)
    [pscustomobject]@{ TargetPath = $values[0]; WorkingDirectory = $values[1] }
}
