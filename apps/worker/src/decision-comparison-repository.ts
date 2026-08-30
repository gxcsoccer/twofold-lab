import { createHash } from "node:crypto";

import {
  canonicalFinancialJson,
  type PortfolioDecisionComparison,
} from "@twofold/core";

import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface DecisionComparisonRegistration {
  readonly comparison: PortfolioDecisionComparison;
  readonly comparisonCanonicalJson: string;
  readonly artifactSha256: string;
  readonly rpcArguments: Readonly<{
    p_comparison_sha256: string;
    p_artifact_sha256: string;
    p_evidence_snapshot_id: string;
    p_official_decision_sha256: string;
    p_candidate_decision_sha256: string;
    p_experiment_id: string | null;
    p_trial_id: string | null;
    p_comparison: PortfolioDecisionComparison;
    p_comparison_canonical_json: string;
    p_recorded_by: string;
  }>;
}

export interface DecisionComparisonArtifactReceipt {
  readonly comparisonSha256: string;
  readonly artifactSha256: string;
  readonly evidenceSnapshotId: string;
}

export interface DecisionComparisonRpcClient {
  rpc(
    functionName: "register_decision_comparison_artifact",
    arguments_: DecisionComparisonRegistration["rpcArguments"],
  ): PromiseLike<RpcResultLike & { readonly data: unknown }>;
}

export function buildDecisionComparisonRegistration(input: {
  readonly comparison: PortfolioDecisionComparison;
  readonly experimentId: string | null;
  readonly trialId: string | null;
  readonly recordedBy: string;
}): DecisionComparisonRegistration {
  if (!SHA256_PATTERN.test(input.comparison.comparisonSha256)) {
    throw new TypeError("comparisonSha256 must be a SHA-256");
  }
  uuid(input.comparison.evidenceSnapshotId, "evidenceSnapshotId");
  optionalUuid(input.experimentId, "experimentId");
  optionalUuid(input.trialId, "trialId");
  const recordedBy = identity(input.recordedBy, "recordedBy");
  const comparisonCanonicalJson = canonicalFinancialJson(input.comparison);
  const artifactSha256 = sha256(comparisonCanonicalJson);
  const rpcArguments = Object.freeze({
    p_comparison_sha256: input.comparison.comparisonSha256,
    p_artifact_sha256: artifactSha256,
    p_evidence_snapshot_id: input.comparison.evidenceSnapshotId,
    p_official_decision_sha256: input.comparison.official.decisionSha256,
    p_candidate_decision_sha256: input.comparison.candidate.decisionSha256,
    p_experiment_id: input.experimentId,
    p_trial_id: input.trialId,
    p_comparison: input.comparison,
    p_comparison_canonical_json: comparisonCanonicalJson,
    p_recorded_by: recordedBy,
  });
  return Object.freeze({
    comparison: input.comparison,
    comparisonCanonicalJson,
    artifactSha256,
    rpcArguments,
  });
}

export async function registerDecisionComparisonArtifact(
  client: DecisionComparisonRpcClient,
  registration: DecisionComparisonRegistration,
): Promise<DecisionComparisonArtifactReceipt> {
  const result = await retryExactRpcOnce(() => client.rpc(
    "register_decision_comparison_artifact",
    registration.rpcArguments,
  ));
  if (result.error !== null) {
    throw new Error(
      `register_decision_comparison_artifact failed: ${result.error.message}`,
    );
  }
  const row = record(result.data);
  const receipt = Object.freeze({
    comparisonSha256: sha(row.comparisonSha256, "comparisonSha256"),
    artifactSha256: sha(row.artifactSha256, "artifactSha256"),
    evidenceSnapshotId: uuid(
      row.evidenceSnapshotId,
      "evidenceSnapshotId",
    ),
  });
  if (
    receipt.comparisonSha256
      !== registration.comparison.comparisonSha256
    || receipt.artifactSha256 !== registration.artifactSha256
    || receipt.evidenceSnapshotId
      !== registration.comparison.evidenceSnapshotId
  ) {
    throw new TypeError(
      "persistence returned a different decision comparison identity",
    );
  }
  return receipt;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("decision comparison RPC must return an object");
  }
  return value as Record<string, unknown>;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function optionalUuid(value: string | null, field: string): void {
  if (value !== null) uuid(value, field);
}

function sha(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256`);
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
