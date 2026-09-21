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

/// 模型名归一（#78）：去首尾空白 + 小写。与 Node 端 `src/models.js normalizeModel()` 的
/// 词法部分同一条规则（Node 还多做一步别名路由，见下）。同一模型在不同来源里记法不同
/// （ZCode 记 `GLM-5.3-Flash`、WorkBuddy 记 `glm-5.3-flash`），不归一时同一个模型会被拆成
/// 多行，价格键（全小写、两端价格查找都是精确匹配）也就再也匹配不上——此前桌面端只能靠
/// 人工往 prices.json 的 aliases 里补 `"GLM-5.3-Flash": "glm-5.3-flash"` 这类条目，
/// 漏一个就静默不计费。规则与两端黄金数记录在 docs/ARCHITECTURE.md「模型名归一」。
///
/// 与 Node 端刻意不同的两点（都是"不能相同"，不是漏掉）：
/// 1. 空名这里回落哨兵 `"unknown"`（本项目的 `Event.model` 是 `String`、落库列 NOT NULL），
///    Node 端返回 null 并落 NULL；两边各自只有一行，不参与任何黄金数。
/// 2. 别名路由（`deepseek-flash` → 具体计费模型）留在 prices.json 的 aliases 里：那是
///    "哪个键有价"的产品事实，两端价目表的键不同（同一对 id 甚至路由方向相反），
///    在这里合并必有一侧静默不计费。
pub fn normalize_model(value: &str) -> String {
    let n = value.trim().to_lowercase();
    if n.is_empty() {
        "unknown".to_string()
    } else {
        n
    }
}
