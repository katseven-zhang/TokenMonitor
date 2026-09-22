import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readScanStatusRow, readScanStatusRows } from "./scan-status";

// The row a current scanner writes, used as the "nothing had to be filled in" baseline.
const completeRow = {
  agent: "codex",
  state: "ready",
  files: 12,
  reused: 3,
  malformedLines: 0,
  errors: ["codex: broken line 88"],
  updatedAt: 1_758_451_200_000,
};

describe("scan_status rows", () => {
  it("passes a current row through unchanged", () => {
    expect(readScanStatusRow(completeRow)).toEqual({
      agent: "codex",
      state: "ready",
      files: 12,
      reused: 3,
      malformedLines: 0,
      errors: ["codex: broken line 88"],
      unreadableErrors: 0,
      updatedAt: 1_758_451_200_000,
      partial: false,
    });
  });

  it("survives the row an older version wrote, which is the crash this reader exists for", () => {
    // No `errors` array at all: `s.errors.map(...)` used to throw here and the throw
    // escaped into the ErrorBoundary wrapping the entire workspace.
    expect(() => readScanStatusRows([{ agent: "codex", state: "ready", files: 4 }])).not.toThrow();
    const [row] = readScanStatusRows([{ agent: "codex", state: "ready", files: 4 }]);
    expect(row.errors).toEqual([]);
    expect(row.partial).toBe(true);
  });

  it("reports an absent count as unknown instead of inventing a zero", () => {
    const row = readScanStatusRow(completeRow);
    expect(row.files).toBe(12);
    const stripped = readScanStatusRow({ ...completeRow, files: undefined });
    expect(stripped.files).toBeNull();
    expect(stripped.malformedLines).toBe(0);
    expect(stripped.partial).toBe(true);
  });

  it("keeps a measured zero distinct from a missing field", () => {
    const measured = readScanStatusRow({ ...completeRow, files: 0, errors: [] });
    expect(measured.files).toBe(0);
    expect(measured.partial).toBe(false);
    expect(readScanStatusRow({ ...completeRow, files: null }).files).toBeNull();
  });

  it("rejects values the backend could not have meant as counts", () => {
    for (const value of ["12", Number.NaN, Number.POSITIVE_INFINITY, true, {}, -5]) {
      const row = readScanStatusRow({ ...completeRow, files: value });
      expect(row.files).toBeNull();
      expect(row.partial).toBe(true);
    }
  });

  it("keeps the readable errors and counts the ones it had to drop", () => {
    const row = readScanStatusRow({ ...completeRow, errors: ["first", 7, "", { text: "x" }, "last"] });
    expect(row.errors).toEqual(["first", "last"]);
    expect(row.unreadableErrors).toBe(3);
    expect(row.partial).toBe(true);
  });

  it("treats an errors field that is not a list as one unreadable entry", () => {
    const row = readScanStatusRow({ ...completeRow, errors: "disk full" });
    expect(row.errors).toEqual([]);
    expect(row.unreadableErrors).toBe(1);
    expect(row.partial).toBe(true);
  });

  it("falls back to a named unknown rather than an anonymous empty row", () => {
    const row = readScanStatusRow({ state: "", files: 1 });
    expect(row.agent).toBe("unknown");
    expect(row.state).toBe("unreadable");
  });

  it("reads a payload that is not even a list of rows as no rows", () => {
    for (const input of [undefined, null, "status", 7, {}]) {
      expect(readScanStatusRows(input)).toEqual([]);
    }
  });

  it("turns a row that is not an object into a placeholder instead of throwing", () => {
    for (const input of [null, undefined, 5, "codex", []]) {
      expect(() => readScanStatusRow(input)).not.toThrow();
      expect(readScanStatusRow(input).partial).toBe(true);
    }
    expect(readScanStatusRows([null, completeRow]).map((row) => row.files)).toEqual([null, 12]);
  });
});

// A regression guard on the call site: reading `data.status` directly re-opens the crash,
// and grepping for the reader's own definition would prove nothing about the consumer.
describe("dashboard consumers", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(path.resolve(here, "../App.tsx"), "utf8");

  it("feeds every status reader through the reader", () => {
    expect(app).toContain("readScanStatusRows(data?.status)");
    expect(app).toContain("sourceRows.map");
    expect(app).toContain("sourceRows.find");
    // Exactly one occurrence, and it is the reader call above: no consumer may index the
    // raw array again.
    expect(app.match(/data\?\.status/g) ?? []).toHaveLength(1);
  });

  it("renders counts through the degraded-aware helpers", () => {
    expect(app).toContain("files:countOrNull(s.files)");
    expect(app).toContain("updated:timeOrNull(s.updatedAt)");
    expect(app).not.toMatch(/<small>\{s\.files\}/);
    expect(app).not.toMatch(/time\(s\.updatedAt\)/);
  });
});
