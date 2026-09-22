//! Synthetic offline fixtures, using the established collectors' token accounting contracts.
//! Shared synthetic fixtures live in `tests/common/mod.rs`. Legacy runtime parity
//! was retired with #123; native golden accounting assertions remain here.
mod common;

use common::{sqlite, blob, number, Fixture, TS};
use rusqlite::params;
use std::collections::BTreeMap;
use tokenmonitor_core::{pricing::Prices, query};
use serde_json::{json, Value};
use std::{fs,path::Path};
use tokenmonitor_core::{config, db, model::Query, scanner, service};

#[test]
fn all_eleven_sources_minute_filters_and_repeated_scans() {
    let f = Fixture::new();
    let mut roots = f.ten_sources();
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
        // #85：project 必须是路径末段。此前这里存的是整条 cwd/URI/目录名，而 Node 端
        // 七个源取的都是末段——同一份日志在两个 UI 里就是两个项目，分组与钻取全对不上。
        // 夹具里各源的项目来源不同（cwd / session.directory / workspace_uris / 目录名），
        // 所以逐个登记期望值。
        const PROJECT_85: [(&str, &str); 11] = [
            ("qoder", "D:\\我的 项目"),
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
    let z = sqlite(&f.0.join("sources/zcode/db.sqlite"));
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

/// #75①②：缺 `total_token_usage` 的采样与"重复通知"的判据，两端各落几条。
/// 修前 Node 端在 `!info?.total_token_usage` 处整条 return，桌面端这边一直按
/// `info.last_token_usage` 落库 —— 同一份日志两端事件数不同。
/// 修前 Node 端判重复通知看的是上游 `total_tokens` 的差分（`d.tt<=0`），于是
/// "只有 reasoning 在动"的采样这边落一条各列全 0 的事件、桌面端 `total()>0` 一道关
/// 拦住，同样是一边多一条。期望统一为"这一轮算不出用量就不落库"。
/// Node 侧同一组期望数字见 test/windows/jsonl-a.test.mjs 的 [#75] 段。
#[test]
fn codex_snapshot_without_total_usage_and_duplicate_notifications_agree() {
    let u = |i: i64, c: i64, o: i64, r: i64, extra: &str| {
        format!(
            "{{\"input_tokens\":{i},\"cached_input_tokens\":{c},\"output_tokens\":{o},\"reasoning_output_tokens\":{r}{extra}}}"
        )
    };
    // ① 只有 last_token_usage：本轮量 500/400 + cw 20 + out 60 → 100+400+20+60 = 580
    let only_last = format!(
        r#"{{"timestamp":{TS},"type":"event_msg","payload":{{"type":"token_count","info":{{"last_token_usage":{}}}}}}}"#,
        u(500, 400, 60, 10, r#","cache_write_input_tokens":20"#)
    );
    let head = r#"{"type":"session_meta","payload":{"id":"codex-75","cwd":"D:\\我的 项目"}}"#;
    let p = tokenmonitor_core::collectors::parse_jsonl(
        "codex",
        "codex/75a.jsonl",
        &format!("{head}\r\n{only_last}\r\n"),
    );
    assert_eq!(p.events.len(), 1, "缺累计基线但带本轮量的一条不能丢");
    assert_eq!(p.events[0].tokens.total(), 580);
    assert_eq!(p.events[0].tokens.cache_write, 20);
    // 本轮没有累计值可读，累计水位不能被推进：下面这条带累计值的采样因此仍是"首个采样"
    let first_with_total = format!(
        r#"{{"timestamp":{},"type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{},"last_token_usage":{}}}}}}}"#,
        TS + 1000,
        u(1000, 800, 100, 40, r#","cache_write_input_tokens":30,"total_tokens":2000"#),
        u(200, 100, 40, 20, r#","cache_write_input_tokens":10"#),
    );
    let p2 = tokenmonitor_core::collectors::parse_jsonl(
        "codex",
        "codex/75a.jsonl",
        &format!("{head}\r\n{only_last}\r\n{first_with_total}\r\n"),
    );
    assert_eq!(p2.events.len(), 2);
    assert_eq!(p2.events[1].tokens.total(), 250, "首个采样只认本轮量，不记整段累计");

    // ② 重复通知 + "只有 reasoning / total_tokens 在动"：两条都不落库
    let dup = first_with_total.replace(
        &format!("\"timestamp\":{}", TS + 1000),
        &format!("\"timestamp\":{}", TS + 2000),
    );
    let reasoning_only = format!(
        r#"{{"timestamp":{},"type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{},"last_token_usage":{}}}}}}}"#,
        TS + 3000,
        u(1000, 800, 100, 90, r#","cache_write_input_tokens":30,"total_tokens":2050"#),
        u(200, 100, 40, 20, r#","cache_write_input_tokens":10"#),
    );
    let p3 = tokenmonitor_core::collectors::parse_jsonl(
        "codex",
        "codex/75b.jsonl",
        &format!("{head}\r\n{first_with_total}\r\n{dup}\r\n{reasoning_only}\r\n"),
    );
    assert_eq!(p3.events.len(), 1, "重复通知与零用量轮次都不能落库：{:#?}", p3.events.iter().map(|e| e.tokens.total()).collect::<Vec<_>>());
    assert_eq!(p3.events[0].tokens.total(), 250);
    assert!(
        p3.events.iter().all(|e| e.tokens.total() > 0),
        "两端都不许产出各列全 0 的事件"
    );
}

/// #75③：`cache_creation_input_tokens` 与 `cache_write_input_tokens` 是同一个累计量的
/// 两个写法。旧规则 `.max()` 假设"同一条记录只会出一种"，此前没有任何 fixture 证明过
/// 这个假设，而它在两处会错：
///  · 同一条记录两种都写且数值不同 → 无法判定，`.max()` 等于凭空取较大者。规则改为**拒读**
///    记 0（写法标 4），两端同式。
///  · 相邻两条采样各只写一种（codex 升级换字段名）→ 跨写法差分必然为负，被 `delta()`
///    的 `.max(0)` 静默清零，那一轮的缓存写入就这么没了。规则改为"写法变了 = 累计序列
///    断了"，与回落同一条处理：改读本条采样的 `last_token_usage`。
/// Node 侧同一组期望数字见 test/windows/jsonl-a.test.mjs 的 [#75] 段。
#[test]
fn codex_cache_write_spellings_conflict_and_switch() {
    let head = r#"{"type":"session_meta","payload":{"id":"codex-75c","cwd":"D:\\我的 项目"}}"#;
    let conflict = r#"{"timestamp":1800000000000,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"cache_creation_input_tokens":999,"cache_write_input_tokens":10,"output_tokens":100,"reasoning_output_tokens":40,"total_tokens":1800},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"cache_creation_input_tokens":999,"cache_write_input_tokens":10,"output_tokens":100,"reasoning_output_tokens":40}}}}"#;
    let p = tokenmonitor_core::collectors::parse_jsonl("codex", "codex/75c.jsonl", &format!("{head}\r\n{conflict}\r\n"));
    assert_eq!(p.events.len(), 1);
    assert_eq!(p.events[0].tokens.cache_write, 0, "两种写法数值冲突时无法判定，不许取较大者");
    assert_eq!(p.events[0].tokens.total(), 1100, "400+600+0+100");

    let agreed = conflict.replace("\"cache_creation_input_tokens\":999", "\"cache_creation_input_tokens\":45")
        .replace("\"cache_write_input_tokens\":10", "\"cache_write_input_tokens\":45");
    let p2 = tokenmonitor_core::collectors::parse_jsonl("codex", "codex/75d.jsonl", &format!("{head}\r\n{agreed}\r\n"));
    assert_eq!(p2.events.len(), 1);
    assert_eq!(p2.events[0].tokens.cache_write, 45, "两种写法一致只是重复写了一遍，照用");
    assert_eq!(p2.events[0].tokens.total(), 1145);

    // 跨写法：第一条只写 write（累计 500），第二条只写 creation（累计 345）。
    // 修前：345-500 = -155 → .max(0) → 这一轮 cache_write 记 0、总量 450。
    // 修后：写法变了按回落处理，读本条 last（本轮 creation 45）→ 45、总量 495。
    let s1 = r#"{"timestamp":1800000000000,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":500,"output_tokens":100,"reasoning_output_tokens":40,"total_tokens":2500},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"cache_write_input_tokens":500,"output_tokens":100,"reasoning_output_tokens":40}}}}"#;
    let s2 = r#"{"timestamp":1800000001000,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1400,"cached_input_tokens":1000,"cache_creation_input_tokens":345,"output_tokens":150,"reasoning_output_tokens":60,"total_tokens":3000},"last_token_usage":{"input_tokens":400,"cached_input_tokens":200,"cache_creation_input_tokens":45,"output_tokens":50,"reasoning_output_tokens":20}}}}"#;
    let p3 = tokenmonitor_core::collectors::parse_jsonl("codex", "codex/75e.jsonl", &format!("{head}\r\n{s1}\r\n{s2}\r\n"));
    let totals: Vec<i64> = p3.events.iter().map(|e| e.tokens.total()).collect();
    let writes: Vec<i64> = p3.events.iter().map(|e| e.tokens.cache_write).collect();
    assert_eq!(totals, vec![1600, 495], "换写法那一轮不能再被 .max(0) 清零：{totals:?}");
    assert_eq!(writes, vec![500, 45]);

    // 写法不变时相邻差分不受影响（防止把这条修成"每轮都回落"）
    let s3 = s2.replace("cache_creation_input_tokens", "cache_write_input_tokens");
    let p4 = tokenmonitor_core::collectors::parse_jsonl("codex", "codex/75f.jsonl", &format!("{head}\r\n{s1}\r\n{s3}\r\n"));
    assert_eq!(p4.events.iter().map(|e| e.tokens.total()).collect::<Vec<_>>(), vec![1600, 450],
        "同为 write 写法时走差分：400+200+0+50");
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

/// #75 第 5 项：`desktop/scripts/compare-local.mjs` 的 codex 样本必须 `equal: true`，
/// 但那个脚本原本只能对用户机器上的真实数据说话（`desktop/.dev-data/events-v2.sqlite`
/// + `~/.codex` 日志），CI 与离线审查都拿它没办法。这里把它的两端拆开各自钉住：
///
/// - **桌面端这一侧**就是下面这份黄金文件：`desktop/src-tauri/tests/fixtures/codex-parity/desktop-events.json`
///   逐字段等于 `collectors.rs` 现场解析 `rollout.jsonl` 产出的 `Event` 序列化结果，
///   也就是 `raw_events.data` 落库的那段 JSON（db.rs 直接 `serde_json::to_string(e)`）。
///   改采集器不改黄金 → 本测试红；改黄金不改采集器 → 本测试红。
/// - **legacy Node 这一侧**由 `node desktop/scripts/compare-local.mjs --fixture` 现场跑
///   `src/collectors/codex.js` 与上面这段黄金 JSON 对照（同一份 rollout 文件），
///   断言在 `test/windows/codex-blackbox.test.mjs`。
///
/// fixture 覆盖 #75 修过的每一条：首个采样取本轮量、稳态差分、cache_write 换写法、
/// 两种写法同时且不等（拒读记 0）、compaction 回落、重复通知不落库（7 行 → 6 条事件）。
/// 六条总量 [880000,440000,240000,230000,345000,223000] = 2,358,000，cached 合计 1,250,000。
#[test]
fn compare_local_golden_is_what_the_desktop_collector_produces() {
    const REL: &str = "desktop/src-tauri/tests/fixtures/codex-parity/rollout.jsonl";
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let text = fs::read_to_string(root.join(REL)).unwrap();
    let golden: Vec<Value> =
        serde_json::from_str(&fs::read_to_string(root.join("desktop/src-tauri/tests/fixtures/codex-parity/desktop-events.json")).unwrap())
            .unwrap();
    let parsed = tokenmonitor_core::collectors::parse_jsonl("codex", REL, &text);
    assert_eq!(parsed.malformed_lines, 0, "fixture 本身不能有坏行");
    assert_eq!(parsed.events.len(), golden.len(), "{:#?}", parsed.events);
    for (index, event) in parsed.events.iter().enumerate() {
        let actual = serde_json::to_value(event).unwrap();
        assert_eq!(actual, golden[index], "第 {} 条事件与 compare-local 的黄金不符", index + 1);
        assert_eq!(
            event.tokens.total(),
            golden[index]["tokens"]["input"].as_i64().unwrap()
                + golden[index]["tokens"]["cached"].as_i64().unwrap()
                + golden[index]["tokens"]["cacheWrite"].as_i64().unwrap()
                + golden[index]["tokens"]["output"].as_i64().unwrap(),
            "落库公式 total = input + cached + cacheWrite + output"
        );
    }
    assert_eq!(
        parsed.events.iter().map(|e| e.tokens.total()).sum::<i64>(),
        2_358_000,
        "六条事件的总量黄金数"
    );
    assert_eq!(
        parsed.events.iter().map(|e| e.tokens.cached).sum::<i64>(),
        1_250_000,
        "cached 单独合计：compare-local 比的就是这两项 + 事件数"
    );
}

/// #71 第 7 项：antigravity 的两处秒→毫秒（行内完成时间 `gen.9.4` 与 `steps.metadata.1`）
/// 之前是裸 `sec * 1000 + nanos / 1e6`。上游把一个离谱的秒值写进这两个 varint 里，
/// debug 构造直接 overflow panic（采集这一源就断在 `read_antigravity` 里），release 构造
/// 回绕成一个 1970 前后的荒唐日期——面板上那条事件既不落在它该在的时间桶，也不报错。
/// 现在换算不出来就是"这条没有可用时间"：坏行计 malformed，同库的健康行照常入库。
#[test]
fn antigravity_bogus_second_timestamp_is_not_a_date() {
    let root = std::env::temp_dir().join(format!("tokenmonitor-agy-71-{}", uuid::Uuid::new_v4()));
    let conv = root.join("conversations/a-session.db");
    let db = sqlite(&conv);
    db.execute_batch("CREATE TABLE steps(idx INTEGER,metadata BLOB);CREATE TABLE gen_metadata(idx INTEGER,data BLOB);")
        .unwrap();
    const SEC: u64 = 1_800_000_000;
    const BOGUS: u64 = i64::MAX as u64; // 乘 1000 必然溢出 i64
    let step_time = |sec: u64| blob(1, &[number(1, sec), number(2, 0)].concat());
    let inline_time = |sec: u64, nanos: u64| {
        blob(9, &blob(4, &[number(1, sec), number(2, nanos)].concat()))
    };
    let usage = || blob(4, &[number(2, 10), number(3, 5), number(5, 0)].concat());

    // 1) 行内时间是坏秒值，回退用的 steps 时间也是坏秒值 → 这一行没有时间，不入库
    db.execute("INSERT INTO steps VALUES(1,?1)", [step_time(BOGUS)]).unwrap();
    db.execute(
        "INSERT INTO gen_metadata VALUES(1,?1)",
        [blob(1, &[usage(), inline_time(BOGUS, 0), blob(19, b"g71-bogus")].concat())],
    )
    .unwrap();
    // 2) 只有坏的行内时间、steps 时间正常 → 回退后照常入库（证明拒的是溢出，不是整源）
    db.execute("INSERT INTO steps VALUES(2,?1)", [step_time(SEC + 60)]).unwrap();
    db.execute(
        "INSERT INTO gen_metadata VALUES(2,?1)",
        [blob(1, &[usage(), inline_time(BOGUS, 0), blob(19, b"g71-fallback")].concat())],
    )
    .unwrap();
    // 3) 行内时间是正常秒值 → 毫秒换算照常
    db.execute(
        "INSERT INTO gen_metadata VALUES(3,?1)",
        [blob(1, &[usage(), inline_time(SEC + 10, 500_000_000), blob(19, b"g71-ok")].concat())],
    )
    .unwrap();
    drop(db);

    let parsed = tokenmonitor_core::collectors::read_antigravity(&conv, "a-project").unwrap();
    let by_model = |name: &str| {
        parsed
            .events
            .iter()
            .find(|e| e.model == name)
            .cloned()
            .unwrap_or_else(|| panic!("事件缺失：{name} 现有 {:?}", parsed.events))
    };
    assert!(
        parsed.events.iter().all(|e| e.model != "g71-bogus"),
        "两处时间都换算不出来的行不能编一个日期入库：{:?}",
        parsed.events
    );
    assert_eq!(parsed.malformed_lines, 1, "{:?}", parsed.events);
    assert_eq!(parsed.events.len(), 2, "{:?}", parsed.events);
    assert_eq!(by_model("g71-fallback").ts, (SEC as i64 + 60) * 1000);
    assert_eq!(by_model("g71-ok").ts, (SEC as i64 + 10) * 1000 + 500);
    assert!(by_model("g71-ok").ts > 1_700_000_000_000, "正常值仍是正常日期");
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
