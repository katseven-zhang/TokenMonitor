import type { Summary } from './api';
import { cacheHitRate,effectivePrice } from './summary-analytics';
export type SummarySort = 'label'|'totalTokens'|'input'|'cached'|'cacheWrite'|'output'|'reasoning'|'events'|'costUsd'|'lastTs'|'cacheHitRate'|'effectivePrice';
export function sortSummaries(rows:Summary[],column:SummarySort,descending:boolean) {
  const value=(row:Summary):string|number|null => column==='cacheHitRate'?cacheHitRate(row):column==='effectivePrice'?effectivePrice(row):column==='input'||column==='cached'||column==='cacheWrite'||column==='output'||column==='reasoning' ? row.tokens[column] : row[column];
  return [...rows].sort((a,b)=>{
    const left=value(a),right=value(b);
    // Unknown prices are not zero and stay after known prices in either direction.
    if(left==null||right==null) return left==null?(right==null?a.key.localeCompare(b.key):1):-1;
    const delta=typeof left==='string'&&typeof right==='string'?left.localeCompare(right,'zh-CN',{numeric:true}):Number(left)-Number(right);
    return (descending?-delta:delta)||a.key.localeCompare(b.key);
  });
}
