import { win32 } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';
import { tokenCount } from './tokens.js';

/**
 * Pi 采集器：`~/.pi/agent/sessions/<编码cwd>/<ISO时间>_<会话uuid>.jsonl`。
 *
 * 追加式 JSONL，按字节游标增量。三类记录有用：
 * - `type=session`（首行）：携带 `cwd`，是 project 的唯一可信来源；
 * - `type=message` 且 `message.usage`：一次 API 调用的用量；
 * - assistant 内容里的 `toolCall` 块：工具调用。
 *
 * 口径（实测 97/97 条成立）：`totalTokens = input + output + cacheRead + cacheWrite`，
 * 即 **input 不含缓存**、**reasoning 已含在 output 内**（deepseek 直连与 openrouter 两条
 * 通路都如此）。reasoning 只作为信息列存，绝不能再加进 total，否则会重复计数。
 */

/**
 * 目录名把 '/' 换成了 '-'（`--Users-louwill-Vibing-daily-test--`），
 * `daily-test` 与 `daily/test` 编码后同形，无法可靠还原——所以 project 只认 session 记录里的
 * cwd，并存进 state 带过后续增量轮次（增量扫描不会重读首行）。
 *
 * cwd 在 Windows 上是 `D:\\...\\项目`：必须用 path.win32.basename，禁止 split('/')。
 */
export async function collectPiFile(store, { tool, path, fileId, offset, state, version }) {
  const st = { ...(state ?? {}), _v: version };
  let inserted = 0;

  // 文件名形如 <ISO时间>_<会话uuid>：尾部 uuid 即 session 记录的 id（已实测一致）
  const underscore = fileId.lastIndexOf('_');
  const sessionId = underscore >= 0 ? fileId.slice(underscore + 1) : fileId;

  const { newOffset } = await readLinesFrom(path, offset, (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // 廉价预过滤：大部分行是 thinking/toolResult 正文，不必 JSON.parse
    if (!line.includes('"usage"') && !line.includes('"toolCall"') && !line.includes('"session"')) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }

    if (rec?.type === 'session') {
      if (rec.cwd) st.project = win32.basename(rec.cwd) || rec.cwd;
      return;
    }
    if (rec?.type !== 'message') return;
    const msg = rec.message;
    if (!msg || msg.role !== 'assistant') return;

    const ts = Date.parse(rec.timestamp) || Number(msg.timestamp) || 0;
    if (!ts) return;

    // 工具调用与用量互不依赖：一条 assistant 消息可能只带其中之一
    if (Array.isArray(msg.content)) {
      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i];
        if (block?.type !== 'toolCall' || !block.name) continue;
        store.insertToolCall({
          ts, tool, name: block.name, session_id: sessionId,
          dedup_key: `${tool}:tc:${sessionId}:${block.id || i}`,
        });
      }
    }

    const u = msg.usage;
    if (!u) return;
    // id 缺失时退回 responseId；两者都没有就不入库——编不出稳定去重键的事件，
    // 一旦触发全量重扫就会变成重复计数，宁可少一条也不能多一条。
    const key = rec.id ?? msg.responseId;
    if (!key) return;

    // #96：字符串形态的用量字段必须先转整数再相加，否则 total 是拼接出来的天文数字
    const input = tokenCount(u.input);
    const cached = tokenCount(u.cacheRead);
    const cacheWrite = tokenCount(u.cacheWrite);
    const output = tokenCount(u.output);
    const total = input + cached + cacheWrite + output;
    if (total <= 0) return;

    inserted += store.insertEvent({
      ts,
      tool,
      model: normalizeModel(msg.model),
      session_id: sessionId,
      project: st.project ?? null,
      input_tokens: input,
      cached_input: cached,
      cache_write: cacheWrite,
      output_tokens: output,
      reasoning_tokens: tokenCount(u.reasoning),
      total_tokens: total,
      dedup_key: `${tool}:${sessionId}:${key}`,
    });
  });

  return { newOffset, inserted, state: st };
}
