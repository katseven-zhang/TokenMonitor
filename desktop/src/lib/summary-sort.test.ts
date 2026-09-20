import { describe,it,expect } from 'vitest';
import type { Summary } from './api';
import { sortSummaries } from './summary-sort';
const row=(key:string,totalTokens:number,costUsd:number|null):Summary=>({key,label:key,totalTokens,costUsd,knownCostUsd:costUsd??0,unpricedTokens:costUsd==null?totalTokens:0,unpricedEvents:costUsd==null?1:0,events:1,firstTs:0,lastTs:totalTokens,agent:'codex',session:key,path:'',tokens:{input:totalTokens,cached:0,cacheWrite:0,output:0,reasoning:0}});
describe('summary sorting',()=>{
  it('sorts numeric values numerically without changing input',()=>{
    const rows=[row('a',2,1),row('b',10,2)];
    expect(sortSummaries(rows,'input',true).map(r=>r.key)).toEqual(['b','a']);
    expect(rows.map(r=>r.key)).toEqual(['a','b']);
  });
  it('keeps unknown prices last for ascending and descending orders',()=>{
    const rows=[row('unknown',100,null),row('free',0,0),row('paid',2,4)];
    expect(sortSummaries(rows,'costUsd',false).map(r=>r.key)).toEqual(['free','paid','unknown']);
    expect(sortSummaries(rows,'costUsd',true).map(r=>r.key)).toEqual(['paid','free','unknown']);
  });
  it('sorts date groups in chronological order and breaks ties stably',()=>{
    expect(sortSummaries([row('2026-09-20',1,0),row('2026-09-19',1,0)],'label',false).map(r=>r.key)).toEqual(['2026-09-19','2026-09-20']);
    expect(sortSummaries([row('b',1,0),row('a',1,0)],'events',true).map(r=>r.key)).toEqual(['a','b']);
  });
});
