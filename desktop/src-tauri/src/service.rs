//! Authenticated loopback-only JSON RPC. No DNS, external HTTP, account request or telemetry.
use crate::{config, db, model::Query, pricing::Prices, query, scanner};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, BufWriter, Read, Write},
    net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
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
        "export" => export(&db, root, args),
        _ => Err(format!("未知只读方法: {method}")),
    }
}
fn replay(db: &rusqlite::Connection, root: &Path, args: &Value) -> Result<Value, String> {
    let path = args["path"].as_str().ok_or("缺少会话路径")?;
    let mut detail = serde_json::to_value(crate::session_replay::fetch_session_detail(db, path)?)
        .map_err(|e| e.to_string())?;
    let prices = prices(root)?;
    let session: String = db
        .query_row(
            "SELECT session FROM raw_events WHERE path=?1 AND agent='codex' LIMIT 1",
            [path],
            |r| r.get(0),
        )
        .unwrap_or_default();
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
    detail["summary"]["costUSD"] = json!(totals.cost_usd);
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
    // #83: Excel strips leading TAB/CR before interpreting a cell, so a value
    // like "\t=cmd()" is formula-injection territory exactly like "=cmd()".
    let safe = if s.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{s}")
    } else {
        s.to_string()
    };
    format!("\"{}\"", safe.replace('"', "\"\""))
}
/// #83: exports land on a sibling temp file first and are renamed into place.
/// A crash or a full disk halfway used to leave a truncated file under the
/// final name — indistinguishable from a complete export.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    let committed = commit_replacing(&temp, path);
    if committed.is_err() {
        let _ = fs::remove_file(&temp);
    }
    committed
}
fn commit_replacing(temp: &Path, path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    fs::rename(temp, path).map_err(|e| e.to_string())
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
                // #62: the stored key may be a `\\?\` verbatim path; exported
                // workbooks and CSVs must show a path the user can actually use.
                crate::model::display_path(&e.path),
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
            write_atomic(&path, &text)?;
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
                        // #83: escape the backslash itself first. A cell ending in `\`
                        // used to emit `...path\|` — markdown reads `\|` as a literal
                        // pipe and the row silently loses a column boundary.
                        .map(|s| {
                            s.replace('\\', "\\\\")
                                .replace('|', "\\|")
                                .replace(['\n', '\r'], " ")
                        })
                        .collect::<Vec<_>>()
                        .join("|")
                ));
            }
            write_atomic(&path, &text)?;
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
                    // #83: "Line" is a number too — as text Excel warns about
                    // numbers-stored-as-text and refuses to sort it numerically.
                    if (matches!(j, 5..=11 | 13)) && value.parse::<f64>().is_ok() {
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
            let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            let committed = book.save(&temp).map_err(|e| e.to_string()).and_then(|()| commit_replacing(&temp, &path));
            if committed.is_err() {
                let _ = fs::remove_file(&temp);
            }
            committed?;
        }
        _ => return Err("不支持的导出格式".into()),
    }
    Ok(json!({"path":path,"rows":rows.len()}))
}
/// #113: the port the control channel should dial, plus an optional reason why
/// `settings.json` was *not* used.
///
///修前这里是 `config::settings(root)?` —— 一个文本文件读不动就让 `status`/`stop`/`scan`
/// 全部报「配置错误」，而后台进程本身毫发无损（「能看数据不能停服务」）。用户手工加一个
/// 未知键、或新版写入字段后降级运行旧版，都会踩到。现在按
/// 「文件里的端口 > 本进程上次成功读到的端口 > 内置默认端口」退回，控制通道照旧连通，
/// 失败原因进服务日志；连不上时再把它拼进错误信息。
fn control_port(root: &Path) -> (u16, Option<String>) {
    let (port, note) = control_port_with_last(root, LAST_CONTROL_PORT.load(Ordering::Relaxed));
    if note.is_none() {
        LAST_CONTROL_PORT.store(port, Ordering::Relaxed);
    }
    (port, note)
}

/// 上面那层的纯函数形态：`last_good` 由参数给，不碰进程全局。
/// 单测必须走这一层——`LAST_CONTROL_PORT` 是进程级静态量，同进程里并行的
/// service 测试也会经 `rpc` 写它，直接断言静态量会得到别的测试留下的端口。
fn control_port_with_last(root: &Path, last_good: u16) -> (u16, Option<String>) {
    match config::settings(root) {
        Ok(s) => (s.port, None),
        Err(e) => {
            let port = if last_good != 0 { last_good } else { config::Settings::default().port };
            (port, Some(e))
        }
    }
}

/// 本进程最近一次从 `settings.json` 成功读到的端口（0 = 还没读到过）。
static LAST_CONTROL_PORT: AtomicU16 = AtomicU16::new(0);

pub fn rpc(root: &Path, method: &str, args: Value) -> Result<Value, String> {
    let (port, config_error) = control_port(root);
    if let Some(e) = &config_error {
        log(root, &format!("settings.json 未被采用，控制通道退回端口 {port} 继续工作：{e}"));
    }
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream = TcpStream::connect_timeout(&address.into(), Duration::from_millis(500))
        .map_err(|e| match &config_error {
            Some(c) => format!("后台未连接: {e}（settings.json 未被采用，已退回端口 {port}；原因：{c}）"),
            None => format!("后台未连接: {e}"),
        })?;
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
    wait_for_ready(
        || rpc(root, "status", json!({})).ok().map(Ok),
        || child.try_wait().ok().flatten().is_some(),
        300,
        Duration::from_millis(100),
    )
}

/// #83: the old inline loop gave up after 50×100ms=5s and reported "启动超时",
/// but a first start must open/migrate the whole cache (db::open runs before
/// the accept loop) — on big caches 5s is routinely exceeded while the child
/// is alive and initializing, so the panel cried wolf. The polling is now a
/// testable helper with a 30s budget, child-exit takes precedence (fail fast,
/// don't burn the budget), and exhaustion says "still starting" — a different
/// fact from "failed to start".
fn wait_for_ready<P, E>(mut probe: P, mut exited: E, attempts: u32, delay: Duration) -> Result<Value, String>
where
    P: FnMut() -> Option<Result<Value, String>>,
    E: FnMut() -> bool,
{
    for _ in 0..attempts {
        if let Some(result) = probe() {
            return result;
        }
        if exited() {
            return Err("后台启动失败，端口可能被其他应用占用".into());
        }
        thread::sleep(delay);
    }
    Err("后台仍在启动：首次建库或视图迁移可能较慢，请稍候刷新；持续未就绪请查看服务日志".into())
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
    /// #83: 启动等待的轮询语义——就绪即回状态；子进程已退出必须快速失败、
    /// 不烧预算；预算耗尽报"仍在启动"（首次建库/迁移慢不是启动失败）。
    #[test]
    fn startup_polling_prioritizes_exit_and_says_still_starting_on_budget() {
        let mut polls = 0;
        let ready = wait_for_ready(
            || {
                polls += 1;
                (polls == 3).then(|| Ok(json!({"running": true})))
            },
            || false,
            10,
            Duration::from_millis(1),
        )
        .unwrap();
        assert_eq!(ready["running"], true);
        assert_eq!(polls, 3);
        let mut polls = 0;
        let mut exit_checks = 0;
        let err = wait_for_ready(
            || {
                polls += 1;
                None
            },
            || {
                exit_checks += 1;
                exit_checks >= 2
            },
            1000,
            Duration::from_millis(1),
        )
        .unwrap_err();
        assert!(err.contains("启动失败"), "{err}");
        assert!(polls <= 2 && polls >= 1, "进程已退出必须立刻失败，不得烧预算：polls={polls}");
        let err = wait_for_ready(|| None, || false, 3, Duration::from_millis(1)).unwrap_err();
        assert!(err.contains("仍在启动"), "{err}");
    }
    /// #83: 导出三件套。① 反斜杠结尾的单元格不得吃掉 markdown 列分隔符
    /// （未转义分隔符计数恒为 15）；② 制表符/回车开头的 CSV 单元格要和 `=`
    /// 一样拿到引号前缀（Excel 会先剥前导空白再解释公式）；③ 重复导出原子
    /// 覆盖且目录里没有 .tmp 残留。
    #[test]
    fn export_escaping_column_integrity_and_atomic_replacement() {
        fn unescaped_separators(row: &str) -> usize {
            let mut n = 0;
            let mut backslashes = 0usize;
            for ch in row.chars() {
                match ch {
                    '\\' => backslashes += 1,
                    '|' => {
                        if backslashes % 2 == 0 {
                            n += 1;
                        }
                        backslashes = 0;
                    }
                    _ => backslashes = 0,
                }
            }
            n
        }
        let (root, _) = fixture();
        let mut cache = db::open(&root).unwrap();
        let event = crate::model::Event {
            id: "1".into(),
            agent: "codex".into(),
            session: "\r=evil".into(),
            project: r"x|y\".into(),
            model: "\t=who".into(),
            ts: 60_000,
            tokens: crate::model::Tokens { input: 5, ..Default::default() },
            path: "fixture.jsonl".into(),
            line: 3,
        };
        db::replace_file(
            &mut cache,
            "fixture.jsonl",
            "codex",
            1,
            1,
            &crate::model::Parsed { events: vec![event], ..Default::default() },
        )
        .unwrap();
        drop(cache);
        let base = |format: &str, path: PathBuf| {
            json!({"query":{"start":60_000,"end":120_000,"agent":"codex"},"format":format,"path":path})
        };
        let md = root.join("out.md");
        query_local(&root, "export", &base("markdown", md.clone())).unwrap();
        let text = fs::read_to_string(&md).unwrap();
        let row = text.lines().rev().find(|l| l.starts_with('|') && !l.contains("---")).unwrap();
        assert!(row.contains(r"x\|y\\"), "反斜杠要先加倍、竖线再转义：{row}");
        assert_eq!(unescaped_separators(row), 15, "分隔符被反斜杠吃了：{row}");
        let csv_path = root.join("out.csv");
        query_local(&root, "export", &base("csv", csv_path.clone())).unwrap();
        let csv_text = fs::read_to_string(&csv_path).unwrap();
        assert!(csv_text.contains("\"'\t=who\""), "Tab 前导未加引号前缀：{csv_text}");
        assert!(csv_text.contains("\"'\r=evil\""), "CR 前导未加引号前缀：{csv_text}");
        for _ in 0..2 {
            let again = query_local(&root, "export", &base("csv", csv_path.clone())).unwrap();
            assert_eq!(again["rows"], 1);
        }
        let leftovers: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "原子导出不得留临时文件：{leftovers:?}");
        fs::remove_dir_all(root).unwrap();
    }
    /// #82：改端口的成功腿此前只测过失败腿（occupied_port_preserves_settings）。
    /// 两条腿：
    /// ① 后台没在跑时——新端口要真的落盘，其余设置一字不改地保留（这就是"成功
    ///    腿"，修前无人断言过保存后的端口值）；
    /// ② 后台在跑时——用一个假控制端口顶替 status/stop，钉住"先探活、再停旧后台"
    ///    的调用顺序，以及停完之后的重启失败必须把原设置恢复回去（不是留下一个
    ///    没人监听的端口）。②里重启必然失败：单元测试的 current_exe 是 libtest
    ///    壳、不认 `--service`，起不来真后台；顺序与回滚两条断言与被测代码路径
    ///    无关地成立，真实重启腿由 desktop/scripts/service-smoke.mjs 覆盖。
    /// 端口一律现绑现取，不写死号段。
    #[test]
    fn save_settings_port_change_saves_and_rebinds_a_running_service() {
        let free = || {
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .unwrap()
                .local_addr()
                .unwrap()
                .port()
        };
        let (root, current) = fixture();
        // 腿①：没有后台在跑（fixture 的端口无人监听、也没有 service.lock）。
        let idle_port = free();
        let mut idle = current.clone();
        idle.port = idle_port;
        assert_eq!(save_settings(&root, &idle).unwrap(), json!({"saved": true}));
        let saved = config::settings(&root).unwrap();
        assert_eq!(saved.port, idle_port, "新端口没落盘");
        assert_eq!(saved.refresh_seconds, current.refresh_seconds);
        assert_eq!(saved.roots, current.roots);
        assert_eq!(saved.disabled_agents, current.disabled_agents);
        // 腿②：旧端口上有个肯应答 status/stop 的假后台。
        let old_port = free();
        let old_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, old_port)).unwrap();
        let mut running = idle.clone();
        running.port = old_port;
        config::save_json(&root.join("settings.json"), &running).unwrap();
        // stop() 靠这把锁判断后台是否真的退干净；假后台不持锁，文件存在即可。
        fs::write(root.join("service.lock"), b"").unwrap();
        let answers = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = answers.clone();
        let fake = std::thread::spawn(move || {
            // save_settings 会问：status（在不在跑）→ status、stop（改端口前）。
            for stream in old_listener.incoming().take(3) {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut line = String::new();
                if BufReader::new(&mut stream).read_line(&mut line).is_err() {
                    break;
                }
                let method = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|v| v["method"].as_str().map(str::to_string))
                    .unwrap_or_default();
                stream
                    .write_all(
                        format!("{}\n", json!({"ok": true, "result": {"running": true}})).as_bytes(),
                    )
                    .unwrap();
                seen.lock().unwrap().push(method);
            }
        });
        let new_port = free();
        let mut next = running.clone();
        next.port = new_port;
        let err = save_settings(&root, &next).unwrap_err();
        assert!(
            err.contains("设置应用失败，已恢复原设置"),
            "重启失败必须报回滚：{err}"
        );
        assert_eq!(
            *answers.lock().unwrap(),
            vec!["status", "status", "stop"],
            "改端口前必须先探活再停掉旧后台"
        );
        assert_eq!(
            config::settings(&root).unwrap().port,
            old_port,
            "后台没能重启时，设置不得留在新端口上"
        );
        let _ = fake.join();
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod tests_control_port {
    use super::*;

    /// #113：控制通道不得因为 settings.json 读不动就整体失灵。
    /// 顺序在同一个测试里排好：先成功读到 P1（缓存住），再把文件写坏，
    /// 断言退回的是**上次成功的端口**而不是默认端口——这正是"后台在跑、
    /// 客户端却停不下来"的那个现场。
    #[test]
    fn control_channel_falls_back_instead_of_failing_the_whole_rpc() {
        let root = std::env::temp_dir().join(format!("tm-rpc-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        fs::write(
            &path,
            r#"{"port":12345,"refreshSeconds":60,"roots":{},"disabledAgents":[]}"#,
        )
        .unwrap();
        let (port, note) = control_port_with_last(&root, 0);
        assert_eq!(port, 12345);
        assert!(note.is_none(), "正常文件不该有降级说明：{note:?}");

        fs::write(&path, b"{ not json at all").unwrap();
        let (port, note) = control_port_with_last(&root, 12345);
        assert_eq!(port, 12345, "必须退回上次成功的端口，而不是默认 8787");
        // 没有"上次成功"时退回内置默认端口（仍然要能连，而不是直接报错）
        let (dflt, note2) = control_port_with_last(&root, 0);
        assert_eq!(dflt, config::Settings::default().port);
        assert!(note2.is_some());
        let note = note.expect("降级必须带上原因");
        assert!(note.contains("settings.json"), "{note}");

        // 未知键不算降级：那正是修前会让 status/stop 全灭的输入。
        fs::write(
            &path,
            r#"{"port":13579,"refreshSeconds":60,"roots":{},"disabledAgents":[],"fromNewerVersion":true}"#,
        )
        .unwrap();
        let (port, note) = control_port_with_last(&root, 0);
        assert_eq!(port, 13579);
        assert!(note.is_none(), "未知键不该被当成配置错误：{note:?}");
        fs::remove_dir_all(&root).ok();
    }
}
