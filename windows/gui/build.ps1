#requires -Version 5.1
<#
.SYNOPSIS
  Builds the TokenMonitor GUI launcher as a native Win32 executable
  (task #24 Win-GUI; rewritten in Rust by #28 Win-GUI-Native).

.DESCRIPTION
  Output is FIXED to windows\gui\publish\TokenMonitorGui.exe and the exact
  directory is cleaned before every build (overwrite, never accumulate).
  The exe links only OS-provided DLLs (user32/gdi32/...), so the target
  Win10/11 machine needs nothing installed. Requires the Rust toolchain
  (rustup, MSVC target). Prints size and SHA-256 of the artifact.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File windows\gui\build.ps1
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$guiDir = $PSScriptRoot
$publish = Join-Path $guiDir 'publish'
if (Test-Path -LiteralPath $publish) { Remove-Item -LiteralPath $publish -Recurse -Force }
New-Item -ItemType Directory -Path $publish -Force | Out-Null

Push-Location $guiDir
try {
  & cargo build --release
  if ($LASTEXITCODE -ne 0) { Write-Host '[gui-build] cargo build failed (Rust toolchain required)'; exit 1 }
} finally { Pop-Location }

$exe = Join-Path $publish 'TokenMonitorGui.exe'
Copy-Item -LiteralPath (Join-Path $guiDir 'target\release\TokenMonitorGui.exe') -Destination $exe -Force

if (-not (Test-Path -LiteralPath $exe)) { Write-Host "[gui-build] exe missing after build"; exit 1 }

$item = Get-Item -LiteralPath $exe
$hash = Get-FileHash -LiteralPath $exe -Algorithm SHA256
Write-Host ("[gui-build] OK {0}" -f $exe)
Write-Host ("[gui-build] bytes={0} sha256={1}" -f $item.Length, $hash.Hash.ToLowerInvariant())
exit 0
