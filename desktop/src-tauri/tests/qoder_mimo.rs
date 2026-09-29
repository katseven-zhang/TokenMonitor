use rusqlite::Connection;
use serde_json::json;
use std::{collections::BTreeMap, fs, path::PathBuf};
use tokenmonitor_core::{
    collectors, config, db,
    model::{Event, Parsed, Query, Tokens, QODER_UNATTRIBUTED_MODEL},
    pricing::Prices, query, scanner,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("tm-source-audit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn query(agent: &str) -> Query {
    Query {
        start: 0,
        end: 2_000_000_000_000,
        agent: Some(agent.into()),
        session: None,
        project: None,
        model: None,
        search: String::new(),
        offset_minutes: 0,
        time_zone: None,
    }
}

#[test]
fn mimo_message_authority_reasoning_wal_and_archive_dedup() {
    let f = Fixture::new();
    let path = f.0.join("mimocode.db");
    let source = Connection::open(&path).unwrap();
    source.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE part(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); INSERT INTO session VALUES('parent','D:/project'),('child','D:/project');").unwrap();
    let usage = |output: i64| {
        json!({"role":"assistant","modelID":"mimo-v2.6-pro","tokens":{"input":10,"output":output,"reasoning":7,"cache":{"read":20,"write":3},"total":40+output}}).to_string()
    };
    source
        .execute(
            "INSERT INTO message VALUES('m1','parent',1800000000000,?1)",
            [usage(5)],
        )
        .unwrap();
    source
        .execute(
            "INSERT INTO message VALUES('m2','child',1800000001000,?1)",
            [usage(9)],
        )
        .unwrap();
    source.execute("INSERT INTO message VALUES('bad','parent',1800000000000,'broken'),('pending','parent',1800000000000,'{\"role\":\"assistant\"}')",[]).unwrap();
    source
        .execute(
            "INSERT INTO part VALUES('finish','parent',1800000000000,?1)",
            [json!({"type":"step-finish","tokens":{"input":9999,"output":9999}}).to_string()],
        )
        .unwrap();
    let parsed = collectors::read_sqlite("xiaomi-mimo", &path).unwrap();
    assert_eq!(parsed.events.len(), 2);
    assert_eq!(parsed.malformed_lines, 1);
    assert_eq!(
        parsed.events[0].tokens,
        Tokens {
            input: 10,
            cached: 20,
            cache_write: 3,
            output: 12,
            reasoning: 7
        }
    );
    let settings = config::Settings {
        roots: BTreeMap::from([("xiaomi-mimo".into(), vec![path.display().to_string()])]),
        ..Default::default()
    };
    scanner::scan(&f.0, &settings).unwrap();
    source
        .execute("UPDATE message SET data=?1 WHERE id='m1'", [usage(15)])
        .unwrap();
    scanner::scan(&f.0, &settings).unwrap();
    let mut cache = db::open(&f.0).unwrap();
    let q = query("xiaomi-mimo");
    let events = db::events(&cache, &q).unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events.iter().map(|e| e.tokens.total()).sum::<i64>(), 104);
    let updated = collectors::read_sqlite("xiaomi-mimo", &path).unwrap();
    db::replace_file(&mut cache, "archive.db", "xiaomi-mimo", 1, 1, &updated).unwrap();
    assert_eq!(db::events(&cache, &q).unwrap().len(), 2);
    assert!(db::events(&cache, &query("opencode")).unwrap().is_empty());
}

#[test]
fn qoder_snapshots_preserve_history_dedupe_copies_and_handle_reset() {
    let f = Fixture::new();
    let mut cache = db::open(&f.0).unwrap();
    let snapshot = |ts, input, output| Parsed {
        qoder_created_at: Some(60_000),
        events: vec![Event {
            id: format!("s|{ts}"),
            agent: "qoder".into(),
            session: "s".into(),
            project: "p".into(),
            model: "unknown".into(),
            ts,
            path: "state.json".into(),
            line: 0,
            tokens: Tokens {
                input,
                output,
                ..Default::default()
            },
        }],
        ..Default::default()
    };
    for (path, ts, input, output) in [
        ("live/state.json", 120_000, 100, 20),
        ("live/state.json", 180_000, 140, 30),
        ("archive/state.json", 120_000, 100, 20),
        ("old/state.json", 60_000, 60, 10),
    ] {
        db::replace_file(
            &mut cache,
            path,
            "qoder",
            1,
            ts,
            &snapshot(ts, input, output),
        )
        .unwrap();
    }
    let q = query("qoder");
    let events = db::events(&cache, &q).unwrap();
    assert_eq!(events.iter().map(|e| e.tokens.total()).sum::<i64>(), 170);
    assert_eq!(
        events.iter().map(|e| e.tokens.total()).collect::<Vec<_>>(),
        vec![70, 50, 50]
    );
    let mut narrow = q.clone();
    narrow.start = 120_000;
    narrow.end = 180_000;
    assert_eq!(db::events(&cache, &narrow).unwrap()[0].tokens.total(), 50);
    db::replace_file(
        &mut cache,
        "live/state.json",
        "qoder",
        1,
        240_000,
        &snapshot(240_000, 0, 0),
    )
    .unwrap();
    db::replace_file(
        &mut cache,
        "live/state.json",
        "qoder",
        1,
        300_000,
        &snapshot(300_000, 10, 3),
    )
    .unwrap();
    assert_eq!(
        db::events(&cache, &q)
            .unwrap()
            .iter()
            .map(|e| e.tokens.total())
            .sum::<i64>(),
        183
    );
    drop(cache);
    let cache = db::open(&f.0).unwrap();
    assert_eq!(
        db::events(&cache, &q)
            .unwrap()
            .iter()
            .map(|e| e.tokens.total())
            .sum::<i64>(),
        183
    );
}

#[test]
fn qoder_cross_day_watermarks_keep_baseline_without_false_daily_tokens() {
    let f = Fixture::new();
    let mut cache = db::open(&f.0).unwrap();
    let created = "2026-09-26T12:00:00Z";
    let ingest = |cache: &mut Connection, updated: &str, input: i64| {
        let state = json!({"sessionId":"cross-day","createdAt":created,"updatedAt":updated,"model":"qfmodel","total":{"input_tokens":input,"output_tokens":0}});
        let parsed = collectors::parse_qoder_state("state.json", &state.to_string());
        assert_eq!(parsed.qoder_created_at, Some(chrono::DateTime::parse_from_rfc3339(created).unwrap().timestamp_millis()));
        db::replace_file(cache,"live/state.json","qoder",1,1,&parsed).unwrap();
    };
    let on = |day: &str| {
        let start = chrono::DateTime::parse_from_rfc3339(&format!("{day}T00:00:00Z")).unwrap().timestamp_millis();
        let mut q = query("qoder");
        q.start = start;
        q.end = start + 86_400_000;
        q
    };
    ingest(&mut cache,"2026-09-27T12:00:00Z",100);
    assert!(db::events(&cache,&on("2026-09-27")).unwrap().is_empty());
    ingest(&mut cache,"2026-09-27T13:00:00Z",130);
    assert_eq!(db::events(&cache,&on("2026-09-27")).unwrap().iter().map(|e|e.tokens.total()).sum::<i64>(),30);
    ingest(&mut cache,"2026-09-28T12:00:00Z",200);
    assert!(db::events(&cache,&on("2026-09-28")).unwrap().is_empty());
    ingest(&mut cache,"2026-09-28T13:00:00Z",215);
    assert_eq!(db::events(&cache,&on("2026-09-28")).unwrap().iter().map(|e|e.tokens.total()).sum::<i64>(),15);
    ingest(&mut cache,"2026-09-28T13:00:00Z",215);
    assert_eq!(db::events(&cache,&on("2026-09-28")).unwrap().iter().map(|e|e.tokens.total()).sum::<i64>(),15);
    let unknown_start = json!({"sessionId":"missing-start","updatedAt":"2026-09-28T14:00:00Z","total":{"input_tokens":500}});
    let parsed = collectors::parse_qoder_state("state.json", &unknown_start.to_string());
    assert_eq!(parsed.qoder_created_at, None);
    db::replace_file(&mut cache,"unknown/state.json","qoder",1,1,&parsed).unwrap();
    assert_eq!(db::events(&cache,&on("2026-09-28")).unwrap().iter().map(|e|e.tokens.total()).sum::<i64>(),15);
}

#[test]
fn qoder_unattributed_model_is_separate_from_other_unknown_and_drills_down() {
    let f = Fixture::new();
    let mut cache = db::open(&f.0).unwrap();
    let at = 1_800_000_000_000i64;
    let event = |agent: &str, session: &str, input: i64| Event {
        id: session.into(), agent: agent.into(), session: session.into(), project: "p".into(),
        model: "unknown".into(), ts: at, tokens: Tokens { input, ..Default::default() },
        path: "state.json".into(), line: 0,
    };
    db::replace_file(&mut cache,"qoder/state.json","qoder",1,1,&Parsed {
        qoder_created_at: Some(at), events: vec![event("qoder","mixed",100)], ..Default::default()
    }).unwrap();
    db::replace_file(&mut cache,"other.jsonl","codex",1,1,&Parsed {
        events: vec![event("codex","other",50)], ..Default::default()
    }).unwrap();
    let prices = Prices::parse(r#"{"version":1,"currency":"USD","models":{}}"#).unwrap();
    let mut q = query("qoder"); q.agent = None;
    let board = query::dashboard(&cache,&q,&prices).unwrap();
    let models = board["models"].as_array().unwrap();
    assert!(models.iter().any(|r|r["key"]==QODER_UNATTRIBUTED_MODEL && r["totalTokens"]==100 && r["costUsd"].is_null()));
    assert!(models.iter().any(|r|r["key"]=="unknown" && r["totalTokens"]==50));
    q.model = Some(QODER_UNATTRIBUTED_MODEL.into());
    assert_eq!(db::events(&cache,&q).unwrap().len(),1);
    assert_eq!(db::event_page(&cache,&q,0,10).unwrap().0,1);
    assert_eq!(query::dashboard(&cache,&q,&prices).unwrap()["totals"]["totalTokens"],100);
    q.model = Some("unknown".into());
    assert_eq!(db::events(&cache,&q).unwrap().len(),1);
    assert_eq!(query::dashboard(&cache,&q,&prices).unwrap()["totals"]["totalTokens"],50);
}

#[test]
fn qoder_credits_range_filters_sidechain_and_over_100_requests() {
    let f = Fixture::new();
    let mut cache = db::open(&f.0).unwrap();
    let records=(0..150).map(|i|json!({"type":"assistant","timestamp":1800000000000i64+i*1000,"sessionId":"s","cwd":"D:/repo","isSidechain":true,"message":{"model":if i%2==0 {"qfmodel"} else {"qmodel_38max"},"usage":{"credits":0.25,"request_id":format!("r{i}")}}}).to_string()).collect::<Vec<_>>().join("\n");
    let parsed = collectors::parse_jsonl("qoder", "a.jsonl", &records);
    for path in ["parent.jsonl", "subagent.jsonl", "archive.jsonl"] {
        db::replace_file(&mut cache, path, "qoder", 1, 1, &parsed).unwrap();
    }
    let mut q = query("qoder");
    assert_eq!(query::qoder_credits(&cache, &q).unwrap().len(), 150);
    let summary = query::qoder_credit_summary(&cache, &q).unwrap();
    assert_eq!(summary.len(), 1);
    assert_eq!(summary[0]["payload"]["requests"], 150.0);
    assert_eq!(summary[0]["payload"]["credits"], 37.5);
    assert_eq!(summary[0]["payload"]["model_credits"]["qfmodel"], 18.75);
    assert_eq!(summary[0]["payload"]["model_credits"]["qmodel_38max"], 18.75);
    assert!(summary[0]["payload"]["original_credits"].is_null());
    q.start = 1800000001000;
    q.end = 1800000004000;
    let rows = query::qoder_credits(&cache, &q).unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter()
            .map(|r| r["payload"]["credits"].as_f64().unwrap())
            .sum::<f64>(),
        0.75
    );
    q.model = Some("other".into());
    assert!(query::qoder_credits(&cache, &q).unwrap().is_empty());
    q.model = None;
    q.session = Some("s".into());
    // #126：qoder 的 project 与其余十源同取 cwd 末段（"D:/repo" → "repo"），
    // 项目过滤按末段精确命中；不再依赖全路径的 Windows 折叠。
    q.project = Some("repo".into());
    assert_eq!(query::qoder_credits(&cache, &q).unwrap().len(), 3);
    q.session = Some("other".into());
    assert!(query::qoder_credits(&cache, &q).unwrap().is_empty());
}

#[test]
fn corrupt_qoder_state_preserves_cache_and_is_retried() {
    let f = Fixture::new();
    let dir = f.0.join("projects").join("s");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("state.json");
    fs::write(&path,json!({"sessionId":"s","createdAt":1800000000000i64,"updatedAt":1800000000000i64,"total":{"input_tokens":100,"output_tokens":20}}).to_string()).unwrap();
    let settings = config::Settings {
        roots: BTreeMap::from([("qoder".into(), vec![dir.display().to_string()])]),
        ..Default::default()
    };
    scanner::scan(&f.0, &settings).unwrap();
    fs::write(&path, "{broken").unwrap();
    for _ in 0..2 {
        let statuses = scanner::scan(&f.0, &settings).unwrap();
        assert_eq!(
            statuses.iter().find(|s| s.agent == "qoder").unwrap().state,
            "error"
        );
    }
    let cache = db::open(&f.0).unwrap();
    assert_eq!(
        db::events(&cache, &query("qoder")).unwrap()[0]
            .tokens
            .total(),
        120
    );
}

#[test]
fn qoder_reader_upgrade_retries_only_failed_state_files() {
    let f = Fixture::new();
    let cache = db::open(&f.0).unwrap();
    for (path,agent,error) in [
        (r"D:\logs\s\state.json","qoder",Some("old SDK reader")),
        (r"D:\logs\s.jsonl","qoder",Some("unrelated failure")),
        (r"D:\logs\other\state.json","other",Some("unrelated failure")),
        (r"D:\logs\ok\state.json","qoder",None),
    ] {
        cache.execute("INSERT INTO source_files VALUES(?1,?2,9,10,NULL,?3,11)",rusqlite::params![path,agent,error]).unwrap();
    }
    cache.execute("DELETE FROM cache_metadata WHERE key='qoder_key_revision'",[]).unwrap();
    drop(cache);
    let cache = db::open(&f.0).unwrap();
    let sizes = cache.prepare("SELECT size FROM source_files ORDER BY path").unwrap()
        .query_map([],|r|r.get::<_,i64>(0)).unwrap().map(Result::unwrap).collect::<Vec<_>>();
    assert_eq!(sizes,vec![9,9,9,-1]);
    cache.execute("UPDATE source_files SET size=9 WHERE agent='qoder' AND error IS NOT NULL",[]).unwrap();
    drop(cache);
    let cache = db::open(&f.0).unwrap();
    assert_eq!(cache.query_row("SELECT size FROM source_files WHERE agent='qoder' AND path LIKE '%state.json' AND error IS NOT NULL",[],|r|r.get::<_,i64>(0)).unwrap(),9);
}

#[test]
fn settings_upgrade_adds_sources_but_preserves_empty_roots_and_disabled() {
    let f = Fixture::new();
    config::initialize(&f.0).unwrap();
    let mut settings = config::Settings::default();
    settings.roots.remove("qoder");
    settings.roots.insert("xiaomi-mimo".into(), vec![]);
    settings.disabled_agents.push("qoder".into());
    config::save_json(&f.0.join("settings.json"), &settings).unwrap();
    let updated = config::settings(&f.0).unwrap();
    assert!(!updated.roots["qoder"].is_empty());
    assert!(updated.roots["xiaomi-mimo"].is_empty());
    assert!(updated.disabled_agents.contains(&"qoder".into()));
}
