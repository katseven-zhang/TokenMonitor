#requires -Version 7.2
[CmdletBinding()]
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $desktopRoot '..'))
$outputRoot = Join-Path $repositoryRoot 'dist\desktop-windows-x64'
$archivePath = Join-Path $repositoryRoot 'dist\TokenMonitor-desktop-windows-x64.zip'
$exePath = Join-Path $desktopRoot 'src-tauri\target\release\TokenMonitor.exe'
# #102：产物版本只有一个真相来源——src-tauri/tauri.conf.json 的 `version`。
# 它以前是这里写死的 '2.0.0'：改了 tauri.conf.json 发出去的包仍然自称 2.0.0，
# manifest.json 与包内 exe 的元数据从此各说各话，而且没有任何门会发现。
# verify-package.ps1 现在拿 manifest 的 version 反查这个文件，漂移即红。
$tauriConfigPath = Join-Path $desktopRoot 'src-tauri\tauri.conf.json'

# #74：指纹必须覆盖所有会改变产物的输入。`tsconfig.json` 以前不在表里——改它
# （strict、target、paths 等）会改变 vite/tsc 的产物，但 `-SkipBuild` 的 stamp 校验
# 认为源码没动，于是把旧 exe 当成新配置的成果打包。test/run.mjs 的 [28] 段守住
# "表里每个路径真实存在"，改名/漏项不会再静默缩小指纹。
# #102：变量名从 `$inputs` 改为 `$fingerprintInputs`。`$input` 是 PowerShell 的自动
# 变量（管道里当前对象的可枚举形式），`$inputs` 与它只差一个字母，在
# `Set-StrictMode -Version Latest` 下这类"看着像自动变量"的名字就是雷（仓库里另一条
# 打包脚本 scripts/build-windows.ps1 已经开了 Set-StrictMode），改名消除歧义。
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

# #102：版本从这里读，不再写死。放在构建开始处而不是写 manifest 处，是为了 fail fast：
# 宁可现在红，也不要花四十多分钟编完 Rust 再往 manifest 里写一个不诚实的版本号。
if (-not (Test-Path -LiteralPath $tauriConfigPath)) { throw "Missing tauri config: $tauriConfigPath" }
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
$appVersion = [string]$tauriConfig.version
if ([string]::IsNullOrWhiteSpace($appVersion)) { throw 'src-tauri/tauri.conf.json declares no version; refusing to write a manifest with a made-up one.' }

Push-Location $desktopRoot
try {
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
    # #102：输出目录必须先清后建。以前这里只有 New-Item -Force（存在即放过），于是上一轮
    # 构建留在 $outputRoot 里的文件会一起进包——verify-package.ps1 的白名单比对
    # （Compare-Object $expected $actual）会把它报成 "Distribution whitelist mismatch"，
    # 报的还是"包里有不该有的东西"这种看起来像白名单写错的样子，真实原因（没清理）
    # 完全看不出来。清理范围就是这一个目录，不放宽到 dist\ 的其他内容
    # （legacy dist\windows-x64 与它同级，属于旧版发布线，必须留着）。
    # 删之前先核对解析出来的绝对路径，路径被改写时宁可失败也不误删。
    if (Test-Path -LiteralPath $outputRoot) {
        $resolved = (Resolve-Path -LiteralPath $outputRoot).Path
        if ($resolved -ine $outputRoot) { throw "Refusing to clean unexpected path: $resolved" }
        Remove-Item -LiteralPath $outputRoot -Recurse -Force
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
    $manifest = [ordered]@{product='TokenMonitor Desktop';version=$appVersion;platform='windows-x64';revision=$revision;sourceHash=$sourceHash.ToLowerInvariant();builtAtUtc=[DateTime]::UtcNow.ToString('o');runtime='system WebView2; no bundled Node';files=@($files)}
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputRoot 'manifest.json') -Encoding utf8
    $archiveInputs = @($names + 'manifest.json') | ForEach-Object { Join-Path $outputRoot $_ }
    Compress-Archive -LiteralPath $archiveInputs -DestinationPath $archivePath -Force
    [pscustomobject]@{ExecutableBytes=(Get-Item -LiteralPath $exePath).Length;ApplicationBytes=($files | Measure-Object bytes -Sum).Sum;ArchiveBytes=(Get-Item -LiteralPath $archivePath).Length;Directory=$outputRoot;Archive=$archivePath} | ConvertTo-Json
} finally { Pop-Location }
