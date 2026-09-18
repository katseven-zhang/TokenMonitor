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
  ok('源码默认 %LOCALAPPDATA%\\TokenMonitor', /join\("TokenMonitor"\)/.test(source));
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
console.log('\n[behavioral] 已构建 exe 无头自检（中文+空格包布局）');
if (!existsSync(exe)) {
  console.log('  [skip] 未找到 windows/gui/publish/TokenMonitorGui.exe —— 先执行：');
  console.log('         powershell -NoProfile -ExecutionPolicy Bypass -File windows/gui/build.ps1');
  console.log('  gui behavioral: skipped (artifact not built)');
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
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* Windows 句柄延迟时容忍 */ }
  }
}

console.log(`\ngui test: ${passed} 项通过${failed ? `，FAILED ${failed}` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
