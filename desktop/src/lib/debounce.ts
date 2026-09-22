export type Debounced<Args extends unknown[]> = ((...args: Args) => void) & {
  cancel: () => void;
  flush: () => void;
};

// Coalesces a burst of keystrokes into one trailing call. The clock is injected so the
// collapsing behaviour can be tested without a DOM.
export function debounce<Args extends unknown[]>(
  run: (...args: Args) => void,
  delay: number,
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  unschedule: (handle: unknown) => void = handle => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
): Debounced<Args> {
  let pending: { args: Args; handle: unknown } | null = null;
  const invoke = () => {
    if (!pending) return;
    const { args } = pending;
    pending = null;
    run(...args);
  };
  const debounced = ((...args: Args) => {
    if (pending) unschedule(pending.handle);
    pending = { args, handle: schedule(invoke, delay) };
  }) as Debounced<Args>;
  debounced.cancel = () => { if (pending) { unschedule(pending.handle); pending = null; } };
  debounced.flush = invoke;
  return debounced;
}

// One query per pause in typing instead of one per keystroke.
export const SEARCH_DEBOUNCE_MS = 350;
