import { describe,it,expect } from 'vitest';
import type { Summary } from './api';
import { cacheHitRate,componentPrices,comparisonShares,comparisonTotals,effectivePrice } from './summary-analytics';
import { sortSummaries } from './summary-sort';
const row=(key:string,costUsd:number|null):Summary=>({key,label:key,agent:'codex',session:'',path:'',firstTs:0,lastTs:1,events:1,totalTokens:100,costUsd,knownCostUsd:costUsd??0,unpricedEvents:costUsd===null?1:0,tokens:{input:20,cached:50,cacheWrite:10,output:20,reasoning:5}});
describe('group comparison analytics',()=>{
  it('derives component rates from historical costs and preserves unknown/unused categories',()=>{
    const r={...row('historical',0.00021),knownCostByComponent:[0.00004,0.00005,0,0.00012] as [number,number,number,number]};
    componentPrices(r).forEach((price,index)=>expect(price).toBeCloseTo([2,1,0,6][index],10));
    expect(componentPrices({...r,costUsd:null})).toEqual([null,null,null,null]);
    expect(componentPrices({...r,tokens:{...r.tokens,cacheWrite:0}})[2]).toBeNull();
  });
  it('includes cache writes in input and avoids double-counting reasoning',()=>{
    const r=row('m',0.0002);
    expect(cacheHitRate(r)).toBe(0.625);
    expect(effectivePrice(r)).toBe(2);
  });
  it('uses all filtered groups and suppresses incomplete cost shares',()=>{
    const paid=row('paid',2),free=row('free',0),unknown=row('unknown',null);
    expect(comparisonShares(paid,comparisonTotals([paid,free]))).toEqual({usage:0.5,cost:1});
    expect(comparisonShares(free,comparisonTotals([paid,free]))).toEqual({usage:0.5,cost:0});
    expect(comparisonShares(paid,comparisonTotals([paid,unknown]))).toEqual({usage:0.5,cost:null});
    expect(effectivePrice(unknown)).toBeNull();
    expect(effectivePrice(free)).toBe(0);
  });
  it('handles empty denominators and sorts unknown effective rates last',()=>{
    const empty={...row('empty',0),totalTokens:0,tokens:{input:0,cached:0,cacheWrite:0,output:0,reasoning:0}};
    expect(cacheHitRate(empty)).toBeNull();expect(effectivePrice(empty)).toBeNull();
    expect(comparisonShares(empty,comparisonTotals([empty]))).toEqual({usage:null,cost:null});
    const rows=[row('unknown',null),row('paid',2),row('free',0)];
    expect(sortSummaries(rows,'effectivePrice',true).map(r=>r.key)).toEqual(['paid','free','unknown']);
    expect(sortSummaries(rows,'effectivePrice',false).map(r=>r.key)).toEqual(['free','paid','unknown']);
  });
});
