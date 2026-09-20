# TokenMonitor Desktop 2

Windows 桌面版，本地读取 Agent 日志并统计用量。完整界面位于应用窗口内，运行不需要 Node，也不请求在线价格、账户额度或更新服务。

## 使用

解压后运行 `TokenMonitor.exe`。需要 Windows 已安装的 Microsoft Edge WebView2 Runtime；本包不捆绑或自动下载运行时。首次启动会从本地日志建立缓存，大量历史日志可能需要一段时间。

- 左侧选择综合总览或任意单独 Agent，查看会话、模型、项目、按日/按月、逐条用量和工具活动。
- 查询区使用本机时间，精确到分钟，范围为 `[开始, 结束)`。5h/7d 快捷项截至点击时最近的整分钟，排除尚未结束的这一分钟；再次点击刷新窗口。
- 顶部全局按钮启动、停止和重启后台，切换页面后仍可操作；“日志”查看运行日志；停止采集后仍可查看已经缓存的数据。关闭窗口进入托盘；托盘的“退出应用并停止后台”退出所有本应用进程。
- “设置”可选择浅色、深色、跟随系统，修改端口、扫描周期、各 Agent 本地路径和登录自启。端口只绑定本机回环地址。
- 使用 Ctrl＋加号/减号缩放应用文字和界面，Ctrl＋0 恢复原比例；不改变 Windows 全局显示设置。
- 模型价格在设置页面以 JSON 编辑，也可在退出应用后直接编辑用户数据目录中的 `prices.json`。每个模型支持基础价格和带时区的 `effectiveFrom` 历史价格；`aliases` 对应日志中的准确模型名称。没有价格的模型显示“未定价”，不会视为免费。
- “设置 → 币种与汇率”选择统一 USD/CNY 显示并填写手动汇率（1 USD 对应多少 CNY）；页面和导出同时换算。价格 JSON 每条记录支持 currency: "USD" 或 "CNY"（不区分大小写），省略时继承顶层 currency；价格数字仍为原币种每百万 Tokens。涉及人民币时必须提供 usdCny，汇率不联网更新。
- 内置价格是明确标注来源日期的离线参考快照，不能代表最新官方价，也不含服务等级或长上下文附加费。应按实际计费合同调整 JSON。
- CSV、Markdown、Excel 导出使用当前查询范围与筛选。费用是按本地价格表计算的估算值，不是账户账单。
- Codex 详情上方显示所选范围用量，下方完整会话回放保留范围外上下文；本地额度是日志观测值，显示观测时间，不伪装为实时额度。没有兑换额度操作。

默认配置、缓存、日志、WebView 数据保存在 `%LOCALAPPDATA%\TokenMonitor2`，与发布目录分离。设置中的路径字段可配置额外本地目录，包括 Codex 归档目录。原日志均以只读方式读取。工具或日志没有提供的字段不会凭空推算。

## 构建

在 `desktop/` 安装构建依赖后，从仓库根目录执行：

```powershell
pwsh -File desktop/scripts/build-windows.ps1
```

需要 Node、Rust 和 Windows C++ 构建工具；这些只用于构建。脚本离线使用已经安装的依赖，固定覆盖 `dist/desktop-windows-x64` 和 `dist/TokenMonitor-desktop-windows-x64.zip`。这两个位置专用于新架构的发布物，旧版 `dist/windows-x64/data` 保留。压缩包严格使用文件清单，不收录缓存、数据库、日志、凭据或 Node。

```powershell
cd desktop
npm test
cd src-tauri
cargo test --offline --no-default-features
```

参考项目移植代码的许可见 `LICENSE.codex-usage-desktop`，分发依赖许可汇总见发布包中的 `THIRD-PARTY-NOTICES.txt`。
