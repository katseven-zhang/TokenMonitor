use crate::{config, pricing::Prices, service};
use serde_json::{json, Value};
use std::fs;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_autostart::ManagerExt;

#[derive(Default)]
struct StartupError(std::sync::Mutex<Option<String>>);
fn start_service(app:&tauri::AppHandle,root:&std::path::Path)->Result<Value,String> {
    let result=service::start(root);
    if let Ok(mut error)=app.state::<StartupError>().0.lock(){*error=result.as_ref().err().cloned();}
    if let Err(error)=&result {service::log(root,error);}
    result
}

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
        "bootstrap" => {
            // #113: unknown keys no longer abort bootstrap (see `Settings::unknown`),
            // but a downgrade must not be *silent* either: the unrecognised keys are
            // logged and echoed to the UI as `settingsWarnings` so the user can see
            // which field came from a newer version instead of wondering why a
            // setting "disappeared".
            let settings = config::settings(&root)?;
            let warnings = config::unknown_keys(&settings);
            if !warnings.is_empty() {
                service::log(
                    &root,
                    &format!(
                        "settings.json 含本版本不认识的键，已忽略并原样保留：{}",
                        warnings.join(", ")
                    ),
                );
            }
            Ok(
                json!({"settings":settings,"settingsWarnings":warnings,"prices":fs::read_to_string(root.join("prices.json")).map_err(|e|e.to_string())?,"dataDir":root,"agents":config::AGENTS,"autostart":app.autolaunch().is_enabled().map_err(|e|e.to_string())?}),
            )
        }
        "status" => {
            let result=service::rpc(&root,"status",json!({}));
            let state=app.state::<StartupError>();
            let mut error=state.0.lock().map_err(|e|e.to_string())?;
            if result.is_ok(){*error=None;}
            Ok(result.unwrap_or(json!({"running":false,"scanning":false,"error":*error})))
        },
        "start" => start_service(app,&root),
        "stop" => service::stop(&root),
        "restart" => {
            service::stop(&root)?;
            start_service(app,&root)
        }
        "scan" => {
            start_service(app,&root)?;
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
            // #62: 存储键是 canonicalize 的 verbatim 形态（\\?\…），explorer.exe
            // 的命令行不接受它；只在这个对外端点上还原。
            let open_path = crate::model::display_path(path);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                std::process::Command::new("explorer.exe")
                    .arg(format!("/select,{open_path}"))
                    .creation_flags(0x08000000)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            Ok(json!({"path":open_path}))
        }
        "dashboard" | "events" | "activities" | "replay" | "export" => service::query_local(&root, method, &args),
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
/// #71(8)：托盘"退出应用并停止后台"这条承诺的兑现顺序，抽成与 Tauri、与原生
/// 消息框都无关的三个闭包，好让 `#[test]` 能钉住它——修前这一段是
/// `if let Err(e)=stop {log(e)}; exit(0)`，日志写在正在关闭的界面背后，停不下来
/// 与停下来了在用户那边一模一样。现在：停不下来必须先有一条看得见的告警，
/// 然后仍然退出（不能把用户关在一个关不掉的托盘上）。
fn quit_with(
    stop: impl FnOnce() -> Result<(), String>,
    warn: impl FnOnce(&str),
    exit: impl FnOnce(),
) {
    if let Err(error) = stop() {
        warn(&error);
    }
    exit();
}
pub fn run() {
    // The runtime otherwise shows an English dialog but can leave a headless
    // tray/service process alive. Stop before constructing either subsystem.
    if let Err(error)=tauri::webview_version() { fatal_desktop(&error.to_string()); }
    let result=tauri::Builder::default()
        .manage(StartupError::default())
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
                            let app=app.clone();
                            std::thread::spawn(move || {
                                let _=start_service(&app,&root);
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
                                quit_with(
                                    || service::stop(&root).map(|_| ()),
                                    // 这个出口自己会写 service.log，再弹一次原生告警：
                                    // 修前只有前者，等于没告诉任何人。
                                    |error| crate::instance::warn_background_not_stopped(error),
                                    || app.exit(0),
                                );
                            });
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            let root = config::data_dir();
            let handle=app.handle().clone();
            std::thread::spawn(move || {
                let _=start_service(&handle,&root);
            });
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(error)=result {
        fatal_desktop(&error.to_string());
    }
}
fn fatal_desktop(error:&str)->! {
    // MessageBoxW 只在 instance::native_dialog 里有一份：main.rs 的实例锁故障、
    // 这里的 WebView2 故障、以及托盘退出时"后台没停下来"的告警共用同一个出口。
    crate::instance::fatal_startup("请确认 Microsoft Edge WebView2 Runtime 已安装且可用。", error)
}

#[cfg(test)]
mod tests {
    use super::quit_with;
    use std::cell::RefCell;

    /// #71(8)：菜单写着"退出应用并停止后台"，所以停不下来是一个必须让用户看见的
    /// 结果，不是一行日志。修前失败与成功在用户侧完全同形（界面一关，日志没人读），
    /// 后台进程继续占着数据目录锁与端口。
    /// 这里钉住两件事：① 失败 → 告警恰好一次、且带着原始错误、然后仍然退出；
    /// ② 成功 → 一声不吭地退出（不许把"停止成功"也弹成故障）。
    #[test]
    fn quit_surfaces_a_background_stop_failure_and_still_exits() {
        let steps = RefCell::new(Vec::<String>::new());
        let error = "后台进程仍持有缓存锁，但控制端口未响应；请保留当前端口并检查日志";
        quit_with(
            || Err(error.to_string()),
            |detail| {
                assert_eq!(detail, error, "告警必须带上真实失败原因，不能只说\"未能停止\"");
                steps.borrow_mut().push("warn".into());
            },
            || steps.borrow_mut().push("exit".into()),
        );
        assert_eq!(
            *steps.borrow(),
            vec!["warn", "exit"],
            "停不下来要\"先告警再退出\"：只退出就是修前的静默失败，只告警会把用户卡在关不掉的托盘上"
        );

        let steps = RefCell::new(Vec::<String>::new());
        quit_with(
            || Ok(()),
            |_| panic!("后台确实停下来了就不得弹告警"),
            || steps.borrow_mut().push("exit".into()),
        );
        assert_eq!(*steps.borrow(), vec!["exit"], "成功路径必须安静");
    }

    /// 上一条只证明 `quit_with` 本身正确；真正会退化的是**接线**——把菜单臂改回
    /// "只写日志再 exit(0)"，行为测试一点感觉都没有。所以这里按调用点（不是函数
    /// 定义）钉住 quit 菜单项：它必须经由 `quit_with`，把可见告警出口和退出都交
    /// 进去，不再自己直接调 `service::log`。桌面消息框无法在无头 CI 里点，这是
    /// 唯一能把这条承诺钉住的检查。
    #[test]
    fn the_quit_menu_item_is_wired_to_the_visible_outcome() {
        let source = include_str!("desktop.rs");
        let marker = "\"quit\" =>";
        let at = source.find(marker).expect("退出菜单项") + marker.len();
        let rest = &source[at..];
        let open = rest.find('{').expect("quit 臂体的左花括号");
        let mut depth = 0usize;
        let mut end = None;
        for (index, ch) in rest[open..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + index);
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &rest[open + 1..end.expect("quit 臂体的右花括号")];
        for required in ["quit_with(", "service::stop(&root)", "warn_background_not_stopped", "app.exit(0)"] {
            assert!(body.contains(required), "quit 菜单臂少了 {required}：{body}");
        }
        assert!(
            !body.contains("service::log"),
            "退出路径不得再把错误只写进日志（那正是修前的静默失败）：{body}"
        );
    }
}
