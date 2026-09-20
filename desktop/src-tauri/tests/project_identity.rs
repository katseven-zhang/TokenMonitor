use tokenmonitor_core::{db,model::{Event,Parsed,Query,Tokens,project_key},pricing::Prices,query};

#[test]
fn windows_project_groups_and_drilldowns_share_identity_without_changing_raw_paths() {
    let root=std::env::temp_dir().join(format!("tokenmonitor-projects-{}",uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let mut cache=db::open(&root).unwrap();
    let paths=[r"D:\Work\项目", "d:/work/项目/", "/Work/Case", "/work/case", r"\\Server\Share\Project", "//server/share/project/", "D:/"];
    let parsed=Parsed{events:paths.iter().enumerate().map(|(i,project)|Event{id:i.to_string(),agent:"codex".into(),session:i.to_string(),project:project.to_string(),model:"m".into(),ts:60_000,tokens:Tokens{input:10,..Default::default()},path:"source.jsonl".into(),line:i+1}).collect(),..Default::default()};
    db::replace_file(&mut cache,"source.jsonl","codex",1,1,&parsed).unwrap();
    let mut q=Query{start:60_000,end:120_000,agent:Some("codex".into()),model:None,project:None,session:None,search:String::new(),offset_minutes:0};
    let prices=Prices::parse(r#"{"version":1,"currency":"USD","models":{}}"#).unwrap();
    let d=query::dashboard(&cache,&q,&prices).unwrap();
    assert_eq!(d["projects"].as_array().unwrap().len(),5);
    for (project,count) in [("d:/work/项目",2),(r"D:\WORK\项目\",2),("//server/share/project",2),("/Work/Case",1),("/work/case",1),("d:/",1)] {
        q.project=Some(project.into());
        let events=db::events(&cache,&q).unwrap();
        assert_eq!(events.len(),count,"{project}");
        assert!(events.iter().all(|e|q.matches(e)));
        assert_eq!(query::dashboard(&cache,&q,&prices).unwrap()["totals"]["totalTokens"],count*10);
        assert!(events.iter().all(|e|e.path=="source.jsonl"));
    }
    q.project=Some("d:/work/项目".into());
    assert_eq!(db::events(&cache,&q).unwrap()[0].project,paths[0]);
    assert_ne!(project_key("Project"),project_key("project"));
    drop(cache);std::fs::remove_dir_all(root).unwrap();
}
