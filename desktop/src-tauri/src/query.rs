use crate::{
    db,
    model::{Event, Query, Tokens},
    pricing::Prices,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use chrono::{Datelike, TimeZone};

fn calendar_rows(rows: BTreeMap<String, Summary>, q: &Query, month: bool) -> Result<Vec<Value>,String> {
    let zone=q.time_zone.as_deref().map(str::parse::<chrono_tz::Tz>).transpose().map_err(|e|e.to_string())?;
    rows.into_values().map(|row| {
        let date=chrono::NaiveDate::parse_from_str(&if month {format!("{}-01",row.key)} else {row.key.clone()},"%Y-%m-%d").map_err(|e|e.to_string())?;
        let end=if month { if date.month()==12 {chrono::NaiveDate::from_ymd_opt(date.year()+1,1,1)} else {chrono::NaiveDate::from_ymd_opt(date.year(),date.month()+1,1)} } else {date.succ_opt()}.ok_or("Invalid calendar boundary")?;
        let boundary=|date:chrono::NaiveDate|->Result<i64,String>{
            let midnight=date.and_hms_opt(0,0,0).ok_or("Invalid midnight")?;
            match zone {
                None=>Ok(midnight.and_utc().timestamp_millis()-q.offset_minutes as i64*60_000),
                Some(zone)=>{
                    // Some zones advance at midnight or skip a date. Match the first
                    // representable instant, and choose the earlier repeated midnight.
                    for minute in 0..=1440 {
                        if let Some(value)=zone.from_local_datetime(&(midnight+chrono::Duration::minutes(minute))).earliest(){return Ok(value.timestamp_millis());}
                    }
                    Err("Cannot resolve calendar boundary".into())
                }
            }
        };
        let mut value=serde_json::to_value(row).map_err(|e|e.to_string())?;
        value["rangeStart"]=json!(boundary(date)?);value["rangeEnd"]=json!(boundary(end)?);Ok(value)
    }).collect()
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub key: String,
    pub label: String,
    pub tokens: Tokens,
    pub total_tokens: i64,
    pub known_cost_usd: f64,
    pub known_cost_by_component: [f64;4],
    pub cost_usd: Option<f64>,
    pub unpriced_events: usize,
    pub unpriced_tokens: i64,
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
        // #83: 与 Tokens::add 同一纪律：计数列一律 saturating，坏行不得把
        // 总数回绕成负数（debug 下直接 panic，release 下静默变负）。
        self.total_tokens = self.total_tokens.saturating_add(e.tokens.total());
        self.events += 1;
        self.first_ts = if self.first_ts == 0 {
            e.ts
        } else {
            self.first_ts.min(e.ts)
        };
        self.last_ts = self.last_ts.max(e.ts);
        match p.cost_parts(e) {
            Some(parts) => {
                self.known_cost_usd += parts.iter().sum::<f64>();
                for (sum,cost) in self.known_cost_by_component.iter_mut().zip(parts) { *sum+=cost; }
            },
            None => {
                self.unpriced_events += 1;
                self.unpriced_tokens = self.unpriced_tokens.saturating_add(e.tokens.total());
            },
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
/// 面板一次调用要跑 7 条独立语句（events、titles、activities、最新配额、
/// scan_status、quota_history 的 COUNT 与明细）。逐条读各自的快照时，扫描器
/// 在两条语句之间提交就会让一次面板里的数字来自两个时间点：例如
/// quota_history 的 COUNT 读在插入之前、明细读取在后，items 会比 total 还长；
/// activities/quotas 与 events 也会互相错开。
/// 这里把整次调用钉在一个只读事务上，语义与 db.rs 的 sql_page（分页端点）
/// 一致——那里早就用同一手法把 COUNT 和分页 SELECT 钉在同一快照。
pub fn dashboard(db: &Connection, q: &Query, prices: &Prices) -> Result<Value, String> {
    // unchecked_transaction 不需要 &mut Connection（rusqlite 的借用检查版本），
    // 代价是它不阻止同一连接上再开嵌套写事务。本面板路径全部是只读语句，且
    // 服务侧写入走的是另一个连接/另一个事务（见 db::open_read 与 scanner），
    // 因此这里不存在被误升成写事务的路径；分页端点用的就是同一取舍。
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    dashboard_snapshot(&tx, q, prices)
}
/// 一次读快照内的面板聚合。与 `dashboard` 分开，是为了能让测试把同一个快照
/// 跨两次分组读取复用（并发提交必须看不到），见 tests。
fn dashboard_snapshot(db: &Connection, q: &Query, prices: &Prices) -> Result<Value, String> {
    let events = db::events(db, q)?;
    let zone=q.time_zone.as_deref().map(str::parse::<chrono_tz::Tz>).transpose().map_err(|e|e.to_string())?;
    let titles = db::titles(db)?;
    let mut totals = Summary { cost_usd: Some(0.0), ..Default::default() };
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
        // Bound the rendered series for unusually long custom ranges.
        ((q.end - q.start + 2_000 * 86_400_000 - 1) / (2_000 * 86_400_000)).max(1) * 86_400_000
    };
    let shift = q.offset_minutes as i64 * 60_000;
    let mut bucket = (q.start + shift).div_euclid(width) * width - shift;
    while bucket < q.end {
        let key = format!("{bucket:015}");
        series.insert(key.clone(), Summary {
            key, label: bucket.to_string(), cost_usd: Some(0.0), ..Default::default()
        });
        bucket += width;
    }
    let mut session_keys = BTreeSet::new();
    let mut all_models = BTreeSet::new();
    let mut all_projects = BTreeSet::new();
    for e in &events {
        totals.add(e, prices);
        group(&mut models, &e.model, &e.model, e, prices);
        group(
            &mut projects,
            &crate::model::project_key(&e.project),
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
            titles.get(&(e.agent.clone(), e.path.clone())).unwrap_or(&e.session),
            e,
            prices,
        );
        let utc=chrono::DateTime::from_timestamp_millis(e.ts).ok_or("Invalid timestamp")?;
        let local=match zone {
            Some(zone)=>utc.with_timezone(&zone).naive_local(),
            None=>(utc+chrono::Duration::minutes(q.offset_minutes as i64)).naive_utc(),
        };
        let day = local.format("%Y-%m-%d").to_string();
        let month = local.format("%Y-%m").to_string();
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
        all_projects.insert(crate::model::project_key(&e.project));
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
    // #71: 同一观测在 sessions/ 与 archived_sessions/ 各存一份是常态；"最新配额"
    // 列表与 quotaHistory 一样必须先按内容去重，否则 100 个名额被副本占满。
    let mut stmt=db.prepare("SELECT DISTINCT agent,session,ts,payload FROM quota WHERE ts<?1 AND (?2 IS NULL OR agent=?2) ORDER BY ts DESC LIMIT 100").map_err(|e|e.to_string())?;
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
    let quota_history = quota_history(db, q)?;
    Ok(
        json!({"query":q,"totals":totals,"models":models.into_values().collect::<Vec<_>>(),"projects":projects.into_values().collect::<Vec<_>>(),"sessions":sessions.into_values().collect::<Vec<_>>(),"agents":agents.into_values().collect::<Vec<_>>(),"days":calendar_rows(days,q,false)?,"months":calendar_rows(months,q,true)?,"series":series.into_values().collect::<Vec<_>>(),"bucketMs":width,"tools":tools,"activityCount":activities.len(),"quotas":quotas,"quotaHistory":quota_history,"status":status,"availableModels":all_models,"availableProjects":all_projects,"eventCount":events.len()}),
    )
}
pub fn activity_page(db: &Connection, q: &Query, offset: usize, limit: usize) -> Result<Value, String> {
    let (total,items)=db::activity_page(db,q,offset,limit)?;
    Ok(json!({"total":total,"items":items}))
}
fn quota_history(db: &Connection, q: &Query) -> Result<Value, String> {
    // Archive copies of the same observation do not represent new observations.
    let selection = "SELECT DISTINCT agent,session,ts,payload FROM quota WHERE ts>=?1 AND ts<?2 AND (?3 IS NULL OR agent=?3) AND (?4 IS NULL OR session=?4)";
    let total: i64 = db.query_row(&format!("SELECT COUNT(*) FROM ({selection})"), params![q.start,q.end,q.agent,q.session], |r|r.get(0)).map_err(|e|e.to_string())?;
    let mut stmt = db.prepare(&format!("{selection} ORDER BY ts DESC,session LIMIT 500")).map_err(|e|e.to_string())?;
    let items = stmt.query_map(params![q.start,q.end,q.agent,q.session], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?)))
        .map_err(|e|e.to_string())?.map(|r| {
            let (agent,session,ts,payload) = r.map_err(|e|e.to_string())?;
            Ok(json!({"agent":agent,"session":session,"ts":ts,"payload":serde_json::from_str::<Value>(&payload).map_err(|e|e.to_string())?}))
        }).collect::<Result<Vec<_>,String>>()?;
    Ok(json!({"total":total,"items":items}))
}
pub fn event_page(
    db: &Connection,
    q: &Query,
    p: &Prices,
    offset: usize,
    limit: usize,
) -> Result<Value, String> {
    let (total,events)=db::event_page(db,q,offset,limit)?;
    let items=events.iter().map(|e|json!({"event":e,"costUSD":p.cost(e)})).collect::<Vec<_>>();
    Ok(json!({"total":total,"items":items}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Parsed;
    #[test]
    fn quota_history_is_half_open_deduplicated_and_session_scoped() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE quota(path TEXT,agent TEXT,session TEXT,ts INTEGER,payload TEXT);").unwrap();
        for path in ["original", "archive"] {
            for session in ["one", "two"] {
                for ts in [59_999, 60_000, 119_999, 120_000] {
                    db.execute("INSERT INTO quota VALUES(?1,'codex',?2,?3,'{}')", params![path,session,ts]).unwrap();
                }
            }
        }
        let mut q = Query { start:60_000,end:120_000,agent:Some("codex".into()),session:Some("one".into()),model:None,project:None,search:String::new(),time_zone: None, offset_minutes: 0 };
        let result = quota_history(&db,&q).unwrap();
        assert_eq!(result["total"],2);
        assert_eq!(result["items"][0]["ts"],119_999);
        assert_eq!(result["items"][1]["ts"],60_000);
        q.session=None;
        assert_eq!(quota_history(&db,&q).unwrap()["total"],4);
        q.agent=Some("pi".into());
        assert_eq!(quota_history(&db,&q).unwrap()["total"],0);
    }
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
            time_zone: None, offset_minutes: 480,
        };
        let result = dashboard(&db, &q, &p).unwrap();
        assert_eq!(result["totals"]["totalTokens"], 20);
        assert_eq!(result["totals"]["unpricedEvents"], 2);
        assert_eq!(result["totals"]["unpricedTokens"], 20);
        assert!(result["totals"]["costUsd"].is_null());
        let mut sparse = q.clone();
        sparse.end = 300_000;
        let chart = dashboard(&db, &sparse, &p).unwrap();
        let buckets = chart["series"].as_array().unwrap();
        assert_eq!(buckets.len(), 4);
        assert_eq!(buckets[0]["label"], "60000");
        assert_eq!(buckets[3]["label"], "240000");
        assert_eq!(buckets[3]["totalTokens"], 0);
        assert_eq!(buckets[3]["costUsd"], 0.0);
        assert_eq!(buckets.iter().map(|b| b["totalTokens"].as_i64().unwrap()).sum::<i64>(), 30);
        sparse.start = 180_000;
        let empty = dashboard(&db, &sparse, &p).unwrap();
        assert_eq!(empty["totals"]["costUsd"], 0.0);
        assert_eq!(empty["series"].as_array().unwrap().len(), 2);
        sparse.start = 60_000;
        sparse.end = 32_503_680_000_000;
        assert!(dashboard(&db, &sparse, &p).unwrap()["series"].as_array().unwrap().len() <= 2001);
        q.agent = None;
        assert_eq!(dashboard(&db, &q, &p).unwrap()["totals"]["totalTokens"], 30);
        q.search = "独特会话".into();
        q.agent = Some("codex".into());
        assert_eq!(dashboard(&db, &q, &p).unwrap()["totals"]["totalTokens"], 20);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    /// #83: 同一路径被两个 agent 索引（配置的根重叠）时各记各的标题。修前
    /// titles 以 path 为键，后读的一行顶掉前一个 agent 的标题：按 codex 标题
    /// 搜索会 0 命中，面板把 codex 会话标成 pi 的标题。
    #[test]
    fn same_path_under_two_agents_keeps_its_own_title() {
        let root = std::env::temp_dir().join(format!("tokenmonitor-titles-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut db = db::open(&root).unwrap();
        let make = |agent: &str, id: &str| Event {
            id: id.into(),
            agent: agent.into(),
            session: "shared".into(),
            project: "p".into(),
            model: "m".into(),
            ts: 60_000,
            tokens: Tokens { input: 100, ..Default::default() },
            path: "same.jsonl".into(),
            line: 1,
        };
        db::replace_file(&mut db, "same.jsonl", "codex", 1, 1, &Parsed {
            title: Some("codex-only-title".into()),
            events: vec![make("codex", "c1")],
            ..Default::default()
        })
        .unwrap();
        db::replace_file(&mut db, "same.jsonl", "pi", 1, 1, &Parsed {
            title: Some("pi-only-title".into()),
            events: vec![make("pi", "p1")],
            ..Default::default()
        })
        .unwrap();
        let p = Prices::parse(include_str!("../../config/prices.json")).unwrap();
        let q = Query {
            start: 60_000,
            end: 120_000,
            agent: None,
            model: None,
            project: None,
            session: None,
            search: "codex-only-title".into(),
            time_zone: None,
            offset_minutes: 0,
        };
        // 无搜索时两个会话行各自带着自己的标题（修前 path 单键让 pi 行覆盖 codex 行，
        // codex 会话会被标成 "pi-only-title"）。
        let all = dashboard(&db, &Query { search: String::new(), ..q.clone() }, &p).unwrap();
        let sessions = all["sessions"].as_array().unwrap();
        let label_of = |key: &str| sessions.iter().find(|s| s["key"] == key).unwrap()["label"].clone();
        assert_eq!(label_of("codex:shared"), serde_json::json!("codex-only-title"));
        assert_eq!(label_of("pi:shared"), serde_json::json!("pi-only-title"));
        // 按 codex 的标题搜索必须只命中 codex 事件（修前命中 0 个）。
        let result = dashboard(&db, &q, &p).unwrap();
        assert_eq!(result["totals"]["totalTokens"], 100);
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
    /// #83: 汇总计数 saturating——两条 i64::MAX 级的畸形事件不再把总数翻负。
    #[test]
    fn summarize_saturates_on_pathological_totals() {
        let p = Prices::parse(r#"{"version":1,"currency":"USD","models":{}}"#).unwrap();
        let huge = Event {
            id: "h".into(),
            agent: "codex".into(),
            session: "s".into(),
            project: "p".into(),
            model: "m".into(),
            ts: 1,
            tokens: Tokens { input: i64::MAX, cached: 1, ..Default::default() },
            path: "p".into(),
            line: 1,
        };
        let s = summarize(&[huge.clone(), huge], &p);
        assert_eq!(s.total_tokens, i64::MAX);
        assert_eq!(s.unpriced_tokens, i64::MAX);
        assert_eq!(s.tokens.input, i64::MAX);
        assert_eq!(s.unpriced_events, 2);
    }
    /// 一次面板调用内的多条语句必须看到同一个读快照。这里把生产本体
    /// `dashboard_snapshot`（公开 `dashboard` 开事务后调用的就是这个函数）跑在手工
    /// 钉住的只读事务上：两次分组读取之间由另一个连接提交 3 条新事件和 1 条配额
    /// 观测。钉住的两次结果必须逐项相同；作为反向对照，未钉住快照的新连接在同一
    /// 时刻必须立刻看到 5 条——没有这层对照，"两次相同"可能只是写入没生效。
    #[test]
    fn dashboard_grouped_reads_share_one_snapshot() {
        let root = std::env::temp_dir().join(format!("tm-snapshot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let prices = Prices::parse(include_str!("../../config/prices.json")).unwrap();
        let make = |id: &str, ts: i64| Event {
            id: id.into(),
            agent: "codex".into(),
            session: "s".into(),
            project: "p".into(),
            model: "m".into(),
            ts,
            tokens: Tokens { input: 10, ..Default::default() },
            path: "a.jsonl".into(),
            line: 1,
        };
        let q = Query {
            start: 0,
            end: 200_000,
            agent: None,
            model: None,
            project: None,
            session: None,
            search: String::new(),
            time_zone: None,
            offset_minutes: 0,
        };
        let (before, pinned, fresh_count) = {
            let mut writer = db::open(&root).unwrap();
            let reader = db::open(&root).unwrap();
            let other = db::open(&root).unwrap();
            db::replace_file(&mut writer, "a.jsonl", "codex", 1, 1, &Parsed {
                events: vec![make("1", 60_000), make("2", 90_000)],
                ..Default::default()
            })
            .unwrap();
            let tx = reader.unchecked_transaction().unwrap();
            let before = dashboard_snapshot(&tx, &q, &prices).unwrap();
            // 快照打开之后才落库的并发提交：新路径 3 条事件 + 1 条配额观测。
            db::replace_file(&mut writer, "b.jsonl", "codex", 1, 1, &Parsed {
                events: vec![make("3", 61_000), make("4", 62_000), make("5", 63_000)],
                quotas: vec![crate::model::Quota {
                    agent: "codex".into(),
                    session: "s".into(),
                    ts: 61_000,
                    payload: json!({"usedPercent": 1}),
                }],
                ..Default::default()
            })
            .unwrap();
            let pinned = dashboard_snapshot(&tx, &q, &prices).unwrap();
            let fresh_count = dashboard(&other, &q, &prices).unwrap()["eventCount"]
                .as_u64()
                .unwrap();
            (before, pinned, fresh_count)
        };
        assert_eq!(before["eventCount"], 2);
        assert_eq!(
            pinned["eventCount"],
            before["eventCount"],
            "同一快照内两次分组读取的 eventCount 必须一致"
        );
        assert_eq!(pinned["totals"], before["totals"]);
        assert_eq!(
            pinned["quotaHistory"], before["quotaHistory"],
            "配额历史不得看到快照打开之后的提交"
        );
        assert_eq!(
            fresh_count, 5,
            "反向对照：未钉住快照的连接必须立刻看到那次提交（否则上面的相等毫无意义）"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
    /// 真正的实弹回归：把一次并发提交精确插在面板的两次分组读取**之间**。
    /// 窗口不靠 sleep 猜：SQLite 的 authorizer 回调在语句 prepare 时触发，用它把
    /// 面板卡在"事件已全部读完、标题语句正要开始"的那一刻，另一个连接在这
    /// 一刻提交新的事件+活动+配额，提交落地后才放行。
    /// 修前面板每条语句各取快照：这一刻之后的语句（activities / quota /
    /// quota_history / scan_status）会看到那次提交，面板返回"事件是旧的、活动与配额
    /// 是新的"这种自相矛盾的混合体；修后整次调用在同一个读事务里，返回必须与提交
    /// 前的基线逐项相同。卡点没命中、提交没生效都会让本测试明确失败，不会假绿。
    #[test]
    fn dashboard_hides_a_commit_landing_between_its_reads() {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
        use std::sync::atomic::Ordering;
        use std::time::Duration;
        let root = std::env::temp_dir().join(format!("tm-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let prices = Prices::parse(include_str!("../../config/prices.json")).unwrap();
        let q = Query {
            start: 0,
            end: 200_000,
            agent: None,
            model: None,
            project: None,
            session: None,
            search: String::new(),
            time_zone: None,
            offset_minutes: 0,
        };
        let make = |path: &str, id: &str, ts: i64| Event {
            id: id.into(),
            agent: "codex".into(),
            session: "s".into(),
            project: "p".into(),
            model: "m".into(),
            ts,
            tokens: Tokens { input: 10, ..Default::default() },
            path: path.into(),
            line: 1,
        };
        let mut writer = db::open(&root).unwrap();
        db::replace_file(&mut writer, "a.jsonl", "codex", 1, 1, &Parsed {
            events: vec![make("a.jsonl", "1", 60_000)],
            activities: vec![crate::model::Activity {
                id: "a1".into(),
                agent: "codex".into(),
                session: "s".into(),
                ts: 60_000,
                name: "exec".into(),
                path: "a.jsonl".into(),
                line: 1,
            }],
            quotas: vec![crate::model::Quota {
                agent: "codex".into(),
                session: "s".into(),
                ts: 60_000,
                payload: json!({"usedPercent": 1}),
            }],
            ..Default::default()
        })
        .unwrap();
        let reader = db::open(&root).unwrap();
        let baseline = dashboard(&reader, &q, &prices).unwrap();
        assert_eq!(baseline["eventCount"], 1);
        let (reached_tx, reached_rx) = std::sync::mpsc::sync_channel::<()>(0);
        let (landed_tx, landed_rx) = std::sync::mpsc::sync_channel::<()>(0);
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hook_fired = fired.clone();
        reader.authorizer(Some(move |ctx: AuthContext<'_>| {
            // source_files 在面板里第一次被 prepare，就是标题那次分组读取。
            if !hook_fired.load(Ordering::SeqCst)
                && matches!(ctx.action, AuthAction::Read { table_name: "source_files", .. })
            {
                hook_fired.store(true, Ordering::SeqCst);
                let _ = reached_tx.send(());
                // 等那次并发提交真正落地，面板才继续读后面的表。
                let _ = landed_rx.recv_timeout(Duration::from_secs(20));
            }
            Authorization::Allow
        }));
        // 并发提交的连接在卡点之前就开好并交给提交线程：authorizer 回调里停着的是
        // 读者线程，绝不许它再去 sqlite3_open 一个新连接。
        let commit_writer = &mut writer;
        std::thread::scope(|scope| {
            let committer = scope.spawn(move || {
                if reached_rx.recv_timeout(Duration::from_secs(20)).is_err() {
                    return;
                }
                db::replace_file(commit_writer, "b.jsonl", "codex", 1, 1, &Parsed {
                    events: vec![make("b.jsonl", "2", 70_000), make("b.jsonl", "3", 80_000)],
                    activities: vec![crate::model::Activity {
                        id: "a2".into(),
                        agent: "codex".into(),
                        session: "s".into(),
                        ts: 70_000,
                        name: "read".into(),
                        path: "b.jsonl".into(),
                        line: 1,
                    }],
                    quotas: vec![crate::model::Quota {
                        agent: "codex".into(),
                        session: "s".into(),
                        ts: 70_000,
                        payload: json!({"usedPercent": 2}),
                    }],
                    title: Some("mid-commit 会话".into()),
                    ..Default::default()
                })
                .unwrap();
                let _ = landed_tx.send(());
            });
            let result = dashboard(&reader, &q, &prices).unwrap();
            committer.join().unwrap();
            assert!(
                fired.load(Ordering::SeqCst),
                "卡点必须命中面板两次分组读取之间，否则这条测试什么都没证明"
            );
            assert_eq!(
                result, baseline,
                "面板在同一次调用里混用了提交前后两个快照：{}",
                serde_json::to_string_pretty(&result).unwrap()
            );
            // 反向对照：那次提交确实有效，未钉住快照的连接立刻看得到。
            let fresh = db::open(&root).unwrap();
            let after = dashboard(&fresh, &q, &prices).unwrap();
            assert_eq!(after["eventCount"], 3);
            assert_eq!(after["activityCount"], 2);
            assert_eq!(after["quotaHistory"]["total"], 2);
        });
        drop(reader);
        drop(writer);
        std::fs::remove_dir_all(&root).unwrap();
    }
    /// 实弹并发回归：一个线程不停 replace_file（同一路径交替写入多/少事件与配额，
    /// 因此既有插入也有撤回），主线程反复调用公开的 `dashboard`。修前面板逐条语句
    /// 各取快照，提交撞上两条语句之间就会返回自相矛盾的面板：配额明细比总数长、
    /// "最新配额"里的观测在同窗历史里查无此条。修后整次调用在一个读事务里，任何
    /// 一次返回都必须自洽。
    #[test]
    fn dashboard_stays_self_consistent_under_concurrent_commits() {
        let root = std::env::temp_dir().join(format!("tm-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let prices = Prices::parse(include_str!("../../config/prices.json")).unwrap();
        let q = Query {
            start: 0,
            end: 200_000,
            agent: None,
            model: None,
            project: None,
            session: None,
            search: String::new(),
            time_zone: None,
            offset_minutes: 0,
        };
        // 事件计数按分组求和回核 eventCount；配额与活动跨语句自洽。
        let consistent = |data: &Value, label: &str| -> Option<String> {
            let events = data["eventCount"].as_u64().unwrap_or(u64::MAX);
            if data["totals"]["events"].as_u64() != Some(events) {
                return Some(format!("{label}: totals.events 与 eventCount={events} 背离"));
            }
            for group in ["models", "projects", "sessions", "agents", "days", "months", "series"] {
                let sum: u64 = data[group]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|row| row["events"].as_u64().unwrap_or(0))
                    .sum();
                if sum != events {
                    return Some(format!("{label}: {group} 分组行数之和 {sum} 与 eventCount={events} 背离"));
                }
            }
            let tools: u64 = data["tools"]
                .as_object()
                .unwrap()
                .values()
                .map(|v| v.as_u64().unwrap_or(0))
                .sum();
            if tools != data["activityCount"].as_u64().unwrap_or(u64::MAX) {
                return Some(format!("{label}: tools 合计 {tools} 与 activityCount 背离"));
            }
            let total = data["quotaHistory"]["total"].as_u64().unwrap_or(u64::MAX);
            let items = data["quotaHistory"]["items"].as_array().unwrap();
            if items.len() as u64 != total.min(500) {
                return Some(format!(
                    "{label}: 配额历史明细 {} 条与总数 {total} 来自不同快照",
                    items.len()
                ));
            }
            let history: BTreeSet<(String, String, i64)> = items
                .iter()
                .map(|row| {
                    (
                        row["agent"].as_str().unwrap_or_default().to_string(),
                        row["session"].as_str().unwrap_or_default().to_string(),
                        row["ts"].as_i64().unwrap_or_default(),
                    )
                })
                .collect();
            for row in data["quotas"].as_array().unwrap() {
                let key = (
                    row["agent"].as_str().unwrap_or_default().to_string(),
                    row["session"].as_str().unwrap_or_default().to_string(),
                    row["ts"].as_i64().unwrap_or_default(),
                );
                if !history.contains(&key) {
                    return Some(format!("{label}: 最新配额 {key:?} 不在同窗配额历史里"));
                }
            }
            None
        };
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        std::thread::scope(|scope| {
            let writer_stop = stop.clone();
            let writer_root = root.clone();
            let committer = scope.spawn(move || {
                let mut writer = db::open(&writer_root).unwrap();
                let mut committed = 0_u64;
                let mut i = 0_u64;
                loop {
                    if writer_stop.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    let path = format!("p{:02}.jsonl", i % 8);
                    let many = i % 2 == 0;
                    let count = if many { 4 } else { 1 };
                    let ts: i64 = 60_000 + (i as i64 * 7_000) % 120_000;
                    let events = (0..count)
                        .map(|k| Event {
                            id: format!("{i}-{k}"),
                            agent: "codex".into(),
                            session: "s".into(),
                            project: "p".into(),
                            model: if many { "m" } else { "m2" }.into(),
                            ts,
                            tokens: Tokens { input: 10, ..Default::default() },
                            path: path.clone(),
                            line: 1,
                        })
                        .collect();
                    let activities = (0..count)
                        .map(|k| crate::model::Activity {
                            id: format!("a{i}-{k}"),
                            agent: "codex".into(),
                            session: "s".into(),
                            ts,
                            name: if many { "exec".into() } else { "read".into() },
                            path: path.clone(),
                            line: 1,
                        })
                        .collect();
                    let quotas = if many {
                        vec![crate::model::Quota {
                            agent: "codex".into(),
                            session: "s".into(),
                            ts,
                            payload: json!({"usedPercent": i}),
                        }]
                    } else {
                        vec![]
                    };
                    // WAL 的自动 checkpoint 撞上活跃读者时会立刻返回 SQLITE_BUSY
                    // （不走 busy_timeout 的防死锁规则）。这里要的是"持续有提交在飞"，
                    // 不是争锁输赢，所以失败退避后继续；成功次数最后有断言兜底。
                    if db::replace_file(
                        &mut writer,
                        &path,
                        "codex",
                        i as i64,
                        i as i64,
                        &Parsed { events, activities, quotas, ..Default::default() },
                    )
                    .is_ok()
                    {
                        committed += 1;
                    } else {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    i += 1;
                }
                committed
            });
            let reader = db::open(&root).unwrap();
            let mut checked = 0_u32;
            let mut busy = 0_u32;
            for round in 0..400_u32 {
                let data = match dashboard(&reader, &q, &prices) {
                    Ok(data) => data,
                    // 读侧偶发锁竞争不是本测试要钉的行为，但也不许成为常态。
                    Err(_) => {
                        busy += 1;
                        std::thread::sleep(std::time::Duration::from_millis(1));
                        continue;
                    }
                };
                if let Some(problem) = consistent(&data, &format!("第 {round} 轮")) {
                    panic!("面板返回自相矛盾的结果：{problem}");
                }
                checked += 1;
            }
            assert!(checked >= 300, "只有 {checked}/400 轮真正校验过自洽性");
            assert_eq!(busy, 0, "面板读取不该出现锁失败");
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            assert!(committer.join().unwrap() >= 20, "并发提交必须真的在跑");
        });
        std::fs::remove_dir_all(&root).unwrap();
    }
}
