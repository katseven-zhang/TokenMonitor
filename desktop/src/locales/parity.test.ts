import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "./en.json";
import ja from "./ja.json";
import zh from "./zh.json";

type Table = Record<string, string>;

function flatten(value: unknown, prefix = "", out: Table = {}): Table {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const id = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object") flatten(child, id, out);
    else out[id] = String(child);
  }
  return out;
}

const tables: Record<"en" | "zh" | "ja", Table> = {
  en: flatten(en),
  zh: flatten(zh),
  ja: flatten(ja),
};

const NAMESPACES = Object.keys(tables.en);
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "locales" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

// `t("a.b")`, `t('a.b')` and the `t(cond ? "a.b" : "a.c", …)` form all resolve a
// literal key, so a missing translation only shows up at runtime in one language.
function referencedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) keys.add(match[1]);
    for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) keys.add(match[1]);
    for (const match of text.matchAll(/\?\s*"([a-zA-Z0-9_.]+)"\s*:\s*"([a-zA-Z0-9_.]+)"/g)) {
      for (const candidate of [match[1], match[2]]) {
        if (NAMESPACES.includes(candidate.split(".")[0])) keys.add(candidate);
      }
    }
  }
  return keys;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
}

// A Chinese literal inside a component is copy the locale tables can never reach, which is
// the exact mixing task #72 complains about. Comments are source text, not UI text, so they
// are stripped before the scan.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const SRC_PREFIX = path.dirname(SRC_ROOT);

// Task #103 owns the last two files that still bake Chinese into a lib module; the guard
// turns red for them as soon as that exemption is dropped.
const UNLOCALISED_MODULES = ["lib/quota-observations.ts", "lib/currency.tsx"];

function relative(file: string): string {
  return path.relative(SRC_PREFIX, file).replaceAll("\\", "/");
}

// Keys the UI assembles at runtime are invisible to the literal scan above:
// `t(`sessions.detail.${toneKey}`)` for a message role, `patch_${action}` for a
// diff header, `tool_argument_labels.${key}` per argument, and the status token
// map the replay header reads. Listing them here is what proves they exist in all
// three tables, and it keeps task #88's pruning from deleting a live key.
const DYNAMIC_KEYS = [
  "sessions.detail.user",
  "sessions.detail.assistant",
  "sessions.detail.developer",
  "sessions.detail.system",
  "sessions.detail.patch_added",
  "sessions.detail.patch_edited",
  "sessions.detail.patch_deleted",
  "sessions.detail.status_completed",
  "sessions.detail.status_running",
  "sessions.detail.status_stopped",
  "sessions.detail.status_failed",
  "sessions.detail.status_success",
  "sessions.detail.status_unrecorded",
  // The language picker builds its option keys from `LANGUAGES`, so no literal reaches them:
  // `t(`settings.lang_${code}`)`. These are the strings the switcher actually shows.
  "settings.lang_zh",
  "settings.lang_en",
  "settings.lang_ja",
  ...Object.keys(tables.en).filter((key) => key.startsWith("sessions.detail.tool_argument_labels.")),
];

const referenced = [...new Set([...referencedKeys(), ...DYNAMIC_KEYS])];

// i18next resolves `t(key, { count })` to `key_one`/`key_other` per language, and
// zh has no plural forms at all, so a literal key lookup would flag correct
// tables. A key counts as present when either the bare key or its plural pair
// exists for that locale.
function has(table: Table, key: string): boolean {
  return Boolean(table[key]?.trim()) || Boolean(table[`${key}_one`]?.trim() && table[`${key}_other`]?.trim());
}

function textFor(table: Table, key: string): string {
  return table[key] ?? table[`${key}_other`] ?? "";
}

// A language name is written the way its own speakers write it: the picker must not offer
// 「英語」 to a Japanese user choosing English (task #104), so these keys are exempt from the
// untranslated-English check below on purpose, and `settings.lang_*` stays a real string.
const ENDONYM_KEYS = ["settings.lang_en", "settings.lang_zh", "settings.lang_ja"];

describe("locale tables", () => {
  it("finds the translation keys the UI actually uses", () => {
    expect(referenced.length).toBeGreaterThan(100);
  });

  it("ships every referenced key in zh and ja, not just English", () => {
    const missing = referenced.flatMap((key) =>
      (["en", "zh", "ja"] as const)
        .filter((locale) => !has(tables[locale], key))
        .map((locale) => `${key} (${locale})`),
    );
    expect(missing).toEqual([]);
  });

  it("keeps the {{placeholder}} set identical across locales for referenced keys", () => {
    const drift = referenced.flatMap((key) =>
      (["zh", "ja"] as const)
        .filter((locale) => placeholders(textFor(tables.en, key)).join() !== placeholders(textFor(tables[locale], key)).join())
        .map((locale) => `${key} (${locale}): ${textFor(tables.en, key)} | ${textFor(tables[locale], key)}`),
    );
    expect(drift).toEqual([]);
  });

  it("does not leave English text where zh and ja claim to translate it", () => {
    // Task #103 shipped zh activity-state labels as the English source strings,
    // and task #104 found the ja language picker translating the endonym
    // "English" into 「英語」. Values that are brand or unit tokens (Tokens, 5h,
    // Excel (.xlsx)) are legitimately ASCII, so only letter-bearing words the
    // locale could translate are checked here.
    const untranslated = referenced.filter((key) => {
      if (ENDONYM_KEYS.includes(key)) return false;
      // Placeholders are code, not copy: `CLI: {{value}}` must not count as an
      // English word that zh and ja failed to translate.
      const source = textFor(tables.en, key).replace(/\{\{[^}]*\}\}/g, "");
      if (!/[A-Za-z]{4,}/.test(source)) return false;
      return (["zh", "ja"] as const).some((locale) => textFor(tables[locale], key) === source);
    });
    expect(untranslated).toEqual([]);
  });

  it("keeps the three activity state labels localized in zh", () => {
    expect(tables.zh["sessions.detail.activity_running"]).toBe("运行中");
    expect(tables.zh["sessions.detail.activity_ran"]).toBe("已执行");
    expect(tables.zh["sessions.detail.activity_stopped"]).toBe("已停止");
  });

  it("shows each language by its own name in every locale", () => {
    for (const locale of ["en", "zh", "ja"] as const) {
      expect(tables[locale]["settings.lang_en"]).toBe("English");
      expect(tables[locale]["settings.lang_zh"]).toBe("简体中文");
      expect(tables[locale]["settings.lang_ja"]).toBe("日本語");
    }
  });

  it("leaves no hardcoded CJK literal in a component the locale tables should speak for", () => {
    const offenders = sourceFiles(SRC_ROOT)
      .filter((file) => !UNLOCALISED_MODULES.some((exempt) => relative(file).endsWith(exempt)))
      .filter((file) => /[぀-ヿ一-鿿]/.test(stripComments(readFileSync(file, "utf8"))))
      .map(relative);
    expect(offenders).toEqual([]);
  });
});
