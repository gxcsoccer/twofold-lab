import { createClient } from "@supabase/supabase-js";
import type { EvolutionMetricObservation } from "@twofold/core";

import type {
  EvolutionCycleClaim,
  EvolutionPolicy,
  EvolutionRepository,
} from "./evolution-runner.js";
import { retryExactRpcOnce } from "./exact-rpc.js";

interface RpcResult {
  readonly data: unknown;
  readonly error: Readonly<{ message: string; code?: string }> | null;
  readonly status: number;
}

export interface EvolutionRpcClient {
  rpc(name: string, args: Readonly<Record<string, unknown>>): PromiseLike<RpcResult>;
}

export class SupabaseEvolutionRepository implements EvolutionRepository {
  readonly #client: EvolutionRpcClient;

  constructor(url: string, secretKey: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as EvolutionRpcClient;
  }

  async request(input: Parameters<EvolutionRepository["request"]>[0]): Promise<void> {
    const response = await retryExactRpcOnce(() => this.#client.rpc(
      "request_evolution_cycle",
      {
        p_idempotency_key: input.idempotencyKey,
        p_window_started_at: input.windowStartedAt,
        p_window_ended_at: input.windowEndedAt,
        p_policy: input.policy,
        p_recorded_by: input.recordedBy,
      },
    ));
    assertRpc(response, "request_evolution_cycle");
  }

  async claim(input: Parameters<EvolutionRepository["claim"]>[0]): Promise<EvolutionCycleClaim | null> {
    const response = await this.#client.rpc("claim_evolution_cycle", {
      p_worker_id: input.workerId,
      p_lease_seconds: input.leaseSeconds,
    });
    assertRpc(response, "claim_evolution_cycle");
    if (response.data === null) return null;
    assertNoJsonNumber(response.data, "evolution cycle claim");
    const row = record(response.data);
    if (row.schema !== "twofold.evolution_cycle/v1" || row.status !== "CLAIMED") {
      throw new TypeError("claim_evolution_cycle returned an invalid lifecycle");
    }
    return Object.freeze({
      cycleId: identity(row.cycleId, "cycleId"),
      leaseToken: identity(row.leaseToken, "leaseToken"),
      windowStartedAt: timestamp(row.windowStartedAt, "windowStartedAt"),
      windowEndedAt: timestamp(row.windowEndedAt, "windowEndedAt"),
      policy: policy(row.policy),
    });
  }

  async collect(input: Parameters<EvolutionRepository["collect"]>[0]): Promise<readonly EvolutionMetricObservation[]> {
    const response = await this.#client.rpc("collect_evolution_metrics", {
      p_window_started_at: input.windowStartedAt,
      p_window_ended_at: input.windowEndedAt,
    });
    assertRpc(response, "collect_evolution_metrics");
    assertNoJsonNumber(response.data, "evolution metrics");
    if (!Array.isArray(response.data)) throw new TypeError("evolution metrics must be an array");
    return Object.freeze(response.data as EvolutionMetricObservation[]);
  }

  async complete(input: Parameters<EvolutionRepository["complete"]>[0]): Promise<void> {
    const response = await retryExactRpcOnce(() => this.#client.rpc(
      "complete_evolution_cycle",
      {
        p_cycle_id: input.cycleId,
        p_lease_token: input.leaseToken,
        p_observations: input.observations,
        p_analysis_report: input.report,
        p_report_sha256: input.report.reportSha256,
        p_worker_id: input.workerId,
      },
    ));
    assertRpc(response, "complete_evolution_cycle");
  }

  async fail(input: Parameters<EvolutionRepository["fail"]>[0]): Promise<void> {
    const response = await retryExactRpcOnce(() => this.#client.rpc(
      "fail_evolution_cycle",
      {
        p_cycle_id: input.cycleId,
        p_lease_token: input.leaseToken,
        p_worker_id: input.workerId,
        p_error_code: input.errorCode,
        p_error_message: input.errorMessage,
      },
    ));
    assertRpc(response, "fail_evolution_cycle");
  }
}

function assertRpc(response: RpcResult, name: string): void {
  if (response.error !== null) throw new Error(`${name} failed: ${response.error.message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value as Record<string, unknown>;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a trimmed identity`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)) {
    throw new TypeError(`${field} must be a canonical timestamp`);
  }
  return parsed;
}

function policy(value: unknown): EvolutionPolicy {
  const parsed = record(value);
  if (
    parsed.schema !== "twofold.evolution_policy/v1"
    || typeof parsed.analyzerVersion !== "string"
    || !Array.isArray(parsed.rules)
  ) throw new TypeError("evolution cycle returned an invalid policy");
  return value as EvolutionPolicy;
}

function assertNoJsonNumber(value: unknown, path: string): void {
  if (typeof value === "number") throw new TypeError(`${path} contains a JSON number`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumber(item, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => assertNoJsonNumber(item, `${path}.${key}`));
  }
}
