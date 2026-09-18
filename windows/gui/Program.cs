using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace TokenMonitorGui;

/// <summary>
/// TokenMonitor 图形启动器（#24 Win-GUI）。
/// 启动/停止后台、端口设置（持久化）、运行状态与输出日志查看。
/// 只通过 127.0.0.1 HTTP（/api/status）感知后台，绝不读数据库内容；
/// 停止只作用于本程序自己拉起的后端进程，绝不误杀外部 node.exe。
/// 同一用户同时只会有一个启动器窗口：第二实例立即退出。
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // 无头自检：打印路径解析结果后退出，供测试与诊断使用，不显示 UI
        if (args.Any(a => a is "--selfcheck" or "-selfcheck"))
        {
            return Selfcheck.Run(args);
        }

        using var mutex = new Mutex(initiallyOwned: true, @"Local\TokenMonitorGui", out var createdNew);
        if (!createdNew) return 0;

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm());
        return 0;
    }
}

/// <summary>纯逻辑：路径解析 / 校验 / 设置读写 / 日志 tail（可独立测试）。</summary>
internal static class GuiCore
{
    public const string MutexName = @"Local\TokenMonitorGui";
    public const string SettingsFileName = "gui-settings.json";
    public const string LogFileName = "tokenmonitor.log";
    public const int DefaultPort = 8787;
    public const int TailLines = 400;

    public static bool TryParsePort(string? text, out int port)
        => int.TryParse(text?.Trim(), out port) && port is >= 1 and <= 65535;

    /// <summary>应用根检测：向上最多 maxUp 层找带 TokenMonitor/windows 标记的 manifest.json。</summary>
    public static string? DetectAppRoot(string startDir, int maxUp = 2)
    {
        var dir = startDir;
        for (var i = 0; i <= maxUp; i++)
        {
            var marker = Path.Combine(dir, "manifest.json");
            try
            {
                if (File.Exists(marker))
                {
                    using var doc = JsonDocument.Parse(File.ReadAllText(marker));
                    if (doc.RootElement.TryGetProperty("name", out var name)
                        && name.GetString() == "TokenMonitor"
                        && doc.RootElement.TryGetProperty("os", out var os)
                        && os.GetString() == "windows")
                    {
                        return dir;
                    }
                }
            }
            catch { /* 损坏清单不构成标记 */ }
            var parent = Directory.GetParent(dir)?.FullName;
            if (parent is null) break;
            dir = parent;
        }
        return null;
    }

    /// <summary>数据根：TOKENMETER_DATA_DIR &gt; 打包形态 &lt;根&gt;\data &gt; 源码默认 %LOCALAPPDATA%\TokenMonitor。</summary>
    public static string ResolveDataRoot(string? appRoot, string? envDataDir, string? localAppData, string home, bool isWindows)
    {
        if (!string.IsNullOrWhiteSpace(envDataDir)) return envDataDir;
        if (!string.IsNullOrEmpty(appRoot)) return Path.Combine(appRoot, "data");
        if (isWindows && !string.IsNullOrWhiteSpace(localAppData)) return Path.Combine(localAppData, "TokenMonitor");
        return Path.Combine(home, ".tokenmeter");
    }

    /// <summary>后端命令：新布局 runtime\node.exe → 旧扁平布局同目录 node.exe → 开发树（PATH node + 仓库 bin）。</summary>
    public static (string exe, string args) ResolveBackend(string? appRoot, string exeDir, Func<string, bool> fileExists)
    {
        foreach (var root in new[] { appRoot, exeDir })
        {
            if (string.IsNullOrEmpty(root)) continue;
            var node = Path.Combine(root, "runtime", "node.exe");
            var script = Path.Combine(root, "runtime", "bin", "tokenwatcher.js");
            if (fileExists(node) && fileExists(script)) return (node, $"\"{script}\" serve --port {{0}}");

            node = Path.Combine(root, "node.exe");
            script = Path.Combine(root, "bin", "tokenwatcher.js");
            if (fileExists(node) && fileExists(script)) return (node, $"\"{script}\" serve --port {{0}}");
        }

        var devScript = Path.GetFullPath(Path.Combine(exeDir, "..", "..", "..", "bin", "tokenwatcher.js"));
        if (fileExists(devScript)) return ("node", $"\"{devScript}\" serve --port {{0}}");
        return (string.Empty, string.Empty);
    }

    public static string LogPathFor(string dataRoot) => Path.Combine(dataRoot, "logs", LogFileName);
    public static string SettingsPathFor(string dataRoot) => Path.Combine(dataRoot, SettingsFileName);

    public static int LoadPort(string settingsPath)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(settingsPath));
            if (doc.RootElement.TryGetProperty("port", out var p) && p.TryGetInt32(out var port)) return port;
        }
        catch { /* 缺失/损坏 → 默认端口 */ }
        return DefaultPort;
    }

    public static void SavePort(string settingsPath, int port)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);
        File.WriteAllText(settingsPath, JsonSerializer.Serialize(new { port }, new JsonSerializerOptions { WriteIndented = true }));
    }

    /// <summary>读取日志末尾若干行；文件被写入方占用也允许读（FileShare.ReadWrite）。</summary>
    public static string[] TailFile(string path, int maxLines)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            const int maxBytes = 1_000_000;
            if (fs.Length > maxBytes) fs.Seek(-maxBytes, SeekOrigin.End);
            using var sr = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: false);
            var first = true;
            var lines = new List<string>();
            while (sr.ReadLine() is { } line)
            {
                if (first && fs.Length > maxBytes) { first = false; continue; } // 跳过被截断的半行
                first = false;
                lines.Add(line);
                if (lines.Count > maxLines) lines.RemoveAt(0);
            }
            return lines.ToArray();
        }
        catch
        {
            return Array.Empty<string>();
        }
    }
}

internal static class Selfcheck
{
    /// <summary>--selfcheck [appRoot]：无头打印解析结果（key=value），永远不弹 UI。
    /// 直接向标准输出流写 UTF-8 字节：WinExe 无控制台，Console.OutputEncoding 会
    /// 静默回退到 OEM 代码页（GBK），中文路径会变乱码。</summary>
    public static int Run(string[] args)
    {
        var appRootArg = args.Length > 1 ? args[^1] : null;
        var exeDir = AppContext.BaseDirectory;
        var appRoot = appRootArg ?? GuiCore.DetectAppRoot(exeDir);
        var dataRoot = GuiCore.ResolveDataRoot(
            appRoot,
            Environment.GetEnvironmentVariable("TOKENMETER_DATA_DIR"),
            Environment.GetEnvironmentVariable("LOCALAPPDATA"),
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            OperatingSystem.IsWindows());
        var (backendExe, backendArgs) = GuiCore.ResolveBackend(appRoot, exeDir, File.Exists);
        var report =
            $"appRoot={(appRoot ?? "(null)")}\n" +
            $"dataRoot={dataRoot}\n" +
            $"logPath={GuiCore.LogPathFor(dataRoot)}\n" +
            $"settingsPath={GuiCore.SettingsPathFor(dataRoot)}\n" +
            $"backendExe={(string.IsNullOrEmpty(backendExe) ? "(not found)" : backendExe)}\n" +
            $"backendArgsTemplate={backendArgs}\n" +
            $"ok={!string.IsNullOrEmpty(backendExe)}\n";
        using var stdout = Console.OpenStandardOutput();
        stdout.Write(Encoding.UTF8.GetBytes(report));
        return string.IsNullOrEmpty(backendExe) ? 2 : 0;
    }
}

/// <summary>主窗口：端口设置 + 启动/停止 + 状态 + 日志 tail。</summary>
internal sealed class MainForm : Form
{
    private readonly Mutex _mutex;
    private readonly string _dataRoot;
    private readonly string _settingsPath;
    private readonly string _logPath;
    private readonly string _backendExe;
    private readonly string _backendArgsTemplate;

    private Process? _backend;
    private bool _externalOnline;
    private bool _pollInFlight;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromMilliseconds(1500) };

    private readonly TextBox _portBox = new();
    private readonly Label _statusLabel = new() { AutoSize = true, Padding = new Padding(0, 8, 0, 0) };
    private readonly TextBox _logBox = new()
    {
        Multiline = true,
        ReadOnly = true,
        ScrollBars = ScrollBars.Vertical,
        Dock = DockStyle.Fill,
        Font = new Font("Consolas", 9f),
        WordWrap = false,
    };
    private readonly System.Windows.Forms.Timer _pollTimer = new() { Interval = 3000 };
    private readonly System.Windows.Forms.Timer _logTimer = new() { Interval = 2000 };

    public MainForm()
    {
        _mutex = new Mutex(initiallyOwned: true, GuiCore.MutexName, out var createdNew);
        if (!createdNew) { Load += (_, _) => Close(); }

        var exeDir = AppContext.BaseDirectory;
        var appRoot = GuiCore.DetectAppRoot(exeDir);
        _dataRoot = GuiCore.ResolveDataRoot(
            appRoot,
            Environment.GetEnvironmentVariable("TOKENMETER_DATA_DIR"),
            Environment.GetEnvironmentVariable("LOCALAPPDATA"),
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            OperatingSystem.IsWindows());
        _settingsPath = GuiCore.SettingsPathFor(_dataRoot);
        _logPath = GuiCore.LogPathFor(_dataRoot);
        (_backendExe, _backendArgsTemplate) = GuiCore.ResolveBackend(appRoot, exeDir, File.Exists);

        Text = "TokenMonitor 控制台";
        MinimumSize = new Size(640, 420);
        Size = new Size(760, 520);
        StartPosition = FormStartPosition.CenterScreen;

        var portLabel = new Label { Text = "端口：", AutoSize = true, Location = new Point(12, 12) };
        _portBox.Location = new Point(52, 9);
        _portBox.Width = 70;

        var saveButton = new Button { Text = "保存端口", Location = new Point(130, 7), AutoSize = true };
        saveButton.Click += (_, _) => ApplyPort();

        var startButton = new Button { Text = "启动", Location = new Point(220, 7), AutoSize = true };
        startButton.Click += (_, _) => StartBackend();

        var stopButton = new Button { Text = "停止", Location = new Point(295, 7), AutoSize = true };
        stopButton.Click += (_, _) => StopOwnBackend(userInitiated: true);

        var panelButton = new Button { Text = "打开面板", Location = new Point(370, 7), AutoSize = true };
        panelButton.Click += (_, _) => OpenPanel();

        _statusLabel.Location = new Point(12, 38);

        var logHeader = new Label { Text = "输出日志（最近 400 行，自动刷新）：", AutoSize = true, Location = new Point(12, 62) };
        _logBox.Location = new Point(12, 84);
        _logBox.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;

        Controls.AddRange(new Control[] { portLabel, _portBox, saveButton, startButton, stopButton, panelButton, _statusLabel, logHeader, _logBox });

        var saved = GuiCore.LoadPort(_settingsPath);
        _portBox.Text = saved.ToString();

        if (string.IsNullOrEmpty(_backendExe))
        {
            startButton.Enabled = false;
            MessageBox.Show(
                "未找到后端启动命令：需要 <应用根>\\runtime\\node.exe 与 runtime\\bin\\tokenwatcher.js（打包布局），\n" +
                "或同目录 node.exe + bin\\tokenwatcher.js（旧布局），或开发树（PATH 上的 node + 仓库 bin）。\n" +
                "仍可查看状态与日志。",
                "TokenMonitor", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        _pollTimer.Tick += (_, _) => _ = PollStatusAsync();
        _logTimer.Tick += (_, _) => RefreshLog();
        Load += (_, _) => { _pollTimer.Start(); _logTimer.Start(); RefreshLog(); _ = PollStatusAsync(); };
        FormClosed += (_, _) =>
        {
            _pollTimer.Stop();
            _logTimer.Stop();
            StopOwnBackend(userInitiated: false); // 与托盘一致：退出控制台只停自己拉起的后台
            try { _mutex.ReleaseMutex(); } catch { /* 释放失败不影响退出 */ }
        };
    }

    private int Port => GuiCore.TryParsePort(_portBox.Text, out var p) ? p : GuiCore.LoadPort(_settingsPath);

    private void ApplyPort()
    {
        if (!GuiCore.TryParsePort(_portBox.Text, out var port))
        {
            MessageBox.Show("端口必须是 1–65535 的整数。", "TokenMonitor", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            _portBox.Text = Port.ToString();
            return;
        }
        try { GuiCore.SavePort(_settingsPath, port); }
        catch (Exception ex) { MessageBox.Show($"保存设置失败：{ex.Message}", "TokenMonitor"); return; }

        if (IsOwnBackendAlive())
        {
            StopOwnBackend(userInitiated: true);
            StartBackend(); // 自己拉起的后台直接按新端口重启
        }
        else
        {
            UpdateStatus();
        }
    }

    private bool IsOwnBackendAlive()
    {
        try { return _backend is { HasExited: false }; }
        catch { return false; }
    }

    private void StartBackend()
    {
        if (IsOwnBackendAlive())
        {
            UpdateStatus();
            return;
        }
        if (_externalOnline)
        {
            MessageBox.Show($"端口 {Port} 已有后台在运行（非本程序启动）。为免误杀外部进程，这里不重复启动；如需换端口请先停止那个后台。",
                "TokenMonitor", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        if (string.IsNullOrEmpty(_backendExe)) return;
        try
        {
            var args = _backendArgsTemplate.Replace("{0}", Port.ToString());
            var psi = new ProcessStartInfo
            {
                FileName = _backendExe,
                Arguments = args,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(_backendExe) is { Length: > 0 } dir ? dir : AppContext.BaseDirectory,
            };
            _backend = Process.Start(psi);
            UpdateStatus();
            _ = PollStatusAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show($"启动后台失败：{ex.Message}\n（需要 runtime\\node.exe 与 runtime\\bin\\tokenwatcher.js；面板地址 http://127.0.0.1:{Port}）",
                "TokenMonitor", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>只停自己拉起的后台；外部启动的后台一律不碰。</summary>
    private void StopOwnBackend(bool userInitiated)
    {
        if (!IsOwnBackendAlive())
        {
            if (userInitiated)
            {
                if (_externalOnline)
                    MessageBox.Show($"当前后台不是本程序启动的（端口 {Port}），为免误杀外部进程这里不停止。",
                        "TokenMonitor", MessageBoxButtons.OK, MessageBoxIcon.Information);
                UpdateStatus();
            }
            return;
        }
        try
        {
            _backend!.Kill(entireProcessTree: true);
            _backend.WaitForExit(5000);
        }
        catch { /* 进程已退出即视为停止 */ }
        finally
        {
            _backend?.Dispose();
            _backend = null;
        }
        if (userInitiated) UpdateStatus();
    }

    private void OpenPanel()
    {
        try
        {
            Process.Start(new ProcessStartInfo($"http://127.0.0.1:{Port}") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            MessageBox.Show($"无法打开面板：{ex.Message}", "TokenMonitor");
        }
    }

    private async Task PollStatusAsync()
    {
        if (_pollInFlight) return;
        _pollInFlight = true;
        try
        {
            using var resp = await _http.GetAsync($"http://127.0.0.1:{Port}/api/status");
            _externalOnline = resp.StatusCode == System.Net.HttpStatusCode.OK;
        }
        catch
        {
            _externalOnline = false;
        }
        finally
        {
            _pollInFlight = false;
        }
        UpdateStatus();
    }

    private void UpdateStatus()
    {
        var state = IsOwnBackendAlive() ? $"运行中（本程序启动，PID {_backend!.Id}）"
            : _externalOnline ? "运行中（外部启动）"
            : "已停止";
        _statusLabel.Text = $"状态：{state}    面板：http://127.0.0.1:{Port}    数据：{_dataRoot}";
    }

    private void RefreshLog()
    {
        var lines = GuiCore.TailFile(_logPath, GuiCore.TailLines);
        if (lines.Length == 0) return;
        var atBottom = _logBox.TextLength == 0
            || _logBox.GetFirstCharIndexOfCurrentLine() >= _logBox.TextLength - 2
            || !_logBox.ScrollBars.HasFlag(ScrollBars.Vertical);
        var text = string.Join(Environment.NewLine, lines);
        if (text == _logBox.Text) return;
        _logBox.Text = text;
        _logBox.SelectionStart = _logBox.TextLength;
        _logBox.ScrollToCaret();
    }
}
