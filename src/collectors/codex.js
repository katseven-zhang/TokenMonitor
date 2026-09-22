import { win32 } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';
import {
  cacheWriteOf as sharedCacheWriteOf, CW_CREATION, CW_WRITE, CW_SAME,
} from './tokens.js';

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
 *   同一份 payload 只会出其中一种"这个假设由 #75 明确化，见下方 cacheWriteOf()。
 * - OpenAI 口径 input_tokens 已含 cached：cached 必须夹在 [0, input]，否则
 *   "新输入 = input - cached" 会变负，两端总数就不一致了。
 * - 数字一律走 num() 强转：日志里出现过字符串形态的用量，`"123" + 0` 是拼接不是相加。
 */
const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * #75：两个 cache_write 写法的取舍规则在 `collectors/tokens.js::cacheWriteOf()`（workbuddy
 * 共用同一条判定）。这里再包一层是为了带上 codex 自己的数值口径 `num()`（非负、非有限值
 * 一律 0），并且给累计差分用 `ws`（写法）字段。codex 特有的一条见 collectCodexFile：
 * 相邻两条采样各自写了具体写法而写法不同 = 累计序列断了，按回落处理，不跨写法做差分
 * （跨写法差分必然为负、会被 `.max(0)` 静默清零，那一轮的缓存写入就这么没了）。
 * 桌面端 `collectors.rs::cache_write_of` + `spelling_changed` 同一条规则。
 */
const cacheWriteOf = (u) => sharedCacheWriteOf(u, num);

export function codexUsage(u) {
  const input = num(u.input_tokens);
  const cached = Math.max(num(u.cached_input_tokens), num(u.cache_read_input_tokens));
  const clamped = Math.min(cached, input);
  const cw = cacheWriteOf(u);
  return {
    i: input,
    c: clamped,
    w: cw.w,
    ws: cw.ws,
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
 *   算不出用量的事件（重复通知）不落库，判据与桌面端落库前的 `total() > 0` 同一条
 *   （#75：此前这边看上游 total_tokens 的差分，"只有 reasoning 在动"的采样两端一边
 *   落一条全 0 事件、一边不落，事件数不同）。
 * - 缺 total_token_usage 的采样不再整条丢弃（#75）：它带 last_token_usage 时那就是本轮
 *   真实用量，与桌面端同样落库；两个都没有才算坏行。
 * - 首个采样与累计值回落（上下文压缩、resume/fork 继承父线程基线）不能差分，也不能
 *   把整个累计值当本轮用量——那会把被继承的父会话重复计入（实测 9 倍，见
 *   docs/ARCHITECTURE.md Codex 段），只认 info.last_token_usage；它缺失时宁可不记
 *   （#75 修前桌面端会退回整段累计值）。修前 Node 端在回落时把差分为负的事件整条丢掉，
 *   等于丢掉压缩后那一轮的用量。cache_write 换了写法也算基线断，走同一条回落。
 * - 模型名（版本差异，两种都认）：新格式 thread_settings_applied.thread_settings.model；
 *   旧格式 turn_context.payload.model（2026-09 之前的 rollout）。
 * - 工具调用：`response_item` 且 `payload.type` 为 `function_call` 或 `custom_tool_call`
 *   （name/call_id）。后者是新版 Codex 的 freeform 工具，#85 起两端同记。
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
        !line.includes('"function_call"') &&
        !line.includes('"custom_tool_call"')) return;
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
    // #85：工具活动只认 `type === 'response_item'`（此前桌面端只看 payload.type，
    // event_msg 里的回放被再数一遍，工具榜恒高于这边）。`custom_tool_call` 是新版
    // Codex 的 freeform 工具调用（apply_patch 一类），同样是真实的一次工具使用，
    // 桌面端一直在记、这边漏了 —— 补齐的那一边是这里，而不是把桌面端砍掉。
    if (rec.type === 'response_item'
        && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
      if (payload.name && Number.isFinite(ts)) {
        // #85：没有 call_id 时按"当前 seq + 该 seq 内的序号"定键。此前只用 seq，而 seq 只在
        // token_count 事件上自增——两次 token_count 之间的第二个 function_call 与第一个共用
        // dedup_key，被 INSERT OR IGNORE 静默丢掉（桌面端按行号定键，反而没这个问题）。
        // 同一 seq 的**首条**仍沿用裸 `seq` 的原键：存量行一条不多一条不少，
        // 只有此前被丢掉的那些才拿到新行。有 call_id 时键的形态完全不变。
        let key = payload.call_id;
        if (key === undefined || key === null || key === '') {
          if (st.tseqFor !== st.seq) { st.tseqFor = st.seq; st.tseq = 0; }
          st.tseq += 1;
          key = st.tseq === 1 ? `${st.seq}` : `${st.seq}:${st.tseq}`;
        }
        store.insertToolCall({
          ts, tool: 'codex', name: payload.name,
          session_id: fileId,
          dedup_key: `codex:tc:${fileId}:${key}`,
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
      // #75(a)：时间读不到才丢（桌面端在这一步之前就已 continue，见 collectors.rs 的
      // `let Some(ts) = … else { continue }`）。**缺 total_token_usage 不再整条丢弃**，
      // 与桌面端 `else if info["last_token_usage"].is_object()` 同式：没有累计基线时
      // last_token_usage 本身就是"本轮量"，不需要基线；两个都没有才算坏行。
      if (!Number.isFinite(ts)) return;
      const hasTotal = !!info?.total_token_usage && typeof info.total_token_usage === 'object';

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

      const cur = hasTotal ? codexUsage(info.total_token_usage) : null;
      const prev = st.cum;
      // 只有真读到累计值才推进基线：某条采样缺 total 不能把已有基线抹掉，
      // 否则下一条读到的累计值会跟 null 比出"首个采样"，把整段累计当本轮用量计入。
      if (cur) st.cum = cur;

      // 累计值回落 = 上下文压缩 / resume 换了基线（与桌面端 reset 判定同式：
      // input 含缓存后的总量、output 任一变小）
      const reset = !!cur && !!prev && (cur.i < prev.i || cur.o < prev.o);
      // #75(c) 情形 2：两条**各自写了具体写法**的采样用了不同字段名，说明累计序列来自
      // 两个版本的写入方，跨写法差分必然为负、会被 .max(0) 静默清零 —— 与回落走同一条
      // 处理。有一种写法是"这条压根没写缓存"（CW_NONE / 冲突拒读）时不算序列断了：那时
      // 上一轮在这条序列上本来就是 0，字段第一次出现按普通差分读，不需要回落到 last。
      const concreteSpelling = (ws) => ws === CW_CREATION || ws === CW_WRITE || ws === CW_SAME;
      const spellingChanged = !!cur && !!prev
        && concreteSpelling(cur.ws) && concreteSpelling(prev.ws) && cur.ws !== prev.ws;
      if (!cur || !prev || reset || spellingChanged) {
        // 无基线可差（首个采样 / 回落 / 没有 total / 写法变了）：只认 info.last_token_usage
        // （本轮真实用量）。它缺失就丢掉这一条——把整段累计值记成单次用量会在
        // resume/fork 会话上重复计入父线程（实测 9 倍）。
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
      const p = parts(d);
      // #75(b)：重复通知的判据两端统一 —— "这一轮算不出任何用量就不落库"，
      // 与桌面端落库前的 `t.total() > 0`（collectors.rs）是同一条不变式。
      // 旧判据 `d.i<=0 && d.o<=0 && d.w<=0 && d.tt<=0` 看的是上游 total_tokens 的差分，
      // 于是"只有 reasoning / 只有 total_tokens 在动"的采样这边落一条各列全 0 的事件、
      // 桌面端一条不落，同一份日志两端事件数不同。
      if (p.total_tokens <= 0) return; // 无新用量（重复通知）
      st.seq++;
      inserted += store.insertEvent({
        ts,
        tool: 'codex',
        model: st.model,
        session_id: payload.session_id || fileId,
        project: st.project,
        // cached 夹进 [0, 输入差分]、各列非负（parts 与桌面端 delta() 同式）：缓存修正
        // 让 Δc > Δi 时新输入不能变负，否则两端总数不同
        ...p,
        dedup_key: `codex:${fileId}:${st.seq}`, // 会话键+序号：归档搬移后路径变了也不能重复计数
      });
    }
  });

  return { newOffset, inserted, state: st };
}
