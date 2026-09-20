import type { Summary } from './api';

export function cacheHitRate(row:Summary):number|null {
  const input=row.tokens.input+row.tokens.cached+row.tokens.cacheWrite;
  return input>0?row.tokens.cached/input:null;
}
export function effectivePrice(row:Summary):number|null {
  return row.costUsd!==null&&row.totalTokens>0?row.costUsd/row.totalTokens*1_000_000:null;
}
export function comparisonTotals(rows:Summary[]) {
  return {
    tokens:rows.reduce((sum,row)=>sum+row.totalTokens,0),
    cost:rows.every(row=>row.costUsd!==null)?rows.reduce((sum,row)=>sum+row.costUsd!,0):null,
  };
}
export function comparisonShares(row:Summary,totals:ReturnType<typeof comparisonTotals>) {
  return {
    usage:totals.tokens>0?row.totalTokens/totals.tokens:null,
    cost:totals.cost!==null&&totals.cost>0&&row.costUsd!==null?row.costUsd/totals.cost:null,
  };
}
