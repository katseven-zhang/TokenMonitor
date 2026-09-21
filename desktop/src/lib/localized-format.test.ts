import { describe, expect, it } from "vitest";
import {
  MISSING_VALUE,
  formatCompact,
  formatCount,
  formatList,
  formatLocaleFor,
  formatOrNull,
  formatTickTimestamp,
  formatTimeOrNull,
  formatTimestamp,
} from "./localized-format";

const moment = Date.UTC(2026, 8, 20, 12, 30, 0);

describe("locale-aware formatting", () => {
  it("uses the same tags the document language sync picks", () => {
    expect(formatLocaleFor("zh")).toBe("zh-CN");
    expect(formatLocaleFor("ja")).toBe("ja-JP");
    expect(formatLocaleFor("en")).toBe("en");
    expect(formatLocaleFor("en-US")).toBe("en");
  });

  it("lets the interface language decide how a timestamp reads", () => {
    // The point of this module: before task #72 every one of these was pinned to `zh-CN`,
    // so an English interface still showed Chinese-formatted dates.
    const zh = formatTimestamp(moment, "zh");
    const en = formatTimestamp(moment, "en");
    const ja = formatTimestamp(moment, "ja");
    expect(zh).not.toBe(en);
    expect(ja).not.toBe(en);
    // The hour is always 24-hour, whatever the language orders its fields as.
    for (const value of [zh, en, ja]) expect(value).toMatch(/20:30:00/);
  });

  it("groups counts without losing the digits for any language", () => {
    for (const language of ["zh", "en", "ja"]) {
      expect(formatCount(1234567, language).replace(/\D/g, "")).toBe("1234567");
    }
    expect(formatCount(12.7, "en")).toBe("13");
  });

  it("shortens large totals for the hero value and the axes", () => {
    expect(formatCompact(12345, "en")).toBe("12.35K");
    expect(formatCompact(12345, "zh")).not.toBe(formatCompact(12345, "en"));
  });

  it("keeps a missing measurement a gap instead of a zero", () => {
    expect(formatOrNull(null, "en")).toBe(MISSING_VALUE);
    expect(formatTimeOrNull(null, "en")).toBe(MISSING_VALUE);
    expect(formatOrNull(0, "en")).not.toBe(MISSING_VALUE);
    expect(formatTimeOrNull(0, "en")).not.toBe(MISSING_VALUE);
  });

  it("shows only the time part the bucket size can change", () => {
    // Written as a growth chain rather than against fixed digits: the tick is rendered in
    // the machine's own time zone, so only the amount of detail is stable.
    const day = formatTickTimestamp(moment, "en", false);
    const hour = formatTickTimestamp(moment, "en", true);
    const minute = formatTickTimestamp(moment, "en", true, true);
    expect(hour.length).toBeGreaterThan(day.length);
    expect(minute.length).toBeGreaterThan(hour.length);
    expect(day).not.toMatch(/:/);
  });

  it("joins an inline list with the language's own separator", () => {
    expect(formatList(["a", "b"], "zh")).toBe("a、b");
    expect(formatList(["a", "b"], "ja")).toBe("a、b");
    expect(formatList(["a", "b"], "en")).toBe("a, b");
    expect(formatList(["only"], "en")).toBe("only");
    expect(formatList([], "en")).toBe("");
  });
});
