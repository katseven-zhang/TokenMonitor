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

/// #111：Windows 文件系统大小写不敏感，`会话.JSONL` 与 `会话.jsonl` 是同一类文件。
/// 修前这里做的是**大小写敏感**的字符串比较（`ext != "jsonl"`），于是 `.JSONL`/`.Jsonl`/
/// `.ZSTD` 的日志被**静默跳过**——不计 files、不进 seen、也不报错，用户看到的是
/// 「这个来源一条都没有」。改成显式的小写不敏感判定，集中在这一个函数里，
/// 免得扫描器与解析器两处各写一遍再走岔（dsh 的 zstd 分支两边都要认）。
pub fn is_collectable_ext(agent: &str, ext: &std::ffi::OsStr) -> bool {
    ext.eq_ignore_ascii_case("jsonl") || (agent == "dsh" && collectors::is_dsh_zstd_ext(ext))
}

/// #111：sqlite 源的文件名判定，同一条大小写不敏感口径（`.DB` 也是数据库文件）。
pub fn is_sqlite_db_ext(ext: &std::ffi::OsStr) -> bool {
    ext.eq_ignore_ascii_case("db")
}

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
    /// #110：本轮"同一个指纹反复失败"的文件数（新失败的 + 正在退避跳过的）。
    /// 与 `errors` 分开计，是因为退避期不再重复报错：`errors` 空、这一项非零，
    /// 面板仍要能说出"有 N 个文件暂缓重试"。
    pub failed_files: usize,
    /// #110：上面这些文件里最早允许再试的时刻（毫秒）。`None` = 没有在退避的文件。
    pub next_retry_at: Option<i64>,
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
    // #63: only reuse when the cached observation is intact *and* carries its
    // source_health row; a missing row forces the reparse that writes it back.
    // #110：负缓存只对指纹可信的源生效——sqlite 的主文件指纹代表不了 WAL，而它
    // 的失败多半是一时的文件占用，退避只会让"锁放开之后"的恢复变慢。
    if !sqlite {
        let now = chrono::Utc::now().timestamp_millis();
        if let Some(f) = db::failure_gate(db, &path_text, agent, size, mtime, now)? {
            s.failed_files += 1;
            s.next_retry_at =
                Some(s.next_retry_at.map_or(f.retry_at_ms, |t| t.min(f.retry_at_ms)));
            return Ok(());
        }
        if let Some(malformed) = db::cache_hit(db, &path_text, agent, size, mtime)? {
            s.malformed_lines += malformed;
            s.reused += 1;
            return Ok(());
        }
    }
    let read = if agent == "antigravity" {
        collectors::read_antigravity(&path, project.unwrap_or(""))
    } else if sqlite {
        collectors::read_sqlite(agent, &path)
    } else {
        collectors::read_jsonl(agent, &path)
    };
    let parsed = match read {
        Ok(parsed) => parsed,
        Err(e) => {
            // #110：失败现在要落库（同一指纹 attempt 递增，到阈值后 failure_gate
            // 挡掉重复的整文件重读）。记账本身出错时继续抛原始错误：否则用户看到的
            // 是"记不上账"，而不是"这个文件读不了"。
            if !sqlite {
                let now = chrono::Utc::now().timestamp_millis();
                if let Ok(f) = db::record_failure(db, &path_text, agent, size, mtime, &e, now) {
                    s.failed_files += 1;
                    if f.retry_at_ms > now {
                        s.next_retry_at = Some(
                            s.next_retry_at.map_or(f.retry_at_ms, |t| t.min(f.retry_at_ms)),
                        );
                    }
                }
            }
            return Err(e);
        }
    };
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
        // #71: 只有这一轮真的对着存在的根目录走完了一次完整、无错的扫描，
        // seen 才能当作"哪些文件消失了"的证据（见下方对账前的守卫）。
        let mut roots_present = false;
        for source in settings.roots.get(agent).into_iter().flatten() {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let path = Path::new(source);
            if !path.exists() {
                continue;
            }
            roots_present = true;
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
                                && e.path().extension().is_some_and(is_sqlite_db_ext) =>
                        {
                            let name = e
                                .path()
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            let key = indexed_path(e.path()).to_lowercase();
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
                if !seen.insert(indexed_path(path).to_lowercase()) {
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
                            if !e.path().extension().is_some_and(|ext| is_collectable_ext(agent, ext)) {
                                continue;
                            }
                            if !seen.insert(indexed_path(e.path()).to_lowercase()) {
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
        // #71 删除对账：文件被删除或移走后，缓存行必须撤回，否则已消失的会话
        // 永远挂在面板上。守卫三件套：至少有一个根目录存在（盘没插不算删除）、
        // 扫描没有被 stop 打断、全程零错误（任何目录遍历出错都让 seen 不完整，
        // 拿它删行会把还在的文件误删）。身份让位规则与 replace_file 相同：
        // 归档副本仍持同 id 事件时由 db::forget_file 在同一事务里重新选举。
        if roots_present && !stop.load(Ordering::Relaxed) && s.errors.is_empty() {
            let stale: Vec<String> = db
                .prepare("SELECT path FROM source_files WHERE agent=?1")
                .map_err(|e| e.to_string())?
                .query_map([agent], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<String>, _>>()
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|p| !seen.contains(&p.to_lowercase()))
                .collect();
            for path in stale {
                if let Err(e) = db::forget_file(&mut db, &path, agent) {
                    s.errors.push(format!("{path}: {e}"));
                }
            }
        }
        // #110：以前只要 errors 非空就是 "error"，面板分不出"一个坏文件 + 其余正常"
        // 和"这个来源这轮什么都没成功"，而退避期 errors 是空的，更会把坏来源显示成
        // ready。现在按"这轮有没有任何文件成功"分档：
        //   全部失败 -> error，有坏文件但其余就绪 -> degraded。
        let succeeded = s.parsed + s.reused;
        s.state = if stop.load(Ordering::Relaxed) {
            "stopped"
        } else if succeeded == 0 && (!s.errors.is_empty() || s.failed_files > 0) {
            "error"
        } else if !s.errors.is_empty() || s.failed_files > 0 {
            "degraded"
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
