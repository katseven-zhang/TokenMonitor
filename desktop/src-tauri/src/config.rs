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
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub port: u16,
    pub refresh_seconds: u64,
    pub roots: BTreeMap<String, Vec<String>>,
    pub disabled_agents: Vec<String>,
    /// #113: unknown keys are collected here instead of hard-failing the whole file.
    /// `deny_unknown_fields` made the control channel depend on a text file: one extra
    /// key written by a newer version (or by hand) turned `status`/`stop`/`scan` into
    /// "config error" while the background process was perfectly alive. The keys are
    /// ignored for behaviour, reported by `unknown_keys()`, and round-tripped on save
    /// so a downgrade-then-upgrade does not silently drop them.
    #[serde(flatten, default)]
    pub unknown: serde_json::Map<String, serde_json::Value>,
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
            // #87：桌面版让位。旧版 Node 后台的默认端口是 8787（src/config.js::DEFAULT_PORT），
            // 两个产品同仓共存时抢同一个回环端口，谁先起谁赢，输的那个此前毫无提示。
            // 改默认值只影响新写入的 settings.json；老用户目录里的 8787 由
            // crate::coexistence 在后台启动时探测并在 service.log 与 status 里报出来。
            // 与 src/coexistence.js::DESKTOP_DEFAULT_PORT 必须一致（test/run.mjs [26] 会比对）。
            port: crate::coexistence::DESKTOP_DEFAULT_PORT,
            refresh_seconds: 60,
            roots,
            disabled_agents: vec![],
            unknown: Default::default(),
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
    let path = root.join("settings.json");
    // #113: every failure here must say *which* file and *which* field, otherwise
    // the user gets "config error" with nothing to act on.
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut s: Settings = serde_json::from_str(&text)
        .map_err(|e| format!("{}: {e}{}", path.display(), top_level_types(&text)))?;
    // Older settings predate these adapters. Preserve explicitly empty roots and
    // disabled agents; only absent source keys receive the new defaults.
    let defaults = Settings::default();
    for agent in ["qoder", "xiaomi-mimo"] {
        s.roots.entry(agent.into()).or_insert_with(|| defaults.roots[agent].clone());
    }
    s.validate()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(s)
}

/// #113: serde 的原文只给「invalid type: string "8787", expected u16 at line 1
/// column 14」——不点名是哪个字段。手工编辑或降级场景里用户要的恰恰是那一个名字，
/// 所以失败时把顶层键与实际 JSON 类型一并列出（`；当前顶层键：port=字符串`）。
/// 只在失败路径上多解析一次，正常路径零成本。
fn top_level_types(text: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return String::new();
    };
    let Some(map) = value.as_object() else {
        return "；当前顶层不是 JSON 对象".to_string();
    };
    let kind = |v: &serde_json::Value| match v {
        serde_json::Value::Null => "空",
        serde_json::Value::Bool(_) => "布尔",
        serde_json::Value::Number(_) => "数字",
        serde_json::Value::String(_) => "字符串",
        serde_json::Value::Array(_) => "数组",
        serde_json::Value::Object(_) => "对象",
    };
    let known = ["port", "refreshSeconds", "roots", "disabledAgents"];
    let parts: Vec<String> = map
        .iter()
        .map(|(k, v)| {
            let tag = if known.contains(&k.as_str()) { "" } else { "(未识别)" };
            format!("{k}{tag}={}", kind(v))
        })
        .collect();
    if parts.is_empty() {
        return String::new();
    }
    format!("；当前顶层键：{}", parts.join(", "))
}

/// #113: keys in `settings.json` that this version does not know about.
/// They are ignored for behaviour on purpose (see `Settings::unknown`); the
/// point of listing them is that a downgrade is *visible* instead of fatal.
pub fn unknown_keys(settings: &Settings) -> Vec<String> {
    let mut keys: Vec<String> = settings.unknown.keys().cloned().collect();
    keys.sort();
    keys
}
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests_unknown_keys {
    use super::*;
    use std::collections::BTreeMap;

    fn root_with(text: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("tm-cfg-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("settings.json"), text).unwrap();
        root
    }

    /// #113：一个未知键不得让整份配置作废（修前 `deny_unknown_fields` 直接 Err，
    /// 于是 bootstrap 卡死、正在跑的后台 status/stop/scan 全部报「配置错误」）。
    #[test]
    fn unknown_keys_are_ignored_listed_and_round_tripped() {
        let root = root_with(
            r#"{"port":9999,"refreshSeconds":60,"roots":{"qoder":[],"xiaomi-mimo":[]},"disabledAgents":[],"themeMode":"dark","nested":{"a":1}}"#,
        );
        let s = settings(&root).expect("含未知键的 settings.json 必须仍能加载");
        assert_eq!(s.port, 9999);
        assert_eq!(unknown_keys(&s), vec!["nested".to_string(), "themeMode".to_string()]);
        // 保存一次：未知键必须原样带回（降级→升级不丢用户写的字段）
        save_json(&root.join("settings.json"), &s).unwrap();
        let again = settings(&root).unwrap();
        assert_eq!(unknown_keys(&again), vec!["nested".to_string(), "themeMode".to_string()]);
        assert_eq!(again.port, 9999);
        assert_eq!(
            again.unknown["themeMode"],
            serde_json::Value::String("dark".into())
        );
        fs::remove_dir_all(&root).ok();
    }

    /// #113：错误信息必须点名是哪个文件——修前只有一句 serde 的原文，
    /// 用户面对两个数据根（便携/源码）时无法知道改哪个文件。
    #[test]
    fn errors_name_the_file_and_the_field() {
        let root = root_with(r#"{"port":"8787","refreshSeconds":60,"roots":{"qoder":[],"xiaomi-mimo":[]},"disabledAgents":[]}"#);
        let err = settings(&root).unwrap_err();
        assert!(err.contains("settings.json"), "{err}");
        assert!(err.contains(&root.display().to_string()), "错误里必须有完整路径：{err}");
        assert!(
            err.contains("port=字符串"),
            "错误里必须点名是哪个字段、它实际是什么类型：{err}"
        );
        fs::remove_dir_all(&root).ok();
    }

    /// 类型正确但值非法（端口 0）也必须带上文件名——validate 的原文没有路径。
    #[test]
    fn validation_errors_also_carry_the_path() {
        let root = root_with(
            r#"{"port":0,"refreshSeconds":60,"roots":{"codex":["D:/x"]},"disabledAgents":[]}"#,
        );
        let err = settings(&root).unwrap_err();
        assert!(err.contains(&root.join("settings.json").display().to_string()), "{err}");
        assert!(err.contains("端口"), "{err}");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn default_settings_have_no_unknown_keys() {
        assert!(unknown_keys(&Settings::default()).is_empty());
        let mut s = Settings::default();
        s.roots = BTreeMap::new();
        assert!(unknown_keys(&s).is_empty());
    }
}
