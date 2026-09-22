import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { basename, dirname, join, win32 } from 'node:path';
import { normalizeModel } from '../models.js';

function isLockError(err) {
  const m = String(err?.message || err);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|unable to open/i.test(m);
}

function openReadonly(path) {
  return new DatabaseSync(path, { readOnly: true, timeout: 2000 });
}

/* ------------------------------------------------------------------ */
/* protobuf 裸格式解析（零依赖）。Antigravity 的 gen_metadata.data 是       */
/* protobuf wire format，官方不公开 schema；以下字段号是 2026-09 对本机    */
/* 数据实测 + 第三方 descriptor-pinned 参考（JingbiaoMei/Tokdash          */
/* AntigravityCLIParser，2026-07-02）交叉印证得出，见 docs/sources/       */
/* antigravity.md。计数都在 2^53 内，用普通 Number 做变体解码即可。        */
/* ------------------------------------------------------------------ */

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
    if (shift > 70) throw new Error('varint too long');
  }
}

/** 解析一条消息：fieldNo -> 值数组（重复字段保留全部，取用方决定取哪个）。 */
function parseMessage(buf) {
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const fieldNo = Math.floor(tag / 8);
    const wire = tag % 8;
    let val;
    if (wire === 0) {
      [val, pos] = readVarint(buf, pos);
    } else if (wire === 1) {
      val = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      if (pos + len > buf.length) throw new Error('truncated length-delimited field');
      val = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 5) {
      pos += 4;
      continue; // fixed32：本源未用到，安全跳过
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
    if (!fields.has(fieldNo)) fields.set(fieldNo, []);
    fields.get(fieldNo).push(val);
  }
  return fields;
}

/** 重复字段取最后一个（写入方对标量重复合入时以最后为准，与参考实现一致）。 */
function lastOf(fields, fieldNo) {
  const a = fields.get(fieldNo);
  return a ? a[a.length - 1] : undefined;
}

function asNumber(v) {
  return typeof v === 'number' ? v : 0;
}

function asText(v) {
  return v == null ? null : Buffer.from(v).toString('utf8');
}

function asMessage(v) {
  return v instanceof Uint8Array ? parseMessage(v) : null;
}

/**
 * 解码 gen_metadata 的一行。
 *
 * 外层路径：1 = Generation 子消息；1.19 = 模型 id 字符串；
 * 1.9.4.1 / 1.9.4.2 = 生成完成时间的秒 / 纳秒（2026-07 参考实现的路径，
 * 本机 2026-09 实测的行内没有 wall-clock 时间，返回 0，由 steps 表补）；
 * 1.4 = ModelUsageStats。
 * ModelUsageStats：2 = 新鲜 input（不含缓存）；3 = 总输出（含 thinking）；
 * 4 = cache 写入；5 = cache 命中；9 = thinking 输出；10 = 可见输出；
 * 1（模型枚举）/ 6（provider 枚举）及 7/8/11 等请求元数据忽略。
 * output 主口径 = f3（含 thinking，实测 f3 = f9 + f10）；f3 缺席时按
 * f10 + f9 回推。
 */
export function decodeGenerationRow(data) {
  const outer = parseMessage(data);
  const gen = asMessage(lastOf(outer, 1));
  if (!gen) return null;
  const usageBlob = lastOf(gen, 4);
  if (!(usageBlob instanceof Uint8Array)) return null;
  const usage = parseMessage(usageBlob);

  const input = asNumber(lastOf(usage, 2));
  const outputTotal = asNumber(lastOf(usage, 3));
  const cacheWrite = asNumber(lastOf(usage, 4));
  const cacheRead = asNumber(lastOf(usage, 5));
  const reasoning = asNumber(lastOf(usage, 9));
  const visible = usage.get(10);
  const visibleOut = visible !== undefined ? asNumber(visible[visible.length - 1]) : null;
  // 本仓库口径（与 opencode/pi 对齐）：output 为含 thinking 的总输出。
  // 实测 f3 = f9 + f10（806=750+56、73=15+58），f3 为主口径；
  // f3 缺席时按 可见+thinking 回推，再退化到 thinking。
  const output = outputTotal > 0
    ? outputTotal
    : (visibleOut != null ? visibleOut + reasoning : reasoning);

  let ts = 0;
  const t9 = asMessage(lastOf(gen, 9));
  if (t9) {
    const t4 = asMessage(lastOf(t9, 4));
    if (t4) {
      const sec = asNumber(lastOf(t4, 1));
      const nanos = asNumber(lastOf(t4, 2));
      if (sec > 0) ts = sec * 1000 + Math.floor(nanos / 1e6);
    }
  }

  return {
    model: asText(lastOf(gen, 19)) || 'unknown',
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    ts,
  };
}

/**
 * steps.metadata 里的 step 时间戳：路径 1.1.1 / 1.1.2 = 秒 / 纳秒。
 * 实测（2026-09，23 库 6520 行）：gen_metadata.idx 与 steps.idx 一一同齐，
 * 本机 build 的生成时间只能从这里取。
 */
export function stepTimestampMs(metadata) {
  try {
    const m = parseMessage(metadata);
    const f1 = m.get(1)?.[0];
    if (!(f1 instanceof Uint8Array)) return 0;
    const t = parseMessage(f1);
    const sec = t.get(1)?.[0];
    if (typeof sec !== 'number' || sec <= 0) return 0;
    const nanos = t.get(2)?.[0];
    return sec * 1000 + Math.floor((typeof nanos === 'number' ? nanos : 0) / 1e6);
  } catch {
    return 0;
  }
}

/** conversation_summaries.workspace_uris 里第一个 file:// URI → 项目名（路径末段）。 */
function projectFromWorkspaceUris(raw) {
  let uris;
  try { uris = JSON.parse(raw || '[]'); } catch { return null; }
  if (!Array.isArray(uris)) return null;
  for (const u of uris) {
    if (typeof u !== 'string' || !u.startsWith('file://')) continue;
    try {
      let p = decodeURIComponent(new URL(u).pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // Windows file:///D:/... 去掉开头的 /
      return win32.basename(p) || p || null;
    } catch { /* 坏 URI 试下一个 */ }
  }
  return null;
}

/**
 * Antigravity 采集器。
 *
 * scanner 传入的 path 是某 home 的 conversation_summaries.db（sqlite 源的
 * root 必须是文件，见 manifest 注释）。真实用量在同级 conversations/<uuid>.db
 * 的 gen_metadata 表里，这里自行枚举：
 * - 每会话按 idx 水位增量（gen_metadata 只追加）；库变短（删过行）就整表重读，
 *   dedup_key 保证重读幂等。
 * - 索引库 / 会话库被锁或不可读：本轮跳过，水位不动，不抛错（Windows 文件占用
 *   是常态）。
 * - 时间戳本轮读不到（steps 被锁或 schema 漂移）时，水位**只推进到那一行之前**：
 *   越过它就等于这一代生成永久丢失（#95）。
 * - 单个会话库出任何错（含 schema 漂移、镜像损坏）都只跳过该会话并记进
 *   state.errors，绝不 throw 穿出本源（#95：一个坏库冻结整源）。
 * - 坏记录（解码失败）只丢该行，不推进失败状态、不影响其他行。
 * - dedup_key `antigravity:<会话id>:<idx>` 跨重扫稳定。
 *
 * 口径与 opencode/pi 对齐：output 为总输出（含 thinking），reasoning 单列
 * （已含在 output 内），total = input + cache命中 + cache写入 + output。
 * 工具调用：gen_metadata 不含工具调用记录，trajectory steps 表的 payload
 * 格式未经验证，按"不得猜测"原则记为 unsupported（见 docs）。
 */
export async function collectAntigravity(store, { tool, path, state, version }) {
  const prev = { conv: {}, ...(state ?? {}) };
  const st = { conv: { ...prev.conv }, _v: version };
  let inserted = 0;

  let summaries;
  try {
    summaries = openReadonly(path);
  } catch {
    return { inserted: 0, state: prev, skip: true };
  }

  /** conversation_id -> project（读不到索引列时按无项目处理） */
  const meta = new Map();
  const errors = [];
  try {
    const rows = summaries
      .prepare('SELECT conversation_id, workspace_uris FROM conversation_summaries')
      .all();
    for (const r of rows) {
      meta.set(String(r.conversation_id), projectFromWorkspaceUris(r.workspace_uris));
    }
  } catch (err) {
    try { summaries.close(); } catch { /* 只读句柄释放 */ }
    if (isLockError(err)) return { inserted: 0, state: prev, skip: true };
    // 索引库 schema 漂移（表/列被改名）不是"本源没有数据"的理由：项目名按缺失处理，
    // conversations/*.db 照收（#95 修前这里 throw，一个坏索引库让整个源每轮停摆）
    errors.push(`index: ${err.message}`);
  } finally {
    try { summaries.close(); } catch { /* 只读句柄释放 */ }
  }

  const convDir = join(dirname(path), 'conversations');
  let files;
  try {
    files = readdirSync(convDir).filter((n) => n.endsWith('.db')).sort();
  } catch {
    files = []; // conversations 目录不存在/被占用：本轮无数据
  }

  for (const name of files) {
    const convId = basename(name, '.db');
    let db;
    try {
      db = openReadonly(join(convDir, name));
    } catch {
      continue; // 被锁/占用：本轮跳过该会话，水位不动
    }
    try {
      const maxIdx = db.prepare('SELECT MAX(idx) AS m FROM gen_metadata').get()?.m ?? 0;
      const cursor = st.conv[convId] || 0;
      const from = maxIdx < cursor ? 0 : cursor; // 缩库 = 删过行，整表重读（dedup 幂等）
      // idx 从 0 起：水位 0（首扫/缩库重读）要读全表，用 -1 作"从头"哨兵
      const gt = from === 0 ? -1 : from;
      const rows = db
        .prepare('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx')
        .all(gt);
      // 本 build 的 gen 行内没有生成时间，从 steps 表同 idx 行补（见 stepTimestampMs）
      const stepTs = new Map();
      let stepsUnavailable = false;
      try {
        for (const s of db.prepare('SELECT idx, metadata FROM steps WHERE idx > ?').all(gt)) {
          const ts = stepTimestampMs(s.metadata);
          if (ts) stepTs.set(s.idx, ts);
        }
      } catch (err) {
        // 锁或 schema 漂移：不是"这一代没有时间"，是"本轮读不到时间"
        stepsUnavailable = true;
        errors.push(`${convId}: steps: ${err.message}`);
      }
      let held = null; // 第一个"时间读不到、行内也无时间"的 idx
      for (const r of rows) {
        let d;
        try { d = decodeGenerationRow(r.data); } catch { continue; }
        if (!d) continue;
        const ts = d.ts || stepTs.get(r.idx) || 0;
        if (!ts) {
          // 没有时间就无法定位到时间轴；steps 本轮读不到时**绝不能越过它推进水位**，
          // 否则锁一释放这一代生成就永远读不到了（#95 主缺陷）
          if (stepsUnavailable && held === null) held = r.idx;
          continue;
        }
        if (d.input === 0 && d.output === 0 && d.cacheRead === 0) continue; // 零用量行
        const total = d.input + d.cacheRead + d.cacheWrite + d.output;
        if (total <= 0) continue;
        inserted += store.insertEvent({
          ts,
          tool,
          model: normalizeModel(d.model),
          session_id: convId,
          project: meta.get(convId) ?? null,
          input_tokens: d.input,
          cached_input: d.cacheRead,
          cache_write: d.cacheWrite,
          output_tokens: d.output,
          reasoning_tokens: d.reasoning,
          total_tokens: total,
          dedup_key: `${tool}:${convId}:${r.idx}`,
        });
      }
      // 停在被扣住的那一行之前（idx > 水位 的语义下即 held-1），下轮从它重读；
      // dedup_key 让重读幂等，被扣住之前的行也已经落库。
      st.conv[convId] = held === null ? Math.max(from, maxIdx) : Math.max(from, held - 1);
    } catch (err) {
      // 单个会话库的任何问题（读到一半被锁、gen_metadata 被改名、镜像损坏）都只跳过
      // 这一个会话，水位不动、下轮重试。#95 修前非锁错误一路 throw 穿出本函数，
      // 一个坏库就能让整个 antigravity 源每轮停摆（其余会话的新行也再也不进库）。
      errors.push(`${convId}: ${err.message}`);
    } finally {
      try { db.close(); } catch { /* 只读句柄释放；Windows 上必须关掉才能删临时库 */ }
    }
  }

  // 逐会话错误留在 state 里随 files.state_json 落库：扫描器只有"collect 抛错"这一条
  // 错误通道，而这里恰恰不能再靠抛错来上报（抛一次 = 全源停摆）。
  if (errors.length) st.errors = errors.slice(0, 5);
  return { inserted, state: st, ...(errors.length ? { errors: st.errors } : {}) };
}
