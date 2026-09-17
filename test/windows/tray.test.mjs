/**
 * Windows tray tests (#9 Win-Tray).
 *
 * Observable, GUI-free evidence: the published self-contained exe runs from a
 * temp path containing spaces AND Chinese characters, enforces single
 * instance (second copy exits immediately, first keeps running), and exits
 * cleanly when killed. If the artifact has not been built yet, the suite
 * skips with a note (CI green without the .NET SDK).
 *
 * Run: TOKENMETER_OFFLINE=1 node test/windows/tray.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
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

if (!existsSync(exe)) {
  console.log('[skip] 未找到 windows/tray/publish/TokenMonitorTray.exe —— 先执行：');
  console.log('       powershell -NoProfile -ExecutionPolicy Bypass -File windows/tray/build.ps1');
  console.log('tray test: skipped (artifact not built)');
  process.exit(0);
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
