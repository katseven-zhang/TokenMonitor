//! #110：`source_files.error` 从此有了写入方。
//!
//! 这一列自 #63 起只有读方（`unchanged()` 的 `AND error IS NULL`），`replace_file`
//! 恒写 NULL，所以那道守卫形同虚设：解析**持久**失败的文件没有任何负缓存，每轮扫描
//! 都重新指纹比对 → 整文件重读 → 再失败一次，来源状态永久 `error`，既不退避也不自愈。
//!
//! 夹具用 dsh 的 zstd 分支：帧头不是 zstd 时 `read_jsonl` **必然**返回 Err（#109 之后
//! 按行降级只覆盖 JSONL 文本，读不出压缩帧仍是一整次失败），所以这是一个不依赖文件
//! 权限、不依赖平台、跨轮稳定的"持久坏文件"。

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tokenmonitor_core::{config, db, scanner};

/// 一轮 dsh 扫描的可观测结果：(parsed, reused, failed_files, next_retry_at, state, errors)。
fn dsh_scan(root: &Path, settings: &config::Settings) -> (usize, usize, usize, Option<i64>, String, Vec<String>) {
    let statuses = scanner::scan(root, settings).unwrap();
    let s = statuses.iter().find(|x| x.agent == "dsh").expect("dsh status");
    (
        s.parsed,
        s.reused,
        s.failed_files,
        s.next_retry_at,
        s.state.clone(),
        s.errors.clone(),
    )
}

/// 读回失败账本（本测试只有一个 dsh 文件，直接取那一行）。`None` = error 列为 NULL。
fn ledger(root: &Path) -> Option<db::Failure> {
    let cache = db::open_read(root).unwrap();
    let raw: Option<String> = cache
        .query_row(
            "SELECT error FROM source_files WHERE agent='dsh'",
            [],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    raw.map(|text| serde_json::from_str::<db::Failure>(&text).expect("账本必须是本模块写的 JSON"))
}

fn dsh_settings(source: &Path) -> config::Settings {
    config::Settings {
        roots: BTreeMap::from([("dsh".into(), vec![source.display().to_string()])]),
        ..Default::default()
    }
}

fn temp_root(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!("tm-fail-{tag}-{}", uuid::Uuid::new_v4()))
}

/// 一个"永远读不出来"的 .zst：内容是普通文本，帧头校验必然失败。
fn write_broken(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, b"definitely not a zstd frame").unwrap();
    path
}

/// 一个能解出内容的 .zst（内容本身是否是好 JSONL 不重要：#109 之后坏行只计数，
/// 整文件仍然 Ok，所以它代表"同目录里其余正常的文件"）。
fn write_good(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let body = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"ok-110\"}}\n";
    fs::write(&path, zstd::stream::encode_all(body.as_bytes(), 1).unwrap()).unwrap();
    path
}

#[test]
fn persistent_parse_failure_is_ledgered_backed_off_and_self_heals() {
    let root = temp_root("ledger");
    config::initialize(&root).unwrap();
    let source = root.join("sources");
    fs::create_dir(&source).unwrap();
    let broken = write_broken(&source, "broken.zst");
    let settings = dsh_settings(&source);
    let broken_text = broken.display().to_string();

    // 第 1~3 轮：还没到退避阈值，每轮照旧真解析、照旧报错（前两次失败多半是文件正在
    // 被写、进程刚启动这类瞬时情况，一上来就挡住就是把可恢复的数据永久藏起来）。
    for attempt in 1..=db::FAILURE_SKIP_AFTER {
        let (parsed, reused, failed, next_retry, state, errors) = dsh_scan(&root, &settings);
        assert_eq!((parsed, reused), (0, 0), "失败的文件不可能被记成解析或复用");
        assert_eq!(failed, 1, "第 {attempt} 轮要如实报出一个失败文件");
        assert_eq!(
            errors.len(),
            1,
            "阈值之前每轮都还在真的重试，所以错误仍然看得见：{errors:?}"
        );
        // 验收项 (3)：错误信息带文件路径，光有"读不了"没法定位。
        assert!(errors[0].contains(&broken_text), "错误要带路径：{:?}", errors[0]);
        assert_eq!(state, "error", "这个来源这一轮什么都没成功 → 全部失败");
        let f = ledger(&root).expect("失败必须落库");
        assert_eq!(f.attempt, attempt, "同一指纹上的 attempt 递增");
        assert!(
            f.reason.contains("zstd") || !f.reason.is_empty(),
            "账本里要留下失败原因：{}",
            f.reason
        );
        if attempt < db::FAILURE_SKIP_AFTER {
            assert_eq!(next_retry, None, "还没开始退避时不该给出重试时刻");
            assert!(
                f.retry_at_ms <= chrono::Utc::now().timestamp_millis(),
                "阈值之前 retry_at 必须还在过去，否则 failure_gate 会提前挡路"
            );
        } else {
            assert!(next_retry.is_some(), "第 {attempt} 次失败之后进入退避");
            assert!(f.retry_at_ms > chrono::Utc::now().timestamp_millis());
        }
    }

    // 第 4 轮：退避生效。**不重解析**，所以这一轮没有新错误（errors 空），但状态不能
    // 掉回 ready —— 面板必须仍然说得出"这个来源没好东西"。
    let (parsed, reused, failed, next_retry, state, errors) = dsh_scan(&root, &settings);
    assert_eq!((parsed, reused), (0, 0));
    assert_eq!(failed, 1, "跳过的文件仍然算失败，不能被读成\"这个来源很干净\"");
    assert!(errors.is_empty(), "退避期不再重复报错（#114 那类刷屏的同一条教训）：{errors:?}");
    assert_eq!(state, "error");
    assert!(next_retry.is_some());
    assert_eq!(
        ledger(&root).unwrap().attempt,
        db::FAILURE_SKIP_AFTER,
        "attempt 停在 3 才是\"这一轮真的没再解析过\"：再失败一次会被推到 4"
    );

    // 那条 #63 守卫现在真的挡东西了：账本行占着同一个指纹，却绝不能被快速路径当成
    // "已缓存的健康观测"。
    {
        let cache = db::open_read(&root).unwrap();
        // 入库键是 canonicalize 之后的形态（Windows 上是 \\?\ 前缀），拿测试自己拼的
        // 路径去问 unchanged() 只会问出一行"根本没这个文件"，那是假绿。
        let stored: String = cache
            .query_row("SELECT path FROM source_files WHERE agent='dsh'", [], |r| r.get(0))
            .unwrap();
        assert!(stored.ends_with("broken.zst"), "账本行就是那个坏文件：{stored}");
        let (size, mtime) = {
            let m = fs::metadata(&broken).unwrap();
            (
                m.len() as i64,
                m.modified()
                    .unwrap()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64,
            )
        };
        assert!(
            !db::unchanged(&cache, &stored, "dsh", size, mtime),
            "error 非 NULL 的行必须挡住 unchanged()，否则 #63 那道守卫还是形同虚设"
        );
        assert_eq!(db::cache_hit(&cache, &stored, "dsh", size, mtime).unwrap(), None);
    }

    // 自愈：文件被换掉（指纹变了）→ 立刻重试，不等退避到期；成功后账本自动清空。
    let body = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"fixed-110\"}}\n";
    fs::write(&broken, zstd::stream::encode_all(body.as_bytes(), 1).unwrap()).unwrap();
    let (parsed, reused, failed, next_retry, state, errors) = dsh_scan(&root, &settings);
    assert_eq!((parsed, reused, failed), (1, 0, 0), "修好的文件必须马上重新解析：{errors:?}");
    assert_eq!(next_retry, None);
    assert!(errors.is_empty(), "{errors:?}");
    assert!(state == "ready" || state == "warning", "状态: {state}");
    assert!(ledger(&root).is_none(), "成功后 error 列要回到 NULL（replace_file 覆盖账本）");
    fs::remove_dir_all(root).unwrap();
}

/// 验收项 (3) 的前半：一个坏文件 + 其余就绪 ≠ 全部失败。修前只要 errors 非空就一律
/// "读取异常"，用户看不出这个来源到底还有没有在用。
#[test]
fn one_bad_file_among_healthy_ones_is_degraded_not_error() {
    let root = temp_root("degraded");
    config::initialize(&root).unwrap();
    let source = root.join("sources");
    fs::create_dir(&source).unwrap();
    let broken = write_broken(&source, "broken.zst");
    write_good(&source, "healthy.zst");
    let settings = dsh_settings(&source);

    let (parsed, reused, failed, next_retry, state, errors) = dsh_scan(&root, &settings);
    assert_eq!(parsed + reused, 1, "健康的那个必须照常入库");
    assert_eq!(failed, 1);
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].contains(&broken.display().to_string()));
    assert_eq!(state, "degraded", "有坏文件但其余就绪不是\"全部失败\"");
    assert_eq!(next_retry, None, "第一次失败还没到退避阈值");

    // 坏文件彻底消失后，来源回到干净状态（#71 的删除对账在 errors 为空的那轮才会跑）。
    fs::remove_file(&broken).unwrap();
    for _ in 0..2 {
        let (parsed, reused, failed, _, state, errors) = dsh_scan(&root, &settings);
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(failed, 0);
        assert!(parsed + reused >= 1, "健康文件这一轮要么重解析要么复用");
        assert!(state == "ready" || state == "warning", "{state}");
    }
    {
        let cache = db::open_read(&root).unwrap();
        let rows: i64 = cache
            .query_row("SELECT COUNT(*) FROM source_files WHERE agent='dsh'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "坏文件的账本行随文件一起撤回，不留孤儿行");
    }
    fs::remove_dir_all(root).unwrap();
}

/// 退避曲线本身：阈值之前不挡路，之后 60s 起指数增长、封顶 30 分钟，且不溢出。
#[test]
fn backoff_curve_is_immediate_then_exponential_and_capped() {
    let now = 1_700_000_000_000i64;
    for attempt in 1..db::FAILURE_SKIP_AFTER {
        assert_eq!(db::failure_retry_at(attempt, now), now, "第 {attempt} 次失败不该等");
    }
    assert_eq!(db::failure_retry_at(3, now), now + 60_000);
    assert_eq!(db::failure_retry_at(4, now), now + 120_000);
    assert_eq!(db::failure_retry_at(5, now), now + 240_000);
    assert_eq!(db::failure_retry_at(6, now), now + 480_000);
    assert_eq!(db::failure_retry_at(7, now), now + 960_000);
    assert_eq!(db::failure_retry_at(8, now), now + 1_800_000);
    // 封顶之后不再翻倍（一个坏了几天的文件最坏等半小时，而不是永远不再被看）；
    // 并且即便时刻已经接近 i64 上界也只是饱和，不会绕回过去把文件永久挡掉。
    assert_eq!(db::failure_retry_at(400, now), now + 1_800_000);
    assert_eq!(db::failure_retry_at(400, i64::MAX), i64::MAX);
}
