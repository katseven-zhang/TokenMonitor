import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import * as fzstd from 'fzstd';
import { normalizeModel } from '../models.js';

/**
 * dsh（DeepSeek Harness）采集器：~/.dsh/sessions 下 zstd 压缩的会话快照。
 *
 * - 文件视为原子快照：mtime/size 变化时整体解压重解析，dedup 保证幂等。
 * - 两种记录结构并存，必须都认：
 *     旧（session.jsonl.zstd）    type=assistant/chunk，用量在 data.chunk.usage
 *     v3（session.v3.jsonl.zstd） type=assistant/message，用量在 data.usage
 *   2026-08-14 dsh 切到 v3，本采集器当时只认旧结构，打开文件后一条也匹配不上、
 *   返回 0 且不报错，整源静默归零一个月。字段名两边一致，仅类型名与路径变了。
 * - 用量口径（两种结构相同）：input 不含缓存，reasoning 已含在 output 内，
 *   total = input + cacheRead + cacheWrite + output（v3 自带 totalTokens，实测恒等）。
 * - 模型优先取记录自带的 data.message.source.model（v3 起每条都带），
 *   回落到顺序解析 request/header 维护的当前模型；cwd 来自 session 记录。
 * - 解压用 fzstd（MIT，纯 JS，约 8kB）：Node 内置 zstd 只解第一帧且不报错，
 *   外部 zstd.exe 在 Windows / launchd PATH 上经常不存在。不得下载运行时二进制。
 */
/**
 * 解压可能含数千独立帧的 zstd。截断的最后一帧丢掉，已完整的帧保留。
 */
export function decompressZstdBuffer(buf) {
  const parts = [];
  try {
    const d = new fzstd.Decompress((chunk) => {
      if (chunk && chunk.length) parts.push(Buffer.from(chunk));
    });
    d.push(buf instanceof Uint8Array ? buf : new Uint8Array(buf), true);
  } catch (err) {
    if (!parts.length) throw err;
  }
  return Buffer.concat(parts).toString('utf8');
}

async function decompress(path) {
  const buf = await readFile(path);
  return decompressZstdBuffer(buf);
}

export async function collectDshFile(store, { path, fileId }) {
  let inserted = 0;
  const text = await decompress(path);
  // fileId 是父目录名。v3 迁移期新旧两个文件会并存于同一目录，若共用 dedup_key
  // 命名空间，seq 相同的两条会互相顶掉，因此 v3 的键额外带上文件名。
  // 旧结构的键保持原样，避免历史事件在重扫时被当成新行插一遍。
  const file = win32.basename(path);
  let model = null;
  let project = null;

  const record = (rec, u, dedupKey, recModel) => {
    if (!u || !Number.isFinite(rec.time)) return;
    const input = u.inputTokens || 0;
    const cached = u.cacheReadTokens || 0;
    const cacheWrite = u.cacheWriteTokens || 0;
    const output = u.outputTokens || 0;
    const total = input + cached + cacheWrite + output;
    if (total <= 0) return;
    inserted += store.insertEvent({
      ts: rec.time,
      tool: 'dsh',
      model: normalizeModel(recModel ?? model),
      session_id: fileId,
      project,
      input_tokens: input,
      cached_input: cached,
      cache_write: cacheWrite,
      output_tokens: output,
      reasoning_tokens: u.reasoningTokens || 0,
      total_tokens: total,
      dedup_key: dedupKey,
    });
  };

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line || (!line.includes('"usage"') && !line.includes('"request/header"') && !line.includes('"type":"session"'))) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.type === 'session') {
      project = rec.cwd ? (win32.basename(rec.cwd) || rec.cwd) : project;
      continue;
    }
    if (rec.type === 'request/header') {
      model = rec.data?.header?.config?.model ?? model;
      continue;
    }
    if (rec.type === 'assistant/message') {
      record(rec, rec.data?.usage, `dsh:${fileId}:${file}:${rec.seq}`,
        rec.data?.message?.source?.model);
      continue;
    }
    if (rec.type === 'assistant/chunk') {
      const chunk = rec.data?.chunk;
      record(rec, chunk?.type === 'usage' ? chunk.usage : null,
        `dsh:${fileId}:${rec.seq}:${rec.data?.turn ?? ''}:${rec.data?.step ?? ''}`);
    }
  }
  return { inserted };
}
