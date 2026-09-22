export type CopyOutcome = { ok: true } | { ok: false; reason: 'unavailable' | 'rejected' };

// `navigator.clipboard?.writeText(x)` resolves to undefined when the clipboard is
// missing, and a rejected write is swallowed by the caller, so both used to be
// reported to the user as "copied".
export async function writeClipboard(text: string): Promise<CopyOutcome> {
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) return { ok: false, reason: 'unavailable' };
  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'rejected' };
  }
}
