
export type RangeKey = "1d" | "2d" | "7d" | "14d" | "30d" | "60d" | "90d" | "180d" | "365d" | string;
export type ExportFormat = "xlsx" | "markdown";

export type OverviewResponse = {
  range: RangeKey;
  days: number;
  timezone: string;
  startDate: string;
  endDate: string;
  updatedAt: string | null;
  daily: Array<{
    date: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUSD: number;
  }>;
  totals: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUSD: number;
    avgTokensPerDay: number;
    avgCostPerDay: number;
    cacheHitRate: number;
    costPerMillionTokens: number;
  };
  models: Array<{
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUSD: number;
    pricingStatus: "priced" | "free" | "unavailable";
    inputCostPerMillionTokens: number | null;
    cachedInputCostPerMillionTokens: number | null;
    outputCostPerMillionTokens: number | null;
    effectiveCostPerMillionTokens: number | null;
  }>;
  projects: Array<{
    project: string;
    displayName: string;
    lastActiveDate?: string;
    codexProjectId?: string;
    codexProjectName?: string;
    codexProjectRoot?: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUSD: number;
  }>;
};

export type ProjectAnalyticsResponse = {
  project: string;
  displayName: string;
  codexProjectId?: string;
  codexProjectName?: string;
  codexProjectRoot?: string;
  range: RangeKey;
  startDate: string;
  endDate: string;
  timezone: string;
  summary: OverviewResponse["projects"][number];
  models: Array<{ model: string; totalTokens: number }>;
  daily: OverviewResponse["daily"];
};

export type ModelPricingCatalogResponse = {
  isLimited: boolean;
  models: Array<{
    model: string;
    provider: string;
    pricingStatus: "priced" | "free" | "unavailable";
    inputCostPerMillionTokens: number | null;
    cachedInputCostPerMillionTokens: number | null;
    outputCostPerMillionTokens: number | null;
  }>;
};

export type MonthlyUsageResponse = {
  timezone: string;
  startMonth: string;
  endMonth: string;
  updatedAt: string | null;
  monthly: Array<{
    month: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUSD: number;
  }>;
};

export type ScanResponse = {
  importedDays: number;
  scannedAt: string;
  timezone: string;
  metrics?: {
    totalMs: number;
    pricingMs: number;
    parseMs: number;
    dbMs: number;
    filesScanned: number;
    filesParsed: number;
    filesReused: number;
    bytesRead: number;
  };
};

export type ExportResponse = {
  path: string;
  format: ExportFormat;
  range: RangeKey;
  exportedAt: string;
};

export type CodexLimitWindow = {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
};

export type CodexResetCredit = {
  id: string;
  expiresAt: string | null;
};

export type CodexLimitsResponse = {
  session: CodexLimitWindow | null;
  weekly: CodexLimitWindow | null;
  resetCreditsAvailableCount?: number | null;
  resetCredits?: CodexResetCredit[] | null;
  updatedAt: string;
  source: string;
  account?: string | null;
  membershipLevel?: string | null;
  workspaceName?: string | null;
  subscriptionExpiresAt?: string | null;
  subscriptionWillRenew?: boolean | null;
};

export type CodexWindowActivationStatus = "started" | "alreadyActive" | "recentlyRequested";

export type CodexWindowActivationResponse = {
  status: CodexWindowActivationStatus;
  limits: CodexLimitsResponse;
};

export type CodexQuotaForecastResponse = {
  score: number;
  fetchedAt: string;
  nextRefreshAt: string;
};

export type CodexResetAnnouncement = {
  id: string;
  resetType: "regular" | "banked";
  announcedAt: string;
  text: string;
  source: {
    author?: string | null;
    url: string;
  };
};

export type UsageRefreshResponse = {
  scan: ScanResponse;
  limits: CodexLimitsResponse | null;
  limitsError: string | null;
  limitsSkipped: boolean;
  refreshedAt: string;
};















export type UpdateCheckResponse = {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  latestTag: string;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseUrl: string;
  etag?: string | null;
  notModified?: boolean | null;
};

export type UpdateInstallResponse = {
  version: string;
};

export type UpdateDownloadProgress = {
  downloaded: number;
  total: number | null;
  finished: boolean;
};





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



export type TrayMenuItemDto = {
  id: string;
  text: string;
  enabled: boolean;
};

export type TrayMenuUpdate = {
  title: string;
  items: TrayMenuItemDto[];
  show_main_text?: string;
  quit_text?: string;
};
