// The DTO shapes `local_request` actually answers with, kept next to the only reader that
// consumes them: `lib/api.ts` re-exports this file as its public type surface
// (`export type * from './reference-types'`).
//
// Task #72 criterion 9 / task #88 dead-code pass: a type belongs here only while a live
// projection reaches it. What used to sit underneath these - the overview, monthly-usage,
// model-catalog, scan, export, Codex limits/forecast/reset-announcement, update-check and tray
// menu shapes - mirrored commands this desktop shell never dispatches (`src-tauri/src/desktop.rs`
// answers bootstrap, status, start, stop, restart, scan, save_settings, save_prices, autostart,
// logs, reveal, dashboard, events, activities, replay, replay_raw, export), and no module,
// test or Rust file named a single one of them, so they are gone. Re-adding a command here
// starts by re-adding the type at the same time as the screen that reads it.

export type SessionDailyUsageRow = {
  date: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUSD: number;
  models: string[];
  projects: string[];
  quotaUsage?: SessionQuotaUsage | null;
};

export type SessionQuotaWindowUsage = {
  windowMinutes: number;
  resetsAt: string | null;
  observedStartAt: string;
  observedEndAt: string;
  observedStartPercent: number;
  observedEndPercent: number;
  observedDeltaPercent: number;
  belowResolution: boolean;
};

export type SessionQuotaUsage = {
  fiveHour: SessionQuotaWindowUsage[];
  weekly: SessionQuotaWindowUsage[];
};

export type SessionDetailRow = {
  path: string;
  sessionId: string;
  threadName: string | null;
  agentSessionId?: string | null;
  parentSessionId?: string | null;
  agentDepth?: number;
  agentPath?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  modifiedAtMs: number;
  sizeBytes: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUSD: number;
  models: string[];
  projects: string[];
  projectReferences?: ProjectReference[];
  dailyUsage: SessionDailyUsageRow[];
  quotaUsage?: SessionQuotaUsage | null;
};

export type ProjectReference = {
  path: string;
  displayName: string;
  codexProjectId?: string;
  codexProjectName?: string;
  codexProjectRoot?: string;
};

export type SessionReplayRawPage = {
  lines: string[];
  start: number;
  totalLines: number;
  modifiedAtMs: number;
  sizeBytes: number;
};

export type SessionReplayDetail = {
  range?: { start:number; end:number };
  rangeTotals?: { totalTokens:number; costUsd:number|null; unpricedEvents:number; events:number };
  path: string;
  sessionId: string;
  threadName: string | null;
  modifiedAtMs: number;
  sizeBytes: number;
  rawLineCount: number;
  /** Base instructions, stored once per session instead of once per turn. */
  baseMessages: Array<{ timestamp: string | null; kind: string; text: string }>;
  agents: Array<{
    path: string;
    sessionId: string;
    parentSessionId: string | null;
    depth: number;
    agentPath: string;
    nickname: string | null;
    role: string | null;
    threadName: string | null;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUSD: number | null;
  }>;
  summary: {
    startTime: string | null;
    endTime: string | null;
    durationMs: number | null;
    timeToFirstTokenMs: number | null;
    cwd: string | null;
    projects: string[];
    models: string[];
    cliVersion: string | null;
    git: Record<string, string>;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    costUSD: number | null;
    turnCount: number;
    messageCount: number;
    toolCallCount: number;
    patchCount: number;
    errorCount: number;
    malformedLines: number;
    unrecognizedEventCount: number;
  };
  turns: Array<{
    turnId: string;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    /** How many entries of the session's `baseMessages` applied when this turn started. */
    baseMessageCount: number;
    systemMessages: Array<{ timestamp: string | null; kind: string; text: string }>;
    userMessages: Array<{ timestamp: string | null; kind: string; text: string }>;
    assistantMessages: Array<{ timestamp: string | null; kind: string; text: string }>;
    reasoningSummaries: Array<{ timestamp: string | null; kind: string; text: string }>;
    toolCalls: Array<{
      callId: string | null;
      name: string;
      status: string | null;
      arguments: string | null;
      output: string | null;
      stderr: string | null;
      startedAt: string | null;
      completedAt: string | null;
      durationMs: number | null;
      isError: boolean;
    }>;
    patchResults: Array<{
      callId: string | null;
      success: boolean | null;
      output: string | null;
      timestamp: string | null;
      isError: boolean;
    }>;
    tokenEvents: Array<{
      timestamp: string | null;
      model: string;
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
      reasoningOutputTokens: number;
      totalTokens: number;
    }>;
    errors: string[];
    items: Array<(
      | { kind: "message"; timestamp: string | null; role: string; source: string; text: string }
      | { kind: "reasoning"; timestamp: string | null; text: string }
      | ({ kind: "toolCall" } & SessionReplayDetail["turns"][number]["toolCalls"][number])
      | ({ kind: "patch" } & SessionReplayDetail["turns"][number]["patchResults"][number])
      | ({ kind: "tokenUsage" } & SessionReplayDetail["turns"][number]["tokenEvents"][number])
      | { kind: "error"; timestamp: string | null; text: string }
      | { kind: "notice"; timestamp: string | null; label: string; text: string | null }
    ) & { rawJsonlLineNumbers?: number[] }>;
  }>;
};
