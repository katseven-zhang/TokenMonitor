/**
 * Windows CI 烟测：语法/import、CLI help/version、临时 HOME scan、loopback 静态资源。
 * TOKENMONITOR_OFFLINE=1。不把 npm test 伪装成通过。
 */
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globSync } from 'node:fs';
import net from 'node:net';
import http from 'node:http';

process.env.TOKENMONITOR_OFFLINE = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'bin', 'tokenmonitor.js');
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

console.log('\n[ci-smoke] import');
{
  const files = [...globSync(join(ROOT, 'src/**/*.js')), ...globSync(join(ROOT, 'web/lib/*.js'))];
  ok('模块非空', files.length >= 15, String(files.length));
  for (const f of files) {
    try {
      await import(pathToFileURL(f).href);
      ok(`import ${f.slice(ROOT.length + 1)}`, true);
    } catch (err) {
      ok(`import ${f.slice(ROOT.length + 1)}`, false, err.message.slice(0, 120));
    }
  }
}

console.log('\n[ci-smoke] CLI help/version');
{
  const env = { ...process.env, TOKENMONITOR_OFFLINE: '1', HOME: mkdtempSync(join(tmpdir(), 'ci-home-')), USERPROFILE: '' };
  env.USERPROFILE = env.HOME;
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env, timeout: 15000, windowsHide: true });
  ok('--help 0', help.status === 0, help.stderr.slice(0, 120));
  const ver = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8', env, timeout: 15000, windowsHide: true });
  ok('--version 0', ver.status === 0 && /\d+\.\d+\.\d+/.test(ver.stdout), ver.stdout);
  rmSync(env.HOME, { recursive: true, force: true });
}

console.log('\n[ci-smoke] temp HOME scan + serve');
{
  const HOME = mkdtempSync(join(tmpdir(), 'ci-scan-中文 空格-'));
  mkdirSync(join(HOME, '.grok', 'sessions', 'proj'), { recursive: true });
  const env = { ...process.env, HOME, USERPROFILE: HOME, TOKENMONITOR_OFFLINE: '1' };
  const scan = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'scan'], {
    encoding: 'utf8', env, timeout: 30000, windowsHide: true,
  });
  ok('scan 退出码 0', scan.status === 0, (scan.stderr || scan.stdout).slice(0, 200));

  const port = await new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'serve', '--port', String(port)], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  const up = await new Promise((r) => {
    const t = setTimeout(() => r(false), 25000);
    child.stdout.on('data', () => { if (buf.includes('listening')) { clearTimeout(t); r(true); } });
  });
  ok('serve listening', up, buf.slice(-120));
  if (up) {
    const get = (path) => new Promise((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      rq.on('error', () => resolve(0));
      rq.end();
    });
    const summary = await get('/api/summary?days=1');
    ok('summary 200', summary === 200, String(summary));
    const app = await get('/app.js');
    ok('app.js 200', app === 200, String(app));
    const ec = await get('/vendor/echarts.min.js');
    ok('echarts 不是 0（未安装时允许 404）', ec === 200 || ec === 404, String(ec));
  }
  await new Promise((r) => {
    child.once('exit', r);
    child.kill('SIGINT');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } r(); }, 3000);
  });
  try { rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* Windows file lock; TEMP will GC */ }
}

if (failed) {
  console.error(`\nci-smoke FAILED ${failed}`);
  process.exit(1);
}
console.log('\nci-smoke OK');
