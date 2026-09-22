//! Synthetic offline fixtures, using the established collectors' token accounting contracts.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tokenmonitor_core::{config, db, model::Query, scanner, service};

const TS: i64 = 1_800_000_000_000;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tm-中文 空格-{}", uuid::Uuid::new_v4()));
        config::initialize(&path).unwrap();
        Self(path)
    }
    fn jsonl(&self, agent: &str, records: &[Value]) -> String {
        let dir = self.0.join("sources").join(agent);
        fs::create_dir_all(&dir).unwrap();
        let text = records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\r\n")
            + "\r\n";
        if agent == "dsh" {
            // Each line is an independent zstd frame, as in the real append-only format.
            let bytes: Vec<u8> = text
                .split_inclusive('\n')
                .flat_map(|line| zstd::stream::encode_all(line.as_bytes(), 1).unwrap())
                .collect();
            fs::write(dir.join("session.v3.jsonl.zstd"), bytes).unwrap();
        } else {
            fs::write(dir.join("session.jsonl"), text).unwrap();
        }
        dir.display().to_string()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

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
fn sqlite(path: &Path) -> Connection {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let c = Connection::open(path).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    c
}

#[test]
fn all_eleven_sources_minute_filters_and_repeated_scans() {
    let f = Fixture::new();
    let mut roots = BTreeMap::new();
    let mut add = |agent: &str, records: Vec<Value>| {
        roots.insert(agent.into(), vec![f.jsonl(agent, &records)]);
    };
    add(
        "codex",
        vec![
            json!({"type":"session_meta","payload":{"id":"codex-session","cwd":"D:\\我的 项目"}}),
            json!({"type":"turn_context","payload":{"model":"m"}}),
            json!({"timestamp":TS,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}),
            // Duplicate cumulative observation must not count as another request.
            json!({"timestamp":TS+1000,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}),
        ],
    );
    for agent in ["claude-code", "ccmr"] {
        let record = json!({"timestamp":TS,"type":"assistant","sessionId":"claude-session","cwd":"D:\\我的 项目","message":{"id":"message-1","model":"m","usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":40},"content":[{"type":"tool_use","id":"tool-1","name":"Read"}]}});
        add(agent, vec![record.clone(), record]);
    }
    add(
        "workbuddy",
        vec![
            json!({"timestamp":TS,"id":"wb-1","sessionId":"wb-session","providerData":{"model":"m"},"message":{"usage":{"input_tokens":500,"cached_input_tokens":300,"output_tokens":50}}}),
        ],
    );
    add(
        "pi",
        vec![
            json!({"type":"session","id":"pi-session","cwd":"D:\\我的 项目"}),
            json!({"timestamp":TS,"type":"message","id":"pi-1","message":{"role":"assistant","model":"m","usage":{"input":240,"cacheRead":1000,"cacheWrite":300,"output":170}}}),
        ],
    );
    add(
        "dsh",
        vec![
            json!({"type":"session","time":TS-1000,"cwd":"D:\\我的 项目"}),
            json!({"type":"assistant/message","seq":1,"time":TS,"data":{"message":{"source":{"model":"m"}},"usage":{"inputTokens":400,"cacheReadTokens":1000,"cacheWriteTokens":30,"outputTokens":50}}}),
        ],
    );
    add(
        "grok",
        vec![
            json!({"timestamp":TS/1000,"params":{"sessionId":"grok-session","update":{"sessionUpdate":"turn_completed","prompt_id":"turn-1","usage":{"modelUsage":{"m":{"inputTokens":2000,"cachedReadTokens":1500,"cacheCreationTokens":100,"outputTokens":80}}}}}}),
        ],
    );

    let zpath = f.0.join("sources/zcode/db.sqlite");
    let z = sqlite(&zpath);
    z.execute_batch("CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE model_usage(id TEXT,session_id TEXT,model_id TEXT,started_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,cache_creation_input_tokens INTEGER,cache_read_input_tokens INTEGER);CREATE TABLE tool_usage(session_id TEXT,tool_name TEXT,started_at INTEGER);INSERT INTO session VALUES('z-session','D:/我的 项目');").unwrap();
    z.execute(
        "INSERT INTO model_usage VALUES('z-1','z-session','m',?1,800,60,0,0,700)",
        [TS],
    )
    .unwrap();
    z.execute("INSERT INTO tool_usage VALUES('z-session','Bash',?1)", [TS])
        .unwrap();
    // Pending, missing and invalid negative usage must not inflate request counts.
    for (id, value) in [
        ("z-empty", Some(0)),
        ("z-null", None),
        ("z-negative", Some(-20)),
    ] {
        z.execute(
            "INSERT INTO model_usage VALUES(?1,'z-session','unknown',?2,?3,?3,?3,?3,?3)",
            params![id, TS, value],
        )
        .unwrap();
    }
    roots.insert("zcode".into(), vec![zpath.display().to_string()]);

    let opath = f.0.join("sources/opencode/db.sqlite");
    let o = sqlite(&opath);
    o.execute_batch("CREATE TABLE session(id TEXT,directory TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);INSERT INTO session VALUES('o-session','D:/我的 项目');").unwrap();
    o.execute("INSERT INTO message VALUES('o-1','o-session',?1,?2)",params![TS,json!({"role":"assistant","modelID":"m","time":{"created":TS},"tokens":{"input":100,"output":200,"reasoning":30,"cache":{"read":300,"write":100}}}).to_string()]).unwrap();
    roots.insert("opencode".into(), vec![opath.display().to_string()]);

    let apath = f.0.join("sources/antigravity/conversations/a-session.db");
    let a = sqlite(&apath);
    a.execute_batch("CREATE TABLE steps(idx INTEGER,metadata BLOB);CREATE TABLE gen_metadata(idx INTEGER,data BLOB);").unwrap();
    let timestamp = blob(1, &number(1, (TS / 1000) as u64));
    let usage = [
        number(2, 100),
        number(3, 806),
        number(4, 30),
        number(5, 200),
        number(9, 750),
        number(10, 56),
    ]
    .concat();
    let generation = blob(1, &[blob(4, &usage), blob(19, b"m")].concat());
    a.execute("INSERT INTO steps VALUES(1,?1)", [timestamp])
        .unwrap();
    a.execute("INSERT INTO gen_metadata VALUES(1,?1)", [generation])
        .unwrap();
    let index_path = f.0.join("sources/antigravity/conversation_summaries.db");
    let index = sqlite(&index_path);
    index
        .execute_batch(
            "CREATE TABLE conversation_summaries(conversation_id TEXT,workspace_uris TEXT);",
        )
        .unwrap();
    index
        .execute(
            "INSERT INTO conversation_summaries VALUES('a-session',?1)",
            [json!(["file:///D:/我的%20项目"]).to_string()],
        )
        .unwrap();
    roots.insert("antigravity".into(), vec![index_path.display().to_string()]);

    // Qoder：转录只喂 credits 面（token 字段服务端恒 0），真实 token 来自兄弟
    // 目录里同名的 <会话id>/state.json。两个面写在同一棵目录下，扫描必须各归各。
    // 明文载荷按真机形状 {latest, total:{…}, credits}，且 total.input_tokens
    // 已含 cache_read ⇒ 落库拆成 70/50/0/40，total=160（不是 210 也不是 120）。
    let qrecords = vec![
        json!({"type":"assistant","timestamp":TS,"sessionId":"q-session","cwd":"D:\\我的 项目","isSidechain":false,"message":{"model":"m","usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0,"credits":0.25,"original_credits":0.25,"billable":true,"request_id":"q-req-1","context_usage_ratio":0.2}}}),
        // 同一 request_id 的第二份抄本不得再计一次
        json!({"type":"assistant","timestamp":TS+1000,"sessionId":"q-session","message":{"model":"m","usage":{"credits":0.25,"request_id":"q-req-1"}}}),
        // sidechain 抄本归 subagents/agent-*.jsonl，父转录跳过
        json!({"type":"assistant","timestamp":TS+2000,"sessionId":"q-session","isSidechain":true,"message":{"model":"m","usage":{"credits":2,"request_id":"q-side-1"}}}),
        json!({"type":"assistant","timestamp":TS+3000,"sessionId":"q-session","message":{"model":"<synthetic>","usage":{"credits":5,"request_id":"q-syn-1"}}}),
    ];
    let qdir = f.jsonl("qoder", &qrecords);
    let qstate = Path::new(&qdir).join("session");
    fs::create_dir_all(&qstate).unwrap();
    let qupdated = chrono::DateTime::from_timestamp_millis(TS)
        .unwrap()
        .to_rfc3339();
    fs::write(
        qstate.join("state.json"),
        json!({"sessionId":"q-session","revision":2,"createdAt":qupdated,"updatedAt":qupdated,
               "model":"m","cwd":"D:\\我的 项目",
               "total":{"input_tokens":120,"cache_read_input_tokens":50,
                        "cache_creation_input_tokens":0,"output_tokens":40},
               "credits":{"used":0,"remaining":0,"total":0}})
            .to_string(),
    )
    .unwrap();
    // 同名但非会话状态的文件（压缩状态）也躺在树里：本源必须认出并忽略它
    fs::create_dir_all(qstate.join("compression-v2")).unwrap();
    fs::write(
        qstate.join("compression-v2").join("state.json"),
        json!({"version":2,"state":{"seenFunctionResponseIds":[]}}).to_string(),
    )
    .unwrap();
    roots.insert("qoder".into(), vec![qdir]);
    let settings = config::Settings {
        roots,
        ..Default::default()
    };
    let expected = [
        ("codex", 120),
        ("claude-code", 100),
        ("ccmr", 100),
        ("workbuddy", 550),
        ("pi", 1710),
        ("dsh", 1480),
        ("grok", 2180),
        ("zcode", 860),
        ("opencode", 700),
        ("antigravity", 1136),
        ("qoder", 160),
    ];
    for _ in 0..2 {
        let statuses = scanner::scan(&f.0, &settings).unwrap();
        assert!(statuses.iter().all(|s| s.errors.is_empty()), "{statuses:?}");
        let cache = db::open_read(&f.0).unwrap();
        for (agent, total) in expected {
            let mut query = Query {
                start: TS,
                end: TS + 60_000,
                agent: Some(agent.into()),
                model: None,
                project: None,
                session: None,
                search: String::new(),
                time_zone: None, offset_minutes: 480,
            };
            let events = db::events(&cache, &query).unwrap();
            assert_eq!(events.len(), 1, "{agent}");
            assert_eq!(events[0].tokens.total(), total, "{agent}");
            query.start = TS + 60_000;
            query.end = TS + 120_000;
            assert!(db::events(&cache, &query).unwrap().is_empty(), "{agent}");
        }
    }
    // Exercise the same local query/export entry point used by the GUI. All sources
    // coexist, so a missing agent filter would leak ten unrelated records.
    for (agent, total) in expected {
        let mut query = Query {
            start: TS,
            end: TS + 60_000,
            agent: Some(agent.into()),
            model: None,
            project: None,
            session: None,
            search: String::new(),
            time_zone: None, offset_minutes: 480,
        };
        let dashboard = service::query_local(&f.0, "dashboard", &json!({"query":query})).unwrap();
        assert_eq!(dashboard["totals"]["totalTokens"], total, "{agent}");
        for grouping in [
            "models", "projects", "sessions", "agents", "days", "months", "series",
        ] {
            let sum: i64 = dashboard[grouping]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["totalTokens"].as_i64().unwrap())
                .sum();
            assert_eq!(sum, total, "{agent}: {grouping}");
        }
        let activity_page = service::query_local(
            &f.0,
            "activities",
            &json!({"query":query,"offset":0,"limit":100}),
        )
        .unwrap();
        let activities = activity_page["items"].as_array().unwrap();
        assert_eq!(dashboard["activityCount"], activity_page["total"]);
        assert!(
            activities.iter().all(|a| a["agent"] == agent),
            "{agent}: activity isolation"
        );
        assert_eq!(
            activities.len(),
            usize::from(matches!(agent, "claude-code" | "ccmr" | "zcode")),
            "{agent}: tool fixture"
        );
        let page =
            service::query_local(&f.0, "events", &json!({"query":query,"offset":0,"limit":1}))
                .unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["event"]["agent"], agent);
        assert_eq!(page["items"][0]["event"]["ts"], TS);
        let next =
            service::query_local(&f.0, "events", &json!({"query":query,"offset":1,"limit":1}))
                .unwrap();
        assert!(next["items"].as_array().unwrap().is_empty());
        for format in ["csv", "markdown", "xlsx"] {
            let path = f.0.join(format!("{agent}.{format}"));
            let result = service::query_local(
                &f.0,
                "export",
                &json!({"query":query,"format":format,"path":path}),
            )
            .unwrap();
            assert_eq!(result["rows"], 1, "{agent}: {format}");
            if format == "csv" {
                let text = fs::read_to_string(&path).unwrap();
                assert_eq!(text.lines().count(), 2);
                let row = text.lines().nth(1).unwrap();
                assert!(row.contains(&format!(",\"{agent}\",")));
                assert!(row.contains(&format!(",\"{total}\",\"unpriced\",")));
            } else if format == "markdown" {
                let text = fs::read_to_string(&path).unwrap();
                assert_eq!(text.lines().filter(|line| line.starts_with('|')).count(), 3);
                assert!(text.contains(&format!("|{agent}|")));
                assert!(text.contains(&format!("|{total}|unpriced|")));
            } else {
                // Native Save As tests independently inspect XLSX cell contents;
                // here verify each agent reaches the writer with one filtered row.
                assert!(fs::read(&path).unwrap().starts_with(b"PK"));
            }
        }
        query.start = TS + 60_000;
        query.end = TS + 120_000;
        let empty = service::query_local(&f.0, "dashboard", &json!({"query":query})).unwrap();
        assert_eq!(empty["totals"]["totalTokens"], 0);
        assert_eq!(empty["activityCount"], 0);
        let path = f.0.join(format!("{agent}.csv"));
        let result = service::query_local(
            &f.0,
            "export",
            &json!({"query":query,"format":"csv","path":path}),
        )
        .unwrap();
        assert_eq!(result["rows"], 0);
        assert_eq!(fs::read_to_string(path).unwrap().lines().count(), 1);
    }
    // credits 面：观测落 quota 表，且绝不携带 token 量（total 恒等式的另一半）。
    {
        let cache = db::open_read(&f.0).unwrap();
        let mut stmt = cache
            .prepare("SELECT session,payload FROM quota WHERE agent='qoder'")
            .unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert_eq!(rows[0].0, "q-req-1");
        let payload: Value = serde_json::from_str(&rows[0].1).unwrap();
        assert_eq!(payload["requests"], 1, "{payload}");
        assert_eq!(payload["credits"], 0.25);
        assert_eq!(payload["billable_requests"], 1);
        assert_eq!(payload["context_usage_ratio"], 0.2);
        assert!(
            payload.get("input_tokens").is_none() && payload.get("total").is_none(),
            "credits 观测不得携带 token 量：{payload}"
        );
    }
    // Read changes committed only in WAL and replace existing records without double counting.
    z.execute("UPDATE model_usage SET output_tokens=70 WHERE id='z-1'", [])
        .unwrap();
    scanner::scan(&f.0, &settings).unwrap();
    let cache = db::open_read(&f.0).unwrap();
    let q = Query {
        start: TS,
        end: TS + 60_000,
        agent: Some("zcode".into()),
        model: None,
        project: None,
        session: None,
        search: String::new(),
        time_zone: None, offset_minutes: 0,
    };
    let rows = db::events(&cache, &q).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].tokens.total(), 870);
}

/// #105 的硬隐私边界：Qoder 只注册 ~/.qoder-cn，同族其它家目录一律不发现、
/// 不扫描、不注册；`.auth`（密钥材料）永不进 roots。缺这一条断言，下一次改动
/// 就可能顺手把 ~/.qoder / ~/.qoderwork 也加进来。
#[test]
fn qoder_registers_only_qoder_cn_never_the_legacy_family() {
    assert!(
        config::AGENTS
            .iter()
            .any(|(agent, label)| *agent == "qoder" && *label == "Qoder"),
        "AGENTS 必须登记 qoder/Qoder：{:?}",
        config::AGENTS
    );
    let settings = config::Settings::default();
    let roots = settings.roots.get("qoder").expect("默认设置要有 qoder 根");
    assert_eq!(roots.len(), 1, "{roots:?}");
    for root in roots {
        let path = Path::new(root);
        assert!(path.is_absolute(), "{root}");
        assert_eq!(path.file_name().unwrap(), "projects", "{root}");
        if std::env::var_os("QODER_CN_HOME").is_none() {
            assert_eq!(
                path.parent().and_then(|p| p.file_name()).unwrap(),
                ".qoder-cn",
                "家目录相对根必须由 homedir 组装：{root}"
            );
        }
    }
    const FORBIDDEN: [&str; 6] = [
        ".qwenworkcn",
        ".qoderwork",
        ".qoderworkcn",
        ".qmind",
        ".qoder",
        ".qoder-cli",
    ];
    for (_, roots) in settings.roots {
        for root in roots {
            let path = Path::new(&root);
            let below = path.ancestors().skip(1).any(|a| {
                FORBIDDEN
                    .iter()
                    // .qoder-cn 以 .qoder 开头，但目录名必须整段相等才算同族
                    .any(|d| a.file_name().is_some_and(|n| n == std::ffi::OsStr::new(d)))
            });
            assert!(!below, "roots 落进了被禁的同族目录：{root}");
            assert!(
                !root.contains(".auth"),
                "密钥材料目录 .auth 永不进 roots：{root}"
            );
        }
    }
}
