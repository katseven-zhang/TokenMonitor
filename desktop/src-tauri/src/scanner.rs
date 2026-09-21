use crate::{
    collectors,
    config::{self, Settings},
    db,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Instant, UNIX_EPOCH},
};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub agent: String,
    pub state: String,
    pub files: usize,
    pub parsed: usize,
    pub reused: usize,
    pub events: usize,
    pub malformed_lines: usize,
    pub errors: Vec<String>,
    pub updated_at: i64,
    pub duration_ms: u128,
}
fn fingerprint(path: &Path) -> Result<(i64, i64), String> {
    let m = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok((
        m.len() as i64,
        m.modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as i64,
    ))
}
fn set_status(db: &Connection, s: &ScanStatus) -> Result<(), String> {
    db.execute(
        "INSERT OR REPLACE INTO scan_status VALUES(?1,?2)",
        params![
            s.agent,
            serde_json::to_string(s).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn indexed_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .display()
        .to_string()
}
/// 同一轮扫描内的去重键。
///
/// Windows 的路径大小写不敏感，`C:\Logs\a.jsonl` 与 `C:\LOGS\A.JSONL` 是同一个文件，
/// 不归一就会把一份日志采两遍（raw_events 主键含 path，两份都留下）。
/// POSIX 恰好相反：大小写敏感，`/logs/A.jsonl` 与 `/logs/a.jsonl` 是两个文件，
/// 一律 `to_lowercase()` 会把后者当成重复直接跳过 —— 少一个文件、少一份用量，
/// 且没有任何错误。故归一只在 Windows 上编译进去（#85 第十项）。
#[cfg(windows)]
fn dedup_key(path: String) -> String {
    path.to_lowercase()
}
#[cfg(not(windows))]
fn dedup_key(path: String) -> String {
    path
}
fn collect_file(
    db: &mut Connection,
    agent: &str,
    path: &Path,
    project: Option<&str>,
    s: &mut ScanStatus,
) -> Result<(), String> {
    let path = PathBuf::from(indexed_path(path));
    let path_text = path.display().to_string();
    let (size, mtime) = fingerprint(&path)?;
    s.files += 1;
    // SQLite may change only in WAL; never skip it using the main file fingerprint.
    let sqlite = matches!(agent, "opencode" | "zcode" | "antigravity");
    if !sqlite && db::unchanged(db, &path_text, agent, size, mtime) {
        s.malformed_lines += db::malformed_lines(db, &path_text, agent)?;
        s.reused += 1;
        return Ok(());
    }
    let parsed = if agent == "antigravity" {
        collectors::read_antigravity(&path, project.unwrap_or(""))
    } else if sqlite {
        collectors::read_sqlite(agent, &path)
    } else {
        collectors::read_jsonl(agent, &path)
    }?;
    db::replace_file(db, &path_text, agent, size, mtime, &parsed)?;
    s.parsed += 1;
    s.events += parsed.events.len();
    s.malformed_lines += parsed.malformed_lines;
    Ok(())
}
pub fn scan(root: &Path, settings: &Settings) -> Result<Vec<ScanStatus>, String> {
    scan_cancellable(root, settings, &AtomicBool::new(false))
}
pub fn scan_cancellable(
    root: &Path,
    settings: &Settings,
    stop: &AtomicBool,
) -> Result<Vec<ScanStatus>, String> {
    let mut db = db::open(root)?;
    let mut results = vec![];
    for &(agent, _) in config::AGENTS {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let began = Instant::now();
        let mut s = ScanStatus {
            agent: agent.into(),
            state: "scanning".into(),
            updated_at: chrono::Utc::now().timestamp_millis(),
            ..Default::default()
        };
        if settings.disabled_agents.iter().any(|a| a == agent) {
            s.state = "disabled".into();
            set_status(&db, &s)?;
            results.push(s);
            continue;
        }
        set_status(&db, &s)?;
        let mut seen = BTreeSet::new();
        for source in settings.roots.get(agent).into_iter().flatten() {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let path = Path::new(source);
            if !path.exists() {
                continue;
            }
            if agent == "antigravity" {
                let projects = match collectors::antigravity_projects(path) {
                    Ok(p) => p,
                    Err(e) => {
                        s.errors.push(format!("{source}: {e}"));
                        continue;
                    }
                };
                let Some(parent) = path.parent() else {
                    continue;
                };
                for entry in walkdir::WalkDir::new(parent.join("conversations"))
                    .min_depth(1)
                    .max_depth(1)
                {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    match entry {
                        Ok(e)
                            if e.file_type().is_file()
                                && e.path().extension().is_some_and(|x| x == "db") =>
                        {
                            let name = e
                                .path()
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            let key = dedup_key(indexed_path(e.path()));
                            if !seen.insert(key) {
                                continue;
                            }
                            if let Err(err) = collect_file(
                                &mut db,
                                agent,
                                e.path(),
                                projects.get(&name).map(String::as_str),
                                &mut s,
                            ) {
                                s.errors.push(format!("{}: {err}", e.path().display()));
                            }
                        }
                        Err(e) => s.errors.push(e.to_string()),
                        _ => {}
                    }
                }
            } else if matches!(agent, "zcode" | "opencode") {
                if !seen.insert(dedup_key(indexed_path(path))) {
                    continue;
                }
                if let Err(e) = collect_file(&mut db, agent, path, None, &mut s) {
                    s.errors.push(format!("{source}: {e}"));
                }
            } else {
                for entry in walkdir::WalkDir::new(path).follow_links(false) {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    match entry {
                        Ok(e) if e.file_type().is_file() => {
                            let ext = e.path().extension().unwrap_or_default().to_string_lossy();
                            if ext != "jsonl"
                                && !(agent == "dsh" && (ext == "zstd" || ext == "zst"))
                            {
                                continue;
                            }
                            if !seen.insert(dedup_key(indexed_path(e.path()))) {
                                continue;
                            }
                            if let Err(err) = collect_file(&mut db, agent, e.path(), None, &mut s) {
                                s.errors.push(format!("{}: {err}", e.path().display()));
                            }
                        }
                        Err(e) => s.errors.push(e.to_string()),
                        _ => {}
                    }
                }
            }
        }
        s.state = if stop.load(Ordering::Relaxed) {
            "stopped"
        } else if !s.errors.is_empty() {
            "error"
        } else if s.malformed_lines > 0 {
            "warning"
        } else if s.files == 0 {
            "missing"
        } else {
            "ready"
        }
        .into();
        s.updated_at = chrono::Utc::now().timestamp_millis();
        s.duration_ms = began.elapsed().as_millis();
        set_status(&db, &s)?;
        results.push(s);
    }
    Ok(results)
}

/// #85 第十项：`seen` 的大小写归一只能建立在"文件系统本身不区分大小写"的前提上。
/// POSIX 上 `/logs/A.jsonl` 与 `/logs/a.jsonl` 是两个文件，一律 lowercase 会把后者
/// 当成重复静默跳过（少一份用量、零错误）；Windows 上它们是同一个文件，不归一就会采两遍。
#[cfg(test)]
mod tests {
    use super::dedup_key;

    #[test]
    fn seen_dedup_key_folds_case_only_where_the_filesystem_is_case_insensitive() {
        if cfg!(windows) {
            assert_eq!(
                dedup_key(r"C:\Logs\A.jsonl".into()),
                dedup_key(r"C:\logs\a.jsonl".into()),
                "Windows：同一文件的两种写法必须并成一个键"
            );
        } else {
            assert_ne!(
                dedup_key("/logs/A.jsonl".into()),
                dedup_key("/logs/a.jsonl".into()),
                "POSIX：大小写不同的两个文件名不能被并成一个键"
            );
        }
    }
}
