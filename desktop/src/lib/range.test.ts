import { describe,it,expect,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preset,localInput,dateRange,windowOf } from './range';
describe('minute-accurate windows',()=>{
 it('uses exactly 300 and 10080 minutes, not calendar day boundaries',()=>{vi.spyOn(Date,'now').mockReturnValue(new Date('2026-09-20T12:34:56Z').getTime());const a=preset(300),b=preset(10080);expect(a.end%60000).toBe(0);expect(a.end-a.start).toBe(18_000_000);expect(b.end-b.start).toBe(604_800_000);vi.restoreAllMocks();});
 it('anchors offsetMinutes at the window start, so a DST-crossing range stays on one grid',()=>{
  // US clocks fall back on 2026-11-01: this hour starts in EDT and ends in EST, which is
  // exactly the case where the two anchors disagree by 60 minutes.
  const previous=process.env.TZ;
  process.env.TZ='America/New_York';
  try{
   const start=Date.parse('2026-11-01T05:30:00Z'),end=Date.parse('2026-11-01T06:30:00Z');
   expect(new Date(start).getTimezoneOffset()).toBe(240);
   expect(new Date(end).getTimezoneOffset()).toBe(300);
   expect(windowOf(start,end).offsetMinutes).toBe(-240);
   vi.spyOn(Date,'now').mockReturnValue(end);
   expect(preset(60).offsetMinutes).toBe(-240);
   expect(preset(60)).toEqual(windowOf(start,end));
   vi.restoreAllMocks();
  } finally { process.env.TZ=previous; }
 });
 it('states the zone the window is actually bucketed in',()=>{
  const window=windowOf(1,2);
  expect(window.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(window.start).toBe(1);
  expect(window.end).toBe(2);
 });
 it('leaves the offset derivation to lib/range instead of repeating it',()=>{
  const app=readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../App.tsx'),'utf8');
  expect(app).toContain('windowOf(start,end)');
  expect(app).toContain('windowOf(Math.max(range.start,q.start),Math.min(range.end,q.end))');
  expect(app).not.toContain('getTimezoneOffset');
 });
 it('round trips local minute input',()=>{const ts=Math.floor(Date.now()/60000)*60000;expect(new Date(localInput(ts)).getTime()).toBe(ts);});
 it('month drill-down starts at local midnight and ends next month',()=>{const r=dateRange('2026-09',true);expect(localInput(r.start)).toBe('2026-09-01T00:00');expect(localInput(r.end)).toBe('2026-10-01T00:00');});
 it('day drill-down crosses a year boundary at local midnight',()=>{const r=dateRange('2026-12-31');expect(localInput(r.start)).toBe('2026-12-31T00:00');expect(localInput(r.end)).toBe('2027-01-01T00:00');});
 it('February includes leap day and ends at the next local month',()=>{const r=dateRange('2028-02',true);expect(localInput(r.start)).toBe('2028-02-01T00:00');expect(localInput(r.end)).toBe('2028-03-01T00:00');});
});
