import { describe, expect, it, vi } from "vitest";
import { createQuotaClock, QUOTA_TICK_MS, sharedQuotaClock } from "./quota-clock";

// A scheduler the test advances by hand, so the cadence and the fan-out are provable without
// a DOM or real time (the same shape `debounce.test.ts` uses).
function scheduler() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, run);
      return id;
    },
    unschedule: (handle: unknown) => {
      timers.delete(handle as number);
    },
    started: () => [...timers.keys()],
    fire: (id: number) => timers.get(id)?.(),
  };
}

function fakeClock(start: number) {
  let nowValue = start;
  const timers = scheduler();
  const clock = createQuotaClock({
    now: () => nowValue,
    schedule: timers.schedule,
    unschedule: timers.unschedule,
  });
  return { clock, timers, advance: (ms: number) => (nowValue += ms) };
}

describe("shared quota countdown clock", () => {
  it("starts no timer until a countdown is mounted", () => {
    const { clock, timers } = fakeClock(0);
    expect(clock.subscribers()).toBe(0);
    expect(timers.started()).toEqual([]);
  });

  it("runs one interval for every subscribed card and notifies each of them", () => {
    const { clock, timers, advance } = fakeClock(1000);
    const first = vi.fn();
    const second = vi.fn();
    clock.subscribe(first);
    clock.subscribe(second);
    expect(clock.subscribers()).toBe(2);

    const id = timers.started()[0];
    // Three windows, one timer: a second subscription must not add a second interval.
    timers.fire(id);
    expect(timers.started()).toHaveLength(1);
    expect(first).toHaveBeenCalledWith(1000);
    expect(second).toHaveBeenCalledWith(1000);

    advance(30_000);
    timers.fire(id);
    expect(second).toHaveBeenLastCalledWith(31_000);
    expect(timers.started()).toHaveLength(1);
  });

  it("clears the interval once the last card unsubscribes", () => {
    const { clock, timers, advance } = fakeClock(0);
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = clock.subscribe(first);
    const offSecond = clock.subscribe(second);
    offFirst();
    expect(clock.subscribers()).toBe(1);
    expect(timers.started()).toHaveLength(1);
    advance(QUOTA_TICK_MS);
    timers.fire(timers.started()[0]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(QUOTA_TICK_MS);

    offSecond();
    expect(clock.subscribers()).toBe(0);
    expect(timers.started()).toEqual([]);
  });

  it("does not notify a listener that unsubscribed during the same tick", () => {
    const { clock, timers } = fakeClock(5);
    const survivor = vi.fn();
    const leaver = vi.fn(() => offLeaver());
    const offLeaver = clock.subscribe(leaver);
    clock.subscribe(survivor);
    expect(clock.subscribers()).toBe(2);

    timers.fire(timers.started()[0]);
    expect(leaver).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(clock.subscribers()).toBe(1);

    timers.fire(timers.started()[0]);
    expect(leaver).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(2);
  });

  it("keeps one shared clock for the whole app", () => {
    expect(sharedQuotaClock()).toBe(sharedQuotaClock());
  });
});
