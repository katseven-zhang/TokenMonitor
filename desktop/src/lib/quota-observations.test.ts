import { describe,it,expect } from 'vitest';
import { quotaHistoryRows, quotaWindowLabel, quotaWindowName, quotaWindows } from './quota-observations';

// A stand-in for the component's `t`: the module under test must hand back a key plus the
// values a sentence needs, and never one language's text (task #103).
const table: Record<string,string> = {
  'quota.window_five_hours':'5 小时窗口',
  'quota.window_seven_days':'7 天窗口',
  'quota.window_minutes':'{{minutes}} 分钟窗口',
};
const translate = (key:string, values?:Record<string,string|number>) =>
  (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_all,name)=>String(values?.[name] ?? _all));

describe('local quota observations',()=>{
  it('normalizes timestamps and names each window through a locale key',()=>{
    const rows=quotaWindows({agent:'codex',session:'s',ts:0,payload:{primary:{window_minutes:300,used_percent:25,resets_at:1800000000},secondary:{window_minutes:10080},credits:{balance:99}}});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({label:{key:'quota.window_five_hours'},remaining:75,reset:1800000000000});
    expect(rows[1]).toMatchObject({label:{key:'quota.window_seven_days'},remaining:null,reset:null});
    expect(rows.map(row=>quotaWindowName(row,translate))).toEqual(['5 小时窗口','7 天窗口']);
  });

  it('keeps an unreadable window name as the raw key instead of inventing copy',()=>{
    expect(quotaWindowLabel(null)).toEqual({key:null});
    const rows=quotaWindows({agent:'codex',session:'s',ts:0,payload:{primary:{used_percent:10},monthly:{window_minutes:45}}});
    expect(quotaWindowName(rows[0],translate)).toBe('primary');
    expect(quotaWindowName(rows[1],translate)).toBe('45 分钟窗口');
    // The key travels with the value it interpolates, so a future table cannot lose it.
    expect(rows[1].label).toEqual({key:'quota.window_minutes',values:{minutes:45}});
  });

  it('bounds percentages without treating missing or nonnumeric data as zero',()=>{
    const rows=quotaWindows({agent:'codex',session:'s',ts:0,payload:{primary:{used_percent:-3,resets_at:null},secondary:{used_percent:120,resets_at:'invalid'},monthly:{used_percent:'0'}}});
    expect(rows.map(row=>row.remaining)).toEqual([100,0,null]);
    expect(rows.every(row=>row.reset===null)).toBe(true);
  });

  it('filters history by the backend key so a language switch cannot empty the table',()=>{
    const observation={agent:'codex',session:'s',ts:0,payload:{primary:{window_minutes:300,used_percent:25}}};
    const all=quotaHistoryRows([observation],'all');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({key:'primary',session:'s',label:{key:'quota.window_five_hours'}});
    expect(quotaHistoryRows([observation],'secondary')).toEqual([]);
    // A translated label is never a filter value.
    expect(quotaHistoryRows([observation],'5 小时窗口')).toEqual([]);
  });
});
