import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { QuotaPanel } from '../src/components/quota-panel';
import type { QuotaPanelData } from '../src/components/quota-panel';
import { QuotaWindowCountdown } from '../src/components/quota-countdown';
import * as CountdownModule from '../src/components/quota-countdown';
import * as HistoryModule from '../src/components/quota-history';
import { QuotaHistoryTable } from '../src/components/quota-history';
import { quotaHistoryRows } from '../src/lib/quota-observations';
import type { QuotaClock } from '../src/lib/quota-clock';

beforeAll(async()=>{
  // The panel's copy comes from the locale tables now, and these assertions are written
  // against the Chinese bundle.
  await i18n.changeLanguage('zh');
});

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

/** A clock that records who asked, so the tick's blast radius is measurable. */
function probeClock(start: number) {
  let nowValue = start;
  let reads = 0;
  const listeners = new Set<(now: number) => void>();
  const clock: QuotaClock & { reads(): number; advance(ms: number): void } = {
    now() { reads += 1; return nowValue; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribers: () => listeners.size,
    reads: () => reads,
    advance(ms) {
      nowValue += ms;
      for (const listener of [...listeners]) listener(nowValue);
    },
  };
  return clock;
}

// Counts how many times a production component function actually ran. Vitest's ESM module
// objects are mutable and the app's own import sites resolve through them, so wrapping the
// export is enough - no DOM harness and no test-only seam inside the component. The `any`
// here is the module namespace's props, whose real types are already checked at the call
// sites in the components themselves.
type Renderable = (...args: unknown[]) => unknown;
function countRenders(namespace: Record<string, any>, name: string) {
  const original = namespace[name] as Renderable;
  return vi.spyOn(namespace, name).mockImplementation((...args: unknown[]) => original(...args));
}

describe('countdown tick isolation (task #72 criterion 8)', () => {
  it('renders the history rows once per panel render and keeps the clock out of them', () => {
    const clock = probeClock(reset - 1);
    const history = countRenders(HistoryModule, 'QuotaHistoryTable');
    const countdown = countRenders(CountdownModule, 'QuotaWindowCountdown');
    renderToStaticMarkup(<QuotaPanel data={data} clock={clock} />);
    // One render of each: the panel body no longer holds the ticking state, so the 500-row
    // table is a sibling of the countdown instead of something the tick drags along.
    expect(history).toHaveBeenCalledTimes(1);
    expect(countdown).toHaveBeenCalledTimes(1);
    // The single clock read in the whole panel is the countdown's own. With the old shape
    // (a `now` state on the panel) the panel body read the clock too, so this count is the
    // guard that keeps the tick inside the leaf.
    expect(clock.reads()).toBe(1);
  });

  it('leaves the rows with no path to the clock at all', () => {
    const clock = probeClock(reset - 1);
    const rows = quotaHistoryRows(data.quotaHistory.items, 'all');
    renderToStaticMarkup(<QuotaHistoryTable rows={rows} language="zh" />);
    expect(clock.reads()).toBe(0);
    clock.advance(3_600_000);
    renderToStaticMarkup(<QuotaHistoryTable rows={rows} language="zh" />);
    expect(clock.reads()).toBe(0);
  });

  it('advances only the countdown line when the clock moves on', () => {
    const clock = probeClock(reset - 1);
    expect(renderToStaticMarkup(<QuotaWindowCountdown reset={reset} language="zh" clock={clock} />)).toContain('约 1 分钟后');
    clock.advance(60_000);
    const html = renderToStaticMarkup(<QuotaWindowCountdown reset={reset} language="zh" clock={clock} />);
    expect(html).toContain('观测重置时间已过，等待新日志');
    expect(html).not.toContain('分钟后');
    // Only the leaf ever consults the clock; an unmounted tree leaves no subscriber behind.
    expect(clock.subscribers()).toBe(0);
  });

  it('speaks the active language instead of one baked into the file', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(reset - 60_000);
    await i18n.changeLanguage('en');
    try {
      const html = renderToStaticMarkup(<QuotaPanel data={data} />);
      expect(html).toContain('Quota and billing');
      expect(html).toContain('in about 1 min');
      expect(html).not.toContain('观测');
    } finally {
      await i18n.changeLanguage('zh');
    }
  });
});

// #105 Qoder credits 面：一个会话两份转录（父转录 + 子代理转录），观测按会话归并。
// 两份的数值刻意不同，归并结果（3 请求 / 0.75 / 1.5 / 1）才能被逐列验证。
const creditAt = reset - 30_000;
const qoderRows = [
  { agent: 'qoder', session: 'agent-x', ts: creditAt, payload: { session_id: 'sess-q', requests: 1, credits: 0.25, original_credits: 0.5, billable_requests: 0, context_usage_ratio: 0.55, models: { 'glm-5.3-flash': 1 }, last_ts: creditAt, project: 'D:\\work\\我的 项目', degraded: { 'sidechain-skipped': 2 } } },
  { agent: 'qoder', session: 'sess-q', ts: creditAt - 1000, payload: { session_id: 'sess-q', requests: 2, credits: 0.5, original_credits: 1, billable_requests: 1, context_usage_ratio: 0.4, models: { qfmodel: 2 }, last_ts: creditAt - 1000, project: '我的 项目', degraded: { 'request-deduped': 1 } } },
] as unknown as typeof data.quotas;
const creditData = { quotas: qoderRows, quotaHistory: { total: 2, items: [] } } as QuotaPanelData;

// #105：额度/计费面板不再是 Codex 专属。门控条件与面板内容都不能再按 Agent 名字写死，
// 否则第 11 个来源的观测在界面上永远不存在。
describe('credit surface beyond codex (#105)', () => {
  it('renders merged session credits for a non-Codex agent', () => {
    const html = renderToStaticMarkup(<QuotaPanel data={creditData} />);
    expect(html).toContain('会话计费观测');
    expect(html).toContain('sess-q');
    expect(html).toContain('qfmodel × 2 · glm-5.3-flash × 1 · sidechain-skipped 2 · request-deduped 1');
    expect(html.match(/sess-q/g)?.length).toBe(1); // 两份转录归并成一行，而不是各列一行
    expect(html).toContain('0.75');
    expect(html).toContain('1.5'); // 原始 credits 同样求和
    expect(html).toContain('55.0%'); // 上下文峰值取最大值，不求和
    expect(html).toContain('我的 项目'); // 完整路径与末段名都归到同一个展示名
    expect(html).toContain('日志未提供可解析的额度窗口。'); // 没有窗口型观测时如实说明
  });

  it('never turns credits into a currency amount or a percentage bar', () => {
    const html = renderToStaticMarkup(<QuotaPanel data={creditData} />);
    expect(html).toMatch(/不参与 ¥\/\$ 折算/); // 口径说明在场
    expect(html).not.toMatch(/[¥$]\s?\d/); // 但 credits 绝不套货币格式
    expect(html).not.toMatch(/观测剩余/); // 计费观测不伪装成额度窗口
  });

  it('keeps codex windows and qoder credits side by side, labelling windows per agent', () => {
    const html = renderToStaticMarkup(
      <QuotaPanel data={{ quotas: [...qoderRows, observation], quotaHistory: { total: 3, items: [observation] } }} />,
    );
    expect(html).toContain('5 小时窗口');
    expect(html).toContain('75.0%');
    expect(html).toContain('codex · 5 小时窗口'); // 多 Agent 共存时卡片必须带来源
    expect(html).toContain('会话计费观测');
  });

  it('shows an honest empty state when the query has no parseable observations', () => {
    const html = renderToStaticMarkup(
      <QuotaPanel data={{ quotas: [{ agent: 'qoder', session: 's', ts: 0, payload: { note: '只有文字' } }], quotaHistory: { total: 0, items: [] } }} />,
    );
    expect(html).toContain('尚无本地额度或计费记录');
    expect(html).not.toContain('会话计费观测');
  });

  it('is no longer gated on the codex agent name anywhere in the wiring', () => {
    const panel = readFileSync(new URL('../src/components/quota-panel.tsx', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(panel).not.toMatch(/agent\s*===\s*['"]codex['"]/);
    expect(app).toMatch(/data\.quotas\.length>0&&<QuotaPanel/); // 门控看有无观测，不看是谁
    expect(app).not.toMatch(/q\.agent==='codex'&&<QuotaPanel/);
  });
});
