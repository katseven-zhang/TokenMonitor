//! TokenMonitor 系统托盘（#32：Rust + windows-sys 原生 Win32 重写，对齐契约 v3 §2）。
//!
//! 功能对齐旧 .NET 版：托盘图标（运行/停止两态，运行时绘制实心圆）、单实例
//! （命名互斥 Local\TokenMonitorTray，与 .NET 版同名避免升级后双开）、约 5s
//! 轮询 /api/status 切换图标与菜单标签、菜单（打开面板 / 启动或重启后台 /
//! 退出托盘）、只管理自己拉起的后台、探测有独立 connect/读写超时（#30 同款
//! 非阻塞方案，总量 ≤1.5s）。目标 Win10/11 x64 零额外依赖、exe ≤2MB。
//!
//! CLI 兼容：--port N 覆盖端口（旧版/测试依赖）；--selfcheck / --probe 无头
//! 模式供行为测试，不进消息循环。

#![windows_subsystem = "windows"]

use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Networking::WinSock as ws;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{
    CreateMutexW, CreateProcessW, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
    PROCESS_INFORMATION, STARTUPINFOW,
};
use windows_sys::Win32::UI::Shell::{ShellExecuteW, Shell_NotifyIconW, NOTIFYICONDATAW};
use windows_sys::Win32::UI::WindowsAndMessaging as wm;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIcon, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DispatchMessageW,
    DestroyMenu, GetMessageW, GetCursorPos, LoadCursorW, MessageBoxW, ModifyMenuW, PostQuitMessage,
    RegisterClassExW, SetForegroundWindow, SetTimer, TrackPopupMenu, TranslateMessage, HICON,
    HMENU, MSG,
};

use wm::{DestroyWindow, MB_ICONWARNING, MB_OK};

// ---------------------------------------------------------------------------
// 常量与纯逻辑：端口/数据根/设置
// ---------------------------------------------------------------------------

pub const MUTEX_NAME: &str = "Local\\TokenMonitorTray";
pub const DEFAULT_PORT: u32 = 8787;
pub const POLL_INTERVAL_MS: u32 = 5000; // 约 5s 轮询（对齐 .NET 版 Timer.Interval=5000）
pub const PROBE_CONNECT_TIMEOUT_MS: u32 = 700;
pub const PROBE_IO_TIMEOUT_MS: u32 = 700; // 探测总预算 ≤1.5s
pub const SETTINGS_FILE: &str = "gui-settings.json"; // 与 GUI 共享同一设置

const WM_TRAY_CALLBACK: u32 = 0x0400 + 100; // NIF_MESSAGE 回调（WM_USER+100）
const WM_APP_POLL: u32 = 0x8001; // 轮询/状态刷新（PostMessage/SendMessage 均可）
const IDM_PANEL: usize = 2001;
const IDM_RESTART: usize = 2002;
const IDM_EXIT: usize = 2003;
const NIM_ADD: u32 = 0;
const NIM_MODIFY: u32 = 1;
const NIM_DELETE: u32 = 2;

pub fn parse_port(text: &str) -> Option<u32> {
    match text.trim().parse::<u32>() {
        Ok(p) if (1..=65535).contains(&p) => Some(p),
        _ => None,
    }
}

/// 数据根：TOKENMONITOR_DATA_DIR > 打包形态 <根>\data（manifest 标记）> %LOCALAPPDATA%\TokenMonitor。
/// 与 GUI 启动器/后端的解析同构（同一份 gui-settings.json）。
pub fn resolve_data_root(
    app_root: Option<&Path>,
    env_data_dir: Option<&str>,
    local_app_data: Option<&str>,
) -> PathBuf {
    if let Some(d) = env_data_dir {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    if let Some(root) = app_root {
        return root.join("data");
    }
    if let Some(la) = local_app_data {
        if !la.trim().is_empty() {
            return Path::new(la).join("TokenMonitor").to_path_buf();
        }
    }
    PathBuf::from(".")
}

/// 应用根检测：向上最多 max_up 层找带 TokenMonitor/windows 标记的 manifest.json
pub fn detect_app_root(start: &Path, max_up: usize) -> Option<PathBuf> {
    let mut cur = Some(start.to_path_buf());
    for _ in 0..=max_up {
        let dir = cur.clone()?;
        if let Ok(text) = std::fs::read_to_string(dir.join("manifest.json")) {
            let t = text.as_str();
            if t.contains("\"name\"") && t.contains("TokenMonitor") && t.contains("\"os\"") && t.contains("windows") {
                return Some(dir);
            }
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
    None
}

/// 已保存端口（与 GUI 共享 gui-settings.json；解析失败回落 8787）
pub fn load_port(settings_path: &Path) -> u32 {
    std::fs::read_to_string(settings_path)
        .ok()
        .and_then(|text| {
            text.split("\"port\"")
                .nth(1)
                .and_then(|rest| {
                    let digits: String = rest
                        .chars()
                        .skip_while(|c| !c.is_ascii_digit())
                        .take_while(|c| c.is_ascii_digit())
                        .collect();
                    digits.parse::<u32>().ok()
                })
                .filter(|p| (1..=65535).contains(p))
        })
        .unwrap_or(DEFAULT_PORT)
}

/// 后端命令解析：新布局 runtime\node.exe → 旧扁平 → 开发树（与 GUI 同构）
pub fn resolve_backend(app_root: Option<&Path>, exe_dir: &Path) -> Option<(PathBuf, PathBuf)> {
    const SCRIPT_NAME: &str = "tokenmonitor.js";
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(r) = app_root {
        roots.push(r.to_path_buf());
    }
    roots.push(exe_dir.to_path_buf());
    for root in &roots {
        let node = root.join("runtime").join("node.exe");
        let script = root.join("runtime").join("bin").join(SCRIPT_NAME);
        if node.is_file() && script.is_file() {
            return Some((node, script));
        }
        let node = root.join("node.exe");
        let script = root.join("bin").join(SCRIPT_NAME);
        if node.is_file() && script.is_file() {
            return Some((node, script));
        }
    }
    let mut cur = Some(exe_dir.to_path_buf());
    for _ in 0..5 {
        let dir = cur.clone()?;
        if dir.join("bin").join(SCRIPT_NAME).is_file() {
            return Some((PathBuf::from("node"), dir.join("bin").join(SCRIPT_NAME)));
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
    None
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------------------------------------------------------------------------
// 探测（独立 connect/读写超时；#30 同款非阻塞方案）
// ---------------------------------------------------------------------------

static WSA_STARTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn ensure_wsa_started() -> bool {
    *WSA_STARTED.get_or_init(|| unsafe {
        let mut wsa: ws::WSADATA = std::mem::zeroed();
        ws::WSAStartup(0x202, &mut wsa) == 0
    })
}

/// 对 127.0.0.1:port 发最小 GET /api/status，返回是否拿到 200。
pub fn http_status_ok(port: u16) -> bool {
    if !ensure_wsa_started() {
        return false;
    }
    unsafe {
        let sock = ws::socket(ws::AF_INET as i32, ws::SOCK_STREAM, 0);
        if sock == ws::INVALID_SOCKET {
            return false;
        }
        let ok = probe_once_inner(sock, port);
        ws::closesocket(sock);
        ok
    }
}

unsafe fn probe_once_inner(sock: usize, port: u16) -> bool {
    let mut nonblocking: u32 = 1;
    if ws::ioctlsocket(sock, ws::FIONBIO, &mut nonblocking) != 0 {
        return false;
    }
    let mut addr: ws::SOCKADDR_IN = std::mem::zeroed();
    addr.sin_family = ws::AF_INET;
    addr.sin_port = ws::htons(port);
    addr.sin_addr.S_un.S_addr = ws::htonl(0x7F00_0001);
    if ws::connect(
        sock,
        &addr as *const ws::SOCKADDR_IN as *const ws::SOCKADDR,
        std::mem::size_of::<ws::SOCKADDR_IN>() as i32,
    ) != 0
    {
        if ws::WSAGetLastError() != ws::WSAEWOULDBLOCK {
            return false;
        }
        let mut wfd: ws::FD_SET = std::mem::zeroed();
        let mut efd: ws::FD_SET = std::mem::zeroed();
        wfd.fd_count = 1;
        wfd.fd_array[0] = sock;
        efd.fd_count = 1;
        efd.fd_array[0] = sock;
        let mut tv = ws::TIMEVAL {
            tv_sec: (PROBE_CONNECT_TIMEOUT_MS / 1000) as i32,
            tv_usec: ((PROBE_CONNECT_TIMEOUT_MS % 1000) * 1000) as i32,
        };
        let n = ws::select(0, std::ptr::null_mut(), &mut wfd, &mut efd, &mut tv);
        if n <= 0 || efd.fd_count > 0 || wfd.fd_count == 0 {
            return false; // 超时/被拒：按不可达（DROP SYN 环境的超时兜底语义）
        }
        let mut serr: i32 = 0;
        let mut slen = std::mem::size_of::<i32>() as i32;
        if ws::getsockopt(sock, ws::SOL_SOCKET as i32, ws::SO_ERROR as i32, &mut serr as *mut i32 as *mut u8, &mut slen) != 0
            || serr != 0
        {
            return false;
        }
    }
    // 非阻塞 socket 上 SO_RCVTIMEO 不生效：连接建立后切回阻塞（#30 实测踩坑）
    let mut blocking: u32 = 0;
    if ws::ioctlsocket(sock, ws::FIONBIO, &mut blocking) != 0 {
        return false;
    }
    let io_ms: u32 = PROBE_IO_TIMEOUT_MS;
    if ws::setsockopt(sock, ws::SOL_SOCKET as i32, ws::SO_RCVTIMEO as i32, &io_ms as *const u32 as *const u8, 4) != 0
        || ws::setsockopt(sock, ws::SOL_SOCKET as i32, ws::SO_SNDTIMEO as i32, &io_ms as *const u32 as *const u8, 4) != 0
    {
        return false;
    }
    let req = format!("GET /api/status HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    if ws::send(sock, req.as_ptr(), req.len() as i32, 0) <= 0 {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = ws::recv(sock, buf.as_mut_ptr(), buf.len() as i32, 0);
    n > 0 && String::from_utf8_lossy(&buf[..n as usize]).contains(" 200 ")
}

fn current_exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

// ---------------------------------------------------------------------------
// 托盘状态（单 UI 线程；句柄/窗体句柄按 GUI 先例标注 Send）
// ---------------------------------------------------------------------------

struct TrayApp {
    saved_port: u32,
    /// --port 参数显式覆盖（旧 CLI 兼容；优先于 settings 文件）
    port_override: Option<u32>,
    backend: Option<(HANDLE, u32)>, // 只管理自己拉起的进程
    backend_exe: Option<PathBuf>,
    backend_script: Option<PathBuf>,
    external_online: bool,
    stopping: bool,
}

unsafe impl Send for TrayApp {}

impl TrayApp {
    fn port(&self) -> u32 {
        self.port_override.unwrap_or(self.saved_port)
    }

    fn own_backend_alive(&self) -> bool {
        match self.backend {
            Some((h, _)) => unsafe { WaitForSingleObject(h, 0) == 0x102 }, // TIMEOUT=仍在运行
            None => false,
        }
    }

    /// 发起 TerminateProcess；等待与回收移交分离线程（UI 线程不阻塞）
    fn stop_own_backend(&mut self) -> Option<HANDLE> {
        if self.stopping {
            return None;
        }
        let (h, _) = self.backend?;
        unsafe {
            TerminateProcess(h, 1);
        }
        self.backend = None;
        self.stopping = true;
        Some(h)
    }

    /// 释放已终止进程的句柄（reap；restart 语义由调用方在解锁后自行处理）
    fn reap_async(h: HANDLE) {
        let h_addr = h as isize;
        std::thread::spawn(move || unsafe {
            WaitForSingleObject(h_addr as HANDLE, 5000);
            CloseHandle(h_addr as HANDLE);
        });
    }

    fn start_backend(&mut self, notify: &mut dyn FnMut(&str, u32)) -> bool {
        if self.stopping {
            notify("停止流程仍在收尾，请稍后再试。", MB_ICONWARNING);
            return false;
        }
        if self.own_backend_alive() {
            return true;
        }
        let (Some(exe), Some(script)) = (self.backend_exe.clone(), self.backend_script.clone()) else {
            notify("未找到后端启动命令：需要 runtime\\node.exe 与 runtime\\bin\\tokenmonitor.js，或开发树 node + bin。", MB_ICONWARNING);
            return false;
        };
        let args = format!("\"{}\" serve --port {}", script.display(), self.port());
        let cwd = exe.parent().map(|p| p.to_path_buf());
        let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let mut cmd = wide(&format!("\"{}\" {args}", exe.display()));
        let mut exe_w = wide(&exe.display().to_string());
        let cwd_text = cwd.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| ".".into());
        let cwd_w = wide(&cwd_text);
        let ok = unsafe {
            CreateProcessW(
                exe_w.as_mut_ptr(),
                cmd.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_NO_WINDOW,
                std::ptr::null(),
                cwd_w.as_ptr(),
                &mut si,
                &mut pi,
            )
        };
        if ok == 0 {
            notify(&format!("启动后台失败（错误 {}）", unsafe { GetLastError() }), MB_ICONWARNING);
            return false;
        }
        self.backend = Some((pi.hProcess, pi.dwProcessId));
        unsafe { CloseHandle(pi.hThread) };
        true
    }
}

struct TrayState {
    ui_hwnd: HWND,
    hicon_run: HICON,
    hicon_stop: HICON,
    nid: NOTIFYICONDATAW,
    menu: HMENU,
    app: TrayApp,
}

unsafe impl Send for TrayState {}

static TRAY: std::sync::Mutex<Option<TrayState>> = std::sync::Mutex::new(None);

fn with_tray<R>(f: impl FnOnce(&mut TrayState) -> R) -> Option<R> {
    TRAY.lock().unwrap_or_else(|e| e.into_inner()).as_mut().map(f)
}

/// 轮询一次：探测状态 → 更新图标/提示/菜单标签
fn poll_once() {
    with_tray(|t| unsafe {
        let running_now = http_status_ok(t.app.port() as u16);
        let own = t.app.own_backend_alive();
        t.app.external_online = running_now && !own;
        let tip = if own {
            format!("TokenMonitor：运行中（托盘启动，端口 {}）", t.app.port())
        } else if t.app.external_online {
            format!("TokenMonitor：运行中（外部启动，端口 {}）", t.app.port())
        } else {
            format!("TokenMonitor：已停止（端口 {}）", t.app.port())
        };
        // 菜单标签三态（对齐 .NET 版 StartRestartLabel）
        let restart_label = if own {
            "重启后台"
        } else if t.app.external_online {
            "后台运行中（外部启动）"
        } else {
            "启动后台"
        };
        ModifyMenuW(t.menu, IDM_RESTART as u32, 0, IDM_RESTART as usize, wide(restart_label).as_ptr());
        let mut nid = t.nid;
        nid.hIcon = if running_now { t.hicon_run } else { t.hicon_stop };
        let tip_w = wide(&tip);
        nid.szTip[..tip_w.len().min(128)].copy_from_slice(&tip_w[..tip_w.len().min(128)]);
        Shell_NotifyIconW(NIM_MODIFY, &nid);
    });
}

fn open_panel(port: u32) {
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            wide("open").as_ptr(),
            wide(&format!("http://127.0.0.1:{port}")).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        );
    }
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_TRAY_CALLBACK {
        if lparam as u32 == 0x0205 {
            // WM_RBUTTONUP：弹菜单（SetForegroundWindow 是托盘菜单能消失的必要姿势）
            with_tray(|t| {
                SetForegroundWindow(t.ui_hwnd);
                let mut pt: POINT = std::mem::zeroed();
                GetCursorPos(&mut pt);
                TrackPopupMenu(t.menu, 0x22 /* TPM_RIGHTBUTTON|TPM_BOTTOMALIGN */, pt.x, pt.y, 0, t.ui_hwnd, std::ptr::null());
            });
        } else if lparam as u32 == 0x0203 {
            // WM_LBUTTONDBLCLK：打开面板
            with_tray(|t| open_panel(t.app.port()));
        }
        return 0;
    }
    match msg {
        WM_APP_POLL => {
            poll_once();
            0
        }
        wm::WM_COMMAND => {
            let id = wparam & 0xffff;
            match id {
                IDM_PANEL => {
                    with_tray(|t| open_panel(t.app.port()));
                }
                IDM_RESTART => {
                    with_tray(|t| {
                        if t.app.external_online && !t.app.own_backend_alive() {
                            MessageBoxW(
                                t.ui_hwnd,
                                wide("当前后台不是托盘启动的（外部启动），为免误杀这里不重启。").as_ptr(),
                                wide("TokenMonitor").as_ptr(),
                                MB_OK | MB_ICONWARNING,
                            );
                            return;
                        }
                        if t.app.own_backend_alive() {
                            if let Some(h) = t.app.stop_own_backend() {
                                TrayApp::reap_async(h);
                                t.app.stopping = false; // 已同步等待回收完成，解除停止态
                            }
                        }
                        t.app.start_backend(&mut |msg, icon| {
                            MessageBoxW(t.ui_hwnd, wide(msg).as_ptr(), wide("TokenMonitor").as_ptr(), MB_OK | icon);
                        });
                    });
                    poll_once(); // 立即刷新图标/菜单
                }
                IDM_EXIT => {
                    let h = with_tray(|t| {
                        t.ui_remove();
                        t.app.stop_own_backend()
                    })
                    .flatten();
                    if let Some(h) = h {
                        TrayApp::reap_async(h); // 进程即将退出：随进程消失无副作用
                    }
                    DestroyWindow(hwnd);
                }
                _ => {}
            }
            0
        }
        wm::WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

impl TrayState {
    /// 托盘图标移除（退出前调用，避免残留幽灵图标）
    fn ui_remove(&mut self) {
        unsafe {
            Shell_NotifyIconW(NIM_DELETE, &self.nid);
            DestroyMenu(self.menu);
        }
    }
}

/// 运行时绘制两态图标：16x16 32bpp 实心圆（运行=绿，停止=灰），无资源文件、exe ≤2MB
unsafe fn make_status_icon(hinstance: HINSTANCE, running: bool) -> HICON {
    let mut xor = [0u8; 16 * 16 * 4];
    for y in 0..16usize {
        for x in 0..16usize {
            let dx = x as i32 - 8;
            let dy = y as i32 - 8;
            if dx * dx + dy * dy <= 42 {
                let i = (y * 16 + x) * 4;
                let (b, g, r) = if running { (0x53, 0xd3, 0x39) } else { (0x6a, 0x55, 0x55) };
                xor[i] = b;
                xor[i + 1] = g;
                xor[i + 2] = r;
                xor[i + 3] = 0xff;
            }
        }
    }
    let and = [0u8; 32];
    CreateIcon(hinstance, 16, 16, 1, 32, and.as_ptr(), xor.as_ptr())
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

fn selfcheck() -> i32 {
    let exe_dir = current_exe_dir();
    let app_root = detect_app_root(&exe_dir, 2);
    let data_root = resolve_data_root(
        app_root.as_deref(),
        std::env::var("TOKENMONITOR_DATA_DIR").ok().as_deref(),
        std::env::var("LOCALAPPDATA").ok().as_deref(),
    );
    let port = std::env::args()
        .position(|a| a == "--port")
        .and_then(|i| std::env::args().nth(i + 1))
        .and_then(|s| parse_port(&s))
        .unwrap_or_else(|| load_port(&data_root.join(SETTINGS_FILE)));
    let backend = resolve_backend(app_root.as_deref(), &exe_dir);
    println!("dataRoot={}", data_root.display());
    println!("settingsPath={}", data_root.join(SETTINGS_FILE).display());
    println!("port={port}");
    println!(
        "backendExe={}",
        backend.as_ref().map_or_else(|| "(not found)".into(), |(e, _)| e.display().to_string())
    );
    println!("ok={}", backend.is_some());
    if backend.is_some() { 0 } else { 2 }
}

fn probe_headless(port: u16) -> i32 {
    let start = std::time::Instant::now();
    let ok = http_status_ok(port);
    println!("ok={} elapsed_ms={}", ok, start.elapsed().as_millis());
    if ok { 0 } else { 1 }
}

fn run_tray(port_override: Option<u32>) {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let exe_dir = current_exe_dir();
        let app_root = detect_app_root(&exe_dir, 2);
        let data_root = resolve_data_root(
            app_root.as_deref(),
            std::env::var("TOKENMONITOR_DATA_DIR").ok().as_deref(),
            std::env::var("LOCALAPPDATA").ok().as_deref(),
        );
        let settings_path = data_root.join(SETTINGS_FILE);
        let saved_port = load_port(&settings_path);
        let resolved = resolve_backend(app_root.as_deref(), &exe_dir);
        let backend_missing = resolved.is_none();

        let class_name = wide("TokenMonitorTrayWnd");
        let mut wc: wm::WNDCLASSEXW = std::mem::zeroed();
        wc.cbSize = std::mem::size_of::<wm::WNDCLASSEXW>() as u32;
        wc.lpfnWndProc = Some(wnd_proc);
        wc.hInstance = hinstance;
        wc.hCursor = LoadCursorW(std::ptr::null_mut(), 32512 as *const u16);
        wc.lpszClassName = class_name.as_ptr();
        if RegisterClassExW(&wc) == 0 {
            return;
        }
        // 隐藏消息窗口（托盘无可见窗体）
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            wide("TokenMonitorTray").as_ptr(),
            0,
            0, 0, 0, 0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return;
        }

        let hicon_run = make_status_icon(hinstance, true);
        let hicon_stop = make_status_icon(hinstance, false);
        let menu = CreatePopupMenu();
        AppendMenuW(menu, 0, IDM_PANEL, wide("打开面板").as_ptr());
        AppendMenuW(menu, 0, IDM_RESTART, wide("启动后台").as_ptr());
        AppendMenuW(menu, 0x800, 0, std::ptr::null()); // MF_SEPARATOR
        AppendMenuW(menu, 0, IDM_EXIT, wide("退出托盘").as_ptr());

        let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
        nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = hwnd;
        nid.uID = 1;
        nid.uFlags = 0x1 | 0x2 | 0x4; // NIF_MESSAGE | NIF_ICON | NIF_TIP
        nid.uCallbackMessage = WM_TRAY_CALLBACK;
        nid.hIcon = hicon_stop;
        let tip = wide("TokenMonitor：检测中…");
        nid.szTip[..tip.len().min(128)].copy_from_slice(&tip[..tip.len().min(128)]);
        Shell_NotifyIconW(NIM_ADD, &nid);

        let state = TrayState {
            ui_hwnd: hwnd,
            hicon_run,
            hicon_stop,
            nid,
            menu,
            app: TrayApp {
                saved_port,
                port_override,
                backend: None,
                backend_exe: resolved.as_ref().map(|(e, _)| e.clone()),
                backend_script: resolved.as_ref().map(|(_, s)| s.clone()),
                external_online: false,
                stopping: false,
            },
        };
        *TRAY.lock().unwrap() = Some(state);

        if backend_missing {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(800));
                MessageBoxW(
                    std::ptr::null_mut(),
                    wide("未找到后端启动命令：托盘将仅显示状态（打开面板/退出可用）。").as_ptr(),
                    wide("TokenMonitor").as_ptr(),
                    MB_OK | MB_ICONWARNING,
                );
            });
        }

        SetTimer(hwnd, 1, POLL_INTERVAL_MS, None);
        poll_once(); // 首轮立即轮询（不等 5s）

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selfcheck") {
        std::process::exit(selfcheck());
    }
    if args.iter().any(|a| a == "--probe") {
        let port = args
            .iter()
            .position(|a| a == "--probe")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| parse_port(s))
            .unwrap_or(DEFAULT_PORT);
        std::process::exit(probe_headless(port as u16));
    }
    let port_override = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| parse_port(s));

    // 单实例：与 .NET 版同名互斥，避免升级后双开
    unsafe {
        CreateMutexW(std::ptr::null(), 1, wide(MUTEX_NAME).as_ptr());
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return; // 第二实例静默退出
        }
    }
    run_tray(port_override);
}
