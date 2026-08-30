import { createClient } from "@supabase/supabase-js";

import type {
  ArenaPhaseOutcome,
  ArenaTickObserver,
  ArenaTickResult,
} from "./arena-tick-runner.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PHASE_KEYS = Object.freeze([
  "agent",
  "cycle",
  "market",
  "corporateActionScan",
  "corporateActionAccount",
  "recovery",
  "season",
  "evolution",
] as const);

interface RpcResult {
  readonly data: unknown;
  readonly error: Readonly<{ message: string }> | null;
}

export interface ArenaTickObservationRpcClient {
  rpc(
    functionName: "renew_worker_lease" | "register_arena_tick_observation",
    arguments_: Readonly<Record<string, unknown>>,
  ): PromiseLike<RpcResult>;
}

export interface RenewArenaTickHeartbeatInput {
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly capabilities: readonly string[];
}

export async function renewArenaTickHeartbeat(
  client: ArenaTickObservationRpcClient,
  input: RenewArenaTickHeartbeatInput,
): Promise<void> {
  const workerId = identity(input.workerId, "workerId");
  if (
    !Number.isInteger(input.leaseSeconds)
    || input.leaseSeconds < 5
    || input.leaseSeconds > 3_600
  ) {
    throw new TypeError("leaseSeconds must be an integer between 5 and 3600");
  }
  const capabilities = capabilityList(input.capabilities);
  const response = await client.rpc("renew_worker_lease", {
    p_worker_id: workerId,
    p_lease_seconds: input.leaseSeconds,
    p_capabilities: {
      schema: "twofold.arena_worker_capabilities/v1",
      arena: capabilities,
    },
  });
  if (response.error !== null) {
    throw new Error(`renew_worker_lease failed: ${response.error.message}`);
  }
}

export async function recordArenaTickObservation(
  client: ArenaTickObservationRpcClient,
  input: Readonly<{
    startedAt: string;
    finishedAt: string;
    result: ArenaTickResult;
  }>,
): Promise<void> {
  const workerId = identity(input.result.workerId, "workerId");
  const startedAt = timestamp(input.startedAt, "startedAt");
  const finishedAt = timestamp(input.finishedAt, "finishedAt");
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new TypeError("finishedAt must not precede startedAt");
  }
  const capabilities = capabilityList(input.result.capabilities);
  const phaseOutcomes = parsePhaseOutcomes(input.result.phaseOutcomes);
  const outcome = aggregateOutcome(phaseOutcomes);
  if (input.result.outcome !== outcome) {
    throw new TypeError("tick outcome is inconsistent with phase outcomes");
  }
  const response = await client.rpc("register_arena_tick_observation", {
    p_worker_id: workerId,
    p_started_at: startedAt,
    p_finished_at: finishedAt,
    p_outcome: outcome,
    p_capabilities: capabilities,
    p_phase_outcomes: phaseOutcomes,
  });
  if (response.error !== null) {
    throw new Error(
      `register_arena_tick_observation failed: ${response.error.message}`,
    );
  }
  assertNoJsonNumber(response.data, "Arena tick observation");
  const row = exactRecord(response.data, [
    "schema",
    "tickId",
    "workerId",
    "startedAt",
    "finishedAt",
    "outcome",
    "capabilities",
    "phaseOutcomes",
  ]);
  if (
    row.schema !== "twofold.arena_tick_observation/v1"
    || typeof row.tickId !== "string"
    || !UUID_PATTERN.test(row.tickId)
    || row.workerId !== workerId
    || row.startedAt !== startedAt
    || row.finishedAt !== finishedAt
    || row.outcome !== outcome
    || !sameJson(row.capabilities, capabilities)
    || !sameJson(parsePhaseOutcomes(row.phaseOutcomes), phaseOutcomes)
  ) {
    throw new TypeError(
      "register_arena_tick_observation returned inconsistent identity",
    );
  }
}

export class SupabaseArenaTickObserver implements ArenaTickObserver {
  readonly #client: ArenaTickObservationRpcClient;
  readonly #leaseSeconds: number;

  constructor(url: string, secretKey: string, leaseSeconds = 180) {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3_600) {
      throw new TypeError("leaseSeconds must be an integer between 5 and 3600");
    }
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as ArenaTickObservationRpcClient;
    this.#leaseSeconds = leaseSeconds;
  }

  heartbeat(input: Readonly<{
    workerId: string;
    capabilities: readonly string[];
  }>): Promise<void> {
    return renewArenaTickHeartbeat(this.#client, {
      ...input,
      leaseSeconds: this.#leaseSeconds,
    });
  }

  record(input: Readonly<{
    startedAt: string;
    finishedAt: string;
    result: ArenaTickResult;
  }>): Promise<void> {
    return recordArenaTickObservation(this.#client, input);
  }
}

function parsePhaseOutcomes(value: unknown): ArenaTickResult["phaseOutcomes"] {
  const row = exactRecord(value, PHASE_KEYS);
  return Object.freeze({
    agent: phaseOutcome(row.agent),
    cycle: phaseOutcome(row.cycle),
    market: phaseOutcome(row.market),
    corporateActionScan: phaseOutcome(row.corporateActionScan),
    corporateActionAccount: phaseOutcome(row.corporateActionAccount),
    recovery: phaseOutcome(row.recovery),
    season: phaseOutcome(row.season),
    evolution: phaseOutcome(row.evolution),
  });
}

function aggregateOutcome(
  outcomes: ArenaTickResult["phaseOutcomes"],
): ArenaPhaseOutcome {
  const values = Object.values(outcomes);
  return values.includes("failed")
    ? "failed"
    : values.includes("completed")
      ? "completed"
      : "idle";
}

function phaseOutcome(value: unknown): ArenaPhaseOutcome {
  if (value !== "idle" && value !== "completed" && value !== "failed") {
    throw new TypeError("unsupported Arena phase outcome");
  }
  return value;
}

function capabilityList(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("capabilities must be a non-empty array");
  }
  const capabilities = value.map((candidate) => identity(candidate, "capability"));
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError("capabilities must be unique");
  }
  return Object.freeze(capabilities);
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a trimmed non-empty identity`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${field} must be a UTC millisecond timestamp`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Arena tick observation must be an object");
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (!sameJson(actual, expected)) {
    throw new TypeError("Arena tick observation has an unexpected shape");
  }
  return row;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") {
    throw new TypeError(`${field} must encode decimals and integers as strings`);
  }
  if (Array.isArray(value)) {
    value.forEach((candidate) => assertNoJsonNumber(candidate, field));
    return;
  }
  if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>)
      .forEach((candidate) => assertNoJsonNumber(candidate, field));
  }
}
