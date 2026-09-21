use std::{collections::BTreeMap,fs};
use tokenmonitor_core::{config,db,scanner};

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

/// #63：缺 `source_health` 行 + 指纹未变 = 曾经把一次查询失败升级成永久错误。
/// 历史缓存里索引过、但没写过健康行的文件每轮都走 unchanged 快速路径，修前每轮
/// 都进 errors、state 永远停在 "error"。修后按“无已知畸形行”处理：正常复用。
#[test]
fn missing_health_row_on_cache_hit_is_reused_not_fatal() {
    let root = std::env::temp_dir().join(format!("tm-health-missing-{}", uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let source = root.join("sources");
    fs::create_dir(&source).unwrap();
    let path = source.join("session.jsonl");
    fs::write(&path, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"ok\"}}\n").unwrap();
    let settings = config::Settings {
        roots: BTreeMap::from([("codex".into(), vec![source.display().to_string()])]),
        ..Default::default()
    };
    let first = scanner::scan(&root, &settings).unwrap();
    assert_eq!(first.iter().find(|s| s.agent == "codex").unwrap().state, "ready");
    // 模拟历史库：删掉这一行，文件本身不动（下一轮必然命中 unchanged）。
    {
        let cache = db::open(&root).unwrap();
        assert_eq!(cache.execute("DELETE FROM source_health WHERE agent='codex'", []).unwrap(), 1);
    }
    let second = scanner::scan(&root, &settings).unwrap();
    let s = second.iter().find(|s| s.agent == "codex").unwrap();
    assert!(s.errors.is_empty(), "{:?}", s.errors);
    assert_eq!(s.state, "ready");
    assert_eq!(s.reused, 1);
    assert_eq!(s.malformed_lines, 0);
    fs::remove_dir_all(root).unwrap();
}
