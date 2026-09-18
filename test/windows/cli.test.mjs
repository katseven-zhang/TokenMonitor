/**
 * Win-CLI：help/version/status 不建库、非法参数非零、SIGINT 受控退出。
 * 运行：TOKENMONITOR_OFFLINE=1 node test/windows/cli.test.mjs
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

process.env.TOKENMONITOR_OFFLINE = '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'bin', 'tokenmonitor.js');

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
    TOKENMONITOR_OFFLINE: '1',
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
const dbFile = join(HOME, '.tokenmonitor', 'tokenmonitor.db');

console.log('\n[help/version] 不创建数据库，文案按平台');
{
  const h = run(['--help'], { home: HOME });
  ok('--help 退出码 0', h.status === 0, String(h.status));
  ok('--help 走 stdout', h.stdout.includes('Usage:') && !h.stderr.includes('Usage:'), `stderr=${h.stderr.slice(0, 80)}`);
  ok('--help 列出 scan/serve/today/status', ['scan', 'serve', 'today', 'status'].every((c) => h.stdout.includes(c)));
  ok('--help 未创建数据库', !existsSync(dbFile));
  if (process.platform === 'win32') {
    ok('Windows help 提到当前用户 Task Scheduler', /Task Scheduler/i.test(h.stdout));
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

console.log('\n[#51 文件日志] 真实命令落 logs\\tokenmonitor.log，只读诊断保持零副作用');
{
  // 空的 HOME/LOCALAPPDATA 让枚举找不到任何来源目录：扫描 0 文件但仍会写一行汇总，
  // 于是能在毫秒级验证「日志确实落盘」，而不必真扫用户数据。
  const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'cli-empty-home-中文 空格-'));
  const LOGDIR = mkdtempSync(join(tmpdir(), 'cli-logdir-中文 空格-'));
  const logFile = join(LOGDIR, 'logs', 'tokenmonitor.log');
  const iso = { extraEnv: { TOKENMONITOR_DATA_DIR: LOGDIR, LOCALAPPDATA: EMPTY_HOME, APPDATA: EMPTY_HOME } };

  run(['status'], { home: EMPTY_HOME, ...iso });
  ok('status 不创建日志目录', !existsSync(join(LOGDIR, 'logs')));
  const v = run(['--version'], { home: EMPTY_HOME, ...iso });
  ok('--version 不创建日志目录', !existsSync(join(LOGDIR, 'logs')));
  ok('--version stdout 只有版本号', /^\d+\.\d+\.\d+\s*$/.test(v.stdout), JSON.stringify(v.stdout));

  const s = run(['scan'], { home: EMPTY_HOME, ...iso });
  ok('scan 退出码 0', s.status === 0, `${s.status} ${s.stderr?.slice(0, 200)}`);
  ok('scan 已写出日志文件', existsSync(logFile), logFile);
  if (existsSync(logFile)) {
    const text = readFileSync(logFile, 'utf8');
    ok('日志行格式 [ISO] [LEVEL]', /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[(INFO|WARN|ERROR)\] /m.test(text), text.slice(0, 140));
    ok('日志不含明文密钥', !/sk-[a-zA-Z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,}/.test(text));
  }
  // 落盘的同时 stdout 必须保持原样：GUI 之外的用户与现有 CI 都按这个前缀读输出
  ok('stdout 仍带 [tokenmonitor] 前缀', /\[tokenmonitor\] /.test(`${s.stdout}${s.stderr}`), `${s.stdout}${s.stderr}`.slice(0, 160));
  ok('stdout 与文件日志同源', s.stdout.includes('scan:') && existsSync(logFile) && readFileSync(logFile, 'utf8').includes('scan:'));

  rmSync(EMPTY_HOME, { recursive: true, force: true });
  rmSync(LOGDIR, { recursive: true, force: true });
}

console.log('\n[agent/bar] Store 创建前分流，bar 按构建物有无给出两种明确行为');
{
  const src = (await import('node:fs')).readFileSync(CLI, 'utf8');
  ok('install-agent 在 new Store 之前',
    src.indexOf("cmd === 'install-agent'") < src.indexOf('new Store(DB_PATH)'));

  // #9 之后 Windows bar 的契约：有托盘构建物 → detached 启动托盘（exit 0）；
  // 没有构建物 → stderr 给出含 tray/127.0.0.1 的构建指引（非零）。两种情况都不建库。
  const trayExe = join(ROOT, 'windows', 'tray', 'publish', 'TokenMonitorTray.exe');
  const trayRunningBefore = spawnSync('tasklist', ['/FI', 'IMAGENAME eq TokenMonitorTray.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    .stdout?.includes('TokenMonitorTray.exe') ?? false;

  const bar = run(['bar', '--port', '9001'], { home: HOME });
  ok('bar 未创建数据库', !existsSync(dbFile));
  if (process.platform === 'win32' && existsSync(trayExe)) {
    ok('bar 启动托盘 exit 0（构建物存在）', bar.status === 0, String(bar.status));
    ok('bar 启动日志在 stdout 且未进入 serve', !bar.stdout.includes('listening') && bar.stdout.includes('127.0.0.1'), bar.stdout.slice(0, 160));
    if (!trayRunningBefore) {
      // 测试拉起的托盘要清理（用户自己的托盘不在测试前运行则不受影响）
      spawnSync('taskkill', ['/IM', 'TokenMonitorTray.exe', '/F'], { stdio: 'ignore' });
    }
  } else {
    ok('bar 非零（无构建物/平台限制）', bar.status !== 0, String(bar.status));
    ok('bar 错误在 stderr', bar.stderr.length > 0 && !bar.stdout.includes('listening'));
    if (process.platform === 'win32') {
      ok('Windows bar 未构建时给出 tray/127.0.0.1 构建指引', /tray|127\.0\.0\.1/i.test(bar.stderr), bar.stderr.slice(0, 160));
    }
  }
  ok('help 列出 install-agent', /install-agent/.test(readFileSync(CLI, 'utf8')));
}

console.log('\n[serve SIGINT] 受控关闭退出码 0');
{
  const port = await new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
  });
  const env = { ...process.env, HOME, USERPROFILE: HOME, TOKENMONITOR_OFFLINE: '1' };
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
