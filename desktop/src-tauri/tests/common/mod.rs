//! Shared synthetic ten-source fixtures (`tests/sources.rs` and
//! `tests/parity.rs` both drive the *same* files through the *same* scanner, so
//! the Node↔Rust comparison is over data the Rust side really indexed).
//! Everything is synthetic: temp dirs under `%TEMP%` and fake drive letters.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tokenmonitor_core::config;

pub const TS: i64 = 1_800_000_000_000;

/// RFC 3339 form of a millisecond instant. Codex, Claude Code and Pi write ISO
/// strings in their real transcripts and their Node collectors parse them with
/// `Date.parse(...)` (a bare JSON *number* parses to NaN and the record is
/// dropped), while the Rust collector accepts either; the fixture therefore uses
/// the wire format of the source it imitates instead of the Rust-only number.
/// Derived from `TS` so both sides can never disagree about the instant.
pub fn ts_iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .expect("fixture timestamp in range")
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub struct Fixture(pub PathBuf);
impl Fixture {
    pub fn new() -> Self {
        let path = std::env::temp_dir().join(format!("tm-中文 空格-{}", uuid::Uuid::new_v4()));
        config::initialize(&path).unwrap();
        Self(path)
    }
    pub fn jsonl(&self, agent: &str, records: &[Value]) -> String {
        let dir = self.0.join("sources").join(agent);
        fs::create_dir_all(&dir).unwrap();
        let text = records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\r\n")
            + "\r\n";
        if agent == "dsh" {
            // Each line is an independent zstd frame, as in the real append-only format.
            let bytes: Vec<u8> = text
                .split_inclusive('\n')
                .flat_map(|line| zstd::stream::encode_all(line.as_bytes(), 1).unwrap())
                .collect();
            fs::write(dir.join("session.v3.jsonl.zstd"), bytes).unwrap();
        } else {
            fs::write(dir.join("session.jsonl"), text).unwrap();
        }
        dir.display().to_string()
    }
    /// Build one file per configured agent and return the `roots` map a scan
    /// needs. Token accounting per agent is pinned by `tests/sources.rs`; the
    /// totals are repeated here so a parity break names the agent it belongs to.
    pub fn ten_sources(&self) -> BTreeMap<String, Vec<String>> {
        let mut roots = BTreeMap::new();
        let mut add = |agent: &str, records: Vec<Value>| {
            roots.insert(agent.to_string(), vec![self.jsonl(agent, &records)]);
        };
        add(
            "codex",
            vec![
                json!({"type":"session_meta","payload":{"id":"codex-session","cwd":"D:\\我的 项目"}}),
                json!({"type":"turn_context","payload":{"model":"m"}}),
                // A real rollout carries both the per-request `last_token_usage`
                // and the session-cumulative `total_token_usage`. The desktop
                // reads the former for its first event, the Node collector only
                // ever diffs the latter (see DIVERGENCES.codex in
                // desktop/scripts/compare-local.mjs).
                json!({"timestamp":ts_iso(TS),"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10},"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}),
                // Duplicate cumulative observation must not count as another request.
                json!({"timestamp":ts_iso(TS+1000),"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10},"total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":10}}}}),
            ],
        );
        for agent in ["claude-code", "ccmr"] {
            let record = json!({"timestamp":ts_iso(TS),"type":"assistant","sessionId":"claude-session","cwd":"D:\\我的 项目","message":{"id":"message-1","model":"m","usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":40},"content":[{"type":"tool_use","id":"tool-1","name":"Read"}]}});
            add(agent, vec![record.clone(), record]);
        }
        add(
            "workbuddy",
            vec![
                // `cache_read_input_tokens` is the field real WorkBuddy
                // transcripts carry (see the root fixture in test/run.mjs);
                // Rust also accepts `cached_input_tokens`, the Node collector
                // only reads the wire name.
                json!({"timestamp":TS,"id":"wb-1","sessionId":"wb-session","providerData":{"model":"m"},"message":{"usage":{"input_tokens":500,"cache_read_input_tokens":300,"output_tokens":50}}}),
            ],
        );
        add(
            "pi",
            vec![
                json!({"type":"session","id":"pi-session","cwd":"D:\\我的 项目"}),
                json!({"timestamp":ts_iso(TS),"type":"message","id":"pi-1","message":{"role":"assistant","model":"m","usage":{"input":240,"cacheRead":1000,"cacheWrite":300,"output":170}}}),
            ],
        );
        add(
            "dsh",
            vec![
                json!({"type":"session","time":TS-1000,"cwd":"D:\\我的 项目"}),
                json!({"type":"assistant/message","seq":1,"time":TS,"data":{"message":{"source":{"model":"m"}},"usage":{"inputTokens":400,"cacheReadTokens":1000,"cacheWriteTokens":30,"outputTokens":50}}}),
            ],
        );
        add(
            "grok",
            vec![
                json!({"timestamp":TS/1000,"params":{"sessionId":"grok-session","update":{"sessionUpdate":"turn_completed","prompt_id":"turn-1","usage":{"modelUsage":{"m":{"inputTokens":2000,"cachedReadTokens":1500,"cacheCreationTokens":100,"outputTokens":80}}}}}}),
            ],
        );

        let zpath = self.0.join("sources/zcode/db.sqlite");
        let z = sqlite(&zpath);
        // provider_id / computed_total_tokens are part of the real ZCode schema
        // (`src/collectors/zcode.js` selects them by name), so the fixture must
        // carry them or the Node side dies on "no such column" instead of
        // reporting a parity number. Rust reads neither one.
        z.execute_batch("CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE model_usage(id TEXT,session_id TEXT,provider_id TEXT,model_id TEXT,started_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,cache_creation_input_tokens INTEGER,cache_read_input_tokens INTEGER,computed_total_tokens INTEGER);CREATE TABLE tool_usage(session_id TEXT,tool_name TEXT,started_at INTEGER);INSERT INTO session VALUES('z-session','D:/我的 项目');").unwrap();
        z.execute(
            "INSERT INTO model_usage VALUES('z-1','z-session','p','m',?1,800,60,0,0,700,860)",
            [TS],
        )
        .unwrap();
        z.execute("INSERT INTO tool_usage VALUES('z-session','Bash',?1)", [TS])
            .unwrap();
        // Pending, missing and invalid negative usage must not inflate request counts.
        for (id, value) in [
            ("z-empty", Some(0)),
            ("z-null", None),
            ("z-negative", Some(-20)),
        ] {
            z.execute(
                "INSERT INTO model_usage VALUES(?1,'z-session','p','unknown',?2,?3,?3,?3,?3,?3,?3)",
                params![id, TS, value],
            )
            .unwrap();
        }
        roots.insert("zcode".into(), vec![zpath.display().to_string()]);

        let opath = self.0.join("sources/opencode/db.sqlite");
        let o = sqlite(&opath);
        // `time_updated` really exists in OpenCode's db and the JS collector
        // increments on it (`WHERE time_updated > ?`), so the fixture must carry
        // it: a NULL there silently drops every row on the Node side.
        o.execute_batch("CREATE TABLE session(id TEXT,directory TEXT);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);CREATE TABLE part(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);INSERT INTO session VALUES('o-session','D:/我的 项目');").unwrap();
        o.execute("INSERT INTO message VALUES('o-1','o-session',?1,?1,?2)",params![TS,json!({"role":"assistant","modelID":"m","time":{"created":TS},"tokens":{"input":100,"output":200,"reasoning":30,"cache":{"read":300,"write":100}}}).to_string()]).unwrap();
        roots.insert("opencode".into(), vec![opath.display().to_string()]);

        let apath = self.0.join("sources/antigravity/conversations/a-session.db");
        let a = sqlite(&apath);
        a.execute_batch("CREATE TABLE steps(idx INTEGER,metadata BLOB);CREATE TABLE gen_metadata(idx INTEGER,data BLOB);").unwrap();
        let timestamp = blob(1, &number(1, (TS / 1000) as u64));
        let usage = [
            number(2, 100),
            number(3, 806),
            number(4, 30),
            number(5, 200),
            number(9, 750),
            number(10, 56),
        ]
        .concat();
        let generation = blob(1, &[blob(4, &usage), blob(19, b"m")].concat());
        a.execute("INSERT INTO steps VALUES(1,?1)", [timestamp])
            .unwrap();
        a.execute("INSERT INTO gen_metadata VALUES(1,?1)", [generation])
            .unwrap();
        let index_path = self.0.join("sources/antigravity/conversation_summaries.db");
        let index = sqlite(&index_path);
        index
            .execute_batch(
                "CREATE TABLE conversation_summaries(conversation_id TEXT,workspace_uris TEXT);",
            )
            .unwrap();
        index
            .execute(
                "INSERT INTO conversation_summaries VALUES('a-session',?1)",
                [json!(["file:///D:/我的%20项目"]).to_string()],
            )
            .unwrap();
        roots.insert("antigravity".into(), vec![index_path.display().to_string()]);
        roots
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn var(mut n: u64) -> Vec<u8> {
    let mut out = vec![];
    while n >= 128 {
        out.push((n as u8 & 127) | 128);
        n >>= 7;
    }
    out.push(n as u8);
    out
}
pub fn number(field: u64, n: u64) -> Vec<u8> {
    [var(field << 3), var(n)].concat()
}
pub fn blob(field: u64, b: &[u8]) -> Vec<u8> {
    [var((field << 3) | 2), var(b.len() as u64), b.to_vec()].concat()
}
pub fn sqlite(path: &Path) -> Connection {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let c = Connection::open(path).unwrap();
    c.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    c
}
