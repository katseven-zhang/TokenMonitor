use serde_json::json;
use std::{collections::BTreeMap, fs};
use tokenmonitor_core::{config, db, scanner};

fn count(cache: &rusqlite::Connection, sql: &str) -> i64 {
    cache.query_row(sql, [], |r| r.get(0)).unwrap()
}

/// #71：源文件被删除/移走是常态（Claude 会话清理、Codex 归档），修前没有任何
/// 删除对账，文件索引过就永远留在缓存里。黄金数：X 两条事件、Y 一条事件，
/// 每条 input 1000；删除 Y 再扫一轮：source_files 2→1、events 视图 3→2、
/// token 合计 3000→2000，且扫描零错误。一个根目录都不存在（盘没插）不算
/// 删除：缓存必须原样保留，等来源回来。
#[test]
fn deleted_source_files_are_retracted_by_the_next_clean_scan() {
    let root = std::env::temp_dir().join(format!("tm-reconcile-{}", uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let source = root.join("sessions");
    fs::create_dir_all(&source).unwrap();
    let rec = |ts: &str| {
        json!({"timestamp": ts, "type": "event_msg", "payload": {"type": "token_count",
            "info": {"last_token_usage": {"input_tokens": 1000, "cached_input_tokens": 0, "output_tokens": 0}}}})
        .to_string()
    };
    let x = source.join("x.jsonl");
    let y = source.join("y.jsonl");
    fs::write(
        &x,
        format!("{}\n{}\n", rec("2026-09-20T00:00:01Z"), rec("2026-09-20T00:00:02Z")),
    )
    .unwrap();
    fs::write(&y, format!("{}\n", rec("2026-09-20T00:01:00Z"))).unwrap();
    let settings = config::Settings {
        roots: BTreeMap::from([("codex".into(), vec![source.display().to_string()])]),
        ..Default::default()
    };
    scanner::scan(&root, &settings).unwrap();
    {
        let cache = db::open(&root).unwrap();
        assert_eq!(count(&cache, "SELECT COUNT(*) FROM source_files WHERE agent='codex'"), 2);
        assert_eq!(count(&cache, "SELECT COUNT(*) FROM events WHERE agent='codex'"), 3);
        assert_eq!(
            count(&cache, "SELECT COALESCE(SUM(json_extract(data,'$.tokens.input')),0) FROM events"),
            3000
        );
    }
    fs::remove_file(&y).unwrap();
    let status = scanner::scan(&root, &settings).unwrap();
    let codex = status.iter().find(|s| s.agent == "codex").unwrap();
    assert!(codex.errors.is_empty(), "{:?}", codex.errors);
    {
        let cache = db::open(&root).unwrap();
        assert_eq!(count(&cache, "SELECT COUNT(*) FROM source_files WHERE agent='codex'"), 1);
        assert_eq!(count(&cache, "SELECT COUNT(*) FROM events WHERE agent='codex'"), 2);
        assert_eq!(
            count(&cache, "SELECT COALESCE(SUM(json_extract(data,'$.tokens.input')),0) FROM events"),
            2000
        );
    }
    // 根目录整体消失（移动硬盘拔出）不是删除证据：X 的行必须还在。
    fs::remove_dir_all(&source).unwrap();
    scanner::scan(&root, &settings).unwrap();
    {
        let cache = db::open(&root).unwrap();
        assert_eq!(count(&cache, "SELECT COUNT(*) FROM source_files WHERE agent='codex'"), 1);
        assert_eq!(count(&cache, "SELECT COUNT(*) FROM events WHERE agent='codex'"), 2);
    }
    fs::remove_dir_all(root).unwrap();
}
