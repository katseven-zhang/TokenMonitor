#requires -Version 7.2
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$directory = Join-Path $root 'dist/desktop-windows-x64'
$expected = @('TokenMonitor.exe','LICENSE','README.md','LICENSE.codex-usage-desktop','prices.example.json','THIRD-PARTY-NOTICES.txt','manifest.json')
$actual = @(Get-ChildItem -LiteralPath $directory -Force | ForEach-Object Name)
if (Compare-Object $expected $actual) { throw 'Distribution whitelist mismatch' }
$manifest = Get-Content -LiteralPath (Join-Path $directory 'manifest.json') -Raw | ConvertFrom-Json
if (Compare-Object ($expected | Where-Object { $_ -ne 'manifest.json' }) @($manifest.files.name)) { throw 'Manifest whitelist mismatch' }
# #102：包里的版本必须等于配置里声明的版本。build-windows.ps1 以前往 manifest 写的是
# 一个硬编码的 '2.0.0'，与 src-tauri/tauri.conf.json 各说各话：改了配置、发出去的包
# 仍然自称旧版本，而且没有任何一处会发现。版本真相来源只有一个 —— tauri.conf.json。
$tauriConf = Get-Content -LiteralPath (Join-Path $root 'desktop/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$declaredVersion = [string]$tauriConf.version
if ([string]::IsNullOrWhiteSpace($declaredVersion)) { throw 'src-tauri/tauri.conf.json declares no version' }
if ([string]$manifest.version -ne $declaredVersion) { throw "Manifest version drift: package says $($manifest.version), tauri.conf.json says $declaredVersion" }
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
