export type DataSource = "unconfigured" | "supabase";

export type StatusTone =
  | "neutral"
  | "positive"
  | "warning"
  | "critical"
  | "informative";

export interface ConnectionSummary {
  configured: boolean;
  source: DataSource;
  readStatus: "UNCONFIGURED" | "READY" | "NOT_READY" | "ERROR";
  label: string;
  detail: string;
}

export interface SetupItem {
  id: string;
  label: string;
  description: string;
  status: "ready" | "missing" | "pending";
  owner: string;
}

export interface SeasonSummary {
  id: string;
  name: string;
  status: "RUNNING" | "PAUSED" | "UNRESOLVED" | "COMPLETE";
  startAt: string;
  endAt: string;
  asOf: string;
  currentWeek: string;
  totalWeeks: string;
  nextDecisionAt: string;
  ruleVersion: string;
  experimentId: string;
}

export interface ModelUsageSummary {
  decisionCount: string;
  requestCount: string;
  uncachedInputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  outputTokens: string;
  /** Included in outputTokens; shown for observability and never added twice. */
  reasoningTokens: string;
  totalBillableTokens: string;
  estimatedCost: string | null;
  costCurrency: string | null;
  costStatus: "ESTIMATED" | "PARTIAL" | "UNPRICED" | "UNAVAILABLE";
  unpricedRequestCount: string;
  unreportedRequestCount: string;
  pricingVersions: string[];
}

export interface RunSummary {
  id: string;
  model: string;
  skill: string;
  kind: "model" | "baseline";
  status: "HEALTHY" | "WARNING" | "UNRESOLVED" | "COMPLETE";
  liquidationNav: string;
  returnPct: string;
  maxDrawdownPct: string;
  taxReserve: string;
  cashPct: string;
  roundMultiple: string;
  pipeline: string;
  modelUsage: ModelUsageSummary | null;
}

export interface ActivityItem {
  id: string;
  occurredAt: string;
  label: string;
  detail: string;
  tone: StatusTone;
}

export interface SeasonOverviewData {
  setupRequired: boolean;
  connection: ConnectionSummary;
  checklist: SetupItem[];
  season: SeasonSummary | null;
  runs: RunSummary[];
  modelUsage: ModelUsageSummary | null;
  activity: ActivityItem[];
}

export interface Holding {
  symbol: string;
  name: string;
  quantity: string;
  markPrice: string;
  marketValue: string;
  weightPct: string;
  unrealizedPct: string;
}

export interface PipelineStage {
  id: string;
  label: string;
  scheduledAt: string;
  status: "complete" | "current" | "upcoming" | "suppressed";
  detail: string;
}

export interface ManifestEntry {
  label: string;
  value: string;
  mono?: boolean;
}

export interface RunDetailData {
  setupRequired: boolean;
  connection: ConnectionSummary;
  run: RunSummary | null;
  seasonName: string | null;
  roundBase: string;
  successThreshold: string;
  failureThreshold: string;
  brokerNav: string;
  taxReservedNav: string;
  holdings: Holding[];
  pipeline: PipelineStage[];
  lastDecision: {
    decidedAt: string;
    dataCutoffAt: string;
    confidence: string;
    thesis: string;
    risks: string[];
    triggers: string[];
  } | null;
  manifest: ManifestEntry[];
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  type: string;
  entity: string;
  summary: string;
  status: "VERIFIED" | "RECORDED" | "WARNING" | "REJECTED";
  chainHash: string;
  idempotencyKey: string;
}

export interface AuditData {
  setupRequired: boolean;
  connection: ConnectionSummary;
  asOf: string | null;
  chainStatus: "EMPTY" | "VERIFIED" | "BROKEN";
  eventCount: string;
  lastCheckpointHash: string | null;
  events: AuditEvent[];
}

export interface SettingsData {
  setupRequired: boolean;
  connection: ConnectionSummary;
  checklist: SetupItem[];
  draft: {
    seasonName: string;
    startAt: string;
    endAt: string;
    timezone: string;
    decisionCadence: string;
    slippageBps: string;
    feeProfile: string;
    taxProfile: string;
    marketDataProvider: string;
    maxProviderRequestsPerDecision: string;
    maxBillableTokensPerDecision: string;
    maxEstimatedCostUsdPerDecision: string;
  };
  model: {
    id: string;
    displayName: string;
    credentialStatus: "not_configured" | "worker_managed";
    pricingStatus: "not_configured" | "versioned";
    pricingVersion: string | null;
  };
}

export interface MarketDataSourceSummary {
  sourceVersionId: string;
  provider: string;
  dataset: string;
  versionKey: string;
  feed: string;
  adjustment: string;
  timeframe: string;
  normalizerVersion: string;
  licenseScope: string;
  effectiveFrom: string;
}

export interface MarketDeliverySummary {
  deliveryId: string;
  rawArtifactId: string;
  providerRequestId: string | null;
  retrievedAt: string;
  firstObservedAt: string;
  availableAt: string;
  storageBucket: string;
  responseSha256: string;
  normalizedManifestSha256: string;
  objectPath: string;
  contentType: string;
  byteSize: string;
  firstStoredAt: string;
}

export interface MarketSnapshotSummary {
  snapshotId: string;
  snapshotKind: string;
  cutoffAt: string;
  targetSessionDate: string;
  symbols: string[];
  selectionPolicy: string;
  manifestSchema: string;
  manifestSha256: string;
  sealedAt: string;
}

export interface MarketBarSummary {
  factId: string;
  deliveryIds: string[];
  symbol: string;
  barStart: string;
  barDate: string;
  currency: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
  tradeCount: string;
  vwap: string | null;
  factSha256: string;
}

export interface MarketDataPageData {
  connection: ConnectionSummary;
  status: "UNCONFIGURED" | "WAITING" | "READY" | "ERROR";
  source: MarketDataSourceSummary | null;
  /** Exact Raw deliveries that contributed facts to the sealed snapshot. */
  deliveries: MarketDeliverySummary[];
  snapshot: MarketSnapshotSummary | null;
  bars: MarketBarSummary[];
  issues: string[];
}

export type ArenaDecisionStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "BUDGET_EXHAUSTED"
  | "NO_ACCEPTED_SUBMISSION";

export type ArenaAgentStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED";

export interface ArenaAgentUsage {
  providerRequestCount: string;
  uncachedInputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  outputTokens: string;
  /** Included in outputTokens; never added to billable tokens a second time. */
  reasoningTokens: string;
  totalBillableTokens: string;
  estimatedCostUsd: string | null;
  costStatus: "ESTIMATED" | "PARTIAL" | "UNPRICED" | "UNAVAILABLE";
  pricingVersions: string[];
}

export interface ArenaAgentNode {
  sessionId: string;
  parentSessionId: string | null;
  agentPath: string;
  displayName: string;
  origin: "root" | "subagent";
  delegationDepth: string;
  status: ArenaAgentStatus;
  provider: string;
  model: string;
  startedAt: string;
  completedAt: string | null;
  lastEventSeq: string;
  usage: ArenaAgentUsage;
}

export interface ArenaDecisionProjection {
  schemaVersion: "1";
  decision: {
    decisionId: string;
    runId: string;
    seasonId: string;
    bundleId: string;
    bundleSha256: string;
    presetId: string;
    status: ArenaDecisionStatus;
    decisionPacketId: string;
    snapshotId: string;
    packetSha256: string;
    dataCutoffAt: string;
    startedAt: string;
    completedAt: string | null;
    failureCode: string | null;
    failureMessage: string | null;
  };
  rootSessionId: string;
  agents: ArenaAgentNode[];
  treeUsage: ArenaAgentUsage;
  budget: {
    maxProviderRequests: string;
    usedProviderRequests: string;
    maxBillableTokens: string;
    usedBillableTokens: string;
    maxEstimatedCostUsd: string;
    usedEstimatedCostUsd: string | null;
    maxDescendants: string;
    activeDescendants: string;
    enforcementStatus: "WITHIN_LIMITS" | "EXHAUSTED" | "UNPRICED";
  };
  submission: {
    status: "PENDING" | "ACCEPTED" | "REJECTED" | "NONE";
    acceptedSubmissionId: string | null;
    acceptedAt: string | null;
    rejectionCode: string | null;
  };
  updatedAt: string;
}

export interface ArenaDecisionProjectionEvidence {
  stateHash: string;
  lastEventId: string | null;
  projectionUpdatedAt: string;
}

export interface AcceptedTargetCycleProjection {
  schema: "twofold.dashboard.accepted_target_cycle/v1";
  status: "COMPLETED";
  cycleId: string;
  decisionId: string;
  acceptedSubmissionId: string;
  s1: {
    status: "COMPLETED";
    orderCount: string;
    settlementCount: string;
  };
  s2: {
    status: "COMPLETED";
    orderCount: string;
    settlementCount: string;
  };
  ledger: {
    transactionCount: string;
    headSequence: string;
    headSha256: string;
  };
  nav: {
    currency: string;
    positionMarketValue: string;
    brokerNav: string;
    taxReserveDeductions: string;
    taxReservedNav: string;
    liquidationDeductions: string;
    liquidationNav: string;
  };
  artifactSha256: string;
  completedAt: string;
}

export type AcceptedTargetCycleBlocker =
  | "DECISION_NOT_FOUND"
  | "ACCEPTED_SUBMISSION_MISSING"
  | "STRATEGY_ACCOUNT_MISSING"
  | "LEDGER_HEAD_MISSING";

export interface AcceptedTargetCycleReadiness {
  schema: "twofold.accepted_target_cycle_readiness/v1";
  status: "BLOCKED" | "READY_FOR_INPUT_BUILD" | "COMPLETED";
  decisionId: string;
  runId: string | null;
  acceptedSubmissionId: string | null;
  strategyAccountId: string | null;
  ledgerHeadSha256: string | null;
  cycleId: string | null;
  blockers: readonly AcceptedTargetCycleBlocker[];
}

export interface ArenaDecisionPageData {
  decisionId: string;
  connection: ConnectionSummary;
  status: "UNCONFIGURED" | "NOT_READY" | "READY" | "ERROR";
  projection: ArenaDecisionProjection | null;
  evidence: ArenaDecisionProjectionEvidence | null;
  executionCycle: AcceptedTargetCycleProjection | null;
  executionReadiness: AcceptedTargetCycleReadiness | null;
  issues: string[];
}

export interface DashboardRepository {
  getSeasonOverview(): Promise<SeasonOverviewData>;
  getRunDetail(runId: string): Promise<RunDetailData>;
  getAuditData(): Promise<AuditData>;
  getSettingsData(): Promise<SettingsData>;
  getMarketData(): Promise<MarketDataPageData>;
  getArenaDecision(decisionId: string): Promise<ArenaDecisionPageData>;
}
