/**
 * Windows GUI launcher tests (#24 Win-GUI; Rust rewrite #28; stay-alive #26).
 *
 * Part A: source-contract assertions on windows/gui/src/main.rs (path
 * resolution tiers, port validation, own-PID-only process handling, log
 * tail sharing, settings location, headless --selfcheck, single mutex in
 * exactly one place). Part B: runs the built exe headlessly (--selfcheck)
 * against a simulated package layout (manifest.json + runtime\ in a temp
 * dir with spaces AND Chinese) plus the dev-tree fallback. Part C: the real
 * GUI process must STAY ALIVE (the #26 bug closed it instantly via a
 * duplicated named mutex) while a second instance must exit immediately.
 * If the artifact has not been built, Parts B/C skip with a note (CI green
 * without the Rust toolchain).
 *
 * Run: TOKENMONITOR_OFFLINE=1 node test/windows/gui.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TOKENMONITOR_OFFLINE = '1';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const guiSource = join(repo, 'windows', 'gui', 'src', 'main.rs');
const exe = join(repo, 'windows', 'gui', 'publish', 'TokenMonitorGui.exe');

let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

const source = existsSync(guiSource) ? readFileSync(guiSource, 'utf8') : '';

console.log('\n[source contract] src/main.rs 契约断言（Rust 原生实现）');
{
  ok('源文件存在', source.length > 0, guiSource);
  ok('GUI 子系统（双击无控制台黑框）', source.includes('#![windows_subsystem = "windows"]'));
  ok('单实例互斥锁只创建一次（#26 教训：恰一处 CreateMutexW 调用）',
    (source.match(/CreateMutexW\(/g) || []).length === 1);
  ok('互斥锁在 main 入口（含 ERROR_ALREADY_EXISTS 误判防护注释）',
    source.includes('ERROR_ALREADY_EXISTS') && source.includes('#26'));
  ok('端口校验 1-65535', /\(1\.\.=65535\)\.contains/.test(source));
  ok('应用根检测带 max_up 上限（仓库上级目录不会误判）', /max_up: usize/.test(source));
  ok('应用根标记校验 name+os', source.includes('"TokenMonitor"') && source.includes('"windows"'));
  ok('ResolveDataRoot 先看 env 覆盖', /if let Some\(d\) = env_data_dir/.test(source));
  ok('打包形态落 <根>\\data', /root\.join\("data"\)/.test(source));
  ok('源码默认运行目录 = 新名字，且与 config.js 同源（#89：旧名字与桌面版卸载目录同路径）',
    /RUNTIME_DIR_NAME:\s*&str\s*=\s*"TokenMonitor-Server"/.test(source)
      && /join\(RUNTIME_DIR_NAME\)/.test(source)
      && /join\(LEGACY_SHARED_RUN_DIR_NAME\)/.test(source));
  ok('#89 老用户原地继续：有历史日志/锁时才留在旧目录',
    /fn has_legacy_run_artifacts/.test(source) && /has_legacy_run_artifacts\(&shared\)/.test(source));
  ok('后端解析优先 runtime\\node.exe（新布局）', /join\("runtime"\)\s*\n?\s*\.join\("node\.exe"\)/.test(source));
  ok('CLI 脚本名统一为 tokenmonitor.js',
    /const SCRIPT_NAME: &str = "tokenmonitor\.js";/.test(source) && !source.includes('SCRIPT_NAMES'));
  ok('停止只作用于自有后端（Kill 前有存活守卫）',
    source.includes('own_backend_alive') && source.includes('TerminateProcess'));
  ok('外部启动的后台不停止不重启', source.includes('为免误杀外部进程'));
  ok('日志 tail 允许写方共享（share_mode 0x7）', /share_mode\(0x7\)/.test(source));
  ok('日志/设置路径落在数据根（logs\\tokenmonitor.log、gui-settings.json）',
    source.includes('logs') && source.includes('gui-settings.json'));
  ok('端口持久化到数据根 gui-settings.json', /save_port\(settings_path: &Path, port: u32\)/.test(source));
  ok('--selfcheck 无头模式（不进 GUI 消息循环）', /--selfcheck/.test(source));
  ok('窗口关闭只停自己拉起的后台（与托盘一致）', source.includes('stop_own_backend(false)'));
  ok('无写死盘符/用户名', !/[A-Za-z]:\\Users\\|[A-Za-z]:\\AgentData/.test(source));
}

// ---- #39：WM_DPICHANGED 持锁自锁死 + 日志截断后残留陈旧内容 ----
console.log('\n[#39] DPI 变更不持锁调窗口 API；日志清空后面板不挂旧内容');
{
  const arm = source.slice(source.indexOf('WM_DPICHANGED =>'), source.indexOf('WM_CTLCOLORSTATIC =>'));
  ok('#39 捕获到 WM_DPICHANGED 分支', arm.includes('WM_DPICHANGED =>') && arm.length > 0);
  const lockOpen = arm.indexOf('let suggested = with_app(');
  const bind = arm.indexOf('if let Some(r) = suggested');   // with_app 已返回、锁已释放
  const setPos = arm.indexOf('SetWindowPos(');
  ok('#39 SetWindowPos 在 APP 锁释放之后才调用（否则 WM_SIZE 重入非重入 Mutex 即自锁死）',
    lockOpen >= 0 && bind > lockOpen && setPos > bind,
    `lockOpen=${lockOpen} bind=${bind} setPos=${setPos}`);
  const locked = arm.slice(lockOpen, bind);
  ok('#39 持锁闭包体内不再出现 SetWindowPos / SetWindowTextW',
    !/SetWindowPos\(/.test(locked) && !/SetWindowTextW\(/.test(locked));
  ok('#39 锁内只准备字体与 RECT，建议矩形以值取出而非就地使用',
    /Some\(unsafe \{ \*prc \}\)/.test(arm) && !/let r = \*prc;/.test(arm));
  ok('#39 布局在解锁后单独取锁执行', /with_app\(\|a\| layout_controls\(hwnd, a\)\)/.test(arm));

  // #34 起占位逻辑移入 show_log_placeholder 并由增量版 refresh_log 调用，切片覆盖两者
  const refresh = source.slice(source.indexOf('fn show_log_placeholder'), source.indexOf('fn poll_status'));
  ok('#39 空 tail 不再直接 return 保留旧文本，而是写占位行',
    /show_log_placeholder\(\)/.test(refresh) && refresh.includes('EMPTY_LOG_TEXT'));
  ok('#39 占位行只在状态翻转时写一次（不每 2s 重设文本）',
    /log_shows_placeholder/.test(refresh) && /if !self\.log_shows_placeholder/.test(refresh));
  ok('#39 有内容时复位占位标记', /self\.log_shows_placeholder = false;/.test(refresh));
}

// ---- #34 日志增量刷新 + 停止流程不阻塞 UI ----
console.log('\n[#34] 空闲期零 IO 增量刷新；Stop 等待移交分离线程');
{
  ok('#34 App 持有增量游标与停止状态字段',
    /log_offset: u64/.test(source) && /log_len: u64/.test(source)
      && /log_buf: Vec<String>/.test(source) && /stopping: bool/.test(source));
  ok('#34 增量决策为纯函数且覆盖 Unchanged/Truncated/Append 三态',
    /pub fn log_refresh_plan/.test(source) && /LogPlan::Unchanged/.test(source)
      && /LogPlan::Truncated/.test(source) && /Append \{ start/.test(source));
  const refresh = source.slice(source.indexOf('fn show_log_placeholder'), source.indexOf('fn poll_status'));
  ok('#34 文件大小未变化时零 IO 直接返回（修前每 2s 全量重读 1MB）',
    /LogPlan::Unchanged => return/.test(refresh));
  ok('#34 有追加时只读新增字节（tail_file 全量 tail 已移除）',
    !/tail_file\(/.test(refresh) && /read_log_delta\(/.test(refresh));
  ok('#34 truncate/轮转清空缓冲与游标，占位语义保持（#39）',
    /LogPlan::Truncated/.test(refresh) && /log_buf\.clear\(\)/.test(refresh) && refresh.includes('EMPTY_LOG_TEXT'));
  ok('#34 半行不消费、游标不推进（与采集侧半行语义一致）',
    /rposition\(/.test(source) && /consumed == start/.test(refresh));
  ok('#34 尾部窗口仍受 TAIL_LINES 约束',
    /log_buf\.len\(\) > TAIL_LINES/.test(refresh));
  const stopFn = source.slice(source.indexOf('fn stop_own_backend'), source.indexOf('fn reap_backend_async'));
  ok('#34 stop_own_backend 只发起 TerminateProcess，调用线程不再等待退出（修前 UI 冻结最多 5s）',
    /TerminateProcess/.test(stopFn) && !/WaitForSingleObject/.test(stopFn));
  ok('#34 句柄等待与回收移交分离线程（reap_backend_async）',
    /fn reap_backend_async/.test(source)
      && /thread::spawn/.test(source.slice(source.indexOf('fn reap_backend_async'), source.indexOf('fn open_panel'))));
  ok('#34 stopping 期间重复 Stop 被忽略', /if self\.stopping \{/.test(stopFn));
  ok('#34 状态栏提供「停止中…」即时反馈', source.includes('停止中…'));
  ok('#34 poll_status 在后台终止且端口不可达后解除 stopping',
    /self\.stopping = false/.test(source.slice(source.indexOf('fn poll_status'), source.indexOf('fn layout_controls'))));
  ok('#34 apply_port 换端口重启改为分离线程等待完成后 PostMessage 触发',
    /reap_backend_async\(h, self\.hwnd, true\)/.test(source));
  ok('#34 Start 在停止收尾期间被守卫（不产生重复拉起）',
    /fn start_backend[\s\S]{0,200}if self\.stopping \{/.test(source));
}

// ---- #30 探测超时 + APP 锁中毒降级 + saved_port 语义 ----
console.log('\n[#30] 探测非阻塞分级超时 ≤1.5s；锁中毒降级；未保存端口不改变探测目标');
{
  ok('#30 connect/读写分级超时常量且总量 ≤1.5s',
    /PROBE_CONNECT_TIMEOUT_MS: u32 = 300/.test(source) && /PROBE_IO_TIMEOUT_MS: u32 = 1200/.test(source));
  ok('#30 connect 改非阻塞（ioctlsocket FIONBIO，修前无界阻塞最长 ~21s）',
    /ioctlsocket\(sock, ws::FIONBIO/.test(source));
  ok('#30 connect 结果用 select 等待并同监听 exceptfds（RST 快速失败）',
    /FD_SET/.test(source) && /select\(0, std::ptr::null_mut\(\), &mut wfd, &mut efd/.test(source)
      && /efd\.fd_count > 0/.test(source));
  ok('#30 已连接后设置 SO_RCVTIMEO/SO_SNDTIMEO 读写兜底',
    /SO_RCVTIMEO/.test(source) && /SO_SNDTIMEO/.test(source));
  ok('#30 任何超时/错误按不可达处理（不 panic 不无限等）',
    /n <= 0 \|\| efd\.fd_count > 0 \|\| wfd\.fd_count == 0/.test(source));
  ok('#30 WSAStartup 只做一次（OnceLock，修前每 2s startup/cleanup）',
    /OnceLock<bool>/.test(source) && (source.match(/WSAStartup\(/g) || []).length === 1
      && !source.includes('WSACleanup'));
  ok('#30 APP 锁中毒降级（unwrap_or_else into_inner，不再 .ok() 静默哑掉）',
    /APP\.lock\(\)\s*\n?\s*\.unwrap_or_else\(\|e\| e\.into_inner\(\)\)/.test(source)
      && !/APP\.lock\(\)\.ok\(\)/.test(source));
  ok('#30 App 持有 saved_port 生效端口字段',
    /saved_port: u32/.test(source) && /let saved_port = load_port\(&settings_path\);/.test(source));
  ok('#30 探测使用已保存端口（不再读输入框当前文本）',
    /http_status_ok\(self\.saved_port as u16\)/.test(source) && !/fn port\(&self\)/.test(source));
  ok('#30 apply_port 保存成功后才切换生效端口',
    /self\.saved_port = port;/.test(source));
  ok('#30 --probe 无头模式（打印 ok/elapsedMs 供行为测试）',
    /--probe/.test(source) && /fn probe_headless/.test(source));
  ok('#30 未越界：日志增量/空 tail/WM_DPICHANGED/WM_CTLCOLORSTATIC 不改动',
    /LogPlan::Unchanged => return/.test(source) && /fn probe_headless/.test(source)
      && /CTL_STATUS_HWND/.test(source) && /WM_DPICHANGED/.test(source));
}

// ---- #41 CI 纳入真实 cargo 构建 + --pumpcheck 消息泵存活断言 ----
console.log('\n[#41] CI cargo 构建门 + --pumpcheck 消息泵存活（「活着但冻结」类缺陷的回归门）');
{
  ok('#41 --pumpcheck 无头模式存在', /--pumpcheck/.test(source) && /fn pumpcheck/.test(source));
  ok('#41 探测点 t=3s/6s（t=3s 晚于首个 2s WM_TIMER tick，否则抓不到 tick 诱发的死锁）',
    /3000u64, 6000u64/.test(source));
  ok('#41 跨线程 SendMessageTimeoutW(WM_NULL, SMTO_ABORTIFHUNG)',
    /SendMessageTimeoutW\(hwnd, 0/.test(source) && /SMTO_ABORTIFHUNG/.test(source));
  ok('#41 探测结果输出 PUMP=OK / PUMP=DEADLOCK', /PUMP=OK/.test(source) && /PUMP=DEADLOCK/.test(source));
  const wfPath = join(repo, '.github', 'workflows', 'windows.yml');
  const yml = existsSync(wfPath) ? readFileSync(wfPath, 'utf8') : '';
  ok('#41 windows.yml 有独立 windows-gui job（不拖慢 Node 侧 job）', /windows-gui:/.test(yml));
  ok('#41 CI 真实跑 cargo build --release', /cargo build --release/.test(yml));
  ok('#41 CI 构建产物后强制跑 gui.test.mjs', /gui\.test\.mjs/.test(yml));
  ok('#41 cargo 缓存（Swatinem/rust-cache）', /rust-cache@v2/.test(yml));
  const tcPath = join(repo, 'rust-toolchain.toml');
  ok('#41 rust 工具链版本固定（rust-toolchain.toml）',
    existsSync(tcPath) && /channel\s*=\s*["']?\d+\.\d+\.\d+/.test(readFileSync(tcPath, 'utf8')));
}

// ---- #54 WM_CTLCOLORSTATIC 取 APP 锁导致首个 2s tick 永久自锁死 ----
console.log('\n[#54] WM_CTLCOLORSTATIC 不得进 APP 锁（静态控件重绘同步回父窗口）');
{
  const arm = source.slice(source.indexOf('WM_CTLCOLORSTATIC =>'), source.indexOf('WM_CTLCOLOREDIT =>'));
  ok('#54 捕获到 WM_CTLCOLORSTATIC 分支', arm.includes('WM_CTLCOLORSTATIC =>') && arm.length > 0);
  ok('#54 处理器不调用 with_app（否则与持锁改文本的调用方互锁）', !arm.includes('with_app('), arm.slice(0, 200));
  ok('#54 颜色/句柄改由原子快照提供', /CTL_STATUS_HWND\.load|CTL_BG_BRUSH\.load/.test(arm));
  ok('#54 快照在 update_status 中先于改文本发布',
    /publish_ctl_snapshot\(/.test(source.slice(source.indexOf('fn update_status'), source.indexOf('fn refresh_log'))));
  ok('#54 WM_CREATE 也给出初值快照', /publish_ctl_snapshot\(status_label, log_header, bg_brush, false\)/.test(source));
  ok('#54 快照发布函数存在且写四个值',
    /fn publish_ctl_snapshot/.test(source) && (source.match(/\.store\(/g) || []).length >= 4);
}

// ---- #59：探测工作线程化（评审新发现缺陷：poll_status 在 APP 锁内 socket 阻塞
// 最长 1.5s，跨进程同步消息被持锁延迟——docs/evidence-33/DPI-INJECTION-RESULT.txt）----
console.log('\n[#59] 探测移出 APP 锁/UI 线程（同步消息不再被持锁阻塞）');
{
  ok('#59 探测在工作线程（WM_TIMER 分支 spawn + PROBE_INFLIGHT 防重入）',
    /WM_TIMER =>[\s\S]{0,600}thread::spawn/.test(source) && source.includes('PROBE_INFLIGHT'));
  ok('#59 探测完成经 PostMessage 回写（WM_APP_PROBE_RESULT）',
    /WM_APP_PROBE_RESULT/.test(source) && /PostMessageW\(hwnd_addr as HWND, WM_APP_PROBE_RESULT/.test(source));
  const timerArm = source.slice(source.indexOf('WM_TIMER =>'), source.indexOf('WM_APP_PROBE_RESULT =>'));
  ok('#59 WM_TIMER 探测在工作线程闭包内（不在 with_app 锁内）',
    timerArm.includes('thread::spawn') && /let online = http_status_ok\(port\)/.test(timerArm)
      && !/with_app\([^)]*\)[^;]*http_status_ok/.test(timerArm),
    timerArm.slice(0, 120));
  ok('#59 WM_TIMER 不再直接调 poll_status（已工作线程化）',
    !/poll_status\(\)/.test(timerArm));
}

// ---- #60：打包形态日志面板恒空（跨形态混用时无法诊断）----
console.log('\n[#60] 空态显示完整 tail 路径 + 多候选根探测（混用可诊断）');
{
  const ph60 = source.slice(source.indexOf('fn show_log_placeholder'), source.indexOf('fn refresh_log'));
  ok('#60 空态提示带完整日志路径（与 selfcheck 同源 log_path_for）',
    /EMPTY_LOG_TEXT/.test(ph60) && /log_path_for\(&root\)/.test(ph60) && /当前 tail 的日志路径/.test(ph60));
  const cand60 = source.slice(source.indexOf('fn candidate_data_roots'), source.indexOf('pub fn parse_port'));
  ok('#60 候选根 = 主根 + 源码形态运行目录；#89 后新旧两个名字都要在候选里',
    cand60.includes('fn candidate_data_roots') && /candidate_runtime_roots\(la\)/.test(cand60)
      && /RUNTIME_DIR_NAME,\s*LEGACY_SHARED_RUN_DIR_NAME/.test(source));
  ok('#60 App 记录备用根与实际 tail 来源字段',
    /alt_log_root: Option<PathBuf>/.test(source) && /log_source: Option<PathBuf>/.test(source));
  const refresh60 = source.slice(source.indexOf('fn refresh_log'), source.indexOf('fn poll_status'));
  ok('#60 主根无日志时探测备用根、切换 tail 并标明来源',
    /alt_log_root\.clone\(\)/.test(refresh60) && /log_source = Some\(alt\)/.test(refresh60)
      && /update_status\(\)/.test(refresh60));
  ok('#60 切换根时清空缓冲与游标（不静默合并 #34/#39 语义）',
    /log_buf\.clear\(\)/.test(refresh60) && /log_offset = 0/.test(refresh60) && /log_len = 0/.test(refresh60));
  const status60 = source.slice(source.indexOf('fn update_status'), source.indexOf('fn show_log_placeholder'));
  ok('#60 状态行标明实际日志根（数据目录≠日志根时不再误导）',
    /日志根：/.test(status60));
}
console.log('\n[behavioral] 已构建 exe 无头自检（中文+空格包布局）');
if (!existsSync(exe) && process.env.SKIP_GUI_ARTIFACT === '1') {
  // 仅限本地无 Rust 工具链时的显式放行（#41）：CI 与默认本地环境不得借此跳绿
  console.log('  [warn] SKIP_GUI_ARTIFACT=1 —— gui behavioral 显式放行跳过（无产物）');
} else if (!existsSync(exe)) {
  // #41：缺产物不再 skip 绿——754313c（#33）只改 GUI 且引入 P1 死锁时 CI 全绿的教训
  failed++;
  console.error('  ✗ 未找到 windows/gui/publish/TokenMonitorGui.exe —— 默认必须先构建产物：');
  console.error('         powershell -NoProfile -ExecutionPolicy Bypass -File windows/gui/build.ps1');
  console.error('         （仅限本地无 Rust 工具链时，可显式 SKIP_GUI_ARTIFACT=1 放行并视为跳过）');
} else {
  const base = mkdtempSync(join(tmpdir(), 'gui-启动器 测试-'));
  try {
    // 模拟打包布局：manifest.json + runtime\{node.exe, bin\tokenmonitor.js}
    const pkg = join(base, '包 目录');
    mkdirSync(join(pkg, 'runtime', 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'manifest.json'), JSON.stringify({ name: 'TokenMonitor', os: 'windows', arch: 'x64' }));
    writeFileSync(join(pkg, 'runtime', 'bin', 'tokenmonitor.js'), '// fake marker for resolution test\n');
    copyFileSync(exe, join(pkg, 'runtime', 'node.exe')); // 任意存在文件即可通过存在性检查

    const run = (envExtra, appRoot) => spawnSync(exe, appRoot ? ['--selfcheck', appRoot] : ['--selfcheck'], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, ...envExtra },
      windowsHide: true,
    });
    const parse = (out) => Object.fromEntries(String(out).split(/\r?\n/).filter((l) => l.includes('=')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }));

    const inPkg = run({}, pkg);
    ok('自检在打包布局 exit 0', inPkg.status === 0, `exit=${inPkg.status} ${String(inPkg.stderr).slice(0, 120)}`);
    const pkgInfo = parse(inPkg.stdout);
    ok('appRoot 识别为包根（中文+空格路径）', pkgInfo.appRoot === pkg, pkgInfo.appRoot);
    ok('dataRoot 落 <包根>\\data', pkgInfo.dataRoot === join(pkg, 'data'), pkgInfo.dataRoot);
    ok('后端解析到 runtime\\node.exe（新布局优先）', pkgInfo.backendExe === join(pkg, 'runtime', 'node.exe'), pkgInfo.backendExe);
    ok('日志路径在 data\\logs', pkgInfo.logPath === join(pkg, 'data', 'logs', 'tokenmonitor.log'), pkgInfo.logPath);
    ok('设置路径在 data\\gui-settings.json', pkgInfo.settingsPath === join(pkg, 'data', 'gui-settings.json'), pkgInfo.settingsPath);

    // 无清单场景：不带 appRoot 参数、从 exe 自身位置（publish 深处）向上检测 → 不误判打包形态，
    // 后端走开发树（PATH node + 仓库 bin，脚本名统一）
    const bare = run({}, null);
    const bareInfo = parse(bare.stdout);
    ok('无清单位置 appRoot=null', bareInfo.appRoot === '(null)', bareInfo.appRoot);
    ok('开发树回退：PATH node + 仓库 bin', bareInfo.backendExe === 'node' && /serve --port \{0\}/.test(bareInfo.backendArgsTemplate ?? ''), `${bareInfo.backendExe} | ${bareInfo.backendArgsTemplate}`);

    // env 覆盖优先级最高
    const forcedDir = join(base, '强制数据 目录');
    const forced = run({ TOKENMONITOR_DATA_DIR: forcedDir }, pkg);
    ok('env 覆盖优先于打包形态', parse(forced.stdout).dataRoot === forcedDir, parse(forced.stdout).dataRoot);
    // ---- #60: 打包 dataRoot 无 logs 目录 + 备用根探测（跨形态混用诊断）----
    console.log('\n[#60 mixed] 打包 dataRoot 无 logs 目录：自检标注主/备日志根');
    {
      // pkg 只建了 runtime\bin，data\logs 从未创建——正是任务报告的打包形态现场
      ok('#60 打包 dataRoot 无 logs 目录（场景成立）', !existsSync(join(pkg, 'data', 'logs')));
      ok('#60 自检 logPath 与 GUI 空态提示同源（同一 log_path_for(data_root)）',
        /当前 tail 的日志路径/.test(source)
          && pkgInfo.logPath === join(pkg, 'data', 'logs', 'tokenmonitor.log'),
        pkgInfo.logPath);
      const laRoot = join(process.env.LOCALAPPDATA || '', 'TokenMonitor');
      // #89 之后主根取决于本机 %LOCALAPPDATA% 里有没有旧版的历史日志，直接读真机环境
      // 会得到两种都算对的结果。改为注入两个隔离的 LOCALAPPDATA 沙箱，把两种情形都钉死。
      const la = mkdtempSync(join(tmpdir(), 'gui89-'));
      const laFresh = join(la, 'fresh');
      const laOld = join(la, 'old');
      mkdirSync(laFresh, { recursive: true });
      mkdirSync(join(laOld, 'TokenMonitor', 'logs'), { recursive: true });
      writeFileSync(join(laOld, 'TokenMonitor', 'logs', 'tokenmonitor.log'), '');
      const freshRoot = join(laFresh, 'TokenMonitor-Server');
      const oldShared = join(laOld, 'TokenMonitor');
      const freshInfo = parse(run({ LOCALAPPDATA: laFresh }, null).stdout);
      ok('#89 新机器（运行目录无旧版历史）：主根用新名字 TokenMonitor-Server',
        freshInfo.dataRoot === freshRoot, freshInfo.dataRoot);
      ok('#89 新机器仍把改名前的旧目录列为备用根（桌面版卸载后日志仍找得回来）',
        freshInfo.altDataRoot === join(laFresh, 'TokenMonitor'), freshInfo.altDataRoot);
      const oldInfo = parse(run({ LOCALAPPDATA: laOld }, null).stdout);
      ok('#89 老用户原地继续：主根仍是改名前的旧目录',
        oldInfo.dataRoot === oldShared, oldInfo.dataRoot);
      ok('#89 老用户的备用根是新名字目录',
        oldInfo.altDataRoot === join(laOld, 'TokenMonitor-Server'), oldInfo.altDataRoot);
      const pkg89 = parse(run({ LOCALAPPDATA: laFresh }, pkg).stdout);
      ok('#89 打包形态主根不受改名影响（仍是包内 data\\）',
        pkg89.dataRoot === join(pkg, 'data'), pkg89.dataRoot);
      ok('#89 打包形态备用根给出可切换的源码形态运行目录',
        pkg89.altDataRoot === freshRoot, pkg89.altDataRoot);
      rmSync(la, { recursive: true, force: true });
      ok('#60 源码形态主根即 runtimeDir（空态提示带完整路径 + §0 文档兜底诊断）',
        /log_path_for\(&root\)/.test(source) && bareInfo.dataRoot === laRoot,
        bareInfo.dataRoot + ' | ' + bareInfo.altDataRoot);
      ok('#60 env 覆盖主根时备用根仍指向某个源码形态运行目录',
        parse(forced.stdout).altDataRoot.startsWith(join(process.env.LOCALAPPDATA || '', 'TokenMonitor')),
        parse(forced.stdout).altDataRoot);
    }


    // ---- Part C: 进程常驻 + 单实例（#26 回归：重复互斥锁曾致窗体 Load 即 Close）----
    console.log('\n[stay-alive] GUI 进程常驻与单实例（#26 回归）');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

    const gui = spawn(exe, [], { stdio: 'ignore' });
    let guiExitedEarly = false;
    gui.on('exit', () => { if (!gui.killed) guiExitedEarly = true; });
    await sleep(4000);
    ok('GUI 进程 4 秒后仍存活（窗口不再自闭）', !guiExitedEarly && alive(gui.pid), guiExitedEarly ? 'exited early (#26 regression)' : `pid=${gui.pid}`);

    const second = spawn(exe, [], { stdio: 'ignore' });
    let secondExited = false;
    second.on('exit', () => { secondExited = true; });
    await sleep(2500);
    ok('第二实例立即退出（单实例语义保持）', secondExited);
    ok('第一实例不受影响', !guiExitedEarly && alive(gui.pid));

    gui.kill();
    await sleep(800);
    ok('关闭第一实例后退出干净', !alive(gui.pid));

    // ---- #34: 空闲期零文件 IO（日志无变化时不再每 2s 重读 1MB）----
    console.log('\n[#34 idle-io] 日志无变化时 GUI 空闲期文件读取增量（AC5 取证）');
    const idleDir = join(base, '空闲 IO 场景');
    mkdirSync(join(idleDir, 'logs'), { recursive: true });
    writeFileSync(join(idleDir, 'logs', 'tokenmonitor.log'), ('x'.repeat(120) + '\n').repeat(8700));
    const idle = spawn(exe, [], { stdio: 'ignore', env: { ...process.env, TOKENMONITOR_DATA_DIR: idleDir } });
    const readIO = (pid) => Number(
      spawnSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ReadTransferCount`],
        { encoding: 'utf8' }).stdout.trim() || 'NaN');
    await sleep(4000);
    const ioA = readIO(idle.pid);
    await sleep(6000);
    const ioB = readIO(idle.pid);
    idle.kill();
    const idleDelta = ioB - ioA;
    ok('#34 空闲 6 秒文件读取增量 < 200KB（修前同法实测 3,000,000 字节）',
      Number.isFinite(idleDelta) && idleDelta >= 0 && idleDelta < 200 * 1024, `delta=${idleDelta} bytes`);

    // ---- #30: --probe 无头探测（死端口按不可达快速退出；活端口 200 快速可达）----
    // 注意：活端口探测必须用 spawn 异步收集——spawnSync 会冻结本测试进程的事件循环，
    // 内建 http 服务器无法应答，造成"假超时"误判（#30 任务备注记录的实现期踩坑）。
    console.log('\n[#30 probe] 探测总耗时 ≤1.5s；死端口不冻结、活端口返回 ok=true');
    const probeRunAsync = (port) => new Promise((resolve) => {
      const started = Date.now();
      const p = spawn(exe, ['--probe', String(port)], { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { try { p.kill(); } catch { /* already gone */ } resolve({ status: null, out, ms: Date.now() - started }); }, 15000);
      p.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, out, ms: Date.now() - started }); });
    });
    const parseProbe = (out) => {
      const m = /ok=(true|false) elapsed_ms=(\d+)/.exec(String(out));
      return m ? { ok: m[1] === 'true', ms: Number(m[2]) } : null;
    };

    const deadPort = 59999; // 无监听端口：select 300ms 预算内按不可达退出（本机安全软件对未知 exe 的 SYN 静默 DROP，超时兜底正是正确语义）
    const dead = await probeRunAsync(deadPort);
    const deadInfo = parseProbe(dead.out);
    ok('#30 死端口探测 exit 1 且快速返回（≤1.5s 预算）',
      dead.status === 1 && deadInfo && !deadInfo.ok && deadInfo.ms <= 1500,
      `exit=${dead.status} ms=${dead.ms} out=${String(dead.out).slice(0, 60)}`);

    const livePort = 41000 + Math.floor(Math.random() * 10000);
    const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    await new Promise((r) => server.listen(livePort, '127.0.0.1', r));
    try {
      const live = await probeRunAsync(livePort);
      const liveInfo = parseProbe(live.out);
      ok('#30 活端口探测 exit 0、ok=true 且快速返回（≤1.5s 预算）',
        live.status === 0 && liveInfo && liveInfo.ok && liveInfo.ms <= 1500,
        `exit=${live.status} ms=${live.ms} out=${String(live.out).slice(0, 60)}`);
    } finally {
      server.close();
    }

    // ---- #41: --pumpcheck 消息泵存活（约 6.5s：两次探测各晚于 2s tick；spawnSync 阻塞本进程无妨）----
    console.log('\n[#41 pumpcheck] 消息泵存活（修前 #33 死锁：进程存活但完全不泵消息，旧断言抱不住）');
    const pc = spawnSync(exe, ['--pumpcheck'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const pumpOk = (String(pc.stdout).match(/PUMP=OK/g) || []).length;
    ok('#41 --pumpcheck exit 0 且两次 PUMP=OK',
      pc.status === 0 && pumpOk === 2, `exit=${pc.status} out=${String(pc.stdout).slice(0, 90)}`);
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* Windows 句柄延迟时容忍 */ }
  }
}

// ---- #59: 行为级 DPI 注入（Post 125% 真实处理路径 → 泵探活，评审 AC2）----
console.log('\n[#59 dpi-inject] WM_DPICHANGED Post 注入后消息泵仍存活');
{
  const sleepE = (ms) => new Promise((r) => setTimeout(r, ms));
  const gui = spawn(exe, [], { stdio: 'ignore' });
  await sleepE(2500);
  const psSrc = [
    '$src = @"',
    'using System; using System.Runtime.InteropServices;',
    'public class W59 {',
    '  [DllImport("user32.dll")] public static extern IntPtr FindWindowW([MarshalAs(UnmanagedType.LPWStr)] string cls, IntPtr win);',
    '  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, UIntPtr wp, IntPtr lp);',
    '  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, UIntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);',
    '}',
    '"@',
    'Add-Type -TypeDefinition $src',
    '$h = [W59]::FindWindowW("TokenMonitorGuiWnd", [IntPtr]::Zero)',
    'if ($h -eq [IntPtr]::Zero) { Write-Output "INJECT_PUMP=NO_WINDOW"; exit 1 }',
    '[W59]::PostMessageW($h, 0x02E0, [UIntPtr]::new([uint32](120 -bor (120 -shl 16))), [IntPtr]::Zero) | Out-Null',
    'Start-Sleep -Milliseconds 1000',
    '$res = [UIntPtr]::Zero',
    '$okr = [W59]::SendMessageTimeoutW($h, 0, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$res)',
    'Write-Output ("INJECT_PUMP=" + $(if ($okr -ne [IntPtr]::Zero) { "ALIVE" } else { "DEAD" }))',
  ]
  const psFile = join(tmpdir(), 'dpi59-inject.ps1');
  writeFileSync(psFile, psSrc.join('\r\n'), 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
    { encoding: 'utf8', timeout: 20000 });
  gui.kill();
  ok('#59 WM_DPICHANGED(125%) Post 注入后泵仍存活（探测已出 UI 线程/APP 锁）',
    String(r.stdout).includes('INJECT_PUMP=ALIVE'),
    'exit=' + r.status + ' out=' + String(r.stdout).slice(0, 80));
  try { rmSync(psFile, { force: true }); } catch { }
}

console.log(`\ngui test: ${passed} 项通过${failed ? `，FAILED ${failed}` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
