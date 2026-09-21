use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Input excludes cache read/write. Reasoning is a subset of output, never added to total.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: i64,
    pub cached: i64,
    pub cache_write: i64,
    pub output: i64,
    pub reasoning: i64,
}
impl Tokens {
    pub fn total(&self) -> i64 {
        self.input + self.cached + self.cache_write + self.output
    }
    pub fn add(&mut self, other: &Self) {
        self.input += other.input;
        self.cached += other.cached;
        self.cache_write += other.cache_write;
        self.output += other.output;
        self.reasoning += other.reasoning;
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub agent: String,
    pub session: String,
    pub project: String,
    pub model: String,
    pub ts: i64,
    pub tokens: Tokens,
    pub path: String,
    pub line: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    pub agent: String,
    pub session: String,
    pub ts: i64,
    pub name: String,
    pub path: String,
    pub line: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub agent: String,
    pub session: String,
    pub ts: i64,
    pub payload: Value,
}
#[derive(Debug, Default)]
pub struct Parsed {
    pub events: Vec<Event>,
    pub activities: Vec<Activity>,
    pub quotas: Vec<Quota>,
    pub title: Option<String>,
    pub malformed_lines: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub start: i64,
    pub end: i64,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub search: String,
    /// Minutes east of UTC. Client passes the selected display timezone offset.
    #[serde(default)]
    pub offset_minutes: i32,
    /// IANA display timezone. Missing only for explicitly fixed-offset API callers.
    #[serde(default)]
    pub time_zone: Option<String>,
}
impl Query {
    pub fn validate(&self) -> Result<(), String> {
        if self.start < 0 || self.end <= self.start || self.end > 32_503_680_000_000 {
            return Err("无效时间范围：开始时间必须早于结束时间".into());
        }
        if !(-24 * 60..=24 * 60).contains(&self.offset_minutes) {
            return Err("无效时区".into());
        }
        if let Some(zone)=&self.time_zone { zone.parse::<chrono_tz::Tz>().map_err(|_|format!("无效 IANA 时区: {zone}"))?; }
        Ok(())
    }
    pub fn matches(&self, e: &Event) -> bool {
        e.ts >= self.start
            && e.ts < self.end
            && self.agent.as_ref().is_none_or(|x| x == &e.agent)
            && self.model.as_ref().is_none_or(|x| x == &e.model)
            && self.project.as_ref().is_none_or(|x| project_key(x) == project_key(&e.project))
            && self.session.as_ref().is_none_or(|x| x == &e.session)
            && (self.search.is_empty()
                || format!("{} {} {}", e.model, e.project, e.session)
                    .to_lowercase()
                    .contains(&self.search.to_lowercase()))
    }
}

/// Windows drive/UNC paths share grouping identity across separators and ASCII
/// case. Other project identifiers (including POSIX paths) stay case-sensitive.
pub fn windows_project_key(value: &str) -> Option<String> {
    let bytes=value.as_bytes();
    let drive=bytes.len()>=3 && bytes[0].is_ascii_alphabetic() && bytes[1]==b':' && matches!(bytes[2],b'/'|b'\\');
    if !drive && !value.starts_with("\\\\") && !value.starts_with("//") { return None; }
    let normalized=value.replace('\\',"/").to_ascii_lowercase();
    Some(if drive && normalized.len()==3 { normalized } else { normalized.trim_end_matches('/').to_string() })
}
pub fn project_key(value: &str) -> String {
    windows_project_key(value).unwrap_or_else(||value.to_string())
}

/// #62: `fs::canonicalize` yields Windows verbatim paths (`\\?\...`);
/// `explorer.exe /select,` cannot handle them and the export "Source" column
/// becomes unreadable. Only the user-facing endpoints strip the prefix — the
/// stored cache keys stay exactly as indexed (old and new rows share one
/// format). A verbatim UNC (`\\?\UNC\server\share\x`) is restored to
/// `\\server\share\x`; anything else passes through unchanged.
pub fn display_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{rest}");
    }
    if let Some(rest) = path.strip_prefix("\\\\?\\") {
        return rest.to_string();
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::display_path;
    /// #62 黄金样例：三种 verbatim 形态各自的展示结果；普通路径原样保留。
    /// 合成盘符 Q: 与 UNC 服务器名都是纯字符串输入，不触碰文件系统。
    #[test]
    fn verbatim_prefix_only_disappears_for_user_facing_endpoints() {
        assert_eq!(display_path(r"\\?\Q:\sessions\a.jsonl"), r"Q:\sessions\a.jsonl");
        assert_eq!(display_path(r"\\?\UNC\nas-share\sessions\a.jsonl"), r"\\nas-share\sessions\a.jsonl");
        assert_eq!(display_path(r"\\?\Q:\"), r"Q:\");
        assert_eq!(display_path(r"Q:\already\normal.jsonl"), r"Q:\already\normal.jsonl");
        assert_eq!(display_path("/tmp/plain.jsonl"), "/tmp/plain.jsonl");
    }
}
