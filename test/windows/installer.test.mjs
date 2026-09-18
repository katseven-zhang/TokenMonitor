/**
 * Windows installer dry-run tests (#13 Win-Installer; layout v2 by #25).
 *
 * Runs scripts/install-windows.ps1 and scripts/uninstall-windows.ps1 entirely
 * inside temp roots (path contains spaces AND Chinese characters) and asserts
 * install / upgrade-rollback / uninstall / purge-data behavior against the
 * layout-v2 candidate (root TokenMonitor.exe + manifest.json + runtime\) with
 * portable data at <install>\data. The scheduled-task step is skipped so the
 * real Task Scheduler is never involved.
 *
 * Run: TOKENMONITOR_OFFLINE=1 node test/windows/installer.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/** Recursive copy file-by-file: fs.cpSync's directory mode trips some
 *  security software on this machine (process killed mid-copy), while plain
 *  per-file copies of the same tree pass fine. */
function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const INSTALL_PS1 = join(repo, 'scripts', 'install-windows.ps1');
const UNINSTALL_PS1 = join(repo, 'scripts', 'uninstall-windows.ps1');

let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failures.push(label); console.log('  ✗ ' + label); }
}

function runPs(script, args, { stdin = '' } = {}) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', input: stdin });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')) };
}

/** Minimal but REAL layout-v2 candidate: root manifest.json + TokenMonitor.exe
 *  (existence-checked only, so a small stand-in works) + runtime\ with a real
 *  node.exe and runnable --version. web/ 不能省：server.js 自 #16 起静态导入
 *  ../web/lib/theme.js（评审 4020427f187e46b4）。 */
function makeCandidate(root, version) {
  const cand = join(root, 'cand-' + version);
  mkdirSync(join(cand, 'runtime', 'bin'), { recursive: true });
  writeFileSync(join(cand, 'manifest.json'), JSON.stringify({ name: 'TokenMonitor', version, os: 'windows', arch: 'x64', layout: 2 }));
  writeFileSync(join(cand, 'TokenMonitor.exe'), 'fake-gui-exe-stand-in');
  cpSync(process.execPath, join(cand, 'runtime', 'node.exe'));
  copyFileSync(join(repo, 'bin', 'tokenmonitor.js'), join(cand, 'runtime', 'bin', 'tokenmonitor.js'));
  copyTree(join(repo, 'src'), join(cand, 'runtime', 'src'));
  copyTree(join(repo, 'web'), join(cand, 'runtime', 'web'));
  writeFileSync(join(cand, 'runtime', 'package.json'), JSON.stringify({ name: 'tokenmonitor', version, type: 'module' }));
  return cand;
}

function installedVersion(installDir) {
  const r = spawnSync(join(installDir, 'runtime', 'node.exe'),
    [join(installDir, 'runtime', 'bin', 'tokenmonitor.js'), '--version'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : 'exit=' + r.status;
}

// Temp root deliberately contains spaces AND Chinese characters.
const base = mkdtempSync(join(tmpdir(), 'installer-安装 测试-'));
const programsRoot = join(base, 'Programs');
const menuRoot = join(base, '开始菜单');
const desktopRoot = join(base, '桌面 文件夹');
const installDir = join(programsRoot, 'TokenMonitor');
const dataDir = join(installDir, 'data');
const dataKeep = join(programsRoot, 'TokenMonitor-data');
const dryRunArgs = ['-InstallRoot', programsRoot,
  '-StartMenuRoot', menuRoot, '-DesktopRoot', desktopRoot, '-SkipScheduledTask'];

try {
  const cand1 = makeCandidate(base, '1.0.0-test');

  console.log('[1] 首次安装（临时根目录，空格+中文路径，布局 v2）');
  {
    const r = runPs(INSTALL_PS1, ['-Source', cand1, ...dryRunArgs]);
    ok(r.code === 0, 'install exit 0');
    ok(existsSync(join(installDir, 'runtime', 'node.exe')) && existsSync(join(installDir, 'runtime', 'bin', 'tokenmonitor.js')), '运行库落到 runtime\\');
    ok(existsSync(join(installDir, 'TokenMonitor.exe')) && existsSync(join(installDir, 'manifest.json')), '根目录有 GUI exe 与 manifest.json');
    ok(installedVersion(installDir) === '1.0.0-test', '安装后 --version=1.0.0-test');
    ok(existsSync(join(menuRoot, 'TokenMonitor.lnk')), '开始菜单快捷方式已创建');
    ok(!existsSync(join(desktopRoot, 'TokenMonitor.lnk')), '未传 -DesktopShortcut 时不建桌面快捷方式');
    ok(existsSync(join(dataDir, 'logs')), '便携数据目录 data\\logs 已创建');
  }

  console.log('[2] 可选桌面快捷方式');
  {
    const r = runPs(INSTALL_PS1, ['-Source', cand1, ...dryRunArgs, '-DesktopShortcut']);
    ok(r.code === 0, '重复安装（升级路径）exit 0');
    ok(existsSync(join(desktopRoot, 'TokenMonitor.lnk')), '桌面快捷方式按需创建');
  }

  console.log('[3] 覆盖升级：data\\ 保留 + 版本替换');
  {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'pricing.json'), '{"seed":1}');
    writeFileSync(join(installDir, 'old-marker.txt'), 'old');
    const cand2 = makeCandidate(base, '2.0.0-test');
    const r = runPs(INSTALL_PS1, ['-Source', cand2, ...dryRunArgs]);
    ok(r.code === 0, 'upgrade exit 0');
    ok(installedVersion(installDir) === '2.0.0-test', '安装目录已是新版本 2.0.0-test');
    ok(!existsSync(join(installDir, 'old-marker.txt')), '旧程序文件被替换（marker 消失）');
    ok(!existsSync(programsRoot + '/TokenMonitor.old'), '验证通过后回滚副本已清理');
    ok(!existsSync(dataKeep), '升级过渡目录已归位');
    ok(readFileSync(join(dataDir, 'pricing.json'), 'utf8') === '{"seed":1}', 'data\\ 在升级后保留');
  }

  console.log('[4] 坏候选升级失败 → 回滚到旧版本，data\\ 不受影响');
  {
    const badCand = join(base, 'cand-broken');
    mkdirSync(join(badCand, 'runtime', 'bin'), { recursive: true });
    writeFileSync(join(badCand, 'manifest.json'), JSON.stringify({ name: 'TokenMonitor', os: 'windows' }));
    cpSync(join(repo, 'bin', 'tokenmonitor.js'), join(badCand, 'runtime', 'bin', 'tokenmonitor.js'));
    writeFileSync(join(badCand, 'runtime', 'package.json'), JSON.stringify({ name: 'tokenmonitor', version: '3.0.0-broken' }));
    const r = runPs(INSTALL_PS1, ['-Source', badCand, ...dryRunArgs]);
    ok(r.code !== 0, '坏候选安装失败非零退出');
    ok(installedVersion(installDir) === '2.0.0-test', '回滚后仍是 2.0.0-test（旧安装完好）');
    ok(existsSync(join(dataDir, 'pricing.json')), '失败升级不影响 data\\');
    ok(!existsSync(programsRoot + '/TokenMonitor.new'), '失败后暂存目录已清理');
  }

  console.log('[5] 卸载：程序删除，data\\ 移到 TokenMonitor-data 保留');
  {
    const r = runPs(UNINSTALL_PS1, dryRunArgs);
    ok(r.code === 0, 'uninstall exit 0');
    ok(!existsSync(installDir), '安装目录已删除');
    ok(existsSync(join(dataKeep, 'pricing.json')), 'data\\ 已移到 TokenMonitor-data 保留');
    ok(!existsSync(join(menuRoot, 'TokenMonitor.lnk')), '开始菜单快捷方式已删除');
    ok(!existsSync(join(desktopRoot, 'TokenMonitor.lnk')), '桌面快捷方式已删除');
    ok(r.out.includes('preserved'), '输出提示数据保留位置');
  }

  console.log('[6] purge-data 需要二次确认');
  {
    const r1 = runPs(UNINSTALL_PS1, [...dryRunArgs, '-PurgeData'], { stdin: '' });
    ok(r1.code !== 0, '无 -ConfirmPurge 且确认不匹配 → 非零退出');
    ok(existsSync(join(dataKeep, 'pricing.json')), '未确认时数据仍在');
    const r2 = runPs(UNINSTALL_PS1, [...dryRunArgs, '-PurgeData', '-ConfirmPurge']);
    ok(r2.code === 0, '-PurgeData -ConfirmPurge → exit 0');
    ok(!existsSync(dataKeep), '确认后保留的数据目录被删除');
  }

  console.log('[7] 删除路径守卫：拒绝盘符根 InstallRoot');
  {
    const driveRoot = process.cwd().slice(0, 3); // e.g. D:\
    mkdirSync(join(programsRoot, 'TokenMonitor', 'data'), { recursive: true });
    const r = runPs(UNINSTALL_PS1, ['-InstallRoot', driveRoot,
      '-PurgeData', '-ConfirmPurge', '-SkipScheduledTask']);
    ok(r.code !== 0, '盘符根作为 InstallRoot 被拒绝');
    ok(existsSync(join(programsRoot, 'TokenMonitor', 'data')), '守卫生效，未发生删除');
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\ninstaller test: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exit(1);
}
