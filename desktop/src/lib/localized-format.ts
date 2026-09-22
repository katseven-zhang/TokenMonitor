import { htmlLangFor } from "./document-language";

// Task #72: the panels formatted every number and timestamp with a literal `'zh-CN'`, so
// switching the interface language changed the words but left Chinese-formatted dates in an
// English window and English `K` abbreviations in a Chinese one. One place decides the
// formatting tag for a language, exactly like `document-language.ts` decides `<html lang>`.

/** BCP 47 tag the `Intl`/`toLocaleString` callers should use for an interface language. */
export function formatLocaleFor(language: string): string {
  return htmlLangFor(language);
}

/** Whole-count grouping (`1,234` / `1234`), used for token and record totals. */
export function formatCount(value: number, language: string): string {
  return new Intl.NumberFormat(formatLocaleFor(language), { maximumFractionDigits: 0 }).format(value);
}

/** Short-form total for the hero value and the chart axes, where digits matter more than units. */
export function formatCompact(value: number, language: string): string {
  return new Intl.NumberFormat(formatLocaleFor(language), { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

/** Local date-time without a 12-hour clock, matching the range fields' minute precision. */
export function formatTimestamp(value: number, language: string): string {
  return new Date(value).toLocaleString(formatLocaleFor(language), { hour12: false });
}

/**
 * Axis ticks for the trend chart: only the parts the bucket size can actually change. An
 * hourly bucket gets an hour but no minutes, a minute bucket gets both, and a daily one
 * neither, which is what keeps the axis from repeating itself.
 */
export function formatTickTimestamp(value: number, language: string, withHour: boolean, withMinute = false): string {
  const options: Intl.DateTimeFormatOptions = { month: "2-digit", day: "2-digit" };
  if (withHour) options.hour = "2-digit";
  if (withMinute) options.minute = "2-digit";
  return new Date(value).toLocaleString(formatLocaleFor(language), options);
}

/**
 * Joins a short inline list with the separator the active language uses (`、` for zh and ja,
 * `, ` otherwise) instead of a CJK comma baked into a component. `Intl.ListFormat` is not
 * used because its `conjunction`/`disjunction` forms would insert a word between the items.
 */
const LIST_SEPARATORS: Record<string, string> = { "zh-CN": "、", "ja-JP": "、" };
export function formatList(values: readonly string[], language: string): string {
  return values.join(LIST_SEPARATORS[formatLocaleFor(language)] ?? ", ");
}

/**
 * A missing measurement reads as a gap, never as a confident zero: an absent count and a
 * measured zero answer different questions. The em dash is punctuation, not copy, so it is
 * not language dependent.
 */
export const MISSING_VALUE = "—";
export function formatOrNull(value: number | null, language: string): string {
  return value === null ? MISSING_VALUE : formatCount(value, language);
}
export function formatTimeOrNull(value: number | null, language: string): string {
  return value === null ? MISSING_VALUE : formatTimestamp(value, language);
}
