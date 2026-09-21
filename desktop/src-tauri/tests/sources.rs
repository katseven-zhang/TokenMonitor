//! Synthetic offline fixtures, using the established collectors' token accounting contracts.
//! The fixtures themselves live in `tests/common/mod.rs` so `tests/parity.rs`
//! drives the Node collectors over exactly the same files this test indexes.
mod common;

use common::{sqlite, Fixture, TS};
use serde_json::json;
use std::fs;
use tokenmonitor_core::{config, db, model::Query, scanner, service};

#[test]
fn all_ten_sources_minute_filters_and_repeated_scans() {
    let f = Fixture::new();
    let roots = f.ten_sources();
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
