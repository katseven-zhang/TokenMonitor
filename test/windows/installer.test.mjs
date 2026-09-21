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
import { spawn, spawnSync } from 'node:child_process';
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

  console.log('[4b] 后台运行中：升级/卸载给出明确中文提示且不动 data\（#31，真实 serve 写锁）');
  {
    mkdirSync(dataDir, { recursive: true });
    // #58 评审整改：锁文件必须由生产路径写出——起真实 serve（TOKENMONITOR_DATA_DIR
    // 指向本场景 data\），其启动即写 tokenmonitor-<port>.lock（含 PID）
    const serveEnv = { ...process.env, TOKENMONITOR_DATA_DIR: dataDir, HOME: base, USERPROFILE: base };
    const serve = spawn(process.execPath,
      ['--disable-warning=ExperimentalWarning', join(repo, 'bin', 'tokenmonitor.js'), 'serve', '--port', '18877'],
      { env: serveEnv, stdio: 'ignore' });
    let lockName = null;
    for (let i = 0; i < 60 && !lockName; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const hit = readdirSync(dataDir).filter((n) => n.startsWith('tokenmonitor-') && n.endsWith('.lock'));
        if (hit.length) lockName = hit[0];
      } catch { /* dir not ready */ }
    }
    ok(!!lockName, 'serve 生产路径写出 tokenmonitor-<port>.lock（含 PID）');
    if (!lockName) {
      try { serve.kill(); } catch { /* already gone */ }
    } else {
      const candRun = makeCandidate(base, '2.1.0-test');
      const rUp = runPs(INSTALL_PS1, ['-Source', candRun, ...dryRunArgs]);
      ok(rUp.code !== 0, '后台运行中升级 → 非零退出');
      ok(rUp.out.includes('请先停止后台'), '升级给出明确中文提示');
      ok(installedVersion(installDir) === '2.0.0-test', '安装目录未被替换（data 未动）');
      const rUn = runPs(UNINSTALL_PS1, dryRunArgs);
      ok(rUn.code !== 0, '后台运行中卸载 → 非零退出');
      ok(rUn.out.includes('请先停止后台'), '卸载给出明确中文提示');
      ok(existsSync(dataDir), '卸载未做破坏性操作（data 仍在）');
      serve.kill();
      // 进程退出后锁由 exit 钩子清理（或 PID 不存活被守卫容错放行）
      for (let i = 0; i < 20; i++) {
        if (!existsSync(join(dataDir, lockName))) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    // 损坏 JSON 容错：视为无运行实例（守卫自身的容错语义，独立于生产写锁路径）
    writeFileSync(join(dataDir, 'tokenmonitor-9999.lock'), 'not-json{{{ broken');
    const rFix = runPs(INSTALL_PS1, ['-Source', makeCandidate(base, '2.2.0-test'), ...dryRunArgs]);
    ok(rFix.code === 0, '损坏锁文件视为无运行实例（升级照常 exit 0）');
    ok(installedVersion(installDir) === '2.2.0-test', '损坏锁场景升级后版本 2.2.0-test');
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
  console.log('[8] #100(a) 任务计划步骤演练：默认机器（无任务）也必须走完卸载');
  {
    // 破坏性的 schtasks 删除步骤用 %TEMP% 里的替身命令演练，绝不调用真实任务计划。
    const schAbsent = join(base, 'fake-schtasks-absent.cmd');
    const schDenied = join(base, 'fake-schtasks-denied.cmd');
    const schOk = join(base, 'fake-schtasks-ok.cmd');
    writeFileSync(schAbsent, '@echo off\r\necho ERROR: The system cannot find the file specified. 1>&2\r\nexit /b 1\r\n');
    writeFileSync(schDenied, '@echo off\r\necho ERROR: Access is denied. 1>&2\r\nexit /b 1\r\n');
    writeFileSync(schOk, '@echo off\r\necho SUCCESS: The scheduled task was successfully deleted.\r\nexit /b 0\r\n');

    const p8 = join(base, 'root8', 'Programs');
    const install8 = join(p8, 'TokenMonitor');
    const args8 = ['-InstallRoot', p8, '-StartMenuRoot', join(base, 'root8', '菜单'), '-DesktopRoot', join(base, 'root8', '桌面')];
    const cand8 = makeCandidate(base, '8.0.0-test');
    const rSetup = runPs(INSTALL_PS1, ['-Source', cand8, ...args8, '-SkipScheduledTask']);
    ok(rSetup.code === 0, '8 演练环境就绪（先按老路装一份，-SkipScheduledTask）');
    mkdirSync(join(install8, 'data'), { recursive: true });
    writeFileSync(join(install8, 'data', 'keep.txt'), 'DATA8');

    // A) 真实的删除失败（拒绝访问）必须中止，且中止发生在任何删除之前
    const rA = runPs(UNINSTALL_PS1, [...args8, '-SchtasksExe', schDenied]);
    ok(rA.code !== 0 && /Access is denied/.test(rA.out),
      'A 任务删除被拒绝 → 非零退出并带出 schtasks 原文');
    ok(existsSync(join(install8, 'runtime', 'node.exe')) && readFileSync(join(install8, 'data', 'keep.txt'), 'utf8') === 'DATA8',
      'A 中止发生在第 1 步：安装目录与 data 完好');

    // B) 默认机器（任务不存在）：修前 2>&1 + EAP=Stop 抛 NativeCommandError，整段卸载在第 1 步中止
    const rB = runPs(UNINSTALL_PS1, [...args8, '-SchtasksExe', schAbsent]);
    ok(rB.code === 0 && /not present/.test(rB.out),
      'B 任务本就不存在 → 卸载继续并 exit 0（#100a 回归）');
    ok(!existsSync(install8) && existsSync(join(p8, 'TokenMonitor-data', 'keep.txt'))
      && readFileSync(join(p8, 'TokenMonitor-data', 'keep.txt'), 'utf8') === 'DATA8',
      'B 卸载真的做完了：安装目录已删，data 移到 TokenMonitor-data 保留');

    // C) 任务存在且删除成功（先清掉 B 留下的保留目录，否则卸载会被双 data 守卫拦下）
    rmSync(join(p8, 'TokenMonitor-data'), { recursive: true, force: true });
    const rC1 = runPs(INSTALL_PS1, ['-Source', cand8, ...args8, '-SkipScheduledTask']);
    ok(rC1.code === 0, 'C 重装以便验证删除成功的分支');
    const rC = runPs(UNINSTALL_PS1, [...args8, '-SchtasksExe', schOk]);
    ok(rC.code === 0 && /removed scheduled task TokenMonitor-Server/.test(rC.out),
      'C 任务删除成功 → exit 0 且报告 removed scheduled task');
  }

  console.log('[9] #100(b) 升级后验证失败：用户数据绝不进入删除范围');
  {
    // 该分支在真机上由 SRP/EDPA 拦掉安装目录里的 node.exe 触发，沙箱里无法自然复现，
    // 因此对脚本副本注入"唯一一处"验证失败，其余控制流与真实脚本完全一致。
    const p9 = join(base, 'root9', 'Programs');
    const menu9 = join(base, 'root9', '菜单');
    const desk9 = join(base, 'root9', '桌面');
    const install9 = join(p9, 'TokenMonitor');
    const args9 = ['-InstallRoot', p9, '-StartMenuRoot', menu9, '-DesktopRoot', desk9];
    const needle = "if ($LASTEXITCODE -ne 0) { Fail 'post-install verification failed for the upgraded install' }";
    const src = readFileSync(INSTALL_PS1, 'utf8');
    ok(src.includes(needle), '注入点仍在（升级后验证失败那一处 Fail）');
    const injected = join(base, 'install-injected.ps1');
    writeFileSync(injected, src.replace(needle, "if ($true) { Fail 'injected: post-upgrade verification failed' }"));

    const r0 = runPs(INSTALL_PS1, ['-Source', makeCandidate(base, '9.0.0-test'), ...args9]);
    ok(r0.code === 0, '9 基线安装 exit 0');
    mkdirSync(join(install9, 'data'), { recursive: true });
    writeFileSync(join(install9, 'data', 'wallet.json'), '{"balance":42}');

    const r = runPs(injected, ['-Source', makeCandidate(base, '10.0.0-test'), '-Repo', repo, ...args9]);
    ok(r.code !== 0, '验证失败 → 非零退出');
    ok(existsSync(join(install9, 'data', 'wallet.json'))
      && readFileSync(join(install9, 'data', 'wallet.json'), 'utf8') === '{"balance":42}',
      'data\\wallet.json 未被删除（修前此文件连同新目录一起被 Remove-Item -Recurse 抹掉）');
    ok(installedVersion(install9) === '9.0.0-test'
      && !existsSync(join(p9, 'TokenMonitor.new')) && !existsSync(join(p9, 'TokenMonitor.old')),
      '回滚到旧版本 9.0.0-test 且没有残留 .new/.old');
    ok(!existsSync(join(p9, 'TokenMonitor-data')), '数据不在过渡目录里（已归位，不留 TokenMonitor-data）');
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\ninstaller test: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exit(1);
}
