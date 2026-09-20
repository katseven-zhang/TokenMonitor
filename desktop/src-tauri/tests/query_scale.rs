use std::{fs,sync::{Arc,atomic::{AtomicUsize,Ordering}},time::Instant};
use tokenmonitor_core::{db,model::{Activity,Event,Parsed,Query,Tokens}};

#[test]
#[ignore = "explicit 100k/1m release benchmark; creates a large temporary SQLite fixture"]
fn indexed_paging_at_100k_and_1m_with_concurrent_writer() {
    let root=std::env::temp_dir().join(format!("tm-query-scale-{}",uuid::Uuid::new_v4()));
    fs::create_dir(&root).unwrap();let mut cache=db::open(&root).unwrap();
    let began=Instant::now();
    for batch in 0..100 {
        let path=format!("fixture-{batch}");
        let events=(batch*10000..(batch+1)*10000).map(|i|Event{id:format!("{i:08}"),ts:60_000+i*1000,agent:"codex".into(),session:format!("s-{}",i%20),project:"D:/合成 项目".into(),model:"模型-Ä".into(),path:path.clone(),line:1,tokens:Tokens{input:1,..Default::default()}}).collect::<Vec<_>>();
        let activities=events.iter().map(|e|Activity{id:e.id.clone(),agent:e.agent.clone(),session:e.session.clone(),ts:e.ts,name:"Read".into(),path:e.path.clone(),line:1}).collect();
        db::replace_file(&mut cache,&path,"codex",batch,1,&Parsed{events,activities,title:Some("查询 标题".into()),..Default::default()}).unwrap();
        if batch!=9&&batch!=99 {continue;}
        let count=(batch+1)*10000;
        let narrow=Query{start:60_000+(count-5)*1000,end:60_000+count*1000,agent:None,model:None,project:None,session:None,search:String::new(),time_zone:Some("Asia/Shanghai".into()),offset_minutes:480};
        let mut explain=cache.prepare("EXPLAIN QUERY PLAN SELECT data FROM events WHERE ts>=?1 AND ts<?2 ORDER BY ts DESC,agent,id LIMIT 100").unwrap();
        let plan=explain.query_map([narrow.start,narrow.end],|r|r.get::<_,String>(3)).unwrap().map(Result::unwrap).collect::<Vec<_>>().join("; ");
        assert!(plan.contains("SEARCH event_current USING INDEX current_event_time"),"{plan}");
        assert!(!plan.contains("TEMP B-TREE"),"{plan}");drop(explain);
        let processed=Arc::new(AtomicUsize::new(0));let hook=processed.clone();
        cache.progress_handler(100,Some(move||{hook.fetch_add(100,Ordering::Relaxed);false}));
        let began_query=Instant::now();
        let (total,rows)=db::event_page(&cache,&narrow,0,100).unwrap();
        assert_eq!(total,5);assert_eq!(rows.len(),5);
        let vm_steps=processed.load(Ordering::Relaxed);assert!(vm_steps<5000,"narrow query processed {vm_steps} VM steps at {count} rows");
        cache.progress_handler(0,None::<fn()->bool>);
        println!("rows={count} narrow_ms={} vm_steps_rounded_down={vm_steps} plan={plan}",began_query.elapsed().as_millis());
        let mut wide=narrow.clone();wide.start=60_000;
        let processed=Arc::new(AtomicUsize::new(0));let hook=processed.clone();
        cache.progress_handler(100,Some(move||{hook.fetch_add(100,Ordering::Relaxed);false}));
        db::event_page(&cache,&wide,0,100).unwrap();
        assert!(processed.load(Ordering::Relaxed)>10000,"progress instrumentation must observe wide-range work");
        cache.progress_handler(0,None::<fn()->bool>);
        for offset in [0,50000,count as usize-100] {
            let began_page=Instant::now();let (total,rows)=db::event_page(&cache,&wide,offset,100).unwrap();
            assert_eq!(total,count as usize);assert_eq!(rows.len(),100);assert_eq!(rows[0].id,format!("{:08}",count as usize-offset-1));
            let (activity_total,activities)=db::activity_page(&cache,&wide,offset,100).unwrap();assert_eq!(activity_total,total);assert_eq!(activities[0].id,rows[0].id);
            println!("rows={count} offset={offset} events_plus_activities_ms={}",began_page.elapsed().as_millis());
        }
        let mut search=narrow.clone();search.search="模型-ä".into();
        assert_eq!(db::event_page(&cache,&search,0,100).unwrap().0,5);
        search.search="查询 标题".into();assert_eq!(db::activity_page(&cache,&search,0,100).unwrap().0,5);
        let writer_root=root.clone();
        let writer=std::thread::spawn(move||{let mut writer=db::open(&writer_root).unwrap();for i in 0..20{db::replace_file(&mut writer,"concurrent","pi",i,i,&Parsed::default()).unwrap();}});
        for _ in 0..20{assert_eq!(db::event_page(&cache,&narrow,0,100).unwrap().0,5);}
        writer.join().unwrap();
    }
    println!("fixture_and_checks_ms={}",began.elapsed().as_millis());
    drop(cache);fs::remove_dir_all(root).unwrap();
}
