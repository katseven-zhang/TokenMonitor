# TokenMonitor Windows 安装器设计说明

对应任务 #13 [Win-Installer]。实现脚本是 `scripts/install-windows.ps1` 与 `scripts/uninstall-windows.ps1`；专属离线测试在 `test/windows/installer.test.mjs`。

## 固定布局（普通用户权限，全程不需要管理员）

| 位置 | 用途 |
| --- | --- |
| `%LOCALAPPDATA%\Programs\TokenMonitor` | 程序本体（dist\windows-x64 运行包的拷贝） |
| `%LOCALAPPDATA%\TokenMonitor` | 项目数据目录（SQLite 数据库、pricing、配置、logs） |
| `%APPDATA%\Microsoft\Windows\Start Menu\Programs\TokenMonitor.lnk` | 开始菜单快捷方式（总是创建） |
| `<桌面>\TokenMonitor.lnk` | 可选桌面快捷方式（`-DesktopShortcut` 时创建） |
| 任务计划 `TokenMonitor-Server` | 由 `token-watcher install-agent`（任务 #8）管理；卸载器按名精确删除 |

## 安装 / 覆盖升级

1. 校验候选包（默认 `dist\windows-x64`）：必须含 `node.exe`、`bin\tokenwatcher.js`、`package.json`，且 `--version` 可执行。
2. 候选先复制到 `<安装目录>.new` 暂存并在最终布局下再次验证。
3. 覆盖升级：旧目录改名 `TokenMonitor.old` 保留 → 暂存目录转正 → 转正后再跑一次 `--version` 验证 → 验证通过才删除 `.old`；验证失败自动把 `.old` 改名回滚，机器上始终保留一个可用版本。
4. 数据目录只创建、不删除；升级天然保留数据库与用户配置。

## 卸载与数据安全

- 卸载只删除三样东西：精确的安装目录、`TokenMonitor.lnk` 快捷方式（开始菜单+桌面）、名为 `TokenMonitor-Server` 的任务计划。
- 用户数据默认**保留**，并打印其位置。
- `-PurgeData` 需要二次确认（`-ConfirmPurge` 或交互输入 `DELETE`）。
- 删除前守卫：路径先 `Resolve-Path`，叶名必须恰好是 `TokenMonitor`；`-InstallRoot`/`-DataRoot` 不得是盘符根；绝不对未解析或宽泛路径做递归删除。

## 临时根目录 dry-run

所有根目录都可以覆盖，测试据此在 `%TEMP%` 下（含空格/中文路径）做全自动安装→升级→回滚→卸载→purge 演练，不触碰真实用户目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1 `
  -Source <候选包> -InstallRoot <临时>\Programs -DataRoot <临时>\Data `
  -StartMenuRoot <临时>\StartMenu -DesktopRoot <临时>\Desktop
```

测试用 `-SkipScheduledTask` 跳过任务计划步骤，保证 dry-run 完全不触碰真实系统状态。
