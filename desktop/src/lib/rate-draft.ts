export type RateDraft = { ok: boolean; value: number | null; display: string };

// A rate draft accepts everything a decimal keyboard can produce while the user is
// still typing ("7", "7.", ".5", "7.2e") and reports both the number the text stands
// for and the text the field should show once the user leaves it. The input owns its
// text, so no keystroke can be folded into the parsed number and written back over it.
const COMPLETE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const TYPABLE = /^\d*\.?\d*(?:[eE][+-]?\d*)?$/;

export function parseExchangeRateDraft(raw: string): RateDraft {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null, display: '' };
  if (COMPLETE.test(text)) return { ok: true, value: Number(text), display: String(Number(text)) };
  if (TYPABLE.test(text)) {
    const settled = text.replace(/\.$/, '').replace(/[eE]\+?$/, '');
    return { ok: true, value: null, display: settled === '' || Number.isFinite(Number(settled)) ? settled : '' };
  }
  return { ok: false, value: null, display: raw };
}

// Types a rate one keystroke at a time and returns the value stored after every key,
// so a regression that swallows the decimal point is visible as a tenfold jump.
export function typeExchangeRate(keystrokes: string): (number | null)[] {
  const stored: (number | null)[] = [];
  for (let index = 1; index <= keystrokes.length; index += 1) {
    stored.push(parseExchangeRateDraft(keystrokes.slice(0, index)).value);
  }
  return stored;
}
