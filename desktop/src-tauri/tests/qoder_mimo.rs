use rusqlite::Connection;
use serde_json::json;
use std::{collections::BTreeMap, fs, path::PathBuf};
use tokenmonitor_core::{
    collectors, config, db,
    model::{Event, Parsed, Query, Tokens},
    query, scanner,
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
fn qoder_credits_range_filters_sidechain_and_over_100_requests() {
    let f = Fixture::new();
    let mut cache = db::open(&f.0).unwrap();
    let records=(0..150).map(|i|json!({"type":"assistant","timestamp":1800000000000i64+i*1000,"sessionId":"s","cwd":"D:/repo","isSidechain":true,"message":{"model":"m","usage":{"credits":0.25,"request_id":format!("r{i}")}}}).to_string()).collect::<Vec<_>>().join("\n");
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
    q.project = Some("d:\\REPO".into());
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
    fs::write(&path,json!({"sessionId":"s","updatedAt":1800000000000i64,"total":{"input_tokens":100,"output_tokens":20}}).to_string()).unwrap();
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
