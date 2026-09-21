# 旧版 Node CLI

本文件只适用于仓库保留的 Node CLI 和 macOS 菜单栏实现；主产品 Windows 桌面版请使用根 README 的构建与运行流程。

## macOS 菜单栏胶囊的打包定位（#91 第 7 项决策记录）

- 它是**有意保留的 legacy 实现**，不是被遗忘的旁支：`bin/tokenmonitor.app/` 仍在根 `package.json` 的 `files` 白名单里，
  所以 **`npm pack` 出来的 tarball 会带上这个 macOS-only 目录**（约 340KB），Windows/Linux 使用者拿到也不会用到。
- `prepack` 负责构建它，且在非 macOS 上**安全跳过**：非 macOS 机器上 `npm pack` 不会失败，只是把检出里已有的 `bin/tokenmonitor.app/` 原样打进包。
- 三处联动，改任何一处都要同时看另外两处：`package.json` 的 `files` 白名单、`prepack` 脚本（`scripts/` 下）、以及 `test/run.mjs` 的 `[10]` 层打包面断言。
- 本次经仓库所有者确认**按"保留"处理**，故此处记录事实与联动点，不删除；若日后改判为 legacy 移除，删的顺序是 `files` 条目 → `prepack`/`build-bar` → `run.mjs [10]` 断言。

安装旧版 Node 包后，通过 CLI 子命令操作，不要使用仅源码检出可用的 npm scripts：

```sh
tokenmonitor --help
tokenmonitor install-agent
tokenmonitor uninstall-agent
tokenmonitor bar
```

`install-agent` / `uninstall-agent` 管理旧版后台代理，`bar` 启动旧版 macOS 菜单栏。它们不是新 Tauri 桌面版的后台、托盘或登录自启入口。
