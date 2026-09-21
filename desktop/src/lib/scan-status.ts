// `query.rs` hands the `scan_status` rows straight through as `serde_json::Value`:
// whatever the scanner build that wrote the row happened to serialise. A row written by
// an older app version is missing fields a newer build declares, and TypeScript types do
// not exist at runtime — the old `s.errors.map(...)` therefore threw, and the throw
// reached the `ErrorBoundary` around the whole workspace instead of costing one panel.
// Everything that reads a status row goes through this reader, so an unusable field
// degrades into an explicit gap rather than a crash.

/** A row exactly as it arrives from the backend: fields may be absent or the wrong type. */
export type RawScanStatus = {
  agent?: unknown;
  state?: unknown;
  files?: unknown;
  reused?: unknown;
  malformedLines?: unknown;
  errors?: unknown;
  updatedAt?: unknown;
};

/** A row the source-status panel can render without probing it again. */
export type ScanStatusRow = {
  agent: string;
  state: string;
  files: number | null;
  reused: number | null;
  malformedLines: number | null;
  errors: string[];
  /** Error entries the row carried but that were not readable as text. */
  unreadableErrors: number;
  updatedAt: number | null;
  /** True when at least one declared field was missing or unusable. */
  partial: boolean;
};

const UNKNOWN_AGENT = "unknown";
const UNKNOWN_STATE = "unreadable";

function readCount(value: unknown): number | null {
  // A negative count is not a measurement either, so it reads as absent rather than as 0.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readErrors(value: unknown): { errors: string[]; unreadable: number } {
  if (value === undefined || value === null) return { errors: [], unreadable: 0 };
  if (!Array.isArray(value)) return { errors: [], unreadable: 1 };
  const errors: string[] = [];
  let unreadable = 0;
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) errors.push(entry);
    else unreadable += 1;
  }
  return { errors, unreadable };
}

/**
 * Reads one whole `status` array defensively: a non-array payload yields no rows, and a
 * row that is not an object at all still yields a placeholder instead of throwing.
 */
export function readScanStatusRows(input: unknown): ScanStatusRow[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => readScanStatusRow(item));
}

/** Reads a single row; exported because the panel needs it per row when merging. */
export function readScanStatusRow(input: unknown): ScanStatusRow {
  const row = (input && typeof input === "object" ? input : {}) as RawScanStatus;
  const missing = (value: unknown) => value === undefined || value === null;
  const agent = readText(row.agent, UNKNOWN_AGENT);
  const state = readText(row.state, UNKNOWN_STATE);
  const files = readCount(row.files);
  const reused = readCount(row.reused);
  const malformedLines = readCount(row.malformedLines);
  const updatedAt = readCount(row.updatedAt);
  const { errors, unreadable } = readErrors(row.errors);
  const partial =
    input === null ||
    typeof input !== "object" ||
    missing(row.agent) ||
    missing(row.state) ||
    files === null ||
    reused === null ||
    malformedLines === null ||
    updatedAt === null ||
    // A non-array `errors` already counts as one unreadable entry above.
    unreadable > 0;
  return { agent, state, files, reused, malformedLines, errors, unreadableErrors: unreadable, updatedAt, partial };
}
