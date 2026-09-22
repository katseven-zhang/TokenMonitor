//! Explicit local acceptance probe. Writes only aggregate counts to stdout;
//! its isolated cache is removed on exit, including failures.
use serde_json::json;
use std::{collections::BTreeMap, fs, path::PathBuf};
use tokenmonitor_core::{
    config, db,
    model::{Query, Tokens},
    query, scanner,
};
struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn main() -> Result<(), String> {
    if std::env::args().nth(1).as_deref() != Some("--local-readonly") {
        return Err("requires explicit --local-readonly".into());
    }
    let root =
        Temp(std::env::temp_dir().join(format!("tm-local-source-audit-{}", uuid::Uuid::new_v4())));
    fs::create_dir_all(&root.0).map_err(|e| e.to_string())?;
    let mut settings = config::Settings::default();
    settings
        .roots
        .retain(|k, _| k == "qoder" || k == "xiaomi-mimo");
    let statuses = scanner::scan(&root.0, &settings)?;
    let cache = db::open(&root.0)?;
    let mut result = BTreeMap::new();
    for agent in ["qoder", "xiaomi-mimo"] {
        let q = Query {
            start: 0,
            end: 32_503_680_000_000,
            agent: Some(agent.into()),
            model: None,
            project: None,
            session: None,
            search: String::new(),
            offset_minutes: 0,
            time_zone: None,
        };
        let events = db::events(&cache, &q)?;
        let mut total = Tokens::default();
        for e in &events {
            total.add(&e.tokens);
        }
        let status = statuses.iter().find(|s| s.agent == agent).unwrap();
        let credits = query::qoder_credits(&cache, &q)?;
        result.insert(agent,json!({"events":events.len(),"tokens":total,"creditsRequests":credits.len(),"credits":credits.iter().fold(0.0,|n,r| n+r["payload"]["credits"].as_f64().unwrap_or(0.0)),"errors":status.errors.len(),"malformed":status.malformed_lines}));
    }
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|e| e.to_string())?
    );
    Ok(())
}
