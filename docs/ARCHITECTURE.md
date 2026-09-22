# TokenMonitor 架构

唯一产品位于 `desktop/`：React 界面通过 Tauri IPC 调用 Rust 查询与生命周期服务；来源读取和 SQLite 事件缓存都在本机。后台由同一个 `TokenMonitor.exe --service` 承担，运行时不需要 Node。

- `collectors.rs` / `scanner.rs`：来源解析、增量和健康状态。
- `db.rs` / `query.rs` / `pricing.rs`：事件去重、查询、离线定价与导出。
- `desktop.rs` / `service.rs` / `main.rs`：托盘、窗口、实例锁、后台生命周期。
- `autostart.rs`：Windows 当前用户自启与路径引号。
- `scripts/`：唯一桌面打包与安装升级卸载链；用户数据不在安装目录内。

Windows 生命周期、默认数据目录与升级保留策略见 [Windows 说明](WINDOWS.md)。旧 Node 架构保存在 [历史档案](legacy/ARCHITECTURE.md)，不再作为实现契约。测试入口见 [贡献指南](../CONTRIBUTING.md)。
