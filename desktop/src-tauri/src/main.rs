#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(all(
    not(debug_assertions),
    feature = "desktop",
    not(feature = "custom-protocol")
))]
compile_error!(
    "Desktop release requires custom-protocol to embed the frontend; use the default features."
);
fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Package validation must not create user data or require WebView2.
    if args.iter().any(|a| a == "--version") {
        println!("TokenMonitor {}", env!("CARGO_PKG_VERSION"));
        return;
    }
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
    // 三种结局分开：拿到锁继续启动；别的实例持有锁则唤起它的窗口后安静退出
    // （这是正常路径，不是错误）；锁文件根本打不开则是数据目录故障，release 版
    // 没有 stderr 也没有 panic 痕迹（panic="abort" + windows_subsystem），必须走
    // 原生消息框，否则用户看到的就只是"双击了没反应"。
    // `_gui_lock` 不是丢弃：绑定活到 main 结束，句柄一 drop 锁就放了。
    let _gui_lock = match tokenmonitor_core::instance::acquire_desktop_lock(&root) {
        tokenmonitor_core::instance::InstanceLock::Held(lock) => lock,
        tokenmonitor_core::instance::InstanceLock::Busy => {
            if !args.iter().any(|a| a == "--background") {
                let _ = std::fs::write(root.join("show-window"), uuid::Uuid::new_v4().to_string());
            }
            return;
        }
        tokenmonitor_core::instance::InstanceLock::Unusable { path, error } => {
            tokenmonitor_core::instance::fatal_startup(
                "本地实例锁文件不可用。请确认数据目录存在且可写，desktop.lock 未被安全软件锁定，且磁盘有空间。",
                &format!("{}: {error}", path.display()),
            )
        }
    };
    let _ = std::fs::remove_file(root.join("show-window"));
    #[cfg(feature = "desktop")]
    tokenmonitor_core::desktop::run();
    #[cfg(not(feature = "desktop"))]
    eprintln!("Build with the desktop feature to launch the GUI");
}
