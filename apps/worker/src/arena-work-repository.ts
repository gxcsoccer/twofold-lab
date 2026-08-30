import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";
import { createClient } from "@supabase/supabase-js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

export type ArenaWorkPhase =
  | "RUN_AGENT_DECISION"
  | "PREPARE_S1_ORDERS"
  | "CAPTURE_S1_OPEN_REFERENCE"
  | "CAPTURE_S1_CLOSE"
  | "SETTLE_S1_AND_PREPARE_S2"
  | "CAPTURE_S2_OPEN_REFERENCE"
  | "CAPTURE_S2_CLOSE"
  | "FINALIZE_ACCEPTED_TARGET_CYCLE";

export type ArenaWorkStatus =
  | "REQUESTED"
  | "CLAIMED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED";

export interface ArenaWorkItem {
  readonly schema: "twofold.arena_work_item_result/v1";
  readonly workItemId: string;
  readonly roundEntryId: string;
  readonly roundId: string;
  readonly seasonId: string;
  readonly entrantId: string;
  readonly runId: string;
  readonly phase: ArenaWorkPhase;
  readonly predecessorWorkItemId: string | null;
  readonly scheduledAt: string;
  readonly deadlineAt: string | null;
  readonly nextAttemptAt: string;
  readonly status: ArenaWorkStatus;
  readonly attemptCount: string;
  readonly claimedBy: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly completedAt: string | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean | null;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaWorkRpcClient {
  rpc(functionName: string, arguments_: Record<string, unknown>): PromiseLike<RpcResult>;
}

export class SupabaseArenaWorkQueue {
  readonly #client: ArenaWorkRpcClient;

  constructor(url: string, secretKey: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as ArenaWorkRpcClient;
  }

  claim(input: {
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly now: string;
    readonly allowedPhases: readonly ArenaWorkPhase[];
  }): Promise<ArenaWorkItem | null> {
    return claimArenaWorkItem(this.#client, input);
  }

  async complete(input: {
    readonly workItemId: string;
    readonly leaseToken: string;
    readonly completedAt: string;
    readonly succeeded: boolean;
    readonly result: Readonly<Record<string, unknown>>;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly retryable: boolean;
  }): Promise<void> {
    await completeArenaWorkItem(this.#client, input);
  }
}

export async function seedArenaRoundWork(
  client: ArenaWorkRpcClient,
  input: { readonly roundId: string; readonly recordedBy: string },
): Promise<{ readonly roundId: string; readonly workItemCount: string }> {
  uuid(input.roundId, "roundId");
  identity(input.recordedBy, "recordedBy");
  const result = await retryExactRpcOnce(() => client.rpc(
    "seed_arena_round_work",
    { p_round_id: input.roundId, p_recorded_by: input.recordedBy },
  ));
  if (result.error !== null) {
    throw new Error(`seed_arena_round_work failed: ${result.error.message}`);
  }
  assertNoJsonNumber(result.data, "seed_arena_round_work result");
  const row = exactRecord(result.data, [
    "schema", "roundId", "workItemCount", "recordedBy",
  ], "Arena work seed");
  if (
    row.schema !== "twofold.arena_work_seed_result/v1"
    || uuid(row.roundId, "seed.roundId") !== input.roundId
    || identity(row.recordedBy, "seed.recordedBy") !== input.recordedBy
  ) throw new TypeError("Arena work seed returned an inconsistent identity");
  return Object.freeze({
    roundId: input.roundId,
    workItemCount: integer(row.workItemCount, "seed.workItemCount"),
  });
}

export async function claimArenaWorkItem(
  client: ArenaWorkRpcClient,
  input: {
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly now: string;
    readonly roundId?: string;
    readonly allowedPhases?: readonly ArenaWorkPhase[];
  },
): Promise<ArenaWorkItem | null> {
  identity(input.workerId, "workerId");
  if (!Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 5) {
    throw new TypeError("leaseSeconds must be an integer of at least five");
  }
  timestamp(input.now, "now");
  if (input.roundId !== undefined) uuid(input.roundId, "roundId");
  const allowedPhases = input.allowedPhases === undefined
    ? null
    : validateAllowedPhases(input.allowedPhases);
  const result = await client.rpc("claim_arena_work_item", {
    p_worker_id: input.workerId,
    p_lease_seconds: input.leaseSeconds,
    p_now: input.now,
    p_round_id: input.roundId ?? null,
    p_allowed_phases: allowedPhases,
  });
  if (result.error !== null) {
    throw new Error(`claim_arena_work_item failed: ${result.error.message}`);
  }
  if (result.data === null) return null;
  return parseWorkItem(result.data);
}

function validateAllowedPhases(
  value: readonly ArenaWorkPhase[],
): readonly ArenaWorkPhase[] {
  const allowed = new Set<ArenaWorkPhase>([
    "RUN_AGENT_DECISION", "PREPARE_S1_ORDERS",
    "CAPTURE_S1_OPEN_REFERENCE", "CAPTURE_S1_CLOSE",
    "SETTLE_S1_AND_PREPARE_S2", "CAPTURE_S2_OPEN_REFERENCE", "CAPTURE_S2_CLOSE",
    "FINALIZE_ACCEPTED_TARGET_CYCLE",
  ]);
  const normalized = [...value].sort();
  if (
    normalized.length === 0
    || normalized.some((phase) => !allowed.has(phase))
    || normalized.some((phase, index) => index > 0 && phase === normalized[index - 1])
    || normalized.some((phase, index) => phase !== value[index])
  ) {
    throw new TypeError("allowedPhases must be a sorted unique phase list");
  }
  return Object.freeze(normalized);
}

export async function completeArenaWorkItem(
  client: ArenaWorkRpcClient,
  input: {
    readonly workItemId: string;
    readonly leaseToken: string;
    readonly completedAt: string;
    readonly succeeded: boolean;
    readonly result: Readonly<Record<string, unknown>>;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly retryable: boolean;
  },
): Promise<ArenaWorkItem> {
  uuid(input.workItemId, "workItemId");
  uuid(input.leaseToken, "leaseToken");
  timestamp(input.completedAt, "completedAt");
  assertNoJsonNumber(input.result, "work completion result");
  const response = await retryExactRpcOnce(() => client.rpc(
    "complete_arena_work_item",
    {
      p_work_item_id: input.workItemId,
      p_lease_token: input.leaseToken,
      p_completed_at: input.completedAt,
      p_succeeded: input.succeeded,
      p_result: input.result,
      p_error_code: input.errorCode,
      p_error_message: input.errorMessage,
      p_retryable: input.retryable,
    },
  ));
  if (response.error !== null) {
    throw new Error(`complete_arena_work_item failed: ${response.error.message}`);
  }
  return parseWorkItem(response.data);
}

function parseWorkItem(value: unknown): ArenaWorkItem {
  assertNoJsonNumber(value, "Arena work item");
  const row = exactRecord(value, [
    "schema", "workItemId", "roundEntryId", "roundId", "seasonId",
    "entrantId", "runId", "phase", "predecessorWorkItemId",
    "scheduledAt", "deadlineAt", "nextAttemptAt", "status",
    "attemptCount", "claimedBy", "leaseToken", "leaseExpiresAt",
    "completedAt", "result", "errorCode", "errorMessage", "retryable",
  ], "Arena work item");
  if (row.schema !== "twofold.arena_work_item_result/v1") {
    throw new TypeError("unsupported Arena work item schema");
  }
  const phases = new Set<ArenaWorkPhase>([
    "RUN_AGENT_DECISION", "PREPARE_S1_ORDERS",
    "CAPTURE_S1_OPEN_REFERENCE", "CAPTURE_S1_CLOSE",
    "SETTLE_S1_AND_PREPARE_S2", "CAPTURE_S2_OPEN_REFERENCE", "CAPTURE_S2_CLOSE",
    "FINALIZE_ACCEPTED_TARGET_CYCLE",
  ]);
  const statuses = new Set<ArenaWorkStatus>([
    "REQUESTED", "CLAIMED", "SUCCEEDED", "FAILED", "CANCELED",
  ]);
  if (!phases.has(row.phase as ArenaWorkPhase)) {
    throw new TypeError("Arena work item has an invalid phase");
  }
  if (!statuses.has(row.status as ArenaWorkStatus)) {
    throw new TypeError("Arena work item has an invalid status");
  }
  const parsed: ArenaWorkItem = {
    schema: "twofold.arena_work_item_result/v1",
    workItemId: uuid(row.workItemId, "workItemId"),
    roundEntryId: uuid(row.roundEntryId, "roundEntryId"),
    roundId: uuid(row.roundId, "roundId"),
    seasonId: uuid(row.seasonId, "seasonId"),
    entrantId: uuid(row.entrantId, "entrantId"),
    runId: uuid(row.runId, "runId"),
    phase: row.phase as ArenaWorkPhase,
    predecessorWorkItemId: nullableUuid(
      row.predecessorWorkItemId,
      "predecessorWorkItemId",
    ),
    scheduledAt: timestamp(row.scheduledAt, "scheduledAt"),
    deadlineAt: nullableTimestamp(row.deadlineAt, "deadlineAt"),
    nextAttemptAt: timestamp(row.nextAttemptAt, "nextAttemptAt"),
    status: row.status as ArenaWorkStatus,
    attemptCount: integer(row.attemptCount, "attemptCount"),
    claimedBy: nullableIdentity(row.claimedBy, "claimedBy"),
    leaseToken: nullableUuid(row.leaseToken, "leaseToken"),
    leaseExpiresAt: nullableTimestamp(row.leaseExpiresAt, "leaseExpiresAt"),
    completedAt: nullableTimestamp(row.completedAt, "completedAt"),
    result: nullableRecord(row.result, "result"),
    errorCode: nullableIdentity(row.errorCode, "errorCode"),
    errorMessage: nullableIdentity(row.errorMessage, "errorMessage"),
    retryable: nullableBoolean(row.retryable, "retryable"),
  };
  if (
    parsed.status === "CLAIMED"
    && (parsed.claimedBy === null || parsed.leaseToken === null
      || parsed.leaseExpiresAt === null)
  ) throw new TypeError("claimed Arena work item has no complete lease");
  return deepFreeze(parsed);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const row = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (
    Object.keys(row).length !== keys.length
    || Object.keys(row).some((key) => !expected.has(key))
  ) throw new TypeError(`${field} has an unexpected shape`);
  return row;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function nullableIdentity(value: unknown, field: string): string | null {
  return value === null ? null : identity(value, field);
}

function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function integer(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!INTEGER_PATTERN.test(parsed)) throw new TypeError(`${field} must be an integer`);
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || new Date(parsed).toISOString() !== parsed
  ) throw new TypeError(`${field} must be a canonical UTC timestamp`);
  return parsed;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function nullableRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object or null`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new TypeError(`${field} must be a boolean or null`);
}

function assertNoJsonNumber(value: unknown, path: string): void {
  if (typeof value === "number") throw new TypeError(`${path} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumber(item, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertNoJsonNumber(nested, `${path}.${key}`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
