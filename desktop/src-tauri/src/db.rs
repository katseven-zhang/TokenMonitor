use crate::{
    model::{Activity, Event, Parsed, Query},
    pricing::Prices,
    types::{DailyUsageRow, ModelUsage},
};
use rusqlite::{params, Connection};
use std::{collections::BTreeMap, path::Path, time::Duration};

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

// Bump when a collector's accounting changes. Rebuild snapshots from source logs,
// while preserving cached data until each replacement transaction is ready.
// 5 = #71：BOM 不再吞首条、浮点 token 字段不再归零、重复配额快照不入库——
// 三者都改变已缓存文件的解析结果，旧行必须按新语义重解析。
pub const COLLECTOR_REVISION: &str = "5";
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
/// #63: the `unchanged()` fast path is only allowed to skip a file when the
/// cached *whole* observation is intact — that includes its `source_health` row.
/// `Some(n)` = reuse it, `n` malformed lines were recorded; `None` = the file
/// must be re-parsed.
///
/// A missing health row must never be read as "0 malformed lines":
/// - it would hide malformed lines the cache does know about (a pre-migration
///   file that had bad lines would report zero forever), and
/// - keeping the fast path hot means `replace_file` never runs, so the row is
///   never written back and nothing can heal the cache on its own.
/// Treating the absent row as "changed" sends the file through the normal parse,
/// and `replace_file` restores the health row: the cache self-heals in one scan.
/// A real query failure is still an error, and the scanner reports it per file.
pub fn cache_hit(db: &Connection, path: &str, agent: &str, size: i64, mtime: i64) -> Result<Option<usize>, String> {
    if !unchanged(db, path, agent, size, mtime) {
        return Ok(None);
    }
    match db.query_row("SELECT malformed_lines FROM source_health WHERE path=?1 AND agent=?2",params![path,agent],|row|row.get(0)) {
        Ok(n) => Ok(Some(n)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
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

/// #71: retract one source file that no longer exists: drop its raw rows, quota
/// rows, health row and the source_files entry itself, then re-elect winners for
/// every touched identity from the snapshots that remain (an archived copy of a
/// deleted session resurfaces through the same ranking as replace_file's).
/// Without this, deleting or archiving a log leaves it indexed forever: the
/// dashboard kept showing sessions whose source is gone.
pub fn forget_file(db: &mut Connection, path: &str, agent: &str) -> Result<(), String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS changed_keys(kind TEXT,agent TEXT,id TEXT,PRIMARY KEY(kind,agent,id)); DELETE FROM changed_keys;").map_err(|e|e.to_string())?;
    for table in ["raw_events","raw_activities"] {
        tx.execute(&format!("INSERT OR IGNORE INTO changed_keys SELECT ?3,agent,id FROM {table} WHERE path=?1 AND agent=?2"),params![path,agent,table]).map_err(|e|e.to_string())?;
    }
    for table in ["raw_events", "raw_activities", "quota", "source_health"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE path=?1 AND agent=?2"),
            params![path, agent],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM source_files WHERE path=?1 AND agent=?2", params![path, agent])
        .map_err(|e| e.to_string())?;
    // Recompute after source_files was dropped, so the forgotten file's mtime
    // can never win a tie.
    for (raw,current,columns) in [("raw_events","event_current","e.path,e.agent,e.id,e.ts,e.session,e.model,e.project,e.data"),("raw_activities","activity_current","e.path,e.agent,e.id,e.ts,e.session,e.data")] {
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
                    labels.get(&(e.agent.clone(), e.path.clone())).map(String::as_str).unwrap_or("")
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
/// #83: titles must be keyed by (agent, path), not path alone. Two agents can
/// index one file (overlapping configured roots), and with a path-only map the
/// row read later silently overwrote the earlier agent's title — searches and
/// session labels then show a title that belongs to a different agent.
pub fn titles(db: &Connection) -> Result<BTreeMap<(String, String), String>, String> {
    let mut stmt = db
        .prepare("SELECT agent,path,title FROM source_files WHERE title IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(((r.get::<_, String>(0)?, r.get::<_, String>(1)?), r.get::<_, String>(2)?)))
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
    // #76: a hand-edited prices.json can now fail Prices::parse at load (an alias
    // colliding with a priced model is rejected). service.rs propagates that error,
    // but this rollup path used `.ok().and_then(|s| Prices::parse(&s).ok())`, which
    // reads "unparsable price table" as "no price table" and silently dropped every
    // cost in the rollup while the dashboard told the user the file is broken. Both
    // load sites now surface the failure; only a genuinely absent file keeps the
    // "no pricing configured" meaning (each event then counts as unpriced, #83).
    let prices = match std::fs::read_to_string(&price_path) {
        Ok(text) => Some(Prices::parse(&text).map_err(|e| format!(
            "无法解析价格文件 {}，会话汇总已中止：{e}",
            price_path.display()
        ))?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("无法读取价格文件 {}：{e}", price_path.display())),
    };
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
            unpriced_events: 0,
            models: BTreeMap::new(),
            projects: BTreeMap::new(),
            updated_at: String::new(),
        });
        // #83: saturating accumulation. A pathological/corrupt token total must
        // not silently wrap i64 negative and drag the day's cost/usage sign over.
        let input = e.tokens.input.saturating_add(e.tokens.cached).saturating_add(e.tokens.cache_write);
        d.input_tokens = d.input_tokens.saturating_add(input);
        d.cached_input_tokens = d.cached_input_tokens.saturating_add(e.tokens.cached);
        d.output_tokens = d.output_tokens.saturating_add(e.tokens.output);
        d.reasoning_output_tokens = d.reasoning_output_tokens.saturating_add(e.tokens.reasoning);
        d.total_tokens = d.total_tokens.saturating_add(e.tokens.total());
        match prices.as_ref().and_then(|p| p.cost(&e)) {
            Some(cost) => d.cost_usd += cost,
            // #83: an unpriced event is a real, reportable fact, not 0.0 USD.
            None => d.unpriced_events += 1,
        }
        let m = d
            .models
            .entry(e.model.clone())
            .or_insert_with(ModelUsage::default);
        m.input_tokens = m.input_tokens.saturating_add(input);
        m.cached_input_tokens = m.cached_input_tokens.saturating_add(e.tokens.cached);
        m.output_tokens = m.output_tokens.saturating_add(e.tokens.output);
        m.reasoning_output_tokens = m.reasoning_output_tokens.saturating_add(e.tokens.reasoning);
        m.total_tokens = m.total_tokens.saturating_add(e.tokens.total());
        let p = d.projects.entry(e.project.clone()).or_default();
        p.input_tokens = p.input_tokens.saturating_add(input);
        p.cached_input_tokens = p.cached_input_tokens.saturating_add(e.tokens.cached);
        p.output_tokens = p.output_tokens.saturating_add(e.tokens.output);
        // #83: projects previously never carried reasoning, so every project row
        // showed 0 reasoning_output_tokens even when models and days had real numbers.
        p.reasoning_output_tokens = p.reasoning_output_tokens.saturating_add(e.tokens.reasoning);
        p.total_tokens = p.total_tokens.saturating_add(e.tokens.total());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;
    use crate::model::{Parsed, Quota, Tokens};

    fn temp_root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("tm-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        config::initialize(&root).unwrap();
        root
    }

    fn event(id: &str, ts: i64) -> Event {
        Event {
            id: id.into(),
            agent: "codex".into(),
            session: "s".into(),
            project: "p".into(),
            model: "m".into(),
            ts,
            tokens: Tokens { input: 10, ..Default::default() },
            path: "f.jsonl".into(),
            line: 1,
        }
    }

    /// #82：collector_revision 的语义迁移此前完全无覆盖。旧语义库重新打开时必须
    /// 把每个来源重新武装（size=-1，下轮扫描全量重解析），但不得清空原始快照——
    /// 重建是靠逐个文件的替换事务增量完成的，中途崩溃也不能丢历史数据。
    /// 断言做到扫描层：武装之后必须真的看到 parsed>0 / reused==0，而不是只从
    /// unchanged() 的 size 谓词上推断（原测试用不存在的文件 + replace_file 播种，
    /// 从来没扫过一轮）。
    #[test]
    fn stale_collector_revision_rearms_sources_but_keeps_raw_cache() {
        let root = temp_root();
        let source = root.join("sources");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("f.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"armed\"}}\n{\"timestamp\":\"2026-09-20T00:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":40,\"output_tokens\":5}}}}\n",
        )
        .unwrap();
        let settings = config::Settings {
            roots: BTreeMap::from([("codex".into(), vec![source.display().to_string()])]),
            ..Default::default()
        };
        let codex_scan = || {
            let statuses = crate::scanner::scan(&root, &settings).unwrap();
            let s = statuses.iter().find(|x| x.agent == "codex").expect("codex status");
            (s.parsed, s.reused, s.events, s.errors.clone())
        };
        // 首轮：真实扫描建立缓存，健康行与 source_files 都是新语义写出来的。
        assert_eq!(codex_scan(), (1, 0, 1, vec![]));
        // 假装这是一个语义升级前留下的库（revision 落后，但文件指纹仍然有效）。
        {
            let db = open(&root).unwrap();
            db.execute("UPDATE cache_metadata SET value='0' WHERE key='collector_revision'", [])
                .unwrap();
        }
        let db = open(&root).unwrap();
        let revision: String = db
            .query_row("SELECT value FROM cache_metadata WHERE key='collector_revision'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(revision, COLLECTOR_REVISION);
        let size: i64 = db
            .query_row("SELECT size FROM source_files WHERE path LIKE '%f.jsonl' AND agent='codex'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(size, -1, "旧语义缓存必须重新武装");
        let kept: i64 = db.query_row("SELECT COUNT(*) FROM raw_events", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1, "重新武装不是抹库：旧快照保留到逐个文件被替换为止");
        drop(db);
        // 扫描层证明：指纹真的没变（size 被人为改成 -1 才失效），下一轮必须
        // 完整重解析这个文件、一条都不复用，且重解析是替换而不是追加。
        assert_eq!(codex_scan(), (1, 0, 1, vec![]));
        let db = open_read(&root).unwrap();
        let rows: i64 = db.query_row("SELECT COUNT(*) FROM raw_events", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "重解析后仍是 1 条事件：武装不得翻倍");
        let rearmed: i64 = db
            .query_row("SELECT COUNT(*) FROM source_files WHERE size=-1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rearmed, 0, "重解析成功后指纹要重新有效");
        drop(db);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// #82：配额入库路径（Parsed.quotas → quota 表 → quota_history 查询）此前
    /// 只测过手工 INSERT 进表之后的读取，采集侧写入从未被钉住：payload 要按
    /// JSON 原样落库，文件重解析后不得留下该文件旧快照的残行。
    #[test]
    fn quota_ingestion_round_trips_payload_and_is_cleared_on_reparse() {
        let root = temp_root();
        let mut db = open(&root).unwrap();
        let parsed = Parsed {
            quotas: vec![Quota {
                agent: "codex".into(),
                session: "s".into(),
                ts: 60_000,
                payload: serde_json::json!({"used_percent": 42, "window": {"kind": "week", "limit_seconds": 1800}}),
            }],
            ..Default::default()
        };
        replace_file(&mut db, "f.jsonl", "codex", 1, 1, &parsed).unwrap();
        let payload: String = db
            .query_row("SELECT payload FROM quota WHERE path='f.jsonl' AND agent='codex' AND session='s' AND ts=60000", [], |r| r.get(0))
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["used_percent"], 42);
        assert_eq!(value["window"]["limit_seconds"], 1800);
        // 配额要能从面板的读取路径原样返回（dashboard 的 quotaHistory 查询段）。
        let prices = crate::pricing::Prices::parse(include_str!("../../config/prices.json")).unwrap();
        let data = crate::query::dashboard(
            &db,
            &crate::model::Query {
                start: 0,
                end: 120_000,
                agent: Some("codex".into()),
                model: None,
                project: None,
                session: None,
                search: String::new(),
                time_zone: None,
                offset_minutes: 0,
            },
            &prices,
        )
        .unwrap();
        assert_eq!(data["quotaHistory"]["total"], 1);
        assert_eq!(data["quotaHistory"]["items"][0]["payload"]["used_percent"], 42);
        // 同一文件重解析、不再含该配额行时，旧行必须随替换事务一起清掉。
        replace_file(&mut db, "f.jsonl", "codex", 2, 2, &Parsed::default()).unwrap();
        let left: i64 = db.query_row("SELECT COUNT(*) FROM quota", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
        drop(db);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// #76 决策：坏的价格文件不得被 rollup 静默丢成 0 成本。修前这里是
    /// `.ok().and_then(|s| Prices::parse(&s).ok())`——解析失败等于"没有价格表"，
    /// 汇总里每条事件都记成 unpriced、成本 0；而同一份文件走面板查询路径
    /// （service.rs 的 prices()）会直接报错，两处口径相反。现在两处都上抛，只有
    /// "文件真的不存在"才保留"未配置价格"的语义（#83 的 unpriced_events 不变）。
    #[test]
    fn rollup_surfaces_an_unparsable_price_file_instead_of_zeroing_cost() {
        let root = temp_root();
        let priced = Event {
            model: "m".into(),
            tokens: Tokens { input: 1_000_000, ..Default::default() },
            ..event("1", 60_000)
        };
        let mut db = open(&root).unwrap();
        replace_file(
            &mut db,
            "r.jsonl",
            "codex",
            10,
            10,
            &Parsed { events: vec![priced], ..Default::default() },
        )
        .unwrap();
        // 别名键顶掉真实模型：#76 之后 Prices::parse 会拒绝这种手改文件。
        std::fs::write(
            &root.join("prices.json"),
            serde_json::json!({
                "version": 1, "currency": "USD",
                "aliases": { "m": "other" },
                "models": {
                    "m": [{ "input": 2, "cached": 0, "cacheWrite": 0, "output": 0 }],
                    "other": [{ "input": 1, "cached": 0, "cacheWrite": 0, "output": 0 }]
                }
            })
            .to_string(),
        )
        .unwrap();
        let err = query_session_rollup_record(&db, "r.jsonl").unwrap_err();
        assert!(err.contains("无法解析价格文件"), "要说清失败来自价格文件：{err}");
        assert!(err.contains("别名 m 与已配置模型同名"), "要带上真正的原因：{err}");
        // 对照①：同一份数据、合法价格表，rollup 正常算出 1M × 2/百万 = 2.0。
        std::fs::write(
            &root.join("prices.json"),
            serde_json::json!({
                "version": 1, "currency": "USD",
                "models": { "m": [{ "input": 2, "cached": 0, "cacheWrite": 0, "output": 0 }] }
            })
            .to_string(),
        )
        .unwrap();
        let rollup = query_session_rollup_record(&db, "r.jsonl").unwrap().expect("rollup");
        assert!((rollup.rows[0].cost_usd - 2.0).abs() < 1e-12, "合法价格表仍要算出成本：{}", rollup.rows[0].cost_usd);
        assert_eq!(rollup.rows[0].unpriced_events, 0);
        // 对照②：文件不存在 = 真的没配价格，rollup 必须照常成功。
        std::fs::remove_file(&root.join("prices.json")).unwrap();
        let rollup = query_session_rollup_record(&db, "r.jsonl").unwrap().expect("rollup");
        assert_eq!(rollup.rows[0].unpriced_events, 1, "缺价格表按 unpriced 计，不是报错也不是 0 成本");
        assert_eq!(rollup.rows[0].cost_usd, 0.0);
        drop(db);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// #83 rollup 三处：① 无价事件计入 unpriced_events（修前按 0.0 加进成本，
    /// rollup 的 0 与"免费"不可区分）；② ProjectUsage 带上 reasoning（修前该
    /// 字段恒 0，日/模型列都有数、项目列永远是 0）；③ 每列 saturating 累加。
    /// 黄金数：priced 1,000,000 input × 2/百万 = 2.0；missing 500,000 不计价；
    /// reasoning 700+300=1000。
    #[test]
    fn rollup_tracks_unpriced_and_project_reasoning() {
        let root = temp_root();
        std::fs::write(
            &root.join("prices.json"),
            serde_json::json!({
                "version": 1, "currency": "USD",
                "models": { "priced": [{ "input": 2, "cached": 0, "cacheWrite": 0, "output": 0 }] }
            })
            .to_string(),
        )
        .unwrap();
        let mut db = open(&root).unwrap();
        let mk = |model: &str, input: i64, reasoning: i64| Event {
            id: model.into(),
            agent: "codex".into(),
            session: "s".into(),
            project: "proj".into(),
            model: model.into(),
            ts: 60_000,
            tokens: Tokens { input, cached: 0, cache_write: 0, output: 0, reasoning },
            path: "r.jsonl".into(),
            line: 1,
        };
        replace_file(
            &mut db,
            "r.jsonl",
            "codex",
            10,
            10,
            &Parsed {
                events: vec![mk("priced", 1_000_000, 700), mk("missing", 500_000, 300)],
                ..Default::default()
            },
        )
        .unwrap();
        let rollup = query_session_rollup_record(&db, "r.jsonl")
            .unwrap()
            .expect("rollup");
        assert_eq!(rollup.rows.len(), 1);
        let day = &rollup.rows[0];
        assert_eq!(day.unpriced_events, 1);
        assert!((day.cost_usd - 2.0).abs() < 1e-12, "只有 priced 事件进成本：{}", day.cost_usd);
        assert_eq!(day.reasoning_output_tokens, 1000);
        let project = day.projects.get("proj").expect("project row");
        assert_eq!(project.reasoning_output_tokens, 1000, "ProjectUsage.reasoning 修前恒 0");
        assert_eq!(project.input_tokens, 1_500_000);
        drop(db);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
