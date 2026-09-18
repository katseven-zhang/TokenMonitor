//! TokenMonitor 图形启动器（#24 Win-GUI；#28 去 .NET 化，Rust 原生 Win32 重写）。
//!
//! 启动/停止后台、端口设置（持久化）、运行状态与输出日志查看。
//! 只通过 127.0.0.1 HTTP（/api/status）感知后台，绝不读数据库内容；
//! 停止只作用于本程序自己拉起的后端进程，绝不误杀外部 node.exe。
//!
//! 单实例判定只在 main 一处（命名互斥锁）——#26 的教训：同进程内第二次
//! 创建同名互斥锁 createdNew 必为 false，会把自己误判成第二实例。
//!
//! 目标 Win10/11 x64 零额外依赖：运行期只链接系统自带的
//! user32/gdi32/kernel32/ws2_32 等；体积约几百 KB。

#![windows_subsystem = "windows"]

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND};
use windows_sys::Win32::Graphics::Gdi::{GetStockObject, DEFAULT_GUI_FONT};
use windows_sys::Win32::Networking::WinSock as ws;
use windows_sys::Win32::System::LibraryLoader::{GetModuleFileNameW, GetModuleHandleW};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, CreateProcessW, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
    PROCESS_INFORMATION, STARTUPINFOW,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowTextLengthW,
    GetWindowTextW, KillTimer, LoadCursorW, MessageBoxW, PostQuitMessage, RegisterClassExW,
    SetTimer, SetWindowTextW, ShowWindow, TranslateMessage, CW_USEDEFAULT, MB_ICONERROR,
    MB_ICONINFORMATION, MB_ICONWARNING, MB_OK, WM_COMMAND, WM_CREATE, WM_DESTROY, WM_SETFONT,
    WM_TIMER, WNDCLASSEXW, WS_BORDER, WS_CHILD, WS_VISIBLE, WS_VSCROLL,
};

const EM_SETSEL: u32 = 0x00B1;
const EM_SCROLLCARET: u32 = 0x00B7;
const ES_MULTILINE: u32 = 0x0004;

// ---------------------------------------------------------------------------
// 纯逻辑：路径解析 / 校验 / 设置读写 / 日志 tail
// ---------------------------------------------------------------------------

pub const MUTEX_NAME: &str = "Local\\TokenMonitorGui";
pub const SETTINGS_FILE: &str = "gui-settings.json";
pub const LOG_FILE: &str = "tokenmonitor.log";
pub const DEFAULT_PORT: u32 = 8787;
pub const TAIL_LINES: usize = 400;

pub fn parse_port(text: &str) -> Option<u32> {
    match text.trim().parse::<u32>() {
        Ok(p) if (1..=65535).contains(&p) => Some(p),
        _ => None,
    }
}

/// 应用根检测：向上最多 max_up 层找带 TokenMonitor/windows 标记的 manifest.json
/// （宽松标记匹配；构建清单由本仓库脚本生成）。仓库源码运行没有该清单 → None。
pub fn detect_app_root(start: &Path, max_up: usize) -> Option<PathBuf> {
    let mut cur = Some(start.to_path_buf());
    for _ in 0..=max_up {
        let dir = cur.clone()?;
        let marker = dir.join("manifest.json");
        if let Ok(text) = std::fs::read_to_string(&marker) {
            let t = text.as_str();
            if t.contains("\"name\"")
                && t.contains("TokenMonitor")
                && t.contains("\"os\"")
                && t.contains("windows")
            {
                return Some(dir);
            }
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
    None
}

/// 数据根：TOKENMONITOR_DATA_DIR > 打包形态 <根>\data > 源码默认 %LOCALAPPDATA%\TokenMonitor。
pub fn resolve_data_root(
    app_root: Option<&Path>,
    env_data_dir: Option<&str>,
    local_app_data: Option<&str>,
    home: &str,
    is_windows: bool,
) -> PathBuf {
    if let Some(d) = env_data_dir {
        if !d.trim().is_empty() {
            return PathBuf::from(d);
        }
    }
    if let Some(root) = app_root {
        return root.join("data");
    }
    if is_windows {
        if let Some(la) = local_app_data {
            if !la.trim().is_empty() {
                return Path::new(la).join("TokenMonitor").to_path_buf();
            }
        }
    }
    Path::new(home).join(".tokenmonitor")
}

/// 后端命令：新布局 runtime\node.exe → 旧扁平布局同目录 node.exe → 开发树（PATH node + 仓库 bin）。
/// CLI 脚本名统一为 tokenmonitor.js。
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
    // 开发树：publish 在 windows\gui\publish（上 3 级）或 target\release（上 2 级）
    let mut cur = Some(exe_dir.to_path_buf());
    for _ in 0..5 {
        let dir = cur.clone()?;
        let script = dir.join("bin").join(SCRIPT_NAME);
        if script.is_file() {
            return Some((PathBuf::from("node"), script));
        }
        cur = dir.parent().map(|p| p.to_path_buf());
    }
    None
}

pub fn log_path_for(data_root: &Path) -> PathBuf {
    data_root.join("logs").join(LOG_FILE)
}

pub fn settings_path_for(data_root: &Path) -> PathBuf {
    data_root.join(SETTINGS_FILE)
}

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

pub fn save_port(settings_path: &Path, port: u32) -> std::io::Result<()> {
    if let Some(dir) = settings_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(settings_path, format!("{{\n  \"port\": {port}\n}}"))
}

/// 读取日志末尾若干行；文件被写入方占用也允许读（FILE_SHARE_READ|WRITE|DELETE）。
pub fn tail_file(path: &Path, max_lines: usize) -> Vec<String> {
    let Ok(mut f) = OpenOptions::new().read(true).share_mode(0x7).open(path) else {
        return Vec::new();
    };
    const MAX_BYTES: u64 = 1_000_000;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let truncated = len > MAX_BYTES;
    if truncated {
        let _ = f.seek(SeekFrom::End(-(MAX_BYTES as i64)));
    }
    let mut buf = String::new();
    if f.read_to_string(&mut buf).is_err() {
        return Vec::new();
    }
    let mut lines: Vec<String> = buf
        .lines()
        .skip(if truncated { 1 } else { 0 })
        .map(|s| s.to_string())
        .collect();
    if lines.len() > max_lines {
        lines.drain(..lines.len() - max_lines);
    }
    lines
}

// ---------------------------------------------------------------------------
// 无头自检：打印路径解析结果（key=value，Rust 原生 UTF-8 输出）
// ---------------------------------------------------------------------------

fn selfcheck(app_root_arg: Option<&str>) -> i32 {
    let exe_dir = current_exe_dir();
    let app_root = match app_root_arg {
        Some(p) => Some(PathBuf::from(p)),
        None => detect_app_root(&exe_dir, 2),
    };
    let data_root = resolve_data_root(
        app_root.as_deref(),
        std::env::var("TOKENMONITOR_DATA_DIR").ok().as_deref(),
        std::env::var("LOCALAPPDATA").ok().as_deref(),
        &std::env::var("USERPROFILE").unwrap_or_default(),
        cfg!(windows),
    );
    let backend = resolve_backend(app_root.as_deref(), &exe_dir);
    let backend_text = match &backend {
        Some((exe, script)) => format!("{} \"{}\" serve --port {{0}}", exe.display(), script.display()),
        None => "(not found)".to_string(),
    };
    println!(
        "appRoot={}",
        app_root.as_deref().map_or_else(|| "(null)".to_string(), |p| p.display().to_string())
    );
    println!("dataRoot={}", data_root.display());
    println!("logPath={}", log_path_for(&data_root).display());
    println!("settingsPath={}", settings_path_for(&data_root).display());
    println!(
        "backendExe={}",
        backend.as_ref().map_or_else(|| "(not found)".to_string(), |(e, _)| e.display().to_string())
    );
    println!("backendArgsTemplate={backend_text}");
    println!("ok={}", backend.is_some());
    if backend.is_some() { 0 } else { 2 }
}

fn current_exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

// ---------------------------------------------------------------------------
// Win32 薄封装
// ---------------------------------------------------------------------------

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    String::from_utf16_lossy(buf)
}

/// 对 127.0.0.1:port 发最小 GET /api/status，返回是否拿到 200。
fn http_status_ok(port: u16) -> bool {
    unsafe {
        let mut wsa: ws::WSADATA = std::mem::zeroed();
        if ws::WSAStartup(0x202, &mut wsa) != 0 {
            return false;
        }
        let ok = probe_once(port);
        ws::WSACleanup();
        ok
    }
}

unsafe fn probe_once(port: u16) -> bool {
    let sock = ws::socket(ws::AF_INET as i32, ws::SOCK_STREAM, 0);
    if sock == ws::INVALID_SOCKET {
        return false;
    }
    let mut addr: ws::SOCKADDR_IN = std::mem::zeroed();
    addr.sin_family = ws::AF_INET;
    addr.sin_port = ws::htons(port);
    addr.sin_addr.S_un.S_addr = ws::htonl(0x7F00_0001); // 127.0.0.1
    let ok = ws::connect(
        sock,
        &addr as *const ws::SOCKADDR_IN as *const ws::SOCKADDR,
        std::mem::size_of::<ws::SOCKADDR_IN>() as i32,
    ) == 0
        && {
            let req = format!("GET /api/status HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
            ws::send(sock, req.as_ptr(), req.len() as i32, 0) > 0 && {
                let mut buf = [0u8; 64];
                let n = ws::recv(sock, buf.as_mut_ptr(), buf.len() as i32, 0);
                n > 0 && String::from_utf8_lossy(&buf[..n as usize]).contains(" 200 ")
            }
        };
    ws::closesocket(sock);
    ok
}

fn msg_box(hwnd: HWND, text: &str, icon: u32) {
    unsafe {
        MessageBoxW(hwnd, wide(text).as_ptr(), wide("TokenMonitor").as_ptr(), MB_OK | icon);
    }
}

fn is_handle_signaled(h: HANDLE) -> Option<bool> {
    unsafe {
        match WaitForSingleObject(h, 0) {
            0 => Some(true),
            0x102 => Some(false), // WAIT_TIMEOUT：仍在运行
            _ => None,
        }
    }
}

// 控件 ID
const ID_PORT: isize = 101;
const ID_SAVE: isize = 102;
const ID_START: isize = 103;
const ID_STOP: isize = 104;
const ID_PANEL: isize = 105;
const ID_LOG: isize = 106;
const ID_STATUS: isize = 107;
const TIMER_ID: usize = 1;

struct App {
    hwnd: HWND,
    port_edit: HWND,
    status_label: HWND,
    log_box: HWND,
    data_root: PathBuf,
    settings_path: PathBuf,
    log_path: PathBuf,
    backend: Option<(HANDLE, u32)>, // 只管理自己拉起的进程
    backend_exe: Option<PathBuf>,
    backend_script: Option<PathBuf>,
    external_online: bool,
}

// 单 GUI 线程；HWND 非 Send 只是保守标注，窗口句柄只在本线程使用
unsafe impl Send for App {}

static APP: std::sync::Mutex<Option<App>> = std::sync::Mutex::new(None);

fn with_app<R>(f: impl FnOnce(&mut App) -> R) -> Option<R> {
    APP.lock().ok().and_then(|mut g| g.as_mut().map(f))
}

impl App {
    fn port(&self) -> u32 {
        let text = self.get_text(self.port_edit);
        parse_port(&text).unwrap_or_else(|| load_port(&self.settings_path))
    }

    fn get_text(&self, hwnd: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            let mut buf = vec![0u16; len as usize + 1];
            GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
            from_wide(&buf[..len as usize])
        }
    }

    fn set_text(&self, hwnd: HWND, text: &str) {
        unsafe { SetWindowTextW(hwnd, wide(text).as_ptr()) };
    }

    fn own_backend_alive(&self) -> bool {
        match self.backend {
            Some((h, _)) => is_handle_signaled(h) == Some(false),
            None => false,
        }
    }

    fn start_backend(&mut self) {
        if self.own_backend_alive() {
            self.update_status();
            return;
        }
        if self.external_online {
            msg_box(
                self.hwnd,
                &format!(
                    "端口 {} 已有后台在运行（非本程序启动）。为免误杀外部进程，这里不重复启动；如需换端口请先停止那个后台。",
                    self.port()
                ),
                MB_ICONINFORMATION,
            );
            return;
        }
        let (Some(exe), Some(script)) = (self.backend_exe.clone(), self.backend_script.clone()) else {
            return;
        };
        let args = format!("\"{}\" serve --port {}", script.display(), self.port());
        let cwd = exe.parent().map(|p| p.to_path_buf()).unwrap_or_else(current_exe_dir);
        let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let mut cmd = wide(&format!("\"{}\" {args}", exe.display()));
        let mut exe_w = wide(&exe.display().to_string());
        let cwd_w = wide(&cwd.display().to_string());
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
            let err = unsafe { GetLastError() };
            msg_box(
                self.hwnd,
                &format!(
                    "启动后台失败（错误 {err}）\n（需要 runtime\\node.exe 与 runtime\\bin\\tokenmonitor.js；面板地址 http://127.0.0.1:{}）",
                    self.port()
                ),
                MB_ICONERROR,
            );
            return;
        }
        self.backend = Some((pi.hProcess, pi.dwProcessId));
        unsafe { CloseHandle(pi.hThread) };
        self.update_status();
    }

    /// 只停自己拉起的后台；外部启动的一律不碰。
    fn stop_own_backend(&mut self, user_initiated: bool) {
        if !self.own_backend_alive() {
            if user_initiated {
                if self.external_online {
                    msg_box(
                        self.hwnd,
                        &format!(
                            "当前后台不是本程序启动的（端口 {}），为免误杀外部进程这里不停止。",
                            self.port()
                        ),
                        MB_ICONINFORMATION,
                    );
                }
                self.update_status();
            }
            return;
        }
        if let Some((h, _)) = self.backend {
            unsafe {
                TerminateProcess(h, 1);
                WaitForSingleObject(h, 5000);
                CloseHandle(h);
            }
        }
        self.backend = None;
        if user_initiated {
            self.update_status();
        }
    }

    fn open_panel(&self) {
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                wide("open").as_ptr(),
                wide(&format!("http://127.0.0.1:{}", self.port())).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1, // SW_SHOWNORMAL
            );
        }
    }

    fn apply_port(&mut self) {
        let text = self.get_text(self.port_edit);
        let Some(port) = parse_port(&text) else {
            msg_box(self.hwnd, "端口必须是 1-65535 的整数。", MB_ICONWARNING);
            self.set_text(self.port_edit, &self.port().to_string());
            return;
        };
        if let Err(e) = save_port(&self.settings_path, port) {
            msg_box(self.hwnd, &format!("保存设置失败：{e}"), MB_ICONERROR);
            return;
        }
        if self.own_backend_alive() {
            self.stop_own_backend(true);
            self.start_backend(); // 自己拉起的后台直接按新端口重启
        } else {
            self.update_status();
        }
    }

    fn update_status(&mut self) {
        let state = if self.own_backend_alive() {
            format!("运行中（本程序启动，PID {}）", self.backend.map(|(_, pid)| pid).unwrap_or(0))
        } else if self.external_online {
            "运行中（外部启动）".to_string()
        } else {
            "已停止".to_string()
        };
        self.set_text(
            self.status_label,
            &format!(
                "状态：{state}    面板：http://127.0.0.1:{}    数据：{}",
                self.port(),
                self.data_root.display()
            ),
        );
    }

    fn refresh_log(&mut self) {
        let lines = tail_file(&self.log_path, TAIL_LINES);
        if lines.is_empty() {
            return;
        }
        self.set_text(self.log_box, &lines.join("\r\n"));
        unsafe {
            SendMessageW(self.log_box, EM_SETSEL, u32::MAX as usize, 0);
            SendMessageW(self.log_box, EM_SCROLLCARET, 0, 0);
        }
    }

    fn poll_status(&mut self) {
        self.external_online = http_status_ok(self.port() as u16);
        self.update_status();
    }
}

use windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW;

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: usize, lparam: isize) -> isize {
    match msg {
        WM_CREATE => {
            let exe_dir = current_exe_dir();
            let app_root = detect_app_root(&exe_dir, 2);
            let data_root = resolve_data_root(
                app_root.as_deref(),
                std::env::var("TOKENMONITOR_DATA_DIR").ok().as_deref(),
                std::env::var("LOCALAPPDATA").ok().as_deref(),
                &std::env::var("USERPROFILE").unwrap_or_default(),
                cfg!(windows),
            );
            let settings_path = settings_path_for(&data_root);
            let log_path = log_path_for(&data_root);
            let resolved = resolve_backend(app_root.as_deref(), &exe_dir);
            *APP.lock().unwrap() = Some(App {
                hwnd,
                port_edit: std::ptr::null_mut(),
                status_label: std::ptr::null_mut(),
                log_box: std::ptr::null_mut(),
                data_root,
                settings_path,
                log_path,
                backend: None,
                backend_exe: resolved.as_ref().map(|(e, _)| e.clone()),
                backend_script: resolved.as_ref().map(|(_, s)| s.clone()),
                external_online: false,
            });

            let hinstance = GetModuleHandleW(std::ptr::null());
            let font = GetStockObject(DEFAULT_GUI_FONT);
            let edit: Vec<u16> = wide("EDIT");
            let button: Vec<u16> = wide("BUTTON");
            let class_static: Vec<u16> = wide("STATIC");
            let mut mk = |id: isize, class: &[u16], text: &str, style: u32, x: i32, y: i32, w: i32, h: i32| -> HWND {
                unsafe {
                    CreateWindowExW(
                        0,
                        class.as_ptr(),
                        wide(text).as_ptr(),
                        style,
                        x,
                        y,
                        w,
                        h,
                        hwnd,
                        id as *mut core::ffi::c_void,
                        hinstance,
                        std::ptr::null(),
                    )
                }
            };
            let child = WS_CHILD | WS_VISIBLE;
            let port_edit = mk(ID_PORT, &edit, "", child | WS_BORDER, 52, 9, 70, 24);
            mk(ID_SAVE, &button, "保存端口", child, 130, 7, 80, 26);
            mk(ID_START, &button, "启动", child, 220, 7, 66, 26);
            mk(ID_STOP, &button, "停止", child, 292, 7, 66, 26);
            mk(ID_PANEL, &button, "打开面板", child, 364, 7, 90, 26);
            let status_label = mk(ID_STATUS, &class_static, "状态：检测中…", child, 12, 40, 720, 20);
            mk(0, &class_static, "输出日志（最近 400 行，自动刷新）：", child, 12, 64, 400, 18);
            let log_box = mk(
                ID_LOG,
                &edit,
                "",
                child | WS_VSCROLL | WS_BORDER | ES_MULTILINE,
                12,
                86,
                720,
                380,
            );
            for h in [port_edit, status_label, log_box] {
                SendMessageW(h, WM_SETFONT, font as usize, 1);
            }
            if let Some(saved) = with_app(|a| {
                a.port_edit = port_edit;
                a.status_label = status_label;
                a.log_box = log_box;
                load_port(&a.settings_path).to_string()
            }) {
                SetWindowTextW(port_edit, wide(&saved).as_ptr());
            }
            let backend_missing = with_app(|a| a.backend_exe.is_none()).unwrap_or(false);
            if backend_missing {
                let text = "未找到后端启动命令：需要 <应用根>\\runtime\\node.exe 与 runtime\\bin\\tokenmonitor.js（打包布局），\n或同目录 node.exe + bin\\tokenmonitor.js，或开发树（PATH 上的 node + 仓库 bin）。\n仍可查看状态与日志。";
                MessageBoxW(hwnd, wide(text).as_ptr(), wide("TokenMonitor").as_ptr(), MB_OK | MB_ICONWARNING);
            }
            SetTimer(hwnd, TIMER_ID, 2000, None);
            0
        }
        WM_TIMER => {
            with_app(|a| {
                a.refresh_log();
                a.poll_status();
            });
            0
        }
        WM_COMMAND => {
            let id = (wparam & 0xffff) as isize;
            with_app(|a| match id {
                ID_SAVE => a.apply_port(),
                ID_START => a.start_backend(),
                ID_STOP => a.stop_own_backend(true),
                ID_PANEL => a.open_panel(),
                _ => {}
            });
            0
        }
        WM_DESTROY => {
            with_app(|a| a.stop_own_backend(false)); // 与托盘一致：退出只停自己拉起的后台
            KillTimer(hwnd, TIMER_ID);
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn run_gui() {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let class_name = wide("TokenMonitorGuiWnd");
        let mut wc: WNDCLASSEXW = std::mem::zeroed();
        wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
        wc.lpfnWndProc = Some(wnd_proc);
        wc.hInstance = hinstance;
        wc.hCursor = LoadCursorW(std::ptr::null_mut(), 32512 as *const u16); // IDC_ARROW (MAKEINTRESOURCE)
        wc.lpszClassName = class_name.as_ptr();
        if RegisterClassExW(&wc) == 0 {
            return;
        }
        let title = wide("TokenMonitor 控制台");
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            0x00CF_0000, // WS_OVERLAPPEDWINDOW
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            760,
            520,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return;
        }
        ShowWindow(hwnd, 1); // SW_SHOWNORMAL
        let mut msg: windows_sys::Win32::UI::WindowsAndMessaging::MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selfcheck" || a == "-selfcheck") {
        std::process::exit(selfcheck(args.get(2).map(|s| s.as_str())));
    }

    // 单实例：判定只在入口这一处；绝不能在窗口构造里再创建同名互斥锁
    //（#26：同进程二次创建 createdNew 必为 false → 误判第二实例 → 窗体自闭）
    unsafe {
        CreateMutexW(std::ptr::null(), 1, wide(MUTEX_NAME).as_ptr());
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return;
        }
    }
    run_gui();
}

// GetModuleFileNameW 保留给后续诊断扩展使用（当前 selfcheck 走 current_exe()）
#[allow(dead_code)]
fn exe_dir_fallback() -> PathBuf {
    unsafe {
        let mut buf = [0u16; 1024];
        let n = GetModuleFileNameW(std::ptr::null_mut(), buf.as_mut_ptr(), buf.len() as u32);
        PathBuf::from(from_wide(&buf[..n as usize]))
    }
}
