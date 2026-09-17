#!/usr/bin/env node
/**
 * Token Watcher — 本地多源 token 用量与配额面板
 *
 * 用法：
 *   tokenwatcher scan
 *   tokenwatcher serve [--port 8787]
 *   tokenwatcher today
 *   tokenwatcher status [--port 8787]
 *   tokenwatcher install-agent [--port 8787]
 *   tokenwatcher uninstall-agent
 *   tokenwatcher bar [--port 8787]
 *
 * tokenmeter 为旧命令名，仍作为别名保留（1.2 及更早版本装的是这个名字）。
 */
import { existsSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';
import { Store } from '../src/store.js';
import { Scanner } from '../src/scanner.js';
import { startServer } from '../src/server.js';
import { BalancePoller } from '../src/balance.js';
import { DB_PATH, DEFAULT_PORT, DATA_DIR } from '../src/config.js';

const log = (msg) => console.log(`[token-watcher] ${msg}`);
const err = (msg) => console.error(`[token-watcher] ${msg}`);

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
    ? `  bar [--port N]             Windows tray is not in this CLI yet. Open http://127.0.0.1:<port>`
    : `  bar [--port N]             Open the macOS menu-bar capsule (connects to 127.0.0.1:<port>).`;
  return `Token Watcher ${PKG.version}

Usage:
  token-watcher <command> [options]

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
  --force                    install-agent: replace a conflicting legacy agent

Exit codes:
  0  success / controlled shutdown (Ctrl+C, SIGTERM)
  1  runtime error
  2  usage error (unknown command, bad or missing --port)
`;
}

function usageExit(msg) {
  err(msg);
  err('Run token-watcher --help for usage.');
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

function migrateLegacyHome() {
  const LEGACY = join(homedir(), '.token-stats');
  const NEWDIR = join(homedir(), '.tokenmeter');
  if (existsSync(LEGACY) && !existsSync(NEWDIR)) renameSync(LEGACY, NEWDIR);
  const LEGACY_DB = join(NEWDIR, 'token-stats.db');
  if (existsSync(LEGACY_DB) && !existsSync(DB_PATH)) renameSync(LEGACY_DB, DB_PATH);
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
    `offline_mode: ${process.env.TOKENMETER_OFFLINE === '1' ? 'yes' : 'no'}`,
  ];
  for (const line of lines) console.log(line);
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
  process.exit(0);
}

// 装卸服务与数据无关，必须在 new Store 之前返回：否则仅仅为了装个开机自启
// 就会在用户机器上建出数据库文件。
if (cmd === 'install-agent' || cmd === 'uninstall-agent' || cmd === 'bar') {
  try {
    if (process.platform === 'win32' && cmd === 'bar') {
      throw new Error(`Windows tray is not in this CLI yet. Start "token-watcher serve --port ${port}" and open http://127.0.0.1:${port}`);
    }
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

migrateLegacyHome();
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
  scanner.startWatching();
  const balancePoller = new BalancePoller(store, { log });
  const server = await startServer({ store, scanner, balancePoller, port, log });
  log('实时监听已启动（FSEvents + 60s 兜底轮询），余额每 30 分钟轮询，Ctrl+C 退出');
  let shutting = false;
  const shutdown = (signal) => {
    if (shutting) return;
    shutting = true;
    process.stderr.write(`[token-watcher] shutting down (${signal})\n`);
    try { scanner.stop(); } catch { /* already stopped */ }
    try { balancePoller.stop?.(); } catch { /* optional */ }
    try { server.close(); } catch { /* listen failed */ }
    try { store.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}
