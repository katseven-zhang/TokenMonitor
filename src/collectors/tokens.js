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
