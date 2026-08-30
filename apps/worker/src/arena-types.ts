import type { ReadyDecisionPacket } from "@twofold-lab/dsh-twofold";

export const ARENA_PROJECTION_NAME = "dashboard.arena_decision";
export const ARENA_PROJECTION_SCHEMA_VERSION = "1";
export const DECISION_PACKET_SCHEMA_VERSION = "twofold.decision_packet/v1";

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

export type ArenaCostStatus =
  | "ESTIMATED"
  | "PARTIAL"
  | "UNPRICED"
  | "UNAVAILABLE";

export interface ArenaUsage {
  providerRequestCount: string;
  uncachedInputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  outputTokens: string;
  reasoningTokens: string;
  totalBillableTokens: string;
  estimatedCostUsd: string | null;
  costStatus: ArenaCostStatus;
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
  usage: ArenaUsage;
}

export interface ArenaBudget {
  maxProviderRequests: string;
  usedProviderRequests: string;
  maxBillableTokens: string;
  usedBillableTokens: string;
  maxEstimatedCostUsd: string;
  usedEstimatedCostUsd: string | null;
  maxDescendants: string;
  activeDescendants: string;
  enforcementStatus: "WITHIN_LIMITS" | "EXHAUSTED" | "UNPRICED";
}

export interface ArenaProjectionState {
  schemaVersion: typeof ARENA_PROJECTION_SCHEMA_VERSION;
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
  treeUsage: ArenaUsage;
  budget: ArenaBudget;
  submission: {
    status: "PENDING" | "ACCEPTED" | "REJECTED" | "NONE";
    acceptedSubmissionId: string | null;
    acceptedAt: string | null;
    rejectionCode: string | null;
  };
  updatedAt: string;
}

export interface ArenaInvocationIdentity {
  decisionId: string;
  runId: string;
  seasonId: string;
  decisionPacketId: string;
  rootSessionId: string;
  snapshotId: string;
  packetSha256: string;
  packetArtifactId: string;
  bundleArtifactId: string;
  bundleId: string;
  bundleSha256: string;
  presetId: "twofold" | "twofold-orchestrator";
  executionClass: "ROOT_ONLY" | "ORCHESTRATED";
  provider: "deepseek-official";
  model: "deepseek-v4-pro";
  decisionAt: string;
  dataCutoffAt: string;
  submissionDeadlineAt: string;
}

export interface PreparedArenaInvocation {
  identity: ArenaInvocationIdentity;
  packet: ReadyDecisionPacket;
  projection: ArenaProjectionState;
  runStreamSeq: string;
  projectionStreamSeq: string;
}

export function emptyArenaUsage(): ArenaUsage {
  return {
    providerRequestCount: "0",
    uncachedInputTokens: "0",
    cacheReadTokens: "0",
    cacheWriteTokens: "0",
    outputTokens: "0",
    reasoningTokens: "0",
    totalBillableTokens: "0",
    estimatedCostUsd: null,
    costStatus: "UNAVAILABLE",
    pricingVersions: [],
  };
}
