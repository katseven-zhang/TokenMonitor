#requires -Version 7.2
[CmdletBinding()]
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..'))
$outputRoot = Join-Path $repositoryRoot 'dist\desktop-windows-x64'
$archivePath = Join-Path $repositoryRoot 'dist\TokenMonitor-desktop-windows-x64.zip'
$exePath = Join-Path $desktopRoot 'src-tauri\target\release\TokenMonitor.exe'

$inputs = @('src','src-tauri\src','src-tauri\icons','src-tauri\capabilities','config','src-tauri\tauri.conf.json','src-tauri\Cargo.toml','src-tauri\Cargo.lock','src-tauri\build.rs','package.json','package-lock.json','vite.config.ts','tailwind.config.ts','postcss.config.cjs','index.html')
function Get-PackageFingerprint([string[]]$Paths) {
    $fingerprint = [Text.StringBuilder]::new()
    foreach ($inputPath in $Paths) {
        foreach ($sourceFile in (Get-ChildItem -LiteralPath (Join-Path $desktopRoot $inputPath) -File -Recurse | Sort-Object FullName)) {
            [void]$fingerprint.AppendLine($sourceFile.FullName.Substring($desktopRoot.Length) + ':' + (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash)
        }
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($fingerprint.ToString()))) } finally { $sha.Dispose() }
}

Push-Location $desktopRoot
try {
    if (-not $SkipBuild) {
        $beforeBuild = Get-PackageFingerprint $inputs
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
        $beforeNative = Get-PackageFingerprint ($inputs + 'dist')
        Push-Location (Join-Path $desktopRoot 'src-tauri')
        try {
            & cargo build --release --offline --locked
            if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
        } finally { Pop-Location }
    }
    if (-not (Test-Path -LiteralPath $exePath)) { throw 'Release executable is missing.' }
    # Content fingerprints avoid treating harmless timestamp changes as stale, while
    # ensuring -SkipBuild can never package an executable from different source/assets.
    $sourceHash = Get-PackageFingerprint ($inputs + 'dist')
    if (-not $SkipBuild -and ($beforeBuild -ne (Get-PackageFingerprint $inputs) -or $beforeNative -ne $sourceHash)) { throw 'Source/assets changed during build; refusing to stamp or package. Rebuild from stable inputs.' }
    $binaryHash = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
    $stampPath = Join-Path $desktopRoot 'src-tauri\target\release\package-build.json'
    if ($SkipBuild) {
        if (-not (Test-Path -LiteralPath $stampPath)) { throw 'No verified build stamp; run without -SkipBuild.' }
        $stamp = Get-Content -LiteralPath $stampPath -Raw | ConvertFrom-Json
        if ($stamp.version -ne 2 -or $stamp.sourceHash -ne $sourceHash -or $stamp.binaryHash -ne $binaryHash) { throw 'Source/assets or executable changed; run without -SkipBuild.' }
    } else {
        @{version=2;sourceHash=$sourceHash;binaryHash=$binaryHash} | ConvertTo-Json | Set-Content -LiteralPath $stampPath -Encoding utf8
    }
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    # Fixed explicit distribution whitelist. Never enumerate runtime data into an archive.
    Copy-Item -LiteralPath $exePath -Destination (Join-Path $outputRoot 'TokenMonitor.exe') -Force
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE') -Destination (Join-Path $outputRoot 'LICENSE') -Force
    Copy-Item -LiteralPath (Join-Path $desktopRoot 'README.md') -Destination (Join-Path $outputRoot 'README.md') -Force
    Copy-Item -LiteralPath (Join-Path $desktopRoot 'LICENSE.codex-usage-desktop') -Destination (Join-Path $outputRoot 'LICENSE.codex-usage-desktop') -Force
    Copy-Item -LiteralPath (Join-Path $desktopRoot 'config\prices.json') -Destination (Join-Path $outputRoot 'prices.example.json') -Force

    $notices = [Text.StringBuilder]::new()
    [void]$notices.AppendLine('TokenMonitor Desktop — third-party licenses (including build dependencies)')
    [void]$notices.AppendLine('Reference desktop source: see LICENSE.codex-usage-desktop.')
    $packages = @()
    $lock = Get-Content -LiteralPath (Join-Path $desktopRoot 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
    foreach ($entry in $lock.packages.GetEnumerator()) {
        if (-not $entry.Key) { continue }
        $manifestPath = Join-Path (Join-Path $desktopRoot $entry.Key) 'package.json'
        if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $packages += [pscustomobject]@{Name=$manifest.name;Version=$manifest.version;License=($manifest.license | ConvertTo-Json -Compress);Directory=(Split-Path $manifestPath -Parent)}
    }
    Push-Location (Join-Path $desktopRoot 'src-tauri')
    try {
        $metadataText = & cargo metadata --offline --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc
        if ($LASTEXITCODE -ne 0) { throw 'Offline Cargo metadata failed.' }
        $metadata = $metadataText | ConvertFrom-Json
        foreach ($package in $metadata.packages) {
            if ($package.name -eq 'tokenmonitor-desktop') { continue }
            $packages += [pscustomobject]@{Name=$package.name;Version=$package.version;License=$package.license;Directory=(Split-Path $package.manifest_path -Parent)}
        }
    } finally { Pop-Location }
    foreach ($package in ($packages | Sort-Object Name,Version -Unique)) {
        [void]$notices.AppendLine("`n=== $($package.Name) $($package.Version) | $($package.License) ===")
        $licenseFiles = Get-ChildItem -LiteralPath $package.Directory -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|NOTICE)([.-]|$)' }
        foreach ($licenseFile in $licenseFiles) {
            [void]$notices.AppendLine("--- $($licenseFile.Name) ---")
            [void]$notices.AppendLine([IO.File]::ReadAllText($licenseFile.FullName))
        }
    }
    [IO.File]::WriteAllText((Join-Path $outputRoot 'THIRD-PARTY-NOTICES.txt'),$notices.ToString(),[Text.UTF8Encoding]::new($false))
    $names = @('TokenMonitor.exe','LICENSE','README.md','LICENSE.codex-usage-desktop','prices.example.json','THIRD-PARTY-NOTICES.txt')
    $files = foreach ($name in $names) {
        $path = Join-Path $outputRoot $name
        [pscustomobject][ordered]@{name=$name;bytes=(Get-Item -LiteralPath $path).Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    $revision = (& git rev-parse HEAD).Trim()
    $manifest = [ordered]@{product='TokenMonitor Desktop';version='2.0.0';platform='windows-x64';revision=$revision;sourceHash=$sourceHash.ToLowerInvariant();builtAtUtc=[DateTime]::UtcNow.ToString('o');runtime='system WebView2; no bundled Node';files=@($files)}
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputRoot 'manifest.json') -Encoding utf8
    $archiveInputs = @($names + 'manifest.json') | ForEach-Object { Join-Path $outputRoot $_ }
    Compress-Archive -LiteralPath $archiveInputs -DestinationPath $archivePath -Force
    [pscustomobject]@{ExecutableBytes=(Get-Item -LiteralPath $exePath).Length;ApplicationBytes=($files | Measure-Object bytes -Sum).Sum;ArchiveBytes=(Get-Item -LiteralPath $archivePath).Length;Directory=$outputRoot;Archive=$archivePath} | ConvertTo-Json
} finally { Pop-Location }
