//! #82 补覆盖：审计点名"零覆盖"的两条路径——`disabled_agents` 的整源跳过
//! （scanner.rs 的 disabled 分支）与无效 IANA 时区（model.rs::validate 的文案，
//! 以及 query.rs 两条分桶腿现在共用的 `zone_of`）。两者此前都只测过 happy path，
//! 分支文案 "无效 IANA 时区" 在 src/ 与 tests/ 里一处都找不到。
//! 端口成功腿（save_settings 改端口）在 src/service.rs 的单元测试里。
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use tokenmonitor_core::{config, db, scanner, service};

fn codex_source(root: &std::path::Path) -> String {
    let dir = root.join("sources");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("session.jsonl"),
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"gap\",\"cwd\":\"D:\\\\我的 项目\"}}\n{\"timestamp\":\"2026-09-20T00:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"model\":\"m\",\"last_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":40,\"output_tokens\":5}}}}\n",
    )
    .unwrap();
    dir.display().to_string()
}

/// 禁用的源必须整源跳过：不遍历目录、不出数字、不写索引行，状态标成
/// disabled；面板仍要能读到这条状态（否则界面会把"用户关掉的源"显示成
/// "还没有扫过的源"）。重新启用后同一个文件要照常补采。
#[test]
fn disabled_agents_are_skipped_without_scanning_their_sources() {
    let root = std::env::temp_dir().join(format!("tm-disabled-{}", uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let source = codex_source(&root);
    let settings = config::Settings {
        roots: BTreeMap::from([("codex".into(), vec![source.clone()])]),
        disabled_agents: vec!["codex".into()],
        ..Default::default()
    };
    let statuses = scanner::scan(&root, &settings).unwrap();
    let off = statuses.iter().find(|s| s.agent == "codex").expect("codex status");
    assert_eq!(off.state, "disabled");
    assert_eq!(off.files, 0, "禁用的源不得遍历目录");
    assert_eq!(off.parsed, 0);
    assert_eq!(off.reused, 0);
    assert_eq!(off.malformed_lines, 0, "禁用的源不得贡献畸形行数");
    assert!(off.errors.is_empty(), "{:?}", off.errors);
    {
        let cache = db::open_read(&root).unwrap();
        let stored: String = cache
            .query_row("SELECT data FROM scan_status WHERE agent='codex'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap()["state"], "disabled");
        let rows: i64 = cache
            .query_row("SELECT COUNT(*) FROM source_files WHERE agent='codex'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "禁用的源不得留下索引行");
    }
    // 面板读取路径也要看得见这条 disabled 状态（scan_status 是它的唯一来源）。
    let listed: Vec<(String, String)> = scanner::scan(&root, &settings)
        .unwrap()
        .into_iter()
        .map(|s| (s.agent, s.state))
        .collect();
    assert_eq!(listed.iter().find(|(a, _)| a == "codex").unwrap().1, "disabled");
    assert_eq!(listed.iter().filter(|(_, state)| state == "disabled").count(), 1);
    // 取消禁用后同一个源恢复正常采集，之前的跳过没有把缓存搞坏。
    let enabled = config::Settings {
        roots: BTreeMap::from([("codex".into(), vec![source])]),
        ..Default::default()
    };
    let after = scanner::scan(&root, &enabled).unwrap();
    let on = after.iter().find(|s| s.agent == "codex").unwrap();
    assert_eq!(on.state, "ready");
    assert_eq!(on.parsed, 1);
    assert_eq!(on.events, 1);
    fs::remove_dir_all(&root).unwrap();
}

/// 无效 IANA 时区必须在真正的读取路径上失败，而不是悄悄退回 UTC。
/// 三条只读入口（dashboard / events / 导出的底层 `db::events`）共用
/// `Query::validate` 这一道闸，所以它们报的是同一句 `无效 IANA 时区: {zone}`；
/// `query.rs` 里那两处 `str::parse::<chrono_tz::Tz>` 排在 validate 之后，公共入口
/// 拿不到非法值，改由 `zone_of` 统一文案并在 `src/query.rs` 的单测里直接钉住。
/// 这里先证明夹具在合法时区下真的有数，再断言非法时区必然失败——否则
/// `is_err()` 是空跑。
#[test]
fn invalid_iana_time_zone_fails_every_read_path_that_accepts_one() {
    let root = std::env::temp_dir().join(format!("tm-zone-{}", uuid::Uuid::new_v4()));
    config::initialize(&root).unwrap();
    let source = codex_source(&root);
    fs::write(
        root.join("prices.json"),
        json!({"version":1,"currency":"USD","models":{"m":[{"input":2,"cached":0,"cacheWrite":0,"output":0}]}})
            .to_string(),
    )
    .unwrap();
    scanner::scan(&root, &config::Settings {
        roots: BTreeMap::from([("codex".into(), vec![source])]),
        ..Default::default()
    })
    .unwrap();
    let window = |zone: &str| json!({"query":{"start":0,"end":32_503_680_000_000i64,"agent":"codex","timeZone":zone}});
    // 先证明这条夹具在合法时区下真的有数（否则下面的 is_err 是空跑）。
    // 黄金数：codex 累计口径 input 100 含缓存 40 → input 60 + cached 40 + output 5。
    let ok = service::query_local(&root, "dashboard", &window("Asia/Shanghai")).unwrap();
    assert_eq!(ok["totals"]["totalTokens"], 105, "夹具本身要能出数");
    assert_eq!(ok["eventCount"], 1);
    assert!(ok["days"].as_array().unwrap().len() >= 1, "日历/分桶没有可用行，下面的时区断言就是空跑：{}", ok["days"]);
    for zone in ["Mars/Olympus_Mons", "Asia/Shangai", "UTC+9"] {
        for method in ["dashboard", "events"] {
            let err = service::query_local(&root, method, &window(zone)).unwrap_err();
            assert!(
                err.contains(&format!("无效 IANA 时区: {zone}")),
                "{method} + {zone} 报了别的错：{err}"
            );
        }
    }
    // 空字符串不是"未指定时区"，它是一个非法的 IANA 名。
    let empty = service::query_local(&root, "dashboard", &window("")).unwrap_err();
    assert!(empty.contains("无效 IANA 时区"), "{empty}");
    fs::remove_dir_all(&root).unwrap();
}
