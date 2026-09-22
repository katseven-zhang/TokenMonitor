# #123 退回整改与安装链承接

> 历史实现/送审记录。最终获批基点、集成对账及合并后验证见 [2.1 集成记录](INTEGRATION-2.1-2026-09-22.md)。

本次整改基于 `codex/qoder-mimo-2.1`（已包含原 #123、Qoder/MiMo 与价格补充），不改动 main 或他人 worktree。原 #123 的独立审查基点是 `8044840`；本次修改仍需不同软件身份重新验收，不能沿用原审查当作当前 HEAD 获批。

## R-1 / R-2 / R-3 / R-5

- 工具链升级注释改为现存 desktop crate 与 desktop.yml 门禁。
- 两份 evidence-33 报告明确标注旧 Win32 历史证据，旧 GUI 测试通过数不代表新版。
- #66/#81/#86/#95/#96/#97/#98/#99/#115/#116/#117/#118/#121/#92/#93/#94/#106/#107/#120 逐任务发布 Room 消息，注明随 legacy 移除作废、在 #123 实际集成时生效；不篡改原批准记录或跨身份改任务状态。
- #95/#96 按任务契约和报告文件范围判断，不用共享 commit 的全部文件代替任务范围；#117 按已删除的 Node 静态服务契约判断，未虚构代码提交。
- 430 余条旧壳断言随路线退役；旧端口告警死锁、数据根改名、日志 tail 不回切均不再适用于已删除入口。新版验收仍由自己的 Rust 与 desktop-smoke 承担。

## R-4：保留 #100 / #101 / #122，要求新版安装链等价承接

三任务保留「已批准待集成」，不标作废，不将此处对账等同于独立批准或正式集成。

| 原要求 | 新版实现与实际回归入口 |
|---|---|
| #100 无计划任务时卸载不能中止 | 新版卸载移除的是自己所属的 HKCU Run 值，不再执行旧 schtasks 步骤；installer-smoke 不传 SkipScheduledTask 完成实际卸载，并保护无关注册表值。旧 Node 任务仅在迁移安装阶段通过 mock 适配器验证，不操作真实任务计划。 |
| #100 验证失败后数据完整回滚 | 版本探测在交换安装目录之前；数据位于程序目录外。新增版本探测失败注入，校验旧包完整且外置数据 SHA256 不变；旧 Node 迁移在交换后制造快捷方式失败，验证原 portable 数据 SHA256 不变。 |
| #100 PS 5.1 | 明确平台变更：新脚本要求 PowerShell 7.2+，不是 PS 5.1 等价实现；#requires 在任何安装改动前拒绝低版本。旧 schtasks stderr/PS 5.1 组合不再存在。 |
| #101 陈旧 EXE 不入包 | build-windows 的内容指纹覆盖前端、Rust src/Cargo.toml/Cargo.lock、配置与编译资源，另比对 EXE SHA256；package-failure-smoke 使用真实构建入口验证过期 stamp 拒绝。 |
| #101 运行中卸载不能半删除 | 安装/卸载先检查安装目录下 TokenMonitor/旧 tray/node 映像并报告 PID 与路径，不杀进程。installer-smoke 启动真实的隔离服务，验证两操作拒绝后包与数据仍完整。 |
| #101 manifest 必须被消费 | 安装前、暂存后、交换后及卸载前均校验白名单、长度、SHA256；installer-smoke 覆盖篡改包拒绝及原安装保持完整。 |
| #101 构建失败不能留下貌似新包的旧产物 | 修复遗漏：开始构建/验证 stamp 前先移除固定输出的 manifest 和 ZIP；任何后续失败再清除这两项。旧 EXE 仅保留作诊断，缺 manifest 不可安装。运行中的发行目录在失效操作之前拒绝。package-failure-smoke 实测过期 stamp 与 frontend 构建失败两条路径均无旧 manifest/ZIP。 |
| #101 白名单及深层构建树 | 固定文件清单打包，安装阶段也严格匹配；旧 verify-windows-source 复制整棵树的入口已退役，无 target/dist 递归搬运。 |
| #122 .old 数据兼取与归位 | 采用任务契约明确允许的「Fail 要求人工处理」路径：任何遗留 .old/.new 均拒绝安装，原位保留，不自动兼取、不自动归位。新增有/无当前安装的孤儿 .old/data、.new/data 回归；与 #100 失败回滚在同一套件运行。 |

遗留数据恢复：遇 .old/.new 时先停止对应程序，将该目录完整备份到安装目录之外并检查 data 内容，再由用户确认恢复/移走遗留目录。不得将旧 Node 数据库直接复制为 desktop 的 events-v2.sqlite；正常 legacy 迁移将完整目录归档为 TokenMonitor-legacy。拒绝自动合并不同格式数据库是明确的数据保全策略。

## 复验边界与后续集成

新增 package-failure-smoke 已接入 desktop.yml。本次在整改工作树亲自复跑以下命令，均退出 0：

| 命令 | 结果 |
|---|---|
| `npm test --prefix desktop` | 9 文件、45 测试通过 |
| `node desktop/scripts/retirement-check.mjs` | 单一 desktop 产品守卫通过 |
| `cargo test --offline --locked --tests --manifest-path desktop/src-tauri/Cargo.toml` | 56 通过；规模用例单独执行 |
| `cargo test --offline --locked --manifest-path desktop/src-tauri/Cargo.toml --test query_scale -- --ignored --nocapture` | 100k/1m 通过；百万条最后页双查询 531ms，夹具与检查合计 53.57 秒（R-6） |
| `pwsh -File desktop/scripts/package-failure-smoke.ps1` | 陈旧 stamp 与前端构建失败的 6 条断言通过 |
| `pwsh -File desktop/scripts/build-windows.ps1` | 前端与 Rust release 构建通过，固定目录覆盖；EXE 9,438,720 字节，包含补充价格 |
| `pwsh -File desktop/scripts/verify-package.ps1` | 白名单、版本、生命周期脚本一致性、manifest/ZIP/hash/许可证通过 |
| `pwsh -File desktop/scripts/installer-smoke.ps1` | 首装/升级/版本探测失败/交换失败回滚、运行中拒绝、.old/.new 保全、旧数据归档、自启归属/卸载与 junction 保护通过 |
| `pwsh -File desktop/scripts/desktop-smoke.ps1` | 隐藏启动、单实例恢复、关窗驻留、后台存活与显式停止通过 |
| `node desktop/scripts/service-smoke.mjs` | 合成用量精确值与服务启停通过 |

所有安装/卸载/窗口测试均使用临时数据根与专属测试注册表键；没有真实计划任务修改。首次扩展安装回归因 COM 返回中文而英文错误匹配失败，改为检查实际回滚及数据哈希后完整复跑通过。远程 CI 红/绿记录仍未生成（R-7），不得以本地执行或 gate_probe 定义声称远程通过。

集成前必须核对其它已批准任务的存活文件：先处理仍适用的 desktop 和混合修复，再应用 #123 退役。后续不得机械合并旧分支而复活 Node/Win32 路径。该对账与 #123 独立复验完成之前，不执行 main 合并/push。
