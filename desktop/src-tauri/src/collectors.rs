//! Read-only source adapters. Source-specific token semantics are normalized here, not in the UI.
use crate::model::{normalize_model, Activity, Event, Parsed, Quota, Tokens};
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
/// #96：用量字段既可能是数字，也可能是**数字形态的字符串**（网关回填 usage 的常见写法）。
/// 这里必须把它读成数字，而不是当"不是 i64"落成 0：Node 端 `collectors/tokens.js
/// tokenCount()` 取的是 123，两端不一致就是同一份日志两个 UI 数字不同。
/// 非数字文本（"12a"）、null/bool、负数一律 0，与原 `as_i64().unwrap_or(0).max(0)` 一致。
fn json_int(v: &Value) -> i64 {
    let n = match v {
        Value::Number(x) => x.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match n {
        // 非有限值、负数、超出 i64 的量级都按 0：真实 token 数远到不了这个量级，
        // 而"读不出来"绝不能变成一个大数（Node 端 tokens.js 同理，非有限值一律 0）。
        Some(x) if x.is_finite() && x >= 0.0 && x <= i64::MAX as f64 => (x.floor() as i64).max(0),
        _ => 0,
    }
}
fn number(v: &Value, key: &str) -> i64 {
    json_int(v.get(key).unwrap_or(&Value::Null))
}
/// #71 第 7 项：秒 + 纳秒 → 毫秒，必须用 `checked_*`。
///
/// protobuf 的 `Timestamp` 里这两个 varint 由写入方说了算，读不出来的值不能变成一个大数：
/// 修前 antigravity 两处（`step_times` 与行内完成时间）都是裸 `sec * 1000 + nanos / 1e6`，
/// debug 构造下直接 overflow panic（采集线程炸），release 下回绕成 1970 前后的荒唐日期
/// ——面板里那条事件既不在"今日/本周"，也不在时间轴该在的位置，属于静默归零那一类。
/// 口径与本文件 `json_int()`（:26）和 `cache_write_of()` 的"两种写法不等就拒读记 0"一致：
/// **返回 0 表示"这条没有可用时间"**，由调用方决定回退（steps 时间）还是计 malformed，
/// 而不是替上游编一个日期出来。`timestamp()`（:7）走的是另一条路：它先把 ≥1e11 的值
/// 当毫秒用，乘 1000 的那一支只接 <1e11 的输入，天然不可能溢出，故不需要这里兜底。
fn seconds_to_ms(seconds: i64, nanos: i64) -> i64 {
    seconds
        .checked_mul(1000)
        .and_then(|ms| ms.checked_add(nanos / 1_000_000))
        // 负数同样不是时间：调用方只需要 `ts <= 0` 这一道判据（step_times 的回退查表
        // 也按 0 处理），不必再多记一种"负毫秒"的形态。
        .filter(|ms| *ms > 0)
        .unwrap_or(0)
}
fn string(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}
/// turn/step 这类"可能是数字、可能是字符串、也可能没有"的分代标签。
/// 缺失必须与 0 可区分（与 Node 端 `${rec.data?.turn ?? ''}` 同式）。
fn usage_tag(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
fn first(values: &[String], fallback: &str) -> String {
    values
        .iter()
        .find(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| fallback.into())
}
/// 与 Node 端 `path.win32.basename()` 同一条规则（#85）：`/` 与 `\` 都是分隔符，
/// 先去掉尾部分隔符再取最后一段；没有分隔符时剥掉 Windows 设备前缀（`C:` → 空，
/// `C:file` → `file`），其余原样。故意不用 `Path`：本仓库的日志里同时存在两种分隔符，
/// 而采集端必须在任何宿主上都得到同一个答案（Node 端七个源就是为此用 win32 的）。
fn win32_basename(value: &str) -> String {
    let trimmed = value.trim_end_matches(['/', '\\']);
    if let Some(i) = trimmed.rfind(['/', '\\']) {
        return trimmed[i + 1..].to_string();
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return trimmed[2..].to_string();
    }
    trimmed.to_string()
}
/// 项目名 = 路径末段（`basename(x) || x`，与 Node 端七个源完全同式）。
/// 根路径（`D:\`、`/`）取不到末段时原样返回，绝不退化成空。
fn project_name(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let base = win32_basename(value);
    if base.is_empty() {
        value.to_string()
    } else {
        base
    }
}
/// #75：两个 cache_write 写法（`cache_creation_input_tokens` /
/// `cache_write_input_tokens`）是**同一个累计量**在 codex 不同版本里的两个名字，不是两个
/// 可以相加的量。旧规则 `.max()` 假设"同一份 payload 只会出其中一种"，而此前没有任何 fixture
/// 证明过这个假设；它在两种情形下出错，规则在此明确：
///  1) 一条记录同时带两种写法且数值不同 —— 无法判定上游说的是哪个量，`.max()` 等于凭空造一个
///     上游从没说过的数。→ 值记 0（**拒读**），写法标为 4 让调用方看得见。数值相同则照用（3）。
///  2) 相邻两条采样各只带一种写法（升级换了字段名）—— 累计差分变成 `新写法值 - 旧写法值`，
///     必然为负，`delta()` 里的 `.max(0)` 把那一轮的缓存写入静默清零。→ 写法换了就说明累计
///     序列已断，调用方按"回落"处理（改读本条的 last_token_usage），不跨写法做差分。
/// 写法：0 都没写 / 1 只写 creation / 2 只写 write / 3 两种都写且相等 / 4 两种都写但不等。
/// 与 Node 端 `collectors/codex.js::cacheWriteOf()` 同一条规则。
///
/// #75 第 3 项：会话回放（`session_replay.rs::normalize_raw_usage`）**也调用这一个实现**。
/// 规则一旦复制就有三份，而这次分歧的成因正是三份里的一份（openai() 读 creation、
/// codex.js 读 write、replay 两个都不读）；跨 crate 边界也只留这一处可调用。
pub(crate) fn cache_write_of(v: &Value) -> (i64, u8) {
    let a = v.get("cache_creation_input_tokens");
    let b = v.get("cache_write_input_tokens");
    match (a, b) {
        (Some(x), Some(y)) => {
            let (p, q) = (json_int(x), json_int(y));
            if p != q {
                (0, 4)
            } else {
                (p, 3)
            }
        }
        (Some(x), None) => (json_int(x), 1),
        (None, Some(y)) => (json_int(y), 2),
        _ => (0, 0),
    }
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
        // 同一份日志两端恒有一边记 0。两种写法的取舍见 cache_write_of()。
        cache_write: cache_write_of(v).0,
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
    // #85：工具活动的主键是 (agent, `{session}:{id}`)。上游没写 id 时这里若原样用空串，
    // 同一会话里所有无名调用就塌成同一个键、逐条互相顶掉（缓存是覆盖语义，不是并存），
    // 工具榜因此只剩一条。Node 端从不产生空 id（各源分别回落到行号/块序号/记录 id），
    // 这里再兜一层：任何调用方漏给空 id 都按行号定位，与 `collectors.rs` 里
    // `key = "line:{index+1}"` 用的是同一个坐标。
    let id = if id.is_empty() {
        &format!("line:{line}")
    } else {
        id
    };
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
        // #85：目录名是 `<前缀>-WorkBuddy-<项目>`，Node 端 projectFromDir 取的是标记之后的
        // 那一段；此前这里直接用整个目录名，同一个项目在两端就成了两个名字。
        let dir = Path::new(path)
            .parent()
            .and_then(Path::file_name)
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        project = match dir.find("-WorkBuddy-") {
            Some(i) if i + "-WorkBuddy-".len() < dir.len() => dir[i + "-WorkBuddy-".len()..].to_string(),
            _ => dir,
        };
    }
    if agent == "grok" {
        project = Path::new(path)
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .map(|p| {
                let decoded = percent_encoding::percent_decode_str(&p.to_string_lossy())
                    .decode_utf8_lossy()
                    .into_owned();
                // 目录名是 encodeURIComponent(绝对路径)，解出来还是整条路径：
                // Node 端取 basename，此前这里留整条 → 同一个项目在两端是两个项目名。
                project_name(&decoded)
            })
            .unwrap_or_default();
    }
    let mut previous: Option<Tokens> = None;
    // #75：累计水位是"哪个写法读出来的"，写法一换差分就跨了两个版本的字段名（见
    // cache_write_of）。与 Node 端 st.cum.ws 同一个作用。
    let mut previous_ws: u8 = 0;
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
        // #85：cwd 落进 project 前一律过 project_name()。日志里存的是绝对路径，
        // Node 端七个源取的是末段（basename），此前这里存整条路径——同一份 rollout
        // 日志在两个 UI 里就是两个项目，分组/钻取/按项目对账全都对不上。
        if kind == "session_meta" {
            session = first(&[string(p, "id"), string(p, "session_id")], &session);
            project = first(&[project_name(&string(p, "cwd"))], &project);
        }
        if kind == "session" {
            session = first(&[string(&rec, "id")], &session);
            project = first(&[project_name(&string(&rec, "cwd"))], &project);
        }
        if kind == "turn_context" {
            model = first(&[string(p, "model")], &model);
            project = first(&[project_name(&string(p, "cwd"))], &project);
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
            // #85 (d)：**带用量**的记录读不到时间就是真实丢数，必须计入 malformed，
            // 让来源健康停在 warning（此前静默 continue，面板上一切正常、只是少数据）。
            // 结构性不带时间的行（codex 的 session_meta/turn_context、pi 与 dsh 的
            // type=session）不是坏数据，不能因为"天生没有时间"就报坏。
            // Node 端没有逐行 malformed 通道（src/scanner.js 只有文件级 parse_errors），
            // 这一条差异是有意保留的，见 docs/ARCHITECTURE.md 的 #85 段。
            let carries_usage = msg["usage"].is_object()
                || p["type"] == "token_count"
                || rec["params"]["update"]["usage"].is_object()
                || rec["data"]["usage"].is_object()
                || rec["data"]["chunk"]["usage"].is_object();
            if carries_usage {
                out.malformed_lines += 1;
            }
            continue;
        };
        let mut tokens = None;
        let mut key = format!("line:{}", index + 1);
        match agent {
            "codex" => {
                // #85：工具活动只认 `rec.type == "response_item"`，与 Node 端
                // `collectCodexFile` 的记录级门槛同式。此前这里只看 payload.type，
                // 于是 event_msg 里回放的同一批 function_call 也被再记一次，
                // 工具榜在桌面端系统性高于 Node 端（同一条调用被数了两遍）。
                // custom_tool_call 是新版 Codex 的 freeform 工具（apply_patch 一类），
                // 是真实工具调用，两端这次一起记：Node 端此前只认 function_call，
                // 少的那一边补上，而不是把桌面端砍掉。
                if kind == "response_item"
                    && (p["type"] == "function_call" || p["type"] == "custom_tool_call")
                {
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
                        let cur_ws = cache_write_of(&info["total_token_usage"]).1;
                        if previous.as_ref() == Some(&cur) && cur_ws == previous_ws {
                            continue;
                        }
                        let reset = previous.as_ref().is_some_and(|prev| {
                            cur.input + cur.cached < prev.input + prev.cached
                                || cur.output < prev.output
                        });
                        // #75 情形 2：两条各自写了具体写法的采样用了不同字段名，说明累计序列
                        // 来自两个版本的写入方，跨写法做差分必然为负、会被 delta() 的 .max(0)
                        // 静默清零 —— 与"回落"走同一条处理：改读本条采样的 last_token_usage。
                        // 上一轮"压根没写缓存"（写法 0 / 冲突拒读）不算序列断了：那时它在
                        // 这条序列上就是 0，字段第一次出现按普通差分读（与 Node 端
                        // codex.js 的 concreteSpelling 同一条收窄）。
                        let concrete_ws = |w: u8| (1..=3).contains(&w);
                        let spelling_changed =
                            concrete_ws(cur_ws) && concrete_ws(previous_ws) && cur_ws != previous_ws;
                        // #75 与 Node 端 codex.js 对齐：首个采样与累计值回落都不能用差分，
                        // 也都不能把整段累计值当单次用量 —— resume/fork 会话继承了父线程的
                        // 累计基线，记整段会把父会话重复计入（docs/ARCHITECTURE.md Codex 段
                        // 实测 9 倍）。只认 info.last_token_usage（本轮真实用量）；它缺失时
                        // 宁可不记（修前这里退回 cur.clone()）。
                        tokens = if previous.is_none() || reset || spelling_changed {
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
                        previous_ws = cur_ws;
                    } else if info["last_token_usage"].is_object() {
                        // #75：缺 total_token_usage 但带 last_token_usage 的采样两端**都落库**
                        // （Node 端修前在这里整条丢弃）。last_token_usage 本来就是本轮量，
                        // 不需要累计基线；累计水位与写法都不动，下一条带 total 的采样照旧差分。
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
                project = first(&[project_name(&string(&rec, "cwd"))], &project);
                if kind != "assistant" {
                    continue;
                }
                // #85：Node 端的两道前置关卡是 `if (!usage || !msg?.id) return;`
                // （collectors/claude.js:25）。缺 `message.id` 就编不出稳定去重键，
                // Node 端连工具调用一起丢；此前桌面端用 `{session}:{ts}:{行号}` 造了一个
                // 合成键入库——全量重扫时行号一变就变成重复计数，两端数字因此永远对不上。
                // 两道关卡的位置也和 Node 一致：都在内容块扫描之前。
                let u = &msg["usage"];
                if !u.is_object() || string(msg, "id").is_empty() {
                    continue;
                }
                // #85：模型名为空时 Node 端整条丢弃（`if (!model || model === '<synthetic>') return;`，
                // 见 collectors/claude.js），此前这里落到哨兵 unknown 仍然入库——同一份 transcript
                // 桌面端多出一条用量。空 model 与 "<synthetic>" 是同一类记录：不是一次真实 API 调用。
                // （与 #78 那条"两端各自只有一行"的约定不冲突：那条说的是有真实用量的行。）
                let raw_model = string(msg, "model");
                if raw_model.is_empty() || raw_model == "<synthetic>" {
                    continue;
                }
                model = raw_model;
                if let Some(blocks) = msg["content"].as_array() {
                    for (bi, b) in blocks.iter().enumerate() {
                        if b["type"] == "tool_use" {
                            // #85：block.id 缺失时不能塌成同一个键（缓存主键 (agent,id)，
                            // 一塌就把同一会话里所有无 id 的工具调用折成一条）。Node 端
                            // 的回落是 `${msg.id}:${块序号}`，这里同一式（msg.id 已在上面
                            // 把过关，非空）。
                            let fallback = format!("{}:{}", string(msg, "id"), bi);
                            tool(
                                &mut out,
                                agent,
                                &session,
                                ts,
                                &string(b, "name"),
                                &first(&[string(b, "id")], &fallback),
                                path,
                                index + 1,
                            );
                        }
                    }
                }
                // `u.is_object()` 与 `msg.id` 非空都已在上面把过关（与 Node 端同两道关卡），
                // 这里只剩落库：键为 `message.id` + `requestId`，与
                // `${tool}:${msg.id}:${rec.requestId ?? ''}` 同式。
                tokens = Some(Tokens {
                    input: number(u, "input_tokens"),
                    cached: number(u, "cache_read_input_tokens"),
                    cache_write: number(u, "cache_creation_input_tokens"),
                    output: number(u, "output_tokens"),
                    reasoning: number(&u["output_tokens_details"], "thinking_tokens"),
                });
                key = string(msg, "id");
                key.push_str(&string(&rec, "requestId"));
            }
            "workbuddy" => {
                session = first(&[string(&rec, "sessionId")], &session);
                if kind == "function_call" {
                    // #85：Node 端要求 `rec.name && rec.callId`，空 callId 不入库
                    let call_id = string(&rec, "callId");
                    if !call_id.is_empty() {
                        tool(
                            &mut out,
                            agent,
                            &session,
                            ts,
                            &string(&rec, "name"),
                            &call_id,
                            path,
                            index + 1,
                        );
                    }
                }
                if msg["usage"].is_object() {
                    // #85：与 claude 同一类修正——Node 端是 `if (!u || !rec.id || !ts) return;`
                    // （collectors/workbuddy.js），编不出稳定去重键的行两端都不入库；
                    // 桌面端此前用 `{session}:{ts}:{行号}` 造合成键，重扫一次就多计一次。
                    // 工具调用不受影响（Node 端也在这道关卡之前就先处理了 function_call）。
                    let id = string(&rec, "id");
                    if id.is_empty() {
                        continue;
                    }
                    tokens = Some(openai(&msg["usage"]));
                    model = first(&[string(&rec["providerData"], "model")], "unknown");
                    key = id;
                }
            }
            "pi" => {
                if kind != "message" || msg["role"] != "assistant" {
                    continue;
                }
                if let Some(blocks) = msg["content"].as_array() {
                    for (bi, b) in blocks.iter().enumerate() {
                        if b["type"] == "toolCall" {
                            // #85：与 claude 同一条规则，id 缺失时按块序号定位
                            // （Node：`${tool}:tc:${sessionId}:${block.id || i}`）
                            tool(
                                &mut out,
                                agent,
                                &session,
                                ts,
                                &string(b, "name"),
                                &first(&[string(b, "id")], &bi.to_string()),
                                path,
                                index + 1,
                            );
                        }
                    }
                }
                let u = &msg["usage"];
                if u.is_object() {
                    // #85：Node 端 `const key = rec.id ?? msg.responseId; if (!key) return;`
                    // （collectors/pi.js:68-69）——"编不出稳定去重键的事件，宁可少一条也不能
                    // 多一条"。桌面端此前退回 `{ts}:{行号}`，同一份文件重扫一次就多点一行。
                    let id = first(&[string(&rec, "id"), string(msg, "responseId")], "");
                    if id.is_empty() {
                        continue;
                    }
                    tokens = Some(Tokens {
                        input: number(u, "input"),
                        cached: number(u, "cacheRead"),
                        cache_write: number(u, "cacheWrite"),
                        output: number(u, "output"),
                        reasoning: number(u, "reasoning"),
                    });
                    model = first(&[string(msg, "model")], "unknown");
                    key = format!("{session}:{id}");
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
                    // #79 与 Node 端 collectDshFile 的同一条定键规则：
                    // 旧结构（assistant/chunk）的 seq 在 turn/step 空间里会重复出现，
                    // 只按 seq 定键会让同一 seq 的后续 step 整条顶掉前一条（事件缓存
                    // 的 PRIMARY KEY(agent,id) 是覆盖语义，不是并存）。
                    // v3（assistant/message）的 seq 全文件唯一，按文件名分代即可。
                    let file = Path::new(path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy();
                    key = if kind == "assistant/chunk" {
                        format!(
                            "{session}:{file}:{}:{}:{}",
                            rec["seq"],
                            usage_tag(&data["turn"]),
                            usage_tag(&data["step"])
                        )
                    } else {
                        format!("{session}:{file}:{}", rec["seq"])
                    };
                }
            }
            "grok" => {
                let params = &rec["params"];
                let upd = &params["update"];
                session = first(&[string(params, "sessionId")], &session);
                if upd["sessionUpdate"] == "tool_call" {
                    // #85：Node 端 `if (name && upd.toolCallId)` —— 没有 toolCallId 就没有
                    // 任何稳定身份（updates.jsonl 是追加式的，位置会变），两端必须都不记；
                    // 名字同样只认 title/kind，不再拿 "tool" 占位造出 Node 端没有的一行。
                    let call_id = string(upd, "toolCallId");
                    let name = first(&[string(upd, "title"), string(upd, "kind")], "");
                    if !call_id.is_empty() && !name.is_empty() {
                        tool(
                            &mut out,
                            agent,
                            &session,
                            ts,
                            &name,
                            &call_id,
                            path,
                            index + 1,
                        );
                    }
                }
                if upd["sessionUpdate"] != "turn_completed" {
                    continue;
                }
                let u = &upd["usage"];
                let by_model = u["modelUsage"].as_object();
                // #96：`modelUsage: {}` 是"没有逐模型拆分"，不是"这一轮没有用量"。
                // 空对象必须与字段缺失同义，否则 unwrap_or_else 的回落分支永远进不去，
                // 整轮用量凭空消失（Node 端 grok.js 同一处、同一条修复）。
                let models: Vec<(String, &Value)> = by_model
                    .filter(|m| !m.is_empty())
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
                            model: normalize_model(&m),
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
                    model: normalize_model(&model),
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
                // #79：model_id 读不动（NULL/列类型漂移）只把这一列当缺失，不牵连整行；
                // #78：与 Node 端 zcode.js 的 normalizeModel(r.model_id) 同式归一。
                let model_id = r.get::<_, String>(2).unwrap_or_default();
                Ok(Event {
                    id: r.get(0)?,
                    agent: agent.into(),
                    session: r.get(1)?,
                    model: normalize_model(&model_id),
                    ts: r.get(3)?,
                    // #85：session.directory 是绝对路径，Node 端 zcode.js 取末段
                    project: project_name(&r.get::<_, String>(9)?),
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
            // #79：单行读不动（列类型漂移、NULL 撞上非空列型、值过大）只丢这一行并计入
            // malformed，让来源健康停留在 warning；修前这里的 `?` 会让一行坏数据把整个
            // 文件解析判失败，该源从此每轮 error、再也不出数。
            let Ok(event) = row else {
                out.malformed_lines += 1;
                continue;
            };
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
            // #79：同上一条规则，坏行只丢自己
            let Ok((id, s, n, t)) = row else {
                out.malformed_lines += 1;
                continue;
            };
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
            // #79：坏行只丢自己，不把整源判失败
            let Ok((id, session, time, data, project)) = row else {
                out.malformed_lines += 1;
                continue;
            };
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
                    // #85：同 zcode，directory 取末段才是 Node 端记的那个项目
                    project: project_name(&project),
                    model: normalize_model(&first(&[string(&v, "modelID")], "unknown")),
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
            // #79：坏行只丢自己，不把整源判失败
            let Ok((id, s, t, d)) = row else {
                out.malformed_lines += 1;
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(&d) else {
                out.malformed_lines += 1;
                continue;
            };
            if v["type"] == "tool" {
                // #85：工具调用的时间优先取 `data.state.time.start`（这次工具真正开始的
                // 时刻），行内没有才退回 part 行的 time_created。此前只用 time_created：
                // 同一次工具调用在两个 UI 的时间轴上能差出整轮执行的时长（Node 端
                // collectors/opencode.js 一直是 state.time.start 优先）。
                let ts = timestamp(&v["state"]["time"]["start"]).unwrap_or(t);
                if ts <= 0 {
                    // 带工具名却读不到时间 = 真实丢这一条，计 malformed（Node 端无逐行通道）
                    out.malformed_lines += 1;
                    continue;
                }
                tool(
                    &mut out,
                    agent,
                    &s,
                    ts,
                    &string(&v, "tool"),
                    &first(&[string(&v, "callID")], &id),
                    &source,
                    0,
                );
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
/// SQLite 的 schema 漂移：表被删/改名，或列被改名。这两种说的是"上游换了形状"，
/// 不是"这一份数据读坏了"，所以只能让对应的信息位缺失，绝不能让整个源每轮抛错——
/// scanner 拿到 `Err` 就把该源标成 error 且**不做** `replace_file`，缓存从此停在旧快照
/// 上再不出数（#79 与 #95 修的都是这一条停摆路径，两边只差在坏的是行还是列名）。
fn schema_drift(e: &rusqlite::Error) -> bool {
    let text = e.to_string();
    text.contains("no such table") || text.contains("no such column")
}
fn step_times(db: &Connection) -> rusqlite::Result<BTreeMap<i64, i64>> {
    let mut stmt = db.prepare("SELECT idx,metadata FROM steps")?;
    let mut rows =
        stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
    let mut out = BTreeMap::new();
    while let Some(row) = rows.next() {
        // #79：单行读不动只丢那一行的时间，不让整库解析失败
        let Ok((idx, b)) = row else { continue };
        if let Ok(f) = fields(&b) {
            let t = nested(&f, 1);
            out.insert(idx, seconds_to_ms(num(&t, 1), num(&t, 2)));
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
    // #95：steps 表被改走（整表缺失或列被改名）只意味着"没有步级时间"，不能让整库解析
    // 失败 —— 修前这里的 `?` 会把该源永久标成 error（一个漂移的会话库 = 整源再不出数）。
    // 锁/IO 一类的暂时性失败仍然上报：那种情况下缓存里已有的事件必须原样保留、
    // 下一轮重读，绝不能用一份读不全的结果去替换它。
    let times = match step_times(&db) {
        Ok(t) => t,
        // "no such table" 与 "no such column" 都是上游改了 schema 的形状，不是读坏了数据
        Err(e) if schema_drift(&e) => BTreeMap::new(),
        Err(e) => return Err(e.to_string()),
    };
    let mut stmt = db
        .prepare("SELECT idx,data FROM gen_metadata")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        // #79：坏行只丢自己，不把整源判失败
        let Ok((idx, b)) = row else {
            out.malformed_lines += 1;
            continue;
        };
        let Ok(f) = fields(&b) else {
            out.malformed_lines += 1;
            continue;
        };
        let gen = nested(&f, 1);
        let u = nested(&gen, 4);
        let t = nested(&nested(&gen, 9), 4);
        // #85 ①时间：行内完成时间**优先**，缺失才回退同 idx 的 steps 时间
        // （docs/sources/antigravity.md「collector 同时支持两代：行内时间戳优先，缺失时
        // 回退 steps 对齐」）。此前取两者 max：steps 一行覆盖多次生成，它的时间可以晚于
        // 本次生成的完成时间，取 max 会把事件推到错误的时间轴上，而 Node 端记的是行内值。
        let inline = seconds_to_ms(num(&t, 1), num(&t, 2));
        let ts = if inline > 0 {
            inline
        } else {
            *times.get(&idx).unwrap_or(&0)
        };
        if ts <= 0 {
            out.malformed_lines += 1;
            continue;
        }
        // #85 ②output 的三个分支与 Node 端 decodeGenerationRow 同式：
        // f3 是"含 thinking 的总输出"主口径，**为 0 或缺席**都视为不可用（旧写法用
        // contains_key，于是 f3=0 的行在这里被记成 0 输出，Node 端却回推出 f10+f9）；
        // f3 不可用时按可见输出 f10 + thinking f9 回推，f10 也不在就只剩 f9。
        let total_out = num(&u, 3);
        let output = if total_out > 0 {
            total_out
        } else if u.contains_key(&10) {
            num(&u, 10) + num(&u, 9)
        } else {
            num(&u, 9)
        };
        let tokens = Tokens {
            input: num(&u, 2),
            cached: num(&u, 5),
            cache_write: num(&u, 4),
            output,
            reasoning: num(&u, 9),
        };
        // #85 ③零用量行：Node 端在 total 之前先有一道 `input===0 && output===0 &&
        // cacheRead===0 → 丢`（collectors/antigravity.js 的"零用量行"）。只带
        // cache 写入的一次生成不算请求，此前桌面端只有 total>0 一道关，这类行会在
        // 桌面端多出一条记录、请求数也比 Node 多。
        if tokens.input == 0 && tokens.output == 0 && tokens.cached == 0 {
            continue;
        }
        // 与 Node 端 antigravity.js 同式：`asText(lastOf(gen, 19)) || 'unknown'` 先兜空名，
        // 再 normalizeModel（#78）。字段缺失/空字节都落到哨兵 unknown 后才归一。
        let raw_model = match gen.get(&19) {
            Some(Field::Bytes(b)) => String::from_utf8_lossy(b).into_owned(),
            _ => String::new(),
        };
        let model = normalize_model(if raw_model.is_empty() { "unknown" } else { &raw_model });
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
/// `conversation_summaries.workspace_uris` → 项目名（#85 ③）。
///
/// 与 Node 端 `collectors/antigravity.js::projectFromWorkspaceUris()` 同式：
/// 扫到**第一个 `file://` 项**才用（此前直接取 `v[0]`，数组里先出现非 file 项时
/// 桌面端会把 `untitled:...` 这类字符串当项目名）；percent 解码后取路径末段，
/// Windows 的 `file:///D:/x` 先去掉 pathname 多出来的那个前导 `/`。
/// 解不出可用 URI 时返回空串（Node 端是 null），坏 JSON/坏数组同样返回空。
fn project_from_workspace_uris(raw: &str) -> String {
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(raw) else {
        return String::new();
    };
    for item in &list {
        let Value::String(uri) = item else { continue };
        let Some(rest) = uri.strip_prefix("file://") else { continue };
        // file:///D:/x 与 file:///etc/x 的 pathname 分别是 /D:/x 与 /etc/x：
        // 末段相同，这里只需把 Windows 多出来的那个前导斜杠去掉再取末段。
        let path = match rest.strip_prefix('/') {
            Some(p) if p.starts_with(|c: char| c.is_ascii_alphabetic()) && p.get(1..2) == Some(":") => {
                p.to_string()
            }
            _ => rest.to_string(),
        };
        let decoded = percent_encoding::percent_decode_str(&path)
            .decode_utf8_lossy()
            .into_owned();
        return project_name(&decoded);
    }
    String::new()
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
        out.insert(id, project_from_workspace_uris(&s));
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
    /// 第 5 行（→ 52）是 #75 刻意**不**改的那一种：上一轮的 total 里压根没写任何
    /// cache_write 写法（写法=0，序列上就是 0），这一轮第一次出现 `cache_creation`
    /// 7 —— 按普通差分读成 7，而不是回落到本轮的 2。只有两条采样**各自**写了具体写法
    /// 且写法不同，才算累计序列断了（`codex_cache_write_spellings_conflict_and_switch`）。
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
    /// 跨分支对账（#75 第 1 项）：姊妹分支 `codex/fix-desktop-data`@6b91d98 新加的十源
    /// 平价探针把 codex 记成"量化分歧 −1 事件 / −120 tokens / −80 cached"，理由是
    /// "Node 侧每条会话第一次 token_count 只建累计基线不产事件（`codex.js:149`）"。
    /// 那个理由说的是 #75 之前的 Node 形状；把它自己的夹具原样搬过来钉住两端就知道
    /// 差值已经是 0：首个采样两端都按 `last_token_usage` 落这一条 120/80 的事件，
    /// 第二条累计值未变（重复通知）两端都不落。Node 侧同一份输入钉在
    /// `test/run.mjs` 的"跨分支对账"块里。任一端改回"只建基线不产事件"必红。
    #[test]
    fn codex_first_sample_no_longer_diverges_from_node_parity_probe() {
        const PROBE_USAGE: &str = r#""last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10},"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}"#;
        let text = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"codex-session\",\"cwd\":\"D:\\\\我的 项目\"}}}}\n\
             {{\"type\":\"turn_context\",\"payload\":{{\"model\":\"m\"}}}}\n\
             {{\"timestamp\":\"2026-09-20T00:00:00Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{{s}}}}}}}\n\
             {{\"timestamp\":\"2026-09-20T00:00:01Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{{s}}}}}}}\n",
            s = PROBE_USAGE
        );
        let p = parse_jsonl("codex", "probe.jsonl", &text);
        assert_eq!(p.malformed_lines, 0, "夹具本身不能带坏行：{:?}", p.events);
        assert_eq!(p.events.len(), 1, "首个采样两端都产这一条：{:?}", p.events);
        let t = &p.events[0].tokens;
        assert_eq!((t.total(), t.cached, t.input), (120, 80, 20), "{:?}", t);
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

#[cfg(test)]
mod collector_parity_tests {
    use super::*;
    /// #71 第 7 项：秒→毫秒不再裸乘。真实 antigravity 时间（18 亿秒量级）照常换算，
    /// 上游写坏的秒值一律读成"没有可用时间"(0)，既不 panic（debug 下修前是 overflow
    /// panic）也不回绕成一个 1970 前后的荒唐日期。端到端的那一条见
    /// `tests/sources.rs::antigravity_bogus_second_timestamp_is_not_a_date`。
    #[test]
    fn seconds_to_ms_refuses_to_invent_a_date() {
        assert_eq!(seconds_to_ms(1_800_000_000, 0), 1_800_000_000_000);
        assert_eq!(seconds_to_ms(1_800_000_000, 500_000_000), 1_800_000_000_500);
        assert_eq!(seconds_to_ms(0, 0), 0);
        // 裸乘会 overflow panic / 回绕的两个量级：读不出来就是 0，不是日期
        assert_eq!(seconds_to_ms(i64::MAX, 0), 0, "sec 大到乘不动 → 无可用时间");
        assert_eq!(seconds_to_ms(9_000_000_000_000_000_000, 0), 0);
        assert_eq!(seconds_to_ms(-5, 0), 0, "负的同样不是时间，调用方只需认 0");
        // 边界内侧仍是合法值：拒的是"换算不出日期"，不是"数字大"。能落进 i64 的换算结果
        // 一律如实上报——这里不再发明第二条丢弃规则（真实上游的秒值在 1e10 量级以下，
        // 而"读得出来却荒谬"该由秒/毫秒粒度那条 1e11 阈值管，见 timestamp() 与 tokens.js）
        assert_eq!(seconds_to_ms(i64::MAX / 1000, 0), 9_223_372_036_854_775_000);
        // 纳秒按 /1e6 进位（与 Node 端 antigravity.js 的 `Math.floor(nanos/1e6)` 同式，
        // 上游写出超过 1e9 的纳秒时两端不能一个加一个不加）
        assert_eq!(seconds_to_ms(1_800_000_000, 1_500_000_000), 1_800_000_001_500);
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
    /// 第 5 行（→ 52）是 #75 刻意**不**改的那一种：上一轮的 total 里压根没写任何
    /// cache_write 写法（写法=0，序列上就是 0），这一轮第一次出现 `cache_creation`
    /// 7 —— 按普通差分读成 7，而不是回落到本轮的 2。只有两条采样**各自**写了具体写法
    /// 且写法不同，才算累计序列断了（`codex_cache_write_spellings_conflict_and_switch`）。
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
    /// 跨分支对账（#75 第 1 项）：姊妹分支 `codex/fix-desktop-data`@6b91d98 新加的十源
    /// 平价探针把 codex 记成"量化分歧 −1 事件 / −120 tokens / −80 cached"，理由是
    /// "Node 侧每条会话第一次 token_count 只建累计基线不产事件（`codex.js:149`）"。
    /// 那个理由说的是 #75 之前的 Node 形状；把它自己的夹具原样搬过来钉住两端就知道
    /// 差值已经是 0：首个采样两端都按 `last_token_usage` 落这一条 120/80 的事件，
    /// 第二条累计值未变（重复通知）两端都不落。Node 侧同一份输入钉在
    /// `test/run.mjs` 的"跨分支对账"块里。任一端改回"只建基线不产事件"必红。
    #[test]
    fn codex_first_sample_no_longer_diverges_from_node_parity_probe() {
        const PROBE_USAGE: &str = r#""last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10},"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}"#;
        let text = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"codex-session\",\"cwd\":\"D:\\\\我的 项目\"}}}}\n\
             {{\"type\":\"turn_context\",\"payload\":{{\"model\":\"m\"}}}}\n\
             {{\"timestamp\":\"2026-09-20T00:00:00Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{{s}}}}}}}\n\
             {{\"timestamp\":\"2026-09-20T00:00:01Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"token_count\",\"info\":{{{s}}}}}}}\n",
            s = PROBE_USAGE
        );
        let p = parse_jsonl("codex", "probe.jsonl", &text);
        assert_eq!(p.malformed_lines, 0, "夹具本身不能带坏行：{:?}", p.events);
        assert_eq!(p.events.len(), 1, "首个采样两端都产这一条：{:?}", p.events);
        let t = &p.events[0].tokens;
        assert_eq!((t.total(), t.cached, t.input), (120, 80, 20), "{:?}", t);
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
    /// #79：旧结构（assistant/chunk）同一 seq 在不同 turn/step 上重复出现时，两条都必须
    /// 留下。只按 seq 定键会让后一条整条顶掉前一条（事件缓存主键是覆盖语义）。
    /// 同一份记录与同样的期望数字写在 Node 端 test/windows/dsh.test.mjs 的 [#79] 段，
    /// 落库后的"两条都在"则由 desktop/src-tauri/tests/sources.rs 的 dsh 同 seq 块守。
    #[test]
    fn dsh_legacy_chunks_sharing_seq_stay_separate() {
        let s = r#"{"type":"session","time":1800000000000,"cwd":"D:\\repo"}
{"type":"assistant/chunk","seq":7,"time":1800000001000,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":100,"cacheReadTokens":10,"cacheWriteTokens":5,"outputTokens":20}}}}
{"type":"assistant/chunk","seq":7,"time":1800000002000,"data":{"turn":1,"step":2,"chunk":{"type":"usage","usage":{"inputTokens":200,"cacheReadTokens":20,"cacheWriteTokens":0,"outputTokens":40}}}}"#;
        let p = parse_jsonl("dsh", "会话目录/session.jsonl", s);
        assert_eq!(p.events.len(), 2, "{:?}", p.events);
        assert_eq!(p.events[0].tokens.total(), 135);
        assert_eq!(p.events[1].tokens.total(), 260);
        assert_ne!(p.events[0].id, p.events[1].id);
        // v3 的 seq 全文件唯一，定键规则刻意不带 turn/step（两端同式）
        let v3 = r#"{"type":"assistant/message","seq":7,"time":1800000001000,"data":{"turn":1,"step":1,"usage":{"inputTokens":100,"cacheReadTokens":10,"cacheWriteTokens":5,"outputTokens":20},"message":{"source":{"model":"m"}}}}
{"type":"assistant/message","seq":7,"time":1800000002000,"data":{"turn":1,"step":2,"usage":{"inputTokens":100,"cacheReadTokens":10,"cacheWriteTokens":5,"outputTokens":20},"message":{"source":{"model":"m"}}}}"#;
        let p2 = parse_jsonl("dsh", "会话目录/session.v3.jsonl", v3);
        assert_eq!(p2.events.len(), 2);
        assert_eq!(p2.events[0].id, p2.events[1].id);
    }
    /// #79（桌面侧）：SQLite 源里一行列类型读不动只丢那一行并计 malformed，
    /// 整个文件/整个源不再被判失败。
    /// 坏行的形状按验收条件点名的一种来：**TEXT 型的 `started_at`**（SQLite 动态类型
    /// 下 INTEGER 声明只是亲和性提示，写入方塞字符串进去完全合法，'不是数字' 转不成
    /// INTEGER 就以 TEXT 存着），外加 NULL 撞非空列型那一种。
    #[test]
    fn sqlite_bad_row_is_skipped_without_failing_the_source() {
        let path = std::env::temp_dir().join(format!("tm-zcode-{}.db", uuid::Uuid::new_v4()));
        let _ = fs::remove_file(&path);
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE session(id TEXT,directory TEXT);
                 CREATE TABLE model_usage(id TEXT,session_id TEXT,model_id TEXT,started_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,cache_creation_input_tokens INTEGER,cache_read_input_tokens INTEGER);
                 CREATE TABLE tool_usage(id INTEGER,session_id TEXT,tool_name TEXT,started_at INTEGER);
                 INSERT INTO session VALUES('z-session','project-dir');
                 INSERT INTO model_usage VALUES('z-1','z-session','m',1800000000000,800,60,0,0,700);
                 INSERT INTO model_usage VALUES(NULL,'z-session','m',1800000001000,1,1,0,0,0);
                 INSERT INTO model_usage VALUES('z-3','z-session','m','不是数字',500,50,0,0,400);
                 INSERT INTO tool_usage VALUES(1,'z-session','Bash',1800000000000);
                 INSERT INTO tool_usage VALUES(2,NULL,'Read',1800000002000);
                 INSERT INTO tool_usage VALUES(3,'z-session','Write','不是数字');",
            )
            .unwrap();
        }
        let parsed = read_sqlite("zcode", &path).expect("一行坏不能让整个源失败");
        assert_eq!(parsed.events.len(), 1, "{:?}", parsed.events);
        assert_eq!(parsed.events[0].tokens.total(), 860);
        assert_eq!(parsed.activities.len(), 1, "{:?}", parsed.activities);
        // 四条坏行各自只丢自己：NULL 主键、TEXT 型 started_at（用量行）、NULL 会话、
        // TEXT 型 started_at（工具行）
        assert_eq!(parsed.malformed_lines, 4, "{:?}", parsed);
        fs::remove_file(path).unwrap();
    }
    /// #79 第三条验收：opencode 走的是同一条容错读取（同一个 `let Ok(..) else` 形状），
    /// 一行 TEXT 型 `time_created` 只丢那一行，健康停在 malformed 计数而不是整源 error。
    #[test]
    fn opencode_bad_sqlite_row_is_skipped_without_failing_the_source() {
        let path = std::env::temp_dir().join(format!("tm-opencode-{}.db", uuid::Uuid::new_v4()));
        let _ = fs::remove_file(&path);
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE session(id TEXT,directory TEXT);
                 CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);
                 CREATE TABLE part(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);
                 INSERT INTO session VALUES('o-session','project-dir');
                 INSERT INTO message VALUES('m-1','o-session',1800000000000,
                   '{\"role\":\"assistant\",\"modelID\":\"M\",\"tokens\":{\"input\":10,\"output\":5,\"cache\":{\"read\":0,\"write\":0}},\"time\":{\"created\":1800000000000}}');
                 INSERT INTO message VALUES('m-2','o-session','不是数字',
                   '{\"role\":\"assistant\",\"modelID\":\"M\",\"tokens\":{\"input\":7,\"output\":3},\"time\":{\"created\":1800000001000}}');
                 INSERT INTO part VALUES('p-1','o-session',1800000000000,
                   '{\"type\":\"tool\",\"tool\":\"bash\",\"callID\":\"c1\",\"state\":{\"time\":{\"start\":1800000000000}}}');
                 INSERT INTO part VALUES('p-2','o-session','不是数字',
                   '{\"type\":\"tool\",\"tool\":\"read\",\"callID\":\"c2\"}');",
            )
            .unwrap();
        }
        let parsed = read_sqlite("opencode", &path).expect("一行类型漂移不能冻结整源");
        assert_eq!(parsed.events.len(), 1, "{:?}", parsed.events);
        assert_eq!(parsed.events[0].tokens.total(), 15);
        assert_eq!(parsed.activities.len(), 1, "{:?}", parsed.activities);
        assert_eq!(parsed.malformed_lines, 2, "{:?}", parsed);
        fs::remove_file(path).unwrap();
    }
    /// #79/#95：`steps` 表**在但列被改名**（schema 漂移的另一种）与整表缺失同一种
    /// 处理——只是"没有步级时间"，不是解析失败。修前这里的白名单只放 `no such table`，
    /// `no such column` 仍然把整份结果判 Err，scanner 因此永不 `replace_file`，
    /// 该会话库从此每轮重炸、缓存里是旧快照。
    #[test]
    fn antigravity_renamed_steps_column_degrades_instead_of_failing() {
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
        let path = std::env::temp_dir().join(format!("tm-agy-col-{}.db", uuid::Uuid::new_v4()));
        let _ = fs::remove_file(&path);
        {
            let db = Connection::open(&path).unwrap();
            // steps 表存在，但 metadata 列被改名为 meta
            db.execute_batch("CREATE TABLE steps(idx INTEGER,meta BLOB);CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);")
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
            db.execute("INSERT INTO gen_metadata VALUES(1,?1)", [&timed]).unwrap();
        }
        let parsed = read_antigravity(&path, "proj").expect("列名漂移不是解析失败");
        assert_eq!(parsed.malformed_lines, 0, "{:?}", parsed.events);
        assert_eq!(parsed.events.len(), 1, "{:?}", parsed.events);
        fs::remove_file(path).unwrap();
    }
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
    /// #78 双端同一条归一规则（解析层）。同一张表也写在 Node 端 `test/run.mjs` 的
    /// [26] 段，两端任一改动都会同时变红。规则来自 Node 侧 `src/models.js`
    /// （去首尾空白 + 小写），桌面端此前只在价格查找时归一，落库的模型名仍是原样。
    ///
    /// 刻意不放进这张表的名字：`deepseek-flash` / `deepseek-v4-flash` /
    /// `deepseek-v4.1-flash`。Node 端 models.js 在归一时还会走一张 ALIASES 路由表，
    /// 而桌面端把同类路由放在 prices.json 的 aliases 里，且两端对同一对 id 的
    /// **路由方向相反**（Node: deepseek-flash→deepseek-v4.1-flash；
    /// 桌面: deepseek-v4.1-flash→deepseek-flash，因为两边价目表的键不同）。
    /// 别名路由是"哪个键有价"的产品事实，不在这条词法规则里，故共享表避开它们。
    #[test]
    fn model_name_normalization_rule_matches_node() {
        for (raw, want) in [
            ("GLM-5.3-Flash", "glm-5.3-flash"),
            ("glm-5.3-flash", "glm-5.3-flash"),
            ("  GLM-5.3-FLASH  ", "glm-5.3-flash"),
            ("MiniMax-M2.7-HighSpeed", "minimax-m2.7-highspeed"),
            ("Pro/zai-org/GLM-5", "pro/zai-org/glm-5"),
            ("unknown", "unknown"),
        ] {
            assert_eq!(normalize_model(raw), want, "raw={raw:?}");
        }
        // 空名是"这条日志没有模型"，落进哨兵 unknown（Node 端落 NULL，见 model.rs）
        for blank in ["", "   ", "\t"] {
            assert_eq!(normalize_model(blank), "unknown", "raw={blank:?}");
        }
    }
    /// #78 双端黄金数（跨来源同一模型）。同一份记录与同样的期望数字写在
    /// Node 端 `test/run.mjs` 的 [26] 段（同一变量的落库层在
    /// `tests/sources.rs::same_model_spelled_differently_across_sources_is_one_row`），
    /// 三处任一改动都会同时变红。
    ///
    /// 期望：三条事件全部记作 `glm-5.3-flash`，
    /// codex 基线条 200000/600000/30000/50000 = 880000（#75 口径），
    /// codex 差分校 100000/300000/10000/30000 = 440000，
    /// claude-code 条 1200/340000/20000/60000 = 421200，
    /// 合计 input 301200 / cached 1240000 / cache_write 60000 / output 140000 = 1741200。
    #[test]
    fn same_model_spelled_differently_across_sources_gets_one_name() {
        const CODEX_78: &str = r#"{"timestamp":"2026-09-20T00:00:01Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"GLM-5.3-Flash"}}}
{"timestamp":"2026-09-20T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":800000,"cached_input_tokens":600000,"cache_write_input_tokens":30000,"output_tokens":50000,"reasoning_output_tokens":20000,"total_tokens":880000},"last_token_usage":{"input_tokens":800000,"cached_input_tokens":600000,"cache_write_input_tokens":30000,"output_tokens":50000,"reasoning_output_tokens":20000}}}}
{"timestamp":"2026-09-20T00:00:03Z","type":"turn_context","payload":{"model":"  GLM-5.3-FLASH  "}}
{"timestamp":"2026-09-20T00:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1200000,"cached_input_tokens":900000,"cache_write_input_tokens":40000,"output_tokens":80000,"reasoning_output_tokens":30000,"total_tokens":1280000},"last_token_usage":{"input_tokens":400000,"cached_input_tokens":300000,"cache_write_input_tokens":10000,"output_tokens":30000,"reasoning_output_tokens":10000}}}}"#;
        const CLAUDE_78: &str = r#"{"timestamp":"2026-09-20T00:10:00Z","type":"assistant","sessionId":"claude-78","cwd":"/work/parity","requestId":"r-78","message":{"id":"msg-78","model":"glm-5.3-flash","usage":{"input_tokens":1200,"cache_read_input_tokens":340000,"cache_creation_input_tokens":20000,"output_tokens":60000,"output_tokens_details":{"thinking_tokens":7000}}}}"#;
        let codex = parse_jsonl("codex", "parity78.jsonl", CODEX_78);
        let claude = parse_jsonl("claude-code", "parity78.jsonl", CLAUDE_78);
        assert_eq!(codex.events.len(), 2, "{:?}", codex.events);
        assert_eq!(claude.events.len(), 1, "{:?}", claude.events);
        let all: Vec<&Event> = codex.events.iter().chain(claude.events.iter()).collect();
        for e in &all {
            assert_eq!(e.model, "glm-5.3-flash", "全部事件同一个模型名：{:?}", all.iter().map(|x| &x.model).collect::<Vec<_>>());
        }
        let components = |events: &[Event]| -> (i64, i64, i64, i64, i64) {
            events.iter().fold((0, 0, 0, 0, 0), |acc, e| {
                (
                    acc.0 + e.tokens.input,
                    acc.1 + e.tokens.cached,
                    acc.2 + e.tokens.cache_write,
                    acc.3 + e.tokens.output,
                    acc.4 + e.tokens.total(),
                )
            })
        };
        assert_eq!(components(&codex.events), (300000, 900000, 40000, 80000, 1320000));
        assert_eq!(components(&claude.events), (1200, 340000, 20000, 60000, 421200));
        let mut merged_events = codex.events.clone();
        merged_events.extend(claude.events.iter().cloned());
        let merged = components(&merged_events);
        assert_eq!(merged, (301200, 1240000, 60000, 140000, 1741200));
        // 单条事件的 total 恒等于四列之和（CONTRIBUTING 落库公式）
        for e in &all {
            assert_eq!(e.tokens.total(), e.tokens.input + e.tokens.cached + e.tokens.cache_write + e.tokens.output);
        }
        assert_eq!(
            all.iter().map(|e| e.tokens.reasoning).sum::<i64>(),
            37000,
            "reasoning 不参与 total，但必须同一条上带着"
        );
    }

    /// #96 双端共享夹具：用量字段是**数字形态的字符串**时，两端必须读出同一个整数。
    /// Node 端同一份记录与同一组期望写在 `test/run.mjs` 的 [27] 段。
    /// 修前两端各错一头：JS 侧 `"123" + 0 + 0 + 456` 做的是拼接（→ 12300456，四个数量级），
    /// Rust 侧 `Value::as_i64` 对字符串一律给 0（→ 这条用量凭空消失）。
    /// 同一处还钉住 grok `modelUsage:{}`（空对象=没有逐模型拆分，不是这一轮没有用量）
    /// 与 Pi 首行 BOM（project 只写在首行，读不到就永久为 null）。
    #[test]
    fn stringly_typed_usage_and_empty_model_usage_match_node() {
        const CLAUDE_96: &str = r#"{"timestamp":"2026-09-21T00:00:00Z","type":"assistant","sessionId":"p96","requestId":"r1","message":{"id":"m1","model":"GLM-96","usage":{"input_tokens":"123","cache_read_input_tokens":"4500","cache_creation_input_tokens":"60","output_tokens":"456","output_tokens_details":{"thinking_tokens":"70"}}}}
{"timestamp":"2026-09-21T00:00:01Z","type":"assistant","sessionId":"p96","requestId":"r2","message":{"id":"m2","model":"glm-96","usage":{"input_tokens":"123","cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":456}}}"#;
        let p = parse_jsonl("claude-code", "p96.jsonl", CLAUDE_96);
        let totals: Vec<i64> = p.events.iter().map(|e| e.tokens.total()).collect();
        assert_eq!(totals, vec![5139, 579], "{:?}", p.events);
        assert_eq!(
            (p.events[0].tokens.input, p.events[0].tokens.cached, p.events[0].tokens.cache_write, p.events[0].tokens.output, p.events[0].tokens.reasoning),
            (123, 4500, 60, 456, 70)
        );

        // Pi：首行 BOM 不能把 type=session 打成坏行（否则 project 永久为空）
        const PI_96: &str = "\u{feff}{\"type\":\"session\",\"version\":3,\"id\":\"p96pi\",\"timestamp\":\"2026-09-21T00:00:00Z\",\"cwd\":\"/work/项目-96\"}\n{\"type\":\"message\",\"id\":\"pi-1\",\"timestamp\":\"2026-09-21T00:01:00Z\",\"message\":{\"role\":\"assistant\",\"model\":\"glm-96\",\"usage\":{\"input\":\"240\",\"cacheRead\":\"1000\",\"cacheWrite\":\"30\",\"output\":\"170\",\"reasoning\":\"40\"}}}";
        let pi = parse_jsonl("pi", "p96pi.jsonl", PI_96);
        assert_eq!(pi.malformed_lines, 0, "BOM 行不是坏行");
        assert_eq!(pi.events.len(), 1, "{:?}", pi.events);
        assert_eq!(pi.events[0].tokens.total(), 1440);
        assert!(!pi.events[0].project.is_empty(), "首行必须被消费掉");

        // Grok：字符串用量 + 空 modelUsage + 缺 modelUsage
        const GROK_96: &str = r#"{"timestamp":1789900000,"params":{"sessionId":"p96grok","update":{"sessionUpdate":"turn_completed","prompt_id":"t1","usage":{"inputTokens":"2000","cachedReadTokens":"1500","cacheCreationTokens":"100","outputTokens":"80","modelUsage":{"glm-96":{"inputTokens":"2000","cachedReadTokens":"1500","cacheCreationTokens":"100","outputTokens":"80"}}}}}}
{"timestamp":1789900060,"params":{"sessionId":"p96grok","update":{"sessionUpdate":"turn_completed","prompt_id":"t2","usage":{"inputTokens":500,"cachedReadTokens":100,"cacheCreationTokens":0,"outputTokens":30,"modelUsage":{}}}}}
{"timestamp":1789900120,"params":{"sessionId":"p96grok","update":{"sessionUpdate":"turn_completed","prompt_id":"t3","usage":{"inputTokens":700,"cachedReadTokens":0,"cacheCreationTokens":20,"outputTokens":60}}}}
{"timestamp":1789900180,"params":{"sessionId":"p96grok","update":{"sessionUpdate":"turn_completed","prompt_id":"t4","usage":{"inputTokens":0,"cachedReadTokens":0,"outputTokens":0,"modelUsage":{}}}}}"#;
        let grok = parse_jsonl("grok", "updates.jsonl", GROK_96);
        let gt: Vec<i64> = grok.events.iter().map(|e| e.tokens.total()).collect();
        assert_eq!(gt, vec![2180, 530, 780], "空 modelUsage 的一轮不能整条丢掉：{:?}", grok.events);
        assert_eq!(grok.events[1].model, "grok", "回落轮次没有模型名");

        // dsh / WorkBuddy 同一条规则
        const DSH_96: &str = r#"{"type":"session","seq":1,"time":1789900000000,"cwd":"/work/项目-96"}
{"type":"assistant/message","seq":9,"time":1789900060000,"data":{"message":{"source":{"model":"glm-96"}},"usage":{"inputTokens":"400","cacheReadTokens":"1000","cacheWriteTokens":"30","outputTokens":"50","reasoningTokens":"10"}}}"#;
        let dsh = parse_jsonl("dsh", "session.v3.jsonl.zstd", DSH_96);
        assert_eq!(dsh.events.len(), 1, "{:?}", dsh.events);
        assert_eq!(dsh.events[0].tokens.total(), 1480);
        assert_eq!(dsh.events[0].tokens.reasoning, 10);

        const WB_96: &str = r#"{"timestamp":1789900000000,"id":"wb-96","sessionId":"p96wb","providerData":{"model":"glm-96","traceId":"tr-96"},"message":{"usage":{"input_tokens":"500","cache_read_input_tokens":"300","output_tokens":"50"}}}"#;
        let wb = parse_jsonl("workbuddy", "p96wb.jsonl", WB_96);
        assert_eq!(wb.events.len(), 1, "{:?}", wb.events);
        assert_eq!(wb.events[0].tokens.total(), 550);
        assert_eq!((wb.events[0].tokens.input, wb.events[0].tokens.cached), (200, 300), "input 含缓存，拆列后总数不变");

        // number() 的边界：非数字文本/null/bool/负数一律 0，与原 as_i64 兜底同式
        let v: Value = json!({"a":"12a","b":null,"c":true,"d":-5,"e":" 456 ","f":12.7});
        assert_eq!(
            (number(&v, "a"), number(&v, "b"), number(&v, "c"), number(&v, "d"), number(&v, "e"), number(&v, "f")),
            (0, 0, 0, 0, 456, 12)
        );
    }

    /// #85 双端共享夹具：桌面端与 Node 端读同一份 JSONL，必须得到同一组
    /// (ts, total, project) 与同一批工具调用。Node 端同一份记录写在
    /// `test/run.mjs` 的 [28] 段。
    /// 修前四处分叉：project 存整条绝对路径（Node 存末段）、claude 空模型仍入库成
    /// `unknown`（Node 整条丢弃）、无 id 的 tool_use 全部塌成同一个键、
    /// 秒级 timestamp 两端归一与否不同。
    #[test]
    fn project_model_and_tool_identity_match_node_on_one_fixture() {
        const CLAUDE_85: &str = r#"{"timestamp":"2026-09-22T00:00:00Z","type":"assistant","sessionId":"p85","requestId":"r1","cwd":"D:\\Work\\我的 项目","message":{"id":"m1","model":"glm-85","usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":30},"content":[{"type":"tool_use","name":"Read"},{"type":"tool_use","name":"Grep"}]}}
{"timestamp":"2026-09-22T00:00:01Z","type":"assistant","sessionId":"p85","requestId":"r2","cwd":"D:\\Work\\我的 项目","message":{"id":"m2","model":"","usage":{"input_tokens":9,"output_tokens":9},"content":[{"type":"tool_use","name":"Bash","id":"t-2"}]}}
{"timestamp":"2026-09-22T00:00:02Z","type":"assistant","sessionId":"p85","requestId":"r3","cwd":"D:\\Work\\我的 项目","message":{"id":"m3","model":"<synthetic>","usage":{"input_tokens":7,"output_tokens":7}}}"#;
        let claude = parse_jsonl("claude-code", "p85.jsonl", CLAUDE_85);
        assert_eq!(claude.events.len(), 1, "空 model 与 <synthetic> 都不是一次真实调用：{:?}", claude.events);
        assert_eq!((claude.events[0].ts, claude.events[0].tokens.total()), (1_790_035_200_000, 155));
        // project 是路径末段，不是整条 cwd
        assert_eq!(claude.events[0].project, "我的 项目");
        // 两个无 id 的 tool_use 必须各自成一行（此前共用空 id → 主键相撞，只剩一条）
        assert_eq!(claude.activities.len(), 2, "{:?}", claude.activities);
        assert_ne!(claude.activities[0].id, claude.activities[1].id);
        assert_eq!(
            claude.activities.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            vec!["Read", "Grep"],
            "被丢弃的那条记录里的工具调用也不得入库"
        );

        // Pi：project 只写在首行的 cwd 里，同样取末段
        const PI_85: &str = r#"{"type":"session","version":3,"id":"p85pi","timestamp":"2026-09-22T00:00:00Z","cwd":"/work/我的 项目"}
{"type":"message","id":"pi-1","timestamp":"2026-09-22T00:01:00Z","message":{"role":"assistant","model":"glm-85","usage":{"input":240,"cacheRead":1000,"cacheWrite":30,"output":170,"reasoning":40},"content":[{"type":"toolCall","name":"read"},{"type":"toolCall","name":"exec","id":"c-1"}]}}"#;
        let pi = parse_jsonl("pi", "p85pi.jsonl", PI_85);
        assert_eq!(pi.events.len(), 1, "{:?}", pi.events);
        assert_eq!(pi.events[0].project, "我的 项目");
        assert_eq!(pi.activities.len(), 2);
        assert_ne!(pi.activities[0].id, pi.activities[1].id, "无 id 的 toolCall 按块序号定位");

        // Codex：session_meta.cwd 取末段；无 call_id 的 function_call 也要各自成行
        const CODEX_85: &str = r#"{"timestamp":"2026-09-22T00:00:00Z","type":"session_meta","payload":{"id":"p85cx","cwd":"D:\\Work\\我的 项目"}}
{"timestamp":"2026-09-22T00:00:01Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"glm-85"}}}
{"timestamp":"2026-09-22T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10},"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}
{"timestamp":"2026-09-22T00:00:03Z","type":"response_item","payload":{"type":"function_call","name":"shell"}}
{"timestamp":"2026-09-22T00:00:04Z","type":"response_item","payload":{"type":"function_call","name":"shell"}}"#;
        let codex = parse_jsonl("codex", "p85cx.jsonl", CODEX_85);
        assert_eq!(codex.events.len(), 1);
        assert_eq!(codex.events[0].project, "我的 项目");
        assert_eq!(codex.activities.len(), 2, "{:?}", codex.activities);

        // Grok：目录名是 URL 编码的整条路径，解出来还要取末段；
        // 缺 toolCallId 或缺 title/kind 的工具调用两端都不记
        const GROK_85: &str = r#"{"timestamp":1789900000,"params":{"sessionId":"p85gk","update":{"sessionUpdate":"turn_completed","prompt_id":"t1","usage":{"inputTokens":2000,"cachedReadTokens":1500,"cacheCreationTokens":100,"outputTokens":80}}}}
{"timestamp":1789900060,"params":{"sessionId":"p85gk","update":{"sessionUpdate":"tool_call","title":"检索","kind":"search"}}}
{"timestamp":1789900120,"params":{"sessionId":"p85gk","update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"检索"}}}
{"timestamp":1789900180,"params":{"sessionId":"p85gk","update":{"sessionUpdate":"tool_call","toolCallId":"call-2"}}}"#;
        // 真实布局：.../sessions/<encodeURIComponent(绝对路径)>/<会话uuid>/updates.jsonl。
        // 编码结果写成字面量而不是现场调用编码器：这一串就是磁盘上真实存在的目录名
        // （见 collectors/grok.js 顶部注释的实测形态），现场编码会把"编码器选哪张表"
        // 这件事也变成被测行为的一部分，而我们要测的是解码。
        // 它是 JS 的 encodeURIComponent(String.raw`D:\Work\我的 项目`)。
        const ENCODED_85: &str =
            "D%3A%5CWork%5C%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE";
        let grok = parse_jsonl("grok", &format!("sessions/{ENCODED_85}/85gk/updates.jsonl"), GROK_85);
        assert_eq!(grok.events.len(), 1);
        assert_eq!(grok.events[0].tokens.total(), 2180);
        assert_eq!(grok.events[0].project, "我的 项目", "解码之后还要取末段");
        assert_eq!(grok.activities.len(), 1, "{:?}", grok.activities);
        assert_eq!(grok.activities[0].name, "检索");
        assert_eq!(grok.activities[0].id, "p85gk:call-1");

        // dsh / WorkBuddy：秒级时间戳归一为毫秒（此前 Node 端直接用，事件落到 1970 年）
        const DSH_85: &str = r#"{"type":"session","seq":1,"time":1789990000,"cwd":"/work/我的 项目"}
{"type":"assistant/message","seq":2,"time":1789990060,"data":{"message":{"source":{"model":"glm-85"}},"usage":{"inputTokens":400,"cacheReadTokens":1000,"cacheWriteTokens":30,"outputTokens":50,"reasoningTokens":10}}}"#;
        let dsh = parse_jsonl("dsh", "session.v3.jsonl.zstd", DSH_85);
        assert_eq!(dsh.events.len(), 1, "{:?}", dsh.events);
        assert_eq!(dsh.events[0].ts, 1_789_990_060_000, "秒级 time ×1000");
        assert_eq!(dsh.events[0].project, "我的 项目");
        assert_eq!(dsh.events[0].tokens.total(), 1480);

        // #75：两种缓存写入拼写同时出现在一条记录里且数值不同 → 无法判定上游说的是哪个量，
        // 两端都**拒读记 0**（此前 Math.max / .max() 会静默取 999，凭空造一个没用过的数）。
        // Node 端同一条记录与同样的期望数字在 test/run.mjs 的 [#85 WorkBuddy] 段。
        const WB_85: &str = r#"{"timestamp":1789990120,"id":"wb-85","sessionId":"p85wb","providerData":{"model":"glm-85","traceId":"tr-85"},"message":{"usage":{"input_tokens":500,"cached_input_tokens":300,"output_tokens":50}}}
{"timestamp":1789990300000,"id":"wb-85c","sessionId":"p85wb","providerData":{"model":"glm-85"},"message":{"usage":{"input_tokens":300,"cache_read_input_tokens":100,"cache_creation_input_tokens":999,"cache_write_input_tokens":10,"output_tokens":30}}}"#;
        let wb = parse_jsonl("workbuddy", r"D:\Work\.WorkBuddy\projects\x-WorkBuddy-我的 项目\p85wb.jsonl", WB_85);
        assert_eq!(wb.events.len(), 2, "{:?}", wb.events);
        assert_eq!(wb.events[0].ts, 1_789_990_120_000);
        assert_eq!(wb.events[0].project, "我的 项目", "目录名取 -WorkBuddy- 之后那段");
        assert_eq!(wb.events[0].tokens.total(), 550);
        assert_eq!(wb.events[1].tokens.cache_write, 0, "两种拼写冲突时不许取较大者");
        assert_eq!(wb.events[1].tokens.total(), 330, "200+100+0+30，而非取较大者的 1329");
    }

    /// #85：工具身份与记录类型门槛，四项都是"两端同一份日志必须给出同一张榜"。
    /// ① codex 的 function_call/custom_tool_call 只在 `type=response_item` 时算工具活动
    ///    （Node `collectCodexFile` 同一条记录级门槛；event_msg 里的回放会数两遍）；
    /// ② `custom_tool_call` 是真实工具调用，Node 端这次一并补上，两端都不少；
    /// ③ 上游没给 id 的工具调用按行号定位，绝不塌成同一个键互相顶掉；
    /// ④ 带用量却读不到时间的记录计入 malformed（结构性无时间的行不算坏数据）。
    #[test]
    fn tool_record_gate_and_line_identity_and_malformed_ts() {
        const CODEX_85B: &str = r#"{"timestamp":"2026-09-22T00:00:00Z","type":"session_meta","payload":{"id":"g85","cwd":"/work/p85"}}
{"timestamp":"2026-09-22T00:00:01Z","type":"event_msg","payload":{"type":"function_call","name":"shell","call_id":"echoed"}}
{"timestamp":"2026-09-22T00:00:02Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","call_id":"c-1"}}
{"timestamp":"2026-09-22T00:00:03Z","type":"response_item","payload":{"type":"function_call","name":"shell"}}
{"timestamp":"2026-09-22T00:00:04Z","type":"response_item","payload":{"type":"function_call","name":"read"}}"#;
        let codex = parse_jsonl("codex", "g85.jsonl", CODEX_85B);
        assert_eq!(
            codex.activities.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            vec!["apply_patch", "shell", "read"],
            "event_msg 里的回放不得计入工具活动，custom_tool_call 必须计入"
        );
        let ids = codex
            .activities
            .iter()
            .map(|a| a.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["g85:c-1", "g85:line:4", "g85:line:5"], "{ids:?}");

        // 带 usage 却没有可用时间 → 真实丢数，计 malformed；session_meta 天生没有时间 → 不计
        const BAD_TS: &str = r#"{"type":"session_meta","payload":{"id":"g86","cwd":"/work/p86"}}
{"timestamp":"not-a-time","type":"assistant","sessionId":"g86","message":{"id":"m1","model":"glm-85","usage":{"input_tokens":10,"output_tokens":5}}}"#;
        let broken = parse_jsonl("claude-code", "g86.jsonl", BAD_TS);
        assert!(broken.events.is_empty(), "{:?}", broken.events);
        assert_eq!(broken.malformed_lines, 1, "只丢时间的那条用量必须被记成坏行");

        const NO_MSG_ID: &str = r#"{"timestamp":"2026-09-22T00:00:00Z","type":"assistant","sessionId":"g87","message":{"model":"glm-85","usage":{"input_tokens":10,"output_tokens":5}}}"#;
        // 缺 message.id：Node 端整条丢弃（`if (!usage || !msg?.id) return;`）。
        // 此前桌面端造了个 `{session}:{ts}:{行号}` 的合成键入库——重扫时行号一动就重复计数，
        // 桌面端的事件数与请求数因此恒高于 Node 端。
        assert!(parse_jsonl("claude-code", "g87.jsonl", NO_MSG_ID).events.is_empty());
        assert_eq!(parse_jsonl("claude-code", "g87.jsonl", NO_MSG_ID).malformed_lines, 0);

        // 同一类缺陷的另外两个实例：Node 端对"编不出稳定去重键"的行一律不入库
        // （pi 是 `rec.id ?? msg.responseId` 都缺就 return，workbuddy 是 `!rec.id` 就 return），
        // 桌面端此前给它们造了 `{ts}:{行号}` 的合成键——全量重扫一次就多计一次。
        const PI_NO_ID: &str = r#"{"timestamp":"2026-09-22T00:00:00Z","type":"message","sessionId":"p88","message":{"role":"assistant","model":"glm-85","usage":{"input":10,"output":5},"content":[{"type":"toolCall","name":"read"}]}}"#;
        let pi = parse_jsonl("pi", "p88.jsonl", PI_NO_ID);
        assert!(
            pi.events.is_empty(),
            "无 id / responseId 的 Pi 用量不得入库：{:?}",
            pi.events
        );
        assert_eq!(pi.activities.len(), 1, "工具调用在 Node 端位于这道关卡之前");

        const WB_NO_ID: &str = r#"{"timestamp":1789990120000,"sessionId":"p89","message":{"usage":{"input_tokens":10,"output_tokens":5}}}"#;
        assert!(
            parse_jsonl("workbuddy", "p89.jsonl", WB_NO_ID).events.is_empty(),
            "无 rec.id 的 WorkBuddy 用量不得入库"
        );
    }

    /// #85：win32 语义的路径末段规则，两端同式（Node 用 path.win32.basename）。
    #[test]
    fn win32_basename_matches_the_node_rule_it_replaces() {
        for (input, want) in [
            (r"D:\Work\我的 项目", "我的 项目"),
            ("/work/proj/", "proj"),
            ("D:/a/b/", "b"),
            ("x", "x"),
            ("项目", "项目"),
            (r"\nas\share\proj", "proj"),
            ("\\\\127.0.0.1\\c$\\a\\b", "b"),
            // 取不到末段时原样返回（Node 端是 `basename(x) || x`），绝不退化成空
            (r"D:\", r"D:\"),
            ("C:", "C:"),
            ("/", "/"),
            ("", ""),
        ] {
            let got = project_name(input);
            assert_eq!(got, want, "{input:?}");
        }
    }
}
