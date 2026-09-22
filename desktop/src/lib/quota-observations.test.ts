import { describe,it,expect } from 'vitest';
import { creditWindows, quotaWindows, type QuotaObservation } from './quota-observations';
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

// #105：credits 面（Qoder）与窗口型额度（Codex）共用 quota 表，但口径完全不同：
// 一个是逐请求累加、一个是账号级快照。归并错了就等于把子代理用量整段丢掉。
const creditRow =(patch:Partial<QuotaObservation>):QuotaObservation => ({
  agent:'qoder', session:'sess-1', ts:1_800_000_000_000,
  payload:{
    session_id:'sess-1', requests:2, credits:0.75, original_credits:1.5, billable_requests:1,
    context_usage_ratio:0.4, models:{qfmodel:2}, last_ts:1_800_000_000_000,
    project:'D:\\work\\我的 项目', degraded:{'request-deduped':1},
  },
  ...patch,
});
describe('session credit observations (#105)',()=>{
  it('merges the parent transcript and its subagent transcript into one session row',()=>{
    const rows=creditWindows([
      creditRow({}),
      creditRow({session:'agent-x',payload:{...creditRow({}).payload,session_id:'sess-1',requests:3,credits:0.25,original_credits:0.5,billable_requests:2,context_usage_ratio:0.1,models:{'glm-5.3-flash':3},last_ts:1_800_000_001_000,degraded:{'sidechain-skipped':4}} as QuotaObservation['payload']}),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.session).toBe('sess-1');
    // 求和而不是取最新：取最新会把子代理那份整段丢掉
    expect(row.requests).toBe(5);
    expect(row.credits).toBeCloseTo(1,10);
    expect(row.originalCredits).toBeCloseTo(2,10);
    expect(row.billableRequests).toBe(3);
    // 上下文比例是"峰值"而非累计量
    expect(row.contextUsageRatio).toBe(0.4);
    expect(row.ts).toBe(1_800_000_001_000);
    expect(row.project).toBe('D:\\work\\我的 项目');
    expect(row.models).toEqual([{key:'glm-5.3-flash',requests:3},{key:'qfmodel',requests:2}]);
    expect(row.degraded).toEqual([{key:'sidechain-skipped',count:4},{key:'request-deduped',count:1}]);
  });
  it('keeps window-shaped quota rows out of the credit table',()=>{
    expect(creditWindows([{agent:'codex',session:'c',ts:0,payload:{primary:{window_minutes:300,used_percent:25}}}])).toEqual([]);
  });
  it('does not merge two agents that happen to share a session id',()=>{
    const rows=creditWindows([
      creditRow({agent:'qoder',payload:{session_id:'shared',requests:1,credits:0.5}}),
      creditRow({agent:'other',session:'other-1',payload:{session_id:'shared',requests:2,credits:0.25}}),
    ]);
    expect(rows.map(r=>`${r.agent}/${r.session}`)).toEqual(['other/shared','qoder/shared']);
    expect(rows.map(r=>r.requests)).toEqual([2,1]);
  });
  it('reports missing numbers as null instead of zero usage',()=>{
    // 只带 requests 的行：其余字段缺数据，绝不能被显示成"用量为零"
    const [row]=creditWindows([creditRow({payload:{session_id:'sess-n',requests:2}})]);
    expect(row.requests).toBe(2);
    expect(row.credits).toBeNull();
    expect(row.originalCredits).toBeNull();
    expect(row.billableRequests).toBeNull();
    expect(row.contextUsageRatio).toBeNull();
    expect(row.project).toBeNull();
    expect(row.models).toEqual([]);
    expect(row.ts).toBe(1_800_000_000_000); // 缺 last_ts 时回落到观测时间
  });
  it('falls back to the row session and ignores nonnumeric junk',()=>{
    const rows=creditWindows([
      creditRow({session:'from-column',payload:{session_id:'',requests:'12',credits:0.5,models:{a:'x',b:2}}}),
      creditRow({agent:'qoder',session:'',payload:{session_id:null,credits:1}}),
    ]);
    // payload.session_id 缺失时回落到行上的 session 列；两处都空的行没有归属，
    // 只能丢掉——凭空造一个空会话会把不相关的用量并成一条
    expect(rows.map(r=>r.session)).toEqual(['from-column']);
    // requests 是非数字 ⇒ 只有 credits 参与求和；字符串模型计数被丢弃
    expect(rows[0].requests).toBeNull();
    expect(rows[0].credits).toBe(0.5);
    expect(rows[0].models).toEqual([{key:'b',requests:2}]);
  });
  it('sorts by most recent activity then session id',()=>{
    const rows=creditWindows([
      creditRow({session:'b',payload:{session_id:'b',requests:1,credits:1,last_ts:10}}),
      creditRow({session:'a',payload:{session_id:'a',requests:1,credits:1,last_ts:20}}),
      creditRow({session:'c',payload:{session_id:'c',requests:1,credits:1,last_ts:20}}),
    ]);
    expect(rows.map(r=>r.session)).toEqual(['a','c','b']);
  });
});
