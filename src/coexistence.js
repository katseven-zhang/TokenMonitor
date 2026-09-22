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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { DEFAULT_PORT, RUNTIME_DATA_DIR, RUNTIME_DIR_NAME, LEGACY_SHARED_RUN_DIR_NAME } from './config.js';

/** 桌面版新默认端口（#87：桌面版让位，旧版保持 8787 不动，避免打断既有书签/任务计划）。 */
export const DESKTOP_DEFAULT_PORT = 18787;
/** 桌面版数据目录名 = desktop/src-tauri/src/config.rs::data_dir 的最后一段。 */
export const DESKTOP_DATA_DIR_NAME = 'TokenMonitor2';
/**
 * #89：桌面版 NSIS 在 installMode=currentUser 下的默认安装目录是
 * `%LOCALAPPDATA%\<productName>` = `%LOCALAPPDATA%\TokenMonitor`（productName 取自
 * desktop/src-tauri/tauri.conf.json，Tauri 未提供改这个目录的配置项），而旧版源码形态
 * 改名前的运行数据目录正是同一个路径 —— 卸载桌面版会把旧版的日志和运行锁整棵删掉。
 * 一个名字同时属于两个产品，这本身就是冲突；常量只在 config.js 定义一次，两边共用。
 */
export const LEGACY_RUN_DIR_NAME = LEGACY_SHARED_RUN_DIR_NAME;
/** 两张价表都只承认这两种币种（桌面版 Prices::parse 同样只放行 USD/CNY）。 */
const PRICE_CURRENCIES = new Set(['USD', 'CNY']);

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
    push(join(local, RUNTIME_DIR_NAME));
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
 * 两条命令都**只查询、不创建不删除**，且在测试里全部走注入；默认机器上它们最多
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
  lines.push(...runDirCollisionLines(inspectRunDirCollision({ env })));
  lines.push(...priceTableLines(inspectPriceTables({ env })));
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

/**
 * #89：两张牌价表 —— 旧版 `~/.tokenmonitor/pricing.json` 与桌面版
 * `%LOCALAPPDATA%\TokenMonitor2\prices.json`。名字像、schema 完全不同
 * （旧版 `models[id] = {currency, input_miss, input_hit, output, off_peak}`；
 * 桌面版 `models[id] = [{currency, input, cached, cacheWrite, output, effectiveFrom?}...]`），
 * 而且互不同步：在一侧改了价，另一侧仍按旧价计费，此前没有任何一侧会说话。
 *
 * 只做"发现并说出来"。合并两张表要动计费口径（峰谷系数、缓存价、effectiveFrom 历史、
 * 汇率取值时刻各不相同），猜错比不说更糟，所以：同 id + 桌面侧只有单一版本（没有
 * effectiveFrom 历史）+ 两边币种相同 才做数值比对，其余一律计入"不可比"。
 * 只读：不写文件、不改任何一张表。
 */
export function inspectPriceTables({
  env = process.env,
  home = homedir(),
  legacyPath = join(dataDirOf(env, home), 'pricing.json'),
  desktopPath = join(desktopDataDir(env) || join(home, '_none'), 'prices.json'),
  exists = existsSync,
  read = readFileSync,
  stat = statSync,
} = {}) {
  const load = (p) => {
    if (!exists(p)) return { path: p, present: false, broken: false, models: new Map(), mtimeMs: 0, fileCurrency: null };
    let mtimeMs = 0;
    try { mtimeMs = stat(p).mtimeMs; } catch { /* 读不到时间不影响后续 */ }
    let parsed = null;
    try { parsed = JSON.parse(read(p, 'utf8')); } catch { return { path: p, present: true, broken: true, models: new Map(), mtimeMs, fileCurrency: null }; }
    const models = new Map();
    const raw = parsed?.models;
    if (raw && typeof raw === 'object') {
      for (const [id, entry] of Object.entries(raw)) models.set(id, entry);
    }
    // 只认 USD/CNY：桌面版 Rust 的 Prices::parse 就只放行这两个，读到别的说明文件不是
    // 它能吃的那份，宁可不猜。
    const fc = String(parsed?.currency ?? '').toUpperCase();
    return { path: p, present: true, broken: false, models, mtimeMs, fileCurrency: PRICE_CURRENCIES.has(fc) ? fc : null };
  };
  const legacy = load(legacyPath);
  const desktop = load(desktopPath);
  /**
   * 旧版一侧：input_miss 是未缓存输入价，output 是输出价。
   * 币种缺省必须是 CNY —— pricing.js::priceOf 写的是 `local.currency === 'USD' ? 价×汇率 : 价`，
   * 也就是"非 USD（含没写）一律按人民币直价"。按字面当成"未知"会让整个比对失去意义。
   */
  const legacyEntry = (e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    if (!Number.isFinite(Number(e.input_miss)) || !Number.isFinite(Number(e.output))) return null;
    const currency = String(e.currency ?? '').toUpperCase() || 'CNY';
    return PRICE_CURRENCIES.has(currency) ? { currency, input: Number(e.input_miss), output: Number(e.output) } : null;
  };
  /**
   * 桌面版一侧：数组是价格历史，多条就没法断定"当前价"。
   * 单条币种的取法与 Rust 一致（pricing.rs::cost_parts）：
   * `rate.currency.as_deref().unwrap_or(&self.currency)` —— 条目没写就回落到文件级
   * `currency`。漏了这层回落，手改过、按 schema 合法省掉币种的文件会被整片判成
   * "不可比"，而这类文件恰恰是最可能已经和另一侧漂移的那批。
   */
  const desktopEntry = (e, fileCurrency) => {
    if (!Array.isArray(e) || e.length !== 1) return null;
    const one = e[0];
    if (!one || typeof one !== 'object') return null;
    if (one.effectiveFrom != null) return null;
    if (!Number.isFinite(Number(one.input)) || !Number.isFinite(Number(one.output))) return null;
    const currency = String(one.currency ?? '').toUpperCase() || String(fileCurrency ?? '').toUpperCase();
    return PRICE_CURRENCIES.has(currency) ? { currency, input: Number(one.input), output: Number(one.output) } : null;
  };
  const comparable = [];
  const diverged = [];
  const notComparable = [];
  for (const [id, lRaw] of legacy.models) {
    if (!desktop.models.has(id)) continue;
    const l = legacyEntry(lRaw);
    const d = desktopEntry(desktop.models.get(id), desktop.fileCurrency);
    if (!l || !d || l.currency !== d.currency) { notComparable.push(id); continue; }
    comparable.push(id);
    if (l.input !== d.input || l.output !== d.output) diverged.push({ id, currency: l.currency, legacy: l, desktop: d });
  }
  return {
    bothPresent: legacy.present && desktop.present,
    legacy,
    desktop,
    sharedIds: comparable.length + notComparable.length,
    comparable,
    diverged,
    notComparable,
    /** 哪一侧更晚被编辑：这是"改了这边、那边还在按旧价计费"最直接的可见信号。 */
    newerSide: (!legacy.present || !desktop.present) ? null
      : (legacy.mtimeMs === desktop.mtimeMs ? 'same' : (legacy.mtimeMs > desktop.mtimeMs ? 'legacy' : 'desktop')),
  };
}

/** inspectPriceTables 的人话摘要，供 status / serve 启动日志用。 */
export function priceTableLines(report = inspectPriceTables()) {
  if (!report.bothPresent) {
    return [`price_tables: 本机只有${report.legacy.present ? '旧版 pricing.json' : report.desktop.present ? '桌面版 prices.json' : '任何一张'}价表，不存在双表打架`];
  }
  const at = (ms) => { try { return new Date(ms).toISOString().slice(0, 16); } catch { return '?'; } };
  const lines = [
    `price_tables: 两张互不同步的价表——旧版 ${report.legacy.path}（${at(report.legacy.mtimeMs)}）`
    + ` / 桌面版 ${report.desktop.path}（${at(report.desktop.mtimeMs)}）；改一边不会改另一边`,
  ];
  if (report.newerSide && report.newerSide !== 'same') {
    lines.push(`price_tables: 更晚被编辑的是${report.newerSide === 'legacy' ? '旧版' : '桌面版'}那一张，另一张仍按它自己的旧价计费`);
  }
  // 解析不了的那一侧必须单独说：否则 models 是空表，下面两行会报"没有可比模型"，
  // 把"这张表坏了"听成"两边没重叠"——恰恰是本次要消灭的那类静默。
  for (const side of [['旧版', report.legacy], ['桌面版', report.desktop]]) {
    if (side[1].broken) lines.push(`price_tables: ${side[0]}那一张 ${side[1].path} 不是合法 JSON，本轮未做比对（先修文件再看有没有漂移）`);
  }
  if (report.diverged.length) {
    lines.push(`price_tables: ${report.diverged.length} 个同名模型两边数字已经不一致（可比的 ${report.comparable.length} 个里）：`
      + report.diverged.slice(0, 5).map((d) => `${d.id} ${d.currency} 旧版 in=${d.legacy.input}/out=${d.legacy.output} vs 桌面版 in=${d.desktop.input}/out=${d.desktop.output}`).join('；')
      + (report.diverged.length > 5 ? ' …' : ''));
  } else if (report.comparable.length) {
    lines.push(`price_tables: 可比的 ${report.comparable.length} 个同名模型两侧数字一致`);
  }
  if (report.notComparable.length) {
    lines.push(`price_tables: 另有 ${report.notComparable.length} 个同名模型因币种/价格历史/字段形态无法断定，未做比对（不猜）`);
  }
  return lines;
}

/**
 * #89：旧版的运行数据目录有没有正好落在桌面版卸载目录里。
 *
 * 只报事实，不搬任何东西：改名发生在 config.js::resolveDataLocations，且只对**新机器**
 * 生效（直接落到只属于旧版的名字）。已经在共用目录里留过日志/锁的老用户原地继续——
 * 悄悄改名会把他们的历史日志和 gui-settings.json 变成孤儿，比共用一个名字更糟。
 * 彻底解掉需要产品裁定（见 docs/WINDOWS.md 第 8 节）：Tauri 没暴露改 NSIS 安装目录的
 * 配置项，只能换 productName 或 fork NSIS 模板，两者都会牵动桌面版自己的数据目录与
 * 已装机用户的卸载入口，不是这轮能顺手改的。
 */
export function inspectRunDirCollision({
  env = process.env,
  runtimeDir = RUNTIME_DATA_DIR,
} = {}) {
  const local = env.LOCALAPPDATA;
  if (!local) {
    return { runtimeDir, nsisInstallDir: null, renamedDir: null, atRisk: false };
  }
  const nsisInstallDir = join(local, LEGACY_RUN_DIR_NAME);
  // Windows 路径大小写不敏感、分隔符可混用；判错方向的代价不对称——把"同路径"说成
  // "不同路径"会让人以为卸载是安全的，所以比较前统一化简，不做字面相等。
  const norm = (p) => String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
  return {
    runtimeDir,
    nsisInstallDir,
    renamedDir: join(local, RUNTIME_DIR_NAME),
    atRisk: norm(runtimeDir) === norm(nsisInstallDir),
  };
}

export function runDirCollisionLines(report = inspectRunDirCollision()) {
  if (!report.nsisInstallDir) {
    return ['run_dir: 没有 LOCALAPPDATA（非 Windows），不存在桌面版卸载目录撞旧版运行数据目录的问题'];
  }
  return report.atRisk
    ? [`run_dir: 旧版运行数据目录 ${report.runtimeDir} 与桌面版的 NSIS 卸载目录同路径——卸载桌面版会连旧版的日志和运行锁一起删。`
      + `#89 起新装机器改用只属于旧版的 ${report.renamedDir}；本机是老用户，日志原地保留、不自动搬（搬了会把历史日志变成孤儿）。`
      + '彻底分开需要产品裁定，见 docs/WINDOWS.md。']
    : [`run_dir: 旧版运行数据目录 ${report.runtimeDir}，已不在桌面版的 NSIS 卸载目录 ${report.nsisInstallDir} 里`];
}
