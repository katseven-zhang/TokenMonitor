/**
 * #87 —— 同仓库两个产品（旧版 Node 后台 / Rust+Tauri 桌面版）共存的探测与报告。
 *
 * 为什么需要它：两边都默认抢 127.0.0.1:8787，各自还有一套独立的登录自启
 * （旧版走当前用户任务计划 TokenMonitor-Server，桌面版走 tauri-plugin-autostart），
 * 此前彼此完全不可见：谁先起谁占端口，后起的那个要么静默降级，要么把错误藏进
 * service.log（旧版更糟——unhandledRejection 吞掉 EADDRINUSE，见 bin/tokenmonitor.js）。
 *
 * 硬约束：本模块**只读**。不创建目录、不写文件、不发 HTTP 请求；唯一的主动出网
 * 行为是 127.0.0.1 上的 TCP connect 探测（status 与 serve 启动各一次，超时即视为不在）。
 * 桌面版数据目录名与端口默认值在这里各留一份常量，与 desktop/src-tauri/src/config.rs
 * 对齐，改一侧必须改另一侧（test/run.mjs 的 [26] 段会同时比对两边文本，防止漂移）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { DEFAULT_PORT, RUNTIME_DATA_DIR } from './config.js';

/** 桌面版新默认端口（#87：桌面版让位，旧版保持 8787 不动，避免打断既有书签/任务计划）。 */
export const DESKTOP_DEFAULT_PORT = 18787;
/** 桌面版数据目录名 = desktop/src-tauri/src/config.rs::data_dir 的最后一段。 */
export const DESKTOP_DATA_DIR_NAME = 'TokenMonitor2';
/** #89：旧版源码形态的运行数据目录在 %LOCALAPPDATA%\TokenMonitor —— 与桌面版 NSIS
 *  currentUser 的安装目录同名，卸载桌面版会把旧版的日志和锁一起删掉。 */
export const LEGACY_RUN_DIR_NAME = 'TokenMonitor';

/** 桌面版数据目录（非 Windows 或缺 LOCALAPPDATA 时返回 null：没有目录就没有冲突面）。 */
export function desktopDataDir(env = process.env) {
  const local = env.LOCALAPPDATA;
  if (!local) return null;
  return join(local, DESKTOP_DATA_DIR_NAME);
}

/** 本机上可能的旧版运行数据目录（去重后用于报告；含 #89 改名前的旧位置）。 */
export function legacyRunDirs(env = process.env, home = homedir(), runtimeDir = RUNTIME_DATA_DIR) {
  const local = env.LOCALAPPDATA;
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  push(runtimeDir);
  push(dataDirOf(env, home));
  if (local) {
    push(join(local, LEGACY_RUN_DIR_NAME));
    push(join(local, 'TokenMonitor-Server'));
  }
  push(join(home, '.tokenmonitor'));
  return out;
}

/** 旧版数据库目录（源码形态），与 runtimeDir 分开解析，便于只读探测。 */
export function dataDirOf(env = process.env, home = homedir()) {
  if (env.TOKENMONITOR_DATA_DIR) return env.TOKENMONITOR_DATA_DIR;
  return join(home, '.tokenmonitor');
}

/**
 * 桌面版装了没有、配在哪个端口。settings.json 读不出端口时退回默认值，
 * 但 installed 仍为 true——损坏的设置文件不等于没装桌面版。
 */
export function inspectDesktopInstall(dir = desktopDataDir()) {
  if (!dir) {
    return { installed: false, dir: null, port: DESKTOP_DEFAULT_PORT, portFromSettings: false, reason: 'no LOCALAPPDATA' };
  }
  const settingsPath = join(dir, 'settings.json');
  if (!existsSync(settingsPath)) {
    return { installed: false, dir, port: DESKTOP_DEFAULT_PORT, portFromSettings: false, reason: 'settings.json absent' };
  }
  let port = DESKTOP_DEFAULT_PORT;
  let portFromSettings = false;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const n = Number(parsed?.port);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) { port = n; portFromSettings = true; }
  } catch { /* 损坏文件：按默认端口报告，不猜、不抛 */ }
  return { installed: true, dir, port, portFromSettings, reason: 'settings.json present' };
}

/** 单次回环 TCP 探测；连上即视为有监听者。不发送任何字节。 */
export function probeTcpPort({ host = '127.0.0.1', port, timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return resolve(false);
    let settled = false;
    const sock = net.connect({ host, port });
    const done = (v) => { if (settled) return; settled = true; sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.once('close', () => { if (!settled) done(false); });
  });
}

/**
 * 端口冲突的可执行结论。netstat/tasklist 只能给出 image name，而两个产品都发
 * TokenMonitor.exe（#89），所以同名时必须把两种可能都列出来，不能指认。
 */
export function describePortConflict({
  port = DEFAULT_PORT,
  holderPid = null,
  holderImage = null,
  ownPortOf = '旧版 Node 后台',
} = {}) {
  const who = holderImage || '未知进程';
  const lines = [`${ownPortOf}需要的端口 127.0.0.1:${port} 已被 ${who}${holderPid ? ` (PID ${holderPid})` : ''} 占用`];
  if (/^TokenMonitor\.exe$/i.test(String(holderImage || ''))) {
    lines.push('  TokenMonitor.exe 这个文件名两个产品都有（旧版启动器与桌面版主程序），无法据此指认——'
      + `看它的安装路径：旧版在 %LOCALAPPDATA%\\Programs\\TokenMonitor，桌面版在 %LOCALAPPDATA%\\${LEGACY_RUN_DIR_NAME}。`);
  }
  lines.push('  旧版不再静默降级，也不会去杀占用者：请改用 --port 指定其它端口，或先停掉占用它的那个产品。');
  return lines;
}

/**
 * 共存报告（status 用）。返回若干行文本；探测失败不抛，最多是"未检测到"。
 *
 * 两套登录自启也是各自的（#87）：旧版是任务计划 TokenMonitor-Server（schtasks /Query，
 * 只读），桌面版是 tauri-plugin-autostart 写的 HKCU Run 值（reg query，只读）。
 * 两条命令都**只查询、不创建不删除**，且在测试里全部走注入；本机默认机器上它们最多
 * 返回"不存在"。
 */
export async function coexistenceLines({
  env = process.env,
  ownPort = DEFAULT_PORT,
  probe = probeTcpPort,
  install = desktopDataDir(env),
  run = runReadOnly,
  platform = process.platform,
} = {}) {
  const desktop = inspectDesktopInstall(install);
  const running = desktop.installed ? await probe({ port: desktop.port }) : false;
  const lines = [
    `desktop_edition: ${desktop.installed ? `installed (${desktop.dir})` : 'not installed'}`,
    `desktop_port: ${desktop.port}${desktop.portFromSettings ? '' : ' (default)'}`,
    `desktop_running: ${running ? 'yes' : 'no'}`,
  ];
  if (running && desktop.port === Number(ownPort)) {
    lines.push(`port_conflict: 桌面版与旧版都想用 127.0.0.1:${ownPort}（#87 起桌面版默认端口应为 ${DESKTOP_DEFAULT_PORT}；仍是旧值说明它的 settings.json 是升级前写下的，请改其中一侧）`);
  }
  const autostart = await detectAutostart({ run, platform });
  lines.push(`legacy_logon_task: ${autostart.legacyTask}`);
  lines.push(`desktop_logon_entry: ${autostart.desktopRunKey}`);
  return lines;
}

/** 同步跑一条只读命令；非零退出/找不到命令都归一化成 'no'，异常不外抛。 */
export function runReadOnly(file, args) {
  try {
    const res = spawnSync(file, args, { encoding: 'utf8', timeout: 4000, windowsHide: true });
    if (res.error) return { ok: false, out: '', err: String(res.error.message || res.error) };
    return { ok: res.status === 0, out: `${res.stdout || ''}${res.stderr || ''}`, err: '' };
  } catch (e) {
    return { ok: false, out: '', err: String(e?.message ?? e) };
  }
}

/**
 * 两个产品各自的登录自启入口（只读）。
 * 'unknown' 只在拿不准时出现——把"查询失败"说成"没有自启"会让人以为干净了。
 */
export async function detectAutostart({
  run = runReadOnly,
  platform = process.platform,
  taskName = 'TokenMonitor-Server',
  desktopRunValueName = 'TokenMonitor',
} = {}) {
  if (platform !== 'win32') return { legacyTask: 'not-applicable', desktopRunKey: 'not-applicable' };
  const q = run('schtasks.exe', ['/Query', '/TN', taskName]);
  const legacyTask = q.ok ? 'yes' : (/cannot find|not found|找不到/i.test(`${q.out}${q.err}`) ? 'no' : 'unknown');
  const r = run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', desktopRunValueName]);
  // reg.exe 的真实措辞是 "ERROR: The system was unable to find the specified registry
  // key or value."，只匹配 "...specified value" 会漏掉它而误报 unknown。
  const desktopRunKey = r.ok
    ? (new RegExp(desktopRunValueName, 'i').test(r.out) ? 'yes' : 'unknown')
    : (/unable to find the specified|cannot find the (file|key|value)/i.test(`${r.out}${r.err}`) ? 'no' : 'unknown');
  return { legacyTask, desktopRunKey };
}
