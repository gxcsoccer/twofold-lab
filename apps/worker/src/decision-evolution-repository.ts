import { createHash } from "node:crypto";

import {
  canonicalFinancialJson,
  type PortfolioDecisionEvolutionEvaluation,
} from "@twofold/core";

import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface DecisionEvolutionRegistration {
  readonly evaluation: PortfolioDecisionEvolutionEvaluation;
  readonly evaluationCanonicalJson: string;
  readonly artifactSha256: string;
  readonly rpcArguments: Readonly<{
    p_evaluation_sha256: string;
    p_artifact_sha256: string;
    p_comparison_sha256: string;
    p_experiment_id: string;
    p_trial_id: string;
    p_evidence_snapshot_id: string;
    p_official_outcome_sha256: string;
    p_candidate_outcome_sha256: string;
    p_result_sha256: string;
    p_evaluation: PortfolioDecisionEvolutionEvaluation;
    p_evaluation_canonical_json: string;
    p_recorded_by: string;
  }>;
}

export interface DecisionEvolutionReceipt {
  readonly evaluationSha256: string;
  readonly artifactSha256: string;
  readonly comparisonSha256: string;
  readonly resultSha256: string;
}

export interface DecisionEvolutionRpcClient {
  rpc(
    functionName: "register_decision_evolution_evaluation",
    arguments_: DecisionEvolutionRegistration["rpcArguments"],
  ): PromiseLike<RpcResultLike & { readonly data: unknown }>;
}

export function buildDecisionEvolutionRegistration(input: {
  readonly evaluation: PortfolioDecisionEvolutionEvaluation;
  readonly experimentId: string;
  readonly trialId: string;
  readonly recordedBy: string;
}): DecisionEvolutionRegistration {
  if (input.evaluation.schema !== "twofold.portfolio_decision_evolution_evaluation/v1") {
    throw new TypeError("unsupported decision evolution evaluation schema");
  }
  const experimentId = uuid(input.experimentId, "experimentId");
  const trialId = uuid(input.trialId, "trialId");
  if (input.evaluation.experimentId !== experimentId) {
    throw new TypeError("evaluation crossed its experiment identity");
  }
  const recordedBy = identity(input.recordedBy, "recordedBy");
  const evaluationCanonicalJson = canonicalFinancialJson(input.evaluation);
  const artifactSha256 = sha256(evaluationCanonicalJson);
  return Object.freeze({
    evaluation: input.evaluation,
    evaluationCanonicalJson,
    artifactSha256,
    rpcArguments: Object.freeze({
      p_evaluation_sha256: sha(
        input.evaluation.evaluationSha256,
        "evaluationSha256",
      ),
      p_artifact_sha256: artifactSha256,
      p_comparison_sha256: sha(
        input.evaluation.comparisonSha256,
        "comparisonSha256",
      ),
      p_experiment_id: experimentId,
      p_trial_id: trialId,
      p_evidence_snapshot_id: uuid(
        input.evaluation.evidenceSnapshotId,
        "evidenceSnapshotId",
      ),
      p_official_outcome_sha256: sha(
        input.evaluation.officialOutcome.outcomeSha256,
        "officialOutcomeSha256",
      ),
      p_candidate_outcome_sha256: sha(
        input.evaluation.candidateOutcome.outcomeSha256,
        "candidateOutcomeSha256",
      ),
      p_result_sha256: sha(input.evaluation.result.resultSha256, "resultSha256"),
      p_evaluation: input.evaluation,
      p_evaluation_canonical_json: evaluationCanonicalJson,
      p_recorded_by: recordedBy,
    }),
  });
}

export async function registerDecisionEvolutionEvaluation(
  client: DecisionEvolutionRpcClient,
  registration: DecisionEvolutionRegistration,
): Promise<DecisionEvolutionReceipt> {
  const response = await retryExactRpcOnce(() => client.rpc(
    "register_decision_evolution_evaluation",
    registration.rpcArguments,
  ));
  if (response.error !== null) {
    throw new Error(
      `register_decision_evolution_evaluation failed: ${response.error.message}`,
    );
  }
  const row = record(response.data);
  const receipt = Object.freeze({
    evaluationSha256: sha(row.evaluationSha256, "evaluationSha256"),
    artifactSha256: sha(row.artifactSha256, "artifactSha256"),
    comparisonSha256: sha(row.comparisonSha256, "comparisonSha256"),
    resultSha256: sha(row.resultSha256, "resultSha256"),
  });
  if (
    receipt.evaluationSha256 !== registration.evaluation.evaluationSha256
    || receipt.artifactSha256 !== registration.artifactSha256
    || receipt.comparisonSha256 !== registration.evaluation.comparisonSha256
    || receipt.resultSha256 !== registration.evaluation.result.resultSha256
  ) {
    throw new TypeError("persistence returned a different decision evolution identity");
  }
  return receipt;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("decision evolution RPC must return an object");
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

function sha(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256`);
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
