#requires -Version 7.2
[CmdletBinding()]
param([switch]$SkipBuild)
& (Join-Path $PSScriptRoot '..\desktop\scripts\build-windows.ps1') -SkipBuild:$SkipBuild
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
