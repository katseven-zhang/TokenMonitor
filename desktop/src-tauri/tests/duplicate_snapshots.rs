use tokenmonitor_core::{db,model::{Event,Parsed,Query,Tokens}};

#[test]
fn newer_observation_wins_over_lexicographically_first_archive() {
    let root=std::env::temp_dir().join(format!("tokenmonitor-snapshots-{}",uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut cache=db::open(&root).unwrap();
    let snapshot=|path:&str,ts,output|Parsed{events:vec![Event{id:"same-request".into(),agent:"claude-code".into(),session:"s".into(),project:"p".into(),model:"m".into(),ts,tokens:Tokens{input:100,output,..Default::default()},path:path.into(),line:1}],..Default::default()};
    db::replace_file(&mut cache,"a-archive","claude-code",1,500,&snapshot("a-archive",60_000,10)).unwrap();
    db::replace_file(&mut cache,"z-live","claude-code",2,100,&snapshot("z-live",61_000,40)).unwrap();
    let query=Query{start:0,end:120_000,agent:Some("claude-code".into()),session:None,model:None,project:None,search:String::new(),time_zone: None, offset_minutes: 0};
    let rows=db::events(&cache,&query).unwrap();
    assert_eq!(rows.len(),1);
    assert_eq!(rows[0].tokens.output,40);
    // Upgrade an existing cache using the former path-first view atomically.
    cache.execute_batch("DROP VIEW events; CREATE VIEW events AS SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY agent,id ORDER BY path) AS rank FROM raw_events) WHERE rank=1; UPDATE cache_metadata SET value='1' WHERE key='view_revision';").unwrap();
    assert_eq!(db::events(&cache,&query).unwrap()[0].tokens.output,10);
    drop(cache);
    let mut cache=db::open(&root).unwrap();
    assert_eq!(db::events(&cache,&query).unwrap()[0].tokens.output,40);
    // A later source revision at the same timestamp can correct usage downwards.
    db::replace_file(&mut cache,"a-archive","claude-code",3,600,&snapshot("a-archive",61_000,30)).unwrap();
    assert_eq!(db::events(&cache,&query).unwrap()[0].tokens.output,30);
    // Reopening applies no destructive migration and preserves the chosen snapshot.
    drop(cache);
    let mut cache=db::open(&root).unwrap();
    assert_eq!(db::events(&cache,&query).unwrap()[0].tokens.output,30);
    db::replace_file(&mut cache,"a-archive","claude-code",0,700,&Parsed::default()).unwrap();
    assert_eq!(db::events(&cache,&query).unwrap()[0].tokens.output,40);
    drop(cache);
    std::fs::remove_dir_all(root).unwrap();
}
