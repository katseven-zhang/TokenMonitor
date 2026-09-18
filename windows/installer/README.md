# TokenMonitor Windows 安装器设计说明

对应任务 #13 [Win-Installer]；布局 v2 由 #25 [Win-Package R2] 重构。实现脚本是 `scripts/install-windows.ps1` 与 `scripts/uninstall-windows.ps1`；专属离线测试在 `test/windows/installer.test.mjs`。

## 固定布局（普通用户权限，全程不需要管理员）

| 位置 | 用途 |
| --- | --- |
| `%LOCALAPPDATA%\Programs\TokenMonitor` | 安装目录。根目录只有 `TokenMonitor.exe`（GUI 启动器）与 `manifest.json`；`node.exe`/`bin\`/`src\`/`web\`/`node_modules\`/`tokenmonitor.cmd` 全部在 `runtime\` 子目录 |
| `<安装目录>\data` | 便携数据目录（SQLite 数据库、pricing、logs、gui-settings.json），随安装目录走，升级/卸载默认保留 |
| `%APPDATA%\Microsoft\Windows\Start Menu\Programs\TokenMonitor.lnk` | 开始菜单快捷方式（总是创建，指向 `TokenMonitor.exe`） |
| `<桌面>\TokenMonitor.lnk` | 可选桌面快捷方式（`-DesktopShortcut` 时创建） |
| 任务计划 `TokenMonitor-Server` | 由 `tokenmonitor install-agent`（任务 #8）管理；卸载器按名精确删除 |

## 安装 / 覆盖升级

1. 校验候选包（默认 `dist\windows-x64`）：必须含 `runtime\node.exe`、`runtime\bin\tokenmonitor.js`、`runtime\package.json`、根目录 `manifest.json` 与 `TokenMonitor.exe`，且 `--version` 可执行。
2. 候选先复制到 `<安装目录>.new` 暂存并在最终布局下再次验证。
3. 覆盖升级：`<安装目录>\data` 先移到 `<InstallRoot>\TokenMonitor-data` 暂存 → 旧目录改名 `TokenMonitor.old` 保留 → 暂存目录转正 → `data` 挪回 → 转正后再跑一次 `--version` 验证 → 验证通过才删除 `.old`；验证失败自动把 `.old` 改名回滚并把 `data` 挪回旧目录，机器上始终保留一个可用版本、数据永不进入删除范围。
4. 数据目录只创建、不删除；升级天然保留数据库、日志与 `gui-settings.json`。

## 卸载与数据安全

- 卸载只删除三样东西：精确的安装目录（其中的 `data` 先移出）、`TokenMonitor.lnk` 快捷方式（开始菜单+桌面）、名为 `TokenMonitor-Server` 的任务计划。
- 用户数据默认**保留**在 `<InstallRoot>\TokenMonitor-data`，并打印其位置。
- `-PurgeData` 需要二次确认（`-ConfirmPurge` 或交互输入 `DELETE`），确认后连 `TokenMonitor-data` 一起删除。
- 删除前守卫：路径先 `Resolve-Path`，叶名必须恰好是 `TokenMonitor` 或 `TokenMonitor-data`；`-InstallRoot` 不得是盘符根；绝不对未解析或宽泛路径做递归删除。

## 临时根目录 dry-run

所有根目录都可以覆盖，测试据此在 `%TEMP%` 下（含空格/中文路径）做全自动安装→升级→回滚→卸载→purge 演练，不触碰真实用户目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1 `
  -Source <候选包> -InstallRoot <临时>\Programs `
  -StartMenuRoot <临时>\StartMenu -DesktopRoot <临时>\Desktop
```

测试用 `-SkipScheduledTask` 跳过任务计划步骤，保证 dry-run 完全不触碰真实系统状态。
