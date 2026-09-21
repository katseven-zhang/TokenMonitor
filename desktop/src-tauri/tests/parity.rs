//! #82: a real Node↔Rust parity gate over the ten synthetic source fixtures.
//!
//! The desktop side of the comparison is *not* hand-written JSON any more: this
//! test indexes the same fixture files with the desktop scanner (`scanner::scan`)
//! and then runs `desktop/scripts/compare-local.mjs` — the Node collectors' own
//! reading of those files — against the SQLite cache Rust produced. Per-agent
//! totals and cached tokens must agree, and every one of the ten agents in
//! `config::AGENTS` has to show up as compared. A source that genuinely cannot
//! match has to be listed in the probe's `DIVERGENCES` map with a *quantified*
//! gap and a reason — it is still asserted, only against that gap — and any
//! unlisted skip makes the probe exit non-zero, which this test checks.
mod common;

use common::Fixture;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use tokenmonitor_core::{config, db, scanner};

fn repo_root() -> PathBuf {
    // tests live in <root>/desktop/src-tauri/tests
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("desktop/src-tauri must sit under the repository root")
        .to_path_buf()
}

fn probe_output(node: &str, script: &Path, cache: &Path) -> (i32, String, String) {
    let output = Command::new(node)
        .arg("--disable-warning=ExperimentalWarning")
        .arg(script)
        .arg(cache)
        .output()
        .unwrap_or_else(|e| panic!("无法启动 {node} 跑平价探针（需要 Node >= 22.13）：{e}"));
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// rows are the probe's JSON report; assert one equal comparison per agent.
/// `equal` is not taken on trust: the numbers are re-derived here from the
/// row's own `old`/`current`/`gap`, so a probe that marks a real mismatch as
/// equal cannot pass this test.
fn check_covered(rows: &[Value], agents: &[&str]) {
    for agent in agents {
        let for_agent: Vec<&Value> = rows.iter().filter(|r| r["agent"] == *agent).collect();
        assert!(
            !for_agent.is_empty(),
            "{agent} 完全没有出现在探针输出里：{rows:?}"
        );
        for row in &for_agent {
            assert_ne!(
                row["unexplained"].as_bool(),
                Some(true),
                "{agent} 被无理由跳过：{row:?}"
            );
            let is_divergence = row["state"] == "quantified divergence";
            let gap_zero = ["events", "tokens", "cached"]
                .iter()
                .all(|k| row["gap"][k].as_i64() == Some(0));
            if is_divergence {
                // 登记"量化的分歧"必须真有其事：有理由、差值非零。
                assert!(
                    row["reason"].as_str().is_some_and(|r| !r.trim().is_empty()),
                    "{agent} 声明分歧却没给理由：{row:?}"
                );
                assert!(!gap_zero, "{agent} 的分差为 0，那就不叫分歧：{row:?}");
            } else {
                assert!(
                    gap_zero || row["gap"].is_null(),
                    "{agent} 没有登记分歧却带差值：{row:?}"
                );
            }
        }
        let compared: Vec<&Value> = for_agent
            .iter()
            .filter(|r| r["equal"].as_bool() == Some(true))
            .copied()
            .collect();
        assert!(
            !compared.is_empty(),
            "{agent} 没有任何一条 equal:true 的比较（Node 采集器与桌面缓存不平价）：{for_agent:?}"
        );
        for row in &compared {
            let gap = |k: &str| row["gap"][k].as_i64().unwrap_or(0);
            let num = |side: &str, k: &str| row[side][k].as_i64();
            // Per-agent totals and cached tokens are the two numbers the panels
            // show; the desktop side must also have indexed something real.
            for k in ["events", "tokens", "cached"] {
                assert_eq!(
                    num("old", k),
                    num("current", k).map(|v| v + gap(k)),
                    "{agent}: 探针自称 {k} 平价，实际对不上 {row:?}"
                );
            }
            assert!(
                num("current", "tokens").unwrap_or(0) > 0,
                "{agent}: 桌面侧一条 token 都没索引，这条比较是空跑 {row:?}"
            );
        }
    }
}

#[test]
fn node_and_rust_agree_on_all_ten_indexed_sources() {
    let f = Fixture::new();
    let settings = config::Settings {
        roots: f.ten_sources(),
        ..Default::default()
    };
    let statuses = scanner::scan(&f.0, &settings).unwrap();
    for s in &statuses {
        assert!(s.errors.is_empty(), "{}: 扫描报错 {s:?}", s.agent);
        assert!(
            s.files > 0 && s.parsed > 0,
            "{}: 这一源根本没被索引，平价测试会空跑：{s:?}",
            s.agent
        );
    }
    // Fold the WAL back into the main file so the probe's read-only handle sees
    // exactly what the desktop scanner committed.
    {
        let cache = db::open(&f.0).unwrap();
        cache.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    }
    let root = repo_root();
    let script = root.join("desktop").join("scripts").join("compare-local.mjs");
    assert!(script.exists(), "缺少平价探针：{}", script.display());
    let node = std::env::var("NODE").unwrap_or_else(|_| "node".into());
    let cache_path = f.0.join("events-v2.sqlite");
    let (code, stdout, stderr) = probe_output(&node, &script, &cache_path);
    let body = stdout
        .find('[')
        .and_then(|from| stdout.rfind(']').map(|to| &stdout[from..=to]))
        .unwrap_or_default();
    let rows: Vec<Value> = serde_json::from_str(body).unwrap_or_else(|e| {
        panic!("探针输出不是 JSON（exit {code}）：{e}\nstdout={stdout}\nstderr={stderr}")
    });
    let agents: Vec<&str> = config::AGENTS.iter().map(|(a, _)| *a).collect();
    assert_eq!(agents.len(), 10, "config::AGENTS 的数量是这条用例的前提");
    if code != 0 {
        panic!("平价探针 exit {code}\nstdout={stdout}\nstderr={stderr}");
    }
    check_covered(&rows, &agents);
}

/// The probe compares whatever the cache has rows for, so a cache that indexes
/// an agent no adapter knows about must fail loudly instead of skipping it.
/// This pins the adapter map against `config::AGENTS` drift without a second
/// hard-coded list: the fixture cache really holds all ten.
#[test]
fn probe_reports_every_agent_the_rust_scanner_indexed() {
    let f = Fixture::new();
    let settings = config::Settings {
        roots: f.ten_sources(),
        ..Default::default()
    };
    scanner::scan(&f.0, &settings).unwrap();
    {
        let cache = db::open(&f.0).unwrap();
        cache.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
    }
    let root = repo_root();
    let node = std::env::var("NODE").unwrap_or_else(|_| "node".into());
    let (_, stdout, _) = probe_output(
        &node,
        &root.join("desktop").join("scripts").join("compare-local.mjs"),
        &f.0.join("events-v2.sqlite"),
    );
    let body = &stdout[stdout.find('[').expect("探针输出应以 JSON 数组开始")..=stdout.rfind(']').unwrap()];
    let rows: Vec<Value> = serde_json::from_str(body).expect("探针输出是 JSON");
    let reported: std::collections::BTreeSet<String> = rows
        .iter()
        .filter_map(|r| r["agent"].as_str().map(str::to_string))
        .collect();
    let indexed: Vec<String> = config::AGENTS.iter().map(|(a, _)| a.to_string()).collect();
    assert_eq!(
        reported,
        indexed.iter().cloned().collect::<std::collections::BTreeSet<String>>(),
        "探针报告的源集合与 scanner 实际索引的源集合不一致（漏了就等于没有平价测试）"
    );
}
