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

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    CreateFontW, CreateSolidBrush, DeleteObject, GetDC, GetDeviceCaps, InvalidateRect, ReleaseDC,
    SetBkColor, SetBkMode, SetTextColor, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
    DEFAULT_PITCH, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD, HBRUSH, HDC, HFONT, LOGPIXELSY,
    OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows_sys::Win32::Networking::WinSock as ws;
use windows_sys::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleW, GetProcAddress, LoadLibraryW,
};
use windows_sys::Win32::System::Threading::{
    CreateMutexW, CreateProcessW, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
    PROCESS_INFORMATION, STARTUPINFOW,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClientRect, GetMessageW,
    GetWindowTextLengthW, GetWindowTextW, KillTimer, LoadCursorW, MessageBoxW, PostQuitMessage,
    RegisterClassExW, SendMessageW, SetTimer, SetWindowPos, SetWindowTextW, ShowWindow,
    TranslateMessage, CW_USEDEFAULT, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONWARNING, MB_OK,
    SWP_NOACTIVATE, SWP_NOZORDER, WM_COMMAND, WM_CREATE, WM_CTLCOLOREDIT, WM_CTLCOLORSTATIC,
    WM_DESTROY, WM_DPICHANGED, WM_SETFONT, WM_SIZE, WM_TIMER, WNDCLASSEXW, WS_BORDER, WS_CHILD,
    WS_OVERLAPPEDWINDOW, WS_VISIBLE, WS_VSCROLL,
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

// 现代化色彩方案（以 Slate / Emerald 为基调，消除系统默认灰底）
const fn rgb(r: u8, g: u8, b: u8) -> u32 {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}

const COLOR_BG: u32 = rgb(248, 250, 252);              // #F8FAFC - slate-50 现代平滑窗体底色
const COLOR_CARD: u32 = rgb(255, 255, 255);            // #FFFFFF - 纯白输入与日志卡片
const COLOR_TEXT_PRIMARY: u32 = rgb(15, 23, 42);       // #0F172A - slate-900 清晰深色正文
const COLOR_TEXT_MUTED: u32 = rgb(71, 85, 105);        // #475569 - slate-600 标签辅助文字
const COLOR_STATUS_RUNNING: u32 = rgb(22, 101, 52);     // #166534 - emerald-800 运行中高可读绿
const COLOR_STATUS_STOPPED: u32 = rgb(100, 116, 139);   // #64748B - slate-500 停止中沉静灰

fn get_window_dpi(hwnd: HWND) -> u32 {
    unsafe {
        let user32 = GetModuleHandleW(wide("user32.dll").as_ptr());
        if !user32.is_null() {
            type GetDpiForWindowFn = unsafe extern "system" fn(HWND) -> u32;
            let p = GetProcAddress(user32, b"GetDpiForWindow\0".as_ptr());
            if let Some(f) = p {
                let get_dpi: GetDpiForWindowFn = std::mem::transmute(f);
                let dpi = get_dpi(hwnd);
                if dpi > 0 {
                    return dpi;
                }
            }
        }
        let hdc = GetDC(hwnd);
        let dpi = if !hdc.is_null() {
            let d = GetDeviceCaps(hdc, LOGPIXELSY as i32) as u32;
            ReleaseDC(hwnd, hdc);
            d
        } else {
            96
        };

        if dpi == 0 { 96 } else { dpi }
    }
}

fn scale(val: i32, dpi: u32) -> i32 {
    ((val * dpi as i32) + 48) / 96
}

fn create_segoe_font(dpi: u32, size_pt: i32, weight: i32) -> HFONT {
    let height = -((size_pt * dpi as i32 + 36) / 72);
    unsafe {
        CreateFontW(
            height,
            0,
            0,
            0,
            weight,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            CLEARTYPE_QUALITY as u32, // ClearType 抗锯齿平滑渲染
            DEFAULT_PITCH as u32 | FF_DONTCARE as u32,
            wide("Segoe UI").as_ptr(),
        )
    }
}

fn apply_window_theme(hwnd: HWND, app_name: &str) {
    unsafe {
        let uxtheme = LoadLibraryW(wide("uxtheme.dll").as_ptr());
        if !uxtheme.is_null() {
            type SetWindowThemeFn = unsafe extern "system" fn(HWND, *const u16, *const u16) -> i32;
            let p = GetProcAddress(uxtheme, b"SetWindowTheme\0".as_ptr());
            if let Some(f) = p {
                let set_theme: SetWindowThemeFn = std::mem::transmute(f);
                set_theme(hwnd, wide(app_name).as_ptr(), std::ptr::null());
            }
        }
    }
}

struct App {
    hwnd: HWND,
    port_label: HWND,
    port_edit: HWND,
    btn_save: HWND,
    btn_start: HWND,
    btn_stop: HWND,
    btn_panel: HWND,
    status_label: HWND,
    log_header: HWND,
    log_box: HWND,
    font_ui: HFONT,
    font_ui_bold: HFONT,
    font_log: HFONT,
    bg_brush: HBRUSH,
    card_brush: HBRUSH,
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
        unsafe {
            InvalidateRect(self.status_label, std::ptr::null(), 1);
        }
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

fn layout_controls(hwnd: HWND, app: &App) {
    let mut rc: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(hwnd, &mut rc) };
    let client_w = rc.right - rc.left;
    let client_h = rc.bottom - rc.top;
    if client_w <= 0 || client_h <= 0 {
        return;
    }

    let dpi = get_window_dpi(hwnd);
    let pad_x = scale(18, dpi);
    let pad_y = scale(16, dpi);
    let row1_y = pad_y;
    let btn_h = scale(30, dpi);
    let edit_h = scale(28, dpi);

    // 第一行：端口标签、输入框、保存按钮、启停面板按钮组
    let mut cur_x = pad_x;
    let label_w = scale(48, dpi);
    unsafe {
        SetWindowPos(
            app.port_label,
            std::ptr::null_mut(),
            cur_x,
            row1_y + scale(4, dpi),
            label_w,
            scale(22, dpi),
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
        cur_x += label_w + scale(6, dpi);

        let edit_w = scale(72, dpi);
        SetWindowPos(
            app.port_edit,
            std::ptr::null_mut(),
            cur_x,
            row1_y + scale(1, dpi),
            edit_w,
            edit_h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
        cur_x += edit_w + scale(10, dpi);

        let save_w = scale(82, dpi);
        SetWindowPos(
            app.btn_save,
            std::ptr::null_mut(),
            cur_x,
            row1_y,
            save_w,
            btn_h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
        cur_x += save_w + scale(8, dpi);

        let start_w = scale(68, dpi);
        SetWindowPos(
            app.btn_start,
            std::ptr::null_mut(),
            cur_x,
            row1_y,
            start_w,
            btn_h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
        cur_x += start_w + scale(8, dpi);

        let stop_w = scale(68, dpi);
        SetWindowPos(
            app.btn_stop,
            std::ptr::null_mut(),
            cur_x,
            row1_y,
            stop_w,
            btn_h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
        cur_x += stop_w + scale(8, dpi);

        let panel_w = scale(92, dpi);
        SetWindowPos(
            app.btn_panel,
            std::ptr::null_mut(),
            cur_x,
            row1_y,
            panel_w,
            btn_h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }

    // 第二行：运行状态信息栏
    let row2_y = row1_y + btn_h + scale(14, dpi);
    let content_w = (client_w - pad_x * 2).max(scale(200, dpi));
    let status_h = scale(24, dpi);
    unsafe {
        SetWindowPos(
            app.status_label,
            std::ptr::null_mut(),
            pad_x,
            row2_y,
            content_w,
            status_h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }

    // 第三行：日志分区标题
    let row3_y = row2_y + status_h + scale(12, dpi);
    let header_h = scale(22, dpi);
    unsafe {
        SetWindowPos(
            app.log_header,
            std::ptr::null_mut(),
            pad_x,
            row3_y,
            content_w,
            header_h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }

    // 第四行：日志输出文本区（自适应铺满剩余高度与宽度）
    let row4_y = row3_y + header_h + scale(6, dpi);
    let log_h = (client_h - row4_y - pad_y).max(scale(100, dpi));
    unsafe {
        SetWindowPos(
            app.log_box,
            std::ptr::null_mut(),
            pad_x,
            row4_y,
            content_w,
            log_h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
}

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

            let dpi = get_window_dpi(hwnd);
            let font_ui = create_segoe_font(dpi, 10, FW_NORMAL as i32);
            let font_ui_bold = create_segoe_font(dpi, 10, FW_SEMIBOLD as i32);
            let font_log = create_segoe_font(dpi, 10, FW_NORMAL as i32);
            let bg_brush = CreateSolidBrush(COLOR_BG);
            let card_brush = CreateSolidBrush(COLOR_CARD);

            let hinstance = GetModuleHandleW(std::ptr::null());
            let edit: Vec<u16> = wide("EDIT");
            let button: Vec<u16> = wide("BUTTON");
            let class_static: Vec<u16> = wide("STATIC");
            let mk = |id: isize, class: &[u16], text: &str, style: u32, x: i32, y: i32, w: i32, h: i32| -> HWND {
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
            };
            let child = WS_CHILD | WS_VISIBLE;
            let port_label = mk(0, &class_static, "端口：", child, 18, 20, 48, 22);
            let port_edit = mk(ID_PORT, &edit, "", child | WS_BORDER, 72, 17, 72, 28);
            let btn_save = mk(ID_SAVE, &button, "保存端口", child, 154, 16, 82, 30);
            let btn_start = mk(ID_START, &button, "启动", child, 244, 16, 68, 30);
            let btn_stop = mk(ID_STOP, &button, "停止", child, 320, 16, 68, 30);
            let btn_panel = mk(ID_PANEL, &button, "打开面板", child, 396, 16, 92, 30);
            let status_label = mk(ID_STATUS, &class_static, "状态：检测中…", child, 18, 58, 720, 24);
            let log_header = mk(0, &class_static, "输出日志（最近 400 行，自动刷新）：", child, 18, 92, 400, 22);
            let log_box = mk(
                ID_LOG,
                &edit,
                "",
                child | WS_VSCROLL | WS_BORDER | ES_MULTILINE,
                18,
                120,
                720,
                380,
            );

            // 应用 Segoe UI 现代清晰字体到全部控件
            for h in [port_label, port_edit, btn_save, btn_start, btn_stop, btn_panel, status_label] {
                SendMessageW(h, WM_SETFONT, font_ui as usize, 1);
            }
            SendMessageW(log_header, WM_SETFONT, font_ui_bold as usize, 1);
            SendMessageW(log_box, WM_SETFONT, font_log as usize, 1);

            // 启用 uxtheme 视觉样式
            apply_window_theme(port_edit, "Explorer");
            apply_window_theme(log_box, "Explorer");

            let app = App {
                hwnd,
                port_label,
                port_edit,
                btn_save,
                btn_start,
                btn_stop,
                btn_panel,
                status_label,
                log_header,
                log_box,
                font_ui,
                font_ui_bold,
                font_log,
                bg_brush,
                card_brush,
                data_root,
                settings_path,
                log_path,
                backend: None,
                backend_exe: resolved.as_ref().map(|(e, _)| e.clone()),
                backend_script: resolved.as_ref().map(|(_, s)| s.clone()),
                external_online: false,
            };

            layout_controls(hwnd, &app);
            *APP.lock().unwrap() = Some(app);

            if let Some(saved) = with_app(|a| load_port(&a.settings_path).to_string()) {
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
        WM_SIZE => {
            with_app(|a| {
                layout_controls(hwnd, a);
            });
            0
        }
        WM_DPICHANGED => {
            let new_dpi = (wparam >> 16) as u32;
            with_app(|a| {
                DeleteObject(a.font_ui as _);
                DeleteObject(a.font_ui_bold as _);
                DeleteObject(a.font_log as _);

                let font_ui = create_segoe_font(new_dpi, 10, FW_NORMAL as i32);
                let font_ui_bold = create_segoe_font(new_dpi, 10, FW_SEMIBOLD as i32);
                let font_log = create_segoe_font(new_dpi, 10, FW_NORMAL as i32);
                for h in [a.port_label, a.port_edit, a.btn_save, a.btn_start, a.btn_stop, a.btn_panel, a.status_label] {
                    SendMessageW(h, WM_SETFONT, font_ui as usize, 1);
                }
                SendMessageW(a.log_header, WM_SETFONT, font_ui_bold as usize, 1);
                SendMessageW(a.log_box, WM_SETFONT, font_log as usize, 1);
                a.font_ui = font_ui;
                a.font_ui_bold = font_ui_bold;
                a.font_log = font_log;

                let prc = lparam as *const RECT;
                if !prc.is_null() {
                    let r = *prc;
                    SetWindowPos(
                        hwnd,
                        std::ptr::null_mut(),
                        r.left,
                        r.top,
                        r.right - r.left,
                        r.bottom - r.top,
                        SWP_NOACTIVATE | SWP_NOZORDER,
                    );
                }
                layout_controls(hwnd, a);
            });
            0
        }
        WM_CTLCOLORSTATIC => {
            let hdc = wparam as HDC;
            let child = lparam as HWND;
            SetBkMode(hdc, TRANSPARENT as i32);
            let (color, bg) = with_app(|a| {
                if child == a.status_label {
                    let text_color = if a.own_backend_alive() || a.external_online {
                        COLOR_STATUS_RUNNING
                    } else {
                        COLOR_STATUS_STOPPED
                    };
                    (text_color, a.bg_brush)
                } else if child == a.log_header {
                    (COLOR_TEXT_PRIMARY, a.bg_brush)
                } else {
                    (COLOR_TEXT_MUTED, a.bg_brush)
                }
            })
            .unwrap_or((COLOR_TEXT_MUTED, std::ptr::null_mut()));
            SetTextColor(hdc, color);
            bg as isize
        }
        WM_CTLCOLOREDIT => {
            let hdc = wparam as HDC;
            SetBkColor(hdc, COLOR_CARD);
            SetTextColor(hdc, COLOR_TEXT_PRIMARY);
            let brush = with_app(|a| a.card_brush).unwrap_or(std::ptr::null_mut());
            brush as isize
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
            with_app(|a| {
                a.stop_own_backend(false); // 与托盘一致：退出只停自己拉起的后台
                DeleteObject(a.font_ui as _);
                DeleteObject(a.font_ui_bold as _);
                DeleteObject(a.font_log as _);
                DeleteObject(a.bg_brush as _);
                DeleteObject(a.card_brush as _);
            });
            KillTimer(hwnd, TIMER_ID);
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn run_gui() {
    unsafe {
        // 启用 DPI 感知（支持 Per-Monitor v2 高分屏缩放）
        let user32 = GetModuleHandleW(wide("user32.dll").as_ptr());
        if !user32.is_null() {
            type SetDpiContextFn = unsafe extern "system" fn(isize) -> i32;
            let p = GetProcAddress(user32, b"SetProcessDpiAwarenessContext\0".as_ptr());
            if let Some(set_dpi_context) = p {
                let f: SetDpiContextFn = std::mem::transmute(set_dpi_context);
                f(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            } else {
                type SetDpiAwareFn = unsafe extern "system" fn() -> i32;
                let p_old = GetProcAddress(user32, b"SetProcessDPIAware\0".as_ptr());
                if let Some(set_dpi_aware) = p_old {
                    let f: SetDpiAwareFn = std::mem::transmute(set_dpi_aware);
                    f();
                }
            }
        }

        // 初始化公共控件
        let icce = windows_sys::Win32::UI::Controls::INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<windows_sys::Win32::UI::Controls::INITCOMMONCONTROLSEX>() as u32,
            dwICC: windows_sys::Win32::UI::Controls::ICC_STANDARD_CLASSES
                | windows_sys::Win32::UI::Controls::ICC_WIN95_CLASSES,
        };
        windows_sys::Win32::UI::Controls::InitCommonControlsEx(&icce);

        let hinstance = GetModuleHandleW(std::ptr::null());
        let class_name = wide("TokenMonitorGuiWnd");
        let mut wc: WNDCLASSEXW = std::mem::zeroed();
        wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
        wc.lpfnWndProc = Some(wnd_proc);
        wc.hInstance = hinstance;
        wc.hCursor = LoadCursorW(std::ptr::null_mut(), 32512 as *const u16); // IDC_ARROW (MAKEINTRESOURCE)
        wc.hbrBackground = CreateSolidBrush(COLOR_BG);
        wc.lpszClassName = class_name.as_ptr();
        if RegisterClassExW(&wc) == 0 {
            return;
        }
        let title = wide("TokenMonitor 控制台");
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            780,
            560,
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
