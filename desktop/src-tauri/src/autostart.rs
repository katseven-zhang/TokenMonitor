//! Current-user Windows startup. Keep existing product entries compatible.
#[cfg(windows)]
pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
pub fn command(executable: &std::path::Path) -> String {
    format!("\"{}\" --background", executable.display())
}
#[cfg(windows)]
fn approval_key(key: &str) -> String {
    if key == RUN_KEY { r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run".into() }
    else { format!(r"{key}\StartupApproved") }
}
#[cfg(windows)]
fn owns(value: &str, executable: &std::path::Path) -> bool {
    value == command(executable) || value == format!("{} --background", executable.display())
}
#[cfg(windows)]
pub fn enabled(key: &str, executable: &std::path::Path) -> Result<bool, String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let user=RegKey::predef(HKEY_CURRENT_USER);
    let run=match user.open_subkey(key) {
        Ok(run)=>run,
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(false),
        Err(e)=>return Err(e.to_string()),
    };
    for name in ["TokenMonitor","tokenmonitor-desktop"] {
        if let Ok(value)=run.get_value::<String,_>(name) {
            if !owns(&value,executable) { continue; }
            if let Ok(approved)=user.open_subkey(approval_key(key)) {
                if let Ok(value)=approved.get_raw_value(name) {
                    if value.bytes.len()>=8 && value.bytes.iter().rev().take(8).any(|v|*v!=0) { continue; }
                }
            }
            return Ok(true);
        }
    }
    Ok(false)
}
#[cfg(windows)]
pub fn set(path: &str, executable: &std::path::Path, enable: bool) -> Result<(), String> {
    use winreg::{enums::{HKEY_CURRENT_USER,RegType::REG_BINARY}, RegKey, RegValue};
    let user=RegKey::predef(HKEY_CURRENT_USER);
    let (key, _)=user.create_subkey(path).map_err(|e|e.to_string())?;
    // Remove only entries belonging to this executable, never another install.
    for name in ["TokenMonitor","tokenmonitor-desktop"] {
        if let Ok(value)=key.get_value::<String,_>(name) {
            if owns(&value,executable) { key.delete_value(name).map_err(|e|e.to_string())?; }
        }
    }
    if enable {
        key.set_value("TokenMonitor", &command(executable)).map_err(|e|e.to_string())?;
        let (approved,_)=user.create_subkey(approval_key(path)).map_err(|e|e.to_string())?;
        approved.set_raw_value("TokenMonitor", &RegValue { vtype: REG_BINARY, bytes: vec![2,0,0,0,0,0,0,0,0,0,0,0] }).map_err(|e|e.to_string())?;
    }
    Ok(())
}
