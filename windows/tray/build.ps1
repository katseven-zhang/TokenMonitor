#requires -Version 5.1
<#
.SYNOPSIS
  Builds the TokenMonitor system tray capsule as a self-contained single-file
  win-x64 executable (task #9 Win-Tray).

.DESCRIPTION
  Output is FIXED to windows\tray\publish\TokenMonitorTray.exe and the exact
  directory is cleaned before every build (overwrite, never accumulate).
  Prints size and SHA-256 of the artifact. Requires the .NET 8 SDK.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File windows\tray\build.ps1
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$trayDir = $PSScriptRoot
$publish = Join-Path $trayDir 'publish'
if (Test-Path -LiteralPath $publish) { Remove-Item -LiteralPath $publish -Recurse -Force }

& dotnet publish (Join-Path $trayDir 'TokenMonitorTray.csproj') `
  -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -o $publish
if ($LASTEXITCODE -ne 0) { Write-Host "[tray-build] dotnet publish failed"; exit 1 }

$exe = Join-Path $publish 'TokenMonitorTray.exe'
if (-not (Test-Path -LiteralPath $exe)) { Write-Host "[tray-build] exe missing after publish"; exit 1 }

$item = Get-Item -LiteralPath $exe
$hash = Get-FileHash -LiteralPath $exe -Algorithm SHA256
Write-Host ("[tray-build] OK {0}" -f $exe)
Write-Host ("[tray-build] bytes={0} sha256={1}" -f $item.Length, $hash.Hash.ToLowerInvariant())
exit 0
