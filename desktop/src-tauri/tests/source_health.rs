use std::{collections::BTreeMap,fs};
use tokenmonitor_core::{config,scanner};

#[test]
fn malformed_health_survives_cache_hits_and_clears_after_repair() {
    let root=std::env::temp_dir().join(format!("tm-health-{}",uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let source=root.join("sources");fs::create_dir(&source).unwrap();
    let path=source.join("session.jsonl");
    let settings=config::Settings{roots:BTreeMap::from([("codex".into(),vec![source.display().to_string()])]),..Default::default()};
    let good="{\"type\":\"session_meta\",\"payload\":{\"id\":\"health\"}}\n";
    fs::write(&path,format!("{good}bad complete record\n")).unwrap();
    for expected_reused in [0,1] {
        let status=scanner::scan(&root,&settings).unwrap();
        let s=status.iter().find(|s|s.agent=="codex").unwrap();
        assert_eq!(s.malformed_lines,1);assert_eq!(s.state,"warning");assert_eq!(s.reused,expected_reused);
    }
    fs::write(&path,good).unwrap();
    let status=scanner::scan(&root,&settings).unwrap();
    let s=status.iter().find(|s|s.agent=="codex").unwrap();
    assert_eq!(s.malformed_lines,0);assert_eq!(s.state,"ready");
    fs::write(&path,format!("{good}{{\"type\":" )).unwrap();
    for _ in 0..2 {
        let status=scanner::scan(&root,&settings).unwrap();
        let s=status.iter().find(|s|s.agent=="codex").unwrap();
        assert_eq!(s.malformed_lines,0);assert_eq!(s.state,"ready");
    }
    fs::write(&path,format!("{good}{{\"type\":\"turn_context\",\"payload\":{{\"model\":\"m\"}}}}\n")).unwrap();
    let status=scanner::scan(&root,&settings).unwrap();
    let s=status.iter().find(|s|s.agent=="codex").unwrap();
    assert_eq!(s.malformed_lines,0);assert_eq!(s.parsed,1);assert_eq!(s.state,"ready");
    fs::remove_dir_all(root).unwrap();
}
