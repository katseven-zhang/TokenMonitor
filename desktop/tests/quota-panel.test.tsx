import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuotaPanel } from '../src/components/quota-panel';
import type { QuotaPanelData } from '../src/components/quota-panel';

const reset = Date.parse('2026-09-20T12:00:00Z');
const observation = {
  agent: 'codex', session: 'sample', ts: reset - 60_000,
  payload: { primary: { window_minutes: 300, used_percent: 25, resets_at: reset / 1000 } },
};
// The panel reads only these two dashboard fields; the query's other projections
// are deliberately absent so this test cannot accidentally depend on usage totals.
const data: QuotaPanelData = { quotas: [observation], quotaHistory: { total: 1, items: [observation] } };

afterEach(() => vi.restoreAllMocks());

describe('local quota reset presentation', () => {
  it('keeps an observed balance and labels the future timestamp', () => {
    vi.spyOn(Date, 'now').mockReturnValue(reset - 1);
    const html = renderToStaticMarkup(<QuotaPanel data={data} />);
    expect(html).toContain('75.0%');
    expect(html).toContain('约 1 分钟后');
    expect(html).toContain('不是实时余额');
    expect(html).not.toContain('观测重置时间已过');
  });

  it.each([0, 1, 7 * 86_400_000])('expires at the exact timestamp plus %i ms without inventing a refill', delta => {
    vi.spyOn(Date, 'now').mockReturnValue(reset + delta);
    const html = renderToStaticMarkup(<QuotaPanel data={data} />);
    expect(html).toContain('观测重置时间已过，等待新日志');
    expect(html).toContain('75.0%');
    expect(html).not.toContain('100.0%');
    expect(html).not.toContain('分钟后');
    expect(html).toContain('重置时间变化不作为人工重置或额度兑换的证据');
  });

  it('does not convert a missing percentage or reset timestamp into a zero balance or countdown', () => {
    const unknown = { ...observation, payload: { primary: { window_minutes: 300 } } };
    const html = renderToStaticMarkup(<QuotaPanel data={{ ...data, quotas: [unknown], quotaHistory: { total: 0, items: [] } }} />);
    expect(html).toContain('未知');
    expect(html).toContain('未记录重置时间');
    expect(html).not.toContain('0.0%');
    expect(html).not.toContain('分钟后');
  });
});
