# Windows 使用与交付

唯一交付物为 Tauri 桌面应用。`windows/gui` 和 `windows/tray` 退役，托盘、后台服务、单实例与登录自启由 `desktop/` 提供。

## 运行与安装

需要 Windows 10/11 x64 和系统 WebView2 Runtime。直接解压运行 `TokenMonitor.exe`；用户运行程序无需 Node 或 Rust。

需要开始菜单安装时，在 PowerShell 7 执行包内 `install-windows.ps1`；也可在源码根目录执行 `pwsh -File scripts/install-windows.ps1`。默认安装到 `%LOCALAPPDATA%\Programs\TokenMonitor`，可加 `-DesktopShortcut`。脚本先校验白名单与 SHA256，再暂存、探测版本、替换并验证；失败回滚。遇到 `.new` / `.old` 遗留会停止并保留现场，不删除其中数据。

卸载：退出托盘及后台后，执行 `pwsh -File uninstall-windows.ps1`。默认保留所有用户数据和旧版档案，仅移除清单内程序、指向该安装的快捷方式和自启值。自启是当前用户 Run 项，界面“设置”可开关；命令对含空格路径加引号。不再需要常驻 Node 或旧任务计划。

脚本支持 `-InstallRoot`（父目录）、`-StartMenuRoot`、`-DesktopRoot`，仅用于明确指定安装位置或隔离测试。发行包脚本需要 PowerShell 7.2+；直接运行 EXE 不需要 PowerShell。

## 数据与旧版升级

新用户默认数据根为 `%LOCALAPPDATA%\TokenMonitor`，数据库为 `events-v2.sqlite`。`TOKENMONITOR_DATA_DIR` 可显式覆盖。已有桌面数据位于 `TokenMonitor2` 且规范目录未有桌面设置时，继续使用原目录，避免静默丢失设置、价格和历史缓存；不自动搬动正在使用的数据库。

从旧 Node 安装升级时，安装器保留整个旧目录到同级 `TokenMonitor-legacy`，包括 `data`。仅当旧任务计划的全部动作都指向此次旧安装时，导出任务 XML 到档案后移除该任务。数据不转换成新版数据库；新版从本地 Agent 原始记录重建缓存。旧记录已删除而只剩 Node 数据库的历史不会自动导入，请保留档案。重复档案、目录联接或未知文件会使操作停止，不自动覆盖。

现存其他便携包、其他分支、其他 worktree 不自动删除。旧包的 `data` 仍属于用户数据。旧文档在 `docs/legacy/`，仅供历史查阅。

## 打包与验证

`pwsh -File scripts/build-windows.ps1` 转交唯一桌面构建脚本，固定覆盖 `dist/desktop-windows-x64` 和 ZIP。发行包只有 EXE、安装脚本、说明、价格示例、许可证和清单，无 `runtime/node.exe`。目录出现非清单内容时停止，避免将数据带入发行包。

CI 仅保留 `desktop.yml`：前端、Rust、索引分页、桌面构建、包校验、服务、安装/回滚/卸载、隐藏启动/单实例/关闭驻留回归。测试使用临时根与独立注册表键，不修改用户实际数据、自启或任务计划。
