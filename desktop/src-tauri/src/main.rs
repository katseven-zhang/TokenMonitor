#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = tokenmonitor_core::config::data_dir();
    if let Err(e) = tokenmonitor_core::config::initialize(&root) {
        eprintln!("{e}");
        std::process::exit(1)
    }
    let error_root = root.clone();
    std::panic::set_hook(Box::new(move |info| {
        tokenmonitor_core::service::log(&error_root, &format!("程序异常：{info}"));
        eprintln!("{info}");
    }));
    if args.iter().any(|a| a == "--service") {
        if let Err(e) = tokenmonitor_core::service::run(&root) {
            eprintln!("{e}");
            std::process::exit(1)
        }
        return;
    }
    let gui_lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("desktop.lock"))
        .expect("无法打开桌面实例锁");
    if gui_lock.try_lock().is_err() {
        if !args.iter().any(|a| a == "--background") {
            let _ = std::fs::write(root.join("show-window"), uuid::Uuid::new_v4().to_string());
        }
        return;
    }
    let _ = std::fs::remove_file(root.join("show-window"));
    #[cfg(feature = "desktop")]
    tokenmonitor_core::desktop::run();
    #[cfg(not(feature = "desktop"))]
    eprintln!("Build with the desktop feature to launch the GUI");
}
