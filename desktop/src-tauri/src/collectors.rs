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
    // #71: token 字段被序列化成浮点（1000000.0、5e3）时 as_i64 返回 None，整列
    // 静默归零。有限浮点按向下取整接受；负数、NaN、无穷一律按 0（与旧行为一致，
    // 宁少不多）。
    let field = v.get(key);
    let raw = field
        .and_then(Value::as_i64)
        .or_else(|| {
            field
                .and_then(Value::as_f64)
                .filter(|f| f.is_finite())
                .map(|f| f.floor().max(0.0) as i64)
        })
        .unwrap_or(0);
    raw.max(0)
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
    // #71: Windows 工具写出的 JSONL 可能带 UTF-8 BOM。它只污染第一条记录——
    // 通常正是 session_meta——丢会话身份/项目归属，还把整行计成畸形行。
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Parsed::default();
    // #71: codex 在每条 token_count 里重复携带相同的 rate_limits 快照，长会话
    // 会把 quota 表灌成同一快照的成百行副本。按 (session, payload) 与上一条
    // 观测比较，重复快照不再入库（跨归档副本的 DISTINCT 见 query.rs）。
    let mut last_quota: BTreeMap<String, Value> = BTreeMap::new();
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
                        let limits = &p["rate_limits"];
                        if last_quota.get(&session).is_none_or(|prev| prev != limits) {
                            last_quota.insert(session.clone(), limits.clone());
                            out.quotas.push(Quota {
                                agent: agent.into(),
                                session: session.clone(),
                                ts,
                                payload: limits.clone(),
                            });
                        }
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
/// #111：dsh 的压缩帧判定，**大小写不敏感**（Windows 文件系统本身就不区分）。
/// 扫描器的入选条件与这里的解码分支共用这一个函数，避免两处各写一遍再走岔：
/// 修前扫描器用 `ext == "zstd"`、这里也用 `== "zstd"`，`.ZSTD` 在两道都被当成别的文件。
pub fn is_dsh_zstd_ext(ext: &std::ffi::OsStr) -> bool {
    ext.eq_ignore_ascii_case("zstd") || ext.eq_ignore_ascii_case("zst")
}

/// #109：把文件字节按行解码成可解析的文本。
///
/// 修前只有两条出路：整段 `from_utf8` 成功，或者——只要**中间**出现一个非法字节
/// （`error_len().is_some()`）——整个文件返回 Err。后果不是"这一行丢了"，而是
/// `collect_file` 失败 → 该 agent 整体 `state=error` → **这个来源的数据永久冻结**，
/// 每轮扫描都重复整文件失败（Node 遗留端是按行丢坏行继续，两侧容错口径漂移，
/// 且桌面端失败半径大得多）。
///
/// 现在按行处理，三条规则：
/// 1. 整段合法 UTF-8 → 零拷贝原样返回（绝大多数情况，无额外开销）；
/// 2. 中间某行含非法字节 → 该行按 lossy 替换后保留，`parse_jsonl` 会把它计成
///    `malformed_lines`（坏数据要**可见**，不能悄悄跳过），其余行照常入库；
/// 3. 末行没有结尾换行且自身 UTF-8 不合法 → 判定为"写方正在写半个字符"，
///    整行丢掉等下一轮（与修前 `error_len().is_none()` 分支同一条语义：
///    半行不推进、不把还在写的内容计成畸形行）。
pub fn decode_jsonl_bytes(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return std::borrow::Cow::Borrowed(text);
    }
    let lines: Vec<&[u8]> = bytes.split(|b| *b == b'\n').collect();
    let last = lines.len() - 1;
    let mut out = String::with_capacity(bytes.len());
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        match std::str::from_utf8(line) {
            Ok(text) => out.push_str(text),
            Err(e) => {
                // 规则 3：末段且是"截断"（error_len 为 None = 尾部不完整）→ 丢掉这一行，
                // 等下一轮写完整了再读；中间段的截断不可能出现，所以不必额外判 i。
                if e.error_len().is_none() && i == last {
                    out.truncate(out.len() - 1); // 收回刚写的分隔符
                    continue;
                }
                out.push_str(&String::from_utf8_lossy(line));
            }
        }
    }
    std::borrow::Cow::Owned(out)
}

pub fn read_jsonl(agent: &str, path: &Path) -> Result<Parsed, String> {
    let mut bytes = Vec::new();
    if agent == "dsh" && path.extension().is_some_and(is_dsh_zstd_ext) {
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
    let text = decode_jsonl_bytes(&bytes);
    Ok(parse_jsonl(agent, &path.display().to_string(), &text))
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
    /// Codex 的一条 `token_count` 快照，#71 的去重用例与 #82 的入库用例共用同一
    /// 份夹具形状：前者钉"重复快照不重插"，后者钉"抽出来的 rate_limits 真的落进
    /// quota 表"。`window` 这个嵌套对象是故意的——它用来证明 payload 是原样落库、
    /// 没有在入库路上被削平。
    fn rate_limit_line(used: u32, ts: &str) -> String {
        format!(r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"token_count","rate_limits":{{"used_percent":{used},"window":{{"kind":"week","limit_seconds":1800}}}},"info":{{"last_token_usage":{{"input_tokens":1,"output_tokens":0}}}}}}}}"#)
    }
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
    /// #71: BOM 只污染第一条记录——通常正是 session_meta。修前那行整体解析
    /// 失败：会话身份退回文件名、项目丢失，还多计一条畸形行。
    #[test]
    fn bom_does_not_swallow_the_first_record() {
        let text = "\u{feff}{\"type\":\"session_meta\",\"payload\":{\"id\":\"bom-session\",\"cwd\":\"Q:/fixture\"}}\n{\"timestamp\":\"2026-09-20T00:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":10,\"output_tokens\":5}}}}\n";
        let p = parse_jsonl("codex", "b.jsonl", text);
        assert_eq!(p.malformed_lines, 0, "BOM 行不得计成畸形行");
        assert_eq!(p.events.len(), 1);
        assert_eq!(p.events[0].session, "bom-session");
        assert_eq!(p.events[0].project, "Q:/fixture");
    }
    /// #71: 浮点 token 字段（JS/Python 写手把 1000000 序列化成 1000000.0、5e3）
    /// 修前 as_i64→None，整列静默归零。现在向下取整接受；负数照旧钳 0（宁少不多）。
    #[test]
    fn float_token_fields_are_read_not_silently_zeroed() {
        let p = parse_jsonl(
            "claude-code",
            "f.jsonl",
            r#"{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"id":"m","model":"claude","usage":{"input_tokens":1000000.9,"cache_read_input_tokens":5e3,"cache_creation_input_tokens":-7,"output_tokens":40.0}}}"#,
        );
        assert_eq!(p.events.len(), 1);
        let t = &p.events[0].tokens;
        assert_eq!(t.input, 1_000_000, "1000000.9 → 1000000（向下取整）");
        assert_eq!(t.cached, 5_000, "5e3 → 5000");
        assert_eq!(t.cache_write, 0, "负数仍按 0");
        assert_eq!(t.output, 40);
    }
    /// #71: codex 在每条 token_count 里重复携带相同 rate_limits 快照，修前长
    /// 会话会往 quota 表灌成百条一模一样的行，面板"最新 100 条配额"全是副本。
    /// 载荷与同会话上一条观测相同就不再入库；载荷一变（10%→11%）立刻新的一行。
    #[test]
    fn repeated_quota_snapshots_are_not_reinserted() {
        let text = [
            rate_limit_line(10, "2026-09-20T00:00:01Z"),
            rate_limit_line(10, "2026-09-20T00:00:02Z"),
            rate_limit_line(10, "2026-09-20T00:00:03Z"),
            rate_limit_line(11, "2026-09-20T00:00:04Z"),
            rate_limit_line(11, "2026-09-20T00:00:05Z"),
        ]
        .join("\n")
            + "\n";
        let p = parse_jsonl("codex", "q.jsonl", &text);
        assert_eq!(p.quotas.len(), 2, "5 条重复快照只留 2 个不同观测");
        assert_eq!(p.quotas[0].payload["used_percent"], 10);
        assert_eq!(p.quotas[1].payload["used_percent"], 11);
    }
    /// #82：把上面 #71 那条去重用例（共用 `rate_limit_line` 这份夹具）往后再推
    /// 一格——抽取出来的 rate_limits 必须真的落进 quota 表。此前配额入库只测过
    /// "手工 Parsed 写进 db::replace_file 再读出来"（db.rs）与"手工 INSERT 进表
    /// 再查"，采集侧的解析→入库这一段在 Rust 端没有钉住：session/ts 取自哪条
    /// 记录、payload 是不是原样落库，改错了无人变红。
    /// 黄金数：三条快照（10/10/11）→ 两行；ts 为各自那条 token_count 的时刻。
    #[test]
    fn rate_limits_rows_reach_the_quota_table() {
        let text = [
            rate_limit_line(10, "2026-09-20T00:00:01Z"),
            rate_limit_line(10, "2026-09-20T00:00:02Z"),
            rate_limit_line(11, "2026-09-20T00:00:03Z"),
        ]
        .join("\n")
            + "\n";
        let parsed = parse_jsonl("codex", "q.jsonl", &text);
        assert_eq!(parsed.events.len(), 3, "每条 token_count 都该出一条事件");
        let root = std::env::temp_dir().join(format!("tm-quota-row-{}", uuid::Uuid::new_v4()));
        crate::config::initialize(&root).unwrap();
        let mut db = crate::db::open(&root).unwrap();
        crate::db::replace_file(&mut db, "q.jsonl", "codex", 1, 1, &parsed).unwrap();
        let rows: Vec<(i64, String, serde_json::Value)> = db
            .prepare("SELECT ts,session,payload FROM quota WHERE agent='codex' ORDER BY ts")
            .unwrap()
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    serde_json::from_str(&r.get::<_, String>(2)?).unwrap(),
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 2, "去重后的两个观测都要入库");
        assert_eq!(rows[0].2["used_percent"], 10);
        assert_eq!(rows[1].2["used_percent"], 11);
        // payload 原样落库：嵌套对象不能在入库路上被削平。
        assert_eq!(rows[0].2["window"]["kind"], "week");
        assert_eq!(rows[0].2["window"]["limit_seconds"], 1800);
        // ts 取自各自那条 token_count，session 全部落在同一会话上。
        assert_eq!(
            rows[0].0,
            chrono::DateTime::parse_from_rfc3339("2026-09-20T00:00:01Z")
                .unwrap()
                .timestamp_millis()
        );
        assert_eq!(
            rows[1].0,
            chrono::DateTime::parse_from_rfc3339("2026-09-20T00:00:03Z")
                .unwrap()
                .timestamp_millis()
        );
        assert!(!rows[0].1.is_empty() && rows[0].1 == rows[1].1, "{rows:?}");
        drop(db);
        std::fs::remove_dir_all(&root).unwrap();
    }
}

#[cfg(test)]
mod tests_utf8_tolerance {
    use super::*;
    use std::io::Write;

    fn meta(id: &str) -> String {
        serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":"D:/fixture"}}).to_string()
    }
    fn usage(ts: &str, input: i64) -> String {
        serde_json::json!({"timestamp":ts,"type":"event_msg","payload":{"type":"token_count",
            "info":{"last_token_usage":{"input_tokens":input,"cached_input_tokens":0,"output_tokens":0}}}})
            .to_string()
    }
    /// 中段坏字节：一个非法的 UTF-8 序列（C3 28）夹在两行好数据之间。
    fn bytes_with_bad_middle_line() -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(meta("s1").as_bytes());
        b.push(0x0A);
        b.extend_from_slice(b"{\"content\":");
        b.extend_from_slice(&[0xC3, 0x28, 0x41]);
        b.push(0x0A);
        b.extend_from_slice(usage("2026-09-20T00:00:02Z", 100).as_bytes());
        b.push(0x0A);
        b
    }

    #[test]
    fn valid_bytes_take_the_zero_copy_path() {
        let bytes = "{\"a\":1}\n{\"b\":2}\n";
        match decode_jsonl_bytes(bytes.as_bytes()) {
            std::borrow::Cow::Borrowed(s) => assert_eq!(s, bytes),
            std::borrow::Cow::Owned(_) => panic!("合法 UTF-8 不该走拷贝路径（这是每轮扫描的热路径）"),
        }
    }

    /// #109 核心：中间一个坏字节，修前整份文件 Err -> 该来源 state=error、数据永久冻结。
    /// 现在坏行计 malformed（要看得见），其余行照常入库。
    #[test]
    fn a_bad_middle_line_becomes_one_malformed_row_not_a_failed_file() {
        let bytes = bytes_with_bad_middle_line();
        let text = decode_jsonl_bytes(&bytes);
        let p = parse_jsonl("codex", "D:/fixture/s.jsonl", &text);
        assert_eq!(p.malformed_lines, 1, "坏字节行必须计成畸形行，不能被静默吞掉");
        assert_eq!(p.events.len(), 1, "其余行照常入库");
        assert_eq!(p.events[0].session, "s1", "首行 session_meta 仍然生效");
    }

    /// 真 read_jsonl：中文+空格路径，坏字节在中间。修前这里返回 Err。
    #[test]
    fn read_jsonl_returns_events_for_a_file_with_a_permanent_bad_byte() {
        let dir = std::env::temp_dir().join(format!("tm-utf8-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("会话 目录.jsonl");
        std::fs::write(&path, bytes_with_bad_middle_line()).unwrap();
        let p = read_jsonl("codex", &path).expect("中间一个坏字节不得让整份文件失败");
        assert_eq!(p.malformed_lines, 1);
        assert_eq!(p.events.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 半行不推进：写方正在写一个多字节字符时截断的尾巴，不得被计成畸形行
    /// （修前 `error_len().is_none()` 分支就是为这个留的，必须保住）。
    #[test]
    fn an_incomplete_multibyte_tail_is_dropped_not_counted_as_malformed() {
        let mut bytes = usage("2026-09-20T00:00:01Z", 10).into_bytes();
        bytes.push(0x0A);
        let tail = "{\"content\":\"元".as_bytes();
        bytes.extend_from_slice(&tail[..tail.len() - 2]); // 只留 3 字节字符的前 1 字节
        let text = decode_jsonl_bytes(&bytes);
        let p = parse_jsonl("codex", "D:/fixture/t.jsonl", &text);
        assert_eq!(p.malformed_lines, 0, "还在写的半行不得计成畸形行");
        assert_eq!(p.events.len(), 1);
        assert!(!text.contains("元"), "半行必须整条丢掉：{text}");
    }

    /// dsh 的 zstd 帧与纯文本共用同一个按行解码（口径一致，验收项 3）。
    #[test]
    fn zstd_frames_share_the_same_line_tolerance_as_plain_text() {
        let dir = std::env::temp_dir().join(format!("tm-utf8-zstd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain_bytes = bytes_with_bad_middle_line();
        let plain = dir.join("plain.jsonl");
        std::fs::write(&plain, &plain_bytes).unwrap();
        let mut enc = zstd::stream::write::Encoder::new(Vec::new(), 3).unwrap();
        enc.write_all(&plain_bytes).unwrap();
        let frame = enc.finish().unwrap();
        let packed = dir.join("packed.jsonl.zstd");
        std::fs::write(&packed, &frame).unwrap();

        let a = read_jsonl("dsh", &packed).expect("zstd 分支同样不得因坏字节整文件失败");
        let b = read_jsonl("dsh", &plain).expect("纯文本分支");
        assert_eq!(a.malformed_lines, 1, "压缩帧里的坏行也要计成畸形行");
        assert_eq!(a.malformed_lines, b.malformed_lines, "两条分支口径必须一致");
        assert_eq!(a.events.len(), b.events.len());
        std::fs::remove_dir_all(&dir).ok();
    }
}
