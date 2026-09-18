#requires -Version 5.1
<#
.SYNOPSIS
  Builds the TokenMonitor system tray as a native Rust Win32 executable
  (task #32 Win-Tray-Native; contract v3 s.2 - zero .NET dependency).

.DESCRIPTION
  Output is FIXED to windows\tray\publish\TokenMonitorTray.exe and the exact
  directory is cleaned before every build (overwrite, never accumulate).
  Prints size and SHA-256 of the artifact. Requires the Rust toolchain
  (version pinned by the repo-root rust-toolchain.toml).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File windows\tray\build.ps1
#>
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)  # windows\tray -> repo root
$crate = Join-Path $repo 'windows\tray'
$publish = Join-Path $crate 'publish'

if (Test-Path -LiteralPath $publish) { Remove-Item -LiteralPath $publish -Recurse -Force }
New-Item -ItemType Directory -Path $publish -Force | Out-Null

Write-Host '[tray-build] cargo build --release ...'
Push-Location $crate
try {
  cargo build --release
  if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
} finally {
  Pop-Location
}

$exe = Join-Path $crate 'target\release\TokenMonitorTray.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'build produced no TokenMonitorTray.exe' }
Copy-Item -LiteralPath $exe -Destination (Join-Path $publish 'TokenMonitorTray.exe') -Force

$bytes = (Get-Item -LiteralPath (Join-Path $publish 'TokenMonitorTray.exe')).Length
$sha = (Get-FileHash -LiteralPath (Join-Path $publish 'TokenMonitorTray.exe') -Algorithm SHA256).Hash
Write-Host ("[tray-build] OK {0}" -f (Join-Path $publish 'TokenMonitorTray.exe'))
Write-Host ("[tray-build] bytes={0} sha256={1}" -f $bytes, $sha)
