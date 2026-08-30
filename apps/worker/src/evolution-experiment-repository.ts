import { createClient } from "@supabase/supabase-js";

import type { EvolutionExperimentStore } from "./evolution-local-experiment.js";
import {
  buildDecisionComparisonRegistration,
  registerDecisionComparisonArtifact,
} from "./decision-comparison-repository.js";
import {
  buildDecisionEvolutionRegistration,
  registerDecisionEvolutionEvaluation,
} from "./decision-evolution-repository.js";
import { retryExactRpcOnce } from "./exact-rpc.js";

interface RpcResult {
  readonly data: unknown;
  readonly error: Readonly<{ message: string; code?: string }> | null;
  readonly status: number;
}

interface RpcClient {
  rpc(name: string, args: Readonly<Record<string, unknown>>): PromiseLike<RpcResult>;
}

export class SupabaseEvolutionExperimentStore implements EvolutionExperimentStore {
  readonly #client: RpcClient;

  constructor(url: string, secretKey: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as RpcClient;
  }

  async propose(input: Parameters<EvolutionExperimentStore["propose"]>[0]): Promise<void> {
    const response = await retryExactRpcOnce(() => this.#client.rpc(
      "propose_evolution_experiment",
      {
        p_spec: input.state.spec,
        p_spec_sha256: input.state.specSha256,
        p_actor_kind: input.actorKind,
        p_actor_id: input.actorId,
        p_proposed_at: input.at,
        p_idempotency_key: input.idempotencyKey,
      },
    ));
    assertRpc(response, "propose_evolution_experiment");
  }

  async transition(input: Parameters<EvolutionExperimentStore["transition"]>[0]): Promise<void> {
    const response = await retryExactRpcOnce(() => this.#client.rpc(
      "transition_evolution_experiment",
      {
        p_experiment_id: input.experimentId,
        p_action: input.action,
        p_actor_kind: input.actorKind,
        p_actor_id: input.actorId,
        p_action_at: input.at,
        p_idempotency_key: input.idempotencyKey,
        p_result: input.result,
      },
    ));
    assertRpc(response, "transition_evolution_experiment");
  }

  async registerTrial(input: Parameters<EvolutionExperimentStore["registerTrial"]>[0]): Promise<string> {
    const response = await retryExactRpcOnce(() => this.#client.rpc(
      "register_evolution_trial",
      {
        p_trial_code: input.trialCode,
        p_experiment_id: input.experimentId,
        p_season_id: input.seasonId,
        p_round_id: input.roundId,
        p_input_evidence: input.inputEvidence,
        p_scheduled_at: input.scheduledAt,
        p_expires_at: input.expiresAt,
        p_recorded_by: input.recordedBy,
      },
    ));
    assertRpc(response, "register_evolution_trial");
    const row = record(response.data);
    return identity(row.trialId, "trialId");
  }

  async completeTrial(input: Parameters<EvolutionExperimentStore["completeTrial"]>[0]): Promise<void> {
    const response = await retryExactRpcOnce(() => this.#client.rpc(
      "complete_evolution_trial",
      {
        p_trial_id: input.trialId,
        p_result: input.result,
        p_completed_at: input.completedAt,
        p_recorded_by: input.recordedBy,
      },
    ));
    assertRpc(response, "complete_evolution_trial");
  }

  async registerDecisionComparison(
    input: Parameters<EvolutionExperimentStore["registerDecisionComparison"]>[0],
  ): Promise<void> {
    const registration = buildDecisionComparisonRegistration({
      comparison: input.comparison,
      experimentId: input.experimentId,
      trialId: input.trialId,
      recordedBy: input.recordedBy,
    });
    await registerDecisionComparisonArtifact(
      this.#client as unknown as Parameters<
        typeof registerDecisionComparisonArtifact
      >[0],
      registration,
    );
  }

  async registerDecisionEvaluation(
    input: Parameters<EvolutionExperimentStore["registerDecisionEvaluation"]>[0],
  ): Promise<void> {
    const registration = buildDecisionEvolutionRegistration({
      evaluation: input.evaluation,
      experimentId: input.experimentId,
      trialId: input.trialId,
      recordedBy: input.recordedBy,
    });
    await registerDecisionEvolutionEvaluation(
      this.#client as unknown as Parameters<
        typeof registerDecisionEvolutionEvaluation
      >[0],
      registration,
    );
  }
}

function assertRpc(response: RpcResult, name: string): void {
  if (response.error !== null) throw new Error(`${name} failed: ${response.error.message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("evolution experiment RPC must return an object");
  }
  return value as Record<string, unknown>;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a trimmed identity`);
  }
  return value;
}
