import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

export const HOME = homedir();

/**
 * 数据源注册表由 src/sources/*.js 清单加载（见 source-registry.js）。
 * kind: jsonl | sqlite | zst；version 落后时全量重扫。
 * apiBilled 仍表示是否计入用户 API key 余额对账。
 */
export { SOURCES, SOURCE_ERRORS } from './source-registry.js';

/**
 * 离线模式（TOKENMETER_OFFLINE=1）：完全不发外网请求。
 * 服务平时会访问三类外部端点——汇率接口、LiteLLM 牌价表、厂商余额接口（带 API key），
 * 离线时全部跳过，改用本地缓存 / pricing.json 的手动汇率 / 种子价继续出数。
 * 运行期读取，便于测试与用户临时切换。
 */
export const isOffline = () => process.env.TOKENMETER_OFFLINE === '1';

export const DATA_DIR = join(HOME, '.tokenmeter');
export const DB_PATH = join(DATA_DIR, 'tokenmeter.db');
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
