use serde_json::json;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use tokenmonitor_core::{collectors, config, db, scanner};

fn count(cache: &rusqlite::Connection, sql: &str) -> i64 {
    cache.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn token_rec(ts: &str) -> String {
    json!({"timestamp": ts, "type": "event_msg", "payload": {"type": "token_count",
        "info": {"last_token_usage": {"input_tokens": 1000, "cached_input_tokens": 0, "output_tokens": 0}}}})
    .to_string()
}

/// #111 纯判定：Windows 文件系统大小写不敏感，`.JSONL` / `.Jsonl` / `.ZSTD` 与
/// 小写形式是同一类文件。修前扫描器写的是 `ext != "jsonl"`（大小写敏感），
/// 大写扩展名的日志被**静默跳过**：不计 files、不进 seen、也不报错。
#[test]
fn extension_predicate_is_case_insensitive_for_jsonl_and_dsh_frames() {
    for up in ["JSONL", "Jsonl", "jSoNl"] {
        assert!(scanner::is_collectable_ext("codex", OsStr::new(up)), "{up} 必须入选");
    }
    assert!(scanner::is_collectable_ext("codex", OsStr::new("jsonl")));
    for up in ["ZSTD", "Zst", "zST"] {
        assert!(scanner::is_collectable_ext("dsh", OsStr::new(up)), "dsh 的 {up} 必须入选");
        assert!(collectors::is_dsh_zstd_ext(OsStr::new(up)), "解码分支必须认 {up}");
    }
    // 反向：非 dsh 的来源不得因为一个 .ZSTD 就入选；非日志后缀也不得入选。
    assert!(!scanner::is_collectable_ext("codex", OsStr::new("ZSTD")));
    assert!(!scanner::is_collectable_ext("codex", OsStr::new("log")));
    assert!(!scanner::is_collectable_ext("codex", OsStr::new("")));
}

/// #111 行为级：真扫描一遍，大写扩展名的文件必须**真的被采集**（黄金数 3 份文件、
/// 3 条事件）。修前这里只会收到 1 份小写文件，另外两份连"被跳过"的痕迹都没有。
#[test]
fn uppercase_extension_files_are_collected_by_a_real_scan() {
    let root = std::env::temp_dir().join(format!("tm-extcase-{}", uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let source = root.join("会话 目录"); // 中文+空格路径，顺带覆盖真实目录名的取值链
    fs::create_dir_all(&source).unwrap();
    let upper = source.join("大写.JSONL");
    let mixed = source.join("Mixed.Jsonl");
    let lower = source.join("plain.jsonl");
    for (i, p) in [&upper, &mixed, &lower].iter().enumerate() {
        fs::write(
            p,
            format!("{}\n", token_rec(&format!("2026-09-20T00:0{}:00Z", i))),
        )
        .unwrap();
    }
    let settings = config::Settings {
        roots: BTreeMap::from([("codex".into(), vec![source.display().to_string()])]),
        ..Default::default()
    };
    let status = scanner::scan(&root, &settings).unwrap();
    let codex = status.iter().find(|s| s.agent == "codex").unwrap();
    assert!(codex.errors.is_empty(), "{:?}", codex.errors);
    let cache = db::open(&root).unwrap();
    assert_eq!(
        count(&cache, "SELECT COUNT(*) FROM source_files WHERE agent='codex'"),
        3,
        "三份文件都要被登记（修前大写那两份被静默跳过）"
    );
    assert_eq!(count(&cache, "SELECT COUNT(*) FROM events WHERE agent='codex'"), 3);
    drop(cache);
    fs::remove_dir_all(&root).ok();
}

/// #111 sqlite 源同一条口径：`.DB` 也是数据库文件，不能因为大小写就整个来源为空。
#[test]
fn sqlite_source_accepts_uppercase_extension() {
    for up in ["DB", "Db"] {
        assert!(
            scanner::is_sqlite_db_ext(OsStr::new(up)),
            "{up} 必须被认成 sqlite 文件"
        );
    }
    assert!(scanner::is_sqlite_db_ext(OsStr::new("db")));
    assert!(!scanner::is_sqlite_db_ext(OsStr::new("sqlite")));
}
