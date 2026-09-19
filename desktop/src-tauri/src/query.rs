use crate::{
    db,
    model::{Event, Query, Tokens},
    pricing::Prices,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub key: String,
    pub label: String,
    pub tokens: Tokens,
    pub total_tokens: i64,
    pub known_cost_usd: f64,
    pub cost_usd: Option<f64>,
    pub unpriced_events: usize,
    pub events: usize,
    pub first_ts: i64,
    pub last_ts: i64,
    pub agent: String,
    pub session: String,
    pub path: String,
}
impl Summary {
    fn add(&mut self, e: &Event, p: &Prices) {
        self.tokens.add(&e.tokens);
        self.total_tokens += e.tokens.total();
        self.events += 1;
        self.first_ts = if self.first_ts == 0 {
            e.ts
        } else {
            self.first_ts.min(e.ts)
        };
        self.last_ts = self.last_ts.max(e.ts);
        match p.cost(e) {
            Some(c) => self.known_cost_usd += c,
            None => self.unpriced_events += 1,
        };
        self.cost_usd = if self.unpriced_events == 0 {
            Some(self.known_cost_usd)
        } else {
            None
        };
        self.agent = e.agent.clone();
        self.session = e.session.clone();
        self.path = e.path.clone();
    }
}
pub fn summarize(events: &[Event], prices: &Prices) -> Summary {
    let mut summary = Summary {
        cost_usd: Some(0.0),
        ..Default::default()
    };
    for event in events {
        summary.add(event, prices);
    }
    summary
}
fn group(map: &mut BTreeMap<String, Summary>, key: &str, label: &str, e: &Event, p: &Prices) {
    map.entry(key.into())
        .or_insert_with(|| Summary {
            key: key.into(),
            label: label.into(),
            ..Default::default()
        })
        .add(e, p)
}
pub fn dashboard(db: &Connection, q: &Query, prices: &Prices) -> Result<Value, String> {
    let events = db::events(db, q)?;
    let titles = db::titles(db)?;
    let mut totals = Summary::default();
    let mut models = BTreeMap::new();
    let mut projects = BTreeMap::new();
    let mut sessions = BTreeMap::new();
    let mut agents = BTreeMap::new();
    let mut days = BTreeMap::new();
    let mut months = BTreeMap::new();
    let mut series = BTreeMap::new();
    let width = if q.end - q.start <= 86_400_000 {
        60_000
    } else if q.end - q.start <= 31 * 86_400_000 {
        3_600_000
    } else {
        86_400_000
    };
    let mut session_keys = BTreeSet::new();
    let mut all_models = BTreeSet::new();
    let mut all_projects = BTreeSet::new();
    for e in &events {
        totals.add(e, prices);
        group(&mut models, &e.model, &e.model, e, prices);
        group(
            &mut projects,
            &e.project,
            if e.project.is_empty() {
                "未记录项目"
            } else {
                &e.project
            },
            e,
            prices,
        );
        group(&mut agents, &e.agent, &e.agent, e, prices);
        let key = format!("{}:{}", e.agent, e.session);
        session_keys.insert(key.clone());
        group(
            &mut sessions,
            &key,
            titles.get(&e.path).unwrap_or(&e.session),
            e,
            prices,
        );
        let shifted =
            chrono::DateTime::from_timestamp_millis(e.ts + q.offset_minutes as i64 * 60_000)
                .ok_or("Invalid timestamp")?;
        let day = shifted.format("%Y-%m-%d").to_string();
        let month = shifted.format("%Y-%m").to_string();
        group(&mut days, &day, &day, e, prices);
        group(&mut months, &month, &month, e, prices);
        let bucket = (e.ts + q.offset_minutes as i64 * 60_000).div_euclid(width) * width
            - q.offset_minutes as i64 * 60_000;
        group(
            &mut series,
            &format!("{bucket:015}"),
            &bucket.to_string(),
            e,
            prices,
        );
        all_models.insert(e.model.clone());
        all_projects.insert(e.project.clone());
    }
    let activities = db::activities(db, q)?
        .into_iter()
        .filter(|a| {
            // When filtering by model/project/search, tool attribution is only known at session granularity.
            (q.model.is_none() && q.project.is_none() && q.search.is_empty())
                || session_keys.contains(&format!("{}:{}", a.agent, a.session))
        })
        .collect::<Vec<_>>();
    let mut tools: BTreeMap<String, usize> = BTreeMap::new();
    for a in &activities {
        *tools.entry(a.name.clone()).or_default() += 1;
    }
    let mut stmt=db.prepare("SELECT agent,session,ts,payload FROM quota WHERE ts<?1 AND (?2 IS NULL OR agent=?2) ORDER BY ts DESC LIMIT 100").map_err(|e|e.to_string())?;
    let quotas=stmt.query_map(params![q.end,q.agent],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?))).map_err(|e|e.to_string())?.map(|row|{let(a,s,t,p)=row.map_err(|e|e.to_string())?;Ok(json!({"agent":a,"session":s,"ts":t,"payload":serde_json::from_str::<Value>(&p).map_err(|e|e.to_string())?}))}).collect::<Result<Vec<_>,String>>()?;
    let mut stmt = db
        .prepare("SELECT data FROM scan_status ORDER BY agent")
        .map_err(|e| e.to_string())?;
    let status = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|r| {
            serde_json::from_str::<Value>(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(
        json!({"query":q,"totals":totals,"models":models.into_values().collect::<Vec<_>>(),"projects":projects.into_values().collect::<Vec<_>>(),"sessions":sessions.into_values().collect::<Vec<_>>(),"agents":agents.into_values().collect::<Vec<_>>(),"days":days.into_values().collect::<Vec<_>>(),"months":months.into_values().collect::<Vec<_>>(),"series":series.into_values().collect::<Vec<_>>(),"bucketMs":width,"tools":tools,"activities":activities,"quotas":quotas,"status":status,"availableModels":all_models,"availableProjects":all_projects,"eventCount":events.len()}),
    )
}
pub fn event_page(
    db: &Connection,
    q: &Query,
    p: &Prices,
    offset: usize,
    limit: usize,
) -> Result<Value, String> {
    let all = db::events(db, q)?;
    let items = all
        .iter()
        .rev()
        .skip(offset)
        .take(limit.min(500))
        .map(|e| json!({"event":e,"costUSD":p.cost(e)}))
        .collect::<Vec<_>>();
    Ok(json!({"total":all.len(),"items":items}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Parsed;
    #[test]
    fn minute_boundaries_agent_filter_and_duplicate_paths() {
        let root = std::env::temp_dir().join(format!("tokenmonitor-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut db = db::open(&root).unwrap();
        let p = Prices::parse(include_str!("../../config/prices.json")).unwrap();
        let make = |id: &str, agent: &str, ts| Event {
            id: id.into(),
            agent: agent.into(),
            session: "s".into(),
            project: "p".into(),
            model: "m".into(),
            ts,
            tokens: Tokens {
                input: 10,
                ..Default::default()
            },
            path: "a".into(),
            line: 1,
        };
        let parsed = Parsed {
            title: Some("独特会话标题".into()),
            events: vec![
                make("1", "codex", 60_000),
                make("2", "codex", 119_999),
                make("3", "codex", 120_000),
            ],
            ..Default::default()
        };
        db::replace_file(&mut db, "a", "codex", 1, 1, &parsed).unwrap();
        db::replace_file(&mut db, "archive", "codex", 1, 1, &parsed).unwrap();
        db::replace_file(
            &mut db,
            "b",
            "pi",
            1,
            1,
            &Parsed {
                events: vec![make("1", "pi", 60_000)],
                ..Default::default()
            },
        )
        .unwrap();
        let mut q = Query {
            start: 60_000,
            end: 120_000,
            agent: Some("codex".into()),
            model: None,
            project: None,
            session: None,
            search: String::new(),
            offset_minutes: 480,
        };
        let result = dashboard(&db, &q, &p).unwrap();
        assert_eq!(result["totals"]["totalTokens"], 20);
        assert_eq!(result["totals"]["unpricedEvents"], 2);
        assert!(result["totals"]["costUsd"].is_null());
        q.agent = None;
        assert_eq!(dashboard(&db, &q, &p).unwrap()["totals"]["totalTokens"], 30);
        q.search = "独特会话".into();
        q.agent = Some("codex".into());
        assert_eq!(dashboard(&db, &q, &p).unwrap()["totals"]["totalTokens"], 20);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
