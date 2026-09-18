#requires -Version 5.1
<#
.SYNOPSIS
  Builds the TokenMonitor GUI launcher as a self-contained single-file
  win-x64 executable (task #24 Win-GUI).

.DESCRIPTION
  Output is FIXED to windows\gui\publish\TokenMonitorGui.exe and the exact
  directory is cleaned before every build (overwrite, never accumulate).
  Prints size and SHA-256 of the artifact. Requires the .NET 8 SDK.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File windows\gui\build.ps1
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$guiDir = $PSScriptRoot
$publish = Join-Path $guiDir 'publish'
if (Test-Path -LiteralPath $publish) { Remove-Item -LiteralPath $publish -Recurse -Force }

& dotnet publish (Join-Path $guiDir 'TokenMonitorGui.csproj') `
  -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -o $publish
if ($LASTEXITCODE -ne 0) { Write-Host "[gui-build] dotnet publish failed"; exit 1 }

$exe = Join-Path $publish 'TokenMonitorGui.exe'
if (-not (Test-Path -LiteralPath $exe)) { Write-Host "[gui-build] exe missing after publish"; exit 1 }

$item = Get-Item -LiteralPath $exe
$hash = Get-FileHash -LiteralPath $exe -Algorithm SHA256
Write-Host ("[gui-build] OK {0}" -f $exe)
Write-Host ("[gui-build] bytes={0} sha256={1}" -f $item.Length, $hash.Hash.ToLowerInvariant())
exit 0
