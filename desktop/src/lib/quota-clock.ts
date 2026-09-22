// Task #72 criterion 8: `QuotaPanel` owned a `setInterval(() => setNow(Date.now()), 1000)`
// in its own body, so every second React re-rendered the whole panel — including a history
// table of up to 500 rows — to advance a countdown that a handful of card footers read.
// The clock lives here instead: one shared ticker, reference counted by subscribers, which
// the countdown leaves subscribe to and nothing else does.
//
// The scheduler is injected for the same reason `lib/debounce.ts` injects one: the cadence
// and the fan-out are then testable without a DOM or real time.

export type QuotaClock = {
  /** Current time, read at render time so a re-render can never show a stale countdown. */
  now(): number;
  /** Registers a listener; returns the unsubscribe the calling component's cleanup runs. */
  subscribe(listener: (now: number) => void): () => void;
  /** Live subscribers, which is also how the tests see that the leaves are the whole fan-out. */
  subscribers(): number;
};

export type QuotaClockOptions = {
  intervalMs?: number;
  schedule?: (run: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
  now?: () => number;
};

export const QUOTA_TICK_MS = 1000;

export function createQuotaClock(options: QuotaClockOptions = {}): QuotaClock {
  const { intervalMs = QUOTA_TICK_MS, now = () => Date.now() } = options;
  const schedule = options.schedule ?? (run => setInterval(run, intervalMs));
  const unschedule = options.unschedule ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>));
  const listeners = new Set<(now: number) => void>();
  let handle: unknown = null;

  const tick = () => {
    const stamp = now();
    // A listener removed during the notification must not receive this tick.
    for (const listener of [...listeners]) listener(stamp);
  };

  return {
    now,
    subscribers: () => listeners.size,
    subscribe(listener) {
      listeners.add(listener);
      // One interval for every card, so three windows cost one timer instead of three, and
      // an unmounted panel leaves no timer behind once its last card has unsubscribed.
      if (handle === null) handle = schedule(tick, intervalMs);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && handle !== null) {
          unschedule(handle);
          handle = null;
        }
      };
    },
  };
}

// The app-wide default: created once per module so every mounted panel shares one timer.
let shared: QuotaClock | null = null;
export function sharedQuotaClock(): QuotaClock {
  shared ??= createQuotaClock();
  return shared;
}
