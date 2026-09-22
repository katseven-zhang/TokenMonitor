import { win32 } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';
import { tokenCount } from './tokens.js';

/**
 * Claude Code transcript 采集器（同时服务官方订阅 ~/.claude 与 ccmr 隔离目录
 * ~/.claude-gateway，格式完全一致，仅 tool 标签不同）。
 *
 * 每条 type=assistant 记录的 message.usage 即一次 API 调用用量；
 * 同一 message.id + requestId 可能因流式分片/会话复制重复出现，全局去重。
 * model="<synthetic>" 是本地合成消息（无真实用量），跳过。
 * project 来自 rec.cwd：Windows 路径必须用 path.win32.basename，禁止 split('/')。
 *
 * #96：工具调用的会话回退链与事件行同一条（`rec.sessionId || rec.session_id || fileId`）。
 * 这一处**不**升 SOURCES.version：`tool_calls.dedup_key` 里不含 session_id，全量重扫只会
 * 以 INSERT OR IGNORE 命中同一行，一行归属也改不回来——升版只换来一次全量重扫的成本。
 * 已入库的行保持原归属，修正只作用于之后写入的行。
 */
export async function collectClaudeFile(store, { tool, path, fileId, offset }) {
  let inserted = 0;

  const { newOffset } = await readLinesFrom(path, offset, (line) => {
    // 廉价预过滤：绝大多数行不含 usage（~800MB 总量下避免无谓 JSON.parse）
    if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const msg = rec?.message;
    const usage = msg?.usage;
    if (!usage || !msg?.id) return;
    const model = msg.model;
    if (!model || model === '<synthetic>') return;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (!Number.isFinite(ts)) return;

    // #96：逐项强转整数。用量字段以数字形态的字符串出现时，`+` 是拼接不是相加
    // （"123" + 0 + 0 + 456 → "12300456"），见 collectors/tokens.js
    const input = tokenCount(usage.input_tokens);
    const cached = tokenCount(usage.cache_read_input_tokens);
    const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
    const output = tokenCount(usage.output_tokens);
    const reasoning = tokenCount(usage.output_tokens_details?.thinking_tokens);
    // Anthropic 口径：input_tokens 不含缓存，total = 四项之和
    const total = input + cached + cacheWrite + output;

    inserted += store.insertEvent({
      ts,
      tool,
      model: normalizeModel(model),
      session_id: rec.sessionId || rec.session_id || fileId,
      project: rec.cwd ? (win32.basename(rec.cwd) || rec.cwd) : null,
      input_tokens: input,
      cached_input: cached,
      cache_write: cacheWrite,
      output_tokens: output,
      reasoning_tokens: reasoning,
      total_tokens: total,
      dedup_key: `${tool}:${msg.id}:${rec.requestId ?? ''}`,
    });

    // 同一条 assistant 消息的 content 里可能带 tool_use 块 → 工具活动统计
    if (Array.isArray(msg.content)) {
      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i];
        if (block?.type !== 'tool_use' || !block.name) continue;
        store.insertToolCall({
          ts,
          tool,
          name: block.name,
          // #96：回退链必须与上面事件行（`rec.sessionId || rec.session_id || fileId`）
          // 一模一样。此前少一级 `rec.session_id`：只写 snake_case 的网关/派生客户端
          // 会把工具活动挂到 fileId（文件名）上，而用量挂在真正的 session_id 上——
          // 同一次调用的工具与 token 因此在"按会话钻取"时分属两个会话。
          session_id: rec.sessionId || rec.session_id || fileId,
          dedup_key: `${tool}:tc:${block.id || `${msg.id}:${i}`}`,
        });
      }
    }
  });

  return { newOffset, inserted };
}
