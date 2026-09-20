# 2026-09-20 发布审查修复与验收

审查基线：`05c90c6`。本文记录实际核实与执行结果，不把审查建议或既有文档当成测试通过。

## 六项问题

| 项目 | 修复 | 已有证据 | 尚待收尾 |
|---|---|---|---|
| R1 首次源码构建 | README 改为 `npm ci`，明确先 `cargo fetch --locked`，再离线构建 | 独立空 `CARGO_HOME` 的 Windows 全流程 35489943861、35490279936 成功，包含依赖准备、构建、打包与服务冒烟 | 35490874630 全流程通过 |
| R2 项目许可证遗漏 | 根 LICENSE 加入发行包、manifest 和 ZIP 白名单 | 最终本机包 `verify-package.ps1` 验证七文件、每文件大小/哈希、ZIP 字节一致，根 LICENSE 一致；正式发行资产远端下载 SHA-256 相等 | 35490874630 全流程通过 |
| R3 桌面 CI 缺失 | 新增独立 Windows desktop workflow：测试、生产构建、包检查、服务冒烟、百万级分页 | 正常 35490279936 成功；前端 35490376438、Rust 35490378525、编译 35490380513 三个故障探针均在注入点失败并阻断后续发布步骤 | 35490874630 全流程通过 |
| R4 夏令时分组错误 | 携带 IANA 时区；每条事件按实际规则分组；后端返回日/月 UTC 边界供下钻 | `calendar_ranges` 验证纽约春季 23 小时、秋季 25 小时、月边界与上海对照；每行汇总、明细和 CSV 行数相等；最终 EXE 日期下钻与 CSV 实测一致 | 无 |
| R5 缓存复用丢失坏行状态 | 同事务持久化每文件健康计数；复用时恢复；完整坏行显示 warning，未完成尾行等待补齐 | `source_health` 验证 1/1/0、尾行补齐；原生窗口显示 1 文件/1 复用/1 无效行和“部分成功”；最终提交 Windows Rust 回归通过 | 无 |
| R6 全量加载后分页 | 写入事务维护规范去重表，保留 raw snapshots；时间索引，SQL COUNT/LIMIT/OFFSET；只反序列化当前页 | 重复快照/迁移/向下修正/删除回退、窄范围不复活旧快照、十万/百万基准通过；最终 runner 百万回归成功；真实缓存逐行比对为零差异 | 无 |

修复提交：`ace239e`、`a9e2f70`；CI 失败探针入口 `2535918`；首次启动实机发现的残留错误提示另以 `6a4e9c6` 修复；`f38c194` 在构建 GUI/托盘/后台之前检查 WebView2，避免缺少运行时仍留下不可见进程。

## 最终代码本机验收（f38c194）

- 覆盖构建成功：EXE 8,386,560 字节，ZIP 4,496,647 字节。七文件白名单、manifest 大小/SHA-256、ZIP 字节与三类许可证均通过 `verify-package.ps1`。
- 打包服务在独立含中文和空格目录完成启动、状态、扫描、精确合成用量和停止测试，退出码 0。
- 用进程级 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 指向不存在的隔离目录模拟运行时不可用：原生中文提示后关闭，系统进程查询确认没有本 EXE 残留 GUI/服务。没有卸载机器上的 WebView2，因此不将此描述为干净系统安装测试。
- 真实既有缓存完成迁移和十来源扫描；只读事务逐行比较原始快照重新排名结果与规范表：115,910 条事件、146,464 条活动，双向差集均为 0。metadata 为 view_revision=3、collector_revision=4。
- `verify-local.py` 的全部 Agent 加十个来源、5 小时与 7 天共 22 组独立 Token/Decimal 费用/分组/活动核对通过。恢复正式用户目录后同样 22 组通过，正式 settings.json/prices.json 前后 SHA-256 不变。
- 扫描期间关闭 GUI 后后台进程仍在并完成扫描；再次启动恢复同一窗口。原生按日选择 2026-09-18 后范围为本地 00:00 至次日 00:00；GUI 行 2,788 条、650,978,259 Tokens 与实际保存的 CSV 完全一致。
- CSV 保存到已有测试文件时弹出“已存在，要替换它吗”；选择“否”后原文件内容不变，再换新文件成功导出。
- 对独立合成来源文件持有 Windows FileShare.None 独占锁，最终 EXE 扫描将来源标记为 error 并记录读取失败；释放后再扫描清除该错误，同时保留另一个文件的 1 条坏行 warning。未修改真实日志或文件权限。
- 空缓存建立后旧错误消失、端口占用提示及解除冲突后恢复、连续两次启动单实例、缓存健康 warning 已在同轮前一构建实机验证；后续 f38c194 仅增加 GUI 初始化前 WebView2 检查。
- 托盘操作由用户明确反馈“测试正常”，并说明使用远程桌面、无显示缩放。自启注册/撤销及 `--background` 隐藏启动已有实机证据；未在用户活动会话中执行注销重登，不将注册检查冒充实际登录循环。没有进行多档 Windows DPI 验收。

## 百万级性能证据

本机 Windows、debug 测试二进制；每个规模包含同数量的事件和活动。使用真实 `replace_file` 写入与真实分页函数，不以等价 SQL 代替。测试会创建并清理独立临时目录。

| 事件数 | 窄范围 5 条 | 首页面事件+活动 | offset=50000 | 末页事件+活动 |
|---|---:|---:|---:|---:|
| 100,000 | <1 ms | 22 ms | 32 ms | 42 ms |
| 1,000,000 | <1 ms | 216 ms | 223 ms | 419 ms |

- 查询计划为 `SEARCH event_current USING INDEX current_event_time (ts>? AND ts<?)`，无全历史窗口排序。
- 真实分页执行通过 SQLite progress hook 计数；窄范围低于 100 个 VM 步的采样粒度；宽范围对照大于 10,000，验证计数器在工作。
- 同时检查 Unicode 搜索、标题搜索、稳定排序、后台写入时读取、精确总数。
- 第二次全程进程监测：退出码 0，峰值工作集 18,227,200 字节；构造数据和验证约 43.8 秒。工作集不是全系统内存或所有场景的上限。
- 运行：`cargo test --offline --locked --no-default-features --manifest-path desktop/src-tauri/Cargo.toml --test query_scale -- --ignored --nocapture`。CI 显式运行此大型测试，常规单元测试默认不执行。

## 开源前扫描

使用官方 Gitleaks v8.30.1 Windows x64 包，下载 SHA-256 与官方 checksums 一致。对本地全部 Git 引用执行 `git --log-opts='--all --full-history' --ignore-gitleaks-allow --redact=100`，针对发行代码 f38c194 的 123 个提交、约 2.19 MB 变更内容，未发现凭据命中。历史对象文件名检查未发现 auth.json、凭据文件、.env、私钥、运行数据库或 service-token。

两份旧 GUI 验收文本包含机器用户名路径，当前版本已改为 ExampleUser；历史提交仍保留原验收路径，未重写历史。扫描未命中不等于绝对不存在秘密，也不覆盖未跟踪的本机数据。用户提供的审查报告、旧计划和个人工作区修改没有加入提交。

## 正式发行

- 最终 Windows 正常 CI [35490874630](https://github.com/katseven-zhang/TokenMonitor/actions/runs/35490874630) 全流程通过，耗时 23 分 32 秒。
- [v2.0.0](https://github.com/katseven-zhang/TokenMonitor/releases/tag/v2.0.0) 已于 2026-09-20 正式发布（非草稿、非预发布），tag 指向 f38c194aa979360235d7ee8dd1964eac86bfc981，与发行 manifest 一致。

发行资产为 TokenMonitor-desktop-windows-x64.zip 和 SHA256SUMS.txt。ZIP 回下载 SHA-256：81e7c239cfb5576cbc3f832f2484bb3d04a0963a30eab80e6f0edddd6b417b5c，与本机文件和 GitHub asset digest 均一致。EXE SHA-256：7bfcd83dc001bb355c61f0b4138a5c0a0c3ab62c3ff8afb365c3345482aabe8a。

仓库保持私有；公开切换由维护者自行进行。源码修复、push、发行资产和发布说明已就绪。上述测试边界继续有效；正式发布不代表安全认证或所有设备兼容性保证。
