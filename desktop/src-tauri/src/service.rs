//! Authenticated loopback-only JSON RPC. No DNS, external HTTP, account request or telemetry.
use crate::{config, db, model::Query, pricing::Prices, query, scanner};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

pub fn log(root: &Path, message: &str) {
    use std::fs::OpenOptions;
    let path = root.join("service.log");
    if fs::metadata(&path).is_ok_and(|m| m.len() > 2_000_000) {
        let _ = fs::rename(&path, root.join("service.previous.log"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {message}", chrono::Local::now().to_rfc3339());
    }
}
fn prices(root: &Path) -> Result<Prices, String> {
    Prices::parse(&fs::read_to_string(root.join("prices.json")).map_err(|e| e.to_string())?)
}
pub fn query_local(root: &Path, method: &str, args: &Value) -> Result<Value, String> {
    let db = db::open_read(root)?;
    match method {
        "dashboard" => query::dashboard(
            &db,
            &serde_json::from_value(args["query"].clone()).map_err(|e| e.to_string())?,
            &prices(root)?,
        ),
        "events" => query::event_page(
            &db,
            &serde_json::from_value(args["query"].clone()).map_err(|e| e.to_string())?,
            &prices(root)?,
            args["offset"].as_u64().unwrap_or(0) as usize,
            args["limit"].as_u64().unwrap_or(100) as usize,
        ),
        "activities" => query::activity_page(
            &db,
            &serde_json::from_value(args["query"].clone()).map_err(|e| e.to_string())?,
            args["offset"].as_u64().unwrap_or(0) as usize,
            args["limit"].as_u64().unwrap_or(100) as usize,
        ),
        "replay" => replay(&db, root, args),
        "replay_raw" => crate::session_replay::fetch_session_raw_page(
            &db,
            args["path"].as_str().ok_or("缺少会话路径")?,
            args["start"].as_u64().unwrap_or(0) as usize,
            args["limit"].as_u64().unwrap_or(500) as usize,
            args["expectedSizeBytes"].as_i64().unwrap_or(-1),
        )
        .and_then(|page| serde_json::to_value(page).map_err(|e| e.to_string())),
        "export" => export(&db, root, args),
        _ => Err(format!("未知只读方法: {method}")),
    }
}
fn replay(db: &rusqlite::Connection, root: &Path, args: &Value) -> Result<Value, String> {
    let path = args["path"].as_str().ok_or("缺少会话路径")?;
    let mut detail = serde_json::to_value(crate::session_replay::fetch_session_detail(db, path)?)
        .map_err(|e| e.to_string())?;
    let prices = prices(root)?;
    // ORDER BY ts: without it SQLite may return the session id of any row in the
    // file, so a resume/compaction file whose earliest event carries no session id
    // used to yield an empty session, which then priced the whole replay at 0.0
    // instead of reporting an unknown cost.
    let session: String = db
        .query_row(
            "SELECT session FROM raw_events WHERE path=?1 AND agent='codex' ORDER BY ts LIMIT 1",
            [path],
            |r| r.get(0),
        )
        .unwrap_or_default();
    let priced = !session.is_empty();
    let lifetime = Query {
        start: 0,
        end: 32_503_680_000_000,
        agent: Some("codex".into()),
        session: Some(session),
        model: None,
        project: None,
        search: String::new(),
        time_zone: None, offset_minutes: 0,
    };
    let totals = query::summarize(&db::events(db, &lifetime)?, &prices);
    // An unknown session is not a free session: pricing 0.0 read as "this cost
    // nothing" in the replay header.
    detail["summary"]["costUSD"] = if priced { json!(totals.cost_usd) } else { Value::Null };
    // A replay deliberately preserves full conversation context. Selected-window usage is
    // separately computed from the same event cache as every table/export, never from daily rows.
    if !args["query"].is_null() {
        let mut selected: Query =
            serde_json::from_value(args["query"].clone()).map_err(|e| e.to_string())?;
        selected.agent = lifetime.agent.clone();
        selected.session = lifetime.session.clone();
        selected.search.clear();
        detail["rangeTotals"] = json!(query::summarize(&db::events(db, &selected)?, &prices));
        detail["range"] = json!({"start":selected.start,"end":selected.end});
    }
    if let Some(agents) = detail["agents"].as_array_mut() {
        for agent in agents {
            let mut q = lifetime.clone();
            q.session = Some(agent["sessionId"].as_str().unwrap_or("").into());
            agent["costUSD"] = json!(query::summarize(&db::events(db, &q)?, &prices).cost_usd);
        }
    }
    Ok(detail)
}
fn csv(s: &str) -> String {
    let safe = if s.starts_with(['=', '+', '-', '@']) {
        format!("'{s}")
    } else {
        s.to_string()
    };
    format!("\"{}\"", safe.replace('"', "\"\""))
}
fn export(db: &rusqlite::Connection, root: &Path, args: &Value) -> Result<Value, String> {
    let q: Query = serde_json::from_value(args["query"].clone()).map_err(|e| e.to_string())?;
    let events = db::events(db, &q)?;
    let p = prices(root)?;
    let path = PathBuf::from(args["path"].as_str().ok_or("未选择导出路径")?);
    let format = args["format"].as_str().ok_or("未选择格式")?;
    let cost_heading = format!("Estimated {}", p.display_currency);
    let headers = [
        "Time (UTC)",
        "Agent",
        "Session",
        "Project",
        "Model",
        "Input",
        "Cached",
        "Cache write",
        "Output",
        "Reasoning (included)",
        "Total",
        &cost_heading,
        "Source",
        "Line",
    ];
    let rows: Vec<Vec<String>> = events
        .iter()
        .map(|e| {
            vec![
                chrono::DateTime::from_timestamp_millis(e.ts)
                    .map(|d| d.to_rfc3339())
                    .unwrap_or_default(),
                e.agent.clone(),
                e.session.clone(),
                e.project.clone(),
                e.model.clone(),
                e.tokens.input.to_string(),
                e.tokens.cached.to_string(),
                e.tokens.cache_write.to_string(),
                e.tokens.output.to_string(),
                e.tokens.reasoning.to_string(),
                e.tokens.total().to_string(),
                p.cost(e)
                    .map(|c| format!("{:.8}",c*p.display_factor()))
                    .unwrap_or_else(|| "unpriced".into()),
                e.path.clone(),
                e.line.to_string(),
            ]
        })
        .collect();
    match format {
        "csv" => {
            let mut text = String::from("\u{feff}");
            text.push_str(&headers.iter().map(|s| csv(s)).collect::<Vec<_>>().join(","));
            for row in &rows {
                text.push('\n');
                text.push_str(&row.iter().map(|s| csv(s)).collect::<Vec<_>>().join(","));
            }
            fs::write(&path, text).map_err(|e| e.to_string())?;
        }
        "markdown" => {
            let mut text = format!(
                "# TokenMonitor 本地用量\n\nUTC 毫秒范围：[{}, {})\n\n|{}|\n|{}|\n",
                q.start,
                q.end,
                headers.join("|"),
                vec!["---"; headers.len()].join("|")
            );
            for row in &rows {
                text.push_str(&format!(
                    "|{}|\n",
                    row.iter()
                        .map(|s| s.replace('|', "\\|").replace(['\n', '\r'], " "))
                        .collect::<Vec<_>>()
                        .join("|")
                ));
            }
            fs::write(&path, text).map_err(|e| e.to_string())?;
        }
        "xlsx" => {
            let mut book = rust_xlsxwriter::Workbook::new();
            let sheet = book.add_worksheet();
            for (i, h) in headers.iter().enumerate() {
                sheet
                    .write_string(0, i as u16, *h)
                    .map_err(|e| e.to_string())?;
            }
            for (i, row) in rows.iter().enumerate() {
                for (j, value) in row.iter().enumerate() {
                    if (5..=11).contains(&j) && value.parse::<f64>().is_ok() {
                        sheet
                            .write_number(i as u32 + 1, j as u16, value.parse::<f64>().unwrap())
                            .map_err(|e| e.to_string())?;
                    } else {
                        sheet
                            .write_string(i as u32 + 1, j as u16, value)
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
            sheet.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;
            sheet
                .set_column_range_width(0, 4, 24)
                .map_err(|e| e.to_string())?;
            book.save(&path).map_err(|e| e.to_string())?;
        }
        _ => return Err("不支持的导出格式".into()),
    }
    Ok(json!({"path":path,"rows":rows.len()}))
}
pub fn rpc(root: &Path, method: &str, args: Value) -> Result<Value, String> {
    let cfg = config::settings(root)?;
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, cfg.port);
    let mut stream = TcpStream::connect_timeout(&address.into(), Duration::from_millis(500))
        .map_err(|e| format!("后台未连接: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(
            if matches!(method, "status" | "start" | "stop" | "scan") {
                2
            } else {
                120
            },
        )))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    let token = fs::read_to_string(root.join("service-token")).map_err(|e| e.to_string())?;
    writeln!(
        stream,
        "{}",
        json!({"token":token,"method":method,"args":args})
    )
    .map_err(|e| e.to_string())?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|e| e.to_string())?;
    let mut body = String::new();
    stream
        .take(128 * 1024 * 1024)
        .read_to_string(&mut body)
        .map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if v["ok"] == true {
        Ok(v["result"].clone())
    } else {
        Err(v["error"].as_str().unwrap_or("后台请求失败").into())
    }
}
pub fn run(root: &Path) -> Result<(), String> {
    // Held until the scanner has really stopped, across port changes and GUI instances.
    let instance = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("service.lock"))
        .map_err(|e| e.to_string())?;
    instance
        .try_lock()
        .map_err(|_| "后台进程已在运行或正在停止".to_string())?;
    let cfg = config::settings(root)?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, cfg.port))
        .map_err(|e| format!("端口{}不可用: {e}", cfg.port))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let _ = db::open(root)?;
    log(
        root,
        &format!(
            "后台启动 pid={} port={}（仅本地）",
            std::process::id(),
            cfg.port
        ),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let request_scan = Arc::new(AtomicBool::new(true));
    let scanning = Arc::new(AtomicBool::new(false));
    let worker_root = root.to_path_buf();
    let worker_stop = stop.clone();
    let worker_request = request_scan.clone();
    let worker_scanning = scanning.clone();
    let worker = thread::spawn(move || {
        let mut last = Instant::now();
        while !worker_stop.load(Ordering::Relaxed) {
            let config = match config::settings(&worker_root) {
                Ok(c) => c,
                Err(e) => {
                    log(&worker_root, &e);
                    thread::sleep(Duration::from_secs(1));
                    continue;
                }
            };
            if worker_request.swap(false, Ordering::Relaxed)
                || last.elapsed().as_secs() >= config.refresh_seconds
            {
                worker_scanning.store(true, Ordering::Relaxed);
                match scanner::scan_cancellable(&worker_root, &config, &worker_stop) {
                    Ok(s) => log(
                        &worker_root,
                        &format!(
                            "扫描完成，{}个来源；{}个来源异常",
                            s.len(),
                            s.iter().filter(|s| !s.errors.is_empty()).count()
                        ),
                    ),
                    Err(e) => log(&worker_root, &format!("扫描失败: {e}")),
                };
                worker_scanning.store(false, Ordering::Relaxed);
                last = Instant::now();
            }
            thread::sleep(Duration::from_millis(200));
        }
    });
    while !stop.load(Ordering::Relaxed) || !worker.is_finished() {
        match listener.accept() {
            Ok((stream, _)) => {
                // Winsock inherits the listener's nonblocking mode on accepted sockets.
                // The listener polls, but each worker must wait for a complete request.
                stream.set_nonblocking(false).map_err(|e| e.to_string())?;
                let root = root.to_path_buf();
                let stop = stop.clone();
                let request_scan = request_scan.clone();
                let scanning = scanning.clone();
                thread::spawn(move || {
                    let mut stream = stream;
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(60)));
                    let result = (|| -> Result<Value, String> {
                        let mut line = String::new();
                        BufReader::new((&mut stream).take(1_048_576))
                            .read_line(&mut line)
                            .map_err(|e| e.to_string())?;
                        let req: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                        let token = fs::read_to_string(root.join("service-token"))
                            .map_err(|e| e.to_string())?;
                        if req["token"].as_str() != Some(token.as_str()) {
                            return Err("本地服务凭据不匹配".into());
                        }
                        match req["method"].as_str().unwrap_or("") {
                            "status" => Ok(
                                json!({"running":true,"stopping":stop.load(Ordering::Relaxed),"scanning":scanning.load(Ordering::Relaxed),"pid":std::process::id()}),
                            ),
                            "stop" => {
                                stop.store(true, Ordering::Relaxed);
                                Ok(json!({"stopping":true}))
                            }
                            "scan" => {
                                if stop.load(Ordering::Relaxed) {
                                    return Err("后台正在停止".into());
                                }
                                request_scan.store(true, Ordering::Relaxed);
                                Ok(json!({"scheduled":true}))
                            }
                            m => query_local(&root, m, &req["args"]),
                        }
                    })();
                    let response = match result {
                        Ok(v) => json!({"ok":true,"result":v}),
                        Err(e) => json!({"ok":false,"error":e}),
                    };
                    // JSON Display emits many small writes. Buffer them so large
                    // local responses do not cause one socket write per JSON token.
                    {
                        let mut writer = BufWriter::new(&mut stream);
                        let _ = write!(writer, "{response}");
                        let _ = writer.flush();
                    }
                    let _ = stream.shutdown(Shutdown::Both);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50))
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let _ = worker.join();
    log(root, "后台已停止");
    drop(listener);
    Ok(())
}
pub fn start(root: &Path) -> Result<Value, String> {
    if let Ok(v) = rpc(root, "status", json!({})) {
        if v["stopping"] == true {
            return Err("后台正在停止，请稍后再启动".into());
        }
        return Ok(v);
    }
    let port = config::settings(root)?.port;
    let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .map_err(|e| format!("端口 {port} 已被占用，请更换端口：{e}"))?;
    drop(probe);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new(exe);
    command.arg("--service").env("TOKENMONITOR_DATA_DIR", root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    for _ in 0..50 {
        if let Ok(v) = rpc(root, "status", json!({})) {
            return Ok(v);
        }
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("后台启动失败，端口可能被其他应用占用".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("后台启动超时，请检查服务日志".into())
}

pub fn stop(root: &Path) -> Result<Value, String> {
    let status = rpc(root, "status", json!({}));
    if status.is_err() {
        if service_locked(root)? {
            return Err("后台进程仍持有缓存锁，但控制端口未响应；请保留当前端口并检查日志".into());
        }
        return Ok(json!({"running":false}));
    }
    rpc(root, "stop", json!({}))?;
    let began = Instant::now();
    while began.elapsed() < Duration::from_secs(30) {
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("service.lock"))
            .map_err(|e| e.to_string())?;
        if lock.try_lock().is_ok() {
            return Ok(json!({"running":false}));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("后台正在结束当前文件的扫描，尚未完全停止；稍后重试".into())
}

fn service_locked(root: &Path) -> Result<bool, String> {
    match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("service.lock"))
    {
        Ok(lock) => Ok(lock.try_lock().is_err()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

pub fn save_settings(root: &Path, next: &config::Settings) -> Result<Value, String> {
    next.validate()?;
    let previous = config::settings(root)?;
    let running = rpc(root, "status", json!({})).is_ok();
    if !running && service_locked(root)? {
        return Err("后台控制端口未响应，设置未更改；请先恢复后台连接".into());
    }
    if next.port != previous.port {
        let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, next.port))
            .map_err(|e| format!("端口 {} 不可用，设置未更改：{e}", next.port))?;
        drop(probe);
        if running {
            stop(root)?;
        }
    }
    if let Err(e) = config::save_json(&root.join("settings.json"), next) {
        if running {
            let _ = start(root);
        }
        return Err(e);
    }
    if running {
        if let Err(e) = start(root) {
            config::save_json(&root.join("settings.json"), &previous)?;
            let recovery = start(root);
            return Err(format!(
                "设置应用失败，已恢复原设置：{e}；后台恢复：{recovery:?}"
            ));
        }
    }
    Ok(json!({"saved":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_range_uses_event_boundaries_and_unknown_cost() {
        let (root, _) = fixture();
        let path = root.join("session.jsonl");
        let text = [
            json!({"type":"session_meta","payload":{"id":"session","cwd":"D:/fixture"}}),
            json!({"timestamp":"2026-09-20T00:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"model":"unpriced-fixture","total_token_usage":{"input_tokens":100,"output_tokens":20}}}}),
            json!({"timestamp":"2026-09-20T00:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"model":"unpriced-fixture","total_token_usage":{"input_tokens":200,"output_tokens":40}}}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        fs::write(&path, &text).unwrap();
        let source = path.display().to_string();
        let parsed = crate::collectors::parse_jsonl("codex", &source, &text);
        let mut cache = db::open(&root).unwrap();
        db::replace_file(&mut cache, &source, "codex", text.len() as i64, 0, &parsed).unwrap();
        let start = chrono::DateTime::parse_from_rfc3339("2026-09-20T00:00:00Z")
            .unwrap()
            .timestamp_millis();
        let detail = replay(
            &cache,
            &root,
            &json!({"path":source,"query":{"start":start,"end":start+60_000}}),
        )
        .unwrap();
        assert_eq!(detail["rangeTotals"]["totalTokens"], 120);
        assert_eq!(detail["rangeTotals"]["unpricedEvents"], 1);
        assert!(detail["rangeTotals"]["costUsd"].is_null());
        assert!(detail["summary"]["costUSD"].is_null());
        assert_eq!(detail["summary"]["totalTokens"], 240);
        drop(cache);
        fs::remove_dir_all(root).unwrap();
    }
    fn fixture() -> (PathBuf, config::Settings) {
        let root =
            std::env::temp_dir().join(format!("tokenmonitor-service-{}", uuid::Uuid::new_v4()));
        config::initialize(&root).unwrap();
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let settings = config::Settings {
            port,
            roots: Default::default(),
            ..Default::default()
        };
        config::save_json(&root.join("settings.json"), &settings).unwrap();
        (root, settings)
    }
    #[test]
    fn service_authentication_stop_and_cached_read() {
        let (root, settings) = fixture();
        let worker_root = root.clone();
        let worker = thread::spawn(move || run(&worker_root));
        let mut ready = false;
        for _ in 0..100 {
            if rpc(&root, "status", json!({})).is_ok() {
                ready = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(ready);
        assert!(run(&root).unwrap_err().contains("运行"));
        let mut delayed = TcpStream::connect((Ipv4Addr::LOCALHOST, settings.port)).unwrap();
        delayed
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        let request = format!(
            "{}\n",
            json!({"token":fs::read_to_string(root.join("service-token")).unwrap(),"method":"status","args":{}})
        );
        let midpoint = request.len() / 2;
        delayed.write_all(&request.as_bytes()[..midpoint]).unwrap();
        thread::sleep(Duration::from_millis(100));
        delayed.write_all(&request.as_bytes()[midpoint..]).unwrap();
        delayed.shutdown(Shutdown::Write).unwrap();
        let mut delayed_response = String::new();
        delayed.read_to_string(&mut delayed_response).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&delayed_response).unwrap()["result"]["running"],
            true
        );
        let mut bad = TcpStream::connect((Ipv4Addr::LOCALHOST, settings.port)).unwrap();
        bad.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        writeln!(bad, "{}", json!({"token":"wrong","method":"stop"})).unwrap();
        bad.shutdown(Shutdown::Write).unwrap();
        let mut response = String::new();
        bad.read_to_string(&mut response).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap()["ok"],
            false
        );
        assert_eq!(rpc(&root, "status", json!({})).unwrap()["running"], true);
        assert_eq!(stop(&root).unwrap()["running"], false);
        worker.join().unwrap().unwrap();
        assert!(db::open_read(&root).is_ok());
        let port_free = TcpListener::bind((Ipv4Addr::LOCALHOST, settings.port)).unwrap();
        drop(port_free);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn occupied_port_preserves_settings() {
        let (root, mut settings) = fixture();
        let original = fs::read(root.join("settings.json")).unwrap();
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        settings.port = occupied.local_addr().unwrap().port();
        assert!(save_settings(&root, &settings)
            .unwrap_err()
            .contains("设置未更改"));
        assert_eq!(fs::read(root.join("settings.json")).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }
}
