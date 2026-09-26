// @vitest-environment jsdom
// #130 复审回归：防抖竞态。在搜索框输入后 SEARCH_DEBOUNCE_MS 内切换 Agent（或点
// 「清除筛选」），待提交的旧词必须随 commitSearch.cancel() 一起死掉——修前定时器
// 到点把已清空的词写回 q.search 与 searchApplied，输入框为空但数据仍按旧词过滤、
// 筛选条显示旧词。本测试用真实 App + 受控时钟（vi.useFakeTimers）证明：到点后
// 筛选条不出现、q.search 保持空（所有 dashboard 请求的 search 恒为 ''）。
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18n from '../src/i18n';
import { SEARCH_DEBOUNCE_MS } from '../src/lib/debounce';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
// recharts 的 ResponsiveContainer 依赖真实布局，jsdom 下不渲染。
vi.mock('../src/components/usage-trend', () => ({ UsageTrend: () => null }));

const emptyTokens = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
const dashboardFor = (query: unknown) => ({
  query,
  totals: {
    key: '', label: '', tokens: emptyTokens, totalTokens: 0, knownCostUsd: 0,
    knownCostByComponent: [0, 0, 0, 0], costUsd: 0, unpricedEvents: 0,
    unpricedTokens: 0, events: 0, lastTs: 0, agent: '', session: '', path: '',
  },
  models: [], projects: [], sessions: [], agents: [], days: [], months: [],
  series: [], bucketMs: 86_400_000, tools: {}, activityCount: 0,
  quotas: [], quotaHistory: { total: 0, items: [] }, status: [],
});

beforeAll(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  await i18n.changeLanguage('zh');
});

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (_cmd: string, payload: { method: string; args: Record<string, unknown> }) => {
    if (payload.method === 'bootstrap') {
      return {
        settings: { port: 18787, refreshSeconds: 60, roots: {}, disabledAgents: [] },
        prices: '{"version":1,"currency":"USD","models":{}}',
        dataDir: 'D:/TokenMonitor',
        agents: [['codex', 'Codex']],
        autostart: false,
      };
    }
    if (payload.method === 'status') return { running: true, scanning: false };
    if (payload.method === 'dashboard') return dashboardFor(payload.args.query);
    return {};
  });
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
});

describe('防抖搜索与上下文重置的竞态（#130）', () => {
  it('输入后 SEARCH_DEBOUNCE_MS 内切换 Agent：旧词不得写回 q.search，筛选条不得出现', async () => {
    vi.useFakeTimers();
    const { default: App } = await import('../src/App');
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => { root = createRoot(container!); root!.render(<App />); });
    // bootstrap / dashboard / status 三个异步请求落定
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });

    // 进入「模型」子页取得搜索框（overview 页没有搜索框）。
    act(() => {
      const tab = [...container!.querySelectorAll('.subnav button')]
        .find(b => b.textContent === '模型');
      (tab as HTMLButtonElement).click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    const input = container!.querySelector('.panel-heading .search input') as HTMLInputElement;
    expect(input).toBeTruthy();

    // 输入待提交词：此刻只进了 draft，尚未提交（筛选条不出现）。
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'foo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container!.querySelector('.filter-chips')).toBeNull();

    // SEARCH_DEBOUNCE_MS 内切换 Agent（chooseAgent → cancel + 清空）。
    act(() => {
      const overview = [...container!.querySelectorAll('.sidebar-nav .side-item')]
        .find(b => b.textContent?.trim() === '综合总览') as HTMLButtonElement;
      overview.click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 100); });

    // 修前：定时器到点把 'foo' 写回 q.search + searchApplied，筛选条带旧词出现。
    expect(container!.querySelector('.filter-chips')).toBeNull();
    // 全程所有 dashboard 请求的 search 恒为空字符串（q.search 未被复活）。
    const dashSearches = invokeMock.mock.calls
      .filter(([cmd, payload]) => cmd === 'local_request' && (payload as { method: string }).method === 'dashboard')
      .map(([, payload]) => (payload as { args: { query: { search: string } } }).args.query.search);
    expect(dashSearches.length).toBeGreaterThan(0);
    expect(dashSearches).not.toContain('foo');
  });

  it('输入后 SEARCH_DEBOUNCE_MS 内点「清除筛选」：已提交的词被清掉且不再复活', async () => {
    vi.useFakeTimers();
    const { default: App } = await import('../src/App');
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => { root = createRoot(container!); root!.render(<App />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });

    act(() => {
      const tab = [...container!.querySelectorAll('.subnav button')]
        .find(b => b.textContent === '模型');
      (tab as HTMLButtonElement).click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    const input = container!.querySelector('.panel-heading .search input') as HTMLInputElement;

    // 这次让它正常提交：350ms 到点 → 筛选条出现。
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'foo');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 100); });
    expect(container!.querySelector('.filter-chips')).not.toBeNull();

    // 提交之后立刻点「清除筛选」：cancel + 清空。此后不存在任何待发定时器，
    // 但这条断言同时钉住「清除后的查询 search 恒为空」。
    act(() => {
      const clear = container!.querySelector('.filter-chips button') as HTMLButtonElement;
      clear.click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 100); });
    expect(container!.querySelector('.filter-chips')).toBeNull();

    const searchesAfterClear = invokeMock.mock.calls
      .filter(([cmd, payload]) => cmd === 'local_request' && (payload as { method: string }).method === 'dashboard')
      .map(([, payload]) => (payload as { args: { query: { search: string } } }).args.query.search);
    const last = searchesAfterClear.at(-1);
    expect(last).toBe('');
  });
});
