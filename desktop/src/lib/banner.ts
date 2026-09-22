// The banner used to concatenate three independent failure sources and clear only two
// of them on dismiss, so a background-status error produced a banner whose close button
// did nothing. The model lives here instead so the priority and dismissal rules are
// testable without a DOM.

export type ErrorSlot = 'action' | 'server' | 'status' | 'query';
export type ErrorSlots = Record<ErrorSlot, string>;

// Most specific to the user's own action first, then the background's own report.
export const ERROR_PRIORITY: ErrorSlot[] = ['action', 'server', 'status', 'query'];

export const emptyErrorSlots = (): ErrorSlots => ({ action: '', server: '', status: '', query: '' });

/** The server repeats the same error every poll; it counts again once the text changes. */
export function serverErrorSlot(error: string | null | undefined, dismissed: string): string {
  return error && error !== dismissed ? error : '';
}

export function visibleError(slots: ErrorSlots): { slot: ErrorSlot; message: string } | null {
  for (const slot of ERROR_PRIORITY) {
    const message = slots[slot];
    if (message && message.trim() !== '') return { slot, message };
  }
  return null;
}

export function dismissError(slots: ErrorSlots, slot: ErrorSlot): ErrorSlots {
  return { ...slots, [slot]: '' };
}

/** Notices are confirmations, not state: they leave on their own so they cannot mask a later failure. */
export const NOTICE_TTL_MS = 8_000;
