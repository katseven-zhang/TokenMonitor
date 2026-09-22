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
