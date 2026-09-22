# TokenMonitor Windows 故障排查手册

适用平台：Windows 10/11 x64。配套的安装与日常运维说明见 [WINDOWS.md](./WINDOWS.md)。本文只描述当前已验证的行为；尚未实现的功能标注 **Pending**。

## 0. 第一步：三条诊断命令

```powershell
cd <仓库目录>
node bin\tokenmonitor.js status      # 后台在线/离线、端口、数据目录、数据库在否、离线模式
Get-Content "<日志路径见下表>\tokenmonitor.log" -Tail 50 -ErrorAction SilentlyContinue
schtasks /Query /TN "TokenMonitor-Server" /V /FO LIST   # 核对自启任务（装了自启才有）
```

日志固定名为 `tokenmonitor.log`，位置随运行形态而变（与 [#23 的三级数据目录解析](../src/config.js) 一致）：

| 运行形态 | 日志目录 |
|---|---|
| 打包/安装（应用根存在 `manifest.json`） | `<应用根>\data\logs` |
| 源码运行（Windows，#89 起） | `%LOCALAPPDATA%\TokenMonitor-Server\logs` |
| 源码运行（Windows，#89 前有历史日志的老机器） | `%LOCALAPPDATA%\TokenMonitor\logs` |
| 设了 `TOKENMONITOR_DATA_DIR` | `%TOKENMONITOR_DATA_DIR%\logs` |
| 非 Windows 或缺 `LOCALAPPDATA` 的源码运行 | `~\.tokenmonitor\logs` |

- `status` 输出的 `data_dir` 是**数据库**目录。打包与强制形态下它与日志同根，可直接拼 `\logs\tokenmonitor.log`；**源码形态下数据库在 `~\.tokenmonitor` 而日志在 `%LOCALAPPDATA%\TokenMonitor-Server`（#89 前的老机器仍在 `%LOCALAPPDATA%\TokenMonitor`），两者不同根**——直接拼会找错目录，请按上表取，或以 `status` 输出的 `run_dir` 行为准。
- 只有真正执行动作的命令才写日志（`scan`/`serve`/`today`/`install-agent`/`uninstall-agent`/`bar`）；`--help`/`--version`/`status` 是零副作用的只读诊断，不会创建日志目录。因此刚装好就看到日志不存在，通常只是还没跑过后台。
- 日志按 5 MiB 轮转，最多留 5 份备份（`tokenmonitor.log.1` … `.5`）。
- 日志中的敏感信息统一显示为 `[REDACTED]`，这是**预期行为**，不是日志损坏（见第 8 节）。
- 所有排查命令都**不要求、也不要**关闭所有 node.exe；需要结束进程时，先按第 1 节确认 PID 归属。

## 1. 端口被占用（serve 启动失败 / status 显示 offline）

**现象**：`serve` 报端口冲突；日志出现 `port conflict on 127.0.0.1:<端口>` 及占用进程描述（🟡 #11 评审通过待集成，诊断能力已在 main）。

**诊断**（把 8787 换成实际端口）：

```powershell
netstat -ano | Select-String ":8787\s+.*LISTENING"
tasklist /FI "PID eq <上一步的PID>"
```

**处置**：

- 首选换端口：`node bin\tokenmonitor.js serve --port 9001`（自启用户改用 `install-agent --port 9001` 重新注册）。
- 只有在确认占用者是**本产品的实例**时才结束它：先用 `Get-CimInstance Win32_Process -Filter "ProcessId=<PID>" | Select-Object CommandLine` 核对命令行里是否有 `tokenmonitor`/`serve --port` 字样，确认后再 `Stop-Process -Id <PID>`。
- 系统绝不自动抢占端口，也绝不误杀无关 node.exe（单实例锁按数据目录+端口作用域，重复启动返回 `already_running`，见 [../src/platform/runtime.js](../src/platform/runtime.js)；测试 [../test/windows/runtime.test.mjs](../test/windows/runtime.test.mjs)）。

## 2. 任务计划安装 / 自启失败（✅ #8 能力，故障定位）

**现象**：`install-agent` 退出码 1，stderr 带有 schtasks 原始错误（工具会把详细原因原样透出，不吞错）。

**排查顺序**：

```powershell
schtasks /Query /TN "TokenMonitor-Server" /V /FO LIST   # 任务是否存在、上次运行结果
node bin\tokenmonitor.js install-agent                   # 同一条命令：直接覆盖更新
node bin\tokenmonitor.js install-agent --force           # 冲突的另一条命令：确认替换它
```

- **任务已存在且就是本命令**（同 node 路径、同脚本、同端口）：直接重跑 `install-agent` 即为覆盖更新，不需要 `--force`。
- **任务已存在但指向另一条命令**（换了 node、换了安装目录、改了端口，或同名任务被别的东西占用）：`install-agent` 会拒绝并打印"已注册的是哪条、这次要写的是哪条"，此时才用 `--force` 明确替换。`--force` 不再是一个不起作用的标志（#96 第 10 条）。
- **`install-agent` 报"任务定义看起来包含密钥"**：这是安装路径自检（#96 第 5 条）。它只认凭据的**形状**（`secret=…`、`sk-…`、`Bearer …`），目录名叫 `secretpad`/`Authorization` 不会触发；真触发时错误消息点名命中的形状但不回显值，把安装目录换到别处即可。
- **node 路径变化**（升级/移动 Node 安装位置后）：重新执行 `install-agent`，动作里的 node 绝对路径会更新。
- **登录未触发**：任务为当前用户登录触发（LogonTrigger），注销重登或 `schtasks /Run /TN "TokenMonitor-Server"` 手动启动验证。
- 卸载时提示任务不存在属正常（幂等卸载，见 [../src/platform/windows-service.js](../src/platform/windows-service.js)；测试 [../test/windows/service.test.mjs](../test/windows/service.test.mjs)）。

## 3. 托盘不在线 / 托盘 EXE 缺失

- Windows 系统托盘**已实现**（✅ #9 `b534213`；#32 起为**原生 Rust Win32 自包含单文件**，零 .NET 依赖）。`bar` 会查找托盘 EXE 并以 `--port` 拉起；托盘 EXE 属构建产物，源码目录未构建时会得到含 `tray` 与面板地址的明确提示——这不是故障，构建托盘（`powershell -NoProfile -ExecutionPolicy Bypass -File windows\tray\build.ps1`，输出固定到 `windows\tray\publish\TokenMonitorTray.exe`，需要仓库 `rust-toolchain.toml` 固定的 Rust 工具链）或直接用浏览器打开面板均可。
  **旧文档写的 `dotnet publish windows\tray\TokenMonitorTray.csproj` 已失效**：`.csproj` 与 `Program.cs` 随 #32 的 Rust 重写一并删除，照抄只会得到 MSBUILD 找不到工程的错误（`test/windows/tray.test.mjs` 有断言守住".NET 工程不得复活"）。
- 托盘单实例互斥，重复执行 `bar` 不会开出第二个托盘；托盘显示离线时先 `status` 确认后台，再 `serve` 启动或用托盘菜单「启动或重启后台」；浏览器访问 `http://127.0.0.1:<端口>`。

## 4. SQLite 数据库被占用 / 来源错误提示 SQLITE_BUSY

**现象**：某来源一轮扫描被跳过并记录来源级错误，日志出现 busy/locked 字样。

**行为与处置**：

- ZCode/OpenCode 等SQLite 来源一律**只读**打开，不会写入或复制用户数据库；瞬时 `SQLITE_BUSY`（客户端正在写 WAL）只跳过当轮，**下一轮自动恢复**，常驻进程不退出（✅ #5；代码 [../src/collectors/zcode.js](../src/collectors/zcode.js)、[../src/collectors/opencode.js](../src/collectors/opencode.js)；测试 [../test/windows/sqlite-sources.test.mjs](../test/windows/sqlite-sources.test.mjs)）。
- **无需关闭任何 AI 客户端**。若同一来源连续多轮报错，重启 `serve` 后复扫一次；仍失败再按日志中的来源名反馈。

## 5. dsh 来源解析失败 / zstd 相关错误

- dsh 会话的 zstd 解压使用内置纯 JS 实现（fzstd）**多帧解码**，不依赖外部 `zstd` 命令；未安装 zstd 不是问题（✅ #6；代码 [../src/collectors/dsh.js](../src/collectors/dsh.js)；测试 [../test/windows/dsh.test.mjs](../test/windows/dsh.test.mjs)）。
- 若日志记录 dsh 来源级错误：确认来源目录未被杀毒软件锁定，然后重扫；其余情况附日志反馈。

## 6. 面板空白 / ECharts 404

**现象**：面板打开后空白，开发者工具看到 `/vendor/echarts.min.js` 404 或 `echarts is not defined`。

**原因与处置**：依赖未安装（图表库由 Node 的解析算法定位 echarts 包，见 [../src/config.js](../src/config.js)）。在仓库目录执行：

```powershell
npm ci        # 或 npm install
```

然后刷新页面；无需重启后台（静态资源按请求读取）。

## 7. 权限类错误

- 安装自启、扫描、面板均为**普通用户权限**操作，不要用管理员身份运行任务计划（LeastPrivilege 设计）。
- `EPERM`：单实例锁探测 PID 时，`EPERM` 表示进程仍在（权限不足以发信号），按“已在运行”处理而非误判为死进程（[../src/platform/runtime.js](../src/platform/runtime.js)）。
- 数据库/日志目录位于用户目录（`%USERPROFILE%\.tokenmonitor`、`%LOCALAPPDATA%\TokenMonitor-Server`），不需要对仓库目录或系统目录写权限；若被重定向到受保护目录，检查 `LOCALAPPDATA`/`USERPROFILE` 环境变量。

## 8. 日志里出现 [REDACTED]

预期脱敏行为（🟡 #11 评审通过待集成，[../src/platform/runtime.js](../src/platform/runtime.js) `sanitizeLogMessage`）：`Authorization`/`Bearer` 头、`sk-ant-`/`sk-`/`key-` API Key、`token`/`auth_token`/`access_token` 字段及会话正文片段统一替换为 `[REDACTED]`。日志位置由运行形态决定（见上表；源码运行 #89 起在 `%LOCALAPPDATA%\TokenMonitor-Server\logs\`），单文件 5 MiB、最多 5 个备份轮转，不会无限增长。日志位置本身没有可配置项；如需完整排障，请携带**已脱敏**的日志片段反馈。

## 9. 已知遗留问题（非阻断）

- 离线模式（`TOKENMONITOR_OFFLINE=1`）下运行全量 `npm test`，其中两项熔断（circuit breaker）断言存在**环境性假红**；在线运行 `npm test` 全部通过（2026-09-17 实测 exit 0）。该项已登记为 #14 的后继改进，不影响 `scan`/`serve` 功能。
- 离线专项测试（`test/windows/*.test.mjs`、`ci-smoke.mjs`）不受此影响，2026-09-17 实测全部 exit 0。
