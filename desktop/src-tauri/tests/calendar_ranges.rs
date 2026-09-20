use tokenmonitor_core::{config,db,model::{Event,Parsed,Query,Tokens},service};
use serde_json::json;
use std::fs;

fn timestamp(text:&str)->i64 { chrono::DateTime::parse_from_rfc3339(text).unwrap().timestamp_millis() }

#[test]
fn calendar_groups_drilldowns_and_exports_agree_across_dst() {
    let root=std::env::temp_dir().join(format!("tm-calendar-{}",uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();let mut cache=db::open(&root).unwrap();
    for (zone,start,end,day,hours) in [
        ("America/New_York","2026-03-07T05:00:00Z","2026-03-10T04:00:00Z","2026-03-08",23),
        ("America/New_York","2026-10-31T04:00:00Z","2026-11-03T05:00:00Z","2026-11-01",25),
        ("America/New_York","2026-03-31T04:00:00Z","2026-04-02T04:00:00Z","2026-04-01",24),
        ("Asia/Shanghai","2026-03-07T16:00:00Z","2026-03-10T16:00:00Z","2026-03-08",24),
    ] {
        let start=timestamp(start);let end=timestamp(end);
        let events=(start..end).step_by(30*60*1000).map(|ts|Event{id:ts.to_string(),agent:"codex".into(),session:"s".into(),project:"p".into(),model:"m".into(),ts,tokens:Tokens{input:1,..Default::default()},path:"fixture".into(),line:1}).collect();
        db::replace_file(&mut cache,"fixture","codex",1,1,&Parsed{events,..Default::default()}).unwrap();
        let q=Query{start,end,agent:None,model:None,project:None,session:None,search:String::new(),offset_minutes:-300,time_zone:Some(zone.into())};
        let data=service::query_local(&root,"dashboard",&json!({"query":q})).unwrap();
        let selected=data["days"].as_array().unwrap().iter().find(|r|r["key"]==day).unwrap();
        assert_eq!(selected["rangeEnd"].as_i64().unwrap()-selected["rangeStart"].as_i64().unwrap(),hours*3_600_000);
        assert_eq!(selected["events"],hours*2);
        for kind in ["days","months"] {
            for row in data[kind].as_array().unwrap() {
                let mut drill=q.clone();drill.start=start.max(row["rangeStart"].as_i64().unwrap());drill.end=end.min(row["rangeEnd"].as_i64().unwrap());
                let detail=service::query_local(&root,"dashboard",&json!({"query":drill})).unwrap();
                assert_eq!(detail["totals"]["events"],row["events"]);
                let path=root.join("calendar.csv");
                let export=service::query_local(&root,"export",&json!({"query":drill,"format":"csv","path":path})).unwrap();
                assert_eq!(export["rows"],row["events"]);
                assert_eq!(fs::read_to_string(path).unwrap().lines().count()-1,row["events"].as_u64().unwrap() as usize);
            }
        }
    }
    drop(cache);fs::remove_dir_all(root).unwrap();
}
