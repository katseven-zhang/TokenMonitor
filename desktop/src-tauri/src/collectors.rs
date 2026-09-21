//! Read-only source adapters. Source-specific token semantics are normalized here, not in the UI.
use crate::model::{Activity, Event, Parsed, Quota, Tokens};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io::Read, path::Path, time::Duration};

pub fn timestamp(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_f64() {
        if !n.is_finite() || n <= 0.0 {
            return None;
        }
        return Some(if n < 100_000_000_000.0 {
            (n * 1000.0) as i64
        } else {
            n as i64
        });
    }
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis())
}
fn number(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0).max(0)
}
fn string(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}
fn first(values: &[String], fallback: &str) -> String {
    values
        .iter()
        .find(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| fallback.into())
}
fn openai(v: &Value) -> Tokens {
    let input = number(v, "input_tokens");
    let cached = number(v, "cached_input_tokens")
        .max(number(v, "cache_read_input_tokens"))
        .min(input);
    Tokens {
        input: input - cached,
        cached,
        // #75: 缓存写入在不同 codex 版本里写作 cache_creation_input_tokens 或
        // cache_write_input_tokens。此前本函数只认前者、Node 端 codex.js 只认后者，
        // 同一份日志两端恒有一边记 0。同一 payload 只会出一种，取 max = 有哪个读哪个。
        cache_write: number(v, "cache_creation_input_tokens")
            .max(number(v, "cache_write_input_tokens")),
        output: number(v, "output_tokens"),
        reasoning: number(v, "reasoning_output_tokens"),
    }
}
fn delta(current: &Tokens, previous: &Tokens) -> Tokens {
    let input = (current.input + current.cached - previous.input - previous.cached).max(0);
    let cached = (current.cached - previous.cached).clamp(0, input);
    Tokens {
        input: input - cached,
        cached,
        cache_write: (current.cache_write - previous.cache_write).max(0),
        output: (current.output - previous.output).max(0),
        reasoning: (current.reasoning - previous.reasoning).max(0),
    }
}
fn tool(
    out: &mut Parsed,
    agent: &str,
    session: &str,
    ts: i64,
    name: &str,
    id: &str,
    path: &str,
    line: usize,
) {
    if !name.is_empty() {
        out.activities.push(Activity {
            id: format!("{session}:{id}"),
            agent: agent.into(),
            session: session.into(),
            ts,
            name: name.into(),
            path: path.into(),
            line,
        });
    }
}
pub fn parse_jsonl(agent: &str, path: &str, text: &str) -> Parsed {
    let mut out = Parsed::default();
    let mut model = "unknown".to_string();
    let mut project = String::new();
    let mut session = Path::new(path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    if agent == "grok" || agent == "dsh" {
        session = Path::new(path)
            .parent()
            .and_then(Path::file_name)
            .unwrap_or_default()
            .to_string_lossy()
            .into();
    }
    if agent == "workbuddy" {
        project = Path::new(path)
            .parent()
            .and_then(Path::file_name)
            .unwrap_or_default()
            .to_string_lossy()
            .into();
    }
    if agent == "grok" {
        project = Path::new(path)
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .map(|p| {
                percent_encoding::percent_decode_str(&p.to_string_lossy())
                    .decode_utf8_lossy()
                    .into_owned()
            })
            .unwrap_or_default();
    }
    let mut previous: Option<Tokens> = None;
    for (index, line) in text.split_inclusive('\n').enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let rec: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                // An invalid unterminated tail may still be written. Only complete
                // records are known malformed; reparse the tail when the file changes.
                if line.ends_with('\n') { out.malformed_lines += 1; }
                continue;
            }
        };
        let kind = rec["type"].as_str().unwrap_or("");
        let p = &rec["payload"];
        if kind == "session_meta" {
            session = first(&[string(p, "id"), string(p, "session_id")], &session);
            project = first(&[string(p, "cwd")], &project);
        }
        if kind == "session" {
            session = first(&[string(&rec, "id")], &session);
            project = first(&[string(&rec, "cwd")], &project);
        }
        if kind == "turn_context" {
            model = first(&[string(p, "model")], &model);
            project = first(&[string(p, "cwd")], &project);
        }
        if p["type"] == "thread_settings_applied" {
            model = first(&[string(&p["thread_settings"], "model")], &model);
        }
        if kind == "request/header" {
            model = first(&[string(&rec["data"]["header"]["config"], "model")], &model);
        }
        let msg = &rec["message"];
        if out.title.is_none()
            && (kind == "user" || p["type"] == "user_message" || msg["role"] == "user")
        {
            let title = first(
                &[
                    string(p, "message"),
                    string(msg, "content"),
                    msg["content"][0]["text"].as_str().unwrap_or("").into(),
                ],
                "",
            );
            if !title.is_empty() {
                out.title = Some(title.chars().take(180).collect());
            }
        }
        let Some(ts) = timestamp(&rec["timestamp"])
            .or_else(|| timestamp(&rec["time"]))
            .or_else(|| timestamp(&msg["timestamp"]))
        else {
            continue;
        };
        let mut tokens = None;
        let mut key = format!("line:{}", index + 1);
        match agent {
            "codex" => {
                if p["type"] == "function_call" || p["type"] == "custom_tool_call" {
                    tool(
                        &mut out,
                        agent,
                        &session,
                        ts,
                        &string(p, "name"),
                        &first(&[string(p, "call_id")], &key),
                        path,
                        index + 1,
                    );
                }
                if p["type"] == "token_count" {
                    if p["rate_limits"].is_object() {
                        out.quotas.push(Quota {
                            agent: agent.into(),
                            session: session.clone(),
                            ts,
                            payload: p["rate_limits"].clone(),
                        });
                    }
                    let info = &p["info"];
                    model = first(&[string(info, "model")], &model);
                    if info["total_token_usage"].is_object() {
                        let cur = openai(&info["total_token_usage"]);
                        if previous.as_ref() == Some(&cur) {
                            continue;
                        }
                        let reset = previous.as_ref().is_some_and(|prev| {
                            cur.input + cur.cached < prev.input + prev.cached
                                || cur.output < prev.output
                        });
                        // #75 与 Node 端 codex.js 对齐：首个采样与累计值回落都不能用差分，
                        // 也都不能把整段累计值当单次用量 —— resume/fork 会话继承了父线程的
                        // 累计基线，记整段会把父会话重复计入（docs/ARCHITECTURE.md Codex 段
                        // 实测 9 倍）。只认 info.last_token_usage（本轮真实用量）；它缺失时
                        // 宁可不记（修前这里退回 cur.clone()）。
                        tokens = if previous.is_none() || reset {
                            info.get("last_token_usage")
                                .filter(|v| v.is_object())
                                .map(openai)
                        } else {
                            previous.as_ref().map(|prev| delta(&cur, prev))
                        };
                        key = format!(
                            "{session}:{ts}:{}:{}:{}",
                            cur.total(),
                            cur.cached,
                            cur.reasoning
                        );
                        previous = Some(cur);
                    } else if info["last_token_usage"].is_object() {
                        tokens = Some(openai(&info["last_token_usage"]));
                        key = format!("{session}:{ts}:{}", info["last_token_usage"]);
                    }
                }
            }
            "claude-code" | "ccmr" => {
                session = first(
                    &[string(&rec, "sessionId"), string(&rec, "session_id")],
                    &session,
                );
                project = first(&[string(&rec, "cwd")], &project);
                if kind != "assistant" {
                    continue;
                }
                model = first(&[string(msg, "model")], "unknown");
                if model == "<synthetic>" {
                    continue;
                }
                if let Some(blocks) = msg["content"].as_array() {
                    for b in blocks {
                        if b["type"] == "tool_use" {
                            tool(
                                &mut out,
                                agent,
                                &session,
                                ts,
                                &string(b, "name"),
                                &string(b, "id"),
                                path,
                                index + 1,
                            );
                        }
                    }
                }
                let u = &msg["usage"];
                if u.is_object() {
                    tokens = Some(Tokens {
                        input: number(u, "input_tokens"),
                        cached: number(u, "cache_read_input_tokens"),
                        cache_write: number(u, "cache_creation_input_tokens"),
                        output: number(u, "output_tokens"),
                        reasoning: number(&u["output_tokens_details"], "thinking_tokens"),
                    });
                    key = first(
                        &[string(msg, "id")],
                        &format!("{session}:{ts}:{}", index + 1),
                    );
                    key.push_str(&string(&rec, "requestId"));
                }
            }
            "workbuddy" => {
                session = first(&[string(&rec, "sessionId")], &session);
                if kind == "function_call" {
                    tool(
                        &mut out,
                        agent,
                        &session,
                        ts,
                        &string(&rec, "name"),
                        &string(&rec, "callId"),
                        path,
                        index + 1,
                    );
                }
                if msg["usage"].is_object() {
                    tokens = Some(openai(&msg["usage"]));
                    model = first(&[string(&rec["providerData"], "model")], "unknown");
                    key = first(
                        &[string(&rec, "id")],
                        &format!("{session}:{ts}:{}", index + 1),
                    );
                }
            }
            "pi" => {
                if kind != "message" || msg["role"] != "assistant" {
                    continue;
                }
                if let Some(blocks) = msg["content"].as_array() {
                    for b in blocks {
                        if b["type"] == "toolCall" {
                            tool(
                                &mut out,
                                agent,
                                &session,
                                ts,
                                &string(b, "name"),
                                &string(b, "id"),
                                path,
                                index + 1,
                            );
                        }
                    }
                }
                let u = &msg["usage"];
                if u.is_object() {
                    tokens = Some(Tokens {
                        input: number(u, "input"),
                        cached: number(u, "cacheRead"),
                        cache_write: number(u, "cacheWrite"),
                        output: number(u, "output"),
                        reasoning: number(u, "reasoning"),
                    });
                    model = first(&[string(msg, "model")], "unknown");
                    key = format!(
                        "{session}:{}",
                        first(
                            &[string(&rec, "id"), string(msg, "responseId")],
                            &format!("{ts}:{}", index + 1)
                        )
                    );
                }
            }
            "dsh" => {
                let data = &rec["data"];
                let u = if kind == "assistant/message" {
                    &data["usage"]
                } else if kind == "assistant/chunk" && data["chunk"]["type"] == "usage" {
                    &data["chunk"]["usage"]
                } else {
                    continue;
                };
                if u.is_object() {
                    tokens = Some(Tokens {
                        input: number(u, "inputTokens"),
                        cached: number(u, "cacheReadTokens"),
                        cache_write: number(u, "cacheWriteTokens"),
                        output: number(u, "outputTokens"),
                        reasoning: number(u, "reasoningTokens"),
                    });
                    model = first(&[string(&data["message"]["source"], "model")], &model);
                    key = format!(
                        "{session}:{}:{}",
                        Path::new(path)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy(),
                        rec["seq"]
                    );
                }
            }
            "grok" => {
                let params = &rec["params"];
                let upd = &params["update"];
                session = first(&[string(params, "sessionId")], &session);
                if upd["sessionUpdate"] == "tool_call" {
                    tool(
                        &mut out,
                        agent,
                        &session,
                        ts,
                        &first(&[string(upd, "title"), string(upd, "kind")], "tool"),
                        &string(upd, "toolCallId"),
                        path,
                        index + 1,
                    );
                }
                if upd["sessionUpdate"] != "turn_completed" {
                    continue;
                }
                let u = &upd["usage"];
                let by_model = u["modelUsage"].as_object();
                let models: Vec<(String, &Value)> = by_model
                    .map(|m| m.iter().map(|(k, v)| (k.clone(), v)).collect())
                    .unwrap_or_else(|| vec![("grok".into(), u)]);
                for (m, u) in models {
                    let input = number(u, "inputTokens");
                    let cached = number(u, "cachedReadTokens").min(input);
                    let t = Tokens {
                        input: input - cached,
                        cached,
                        cache_write: number(u, "cacheCreationTokens"),
                        output: number(u, "outputTokens"),
                        reasoning: number(u, "reasoningTokens"),
                    };
                    if t.total() > 0 {
                        out.events.push(Event {
                            id: format!(
                                "{session}:{}:{m}",
                                upd.get("prompt_id").cloned().unwrap_or(json!(ts))
                            ),
                            agent: agent.into(),
                            session: session.clone(),
                            project: project.clone(),
                            model: m,
                            ts,
                            tokens: t,
                            path: path.into(),
                            line: index + 1,
                        });
                    }
                }
            }
            _ => {}
        }
        if let Some(t) = tokens {
            if t.total() > 0 {
                out.events.push(Event {
                    id: key,
                    agent: agent.into(),
                    session: session.clone(),
                    project: project.clone(),
                    model: model.clone(),
                    ts,
                    tokens: t,
                    path: path.into(),
                    line: index + 1,
                });
            }
        }
    }
    out
}
pub fn read_jsonl(agent: &str, path: &Path) -> Result<Parsed, String> {
    let mut bytes = Vec::new();
    if agent == "dsh" && path.extension().is_some_and(|e| e == "zstd" || e == "zst") {
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut decoder = zstd::stream::read::Decoder::new(file).map_err(|e| e.to_string())?;
        // Complete frames remain usable if the writer has not finished its last frame.
        if let Err(e) = decoder.read_to_end(&mut bytes) {
            if bytes.is_empty() {
                return Err(e.to_string());
            }
        }
    } else {
        bytes = fs::read(path).map_err(|e| e.to_string())?;
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text,
        // A live writer may be between bytes of a UTF-8 character. Keep complete records;
        // the changed file fingerprint will cause the completed tail to be read next scan.
        Err(e) if e.error_len().is_none() => {
            std::str::from_utf8(&bytes[..e.valid_up_to()]).map_err(|e| e.to_string())?
        }
        Err(e) => return Err(format!("日志不是有效 UTF-8：{e}")),
    };
    Ok(parse_jsonl(agent, &path.display().to_string(), text))
}
fn readonly(path: &Path) -> Result<Connection, String> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    Ok(db)
}
pub fn read_sqlite(agent: &str, path: &Path) -> Result<Parsed, String> {
    let db = readonly(path)?;
    let mut out = Parsed::default();
    let source = path.display().to_string();
    if agent == "zcode" {
        let mut stmt=db.prepare("SELECT u.id,u.session_id,u.model_id,u.started_at,u.input_tokens,u.output_tokens,u.reasoning_tokens,u.cache_creation_input_tokens,u.cache_read_input_tokens,COALESCE(s.directory,'') FROM model_usage u LEFT JOIN session s ON s.id=u.session_id").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                let input: i64 = r.get::<_, Option<i64>>(4)?.unwrap_or(0).max(0);
                let cached = r.get::<_, Option<i64>>(8)?.unwrap_or(0).clamp(0, input);
                Ok(Event {
                    id: r.get(0)?,
                    agent: agent.into(),
                    session: r.get(1)?,
                    model: r.get(2)?,
                    ts: r.get(3)?,
                    project: r.get(9)?,
                    tokens: Tokens {
                        input: input - cached,
                        cached,
                        output: r.get::<_, Option<i64>>(5)?.unwrap_or(0).max(0),
                        reasoning: r.get::<_, Option<i64>>(6)?.unwrap_or(0).max(0),
                        cache_write: r.get::<_, Option<i64>>(7)?.unwrap_or(0).max(0),
                    },
                    path: source.clone(),
                    line: 0,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let event = row.map_err(|e| e.to_string())?;
            // Empty/in-progress rows are not usage requests, as in the other adapters.
            if event.tokens.total() > 0 {
                out.events.push(event);
            }
        }
        let mut stmt = db
            .prepare("SELECT rowid,session_id,tool_name,started_at FROM tool_usage")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, s, n, t) = row.map_err(|e| e.to_string())?;
            tool(&mut out, agent, &s, t, &n, &id.to_string(), &source, 0);
        }
    } else if agent == "opencode" {
        let mut stmt=db.prepare("SELECT m.id,m.session_id,m.time_created,m.data,COALESCE(s.directory,'') FROM message m LEFT JOIN session s ON s.id=m.session_id").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, session, time, data, project) = row.map_err(|e| e.to_string())?;
            let Ok(v) = serde_json::from_str::<Value>(&data) else {
                out.malformed_lines += 1;
                continue;
            };
            if v["role"] != "assistant" {
                continue;
            }
            let t = &v["tokens"];
            let tokens = Tokens {
                input: number(t, "input"),
                cached: number(&t["cache"], "read"),
                cache_write: number(&t["cache"], "write"),
                output: number(t, "output"),
                reasoning: number(t, "reasoning"),
            };
            if tokens.total() > 0 {
                out.events.push(Event {
                    id,
                    agent: agent.into(),
                    session,
                    project,
                    model: first(&[string(&v, "modelID")], "unknown"),
                    ts: timestamp(&v["time"]["created"]).unwrap_or(time),
                    tokens,
                    path: source.clone(),
                    line: 0,
                });
            }
        }
        let mut stmt = db
            .prepare("SELECT id,session_id,time_created,data FROM part")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, s, t, d) = row.map_err(|e| e.to_string())?;
            if let Ok(v) = serde_json::from_str::<Value>(&d) {
                if v["type"] == "tool" {
                    tool(
                        &mut out,
                        agent,
                        &s,
                        t,
                        &string(&v, "tool"),
                        &first(&[string(&v, "callID")], &id),
                        &source,
                        0,
                    );
                }
            }
        }
    } else {
        return Err(format!("SQLite adapter missing for {agent}"));
    }
    Ok(out)
}

#[derive(Clone)]
enum Field {
    Num(u64),
    Bytes(Vec<u8>),
}
fn varint(data: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut n = 0;
    for shift in (0..=63).step_by(7) {
        let b = *data.get(*pos).ok_or("截断的protobuf")?;
        *pos += 1;
        if shift == 63 && b > 1 {
            return Err("protobuf溢出".into());
        }
        n |= u64::from(b & 127) << shift;
        if b & 128 == 0 {
            return Ok(n);
        }
    }
    Err("protobuf溢出".into())
}
fn fields(data: &[u8]) -> Result<BTreeMap<u64, Field>, String> {
    let mut out = BTreeMap::new();
    let mut p = 0;
    while p < data.len() {
        let tag = varint(data, &mut p)?;
        let field = match tag & 7 {
            0 => Field::Num(varint(data, &mut p)?),
            2 => {
                let len = usize::try_from(varint(data, &mut p)?).map_err(|e| e.to_string())?;
                let end = p.checked_add(len).ok_or("protobuf长度溢出")?;
                let v = data.get(p..end).ok_or("截断的protobuf")?.to_vec();
                p = end;
                Field::Bytes(v)
            }
            1 | 5 => {
                let end = p + if tag & 7 == 1 { 8 } else { 4 };
                let v = data.get(p..end).ok_or("截断的protobuf")?.to_vec();
                p = end;
                Field::Bytes(v)
            }
            _ => return Err("未知protobuf类型".into()),
        };
        out.insert(tag >> 3, field);
    }
    Ok(out)
}
fn nested(f: &BTreeMap<u64, Field>, key: u64) -> BTreeMap<u64, Field> {
    match f.get(&key) {
        Some(Field::Bytes(b)) => fields(b).unwrap_or_default(),
        _ => BTreeMap::new(),
    }
}
fn num(f: &BTreeMap<u64, Field>, key: u64) -> i64 {
    match f.get(&key) {
        Some(Field::Num(n)) => i64::try_from(*n).unwrap_or(0),
        _ => 0,
    }
}
/// steps.metadata 提供的步级时间（idx → ms）。本机 build 的生成行内没有 wall-clock，
/// 时间只能来自这里（与 Node 端 stepTimestampMs 同一路径 1.1/1.2）。
fn step_times(db: &Connection) -> rusqlite::Result<BTreeMap<i64, i64>> {
    let mut stmt = db.prepare("SELECT idx,metadata FROM steps")?;
    let mut rows =
        stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
    let mut out = BTreeMap::new();
    while let Some(row) = rows.next() {
        let (idx, b) = row?;
        if let Ok(f) = fields(&b) {
            let t = nested(&f, 1);
            out.insert(idx, num(&t, 1) * 1000 + num(&t, 2) / 1_000_000);
        }
    }
    Ok(out)
}
pub fn read_antigravity(path: &Path, project: &str) -> Result<Parsed, String> {
    let db = readonly(path)?;
    let mut out = Parsed::default();
    let session = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let source = path.display().to_string();
    // #95：steps 表被改走（schema 漂移）只意味着"没有步级时间"，不能让整库解析失败 ——
    // 修前这里的 `?` 会把该源永久标成 error（一个漂移的会话库 = 整源再不出数）。
    // 锁/IO 一类的暂时性失败仍然上报：那种情况下缓存里已有的事件必须原样保留、
    // 下一轮重读，绝不能用一份读不全的结果去替换它。
    let times = match step_times(&db) {
        Ok(t) => t,
        Err(e) if e.to_string().contains("no such table") => BTreeMap::new(),
        Err(e) => return Err(e.to_string()),
    };
    let mut stmt = db
        .prepare("SELECT idx,data FROM gen_metadata")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (idx, b) = row.map_err(|e| e.to_string())?;
        let Ok(f) = fields(&b) else {
            out.malformed_lines += 1;
            continue;
        };
        let gen = nested(&f, 1);
        let u = nested(&gen, 4);
        let t = nested(&nested(&gen, 9), 4);
        let ts = (num(&t, 1) * 1000 + num(&t, 2) / 1_000_000).max(*times.get(&idx).unwrap_or(&0));
        if ts <= 0 {
            out.malformed_lines += 1;
            continue;
        }
        let tokens = Tokens {
            input: num(&u, 2),
            cached: num(&u, 5),
            cache_write: num(&u, 4),
            output: if u.contains_key(&3) {
                num(&u, 3)
            } else {
                num(&u, 9) + num(&u, 10)
            },
            reasoning: num(&u, 9),
        };
        let model = match gen.get(&19) {
            Some(Field::Bytes(b)) => String::from_utf8_lossy(b).into(),
            _ => "unknown".into(),
        };
        if tokens.total() > 0 {
            out.events.push(Event {
                id: format!("{session}:{idx}"),
                agent: "antigravity".into(),
                session: session.clone(),
                project: project.into(),
                model,
                ts,
                tokens,
                path: source.clone(),
                line: 0,
            });
        }
    }
    Ok(out)
}
pub fn antigravity_projects(index: &Path) -> Result<BTreeMap<String, String>, String> {
    let db = readonly(index)?;
    let mut stmt = db
        .prepare("SELECT conversation_id,workspace_uris FROM conversation_summaries")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (id, s) = row.map_err(|e| e.to_string())?;
        let v = serde_json::from_str::<Value>(&s).unwrap_or_default();
        let uri = v[0].as_str().unwrap_or("");
        out.insert(
            id,
            percent_encoding::percent_decode_str(uri.trim_start_matches("file:///"))
                .decode_utf8_lossy()
                .into_owned(),
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_correction_cannot_inflate_cumulative_delta() {
        let prev = Tokens {
            input: 80,
            cached: 20,
            output: 10,
            ..Default::default()
        };
        let now = Tokens {
            input: 70,
            cached: 50,
            output: 15,
            ..Default::default()
        };
        let change = delta(&now, &prev);
        assert_eq!(change.total(), 25);
        assert_eq!(change.cached, 20);
        assert_eq!(change.input, 0);
    }
    #[test]
    fn partial_utf8_tail_preserves_prior_records() {
        let path = std::env::temp_dir().join(format!("tm-tail-{}.jsonl", uuid::Uuid::new_v4()));
        let line = r#"{"type":"assistant","timestamp":1800000000000,"message":{"id":"m","model":"m","usage":{"input_tokens":10,"output_tokens":5}}}"#;
        let mut bytes = format!("{line}\n{{\"content\":\"").into_bytes();
        bytes.extend_from_slice(&[0xe4, 0xb8]);
        fs::write(&path, bytes).unwrap();
        let parsed = read_jsonl("claude-code", &path).unwrap();
        assert_eq!(parsed.events.len(), 1);
        assert_eq!(parsed.events[0].tokens.total(), 15);
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn codex_cumulative_duplicates_model_switch_and_archive_identity() {
        let s = r#"{"type":"session_meta","payload":{"id":"same","cwd":"D:\\repo"}}
{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"new-model"}}}
{"timestamp":"2026-09-20T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10},"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}
{"timestamp":"2026-09-20T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10},"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}
{"timestamp":"2026-09-20T00:01:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":150,"cached_input_tokens":100,"output_tokens":40,"reasoning_output_tokens":15},"last_token_usage":{"input_tokens":50,"cached_input_tokens":20,"output_tokens":20,"reasoning_output_tokens":5}}}}"#;
        let a = parse_jsonl("codex", "a.jsonl", s);
        let b = parse_jsonl("codex", "archive.jsonl", s);
        assert_eq!(a.events.len(), 2);
        assert_eq!(a.events[1].tokens.total(), 70);
        assert_eq!(a.events[1].model, "new-model");
        assert_eq!(a.events[0].id, b.events[0].id);
    }
    /// #75 双端黄金数。同一份 JSONL 与同样的期望也写在 Node 端
    /// `test/run.mjs` 的 [17] 段（`#75` 块），两端任一改动都会同时变红。
    /// events = [125, 70, 85, 52]（重复通知那条不产事件），缺 last_token_usage 的
    /// 孤立首采样不产事件。
    #[test]
    fn codex_baseline_reset_and_cache_write_match_node_golden_numbers() {
        const F: &str = r#"{"timestamp":"2026-09-20T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"cache_write_input_tokens":5,"output_tokens":20,"reasoning_output_tokens":10,"total_tokens":120},"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"cache_write_input_tokens":5,"output_tokens":20,"reasoning_output_tokens":10}}}}
{"timestamp":"2026-09-20T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"cache_write_input_tokens":5,"output_tokens":20,"reasoning_output_tokens":10,"total_tokens":120},"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"cache_write_input_tokens":5,"output_tokens":20,"reasoning_output_tokens":10}}}}
{"timestamp":"2026-09-20T00:00:03Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":150,"cached_input_tokens":100,"cache_write_input_tokens":5,"output_tokens":40,"reasoning_output_tokens":15,"total_tokens":190},"last_token_usage":{"input_tokens":50,"cached_input_tokens":20,"output_tokens":20,"reasoning_output_tokens":5}}}}
{"timestamp":"2026-09-20T00:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":60,"cached_input_tokens":40,"output_tokens":25,"reasoning_output_tokens":8,"total_tokens":85},"last_token_usage":{"input_tokens":60,"cached_input_tokens":40,"output_tokens":25,"reasoning_output_tokens":8}}}}
{"timestamp":"2026-09-20T00:00:05Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"cache_creation_input_tokens":7,"output_tokens":30,"reasoning_output_tokens":10,"total_tokens":130},"last_token_usage":{"input_tokens":40,"cached_input_tokens":0,"cache_creation_input_tokens":2,"output_tokens":5,"reasoning_output_tokens":2}}}}"#;
        let p = parse_jsonl("codex", "parity.jsonl", F);
        let totals: Vec<i64> = p.events.iter().map(|e| e.tokens.total()).collect();
        assert_eq!(totals, vec![125, 70, 85, 52], "{:?}", p.events);
        // 首个采样 = 本轮 last_token_usage，含 cache_write_input_tokens（旧版字段名）
        let first = &p.events[0].tokens;
        assert_eq!(
            (first.input, first.cached, first.cache_write, first.output, first.reasoning),
            (20, 80, 5, 20, 10)
        );
        // 回落（压缩/resume）取本轮真实用量，不重记累计值：20+40+0+25
        assert_eq!(p.events[2].tokens.total(), 85);
        assert_eq!(p.events[2].tokens.input, 20);
        assert_eq!(p.events[2].tokens.cached, 40);
        // 稳态差分同时认两种 cache_write 拼写：40+0+7+5
        assert_eq!(p.events[3].tokens.cache_write, 7);
        assert_eq!(p.events[3].tokens.cached, 0);
        // 只有累计值、没有 last_token_usage 的孤立首采样：宁可不记
        let alone = parse_jsonl(
            "codex",
            "solo.jsonl",
            r#"{"timestamp":"2026-09-20T00:00:06Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":500,"cached_input_tokens":400,"output_tokens":100,"reasoning_output_tokens":50}}}}"#,
        );
        assert!(alone.events.is_empty(), "{:?}", alone.events);
    }
    #[test]
    fn anthropic_reasoning_is_not_double_counted() {
        let p = parse_jsonl(
            "claude-code",
            "a.jsonl",
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"id":"m","model":"claude","usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":40,"output_tokens_details":{"thinking_tokens":25}}}}"#,
        );
        assert_eq!(p.events[0].tokens.total(), 100);
    }
    #[test]
    fn malformed_rows_do_not_drop_good_rows() {
        let p = parse_jsonl("pi", "p.jsonl", "bad\n{\"type\":\"session\"}");
        assert_eq!(p.malformed_lines, 1);
    }
    /// #95（桌面侧对偶）：steps 表被改走时必须降级为"没有步级时间"，
    /// 能定时的生成照常入库，定不了时的按 malformed 计，整库解析仍返回 Ok。
    #[test]
    fn antigravity_missing_steps_table_degrades_instead_of_failing() {
        fn var(mut n: u64) -> Vec<u8> {
            let mut out = vec![];
            while n >= 128 {
                out.push((n as u8 & 127) | 128);
                n >>= 7;
            }
            out.push(n as u8);
            out
        }
        fn number(field: u64, n: u64) -> Vec<u8> {
            [var(field << 3), var(n)].concat()
        }
        fn blob(field: u64, b: &[u8]) -> Vec<u8> {
            [var((field << 3) | 2), var(b.len() as u64), b.to_vec()].concat()
        }
        let path = std::env::temp_dir().join(format!("tm-agy-{}.db", uuid::Uuid::new_v4()));
        let _ = fs::remove_file(&path);
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);",
            )
            .unwrap();
            let usage = [number(2, 100), number(3, 80)].concat();
            let timed = blob(
                1,
                &[
                    blob(4, &usage),
                    blob(19, b"m"),
                    blob(9, &blob(4, &[number(1, 1_800_000_000), number(2, 500_000_000)].concat())),
                ]
                .concat(),
            );
            let untimed = blob(1, &[blob(4, &usage), blob(19, b"m")].concat());
            db.execute("INSERT INTO gen_metadata VALUES(1,?1)", [&timed])
                .unwrap();
            db.execute("INSERT INTO gen_metadata VALUES(2,?1)", [&untimed])
                .unwrap();
        }
        let parsed = read_antigravity(&path, "proj").expect("steps 缺失不是解析失败");
        assert_eq!(parsed.events.len(), 1, "{:?}", parsed.events);
        assert_eq!(parsed.events[0].ts, 1_800_000_000_500);
        assert_eq!(parsed.events[0].tokens.total(), 180);
        assert_eq!(parsed.malformed_lines, 1);
        fs::remove_file(path).unwrap();
    }
}
