import { win32 } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';

/**
 * rate_limits 规范化（#44；#58 修正 resets_at 形态）：
 * primary(5h/周)/secondary(weekly)/monthly 三窗口，每窗口解析
 * window_minutes/used_percent/resets_at/credits/capacity/remaining。
 * resets_at 实测存在多种形态（#58 真实日志为秒级 Unix 时间戳数字）：
 *   - ISO 字符串 → 原样保留，resets_at_ms = Date.parse
 *   - 数字 < 1e11 → 视为秒级时间戳，×1000 归一为毫秒，resets_at 输出对应 ISO
 *   - 数字 ≥ 1e11 → 视为毫秒直通，resets_at 输出对应 ISO
 *   - 其他/缺失 → null（显式 0 与缺失可区分的契约不变）
 * raw 非对象或三窗口全缺 → 返回 null（来源级可诊断：调用方跳过配额写入，
 * 不抛穿、不影响事件采集）。
 */
export function normalizeRateLimits(rl, ts) {
  if (!rl || typeof rl !== 'object') return null;
  const win = (w, kind) => {
    if (!w || typeof w !== 'object') return null;
    const hasWin = w.window_minutes !== undefined || w.used_percent !== undefined
      || w.resets_at !== undefined || w.credits !== undefined
      || w.capacity !== undefined || w.remaining !== undefined;
    if (!hasWin) return null;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    let resetsIso = null;
    let resetsMs = null;
    if (typeof w.resets_at === 'string' && w.resets_at) {
      const parsed = Date.parse(w.resets_at);
      if (Number.isFinite(parsed)) {
        resetsIso = w.resets_at;
        resetsMs = parsed;
      }
    } else if (typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)) {
      // 秒级（10 位，<1e11）×1000 归一为毫秒；≥1e11 已是毫秒直通（#58）
      resetsMs = w.resets_at < 1e11 ? w.resets_at * 1000 : w.resets_at;
      resetsIso = new Date(resetsMs).toISOString();
    }
    return {
      kind,
      window_minutes: num(w.window_minutes),
      used_percent: num(w.used_percent),
      resets_at: resetsIso,
      resets_at_ms: resetsMs,
      credits: num(w.credits),
      capacity: num(w.capacity),
      remaining: num(w.remaining),
    };
  };
  const windows = [
    win(rl.primary, 'primary'),
    win(rl.secondary, 'secondary'),
    win(rl.monthly, 'monthly'),
  ].filter(Boolean);
  if (!windows.length) return null;
  return {
    plan_type: typeof rl.plan_type === 'string' ? rl.plan_type : null,
    duration_minutes: (typeof rl.duration_minutes === 'number' && Number.isFinite(rl.duration_minutes))
      ? rl.duration_minutes : null,
    windows,
    collected_at: Number.isFinite(ts) ? ts : null,
  };
}

/**
 * Codex 用量字段解析（#75 与桌面端 collectors.rs::openai() 逐字段对齐）：
 * - 字段名版本漂移：缓存命中在旧版写作 cached_input_tokens、新版 cache_read_input_tokens；
 *   缓存写入同样有两种写法 cache_creation_input_tokens / cache_write_input_tokens
 *   （#75 修前三处只各认一种：Node 端 codex.js 认 cache_write_*，桌面端 openai() 认
 *   cache_creation_*，于是同一份日志两端 cache_write 恒有一边为 0）。
 *   同一份 payload 只会出其中一种，取 max 即"有哪个读哪个"，绝不相加。
 * - OpenAI 口径 input_tokens 已含 cached：cached 必须夹在 [0, input]，否则
 *   "新输入 = input - cached" 会变负，两端总数就不一致了。
 * - 数字一律走 num() 强转：日志里出现过字符串形态的用量，`"123" + 0` 是拼接不是相加。
 */
const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export function codexUsage(u) {
  const input = num(u.input_tokens);
  const cached = Math.max(num(u.cached_input_tokens), num(u.cache_read_input_tokens));
  const clamped = Math.min(cached, input);
  return {
    i: input,
    c: clamped,
    w: Math.max(num(u.cache_creation_input_tokens), num(u.cache_write_input_tokens)),
    o: num(u.output_tokens),
    r: num(u.reasoning_output_tokens),
    tt: num(u.total_tokens),
  };
}

/**
 * 绝对用量或差分量 → 入库五列（#75：与桌面端 openai()/delta() 同一条不变式）：
 * 每列非负、cached 夹在 [0, 输入总量]、新输入 = 输入总量 - 缓存命中、
 * total 与入库各列之和恒等（CONTRIBUTING 的落库公式）。
 */
function parts(u) {
  const raw = Math.max(num(u.i), 0);
  const cached = Math.min(Math.max(num(u.c), 0), raw);
  const out = {
    input_tokens: raw - cached,
    cached_input: cached,
    cache_write: Math.max(num(u.w), 0),
    output_tokens: Math.max(num(u.o), 0),
    reasoning_tokens: Math.max(num(u.r), 0),
  };
  out.total_tokens = out.input_tokens + out.cached_input + out.cache_write + out.output_tokens;
  return out;
}

/**
 * Codex rollout 采集器（~/.codex/sessions 与 archived_sessions，2.4GB 量级）。
 *
 * - token_count.info.total_token_usage 是会话累计值：稳态按相邻事件差分得到单次用量，
 *   差分为 0 的事件（重复通知）自然跳过。
 * - 首个采样与累计值回落（上下文压缩、resume/fork 继承父线程基线）不能差分，也不能
 *   把整个累计值当本轮用量——那会把被继承的父会话重复计入（实测 9 倍，见
 *   docs/ARCHITECTURE.md Codex 段），只认 info.last_token_usage；它缺失时宁可不记
 *   （#75 修前桌面端会退回整段累计值）。修前 Node 端在回落时把差分为负的事件整条丢掉，
 *   等于丢掉压缩后那一轮的用量。
 * - 模型名（版本差异，两种都认）：新格式 thread_settings_applied.thread_settings.model；
 *   旧格式 turn_context.payload.model（2026-09 之前的 rollout）。
 * - 工具调用：response_item 且 payload.type=function_call（name/call_id）。
 * - rate_limits 为账号级配额快照：只保留全局最新一条（按 ts）。
 * - 增量恢复：state（累计值 + 当前模型 + 项目）持久化在 files.state_json。
 * - OpenAI 口径：input_tokens 已含 cached_input_tokens，入库拆为新输入/缓存命中两列，
 *   total = 新输入 + 缓存命中 + cache_write + output。
 */
export async function collectCodexFile(store, { path, fileId, offset, state, version }) {
  let st = state ?? { model: null, cum: null, project: null, seq: 0, parent: null };
  st._v = version; // 版本戳：避免常驻服务每轮全量重扫
  let inserted = 0;

  const { newOffset } = await readLinesFrom(path, offset, (line) => {
    if (!line.includes('"token_count"') &&
        !line.includes('"thread_settings_applied"') &&
        !line.includes('"session_meta"') &&
        !line.includes('"turn_context"') &&
        !line.includes('"function_call"')) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const payload = rec?.payload;
    if (!payload) return;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;

    if (rec.type === 'session_meta' || payload.type === 'session_meta') {
      // session_meta 的 type 在记录顶层，payload 即 SessionMeta（含 cwd）
      st.project = payload.cwd ? (win32.basename(payload.cwd) || payload.cwd) : st.project;
      st.parent = payload.parent_thread_id || null; // resume 链：模型可从父会话继承
      return;
    }
    if (rec.type === 'turn_context') {
      if (payload.model) st.model = normalizeModel(payload.model); // 旧格式模型位
      return;
    }
    if (rec.type === 'response_item' && payload.type === 'function_call') {
      if (payload.name && Number.isFinite(ts)) {
        store.insertToolCall({
          ts, tool: 'codex', name: payload.name,
          session_id: fileId,
          dedup_key: `codex:tc:${fileId}:${payload.call_id ?? `${st.seq}`}`,
        });
      }
      return;
    }
    if (payload.type === 'thread_settings_applied') {
      st.model = normalizeModel(payload.thread_settings?.model ?? st.model);
      return;
    }
    if (payload.type === 'token_count') {
      const info = payload.info;
      if (!info?.total_token_usage || !Number.isFinite(ts)) return;

      if (payload.rate_limits) {
        const norm = normalizeRateLimits(payload.rate_limits, ts);
        if (norm) {
          // 兼容字段（既有面板/测试消费的顶层字段）取 primary 窗口；
          // 规范化结果随快照携带全部窗口（#44：供 #45 历史存储与 #46 API）
          const p = norm.windows.find((w) => w.kind === 'primary') ?? norm.windows[0];
          store.saveQuota('codex', ts, {
            used_percent: p.used_percent,
            window_minutes: p.window_minutes,
            resets_at: p.resets_at,
            plan_type: norm.plan_type,
            ...norm,
          });
        }
        // norm 为 null（坏字段/空对象）：来源级可诊断结果——跳过配额写入，
        // 不抛穿、不中断 token 事件采集
      }

      const cur = codexUsage(info.total_token_usage);
      const prev = st.cum;
      st.cum = cur;

      // 累计值回落 = 上下文压缩 / resume 换了基线（与桌面端 reset 判定同式：
      // input 含缓存后的总量、output 任一变小）
      const reset = prev && (cur.i < prev.i || cur.o < prev.o);
      if (!prev || reset) {
        // 基线/回落：只认 info.last_token_usage（本轮真实用量）。它缺失就丢掉这一条——
        // 把整段累计值记成单次用量会在 resume/fork 会话上重复计入父线程（实测 9 倍）。
        const last = info.last_token_usage && typeof info.last_token_usage === 'object'
          ? codexUsage(info.last_token_usage) : null;
        if (!last) return;
        const p = parts(last);
        if (p.total_tokens <= 0) return;
        inserted += store.insertEvent({
          ts,
          tool: 'codex',
          model: st.model,
          session_id: payload.session_id || fileId,
          project: st.project,
          ...p,
          // 基线/回落事件按采样时刻定键，不占 seq：本次语义修正因此不会让既有
          // 差分事件的 dedup_key 整体位移（位移 + 全量重扫 = 双计）
          dedup_key: `codex:${fileId}:baseline:${ts}`,
        });
        return;
      }

      const d = {
        i: cur.i - prev.i, c: cur.c - prev.c, w: cur.w - prev.w,
        o: cur.o - prev.o, r: cur.r - prev.r, tt: cur.tt - prev.tt,
      };
      if (d.i <= 0 && d.o <= 0 && d.w <= 0 && d.tt <= 0) return; // 无新用量（重复通知）
      st.seq++;
      inserted += store.insertEvent({
        ts,
        tool: 'codex',
        model: st.model,
        session_id: payload.session_id || fileId,
        project: st.project,
        // cached 夹进 [0, 输入差分]、各列非负（parts 与桌面端 delta() 同式）：缓存修正
        // 让 Δc > Δi 时新输入不能变负，否则两端总数不同
        ...parts(d),
        dedup_key: `codex:${fileId}:${st.seq}`, // 会话键+序号：归档搬移后路径变了也不能重复计数
      });
    }
  });

  return { newOffset, inserted, state: st };
}
