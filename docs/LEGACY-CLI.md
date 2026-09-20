# 旧版 Node CLI

本文件只适用于仓库保留的 Node CLI 和 macOS 菜单栏实现；主产品 Windows 桌面版请使用根 README 的构建与运行流程。

安装旧版 Node 包后，通过 CLI 子命令操作，不要使用仅源码检出可用的 npm scripts：

```sh
tokenmonitor --help
tokenmonitor install-agent
tokenmonitor uninstall-agent
tokenmonitor bar
```

`install-agent` / `uninstall-agent` 管理旧版后台代理，`bar` 启动旧版 macOS 菜单栏。它们不是新 Tauri 桌面版的后台、托盘或登录自启入口。
