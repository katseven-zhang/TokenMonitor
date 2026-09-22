# TokenMonitor

TokenMonitor 是一款面向 Windows 的本地多 Agent 用量分析桌面应用。它纯本地读取本机 AI 编码工具留下的记录数据，将不同格式统一为可查询的 Token 事件，再提供模型、项目、会话、日期、工具调用、费用和额度观测等视图。

> TokenMonitor 是非官方工具。它读取的是各工具保存在本机的私有格式；上游格式变化可能影响采集结果。模型费用是按本地价格表计算的估算值，不代表厂商账单。

## 主要能力

### 多 Agent 统一采集

当前桌面版支持 12 个本地来源：

| Agent / 工具 | 默认数据位置或类型 | 采集方式 |
|---|---|---|
| Codex | `~/.codex/sessions`、`archived_sessions` | JSONL，会话与归档去重 |
| Claude Code | `~/.claude/projects` | JSONL |
| ccmr | `~/.claude-gateway/projects` | JSONL |
| ZCode | `~/.zcode/cli/db/db.sqlite` | SQLite/WAL |
| dsh | `~/.dsh/sessions` | 多帧 zstd 会话 |
| WorkBuddy | `~/.WorkBuddy/projects` | JSONL |
| Grok Build | `~/.grok/sessions` | JSONL |
| Pi | `~/.pi/agent/sessions` | JSONL |
| OpenCode | `opencode.db` | SQLite/WAL |
| Qoder CN | `~/.qoder-cn/projects` | 认证解密累计 token 状态、逐请求 credits |
| Xiaomi MiMo Desktop | `~/.local/share/mimocode/mimocode.db` | SQLite/WAL；包含 reasoning |
| Antigravity | `conversation_summaries.db` | SQLite/WAL |

每个来源都归一化为相同的时间、Agent、模型、项目、会话、Token 分类与工具调用结构。扫描采用只读访问，并通过文件游标、数据库水位、来源版本和去重键保证重复扫描尽量不重不漏。

### 本地分析

- 全部 Agent 总览，也可以只查看任意一个 Agent；
- 模型、项目、日、月、会话和逐条用量明细；
- 输入、缓存读取、缓存写入、输出和推理 Token 分项；
- 分页的工具调用活动、来源健康状态和本地日志；
- Codex 会话完整回放，包括父子 Agent、消息、命令、补丁和工具结果；
- 分钟精度的半开时间范围 `[开始, 结束)`，并提供近 5 小时、24 小时、7 天和 30 天快捷范围；
- CSV、Markdown 和 Excel 导出，遵循当前筛选范围。

### 离线定价策略

模型定价由本地 JSON 管理。当前价格目录的约定是：中国模型使用 CNY，海外模型使用 USD；每条价格仍可明确指定自己的原始币种。

定价引擎支持：

- `input`、`cached`、`cacheWrite`、`output` 四种价格分项；
- 日志模型名到标准模型名的精确别名；
- `effectiveFrom` 历史价格，按请求时间选择生效记录；
- 每条价格独立使用 `USD` 或 `CNY`；
- 手动维护 `usdCny`，页面和导出统一显示为美元或人民币；
- 已定价费用与未定价条数、未定价 Token 分开显示；
- 缺少价格表示“未知”，不会被当作免费或零费用。

内置目录只是带来源日期的离线参考快照。服务等级、长上下文附加费、企业合同和地区差异应按实际情况在本地价格文件中调整。

### 桌面与后台运行

- 顶部全局控制后台启动、停止和重启；
- 后台停止后，仍可读取已经缓存的统计结果；
- 关闭窗口后驻留系统托盘；
- 支持当前用户登录自启，无需管理员权限；
- 单实例恢复窗口，避免重复启动多个桌面实例；
- 浅色、深色和跟随系统主题；
- `Ctrl + 加号/减号` 缩放界面，`Ctrl + 0` 恢复；
- 本地端口可配置，服务只面向本机使用。

## 版本线与产品身份（#68）

同一个仓库里有**两个独立产品**，各自一条版本号，**不是**同一版本线的新旧两级：

| 产品 | 版本号来源（必须彼此一致） | 当前 |
| --- | --- | --- |
| 旧版 Node 后台（CLI / 打包安装形态 / GUI 启动器 / 托盘） | `package.json`、`windows/gui/Cargo.toml`+`.lock`、`windows/tray/Cargo.toml`+`.lock` | `1.4.3` |
| 桌面版（Rust + Tauri） | `desktop/package.json`、`desktop/src-tauri/tauri.conf.json`、`desktop/src-tauri/Cargo.toml` | `2.0.0` |

- GitHub tag `vX.Y.Z` 指的是**桌面版**那一条线；旧版后台的发行版本看它自己 `package.json`
  与构建清单 `manifest.json` 的 `version`（由 [scripts/build-windows.ps1](scripts/build-windows.ps1)
  从根 `package.json` 取）。两者数字相同只是巧合，不代表同一次发行。
- 两个产品的可执行文件都叫 `TokenMonitor.exe`，`--version` 又只打印裸版本号，**不能**据此
  区分你跑的是哪一个；产品身份看安装路径与数据目录（见
  [docs/WINDOWS.md](docs/WINDOWS.md) 第 3、3b 节，`tokenmonitor status` 会打印 `run_dir`）。
- 家族内不许漂移：`test/run.mjs` 的 `[28]` 段逐个比对上面两列，任一文件漏改即失败；
  同时断言两条线**故意不同**，防止有人把"统一版本号"当成修复手段顺手同步。
- 待产品裁定（本轮没有擅自改动）：是否把旧版后台升到 2.x 与桌面版对齐、或显式改名
  版本线（如 `1.x-legacy`）。合并会让 `v2.0.0` 这个已发布的 tag 变得指代不清，
  属于发行决策，不是 bug 修复。

## 快速使用

### 运行已构建版本

从 [GitHub Releases](https://github.com/katseven-zhang/TokenMonitor/releases/latest) 下载 `TokenMonitor-desktop-windows-x64.zip`，解压后运行 `TokenMonitor.exe`。压缩包同时包含项目许可证、第三方许可和文件校验清单。

从固定发行目录运行：

```text
dist/desktop-windows-x64/TokenMonitor.exe
```

或者解压：

```text
dist/TokenMonitor-desktop-windows-x64.zip
```

运行要求：

- Windows 10/11 x64；
- Microsoft Edge WebView2 Runtime。

首次运行会扫描本地历史记录。日志较多时，首次建立缓存可能需要一定时间。默认配置、事件缓存、日志、价格和 WebView 数据位于：

```text
%LOCALAPPDATA%\TokenMonitor
```

所有 Agent 路径都可以在“设置”中修改或禁用。已有 TokenMonitor2 桌面数据且规范目录无桌面设置时，继续使用原目录；不自动合并数据库。安装、升级和卸载说明见 [Windows 使用说明](docs/WINDOWS.md)。

### 从源码构建

构建环境需要 Node.js、Rust stable、Windows C++ 构建工具和 PowerShell 7：

```powershell
cd desktop
npm ci
cd ..
cargo fetch --locked --manifest-path desktop/src-tauri/Cargo.toml
pwsh -File desktop/scripts/build-windows.ps1
```

首次依赖准备需要联网：`npm ci` 安装锁定的前端依赖，`cargo fetch` 预取锁定的 Rust 依赖。之后打包脚本使用离线 Cargo 构建；构建依赖下载不改变应用运行时的纯本地行为。CI 在无项目 Cargo 缓存的 Windows runner 上执行相同流程。

构建脚本会覆盖固定位置，不会不断创建新目录：

```text
dist/desktop-windows-x64
dist/TokenMonitor-desktop-windows-x64.zip
```

## 架构

```text
本地 Agent 日志 / SQLite / zstd
                │
                ▼
      Rust 原生来源采集器（12 源）
                │
                ▼
      SQLite 统一事件缓存与去重
                │
                ▼
   本地查询、定价、导出和服务生命周期
                │
                ▼
       Tauri + React 桌面界面
```

主要目录：

```text
desktop/src-tauri/src/collectors.rs      多来源解析与归一化
desktop/src-tauri/src/scanner.rs         增量扫描和来源状态
desktop/src-tauri/src/db.rs              本地事件缓存
desktop/src-tauri/src/pricing.rs         历史价格与币种换算
desktop/src-tauri/src/query.rs           汇总、筛选和分页查询
desktop/src-tauri/src/service.rs         本地后台与导出
desktop/src-tauri/src/session_replay.rs  Codex 会话回放
desktop/src/                             React 桌面界面
desktop/scripts/build-windows.ps1        固定目录覆盖式打包
```

更详细的实现和验收记录见：

- [桌面重构说明](docs/DESKTOP-REFACTOR.md)
- [桌面验收记录](docs/DESKTOP-VERIFICATION.md)
- [Codex 参考功能迁移矩阵](docs/CODEX-MIGRATION-MATRIX.md)
- [Windows 使用说明](docs/WINDOWS.md)
- [单一桌面产品迁移记录](docs/RETIRE-LEGACY-123.md)

## 测试

前端测试：

```powershell
cd desktop
npm test -- --run
```

Rust 单元与集成测试：

```powershell
cd desktop/src-tauri
cargo test --offline --locked --tests
```

测试覆盖来源黄金数据、重复扫描、分钟边界、缓存 Token、历史价格、混合币种、项目身份、会话回放、活动分页、本地服务生命周期和导出结果。

## 本地数据

TokenMonitor 仅读取用户配置的本机 Agent 记录。索引、统计、价格和设置均在本地处理并保存。

## 项目实现与开源致谢

以下能力是在 TokenMonitor 项目中设计并实现的：

- 12 个 Agent 来源的原生采集器和统一事件模型；
- 增量扫描、SQLite/WAL 读取、去重、缓存与来源健康状态；
- 模型别名、Token 分项、历史生效价格、未知价格语义；
- 中国模型 CNY、海外模型 USD 的本地价格目录策略；
- USD/CNY 原币种记录、手动汇率和统一显示币种；
- 全 Agent 与单 Agent 查询、项目归一化、分页、筛选和导出；
- Rust 本地后台的启动、停止、重启、端口与缓存读取；
- Windows 托盘、单实例、登录自启和固定目录打包；
- 面向真实本地数据的验证脚本、单元测试和集成测试。

TokenMonitor 的 Codex 会话体验参考并移植了 `codex-usage-desktop` v3.3.0 的部分实现，主要包括：

- Codex 会话回放解析器；
- 回放相关 React 组件；
- 部分格式化辅助、类型定义、语言包和样式配置。

这些移植和改编部分继续遵循原项目 MIT 许可，并保留原版权声明：

- [参考项目代码许可](desktop/LICENSE.codex-usage-desktop)
- 参考项目：<https://github.com/itvincent-git/codex-usage-desktop>

## License

TokenMonitor 本项目代码采用 [MIT License](LICENSE)。发行包还包含依赖许可证汇总和参考项目许可。使用、修改或再分发时，请同时保留适用的版权声明与许可文本。
