/**
 * Windows installer dry-run tests (#13 Win-Installer).
 *
 * Runs scripts/install-windows.ps1 and scripts/uninstall-windows.ps1 entirely
 * inside temp roots (path contains spaces AND Chinese characters) and asserts
 * install / upgrade-rollback / uninstall / purge-data behavior without
 * touching the real user profile. The scheduled-task step is skipped so the
 * real Task Scheduler is never involved.
 *
 * Run: TOKENMETER_OFFLINE=1 node test/windows/installer.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
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

/** Minimal but REAL candidate: node.exe + bin + src + web + package.json (--version works).
 *  web/ 不能省：server.js 自 #16 起静态导入 ../web/lib/theme.js（评审 4020427f187e46b4）。 */
function makeCandidate(root, version) {
  const cand = join(root, 'cand-' + version);
  mkdirSync(join(cand, 'bin'), { recursive: true });
  cpSync(process.execPath, join(cand, 'node.exe'));
  copyFileSync(join(repo, 'bin', 'tokenwatcher.js'), join(cand, 'bin', 'tokenwatcher.js'));
  copyTree(join(repo, 'src'), join(cand, 'src'));
  copyTree(join(repo, 'web'), join(cand, 'web'));
  writeFileSync(join(cand, 'package.json'), JSON.stringify({ name: 'token-watcher', version, type: 'module' }));
  return cand;
}

function installedVersion(installDir) {
  const r = spawnSync(join(installDir, 'node.exe'),
    [join(installDir, 'bin', 'tokenwatcher.js'), '--version'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : 'exit=' + r.status;
}

// Temp root deliberately contains spaces AND Chinese characters.
const base = mkdtempSync(join(tmpdir(), 'installer-安装 测试-'));
const programsRoot = join(base, 'Programs');
const dataRoot = join(base, 'Data');
const menuRoot = join(base, '开始菜单');
const desktopRoot = join(base, '桌面 文件夹');
const installDir = join(programsRoot, 'TokenMonitor');
const dataDir = join(dataRoot, 'TokenMonitor');
const dryRunArgs = ['-InstallRoot', programsRoot, '-DataRoot', dataRoot,
  '-StartMenuRoot', menuRoot, '-DesktopRoot', desktopRoot, '-SkipScheduledTask'];

try {
  const cand1 = makeCandidate(base, '1.0.0-test');

  console.log('[1] 首次安装（临时根目录，空格+中文路径）');
  {
    const r = runPs(INSTALL_PS1, ['-Source', cand1, ...dryRunArgs]);
    ok(r.code === 0, 'install exit 0');
    ok(existsSync(join(installDir, 'node.exe')) && existsSync(join(installDir, 'bin', 'tokenwatcher.js')), '程序文件落到安装目录');
    ok(installedVersion(installDir) === '1.0.0-test', '安装后 --version=1.0.0-test');
    ok(existsSync(join(menuRoot, 'TokenMonitor.lnk')), '开始菜单快捷方式已创建');
    ok(!existsSync(join(desktopRoot, 'TokenMonitor.lnk')), '未传 -DesktopShortcut 时不建桌面快捷方式');
    ok(existsSync(dataDir), '数据目录已创建');
  }

  console.log('[2] 可选桌面快捷方式');
  {
    const r = runPs(INSTALL_PS1, ['-Source', cand1, ...dryRunArgs, '-DesktopShortcut']);
    ok(r.code === 0, '重复安装（升级路径）exit 0');
    ok(existsSync(join(desktopRoot, 'TokenMonitor.lnk')), '桌面快捷方式按需创建');
  }

  console.log('[3] 覆盖升级：数据保留 + 版本替换');
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
    ok(readFileSync(join(dataDir, 'pricing.json'), 'utf8') === '{"seed":1}', '数据目录在升级后保留');
  }

  console.log('[4] 坏候选升级失败 → 回滚到旧版本');
  {
    const badCand = join(base, 'cand-broken');
    mkdirSync(join(badCand, 'bin'), { recursive: true });
    cpSync(join(repo, 'bin', 'tokenwatcher.js'), join(badCand, 'bin', 'tokenwatcher.js'));
    writeFileSync(join(badCand, 'package.json'), JSON.stringify({ name: 'token-watcher', version: '3.0.0-broken' }));
    const r = runPs(INSTALL_PS1, ['-Source', badCand, ...dryRunArgs]);
    ok(r.code !== 0, '坏候选安装失败非零退出');
    ok(installedVersion(installDir) === '2.0.0-test', '回滚后仍是 2.0.0-test（旧安装完好）');
    ok(existsSync(join(dataDir, 'pricing.json')), '失败升级不影响数据');
    ok(!existsSync(programsRoot + '/TokenMonitor.new'), '失败后暂存目录已清理');
  }

  console.log('[5] 卸载：只删程序与快捷方式，默认保留数据');
  {
    const r = runPs(UNINSTALL_PS1, dryRunArgs);
    ok(r.code === 0, 'uninstall exit 0');
    ok(!existsSync(installDir), '安装目录已删除');
    ok(!existsSync(join(menuRoot, 'TokenMonitor.lnk')), '开始菜单快捷方式已删除');
    ok(!existsSync(join(desktopRoot, 'TokenMonitor.lnk')), '桌面快捷方式已删除');
    ok(existsSync(join(dataDir, 'pricing.json')), '默认保留用户数据');
    ok(r.out.includes('preserved'), '输出提示数据保留位置');
  }

  console.log('[6] purge-data 需要二次确认');
  {
    const r1 = runPs(UNINSTALL_PS1, [...dryRunArgs, '-PurgeData'], { stdin: '' });
    ok(r1.code !== 0, '无 -ConfirmPurge 且确认不匹配 → 非零退出');
    ok(existsSync(join(dataDir, 'pricing.json')), '未确认时数据仍在');
    const r2 = runPs(UNINSTALL_PS1, [...dryRunArgs, '-PurgeData', '-ConfirmPurge']);
    ok(r2.code === 0, '-PurgeData -ConfirmPurge → exit 0');
    ok(!existsSync(dataDir), '确认后数据目录被删除');
  }

  console.log('[7] 删除路径守卫：拒绝盘符根 DataRoot');
  {
    const driveRoot = process.cwd().slice(0, 3); // e.g. D:\
    mkdirSync(join(dataRoot, 'TokenMonitor'), { recursive: true });
    const r = runPs(UNINSTALL_PS1, ['-InstallRoot', programsRoot, '-DataRoot', driveRoot,
      '-PurgeData', '-ConfirmPurge', '-SkipScheduledTask']);
    ok(r.code !== 0, '盘符根作为 DataRoot 被拒绝');
    ok(existsSync(join(dataRoot, 'TokenMonitor')), '守卫生效，未发生删除');
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\ninstaller test: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exit(1);
}
