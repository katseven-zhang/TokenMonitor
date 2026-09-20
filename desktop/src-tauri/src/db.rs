use crate::{
    model::{Activity, Event, Parsed, Query},
    pricing::Prices,
    types::{DailyUsageRow, ModelUsage},
};
use rusqlite::{params, Connection};
use std::{collections::BTreeMap, path::Path, time::Duration};

pub fn open_read(root: &Path) -> Result<Connection, String> {
    let db = Connection::open_with_flags(
        root.join("events-v2.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("用量缓存尚未就绪，请启动后台：{e}"))?;
    db.busy_timeout(Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    Ok(db)
}

pub fn open(root: &Path) -> Result<Connection, String> {
    let db = Connection::open(root.join("events-v2.sqlite")).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS source_files(path TEXT NOT NULL,agent TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,title TEXT,error TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(path,agent));
      CREATE TABLE IF NOT EXISTS raw_events(path TEXT NOT NULL,agent TEXT NOT NULL,id TEXT NOT NULL,ts INTEGER NOT NULL,session TEXT NOT NULL,model TEXT NOT NULL,project TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(path,agent,id));
      CREATE INDEX IF NOT EXISTS event_time ON raw_events(ts,agent);
      CREATE INDEX IF NOT EXISTS event_identity ON raw_events(agent,id);
      CREATE TABLE IF NOT EXISTS raw_activities(path TEXT NOT NULL,agent TEXT NOT NULL,id TEXT NOT NULL,ts INTEGER NOT NULL,session TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(path,agent,id));
      CREATE INDEX IF NOT EXISTS activity_time ON raw_activities(ts,agent);
      CREATE TABLE IF NOT EXISTS quota(path TEXT NOT NULL,agent TEXT NOT NULL,session TEXT NOT NULL,ts INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(path,agent,session,ts));
      CREATE TABLE IF NOT EXISTS scan_status(agent TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE VIEW IF NOT EXISTS events AS SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY agent,id ORDER BY path) AS rank FROM raw_events) WHERE rank=1;
      CREATE VIEW IF NOT EXISTS activities AS SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY agent,id ORDER BY path) AS rank FROM raw_activities) WHERE rank=1;").map_err(|e|e.to_string())?;
    let view_revision: Option<String> = db.query_row(
        "SELECT value FROM cache_metadata WHERE key='view_revision'", [], |r|r.get(0)
    ).ok();
    if view_revision.as_deref() != Some("2") {
        // A partial archive must not win merely because its pathname sorts first.
        // Prefer the latest observation, then the most recently modified source.
        // Keep both snapshots so deletion of one copy never deletes the other.
        db.execute_batch("BEGIN IMMEDIATE;
          DROP VIEW events;
          DROP VIEW activities;
          CREATE VIEW events AS SELECT * FROM (SELECT e.*,ROW_NUMBER() OVER(PARTITION BY e.agent,e.id ORDER BY e.ts DESC,COALESCE(f.mtime,0) DESC,e.path) AS rank FROM raw_events e LEFT JOIN source_files f ON f.path=e.path AND f.agent=e.agent) WHERE rank=1;
          CREATE VIEW activities AS SELECT * FROM (SELECT e.*,ROW_NUMBER() OVER(PARTITION BY e.agent,e.id ORDER BY e.ts DESC,COALESCE(f.mtime,0) DESC,e.path) AS rank FROM raw_activities e LEFT JOIN source_files f ON f.path=e.path AND f.agent=e.agent) WHERE rank=1;
          INSERT OR REPLACE INTO cache_metadata VALUES('view_revision','2');
          COMMIT;").map_err(|e|e.to_string())?;
    }
    // Bump when a collector's accounting changes. Rebuild snapshots from source logs,
    // while preserving cached data until each replacement transaction is ready.
    const COLLECTOR_REVISION: &str = "3";
    let revision: Option<String> = db
        .query_row(
            "SELECT value FROM cache_metadata WHERE key='collector_revision'",
            [],
            |r| r.get(0),
        )
        .ok();
    if revision.as_deref() != Some(COLLECTOR_REVISION) {
        db.execute_batch("BEGIN IMMEDIATE; UPDATE source_files SET size=-1;")
            .map_err(|e| e.to_string())?;
        db.execute(
            "INSERT OR REPLACE INTO cache_metadata VALUES('collector_revision',?1)",
            [COLLECTOR_REVISION],
        )
        .map_err(|e| e.to_string())?;
        db.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
    }
    Ok(db)
}
pub fn unchanged(db: &Connection, path: &str, agent: &str, size: i64, mtime: i64) -> bool {
    db.query_row("SELECT 1 FROM source_files WHERE path=?1 AND agent=?2 AND size=?3 AND mtime=?4 AND error IS NULL",params![path,agent,size,mtime],|_|Ok(())).is_ok()
}
pub fn replace_file(
    db: &mut Connection,
    path: &str,
    agent: &str,
    size: i64,
    mtime: i64,
    parsed: &Parsed,
) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    for table in ["raw_events", "raw_activities", "quota"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE path=?1 AND agent=?2"),
            params![path, agent],
        )
        .map_err(|e| e.to_string())?;
    }
    {
        let mut stmt = tx
            .prepare("INSERT OR REPLACE INTO raw_events VALUES(?1,?2,?3,?4,?5,?6,?7,?8)")
            .map_err(|e| e.to_string())?;
        for e in &parsed.events {
            stmt.execute(params![
                path,
                agent,
                e.id,
                e.ts,
                e.session,
                e.model,
                e.project,
                serde_json::to_string(e).map_err(|e| e.to_string())?
            ])
            .map_err(|e| e.to_string())?;
        }
        let mut stmt = tx
            .prepare("INSERT OR REPLACE INTO raw_activities VALUES(?1,?2,?3,?4,?5,?6)")
            .map_err(|e| e.to_string())?;
        for a in &parsed.activities {
            stmt.execute(params![
                path,
                agent,
                a.id,
                a.ts,
                a.session,
                serde_json::to_string(a).map_err(|e| e.to_string())?
            ])
            .map_err(|e| e.to_string())?;
        }
        let mut stmt = tx
            .prepare("INSERT OR REPLACE INTO quota VALUES(?1,?2,?3,?4,?5)")
            .map_err(|e| e.to_string())?;
        for q in &parsed.quotas {
            stmt.execute(params![
                path,
                agent,
                q.session,
                q.ts,
                serde_json::to_string(&q.payload).map_err(|e| e.to_string())?
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO source_files VALUES(?1,?2,?3,?4,?5,NULL,?6)",
        params![
            path,
            agent,
            size,
            mtime,
            parsed.title,
            chrono::Utc::now().timestamp_millis()
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
pub fn events(db: &Connection, q: &Query) -> Result<Vec<Event>, String> {
    q.validate()?;
    let labels = if q.search.is_empty() {
        BTreeMap::new()
    } else {
        titles(db)?
    };
    let search = q.search.to_lowercase();
    let mut without_search = q.clone();
    without_search.search.clear();
    let windows_project=q.project.as_deref().and_then(crate::model::windows_project_key).map(|key|key.trim_end_matches('/').to_string());
    let mut stmt=db.prepare("SELECT data FROM events WHERE ts>=?1 AND ts<?2 AND (?3 IS NULL OR agent=?3) AND (?4 IS NULL OR model=?4) AND (?5 IS NULL OR project=?5 OR (?7 IS NOT NULL AND lower(rtrim(replace(project,char(92),'/'),'/'))=?7)) AND (?6 IS NULL OR session=?6) ORDER BY ts,id").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(
            params![q.start, q.end, q.agent, q.model, q.project, q.session,windows_project],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for row in rows {
        let e: Event =
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if without_search.matches(&e)
            && (search.is_empty()
                || format!(
                    "{} {} {} {}",
                    e.model,
                    e.project,
                    e.session,
                    labels.get(&e.path).map(String::as_str).unwrap_or("")
                )
                .to_lowercase()
                .contains(&search))
        {
            out.push(e);
        }
    }
    Ok(out)
}
pub fn activities(db: &Connection, q: &Query) -> Result<Vec<Activity>, String> {
    let mut stmt=db.prepare("SELECT data FROM activities WHERE ts>=?1 AND ts<?2 AND (?3 IS NULL OR agent=?3) AND (?4 IS NULL OR session=?4) ORDER BY ts").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(params![q.start, q.end, q.agent, q.session], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}
pub fn titles(db: &Connection) -> Result<BTreeMap<String, String>, String> {
    let mut stmt = db
        .prepare("SELECT path,title FROM source_files WHERE title IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(|e| e.to_string())
}

// Adapter for the attributed reference replay parser. The new cache has no legacy daily tables.
#[derive(Debug, Clone)]
pub struct SessionRollupRecord {
    pub path: String,
    pub modified_at_ms: i64,
    pub size_bytes: i64,
    pub rows: Vec<DailyUsageRow>,
    pub prompt_title: Option<String>,
}
#[derive(Debug, Clone)]
pub struct SessionHierarchyRecord {
    pub path: String,
    pub prompt_title: Option<String>,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}
pub fn query_session_rollup_record(
    db: &Connection,
    path: &str,
) -> Result<Option<SessionRollupRecord>, String> {
    let meta = db.query_row(
        "SELECT size,mtime,title FROM source_files WHERE path=?1 AND agent='codex'",
        [path],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        },
    );
    let (size, mtime, title) = match meta {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut stmt = db
        .prepare("SELECT data FROM raw_events WHERE path=?1 AND agent='codex' ORDER BY ts")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([path], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let price_path = Path::new(db.path().unwrap_or(""))
        .parent()
        .unwrap_or(Path::new("."))
        .join("prices.json");
    let prices = std::fs::read_to_string(price_path)
        .ok()
        .and_then(|s| Prices::parse(&s).ok());
    let mut days: BTreeMap<String, DailyUsageRow> = BTreeMap::new();
    for row in rows {
        let e: Event =
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let date = chrono::DateTime::from_timestamp_millis(e.ts)
            .ok_or("Invalid timestamp")?
            .format("%Y-%m-%d")
            .to_string();
        let d = days.entry(date.clone()).or_insert_with(|| DailyUsageRow {
            date,
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: 0,
            cost_usd: 0.0,
            models: BTreeMap::new(),
            projects: BTreeMap::new(),
            updated_at: String::new(),
        });
        let input = e.tokens.input + e.tokens.cached + e.tokens.cache_write;
        d.input_tokens += input;
        d.cached_input_tokens += e.tokens.cached;
        d.output_tokens += e.tokens.output;
        d.reasoning_output_tokens += e.tokens.reasoning;
        d.total_tokens += e.tokens.total();
        d.cost_usd += prices.as_ref().and_then(|p| p.cost(&e)).unwrap_or(0.0);
        let m = d
            .models
            .entry(e.model.clone())
            .or_insert_with(ModelUsage::default);
        m.input_tokens += input;
        m.cached_input_tokens += e.tokens.cached;
        m.output_tokens += e.tokens.output;
        m.reasoning_output_tokens += e.tokens.reasoning;
        m.total_tokens += e.tokens.total();
        let p = d.projects.entry(e.project.clone()).or_default();
        p.input_tokens += input;
        p.cached_input_tokens += e.tokens.cached;
        p.output_tokens += e.tokens.output;
        p.total_tokens += e.tokens.total();
    }
    Ok(Some(SessionRollupRecord {
        path: path.into(),
        modified_at_ms: mtime,
        size_bytes: size,
        rows: days.into_values().collect(),
        prompt_title: title,
    }))
}
pub fn query_session_hierarchy_records(
    db: &Connection,
) -> Result<Vec<SessionHierarchyRecord>, String> {
    let mut stmt = db
        .prepare("SELECT path FROM source_files WHERE agent='codex'")
        .map_err(|e| e.to_string())?;
    let paths = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for p in paths {
        if let Some(r) = query_session_rollup_record(db, &p)? {
            out.push(SessionHierarchyRecord {
                path: p,
                prompt_title: r.prompt_title,
                input_tokens: r.rows.iter().map(|r| r.input_tokens).sum(),
                cached_input_tokens: r.rows.iter().map(|r| r.cached_input_tokens).sum(),
                output_tokens: r.rows.iter().map(|r| r.output_tokens).sum(),
                cost_usd: r.rows.iter().map(|r| r.cost_usd).sum(),
            });
        }
    }
    Ok(out)
}
