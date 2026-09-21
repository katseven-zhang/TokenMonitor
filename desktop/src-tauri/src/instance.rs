//! 桌面实例锁，以及"界面还没起来"时的致命错误出口。
//!
//! 两件事都必须与 Tauri 无关，才能在 `main.rs` 里用得上：release 版按
//! `windows_subsystem = "windows"` + `panic = "abort"` 构建（见 main.rs 首行与
//! Cargo.toml），此时 stderr 与 panic 钩子都不会留下任何可见痕迹，而主窗口尚未
//! 创建。所以实例锁打不开这类故障只能走原生消息框，否则用户看到的就是
//! "双击了没反应"。
use crate::{config, service};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

/// 桌面实例锁的三种结局。修前只有"拿到/没拿到"两种，而"没拿到"里混着两件性质
/// 相反的事：另一个实例正常持有锁（预期行为，安静让位），以及锁文件根本打不开
/// （数据目录不可用，必须报错）。
#[derive(Debug)]
pub enum InstanceLock {
    /// 本实例持有锁。返回的 File 必须活到进程结束，drop 即放锁。
    Held(File),
    /// 另一个实例持有锁：不是错误。
    Busy,
    /// 锁文件打不开（权限、目录占位、磁盘或数据目录故障）。带 OS 原因。
    Unusable { path: PathBuf, error: std::io::Error },
}

pub fn acquire_desktop_lock(root: &Path) -> InstanceLock {
    let path = root.join("desktop.lock");
    let lock = match OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
    {
        Ok(lock) => lock,
        Err(error) => return InstanceLock::Unusable { path, error },
    };
    // try_lock 失败只说明别的实例持有它，与"打不开"是两回事。
    if lock.try_lock().is_err() {
        InstanceLock::Busy
    } else {
        InstanceLock::Held(lock)
    }
}

/// 界面起不来时唯一的对外报错通道：写日志、弹原生消息框、以非零码退出。
/// `advice` 是给人看的处置建议，`detail` 是原始错误。desktop.rs 的 WebView2
/// 致命错误也走这里。
pub fn fatal_startup(advice: &str, detail: &str) -> ! {
    let message = format!("TokenMonitor 无法打开桌面界面。{advice}\n\n详细错误：{detail}");
    service::log(&config::data_dir(), &message);
    // 0x10 = MB_ICONERROR：Native fallback still works when WebView2 cannot create any UI.
    native_dialog("TokenMonitor 启动失败", &message, 0x10);
    eprintln!("{message}");
    std::process::exit(1);
}

/// #71(8)：托盘"退出应用并停止后台"停不下来时的用户可见结果。
///
/// 修前只有 `service::log`：那一刻界面正在关闭，用户在下次打开应用之前读不到
/// 它，而后台进程仍活着（占着数据目录锁与本地端口）——菜单的承诺静默落空。
/// 现在除了同一条日志还弹一次原生告警，然后照常退出：既不能假装停成功，也不能
/// 把用户卡在一个关不掉的托盘上。
/// 只有桌面壳（`desktop` feature）会调它；`cargo test --no-default-features`
/// （desktop/README.md 记的无界面跑法）下它是纯 API 面，不该报 dead_code。
#[cfg_attr(not(feature = "desktop"), allow(dead_code))]
pub fn warn_background_not_stopped(detail: &str) {
    let message = format!(
        "TokenMonitor 即将退出，但后台采集没有停下来。{detail}\n\
         后台进程仍在占用数据目录与本地端口：再次打开应用可以用托盘里的\u{201c}停止后台采集\u{201d}重试，\
         仍然失败请带着 service.log 反馈。"
    );
    service::log(&config::data_dir(), &message);
    native_dialog("TokenMonitor 后台未停止", &message, 0x30); // MB_ICONWARNING
}

/// MessageBoxW 全仓库只此一份：启动致命错误与"后台没停下来"的告警共用同一个
/// 出口。非 Windows 目标上没有原生壳可弹，退化为只写日志（调用方已写过）。
fn native_dialog(title: &str, text: &str, flags: u32) {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" { fn MessageBoxW(window: *mut std::ffi::c_void, text: *const u16, title: *const u16, flags: u32) -> i32; }
        let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), flags); }
    }
    #[cfg(not(windows))]
    { let _ = (title, text, flags); }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("tm-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// 实例锁的"别的实例在用"与"锁文件打不开"必须是可分辨的两种结局：前者安静
    /// 让位（main.rs 仍要写 show-window 唤起已有窗口），后者是致命故障。修前二者
    /// 都塌进同一个 `expect`，release 下表现为"双击没反应"且不留任何诊断。
    #[test]
    fn busy_lock_and_unusable_lock_are_distinguishable() {
        let root = temp_root("instance-lock");
        let held = match acquire_desktop_lock(&root) {
            InstanceLock::Held(file) => file,
            other => panic!("干净的数据目录必须先拿到锁，实际 {other:?}"),
        };
        assert!(root.join("desktop.lock").exists());
        match acquire_desktop_lock(&root) {
            // 忙：没有 OS 错误可报告，也没有 File 句柄——调用方据此写 show-window 后返回。
            InstanceLock::Busy => {}
            other => panic!("锁被本进程另一句柄持有时必须报 Busy，实际 {other:?}"),
        }
        // 打不开：desktop.lock 被一个同名目录占住（数据目录不可写/被破坏的代理）。
        let broken = temp_root("instance-lock-broken");
        std::fs::create_dir_all(broken.join("desktop.lock")).unwrap();
        match acquire_desktop_lock(&broken) {
            InstanceLock::Unusable { path, error } => {
                assert_eq!(path, broken.join("desktop.lock"));
                assert_ne!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock,
                    "打不开锁文件不能退化成套锁失败，那会被当成'已有实例在跑'而静默退出"
                );
                assert!(!error.to_string().is_empty());
            }
            other => panic!("锁文件不可用时必须报 Unusable，实际 {other:?}"),
        }
        drop(held);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&broken).unwrap();
    }
}
