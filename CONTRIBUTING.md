# 贡献指南

TokenMonitor 只维护 `desktop/` 桌面产品。Node.js 仅用于前端构建与测试；旧 Node 服务、Web 面板、CLI 和 Win32 启动器已经退役。

## 新增采集来源

先核对本地记录是否提供真实用量字段，明确输入、缓存、输出和推理的口径，不以猜测补齐缺失值。在 `desktop/src-tauri/src/collectors.rs` 实现纯解析逻辑，在 `config.rs` 注册默认路径，在 `scanner.rs` 接入格式发现；界面来源清单和语言包同步更新。为新来源添加合成、脱敏的 Rust fixture，验证去重、增量、归档、损坏记录和 Windows 中文/空格路径。

## 验证

```powershell
npm ci --prefix desktop
npm run build --prefix desktop
npm test --prefix desktop
cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml
pwsh -File scripts/build-windows.ps1
pwsh -File desktop/scripts/verify-package.ps1
node desktop/scripts/service-smoke.mjs
pwsh -File desktop/scripts/installer-smoke.ps1
pwsh -File desktop/scripts/desktop-smoke.ps1
```

安装、注册表和进程回归必须使用临时目录、独立测试键和合成数据。不得访问真实会话内容作为测试 fixture。构建固定覆盖 `dist/desktop-windows-x64`，不得创建无限版本目录。保留 MIT 与参考项目许可。
