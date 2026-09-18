using System.Diagnostics;
using System.Drawing.Drawing2D;

namespace TokenMonitorTray;

/// <summary>
/// TokenMonitor 系统托盘胶囊（#9 Win-Tray）。
/// 只通过 127.0.0.1 HTTP（/api/status）感知后台状态，绝不读数据库、不展示会话内容；
/// 后台进程只管理托盘自己启动的实例（绝不误杀外部 node.exe）。
/// 同一用户同时只会有一个托盘图标：第二实例立即退出。
/// </summary>
internal static class Program
{
    private static Mutex? _mutex;
    private static NotifyIcon? _tray;
    private static ToolStripMenuItem? _startRestartItem;
    private static Process? _backend;
    private static bool _backendOwned;
    private static bool _externalOnline;
    private static bool _pollInFlight;
    private static bool _lastOnline;
    private static bool _everPolled;
    private static int _port = 8787;
    private static string _backendExe = string.Empty;
    private static string _backendArgs = string.Empty;
    private static string _panelUrl = "http://127.0.0.1:8787";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMilliseconds(1500) };

    [STAThread]
    private static int Main(string[] args)
    {
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] is "--port" or "-p" && i + 1 < args.Length
                && int.TryParse(args[++i], out var p) && p is >= 1 and <= 65535)
            {
                _port = p;
            }
        }
        _panelUrl = $"http://127.0.0.1:{_port}";

        // 单实例：重复启动 = 新实例立即退出，桌面永远只有一个图标
        _mutex = new Mutex(initiallyOwned: true, @"Local\TokenMonitorTray", out var createdNew);
        if (!createdNew) return 0;

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        ResolveBackendCommand();

        _startRestartItem = new ToolStripMenuItem(StartRestartLabel(), null, (_, _) => StartRestartBackend());
        if (string.IsNullOrEmpty(_backendExe))
        {
            _startRestartItem.Enabled = false;
            _startRestartItem.ToolTipText = "未找到后端启动命令（需要 node.exe 与 bin/tokenmonitor.js）";
        }

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开面板", null, (_, _) => OpenPanel());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_startRestartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出托盘", null, (_, _) => ExitTray());

        _tray = new NotifyIcon
        {
            Icon = MakeIcon(online: false),
            Text = $"TokenMonitor 后台：检测中… (port {_port})",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _tray.DoubleClick += (_, _) => OpenPanel();

        var timer = new System.Windows.Forms.Timer { Interval = 5000 };
        timer.Tick += (_, _) => _ = PollOnceAsync();
        timer.Start();
        _ = PollOnceAsync();

        Application.Run(new TrayApplicationContext());
        return 0;
    }

    private sealed class TrayApplicationContext : ApplicationContext
    {
        public TrayApplicationContext() { }
        protected override void ExitThreadCore()
        {
            if (_tray is not null) { _tray.Visible = false; _tray.Dispose(); }
            StopBackend();
            try { _mutex?.ReleaseMutex(); } catch { /* 释放失败不影响退出 */ }
            base.ExitThreadCore();
        }
    }

    private static void ExitTray()
    {
        if (_tray is not null) _tray.Visible = false; // 退出必须让图标立即消失
        Application.Exit();
    }

    private static void OpenPanel()
    {
        try
        {
            Process.Start(new ProcessStartInfo(_panelUrl) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            ShowTip("无法打开面板: " + ex.Message);
        }
    }

    private static string StartRestartLabel()
    {
        if (IsBackendAlive()) return "重启后台";
        return _externalOnline ? "后台运行中（外部启动）" : "启动后台";
    }

    private static void StartRestartBackend()
    {
        if (_externalOnline && !IsBackendAlive())
        {
            ShowTip($"端口 {_port} 已有后台在运行（非托盘启动），为免误杀外部进程这里不重启");
            return;
        }
        StopBackend();
        StartBackend();
    }

    /// <summary>后台命令解析：优先打包布局（同目录 node.exe + bin），回退开发树（PATH 上的 node + 仓库 bin）。</summary>
    private static void ResolveBackendCommand()
    {
        var exeDir = AppContext.BaseDirectory;
        var localNode = Path.Combine(exeDir, "node.exe");
        var localScript = Path.Combine(exeDir, "bin", "tokenmonitor.js");
        if (File.Exists(localNode) && File.Exists(localScript))
        {
            _backendExe = localNode;
            _backendArgs = $"\"{localScript}\" serve --port {_port}";
            return;
        }
        var repoScript = Path.GetFullPath(Path.Combine(exeDir, "..", "..", "..", "bin", "tokenmonitor.js"));
        if (File.Exists(repoScript))
        {
            // 开发布局：publish 输出在 <repo>\windows\tray\publish 下，仓库根再往上三级
            _backendExe = "node";
            _backendArgs = $"\"{repoScript}\" serve --port {_port}";
        }
    }

    private static bool IsBackendAlive()
    {
        try { return _backend is { HasExited: false }; }
        catch { return false; }
    }

    private static void StartBackend()
    {
        if (string.IsNullOrEmpty(_backendExe))
        {
            ShowTip("未找到后端启动命令（需要 node.exe 与 bin/tokenmonitor.js）");
            return;
        }
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = _backendExe,
                Arguments = _backendArgs,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(_backendExe).IsNullOrEmpty()
                    ? AppContext.BaseDirectory
                    : Path.GetDirectoryName(_backendExe)!,
            };
            _backend = Process.Start(psi);
            _backendOwned = _backend != null;
            ShowTip("后台已启动，正在初始化…");
            _ = PollOnceAsync();
        }
        catch (Exception ex)
        {
            ShowTip("后台启动失败: " + ex.Message);
        }
    }

    private static void StopBackend()
    {
        if (!IsBackendAlive()) return;
        try
        {
            _backend!.Kill(entireProcessTree: true);
            _backend.WaitForExit(3000);
        }
        catch { /* 进程已退出 */ }
    }

    private static async Task PollOnceAsync()
    {
        if (_pollInFlight) return; // 后台无响应时绝不拖住 UI 线程
        _pollInFlight = true;
        try
        {
            bool online;
            try
            {
                using var resp = await Http.GetAsync($"http://127.0.0.1:{_port}/api/status");
                online = resp.IsSuccessStatusCode;
            }
            catch
            {
                online = false;
            }

            if (online && !IsBackendAlive()) _externalOnline = true;
            if (!online) _externalOnline = false;

            var tray = _tray;
            if (tray is not null)
            {
                var wanted = StartRestartLabel();
                if (_startRestartItem is not null && _startRestartItem.Text != wanted
                    && !string.IsNullOrEmpty(_backendExe))
                {
                    _startRestartItem.Text = wanted;
                }
                tray.Text = $"TokenMonitor 后台：{(online ? "在线" : "离线")} (port {_port})";
                var newIcon = MakeIcon(online);
                var old = tray.Icon;
                tray.Icon = newIcon;
                _ = old; // 程序生命周期内仅两枚图标句柄（在线/离线），退出时随进程回收
                if (_everPolled && online != _lastOnline)
                {
                    tray.BalloonTipTitle = online ? "TokenMonitor 后台已上线" : "TokenMonitor 后台离线";
                    tray.BalloonTipText = online
                        ? $"面板: {_panelUrl}"
                        : $"未连上 127.0.0.1:{_port}，可从菜单「启动后台」";
                    tray.ShowBalloonTip(3000);
                }
            }
            _lastOnline = online;
            _everPolled = true;
        }
        finally
        {
            _pollInFlight = false;
        }
    }

    private static void ShowTip(string message)
    {
        var tray = _tray;
        if (tray is null) return;
        tray.BalloonTipTitle = "TokenMonitor 托盘";
        tray.BalloonTipText = message;
        tray.ShowBalloonTip(2500);
    }

    /// <summary>运行时绘制的图标（在线=绿、离线=灰），避免携带二进制资源。</summary>
    private static Icon MakeIcon(bool online)
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var bg = new SolidBrush(online
                ? Color.FromArgb(57, 211, 83)
                : Color.FromArgb(125, 125, 140));
            g.FillEllipse(bg, 2, 2, 28, 28);
            using var font = new Font("Segoe UI", 15f, FontStyle.Bold);
            using var fg = new SolidBrush(Color.FromArgb(22, 22, 30));
            var size = g.MeasureString("T", font);
            g.DrawString("T", font, fg, 16f - size.Width / 2f, 16f - size.Height / 2f + 1f);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }
}

internal static class Extensions
{
    public static bool IsNullOrEmpty(this string? value) => string.IsNullOrEmpty(value);
}
