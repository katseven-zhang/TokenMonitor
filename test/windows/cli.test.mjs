/**
 * Win-CLI：help/version/status 不建库、非法参数非零、SIGINT 受控退出。
 * 运行：TOKENMETER_OFFLINE=1 node test/windows/cli.test.mjs
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

process.env.TOKENMETER_OFFLINE = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'bin', 'tokenwatcher.js');

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
};

function run(args, { home, extraEnv = {}, timeout = 15000 } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TOKENMETER_OFFLINE: '1',
    ...extraEnv,
  };
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    encoding: 'utf8',
    env,
    timeout,
    windowsHide: true,
  });
}

const HOME = mkdtempSync(join(tmpdir(), 'cli-home-中文 空格-'));
const dbFile = join(HOME, '.tokenmeter', 'tokenmeter.db');

console.log('\n[help/version] 不创建数据库，文案按平台');
{
  const h = run(['--help'], { home: HOME });
  ok('--help 退出码 0', h.status === 0, String(h.status));
  ok('--help 走 stdout', h.stdout.includes('Usage:') && !h.stderr.includes('Usage:'), `stderr=${h.stderr.slice(0, 80)}`);
  ok('--help 列出 scan/serve/today/status', ['scan', 'serve', 'today', 'status'].every((c) => h.stdout.includes(c)));
  ok('--help 未创建数据库', !existsSync(dbFile));
  if (process.platform === 'win32') {
    ok('Windows help 提到 Task Scheduler 尚未在本 CLI', /Task Scheduler/i.test(h.stdout));
    ok('Windows help 提到 tray 尚未在本 CLI', /tray/i.test(h.stdout));
  } else {
    ok('非 Windows help 提到 LaunchAgent', /LaunchAgent/i.test(h.stdout));
  }

  const v = run(['--version'], { home: HOME });
  ok('--version 退出码 0', v.status === 0);
  ok('--version 只打出版本号', /^\d+\.\d+\.\d+\s*$/.test(v.stdout), JSON.stringify(v.stdout));
  ok('--version 未创建数据库', !existsSync(dbFile));
}

console.log('\n[usage errors] 未知命令/非法端口非零，不再静默 serve');
{
  const unk = run(['not-a-command'], { home: HOME });
  ok('未知命令退出码 2', unk.status === 2, String(unk.status));
  ok('未知命令写 stderr 不写 stdout 用量', unk.stderr.includes("Unknown command") && !unk.stdout.includes('listening'));
  ok('未知命令未创建数据库', !existsSync(dbFile));

  const badPort = run(['serve', '--port', 'abc'], { home: HOME });
  ok('非法端口退出码 2', badPort.status === 2, String(badPort.status));
  ok('非法端口不回退默认', badPort.stderr.includes('Invalid port') && !badPort.stdout.includes('listening'));

  const missing = run(['serve', '--port'], { home: HOME });
  ok('缺失 --port 值退出码 2', missing.status === 2, String(missing.status));

  const range = run(['--port', '99999'], { home: HOME });
  ok('端口越界退出码 2', range.status === 2, String(range.status));

  const opt = run(['--nope'], { home: HOME });
  ok('未知选项退出码 2', opt.status === 2, String(opt.status));
}

console.log('\n[status] 不读会话、不建库');
{
  const s = run(['status'], { home: HOME });
  ok('status 退出码 0', s.status === 0, `${s.status} ${s.stderr}`);
  ok('status 含 backend/port/data_dir', /backend:/.test(s.stdout) && /port:/.test(s.stdout) && /data_dir:/.test(s.stdout));
  ok('status 不含会话内容字段', !/session_id|all_time_tokens|events/.test(s.stdout));
  ok('status 未创建数据库', !existsSync(dbFile));
}

console.log('\n[agent/bar] Store 创建前分流，Windows 文案准确');
{
  const src = (await import('node:fs')).readFileSync(CLI, 'utf8');
  ok('install-agent 在 new Store 之前',
    src.indexOf("cmd === 'install-agent'") < src.indexOf('new Store(DB_PATH)'));
  const bar = run(['bar', '--port', '9001'], { home: HOME });
  ok('bar 未创建数据库', !existsSync(dbFile));
  ok('bar 非零（本机无对应桌面实现或平台限制）', bar.status !== 0, String(bar.status));
  ok('bar 错误在 stderr', bar.stderr.length > 0 && !bar.stdout.includes('listening'));
  if (process.platform === 'win32') {
    ok('Windows bar 说明托盘未在本 CLI', /tray|127\.0\.0\.1/i.test(bar.stderr), bar.stderr.slice(0, 160));
  }
  const inst = run(['install-agent'], { home: HOME });
  ok('install-agent 未创建数据库', !existsSync(dbFile));
  if (process.platform === 'win32') {
    ok('Windows install-agent 说明任务计划未在本 CLI', /Task Scheduler|serve/i.test(inst.stderr), inst.stderr.slice(0, 160));
    ok('Windows install-agent 非零', inst.status !== 0);
  }
}

console.log('\n[serve SIGINT] 受控关闭退出码 0');
{
  const port = await new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const env = { ...process.env, HOME, USERPROFILE: HOME, TOKENMETER_OFFLINE: '1' };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'serve', '--port', String(port)], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => { buf += d; });
  const started = await new Promise((r) => {
    const t = setTimeout(() => r(false), 25000);
    const onData = () => {
      if (buf.includes('listening')) { clearTimeout(t); r(true); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
  ok('serve 启动', started, buf.slice(-200));
  if (started) {
    const finished = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    child.kill('SIGINT');
    const { code, signal } = await Promise.race([
      finished,
      new Promise((r) => setTimeout(() => r({ code: 'timeout', signal: null }), 8000)),
    ]);
    if (code === 'timeout') {
      child.kill('SIGKILL');
      ok('SIGINT 受控退出', false, 'timed out');
    } else {
      const src = (await import('node:fs')).readFileSync(CLI, 'utf8');
      ok('CLI 注册 SIGINT/SIGTERM 并 process.exit(0)',
        /process.on\('SIGINT'/.test(src) && /process.on\('SIGTERM'/.test(src) && /shutting down/.test(src)
        && /process.exit\(0\)/.test(src));
      if (process.platform === 'win32') {
        ok('Windows 子进程已结束（process.kill 在 Windows 上不投递 SIGINT 给 handler）',
          code === 0 || signal === 'SIGINT' || signal === 'SIGTERM',
          `code=${code} signal=${signal}`);
      } else {
        ok('SIGINT 退出码 0', code === 0, `code=${code} signal=${signal}`);
        ok('关闭日志 shutting down', /shutting down/i.test(buf), buf.slice(-180));
      }
    }
  } else {
    child.kill('SIGKILL');
  }
}

rmSync(HOME, { recursive: true, force: true });
if (failed) {
  console.error(`\ncli FAILED ${failed}`);
  process.exit(1);
}
console.log('\ncli OK');
