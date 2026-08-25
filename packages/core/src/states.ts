import type { SequenceString } from "./decimal.js";

export const SEASON_STATUSES = [
  "draft",
  "scheduled",
  "active",
  "completed",
  "unresolved",
  "canceled",
] as const;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

export const RUN_STATUSES = [
  "queued",
  "initializing",
  "active",
  "paused",
  "completed",
  "failed",
  "terminated",
  "canceled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const PIPELINE_STATUSES = [
  "idle",
  "decision_due",
  "deciding",
  "s1_pending",
  "s1_executing",
  "s2_planning",
  "s2_pending",
  "s2_executing",
  "settling",
  "deferred",
  "replaying",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const HEALTH_STATUSES = [
  "unknown",
  "healthy",
  "degraded",
  "nav_unresolved",
  "tax_unresolved",
  "blocked",
  "offline",
] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface HealthIssue {
  readonly code: string;
  readonly message: string;
  readonly since: string;
  readonly retryable: boolean;
}

export interface ControlPlaneIdentity {
  readonly experimentId: string;
  readonly seasonId: string;
  readonly runId: string;
}

export interface OrthogonalRuntimeState {
  readonly season: SeasonStatus;
  readonly run: RunStatus;
  readonly pipeline: PipelineStatus;
  readonly health: HealthStatus;
}

export interface StateProjectionMetadata {
  readonly lastAppliedSequence: SequenceString;
  readonly lastEventId?: string;
  readonly updatedAt?: string;
}
