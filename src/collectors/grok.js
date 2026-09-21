import { win32 } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';
import { tokenCount } from './tokens.js';

/**
 * Grok Build 采集器：~/.grok/sessions/<项目目录(URL编码)>/<会话id>/updates.jsonl。
 *
 * - 轮次用量在 turn_completed 事件：params.update.usage（inputTokens 含 cachedRead，
 *   OpenAI 口径；modelUsage 为逐模型拆分；costUsdTicks 为厂商侧成本刻度，暂存原始值）；
 * - 工具调用在 tool_call 事件（title/kind 为名，toolCallId 去重）；
 * - timestamp 为 Unix 秒（防御性兼容毫秒）。
 *
 * Windows 实测目录名是 encodeURIComponent(绝对路径)，例如
 * `D%3A%5CAgentData%5C...%5CTokenMonitor`（%5C = 反斜杠，%3A = 冒号）。
 * 必须用 path.win32，禁止 split('/') / lastIndexOf('/')：POSIX 切法在反斜杠路径上
 * 会得到整段字符串，项目名就会变成整条 URL 编码路径。
 */
function projectFromDir(p) {
  // .../sessions/<项目目录(URL编码)>/<会话uuid>/updates.jsonl → 取项目目录。
  const encoded = win32.basename(win32.dirname(win32.dirname(p)))
    || win32.basename(win32.dirname(p));
  let decoded = encoded;
  try { decoded = decodeURIComponent(encoded); } catch { /* 非法 % 序列：保持原名 */ }
  return win32.basename(decoded) || decoded;
}

function stripCR(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

export async function collectGrokFile(store, { tool, path, fileId, offset }) {
  let inserted = 0;
  let liveMax = 0;       // 本次扫描批次内的最大上下文水位（流式 _meta.totalTokens）
  let liveTs = 0;
  let liveSid = null;
  const project = projectFromDir(path);

  const { newOffset } = await readLinesFrom(path, offset, (raw) => {
    const line = stripCR(raw);
    if (!line.includes('"turn_completed"') && !line.includes('"sessionUpdate":"tool_call"') && !line.includes('"totalTokens"')) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const p = rec?.params;
    const upd = p?.update;
    if (!p || !upd) {
      // 非标准 update 行也可能是携带 totalTokens 的分片
      return;
    }
    let ts = Number(rec.timestamp) || 0;
    if (ts > 0 && ts < 1e12) ts *= 1000; // 秒 → 毫秒
    if (!ts) return;

    // 流式水位：轮次进行中的实时上下文规模（非消耗量）
    const meta = p._meta;
    if (meta && typeof meta.totalTokens === 'number' && meta.totalTokens > liveMax) {
      liveMax = meta.totalTokens;
      liveTs = ts;
      liveSid = p.sessionId || liveSid;
    }

    if (upd.sessionUpdate === 'tool_call') {
      const name = upd.title || upd.kind;
      if (name && upd.toolCallId) {
        store.insertToolCall({
          ts, tool, name, session_id: p.sessionId || fileId,
          dedup_key: `grok:tc:${upd.toolCallId}`,
        });
      }
      return;
    }
    if (upd.sessionUpdate === 'turn_completed' && upd.usage) {
      const u = upd.usage;
      // #96：`modelUsage: {}`（网关在降级轮次里就是这么写的）会让 Object.entries 得到
      // 空数组，于是 for 循环一次都不执行——整轮的用量凭空消失，且不报错。空对象必须
      // 与"没有该字段"同义：回落到轮次级的汇总 usage。
      const entries = u.modelUsage && typeof u.modelUsage === 'object'
        ? Object.entries(u.modelUsage) : [];
      const models = entries.length ? entries : [[null, u]];
      for (const [model, m] of models) {
        const input = tokenCount(m.inputTokens);
        const cached = Math.min(tokenCount(m.cachedReadTokens), input);
        const cacheW = tokenCount(m.cacheCreationTokens);
        const output = tokenCount(m.outputTokens);
        const total = input + cacheW + output;
        if (total <= 0) continue;
        inserted += store.insertEvent({
          ts,
          tool,
          model: normalizeModel(model || 'grok'),
          session_id: p.sessionId || fileId,
          project,
          input_tokens: input - cached,
          cached_input: cached,
          cache_write: cacheW,
          output_tokens: output,
          reasoning_tokens: tokenCount(m.reasoningTokens),
          total_tokens: total,
          dedup_key: `grok:${p.sessionId}:${upd.prompt_id}:${model ?? 'x'}`,
        });
      }
    }
  });

  // 进行中的轮次：把实时上下文水位写入 quota 快照（健康条/面板显示"进行中"）
  if (liveMax > 0) {
    store.saveQuota('grok:live', liveTs || Date.now(), {
      context_tokens: liveMax, session_id: liveSid || fileId, project,
    });
  }
  return { newOffset, inserted };
}
