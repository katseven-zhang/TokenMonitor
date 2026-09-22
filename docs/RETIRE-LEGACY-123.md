# 123 号任务：单一桌面产品线

用户决定废弃旧 Node 版本。实现分支 `codex/retire-legacy-123` 从 `main@ac4ee65` 隔离，不合并其他待集成修复，不改写其他工作树。

## 交付决策

- 保留 Tauri 自带托盘、自启、窗口与单实例。退役独立 Win32 GUI/tray。
- 保持已发布桌面包名与固定覆盖目录，根构建入口转交 desktop 构建。
- 安装器校验、暂存和回滚；用户数据在程序目录外。旧 Node 安装整体存档，默认不删除数据。
- 新数据根统一 TokenMonitor；已有 TokenMonitor2 桌面根继续可用。旧 Node 数据库格式不混入桌面事件库。
- Node 仅为开发构建/测试依赖，根 package 是 private 调度入口。

## Room 任务分类

逐项依据任务原文归属，不能用候选名单直接批量关闭：

- **保留** #111（Rust 扫描器扩展名）、#114（Rust worker 配置日志），以及其他 desktop / 混合任务。
- 纯 Node/Web 测试及行为随 legacy 退役：#66、#81、#86、#95、#96、#97、#98、#99、#115、#116、#117、#118、#121。
- 原生旧壳及旧安装链随对应实现退役：#92、#93、#94、#100、#101、#106、#107、#120、#122；数据保留与回滚要求由新版安装回归重新验证。
- #67、#68、#74、#75、#82、#85、#87、#89、#90、#91、#102、#105 含混合/产品/桌面事项，不自动作废。

这些旧任务已被其他软件身份实现并批准。保留原验收事实，最终“随 legacy 移除作废”的账面操作由有权限 owner/管理员执行；不得伪造自审或集成记录。其他分支和 worktree 全部保留，删除前须另行征得 owner 同意。

## 验收证据

本地证据见下表；实现、独立批准、集成、发布分别记录。
## 本地验收证据（2026-09-22）

| 验收范围 | 结果 |
|---|---|
| legacy 本体、根包依赖与入口 | 删除 90 个跟踪文件；src/web/menubar/bin/test/windows 均不存在，根包 private，无运行依赖；retirement-check 通过 |
| 测试与 CI | 退役 test.yml/windows.yml；唯一 desktop.yml 串联仓库守卫、前端、Rust、分页、打包与生命周期 |
| 桌面前端 | npm test：9 文件 / 34 测试通过；npm run build --prefix desktop 退出 0 |
| Rust | cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml：47 通过，1 个规模用例默认 ignored |
| 规模用例 | cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml --test query_scale -- --ignored --nocapture：通过；100 万条最后页双查询约 446ms |
| 固定打包 | pwsh -File scripts/build-windows.ps1：退出 0；8,398,336 字节 EXE，无 Node 运行时；仅桌面 ZIP |
| 包完整性 | verify-package.ps1：文件白名单、manifest SHA256、ZIP 字节、许可证与包内安装脚本和源码一致性通过 |
| 安装/卸载 | 对发行包内脚本实测：首次安装、覆盖升级、损坏包拒绝、替换后失败回滚、遗留 .old 数据保护、快捷方式、所属自启移除、数据保留、旧 Node 数据归档、盘根与 junction 防护全部通过 |
| 桌面生命周期 | 隔离数据根实测：隐藏启动、重复实例退出并恢复原窗口、关闭后驻留与后台继续运行、明确停止后台通过 |
| 自启 | 独立 HKCU 测试键实测：中文/空格路径引号、开关、旧名条目兼容、任务管理器禁用状态、保留其他值通过 |
| 文档与旧壳 | Windows/架构/贡献/实施指引更新，旧文档归档；独立 windows/gui 与 windows/tray 完全退役 |
| Room 收口 | 自动审批拒绝取消其他软件身份持有的 #116；纯 legacy 任务须 owner/管理员关闭，#111/#114 及混合 desktop 任务保留 |

EXE SHA256: `e820dc1280273aaec5d46c6b45778b982c0357d8a16c28f8cd907739dde7c2f0`。
删除明细见 [文件清单](RETIRE-LEGACY-123-DELETIONS.md)。

全部安装/窗口/后台测试限定临时目录，采集用合成 fixture；注册表使用专属临时键。旧任务计划仅通过模拟适配器验证归属判定与退役调用，不触碰真实任务计划；未实测 Windows 登录注销周期，未将远程 CI 描述为已运行。构建的大分块提示为已有前端警告，不影响构建退出码。

本分支来自 main@ac4ee65，未集成其他已批准桌面修复。代码完成并提交 Work Report 只表示待独立验收；未 push、未合并 main、未发布 Release，也未删除其他 worktree。
