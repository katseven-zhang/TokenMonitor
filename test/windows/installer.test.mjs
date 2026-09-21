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
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else {
    failures.push(label);
    console.log('  ✗ ' + label + (detail === undefined ? '' : '\n      ' + String(detail).replace(/\n/g, '\n      ')));
  }
}

function runPs(script, args, { stdin = '' } = {}) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', input: stdin });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')) };
}

/** All files under root, POSIX-relative, manifest.json excluded (it cannot hash itself). */
function packageFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out
    .map((p) => ({ abs: p, rel: p.slice(root.length + 1).replace(/\\/g, '/') }))
    .filter((f) => f.rel !== 'manifest.json')
    .sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return ['<unreadable>']; }
}

/** Minimal but REAL layout-v2 candidate: root manifest.json + TokenMonitor.exe
 *  (existence-checked only, so a small stand-in works) + runtime\ with a real
 *  node.exe and runnable --version. web/ 不能省：server.js 自 #16 起静态导入
 *  ../web/lib/theme.js（评审 4020427f187e46b4）。
 *  #101：manifest 的 files[] SHA-256 清单现在真的被安装器消费了，所以夹具必须写出
 *  真实哈希——否则夹具本身就是一个"装不出来的假包"。清单最后写，且不含自身。 */
function makeCandidate(root, version) {
  const cand = join(root, 'cand-' + version);
  mkdirSync(join(cand, 'runtime', 'bin'), { recursive: true });
  writeFileSync(join(cand, 'TokenMonitor.exe'), 'fake-gui-exe-stand-in');
  cpSync(process.execPath, join(cand, 'runtime', 'node.exe'));
  copyFileSync(join(repo, 'bin', 'tokenmonitor.js'), join(cand, 'runtime', 'bin', 'tokenmonitor.js'));
  copyTree(join(repo, 'src'), join(cand, 'runtime', 'src'));
  copyTree(join(repo, 'web'), join(cand, 'runtime', 'web'));
  writeFileSync(join(cand, 'runtime', 'package.json'), JSON.stringify({ name: 'tokenmonitor', version, type: 'module' }));
  const files = packageFiles(cand).map((f) => ({ path: f.rel, bytes: statSync(f.abs).size, sha256: sha256File(f.abs) }));
  writeFileSync(join(cand, 'manifest.json'), JSON.stringify({
    name: 'TokenMonitor', version, os: 'windows', arch: 'x64', layout: 2, fileCount: files.length, files,
  }));
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
    ok(r0.code === 0, '9 基线安装 exit 0', r0.out.slice(-500));
    mkdirSync(join(install9, 'data'), { recursive: true });
    writeFileSync(join(install9, 'data', 'wallet.json'), '{"balance":42}');

    const r = runPs(injected, ['-Source', makeCandidate(base, '10.0.0-test'), '-Repo', repo, ...args9]);
    ok(r.code !== 0, '验证失败 → 非零退出', r.out.slice(-500));
    // 失败时打印脚本输出尾部与现场目录：回滚路径若被文件占用打断（本机 AV 有先例），
    // ERROR 行里的文件名就是打断点，别把归因留给猜。
    const scene = () => 'r.out tail: ' + r.out.slice(-600) + '\np9: ' + safeReaddir(p9).join(', ');
    ok(existsSync(join(install9, 'data', 'wallet.json'))
      && readFileSync(join(install9, 'data', 'wallet.json'), 'utf8') === '{"balance":42}',
      'data\\wallet.json 未被删除（修前此文件连同新目录一起被 Remove-Item -Recurse 抹掉）', scene());
    ok(installedVersion(install9) === '9.0.0-test'
      && !existsSync(join(p9, 'TokenMonitor.new')) && !existsSync(join(p9, 'TokenMonitor.old')),
      '回滚到旧版本 9.0.0-test 且没有残留 .new/.old', scene());
    ok(!existsSync(join(p9, 'TokenMonitor-data')), '数据不在过渡目录里（已归位，不留 TokenMonitor-data）', scene());
  }

  /* ---------- [10] #101：清单哈希终于有了消费方；占用中的安装树不再被删一半 ---------- */
  console.log('\n[10] #101 manifest SHA-256 消费方 + 安装树占用守卫');
  {
    const p10 = join(base, 'root10', 'Programs');
    const a10 = ['-InstallRoot', p10, '-StartMenuRoot', join(base, 'root10', '菜单'), '-DesktopRoot', join(base, 'root10', '桌面')];
    const install10 = join(p10, 'TokenMonitor');

    // (a) 内容与清单不符：必须拒装，且一个文件都不落地
    const tampered = makeCandidate(base, '11.0.0-test');
    appendFileSync(join(tampered, 'runtime', 'src', 'config.js'), '\n// silently edited after hashing\n');
    const rTamper = runPs(INSTALL_PS1, ['-Source', tampered, '-Repo', repo, ...a10]);
    ok(rTamper.code !== 0, '#101 内容被改过的包拒装（非零退出）', `code=${rTamper.code}`);
    ok(/SHA-256 mismatch/i.test(rTamper.out) && /runtime\/src\/config\.js/.test(rTamper.out),
      '#101 拒装原因点名 SHA-256 与具体文件', rTamper.out.slice(-400));
    ok(!existsSync(install10), '#101 拒装发生在写入之前：安装目录根本没建', install10);

    // (b) 清单里没有的文件混进包里 → 同样拒装（否则等于允许装来路不明的内容）
    const smuggled = makeCandidate(base, '12.0.0-test');
    writeFileSync(join(smuggled, 'runtime', 'unexpected.js'), 'module.exports = 1');
    const rExtra = runPs(INSTALL_PS1, ['-Source', smuggled, '-Repo', repo, ...a10]);
    ok(rExtra.code !== 0 && /not in manifest/.test(rExtra.out), '#101 清单未登记的文件也拒装', rExtra.out.slice(-400));
    ok(/unexpected\.js/.test(rExtra.out), '#101 点名那个未登记的文件', rExtra.out.slice(-300));

    // (c) 清单没有 files[] —— "干脆不写哈希" 不能成为绕过校验的办法
    const bare = makeCandidate(base, '13.0.0-test');
    writeFileSync(join(bare, 'manifest.json'), JSON.stringify({ name: 'TokenMonitor', version: '13.0.0-test', os: 'windows', arch: 'x64', layout: 2 }));
    const rBare = runPs(INSTALL_PS1, ['-Source', bare, '-Repo', repo, ...a10]);
    ok(rBare.code !== 0 && /no files\[\] hash list/.test(rBare.out), '#101 无哈希清单的包拒装，并说明要重建', rBare.out.slice(-400));

    // (d) 完好无损的包照常装成 —— 上面三条不是把安装整体弄坏
    const good = makeCandidate(base, '14.0.0-test');
    const rGood = runPs(INSTALL_PS1, ['-Source', good, '-Repo', repo, ...a10]);
    ok(rGood.code === 0, '#101 校验通过的包正常安装', rGood.out.slice(-400));
    ok(/integrity verified: \d+ files/.test(rGood.out) && !/integrity verified: 0 files/.test(rGood.out),
      '#101 安装日志报告了实际校验过的文件数', rGood.out.slice(-400));

    // (e) 占用守卫：静态断言，绝不真起进程（本机有真实安装在跑，不许碰）
    {
      const instSrc = readFileSync(INSTALL_PS1, 'utf8');
      const uninsSrc = readFileSync(UNINSTALL_PS1, 'utf8');
      for (const [label, src] of [['安装器', instSrc], ['卸载器', uninsSrc]]) {
        // 主执行流程 = 顶层 try 块中真正开始干活的那一个（首行即 Assert-BackendStopped）。
        // 不能锚"第一个 ^try {"：清单校验块 (#101) 也是一个顶层 try，从它切会
        // 把 Remove-InstallTree 的函数定义体当成"第一处递归删除"。
        const flowStart = src.search(/^try \{\r?\n\s*Assert-BackendStopped/m);
        ok(flowStart > -1, `#101 ${label} 主流程 try 块可定位`);
        const flow = src.slice(flowStart);
        ok(/function Assert-InstallTreeIdle/.test(src) && /Assert-InstallTreeIdle\b/.test(flow),
          `#101 ${label} 有安装树占用守卫且在主流程被调用`);
        const guardCall = flow.search(/^\s*Assert-InstallTreeIdle\b/m);
        const firstDelete = flow.search(/Remove-InstallTree -Path|Remove-Item -LiteralPath \$(staging|backup|full) -Recurse/);
        ok(guardCall > -1 && firstDelete > -1 && guardCall < firstDelete,
          `#101 ${label} 的占用检查在任何递归删除之前`, `guard=${guardCall} firstDelete=${firstDelete}`);
        const guardDef = src.search(/function Assert-InstallTreeIdle/);
        ok(!/Stop-Process|taskkill|\bKill\(/.test(src.slice(guardDef, src.indexOf('\n}', guardDef))),
          `#101 ${label} 只报告不杀进程（守卫里没有 Stop-Process/Kill/taskkill）`);
      }
      ok(/install tree is in use by/.test(instSrc) && /install tree is in use by/.test(uninsSrc),
        '#101 占用守卫说的是"停不掉就别删"，不是静默跳过删除');
    }

    // (f) 打包器不再静默装旧 exe
    {
      const buildSrc = readFileSync(join(repo, 'scripts', 'build-windows.ps1'), 'utf8');
      ok(/function Get-NewestSourceWrite/.test(buildSrc) && /stale \(newest source/.test(buildSrc),
        '#101 build-windows.ps1 按源码时间判定 publish 产物是否过期');
      ok((buildSrc.match(/Resolve-PublishedExe/g) || []).length === 3,
        '#101 GUI 与托盘两个产物走同一条过期即重建的路径'); // 1 定义 + 2 调用
      ok(/\$rel -match '\^\(publish\|target\)/.test(buildSrc),
        '#101 过期判定排除 publish\\ 与 target\\（否则 exe 永远比自身新）');
      ok(!/-not \(Test-Path -LiteralPath \$guiExe\)/.test(buildSrc),
        '#101 打包器不再保留"只在缺失时才构建"的旧分支');
      // 清单的生产方与消费方枚举口径必须一致：消费方 (install-windows.ps1) 用
      // -Force 扫描未登记文件，生产方若不带 -Force，一个隐藏的合法文件会让
      // 完整构建的包在安装时被误拒。
      ok(/Get-ChildItem -LiteralPath \$dist -Recurse -File -Force/.test(buildSrc),
        '#101 manifest 的文件枚举与安装器的校验枚举同用 -Force');
    }

    // (g) 占用守卫的正向分支演练：静态断言只能证明"代码在那儿"，证明不了它会拦。
    // 这里从 %TEMP% 沙箱安装树里真起一个改名的 node.exe（进程名即 TokenMonitor.exe），
    // 卸载与安装都必须停下来且一毫未删；测试只结束自己按 PID 起的假进程，
    // 绝不触碰本机真实安装（守卫按镜像路径比对，真实进程不在沙箱根下，天然不受影响）。
    {
      const waitPs = join(base, 'wait-pid.ps1');
      writeFileSync(waitPs, [
        'param([int]$TargetPid, [string]$Mode)',
        '$deadline = (Get-Date).AddSeconds(25)',
        'while ((Get-Date) -lt $deadline) {',
        '  $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue',
        '  if ($null -eq $proc) { if ($Mode -eq \'exited\') { Write-Output \'OK-exited\'; exit 0 }; Start-Sleep -Milliseconds 200; continue }',
        '  if ($Mode -eq \'exited\' -and $proc.HasExited) { Write-Output \'OK-exited\'; exit 0 }',
        '  if ($Mode -eq \'visible\') { $path = \'\'; try { $path = $proc.Path } catch {}; if (-not [string]::IsNullOrEmpty($path)) { Write-Output \'OK-visible\'; exit 0 } }',
        '  Start-Sleep -Milliseconds 200',
        '}',
        'Write-Output ("TIMEOUT-" + $Mode)',
        'exit 1',
      ].join('\r\n'));
      const waitPid = (pid, mode) => {
        const w = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', waitPs, '-TargetPid', String(pid), '-Mode', mode], { encoding: 'utf8' });
        return ((w.stdout || '') + (w.stderr || '')).trim();
      };

      const pG = join(base, 'rootg', 'Programs');
      const installG = join(pG, 'TokenMonitor');
      mkdirSync(join(installG, 'runtime'), { recursive: true });
      writeFileSync(join(installG, 'keep.txt'), 'G');
      const dummy = join(installG, 'TokenMonitor.exe');
      copyFileSync(process.execPath, dummy);
      const child = spawn(dummy, ['-e', 'setTimeout(function () {}, 120000)'], { stdio: 'ignore' });
      try {
        ok(waitPid(child.pid, 'visible') === 'OK-visible', '#101 演练假进程已就绪（Get-Process 可查到镜像路径）');
        const rG = runPs(UNINSTALL_PS1, ['-InstallRoot', pG,
          '-StartMenuRoot', join(base, 'rootg', '菜单'), '-DesktopRoot', join(base, 'rootg', '桌面'), '-SkipScheduledTask']);
        ok(rG.code !== 0 && /install tree is in use by/.test(rG.out) && new RegExp('TokenMonitor \\(PID ' + child.pid + '\\)').test(rG.out),
          '#101 卸载遇占用真中止，且点名 PID（正向分支演练）', rG.out.slice(-600));
        ok(existsSync(join(installG, 'keep.txt')) && existsSync(join(installG, 'runtime')),
          '#101 占用中止发生在任何删除之前：沙箱树完好', rG.out.slice(-300));

        const pI = join(base, 'rooti', 'Programs');
        const installI = join(pI, 'TokenMonitor');
        mkdirSync(join(installI, 'runtime'), { recursive: true });
        writeFileSync(join(installI, 'keep.txt'), 'I');
        const dummyI = join(installI, 'TokenMonitorTray.exe');
        copyFileSync(process.execPath, dummyI);
        const childI = spawn(dummyI, ['-e', 'setTimeout(function () {}, 120000)'], { stdio: 'ignore' });
        try {
          ok(waitPid(childI.pid, 'visible') === 'OK-visible', '#101 演练假进程2已就绪');
          const rI = runPs(INSTALL_PS1, ['-Source', good, '-Repo', repo,
            '-InstallRoot', pI, '-StartMenuRoot', join(base, 'rooti', '菜单'), '-DesktopRoot', join(base, 'rooti', '桌面')]);
          ok(rI.code !== 0 && /install tree is in use by/.test(rI.out),
            '#101 安装遇占用同样中止', rI.out.slice(-600));
          ok(existsSync(join(installI, 'keep.txt')) && !existsSync(join(pI, 'TokenMonitor.new')),
            '#101 安装中止未留下半截交换：树完好且无 .new 残留', rI.out.slice(-300));
        } finally {
          childI.kill();
          waitPid(childI.pid, 'exited');
        }
      } finally {
        child.kill();
        waitPid(child.pid, 'exited');
      }
    }

    // (h) 打包器过期判定的真函数演练：从 build-windows.ps1 的 AST 里抽出
    // Get-NewestSourceWrite / Resolve-PublishedExe 本尊，在 %TEMP% 假 windows\gui
    // 树上跑缺失/新鲜/过期/target 排除四种判定，build.ps1 用替身计数，
    // 因此不跑 cargo、不碰真实 windows\*\publish。
    {
      const reh = join(base, 'stale-rehearsal.ps1');
      writeFileSync(reh, [
        'param([string]$ScriptPath, [string]$Sandbox)',
        '$ErrorActionPreference = \'Stop\'',
        'function Fail([string]$m) { throw $m }',
        '$toks = $null; $perr = $null',
        '$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$toks, [ref]$perr)',
        'if ($perr.Count -gt 0) { throw \'build-windows.ps1 does not parse\' }',
        '$fns = @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and @(\'Get-NewestSourceWrite\',\'Resolve-PublishedExe\') -contains $a.Name }, $true))',
        'if ($fns.Count -ne 2) { throw \'functions under test not found\' }',
        'Invoke-Expression ((@($fns) | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine)',
        '$repoFull = $Sandbox',
        '$gui = Join-Path $repoFull \'windows\\gui\'',
        'New-Item -ItemType Directory -Path (Join-Path $gui \'src\'),(Join-Path $gui \'publish\'),(Join-Path $gui \'target\') -Force | Out-Null',
        '@\'',
        'param()',
        '$dir = Split-Path -Parent $MyInvocation.MyCommand.Path',
        '$cf = Join-Path $dir \'buildcount.txt\'',
        '$c = 0',
        'if (Test-Path -LiteralPath $cf) { $c = [int](Get-Content -LiteralPath $cf -Raw) }',
        '$c++',
        'Set-Content -LiteralPath $cf -Value $c',
        '$exe = Join-Path $dir \'publish\\TokenMonitorGui.exe\'',
        // PS 5.1 的 New-Item 没有 -LiteralPath；沙箱目录名只含随机字母数字，-Path 安全。
        'New-Item -ItemType File -Path $exe -Force | Out-Null',
        '(Get-Item -LiteralPath $exe).LastWriteTime = Get-Date',
        '\'@ | Set-Content -LiteralPath (Join-Path $gui \'build.ps1\') -Encoding UTF8',
        'Set-Content -LiteralPath (Join-Path $gui \'src\\main.rs\') -Value \'fn main() {}\'',
        'function BC { if (Test-Path -LiteralPath (Join-Path $gui \'buildcount.txt\')) { [int](Get-Content -LiteralPath (Join-Path $gui \'buildcount.txt\') -Raw) } else { 0 } }',
        'Resolve-PublishedExe \'gui\' \'TokenMonitorGui.exe\' \'GUI launcher\' | Out-Null   # 缺失 -> 构建 (1)',
        'Write-Output ("C1=" + (BC))',
        'Resolve-PublishedExe \'gui\' \'TokenMonitorGui.exe\' \'GUI launcher\' | Out-Null   # 新鲜 -> 不构建',
        'Write-Output ("C2=" + (BC))',
        '(Get-Item -LiteralPath (Join-Path $gui \'publish\\TokenMonitorGui.exe\')).LastWriteTime = (Get-Date).AddMinutes(-5)',
        'Resolve-PublishedExe \'gui\' \'TokenMonitorGui.exe\' \'GUI launcher\' | Out-Null   # 源码比 exe 新 -> 过期, 重建 (2)',
        'Write-Output ("C3=" + (BC))',
        'Set-Content -LiteralPath (Join-Path $gui \'target\\scratch.o\') -Value \'newer than exe but excluded\'',
        'Resolve-PublishedExe \'gui\' \'TokenMonitorGui.exe\' \'GUI launcher\' | Out-Null   # target\\ 排除 -> 仍新鲜',
        'Write-Output ("C4=" + (BC))',
        'Set-Content -LiteralPath (Join-Path $gui \'src\\added.rs\') -Value \'fn added() {}\'',
        'Resolve-PublishedExe \'gui\' \'TokenMonitorGui.exe\' \'GUI launcher\' | Out-Null   # 真源码更新 -> 过期, 重建 (3)',
        'Write-Output ("C5=" + (BC))',
      ].join('\r\n'));
      const rH = runPs(reh, ['-ScriptPath', join(repo, 'scripts', 'build-windows.ps1'), '-Sandbox', join(base, 'stale-sandbox')]);
      ok(rH.code === 0 && /C1=1/.test(rH.out) && /C2=1/.test(rH.out) && /C3=2/.test(rH.out)
        && /C4=2/.test(rH.out) && /C5=3/.test(rH.out),
        '#101 过期判定真函数演练：缺失→建、新鲜→跳过、过期→重建、target\\ 排除', rH.out.slice(-800));
      ok(/exe missing, building/.test(rH.out) && /exe stale \(newest source/.test(rH.out),
        '#101 演练同时覆盖 missing 与 stale 两种报告文案', rH.out.slice(-400));
    }

    // (i) 打包面白名单的真函数演练：从 build-windows.ps1 的 AST 里抽出
    // New-RelativePathSet / Get-PackagedFileSets / Copy-TrackedSourceTree 本尊，在
    // %TEMP% 里真 git init + git add 一个假仓库跑：git 跟踪的文件进包、未跟踪残留
    // 点名并使构建失败、.gitignore 排除项只是不打包（不报错）、索引里有而工作树里
    // 没有的文件同样拒绝。全程不碰真实仓库，也不跑 cargo/npm。
    {
      const reh = join(base, 'whitelist-rehearsal.ps1');
      // 生成的沙箱脚本一律 ASCII：Windows PowerShell 5.1 按系统 ANSI 代码页读取无
      // BOM 的 .ps1，中文说明可能把紧跟其后的单引号吞掉（实测报"字符串未终止"）。
      writeFileSync(reh, [
        'param([string]$ScriptPath, [string]$Sandbox)',
        '$ErrorActionPreference = \'Stop\'',
        'function Fail([string]$m) { throw $m }',
        '$toks = $null; $perr = $null',
        '$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$toks, [ref]$perr)',
        'if ($perr.Count -gt 0) { throw \'build-windows.ps1 does not parse\' }',
        '$names = @(\'New-RelativePathSet\',\'Get-PackagedFileSets\',\'Copy-TrackedSourceTree\')',
        '$fns = @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $a.Name }, $true))',
        'if ($fns.Count -ne 3) { throw (\'whitelist functions not found: \' + $fns.Count) }',
        'Invoke-Expression ((@($fns) | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine)',
        // 光定义没人调用等于没修：抽出真函数之后还要钉住第 6 步真的调用它，并且没有
        // 换一种写法（robocopy 之类）重新开一个整目录复制的后门。
        '$cmdNames = @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })',
        'Write-Output (\'CALLSITE_COPY=\' + @($cmdNames | Where-Object { $_ -eq \'Copy-TrackedSourceTree\' }).Count)',
        'Write-Output (\'CALLSITE_SETS=\' + @($cmdNames | Where-Object { $_ -eq \'Get-PackagedFileSets\' }).Count)',
        'Write-Output (\'CALLSITE_ROBOCOPY=\' + @($cmdNames | Where-Object { $_ -ieq \'robocopy\' }).Count)',
        '$repoFull = $Sandbox',
        '$PACKAGED_DIRS = @(\'bin\',\'src\',\'web\')',
        '$runtime = Join-Path $Sandbox \'out\'',
        'New-Item -ItemType Directory -Path (Join-Path $Sandbox \'web\\lib\'),(Join-Path $Sandbox \'src\'),(Join-Path $Sandbox \'bin\'),$runtime -Force | Out-Null',
        'Set-Content -LiteralPath (Join-Path $Sandbox \'web\\app.js\') -Value \'app\'',
        'Set-Content -LiteralPath (Join-Path $Sandbox \'web\\lib\\theme.js\') -Value \'theme\'',
        'Set-Content -LiteralPath (Join-Path $Sandbox \'src\\server.js\') -Value \'server\'',
        'Set-Content -LiteralPath (Join-Path $Sandbox \'bin\\tokenmonitor.js\') -Value \'cli\'',
        '$ErrorActionPreference = \'SilentlyContinue\'',
        '& git init --quiet $Sandbox | Out-Null',
        '$init = $LASTEXITCODE',
        '& git -C $Sandbox add -- web/app.js web/lib/theme.js src/server.js bin/tokenmonitor.js | Out-Null',
        '$add = $LASTEXITCODE',
        '$ErrorActionPreference = \'Stop\'',
        'if ($init -ne 0 -or $add -ne 0) { throw (\'sandbox git setup failed init=\' + $init + \' add=\' + $add) }',
        'Set-Content -LiteralPath (Join-Path $Sandbox \'.gitignore\') -Value \'web/local.bak\'',
        'Set-Content -LiteralPath (Join-Path $Sandbox \'web\\local.bak\') -Value \'ignored junk\'',
        'Set-Content -LiteralPath (Join-Path $Sandbox \'web\\scratch.js\') -Value \'untracked leftover\'',
        '$sets = Get-PackagedFileSets',
        'if ($null -eq $sets) { throw \'Get-PackagedFileSets must not be null inside a real git checkout\' }',
        'Write-Output (\'TRACKED=\' + $sets.tracked.Count)',
        'Write-Output (\'UNTRACKED=\' + $sets.untracked.Count)',
        'Copy-TrackedSourceTree \'bin\' $runtime $sets',
        'Copy-TrackedSourceTree \'src\' $runtime $sets',
        '$thrown = \'\'',
        'try { Copy-TrackedSourceTree \'web\' $runtime $sets } catch { $thrown = $_.Exception.Message }',
        'Write-Output (\'WEB_THREW=\' + ($thrown -ne \'\'))',
        'Write-Output (\'WEB_NAMED=\' + ($thrown -like \'*web/scratch.js*\'))',
        'Write-Output (\'WEB_IGNORATES_IGNORED=\' + (-not ($thrown -like \'*local.bak*\')))',
        'Write-Output (\'APP=\' + (Test-Path -LiteralPath (Join-Path $runtime \'web\\app.js\')))',
        'Write-Output (\'THEME=\' + (Test-Path -LiteralPath (Join-Path $runtime \'web\\lib\\theme.js\')))',
        'Write-Output (\'BINOK=\' + (Test-Path -LiteralPath (Join-Path $runtime \'bin\\tokenmonitor.js\')))',
        'Write-Output (\'SRCOK=\' + (Test-Path -LiteralPath (Join-Path $runtime \'src\\server.js\')))',
        'Write-Output (\'SCRATCH_SHIPPED=\' + (Test-Path -LiteralPath (Join-Path $runtime \'web\\scratch.js\')))',
        'Write-Output (\'IGNORED_SHIPPED=\' + (Test-Path -LiteralPath (Join-Path $runtime \'web\\local.bak\')))',
        'Remove-Item -LiteralPath (Join-Path $Sandbox \'bin\\tokenmonitor.js\') -Force',
        '$thrown2 = \'\'',
        'try { Copy-TrackedSourceTree \'bin\' $runtime $sets } catch { $thrown2 = $_.Exception.Message }',
        'Write-Output (\'ABSENT_NAMED=\' + ($thrown2 -like \'*bin/tokenmonitor.js*\'))',
        '$repoFull = $env:SYSTEMROOT',
        '$sets3 = Get-PackagedFileSets',
        'Write-Output (\'NO_GIT_IS_NULL=\' + ($null -eq $sets3))',
      ].join('\r\n'));
      const rI = runPs(reh, ['-ScriptPath', join(repo, 'scripts', 'build-windows.ps1'), '-Sandbox', join(base, 'whitelist-sandbox')]);
      ok(/TRACKED=4/.test(rI.out) && /UNTRACKED=1/.test(rI.out),
        '#101 git 索引给出跟踪集、git status 口径给出未跟踪集（.gitignore 排除项两头都不在）', rI.out.slice(-500));
      ok(rI.code === 0 && /WEB_THREW=True/.test(rI.out) && /WEB_NAMED=True/.test(rI.out),
        '#101 未跟踪残留使构建失败且点名那个文件', rI.out.slice(-600));
      ok(/WEB_IGNORATES_IGNORED=True/.test(rI.out),
        '#101 被 .gitignore 排除的本地文件只不打包，不误报为违规', rI.out.slice(-400));
      ok(/APP=True/.test(rI.out) && /THEME=True/.test(rI.out) && /BINOK=True/.test(rI.out) && /SRCOK=True/.test(rI.out),
        '#101 白名单内的源文件照常进包（含子目录）', rI.out.slice(-400));
      ok(/SCRATCH_SHIPPED=False/.test(rI.out) && /IGNORED_SHIPPED=False/.test(rI.out),
        '#101 残留与 ignore 内容都进不了包', rI.out.slice(-400));
      ok(/ABSENT_NAMED=True/.test(rI.out),
        '#101 索引里有、工作树里没有的文件同样拒绝（不许交出缺文件的"完整"包）', rI.out.slice(-400));
      ok(/NO_GIT_IS_NULL=True/.test(rI.out),
        '#101 git 取不到索引时返回 $null，由调用方报错而非退回整目录复制', rI.out.slice(-400));
      // 打包脚本里不许再留下"整目录递归复制应用代码"的写法
      const buildSrc2 = readFileSync(join(repo, 'scripts', 'build-windows.ps1'), 'utf8');
      ok(!/Copy-Item -Path \(Join-Path \$repoFull \$dir\) -Destination \(Join-Path \$runtime \$dir\) -Recurse/.test(buildSrc2),
        '#101 bin/src/web 不再整目录 Copy-Item -Recurse', buildSrc2.slice(0, 200));
      ok(/CALLSITE_COPY=1/.test(rI.out) && /CALLSITE_SETS=1/.test(rI.out) && /CALLSITE_ROBOCOPY=0/.test(rI.out),
        '#101 第 6 步真的调用白名单函数（只定义不调用、或另开 robocopy 后门都会红）', rI.out.slice(-500));
    }

    // (j) 源码验证复制的真函数演练：从 verify-windows-source.ps1 抽出
    // Copy-VerifySourceTree 本尊，在假源码树上跑。关键点是 PowerShell 5.1 的
    // Copy-Item -Exclude 只对 -Path 通配到的顶层条目生效，对递归进去的子项无效——
    // 所以这里既断言新实现挡住了嵌套的 target/dist/node_modules，也用一个负对照
    // 把"修前那种写法就算补上 target 也照样漏"钉在测试里。
    {
      const reh = join(base, 'verify-copy-rehearsal.ps1');
      writeFileSync(reh, [
        'param([string]$ScriptPath, [string]$Sandbox)',
        '$ErrorActionPreference = \'Stop\'',
        '$toks = $null; $perr = $null',
        '$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$toks, [ref]$perr)',
        'if ($perr.Count -gt 0) { throw \'verify-windows-source.ps1 does not parse\' }',
        '$fn = @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq \'Copy-VerifySourceTree\' }, $true))',
        'if ($fn.Count -ne 1) { throw \'Copy-VerifySourceTree not found\' }',
        'Invoke-Expression $fn[0].Extent.Text',
        '$src = Join-Path $Sandbox \'repo\'',
        'New-Item -ItemType Directory -Path (Join-Path $src \'windows\\gui\\target\\debug\'),(Join-Path $src \'windows\\gui\\src\'),(Join-Path $src \'desktop\\node_modules\\pkg\'),(Join-Path $src \'desktop\\dist\\assets\'),(Join-Path $src \'src\'),(Join-Path $src \'.git\') -Force | Out-Null',
        'Set-Content -LiteralPath (Join-Path $src \'src\\server.js\') -Value \'server\'',
        'Set-Content -LiteralPath (Join-Path $src \'windows\\gui\\src\\main.rs\') -Value \'fn main() {}\'',
        'Set-Content -LiteralPath (Join-Path $src \'windows\\gui\\target\\debug\\huge.bin\') -Value (\'x\' * 4096)',
        'Set-Content -LiteralPath (Join-Path $src \'desktop\\node_modules\\pkg\\index.js\') -Value \'dep\'',
        'Set-Content -LiteralPath (Join-Path $src \'desktop\\dist\\assets\\bundle.js\') -Value \'built\'',
        'Set-Content -LiteralPath (Join-Path $src \'.git\\HEAD\') -Value \'ref: refs/heads/main\'',
        // 演练必须用脚本里真正那份排除集，不能用测试自己抄一份字面量：抄来的字面量
        // 只证明"函数会过滤"，脚本把 target 从排除集里删掉时测试照样全绿（实测过）。
        '$asm = @($ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.AssignmentStatementAst] -and $a.Left.Extent.Text -eq \'$ExcludedNames\' }, $true))',
        'if ($asm.Count -ne 1) { throw \'verify-windows-source.ps1 must define $ExcludedNames exactly once\' }',
        '$excluded = @(Invoke-Expression $asm[0].Right.Extent.Text)',
        'Write-Output (\'LIST_TARGET=\' + ($excluded -contains \'target\'))',
        'Write-Output (\'LIST_DIST=\' + ($excluded -contains \'dist\'))',
        'Write-Output (\'LIST_NM=\' + ($excluded -contains \'node_modules\'))',
        'Write-Output (\'LIST_GIT=\' + ($excluded -contains \'.git\'))',
        '$work = Join-Path $Sandbox \'work\'',
        'New-Item -ItemType Directory -Path $work -Force | Out-Null',
        '$n = Copy-VerifySourceTree -SourceRoot $src -TargetRoot $work -Excluded $excluded',
        'Write-Output (\'COPIED=\' + $n)',
        'Write-Output (\'SERVER=\' + (Test-Path -LiteralPath (Join-Path $work \'src\\server.js\')))',
        'Write-Output (\'MAINRS=\' + (Test-Path -LiteralPath (Join-Path $work \'windows\\gui\\src\\main.rs\')))',
        'Write-Output (\'TARGET_LEAK=\' + (Test-Path -LiteralPath (Join-Path $work \'windows\\gui\\target\\debug\\huge.bin\')))',
        'Write-Output (\'NM_LEAK=\' + (Test-Path -LiteralPath (Join-Path $work \'desktop\\node_modules\\pkg\\index.js\')))',
        'Write-Output (\'DIST_LEAK=\' + (Test-Path -LiteralPath (Join-Path $work \'desktop\\dist\\assets\\bundle.js\')))',
        'Write-Output (\'GIT_LEAK=\' + (Test-Path -LiteralPath (Join-Path $work \'.git\\HEAD\')))',
        '$old = Join-Path $Sandbox \'old\'',
        'New-Item -ItemType Directory -Path $old -Force | Out-Null',
        'Copy-Item -Path (Join-Path $src \'*\') -Destination $old -Recurse -Force -Exclude $excluded',
        'Write-Output (\'OLD_TARGET_LEAK=\' + (Test-Path -LiteralPath (Join-Path $old \'windows\\gui\\target\\debug\\huge.bin\')))',
        'Write-Output (\'OLD_NM_LEAK=\' + (Test-Path -LiteralPath (Join-Path $old \'desktop\\node_modules\\pkg\\index.js\')))',
      ].join('\r\n'));
      const rJ = runPs(reh, ['-ScriptPath', join(repo, 'scripts', 'verify-windows-source.ps1'), '-Sandbox', join(base, 'verify-copy-sandbox')]);
      ok(rJ.code === 0 && /SERVER=True/.test(rJ.out) && /MAINRS=True/.test(rJ.out) && /COPIED=2/.test(rJ.out),
        '#14 验证用源码复制照常带走真实源文件', rJ.out.slice(-500));
      ok(/TARGET_LEAK=False/.test(rJ.out) && /NM_LEAK=False/.test(rJ.out) && /DIST_LEAK=False/.test(rJ.out) && /GIT_LEAK=False/.test(rJ.out),
        '#14 嵌套的 target/dist/node_modules/.git 一律不复制（GB 级构建树 + MAX_PATH）', rJ.out.slice(-500));
      ok(/LIST_TARGET=True/.test(rJ.out) && /LIST_DIST=True/.test(rJ.out) && /LIST_NM=True/.test(rJ.out) && /LIST_GIT=True/.test(rJ.out),
        '#14 脚本自己的排除集里 target/dist/node_modules/.git 一个都不能少（少一个即红）', rJ.out.slice(-500));
      ok(/OLD_TARGET_LEAK=True/.test(rJ.out) && /OLD_NM_LEAK=True/.test(rJ.out),
        '#14 负对照成立：Copy-Item -Exclude 就算补上 target 也挡不住嵌套构建目录（所以才必须自己走目录树）', rJ.out.slice(-500));
      const verifySrc = readFileSync(join(repo, 'scripts', 'verify-windows-source.ps1'), 'utf8');
      ok(!/Copy-Item -Path \(Join-Path \$Root '\*'\) -Destination \$Work -Recurse/.test(verifySrc),
        '#14 verify-windows-source.ps1 不再用整目录 Copy-Item -Recurse -Exclude', verifySrc.slice(0, 200));
    }
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\ninstaller test: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  FAIL: ' + f);
  process.exit(1);
}
