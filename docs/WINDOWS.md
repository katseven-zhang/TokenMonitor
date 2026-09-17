# TokenMonitor Windows 安装与运维手册

适用平台：Windows 10/11 x64。本文只描述**当前已验证**的能力，未实现或尚未通过独立评审的功能一律标注 **Pending** / **待评审**，不把计划写成完成。故障排查见 [TROUBLESHOOTING_WINDOWS.md](./TROUBLESHOOTING_WINDOWS.md)。

- 撰写基线：main 分支，撰写时 HEAD 为 `235cbda`（2026-09-17）。
- 状态图例：✅ 已集成（独立评审通过并集成）｜🟡 待评审（代码已在 main 工作树，Work Report 已提交，等待另一软件身份验收）｜⛔ Pending（未实现，标注对应任务号）。

## 1. 系统要求

- Windows 10/11 x64，普通用户权限即可（安装自启**不需要管理员**）。
- Node.js ≥ 22.13（22.13 与 24 均在 CI 矩阵中验证，见 [../.github/workflows/windows.yml](../.github/workflows/windows.yml)）。`node:sqlite` 为实验特性，启动时出现 `ExperimentalWarning: SQLite` 属正常。
- PowerShell 5.1 及以上（本文示例全部兼容）。任何流程都**不要求关闭所有 node.exe**。

## 2. 从源码运行

```powershell
git clone <仓库地址> TokenMonitor
cd TokenMonitor
npm ci
node bin\tokenwatcher.js scan     # 首次增量扫描历史数据后退出
node bin\tokenwatcher.js serve    # 启动后台与本地面板，默认 http://127.0.0.1:8787
```

路径含空格或中文时，用引号包住完整路径再调用：

```powershell
& "D:\我的工具\Token Monitor\bin\tokenwatcher.js" serve --port 8787
```

通过 `npm install -g` 安装后，`tokenwatcher` / `token-watcher` / `tokenmeter` 三个短命令等价（见 [../package.json](../package.json) 的 `bin` 字段）。

### 可用命令（✅ 已集成，#10）

实现：[../bin/tokenwatcher.js](../bin/tokenwatcher.js)；测试：[../test/windows/cli.test.mjs](../test/windows/cli.test.mjs)。

| 命令 | 行为 |
| --- | --- |
| `scan` | 增量扫描一次后退出，按来源汇总输出 |
| `serve [--port N]` | 扫描 + 本地面板 + 实时监听（默认命令） |
| `today` | 打印今日用量汇总 |
| `status [--port N]` | 报告后台在线/离线、端口、数据目录、数据库在否、离线模式；**不读取会话内容** |
| `install-agent` / `uninstall-agent` | 安装/卸载当前用户任务计划（见第 4 节） |
| `bar` | Windows 上明确报错并提示面板地址（托盘 Pending，见第 5 节） |
| `--help` / `--version` | 不创建数据库 |

- 退出码：`0` 成功或受控关闭（Ctrl+C / SIGTERM / SIGBREAK）；`1` 运行错误；`2` 用法错误（未知命令、非法或缺失 `--port`）。实测：未知命令与 `--port 0` 均返回 2，不静默回退默认端口。
- `status` 实测输出五行：`backend` / `port` / `data_dir` / `db` / `offline_mode`，且在数据库不存在时不创建数据库（`db: absent`）。

## 3. 数据目录与端口

- **数据库**：`%USERPROFILE%\.tokenmeter\tokenmeter.db`（[../src/config.js](../src/config.js)）。旧目录 `%USERPROFILE%\.token-stats` 会在首次运行 `scan`/`serve`/`today` 时自动改名迁移（幂等；仅当新目录不存在时执行，见 [../bin/tokenwatcher.js](../bin/tokenwatcher.js) 的 `migrateLegacyHome`）。
- **运行锁与日志目录（🟡 待评审，#11）**：默认 `%LOCALAPPDATA%\TokenMonitor`（未设置 `LOCALAPPDATA` 时退回 `~/.tokenmeter`）；单实例锁文件为 `tokenmonitor-<端口>.lock`；日志在其 `logs\` 子目录（见第 6 节）。实现：[../src/platform/runtime.js](../src/platform/runtime.js)；测试：[../test/windows/runtime.test.mjs](../test/windows/runtime.test.mjs)。
- **端口**：默认 `8787`；`--port N`（1–65535）对 serve/status/install-agent/bar 均可用，非法值直接报错退出。服务只绑定 `127.0.0.1` 回环并校验 `Host` 头（DNS rebinding 防护，[../src/server.js](../src/server.js)）。
- **离线模式**：设置 `$env:TOKENMETER_OFFLINE='1'` 后，汇率、LiteLLM 牌价表、厂商余额三类外网请求全部跳过，改用本地缓存 / 内置牌价 / 种子价继续出数（[../src/config.js](../src/config.js)）。CI 与 Windows 专项测试默认离线运行。

## 4. 开机自启：当前用户任务计划（✅ 已集成，#8）

实现：[../src/platform/windows-service.js](../src/platform/windows-service.js)、[../src/agent.js](../src/agent.js)；测试：[../test/windows/service.test.mjs](../test/windows/service.test.mjs)。

```powershell
node bin\tokenwatcher.js install-agent               # 默认端口 8787
node bin\tokenwatcher.js install-agent --port 9001   # 指定端口
node bin\tokenwatcher.js uninstall-agent             # 只删除 TokenMonitor-Server 这一条任务
schtasks /Query /TN "TokenMonitor-Server" /V /FO LIST  # 手动核对任务状态
```

- 任务名固定为 `TokenMonitor-Server`，登录触发、`RunLevel=LeastPrivilege`、窗口隐藏、`MultipleInstancesPolicy=IgnoreNew`；动作指向当前 `node.exe` 与入口脚本的真实路径。
- 卸载只删除该任务，不触碰机器上其他任务计划；任务不存在时卸载友好提示而非报错。
- 重复安装是覆盖更新；任务 XML 写入前有敏感串检查，**不包含 Token / API Key**。

## 5. 系统托盘（⛔ Pending，#9）

Windows 系统托盘尚未实现。当前在 Windows 上执行 `bar` 会得到明确报错并给出替代方案，不会静默失败：

```text
Windows tray is not in this CLI yet. Start "token-watcher serve --port 8787" and open http://127.0.0.1:8787
```

替代方式：浏览器打开 `http://127.0.0.1:<端口>`。托盘交付后本节将更新。

## 6. 日志（🟡 待评审，#11）

实现：[../src/platform/runtime.js](../src/platform/runtime.js)（`RuntimeLogger` / `sanitizeLogMessage`）；测试：[../test/windows/runtime.test.mjs](../test/windows/runtime.test.mjs)。

- 位置：`%LOCALAPPDATA%\TokenMonitor\logs\tokenmonitor.log`。
- 自动脱敏：`Authorization`/`Bearer` 头、`sk-ant-`/`sk-`/`key-` 形态 API Key、`token`/`auth_token`/`access_token` 字段，以及会话正文/提示词类内容，统一替换为 `[REDACTED]`。
- 轮转：单文件 5 MiB 上限，最多保留 5 个备份（`tokenmonitor.log.1` … `.5`），无时间戳目录堆积。

## 7. 升级

源码方式升级（数据目录与代码目录无关，升级不触碰数据）：

```powershell
cd <仓库目录>
git pull --ff-only
npm ci
node bin\tokenwatcher.js status    # 确认后台在线；如已停止则重新 serve
```

- 基于安装器的覆盖升级（先验证候选、失败可回滚、保留数据库与配置）：⛔ Pending（#13）。
- 固定目录覆盖式 EXE 构建（`dist/windows-x64`）：⛔ Pending（#12）。

## 8. 卸载与数据备份

```powershell
node bin\tokenwatcher.js uninstall-agent        # 只删除 TokenMonitor-Server 任务
# 移除程序本身：删除源码/安装目录即可
# 用户数据默认保留；确认不再需要后再手动删除：
Remove-Item "$env:USERPROFILE\.tokenmeter" -Recurse -Force
```

备份（建议先停止后台进程，获得一致快照；目标路径含空格/中文同样加引号）：

```powershell
Copy-Item "$env:USERPROFILE\.tokenmeter" "D:\备份路径\tokenmeter-backup" -Recurse -Force
```

## 9. Windows 与 macOS 命令差异

| 事项 | Windows | macOS |
| --- | --- | --- |
| 自启安装/卸载 | 当前用户任务计划 `TokenMonitor-Server`（schtasks，免管理员） | 当前用户 LaunchAgent（launchctl + plist） |
| 核对自启 | `schtasks /Query /TN "TokenMonitor-Server" /V /FO LIST` | `launchctl print gui/$(id -u)/com.tokenmeter.server` |
| `bar` | 明确报错，提示面板地址（托盘 Pending） | 打开菜单栏胶囊 |
| 数据目录 | `%USERPROFILE%\.tokenmeter` | `~/.tokenmeter` |
| 停止后台 | `serve` 窗口 Ctrl+C（SIGBREAK 同样受控关闭） | `launchctl bootout` 或 Ctrl+C |
| 路径引用 | PowerShell 中含空格/中文路径一律加引号 | 多数场景无需引号 |

`serve`、`scan`、`today`、`status`、`--help`、`--version` 在两个平台行为一致。

## 10. 隐私边界

- 面板只监听 `127.0.0.1` 并校验 `Host` 头，本机外部进程与浏览器页面无法跨源读取（[../src/server.js](../src/server.js)）。
- 不上传任何会话数据；`TOKENMETER_OFFLINE=1` 下完全不出网。
- 任务计划 XML 不含秘密；日志自动脱敏（第 6 节）。
- 余额轮询只在配置了对应 API Key 时访问厂商接口，离线模式整体跳过。

## 11. 能力与证据总表

实测环境：Windows x64，Node v24.14.0，2026-09-17；除注明外均为离线（`TOKENMETER_OFFLINE=1`）运行且退出码 0。

| 能力 | 状态 | 任务/commit | 代码 | 测试 |
| --- | --- | --- | --- | --- |
| CLI help/version/status/错误码 | ✅ | #10 `65d0f21` | [../bin/tokenwatcher.js](../bin/tokenwatcher.js) | [cli.test.mjs](../test/windows/cli.test.mjs) |
| 当前用户任务计划自启 | ✅ | #8 `035627c` | [windows-service.js](../src/platform/windows-service.js) | [service.test.mjs](../test/windows/service.test.mjs) |
| 来源注册表与 Windows 根目录发现 | ✅ | #2 `6af9e76` | [../src/source-registry.js](../src/source-registry.js)、[../src/sources/](../src/sources/) | 各来源专项测试 |
| Claude/ccmr/Codex JSONL 兼容 | ✅ | #3 `ce8a39f` | [claude.js](../src/collectors/claude.js) 等 | [jsonl-a.test.mjs](../test/windows/jsonl-a.test.mjs) |
| Grok/WorkBuddy/Pi JSONL 兼容 | ✅ | #4 `65fffdb` | [grok.js](../src/collectors/grok.js) 等 | [jsonl-b.test.mjs](../test/windows/jsonl-b.test.mjs) |
| ZCode/OpenCode SQLite WAL 只读 | ✅ | #5 `9a1d74a` | [zcode.js](../src/collectors/zcode.js)、[opencode.js](../src/collectors/opencode.js) | [sqlite-sources.test.mjs](../test/windows/sqlite-sources.test.mjs) |
| dsh 多帧 zstd（无外部 CLI） | ✅ | #6 `9eb483f`/`d72afcb` | [dsh.js](../src/collectors/dsh.js) | [dsh.test.mjs](../test/windows/dsh.test.mjs) |
| Windows 源码/路径 CI 烟测 | ✅ | #14 `d85f78a` | [windows.yml](../.github/workflows/windows.yml)、[verify-windows-source.ps1](../scripts/verify-windows-source.ps1) | [ci-smoke.mjs](../test/windows/ci-smoke.mjs) |
| 文件监听降级与防抖生命周期 | 🟡 | #7 `e24ad72` | [watch.js](../src/platform/watch.js) | [watch.test.mjs](../test/windows/watch.test.mjs) |
| 单实例锁/日志/端口诊断/受控关闭 | 🟡 | #11 `235cbda` | [runtime.js](../src/platform/runtime.js) | [runtime.test.mjs](../test/windows/runtime.test.mjs) |
| 系统托盘 | ⛔ Pending | #9 | — | — |
| 非管理员安装器（安装/升级/卸载） | ⛔ Pending | #13 | — | — |
| EXE 覆盖式构建 | ⛔ Pending | #12 | — | — |
| 面板来源元数据动态展示 | ⛔ Pending | #16 | — | — |
| 新来源 Antigravity / TRAE / Hermes | ⛔ Pending | #17–#19 | — | — |

### 本次核验命令与退出码

```text
TOKENMETER_OFFLINE=1 node test/windows/cli.test.mjs              exit 0
TOKENMETER_OFFLINE=1 node test/windows/service.test.mjs          exit 0
TOKENMETER_OFFLINE=1 node test/windows/jsonl-a.test.mjs          exit 0
TOKENMETER_OFFLINE=1 node test/windows/jsonl-b.test.mjs          exit 0
TOKENMETER_OFFLINE=1 node test/windows/sqlite-sources.test.mjs   exit 0
TOKENMETER_OFFLINE=1 node test/windows/dsh.test.mjs              exit 0
TOKENMETER_OFFLINE=1 node test/windows/watch.test.mjs            exit 0
TOKENMETER_OFFLINE=1 node test/windows/runtime.test.mjs          exit 0
node test/windows/ci-smoke.mjs                                   exit 0
npm test（在线全量）                                              exit 0，全部通过
node bin/tokenwatcher.js --version / --help / status             exit 0
node bin/tokenwatcher.js <未知命令> / serve --port 0              exit 2
```
