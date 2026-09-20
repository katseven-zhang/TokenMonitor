use serde_json::json;
use std::{collections::BTreeSet, fs};
use tokenmonitor_core::{
    config, db,
    model::{Activity, Event, Parsed, Query, Tokens},
    service,
};

#[test]
fn activity_pages_reach_older_rows_and_preserve_all_filters() {
    let root = std::env::temp_dir().join(format!("tm-activity-pages-{}", uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let ts = 1_800_000_000_000;
    let mut cache = db::open(&root).unwrap();
    let event = Event {
        id: "usage".into(),
        agent: "codex".into(),
        session: "wanted".into(),
        project: "D:/project".into(),
        model: "model".into(),
        ts,
        tokens: Tokens {
            input: 1,
            ..Default::default()
        },
        path: "source".into(),
        line: 1,
    };
    let mut activities = (0..625)
        .map(|i| Activity {
            id: format!("call-{i:04}"),
            agent: "codex".into(),
            session: "wanted".into(),
            ts: ts + (i / 3) * 1000,
            name: if i % 2 == 0 { "Read" } else { "Write" }.into(),
            path: "source".into(),
            line: i as usize + 1,
        })
        .collect::<Vec<_>>();
    let mut outside = activities[0].clone();
    outside.id = "at-exclusive-end".into();
    outside.ts = ts + 300_000;
    activities.push(outside);
    let mut other = activities[0].clone();
    other.id = "different-session".into();
    other.session = "other".into();
    activities.push(other.clone());
    db::replace_file(
        &mut cache,
        "source",
        "codex",
        1,
        1,
        &Parsed {
            events: vec![event],
            activities,
            title: Some("fixture title".into()),
            ..Default::default()
        },
    )
    .unwrap();
    other.agent = "pi".into();
    other.id = "different-agent".into();
    other.path = "pi-source".into();
    db::replace_file(
        &mut cache,
        "pi-source",
        "pi",
        1,
        1,
        &Parsed {
            activities: vec![other],
            ..Default::default()
        },
    )
    .unwrap();
    let base = Query {
        start: ts,
        end: ts + 300_000,
        agent: Some("codex".into()),
        model: None,
        project: None,
        session: None,
        search: String::new(),
        offset_minutes: 480,
    };
    let all = service::query_local(
        &root,
        "activities",
        &json!({"query":base,"offset":0,"limit":100}),
    )
    .unwrap();
    assert_eq!(all["total"], 626);
    for mode in ["model", "project", "session", "search"] {
        let mut q = base.clone();
        match mode {
            "model" => q.model = Some("model".into()),
            "project" => q.project = Some("d:\\PROJECT\\".into()),
            "session" => q.session = Some("wanted".into()),
            _ => q.search = "fixture title".into(),
        }
        let dashboard = service::query_local(&root, "dashboard", &json!({"query":q})).unwrap();
        assert!(
            dashboard.get("activities").is_none(),
            "dashboard must not serialize full activity records"
        );
        assert_eq!(dashboard["activityCount"], 625);
        assert_eq!(dashboard["tools"]["Read"], 313);
        assert_eq!(dashboard["tools"]["Write"], 312);
        let mut ids = BTreeSet::new();
        let mut previous = None;
        for offset in (0..700).step_by(100) {
            let page = service::query_local(
                &root,
                "activities",
                &json!({"query":q,"offset":offset,"limit":100}),
            )
            .unwrap();
            assert_eq!(page["total"], 625);
            let items = page["items"].as_array().unwrap();
            assert_eq!(items.len(), 100.min(625 - offset));
            for item in items {
                assert_eq!(item["agent"], "codex");
                assert_eq!(item["session"], "wanted");
                let time = item["ts"].as_i64().unwrap();
                assert!(time >= ts && time < q.end);
                let id = item["id"].as_str().unwrap().to_string();
                if let Some((last_ts, last_id)) = &previous {
                    assert!(time < *last_ts || (time == *last_ts && id > *last_id));
                }
                previous = Some((time, id.clone()));
                assert!(ids.insert(id));
            }
        }
        assert_eq!(ids.len(), 625);
        assert!(ids.contains("call-0000"));
        assert!(ids.contains("call-0624"));
        let empty = service::query_local(
            &root,
            "activities",
            &json!({"query":q,"offset":625,"limit":100}),
        )
        .unwrap();
        assert!(empty["items"].as_array().unwrap().is_empty());
        q.start = ts + 300_000;
        q.end = ts + 360_000;
        // Session filtering preserves the activity at the new start boundary.
        q.model = None;
        q.project = None;
        q.search.clear();
        q.session = Some("wanted".into());
        let edge = service::query_local(&root, "activities", &json!({"query":q})).unwrap();
        assert_eq!(edge["total"], 1);
        assert_eq!(edge["items"][0]["id"], "at-exclusive-end");
    }
    drop(cache);
    fs::remove_dir_all(root).unwrap();
}
