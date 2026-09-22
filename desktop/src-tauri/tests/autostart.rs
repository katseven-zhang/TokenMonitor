#![cfg(windows)]
use tokenmonitor_core::autostart;
use winreg::{enums::HKEY_CURRENT_USER, RegKey};
#[test]
fn startup_quotes_unicode_spaces_and_toggles_only_own_value() {
    let path = format!(r"Software\TokenMonitor-Autostart-Test-{}", uuid::Uuid::new_v4());
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = user.create_subkey(&path).unwrap();
    key.set_value("unrelated", &"keep").unwrap();
    let exe = std::path::Path::new(r"C:\Synthetic 用户\Program Files\TokenMonitor.exe");
    assert!(!autostart::enabled(&path, exe).unwrap());
    autostart::set(&path, exe, true).unwrap();
    assert_eq!(key.get_value::<String,_>("TokenMonitor").unwrap(), r#""C:\Synthetic 用户\Program Files\TokenMonitor.exe" --background"#);
    assert!(autostart::enabled(&path, exe).unwrap());
    let approved=user.open_subkey_with_flags(format!(r"{path}\StartupApproved"),winreg::enums::KEY_ALL_ACCESS).unwrap();
    approved.set_raw_value("TokenMonitor", &winreg::RegValue { vtype:winreg::enums::RegType::REG_BINARY, bytes:vec![3,0,0,0,1,0,0,0,0,0,0,0] }).unwrap();
    assert!(!autostart::enabled(&path, exe).unwrap());
    autostart::set(&path, exe, true).unwrap();
    assert!(autostart::enabled(&path, exe).unwrap());
    autostart::set(&path, exe, false).unwrap();
    assert!(!autostart::enabled(&path, exe).unwrap());
    key.set_value("tokenmonitor-desktop", &format!("{} --background",exe.display())).unwrap();
    assert!(autostart::enabled(&path, exe).unwrap());
    autostart::set(&path, exe, true).unwrap();
    assert!(key.get_value::<String,_>("tokenmonitor-desktop").is_err());
    autostart::set(&path, exe, false).unwrap();
    assert_eq!(key.get_value::<String,_>("unrelated").unwrap(), "keep");
    user.delete_subkey_all(&path).unwrap();
}
