/**
 * Codex 消耗节奏与耗尽风险计算（#47）——全仓唯一 burn/pace/risk/ETA 算法。
 *
 * 纯逻辑模块契约（#46 只序列化本模块输出、#48 只展示，均不得另写算法）：
 * - 无 IO：不访问网络、不碰数据库、不读文件、不改配额、不执行 reset-credit。
 * - 输入输出都是稳定数据对象（字段契约见下），时间单位一律毫秒时间戳 /
 *   毫秒时长，token 单位一律"个"（不是百万）。
 *
 * 输入：窗口快照的时间升序样本数组。
 *   sample = {
 *     ts: number,                // 采样时刻（ms 时间戳）
 *     windowId: string,          // 窗口标识（5h 窗口起点/周锚点/月份，重置后必变化）
 *     used: number|null,         // 窗口已用 token（未知传 null）
 *     capacity: number|null,     // 窗口容量 token（未配额/未知传 null）
 *     resetsAt: number|null,     // 窗口重置时刻（ms，未知传 null）
 *   }
 *
 * 输出：computePace(samples, now) →
 *   {
 *     state: 'ok' | 'unknown',   // 无法推断时 state='unknown' 且 unknown_reason 必填
 *     unknown_reason: null |     // 'no_samples' | 'single_sample' | 'no_capacity' |
 *       string,                  //   'stale_samples' | 'invalid_values' | 'window_reset'
 *     used: number|null,         // 最新样本的已用量（缺失为 null，绝不塌成 0）
 *     capacity: number|null,
 *     remaining: number|null,    // capacity-used；capacity 未知为 null；负值截 0
 *     used_percent: number|null, // 0-100；capacity 缺失为 null
 *     burn_rate_per_hour: number|null,   // EWMA 速率（token/小时）
 *     safe_usage_line: number|null,      // 计划安全线：窗口结束前按安全系数应低于的总量
 *     risk: 'low'|'medium'|'high'|'unknown',
 *     eta_to_exhaust_ms: number|null,    // 按当前 burn 到耗尽的毫秒数；null=无法推断
 *     reset_relief: boolean|null,        // true=即将重置（<2h），会缓解耗尽风险
 *     samples_used: number,              // 参与推断的样本数
 *   }
 *
 * 固化规则（与本文件测试一一对应，不得在别处重写）：
 * 1. burn rate = EWMA(α=0.5) 的分段速率加权：优先最近两样本的差商，
 *    历史样本按 α=0.5 指数衰减参与，窗口内速率稳定时趋近平均差商。
 * 2. 窗口重置 / windowId 变化：旧窗口样本全部弃用，只用新窗口样本
 *    （旧窗口速率不得污染新窗口）；样本不足两个 → unknown single_sample。
 * 3. 时间倒退 / 用量回落 / NaN / 负数 / 超范围（used<0 或 capacity<0）：
 *    该样本丢弃；若因此无可信样本 → unknown invalid_values；绝不产生假 ETA。
 *    （#74：这一条原先写的是 capacity<=0。改注释而不是改代码——规则 6 明确把
 *    capacity=0 定成"容量为零＝已耗尽"的合法事实，usable() 也只挡 <0；把 0 当脏
 *    样本丢掉会让耗尽状态退化成 unknown，规则 6 与 #47 的 cap0→risk=high 测试双双作废。）
 * 4. 陈旧样本：最新样本距 now 超过 STALE_SAMPLE_MS（默认 30 分钟）→ unknown
 *    stale_samples（仍返回 used/capacity 事实字段）。
 * 5. capacity 缺失：used/burn 可给，但 remaining/percent/risk/ETA → unknown no_capacity。
 * 6. 显式 0 是合法值：used=0 表示"刚重置"；capacity=0 表示"容量为零"（耗尽），
 *    两者都不产生 unknown。
 * 7. risk：used_percent 与 burn 外推重叠——<60% low；60-84% medium；
 *    ≥85% 或外推将在窗口内耗尽 → high；不足以下结论 → unknown。
 * 8. reset_relief：resetsAt 距 now < RESET_RELIEF_MS（默认 2h）→ true；
 *    resetsAt 未知 → null。
 */

/** 样本新鲜度阈值（ms）：最新样本距 now 超过它视为陈旧 */
export const STALE_SAMPLE_MS = 30 * 60_000;
/** 即将重置阈值（ms）：重置临近时风险缓解 */
export const RESET_RELIEF_MS = 2 * 3_600_000;
/** EWMA 平滑系数：0.5 = 最近一段差商与历史各占一半 */
export const EWMA_ALPHA = 0.5;
/** risk=high 的已用百分比阈值 */
export const RISK_HIGH_PERCENT = 85;
/** risk=medium 的已用百分比阈值 */
export const RISK_MEDIUM_PERCENT = 60;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 样本可用性过滤：时间倒退、NaN/负数、容量非法一律丢弃（规则 3） */
function usable(sample) {
  if (!sample || !isNum(sample.ts)) return false;
  if (sample.used !== null && (!isNum(sample.used) || sample.used < 0)) return false;
  if (sample.capacity !== null && (!isNum(sample.capacity) || sample.capacity < 0)) return false;
  return true;
}

/**
 * 主入口：samples 时间升序；now 为推断基准时刻（可测性：由调用方传入）。
 */
export function computePace(samples, now = Date.now()) {
  const out = {
    state: 'unknown', unknown_reason: null,
    used: null, capacity: null, remaining: null, used_percent: null,
    burn_rate_per_hour: null, safe_usage_line: null,
    risk: 'unknown', eta_to_exhaust_ms: null, reset_relief: null,
    samples_used: 0,
  };
  if (!Array.isArray(samples) || samples.length === 0) {
    out.unknown_reason = 'no_samples';
    return out;
  }

  // 窗口重置：只保留最后一段同 windowId 的样本（规则 2——旧窗口不污染新窗口）
  const lastId = samples[samples.length - 1].windowId;
  const windowSamples = samples.filter((s) => s.windowId === lastId);

  // 可用性过滤（规则 3）
  const good = windowSamples.filter(usable);
  if (good.length === 0) {
    out.unknown_reason = 'invalid_values';
    return out;
  }

  // 事实字段取最新样本（缺失保持 null，规则 6：显式 0 保留为 0）
  const latest = good[good.length - 1];
  out.used = latest.used;
  out.capacity = latest.capacity;
  if (isNum(out.capacity)) {
    out.remaining = Math.max(0, out.capacity - (out.used ?? 0));
    if (out.capacity === 0) {
      out.used_percent = null; // 容量为零无百分比可言，直接判 high
    } else if (isNum(out.used)) {
      out.used_percent = Math.min(100, (out.used / out.capacity) * 100);
    }
  }

  // 陈旧样本：事实字段照给，推断拒绝（规则 4）
  if (!isNum(now) || now - latest.ts > STALE_SAMPLE_MS) {
    out.unknown_reason = 'stale_samples';
    return finalize(out);
  }

  if (good.length < 2) {
    out.unknown_reason = 'single_sample';
    return finalize(out);
  }

  // burn rate：分段差商（token/hour）的 EWMA（规则 1）。
  // 速率取「已用量增量 / 时间增量」；同窗口内异常回落构造出负差商时丢弃该段。
  let ewma = null, segs = 0;
  for (let i = 1; i < good.length; i++) {
    const dtH = (good[i].ts - good[i - 1].ts) / 3_600_000;
    const du = (good[i].used ?? 0) - (good[i - 1].used ?? 0);
    if (dtH <= 0 || du < 0) continue;
    const rate = du / dtH;
    segs++;
    ewma = ewma === null ? rate : ewma + EWMA_ALPHA * (rate - ewma);
  }
  if (segs === 0 || ewma === null) {
    out.unknown_reason = 'invalid_values';
    return finalize(out);
  }
  out.burn_rate_per_hour = ewma;
  out.samples_used = segs + 1;

  // 计划安全线：窗口剩余时长内按 80% 安全系数应低于的已用总量
  const windowLeftMs = isNum(latest.resetsAt) ? Math.max(0, latest.resetsAt - latest.ts) : null;
  if (isNum(out.capacity) && windowLeftMs !== null) {
    const budget = (ewma * (windowLeftMs / 3_600_000)) / 0.8;
    out.safe_usage_line = Math.max(0, out.capacity - budget);
  }

  // ETA（规则 7）：burn<=0 时不外推（可能是刚重置）
  if (isNum(out.capacity) && ewma > 0 && isNum(out.used)) {
    const remainingTok = Math.max(0, out.capacity - out.used);
    out.eta_to_exhaust_ms = remainingTok <= 0 ? 0 : Math.round((remainingTok / ewma) * 3_600_000);
  }

  // reset relief（规则 8）
  out.reset_relief = isNum(latest.resetsAt) ? latest.resetsAt - now < RESET_RELIEF_MS : null;

  // risk 分级（规则 7）
  if (out.capacity === 0) {
    out.risk = 'high';
  } else if (out.used_percent !== null) {
    const willExhaustInWindow = isNum(out.eta_to_exhaust_ms)
      && isNum(latest.resetsAt) && now + out.eta_to_exhaust_ms < latest.resetsAt;
    if (out.used_percent >= RISK_HIGH_PERCENT || willExhaustInWindow) out.risk = 'high';
    else if (out.used_percent >= RISK_MEDIUM_PERCENT) out.risk = 'medium';
    else out.risk = 'low';
    out.state = 'ok';
    out.unknown_reason = null;
    return out;
  } else {
    // 有 burn 但无 capacity：给速率事实，不给风险结论
    out.unknown_reason = 'no_capacity';
    return finalize(out);
  }
  return finalize(out);
}

/** unknown 路径统一收口：state/unknown_reason 已设置，事实字段保留 */
function finalize(out) {
  out.state = 'unknown';
  if (!out.unknown_reason) out.unknown_reason = 'unknown';
  return out;
}
