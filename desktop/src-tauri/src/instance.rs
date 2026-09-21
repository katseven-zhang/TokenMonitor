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
/// 致命错误也走这里，MessageBoxW 全仓库只此一份。
pub fn fatal_startup(advice: &str, detail: &str) -> ! {
    let message = format!("TokenMonitor 无法打开桌面界面。{advice}\n\n详细错误：{detail}");
    service::log(&config::data_dir(), &message);
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" { fn MessageBoxW(window: *mut std::ffi::c_void, text: *const u16, title: *const u16, flags: u32) -> i32; }
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "TokenMonitor 启动失败".encode_utf16().chain(Some(0)).collect();
        // Native fallback still works when WebView2 cannot create any UI.
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10); }
    }
    eprintln!("{message}");
    std::process::exit(1);
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
