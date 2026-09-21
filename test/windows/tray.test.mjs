/**
 * Windows tray tests (#9 Win-Tray).
 *
 * Observable, GUI-free evidence: the published self-contained exe runs from a
 * temp path containing spaces AND Chinese characters, enforces single
 * instance (second copy exits immediately, first keeps running), and exits
 * cleanly when killed. A missing artifact is a HARD failure (exit 1), not a
 * skip - the tray is native Rust Win32 since #32 and needs no .NET SDK, so
 * "CI green without the SDK" is no longer an available excuse. Skipping is
 * only possible by explicitly exporting SKIP_TRAY_ARTIFACT=1, and
 * test/run.mjs #67 asserts that no CI job does that.
 *
 * Run: TOKENMONITOR_OFFLINE=1 node test/windows/tray.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const exe = join(repo, 'windows', 'tray', 'publish', 'TokenMonitorTray.exe');

let passed = 0;
const failures = [];
function ok(cond, label, extra = '') {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label + (extra ? ' | ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// #32/#41：缺产物不再 skip 绿——默认报错失败；仅本地无工具链时显式 SKIP_TRAY_ARTIFACT=1 放行
if (!existsSync(exe) && process.env.SKIP_TRAY_ARTIFACT === '1') {
  console.log('[warn] SKIP_TRAY_ARTIFACT=1 —— tray behavioral 显式放行跳过（无产物）');
  console.log('tray test: skipped (artifact not built, explicitly allowed)');
  process.exit(0);
}
if (!existsSync(exe)) {
  console.log('  ✗ 未找到 windows/tray/publish/TokenMonitorTray.exe —— 默认必须先构建产物：');
  console.log('         powershell -NoProfile -ExecutionPolicy Bypass -File windows/tray/build.ps1');
  console.log('         （仅限本地无 Rust 工具链时，可显式 SKIP_TRAY_ARTIFACT=1 放行）');
  process.exit(1);
}

console.log('[0] 源码契约（Rust 原生实现，#32）');
{
  const source = readFileSync(join(repo, 'windows', 'tray', 'src', 'main.rs'), 'utf8');
  const okSrc = (cond, label, extra = '') => ok(cond, label, extra);
  okSrc(source.includes('MUTEX_NAME') && source.includes('TokenMonitorTray'), '单实例互斥常量（与 .NET 版同名 Local 命名空间）');
  okSrc(source.includes('Shell_NotifyIconW'), '托盘图标走 Shell_NotifyIconW（原生 Win32，无 .NET）');
  okSrc(/PROBE_CONNECT_TIMEOUT_MS: u32 = 700/.test(source) && /PROBE_IO_TIMEOUT_MS: u32 = 700/.test(source),
    '探测分级超时常量（总量 ≤1.5s，不无界阻塞）');
  okSrc(/ioctlsocket\(sock, ws::FIONBIO/.test(source), 'connect 非阻塞（select 等待）');
  okSrc(source.includes('POLL_INTERVAL_MS: u32 = 5000'), '约 5s 轮询 /api/status');
  okSrc(source.includes('重启后台') && source.includes('后台运行中（外部启动）') && source.includes('启动后台'),
    '菜单标签三态（对齐 .NET 版 StartRestartLabel）');
  okSrc(source.includes('为免误杀这里不重启'), '外部启动的后台不停止不重启（只管理自有）');
  okSrc(source.includes('--selfcheck') && source.includes('--probe'), '无头 --selfcheck / --probe 模式');
  // #58 评审发现的活缺陷回归门：SetTimer 投递 WM_TIMER，wnd_proc 必须处理它（修前只处理 WM_APP_POLL → 定时器 tick 永不触发）
  okSrc(/wm::WM_TIMER => \{[\s\S]{0,80}poll_once\(\);/.test(source), 'WM_TIMER 分支存在并触发 poll_once（定时器接线）');
  okSrc(source.includes('--pollcheck'), '--pollcheck 无头轮询自检模式');
  okSrc(!existsSync(join(repo, 'windows', 'tray', 'Program.cs'))
    && !existsSync(join(repo, 'windows', 'tray', 'TokenMonitorTray.csproj')), '.NET 版已删除（csproj/Program.cs）');

  // #58 行为级轮询断言：--pollcheck 在 5.5s 内应被定时器 tick 多次驱动（≥2 = 接线正常；断裂时恒为 1）
  {
    const pc = spawnSync(exe, ['--pollcheck'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const m = /POLLCHECK=(\d+)/.exec(String(pc.stdout));
    const n = m ? Number(m[1]) : 0;
    ok(pc.status === 0 && n >= 2, '--pollcheck 轮询接线（首轮 + 定时器 tick 均驱动 poll_once）',
      `exit=${pc.status} POLLCHECK=${n}`);
  }
}

console.log('[1] 中文+空格路径下运行自包含单文件');
// Temp path deliberately contains spaces AND Chinese characters.
const base = mkdtempSync(join(tmpdir(), 'tray-托盘 测试-'));
const exeCopy = join(base, '托盘 目录', 'TokenMonitorTray.exe');
mkdirIfMissing(dirname(exeCopy));
copyFileSync(exe, exeCopy);

function mkdirIfMissing(dir) {
  spawnSync('powershell', ['-NoProfile', '-Command', `New-Item -ItemType Directory -Path '${dir}' -Force | Out-Null`]);
}

const first = spawn(exeCopy, ['--port', '18931'], { stdio: 'ignore' });
await sleep(3000);
ok(alive(first.pid), '托盘进程在中文+空格路径下稳定运行');

console.log('[2] 单实例：第二个实例立即退出，不出现多个图标');
const second = spawn(exeCopy, ['--port', '18931'], { stdio: 'ignore' });
let secondExited = false;
second.on('exit', () => { secondExited = true; });
await sleep(6000);
ok(secondExited, '第二实例自动退出');
ok(alive(first.pid), '第一实例不受影响，图标唯一');

console.log('[3] 退出清理');
first.kill();
await sleep(2500);
ok(!alive(first.pid), '进程可正常终止，无残留');

rmSync(base, { recursive: true, force: true });

console.log(`\ntray test: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exit(1);
}
