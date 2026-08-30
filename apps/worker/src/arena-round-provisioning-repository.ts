import { createClient } from "@supabase/supabase-js";

import type { TwoStageCycleCalendar } from "./alpaca-calendar.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

export type ArenaRoundProvisioningStatus =
  | "REQUESTED"
  | "CLAIMED"
  | "SUCCEEDED"
  | "FAILED";

export interface ArenaRoundProvisioning {
  readonly schema: "twofold.arena_round_provisioning/v1";
  readonly provisioningId: string;
  readonly sourceRoundId: string;
  readonly seasonId: string;
  readonly seasonCode: string;
  readonly seasonClosesAt: string;
  readonly nextRoundIndex: string;
  readonly decisionSnapshotId: string;
  readonly decisionSessionDate: string;
  readonly decisionAvailableAt: string;
  readonly recordedBy: string;
  readonly status: ArenaRoundProvisioningStatus;
  readonly attemptCount: string;
  readonly nextAttemptAt: string;
  readonly claimedBy: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly completedAt: string | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean | null;
}

export interface ArenaRoundProvisioningCommit {
  readonly schema: "twofold.arena_round_provisioning_commit/v1";
  readonly outcome: "ROUND_PROVISIONED" | "SEASON_COMPLETE";
  readonly provisioningId: string;
  readonly seasonId: string;
  readonly sourceRoundId: string;
  readonly roundId: string | null;
  readonly roundIndex: string;
  readonly entryCount: string;
  readonly workItemCount: string;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaRoundProvisioningRpcClient {
  rpc(
    functionName:
      | "claim_arena_round_provisioning"
      | "commit_arena_round_provisioning"
      | "fail_arena_round_provisioning",
    arguments_: Readonly<Record<string, unknown>>,
  ): PromiseLike<RpcResult>;
}

export interface ClaimArenaRoundProvisioningInput {
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly now: string;
}

export interface CommitArenaRoundProvisioningInput {
  readonly provisioningId: string;
  readonly sourceRoundId: string;
  readonly seasonId: string;
  readonly roundIndex: string;
  readonly leaseToken: string;
  readonly calendarArtifactId: string;
  readonly calendarArtifactSha256: string;
  readonly schedule: TwoStageCycleCalendar;
  readonly completedAt: string;
}

export interface FailArenaRoundProvisioningInput {
  readonly provisioningId: string;
  readonly leaseToken: string;
  readonly completedAt: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
}

export async function claimArenaRoundProvisioning(
  client: ArenaRoundProvisioningRpcClient,
  input: ClaimArenaRoundProvisioningInput,
): Promise<ArenaRoundProvisioning | null> {
  const workerId = identity(input.workerId, "workerId");
  if (
    !Number.isInteger(input.leaseSeconds)
    || input.leaseSeconds < 5
    || input.leaseSeconds > 3_600
  ) {
    throw new TypeError("leaseSeconds must be an integer between 5 and 3600");
  }
  const now = timestamp(input.now, "now");
  const result = await client.rpc("claim_arena_round_provisioning", {
    p_worker_id: workerId,
    p_lease_seconds: input.leaseSeconds,
    p_now: now,
  });
  if (result.error !== null) throw rpcError("claim_arena_round_provisioning", result);
  const raw = singleResult(result.data);
  if (raw === null) return null;
  const item = parseProvisioning(raw);
  if (
    item.status !== "CLAIMED"
    || item.claimedBy !== workerId
    || item.leaseToken === null
    || item.leaseExpiresAt === null
    || Date.parse(item.leaseExpiresAt) <= Date.parse(now)
  ) {
    throw new TypeError("claim_arena_round_provisioning returned an inconsistent lease");
  }
  return item;
}

/** Exact retry is safe because the database fingerprints the full commit. */
export async function commitArenaRoundProvisioningExact(
  client: ArenaRoundProvisioningRpcClient,
  input: CommitArenaRoundProvisioningInput,
): Promise<ArenaRoundProvisioningCommit> {
  uuid(input.provisioningId, "provisioningId");
  uuid(input.sourceRoundId, "sourceRoundId");
  uuid(input.seasonId, "seasonId");
  positiveInteger(input.roundIndex, "roundIndex");
  uuid(input.leaseToken, "leaseToken");
  uuid(input.calendarArtifactId, "calendarArtifactId");
  sha256(input.calendarArtifactSha256, "calendarArtifactSha256");
  timestamp(input.completedAt, "completedAt");
  validateSchedule(input.schedule);
  const arguments_ = Object.freeze({
    p_provisioning_id: input.provisioningId,
    p_lease_token: input.leaseToken,
    p_calendar_artifact_id: input.calendarArtifactId,
    p_calendar_artifact_sha256: input.calendarArtifactSha256,
    p_schedule: input.schedule,
    p_completed_at: input.completedAt,
  });
  const result = await retryExactRpcOnce(() => client.rpc(
    "commit_arena_round_provisioning",
    arguments_,
  ));
  if (result.error !== null) throw rpcError("commit_arena_round_provisioning", result);
  const committed = parseCommit(singleResult(result.data));
  if (
    committed.provisioningId !== input.provisioningId
    || committed.sourceRoundId !== input.sourceRoundId
    || committed.seasonId !== input.seasonId
    || committed.roundIndex !== input.roundIndex
  ) {
    throw new TypeError("commit_arena_round_provisioning returned inconsistent identity");
  }
  return committed;
}

export async function failArenaRoundProvisioning(
  client: ArenaRoundProvisioningRpcClient,
  input: FailArenaRoundProvisioningInput,
): Promise<ArenaRoundProvisioning> {
  uuid(input.provisioningId, "provisioningId");
  uuid(input.leaseToken, "leaseToken");
  timestamp(input.completedAt, "completedAt");
  identity(input.errorCode, "errorCode");
  identity(input.errorMessage, "errorMessage");
  const result = await client.rpc("fail_arena_round_provisioning", {
    p_provisioning_id: input.provisioningId,
    p_lease_token: input.leaseToken,
    p_completed_at: input.completedAt,
    p_error_code: input.errorCode,
    p_error_message: input.errorMessage,
    p_retryable: input.retryable,
  });
  if (result.error !== null) throw rpcError("fail_arena_round_provisioning", result);
  const failed = parseProvisioning(singleResult(result.data));
  if (
    failed.provisioningId !== input.provisioningId
    || (failed.status !== "REQUESTED" && failed.status !== "FAILED")
  ) {
    throw new TypeError("fail_arena_round_provisioning returned inconsistent identity");
  }
  return failed;
}

export class SupabaseArenaRoundProvisioningQueue {
  readonly #client: ArenaRoundProvisioningRpcClient;

  constructor(url: string, secretKey: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as ArenaRoundProvisioningRpcClient;
  }

  claim(input: ClaimArenaRoundProvisioningInput) {
    return claimArenaRoundProvisioning(this.#client, input);
  }

  commit(input: CommitArenaRoundProvisioningInput) {
    return commitArenaRoundProvisioningExact(this.#client, input);
  }

  fail(input: FailArenaRoundProvisioningInput) {
    return failArenaRoundProvisioning(this.#client, input);
  }
}

function parseProvisioning(value: unknown): ArenaRoundProvisioning {
  assertNoJsonNumber(value, "Arena Round provisioning result");
  const row = exactRecord(value, [
    "schema", "provisioningId", "sourceRoundId", "seasonId", "seasonCode",
    "seasonClosesAt", "nextRoundIndex", "decisionSnapshotId",
    "decisionSessionDate", "decisionAvailableAt", "recordedBy", "status",
    "attemptCount", "nextAttemptAt", "claimedBy", "leaseToken",
    "leaseExpiresAt", "completedAt", "result", "errorCode", "errorMessage",
    "retryable",
  ], "Arena Round provisioning result");
  if (row.schema !== "twofold.arena_round_provisioning/v1") {
    throw new TypeError("unsupported Arena Round provisioning schema");
  }
  const status = provisioningStatus(row.status);
  const result = nullableObject(row.result, "result");
  const parsed = Object.freeze({
    schema: "twofold.arena_round_provisioning/v1" as const,
    provisioningId: uuid(row.provisioningId, "provisioningId"),
    sourceRoundId: uuid(row.sourceRoundId, "sourceRoundId"),
    seasonId: uuid(row.seasonId, "seasonId"),
    seasonCode: identity(row.seasonCode, "seasonCode"),
    seasonClosesAt: timestamp(row.seasonClosesAt, "seasonClosesAt"),
    nextRoundIndex: positiveInteger(row.nextRoundIndex, "nextRoundIndex"),
    decisionSnapshotId: uuid(row.decisionSnapshotId, "decisionSnapshotId"),
    decisionSessionDate: date(row.decisionSessionDate, "decisionSessionDate"),
    decisionAvailableAt: timestamp(row.decisionAvailableAt, "decisionAvailableAt"),
    recordedBy: identity(row.recordedBy, "recordedBy"),
    status,
    attemptCount: nonNegativeInteger(row.attemptCount, "attemptCount"),
    nextAttemptAt: timestamp(row.nextAttemptAt, "nextAttemptAt"),
    claimedBy: nullableIdentity(row.claimedBy, "claimedBy"),
    leaseToken: nullableUuid(row.leaseToken, "leaseToken"),
    leaseExpiresAt: nullableTimestamp(row.leaseExpiresAt, "leaseExpiresAt"),
    completedAt: nullableTimestamp(row.completedAt, "completedAt"),
    result,
    errorCode: nullableIdentity(row.errorCode, "errorCode"),
    errorMessage: nullableIdentity(row.errorMessage, "errorMessage"),
    retryable: nullableBoolean(row.retryable, "retryable"),
  }) satisfies ArenaRoundProvisioning;
  const claimed = status === "CLAIMED";
  if (
    claimed !== (parsed.claimedBy !== null)
    || claimed !== (parsed.leaseToken !== null)
    || claimed !== (parsed.leaseExpiresAt !== null)
    || (claimed && parsed.completedAt !== null)
  ) {
    throw new TypeError("Arena Round provisioning has an inconsistent lease shape");
  }
  if (BigInt(parsed.nextRoundIndex) <= 1n) {
    throw new TypeError("nextRoundIndex must be greater than one");
  }
  return parsed;
}

function parseCommit(value: unknown): ArenaRoundProvisioningCommit {
  assertNoJsonNumber(value, "Arena Round provisioning commit");
  const row = exactRecord(value, [
    "schema", "outcome", "provisioningId", "seasonId", "sourceRoundId",
    "roundId", "roundIndex", "entryCount", "workItemCount",
  ], "Arena Round provisioning commit");
  if (row.schema !== "twofold.arena_round_provisioning_commit/v1") {
    throw new TypeError("unsupported Arena Round provisioning commit schema");
  }
  if (row.outcome !== "ROUND_PROVISIONED" && row.outcome !== "SEASON_COMPLETE") {
    throw new TypeError("unsupported Arena Round provisioning outcome");
  }
  const parsed = Object.freeze({
    schema: "twofold.arena_round_provisioning_commit/v1" as const,
    outcome: row.outcome,
    provisioningId: uuid(row.provisioningId, "provisioningId"),
    seasonId: uuid(row.seasonId, "seasonId"),
    sourceRoundId: uuid(row.sourceRoundId, "sourceRoundId"),
    roundId: nullableUuid(row.roundId, "roundId"),
    roundIndex: positiveInteger(row.roundIndex, "roundIndex"),
    entryCount: nonNegativeInteger(row.entryCount, "entryCount"),
    workItemCount: nonNegativeInteger(row.workItemCount, "workItemCount"),
  }) satisfies ArenaRoundProvisioningCommit;
  if (
    (parsed.outcome === "ROUND_PROVISIONED"
      && (parsed.roundId === null || parsed.entryCount === "0" || parsed.workItemCount === "0"))
    || (parsed.outcome === "SEASON_COMPLETE"
      && (parsed.roundId !== null || parsed.entryCount !== "0" || parsed.workItemCount !== "0"))
  ) {
    throw new TypeError("Arena Round provisioning commit has inconsistent outcome");
  }
  return parsed;
}

function validateSchedule(value: TwoStageCycleCalendar): void {
  assertNoJsonNumber(value, "schedule");
  if (value.schema !== "twofold.two_stage_cycle_calendar/v1") {
    throw new TypeError("schedule uses an unsupported schema");
  }
  date(value.decisionSessionDate, "schedule.decisionSessionDate");
  date(value.s1SessionDate, "schedule.s1SessionDate");
  date(value.s2SessionDate, "schedule.s2SessionDate");
  timestamp(value.s1OpenAt, "schedule.s1OpenAt");
  timestamp(value.s1ReferenceAvailableAt, "schedule.s1ReferenceAvailableAt");
  timestamp(value.s1CloseAt, "schedule.s1CloseAt");
  timestamp(value.s1CloseAvailableAt, "schedule.s1CloseAvailableAt");
  timestamp(value.s2OpenAt, "schedule.s2OpenAt");
  timestamp(value.s2ReferenceAvailableAt, "schedule.s2ReferenceAvailableAt");
  timestamp(value.s2CloseAt, "schedule.s2CloseAt");
  timestamp(value.cycleReadyAt, "schedule.cycleReadyAt");
}

function rpcError(name: string, result: RpcResult): Error {
  return new Error(`${name} failed: ${result.error?.message ?? "unknown RPC error"}`);
}

function singleResult(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length !== 1) throw new TypeError("RPC must return exactly one result");
  return value[0];
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
  const expected = [...keys].sort();
  const actual = Object.keys(row).sort();
  if (
    expected.length !== actual.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new TypeError(`${field} has an unexpected shape`);
  return row;
}

function provisioningStatus(value: unknown): ArenaRoundProvisioningStatus {
  if (
    value !== "REQUESTED" && value !== "CLAIMED"
    && value !== "SUCCEEDED" && value !== "FAILED"
  ) throw new TypeError("status is unsupported");
  return value;
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

function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256`);
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

function date(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed)
    || new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed
  ) throw new TypeError(`${field} must be a calendar date`);
  return parsed;
}

function positiveInteger(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!POSITIVE_INTEGER_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a canonical positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
  return parsed;
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new TypeError(`${field} must be a boolean or null`);
}

function nullableObject(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object or null`);
  }
  return Object.freeze({ ...(value as Record<string, unknown>) });
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
