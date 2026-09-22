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

/**
 * 缓存写入的两种拼写（#75）：`cache_creation_input_tokens` 与 `cache_write_input_tokens`
 * 是**同一个量**在不同版本里的两个名字，不是两个可以相加的量。规则必须只有一处实现——
 * codex 与 workbuddy 都读它，桌面端对应 `collectors.rs::cache_write_of`（openai() 里
 * 唯一那条 cache_write 通道，因此 workbuddy 与 codex 在桌面端天然同式）。
 *
 *  1. 只出一种 → 用它；两种都出且**数值相同** → 照用（只是重复写了一遍）。
 *  2. 两种都出且**数值不同** → 无法判定上游说的是哪个量，**拒读记 0**。旧规则
 *     `Math.max(两种)` 假设"同一份 payload 只会出其中一种"，此前没有任何 fixture
 *     证明过这个假设；而 max 等于凭空取一个上游从没说过的较大值。
 *
 * 第二个返回值 `ws`（写法）是 codex 累计差分专用的：0 都没写 / 1 只 creation / 2 只 write /
 * 3 两种都写且相等 / 4 两种都写但不等。相邻两条采样的 `ws` 都是"具体写法"（1/2/3）却不相同
 * 时，说明累计序列来自两个版本的写入方，跨写法差分必然为负、会被 `.max(0)` 静默清零，
 * 调用方要按"基线断了"处理。非累计的源（workbuddy）忽略 ws 即可。
 *
 * `readNumber` 让各源保留自己的数值口径（codex 用 `num()` 夹非负，workbuddy 用
 * `tokenCount()`），共享的只是"哪个写法算哪个数"这一条判定。
 */
export const CW_NONE = 0;
export const CW_CREATION = 1;
export const CW_WRITE = 2;
export const CW_SAME = 3;
export const CW_CONFLICT = 4;

export function cacheWriteOf(u, readNumber = tokenCount) {
  const hasA = u?.cache_creation_input_tokens !== undefined;
  const hasB = u?.cache_write_input_tokens !== undefined;
  if (hasA && hasB) {
    const a = readNumber(u.cache_creation_input_tokens);
    const b = readNumber(u.cache_write_input_tokens);
    if (a !== b) return { w: 0, ws: CW_CONFLICT }; // 无法判定：拒读，不取较大者
    return { w: a, ws: CW_SAME };
  }
  if (hasA) return { w: readNumber(u.cache_creation_input_tokens), ws: CW_CREATION };
  if (hasB) return { w: readNumber(u.cache_write_input_tokens), ws: CW_WRITE };
  return { w: 0, ws: CW_NONE };
}
