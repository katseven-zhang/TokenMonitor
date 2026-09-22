#requires -Version 7.2
# Exercise the real build entry in an isolated checkout-shaped fixture. No real
# build, process shutdown, installed application or user data is touched.
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$root = Join-Path ([IO.Path]::GetTempPath()) ('TokenMonitor package-failure-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
function Check([bool]$Value,[string]$Message) { if (-not $Value) { throw $Message }; Write-Output "PASS: $Message" }
try {
    $files = & git -C $repo ls-files desktop scripts/package-common.ps1
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate fixture source' }
    foreach ($file in $files) {
        $target = Join-Path $root $file
        New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $target
    }
    $package = Join-Path $root 'dist/desktop-windows-x64'
    $zip = Join-Path $root 'dist/TokenMonitor-desktop-windows-x64.zip'
    $manifest = Join-Path $package 'manifest.json'
    New-Item -ItemType Directory -Path $package,(Join-Path $root 'desktop/dist'),(Join-Path $root 'desktop/src-tauri/target/release') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $root 'desktop/dist/index.html') 'synthetic frontend'
    Set-Content -LiteralPath (Join-Path $root 'desktop/src-tauri/target/release/TokenMonitor.exe') 'synthetic stale executable; never executed'
    @{version=2;sourceHash='stale-source';binaryHash='stale-binary'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'desktop/src-tauri/target/release/package-build.json')
    $builder = Join-Path $root 'desktop/scripts/build-windows.ps1'
    foreach ($mode in @('stale','frontend-failure')) {
        Set-Content -LiteralPath $manifest 'old manifest'
        Set-Content -LiteralPath $zip 'old ZIP'
        Set-Content -LiteralPath (Join-Path $package 'TokenMonitor.exe') 'previous executable'
        $rejected = $false
        try {
            if ($mode -eq 'frontend-failure') {
                function npm.cmd { $global:LASTEXITCODE = 9 }
                try { & $builder } finally { Remove-Item Function:npm.cmd }
            } else { & $builder -SkipBuild }
        } catch {
            $expected = if ($mode -eq 'stale') { 'Source/assets or executable changed' } else { 'Frontend build failed' }
            if (-not $_.Exception.Message.Contains($expected)) { throw }
            $rejected = $true
        }
        Check $rejected "$mode rejected by real build entry"
        Check (-not (Test-Path -LiteralPath $manifest) -and -not (Test-Path -LiteralPath $zip)) "$mode leaves no publishable old manifest or ZIP"
        Check ((Get-Content -LiteralPath (Join-Path $package 'TokenMonitor.exe')) -eq 'previous executable') "$mode preserves prior executable for diagnosis"
    }
} finally {
    $full = [IO.Path]::GetFullPath($root)
    if (-not $full.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $full) -notlike 'TokenMonitor package-failure-*') { throw 'Unsafe fixture cleanup target' }
    . (Join-Path $repo 'scripts/package-common.ps1')
    Assert-PlainTree $full
    Remove-Item -LiteralPath $full -Recurse -Force
}
