# TokenMonitor 合并修复执行计划 v1（2026-09-18）

编制：Qoder CN 会话 `<总指挥会话>`（总指挥）
执行：由用户切换到轻量模型（flash 级）按本文件逐条实施
覆盖任务：#30 #31 #32 #34 #35 #36 #37 #38 #39 #40 #41 #42 #43 #44 #45 #46 #47 #48 #49 #50 #51 #52 #53（共 23 项，全部已由本会话领取）
不在本计划内：#33（`awaiting_review`，属另一会话，见 §8 风险 R1）

---

## 0. 基线事实修正（务必先读）

实施前请以本节为准，Binding 文档 `agent-execution-standard` §3 的两条基线事实**已经过时**：

| 项目 | Binding 文档 §3 记载 | 2026-09-18 实测 |
|---|---|---|
| main 基线 commit | `11f399c` | `754313c`（`style(gui): modernize Win32 launcher...` #33） |
| `npm test` | 「当前有 16 项失败」 | **全绿，exit 0，输出「✓ 全部通过」** |

实测命令与结果：

```
$ npm test            # = node --disable-warning=ExperimentalWarning test/run.mjs
✓ 全部通过             # exit code 0
```

**含义**：各任务验收标准里的「npm test 全量 exit 0」现在是**真实可达的硬门槛**，不再是「相对基线无新增失败」。任何一项任务做完后 `npm test` 变红，就是该任务引入的回归，必须修掉，不得用「基线本来就红」解释。

另需注意：`npm test`（`test/run.mjs`）**不会**执行 `test/windows/*.mjs`（仅 `ci-smoke.mjs` 进了 CI）。所以 Windows 侧改动必须**另外手工逐条跑**对应的 `test/windows/*.mjs`，见 §6。

工作区当前状态（不要清理，是用户的在制品）：

```
 M .gitignore                                    # 新增 /codex-lb-main/ 与 /claude-codex-usage-dashboard-main/ 忽略
?? docs/TokenMonitor_Code_Review_2026-09-18.txt   # 375 行 review，#30/#39/#40/#41/#42/#43 的问题来源
?? docs/PLAN-2026-09-18-consolidated.md           # 本文件
```

---

## 1. 全局铁律（每一条都不可违反）

1. **一任务一 commit**，提交前必跑 `git diff --check`。commit message 用仓库现有风格：`fix(scope): 描述 (#任务号)` / `feat(scope): ...` / `refactor(scope): ...`。
2. **不越文件范围**。每个任务的「允许改动文件」是白名单，白名单外的中央文件（`src/config.js`、`src/source-registry.js`、`README.md`）一律不许「顺手改」。发现范围外问题 → 写进 Work Report 的「未解决风险」，不要动代码。
3. **不提交**：`.agentchatroom/`、`.workbuddy/`、`dist/`、`windows/*/target/`、`windows/*/publish/`、`*.db`、日志、真实会话 fixture、Token。
4. **不写死**本机用户名、盘符、绝对路径、端口、Agent 数量。路径一律走 `node:path` + `homedir()` + 环境变量。
5. **禁止**：`git push`、发 Release、发 npm、部署、上传用户数据、使用 banked reset、`--no-verify`。
6. **禁止**移植 `codex-lb-main/` 或 `claude-codex-usage-dashboard-main/` 的 React/Python 代码，只允许参考其「用户可见功能清单」。这两个目录是外部 vendored 树，已被 gitignore。
7. **测试默认离线**：`TOKENMONITOR_OFFLINE=1`。fixture 必须脱敏、最小化，放 `test/sources/<slug>/`。Windows 路径测试至少覆盖反斜杠、空格、中文。
8. **`cargo build --release` 必须零 warning**（GUI 与 tray 两个 crate 都是）。
9. **明确 0 ≠ 缺失**。任何数值字段：显式 0 保留为 `0`，字段缺失一律 `null` 并给 `unknown_reason`，**绝不允许** `x || 0` 这种把缺失塌成 0 的写法。这条是 #44/#45/#46/#47/#49 的共同命门。
10. **不许伪造证据**。跑不了就写「跳过 + 原因」，跑了失败就写「失败 + 输出」。

---

## 2. 文件冲突簇与强制串行顺序

23 个任务的 `depends_on` 全部为 `[]`（Room 形式无依赖），但**物理文件是重叠的**。现在 23 项同属一个会话，因此靠「固定串行顺序 + 一任务一 commit」消除冲突。同簇内**严禁并行、严禁跳序**。

| 簇 | 共享文件 | 涉及任务 | 强制顺序 |
|---|---|---|---|
| **C1 GUI** | `windows/gui/src/main.rs`、`test/windows/gui.test.mjs` | #39 #34 #30 | **#39 → #34 → #30** |
| **C2 日志生产** | `bin/tokenmonitor.js`、`src/platform/runtime.js` | #51 | 独立，但必须**排在 C1 之前**（见 §3 理由） |
| **C3 Scanner** | `src/scanner.js` | #43 #52 #40 | **#43 → #52 → #40** |
| **C4 后端 API** | `src/server.js` | #42 #36 #37 #46 #53 | **#42 → #36 → #37 → #46 → #53** |
| **C5 前端** | `web/app.js`、`web/index.html`、`web/style.css` | #36 #38 #37 #35 #48 #49 | **#36 → #38 → #37 → #35 → #48 → #49** |
| **C6 Codex 数据链** | `src/collectors/codex.js`、`src/store.js`、新建 `src/codex-pace.js` | #47 #44 #45 #46 | **#47 → #44 → #45 → #46** |
| **C7 Windows 交付** | `scripts/*.ps1`、`windows/tray/**` | #31 #32 | 互相独立，可任意插入 |
| **C8 CI** | `.github/workflows/windows.yml`、`test/windows/gui.test.mjs` | #41 | 必须在 **C1 全部完成之后** |

注意 #36 与 #37 同时落在 C4 和 C5：它们各自的后端部分与前端部分**必须在同一个 commit 内完成**，不要拆成两个 commit 跨波次。

---

## 3. 波次总览

```
Wave 0  基线固化            （不改代码）
Wave 1  #51                 日志生产接线      ← 先做，否则 Wave 2 的日志修复无法端到端验证
Wave 2  #39 → #34 → #30     GUI 死锁/卡顿/探测  ← P1，用户可直接感知
Wave 3  #41                 CI 保护网         ← 紧跟 Wave 2，之后所有 GUI 改动才有兜底
Wave 4  #43 → #52 → #40     Scanner 三连
Wave 5  #42 → #36           后端参数与健康语义
Wave 6  #47 → #44 → #45 → #46  Codex 数据链（契约先行）
Wave 7  #38 → #37 → #35     前端通用能力
Wave 8  #48 → #49           Codex 独立页（P1 主线）
Wave 9  #53 → #50           纵深防御与黑盒验收
Wave 10 #31 → #32           Windows 交付独立项（可随时插入，无文件冲突）
```

**为什么 #51 排在 GUI 之前**：`windows/gui/src/main.rs:151-153` 的 `log_path_for` 指向 `<data_root>\logs\tokenmonitor.log`，而全仓 `new RuntimeLogger` 只出现在 `src/platform/runtime.js:392`（RuntimeManager 构造默认值）和 `test/windows/runtime.test.mjs:199`——**生产路径从未实例化**，该文件永远不产生。所以 GUI 日志面板恒空。先修 #51 让文件真实产生，#39 的「空 tail 清空」和 #34 的「增量读取」才有可观测的验证对象。

**为什么 #47 排在 #44/#45 之前（契约先行）**：#47 是纯逻辑模块，无 IO、无依赖，且 #46 只允许序列化它的输出、#48 只允许展示。先固定它的输入/输出字段形状，#45 的存储 schema 和 #46 的 API 才有确定目标，避免三方来回改。

---

## Wave 0 — 基线固化（不改任何代码）

```bash
cd "<仓库根>"
git log --oneline -1                       # 期望 754313c
git status --short                         # 记录当前 3 条，后续每波对比
npm test                                   # 期望 exit 0 「✓ 全部通过」——记下这个数字作为黄金基线
cd windows/gui && cargo build --release    # 期望成功且零 warning
```

把这三条的输出原样存下来，作为每一个 Work Report 的「before」证据。

---

## Wave 1 — #51 RuntimeLogger 接线（P2，但是 Wave 2 的前置）

**允许改动**：`bin/tokenmonitor.js`、`src/platform/runtime.js`（如需微调）、`docs/TROUBLESHOOTING_WINDOWS.md`（如与实现有出入）、`test/windows/runtime.test.mjs`

**现状锚点**
- `bin/tokenmonitor.js:23-24`：`const log = (msg) => console.log(\`[tokenmonitor] ${msg}\`);` / `const err = ...console.error(...)`。**没有任何文件日志。**
- 命令分发：`COMMANDS` 数组 line 26；`scan` 191-197；`today` 198-206；`serve` 207-233（含 SIGINT/SIGTERM/SIGBREAK 221-233）。
- `src/platform/runtime.js`：`sanitizeLogMessage` 274-309（已实现 API Key/Bearer/sk-ant-/api_key/会话正文脱敏）；`RuntimeLogger` 314-378；轮转默认 `maxSizeBytes = 5*1024*1024`、`maxBackups = 5`（318-319），`_rotateIfNeeded` 353-372（`.1`…`.5` 递移）；`write()` 331-351 追加 `[ISO] [LEVEL] sanitized` 并可选回显 console。
- 日志目录：`getDefaultLogDir()` = `runtime.js:16-18` → `join(RUNTIME_DATA_DIR, 'logs')`。
- 三级数据目录：`resolveDataLocations()` = `src/config.js:58-88`（tier1 `TOKENMONITOR_DATA_DIR` 66-74；tier2 打包形态 `<appRoot>\data` 75-78；tier3 源码形态 dbDir=`~/.tokenmonitor`、runtimeDir=`%LOCALAPPDATA%\TokenMonitor` 79-87）。

**改法**
1. 在 `bin/tokenmonitor.js` 顶部（`COMMANDS` 之前、数据目录可解析之后）实例化一次 `RuntimeLogger`，`logFile = join(getDefaultLogDir(), 'tokenmonitor.log')`，`echoToConsole: true`（**stdout 输出必须保持**，否则现有测试和 CI smoke 会红）。
2. 把 line 23-24 的 `log`/`err` 改为转发到该 logger 的 `info`/`error`，保留 `[tokenmonitor] ` 前缀的 stdout 观感。
3. 确认 `serve`/`scan`/`today` 三条路径都经过这个 logger。`install-agent`/`uninstall-agent`/`bar`（172-187，在 `new Store` 之前分流）至少也要能写日志。
4. **关键校验（必须做，写进 Work Report）**：Node 侧日志路径与 Rust GUI 的 `log_path_for`（`main.rs:151-153` → `<resolve_data_root()>\logs\tokenmonitor.log`，`resolve_data_root` 在 `main.rs:92-115`）是否在**两种形态下都指向同一文件**。
   - 打包形态：Node = `<appRoot>\data`，Rust = `<appRoot>\data` → 应一致，**实测确认**。
   - 源码形态：Node 的日志走 `RUNTIME_DATA_DIR` = `%LOCALAPPDATA%\TokenMonitor`，而 Rust 侧**没有 dbDir/runtimeDir 之分**，只有一个 root。**这里极可能不一致。**
   - 若不一致：`main.rs` **不在本任务文件范围内，禁止修改**。做法是在 `runtime.js` 侧对齐（让源码形态的 `getDefaultLogDir()` 落到与 Rust 相同的 root），或若无法在范围内对齐，则在 `docs/TROUBLESHOOTING_WINDOWS.md` 明确写出两种形态各自的真实日志路径，并在 Work Report「未解决风险」里点名，由总指挥决定是否开新任务。
5. `docs/TROUBLESHOOTING_WINDOWS.md` 第 0 节的 `Get-Content` 指引：实测能取到内容后，如路径/文件名有出入就改正。

**验证**
```bash
TOKENMONITOR_OFFLINE=1 node test/windows/runtime.test.mjs ; echo "exit=$?"
node bin/tokenmonitor.js scan            # 然后确认 <logdir>\tokenmonitor.log 真实产生且非空
node bin/tokenmonitor.js --help          # stdout 观感不变
npm test                                 # 必须仍为 exit 0
```
额外断言：日志文件里**不得**出现 `sk-`、`Bearer`、`api_key` 明文（`sanitizeLogMessage` 生效证据）。

---

## Wave 2 — GUI 三连（`windows/gui/src/main.rs`，1084 行）

三个任务共用同一个文件，**必须按 #39 → #34 → #30 顺序，各自一个 commit**。

公共锚点：`struct App` 412-435；`static APP: Mutex<Option<App>>` 441（配 `unsafe impl Send for App {}` 439）；`with_app()` 443-445；`wnd_proc` 772-989；`WM_CREATE` 774-884（`SetTimer(hwnd, TIMER_ID, 2000, None)` 在 882，`TIMER_ID=1` 在 331）；`WM_TIMER` 956-962（`with_app(|a| { a.refresh_log(); a.poll_status(); })`）；`layout_controls` 634-770；`run_gui` 991-1056；`main` 1059-1074（单实例 `CreateMutexW` 1068，名字 `Local\TokenMonitorGui` line 56）。
Cargo：`windows-sys = "0.59"`，release profile `strip/lto/codegen-units=1/panic="abort"`。

### 2.1 #39（P1）WM_DPICHANGED 自锁死 + 日志截断残留

**缺陷 1（死锁）**：`WM_DPICHANGED` 891-926 整个 body 在 `with_app(|a| { ... })`（893）内。字体重建 894-908，随后 **910-922 在持锁状态下调 `SetWindowPos`**，923 再调 `layout_controls(hwnd, a)`。`SetWindowPos` 会同步派发 `WM_SIZE`，而 `WM_SIZE` 处理器 885-890 又调 `with_app` → 对**非重入** `std::sync::Mutex` 二次加锁 → 当前线程等自己释放 → GUI 冻死。触发场景：把窗口从 100% DPI 屏拖到 125%/150% 屏。

**改法**：锁内只做「准备」，锁外才碰窗口 API。
```rust
// 锁内：重建字体、更新 App 上的 dpi/scale，把目标 RECT 拷出来
let suggested: Option<RECT> = with_app(|a| {
    /* 重建 font handles（原 894-908 的逻辑） */
    /* 更新 a 上的 dpi / scale 字段 */
    let prc = lparam as *const RECT;
    if prc.is_null() { None } else { Some(unsafe { *prc }) }   // 只拷贝，不调用窗口 API
});
// 锁已释放：现在才允许 SetWindowPos
if let Some(r) = suggested {
    unsafe { SetWindowPos(hwnd, 0, r.left, r.top,
        r.right - r.left, r.bottom - r.top,
        SWP_NOACTIVATE | SWP_NOZORDER); }
}
// 再单独取锁做布局（此时 SetWindowPos 引发的 WM_SIZE 已经跑完）
with_app(|a| layout_controls(hwnd, a));
```
要点：**绝不在 `with_app` 闭包内调用 `SetWindowPos`/`SetWindowTextW` 等会同步派发消息的 API**。同理检查 `layout_controls`（634-770）内部是否有会重入的调用——它本来就一直在锁内跑，若 `WM_SIZE` 路径也调它，说明它自身是安全的，保持原样即可。

**缺陷 2（陈旧日志）**：`refresh_log` 616-626 在 `tail_file` 返回空时 618-620 直接 `return`，不清空 edit box。日志被 truncate / 轮转 / 删除重建后，面板继续显示上一次的旧内容，用户误以为旧错误仍在。

**改法**：`lines.is_empty()` 时把 `log_box` 设为 `（暂无日志）`（或清空）。**必须加一个 `App` 上的 bool 标志**（如 `log_cleared: bool`），只在状态发生翻转时调一次 `SetWindowTextW`，避免每 2s 空转刷文本。
> 交接给 #34：#34 会重写 `refresh_log` 的读取方式，**必须原样保留本任务的空 tail 清空语义**（#34 的 AC1 明确禁止改动它）。

**验证**：`cargo build --release` 零 warning；双屏不同 DPI 手工拖拽验证（**必须实机做并记录**，这是 AC4 硬要求）；`TOKENMONITOR_OFFLINE=1 node test/windows/gui.test.mjs`；`npm test` exit 0；`git diff --check` clean。

### 2.2 #34（P1）日志增量刷新 + 停止流程不阻塞 UI

**缺陷 1（每 2s 全量重读 + 全量重设文本）**：`refresh_log` 616-626 每 tick 调 `tail_file(&self.log_path, TAIL_LINES)` 然后 `set_text`（`SetWindowTextW`）+ `EM_SETSEL`/`EM_SCROLLCARET`。`tail_file` 186-209 以 `share_mode(0x7)` 打开，`MAX_BYTES = 1_000_000`（194 处 `seek End(-1MB)`），保留末尾 `TAIL_LINES = 400`（line 60，`lines.drain(..)`）。**完全没有 offset 跟踪**——即使日志一字未变，也是「读 1MB + 重设 400 行文本」，全在 UI 线程，每 2 秒一次。

**改法**：在 `struct App`（412-435）新增 `log_offset: u64`、`log_len: u64`、`log_buf: Vec<String>`（上限 `TAIL_LINES`）。每 tick：
1. 取当前文件大小（`GetFileAttributesExW` 拿 `nFileSizeLow/High`，或 open + `seek(End(0))`）。
2. `size == log_len` → **立即 return，不读文件、不碰控件**（这是 AC1 的核心，也是卡顿的主要来源）。
3. `size < log_len` → truncate/轮转：`log_offset = 0`、`log_buf.clear()`，走 #39 的「（暂无日志）」分支。
4. `size > log_len` → `seek` 到 `log_offset`，**只读 delta**（delta 超过 `MAX_BYTES` 时只取末尾 1MB 并把 offset 对齐到行首），按行 push 进 `log_buf`，超出 400 行时从头部 drain；更新 `log_offset = size`、`log_len = size`；然后从 `log_buf` 重设文本。
   - 可选优化：用 `EM_REPLACESEL` 只追加新行，仅在 drain 发生后才整体重设。若实现复杂度上升就跳过，**「无变化不做事」才是硬指标**。

**缺陷 2（Stop 阻塞 UI 最多 5s）**：`stop_own_backend` 532-560，`TerminateProcess(h,1)` → `WaitForSingleObject(h, 5000)` → `CloseHandle(h)`（549-555），**在 UI 线程且持有 APP 锁**。调用点：`WM_COMMAND` 的 `ID_STOP` 968、`WM_DESTROY` 976、`apply_port` 587。

**改法**：UI 线程只 `TerminateProcess`，等待挪到分离线程。
```rust
// 锁内：TerminateProcess + 在 App 上置 stopping = true，取出 HANDLE 所有权
// 锁外：std::thread::spawn(move || { WaitForSingleObject(h, 5000); CloseHandle(h); })
```
并在 `App` 上加 `stopping: bool`：置位期间状态标签显示「停止中…」，重复点击 Stop 直接忽略。**语义不变**：只管理本产品自有后台，绝不 kill 外部启动的 node（`runtime\tokenmonitor.cmd` 起的后台，GUI 的 Stop 按设计不动它）。
`WM_DESTROY`（976）路径：进程即将退出，`TerminateProcess` 后**直接跳过等待**即可（分离线程随进程消失，无副作用）。

**交接边界**：不得修改 `probe_once`/`http_status_ok`、APP 锁中毒降级、`saved_port`（属 #30），不得修改 `WM_DPICHANGED`（属 #39）。

**验证**：`test/windows/gui.test.mjs` 新增 tail offset / 停止流程 / UI 可操作性用例，**现有 33 项必须全过**；`cargo build --release` 零 warning；`npm test` exit 0。**AC5 要求附修复前后启动/空闲时 UI 卡顿对比证据**——用秒表或 `Measure-Command` 记录窗口拖动/点击响应，写进 Work Report。

### 2.3 #30（P2）探测超时 + 锁中毒降级 + saved_port 语义

**缺陷 1（无界阻塞 socket，每 2s 一次，UI 线程）**：`probe_once` 281-305 用阻塞 winsock `connect`/`send`/`recv` 发 `GET /api/status HTTP/1.0`，检查前 64 字节是否含 `" 200 "`。**全文件 grep 无 `setsockopt`/`SO_RCVTIMEO`/`SO_SNDTIMEO`**——一个都没有。`http_status_ok` 269-279 还每次轮询都 `WSAStartup(0x202)` → probe → `WSACleanup`。调用链：`WM_TIMER` 956-962 → `poll_status` 628-631 → `http_status_ok`。后台不在时 connect 会等到系统默认超时（Windows 上可达 ~21s），期间整个 GUI 冻结。

**改法**（AC1 要求总耗时 ≤1.5s）：
1. `WSAStartup` 只做一次（`WM_CREATE` 里，或 `std::sync::OnceLock`），不要每轮 startup/cleanup。
2. socket 设为非阻塞（`ioctlsocket(FIONBIO)`），`connect` 后用 `select()` 等可写，`timeval` 预算 **700ms**。注意：Windows 上 `SO_SNDTIMEO` **不作用于 connect**，所以必须用 select，不能只靠 setsockopt。
3. connect 成功后 `setsockopt(SO_RCVTIMEO/SO_SNDTIMEO, 700ms)`，再 `send`/`recv`。
4. 任何超时/错误一律按「不可达」处理，返回 false，**不得 panic、不得无限等**。总预算 700 + 700 ≤ 1.5s。

**缺陷 2（锁中毒传播 panic）**：`with_app()` 443-445 当前对 `APP.lock()` 的结果按 unwrap 处理。任一持锁线程 panic 后锁中毒，之后每次 `with_app` 都 panic。
**改法**：`APP.lock().unwrap_or_else(|e| e.into_inner())` —— 中毒时降级继续用内部数据，不传播 panic。

**缺陷 3（saved_port 语义）**：探测目标端口必须用**已保存/已生效**的端口（`App` 上的端口字段，由 `load_port`/`save_port` 159-183 与 `apply_port` 587 维护），**绝不能**读端口输入框的当前文本（`GetWindowTextW`）——否则用户在输入框里改了还没点保存，状态探测就跑去打一个未生效的端口。
**实施前先读 `struct App`（412-435）确认字段真名**，不要猜。

**交接边界**：不得修改 `refresh_log` 的增量读取与空 tail 清空（属 #34/#39），不得修改 `WM_DPICHANGED`（属 #39）。

**验证**：`TOKENMONITOR_OFFLINE=1 node test/windows/gui.test.mjs` 全过；`cargo build --release` 零 warning；`npm test` exit 0；`git diff --check` clean。补充实测：后台未启动时，连续点刷新/拖窗口，GUI 不得冻结超过 1.5s。

---

## Wave 3 — #41 CI 纳入真实 cargo 构建

**允许改动**：`.github/workflows/windows.yml`、`test/windows/gui.test.mjs`、（如需）新增 `rust-toolchain.toml`

**现状**：`windows.yml` 64 行，`TOKENMONITOR_OFFLINE: '1'`（line 10），两个 job：
- `windows-smoke`（windows-latest，矩阵 Node 22.13/24，`working-directory: Token Monitor`，pwsh）：checkout（path `Token Monitor`）→ setup-node → `npm ci --omit=dev` → `node test/windows/ci-smoke.mjs` → `node bin/tokenmonitor.js --help/--version` → `powershell -NoProfile -File scripts/verify-windows-source.ps1`
- `windows-npm-test`：checkout → setup-node → `npm ci` → `npm test`

**`.github/` 内 grep `cargo|rust|toolchain` 零命中；仓库无 `rust-toolchain.toml`（只有已 gitignore 的 `codex-lb-main/rust-toolchain.toml`）；workflow 内 grep `cache` 零命中。**

**后果已应验**：`754313c`（#33）只改 GUI 且引入了 P1 死锁（#39），CI 全绿放过。

**改法**
1. 新增独立 job `windows-gui`（不要塞进现有 job，AC4 要求不拖慢 Node 侧）：
   - `actions/checkout@v4`（**注意 path 必须与现有 job 一致为 `Token Monitor`**，否则路径全错）
   - 固定 Rust 工具链（`dtolnay/rust-toolchain@stable` 或 `actions-rust-toolchain`，版本号写死）
   - `Swatinem/rust-cache@v2` 缓存 `~/.cargo` 与 `windows/gui/target`
   - `powershell -NoProfile -ExecutionPolicy Bypass -File windows/gui/build.ps1`（build.ps1 40 行：清空重建 `windows\gui\publish\`，`cargo build --release` 在 line 27，拷 `target\release\TokenMonitorGui.exe` → `publish\TokenMonitorGui.exe` 在 line 32，打印字节数与 SHA-256）
   - 构建成功后**强制**跑 `node test/windows/gui.test.mjs`
2. `test/windows/gui.test.mjs:68-72` 现在是：
   ```js
   if (!existsSync(exe)) {
     console.log('  [skip] 未找到 windows/gui/publish/TokenMonitorGui.exe —— 先执行：');
     console.log('         powershell -NoProfile -ExecutionPolicy Bypass -File windows/gui/build.ps1');
     console.log('  gui behavioral: skipped (artifact not built)');
   } else {
   ```
   （`exe` 定义在 line 28）。改为：**只有** `process.env.SKIP_GUI_ARTIFACT === '1'` 时才允许 skip 并打 warning；否则打印错误并 `process.exit(1)`。
   > 对照：`test/windows/tray.test.mjs:31-36` 是打完 `[skip]` 直接 `process.exit(0)` —— #32 做完后要一并按同样规则收紧。
3. **AC3 硬要求**：故意在 `main.rs` 引入一个编译错误，推一次验证 CI 真的变红，截图/链接存进 Work Report，然后撤除。

**验证**：`cargo build --release` 零 warning；workflow 云端实跑一次绿色（AC5 要求把链接写进 Work Report）；本地 `node test/windows/gui.test.mjs` 在删掉 publish exe 后必须 exit 1。

---

## Wave 4 — Scanner 三连（`src/scanner.js`，243 行）

顺序 **#43 → #52 → #40**（先做小而孤立的，最后做结构性重构）。

公共锚点：`scanAll` 76-155；并发闸 `scanning`/`_scanPending` 77-82 + `finally` 141-148；`this.stats` 初始化 56；`_stat(tool)` 70-73；`liveRootsOf` 41-47；`_pruneMissingFiles` 162-179；`_inheritCodexModels` 186-216（doc 181-185），在 `scanAll` line 149 被无条件调用。

### 4.1 #43（P3）脏 state_json 容错 + 当轮统计重置 + 路径 contain 判定

**缺陷 1**：`line 103`
```js
const prev = row?.state_json ? JSON.parse(row.state_json) : undefined;
```
**裸 JSON.parse，无 try/catch**。它在 `BEGIN`(115) 之前，而外层 86-141 是 `try/finally` **没有 catch** —— 一行脏 `state_json`（旧版本数据/库损坏/手改）就让整个 `scanAll` reject。对比：`_inheritCodexModels` 里 line 196 的 parse **是有 try/catch 的**。

**改法**：包 try/catch。失败时 → 记 warning（走 `this.log`）、`prev = undefined`、**该文件按全量重扫**（`needFull` 在 105 已经因为 `!prev` 自动成立，确认即可），其余源/文件不受影响。`dedup_key` 保证重扫幂等。

**缺陷 2**：每轮统计只重置了一部分。`line 89` `st.parse_errors = 0;`、`line 90` `st.last_scan_ms = Date.now();`，但：
- `st.files`（`_stat` 70-73 初始化为 0，line 99 `st.files++`）**从不重置** → 它实际是「累计扫描过多少次文件」，不是本轮文件数。
- `st.last_error`（line 135 写入，带 ISO 时间戳前缀）**从不置回 null** → 解析早就恢复了，前端 tooltip 还挂着几天前的错误。

**改法**：在 89-90 旁边补 `st.files = 0;` 与 `st.last_error = null;`。
> 影响面确认：`computeHealth`（`server.js:92-120`）的 `files` 字段来自 `SELECT COUNT(*) FROM files`（100-101）即数据库真实行数，**不是** `st.files`，所以重置 `st.files` 不会误伤健康卡的文件数。`parse_errors`/`last_error`/`last_scan_ms` 才来自 stats。

**缺陷 3**：`line 166`
```js
const gone = rows.filter(r => !seen.has(r.path) && liveRoots.some(root => r.path.startsWith(root)));
```
字符串 `startsWith` 会把 `C:\data\codex-old\abc.jsonl` 判成 `C:\data\codex` 的子项。

**改法**：用 `path.relative` 做真包含判定，抽一个模块内小工具：
```js
const isInside = (root, target) => {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
```
（Windows 大小写不敏感：如现有代码没有统一规范化，先 `path.resolve` 再比；若仓库已有同类工具，复用它，不要新造第二套。）

### 4.2 #52（P2）`_inheritCodexModels` 写放大

**现状**：186-216，在 `scanAll` line 149 每轮无条件调用。210-215 对每一条有 state 的 codex `files` 行都跑 `updState.run(...)`(213) 和 `this.store.saveFile({...r, state_json: JSON.stringify(st)})`(214)，**写之前没有任何变化判断**。模型继承循环在 198-208（最多 6 趟）。而 `saveFile`（`store.js:199-203`）的 upsert 会把 `last_scan_ms` 刷成 `Date.now()` —— 等于每轮把所有 codex 行的 `last_scan_ms` 无意义地扰动一遍。

**改法**：先把要写的新 `state_json` 序列化出来，与 `r.state_json` 原值**字符串比对**；事件回填也一样，只有真的 `inserted > 0` 才算变化。**仅在变化时**才 `updState.run` / `saveFile`。连续两轮无变化的扫描必须零写入，且 `last_scan_ms` 不被本函数扰动（AC1）。Codex resume 的模型继承与事件回填语义**保持不变**，既有 Codex 断言全过（AC2）。

### 4.3 #40（P2）SQLite 事务跨 await

**现状（已实测确认）**：事务是**按文件**开的，在 for-await 循环体内：`BEGIN` 115 → `await src.collect(this.store, {...})` 120 → `saveFile` 125-130 → `COMMIT` 131，异常走 `ROLLBACK` 133。**await 确实在事务内**。同进程其他异步任务（`BalancePoller` → `store.saveQuota`、HTTP 查询）共用同一个 Store/连接，会被卷进来；collector 抛错 ROLLBACK 时连它们的中途写入一起回滚。

**关键有利事实（已实测）**：全部 collector 只调用三个 store 方法，**全是写、零读**：
```
store.insertEvent    (9 处)   store.insertToolCall (7 处)   store.saveQuota (2 处：codex.js / grok.js)
```
`store.saveFile` 由 scanner 自己在 125-130 调。所以「缓冲代理 store」方案完全可行。

**改法（推荐方案 A：缓冲 store）**
1. 造一个轻量代理对象，实现 `insertEvent`/`insertToolCall`/`saveQuota`/`saveFile`/`saveRates`：不直接落库，而是把调用参数 push 进一个数组。
2. `await src.collect(proxy, {...})` 全部完成后（含 scanner 自己的 `saveFile`），在**一个同步事务**里按序 flush：`BEGIN` → 逐条重放到真 store → `COMMIT`；异常 `ROLLBACK`。**BEGIN 与 COMMIT 之间不得出现任何 `await`。**
3. `saveQuota` 的 flush 必须调**真的** `store.saveQuota`，因为它内部还会写 `balance_history`（`store.js:204-210`），不要绕过。
4. AC2 达成方式：flush 是同步的，`BalancePoller` 的 `saveQuota` 无法插进这个事务；扫描失败只 ROLLBACK 扫描自己缓冲的写入。
5. AC3：超长文件多 chunk 解析时，游标推进与事件写入必须在同一次 flush 内原子完成；允许 `dedup_key` 兜底重复解析，但不可丢写入。

**备选方案 B**（若代理侵入过大）：直接去掉外层 `BEGIN/COMMIT`，让每条 `insertEvent`/`saveFile` 各自 autocommit，靠 `dedup_key`（`store.js:131-145`，含 `_supersedeEvent` 补齐逻辑）保证幂等。**代价**是失去单文件原子性，AC3 需要额外论证。**若选 B，必须在 Work Report 里写明理由和 AC3 的替代论证**，由总指挥确认。

**实施前必读**：`src/store.js` 全文（233 行，`insertEvent` 162-177 的 `_supersedeEvent` 补齐语义尤其重要，缓冲重放不得破坏它）。

**验证**：给出 before/after 实测（AC5）——例如扫描期间并发 `saveQuota` 的写入是否还在、扫描失败时是否只回滚扫描自己的行；`npm test` exit 0；现有增量/断点续传用例通过；`git diff --check` clean。

---

## Wave 5 — 后端参数与健康语义（`src/server.js`，444 行）

### 5.1 #42（P2）`days=0` 被当 30

**现状（全仓已扫，共 3 处同型）**
| 位置 | 当前表达式 | 备注 |
|---|---|---|
| `src/server.js:340` `/api/summary` | `Math.max(0, Math.min(3650, Number(url.searchParams.get('days')) \|\| 30))` | min=0 |
| `src/server.js:373` `/api/tool-activity` | `Math.max(1, Math.min(3650, Number(...) \|\| 30))` | **min=1**，与另两处不一致 |
| `src/server.js:388` `/api/export.csv` | `Math.max(0, Math.min(3650, Number(...) \|\| 30))` | min=0 |

`Number('0') === 0`，`0 || 30 === 30` → 「全部历史」永远表达不出来。而 `web/index.html:39` 真有 `data-days="0"`（label「全部」）按钮，定价侧也已把 0 当 all-time（`src/pricing.js` 的 `rangeStart` 三元）。用户点「全部」实际只拿 30 天。

`/api/sessions`（350）**不用**这个模式：`day` 走正则校验（351-353），`tool` 是 `url.searchParams.get('tool') || ''`（354）—— 无需改动，但要在 Work Report 里说明已排查。

`src/` 内其余 `Number(x) || d` 都在 collector 内部（`pi.js:48`、`opencode.js:70,77,112`、`grok.js:49`），**不是 query 参数**，不属本任务；另有 `src/pricing.js:94` 的 `pricing.usd_to_cny || 7.2`（汇率兜底，语义正确，不动）。

**改法**：抽一个模块内 helper，三处统一调用：
```js
// 未提供 → fallback；显式 "0" → 0；非法（NaN/负数/非数字）→ fallback
const parseDays = (raw, fallback, min, max) => {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
};
```
- `/api/summary` → `parseDays(get('days'), 30, 0, 3650)`
- `/api/export.csv` → `parseDays(get('days'), 30, 0, 3650)`
- `/api/tool-activity` → `parseDays(get('days'), 30, 0, 3650)`（**min 由 1 改 0**，并确认其下游 SQL 在 `days=0` 时不加时间下界；若该 SQL 假定 `days>=1`，一并修正）
- 负数/非数字的行为在**代码注释与测试中同时固化**（AC1）。

**附带前端一行修**（注意：这会碰 `web/app.js`，属 C5 簇，必须在同一 commit 内说明）：`web/app.js:365` 把 `/api/tool-activity?days=30` **硬编码成 30**，应改为跟随当前 `days`（全局变量在 `app.js:12` `let days = 7;`）。否则后端修好了，前端仍然只请求 30 天。

**验证**：实抓 `/api/summary?days=0`，确认 `costs.by_day` 行数明显 > 30（AC2）；`days=` 空、`days=abc`、`days=-5`、`days=7` 四种都补用例；`npm test` exit 0。

### 5.2 #36（P2）「疑似停更」文案歧义 + 诊断透明化

**现状**：`computeHealth` 在 `src/server.js:92-120`（**任务描述里的 86-108 是 doc comment 行号，实际 body 是 92-120**）：
```js
let status = 'ok';
if (!ev.n) status = 'empty';
else if ((st.parse_errors || 0) > 0) status = 'error';
else if (f.max_mtime && ev.last_ts &&
         f.max_mtime > now - 30 * 60_000 &&
         f.max_mtime - ev.last_ts > 30 * 60_000) status = 'stale';
```
阈值 `30 * 60_000` 用了两次。语义：**日志文件最近 30 分钟内还在写（max_mtime 新），但已解析出的最后一条事件比文件写入旧 30 分钟以上** → 暗示解析静默失败（日志格式漂移）。**不是**「你没在用这个应用」。
返回字段（109-118）：`tool, status, events, last_event_ts, files, last_file_mtime, parse_errors, last_error, last_scan_ms`。**注意 SQL 别名是 `max_mtime`，但对外返回的字段名叫 `last_file_mtime`** —— 前端要用对名字。
被 `buildSummary`（122-210）在 line 199 调用。
前端：`web/app.js` `renderHealth(health)` 273-297，`ago()` 276-282，圆点色 283，标签 **284**：`{ ok: '', empty: ' 无数据', stale: ' 疑似停更', error: ' 解析错误' }`。tooltip 当前只有最近事件时间，无任何解释。

**改法**
1. 后端：把 `computeHealth` **具名导出**（`export function computeHealth(...)`），保持现有默认导出/`startServer` 不变，这样才能单测（AC4）。返回字段一个都不许改名（前端和现有测试依赖）。
2. 前端标签（`app.js:284`）：`stale` → `疑似解析异常`；`empty` → 明确表达「从未采集到数据」（与 stale 区分开，AC3）。
3. tooltip 补齐诊断四要素（AC2）：源文件最近写入时间 `last_file_mtime`、最后事件时间 `last_event_ts`、事件总数 `events`、`last_error`（若有）。
4. 新增 `computeHealth` 单测四例：mtime 新但无新事件 → `stale`；无事件 → `empty`；`parse_errors>0` → `error`；正常使用间隔 → `ok`。
5. **无 API 破坏性变更**（AC5）——只加导出，不改字段。

> 顺带说明：#43 修好 `st.last_error` 永不重置之后，本任务的 tooltip 才不会挂陈年错误。两个任务的成果互相印证，Work Report 里可以交叉引用。

---

## Wave 6 — Codex 数据链（契约先行）

### 6.1 #47（P2）消耗节奏与耗尽风险（纯逻辑，**先做**）

**新建** `src/codex-pace.js` + `test/codex-pace.test.mjs`（或并入 `test/run.mjs` 的既有分组风格，与仓库一致即可）。

**硬约束**：纯函数，**不访问网络、不碰数据库、不做 IO、不执行 reset-credit、不修改配额**。输入输出都是稳定数据对象。阈值、单位、窗口 reset 规则、样本可信度规则**必须写进模块头注释和测试**（AC4），因为 #46 只允许序列化它的结果、#48 只允许展示，**全仓不得出现第二套 burn 算法**。

**必须导出并固化的能力**：burn rate、EWMA、safe usage line（计划/安全线）、risk 等级、ETA、reset relief、以及无法推断时的 `unknown` + `unknown_reason`。

**必须覆盖的边界（AC2/AC3）**：窗口 reset / window id 变化、时间倒退、用量回落、陈旧样本、容量缺失、单样本、重复样本；**旧窗口的速率不得污染新窗口**；明确 0 正确处理；NaN/负数/超范围值**不得产生假 ETA**。

> 契约交付物：模块头的 JSDoc 必须写清输入对象的每个字段名与单位、输出对象的每个字段名。#45 的存储 schema 和 #46 的 API 字段都要**照抄这份契约**，不许各自发明命名。

### 6.2 #44（P2）配额窗口与用量语义采集

**允许改动**：`src/collectors/codex.js`（109 行）、`test/sources/codex/**`、Codex 专属文档。
**禁止**：修改来源注册器（`src/source-registry.js`、`src/sources/codex.js`）、其他来源 collector、`src/scanner.js`、`web/app.js`、`README.md`。**禁止重复 #3 已交付的**基础 sessions/archived_sessions、CRLF、半行、归档搬移、基础 token_count 采集。**禁止**访问远端 API、账号池、代理、OAuth、reset-credit。

**要解析并规范化的字段**：primary/5h、secondary/weekly、monthly 三类窗口；credits/capacity/remaining；used/remaining percent；reset；duration；plan_type；以及 input / cached input / cache write / output / reasoning / total 的口径。

**关键正确性要求**
- `cached` 与 `reasoning` **不得被重复计入 total**（AC2，口径对齐 codex-lb 文档的语义定义，但**不许移植其代码**）。
- **显式 0 与字段缺失必须可区分**（AC3）：缺失 → `null`，绝不静默变 0。
- 无配额或坏字段 → 只产生**来源级可诊断结果**，不抛穿。
- 重复扫描、collector version 重扫、现有 #3 fixture 全部保持幂等，不改变其他来源结果（AC4）。

**注意**：`codex.js` 目前会调 `store.saveQuota`（见 §4.3 实测）。#40 落地后这个调用会经过缓冲代理，**行为不变**；但如果你先做 #44 后做 #40，注意两次的交互，`saveQuota` 的调用签名不要改。
**注意**：`collect` 的 `state` 参数来自 `files.state_json`（`scanner.js:109,121`）。新增字段要放进返回的 `r.state`，`scanner.js:124` 会自动带上 `_v`。

**验证**：合成 fixture 在 Windows 反斜杠 / 空格 / 中文路径下可解析（AC1）；`TOKENMONITOR_OFFLINE=1` 下专项 exit 0；Work Report 附**黄金数字**（AC5）。

### 6.3 #45（P2）配额快照历史存储与增量迁移

**允许改动**：`src/store.js`（233 行）+ 专属测试。
**现状锚点**：`Store.constructor` 126-160（`this.db.exec(SCHEMA)` 129、`migrate(this.db)` 130，`migrate` 定义在 123 之前）；`_upsertQuota` 156-159（`ON CONFLICT(tool) DO UPDATE ... WHERE excluded.ts > quota.ts`，注释「只接受更新的快照，扫描顺序无关」）；`saveQuota` 204-210；`getQuota` 211-214。

**改法**
1. 新表（如 `codex_quota_history`）走**现有 `migrate()` 模式**，幂等：全新库与已有库都能完成，重复启动不重复建表，**不破坏 events/quota/files 及其他来源数据**（AC1）。
2. 每个窗口可插入或更新**可去重**的快照历史：同一采集点重复写入不产生重复样本；保留明确 0，缺失字段存 `NULL`（AC2）。
3. **`getQuota('codex')` 必须继续返回最新兼容快照**（AC3）—— 现有 `server.js` 与扫描链路依赖它，不许改签名。新增的历史读取接口要有明确的排序、时间边界、以及 reset 窗口切换语义。
4. Windows 文件占用 / 瞬时 `SQLITE_BUSY` / WAL 只读冲突要能容错（`openDatabaseWithRetry` 已有先例，见 `store.js:120` 附近），**不得伪造历史样本**（AC4）。
5. 历史不可用时，现有扫描/API **不得崩溃**。

**输入形状必须严格等于 #47 模块头声明的契约**（见 §6.1）。

**验证**：临时数据库 + 清理句柄；中文/空格临时目录；`TOKENMONITOR_OFFLINE=1` 专项 exit 0；`npm test` exit 0；提交仅触及声明范围。

### 6.4 #46（P1）只读 API 契约

**允许改动**：`src/server.js`（新增路由）+ 脱敏 fixture + 专属测试。
**禁止**：数据库 schema/迁移（#45）、Codex JSONL 解析（#44）、前端 DOM（#48/#49）、顶层页面路由与浏览器导航（#48）、**第二套 burn 算法**（#47）。不复制 codex-lb 服务结构，不访问远端 `/wham/usage`。

**现有路由（新增时不要撞名，插入位置参考）**：`/api/status` 309、`/api/sources` 319、`/api/summary` 339、`/api/sessions` 350、`/api/session/<sid>` 364（startsWith）、`/api/tool-activity` 372、`/api/export.csv` 387、`/api/stream`(SSE) 404、`/vendor/echarts.min.js` 416、`/` 417、静态兜底 419-420、最终 404 421。handler 起点 299，被 `withErrors`（242-252）包裹。Host 头 403 守卫 302（`isLocalHost` 228-234），服务只 bind `127.0.0.1`（439）。

**建议路由集**（前缀统一 `/api/codex/`，全部只读 GET，全部走 `json()` 25-32）
| 路由 | 内容 |
|---|---|
| `/api/codex/summary` | 5h/weekly/monthly 窗口：used/remaining、credits、capacity、reset、duration、plan_type、freshness |
| `/api/codex/throughput?days=N` | input / cached input / cache write / output / reasoning / total 的 breakdown + 按小时/按日 trend + requests/sessions/model/project/tool 计数 + 平均/峰值 |
| `/api/codex/pace` | **直接序列化 #47 的输出**，一个字段都不许重算 |
| `/api/codex/cost?window=weekly` | weekly API-equivalent cost：按模型 × (input/cached/output) 拆分、窗口已用金额、未配价模型列表、价格来源与时间（`fx_source`/`fx_ts`）；完整周额度外推**仅在条件足够时**返回，否则给 `unknown_reason` |
| `/api/codex/events?day=&model=&session=&limit=` | 供 #49 的请求明细 |
| `/api/codex/report?day=` | 供 #49 的日报聚合（含 reasoning known/unknown coverage） |
| `/api/codex/export.csv?...` | 供 #49 的 CSV（与既有 `/api/export.csv` 387 并存，不要改它） |

**必须保持**：`/api/summary`、`/api/sessions`、`/api/session/:id`、`/api/export.csv` 兼容不变；保留 #42 的 `days=0` 语义（新路由也要用同一个 `parseDays` helper）；不破坏 #53 将加的响应头（AC4）。
**隐私**：不得泄漏 token、OAuth、代理、账号凭据（AC5）。路径字段遵守 `/api/sources`（319）同样的抹除规则。
**降级**：空数据、旧数据库（无 #45 的历史表）都要优雅降级为 `null` + `unknown_reason`，**不许 500**（AC3）。

**验证**：坏 JSON、缺列、窗口 reset、数据库锁、中文路径、无历史样本 6 类测试全过（AC5）；专项 exit 0；`npm test` exit 0；`git diff --check` clean。

---

## Wave 7 — 前端通用能力（`web/`）

**当前 `web/` 全貌**
```
web/index.html    89 行 / 4,072 B
web/app.js       845 行 / 39,913 B
web/style.css    135 行 / 7,437 B   （:root 设计令牌在 1-13：--bg --panel --panel2 --border --text --dim --cc --ccmr --codex --zcode --dsh；单一 media query 在 128）
web/lib/format.js   41 行  (esc/fmt/fmtShort/hhmm/ymd —— 只有 token 数格式化，没有金额)
web/lib/series.js  105 行
web/lib/sources.js  69 行
web/lib/theme.js    31 行
web/lib/tooltip.js  46 行
web/favicon.svg / favicon.png / apple-touch-icon.png
```
资源加载方式（对 #53 CSP 至关重要）：`style.css` link 在 line 10；**ECharts 是本地 classic script** line 11 `<script src="/vendor/echarts.min.js"></script>`，由 `server.js:416` 从 `ECHARTS_PATH`（`node_modules/echarts/dist/echarts.min.js`，`resolveEcharts()` 在 `src/config.js:109-118`）提供，**没有任何 CDN**；`app.js` 是 `type="module"`（line 87）；**无内联 `<script>`**；但 `index.html:71,73` 有内联 `style="..."` 属性，且有内联 SVG。
数据获取：**没有 fetch 封装**，裸 `fetch()` 在 `load()` 65-82（`/api/summary?days=${days}`）、365（`/api/tool-activity?days=30` 硬编码）、397、430、804（`/api/sources`）。导出走 `window.open` 460-462。生命周期在文件末尾 842-845：`loadSourceMeta(); load(); connectSSE(); setInterval(load, 60_000);`。SSE `connectSSE()` 788-798（`EventSource('/api/stream')`，600ms debounce → `load()`）。
**路由：完全没有。** `web/` 内 grep `pushState|popstate|hashchange|history.|location.hash|location.pathname|router` **零命中**；服务端未知路径 404（`server.js:421`）。所以 #48 的「可书签 `/codex`」需要**同时**加服务端路由和页面。

### 7.1 #38（P2）共享 CNY/USD 展示层 —— **前端第一优先**

**为什么排第一**：#35（AC4）和 #48（AC5/AC7）都明确要求「只调用 #38 的共享转换，不另建汇率逻辑」。#38 不先落地，后面两个任务就会各自造轮子。

**现状**：**没有任何金额格式化 helper**。`¥` 是硬编码散落在 `web/app.js` 的 **155、161、171、177-178、233（`(v) => \`¥${v.toFixed(2)}\``）、242（`formatter: (v) => '¥' + v`）**。`web/lib/format.js` 只有 token 数格式化。汇率数据由 `src/pricing.js` 的 `computeCosts`（90-163）返回 `usd_to_cny`/`fx_source`/`fx_ts`（159-161），源头是 `src/fx.js` 的 `ensureFxRate()`（53-90，`FX_URLS` 10-13，内存缓存 18，磁盘缓存 `<DATA_DIR>/fx-cache.json` 14，**TTL 12h** line 15，单 URL 超时 10s line 36，合理区间 5.5-9.5 line 51，支持 `usd_to_cny_manual` 手工覆盖 54-57）；`computeCosts` 用 **2500ms** 超时 race，兜底 `{rate: pricing.usd_to_cny || 7.2, source:'default'}`（92-95）。

**改法**
1. **新建 `web/lib/money.js`**，导出：`initMoney(costsOrSummary)`（吃进 `usd_to_cny`/`fx_source`/`fx_ts`）、`setCurrency('CNY'|'USD')`、`getCurrency()`、`formatMoney(cnyAmount)`。
2. 换算方向：后端返回的金额**已是 CNY**（USD 牌价在 `priceOf` 71-88 里已乘过 rate），所以 `USD = CNY ÷ usd_to_cny`。**统一使用同一次 summary 响应里的 `usd_to_cny`/`fx_source`/`fx_ts`，绝不另拉汇率、绝不在前端重新计价**（AC2）。
3. USD 保留 2 位小数、带 `$` 前缀；CNY 保持现状 `¥` + 2 位（AC3）。默认 CNY。
4. 选择持久化到 `localStorage`（键名如 `tm.currency`），刷新后保留（AC1）。
5. 顶部加切换控件（`index.html` 的 `nav#range` 35-41 附近，或 header 内），切换后所有金额重渲染。
6. 替换 `app.js` 的 155、161、171、177-178、233、242 全部硬编码 `¥`。
7. **不许转换**：厂商余额卡（`renderBalanceStatus` 260-270）与对账行 —— 保持原币种（AC1 末句、任务描述「厂商余额/对账行保持原币种」）。
8. 切换时 `fx_source` / `fx_ts` 说明仍须可见（AC2）。

**验证**：格式化 + 持久化测试覆盖首页**与** Codex 独立页（AC5，Codex 页在 #48 之后补）；`npm test` exit 0；`git diff --check` clean。领取时声明与 #35/#48/#49 的 web 文件冲突。

### 7.2 #37（P2）未配价模型可操作 + 改价不即时生效 Bug

**现状（三个独立问题）**
1. **真 Bug**：`src/pricing.js` `let cached = null;` 在 **line 43**，`loadPricing` 在 **45-54**：
   ```js
   export async function loadPricing() {
     if (cached) return cached;
     try { cached = JSON.parse(await readFile(PRICING_PATH, 'utf8')); }
     catch { await writeFile(PRICING_PATH, JSON.stringify(SEED, null, 2) + '\n', {mode:0o600}).catch(()=>{}); cached = SEED; }
     return cached;
   }
   ```
   **全仓没有任何地方把 `cached` 置回 null** —— 模块级、进程生命周期永久缓存。而 `SEED._note`（`src/pricing.js:18`）写的是「单价为每百万 token；DeepSeek 记峰时价，off_peak 为谷时折扣系数；**编辑后即时生效**」。**描述与行为不一致**，改完必须重启后端。
2. **UI 无操作入口**：`web/app.js:172`
   ```js
   const unpriced = costs.unpriced?.length ? `<div class="recon dim" title="${esc(costs.unpriced.join(', '))}">⚠ ${costs.unpriced.length} 个模型未配价</div>` : '';
   ```
   在 `renderStatus`（117-200）内，line 182 渲染进「API 花费」卡。42 个模型被折叠成一句话，名单只在 `title` 悬浮里。
3. **`unpriced` 的产生位置**：`computeCosts` 内层 `agg()` 的 `line 112` `if (!p) { unpriced.add(r.model); continue; }`，收集于 125，从 all-time 聚合返回于 158。`priceOf`（71-88，**未导出**）查找顺序：① `table[model]`（pricing.json，line 72，用于 76-84，USD 条目乘 rate，CNY 直接用）→ ② `lookupPrice(model)`（LiteLLM 兜底，85，全 USD × rate，87）→ ③ `null`（86）。`off_peak` 解析在 75。

**配价位置（回答用户「在哪配」）**：数据目录的 `pricing.json`，`PRICING_PATH = join(DATA_DIR, 'pricing.json')`（`src/pricing.js:14`）。打包形态 = `dist\windows-x64\data\pricing.json`（实测存在，line 2 就是那句 `_note`，含 deepseek-v4.1-flash / v4-flash / v4-pro 三个 USD 条目和 kimi-k2.6 / k2.7-code / k3 三个 CNY 条目）；源码形态 = `%LOCALAPPDATA%\TokenMonitor\pricing.json`。**仓库里没有 pricing.json 模板**，`~/.tokenmonitor/` 下也没有（那里只有 `tokenmonitor.db*` 和 `backups/`）；文件由 `loadPricing` 的 catch 分支按需生成。

**改法**
1. **修缓存（AC3）**：`loadPricing` 改为按 mtime 失效——缓存 `{ data, mtimeMs }`，每次调用 `stat(PRICING_PATH)`，mtimeMs 或 size 变化就重读。代价是一次 stat，可忽略。（用 `watch` 亦可，但 stat 更简单、Windows 上更可靠。）
2. **修 `_note`（AC3）**：把 `src/pricing.js:18` 的 SEED 文案改成与真实行为一致。**注意**：已安装实例的 `pricing.json` 里那句旧文案只在重新 seed 时才会更新，所以在 Work Report 里说明「存量文件的 `_note` 文本不会自动改写，行为修复才是重点」。**不要手工去改 `dist/windows-x64/data/pricing.json`**（那是构建产物）。
3. **新后端接口（AC1）**：返回每个未配价模型的 tokens 用量、最近出现时间、出现次数，按 tokens 降序。数据源：`events` 表 `GROUP BY model`，过滤掉价表命中的（复用 `priceOf` 的判定，需要把它导出或在 pricing.js 内新增一个 `isPriced(model)`）。**新增路由在 `src/server.js`，属 C4 簇**，插入位置参考 §6.4 的路由表。
4. **模板生成（AC2）**：一键生成/下载 pricing.json 片段——包含全部未配价模型名 + 待填字段注释（`input`/`cacheRead`/`cacheWrite`/`output`，单位「每百万 token」，并注明 USD 还是 CNY 条目的语义差异），用户/agent 填好可直接合入 `pricing.json`。
5. **前端（AC1/AC2）**：`app.js:172` 那句提示改成可点开，展开为表格（模型名 / tokens / 最近出现 / 次数）+「下载模板」按钮。
6. **隐私（AC4）**：未配价列表**不得泄漏绝对路径或敏感信息**，遵守 `/api/sources`（`server.js:319`）同样的路径抹除规则。
7. **单测（AC3/AC5）**：mtime 失效（改文件后不重启即生效）+ 列表接口。

> 当前实测未配价 42 个（2026-09-18 快照，清单随使用变化，以接口实时数据为准）：claude-opus-4-6-thinking、gemini-3.1-pro-low、gemini-3.8-flash-tiered、codex-auto-review、big-pickle、deepseek-v4-flash-free、mimo-v2.5-free、minimax-m3-free、muse-spark-1.2/1.3-contributor-free、x-preview-f-free、agnes-2.0/3.0-flash、astron-code-latest、auto-pro、deepseek-ai/deepseek-v4-flash、deepseek-ai/deepseek-v4-pro、deepseek-v4-flash-202605、deepseek-v4-pro-202606、ep-07iye0i1、ep-8l4n27h2、ep-boahh1o6、ep-i72eb58u、frank/glm-5.2、glm-5.2-x、hy3-preview-agent、hy3-x、intern-s2-preview-35b、kimi-for-coding、kimi-k3-2、nex-agi/nex-n2-pro、nvidia/nemotron-3-super-120b-a12b、pro/zai-org/glm-5、pro/zai-org/glm-5.1、sensenova-6.7-flash-lite、stealth/ox-alpha、stealth/union-alpha、tencent/hy3-preview-20260421、xop3qwencodernext、xopglm5、xopglm51、xopqwen35397b。**这个清单只用于人工核对，不许写进代码或测试断言。**

### 7.3 #35（P2）单应用 × 每模型明细视图（多来源通用）

**现状**：`renderModel(byModel)` 在 `web/app.js:562-578`，只是 `/api/summary` 的 `by_model` top-10 横向条形图。**没有独立模型页/路由**。另有 `renderCostDay` 203-245（含 line 206 的 DeepSeek 显示名合并）。来源元数据已在 `loadSourceMeta()`（`app.js:804` 取 `/api/sources`）里拿到。

**改法**
1. 后端新增通用聚合：按 `source/tool × model` 给出 tokens、调用数、最近使用时间，接受窗口参数（复用 #42 的 `parseDays`）。**不得破坏现有全局 `by_model`/`by_tool`/`costday`**（AC1）。
2. 前端在现有模型视图加**应用选择器**，选项来自 `/api/sources` 注册表 —— **新增来源无需再改前端映射**（AC2，禁止硬编码来源名单）。
3. 金额显示**只调用 #38 的 `formatMoney`**，不另建汇率或定价逻辑（AC4）。
4. **不许碰**：Codex 独立详细页、weekly API-equivalent cost、完整周额度外推、Codex 专属路由（全属 #46/#48，AC3）。

**验证**：新增面板测试；`npm test` exit 0；`git diff --check` clean；领取时声明与 #38/#48/#49 的首页文件冲突。

---

## Wave 8 — Codex 独立页（P1 主线）

### 8.1 #48（P1）页面壳、路由、首页入口、配额/吞吐/趋势/pace/weekly cost 概览

**独占范围**：Codex 顶层详细页的页面壳、稳定页面路由（`/codex`）、首页入口、页面内返回、浏览器 Back/Forward，以及配额/吞吐/趋势/pace/weekly API-equivalent cost 的**概览** UI。
**禁止**：新增账号池、代理、OAuth、远端配额管理、reset-credit 按钮；移植 codex-lb 的 React UI（只重写其**本地统计展示能力**）。#49 只能作为本任务路由**内部**的 tab/面板/抽屉，不得另建竞争性顶层路由或首页入口。

**改法（推荐：独立页面 + 真实导航，不要造 SPA 路由）**

因为 `web/` 现在**完全没有路由**（见 §7 开头的 grep 结果），而 AC2 要的是「稳定可书签、支持 Back/Forward、返回后首页状态不被破坏」，最稳妥的实现是**独立 HTML 页面 + 真实链接跳转**，而不是引入 history API 的 SPA 路由器。真实导航天然满足书签与 Back/Forward，且**对现有多来源首页零侵入**（AC1 要求首页布局/刷新/日期范围/图表/会话/其他来源统计无回归）。

1. **服务端路由**（`src/server.js`，C4 簇）：在静态兜底 419-420 **之前**加显式路由
   ```js
   if (p === '/codex' || p === '/codex/') return serveFile(res, join(WEB_DIR, 'codex.html'), MIME['.html']);
   ```
   `serveFile` 在 212-223，`MIME` 表在 16-23（确认 `.html` 已在表内，若无需补）。未知路径仍走 421 的 404。
2. **新建 `web/codex.html` + `web/codex.js`**，复用 `web/style.css`、`web/lib/*`、`/vendor/echarts.min.js`（AC7 要求复用现有静态资源、请求生命周期、ECharts/样式体系）。`codex.html` 的头部资源加载方式**照抄 `index.html:10-11,87`**，这样 #53 的 CSP 一套头就能同时覆盖两个页面。
3. **首页入口**：在 `web/index.html` 的 `nav#range`（35-41）或 header 里加一个 `<a href="/codex">Codex 详细统计</a>`。**这是对首页的唯一改动**（AC1）。
4. **返回**：`codex.html` 内放返回按钮 → `history.back()`，并在 `history.length <= 1`（直接书签进入）时兜底跳 `/`。
5. **首页状态保持（AC2 的隐藏陷阱，必须处理）**：真实导航离开 `/` 再返回时，`app.js` 会重新执行 842-845 的启动序列，全局 `let days = 7;`（line 12）会把用户选的「全部/90/30」**重置回 7**。修法：在跳走之前把 `days`（以及必要的滚动位置）写进 `sessionStorage`，`app.js` 启动时优先恢复。不处理这条，AC2 的「返回后首页状态不被重置」就是假的。
6. **概览内容（AC3/AC4/AC5）**：
   - 配额卡：5h / weekly / monthly 的 used/remaining、credits、capacity、reset 倒计时、plan_type、freshness。
   - 吞吐总览：input、cached input、cache write、output、reasoning、total、requests、sessions、model/project/tool 维度、平均值/峰值。
   - 趋势图：按小时/按日/按窗口的 tokens、请求数、缓存、reasoning（复用 ECharts，与 `renderCostDay` 203-245 同一套配置风格）。
   - pace：实际用量、计划/安全线、burn rate、risk、ETA —— **只消费 `/api/codex/pace`（#46 序列化 #47 的结果），前端不得自己算**。
   - weekly secondary 窗口的 API-equivalent cost：按模型 × (input/cached/output) 拆分、窗口已用金额、未配价模型、价格时间；条件足够时显示完整周额度外推估算。
   - **必须显著标注**：「API 等值估算，不是订阅真实账单」（AC5 原文要求）。
   - 金额**只调用 #38 的 `formatMoney`**（AC7）。
7. **健壮性（AC4/AC6）**：样本不足、reset 后、陈旧数据 → 显示 `unknown` **及原因**；monthly 缺失、API 失败、空数据、中文/长模型名、窄宽度、倒计时都要正确处理；**布局不跳动、不重叠、不误报已耗尽**。

**验证（AC8）**：专项测试覆盖首页入口、详情页加载、返回/浏览器导航、真实响应、unknown/zero、价格缺失、外推不可用、刷新/失败、趋势空态、窄宽度；`npm test` 或等价离线检查 exit 0；`git diff --check` clean；**必须提供浏览器截图或 DOM 证据**。

### 8.2 #49（P1）明细、日报、筛选、CSV

**范围**：只能在 #48 提供的 `/codex` 路由**内部**做 tab / 面板 / 抽屉 / 内部状态视图。
**禁止**：注册另一个顶层 Codex 路由、重复实现首页入口/返回/浏览器导航、接管 #48 的配额概览/pace/趋势主卡/weekly API-equivalent cost 卡、实现 #35 的通用 source×model、实现 #38 的货币切换。必要金额**只引用** #46/#48 已定义的只读字段。

**改法**
1. 在 `web/codex.js` 内加视图切换（tab 或内部状态），消费 `/api/codex/events`、`/api/codex/report`、`/api/codex/export.csv`。
2. 筛选：日期/时间窗口、模型、会话；要处理加载中、空结果、错误三态（AC1）。
3. 请求列表与详情逐条显示：input / cached input / cache write / output / reasoning / total、model、session、project、timestamp、tool（AC2）。
4. **口径必须在 UI 上明确**（AC2 + 任务描述）：`total` **不重复计算** cached/reasoning；`reasoning`/`cached` 与 `total` 的包含关系要有文字说明；**缺失值不得伪装成 0**（显示 `—` 或 `unknown`）。
5. 日报（AC3）：按日 token/request/breakdown 汇总、reasoning known/unknown coverage、未配价模型提示。
6. **CSV（AC3，重点）**：必须可被解析，且正确转义**中文 / 逗号 / 换行 / 引号**。规则：字段含 `"` `,` `\n` `\r` 时用双引号包裹，内部 `"` 翻倍为 `""`；文件带 **UTF-8 BOM**（否则 Excel 打开中文乱码）。参考既有 `/api/export.csv`（`server.js:387`，响应头 398-401 含 `content-disposition`）的做法，**但不要修改它**。

**验证（AC5）**：与 #48 的路由/入口/返回导航兼容；前端专项测试；`npm test` 或等价离线检查 exit 0；`git diff --check` clean；提供截图或浏览器证据。

---

## Wave 9 — 纵深防御与黑盒验收

### 9.1 #53（P2）CSP

**现状**：**全仓（src/ web/ bin/ scripts/ windows/）grep `Content-Security-Policy` / `X-Frame-Options` / `X-Content-Type-Options` 零命中。**
响应头设置点：`json()` 25-32（`content-type` + `cache-control: no-store`）；Host 守卫 403（303）；`serveFile` 217-221（`content-type`/`content-length`/`cache-control: no-cache`）；CSV 398-401；SSE 405-409。

**改法**
1. 只对 **HTML 响应**加 CSP（`serveFile` 212-223 内按 `type === MIME['.html']` 分支，或在 `/`（417）与 `/codex`（#48 新增）两处显式加）。**API JSON / SSE / CSV 的语义不得被 CSP 改写**（AC2）——不要给它们加 CSP。
2. 建议策略：
   ```
   Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
   X-Content-Type-Options: nosniff
   X-Frame-Options: DENY
   Referrer-Policy: no-referrer
   ```
   依据：ECharts 是同源 `/vendor/echarts.min.js`（`index.html:11` ← `server.js:416`），所以 `script-src 'self'` 够用，**无需 CDN 白名单**；`app.js` 是 `type="module"`（line 87）也在 `'self'` 内；SSE 走同源 `/api/stream`，`connect-src 'self'` 覆盖。
3. **`style-src` 的 `'unsafe-inline'` 决策**：`index.html:71,73` 有内联 `style="..."` 属性，且 `app.js` 的模板字符串里可能还有更多。**首选**是把这些内联样式抽成 `web/style.css` 的 class，然后**去掉 `'unsafe-inline'`**（更强）；若抽取代价过大或跨出文件范围，则保留 `'unsafe-inline'` 并在 Work Report 里写明原因和残留清单。注意：通过 JS 设置 `element.style.xxx` **不受** `style-src` 限制，只有 HTML 里的 `style="..."` 属性和 `<style>` 块受限。
4. `web/codex.html`（#48）必须一并覆盖，所以本任务排在 #48/#49 之后。
5. 行为测试断言 `/`、`/codex`、静态资源的响应头（AC3）；图表、SSE、字体/样式、返回导航全部保持通过。

### 9.2 #50（P2）黑盒验收资产与边界文档

**范围**：Codex 专属 fixtures、浏览器/前端回归测试、截图证据、docs。**禁止修改 GUI 文件、禁止复制 codex-lb 源码、禁止把远端账号/代理/OAuth 能力列为本地功能。**

**改法**
1. 提供脱敏 fixture + 黑盒命令，精确验收：从首页进入/返回 Codex 独立页、窗口卡、token breakdown、趋势/pace/risk/ETA、weekly API-equivalent cost、明细、日报、CSV（AC1）。
2. 浏览器或前端测试覆盖：加载/刷新/失败/空态/unknown/0、窗口 reset、Back/Forward、窄宽度、不重叠布局，保留可复核的截图或 DOM 证据（AC2）。
3. 回归断言：双扫描、版本重扫、归档搬移、坏 JSON/半行/缺列、WAL/锁冲突、Windows 中文/空格路径；**失败必须非零，不得静默跳过**（AC3）。
4. **文档**（建议 `docs/CODEX-STATS.md`）：区分「本地 Codex 日志统计」与「codex-lb 远端账号池/代理/OAuth」，列出当前不支持项、数据新鲜度、`unknown` 的限制与原因（AC4）。同时记录 Windows 中文/空格路径、CRLF/半行、双扫描、归档搬移、窗口 reset、坏记录、显式 0/unknown、WAL/文件占用、离线模式、覆盖式 `dist/windows-x64` 打包约束。
5. 打包约束：覆盖式构建写入 `dist/windows-x64`，**不创建时间戳目录**（AC5）。

---

## Wave 10 — Windows 交付独立项（无文件冲突，可随时插入）

### 10.1 #31（P2）安装/卸载遇运行中后台

**允许改动**：`scripts/install-windows.ps1`、`scripts/uninstall-windows.ps1`、`test/windows/installer.test.mjs`（173 行）

**问题**：#25 布局 v2 之后，升级/卸载需要 `Move-Item <安装目录>\data`。后台在跑时 `node.exe` 持有 `data\` 内数据库/日志句柄，`Move-Item` 失败，抛的是**原始 PowerShell 错误**，用户完全不知道要先停后台。

**改法**
1. 两个脚本在任何破坏性操作**之前**检测运行中后台：数据目录下 `tokenmonitor-*.lock`（形如 `tokenmonitor-<端口>.lock`）→ 解析 PID → `Get-Process -Id` 存活检查；或端口探测在线。
2. 检测到在跑 → 明确中文提示「请先停止后台再执行安装/卸载」→ **非零退出**，且**绝不**对 `data\` 执行 `Move-Item`（AC1）。
3. 锁文件 JSON 解析必须容错：**损坏 JSON 视为无运行实例**（AC3）。
4. 后台未运行时行为完全不变，`installer.test.mjs` 全部现有场景保持通过（AC2）；新增运行中场景断言。

**验证**：`node test/windows/installer.test.mjs`；`git diff --check` clean；聚焦 commit。

### 10.2 #32（P2）托盘去 .NET 化（本批最大单项）

**现状（实测）**
```
windows/tray/Program.cs                        283 行 / 10,020 B
windows/tray/TokenMonitorTray.csproj            16 行
windows/tray/build.ps1                          35 行
windows/tray/.gitignore
windows/tray/publish/TokenMonitorTray.exe  161,623,128 B   ← 自包含单文件，161 MB
windows/tray/{bin,obj}/
```
csproj：`<OutputType>WinExe`、`<TargetFramework>net8.0-windows`、`<UseWindowsForms>true`、`<AssemblyName>TokenMonitorTray`、Version 1.4.3。**自包含/单文件设置不在 csproj，而在 `build.ps1:22-25` 的 CLI 参数**（`dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $publish`）。
`Program.cs` 行为：单实例命名互斥 `Local\TokenMonitorTray`（43-44，第二实例返回 0）；`HttpClient` 超时 1500ms（27）；轮询 `Timer.Interval = 5000`（74-77），`PollOnceAsync` 198-248 打 `/api/status`，带 `_pollInFlight` 重入保护；菜单项 58-63 = 打开面板 / 分隔 / 启动重启项（标签由 `StartRestartLabel()` 113-117 决定：重启后台 | 后台运行中（外部启动）| 启动后台）/ 分隔 / 退出托盘；双击开面板（72）；`ResolveBackendCommand` 131-149（同目录 node.exe + `bin\tokenmonitor.js`，否则开发树 `..\..\..\bin`）；`StopBackend` 187-196（`Kill(entireProcessTree: true)` + `WaitForExit(3000)`）；图标运行时绘制 `MakeIcon` 260-276；退出清理 `TrayApplicationContext.ExitThreadCore` 86-92。

**⚠ 顺带发现的既有缺陷（本任务必须一并修）**：`scripts/build-windows.ps1`（190 行）**grep -i tray 零命中** —— 打包器从不构建/拷贝托盘。它只处理 Rust GUI：84-91 用 `windows\gui\publish\TokenMonitorGui.exe`（缺失则调 `windows\gui\build.ps1`），107 拷成 `dist\windows-x64\TokenMonitor.exe`。而 `src/bar.js` 的 `trayExeCandidates()`（**22-27**）期望 `[<root>\windows\tray\publish\TokenMonitorTray.exe, <root>\tray\TokenMonitorTray.exe]`，`openBar()`（29-45）取第一个存在的，否则抛错并打印构建指引；`bin/tokenmonitor.js:42` 的帮助文本也提到 tray。**即：打包形态下 `bar` 命令永远找不到托盘。**

**改法**
1. `windows/tray/` 重写为 **Rust + `windows-sys`**（与 GUI 同栈），托盘图标用 `Shell_NotifyIconW`；**删除 .NET 版**（`csproj` + `Program.cs`）。目标 exe **≤2MB**、目标机零额外依赖（对齐架构契约 v3 §2）。
   - **直接复用 `windows/gui/` 的既有成果**：`Cargo.toml` 的 `windows-sys = "0.59"` feature 列表（需补 `Win32_UI_Shell` 已有、可能需 `Win32_UI_NotificationServices`/`Win32_UI_WindowsAndMessaging` 等）、release profile（`strip/lto/codegen-units=1/panic="abort"`）、`build.ps1` 结构（40 行，清空重建 publish → `cargo build --release` → 拷贝 → 打印字节数与 SHA-256）。
   - **探测超时必须复用 #30 的成果**（非阻塞 connect + select 700ms + `SO_RCVTIMEO/SO_SNDTIMEO`），AC2 明确要求「探测必须有独立的 connect/read 超时，不能无界阻塞 UI」。**所以 #32 建议排在 Wave 2 之后做。**
   - 单实例互斥参照 `windows/gui/src/main.rs:1068`（`CreateMutexW`，名字 `Local\TokenMonitorGui`）—— 托盘用 `Local\TokenMonitorTray`，与 .NET 版保持同名以免升级后双开。
2. **功能对齐（AC2）**：单实例；约 5s 轮询 `/api/status` 切换图标状态；菜单「打开面板 / 启动或重启后台 / 退出托盘」（含 .NET 版 `StartRestartLabel()` 的三态标签语义：自有后台在跑 → 重启后台；外部启动的在跑 → 后台运行中（外部启动，不可停）；都没跑 → 启动后台）；**只管理自己拉起的后台**；退出托盘停自有后台。
3. **打包接线（AC3）**：`windows/tray/build.ps1` 改 cargo 构建；`scripts/build-windows.ps1` 补上托盘的构建与拷贝（产出到包内 `tray\TokenMonitorTray.exe`，与 `src/bar.js:22-27` 的第二个候选路径 `<root>\tray\TokenMonitorTray.exe` 对齐）；`bar` 命令的解析路径若需调整一并提交。
4. **测试（AC4）**：`test/windows/tray.test.mjs`（现 72 行）覆盖中文+空格路径、单实例第二实例退出、被杀干净退出、超时行为。**注意 `tray.test.mjs:31-36` 现在是打完 `[skip]` 直接 `process.exit(0)`** —— 按 #41 的同一规则收紧为：仅 `SKIP_GUI_ARTIFACT=1`（或等价的 tray 变量）时放行，否则 exit 1。
5. 确认 `windows/tray/.gitignore` 覆盖 `target/`、`publish/`、`bin/`、`obj/`，**161MB 的旧 exe 和新的 cargo target 都不得进 Git**。

**验证**：离线全部套件 + 在线 `npm test` 无回归；`cargo build --release` 零 warning；exe 字节数 ≤2MB（打印出来作为证据）；`git diff --check` clean；聚焦 commit；不设置任何依赖。

---

## 6. 每波收尾的统一验证清单

每完成一个 commit，跑：
```bash
git diff --check                                  # 必须 clean
npm test                                          # 必须 exit 0 「✓ 全部通过」
```
每完成一波，额外跑该波相关的 Windows 套件（**这些不在 `npm test` 里，必须手工跑**）：
```bash
export TOKENMONITOR_OFFLINE=1
node test/windows/gui.test.mjs        ; echo "gui exit=$?"       # Wave 2/3
node test/windows/runtime.test.mjs    ; echo "runtime exit=$?"   # Wave 1
node test/windows/installer.test.mjs  ; echo "installer exit=$?" # Wave 10
node test/windows/tray.test.mjs       ; echo "tray exit=$?"      # Wave 10
node test/windows/cli.test.mjs        ; echo "cli exit=$?"
node test/windows/ci-smoke.mjs        ; echo "smoke exit=$?"
node test/source-registry.test.mjs    ; echo "registry exit=$?"
cd windows/gui && cargo build --release            # 零 warning
```
全部 `test/` 清单（16 个 `.mjs`）：`run.mjs`(1076)、`source-registry.test.mjs`(147)、`sources/antigravity/antigravity.test.mjs`(277)、`windows/` 下 `ci-smoke`(102) `cli`(180) `dsh`(164) `gui`(141) `installer`(173) `jsonl-a`(271) `jsonl-b`(377) `runtime`(376) `service`(88) `sqlite-sources`(232) `tray`(72) `ui-sources`(143) `watch`(316)。

**现有测试覆盖缺口（补测试时注意，别以为已有）**：`computeHealth` 只有 `run.mjs:666-677` 通过实抓 `/api/summary` 的间接断言（`s.health.length === SOURCES.length`、状态都在 ok/empty），**没有单元测试** → #36 要新建。`loadPricing` 的缓存/失效**完全没测**（`run.mjs` 只测 `PEAK_SQL` line 848、`computeRecon` 308-338/940-963、以及在临时 HOME 里 seed pricing.json line 528）→ #37 要新建。Scanner 事务**没有任何测试**（`sqlite-sources.test.mjs:136`、`antigravity.test.mjs:236` 里的 `BEGIN EXCLUSIVE` 是测试侧模拟锁库的写者）→ #40 要新建。

---

## 7. Work Report 模板（每个任务提交时照填）

```
任务：#NN 标题
Commit：<sha> （一任务一 commit）
改动文件：<白名单内的实际文件清单>

逐条验收标准证据：
  AC1 …：<命令> → exit <码> / <实测输出摘要> / <截图路径>
  AC2 …：…
  （每条都要有；跑不了的写「跳过 + 原因」，失败的写「失败 + 输出」，禁止伪装通过）

基线对比：
  before：npm test exit 0「✓ 全部通过」/ cargo build 零 warning（Wave 0 记录）
  after ：npm test exit <码> / cargo build warning 数 <n>

未解决风险 / 范围外发现：<只记录，不擅自修>
```
提交 `work_report` 后，由**另一软件身份**逐项 `review_submit`（`approved` / `changes_requested`）。实现者不能批准自己的工作。`approved` 之后仍是 `pending_integration`，只有 `integration_submit` 之后才算交付。

---

## 8. 风险与需总指挥/用户决策项

**R1（需决策）#33 与 #39 的关系。** `754313c`（#33 GUI 美化）当前状态 `awaiting_review`，owner 是另一会话 `<另一会话>`，而 **#39 要修的 P1 死锁正是 #33 引入的**（`windows/gui/src/main.rs` 的 `WM_DPICHANGED` 在持 APP 锁时调 `SetWindowPos`）。本会话不能批准自己的工作，也不该在别人的 review 任务上越权。
建议处置：**#33 的 review 结论应为 `changes_requested`**，理由是引入 P1 自锁死；#39 修完后重新提交 review。请总指挥/用户确认由哪个身份去 `review_submit`。

**R2（需决策）Binding 文档 §3 基线事实过时。** 见 §0。`main` 基线已是 `754313c` 而非 `11f399c`，`npm test` 已全绿而非「16 项失败」。建议把 `agent-execution-standard` 升到 v2 修正这两条，否则后续每个 Agent 都会拿错误的门槛自我评估（甚至借「基线本来就红」掩盖真实回归）。

**R3（中等）#51 的 Node/Rust 日志路径可能不一致。** 源码形态下 Node 的日志落 `%LOCALAPPDATA%\TokenMonitor\logs\`，而 Rust `resolve_data_root`（`main.rs:92-115`）没有 dbDir/runtimeDir 之分。若实测确实不一致，修 `main.rs` 超出 #51 的文件范围 → 需要开新任务或扩大 #51 范围。Wave 1 必须先实测确认。

**R4（中等）#40 是本批技术风险最高的一项。** 事务是**按文件**开的且 `await src.collect()` 在事务内，collector 直接往 store 写。方案 A（缓冲代理 store）可行且已验证 collector 只写不读（仅 `insertEvent`/`insertToolCall`/`saveQuota` 三个方法），但需要保证重放顺序与 `_supersedeEvent`（`store.js:141-145,171-175`）的补齐语义不被破坏。若实施中发现 collector 有隐藏的读依赖，立即停下来上报，不要硬改。

**R5（中等）#48 的「返回后首页状态不被破坏」是隐藏陷阱。** 见 §8.1 第 5 点：真实导航会让 `app.js` 重跑启动序列，`days` 被重置回 7。必须用 `sessionStorage` 保持。轻量模型极可能漏掉这条而自认为通过了 AC2。

**R6（低）#32 体量偏大。** 161MB .NET 自包含 → ≤2MB Rust，等于重写一个 Win32 程序，且要顺带修 `scripts/build-windows.ps1` 从不打包托盘的既有缺陷。建议放在最后，或单独安排一个不被打断的时段。若时间不足，可先只交付「Rust 托盘 + build.ps1 接线」，把 `bar` 命令路径调整拆成后续项——但需总指挥批准范围调整。

**R7（低）`web/app.js` 是 845 行的单文件热点。** #36/#37/#38/#35/#48/#49 六个任务都要碰它（或新增同层的 `codex.js`）。严格按 §2 的 C5 顺序串行，每步 `npm test` 必须回绿再进下一步。建议 #38 落地时就把金额格式化收进 `web/lib/money.js`，减少后续任务在 `app.js` 里的散落改动。

**R8（提示）Room 状态。** 23 项任务已全部由会话 `<总指挥会话>` 领取（`status: claimed`），`task_list(status=todo)` 返回空 —— 其他 Agent 现在无法领取任何任务。若需要并行分担，必须由本会话 `task_release` 或走 `task_assign`/`task_handoff`，且同文件簇（§2）严禁跨会话并行。

---

# 附录 A：Wave 1–2 执行状态与总指挥决策（2026-09-18 晚，交接给实施模型）

> 本节优先级**高于**上文正文。上文是计划，本节是计划遇到现实之后的修正。实施前务必先读本节。

## A.1 已完成（勿重做）

| 任务 | Commit | 状态 |
|---|---|---|
| #51 RuntimeLogger 接线 | `8f4a735` | `awaiting_review`，已交 Work Report |
| #39 WM_DPICHANGED 死锁 + 日志截断残留 | `04e7856` | `awaiting_review`，已交 Work Report |
| #54 WM_CTLCOLORSTATIC 死锁（新发现） | 同 `04e7856` | Room 任务 `todo` **未领取**，见 A.3 |

`gui.test.mjs` 现为 **48 项**（原 33 + #39 八项 + #54 六项），全过。新增断言已用 `git show HEAD` 旧源码反向验证会 FAIL，不是恒真断言。

## A.2 计划被实测推翻的两处（正文对应段落作废）

1. **R3 不存在。** `TokenMonitorGui.exe --selfcheck` 输出的 `logPath` 与 Node `getDefaultLogDir()` 解析并实际写入的路径字节相同：`%LOCALAPPDATA%\TokenMonitor\logs\tokenmonitor.log`（已积累 130 行真实 serve 日志）。两侧 tier 逻辑（env > `<根>\data` > `%LOCALAPPDATA%\TokenMonitor` > `~\.tokenmonitor`）逐条同构。**不需要改 `main.rs`，不需要开新任务。** 正文 Wave 1 第 4 点与 §8 R3 作废。

2. **GUI「卡顿」的根因不是 #34 也不是 #30，而是第三个锁重入位点（已修）。** 证据链：
   - 跨进程 `SendMessageTimeout` 探测发现修前 GUI **从首个 2s tick 起永久停止取消息** —— 窗口存在、进程存活，但连 `WM_NULL` 都超时（后续轮次 0ms 返回即 `SMTO_ABORTIFHUNG` 已判定其 hung）。
   - 排除 #30：把 `gui-settings.json` 指向死端口 59999（`connect` 立即被拒、`probe_once` 毫秒返回）后**仍然死锁**。
   - 排除探测方法假因：PowerShell 与 exe 都是 64 位（`IntPtr.Size=8` / PE `machine=0x8664`），不是跨位数消息过滤。
   - 真因：`WM_CTLCOLORSTATIC` 处理器用 `with_app` 取 APP 锁读句柄/画刷/运行标志；而 `update_status()` 常在**持有 APP 锁**时被调用（`WM_TIMER` 闭包内，以及 start/stop/`apply_port` 按钮路径），它对静态控件 `SetWindowTextW` → 同步触发子控件重绘 → Win32 向父窗口发 `WM_CTLCOLORSTATIC` → 回到本进程 `wnd_proc` → 对**不可重入**的 `std::sync::Mutex` 二次加锁 → 永久死锁。
   - 修法：四个值改原子快照（`CTL_STATUS_HWND` / `CTL_LOGHDR_HWND` / `CTL_BG_BRUSH` / `CTL_BACKEND_RUNNING`），`publish_ctl_snapshot()` 在锁内发布，处理器全程不进锁，一次性覆盖所有调用点位。
   - before/after：修前 `WM_DPICHANGED → TIMEOUT-DEADLOCK`；修后 `→ RESPONDED elapsed_ms=37`，`WM_NULL` 连续 8 轮 `RESPONDED (0-7ms)`。

**实施预期修正**：#34 的 AC5 要求「修复前后 UI 卡顿对比证据」—— 冻结已修，**不要指望 #34 带来戏剧性的前后差异**。#34 剩下的真实收益是「空闲时不再每 2s 读 1MB + 重设 400 行文本」，请按空闲期文件 IO / CPU 取证，而不是按「窗口是否卡死」。#30 的超时修复仍然必要（无界 `connect`/`recv` 在特定网络状态下仍会长时间冻结 UI），但它不再是「卡顿主因」。

## A.3 决策一：#54 怎么收口（不再拆 commit）

`task_claim(#54)` 被权限分类器以「自生成任务需用户授权」拦了两次，未绕开。决策：

- **不做 commit 拆分。** 回溯拆分 `04e7856` 的风险（Rust 编译中间态、断言与代码错位）高于收益：两处修的是**同一缺陷类**，证据已在 #39 的 Work Report 里逐条归属清楚。
- **#54 不需要写任何新代码。** 实施模型只需：`task_claim(#54)` → `work_report`，`commit_hash` 填 `04e7856d54c7299e6336e9353f1cac0743adb714`，`files` 填 `windows/gui/src/main.rs` 与 `test/windows/gui.test.mjs`，正文写明「实现已随 #39 一并提交，本报告仅补齐独立任务的验收记录」，并复述 A.2 第 2 条的证据链与 before/after 数字。这样 #54 能拿到自己的独立 review，闭环而不返工。
- 若 review 方要求物理拆分，再由总指挥决定是否返工。

## A.4 决策二：#41 范围上调（勿按原文实现）

`gui.test.mjs` Part C 的现有断言是「GUI 进程 4 秒后仍存活」—— 而本次 bug 恰恰是**进程存活但完全不泵消息**，现有测试天然抱不住它。#41 若只按原文加 cargo 构建步骤，Rust GUI 再次冻结时 CI 依旧绿灯。

**#41 新增一条硬性验收**：行为测试必须断言**消息泵存活**，而不只是进程存活。推荐实现（自包含、CI 可跑、不依赖 PowerShell、不需要交互桌面）：

给 GUI exe 增加 `--pumpcheck` 无头模式（与现有 `--selfcheck` 同族，`main.rs` 的 `selfcheck` 215-247 可参照）：
1. 正常创建窗口（可不 `ShowWindow`），进入消息循环；
2. 起 worker 线程，在 **t=3s 与 t=6s** 各做一次 `SendMessageTimeoutW(hwnd, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 3000, &res)` —— 3s 这一次必须晚于首个 2s `WM_TIMER` tick，否则抓不到 tick 诱发的死锁；
3. 每次探测打印 `PUMP=OK` 或 `PUMP=DEADLOCK`；
4. 全部 OK → `exit 0`，任一超时 → `exit 1`，最后 `PostQuitMessage` 收尾。

`gui.test.mjs` Part C 调 `exe --pumpcheck`，断言 exit 0 且 stdout 含两次 `PUMP=OK`。

> 踩过的坑：跨进程找窗口要用 `EnumWindows` + 按 PID 过滤 + 比对类名 `TokenMonitorGuiWnd`，**不要用 `FindWindowW`**（实测找不到）；若坚持用 PowerShell，脚本必须**纯 ASCII**（PS 5.1 把无 BOM 的 UTF-8 当 ANSI 读，中文注释会破坏解析并报「缺少 )」这类误导性错误）。

## A.5 决策三：剩余顺序不变

Wave 2 余下按 **#34 → #30**，然后 Wave 3 `#41`（含 A.4 上调）→ Wave 4 `#43 → #52 → #40` → …… 直到 Wave 10。§2 同簇串行顺序全部照旧。#34 与 #30 都改 `windows/gui/src/main.rs`，**必须串行、各自一个 commit**，且：

- #34 不得改 `probe_once`/`http_status_ok`/`saved_port`（#30）；不得改 `WM_DPICHANGED`，**不得把 `WM_CTLCOLORSTATIC` 改回取 APP 锁**（#39/#54 已固化，改回去就是重新引入死锁）；不得改空 tail 占位语义（#39）。
- #30 不得改 `refresh_log` 的增量 offset 与空 tail 占位（#34/#39）。
- #30 顺带把 `with_app` 的 `APP.lock().ok()` 改成中毒降级 `unwrap_or_else(|e| e.into_inner())`：现状是中毒后**静默返回 None**，等于所有 GUI 功能哑掉且不报错，比 panic 更难查。

## A.6 环境与取证注意

- **`npm test` 基线全绿 exit 0**（见 §0）。做完任何一步变红都是你引入的回归，必须修。
- **已知偶发**：`cli.test.mjs` 的 `[serve SIGINT]` 用例在 Windows 上无法投递 SIGINT，会留下 `node bin/tokenmonitor.js serve --port <随机高端口>` 孤儿进程占用数据库/端口，导致**紧随其后**的 `npm test` 偶发 2 项失败，复跑即绿。遇到时先用 `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 确认有没有 `serve --port <随机>` 孤儿；**不要误杀用户自己在 8787 上的后台**。该问题不属 23 项任何任务范围，是否开任务待用户定。
- **临时工具（未跟踪，勿提交）**：仓库根有 `gui-message-pump-probe.ps1`，用来验 #34/#30 修完后消息泵与探测耗时。跑法：`powershell -NoProfile -ExecutionPolicy Bypass -File gui-message-pump-probe.ps1 -Exe "windows\gui\publish\TokenMonitorGui.exe"`，正常应输出多轮 `WM_NULL ... RESPONDED` 且最后 `RESULT=RESPONDED`。**#41 落地 `--pumpcheck` 后把它删掉**，别让它进 Git。
- 工作区有用户在制品，不要清理：` M .gitignore`、`?? docs/TokenMonitor_Code_Review_2026-09-18.txt`。提交时**逐个文件 `git add`**，不要 `git add -A`。

## A.7 交接给实施模型的起手式

1. `room_bootstrap(project_name="TokenMonitor")` → 确认 Project 名与 root 完全一致；读 `connection.room_session`：`restored` 表示同 Session、任务所有权不变；`created` 表示新 Session **不继承**任何任务，23 项需 `task_claim(reclaim=true)`（仅同软件身份且原 owner 已断开时允许）。
2. `room_sync` 读最新消息；`project_document_get("consolidated-fix-plan-2026-09-18")` 读 Room 版索引。
3. 读本文件**全文**，尤其本附录 A。
4. 跑 Wave 0 三条基线命令，确认与 §0 一致（HEAD 应已是 `04e7856`）。
5. 先做 A.3（#54 补 Work Report，零代码），再从 **#34** 开始。
6. 每任务：改代码 → `cargo build --release` 零 warning → 相关 `test/windows/*.mjs` → `npm test` exit 0 → `git diff --check` → 一个聚焦 commit → `work_report` 逐条 AC 附证据。
7. 跑不了或失败的，如实写「跳过+原因」/「失败+输出」，不许伪装通过。

