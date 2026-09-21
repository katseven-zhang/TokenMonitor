use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsageRow {
    pub date: String,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub models: BTreeMap<String, ModelUsage>,
    pub projects: BTreeMap<String, ProjectUsage>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
    pub models: BTreeMap<String, ModelUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplaySummary {
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub duration_ms: Option<i64>,
    pub time_to_first_token_ms: Option<i64>,
    pub cwd: Option<String>,
    pub projects: Vec<String>,
    pub models: Vec<String>,
    pub cli_version: Option<String>,
    pub git: BTreeMap<String, String>,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
    pub turn_count: usize,
    pub message_count: usize,
    pub tool_call_count: usize,
    pub patch_count: usize,
    pub error_count: usize,
    /// JSONL lines that could not be parsed, so a partial replay is never
    /// presented as a complete one.
    pub malformed_lines: usize,
    /// Distinct payload types the parser has no rule for.
    pub unrecognized_event_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayMessage {
    pub timestamp: Option<String>,
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub raw_jsonl_line_numbers: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayToolCall {
    pub call_id: Option<String>,
    pub name: String,
    pub status: Option<String>,
    pub arguments: Option<String>,
    pub output: Option<String>,
    pub stderr: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayPatchResult {
    pub call_id: Option<String>,
    pub success: Option<bool>,
    pub output: Option<String>,
    pub timestamp: Option<String>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayTokenEvent {
    pub timestamp: Option<String>,
    pub model: String,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_output_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionReplayItem {
    Message {
        timestamp: Option<String>,
        role: String,
        source: String,
        text: String,
        #[serde(default)]
        raw_jsonl_line_numbers: Vec<usize>,
    },
    Reasoning {
        timestamp: Option<String>,
        text: String,
        #[serde(default)]
        raw_jsonl_line_numbers: Vec<usize>,
    },
    ToolCall {
        #[serde(flatten)]
        tool: SessionReplayToolCall,
        #[serde(default)]
        raw_jsonl_line_numbers: Vec<usize>,
    },
    Patch {
        #[serde(flatten)]
        patch: SessionReplayPatchResult,
        #[serde(default)]
        raw_jsonl_line_numbers: Vec<usize>,
    },
    TokenUsage {
        #[serde(flatten)]
        usage: SessionReplayTokenEvent,
        #[serde(default)]
        raw_jsonl_line_numbers: Vec<usize>,
    },
    Error {
        timestamp: Option<String>,
        text: String,
        #[serde(default)]
        raw_jsonl_line_numbers: Vec<usize>,
    },
    Notice {
        timestamp: Option<String>,
        label: String,
        text: Option<String>,
        #[serde(default)]
        raw_jsonl_line_numbers: Vec<usize>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayTurn {
    pub turn_id: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub system_messages: Vec<SessionReplayMessage>,
    pub user_messages: Vec<SessionReplayMessage>,
    pub assistant_messages: Vec<SessionReplayMessage>,
    pub reasoning_summaries: Vec<SessionReplayMessage>,
    pub tool_calls: Vec<SessionReplayToolCall>,
    pub patch_results: Vec<SessionReplayPatchResult>,
    pub token_events: Vec<SessionReplayTokenEvent>,
    pub errors: Vec<String>,
    pub items: Vec<SessionReplayItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayAgent {
    pub path: String,
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub depth: usize,
    pub agent_path: String,
    pub nickname: Option<String>,
    pub role: Option<String>,
    pub thread_name: Option<String>,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    #[serde(rename = "costUSD")]
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayDetail {
    pub path: String,
    pub session_id: String,
    pub thread_name: Option<String>,
    pub modified_at_ms: i64,
    pub size_bytes: i64,
    /// Total JSONL lines in the source file. The transcript itself is deliberately
    /// not part of this response — see `fetch_session_raw_page`, which pages it.
    pub raw_line_count: usize,
    pub agents: Vec<SessionReplayAgent>,
    pub summary: SessionReplaySummary,
    pub turns: Vec<SessionReplayTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplayRawPage {
    pub lines: Vec<String>,
    pub start: usize,
    pub total_lines: usize,
    pub modified_at_ms: i64,
    pub size_bytes: i64,
}

#[cfg(test)]
mod tests {
    use super::SessionReplayItem;

    #[test]
    fn serializes_replay_item_fields_as_camel_case() {
        let item = SessionReplayItem::Message {
            timestamp: None,
            role: "user".to_string(),
            source: "user_message".to_string(),
            text: "Hello".to_string(),
            raw_jsonl_line_numbers: vec![3],
        };

        let value = serde_json::to_value(item).expect("replay item should serialize");

        assert_eq!(value["rawJsonlLineNumbers"], serde_json::json!([3]));
        assert!(value.get("raw_jsonl_line_numbers").is_none());
    }
}
