use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
pub const AGENTS: &[(&str, &str)] = &[
    ("codex", "Codex"),
    ("claude-code", "Claude Code"),
    ("ccmr", "ccmr"),
    ("zcode", "ZCode"),
    ("dsh", "dsh"),
    ("workbuddy", "WorkBuddy"),
    ("grok", "Grok Build"),
    ("pi", "Pi"),
    ("opencode", "OpenCode"),
    ("antigravity", "Antigravity"),
    ("qoder", "Qoder"),
    ("xiaomi-mimo", "Xiaomi MiMo Desktop"),
];
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub port: u16,
    pub refresh_seconds: u64,
    pub roots: BTreeMap<String, Vec<String>>,
    pub disabled_agents: Vec<String>,
}
impl Default for Settings {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let mut roots = BTreeMap::new();
        let codex = std::env::var_os("CODEX_HOME")
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        roots.insert(
            "codex".into(),
            vec![
                codex.join("sessions").display().to_string(),
                codex.join("archived_sessions").display().to_string(),
            ],
        );
        for (agent, relative) in [
            ("claude-code", ".claude/projects"),
            ("ccmr", ".claude-gateway/projects"),
            ("pi", ".pi/agent/sessions"),
            ("workbuddy", ".WorkBuddy/projects"),
            ("grok", ".grok/sessions"),
            ("dsh", ".dsh/sessions"),
            ("zcode", ".zcode/cli/db/db.sqlite"),
        ] {
            roots.insert(
                agent.into(),
                vec![home.join(relative).display().to_string()],
            );
        }
        let mut op = vec![home.join(".local/share/opencode/opencode.db")];
        if let Some(p) = dirs::data_local_dir() {
            op.push(p.join("opencode/opencode.db"));
        }
        if let Some(p) = std::env::var_os("XDG_DATA_HOME") {
            op.push(PathBuf::from(p).join("opencode/opencode.db"));
        }
        roots.insert(
            "opencode".into(),
            op.into_iter().map(|p| p.display().to_string()).collect(),
        );
        let mut ant = vec![];
        if let Some(p) = std::env::var_os("ANTIGRAVITY_HOME") {
            ant.push(PathBuf::from(p));
        }
        for name in [
            "antigravity",
            "antigravity-cli",
            "antigravity-acp",
            "antigravity-ide",
        ] {
            ant.push(home.join(".gemini").join(name));
        }
        roots.insert(
            "antigravity".into(),
            ant.into_iter()
                .map(|p| p.join("conversation_summaries.db").display().to_string())
                .collect(),
        );
        // Qoder CN：只注册 ~/.qoder-cn/projects（#105 的硬隐私边界）。同族的
        // .qwenworkcn/.qoderwork/.qoderworkcn/.qmind/.qoder/.qoder-cli 一律不发现、
        // 不扫描、不注册；.auth 永不进 roots。自定义目录由设置显式指定。
        let qoder = home.join(".qoder-cn");
        roots.insert(
            "qoder".into(),
            vec![qoder.join("projects").display().to_string()],
        );
        roots.insert("xiaomi-mimo".into(), vec![home.join(".local/share/mimocode/mimocode.db").display().to_string()]);
        Self {
            port: 8787,
            refresh_seconds: 60,
            roots,
            disabled_agents: vec![],
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 || !(10..=86400).contains(&self.refresh_seconds) {
            return Err("端口须为1–65535，刷新间隔须为10–86400秒".into());
        }
        if self
            .roots
            .keys()
            .chain(self.disabled_agents.iter())
            .any(|s| !AGENTS.iter().any(|(a, _)| a == s))
        {
            return Err("未知Agent标识".into());
        }
        for roots in self.roots.values() {
            for root in roots {
                if !Path::new(root).is_absolute() {
                    return Err(format!("数据源必须使用绝对路径: {root}"));
                }
            }
        }
        Ok(())
    }
}
pub fn data_dir() -> PathBuf {
    std::env::var_os("TOKENMONITOR_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            default_data_dir(&dirs::data_local_dir().unwrap_or_else(|| PathBuf::from(".")))
        })
}
pub fn default_data_dir(local: &Path) -> PathBuf {
    let current = local.join("TokenMonitor");
    let previous = local.join("TokenMonitor2");
    // Existing desktop users keep their exact cache/settings. New installations
    // use the canonical product root. Never merge incompatible Node databases.
    if !current.join("settings.json").exists()
        && (previous.join("settings.json").exists() || previous.join("events-v2.sqlite").exists()) {
        previous
    } else {
        current
    }
}
pub fn initialize(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    if !root.join("settings.json").exists() {
        save_json(&root.join("settings.json"), &Settings::default())?;
    }
    if !root.join("prices.json").exists() {
        fs::write(
            root.join("prices.json"),
            include_str!("../../config/prices.json"),
        )
        .map_err(|e| e.to_string())?;
    }
    if !root.join("service-token").exists() {
        fs::write(root.join("service-token"), uuid::Uuid::new_v4().to_string())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn settings(root: &Path) -> Result<Settings, String> {
    let mut s: Settings = serde_json::from_str(
        &fs::read_to_string(root.join("settings.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // Older settings predate these adapters. Preserve explicitly empty roots and
    // disabled agents; only absent source keys receive the new defaults.
    let defaults = Settings::default();
    for agent in ["qoder", "xiaomi-mimo"] {
        s.roots.entry(agent.into()).or_insert_with(|| defaults.roots[agent].clone());
    }
    s.validate()?;
    Ok(s)
}
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}
