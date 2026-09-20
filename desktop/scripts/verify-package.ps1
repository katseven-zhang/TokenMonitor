#requires -Version 7.2
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$directory = Join-Path $root 'dist/desktop-windows-x64'
$expected = @('TokenMonitor.exe','LICENSE','README.md','LICENSE.codex-usage-desktop','prices.example.json','THIRD-PARTY-NOTICES.txt','manifest.json')
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
Write-Output 'PASS: seven-file package, manifest hashes, ZIP bytes and project/reference/dependency licenses'
