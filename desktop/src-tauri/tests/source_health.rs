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

/// 扫一轮，返回 codex 的 (parsed, reused, malformed_lines, state, errors)。
/// 返回 owned 值而不是 `&ScanStatus`，测试里才不用为一堆临时 Vec 的寿命绕路。
fn codex_scan(
    root: &std::path::Path,
    settings: &config::Settings,
) -> (usize, usize, usize, String, Vec<String>) {
    let statuses = scanner::scan(root, settings).unwrap();
    let s = statuses.iter().find(|x| x.agent == "codex").expect("codex status");
    (s.parsed, s.reused, s.malformed_lines, s.state.clone(), s.errors.clone())
}

/// #63 (a)：缺 `source_health` 行 + 指纹未变。曾经这里把"没有健康行"读成
/// "畸形行 = 0"上报：缓存明明知道这个文件有坏行，面板却永远显示 0；更要命的
/// 是快速路径继续命中，`replace_file` 永远轮不到，那一行再也补不回来——缓存
/// 自我屏蔽了唯一的修复路径。修后缺行等于"文件变了"：走完整重解析、按真实值
/// 上报畸形行、并由 `replace_file` 把健康行写回（下一轮才回到快速路径）。
#[test]
fn missing_health_row_forces_reparse_and_self_heals() {
    let root = std::env::temp_dir().join(format!("tm-health-heal-{}", uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let source = root.join("sources");
    fs::create_dir(&source).unwrap();
    let path = source.join("session.jsonl");
    // 已知有 1 条畸形行的文件：这样"上报 0"才是可观测的背离，而不是巧合。
    fs::write(&path, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"heals\"}}\nbad complete record\n").unwrap();
    let settings = config::Settings {
        roots: BTreeMap::from([("codex".into(), vec![source.display().to_string()])]),
        ..Default::default()
    };
    // 基线：首轮完整解析，健康行写好，畸形行 = 1。
    assert_eq!(codex_scan(&root, &settings), (1, 0, 1, "warning".into(), vec![]));
    // 文件未变、健康行健在 → 快速路径复用，畸形行照旧是 1。
    assert_eq!(codex_scan(&root, &settings), (0, 1, 1, "warning".into(), vec![]));
    // 模拟迁移前的历史库：只删健康行，文件本身一个字都不改（下一轮指纹仍命中）。
    {
        let cache = db::open(&root).unwrap();
        assert_eq!(cache.execute("DELETE FROM source_health WHERE agent='codex'", []).unwrap(), 1);
        let gone: i64 = cache
            .query_row("SELECT COUNT(*) FROM source_files WHERE agent='codex'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(gone, 1, "删的只是健康行：source_files 必须还在，否则这测的是全量重扫");
    }
    // 缺健康行 → 重解析、按真实值上报、错误列表干净。
    assert_eq!(codex_scan(&root, &settings), (1, 0, 1, "warning".into(), vec![]));
    {
        // 自愈证明：健康行重新存在，且带的是重解析后的真实值。
        let cache = db::open_read(&root).unwrap();
        let healed: usize = cache
            .query_row("SELECT malformed_lines FROM source_health WHERE agent='codex'", [], |r| r.get(0))
            .expect("重扫后 source_health 行必须回来");
        assert_eq!(healed, 1);
    }
    // 第四轮回到快速路径，数字保持稳定（不是修前那种"永久 0"）。
    assert_eq!(codex_scan(&root, &settings), (0, 1, 1, "warning".into(), vec![]));
    fs::remove_dir_all(root).unwrap();
}

/// #63 (b) 验收原话：`DELETE FROM source_health` 后重扫——无错误、文件被重新
/// 解析（parsed > 0）、状态 ready。健康文件另测一条，是为了让 "ready" 这个断言
/// 不被畸形行的 warning 混住（上一条测试负责畸形行的口径）。
#[test]
fn missing_health_row_on_cache_hit_is_reparsed_not_reported_as_zero() {
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
    assert!(s.parsed > 0, "缺健康行的文件必须被重新解析：{s:?}");
    assert_eq!(s.reused, 0);
    // 自愈：重解析把健康行写了回来，所以第三轮才允许复用。
    {
        let cache = db::open_read(&root).unwrap();
        let rows: i64 = cache
            .query_row("SELECT COUNT(*) FROM source_health WHERE agent='codex'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "重扫后 source_health 行必须恢复");
    }
    let third = scanner::scan(&root, &settings).unwrap();
    let s = third.iter().find(|s| s.agent == "codex").unwrap();
    assert_eq!(s.reused, 1, "健康行补回后快速路径恢复");
    assert_eq!(s.parsed, 0);
    assert_eq!(s.state, "ready");
    fs::remove_dir_all(root).unwrap();
}
