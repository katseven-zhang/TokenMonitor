#requires -Version 7.2
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$directory = Join-Path $root 'dist/desktop-windows-x64'
. (Join-Path $root 'scripts/package-common.ps1')
Assert-DesktopPackage $directory
foreach ($name in @('install-windows.ps1','uninstall-windows.ps1','package-common.ps1')) {
    if ((Get-FileHash -LiteralPath (Join-Path $directory $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $root "scripts/$name")).Hash) { throw "Packaged lifecycle script is stale: $name" }
}
$expected = @($PackageFiles + 'manifest.json')
$actual = @(Get-ChildItem -LiteralPath $directory -Force | ForEach-Object Name)
if (Compare-Object $expected $actual) { throw 'Distribution whitelist mismatch' }
$manifest = Get-Content -LiteralPath (Join-Path $directory 'manifest.json') -Raw | ConvertFrom-Json
if (Compare-Object ($expected | Where-Object { $_ -ne 'manifest.json' }) @($manifest.files.name)) { throw 'Manifest whitelist mismatch' }
foreach ($file in $manifest.files) {
    $path = Join-Path $directory $file.name
    if ((Get-Item -LiteralPath $path).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Manifest mismatch: $($file.name)" }
}
if ((Get-FileHash (Join-Path $directory 'LICENSE')).Hash -ne (Get-FileHash (Join-Path $root 'LICENSE')).Hash) { throw 'Project LICENSE differs' }
$zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $root 'dist/TokenMonitor-desktop-windows-x64.zip'))
try {
    if (Compare-Object $expected @($zip.Entries.FullName)) { throw 'ZIP whitelist mismatch' }
    foreach ($entry in $zip.Entries) {
        $stream = $entry.Open()
        try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)) } finally { $stream.Dispose() }
        if ($hash -ne (Get-FileHash (Join-Path $directory $entry.FullName)).Hash) { throw "ZIP content mismatch: $($entry.FullName)" }
    }
} finally { $zip.Dispose() }
Write-Output 'PASS: desktop-only package, lifecycle scripts, manifest hashes, ZIP bytes and licenses'
