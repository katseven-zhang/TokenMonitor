#!/usr/bin/env node
/**
 * TokenMonitor — 本地多源 token 用量与配额面板
 *
 * 用法：
 *   tokenmonitor scan
 *   tokenmonitor serve [--port 8787]
 *   tokenmonitor today
 *   tokenmonitor status [--port 8787]
 *   tokenmonitor install-agent [--port 8787]
 *   tokenmonitor uninstall-agent
 *   tokenmonitor bar [--port 8787]
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { startServer } from '../src/server.js';
import { BalancePoller } from '../src/balance.js';
import { DB_PATH, DEFAULT_PORT, DATA_DIR } from '../src/config.js';
import { RuntimeLogger, getDefaultLogDir } from '../src/platform/runtime.js';

// --help / --version / status 必须零副作用（不建目录，stdout 只有所规定的行），
// 所以文件日志延迟装配；装配失败就降级为仅 stdout，不能让日志把主流程带崩。
let fileLogger = null;
const log = (msg) => {
  if (fileLogger) fileLogger.info(msg);
  else console.log(`[tokenmonitor] ${msg}`);
};
const err = (msg) => {
  if (fileLogger) fileLogger.error(msg);
  else console.error(`[tokenmonitor] ${msg}`);
};

const COMMANDS = ['scan', 'serve', 'today', 'install-agent', 'uninstall-agent', 'bar', 'status'];
const PKG = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

function installDaemonGuards() {
  process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.message ?? e}`));
  process.on('uncaughtException', (e) => log(`uncaught exception: ${e?.stack ?? e}`));
}

function helpText() {
  const win = process.platform === 'win32';
  const agent = win
    ? `  install-agent [--port N]   Install a current-user Task Scheduler logon task (no admin).
  uninstall-agent            Remove only the TokenMonitor-Server task.`
    : `  install-agent [--port N]   Install a current-user macOS LaunchAgent (no admin).
  uninstall-agent            Stop and remove that LaunchAgent.`;
  const bar = win
    ? `  bar [--port N]             Launch the Windows system tray (connects to 127.0.0.1:<port>).`
    : `  bar [--port N]             Open the macOS menu-bar capsule (connects to 127.0.0.1:<port>).`;
  return `TokenMonitor ${PKG.version}

Usage:
  tokenmonitor <command> [options]

Commands:
  scan                       Incremental scan once, then exit
  serve [--port N]           Scan, serve the local panel, watch for changes (default)
  today                      Print today's usage summary
  status [--port N]          Backend online/offline, port, and data directory (no session contents)
${agent}
${bar}

Options:
  --port, -p N               Loopback port (1-65535). Default ${DEFAULT_PORT}. Invalid values error; they do not fall back.
  --help, -h                 Show this help (does not create a database)
  --version, -v              Print version (does not create a database)
  --force                    install-agent: replace a conflicting TokenMonitor agent

Exit codes:
  0  success / controlled shutdown (Ctrl+C, SIGTERM)
  1  runtime error
  2  usage error (unknown command, bad or missing --port)
`;
}

function usageExit(msg) {
  err(msg);
  err('Run tokenmonitor --help for usage.');
  process.exit(2);
}

function parseArgs(argv) {
  let cmd = null;
  let port = null;
  let force = false;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h' || a === 'help') { help = true; continue; }
    if (a === '--version' || a === '-v' || a === 'version') { version = true; continue; }
    if (a === '--force') { force = true; continue; }
    if (a === '--port' || a === '-p') {
      const raw = argv[i + 1];
      if (raw == null || String(raw).startsWith('-')) usageExit('Missing value for --port');
      i++;
      if (!/^\d+$/.test(String(raw))) usageExit(`Invalid port '${raw}'`);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) usageExit(`Invalid port '${raw}' (expected 1-65535)`);
      port = n;
      continue;
    }
    if (a.startsWith('-')) usageExit(`Unknown option '${a}'`);
    if (COMMANDS.includes(a)) {
      if (cmd && cmd !== a) usageExit(`Multiple commands: '${cmd}' and '${a}'`);
      cmd = a;
      continue;
    }
    usageExit(`Unknown command '${a}'`);
  }
  return {
    help,
    version,
    cmd: cmd || 'serve',
    port: port ?? DEFAULT_PORT,
    portExplicit: port != null,
    force,
  };
}

async function probeBackend(port) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/summary?days=1',
      method: 'GET',
      timeout: 1500,
      headers: { host: `127.0.0.1:${port}` },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 || res.statusCode === 403 ? 'online' : `http_${res.statusCode}`);
    });
    req.on('timeout', () => { req.destroy(); resolve('offline'); });
    req.on('error', () => resolve('offline'));
    req.end();
  });
}

function printStatus({ port, backend }) {
  const lines = [
    `backend: ${backend}`,
    `port: ${port}`,
    `data_dir: ${DATA_DIR}`,
    `db: ${existsSync(DB_PATH) ? 'present' : 'absent'}`,
    `offline_mode: ${process.env.TOKENMONITOR_OFFLINE === '1' ? 'yes' : 'no'}`,
  ];
  for (const line of lines) console.log(line);
}

/**
 * #87：status 追加共存三行（桌面版是否装机/配在哪个端口/是否在跑）。
 * 这段必须零副作用——status 承诺不建库不建目录，所以只用 coexistence.js 的只读探测。
 */
async function printCoexistence({ port }) {
  try {
    const { coexistenceLines } = await import('../src/coexistence.js');
    for (const line of await coexistenceLines({ ownPort: port })) console.log(line);
  } catch (e) {
    console.log(`desktop_edition: unknown (${e?.message ?? e})`);
  }
}

const fmt = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n ?? 0);
};

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(helpText());
  process.exit(0);
}
if (args.version) {
  console.log(PKG.version);
  process.exit(0);
}

const { cmd, port, force } = args;

if (cmd === 'status') {
  const backend = await probeBackend(port);
  printStatus({ port, backend });
  await printCoexistence({ port });
  process.exit(0);
}

// 到这里才是会真正执行动作的命令：按 #23 的三级数据目录解析装配文件日志，
// stdout 输出保持不变（consoleOutput），同时落 <数据根>\logs\tokenmonitor.log 供 GUI tail。
try {
  fileLogger = new RuntimeLogger({ logDir: getDefaultLogDir(), consoleOutput: true });
} catch (e) {
  err(`文件日志不可用，仅输出到 stdout：${e.message}`);
}

// 装卸服务与数据无关，必须在 new Store 之前返回：否则仅仅为了装个开机自启
// 就会在用户机器上建出数据库文件。
if (cmd === 'install-agent' || cmd === 'uninstall-agent' || cmd === 'bar') {
  try {
    if (cmd === 'bar') {
      const { openBar } = await import('../src/bar.js');
      openBar({ port, log });
    } else {
      const { installAgent, uninstallAgent } = await import('../src/agent.js');
      if (cmd === 'install-agent') installAgent({ port, force, log });
      else uninstallAgent({ log });
    }
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
  process.exit(0);
}

const store = new Store(DB_PATH);

if (cmd === 'scan') {
  const scanner = new Scanner(store, { log });
  await scanner.scanAll();
  for (const r of store.byTool()) {
    log(`${r.tool.padEnd(12)} ${String(r.n).padStart(6)} 次  in=${fmt(r.input)} cached=${fmt(r.cached)} cacheW=${fmt(r.cache_write)} out=${fmt(r.output)}  total=${fmt(r.total)}`);
  }
  store.close();
} else if (cmd === 'today') {
  const scanner = new Scanner(store, { log });
  await scanner.scanAll();
  const db = store.db;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = db.prepare('SELECT SUM(total_tokens) t FROM events WHERE ts >= ?').get(start.getTime());
  const byTool = db.prepare('SELECT tool, SUM(total_tokens) t FROM events WHERE ts >= ? GROUP BY tool').all(start.getTime());
  log(`今日: ${fmt(today.t || 0)} tokens（${byTool.map((r) => `${r.tool} ${fmt(r.t)}`).join(' | ') || '无'}）`);
  store.close();
} else {
  installDaemonGuards();
  log(`db: ${DB_PATH}`);
  const scanner = new Scanner(store, { log });
  log('初次扫描历史数据（增量游标，仅首次较慢）…');
  await scanner.scanAll();
  for (const r of store.byTool()) {
    log(`${r.tool.padEnd(12)} ${String(r.n).padStart(6)} 次  total=${fmt(r.total)}`);
  }
  // #87：先监听，成功了才开始盯目录。
  // 修前顺序是 startWatching() → await startServer()，而 installDaemonGuards() 已经
  // 装了 unhandledRejection 兜底：端口被占用时 startServer 的 Promise 被 reject，
  // 那个 handler 把 EADDRINUSE 当普通拒绝吞掉，await 之后的代码（含运行锁）永远不执行，
  // 但 scanner 的 fs.watch + 兜底轮询和 balancePoller 的定时器已经把事件循环钉住——
  // 抢端口输掉的这个旧版实例就成了静默僵尸：没有 HTTP、没有锁文件、却在持续扫描，
  // 还会每 30 分钟打一次余额接口。现在冲突必须说清占用了是谁、并且以退出码 1 结束。
  const balancePoller = new BalancePoller(store, { log });
  let server = null;
  try {
    server = await startServer({ store, scanner, balancePoller, port, log });
  } catch (e) {
    err(`serve 启动失败：${e?.message ?? e}`);
    if (e?.code === 'EADDRINUSE') {
      const c = e.conflict || {};
      try {
        const { describePortConflict, coexistenceLines } = await import('../src/coexistence.js');
        for (const line of describePortConflict({ port, holderPid: c.pid, holderImage: c.processName })) err(line);
        for (const line of await coexistenceLines({ ownPort: port })) err(line);
      } catch (reportErr) {
        err(`端口冲突详情不可用：${reportErr?.message ?? reportErr}`);
      }
    }
    // 只清理自己起起来的东西：绝不终止占用端口的进程（可能是另一个产品，也可能是用户的别的程序）。
    try { scanner.stop(); } catch { /* 未启动 */ }
    try { balancePoller.stop?.(); } catch { /* optional */ }
    try { server?.close(); } catch { /* 没起来 */ }
    try { store.close(); } catch { /* already closed */ }
    err('exiting with code 1 (port conflict is fatal for this instance; nothing else was touched)');
    process.exit(1);
  }
  scanner.startWatching();
  log('实时监听已启动（fs.watch 目录监听 + 60s 兜底轮询），余额每 30 分钟轮询，Ctrl+C 退出');
  let shutting = false;
  // #31：serve 运行锁（数据目录 tokenmonitor-<port>.lock，含 PID）——
  // 安装/卸载脚本据此识别运行中后台；锁目录与数据目录同层（打包/安装形态=appRoot\data）
  const runtimeLockPath = join(DATA_DIR, `tokenmonitor-${port}.lock`);
  const writeRuntimeLock = () => {
    try {
      writeFileSync(runtimeLockPath, JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() }));
    } catch { /* 数据目录不可写时跳过（守卫会因无锁放行，行为同修前） */ }
  };
  const removeRuntimeLock = () => {
    try { rmSync(runtimeLockPath, { force: true }); } catch { /* best effort */ }
  };
  writeRuntimeLock();
  process.on('exit', removeRuntimeLock); // 正常/异常退出兜底清理；异常残留由守卫的 PID 存活检查容错
  const shutdown = (signal) => {
    if (shutting) return;
    shutting = true;
    err(`shutting down (${signal})`);
    try { scanner.stop(); } catch { /* already stopped */ }
    try { balancePoller.stop?.(); } catch { /* optional */ }
    try { server.close(); } catch { /* listen failed */ }
    try { store.close(); } catch { /* already closed */ }
    removeRuntimeLock();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}
