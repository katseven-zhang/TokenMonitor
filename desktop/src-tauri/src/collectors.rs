//! Read-only source adapters. Source-specific token semantics are normalized here, not in the UI.
use crate::model::{Activity, Event, Parsed, Quota, Tokens};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::Path,
    time::Duration,
};

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
        cache_write: number(v, "cache_creation_input_tokens"),
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
                        tokens = Some(if reset || previous.is_none() {
                            if info["last_token_usage"].is_object() {
                                openai(&info["last_token_usage"])
                            } else {
                                cur.clone()
                            }
                        } else {
                            previous
                                .as_ref()
                                .map(|prev| delta(&cur, prev))
                                .unwrap_or_else(|| cur.clone())
                        });
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
            "qoder" => {
                session = first(&[string(&rec, "sessionId"), string(&rec, "session_id")], &session);
                project = first(&[string(&rec, "cwd")], &project);
                if kind != "assistant" { continue; }
                let u = &msg["usage"];
                let model = string(msg, "model");
                if model == "<synthetic>" || !u.is_object() { continue; }
                let Some(credits) = u["credits"].as_f64().filter(|n| n.is_finite() && *n >= 0.0) else { continue; };
                let request_id = first(&[string(u, "request_id"), string(&rec["requestTokenAnchor"], "requestId")], "");
                if request_id.is_empty() { out.malformed_lines += 1; continue; }
                // Keep per-request timestamps and identity. Parent/sidechain/archive
                // copies are deduplicated globally before range filtering, not dropped.
                out.quotas.push(Quota {
                    agent: agent.into(), session: request_id.clone(), ts,
                    payload: json!({"session_id":session,"request_id":request_id,
                        "model":model,"project":project,"requests":1,"credits":credits,
                        "original_credits":u.get("original_credits"),
                        "billable_requests":u["billable"].as_bool().map(i64::from),
                        "context_usage_ratio":u.get("context_usage_ratio"),
                        "models":if model.is_empty() {json!({})} else {json!({model:1})},
                        "last_ts":ts}),
                });
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
/// 会话状态里的累计 token。**口径**：真机载荷把累计值放在 `total`
/// （`{latest, total:{…}, credits}`），且 `total.input_tokens` 已经把
/// `cache_read_input_tokens` 含在内（OpenAI 口径）——`usage` /
/// `total_token_usage` 与挂在 `data` 下的同名位置只作兼容候选。
/// 库内 `input` 列按 `docs/ARCHITECTURE.md` 只放"新输入"，故走 `openai()`
/// 拆成 新输入 / 缓存命中 两列：拆完 `total = input + cached + cache_write +
/// output` 恰等于真机的 `input_tokens + cache_creation + output_tokens`，
/// 缓存读不会被算两遍。`credits` 子对象是计费刻度而非 token 量，不作为候选。
fn qoder_state_tokens(v: &Value) -> Option<Tokens> {
    let candidates: Vec<&Value> = [
        v.get("total"),
        v.get("usage"),
        v.get("total_token_usage"),
        v.get("data").and_then(|d| d.get("total")),
        v.get("data").and_then(|d| d.get("usage")),
        v.get("data").and_then(|d| d.get("total_token_usage")),
        Some(v),
    ]
    .into_iter()
    .flatten()
    .filter(|c| c.is_object())
    .collect();
    for c in candidates {
        if ["input_tokens", "output_tokens"].iter().any(|k| c[*k].as_i64().is_none_or(|n|n<0)) {
            continue;
        }
        if ["cache_read_input_tokens","cache_creation_input_tokens","reasoning_output_tokens"].iter().any(|k| c.get(*k).is_some_and(|v|v.as_i64().is_none_or(|n|n<0))) {continue;}
        if number(c,"cache_read_input_tokens")>number(c,"input_tokens") {continue;}
        let t = openai(c);
        return Some(t); // A valid zero is a counter-reset watermark, not corrupt data.
    }
    None
}

/// Normalized plaintext cumulative usage; authenticated reading lives in qoder.rs.
pub fn parse_qoder_state(path: &str, text: &str) -> Parsed {
    let mut out = Parsed::default();
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        out.malformed_lines += 1; // 写一半/坏 JSON：降级，不抛
        return out;
    };
    let session = string(&v, "sessionId");
    if session.is_empty() {
        return out; // 不是会话状态（同名文件在别处也合法存在）
    }
    // 水位键：实测是 ISO 字符串，也容忍 epoch 数字——只认一种形态的代价是
    // 整源静默零事件（与 Node 的 stateWatermarkOf 同口径）
    let updated = match v.get("updatedAt") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    if updated.is_empty() {
        out.malformed_lines += 1; // 没有水位就无法判重
        return out;
    }
    let Some(tokens) = qoder_state_tokens(&v) else {
        out.malformed_lines += 1; // 密文载荷或字段缺失：按缺数据降级
        return out;
    };
    let ts = timestamp(&v["updatedAt"]).unwrap_or(0);
    if ts <= 0 {
        out.malformed_lines += 1;
        return out;
    }
    out.events.push(Event {
        id: format!("{session}|{updated}"),
        agent: "qoder".into(),
        session,
        project: first(&[string(&v, "cwd"), string(&v["data"], "cwd")], ""),
        model: first(&[string(&v, "model"), string(&v["data"], "model")], "unknown"),
        ts,
        tokens,
        path: path.into(),
        line: 0,
    });
    out
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
    db.execute_batch("BEGIN").map_err(|e|e.to_string())?;
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
    } else if agent == "opencode" || agent == "xiaomi-mimo" {
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
            let (id, session, time, data, project) = match row { Ok(row)=>row, Err(_)=>{out.malformed_lines+=1;continue;} };
            let Ok(v) = serde_json::from_str::<Value>(&data) else {
                out.malformed_lines += 1;
                continue;
            };
            if v["role"] != "assistant" {
                continue;
            }
            let t = &v["tokens"];
            if !t.is_object() { continue; }
            if ["input","output"].iter().any(|k| t[*k].as_i64().is_none_or(|n|n<0)) {out.malformed_lines+=1;continue;}
            let tokens = Tokens {
                input: number(t, "input"),
                cached: number(&t["cache"], "read"),
                cache_write: number(&t["cache"], "write"),
                // MiMo reasoning is additional to its raw output.
                output: number(t, "output") + if agent == "xiaomi-mimo" {number(t,"reasoning")} else {0},
                reasoning: number(t, "reasoning"),
            };
            if agent == "xiaomi-mimo" && t["total"].as_i64().is_some_and(|total| total>0 && total!=tokens.total()) {
                out.malformed_lines += 1;
                continue;
            }
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
pub fn read_antigravity(path: &Path, project: &str) -> Result<Parsed, String> {
    let db = readonly(path)?;
    let mut out = Parsed::default();
    let session = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let source = path.display().to_string();
    let mut times = BTreeMap::new();
    let mut stmt = db
        .prepare("SELECT idx,metadata FROM steps")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (idx, b) = row.map_err(|e| e.to_string())?;
        if let Ok(f) = fields(&b) {
            let t = nested(&f, 1);
            times.insert(idx, num(&t, 1) * 1000 + num(&t, 2) / 1_000_000);
        }
    }
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
{"timestamp":"2026-09-20T00:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}
{"timestamp":"2026-09-20T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}
{"timestamp":"2026-09-20T00:01:01Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":150,"cached_input_tokens":100,"output_tokens":40,"reasoning_output_tokens":15}}}}"#;
        let a = parse_jsonl("codex", "a.jsonl", s);
        let b = parse_jsonl("codex", "archive.jsonl", s);
        assert_eq!(a.events.len(), 2);
        assert_eq!(a.events[1].tokens.total(), 70);
        assert_eq!(a.events[1].model, "new-model");
        assert_eq!(a.events[0].id, b.events[0].id);
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

    #[test]
    fn qoder_transcript_feeds_credits_plane_never_token_events() {
        // 转录里 token 字段恒 0（真机即如此）：这一面只能进 credits 观测。
        let s = r#"{"type":"assistant","timestamp":1800000000000,"sessionId":"q-s","cwd":"D:\\我的 项目","message":{"model":"QF","usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0,"credits":0.25,"original_credits":0.25,"billable":true,"request_id":"r1","context_usage_ratio":0.2}}}
{"type":"assistant","timestamp":1800000001000,"sessionId":"q-s","message":{"model":"QF","usage":{"input_tokens":9999,"output_tokens":9999,"credits":0.25,"request_id":"r1"}}}
{"type":"assistant","timestamp":1800000002000,"sessionId":"q-s","isSidechain":true,"message":{"model":"QF","usage":{"credits":2,"request_id":"side1"}}}
{"type":"assistant","timestamp":1800000003000,"sessionId":"q-s","message":{"model":"<synthetic>","usage":{"credits":5,"request_id":"r2"}}}
{"type":"assistant","timestamp":1800000004000,"sessionId":"q-s","message":{"model":"QF","usage":{"credits":0.125}}}"#;
        let p = parse_jsonl("qoder", "q.jsonl", s);
        assert!(p.events.is_empty(), "credits 面不得产 token 事件");
        assert_eq!(p.quotas.len(), 3, "{:?}", p.quotas);
        let payload = &p.quotas[0].payload;
        assert_eq!(payload["requests"], 1, "{payload}");
        assert_eq!(payload["credits"], 0.25, "{payload}");
        assert_eq!(payload["billable_requests"], 1);
        assert_eq!(payload["context_usage_ratio"], 0.2);
        assert_eq!(payload["session_id"], "q-s");
        assert_eq!(payload["project"], "D:\\我的 项目");
        // 缺 request_id 的那条：想记而记不了，才是 health 的 warning
        assert_eq!(p.malformed_lines, 1, "{:?}", p.malformed_lines);
    }

    #[test]
    fn qoder_state_watermark_and_degradation() {
        // 真机口径：total.input_tokens 已含 cache_read ⇒ 入库拆成 新输入/缓存命中
        // （120 含 50 ⇒ 70/50/5/40 = 165，缓存不被算两遍）
        let plain = r#"{"sessionId":"q1","revision":3,"updatedAt":"2026-09-20T00:00:00Z","model":"m","cwd":"D:\\repo","total":{"input_tokens":120,"cache_read_input_tokens":50,"cache_creation_input_tokens":5,"output_tokens":40,"reasoning_output_tokens":10,"credits":{"used":0,"remaining":0}}}"#;
        let p = parse_qoder_state("state.json", plain);
        assert_eq!(p.events.len(), 1, "{:?}", p.events);
        assert_eq!(p.events[0].id, "q1|2026-09-20T00:00:00Z");
        assert_eq!(p.events[0].tokens.input, 70, "新输入必须扣掉已含的缓存读");
        assert_eq!(p.events[0].tokens.cached, 50);
        assert_eq!(p.events[0].tokens.cache_write, 5);
        assert_eq!(p.events[0].tokens.output, 40);
        assert_eq!(p.events[0].tokens.total(), 165);
        assert_eq!(p.events[0].tokens.reasoning, 10); // 单列，不重复计入 total
        assert!(p.events[0].ts > 0);
        assert_eq!(p.events[0].project, "D:\\repo");
        assert_eq!(p.malformed_lines, 0);
        // 兼容别名：早期版本把累计值放在 usage
        let alias = plain.replace("\"total\":", "\"usage\":");
        assert_eq!(
            parse_qoder_state("state.json", &alias).events[0]
                .tokens
                .total(),
            165
        );
        // 水位容忍 epoch 数字（只认 ISO 的后果是整源静默零事件）
        let epoch = r#"{"sessionId":"q1e","updatedAt":1790000000000,"total":{"input_tokens":30,"output_tokens":6}}"#;
        let e = parse_qoder_state("state.json", epoch);
        assert_eq!(e.events.len(), 1, "{:?}", e.malformed_lines);
        assert_eq!(e.events[0].id, "q1e|1790000000000");
        assert_eq!(e.events[0].tokens.total(), 36);

        // 真机形态：items.* 是 AES-GCM 密文。桌面端不碰密钥材料，只降级。
        let sealed = r#"{"sessionId":"q2","updatedAt":"2026-09-20T00:00:00Z","items":{"s0":{"n":"AAAAAAAAAAAAAAAA","p":"Qg==","t":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}}"#;
        let s = parse_qoder_state("state.json", sealed);
        assert!(s.events.is_empty());
        assert_eq!(s.malformed_lines, 1);

        // 坏 JSON / 缺水位 / 同名但非会话状态：都不抛，也不谎报降级
        assert_eq!(parse_qoder_state("x", "{\"sessionId\":").malformed_lines, 1);
        assert_eq!(parse_qoder_state("y", "{\"version\":2,\"state\":{}}").malformed_lines, 0);
        assert!(parse_qoder_state("y", "{\"version\":2,\"state\":{}}").events.is_empty());
        assert_eq!(
            parse_qoder_state("z", "{\"sessionId\":\"q3\"}").malformed_lines,
            1,
            "缺 updatedAt 就无法判重"
        );
    }
}
