# TokenMonitor Windows 安装与运维手册

适用平台：Windows 10/11 x64。本文只描述**当前已验证**的能力，未实现或尚未通过独立评审的功能一律标注 **Pending** / **待评审**，不把计划写成完成。故障排查见 [TROUBLESHOOTING_WINDOWS.md](./TROUBLESHOOTING_WINDOWS.md)。

- 撰写基线：main 分支，初版 HEAD 为 `235cbda`（2026-09-17），状态刷新时 HEAD 为 `71697ce`（2026-09-18）。
- 状态图例：✅ 已集成（独立评审通过并集成）｜🟡 评审通过、integration 待提交（代码已在 main，Work Report 已提交且独立评审 approved，按"未集成不称交付"规约不标 ✅）｜⛔ Pending（未实现或无本地数据面，标注对应任务号）。

## 1. 系统要求

- Windows 10/11 x64，普通用户权限即可（安装自启**不需要管理员**）。
- Node.js ≥ 22.13（22.13 与 24 均在 CI 矩阵中验证，见 [../.github/workflows/windows.yml](../.github/workflows/windows.yml)）。`node:sqlite` 为实验特性，启动时出现 `ExperimentalWarning: SQLite` 属正常。
- PowerShell 5.1 及以上（本文示例全部兼容）。任何流程都**不要求关闭所有 node.exe**。

## 2. 从源码运行

```powershell
git clone <仓库地址> TokenMonitor
cd TokenMonitor
npm ci
node bin\tokenmonitor.js scan     # 首次增量扫描历史数据后退出
node bin\tokenmonitor.js serve    # 启动后台与本地面板，默认 http://127.0.0.1:8787
```

路径含空格或中文时，用引号包住完整路径再调用：

```powershell
& "D:\我的工具\Token Monitor\bin\tokenmonitor.js" serve --port 8787
```

通过 `npm install -g` 安装后，唯一 CLI 命令为 `tokenmonitor`（见 [../package.json](../package.json) 的 `bin` 字段）。

### 可用命令（✅ 已集成，#10）

实现：[../bin/tokenmonitor.js](../bin/tokenmonitor.js)；测试：[../test/windows/cli.test.mjs](../test/windows/cli.test.mjs)。

| 命令 | 行为 |
| --- | --- |
| `scan` | 增量扫描一次后退出，按来源汇总输出 |
| `serve [--port N]` | 扫描 + 本地面板 + 实时监听（默认命令） |
| `today` | 打印今日用量汇总 |
| `status [--port N]` | 报告后台在线/离线、端口、数据目录、数据库在否、离线模式；**不读取会话内容** |
| `install-agent` / `uninstall-agent` | 安装/卸载当前用户任务计划（见第 4 节） |
| `bar` | 启动 Windows 系统托盘；托盘 EXE 缺失时打印含 `tray` 与面板地址的明确提示（见第 5 节） |
| `--help` / `--version` | 不创建数据库 |

- 退出码：`0` 成功或受控关闭（Ctrl+C / SIGTERM / SIGBREAK）；`1` 运行错误；`2` 用法错误（未知命令、非法或缺失 `--port`）。实测：未知命令与 `--port 0` 均返回 2，不静默回退默认端口。
- `status` 实测输出五行：`backend` / `port` / `data_dir` / `db` / `offline_mode`，且在数据库不存在时不创建数据库（`db: absent`）。

## 3. 数据目录与端口

数据位置按三级优先解析（见 [../src/config.js](../src/config.js) 的 `resolveDataLocations`）：

1. **环境变量 `TOKENMONITOR_DATA_DIR`**：显式指定，数据库、日志、锁、设置全部落到该目录（最高优先，测试/自定义场景用）。
2. **打包/安装形态**：应用根存在 `manifest.json`（构建清单，含 `name: TokenMonitor` 标记）即视为打包形态——数据库、日志、锁、设置统一落在 **`<应用根>\data`**，用户看得见、随目录走（便携式）。
3. **源码运行形态**：数据库 `%USERPROFILE%\.tokenmonitor\tokenmonitor.db`（[../src/config.js](../src/config.js)）；运行数据（日志、锁文件）在 **`%LOCALAPPDATA%\TokenMonitor-Server`**（[../src/platform/runtime.js](../src/platform/runtime.js)）。源码运行与打包运行使用各自的新数据根，不读取、迁移或删除其他命名空间。
   - **#89 改名**：这里过去用 `%LOCALAPPDATA%\TokenMonitor`，而桌面版 NSIS 在 `installMode=currentUser` 下的默认安装目录恰好是 `%LOCALAPPDATA%\<productName>` = **同一路径**（productName 见 `desktop/src-tauri/tauri.conf.json`，Tauri 未提供改安装目录的配置项），卸载桌面版会把旧版的日志和运行锁连根删掉。新装机器直接用上面的新名字；**已经在旧目录里留下过日志（`logs\tokenmonitor*.log`）或任一把 `tokenmonitor-<port>.lock` 的老用户继续用旧目录**——自动搬家会把他们的历史日志变成孤儿，比共用名字更糟。老机器的处置见 3b 节（需要产品裁定）。

- **单实例锁**：`tokenmonitor-<端口>.lock`，位于上述运行数据目录；重复启动返回 `already_running` 与已运行 PID。
- **端口**：默认 `8787`；`--port N`（1–65535）对 serve/status/install-agent/bar 均可用，非法值直接报错退出。服务只绑定 `127.0.0.1` 回环并校验 `Host` 头（DNS rebinding 防护，[../src/server.js](../src/server.js)）。
- **离线模式**：设置 `$env:TOKENMONITOR_OFFLINE='1'` 后，汇率、LiteLLM 牌价表、厂商余额三类外网请求全部跳过，改用本地缓存 / 内置牌价 / 种子价继续出数（[../src/config.js](../src/config.js)）。CI 与 Windows 专项测试默认离线运行。

## 3b. 与桌面版共存（#87）

同一仓库里有**两个产品**：旧版 Node 后台（本文档）与 Rust/Tauri 桌面版（`desktop/`）。
两者此前默认端口都是 `127.0.0.1:8787`，各自还有一套独立的登录自启，且彼此完全看不见对方。

| | 旧版 Node 后台 | 桌面版 |
| --- | --- | --- |
| 默认端口 | `8787`（**不变**：书签、任务计划、托盘、菜单栏都按它写死） | `18787`（#87 起让位；`desktop/src-tauri/src/config.rs`） |
| 数据目录 | `%USERPROFILE%\.tokenmonitor` + 运行数据（见第 3 节、#89） | `%LOCALAPPDATA%\TokenMonitor2` |
| 登录自启 | 任务计划 `TokenMonitor-Server` | tauri-plugin-autostart 写的 `HKCU\...\CurrentVersion\Run` 值 |
| 进程名 | 启动器 `TokenMonitor.exe` + `node.exe`（**与桌面版主程序同名，见 #89**） | `TokenMonitor.exe` |

- **探测是双向的**：旧版侧 [../src/coexistence.js](../src/coexistence.js) 只读地看桌面版装没装
  （`%LOCALAPPDATA%\TokenMonitor2\settings.json`）、配在哪个端口、那个端口有没有人监听，
  以及两套自启各自的注册状态；桌面版侧
  [../desktop/src-tauri/src/coexistence.rs](../desktop/src-tauri/src/coexistence.rs) 反向认旧版的
  运行锁与端口。探测**只读**：不建目录、不写文件、不创建/修改/删除任务计划、绝不终止对方进程。
- `tokenmonitor status` 现在多出这几行：`desktop_edition`、`desktop_port`、`desktop_running`、
  `legacy_logon_task` / `desktop_logon_entry`，以及 #89 的 `run_dir` 与 `price_tables`。
- **旧版端口冲突不再是静默的**（这是 #87 里最坏的一条路径）：修前 `bin/tokenmonitor.js` 里
  `installDaemonGuards()` 的 `unhandledRejection` 兜底会把 `startServer()` 抛出的
  `EADDRINUSE` 拒绝当普通日志吞掉，于是 `await` 之后的运行锁代码永不执行，而已经启动的
  `fs.watch` 监听和每 30 分钟一次的余额轮询继续把事件循环钉住——抢端口输掉的旧版实例变成
  一个**静默僵尸**：没有 HTTP、没有锁文件、却在持续扫描并持续打余额接口，安装/卸载脚本的
  运行守卫因为看不到锁而一路放行。桌面版输的时候只把错误写进 `service.log`。
  现在旧版先监听、监听成功之后才开始盯目录；冲突时打印占用者的 PID 与镜像名、给出两侧
  安装路径（`TokenMonitor.exe` 两边都有，不能据此指认），并以退出码 1 结束。
- 老用户的 `settings.json` 是升级前写的，端口仍可能是 `8787`：这不会静默打架——旧版会因
  冲突退出并说明原因，桌面版会在 `service.log` 与 `status` 里报告"旧版在跑/端口相同"。
  自行把其中一侧改成别的端口即可。

### 3b-1. #89：同名的四处冲突，本轮做到"发现并说出来"

两个产品共用四个名字，其中两处会真丢数据。探测全部在
[../src/coexistence.js](../src/coexistence.js)（只读：不建目录、不写文件、不改任何一张价表），
测试：[../test/run.mjs](../test/run.mjs) 的 `[27]` 段。

| 冲突 | 后果 | 本轮处置 |
| --- | --- | --- |
| 卸载目录 `%LOCALAPPDATA%\TokenMonitor` | 卸载桌面版连旧版日志/运行锁一起删，运行守卫随即放行 | 新机器改名 `TokenMonitor-Server`；老机器 `run_dir` 报"有风险"并说明不自动搬的理由 |
| 两张价表 `pricing.json` / `prices.json` | 名字像、schema 不同、互不同步：改了这边，那边仍按旧价计费 | `price_tables` 报出两侧路径与最后编辑时间、谁更新、可比模型里哪几个数字已经不一致 |
| 两个 `TokenMonitor.exe` | 端口占用者无法据此指认 | #87 已改为不指认产品、给出两侧安装路径 |
| 各自残留的卸载孤儿 | 卸载一个，另一个的残留没人管 | 见下方"未做" |

- **改名落在三个解析点，必须同源**：[../src/config.js](../src/config.js)（后端，唯一常量源）、
  [../windows/gui/src/main.rs](../windows/gui/src/main.rs)（GUI 启动器）、
  [../windows/tray/src/main.rs](../windows/tray/src/main.rs)（托盘）。GUI 与托盘读的是
  **同一份 `gui-settings.json`**，三处判分歧就会出现"GUI 改了端口、托盘还在旧目录里看不到"，
  比冲突本身更难查；`[27]` 段用文本比对钉住三处常量与判据同形。GUI 还把新旧两个目录都列为
  候选根（#60 的备用根机制），所以老机器上日志搬家了也 tail 得回来。

- **价表只比对敢断定的部分**：同 id + 桌面版只有一条价格记录且无 `effectiveFrom` 历史 +
  两侧币种相同，才比 `input/output` 数字；其余一律计入"不可比"并说明数量，**不猜**。
  币种缺省按各自计费代码的真实行为解析（旧版 `pricing.js::priceOf` 缺省即人民币；
  桌面版 `pricing.rs::cost_parts` 是 `unwrap_or(&self.currency)`，条目省略币种回落到文件级
  `currency`）——这里两边行为本就不同，写死成一套会有一侧整片误判。合并两张表要动的计费口径
  （峰谷系数、缓存价、`effectiveFrom` 历史、汇率取值时刻各不相同）超出"发现"的范围。
- **需要产品裁定、本轮没有做的（不猜）**：
  1. 把桌面版 NSIS 安装目录彻底挪出 `%LOCALAPPDATA%\TokenMonitor`。Tauri 未暴露该配置项，
     只能改 `productName` 或 fork NSIS 模板；两者都会牵动桌面版自己的数据目录命名与已装机
     用户的卸载入口，属产品决定。裁定前，老机器只能靠 `run_dir` 报告 + 第 3 节的改名。
  2. 卸载孤儿的**自动清理**。删除别的安装器留下的残留是破坏性操作，且两个产品的卸载入口
     各自独立；本轮只保证"不制造新孤儿"（改名 + 第 8 节的数据保留），不自动删任何东西。

## 4. 开机自启：当前用户任务计划（✅ 已集成，#8）

实现：[../src/platform/windows-service.js](../src/platform/windows-service.js)、[../src/agent.js](../src/agent.js)；测试：[../test/windows/service.test.mjs](../test/windows/service.test.mjs)。

```powershell
node bin\tokenmonitor.js install-agent               # 默认端口 8787
node bin\tokenmonitor.js install-agent --port 9001   # 指定端口
node bin\tokenmonitor.js uninstall-agent             # 只删除 TokenMonitor-Server 这一条任务
schtasks /Query /TN "TokenMonitor-Server" /V /FO LIST  # 手动核对任务状态
```

- 任务名固定为 `TokenMonitor-Server`，登录触发、`RunLevel=LeastPrivilege`、窗口隐藏、`MultipleInstancesPolicy=IgnoreNew`；动作指向当前 `node.exe` 与入口脚本的真实路径。
- 卸载只删除该任务，不触碰机器上其他任务计划；任务不存在时卸载友好提示而非报错。
- 重复安装是覆盖更新；任务 XML 写入前有敏感串检查，**不包含 Token / API Key**。

## 5. 系统托盘（✅ 已集成，#9）

实现：[../windows/tray/](../windows/tray/)（独立 Windows 系统托盘，自包含单文件 x64）；测试：[../test/windows/tray.test.mjs](../test/windows/tray.test.mjs)。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File windows\tray\build.ps1 # 固定目录覆盖构建托盘
node bin\tokenmonitor.js bar                                                 # 查找并以 --port 拉起托盘
```

- `bar` 依次查找 `windows/tray/publish` 与包内 `tray/` 目录下的托盘 EXE；找到则以当前 `--port` 拉起，找不到则打印含 `tray` 与面板地址的明确提示，不静默失败（托盘 EXE 属构建产物，源码目录默认没有）。
- 托盘行为：单实例互斥（命名 Mutex）；约 5 秒异步轮询 `/api/status` 更新图标状态；菜单为「打开面板 / 启动或重启后台 / 退出托盘」。托盘只管理它自己拉起的后台进程，不触碰其他 node.exe。

## 6. 日志（🟡 评审通过待集成，#11）

实现：[../src/platform/runtime.js](../src/platform/runtime.js)（`RuntimeLogger` / `sanitizeLogMessage`）；测试：[../test/windows/runtime.test.mjs](../test/windows/runtime.test.mjs)。

- 位置：源码运行形态 `%LOCALAPPDATA%\TokenMonitor-Server\logs\tokenmonitor.log`（#89 前建的机器仍在 `%LOCALAPPDATA%\TokenMonitor\logs\`，以 `status` 的 `run_dir` 行为准）；打包/安装形态 `<安装目录>\data\logs\`。
- 自动脱敏：`Authorization`/`Bearer` 头、`sk-ant-`/`sk-`/`key-` 形态 API Key、`token`/`auth_token`/`access_token` 字段，以及会话正文/提示词类内容，统一替换为 `[REDACTED]`。
- 轮转：单文件 5 MiB 上限，最多保留 5 个备份（`tokenmonitor.log.1` … `.5`），无时间戳目录堆积。

## 7. 升级

源码方式升级（数据目录与代码目录无关，升级不触碰数据）：

```powershell
cd <仓库目录>
git pull --ff-only
npm ci
node bin\tokenmonitor.js status    # 确认后台在线；如已停止则重新 serve
```

- 基于安装器的覆盖升级（先验证候选、失败可回滚、保留 `data\`）：✅ 已集成（#13，`558380a` + 修复 `50fab85`；布局 v2 由 #25 重构）。按用户级安装到 `%LOCALAPPDATA%\Programs\TokenMonitor`，无需管理员；脚本见 [../scripts/install-windows.ps1](../scripts/install-windows.ps1)、[../scripts/uninstall-windows.ps1](../scripts/uninstall-windows.ps1)，说明见 [../windows/installer/README.md](../windows/installer/README.md)；测试 [../test/windows/installer.test.mjs](../test/windows/installer.test.mjs)。
- **升级失败时的数据边界（#100）**：`data\` 只有在**新安装验证通过之后**才放回安装目录，验证失败时它仍留在 `TokenMonitor-data`；安装脚本里每一处递归删除都走同一个守卫函数，删除前先把树内的 `data\` 移到保留目录，两边都存在时直接拒绝删除。修前的顺序是"先放回 data → 再验证 → 失败就把整个新目录 `Remove-Item -Recurse`"，一次验证失败会连同用户数据一起删掉，README 承诺的"数据永不进入删除范围"当时是不成立的。
- **候选包完整性校验（#101）**：安装/升级在写入任何东西之前，把候选包逐文件对照 `manifest.json` 的 `files[]`（bytes/SHA-256）校验：哈希不符、出现清单未登记的文件、或清单干脆没有 `files[]`，一律拒装并点名到具体文件。这份清单由构建脚本一直就在写，但此前没有任何消费方——被截断、被手改、下载了一半的包与完好包被同等对待。校验是强制的（无哈希清单算失败而非跳过），否则"忘了算哈希"就成了绕过入口。
- **安装树占用守卫（#101）**：锁文件守卫只看得见后台；启动器与托盘是安装树里各自持有镜像文件的原生 exe。若仍有 `TokenMonitor`/`TokenMonitorTray`/`node` 进程**从即将删除的目录树里**运行，递归删除会半途失败——旧树已改名、交换完不成，之后每次重装都踩在残留的 `.old`/`.new` 上卡死。因此安装与卸载在任何破坏性步骤之前先检测占用，列出 PID 与镜像路径后中止；脚本不替你结束任何进程，请先用启动器「停止」并关闭托盘/启动器窗口。
- 固定目录覆盖式运行包构建（`dist/windows-x64`）：✅ 已集成（#12 `c5db723`；布局 v2 由 #25 重构）。见 [../scripts/build-windows.ps1](../scripts/build-windows.ps1)；构建前只清理该精确目录，产物带 manifest（逐文件字节/sha256，含隐藏文件——与安装器的校验枚举同口径 #101）。`windows\gui`/`windows\tray` 的 publish exe **缺失或比任何源码旧都立即重建**（#101）：此前只在缺失时构建，一个早先提交留下的 publish 产物会被静默打包，出货的 exe 落后于源码而包里没有任何东西说明这点。
- **发布面由 git 索引定义（#101）**：`bin\`/`src\`/`web\` 不再整目录 `Copy-Item -Recurse`，改为按 `git ls-files` 逐个复制；这三棵树里出现 git **既不跟踪也不 ignore** 的本地残留时，构建立即失败并逐个点名（`.gitignore` 排除项只不打包，不算违规）；索引里登记了、工作树里却没有的文件同样拒绝。此前第 7 步内容扫描只认凭据/数据库/日志，认不出"多出来一个不是源文件的文件"，本地构建残留会跟着出厂并被清单照常哈希。

### 运行包布局（v2，#25）

```text
dist\windows-x64\
├─ TokenMonitor.exe     ← GUI 启动器（原生 Rust Win32，零运行时依赖：启动/停止后台、端口设置、日志查看）
├─ manifest.json        ← 完整性清单（逐文件 bytes/sha256）
└─ runtime\             ← 全部运行库（根目录不再出现 node.exe）
   ├─ node.exe
   ├─ bin\  src\  web\  package.json  node_modules\
   └─ tokenmonitor.cmd  ← CLI 入口（tokenmonitor.cmd status 等）
```

绿色版直接使用：双击 `TokenMonitor.exe`（GUI）或 `runtime\tokenmonitor.cmd serve`（CLI）；
首次运行自动创建 `<包根>\data`；打包运行只使用包根内的新数据目录（见第 3 节）。

## 8. 卸载与数据备份

```powershell
node bin\tokenmonitor.js uninstall-agent        # 只删除 TokenMonitor-Server 任务
# 移除程序本身：安装版运行 scripts\uninstall-windows.ps1；
# 卸载默认把 <安装目录>\data 移到 %LOCALAPPDATA%\Programs\TokenMonitor-data 保留
# 移除绿色版：删除解压目录即可（data\ 在目录内，一并移走）
Remove-Item "$env:USERPROFILE\.tokenmonitor" -Recurse -Force
```

- **卸载第 1 步（删任务）在默认机器上曾经会中止整段卸载（#100）**：该步把 schtasks 的
  stderr 用 `2>&1` 并入管道，而脚本顶部是 `$ErrorActionPreference='Stop'`；PowerShell 5.1
  会把每一行被重定向的原生 stderr 变成 ErrorRecord 并抛出 `NativeCommandError`。默认机器上
  根本没有这条任务，schtasks 恰好往 stderr 写
  `ERROR: The system cannot find the file specified.` 并以退出码 1 结束，于是卸载在第 1 步
  就退出，快捷方式、安装目录、数据整理全都没做。现在调用期间临时把首选项降为 `Continue`，
  调用后再恢复。
- 该步只对"任务确实不存在"的两种 schtasks 措辞放行；拒绝访问、Task Scheduler 服务未运行、
  任务被组策略锁住这些同样以退出码 1 结束的**真失败会带着原文中止**，且中止发生在任何删除
  动作之前，机器状态未变，修好调度器再跑一次即可。
- 演练入口：`-SchtasksExe <命令路径>` 只给自动化测试用，把该步指向 `%TEMP%` 里的替身命令，
  因此这一段破坏性代码在本机可被完整验证而**不会触碰真实任务计划**；`-SkipScheduledTask`
  仍然是完全跳过。
- **卸载同样有安装树占用守卫（#101）**：第 4 步对安装目录做递归删除前，先确认没有
  `TokenMonitor`/`TokenMonitorTray`/`node` 进程仍从 `TokenMonitor`、`.new`、`.old` 树里运行
  （含锁文件缺失/损坏时漏掉的后台孤儿进程）。有占用就在第 1 步之前中止，任务计划、快捷方式、
  数据一样未动；放任执行则会得到"任务与快捷方式已删、目录只删掉一半"的半截卸载。

备份（建议先停止后台进程，获得一致快照；目标路径含空格/中文同样加引号）：

```powershell
Copy-Item "$env:USERPROFILE\.tokenmonitor" "D:\备份路径\tokenmonitor-backup" -Recurse -Force
```

## 9. Windows 与 macOS 命令差异

| 事项 | Windows | macOS |
| --- | --- | --- |
| 自启安装/卸载 | 当前用户任务计划 `TokenMonitor-Server`（schtasks，免管理员） | 当前用户 LaunchAgent（launchctl + plist） |
| 核对自启 | `schtasks /Query /TN "TokenMonitor-Server" /V /FO LIST` | `launchctl print gui/$(id -u)/com.tokenmonitor.server` |
| `bar` | 启动系统托盘（✅ #9）；托盘 EXE 缺失时明确提示面板地址 | 打开菜单栏胶囊 |
| 数据目录 | `%USERPROFILE%\.tokenmonitor` | `~/.tokenmonitor` |
| 停止后台 | `serve` 窗口 Ctrl+C（SIGBREAK 同样受控关闭） | `launchctl bootout` 或 Ctrl+C |
| 路径引用 | PowerShell 中含空格/中文路径一律加引号 | 多数场景无需引号 |

`serve`、`scan`、`today`、`status`、`--help`、`--version` 在两个平台行为一致。

## 10. 隐私边界

- 面板只监听 `127.0.0.1` 并校验 `Host` 头，本机外部进程与浏览器页面无法跨源读取（[../src/server.js](../src/server.js)）。
- 不上传任何会话数据；`TOKENMONITOR_OFFLINE=1` 下完全不出网。
- 任务计划 XML 不含秘密；日志自动脱敏（第 6 节）。
- 余额轮询只在配置了对应 API Key 时访问厂商接口，离线模式整体跳过。

## 11. 能力与证据总表

实测环境：Windows x64，Node v24.14.0，2026-09-18 刷新；除注明外均为离线（`TOKENMONITOR_OFFLINE=1`）运行且退出码 0。

| 能力 | 状态 | 任务/commit | 代码 | 测试 |
| --- | --- | --- | --- | --- |
| CLI help/version/status/错误码 | ✅ | #10 `65d0f21` | [../bin/tokenmonitor.js](../bin/tokenmonitor.js) | [cli.test.mjs](../test/windows/cli.test.mjs) |
| 当前用户任务计划自启 | ✅ | #8 `035627c` | [windows-service.js](../src/platform/windows-service.js) | [service.test.mjs](../test/windows/service.test.mjs) |
| 来源注册表与 Windows 根目录发现 | ✅ | #2 `6af9e76` | [../src/source-registry.js](../src/source-registry.js)、[../src/sources/](../src/sources/) | 各来源专项测试 |
| Claude/ccmr/Codex JSONL 兼容 | ✅ | #3 `ce8a39f` | [claude.js](../src/collectors/claude.js) 等 | [jsonl-a.test.mjs](../test/windows/jsonl-a.test.mjs) |
| Grok/WorkBuddy/Pi JSONL 兼容 | ✅ | #4 `65fffdb` | [grok.js](../src/collectors/grok.js) 等 | [jsonl-b.test.mjs](../test/windows/jsonl-b.test.mjs) |
| ZCode/OpenCode SQLite WAL 只读 | ✅ | #5 `9a1d74a` | [zcode.js](../src/collectors/zcode.js)、[opencode.js](../src/collectors/opencode.js) | [sqlite-sources.test.mjs](../test/windows/sqlite-sources.test.mjs) |
| dsh 多帧 zstd（无外部 CLI） | ✅ | #6 `9eb483f`/`d72afcb` | [dsh.js](../src/collectors/dsh.js) | [dsh.test.mjs](../test/windows/dsh.test.mjs) |
| Windows 源码/路径 CI 烟测 | ✅ | #14 `d85f78a` | [windows.yml](../.github/workflows/windows.yml)、[verify-windows-source.ps1](../scripts/verify-windows-source.ps1) | [ci-smoke.mjs](../test/windows/ci-smoke.mjs) |
| 文件监听降级与防抖生命周期 | 🟡 | #7 `e24ad72` | [watch.js](../src/platform/watch.js) | [watch.test.mjs](../test/windows/watch.test.mjs) |
| 单实例锁/日志/端口诊断/受控关闭 | 🟡 | #11 `235cbda` | [runtime.js](../src/platform/runtime.js) | [runtime.test.mjs](../test/windows/runtime.test.mjs) |
| 系统托盘（WinForms，单实例，状态轮询） | ✅ | #9 `b534213` | [windows/tray/](../windows/tray/) | [tray.test.mjs](../test/windows/tray.test.mjs) |
| 非管理员安装器（安装/升级/卸载/回滚 + 候选完整性与占用守卫） | ✅ | #13 `558380a`/`50fab85`；#100、#101 | [install-windows.ps1](../scripts/install-windows.ps1)、[uninstall-windows.ps1](../scripts/uninstall-windows.ps1) | [installer.test.mjs](../test/windows/installer.test.mjs) |
| EXE 覆盖式构建（dist/windows-x64 + manifest；publish 过期即重建） | ✅ | #12 `c5db723`；#101 | [build-windows.ps1](../scripts/build-windows.ps1) | —（验收轮实跑验证） |
| 面板来源元数据动态展示（/api/sources + 回退色） | ✅ | #16 `eedf2c4` | [../src/server.js](../src/server.js)、[../web/lib/sources.js](../web/lib/sources.js) | [ui-sources.test.mjs](../test/windows/ui-sources.test.mjs) |
| 数据目录便携化（打包形态 <根>\data + 旧库迁移） | ✅ | #23 `d568ba2` | [../src/config.js](../src/config.js)、[../src/platform/runtime.js](../src/platform/runtime.js) | [runtime.test.mjs](../test/windows/runtime.test.mjs) |
| 运行包布局 v2（根 GUI exe + runtime\） | ✅ | #25 `71a04e2` | [build-windows.ps1](../scripts/build-windows.ps1) | [installer.test.mjs](../test/windows/installer.test.mjs) |
| GUI 启动器（原生 Rust Win32，≤2MB 零依赖） | ✅ | #24 `18c9047`，#28 Rust 重写 | [windows/gui/](../windows/gui/) | [gui.test.mjs](../test/windows/gui.test.mjs) |
| 新来源 Antigravity（~/.gemini/antigravity SQLite） | ✅ | #20 `71697ce` | [antigravity.js](../src/collectors/antigravity.js) | [antigravity.test.mjs](../test/sources/antigravity/antigravity.test.mjs) |
| 新来源 TRAE / Hermes | ⛔ Pending（blocker：本地无用量数据面） | #18 / #19 | — | — |

### 本次核验命令与退出码

实测环境：Windows x64，Node v24.14.0，2026-09-18 刷新；除注明外均为离线（`TOKENMONITOR_OFFLINE=1`）运行且退出码 0。

```text
TOKENMONITOR_OFFLINE=1 node test/windows/cli.test.mjs              exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/service.test.mjs          exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/jsonl-a.test.mjs          exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/jsonl-b.test.mjs          exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/sqlite-sources.test.mjs   exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/dsh.test.mjs              exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/watch.test.mjs            exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/runtime.test.mjs          exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/tray.test.mjs             exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/gui.test.mjs              exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/installer.test.mjs        exit 0
TOKENMONITOR_OFFLINE=1 node test/windows/ui-sources.test.mjs       exit 0
TOKENMONITOR_OFFLINE=1 node test/sources/antigravity/antigravity.test.mjs  exit 0
node test/windows/ci-smoke.mjs                                   exit 0
npm test（在线全量）                                              exit 0，全部通过
node bin/tokenmonitor.js --version / --help / status             exit 0
node bin/tokenmonitor.js <未知命令> / serve --port 0              exit 2
```
