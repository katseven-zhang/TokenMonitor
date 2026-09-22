export type QuotaObservation = { agent:string; session:string; ts:number; payload:Record<string,unknown> };
/**
 * The window's length as locale copy: a `key` into the three tables plus the values the
 * sentence interpolates. A lib module must not import a hook or an i18next instance, and it
 * must not bake one language into a returned string either (task #103) — the panel that owns
 * the active language turns this into text. `null` means the log named no length, so the
 * raw backend key is shown instead of an invented label.
 */
export type QuotaWindowLabel = { key: string | null; values?: Record<string, string | number> };

export function quotaWindowLabel(minutes: number | null): QuotaWindowLabel {
  if (minutes === null) return { key: null };
  if (minutes === 300) return { key: "quota.window_five_hours" };
  if (minutes === 10080) return { key: "quota.window_seven_days" };
  return { key: "quota.window_minutes", values: { minutes } };
}

/**
 * Turns a window's label into text in the language the caller renders in. A log row with no
 * window length keeps its raw backend key: inventing "unnamed window" would put words on a
 * reading the log never made.
 */
export function quotaWindowName(window: { key: string; label: QuotaWindowLabel }, translate: (key: string, values?: Record<string, string | number>) => string): string {
  return window.label.key === null ? window.key : translate(window.label.key, window.label.values);
}

export function quotaWindows(observation: QuotaObservation) {
  return ['primary','secondary','monthly'].flatMap(key => {
    const raw = observation.payload[key];
    if (!raw || typeof raw !== 'object') return [];
    const value = raw as Record<string,unknown>;
    const minutes = typeof value.window_minutes === 'number' && Number.isFinite(value.window_minutes) && value.window_minutes > 0 ? value.window_minutes : null;
    const used = typeof value.used_percent === 'number' && Number.isFinite(value.used_percent) ? value.used_percent : null;
    const reset = typeof value.resets_at === 'number' ? value.resets_at * (value.resets_at < 1e11 ? 1000 : 1) : typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : NaN;
    return [{key, label:quotaWindowLabel(minutes), minutes, used, remaining:used==null?null:Math.max(0,Math.min(100,100-used)), reset:Number.isFinite(reset)&&reset>0?reset:null}];
  });
}

/** One row of the observation history table: a window reading plus the log it came from. */
export type QuotaHistoryRow = ReturnType<typeof quotaWindows>[number] & { ts:number; session:string };

/**
 * Flattens observations into history rows and applies the window filter. The filter is a
 * `key`, never a translated label, so switching language mid-session cannot silently empty
 * the table, and an unknown filter reads as "no rows" instead of "all rows".
 */
export function quotaHistoryRows(observations: QuotaObservation[], windowFilter:string): QuotaHistoryRow[] {
  return observations.flatMap(row=>quotaWindows(row).map(window=>({...window,ts:row.ts,session:row.session})))
    .filter(row=>row.key===windowFilter||windowFilter==='all');
}

/**
 * How far away an observed reset still is. Whole minutes are the only resolution the log
 * supports, so this rounds up rather than showing a sub-minute value that moves every tick.
 */
export function minutesUntilReset(now:number, reset:number|null): number|null {
  if (reset === null) return null;
  if (reset <= now) return 0;
  return Math.ceil((reset - now) / 60_000);
}

/** 一条会话级计费（credits）观测：由多份"每文件一条"的观测归并而来。 */
export type CreditWindow = {
  /** 观测来源 Agent：面板不再按名字写死，多源共存时要靠它标注归属。 */
  agent: string;
  session: string;
  ts: number;
  project: string | null;
  requests: number | null;
  credits: number | null;
  originalCredits: number | null;
  billableRequests: number | null;
  contextUsageRatio: number | null;
  models: { key: string; requests: number }[];
  degraded: { key: string; count: number }[];
};

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** 求和：一条都没有数值时仍是 null——缺数据不能被写成"用量为零"。 */
const summed = (values: (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

const merged = (rows: QuotaObservation[], field: string) => {
  const out = new Map<string, number>();
  for (const row of rows) {
    const source = row.payload[field];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      const n = finite(value);
      if (n === null) continue;
      out.set(key, (out.get(key) ?? 0) + n);
    }
  }
  return [...out.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
};

/** Backend returns globally deduplicated requests in the selected range. Group by session for display. */
export function creditWindows(rows: QuotaObservation[]): CreditWindow[] {
  const bySession = new Map<string, QuotaObservation[]>();
  for (const row of rows) {
    const credits = finite(row.payload.credits);
    const requests = finite(row.payload.requests);
    if (credits === null && requests === null) continue;
    const raw = row.payload.session_id;
    const session = typeof raw === 'string' && raw ? raw : row.session;
    if (!session) continue;
    // 归并键带上 agent：会话 id 只在同一个来源内部唯一，两个 Agent 恰好同名
    // 会话时不能把它们的用量并成一条
    const key = `${row.agent}\u0000${session}`;
    const bucket = bySession.get(key);
    if (bucket) bucket.push(row);
    else bySession.set(key, [row]);
  }
  return [...bySession.entries()]
    .map(([key, group]) => {
      const session = key.slice(key.indexOf('\u0000') + 1);
      const project = group.map(r => r.payload.project).find(p => typeof p === 'string' && p) ?? null;
      const stamps = group
        .map(r => finite(r.payload.last_ts) ?? r.ts)
        .filter((v): v is number => v !== null && v > 0);
      return {
        agent: group[0].agent,
        session,
        ts: stamps.length ? Math.max(...stamps) : 0,
        project: typeof project === 'string' ? project : null,
        requests: summed(group.map(r => finite(r.payload.requests))),
        credits: summed(group.map(r => finite(r.payload.credits))),
        originalCredits: summed(group.map(r => finite(r.payload.original_credits))),
        billableRequests: summed(group.map(r => finite(r.payload.billable_requests))),
        contextUsageRatio: (() => {
          const ratios = group.map(r => finite(r.payload.context_usage_ratio)).filter((v): v is number => v !== null);
          return ratios.length ? Math.max(...ratios) : null;
        })(),
        models: merged(group, 'models').map(row => ({ key: row.key, requests: row.count })),
        degraded: merged(group, 'degraded').map(row => ({ key: row.key, count: row.count })),
      };
    })
    .sort((a, b) => b.ts - a.ts || a.agent.localeCompare(b.agent) || a.session.localeCompare(b.session));
}
