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
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

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
    GetWindowTextLengthW, GetWindowTextW, KillTimer, LoadCursorW, MessageBoxW, PostMessageW,
    PostQuitMessage, PostThreadMessageW, RegisterClassExW, SendMessageTimeoutW, SendMessageW,
    SetTimer, SetWindowPos, SetWindowTextW, ShowWindow, TranslateMessage, CW_USEDEFAULT,
    MB_ICONERROR, MB_ICONINFORMATION, MB_ICONWARNING, MB_OK, SMTO_ABORTIFHUNG, SWP_NOACTIVATE,
    SWP_NOZORDER, WM_COMMAND, WM_CREATE, WM_CTLCOLOREDIT, WM_CTLCOLORSTATIC, WM_DESTROY,
    WM_DPICHANGED, WM_QUIT, WM_SETFONT, WM_SIZE, WM_TIMER, WNDCLASSEXW, WS_BORDER, WS_CHILD,
    WS_OVERLAPPEDWINDOW, WS_VISIBLE, WS_VSCROLL,
};



/// #59：探测完成回写消息（工作线程 → UI 线程；wparam=online）
const WM_APP_PROBE_RESULT: u32 = 0x0400 + 101;
/// #59：探测在途标志（防重入——探测未返回前不叠加新线程）
static PROBE_INFLIGHT: AtomicBool = AtomicBool::new(false);
/// 支持通过命令行 `--dpi <val>` 覆盖初始 DPI（如 96/120/144），供测试与多 DPI 取证渲染
static INITIAL_DPI: AtomicU32 = AtomicU32::new(0);

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
/// 日志为空时面板显示的占位行（#39：截断/轮转后不能继续挂着陈旧内容）
pub const EMPTY_LOG_TEXT: &str = "（暂无日志）";
/// #60：候选数据根（混用场景）：打包形态根优先，其后是源码形态 runtimeDir 根。
/// GUI 与后台可能不同形态启动；主根优先，主根无日志时 refresh_log 切换到备用根，绝不混写游标
/// （每个根独立 tail，切换时清空缓冲重来，#34/#39 语义不变）。
pub fn candidate_data_roots(
    app_root: Option<&Path>,
    env_data_dir: Option<&str>,
    local_app_data: Option<&str>,
    home: &str,
    is_windows: bool,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let primary = resolve_data_root(app_root, env_data_dir, local_app_data, home, is_windows);
    roots.push(primary);
    if is_windows {
        if let Some(la) = local_app_data {
            if !la.trim().is_empty() {
                let alt = Path::new(la).join("TokenMonitor").to_path_buf();
                if !roots.iter().any(|r| r == &alt) {
                    roots.push(alt);
                }
            }
        }
    }
    roots
}

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

/// 增量刷新决策（纯逻辑，#34）：由上一轮游标与当前文件大小决定本轮动作。
#[derive(Debug, PartialEq, Eq)]
pub enum LogPlan {
    /// 文件大小与上一轮一致：不重读、不重设文本（空闲期零 IO，卡顿主因）
    Unchanged,
    /// 文件变小：被 truncate / 轮转 / 删除重建，需清空缓冲从头读（保持 #39 的占位语义）
    Truncated,
    /// 正常追加（或首次读取）：从 start 读到当前大小
    Append { start: u64 },
}

/// 阈值与单位契约（#34）：offset/prev_len/size 均为字节；单次增量超过
/// MAX_BYTES 时只保留末尾 MAX_BYTES（起始残行被跳过）；行数窗口 TAIL_LINES。
pub const LOG_DELTA_MAX_BYTES: u64 = 1_000_000;

pub fn log_refresh_plan(offset: u64, prev_len: u64, size: u64) -> LogPlan {
    if size == prev_len {
        LogPlan::Unchanged
    } else if size < prev_len {
        LogPlan::Truncated
    } else if prev_len == 0 {
        // 首次读取或 truncate 清零后的重建：从文件头读起
        LogPlan::Append { start: 0 }
    } else {
        // 正常追加：从上次消费到的位置继续（offset == prev_len；半行未消费时 offset < prev_len）
        LogPlan::Append { start: offset }
    }
}

/// 读取 [from, to) 区间的完整行；返回 (完整行, 已消费到的绝对偏移)。
/// 末尾若无换行（写入方正在写半行），该半行本轮不消费、游标不推进（与采集侧半行语义一致）。
/// 文件被写入方占用也允许读（FILE_SHARE_READ|WRITE|DELETE）。
pub fn read_log_delta(path: &Path, from: u64, to: u64) -> Option<(Vec<String>, u64)> {
    if to <= from {
        return Some((Vec::new(), from));
    }
    let mut f = OpenOptions::new().read(true).share_mode(0x7).open(path).ok()?;
    // 超长增量只取末尾 LOG_DELTA_MAX_BYTES，起始位置若不在行首则跳过首个残行
    let delta = to - from;
    let (start, skip_first_partial) = if delta > LOG_DELTA_MAX_BYTES {
        (to - LOG_DELTA_MAX_BYTES, true)
    } else {
        (from, false)
    };
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = vec![0u8; (to - start) as usize];
    f.read_exact(&mut buf).ok()?;
    let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
        // 区间内还没有任何完整行（写入方正写到半行）：本轮不消费，游标不动
        return Some((Vec::new(), from));
    };
    let complete = &buf[..=last_nl];
    let consumed = start + complete.len() as u64;
    let text = String::from_utf8_lossy(complete);
    let mut lines: Vec<String> = text
        .lines()
        .skip(if skip_first_partial { 1 } else { 0 })
        .map(|s| s.to_string())
        .collect();
    if lines.len() > TAIL_LINES {
        lines.drain(..lines.len() - TAIL_LINES);
    }
    Some((lines, consumed))
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
    // #60：备用候选根与 GUI 自动切换 tail 的探测同源——混用诊断时直接可比对主/备两根
    let alt_root = candidate_data_roots(
        app_root.as_deref(),
        std::env::var("TOKENMONITOR_DATA_DIR").ok().as_deref(),
        std::env::var("LOCALAPPDATA").ok().as_deref(),
        &std::env::var("USERPROFILE").unwrap_or_default(),
        cfg!(windows),
    )
    .into_iter()
    .find(|r| r != &data_root);
    println!(
        "altDataRoot={}",
        alt_root.map_or_else(|| "(none)".to_string(), |p| p.display().to_string())
    );
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

/// 探测分级超时预算（#30）：非阻塞 connect 300ms + 读写 1200ms，总量 ≤1.5s。
/// 任何超时/错误一律按不可达处理，绝不在 UI 线程无界阻塞。
pub const PROBE_CONNECT_TIMEOUT_MS: u32 = 300;
pub const PROBE_IO_TIMEOUT_MS: u32 = 1200;

/// WSAStartup 只做一次（修前每 2s 轮询都 startup/cleanup 一遍，#30）。
static WSA_STARTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn ensure_wsa_started() -> bool {
    *WSA_STARTED.get_or_init(|| unsafe {
        let mut wsa: ws::WSADATA = std::mem::zeroed();
        ws::WSAStartup(0x202, &mut wsa) == 0
    })
}

/// 对 127.0.0.1:port 发最小 GET /api/status，返回是否拿到 200。
/// 总耗时 ≤ PROBE_CONNECT_TIMEOUT_MS + PROBE_IO_TIMEOUT_MS ≤ 1.5s（#30）。
fn http_status_ok(port: u16) -> bool {
    if !ensure_wsa_started() {
        return false;
    }
    unsafe { probe_once(port) }
}

unsafe fn probe_once(port: u16) -> bool {
    let sock = ws::socket(ws::AF_INET as i32, ws::SOCK_STREAM, 0);
    if sock == ws::INVALID_SOCKET {
        return false;
    }
    let ok = probe_once_inner(sock, port);
    ws::closesocket(sock);
    ok
}

unsafe fn probe_once_inner(sock: usize, port: u16) -> bool {
    // 非阻塞 connect：修前的阻塞 connect 在特定网络状态下会冻结 UI 最长 ~21s（#30）
    let mut nonblocking: u32 = 1;
    if ws::ioctlsocket(sock, ws::FIONBIO, &mut nonblocking) != 0 {
        return false;
    }
    let mut addr: ws::SOCKADDR_IN = std::mem::zeroed();
    addr.sin_family = ws::AF_INET;
    addr.sin_port = ws::htons(port);
    addr.sin_addr.S_un.S_addr = ws::htonl(0x7F00_0001); // 127.0.0.1
    let rc = ws::connect(
        sock,
        &addr as *const ws::SOCKADDR_IN as *const ws::SOCKADDR,
        std::mem::size_of::<ws::SOCKADDR_IN>() as i32,
    );
    if rc != 0 {
        let err = ws::WSAGetLastError();
        if err != ws::WSAEWOULDBLOCK {
            return false; // 立即被拒（端口未监听等）
        }
        // select 等连接结果：同时监听 write（成功）与 except（被拒，RST 走 exceptfds 可快速失败）
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
            return false; // 超时 / 连接被拒 / select 错误：一律按不可达
        }
        let mut serr: i32 = 0;
        let mut slen = std::mem::size_of::<i32>() as i32;
        if ws::getsockopt(sock, ws::SOL_SOCKET as i32, ws::SO_ERROR as i32, &mut serr as *mut i32 as *mut u8, &mut slen) != 0
            || serr != 0
        {
            return false;
        }
    }
    // 连接已建立：切回阻塞模式——SO_RCVTIMEO/SO_SNDTIMEO 只对阻塞 socket 生效，
    // 非阻塞 socket 上 recv 会立即返回 WSAEWOULDBLOCK 而不是等待（#30 实测踩坑）
    let mut blocking: u32 = 0;
    if ws::ioctlsocket(sock, ws::FIONBIO, &mut blocking) != 0 {
        return false;
    }
    // 读写超时兜底（Windows 上 SO_SNDTIMEO/SO_RCVTIMEO 为毫秒 DWORD；
    // SO_SNDTIMEO 不作用于 connect，所以 connect 阶段必须靠上面的 select）
    let io_ms: u32 = PROBE_IO_TIMEOUT_MS;
    if ws::setsockopt(sock, ws::SOL_SOCKET as i32, ws::SO_RCVTIMEO as i32, &io_ms as *const u32 as *const u8, 4) != 0
        || ws::setsockopt(sock, ws::SOL_SOCKET as i32, ws::SO_SNDTIMEO as i32, &io_ms as *const u32 as *const u8, 4) != 0
    {
        return false;
    }
    let req = format!("GET /api/status HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
    let sent = ws::send(sock, req.as_ptr(), req.len() as i32, 0);
    if sent <= 0 {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = ws::recv(sock, buf.as_mut_ptr(), buf.len() as i32, 0);
    n > 0 && String::from_utf8_lossy(&buf[..n as usize]).contains(" 200 ")
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
    /// #60：备用候选数据根（源码形态 runtimeDir 等）；主根无日志时自动切换 tail
    alt_log_root: Option<PathBuf>,
    /// #60：当前 tail 实际来源（显示在状态行，标明读的是哪个根）
    log_source: Option<PathBuf>,
    /// 已保存/已生效端口（#30）：探测、启动、打开面板一律用它；
    /// 端口输入框的未保存文本不改变任何后台交互目标。
    saved_port: u32,
    backend: Option<(HANDLE, u32)>, // 只管理自己拉起的进程
    backend_exe: Option<PathBuf>,
    backend_script: Option<PathBuf>,
    external_online: bool,
    /// 面板当前是否已在显示「（暂无日志）」占位行。用于只在状态翻转时改一次文本，
    /// 免得每 2s 定时都对空日志重设一次窗口文本（#39）。
    log_shows_placeholder: bool,
    /// 增量读取游标：已消费到的字节偏移（#34）
    log_offset: u64,
    /// 上一轮看到的文件大小；本轮大小与它相等则什么都不做（#34）
    log_len: u64,
    /// 面板尾部行缓冲（上限 TAIL_LINES，#34）
    log_buf: Vec<String>,
    /// 停止流程已发起、分离线程正在等待后台退出；期间重复 Stop/Start 被忽略（#34）
    stopping: bool,
    /// 待在锁外弹出的提示框信息（文本, 样式图标）。避免在持有 APP 锁时调用阻塞式 MessageBoxW（模态循环重入自锁死）。
    pending_alert: Option<(String, u32)>,
    /// 当前窗口 DPI（WM_DPICHANGED 下记录新 DPI，供 layout_controls 使用）
    dpi: u32,
}


// 单 GUI 线程；HWND 非 Send 只是保守标注，窗口句柄只在本线程使用
unsafe impl Send for App {}

static APP: std::sync::Mutex<Option<App>> = std::sync::Mutex::new(None);

// WM_CTLCOLORSTATIC 在子静态控件重绘时被**同步**发回父窗口。若它去取 APP 锁，而某个
// 调用方正持着 APP 锁改静态文本（WM_TIMER 里的 update_status、按钮的 stop/start 都是），
// 同一线程就会对非重入的 std::sync::Mutex 二次加锁 —— 首个 2s tick 即永久自锁死：
// 窗口在、进程活，但消息循环再也不取消息。这里把该处理器需要的四个值改成原子快照，
// 让它完全不进 APP 锁，从根上消除这一类重入（与 #39 的 SetWindowPos 同源问题）。
static CTL_STATUS_HWND: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static CTL_LOGHDR_HWND: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static CTL_BG_BRUSH: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static CTL_CARD_BRUSH: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static CTL_BACKEND_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 把 APP 锁内算出的值发布给免锁的 WM_CTLCOLORSTATIC 处理器
fn publish_ctl_snapshot(status_hwnd: HWND, log_header: HWND, bg_brush: HBRUSH, running: bool) {
    use std::sync::atomic::Ordering::Relaxed;
    CTL_STATUS_HWND.store(status_hwnd as usize, Relaxed);
    CTL_LOGHDR_HWND.store(log_header as usize, Relaxed);
    CTL_BG_BRUSH.store(bg_brush as usize, Relaxed);
    CTL_BACKEND_RUNNING.store(running, Relaxed);
}

fn with_app<R>(f: impl FnOnce(&mut App) -> R) -> Option<R> {
    // 锁中毒降级（#30）：任一持锁线程 panic 后不再让后续每次 with_app 都 panic
    //（修前 .ok() 会静默返回 None，全部 GUI 功能哑掉且无任何报错，比 panic 更难查）
    APP.lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_mut()
        .map(f)
}

impl App {
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

    fn alert(&mut self, text: &str, icon: u32) {
        self.pending_alert = Some((text.to_string(), icon));
    }

    fn own_backend_alive(&self) -> bool {
        match self.backend {
            Some((h, _)) => is_handle_signaled(h) == Some(false),
            None => false,
        }
    }

    fn start_backend(&mut self) {
        if self.stopping {
            // 停止流程仍在收尾（分离线程等待中）：忽略重复启动。
            // apply_port 的自动重启由分离线程完成等待后 PostMessage 触发，彼时 stopping 已被 poll 解除。
            return;
        }
        if self.own_backend_alive() {
            self.update_status();
            return;
        }
        if self.external_online {
            let port = self.saved_port;
            self.alert(
                &format!(
                    "端口 {} 已有后台在运行（非本程序启动）。为免误杀外部进程，这里不重复启动；如需换端口请先停止那个后台。",
                    port
                ),
                MB_ICONINFORMATION,
            );
            return;
        }
        let (Some(exe), Some(script)) = (self.backend_exe.clone(), self.backend_script.clone()) else {
            return;
        };
        let args = format!("\"{}\" serve --port {}", script.display(), self.saved_port);
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
            let port = self.saved_port;
            self.alert(
                &format!(
                    "启动后台失败（错误 {err}）\n（需要 runtime\\node.exe 与 runtime\\bin\\tokenmonitor.js；面板地址 http://127.0.0.1:{}）",
                    port
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
    /// 返回 Some(h) = 已发起 TerminateProcess，进程句柄所有权移交调用方，
    /// 由 reap_backend_async 在分离线程等待退出并回收（#34：UI 线程绝不 WaitForSingleObject(5000)
    /// 阻塞消息循环——修前 Stop 会冻结窗口最多 5 秒）。
    fn stop_own_backend(&mut self, user_initiated: bool) -> Option<HANDLE> {
        if self.stopping {
            // 停止已在进行中：重复点击直接忽略
            return None;
        }
        if !self.own_backend_alive() {
            if user_initiated {
                if self.external_online {
                    let port = self.saved_port;
                    self.alert(
                        &format!(
                            "当前后台不是本程序启动的（端口 {}），为免误杀外部进程这里不停止。",
                            port
                        ),
                        MB_ICONINFORMATION,
                    );
                }
                self.update_status();
            }
            return None;
        }
        let (h, _) = self.backend?;
        unsafe {
            TerminateProcess(h, 1);
        }
        self.backend = None;
        self.stopping = true;
        // 立即反馈「停止中…」，不等进程退出（等待在分离线程）
        self.update_status();
        Some(h)
    }

    /// 在分离线程等待被终止的后台退出并回收句柄（#34）。
    /// restart=true 时（apply_port 换端口重启），等待完成后通知 UI 线程重新启动后台；
    /// PostMessageW 线程安全，真正的 CreateProcess 仍回到 UI 线程执行。
    /// 句柄经 isize 跨线程传递（windows-sys 的 HANDLE/HWND 裸指针不实现 Send）。
    fn reap_backend_async(h: HANDLE, hwnd: HWND, restart: bool) {
        let h_addr = h as isize;
        let hwnd_addr = hwnd as isize;
        std::thread::spawn(move || unsafe {
            let h = h_addr as HANDLE;
            WaitForSingleObject(h, 5000);
            CloseHandle(h);
            if restart && hwnd_addr != 0 {
                PostMessageW(hwnd_addr as HWND, WM_COMMAND, ID_START as usize, 0);
            }
        });
    }

    fn open_panel(&self) {
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                wide("open").as_ptr(),
                wide(&format!("http://127.0.0.1:{}", self.saved_port)).as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1, // SW_SHOWNORMAL
            );
        }
    }

    fn apply_port(&mut self) {
        let text = self.get_text(self.port_edit);
        let Some(port) = parse_port(&text) else {
            self.alert("端口必须是 1-65535 的整数。", MB_ICONWARNING);
            self.set_text(self.port_edit, &self.saved_port.to_string());
            return;
        };
        if let Err(e) = save_port(&self.settings_path, port) {
            self.alert(&format!("保存设置失败：{e}"), MB_ICONERROR);
            return;
        }
        // 保存成功后才切换生效端口（#30）：探测/启动/面板立即使用新端口；
        // 输入框里改了但没保存的文本不影响任何后台交互目标
        self.saved_port = port;
        if self.own_backend_alive() {
            if let Some(h) = self.stop_own_backend(true) {
                // 旧进程退出在分离线程等待（#34）；完成后 PostMessage 回 UI 线程按新端口重启
                Self::reap_backend_async(h, self.hwnd, true);
            }
        } else {
            self.update_status();
        }
    }

    fn update_status(&mut self) {
        let alive = self.own_backend_alive();
        let running = alive || self.external_online;
        // 先发布免锁快照，再改文本：改文本触发的重绘会同步回到 WM_CTLCOLORSTATIC，
        // 那个处理器只能读原子值，不能再进 APP 锁（本方法常在持锁时被调用）。
        publish_ctl_snapshot(self.status_label, self.log_header, self.bg_brush, running);
        let state = if self.stopping {
            // 停止流程已发起、分离线程等待中（#34）
            "停止中…".to_string()
        } else if alive {
            format!("运行中（本程序启动，PID {}）", self.backend.map(|(_, pid)| pid).unwrap_or(0))
        } else if self.external_online {
            "运行中（外部启动）".to_string()
        } else {
            "已停止".to_string()
        };
        // #60：混用场景下若日志实际来自备用根，状态行标明，避免「数据目录≠日志目录」误导
        let log_note = match &self.log_source {
            Some(alt) => format!("    日志根：{}", alt.display()),
            None => String::new(),
        };
        self.set_text(
            self.status_label,
            &format!(
                "状态：{state}    面板：http://127.0.0.1:{}    数据：{}{}",
                self.saved_port,
                self.data_root.display(),
                log_note
            ),
        );
        unsafe {
            InvalidateRect(self.status_label, std::ptr::null(), 1);
        }
    }


    /// 空日志占位：只在状态翻转时写一次文本（#39 语义，#34 保持）。
    /// #60：占位必须同时显示 tail 的完整路径（区分「路径不对」与「真的没日志」）。
    fn show_log_placeholder(&mut self) {
        self.log_buf.clear();
        self.log_offset = 0;
        self.log_len = 0;
        if !self.log_shows_placeholder {
            self.log_shows_placeholder = true;
            // #60：占位必须同时显示当前 tail 的完整路径（区分「路径不对」与「真的没日志」），
            // 路径与 --selfcheck 的 logPath 同源（log_path_for）；混用切换到备用根后
            // 备用根日志消失时，也如实显示备用根（实际 tail 的根）。
            let root = self.log_source.clone().unwrap_or_else(|| self.data_root.clone());
            self.set_text(
                self.log_box,
                &format!(
                    "{}\r\n当前 tail 的日志路径：{}\r\n（若后台以其他形态启动，日志可能在另一数据根——见状态行的数据目录与 TROUBLESHOOTING_WINDOWS.md §0）",
                    EMPTY_LOG_TEXT,
                    log_path_for(&root).display()
                ),
            );
        }
    }

    /// 增量刷新日志面板（#34）：文件大小未变化时零 IO、不碰控件；
    /// 有追加时只读新增字节；truncate/轮转时清空后重读并保持 #39 的占位语义。
    fn refresh_log(&mut self) {
        let meta = match std::fs::metadata(&self.log_path) {
            Ok(m) => m,
            Err(_) => {
                // #60 混用场景：主根无日志文件时，探测备用根是否有日志——
                // 有则自动切换 tail 到备用根（每个根独立缓冲/游标，切换即清空重来，
                // #34/#39 语义不变；绝不混写）；都没有则显示含完整路径的空态占位。
                if let Some(alt) = self.alt_log_root.clone() {
                    let alt_log = log_path_for(&alt);
                    if let Ok(alt_meta) = std::fs::metadata(&alt_log) {
                        if alt_meta.len() > 0 {
                            self.log_path = alt_log;
                            self.log_source = Some(alt);
                            self.log_buf.clear();
                            self.log_offset = 0;
                            self.log_len = 0;
                            self.log_shows_placeholder = false;
                            self.update_status(); // 状态行标明实际 tail 的来源根
                            return;
                        }
                    }
                }
                self.show_log_placeholder();
                return;
            }
        };
        let size = meta.len();
        match log_refresh_plan(self.log_offset, self.log_len, size) {
            // 无变化：不重读文件、不重设文本（修前每 2s 全量读 1MB + 重设 400 行，卡顿主因）
            LogPlan::Unchanged => return,
            LogPlan::Truncated => {
                // truncate / 轮转 / 删除重建：清空缓冲与游标后按新内容重读
                if size == 0 {
                    self.show_log_placeholder();
                    return;
                }
                self.log_buf.clear();
                self.log_offset = 0;
                self.log_len = 0;
            }
            LogPlan::Append { start } => {
                self.log_len = size;
                let Some((mut new_lines, consumed)) = read_log_delta(&self.log_path, start, size)
                else {
                    return; // 读取失败（写方竞争等）：下轮按新状态重来
                };
                if consumed == start {
                    // 区间内还没有完整行（半行挂着）：游标不推进、不重设文本
                    return;
                }
                self.log_buf.extend(new_lines.drain(..));
                if self.log_buf.len() > TAIL_LINES {
                    let excess = self.log_buf.len() - TAIL_LINES;
                    self.log_buf.drain(..excess);
                }
                self.log_offset = consumed;
            }
        }
        if self.log_buf.is_empty() {
            self.show_log_placeholder();
            return;
        }
        self.log_shows_placeholder = false;
        self.set_text(self.log_box, &self.log_buf.join("\r\n"));
        unsafe {
            SendMessageW(self.log_box, EM_SETSEL, u32::MAX as usize, 0);
            SendMessageW(self.log_box, EM_SCROLLCARET, 0, 0);
        }
    }

    #[allow(dead_code)]
    fn poll_status(&mut self) {
        // #30 / #34 契约保持；实际定时探测已移交工作线程异步执行（#59）
        let _ = http_status_ok(self.saved_port as u16);
        if self.stopping && !self.own_backend_alive() && !self.external_online {
            // 后台已终止且端口不再可达：停止流程完成，解除「停止中」（#34）
            self.stopping = false;
        }
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

    let dpi = if app.dpi > 0 { app.dpi } else { get_window_dpi(hwnd) };
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
            // #60：候选根（主根 + 源码形态 runtimeDir），主根无日志时 refresh_log 自动切换
            let alt_log_root = candidate_data_roots(
                app_root.as_deref(),
                std::env::var("TOKENMONITOR_DATA_DIR").ok().as_deref(),
                std::env::var("LOCALAPPDATA").ok().as_deref(),
                &std::env::var("USERPROFILE").unwrap_or_default(),
                cfg!(windows),
            )
            .into_iter()
            .find(|r| r != &data_root);
            let resolved = resolve_backend(app_root.as_deref(), &exe_dir);
            let saved_port = load_port(&settings_path);

            let init_dpi = INITIAL_DPI.load(Ordering::Relaxed);
            let dpi = if init_dpi > 0 { init_dpi } else { get_window_dpi(hwnd) };
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
                alt_log_root,
                log_source: None,
                saved_port,
                backend: None,
                backend_exe: resolved.as_ref().map(|(e, _)| e.clone()),
                backend_script: resolved.as_ref().map(|(_, s)| s.clone()),
                external_online: false,
                // 文本框初值为空而非占位行，故置 false：首轮空日志会写一次「（暂无日志）」
                log_shows_placeholder: false,
                log_offset: 0,
                log_len: 0,
                log_buf: Vec::new(),
                stopping: false,
                pending_alert: None,
                dpi,
            };

            layout_controls(hwnd, &app);
            *APP.lock().unwrap() = Some(app);
            // WM_CTLCOLORSTATIC 可能在下一次重绘就到来，先给出免锁快照的初值
            publish_ctl_snapshot(status_label, log_header, bg_brush, false);
            CTL_CARD_BRUSH.store(card_brush as usize, std::sync::atomic::Ordering::Relaxed);

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
            // 锁内只做「准备」：换字体、把建议矩形拷出来。绝不在持有 APP 锁时调用
            // SetWindowPos —— 它会同步派发 WM_SIZE，而 WM_SIZE 处理器又进 with_app，
            // std::sync::Mutex 不可重入，同线程二次加锁就是自锁死（#39，由 #33 引入）。
            let suggested = with_app(|a| {
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
                a.dpi = new_dpi;
                a.font_ui = font_ui;
                a.font_ui_bold = font_ui_bold;
                a.font_log = font_log;

                let prc = lparam as *const RECT;
                if prc.is_null() {
                    None
                } else {
                    Some(unsafe { *prc })
                }
            })
            .flatten();
            // 锁已释放，此时 SetWindowPos 引发的 WM_SIZE 能正常取到锁
            if let Some(r) = suggested {
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
            with_app(|a| layout_controls(hwnd, a));
            0
        }
        WM_CTLCOLORSTATIC => {
            let hdc = wparam as HDC;
            let child = lparam as HWND;
            SetBkMode(hdc, TRANSPARENT as i32);
            // 全程不进 APP 锁：本消息是子控件重绘时**同步**发给父窗口的，
            // 调用方往往正持有 APP 锁，取锁即自锁死（见 CTL_* 注释）。
            use std::sync::atomic::Ordering::Relaxed;
            let bg = CTL_BG_BRUSH.load(Relaxed) as isize;
            let color = if child as usize == CTL_STATUS_HWND.load(Relaxed) {
                if CTL_BACKEND_RUNNING.load(Relaxed) {
                    COLOR_STATUS_RUNNING
                } else {
                    COLOR_STATUS_STOPPED
                }
            } else if child as usize == CTL_LOGHDR_HWND.load(Relaxed) {
                COLOR_TEXT_PRIMARY
            } else {
                COLOR_TEXT_MUTED
            };
            SetTextColor(hdc, color);
            bg
        }
        WM_CTLCOLOREDIT => {
            let hdc = wparam as HDC;
            SetBkColor(hdc, COLOR_CARD);
            SetTextColor(hdc, COLOR_TEXT_PRIMARY);
            CTL_CARD_BRUSH.load(std::sync::atomic::Ordering::Relaxed) as isize
        }
        WM_TIMER => {
            with_app(|a| a.refresh_log());
            // #59：探测在工作线程执行（UI 线程零阻塞）。修前 poll_status 在
            // APP 锁内阻塞 UI 线程最长 1.5s（每 2s 一次），跨进程同步消息
            // （WM_DPICHANGED 等 SendMessageTimeout）会被持锁延迟超时。
            // inflight 防重入：探测未返回前不叠加新线程；完成后 WM_APP_PROBE_RESULT 回写。
            if !PROBE_INFLIGHT.swap(true, Ordering::Relaxed) {
                let port = with_app(|a| a.saved_port as u16).unwrap_or(0);
                let hwnd_addr = hwnd as isize;
                std::thread::spawn(move || {
                    let online = http_status_ok(port);
                    PROBE_INFLIGHT.store(false, Ordering::Relaxed);
                    unsafe {
                        PostMessageW(hwnd_addr as HWND, WM_APP_PROBE_RESULT, online as usize, 0);
                    }
                });
            }
            with_app(|a| a.update_status());
            0
        }
        WM_APP_PROBE_RESULT => {
            with_app(|a| {
                a.external_online = wparam != 0;
                if a.stopping && !a.own_backend_alive() && !a.external_online {
                    a.stopping = false; // #34：后台已终止且端口不可达后解除「停止中」
                }
                a.update_status();
            });
            0
        }
        WM_COMMAND => {
            let id = (wparam & 0xffff) as isize;
            // 停止只发起 TerminateProcess（#34）；句柄等待在分离线程，UI 线程不阻塞
            let (wait, alert) = with_app(|a| {
                let wait = match id {
                    ID_SAVE => {
                        a.apply_port();
                        None
                    }
                    ID_START => {
                        a.start_backend();
                        None
                    }
                    ID_STOP => a.stop_own_backend(true),
                    ID_PANEL => {
                        a.open_panel();
                        None
                    }
                    _ => None,
                };
                let alert = a.pending_alert.take();
                (wait, alert)
            })
            .unwrap_or((None, None));

            if let Some(h) = wait {
                let hwnd = with_app(|a| a.hwnd).unwrap_or(std::ptr::null_mut());
                App::reap_backend_async(h, hwnd, false);
            }
            // 关键：在 APP 锁完全释放后再调用 msg_box！
            // 弹出 MessageBoxW 模态对话框时，其模态消息循环处理 WM_TIMER / WM_APP_PROBE_RESULT 时
            // with_app 均可正常取锁，彻底杜绝单线程自死锁冻结。
            if let Some((text, icon)) = alert {
                msg_box(hwnd, &text, icon);
            }
            0
        }
        WM_DESTROY => {
            let wait = with_app(|a| {
                let h = a.stop_own_backend(false); // 与托盘一致：退出只停自己拉起的后台
                DeleteObject(a.font_ui as _);
                DeleteObject(a.font_ui_bold as _);
                DeleteObject(a.font_log as _);
                DeleteObject(a.bg_brush as _);
                DeleteObject(a.card_brush as _);
                h
            })
            .flatten();
            if let Some(h) = wait {
                // 进程即将退出：等待移交分离线程即可（随进程消失无副作用，#34 不再阻塞销毁）
                App::reap_backend_async(h, std::ptr::null_mut(), false);
            }
            KillTimer(hwnd, TIMER_ID);
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn enable_dpi_awareness() {
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
    }
}

fn init_common_controls() {
    unsafe {
        let icce = windows_sys::Win32::UI::Controls::INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<windows_sys::Win32::UI::Controls::INITCOMMONCONTROLSEX>() as u32,
            dwICC: windows_sys::Win32::UI::Controls::ICC_STANDARD_CLASSES
                | windows_sys::Win32::UI::Controls::ICC_WIN95_CLASSES,
        };
        windows_sys::Win32::UI::Controls::InitCommonControlsEx(&icce);
    }
}

/// 注册窗口类并创建主窗口（run_gui 与 --pumpcheck 共用；调用方决定是否 ShowWindow）。
unsafe fn create_main_window() -> HWND {
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
        return std::ptr::null_mut();
    }
    let title = wide("TokenMonitor 控制台");
    let init_dpi = INITIAL_DPI.load(Ordering::Relaxed);
    let dpi = if init_dpi > 0 { init_dpi } else { 96 };
    let win_w = scale(780, dpi);
    let win_h = scale(560, dpi);
    CreateWindowExW(
        0,
        class_name.as_ptr(),
        title.as_ptr(),
        WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        win_w,
        win_h,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        hinstance,
        std::ptr::null(),
    )
}

fn run_gui() {
    unsafe {
        enable_dpi_awareness();
        init_common_controls();
        let hwnd = create_main_window();
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

/// 消息泵存活自检（#41）：正常创建窗口（不 ShowWindow）并进入消息循环；
/// worker 线程在 t=3s 与 t=6s 各做一次跨线程 SendMessageTimeoutW(WM_NULL, SMTO_ABORTIFHUNG, 3000)。
/// t=3s 必须晚于首个 2s WM_TIMER tick——tick 诱发的重入死锁（#39/#54 类缺陷）要过首个 tick 才现形；
/// 而「进程存活但完全不泵消息」是「进程 4 秒仍存活」式断言天然抱不住的（#33 引入 P1 死锁时 CI 全绿应验）。
/// 两次均快速应答 → PUMP=OK；超时 → PUMP=DEADLOCK。全 OK exit 0，任一超时 exit 1。
fn pumpcheck() -> i32 {
    unsafe {
        enable_dpi_awareness();
        init_common_controls();
        let hwnd = create_main_window();
        if hwnd.is_null() {
            println!("PUMP-SUMMARY=CREATE-FAILED");
            return 2;
        }
        let main_tid = windows_sys::Win32::System::Threading::GetCurrentThreadId();
        let hwnd_addr = hwnd as isize;
        let worker = std::thread::spawn(move || {
            let hwnd = hwnd_addr as HWND;
            let started = std::time::Instant::now();
            let mut all_ok = true;
            for probe_at_ms in [3000u64, 6000u64] {
                let target = std::time::Duration::from_millis(probe_at_ms);
                let waited = started.elapsed();
                if waited < target {
                    std::thread::sleep(target - waited);
                }
                let mut result: usize = 0;
                let responded =
                    SendMessageTimeoutW(hwnd, 0 /* WM_NULL */, 0, 0, SMTO_ABORTIFHUNG, 3000, &mut result);
                if responded != 0 {
                    println!("PUMP=OK");
                } else {
                    println!("PUMP=DEADLOCK");
                    all_ok = false;
                }
            }
            // 通知 UI 线程的消息循环退出（PostQuitMessage 只作用于调用线程，这里必须走线程消息）
            PostThreadMessageW(main_tid, WM_QUIT, 0, 0);
            all_ok
        });
        let mut msg: windows_sys::Win32::UI::WindowsAndMessaging::MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if worker.join().unwrap_or(false) {
            println!("PUMP-SUMMARY=OK");
            0
        } else {
            println!("PUMP-SUMMARY=DEADLOCK");
            1
        }
    }
}


/// 无头探测（#30）：对指定端口跑一次带超时的状态探测，打印 ok/elapsedMs 供行为测试。
fn probe_headless(port: u16) -> i32 {
    let start = std::time::Instant::now();
    let ok = http_status_ok(port);
    println!("ok={} elapsed_ms={}", ok, start.elapsed().as_millis());
    if ok { 0 } else { 1 }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    for arg in &args {
        if let Some(rest) = arg.strip_prefix("--dpi=") {
            if let Ok(val) = rest.parse::<u32>() {
                if (48..=480).contains(&val) {
                    INITIAL_DPI.store(val, Ordering::Relaxed);
                }
            }
        }
    }
    if let Some(pos) = args.iter().position(|a| a == "--dpi") {
        if let Some(val_str) = args.get(pos + 1) {
            if let Ok(val) = val_str.parse::<u32>() {
                if (48..=480).contains(&val) {
                    INITIAL_DPI.store(val, Ordering::Relaxed);
                }
            }
        }
    }

    if args.iter().any(|a| a == "--selfcheck" || a == "-selfcheck") {
        std::process::exit(selfcheck(args.get(2).map(|s| s.as_str())));
    }
    if args.iter().any(|a| a == "--probe") {
        // --probe [port]：无头探测，exit 0 = 可达 / 1 = 不可达或超时（总预算 ≤1.5s）
        let port = args
            .iter()
            .position(|a| a == "--probe")
            .and_then(|i| args.get(i + 1))
            .and_then(|s| parse_port(s))
            .unwrap_or(DEFAULT_PORT);
        std::process::exit(probe_headless(port as u16));
    }
    if args.iter().any(|a| a == "--pumpcheck") {
        // --pumpcheck：无头消息泵存活自检（#41），exit 0 = 两次探测均快速应答
        std::process::exit(pumpcheck());
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
