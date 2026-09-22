import { applyDocumentLanguage } from "./document-language";

// Task #72: `src/i18n.ts` already read a saved language from `localStorage`, but nothing
// in `desktop/src` ever wrote one and nothing called `changeLanguage`, so the picker that
// the locale tables shipped keys for (`settings.lang_*`) could not exist. These helpers
// keep the storage contract and the fallback chain in one place so the switcher, the
// initialisation and the tests all agree on the same rules without a DOM.

export type LanguageCode = "en" | "zh" | "ja";

/** Order the picker shows: the language the interface is currently most likely to want. */
export const LANGUAGES: readonly LanguageCode[] = ["zh", "en", "ja"];

/** Same key `src/i18n.ts` reads on boot; a new name would silently forget the choice. */
export const LANGUAGE_STORAGE_KEY = "language";

type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void } | null | undefined;

/** Narrows anything read from storage (or a `<select>`) to a language the tables cover. */
export function asLanguage(value: unknown): LanguageCode | null {
  return value === "zh" || value === "en" || value === "ja" ? value : null;
}

/** Reads the saved choice. A disabled or throwing `localStorage` is "no saved choice". */
export function readStoredLanguage(storage: StorageLike): LanguageCode | null {
  try {
    return asLanguage(storage?.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeLanguage(storage: StorageLike, code: LanguageCode): boolean {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, code);
    return true;
  } catch {
    // Private-mode and quota failures must not turn a language switch into an error banner.
    return false;
  }
}

/**
 * Picks the boot language: an explicit saved choice always wins, then the browser's own
 * language, then English. A `zh-TW`/`zh-HK` navigator still selects `zh`, because the
 * tables only carry one Chinese bundle and offering a variant would be a false promise.
 */
export function resolveLanguage(stored: unknown, navigatorLanguage = ""): LanguageCode {
  const saved = asLanguage(stored);
  if (saved) return saved;
  const tag = (navigatorLanguage || "").toLowerCase();
  if (tag.startsWith("zh")) return "zh";
  if (tag.startsWith("ja")) return "ja";
  return "en";
}

export type LanguageI18n = { changeLanguage(language: string): unknown };

/**
 * Applies a language everywhere it has an effect: the resource table, the persisted
 * choice, and `<html lang>` through the same `applyDocumentLanguage` the boot path uses.
 * Returning the document tag lets the caller (and the tests) see the applied result.
 */
export function switchLanguage(
  code: LanguageCode,
  i18n: LanguageI18n,
  storage: StorageLike = globalThis.localStorage,
  doc: Parameters<typeof applyDocumentLanguage>[1] = globalThis.document,
): string {
  void i18n.changeLanguage(code);
  storeLanguage(storage, code);
  return applyDocumentLanguage(code, doc);
}
