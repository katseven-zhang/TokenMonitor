//! Synthetic offline fixtures, using the established collectors' token accounting contracts.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tokenmonitor_core::{config, db, model::Query, pricing::Prices, query, scanner, service};

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
fn all_ten_sources_minute_filters_and_repeated_scans() {
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
            // #75: 首个采样按 info.last_token_usage（本轮真实用量）记账。
            json!({"timestamp":TS,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10},"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}),
            // Duplicate cumulative observation must not count as another request.
            json!({"timestamp":TS+1000,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10},"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}),
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
    ];
    for _ in 0..2 {
        let statuses = scanner::scan(&f.0, &settings).unwrap();
        assert!(statuses.iter().all(|s| s.errors.is_empty()), "{statuses:?}");
        let cache = db::open_read(&f.0).unwrap();
        // #85：project 必须是路径末段。此前这里存的是整条 cwd/URI/目录名，而 Node 端
        // 七个源取的都是末段——同一份日志在两个 UI 里就是两个项目，分组与钻取全对不上。
        // 夹具里各源的项目来源不同（cwd / session.directory / workspace_uris / 目录名），
        // 所以逐个登记期望值。
        const PROJECT_85: [(&str, &str); 10] = [
            ("codex", "我的 项目"),          // session_meta.payload.cwd 末段
            ("claude-code", "我的 项目"),    // rec.cwd 末段
            ("ccmr", "我的 项目"),
            ("workbuddy", "workbuddy"),      // 目录名里没有 `-WorkBuddy-` 标记时整名即项目
            ("pi", "我的 项目"),             // type=session 的 cwd 末段
            ("dsh", "我的 项目"),
            ("grok", "sources"),             // sessions/<URL 编码路径>/<uuid>/ 的解码末段
            ("zcode", "我的 项目"),          // session.directory 末段
            ("opencode", "我的 项目"),
            ("antigravity", "我的 项目"),    // workspace_uris 第一个 file:// 项的末段
        ];
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
            let want = PROJECT_85.iter().find(|(a, _)| *a == agent).map(|(_, p)| *p).unwrap();
            assert_eq!(events[0].project, want, "{agent}: project 取末段");
            query.start = TS + 60_000;
            query.end = TS + 120_000;
            assert!(db::events(&cache, &query).unwrap().is_empty(), "{agent}");
        }
    }
    // Exercise the same local query/export entry point used by the GUI. All sources
    // coexist, so a missing agent filter would leak nine unrelated records.
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

/// #79：旧结构（assistant/chunk）同一 seq 的不同 step 必须各自成一行。
/// 事件缓存的主键是 (agent,id)，只按 seq 定键时后一条会整条顶掉前一条——
/// Node 端早就把 turn/step 带进键里（src/collectors/dsh.js），桌面端此前没有。
/// 同一份记录与同样的期望数字写在 test/windows/dsh.test.mjs 的 [#79] 段。
#[test]
fn dsh_same_seq_legacy_chunks_are_not_overwritten_in_the_cache() {
    let f = Fixture::new();
    let dir = f.jsonl(
        "dsh",
        &[
            json!({"type":"assistant/chunk","seq":7,"time":TS,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":100,"cacheReadTokens":10,"cacheWriteTokens":5,"outputTokens":20}}}}),
            json!({"type":"assistant/chunk","seq":7,"time":TS+1000,"data":{"turn":1,"step":2,"chunk":{"type":"usage","usage":{"inputTokens":200,"cacheReadTokens":20,"cacheWriteTokens":0,"outputTokens":40}}}}),
        ],
    );
    let mut roots = BTreeMap::new();
    roots.insert("dsh".to_string(), vec![dir]);
    let settings = config::Settings {
        roots,
        ..Default::default()
    };
    let query = Query {
        start: TS,
        end: TS + 60_000,
        agent: Some("dsh".into()),
        model: None,
        project: None,
        session: None,
        search: String::new(),
        time_zone: None, offset_minutes: 0,
    };
    for round in 0..2 {
        let statuses = scanner::scan(&f.0, &settings).unwrap();
        assert!(
            statuses.iter().all(|s| s.errors.is_empty()),
            "round {round}: {statuses:?}"
        );
        let cache = db::open_read(&f.0).unwrap();
        let events = db::events(&cache, &query).unwrap();
        assert_eq!(events.len(), 2, "round {round}: 同 seq 的两个 step 不能互相顶掉");
        assert_eq!(
            events.iter().map(|e| e.tokens.total()).sum::<i64>(),
            395,
            "round {round}"
        );
    }
}

/// #78（落库层）：两个来源把同一个模型写成不同大小写时，面板必须只出一行。
/// 修前 codex 记 `GLM-5.3-Flash`、claude-code 记 `glm-5.3-flash` 会在模型分组里
/// 拆成两行，而且只有与价目表键完全一致的那一行拿得到成本——另一行静默 unpriced。
/// 同一份记录与同样的期望数字写在 collectors.rs 的 #78 块（解析层）与
/// Node 端 test/run.mjs 的 [26] 段，三处任一改动都会同时变红。
/// 期望：1 个模型行 `glm-5.3-flash`，input 301200 / cached 1240000 /
/// cache_write 60000 / output 140000，合计 1741200 token，四列单价各 1/百万 → 1.7412。
#[test]
fn same_model_spelled_differently_across_sources_is_one_row() {
    const CODEX_78: &str = r#"{"timestamp":"2026-09-20T00:00:01Z","type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model":"GLM-5.3-Flash"}}}
{"timestamp":"2026-09-20T00:00:02Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":800000,"cached_input_tokens":600000,"cache_write_input_tokens":30000,"output_tokens":50000,"reasoning_output_tokens":20000,"total_tokens":880000},"last_token_usage":{"input_tokens":800000,"cached_input_tokens":600000,"cache_write_input_tokens":30000,"output_tokens":50000,"reasoning_output_tokens":20000}}}}
{"timestamp":"2026-09-20T00:00:03Z","type":"turn_context","payload":{"model":"  GLM-5.3-FLASH  "}}
{"timestamp":"2026-09-20T00:00:04Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1200000,"cached_input_tokens":900000,"cache_write_input_tokens":40000,"output_tokens":80000,"reasoning_output_tokens":30000,"total_tokens":1280000},"last_token_usage":{"input_tokens":400000,"cached_input_tokens":300000,"cache_write_input_tokens":10000,"output_tokens":30000,"reasoning_output_tokens":10000}}}}"#;
    const CLAUDE_78: &str = r#"{"timestamp":"2026-09-20T00:10:00Z","type":"assistant","sessionId":"claude-78","cwd":"/work/parity","requestId":"r-78","message":{"id":"msg-78","model":"glm-5.3-flash","usage":{"input_tokens":1200,"cache_read_input_tokens":340000,"cache_creation_input_tokens":20000,"output_tokens":60000,"output_tokens_details":{"thinking_tokens":7000}}}}"#;
    let root = std::env::temp_dir().join(format!("tokenmonitor-model-78-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut cache = db::open(&root).unwrap();
    let codex = tokenmonitor_core::collectors::parse_jsonl("codex", "codex/parity78.jsonl", CODEX_78);
    let claude = tokenmonitor_core::collectors::parse_jsonl("claude-code", "claude/parity78.jsonl", CLAUDE_78);
    // 价目表键故意写成大小写混合的配置：两侧都必须命中同一行、都拿到成本
    let prices = Prices::parse(
        r#"{"version":1,"currency":"USD","models":{"GLM-5.3-Flash":[{"input":1,"cached":1,"cacheWrite":1,"output":1}]}}"#,
    )
    .unwrap();
    db::replace_file(&mut cache, "codex/parity78.jsonl", "codex", 1, 1, &codex).unwrap();
    db::replace_file(&mut cache, "claude/parity78.jsonl", "claude-code", 1, 1, &claude).unwrap();
    let mut q = Query {
        start: 1_789_862_400_000,
        end: 1_789_863_060_000,
        agent: None,
        model: None,
        project: None,
        session: None,
        search: String::new(),
        time_zone: None,
        offset_minutes: 0,
    };
    let dash = query::dashboard(&cache, &q, &prices).unwrap();
    let models = dash["models"].as_array().unwrap().clone();
    assert_eq!(models.len(), 1, "同一模型的不同写法只能一行：{models:?}");
    assert_eq!(models[0]["key"], "glm-5.3-flash");
    assert_eq!(models[0]["totalTokens"], 1_741_200);
    assert_eq!(models[0]["events"], 3);
    assert_eq!(models[0]["unpricedEvents"], 0, "大小写变体不能静默不计费");
    assert!(
        (models[0]["knownCostUsd"].as_f64().unwrap() - 1.7412).abs() < 1e-9,
        "{models:?}"
    );
    assert_eq!(dash["availableModels"], json!(["glm-5.3-flash"]));
    assert_eq!(dash["totals"]["totalTokens"], 1_741_200);
    // 钻取用的标签就是落库的归一名：按归一名过滤必须拿到全部三条
    q.model = Some("glm-5.3-flash".into());
    let events = db::events(&cache, &q).unwrap();
    assert_eq!(events.len(), 3);
    assert!(events.iter().all(|e| e.model == "glm-5.3-flash"));
    assert_eq!(events.iter().map(|e| e.tokens.total()).sum::<i64>(), 1_741_200);
    drop(cache);
    std::fs::remove_dir_all(root).unwrap();
}

/// #85：Antigravity 与 Node 端 `collectors/antigravity.js` 的三处分支必须同式。
/// 同一份合成 protobuf 与同一组期望也写在
/// `test/sources/antigravity/antigravity.test.mjs`（f3=0 回退、行内时间优先）与
/// `test/run.mjs` 的 [28] 段。
/// ① output：f3 **为 0 或缺席**都算不可用（旧写法用 contains_key，于是 f3=0 的行
///    在桌面端记 0 输出、Node 端回推出 f10+f9）；可用时取 f3，其次 f10+f9，最后只剩 f9。
/// ② 时间：行内完成时间**优先**，缺失才回退同 idx 的 steps 时间（旧写法取 max，
///    steps 一行覆盖多次生成，取 max 会把事件推到比真实完成时间更晚的位置上）。
/// ③ 项目：workspace_uris 里**第一个 file:// 项**的末段（旧写法直接取 v[0] 并留整条路径，
///    数组里先出现 `untitled:` 时桌面端拿到的根本不是路径）。
/// ④ 零用量行：input/output/cacheRead 全 0 的一代不是请求（只带 cache 写入也不算），
///    Node 端在 total 之前先有这一道判据，此前桌面端只有 total>0 一道关。
/// steps 表读失败的两侧语义：Node 端扣住水位不越过未采样的生成（#95），桌面端整份结果
/// 判失败、保留缓存里已有的行（`collect_file` 不会用读不全的结果去替换缓存）——两条路径
/// 保证的是同一件事："读不到时间的那些生成不会永久丢失"，故不算漂移，见
/// docs/ARCHITECTURE.md 的 #85 段。
#[test]
fn antigravity_decoder_branches_and_project_match_node() {
    let root = std::env::temp_dir().join(format!("tokenmonitor-agy-85-{}", uuid::Uuid::new_v4()));
    let conv = root.join("conversations/a-session.db");
    let a = sqlite(&conv);
    a.execute_batch("CREATE TABLE steps(idx INTEGER,metadata BLOB);CREATE TABLE gen_metadata(idx INTEGER,data BLOB);")
        .unwrap();
    const SEC: u64 = 1_800_000_000;
    // steps 比行内完成时间**更晚**：取 max 的旧写法会在这里露馅
    let step_time = |sec: u64| blob(1, &[number(1, sec), number(2, 0)].concat());
    let inline_time = |sec: u64, nanos: u64| blob(9, &blob(4, &[number(1, sec), number(2, nanos)].concat()));
    // 1) f3 存在但为 0 → 回退 f10+f9 = 58+15 = 73；行内时间 SEC+10 优先于 steps 的 SEC+60
    let usage1 = [
        number(2, 100),
        number(3, 0),
        number(4, 30),
        number(5, 200),
        number(9, 15),
        number(10, 58),
    ]
    .concat();
    let gen1 = blob(
        1,
        &[
            blob(4, &usage1),
            inline_time(SEC + 10, 500_000_000),
            blob(19, b"Gemini-85"),
        ]
        .concat(),
    );
    // 2) f3 与 f10 都不在 → 只剩 thinking(f9) = 5；没有行内时间，用 steps 的 SEC+120
    let usage2 = [number(2, 10), number(9, 5)].concat();
    let gen2 = blob(1, &[blob(4, &usage2), blob(19, b"g85")].concat());
    // 3) 只有 cache 写入为正：Node 端在 total 之前先有一道"input/output/cacheRead 全 0
    //    → 零用量行"的判据，这一条不是一次请求，两端都必须不入库
    let usage3 = [number(2, 0), number(3, 0), number(4, 40), number(5, 0), number(10, 0)].concat();
    let gen3 = blob(1, &[blob(4, &usage3), blob(19, b"g85-zero")].concat());
    a.execute("INSERT INTO steps VALUES(1,?1)", [step_time(SEC + 60)])
        .unwrap();
    a.execute("INSERT INTO steps VALUES(2,?1)", [step_time(SEC + 120)])
        .unwrap();
    a.execute("INSERT INTO gen_metadata VALUES(1,?1)", [gen1])
        .unwrap();
    a.execute("INSERT INTO gen_metadata VALUES(2,?1)", [gen2])
        .unwrap();
    a.execute("INSERT INTO gen_metadata VALUES(3,?1)", [gen3])
        .unwrap();
    drop(a);

    let index_path = root.join("conversation_summaries.db");
    let index = sqlite(&index_path);
    index
        .execute_batch("CREATE TABLE conversation_summaries(conversation_id TEXT,workspace_uris TEXT);")
        .unwrap();
    index
        .execute(
            "INSERT INTO conversation_summaries VALUES('a-session',?1)",
            [json!(["untitled:empty", "file:///D:/我的%20项目/sub"]).to_string()],
        )
        .unwrap();
    drop(index);

    let projects = tokenmonitor_core::collectors::antigravity_projects(&index_path).unwrap();
    assert_eq!(
        projects.get("a-session").map(String::as_str),
        Some("sub"),
        "跳过非 file:// 项，且取路径末段：{projects:?}"
    );
    let parsed = tokenmonitor_core::collectors::read_antigravity(
        &conv,
        projects.get("a-session").map(String::as_str).unwrap_or(""),
    )
    .unwrap();
    assert_eq!(parsed.events.len(), 2, "{:?}", parsed.events);
    assert!(
        parsed.events.iter().all(|e| e.model != "g85-zero"),
        "只有 cache 写入为正的一代不是请求：{:?}",
        parsed.events
    );
    let e1 = parsed.events.iter().find(|e| e.model == "gemini-85").unwrap();
    let e2 = parsed.events.iter().find(|e| e.model == "g85").unwrap();
    assert_eq!(e1.tokens.output, 73, "f3=0 时按 f10+f9 回推");
    assert_eq!(e1.tokens.total(), 403);
    assert_eq!(
        e1.ts,
        (SEC as i64 + 10) * 1000 + 500,
        "行内时间优先，不取 steps 的更晚值"
    );
    assert_eq!(e1.project, "sub");
    assert_eq!(e2.tokens.output, 5, "f3/f10 都不在时只剩 thinking");
    assert_eq!(e2.tokens.total(), 15);
    assert_eq!(e2.ts, (SEC as i64 + 120) * 1000, "无行内时间才回退 steps");
    let _ = fs::remove_dir_all(&root);
}

/// #85：opencode 的工具调用时间与 Node 端 `collectors/opencode.js` 同一优先级——
/// `data.state.time.start`（工具真正开始的时刻）优先，行内没有才退回 part 行的
/// `time_created`。此前桌面端只认 `time_created`：一次跑了 60 秒的工具调用在桌面端
/// 落在结束那一刻、在 Node 端落在开始那一刻，同一次调用在两个时间轴上差出一轮执行时长。
/// 读不到任何时间的行计 malformed（桌面端独有的逐行健康信号；Node 端只有文件级
/// parse_errors，这一条差异记在 docs/ARCHITECTURE.md 的 #85 段）。
#[test]
fn opencode_tool_part_timestamp_prefers_state_time_start() {
    let root = std::env::temp_dir().join(format!("tokenmonitor-oc85-{}", uuid::Uuid::new_v4()));
    let path = root.join("db.sqlite");
    let db = sqlite(&path);
    db.execute_batch("CREATE TABLE session(id TEXT,directory TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);INSERT INTO session VALUES('o-s','D:/我的 项目');").unwrap();
    // 1) 行内有开始时间：列上的 time_created 晚了一分钟，必须让位
    db.execute("INSERT INTO part VALUES('p-1','o-s',?1,?2)", params![TS + 60_000, json!({"type":"tool","tool":"bash","callID":"c1","state":{"time":{"start":TS}}}).to_string()]).unwrap();
    // 2) 行内没有 state.time.start：退回 time_created
    db.execute("INSERT INTO part VALUES('p-2','o-s',?1,?2)", params![TS + 120_000, json!({"type":"tool","tool":"read","callID":"c2"}).to_string()]).unwrap();
    // 3) 两处时间都读不到：不入库，计 malformed
    db.execute("INSERT INTO part VALUES('p-3','o-s',0,?1)", [json!({"type":"tool","tool":"edit","callID":"c3"}).to_string()]).unwrap();
    // 4) 没有 callID：去重身份回落到 part.id（与 Node 端 `d.callID || p.id` 同式）
    db.execute("INSERT INTO part VALUES('p-4','o-s',?1,?2)", params![TS + 180_000, json!({"type":"tool","tool":"search"}).to_string()]).unwrap();
    // 5) 非工具 part：不参与工具榜，也不该被算成坏行
    db.execute("INSERT INTO part VALUES('p-5','o-s',?1,?2)", params![TS + 240_000, json!({"type":"text","text":"hi"}).to_string()]).unwrap();
    drop(db);

    let parsed = tokenmonitor_core::collectors::read_sqlite("opencode", &path).unwrap();
    let got: Vec<(String, i64)> = parsed
        .activities
        .iter()
        .map(|a| (a.id.clone(), a.ts))
        .collect();
    assert_eq!(
        got,
        vec![
            ("o-s:c1".to_string(), TS),
            ("o-s:c2".to_string(), TS + 120_000),
            ("o-s:p-4".to_string(), TS + 180_000),
        ],
        "{:?}",
        parsed.activities
    );
    assert_eq!(parsed.malformed_lines, 1, "只有读不到时间的工具行才是坏行");
    let _ = fs::remove_dir_all(&root);
}
