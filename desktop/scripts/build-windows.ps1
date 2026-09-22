#requires -Version 7.2
[CmdletBinding()]
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..'))
$outputRoot = Join-Path $repositoryRoot 'dist\desktop-windows-x64'
$archivePath = Join-Path $repositoryRoot 'dist\TokenMonitor-desktop-windows-x64.zip'
. (Join-Path $repositoryRoot 'scripts\package-common.ps1')
$exePath = Join-Path $desktopRoot 'src-tauri\target\release\TokenMonitor.exe'
# #102：产物版本只有一个真相来源——src-tauri/tauri.conf.json 的 `version`。
# 它以前是这里写死的 '2.0.0'：改了 tauri.conf.json 发出去的包仍然自称 2.0.0，
# manifest.json 与包内 exe 的元数据从此各说各话，而且没有任何门会发现。
# verify-package.ps1 现在拿 manifest 的 version 反查这个文件，漂移即红。
$tauriConfigPath = Join-Path $desktopRoot 'src-tauri\tauri.conf.json'

# Every input affecting frontend or native assets participates in the stale-build check.
$fingerprintInputs = @('src','src-tauri\src','src-tauri\icons','src-tauri\capabilities','config','src-tauri\tauri.conf.json','src-tauri\Cargo.toml','src-tauri\Cargo.lock','src-tauri\build.rs','package.json','package-lock.json','tsconfig.json','vite.config.ts','tailwind.config.ts','postcss.config.cjs','index.html')
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

$publishingStarted = $false
Push-Location $desktopRoot
try {
    # Invalidate publishable artifacts before a build/stamp failure can leave a
    # previous package looking current. Only these two fixed files are removed.
    Assert-PlainTree (Split-Path $outputRoot -Parent)
    Assert-InstallStopped $outputRoot
    $publishingStarted = $true
    foreach ($artifact in @((Join-Path $outputRoot 'manifest.json'),$archivePath)) {
        if (Test-Path -LiteralPath $artifact) {
            if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw "Expected artifact file: $artifact" }
            Remove-Item -LiteralPath $artifact -Force
        }
    }
    # #102：版本从这里读，不再写死。放在构建开始处而不是写 manifest 处，是为了 fail fast：
    # 宁可现在红，也不要花四十多分钟编完 Rust 再往 manifest 里写一个不诚实的版本号。
    if (-not (Test-Path -LiteralPath $tauriConfigPath)) { throw "Missing tauri config: $tauriConfigPath" }
    $tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
    $appVersion = [string]$tauriConfig.version
    if ([string]::IsNullOrWhiteSpace($appVersion)) { throw 'src-tauri/tauri.conf.json declares no version; refusing to write a manifest with a made-up one.' }

    if (-not $SkipBuild) {
        $beforeBuild = Get-PackageFingerprint $fingerprintInputs
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
        $beforeNative = Get-PackageFingerprint ($fingerprintInputs + 'dist')
        Push-Location (Join-Path $desktopRoot 'src-tauri')
        try {
            & cargo build --release --offline --locked
            if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
        } finally { Pop-Location }
    }
    if (-not (Test-Path -LiteralPath $exePath)) { throw 'Release executable is missing.' }
    # Content fingerprints avoid treating harmless timestamp changes as stale, while
    # ensuring -SkipBuild can never package an executable from different source/assets.
    $sourceHash = Get-PackageFingerprint ($fingerprintInputs + 'dist')
    if (-not $SkipBuild -and ($beforeBuild -ne (Get-PackageFingerprint $fingerprintInputs) -or $beforeNative -ne $sourceHash)) { throw 'Source/assets changed during build; refusing to stamp or package. Rebuild from stable inputs.' }
    $binaryHash = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
    $stampPath = Join-Path $desktopRoot 'src-tauri\target\release\package-build.json'
    if ($SkipBuild) {
        if (-not (Test-Path -LiteralPath $stampPath)) { throw 'No verified build stamp; run without -SkipBuild.' }
        $stamp = Get-Content -LiteralPath $stampPath -Raw | ConvertFrom-Json
        if ($stamp.version -ne 2 -or $stamp.sourceHash -ne $sourceHash -or $stamp.binaryHash -ne $binaryHash) { throw 'Source/assets or executable changed; run without -SkipBuild.' }
    } else {
        @{version=2;sourceHash=$sourceHash;binaryHash=$binaryHash} | ConvertTo-Json | Set-Content -LiteralPath $stampPath -Encoding utf8
    }
    Assert-PlainTree $outputRoot
    if (Test-Path -LiteralPath $outputRoot) {
        $unexpected = @(Get-ChildItem -LiteralPath $outputRoot -Force | Where-Object { $_.Name -notin @($PackageFiles + 'manifest.json') -or $_.PSIsContainer })
        if ($unexpected.Count) { throw 'Output contains unknown files or data; preserve them before rebuilding.' }
    }
    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    # Fixed explicit distribution whitelist. Never enumerate runtime data into an archive.
    Copy-Item -LiteralPath $exePath -Destination (Join-Path $outputRoot 'TokenMonitor.exe') -Force
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE') -Destination (Join-Path $outputRoot 'LICENSE') -Force
    Copy-Item -LiteralPath (Join-Path $desktopRoot 'README.md') -Destination (Join-Path $outputRoot 'README.md') -Force
    Copy-Item -LiteralPath (Join-Path $desktopRoot 'LICENSE.codex-usage-desktop') -Destination (Join-Path $outputRoot 'LICENSE.codex-usage-desktop') -Force
    Copy-Item -LiteralPath (Join-Path $desktopRoot 'config\prices.json') -Destination (Join-Path $outputRoot 'prices.example.json') -Force
    foreach ($name in @('install-windows.ps1','uninstall-windows.ps1','package-common.ps1')) {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot "scripts\$name") -Destination (Join-Path $outputRoot $name) -Force
    }

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
    $names = $PackageFiles
    $files = foreach ($name in $names) {
        $path = Join-Path $outputRoot $name
        [pscustomobject][ordered]@{name=$name;bytes=(Get-Item -LiteralPath $path).Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    # #74：这个脚本在 npm 与 cargo 之后都查了 $LASTEXITCODE，唯独这里没查。
    # `git` 不在 PATH、或者从没有 HEAD 的仓库里构建时，& git rev-parse 只是往 stderr
    # 写一行字并把空串留在管道里（原生命令的非零退出不会触发 $ErrorActionPreference），
    # 于是构建照样成功，manifest 里躺着一个空 revision——事后没人能看出这个包是从
    # 哪个提交来的。缺版本可以失败，缺来源不可以静默通过。
    $revisionOutput = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw "git rev-parse HEAD failed (exit $LASTEXITCODE); refusing to stamp a release with no revision." }
    $revision = ([string]$revisionOutput).Trim()
    if ($revision -notmatch '^[0-9a-f]{7,40}$') { throw "git rev-parse HEAD did not return a commit SHA (got '$revision')." }
    $manifest = [ordered]@{product='TokenMonitor';version=$appVersion;platform='windows-x64';revision=$revision;sourceHash=$sourceHash.ToLowerInvariant();builtAtUtc=[DateTime]::UtcNow.ToString('o');runtime='system WebView2; no bundled Node';files=@($files)}
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputRoot 'manifest.json') -Encoding utf8
    $archiveInputs = @($names + 'manifest.json') | ForEach-Object { Join-Path $outputRoot $_ }
    Compress-Archive -LiteralPath $archiveInputs -DestinationPath $archivePath -Force
    [pscustomobject]@{ExecutableBytes=(Get-Item -LiteralPath $exePath).Length;ApplicationBytes=($files | Measure-Object bytes -Sum).Sum;ArchiveBytes=(Get-Item -LiteralPath $archivePath).Length;Directory=$outputRoot;Archive=$archivePath} | ConvertTo-Json
} catch {
    # Also cover failures after manifest creation, such as ZIP compression.
    if ($publishingStarted) {
        foreach ($artifact in @((Join-Path $outputRoot 'manifest.json'),$archivePath)) {
            if (Test-Path -LiteralPath $artifact -PathType Leaf) {
                Assert-PlainTree $artifact
                Remove-Item -LiteralPath $artifact -Force
            }
        }
    }
    throw
} finally { Pop-Location }
