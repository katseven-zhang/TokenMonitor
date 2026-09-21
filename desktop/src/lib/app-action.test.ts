import { afterEach, describe, expect, it } from "vitest";
import { loadLogs, priceFailureAt, runAction, type ActionDeps, type PriceFailure, type PriceSurface } from "./app-action";
import type { Status } from "./api";

const running: Status = { running: true, scanning: false };
const surfaces: PriceSurface[] = ["currency", "prices"];

function harness(overrides: Partial<ActionDeps> = {}) {
  const banner: string[] = [];
  const cleared: string[] = [];
  const set: Status[] = [];
  const busy: boolean[] = [];
  const deps: ActionDeps = {
    invoke: async <T>() => ({}) as T,
    report: (slot, message) => { banner.push(`${slot}:${message}`); },
    clearActionError: () => { cleared.push('action'); },
    setBusy: value => { busy.push(value); },
    refresh: async () => {},
    setStatus: status => { set.push(status); },
    ...overrides,
  };
  return { banner, cleared, set, busy, deps };
}

describe('one failure, one surface', () => {
  it('uses the banner as the only reporter when the caller has nowhere to show it', async () => {
    const { banner, deps } = harness({ invoke: async <T>() => { throw new Error('服务未启动'); } });
    expect(await runAction(deps, 'start')).toBe(false);
    expect(banner).toEqual(['action:Error: 服务未启动']);
  });

  // The bug this guards: `action()` wrote the banner *and* called `onError`, so a rejected
  // price save showed the same sentence inline in the settings page and again at the top.
  it('leaves the banner untouched when the caller reports the failure itself', async () => {
    const { banner, deps } = harness({ invoke: async <T>() => { throw new Error('价格文档无法解析'); } });
    const inline: string[] = [];
    expect(await runAction(deps, 'save_prices', {}, message => { inline.push(message); })).toBe(false);
    expect(inline).toEqual(['Error: 价格文档无法解析']);
    expect(banner).toEqual([]);
  });

  it('clears the previous action failure before running, and leaves the busy flag behind', async () => {
    const { cleared, busy, deps } = harness();
    expect(await runAction(deps, 'scan')).toBe(true);
    expect(cleared).toEqual(['action']);
    expect(busy).toEqual([true, false]);
  });

  it('keeps reporting exactly one failure when the refresh after a good save itself fails', async () => {
    const { banner, deps } = harness({
      invoke: async <T>() => ({}) as T,
      refresh: async () => { throw new Error('读取仪表数据失败'); },
    });
    const inline: string[] = [];
    expect(await runAction(deps, 'save_prices', {}, message => { inline.push(message); })).toBe(false);
    expect([banner, inline].filter(list => list.length)).toHaveLength(1);
  });
});

describe('logs page read', () => {
  let unhandled: unknown[] = [];
  const seen = (reason: unknown) => { unhandled.push(reason); };
  afterEach(() => { process.off('unhandledRejection', seen); unhandled = []; });

  async function settle(invoke: Parameters<typeof loadLogs>[0]) {
    process.on('unhandledRejection', seen);
    const texts: string[] = [];
    const failures: string[] = [];
    await expect(loadLogs(invoke, text => { texts.push(text); }, message => { failures.push(message); })).resolves.toBeUndefined();
    await new Promise(resolve => { setTimeout(resolve, 0); });
    process.off('unhandledRejection', seen);
    return { texts, failures };
  }

  it('hands the log text to the page when the read succeeds', async () => {
    const { texts, failures } = await settle(async <T>() => ({ text: 'scan finished' }) as T);
    expect(texts).toEqual(['scan finished']);
    expect(failures).toEqual([]);
  });

  it('reports a rejected read instead of leaving it unhandled', async () => {
    const { texts, failures } = await settle(async <T>() => { throw new Error('日志文件读不到'); });
    expect(texts).toEqual([]);
    expect(failures).toEqual(['Error: 日志文件读不到']);
  });

  it('leaves no rejection with no handler behind', async () => {
    await settle(async <T>() => { throw new Error('后台未连接'); });
    expect(unhandled).toEqual([]);
  });
});

describe('price failure placement', () => {
  const failure: PriceFailure = { surface: 'currency', message: '价格内容为空' };

  it('shows the failure on the surface that asked for the save', () => {
    expect(priceFailureAt(failure, 'currency')).toBe('价格内容为空');
  });

  it('keeps the other save button quiet, so the sentence is never on screen twice', () => {
    const shown = surfaces.filter(surface => priceFailureAt(failure, surface) !== '');
    expect(shown).toEqual(['currency']);
    expect(surfaces.filter(surface => priceFailureAt(failure, surface) === '')).toEqual(['prices']);
  });

  it('shows nothing anywhere before a save has failed', () => {
    expect(surfaces.map(surface => priceFailureAt(null, surface))).toEqual(['', '']);
  });
});
