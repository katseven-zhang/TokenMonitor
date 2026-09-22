//! #87 —— 桌面版对旧版 Node 后台的只读探测。
//!
//! 两个产品共用一个仓库、此前共用一个默认端口（都是 127.0.0.1:8787），并且各自有一套
//! 登录自启：旧版是当前用户任务计划 `TokenMonitor-Server`，桌面版是
//! tauri-plugin-autostart 写的 HKCU `...\CurrentVersion\Run` 值。彼此完全不可见，
//! 抢输的一方要么静默僵尸、要么把错误藏进 service.log。
//!
//! 这里只做**读取**：查锁文件、查端口能否 connect、`schtasks /Query`。绝不写文件、
//! 绝不创建/修改/删除任务计划、绝不终止任何进程。默认值与旧版侧常量
//! （`src/coexistence.js`）成对，改一侧必须改另一侧。

use serde_json::Value;
use std::{
    fs,
    net::{Ipv4Addr, TcpStream},
    path::PathBuf,
    process::Command,
    time::Duration,
};

/// 旧版 `src/config.js::DEFAULT_PORT`。
pub const LEGACY_DEFAULT_PORT: u16 = 8787;
/// 桌面版自己的新默认端口（`config::Settings::default`）。
pub const DESKTOP_DEFAULT_PORT: u16 = 18787;
/// 旧版任务计划名（`src/platform/windows-service.js::WINDOWS_TASK_NAME`）。
pub const LEGACY_TASK_NAME: &str = "TokenMonitor-Server";

fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from).or_else(dirs::home_dir)
}

/// 旧版可能写下 `tokenmonitor-<port>.lock` 的全部位置。
///
/// 覆盖 #89 改名前后的两个运行数据目录名，以及安装/便携形态的 `<安装根>\data`：
/// 探测漏一个位置，就等于在那些机器上仍然"看不见对方"。
pub fn legacy_lock_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    if let Some(local) = local_app_data() {
        push(local.join("TokenMonitor-Server")); // #89 之后的新名字
        push(local.join("TokenMonitor")); // #89 之前的旧名字（也是桌面版 NSIS 安装目录）
        push(local.join("Programs").join("TokenMonitor").join("data")); // 安装形态
    }
    if let Some(home) = home_dir() {
        push(home.join(".tokenmonitor")); // 非 Windows / 缺 LOCALAPPDATA 时的回落
    }
    if let Some(forced) = std::env::var_os("TOKENMONITOR_DATA_DIR") {
        push(PathBuf::from(forced));
    }
    out
}

/// 一个旧版运行锁的解析结果。锁里损坏的 JSON 按"没有实例"处理（与旧版守卫同语义）。
#[derive(Debug, Clone, Default)]
pub struct LegacyLock {
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub path: Option<PathBuf>,
}

fn parse_lock(text: &str) -> LegacyLock {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return LegacyLock::default(),
    };
    LegacyLock {
        pid: v.get("pid").and_then(Value::as_u64).map(|n| n as u32),
        port: v.get("port").and_then(Value::as_u64).and_then(|n| u16::try_from(n).ok()),
        path: None,
    }
}

/// 旧版是否装了 / 是否在跑。生产入口，探测真实任务计划。
pub fn detect_legacy(own_port: u16, base_dirs: Option<Vec<PathBuf>>) -> String {
    detect_legacy_with(own_port, base_dirs, legacy_task_state)
}

/// 可注入版本：`task_state` 抽出来是为了单元测试不必去起 schtasks 进程。
pub fn detect_legacy_with(
    own_port: u16,
    base_dirs: Option<Vec<PathBuf>>,
    task_state: impl Fn() -> &'static str,
) -> String {
    let dirs = base_dirs.unwrap_or_else(legacy_lock_dirs);
    let mut found = LegacyLock::default();
    let mut installed = false;
    for dir in &dirs {
        let rd = match fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        installed = true;
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.starts_with("tokenmonitor-") && name.ends_with(".lock")) {
                continue;
            }
            let text = match fs::read_to_string(entry.path()) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let mut lock = parse_lock(&text);
            if lock.pid.is_some() {
                lock.path = Some(entry.path());
                found = lock;
                break;
            }
        }
        if found.pid.is_some() {
            break;
        }
    }
    let port = found.port.unwrap_or(LEGACY_DEFAULT_PORT);
    // "在运行"要求两件事同时成立：锁里有 PID（旧版 serve 写的），且那个端口真的有人监听。
    // 只有前者成立就是 #87 修的僵尸：残留锁或吞掉了 EADDRINUSE 的死实例。
    let running = found.pid.is_some() && probe(port);
    let task = task_state();
    let parts = format!(
        "旧版 Node 后台：{}；锁 {}；端口 {}{}；登录自启任务 {}{}",
        if installed { "本机存在" } else { "未见数据目录" },
        found
            .path
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "无".to_string()),
        port,
        if running { "（在运行）" } else { "（未在运行）" },
        task,
        if port == own_port {
            "；与本版默认端口相同——请只保留一个，或把其中一侧换端口"
        } else {
            ""
        }
    );
    parts
}

/// `schtasks /Query` 是只读的：查不到就是 "no"，查询本身失败才是 "unknown"。
/// 绝不在这条路径上出现 /Create 或 /Delete。
fn legacy_task_state() -> &'static str {
    let Ok(out) = Command::new("schtasks.exe")
        .args(["/Query", "/TN", LEGACY_TASK_NAME])
        .output()
    else {
        return "unknown";
    };
    if out.status.success() {
        return "yes";
    }
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .to_lowercase();
    if text.contains("cannot find") || text.contains("not found") || text.contains("找不到") {
        "no"
    } else {
        "unknown"
    }
}

fn probe(port: u16) -> bool {
    TcpStream::connect_timeout(
        &(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// 端口被占时给运维的一句话结论（供 `run`/`start` 的报错拼接）。
pub fn conflict_hint(port: u16, own_port: u16) -> String {
    if port != own_port {
        return String::new();
    }
    format!(
        "（127.0.0.1:{port} 同时也是旧版 Node 后台的默认端口；旧版占用的话请停掉它，或改本版设置里的端口。#87 起本版默认端口是 {DESKTOP_DEFAULT_PORT}，仍报这个错说明 settings.json 是升级前写下的。）"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tm-coexistence-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &PathBuf) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn desktop_default_port_moved_off_the_legacy_one() {
        assert_eq!(DESKTOP_DEFAULT_PORT, crate::config::Settings::default().port);
        assert_eq!(LEGACY_DEFAULT_PORT, 8787);
        assert_ne!(DESKTOP_DEFAULT_PORT, LEGACY_DEFAULT_PORT);
    }

    #[test]
    fn lock_parsing_reads_pid_and_port() {
        let lock = parse_lock(r#"{"pid":4242,"port":18787,"dataDir":"x"}"#);
        assert_eq!(lock.pid, Some(4242));
        assert_eq!(lock.port, Some(18787));
    }

    #[test]
    fn corrupt_lock_is_treated_as_no_instance() {
        let lock = parse_lock("not-json{{{");
        assert_eq!(lock.pid, None);
        assert_eq!(lock.port, None);
    }

    #[test]
    fn injected_dir_exposes_the_legacy_lock_without_touching_real_state() {
        // 锁里写一个不会有人监听的端口，避免测试去 connect 用户机器上真实在跑的 8787。
        let dir = tmp("detect");
        fs::write(
            dir.join("tokenmonitor-42424.lock"),
            r#"{"pid":4242,"port":42424}"#,
        )
        .unwrap();
        let text = detect_legacy_with(DESKTOP_DEFAULT_PORT, Some(vec![dir.clone()]), || "skipped");
        cleanup(&dir);
        assert!(text.contains("42424"), "{text}");
        assert!(text.contains("tokenmonitor-42424.lock"), "{text}");
        assert!(text.contains("未在运行"), "{text}");
    }

    #[test]
    fn empty_dirs_report_no_legacy_installed() {
        let dir = tmp("absent");
        let text = detect_legacy_with(DESKTOP_DEFAULT_PORT, Some(vec![dir.join("nope")]), || "skipped");
        cleanup(&dir);
        assert!(text.contains("未见数据目录"), "{text}");
    }

    #[test]
    fn conflict_hint_only_appears_for_the_shared_port() {
        assert!(conflict_hint(LEGACY_DEFAULT_PORT, LEGACY_DEFAULT_PORT).contains("旧版"));
        assert!(conflict_hint(DESKTOP_DEFAULT_PORT, LEGACY_DEFAULT_PORT).is_empty());
    }
}
