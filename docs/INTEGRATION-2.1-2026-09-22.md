# TokenMonitor 2.1 集成记录（2026-09-22）

用户在 #123 独立复审 approved 后授权集成、合并 main 并 git push。#123 的复审对象为 `ab545397c402f440f5d0ee94357366c01e7d56cf`；本次集成提交 `e557468` 先承接仍适用的修复，再应用 legacy 退役。下面是集成者的复验记录，不替代或改写原独立审查。

## 分支与任务对账

| 合入分支 | 保留范围 |
| --- | --- |
| codex/fix-r9-scan-error（含 fix-desktop-data、fix-r9-r13-desktop） | #62/#63/#71/#76/#82/#83/#108–#114：桌面数据、导出、配置、容错、去重、失败退避 |
| codex/fix-replay | #61/#64/#65/#73/#80：回放增量口径、单会话读取、退出码判断、工具配对与消息处理 |
| codex/fix-r13-modal（含 fix-desktop-ui-i18n） | #69/#70/#72/#77/#84/#88/#103/#104/#119：搜索分页、汇率、多语言、死字段清理与弹窗焦点 |
| codex/fix-collector-parity | #75/#78/#79/#85：保留 Rust 采集语义、名称归一、SQLite 行容错与合成黄金数据；Node 对照运行器随产品退役 |
| codex/fix-ci-docs | #67/#68/#74/#90/#102：保留桌面触发过滤、固定 action SHA、零告警、版本与指纹检查；旧运行入口和旧门禁删除 |
| codex/cleanup-repository | #91：历史归档、脱敏、未跟踪用户资料保留、vendored 目录忽略 |
| codex/fix-r16-installer（含 fix-packaging-coexistence） | #87/#89/#100/#101/#122：保留旧安装探测与端口隔离；安装/卸载及数据保护按 #123 新交付契约等价承接 |
| codex/qoder-mimo-2.1 | 最后应用 #123 的 ab54539，保留用户要求的 Qoder/MiMo 与 Qwen/MiMo 价格；不将该复审解释成这些附加功能的单独独立批准 |

纯 legacy #66/#81/#86/#95/#96/#97/#98/#99/#115/#116/#117/#118/#121/#92/#93/#94/#106/#107/#120 随 #123 移除作废；不合入会复活旧运行入口的分支，不删除他人工作树。#105 的旧实现已由用户要求的 Qoder/MiMo 审计修正取代，详见 QODER-MIMO-2.1-AUDIT.md；不把旧实现获批宣称为新实现单独获批。

## 冲突处理

- 回放既保留一次价格读取和指定会话查询，也保留价格损坏时的显式错误。
- 采集器 revision 升至 10，使既有缓存重新按合并后的采集语义索引；保留失败退避、大小写扩展名和平台相关路径去重。
- credits 面板接入中英日语言表，按来源标注额度，保留倒计时叶组件隔离。MiMo 大小写重复别名合并成一条，价格数字不变；新增内置价目表可解析检查。
- 删除冗余 eventCount/availableModels/firstTs 后，测试改用仍公开的 totals.events 和 models；保留多连接快照、汇总与钻取语义断言。
- 原 Node↔Rust parity 运行器退出；Codex 黄金夹具移至 desktop/src-tauri/tests/fixtures，原 token 数值断言保留。XLSX 解包验证、11 源合成扫描和 Qoder/MiMo 专项继续运行。
- 旧 Node 测试中的仍适用 CI/指纹断言迁至 retirement-check.mjs。构建开始失效旧 manifest/ZIP，版本探测失败也不留下可误发的旧包。
- 冒烟清理时终止测试自己的进程树，避免只退出父进程后 WebView 临时数据库仍被占用；不终止用户实例。

## 最终本地验证

- npm test --prefix desktop：28 文件、183 测试通过。
- npm run build --prefix desktop：通过（Vite 大于 500 kB chunk 提示仍存在）。
- cargo test --offline --locked --tests --manifest-path desktop/src-tauri/Cargo.toml：162 通过；规模用例按既有约定单独运行。
- query_scale --ignored --nocapture：10 万/100 万记录与并发写入通过；百万最深分页加活动查询 455 ms。
- RUSTFLAGS=-Dwarnings 的 release 构建与正式固定目录打包：通过。
- retirement-check.mjs、package-failure-smoke.ps1、verify-package.ps1：通过。
- service-smoke.mjs：启动、鉴权、扫描精确 120 tokens、停止通过。
- installer-smoke.ps1：版本失败前置、损坏包拒绝、遗留 old/new 保全、升级回滚、运行中拒绝、卸载与所属自启清理、legacy 数据归档、junction 边界通过。
- desktop-smoke.ps1：后台隐藏、二次启动恢复、关窗驻留、服务停止与测试进程树清理通过。

上述均为集成工作树本地证据。远程 CI 以本次 push 对应的 GitHub Actions 记录为准，不沿用旧分支结果。主工作区用户未跟踪资料保持原样；原 `.gitignore` 的 vendored 忽略项已包含在集成结果中。旧版被忽略的依赖/编译缓存和旧发行目录保存到 `.worktrees/legacy-retired-artifacts/`，不作为当前发布物。固定新版产物为 `dist/desktop-windows-x64/` 与 `dist/TokenMonitor-desktop-windows-x64.zip`。

## 首次 push 后的 CI 修正

GitHub Actions run 35716198165 的前端门禁发现 localized-format.test.ts 将 UTC 时间固定断言为 UTC+8。格式化函数按主机本地时区显示是预期行为；测试改用同一个本地墙钟时刻构造夹具。UTC 与 Asia/Singapore 两个进程环境下全套 183 项均通过。产品代码未修改；后续远程 CI 以修正提交对应的 run 为准。
