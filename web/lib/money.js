/**
 * 共享 CNY/USD 展示层（#38）——全站金额格式化的唯一入口。
 *
 * 契约：
 * - 后端返回的金额一律已是 CNY（定价侧已按牌价×汇率换算），所以
 *   USD = CNY ÷ 同一份 usd_to_cny；绝不另拉汇率、绝不在前端重新计价。
 * - 汇率来源/时间说明由 initMoney 从同一次 summary 响应吃进（usd_to_cny/fx_source/fx_ts），
 *   切换货币时调用方仍须展示 getFx() 的来源说明（AC：切换时来源/时间仍可见）。
 * - USD 保留 2 位小数、$ 前缀；CNY 保持 ¥ + 2 位；默认 CNY。
 * - 选择持久化 localStorage('tm.currency')；无 localStorage 环境（node 测试/隐私模式）安全降级为内存态。
 * - 厂商余额卡与对账行是原币种展示，不属于本模块（调用方不要用它格式化）。
 */

const LS_KEY = 'tm.currency';
let usdToCny = null;
let fxSource = null;
let fxTs = null;
let currency = 'CNY';
try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY) === 'USD') currency = 'USD';
} catch { /* 隐私模式等：内存态即可 */ }

/** 每次拿到新的 summary/costs 响应后调用：吃进同一次响应里的汇率与来源说明 */
export function initMoney(costsOrSummary = {}) {
  const c = costsOrSummary ?? {};
  if (typeof c.usd_to_cny === 'number' && Number.isFinite(c.usd_to_cny) && c.usd_to_cny > 0) {
    usdToCny = c.usd_to_cny;
  }
  if (c.fx_source !== undefined) fxSource = c.fx_source;
  if (c.fx_ts !== undefined) fxTs = c.fx_ts;
}

/** 切换货币并持久化；非法值回 CNY */
export function setCurrency(c) {
  currency = c === 'USD' ? 'USD' : 'CNY';
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, currency);
  } catch { /* 内存态 */ }
  return currency;
}

export function getCurrency() { return currency; }

/** 当前吃进的汇率事实（切换货币时来源/时间说明的数据源） */
export function getFx() { return { usd_to_cny: usdToCny, fx_source: fxSource, fx_ts: fxTs }; }

/**
 * 格式化一笔"后端口径为 CNY"的金额。
 * 汇率未就绪时：CNY 原样、USD 显示 '—'（不假装换算）；非数值一律 '—'（缺失不伪装成 0）。
 */
export function formatMoney(cnyAmount) {
  if (typeof cnyAmount !== 'number' || !Number.isFinite(cnyAmount)) return '—';
  if (currency === 'USD') {
    if (!usdToCny) return '—';
    return `$${(cnyAmount / usdToCny).toFixed(2)}`;
  }
  return `¥${cnyAmount.toFixed(2)}`;
}

/** ECharts 轴标签用的精简版（整数位，避免轴文字过长） */
export function formatMoneyAxis(cnyAmount) {
  if (typeof cnyAmount !== 'number' || !Number.isFinite(cnyAmount)) return '—';
  if (currency === 'USD') {
    if (!usdToCny) return '—';
    return `$${(cnyAmount / usdToCny).toFixed(0)}`;
  }
  return `¥${cnyAmount.toFixed(0)}`;
}
