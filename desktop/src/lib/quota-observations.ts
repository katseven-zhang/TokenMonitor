export type QuotaObservation = { agent:string; session:string; ts:number; payload:Record<string,unknown> };
export function quotaWindows(observation: QuotaObservation) {
  return ['primary','secondary','monthly'].flatMap(key => {
    const raw = observation.payload[key];
    if (!raw || typeof raw !== 'object') return [];
    const value = raw as Record<string,unknown>;
    const minutes = typeof value.window_minutes === 'number' && Number.isFinite(value.window_minutes) && value.window_minutes > 0 ? value.window_minutes : null;
    const used = typeof value.used_percent === 'number' && Number.isFinite(value.used_percent) ? value.used_percent : null;
    const reset = typeof value.resets_at === 'number' ? value.resets_at * (value.resets_at < 1e11 ? 1000 : 1) : typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : NaN;
    return [{key, label:minutes===300?'5 小时窗口':minutes===10080?'7 天窗口':minutes?`${minutes} 分钟窗口`:key, used, remaining:used==null?null:Math.max(0,Math.min(100,100-used)), reset:Number.isFinite(reset)&&reset>0?reset:null}];
  });
}
