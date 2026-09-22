//! Qoder CN local state format. Never opens authentication stores or logs the
//! SDK format constant, decrypted payloads, or transcript contents.
use crate::{collectors, model::Parsed};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

const SDK: &str = "resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs";
type CachedKey = (PathBuf, u64, SystemTime, [u8; 32]);
static KEY: OnceLock<Mutex<Option<CachedKey>>> = OnceLock::new();

fn runtime_key() -> Result<[u8; 32], String> {
    let mut roots = vec![];
    if let Some(p) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(p).join("Qoder CN"));
    }
    if let Some(p) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(p).join("Programs/Qoder CN"));
    }
    // Only the installed CN SDK. No auth directories, environment-injected key,
    // family-product discovery, or unauthenticated decryption fallback.
    let mut cached = KEY
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Qoder SDK cache unavailable")?;
    for root in roots {
        let path = root.join(SDK);
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if let Some((p, len, time, key)) = cached.as_ref() {
            if *p == path && *len == meta.len() && *time == modified {
                return Ok(*key);
            }
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Some(key) = format_key(&text) else {
            continue;
        };
        *cached = Some((path, meta.len(), modified, key));
        return Ok(key);
    }
    Err("Qoder CN 已安装 SDK 的状态格式不可识别；保留上次数据，等待兼容更新或在标准目录安装 Qoder CN".into())
}

fn format_key(text: &str) -> Option<[u8; 32]> {
    let re = regex::Regex::new(r"nBl\s*=\s*Buffer\.from\(\[([\d,\s]+)\]\)").ok()?;
    let capture = re.captures(text)?;
    let values: Vec<u8> = capture[1]
        .split(',')
        .map(|s| s.trim().parse())
        .collect::<Result<_, _>>()
        .ok()?;
    values.try_into().ok()
}

fn project_hash(cwd: &str) -> Option<String> {
    let normalized = cwd
        .strip_prefix(r"\\?\")
        .unwrap_or(cwd)
        .replace('\\', "/")
        .to_lowercase();
    // The SDK hashes resolved absolute paths. Never resolve a relative source
    // path against TokenMonitor's unrelated working directory.
    if !(normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
            && normalized.as_bytes().get(2) == Some(&b'/'))
    {
        return None;
    }
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "." => {}
            ".." => {
                if parts.len() > 1 {
                    parts.pop();
                }
            }
            _ => parts.push(part),
        }
    }
    while parts.last() == Some(&"") && parts.len() > 1 {
        parts.pop();
    }
    let mut path = parts.join("/");
    if path.len() == 2 && path.ends_with(':') {
        path.push('/');
    }
    if path.is_empty() {
        path.push('/');
    }
    Some(format!("{:x}", Sha256::digest(path.as_bytes())))
}

fn decrypt(
    segment: &Value,
    session: &str,
    cwd: &str,
    segment_key: &str,
    key: &[u8; 32],
) -> Result<Value, String> {
    let decode = |name: &str| {
        STANDARD
            .decode(segment[name].as_str().unwrap_or(""))
            .map_err(|_| "Qoder 状态编码无效".to_string())
    };
    let nonce = decode("n")?;
    let mut data = decode("p")?;
    let tag = decode("t")?;
    if nonce.len() != 12 || tag.len() != 16 {
        return Err("Qoder 状态认证字段无效".into());
    }
    data.extend(tag);
    let project_hash = project_hash(cwd).ok_or("Qoder 状态缺少绝对项目目录")?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Qoder 状态格式无效")?;
    // serde_json::Value maps sort keys; build the specified AAD order explicitly.
    let session = serde_json::to_string(session).map_err(|_| "Qoder session 无效")?;
    let segment_key = serde_json::to_string(segment_key).map_err(|_| "Qoder segment 无效")?;
    for aad in [
        format!(
            r#"{{"sessionId":{session},"projectHash":"{project_hash}","segmentKey":{segment_key}}}"#
        ),
        format!(r#"{{"sessionId":{session},"projectHash":"{project_hash}"}}"#),
    ] {
        if let Ok(bytes) = cipher.decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &data,
                aad: aad.as_bytes(),
            },
        ) {
            return serde_json::from_slice(&bytes).map_err(|_| "Qoder 用量载荷无效".into());
        }
    }
    Err("Qoder 状态认证失败；保留上次数据并重试".into())
}

pub fn read_state(path: &Path) -> Result<Parsed, String> {
    let text = fs::read_to_string(path).map_err(|_| "无法读取 Qoder 状态")?;
    let mut state: Value =
        serde_json::from_str(&text).map_err(|_| "Qoder 状态尚未写完或 JSON 无效")?;
    let Some(session) = state["sessionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
    else {
        if state["version"].is_number() && state["state"].is_object() {
            return Ok(Parsed::default());
        }
        return Err("Qoder 会话状态不完整；保留上次数据并重试".into());
    };
    let mut models = BTreeSet::new();
    let mut cwds = BTreeSet::new();
    if let Some(cwd) = state["cwd"].as_str() {
        cwds.insert(cwd.to_string());
    }
    if let Some(cwd) = state["data"]["cwd"].as_str() {
        cwds.insert(cwd.to_string());
    }
    // Metadata only from the same session's sibling transcript; no family trees.
    if let Some(dir) = path.parent() {
        if let Some(name) = dir.file_name() {
            let transcript = dir.with_file_name(format!("{}.jsonl", name.to_string_lossy()));
            if let Ok(text) = fs::read_to_string(transcript) {
                for line in text.lines() {
                    let Ok(record) = serde_json::from_str::<Value>(line) else {
                        continue;
                    };
                    if record["sessionId"].as_str().is_some_and(|s| s != session) {
                        continue;
                    }
                    if let Some(cwd) = record["cwd"].as_str().filter(|s| !s.is_empty()) {
                        cwds.insert(cwd.to_string());
                    }
                    if let Some(model) = record["message"]["model"]
                        .as_str()
                        .filter(|s| !s.is_empty() && *s != "<synthetic>")
                    {
                        models.insert(model.to_string());
                    }
                }
            }
        }
    }
    if state["items"].is_object() {
        let key = runtime_key()?;
        let segment = &state["items"]["s0"];
        if !segment.is_object() {
            return Err("Qoder 用量 segment 不可识别".into());
        }
        let mut usage = None;
        for cwd in &cwds {
            if let Ok(payload) = decrypt(segment, &session, cwd, "s0", &key) {
                usage = Some((cwd.clone(), payload));
                break;
            }
        }
        let (cwd, payload) = usage.ok_or("Qoder 状态认证失败或缺少项目目录；保留上次数据并重试")?;
        state["cwd"] = json!(cwd);
        state["total"] = payload["total"].clone();
        // Token watermark, rather than a non-usage outer-state modification.
        if !payload["updatedAt"].is_null() {
            state["updatedAt"] = payload["updatedAt"].clone();
        }
    }
    if models.len() == 1 && state["model"].is_null() {
        state["model"] = json!(models.into_iter().next());
    }
    let parsed = collectors::parse_qoder_state(&path.display().to_string(), &state.to_string());
    if parsed.malformed_lines > 0 {
        return Err("Qoder 累计用量或水位无效；保留上次数据并重试".into());
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_format_accepts_both_aads_and_rejects_tampering() {
        let key = [42u8; 32];
        let nonce = [7u8; 12];
        let hash = project_hash(r"D:\项目\a\..\repo\").unwrap();
        assert_eq!(Some(hash.clone()), project_hash("d:/项目/repo"));
        for legacy in [false, true] {
            let aad = if legacy {
                format!(r#"{{"sessionId":"s","projectHash":"{hash}"}}"#)
            } else {
                format!(r#"{{"sessionId":"s","projectHash":"{hash}","segmentKey":"s0"}}"#)
            };
            let bytes = Aes256Gcm::new_from_slice(&key)
                .unwrap()
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: br#"{"total":{"input_tokens":123}}"#,
                        aad: aad.as_bytes(),
                    },
                )
                .unwrap();
            let segment = json!({"n":STANDARD.encode(nonce),"p":STANDARD.encode(&bytes[..bytes.len()-16]),"t":STANDARD.encode(&bytes[bytes.len()-16..])});
            assert_eq!(
                decrypt(&segment, "s", r"D:\项目\repo", "s0", &key).unwrap()["total"]
                    ["input_tokens"],
                123
            );
            assert!(decrypt(&segment, "other", r"D:\项目\repo", "s0", &key).is_err());
            assert!(decrypt(&segment, "s", r"D:\other", "s0", &key).is_err());
            assert!(decrypt(&segment, "s", r"D:\项目\repo", "s0", &[1; 32]).is_err());
        }
        assert!(project_hash("relative/path").is_none());
        assert_eq!(project_hash("D:/"), project_hash(r"\\?\D:\"));
    }
}
