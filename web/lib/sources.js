/** 来源元数据合并与回退（#16 UI-Sources）。
 *
 *  /api/sources 的注册表元数据 + web/lib/theme.js 的内建品牌表合并成一张查询表：
 *  - 内建 9 源的颜色/标签永远优先（不无故改变）；
 *  - 新来源（Antigravity / TRAE / Hermes…）注册后，前端零改动即可显示；
 *  - 数据里出现但注册表没有的未知工具，取确定性回退色：同 tool 恒同色。
 *
 *  纯函数、无 DOM，可被 test/run.mjs 与专属测试直接 import。
 */

/** 工具名 → 确定性回退色：字符串哈希散列到黄金角色相，深色底可读。 */
export function fallbackColorFor(tool) {
  const s = String(tool ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return hslToHex((h * 137.508) % 360, 0.5, 0.6);
}

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * 合并内建品牌表与 /api/sources 载荷。
 * - colors/labels：内建优先（9 源颜色/标签不因 API 改变）；API 新源补回退色，
 *   label 缺省退回 tool id；
 * - kinds/billed：注册表能力面（jsonl/sqlite/zst、是否计 API 钱包）；
 * - errors：注册表加载错误透传（服务端已抹掉绝对路径），供健康条展示；
 * - payload 兼容旧服务端：无 sources / 非数组 → 完全退化为内建，不抛错。
 */
export function mergeSourceMeta(builtinColors, builtinLabels, payload) {
  const colors = { ...builtinColors };
  const labels = { ...builtinLabels };
  const kinds = {};
  const billed = {};
  const added = [];
  const list = Array.isArray(payload?.sources) ? payload.sources : [];
  for (const src of list) {
    if (!src || typeof src.tool !== 'string' || !src.tool) continue;
    const tool = src.tool;
    if (!(tool in colors)) {
      colors[tool] = fallbackColorFor(tool);
      added.push(tool);
    }
    if (!(tool in labels)) labels[tool] = typeof src.label === 'string' && src.label ? src.label : tool;
    kinds[tool] = typeof src.kind === 'string' ? src.kind : null;
    billed[tool] = src.apiBilled === true;
  }
  return {
    colors,
    labels,
    kinds,
    billed,
    added,
    errors: Array.isArray(payload?.errors) ? payload.errors : [],
  };
}

/** 图例/徽章用的展示名：注册标签优先，未知工具直接展示 tool id（调用方负责 esc）。 */
export function displayLabelOf(meta, tool) {
  return meta?.labels?.[tool] ?? String(tool ?? '');
}
