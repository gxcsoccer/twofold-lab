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

export type PrivateArenaSeasonStatus = "UPCOMING" | "RUNNING" | "COMPLETE";

export type PrivateArenaRoundStage =
  | "SCHEDULED"
  | "DECISION_WINDOW"
  | "WAITING_S1_OPEN"
  | "S1_EXECUTION"
  | "SETTLING_S1"
  | "S2_EXECUTION"
  | "FINALIZING"
  | "COMPLETE";

export type PrivateArenaWorkPhase =
  | "RUN_AGENT_DECISION"
  | "PREPARE_S1_ORDERS"
  | "CAPTURE_S1_OPEN_REFERENCE"
  | "CAPTURE_S1_CLOSE"
  | "SETTLE_S1_AND_PREPARE_S2"
  | "CAPTURE_S2_OPEN_REFERENCE"
  | "CAPTURE_S2_CLOSE"
  | "FINALIZE_ACCEPTED_TARGET_CYCLE";

export type PrivateArenaWorkStatus =
  | "REQUESTED"
  | "CLAIMED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED";

export interface PrivateArenaWorkOverview {
  schema: "twofold.private_arena_work_overview/v1";
  phase: PrivateArenaWorkPhase;
  status: PrivateArenaWorkStatus;
  scheduledAt: string;
  deadlineAt: string | null;
  attemptCount: string;
  errorCode: string | null;
}

export interface PrivateArenaScore {
  schema: "twofold.private_arena_score/v1";
  stage: "OPENING" | "S1_CLOSE" | "S2_CLOSE";
  roundIndex: string;
  valuationAt: string;
  brokerNav: string;
  taxReservedNav: string;
  liquidationNav: string;
  scoreBaseLiquidationNav: string;
  returnMultiple: string;
  valuationSha256: string;
}

export type PrivateArenaNoTradeReason =
  | "DECISION_UNAVAILABLE"
  | "S1_PLAN_UNAVAILABLE"
  | "S1_CHECKPOINT_UNAVAILABLE"
  | "FINALIZATION_UNAVAILABLE";

export interface PrivateArenaNoTradeOverview {
  schema: "twofold.private_arena_no_trade_overview/v1";
  status: "REQUESTED" | "CLAIMED" | "SUCCEEDED" | "FAILED";
  reasonCode: PrivateArenaNoTradeReason;
  sourcePhase:
    | "RUN_AGENT_DECISION"
    | "PREPARE_S1_ORDERS"
    | "SETTLE_S1_AND_PREPARE_S2"
    | "FINALIZE_ACCEPTED_TARGET_CYCLE";
  scheduledAt: string;
  completedAt: string | null;
  valuationId: string | null;
  outcome: "NO_TRADE_CARRY_FORWARD" | "EXISTING_S2_VALUATION" | null;
}

export interface PrivateArenaEntrantOverview {
  schema: "twofold.private_arena_entrant_overview/v2";
  rank: string | null;
  entrantId: string;
  entrantCode: string;
  runId: string;
  bundleId: string;
  presetId: string;
  provider: string;
  model: string;
  executionClass: "ROOT_ONLY" | "ORCHESTRATED" | "DETERMINISTIC_BASELINE";
  roundEntryId: string | null;
  decisionId: string | null;
  noTrade: PrivateArenaNoTradeOverview | null;
  valuation: PrivateArenaScore | null;
  work: PrivateArenaWorkOverview[];
}

export interface PrivateArenaOverview {
  schema: "twofold.private_arena_overview/v2";
  asOf: string;
  season: {
    schema: "twofold.private_arena_season_overview/v1";
    seasonId: string;
    seasonCode: string;
    displayName: string;
    opensAt: string;
    closesAt: string;
    status: PrivateArenaSeasonStatus;
    decisionCadence: "US_EQUITY_DAILY_AFTER_CLOSE";
    marketTimezone: "America/New_York";
    openingHolding: string;
    openingCash: string;
    entrantCount: string;
    roundCount: string;
  };
  currentRound: {
    schema: "twofold.private_arena_round_overview/v1";
    roundId: string;
    roundIndex: string;
    stage: PrivateArenaRoundStage;
    entryCount: string;
    finalCount: string;
    decisionSessionDate: string;
    decisionWindowOpensAt: string;
    decisionWindowClosesAt: string;
    s1SessionDate: string;
    s1OpenAt: string;
    s1CloseAt: string;
    s2SessionDate: string;
    s2OpenAt: string;
    s2CloseAt: string;
    cycleReadyAt: string;
  } | null;
  entrants: PrivateArenaEntrantOverview[];
}

export interface SeasonOverviewData {
  setupRequired: boolean;
  connection: ConnectionSummary;
  checklist: SetupItem[];
  overview: PrivateArenaOverview | null;
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

export interface AcceptedTargetSubmission {
  submissionId: string;
  decisionId: string;
  targets: ReadonlyArray<{
    symbol: string;
    targetWeightBps: string;
    rationale?: string;
  }>;
  cashWeightBps: string;
  decisionSummary: string;
  submissionSha256: string;
  acceptedAt: string;
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
  acceptedSubmission: AcceptedTargetSubmission | null;
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
