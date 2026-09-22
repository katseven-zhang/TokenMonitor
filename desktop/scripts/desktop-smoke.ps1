#requires -Version 7.2
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$exe = Join-Path $repo 'dist/desktop-windows-x64/TokenMonitor.exe'
$root = Join-Path ([IO.Path]::GetTempPath()) ('TokenMonitor UI smoke-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start()
$port = $listener.LocalEndpoint.Port; $listener.Stop()
@{ port=$port; refreshSeconds=86400; roots=@{}; disabledAgents=@('codex','claude-code','ccmr','zcode','dsh','workbuddy','grok','pi','opencode','antigravity','qoder','xiaomi-mimo') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'settings.json') -Encoding utf8NoBOM
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DesktopProbe {
  public delegate bool Callback(IntPtr window, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w, out uint id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr w, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr w, uint msg, IntPtr a, IntPtr b);
  public static IntPtr Visible(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((w,p) => { uint id; GetWindowThreadProcessId(w,out id); var title=new System.Text.StringBuilder(256); GetWindowText(w,title,256); if(id==pid && title.ToString()=="TokenMonitor · 本地 Agent 用量" && IsWindowVisible(w)) found=w; return true; }, IntPtr.Zero);
    return found;
  }
}
"@
function Rpc([string]$Method) {
    $client = [Net.Sockets.TcpClient]::new(); $client.Connect('127.0.0.1',$port)
    try {
        $stream = $client.GetStream(); $stream.ReadTimeout=3000
        $writer = [IO.StreamWriter]::new($stream,[Text.UTF8Encoding]::new($false)); $writer.AutoFlush=$true
        $writer.WriteLine((@{token=[IO.File]::ReadAllText((Join-Path $root 'service-token'));method=$Method;args=@{}} | ConvertTo-Json -Compress))
        $reader = [IO.StreamReader]::new($stream); return ($reader.ReadLine() | ConvertFrom-Json)
    } finally { $client.Dispose() }
}
function Until([scriptblock]$Check,[string]$Message) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do { try { if (& $Check) { Write-Output "PASS: $Message"; return } } catch {} ; Start-Sleep -Milliseconds 200 } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out: $Message"
}
$priorRoot = $env:TOKENMONITOR_DATA_DIR
$env:TOKENMONITOR_DATA_DIR=$root
$gui = $null
try {
    $gui = Start-Process -FilePath $exe -ArgumentList '--background' -PassThru -WindowStyle Hidden
    Until { (Rpc 'status').result.running -eq $true } 'background service starts with isolated data'
    if ([DesktopProbe]::Visible($gui.Id) -ne [IntPtr]::Zero) { throw 'Background startup unexpectedly displays window' }
    Write-Output 'PASS: background desktop remains hidden'
    $again = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
    if (-not $again.WaitForExit(10000) -or $again.ExitCode -ne 0) { throw 'Second desktop instance did not exit successfully' }
    Until { [DesktopProbe]::Visible($gui.Id) -ne [IntPtr]::Zero } 'second launch restores existing window'
    $window = [DesktopProbe]::Visible($gui.Id)
    [void][DesktopProbe]::PostMessageW($window,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)
    Until { [DesktopProbe]::Visible($gui.Id) -eq [IntPtr]::Zero } 'close hides window for tray residency'
    $gui.Refresh(); if ($gui.HasExited) { throw 'Close terminated tray application' }
    if (-not (Rpc 'status').result.running) { throw 'Close stopped background unexpectedly' }
    Write-Output 'PASS: tray application and service survive window close'
    if (-not (Rpc 'stop').result.stopping) { throw 'Service stop rejected' }
    Until { try { -not (Rpc 'status').result.running } catch { $true } } 'service stops explicitly'
} finally {
    try { $null = Rpc 'stop' } catch {}
    if ($gui) { $gui.Refresh(); if (-not $gui.HasExited) { $gui.Kill($true); $gui.WaitForExit() } }
    $env:TOKENMONITOR_DATA_DIR=$priorRoot
    # Only this test's unique temp root. WebView descendants can close asynchronously.
    $full=[IO.Path]::GetFullPath($root)
    if (-not $full.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe UI fixture cleanup' }
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        try { Remove-Item -LiteralPath $full -Recurse -Force; break } catch { if ($attempt -eq 19) { throw }; Start-Sleep -Milliseconds 250 }
    }
}
