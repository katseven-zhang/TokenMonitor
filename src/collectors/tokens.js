/**
 * token 计数的取值规则（#96）。
 *
 * 上游 JSON 里同一个用量字段可能是数字，也可能是**数字形态的字符串**（网关/中间层
 * 回填 usage 时的常见写法）。而 `input + cached + cacheWrite + output` 里只要有一项
 * 是字符串，JS 做的就是拼接而不是相加：
 *
 *     "123" + 0 + 0 + 456 → "12300456"
 *
 * 落库时 events.total_tokens 是 INTEGER 列，SQLite 的 INTEGER 亲和性会把这串数字文本
 * 再转成整数 12,300,456 —— 一次 579 token 的调用被记成 1230 万，凭空放大四个数量级，
 * 而且不报错、不产生坏行计数，健康面板一切正常。
 *
 * 所以求和之前必须逐项强转整数，字符串不允许进加法。非数字文本（`"12a"`）、NaN、
 * Infinity、null/undefined 一律按 0 处理，与桌面端 `collectors.rs::number()` 同一条
 * 规则（双端共享 fixture 见 test/run.mjs 的 [27] 段与
 * desktop/src-tauri/tests/sources.rs）。
 */
export function tokenCount(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 秒/毫秒归一（#85：与桌面端 `collectors.rs::timestamp()` 同一个边界）。
 *
 * dsh 的 `time` 与 WorkBuddy 的 `timestamp` 粒度不总是毫秒。归一前，秒级记录会被当成
 * 毫秒直接落库，事件落到 1970-01-21 —— Node 面板的"今日/本周"里根本没有它，桌面端
 * （早就在 timestamp() 里做了这个判断）却照常统计，同一份日志在两个 UI 里的合计不同。
 * 边界取 1e11 毫秒（公元 5138 年）：真实毫秒值远小于它，真实秒值也远小于它，
 * 两端必须用同一个常数，否则边界两侧的记录又会分家。
 * 返回 0 表示"没有可用时间"，由调用方决定跳过该条。
 */
export function epochMs(value) {
  let n = typeof value === 'number' ? value : Number(value);
  // 桌面端 timestamp() 的两条分支：先按数字判粒度，数字读不出来再按 ISO 字符串解析
  if (!Number.isFinite(n) && typeof value === 'string' && value.trim()) n = Date.parse(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? Math.trunc(n * 1000) : Math.trunc(n);
}
