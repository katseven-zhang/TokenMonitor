import { describe,it,expect } from 'vitest';
import { quotaWindows } from './quota-observations';
describe('local quota observations',()=>{
  it('normalizes timestamps and preserves unknown fields',()=>{
    const rows=quotaWindows({agent:'codex',session:'s',ts:0,payload:{primary:{window_minutes:300,used_percent:25,resets_at:1800000000},secondary:{window_minutes:10080},credits:{balance:99}}});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({label:'5 小时窗口',remaining:75,reset:1800000000000});
    expect(rows[1]).toMatchObject({label:'7 天窗口',remaining:null,reset:null});
  });
  it('bounds percentages without treating missing or nonnumeric data as zero',()=>{
    const rows=quotaWindows({agent:'codex',session:'s',ts:0,payload:{primary:{used_percent:-3,resets_at:null},secondary:{used_percent:120,resets_at:'invalid'},monthly:{used_percent:'0'}}});
    expect(rows.map(row=>row.remaining)).toEqual([100,0,null]);
    expect(rows.every(row=>row.reset===null)).toBe(true);
  });
});
