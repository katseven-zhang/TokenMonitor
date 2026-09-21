import { describe,expect,it,vi } from 'vitest';
import { debounce } from './debounce';

// A clock the test advances by hand, so nothing here depends on real time or a DOM.
function clock() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: (fn: () => void, _ms: number) => { const id = next++; timers.set(id, fn); return id; },
    unschedule: (handle: unknown) => { timers.delete(handle as number); },
    fire: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    scheduled: () => timers.size,
  };
}

describe('search input debouncing', () => {
  it('runs once with the last value of a keystroke burst', () => {
    const timers = clock();
    const run = vi.fn();
    const commit = debounce<[string]>(run, 350, timers.schedule, timers.unschedule);
    commit('a');
    commit('ab');
    commit('abc');
    expect(run).not.toHaveBeenCalled();
    expect(timers.scheduled()).toBe(1);
    timers.fire();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('abc');
  });

  it('runs again for a later burst', () => {
    const timers = clock();
    const run = vi.fn();
    const commit = debounce<[string]>(run, 350, timers.schedule, timers.unschedule);
    commit('a');
    timers.fire();
    commit('b');
    timers.fire();
    expect(run.mock.calls).toEqual([['a'], ['b']]);
  });

  it('can commit immediately and drops a pending burst on cancel', () => {
    const timers = clock();
    const run = vi.fn();
    const commit = debounce<[string]>(run, 350, timers.schedule, timers.unschedule);
    commit('abc');
    commit.flush();
    expect(run).toHaveBeenCalledWith('abc');
    commit.flush();
    expect(run).toHaveBeenCalledTimes(1);
    commit('abc');
    commit.cancel();
    timers.fire();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
