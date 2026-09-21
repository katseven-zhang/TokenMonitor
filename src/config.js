import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

export const HOME = homedir();

/**
 * 数据源注册表由 src/sources/*.js 清单加载（见 source-registry.js）。
 * kind: jsonl | sqlite | zst；version 落后时全量重扫。
 * apiBilled 仍表示是否计入用户 API key 余额对账。
 */
export { SOURCES, SOURCE_ERRORS } from './source-registry.js';

/**
 * 离线模式（TOKENMONITOR_OFFLINE=1）：完全不发外网请求。
 * 服务平时会访问三类外部端点——汇率接口、LiteLLM 牌价表、厂商余额接口（带 API key），
 * 离线时全部跳过，改用本地缓存 / pricing.json 的手动汇率 / 种子价继续出数。
 * 运行期读取，便于测试与用户临时切换。
 */
export const isOffline = () => process.env.TOKENMONITOR_OFFLINE === '1';

/**
 * 打包/安装形态检测：从本文件位置向上最多 maxUp 层找 manifest.json，且内容必须
 * 带 TokenMonitor/windows 标记（构建清单写入的字段）。仓库源码运行没有该清单，
 * 返回 null；这样 dist\windows-x64 与安装目录（<根>\manifest.json + <根>\runtime\src）
 * 命中两层，仓库与任意上级目录不会误判。
 */
export function detectAppRoot({
  from = import.meta.dirname,
  maxUp = 2,
  exists = existsSync,
  read = readFileSync,
} = {}) {
  let dir = from;
  for (let i = 0; i <= maxUp; i++) {
    const marker = join(dir, 'manifest.json');
    if (exists(marker)) {
      try {
        const j = JSON.parse(read(marker, 'utf8'));
        if (j && j.name === 'TokenMonitor' && j.os === 'windows') return dir;
      } catch { /* 损坏的清单不构成标记 */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 数据位置解析（#23，优先级从高到低）：
 * 1. TOKENMONITOR_DATA_DIR 环境变量——显式指定，数据库/日志/锁/设置统一落该目录；
 * 2. 打包/安装形态（检测到应用根）——统一落 <应用根>\data，用户看得见、随包走；
 * 3. 源码运行形态——数据库 ~/.tokenmonitor，运行数据（日志/锁）
 *    %LOCALAPPDATA%\TokenMonitor-Server（非 Windows 或缺 LOCALAPPDATA 时退回 ~/.tokenmonitor）。
 *
 * #89：第 3 条以前用的是 %LOCALAPPDATA%\TokenMonitor，而桌面版 NSIS 在
 * installMode=currentUser 下的默认安装目录就是 %LOCALAPPDATA%\<productName>
 * （productName = TokenMonitor，见 desktop/src-tauri/tauri.conf.json；Tauri 未提供改这个
 * 目录的配置项），两者路径完全相同。于是卸载桌面版会把旧版的日志和运行锁一起删掉，
 * 旧版的运行守卫还可能因锁被删而放行。新装机器改用只属于旧版的目录名。
 * 已经在那个目录里留下过日志或锁的老用户**继续用原目录**——改名会把他们的历史日志和
 * gui-settings.json 变成孤儿，比共享名字更糟。老机器的处置与需要的产品裁定见
 * docs/WINDOWS.md 共存一节。
 */
export const RUNTIME_DIR_NAME = 'TokenMonitor-Server';
/** #89 改名前旧版源码形态用过的目录名（= 桌面版 NSIS 安装目录名，冲突源）。 */
export const LEGACY_SHARED_RUN_DIR_NAME = 'TokenMonitor';

/**
 * 该目录看起来是不是旧版自己的运行数据。认两类只有旧版会留下的东西：
 * logs\ 里有 tokenmonitor 自己的日志文件（runtime.js::RuntimeLogger 写的
 * tokenmonitor.log 及其 .1/.2 轮转副本），或目录里有任一把 tokenmonitor-<port>.lock
 * （runtime.js::getLockFilePath）。
 *
 * 判据不能松到"有个 logs 目录就算"：判错的后果是旧版继续住进桌面版的卸载目录，
 * 也就是这个改名要修的那个问题本身，所以宁可判"不是"、新开一个目录。
 */
function hasLegacyRunArtifacts(dir, exists = existsSync, list = readdirSync) {
  if (!exists(dir)) return false;
  try {
    if (list(dir).some((n) => /^tokenmonitor-.*\.lock$/i.test(n))) return true;
  } catch {
    return false; // 读不动就按"不是旧版目录"处理，宁可新开一个目录也不去共用别人的目录
  }
  const logDir = join(dir, 'logs');
  if (!exists(logDir)) return false;
  try {
    return list(logDir).some((n) => /^tokenmonitor.*\.log$/i.test(n));
  } catch {
    return false;
  }
}

export function resolveDataLocations({
  env = process.env,
  home = HOME,
  platform = process.platform,
  appRoot,
  detect = detectAppRoot,
  exists = existsSync,
  list = readdirSync,
} = {}) {
  const root = appRoot !== undefined ? appRoot : detect();
  if (env.TOKENMONITOR_DATA_DIR) {
    return {
      portable: false,
      forced: true,
      appRoot: root,
      dbDir: env.TOKENMONITOR_DATA_DIR,
      runtimeDir: env.TOKENMONITOR_DATA_DIR,
    };
  }
  if (root) {
    const data = join(root, 'data');
    return { portable: true, forced: false, appRoot: root, dbDir: data, runtimeDir: data };
  }
  let runtimeDir = join(home, '.tokenmonitor');
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const shared = join(env.LOCALAPPDATA, LEGACY_SHARED_RUN_DIR_NAME);
    runtimeDir = hasLegacyRunArtifacts(shared, exists, list)
      ? shared // 老用户原地继续，不制造孤儿日志
      : join(env.LOCALAPPDATA, RUNTIME_DIR_NAME);
  }
  return {
    portable: false,
    forced: false,
    appRoot: null,
    dbDir: join(home, '.tokenmonitor'),
    runtimeDir,
  };
}

const LOCATIONS = resolveDataLocations();

export const DATA_DIR = LOCATIONS.dbDir;
export const DB_PATH = join(DATA_DIR, 'tokenmonitor.db');
/** 运行数据目录（日志/锁/GUI 设置）。源码形态与 DATA_DIR 不同，打包/强制形态二者相同。 */
export const RUNTIME_DATA_DIR = LOCATIONS.runtimeDir;
export const DATA_LOCATIONS = LOCATIONS;
export const DEFAULT_PORT = 8787;
export const WEB_DIR = join(import.meta.dirname, '..', 'web');
/**
 * ECharts 的磁盘路径。
 *
 * 不能写死 `<本包>/node_modules/echarts`：那只在仓库里直接跑时成立。作为依赖被安装时
 * （npx / npm i -g），npm 会把 echarts 提升到顶层 node_modules，嵌套路径根本不存在，
 * 于是 /vendor/echarts.min.js 返回 404 → echarts 全局缺失 → app.js 在 echarts.init
 * 处抛错 → 整个面板空白。1.2.0 就是这么坏的。
 *
 * 交给 Node 自己的解析算法：提升与嵌套两种布局都能找到。
 */
function resolveEcharts() {
  try {
    return createRequire(import.meta.url).resolve('echarts/dist/echarts.min.js');
  } catch {
    // 兜底：echarts 未安装时给出仓库内的预期路径，由 serveFile 统一报 404
    return join(import.meta.dirname, '..', 'node_modules', 'echarts', 'dist', 'echarts.min.js');
  }
}

export const ECHARTS_PATH = resolveEcharts();
