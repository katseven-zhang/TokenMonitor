import { describe, expect, it } from "vitest";
import {
  asLanguage,
  LANGUAGES,
  LANGUAGE_STORAGE_KEY,
  readStoredLanguage,
  resolveLanguage,
  storeLanguage,
  switchLanguage,
} from "./language";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("language choice", () => {
  it("only accepts a language the tables carry", () => {
    expect(asLanguage("ja")).toBe("ja");
    for (const rejected of ["zh-CN", "fr", "", null, undefined, 42, { toString: () => "en" }]) {
      expect(asLanguage(rejected)).toBeNull();
    }
  });

  it("survives a storage that is missing or throws", () => {
    expect(readStoredLanguage(null)).toBeNull();
    expect(readStoredLanguage(undefined)).toBeNull();
    expect(readStoredLanguage({ getItem: () => { throw new Error("disabled"); }, setItem: () => {} })).toBeNull();
    expect(storeLanguage({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, "en")).toBe(false);
    expect(storeLanguage(null, "en")).toBe(true);
  });

  it("prefers the saved choice over the browser language", () => {
    const saved = storage({ [LANGUAGE_STORAGE_KEY]: "ja" });
    expect(resolveLanguage(readStoredLanguage(saved), "zh-CN")).toBe("ja");
  });

  it("falls back to the browser and then to English", () => {
    expect(resolveLanguage(null, "zh-TW")).toBe("zh");
    expect(resolveLanguage(null, "ja-JP")).toBe("ja");
    expect(resolveLanguage(null, "de-DE")).toBe("en");
    expect(resolveLanguage(null, "")).toBe("en");
    // A junk value in storage is not a choice, so the browser still decides.
    expect(resolveLanguage("pirate", "ja")).toBe("ja");
  });

  it("reads the key the boot path writes", () => {
    // `src/i18n.ts` reads `language`; a picker writing a different key would look like it
    // worked for the rest of the session and be forgotten at the next start.
    const saved = storage();
    storeLanguage(saved, "en");
    expect([...saved.values.keys()]).toEqual([LANGUAGE_STORAGE_KEY]);
    expect(readStoredLanguage(saved)).toBe("en");
  });

  it("switches the table, the stored choice and <html lang> together", () => {
    const calls: string[] = [];
    const i18n = { changeLanguage: (language: string) => void calls.push(`table:${language}`) };
    const doc = { documentElement: { lang: "zh-CN" } };
    const saved = storage();
    const applied = switchLanguage("en", i18n, saved, doc);
    expect(calls).toEqual(["table:en"]);
    expect(readStoredLanguage(saved)).toBe("en");
    expect(doc.documentElement.lang).toBe("en");
    expect(applied).toBe("en");
    // The tag mapping for the other two languages is `document-language.test.ts`'s job; this
    // is the wiring the settings picker depends on.
    switchLanguage("ja", i18n, saved, doc);
    expect(doc.documentElement.lang).toBe("ja-JP");
  });

  it("offers every table language in the picker", () => {
    const tableKeys = new Set(["zh", "en", "ja"]);
    expect(LANGUAGES.every(code => tableKeys.has(code))).toBe(true);
    expect(LANGUAGES).toHaveLength(tableKeys.size);
  });
});
