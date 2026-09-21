import { win32 } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';
import { tokenCount, epochMs } from './tokens.js';

/**
 * WorkBuddy 采集器：~/.WorkBuddy/projects/<dir>/<session>.jsonl（Electron 版 transcript）。
 *
 * - usage 在记录的 `message.usage`（OpenAI 口径：input_tokens 已含 cache_read，
 *   `total = input + cache_write + output`）；缓存写入/思考量与 codex 一样有
 *   `cache_creation_input_tokens` / `cache_write_input_tokens` 与
 *   `reasoning_output_tokens` 三种字段名，#85 起两端都认（此前这边把 cache_write 与
 *   reasoning 写死成 0，逐字段对账永远对不上）；
 * - providerData 携带 model（真实名，如 glm-5.3-flash）与 traceId（轮次键，
 *   供 credit 对账与费率自学习）；
 * - 工具调用在 type=function_call 记录（name + callId 去重）；
 * - 项目名从目录名解出（...-WorkBuddy-<名称>）。Windows 上必须用 path.win32，
 *   禁止 lastIndexOf('/')：找不到 '/' 会把项目名切成文件名残片。
 */
function projectFromDir(fileDir) {
  const name = win32.basename(fileDir);
  const m = name.match(/-WorkBuddy-(.+)$/);
  return m ? m[1] : name;
}

function stripCR(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

export async function collectWorkbuddyFile(store, { tool, path, fileId, offset }) {
  let inserted = 0;
  // 用 path.win32.dirname 而不是 lastIndexOf('/')：Windows 上分隔符是反斜杠，
  // 原写法找不到 '/' 会退化成 slice(0, -1)，把项目名切成文件名的残片
  const project = projectFromDir(win32.dirname(path));

  const { newOffset } = await readLinesFrom(path, offset, (raw) => {
    const line = stripCR(raw);
    if (!line.includes('"usage"') && !line.includes('"function_call"')) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }

    // #85：timestamp 的粒度不总是毫秒，桌面端 timestamp() 一直在归一，这里此前直接用
    // 原值——秒级记录落到 1970 年，同一份 transcript 在两个 UI 里的窗口合计不同。
    const ts = epochMs(rec?.timestamp);
    if (rec?.type === 'function_call' && rec.name && rec.callId && ts) {
      store.insertToolCall({
        ts,
        tool,
        name: rec.name,
        session_id: rec.sessionId || fileId,
        dedup_key: `wb:tc:${rec.callId}`,
      });
    }

    const u = rec?.message?.usage;
    if (!u || !rec.id || !ts) return;
    // #96：数字形态的字符串先转整数再相加（tokens.js）
    const inputRaw = tokenCount(u.input_tokens);
    // #85：缓存命中在 WorkBuddy 的 transcript 里有 `cached_input_tokens` 与
    // `cache_read_input_tokens` 两种写法（与 codex 的 #75 同一类字段漂移）。
    // 此前这里只认后者，写前者的轮次在这端记 0 缓存命中。
    const cached = Math.min(
      Math.max(tokenCount(u.cached_input_tokens), tokenCount(u.cache_read_input_tokens)),
      inputRaw);
    // #85：cache_write 与 reasoning 此前被写死成 0，而桌面端 openai(usage) 一直在读
    // 它们——同一份 transcript 的 cache_write 在两个 UI 里恒有一边是 0，逐字段对账
    // 永远对不上。两种拼写取 max（同一 payload 只出一种），与桌面端同式。
    const cacheWrite = Math.max(
      tokenCount(u.cache_creation_input_tokens),
      tokenCount(u.cache_write_input_tokens));
    const output = tokenCount(u.output_tokens);
    const reasoning = tokenCount(u.reasoning_output_tokens);
    // OpenAI 口径：input 已含缓存 → total = input + cache_write + output（拆列后不变）。
    // 关卡也从 `input + output <= 0` 换成 total<=0：只带缓存写入的一轮此前在这边被丢掉、
    // 桌面端却记下来（它只有 total>0 一道关），两端请求数因此不同。
    const total = inputRaw + cacheWrite + output;
    if (total <= 0) return;

    const pd = rec.providerData || {};
    inserted += store.insertEvent({
      ts,
      tool,
      model: normalizeModel(pd.model),
      session_id: rec.sessionId || fileId,
      project,
      input_tokens: inputRaw - cached,
      cached_input: cached,
      cache_write: cacheWrite,
      output_tokens: output,
      reasoning_tokens: reasoning,
      total_tokens: total,
      dedup_key: `wb:${rec.id}`,
      trace_id: pd.traceId || null,
    });
  });

  return { newOffset, inserted };
}
