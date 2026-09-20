use crate::{config, pricing::Prices, service};
use serde_json::{json, Value};
use std::fs;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
async fn local_request(
    app: tauri::AppHandle,
    method: String,
    args: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, &method, args))
        .await
        .map_err(|e| e.to_string())?
}
fn dispatch(app: &tauri::AppHandle, method: &str, args: Value) -> Result<Value, String> {
    let root = config::data_dir();
    match method {
        "bootstrap" => Ok(
            json!({"settings":config::settings(&root)?,"prices":fs::read_to_string(root.join("prices.json")).map_err(|e|e.to_string())?,"dataDir":root,"agents":config::AGENTS,"autostart":app.autolaunch().is_enabled().map_err(|e|e.to_string())?}),
        ),
        "status" => Ok(service::rpc(&root, "status", json!({}))
            .unwrap_or(json!({"running":false,"scanning":false}))),
        "start" => service::start(&root),
        "stop" => service::stop(&root),
        "restart" => {
            service::stop(&root)?;
            service::start(&root)
        }
        "scan" => {
            service::start(&root)?;
            service::rpc(&root, "scan", json!({}))
        }
        "save_settings" => {
            let next: config::Settings = serde_json::from_value(args).map_err(|e| e.to_string())?;
            service::save_settings(&root, &next)
        }
        "save_prices" => {
            let text = args["text"].as_str().ok_or("价格内容为空")?;
            let prices = Prices::parse(text)?;
            config::save_json(&root.join("prices.json"), &prices)?;
            Ok(json!({"saved":true}))
        }
        "autostart" => {
            if args["enabled"] == true {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            }
            .map_err(|e| e.to_string())?;
            Ok(json!({"enabled":app.autolaunch().is_enabled().map_err(|e|e.to_string())?}))
        }
        "logs" => {
            Ok(json!({"text":fs::read_to_string(root.join("service.log")).unwrap_or_default()}))
        }
        "reveal" => {
            let path = args["path"].as_str().ok_or("缺少路径")?;
            let db = crate::db::open_read(&root)?;
            db.query_row("SELECT 1 FROM source_files WHERE path=?1", [path], |_| {
                Ok(())
            })
            .map_err(|_| "只允许打开已索引的本地文件".to_string())?;
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                std::process::Command::new("explorer.exe")
                    .arg(format!("/select,{path}"))
                    .creation_flags(0x08000000)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            Ok(json!({"path":path}))
        }
        "dashboard" | "events" | "replay" | "export" => service::query_local(&root, method, &args),
        _ => Err(format!("未知本地操作: {method}")),
    }
}
fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--background"])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![local_request])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let root = config::data_dir();
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .visible(!std::env::args().any(|arg| arg == "--background"))
                .data_directory(root.join("webview"))
                .additional_browser_args("--disable-background-networking --disable-component-update --disable-sync --disable-domain-reliability --no-first-run")
                .on_navigation(|url| {
                    url.as_str() == "about:blank"
                        || (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
                        || (cfg!(debug_assertions) && url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(5173))
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            let handle = app.handle().clone();
            let show_root = root.clone();
            std::thread::spawn(move || {
                let mut last = String::new();
                loop {
                    if let Ok(request) = fs::read_to_string(show_root.join("show-window")) {
                        if request != last { last = request; show(&handle); }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            });
            let show_item =
                MenuItem::with_id(app, "show", "打开 TokenMonitor", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "停止后台采集", true, None::<&str>)?;
            let start_item = MenuItem::with_id(app, "start", "启动后台采集", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出应用并停止后台", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &start_item, &stop_item, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("missing icon")?.clone())
                .tooltip("TokenMonitor · 纯本地用量")
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                        show(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    match id {
                        "show" => show(app),
                        "start" => {
                            let root = config::data_dir();
                            std::thread::spawn(move || {
                                if let Err(e) = service::start(&root) {
                                    service::log(&root, &e);
                                }
                            });
                        }
                        "stop" => {
                            let root = config::data_dir();
                            std::thread::spawn(move || {
                                if let Err(e) = service::stop(&root) {
                                    service::log(&root, &e);
                                }
                            });
                        }
                        "quit" => {
                            let app = app.clone();
                            std::thread::spawn(move || {
                                let root = config::data_dir();
                                if let Err(e) = service::stop(&root) {
                                    service::log(&root, &e);
                                }
                                app.exit(0);
                            });
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            let root = config::data_dir();
            std::thread::spawn(move || {
                if let Err(e) = service::start(&root) {
                    service::log(&root, &e);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("TokenMonitor desktop failed");
}
