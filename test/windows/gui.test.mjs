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
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* Windows 句柄延迟时容忍 */ }
  }
}

console.log(`\ngui test: ${passed} 项通过${failed ? `，FAILED ${failed}` : '，全部通过'}`);
process.exit(failed ? 1 : 0);
