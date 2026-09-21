import { win32 } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';
import { tokenCount } from './tokens.js';

/**
 * WorkBuddy 采集器：~/.WorkBuddy/projects/<dir>/<session>.jsonl（Electron 版 transcript）。
 *
 * - usage 在记录的 message.usage（OpenAI 口径：input_tokens 已含 cache_read，
 *   实测 total = input + output）；
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

    if (rec?.type === 'function_call' && rec.name && rec.callId && Number.isFinite(rec.timestamp)) {
      store.insertToolCall({
        ts: rec.timestamp,
        tool,
        name: rec.name,
        session_id: rec.sessionId || fileId,
        dedup_key: `wb:tc:${rec.callId}`,
      });
    }

    const u = rec?.message?.usage;
    if (!u || !rec.id || !Number.isFinite(rec.timestamp)) return;
    // #96：数字形态的字符串先转整数再相加（tokens.js）
    const inputRaw = tokenCount(u.input_tokens);
    const cached = Math.min(tokenCount(u.cache_read_input_tokens), inputRaw);
    const output = tokenCount(u.output_tokens);
    if (inputRaw + output <= 0) return;

    const pd = rec.providerData || {};
    inserted += store.insertEvent({
      ts: rec.timestamp,
      tool,
      model: normalizeModel(pd.model),
      session_id: rec.sessionId || fileId,
      project,
      input_tokens: inputRaw - cached,
      cached_input: cached,
      cache_write: 0,
      output_tokens: output,
      reasoning_tokens: 0,
      total_tokens: inputRaw + output,
      dedup_key: `wb:${rec.id}`,
      trace_id: pd.traceId || null,
    });
  });

  return { newOffset, inserted };
}
