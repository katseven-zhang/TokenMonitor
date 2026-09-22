# TokenMonitor 架构

唯一产品位于 `desktop/`：React 界面通过 Tauri IPC 调用 Rust 查询与生命周期服务；来源读取和 SQLite 事件缓存都在本机。后台由同一个 `TokenMonitor.exe --service` 承担，运行时不需要 Node。

- `collectors.rs` / `scanner.rs`：来源解析、增量和健康状态。
- `db.rs` / `query.rs` / `pricing.rs`：事件去重、查询、离线定价与导出。
- `desktop.rs` / `service.rs` / `main.rs`：托盘、窗口、实例锁、后台生命周期。
- `autostart.rs`：Windows 当前用户自启与路径引号。
- `scripts/`：唯一桌面打包与安装升级卸载链；用户数据不在安装目录内。

Windows 生命周期、默认数据目录与升级保留策略见 [Windows 说明](WINDOWS.md)。旧 Node 架构保存在 [历史档案](legacy/ARCHITECTURE.md)，不再作为实现契约。测试入口见 [贡献指南](../CONTRIBUTING.md)。

## 2.1 本地来源口径

`qoder.rs` 读取 Qoder CN SDK 的发布格式常量，对 `items.s0` 做 AES-256-GCM 验证。AAD 固定顺序为 sessionId、projectHash、segmentKey；兼容旧版省略 segmentKey 的认证 AAD，不尝试无 AAD 解密。projectHash 为绝对 Windows cwd 规范化后的 SHA-256。只读取同会话兄弟转录的 cwd/model 元数据；不读取认证目录或其他 Qoder 家族数据。SDK 元数据变化使内存缓存失效。

Qoder 状态的 input_tokens 已含缓存读。归一化为 input=input_tokens-cache_read，cached=cache_read，cache_write=cache_creation，output=output_tokens。缓存表 `qoder_snapshots` 以 session+timestamp 唯一保存累计水位，按时间生成增量：首次观测为基线，相同水位/多路径副本不相加；迟到的旧水位细分基线；累计重置先更新基线再计后续增长。解密/解析失败不替换已有缓存。初次观察之前的时间分布未知，界面明确提示；reasoning 是 output 子集，不额外加总。

Qoder JSONL 不贡献 token。quota 记录逐请求 credits，request_id 做跨文件去重后再执行起止时间、来源、模型、项目、会话过滤；没有 100 条截断。后端把结果汇总到会话减少 UI 传输量，保留缺失字段为 null。Codex 的账户额度观测保持独立语义。

MiMo 只读查询 message/session/part。input、cache.read、cache.write 互斥，MiMo 原始 output 不含 reasoning，所以统一 output=原始 output+reasoning。message.id 为稳定身份，step-finish 的 tokens 不重复计数；OpenCode 原有口径不变。带正 total 的记录必须满足字段总和。SQLite 使用只读事务快照，每轮读取 WAL，不依赖主 DB 文件的 mtime。
