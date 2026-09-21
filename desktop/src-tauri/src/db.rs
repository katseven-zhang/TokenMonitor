use crate::{
    model::{Activity, Event, Parsed, Query},
    pricing::Prices,
    types::{DailyUsageRow, ModelUsage},
};
use rusqlite::{params, Connection};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

// Counters that make the replay hot path testable: opening one session used to
// re-read `prices.json` per file and deserialize every event of every unrelated
// session in the cache. They are thread-local so a test can measure exactly the
// work its own call did while other tests run in parallel.
thread_local! {
    static PRICES_PARSE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static EVENT_DESERIALIZE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub fn prices_parse_count() -> usize {
    PRICES_PARSE_COUNT.with(|counter| counter.get())
}

pub fn event_deserialize_count() -> usize {
    EVENT_DESERIALIZE_COUNT.with(|counter| counter.get())
}

pub fn prices_path(db: &Connection) -> PathBuf {
    Path::new(db.path().unwrap_or(""))
        .parent()
        .unwrap_or(Path::new("."))
        .join("prices.json")
}

/// Read and parse `prices.json` once; callers keep the result and pass it down by
/// reference instead of paying one file read plus one parse per session.
pub fn load_prices(db: &Connection) -> Option<Prices> {
    PRICES_PARSE_COUNT.with(|counter| counter.set(counter.get() + 1));
    std::fs::read_to_string(prices_path(db))
        .ok()
        .and_then(|text| Prices::parse(&text).ok())
}

fn register_query_functions(db:&Connection)->Result<(),String> {
    let flags=rusqlite::functions::FunctionFlags::SQLITE_UTF8|rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC;
    db.create_scalar_function("tm_lower",1,flags,|ctx|Ok(ctx.get::<String>(0)?.to_lowercase())).map_err(|e|e.to_string())?;
    db.create_scalar_function("tm_project",1,flags,|ctx|Ok(crate::model::project_key(&ctx.get::<String>(0)?))).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn open_read(root: &Path) -> Result<Connection, String> {
    if !root.join("events-v2.sqlite").exists() {
        return Err("正在准备本地用量缓存；首次启动请稍候。若后台已停止，请点击顶部“启动”；启动失败原因请查看日志。".into());
    }
    let db = Connection::open_with_flags(
        root.join("events-v2.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| format!("无法读取本地用量缓存：{e}"))?;
    db.busy_timeout(Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    register_query_functions(&db)?;
    Ok(db)
}

pub fn open(root: &Path) -> Result<Connection, String> {
    let db = Connection::open(root.join("events-v2.sqlite")).map_err(|e| e.to_string())?;
    register_query_functions(&db)?;
    db.busy_timeout(Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS source_files(path TEXT NOT NULL,agent TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,title TEXT,error TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(path,agent));
      CREATE TABLE IF NOT EXISTS raw_events(path TEXT NOT NULL,agent TEXT NOT NULL,id TEXT NOT NULL,ts INTEGER NOT NULL,session TEXT NOT NULL,model TEXT NOT NULL,project TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(path,agent,id));
      CREATE INDEX IF NOT EXISTS event_time ON raw_events(ts,agent);
      CREATE INDEX IF NOT EXISTS event_identity ON raw_events(agent,id);
      CREATE TABLE IF NOT EXISTS raw_activities(path TEXT NOT NULL,agent TEXT NOT NULL,id TEXT NOT NULL,ts INTEGER NOT NULL,session TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(path,agent,id));
      CREATE INDEX IF NOT EXISTS activity_time ON raw_activities(ts,agent);
      CREATE INDEX IF NOT EXISTS activity_identity ON raw_activities(agent,id);
      CREATE TABLE IF NOT EXISTS quota(path TEXT NOT NULL,agent TEXT NOT NULL,session TEXT NOT NULL,ts INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(path,agent,session,ts));
      CREATE TABLE IF NOT EXISTS scan_status(agent TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_health(path TEXT NOT NULL,agent TEXT NOT NULL,malformed_lines INTEGER NOT NULL,PRIMARY KEY(path,agent));
      CREATE VIEW IF NOT EXISTS events AS SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY agent,id ORDER BY path) AS rank FROM raw_events) WHERE rank=1;
      CREATE VIEW IF NOT EXISTS activities AS SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY agent,id ORDER BY path) AS rank FROM raw_activities) WHERE rank=1;").map_err(|e|e.to_string())?;
    let view_revision: Option<String> = db.query_row(
        "SELECT value FROM cache_metadata WHERE key='view_revision'", [], |r|r.get(0)
    ).ok();
    if view_revision.as_deref() != Some("3") {
        // A partial archive must not win merely because its pathname sorts first.
        // Prefer the latest observation, then the most recently modified source.
        // Keep both snapshots so deletion of one copy never deletes the other.
        db.execute_batch("BEGIN IMMEDIATE;
          DROP VIEW events;
          DROP VIEW activities;
          DROP TABLE IF EXISTS event_current;
          DROP TABLE IF EXISTS activity_current;
          CREATE TABLE event_current(path TEXT NOT NULL,agent TEXT NOT NULL,id TEXT NOT NULL,ts INTEGER NOT NULL,session TEXT NOT NULL,model TEXT NOT NULL,project TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(agent,id));
          CREATE TABLE activity_current(path TEXT NOT NULL,agent TEXT NOT NULL,id TEXT NOT NULL,ts INTEGER NOT NULL,session TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(agent,id));
          INSERT INTO event_current SELECT path,agent,id,ts,session,model,project,data FROM (SELECT e.*,ROW_NUMBER() OVER(PARTITION BY e.agent,e.id ORDER BY e.ts DESC,COALESCE(f.mtime,0) DESC,e.path) AS rank FROM raw_events e LEFT JOIN source_files f ON f.path=e.path AND f.agent=e.agent) WHERE rank=1;
          INSERT INTO activity_current SELECT path,agent,id,ts,session,data FROM (SELECT e.*,ROW_NUMBER() OVER(PARTITION BY e.agent,e.id ORDER BY e.ts DESC,COALESCE(f.mtime,0) DESC,e.path) AS rank FROM raw_activities e LEFT JOIN source_files f ON f.path=e.path AND f.agent=e.agent) WHERE rank=1;
          CREATE INDEX current_event_time ON event_current(ts DESC,agent,id);
          CREATE INDEX current_event_agent_time ON event_current(agent,ts DESC,id);
          CREATE INDEX current_event_session_time ON event_current(agent,session,ts);
          CREATE INDEX current_activity_time ON activity_current(ts DESC,agent,id);
          CREATE INDEX current_activity_agent_time ON activity_current(agent,ts DESC,id);
          CREATE VIEW events AS SELECT * FROM event_current;
          CREATE VIEW activities AS SELECT * FROM activity_current;
          INSERT OR REPLACE INTO cache_metadata VALUES('view_revision','3');
          COMMIT;").map_err(|e|e.to_string())?;
    }
    // Bump when a collector's accounting changes. Rebuild snapshots from source logs,
    // while preserving cached data until each replacement transaction is ready.
    const COLLECTOR_REVISION: &str = "4";
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
pub fn malformed_lines(db: &Connection, path: &str, agent: &str) -> Result<usize, String> {
    db.query_row("SELECT malformed_lines FROM source_health WHERE path=?1 AND agent=?2",params![path,agent],|row|row.get(0)).map_err(|e|e.to_string())
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
    tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS changed_keys(kind TEXT,agent TEXT,id TEXT,PRIMARY KEY(kind,agent,id)); DELETE FROM changed_keys;").map_err(|e|e.to_string())?;
    for table in ["raw_events","raw_activities"] {
        tx.execute(&format!("INSERT OR IGNORE INTO changed_keys SELECT ?3,agent,id FROM {table} WHERE path=?1 AND agent=?2"),params![path,agent,table]).map_err(|e|e.to_string())?;
    }
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
    tx.execute("INSERT OR REPLACE INTO source_health VALUES(?1,?2,?3)",params![path,agent,parsed.malformed_lines]).map_err(|e|e.to_string())?;
    // Recompute only identities touched by this file, after updating its mtime.
    // Deleted winners fall back to another raw snapshot in the same transaction.
    for (raw,current,columns) in [("raw_events","event_current","e.path,e.agent,e.id,e.ts,e.session,e.model,e.project,e.data"),("raw_activities","activity_current","e.path,e.agent,e.id,e.ts,e.session,e.data")] {
        tx.execute(&format!("INSERT OR IGNORE INTO changed_keys SELECT ?3,agent,id FROM {raw} WHERE path=?1 AND agent=?2"),params![path,agent,raw]).map_err(|e|e.to_string())?;
        tx.execute(&format!("DELETE FROM {current} WHERE (agent,id) IN (SELECT agent,id FROM changed_keys WHERE kind=?1)"),[raw]).map_err(|e|e.to_string())?;
        tx.execute(&format!("INSERT INTO {current} SELECT {columns} FROM changed_keys k JOIN {raw} e ON e.agent=k.agent AND e.id=k.id WHERE k.kind=?1 AND e.path=(SELECT r.path FROM {raw} r LEFT JOIN source_files f ON f.path=r.path AND f.agent=r.agent WHERE r.agent=k.agent AND r.id=k.id ORDER BY r.ts DESC,COALESCE(f.mtime,0) DESC,r.path LIMIT 1)"),[raw]).map_err(|e|e.to_string())?;
    }
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
const EVENT_FILTER:&str="e.ts>=?1 AND e.ts<?2 AND (?3 IS NULL OR e.agent=?3) AND (?4 IS NULL OR e.model=?4) AND (?5 IS NULL OR tm_project(e.project)=tm_project(?5)) AND (?6 IS NULL OR e.session=?6) AND (?7='' OR instr(tm_lower(e.model||' '||e.project||' '||e.session||' '||COALESCE((SELECT title FROM source_files f WHERE f.path=e.path AND f.agent=e.agent),'')),?7)>0)";

fn sql_page<T:serde::de::DeserializeOwned>(db:&Connection,q:&Query,selection:&str,alias:&str,offset:usize,limit:usize)->Result<(usize,Vec<T>),String> {
    q.validate()?;
    let search=q.search.to_lowercase();
    // COUNT and rows use one read snapshot while the service commits new observations.
    let tx=db.unchecked_transaction().map_err(|e|e.to_string())?;
    let total=tx.query_row(&format!("SELECT COUNT(*) {selection}"),params![q.start,q.end,q.agent,q.model,q.project,q.session,search],|r|r.get::<_,usize>(0)).map_err(|e|e.to_string())?;
    let mut stmt=tx.prepare(&format!("SELECT {alias}.data {selection} ORDER BY {alias}.ts DESC,{alias}.agent,{alias}.id LIMIT ?8 OFFSET ?9")).map_err(|e|e.to_string())?;
    let rows=stmt.query_map(params![q.start,q.end,q.agent,q.model,q.project,q.session,search,limit as i64,i64::try_from(offset).unwrap_or(i64::MAX)],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
    let items=rows.map(|row|serde_json::from_str(&row.map_err(|e|e.to_string())?).map_err(|e|e.to_string())).collect::<Result<Vec<T>,String>>()?;
    Ok((total,items))
}
pub fn event_page(db:&Connection,q:&Query,offset:usize,limit:usize)->Result<(usize,Vec<Event>),String> {
    sql_page(db,q,&format!("FROM events e WHERE {EVENT_FILTER}"),"e",offset,limit.min(500))
}
pub fn activity_page(db:&Connection,q:&Query,offset:usize,limit:usize)->Result<(usize,Vec<Activity>),String> {
    let selection=format!("FROM activities a WHERE a.ts>=?1 AND a.ts<?2 AND (?3 IS NULL OR a.agent=?3) AND (?6 IS NULL OR a.session=?6) AND ((?4 IS NULL AND ?5 IS NULL AND ?7='') OR EXISTS(SELECT 1 FROM events e WHERE e.agent=a.agent AND e.session=a.session AND {EVENT_FILTER}))");
    sql_page(db,q,&selection,"a",offset,limit.clamp(1,1000))
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
    prices: Option<&Prices>,
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
    let mut days: BTreeMap<String, DailyUsageRow> = BTreeMap::new();
    for row in rows {
        EVENT_DESERIALIZE_COUNT.with(|counter| counter.set(counter.get() + 1));
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
        d.cost_usd += prices.and_then(|p| p.cost(&e)).unwrap_or(0.0);
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
/// Cost of one session file, priced with the caller's already-parsed table. Only
/// called for the agents a replay keeps in its family, so pricing is proportional
/// to the tree being displayed rather than to the whole cache.
pub fn query_session_cost_usd(db: &Connection, path: &str, prices: Option<&Prices>) -> f64 {
    let Ok(mut stmt) = db.prepare(
        "SELECT data FROM raw_events WHERE path=?1 AND agent='codex' ORDER BY ts",
    ) else {
        return 0.0;
    };
    let Ok(rows) = stmt.query_map([path], |r| r.get::<_, String>(0)) else {
        return 0.0;
    };
    rows.filter_map(|row| row.ok())
        .filter_map(|data| {
            EVENT_DESERIALIZE_COUNT.with(|counter| counter.set(counter.get() + 1));
            serde_json::from_str::<Event>(&data).ok()
        })
        .filter_map(|event| prices?.cost(&event))
        .sum::<f64>()
}

/// Per-session token totals computed by SQL. The previous version rebuilt a full
/// daily rollup for *every* codex file — deserializing all of their events and
/// re-parsing `prices.json` each time — just to open one replay.
pub fn query_session_hierarchy_records(
    db: &Connection,
) -> Result<Vec<SessionHierarchyRecord>, String> {
    let mut stmt = db
        .prepare(
            "SELECT sf.path,
                    sf.title,
                    COALESCE(SUM(json_extract(re.data,'$.tokens.input')),0)
                  + COALESCE(SUM(json_extract(re.data,'$.tokens.cached')),0)
                  + COALESCE(SUM(json_extract(re.data,'$.tokens.cache_write')),0),
                    COALESCE(SUM(json_extract(re.data,'$.tokens.cached')),0),
                    COALESCE(SUM(json_extract(re.data,'$.tokens.output')),0)
             FROM source_files AS sf
             LEFT JOIN raw_events AS re ON re.path = sf.path AND re.agent = 'codex'
             WHERE sf.agent = 'codex'
             GROUP BY sf.path",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SessionHierarchyRecord {
                path: r.get(0)?,
                prompt_title: r.get(1)?,
                input_tokens: r.get(2)?,
                cached_input_tokens: r.get(3)?,
                output_tokens: r.get(4)?,
                cost_usd: 0.0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}
