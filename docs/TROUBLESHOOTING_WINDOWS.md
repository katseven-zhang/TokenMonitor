# Windows 排障

当前应用、安装、数据根与升级策略见 [Windows 说明](WINDOWS.md)。

- 无法打开窗口：检查系统 WebView2 Runtime，查看用户数据根的 service.log。
- 端口占用：退出其他旧实例，或在设置中选择可用端口；不自动终止其他进程。
- 安装提示 .new/.old：保留目录并先检查其中的数据，不直接删除恢复副本。
- 默认根为 TokenMonitor；已有 TokenMonitor2 数据时按兼容规则继续使用，界面可查看实际数据目录。

旧 Node/Win32 排障文档已归档至 [legacy](legacy/TROUBLESHOOTING_WINDOWS.md)，其中命令不再适用。
