import { describe,it,expect,vi } from 'vitest';
import { preset,localInput,dateRange } from './range';
describe('minute-accurate windows',()=>{
 it('uses exactly 300 and 10080 minutes, not calendar day boundaries',()=>{vi.spyOn(Date,'now').mockReturnValue(new Date('2026-09-20T12:34:56Z').getTime());const a=preset(300),b=preset(10080);expect(a.end%60000).toBe(0);expect(a.end-a.start).toBe(18_000_000);expect(b.end-b.start).toBe(604_800_000);vi.restoreAllMocks();});
 it('round trips local minute input',()=>{const ts=Math.floor(Date.now()/60000)*60000;expect(new Date(localInput(ts)).getTime()).toBe(ts);});
 it('month drill-down starts at local midnight and ends next month',()=>{const r=dateRange('2026-09',true);expect(localInput(r.start)).toBe('2026-09-01T00:00');expect(localInput(r.end)).toBe('2026-10-01T00:00');});
});
