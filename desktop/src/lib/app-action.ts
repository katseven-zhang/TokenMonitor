import type { ErrorSlot } from './banner';
import type { Status } from './api';

// Task #72: `App.tsx` used to own these three rules inside its own closure, which left them
// untestable without a DOM - so a failed `invoke` reaching a caller that never caught it, and
// one failure written to two surfaces, were both invisible. They live here as plain functions
// the shell wires its state into, exactly like `lib/banner.ts` does for the slot model.

/** The desktop shell's one IPC entry: `lib/api.ts`'s `request`, wrapped around `local_request`. */
export type Invoke = <T>(method: string, args?: unknown) => Promise<T>;

export type ActionDeps = {
  invoke: Invoke;
  /** Writes a shared banner slot. Only the failure nobody else can show belongs there. */
  report: (slot: ErrorSlot, message: string) => void;
  clearActionError: () => void;
  setBusy: (busy: boolean) => void;
  refresh: () => unknown;
  setStatus: (status: Status) => void;
};

/**
 * Runs one service action and reports its failure exactly once. A caller that passed
 * `onError` can place the sentence next to the control that caused it, so the banner stays
 * silent; without that callback the banner is the only surface that can speak.
 */
export async function runAction(
  deps: ActionDeps,
  method: string,
  args: unknown = {},
  onError?: (message: string) => void,
): Promise<boolean> {
  deps.setBusy(true);
  deps.clearActionError();
  try {
    await deps.invoke<unknown>(method, args);
    await deps.refresh();
    deps.setStatus(await deps.invoke<Status>('status'));
    return true;
  } catch (error) {
    const message = String(error);
    if (onError) onError(message);
    else deps.report('action', message);
    return false;
  } finally {
    deps.setBusy(false);
  }
}

/**
 * Reads the service log for the logs page. The result and the failure are both handed to a
 * callback, so a rejected `invoke` can never leave the caller with an unhandled rejection or
 * with a page that silently keeps yesterday's text.
 */
export async function loadLogs(
  invoke: Invoke,
  onText: (text: string) => void,
  onFailure: (message: string) => void,
): Promise<void> {
  try {
    onText((await invoke<{ text: string }>('logs')).text);
  } catch (error) {
    onFailure(String(error));
  }
}

/** The two surfaces in the settings page that can save the price document. */
export type PriceSurface = 'currency' | 'prices';
export type PriceFailure = { surface: PriceSurface; message: string } | null;

/**
 * Which of the two save buttons shows a price failure: the one that asked for the save.
 * Handing the message to both would put the same sentence on screen twice.
 */
export function priceFailureAt(failure: PriceFailure, surface: PriceSurface): string {
  return failure && failure.surface === surface ? failure.message : '';
}
