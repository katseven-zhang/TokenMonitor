use std::fs;
use tokenmonitor_core::config;
#[test]
fn canonical_root_preserves_existing_desktop_and_node_data() {
    let root = std::env::temp_dir().join(format!("tm-data-root-{}", uuid::Uuid::new_v4()));
    let current = root.join("TokenMonitor");
    let previous = root.join("TokenMonitor2");
    fs::create_dir_all(&current).unwrap();
    fs::write(current.join("tokenmonitor.db"), b"legacy-sentinel").unwrap();
    assert_eq!(config::default_data_dir(&root), current);
    fs::create_dir_all(&previous).unwrap();
    fs::write(previous.join("settings.json"), b"existing-settings").unwrap();
    assert_eq!(config::default_data_dir(&root), previous);
    fs::write(current.join("settings.json"), b"canonical-settings").unwrap();
    assert_eq!(config::default_data_dir(&root), current);
    assert_eq!(fs::read(current.join("tokenmonitor.db")).unwrap(), b"legacy-sentinel");
    assert_eq!(fs::read(previous.join("settings.json")).unwrap(), b"existing-settings");
    fs::remove_dir_all(root).unwrap();
}
