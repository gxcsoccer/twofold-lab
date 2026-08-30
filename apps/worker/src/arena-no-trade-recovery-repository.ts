import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import type { BuiltArenaValuation } from "./arena-valuation.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

export type ArenaNoTradeRecoveryStatus =
  | "REQUESTED"
  | "CLAIMED"
  | "SUCCEEDED"
  | "FAILED";

export type ArenaNoTradeReason =
  | "DECISION_UNAVAILABLE"
  | "S1_PLAN_UNAVAILABLE"
  | "S1_CHECKPOINT_UNAVAILABLE"
  | "FINALIZATION_UNAVAILABLE";

export interface ArenaNoTradeRecovery {
  readonly schema: "twofold.arena_no_trade_recovery/v1";
  readonly recoveryId: string;
  readonly roundEntryId: string;
  readonly roundId: string;
  readonly seasonId: string;
  readonly entrantId: string;
  readonly runId: string;
  readonly sourceWorkItemId: string;
  readonly reasonCode: ArenaNoTradeReason;
  readonly scheduledAt: string;
  readonly recordedBy: string;
  readonly status: ArenaNoTradeRecoveryStatus;
  readonly attemptCount: string;
  readonly nextAttemptAt: string;
  readonly claimedBy: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly completedAt: string | null;
  readonly valuationId: string | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean | null;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaNoTradeRecoveryRpcClient {
  rpc(
    functionName:
      | "claim_arena_no_trade_recovery"
      | "commit_arena_no_trade_recovery"
      | "fail_arena_no_trade_recovery",
    arguments_: Readonly<Record<string, unknown>>,
  ): PromiseLike<RpcResult>;
}

export interface ClaimArenaNoTradeRecoveryInput {
  readonly workerId: string;
  readonly leaseSeconds: number;
  readonly now: string;
}

export interface CommitArenaNoTradeRecoveryInput {
  readonly recoveryId: string;
  readonly roundEntryId: string;
  readonly roundId: string;
  readonly seasonId: string;
  readonly entrantId: string;
  readonly runId: string;
  readonly reasonCode: ArenaNoTradeReason;
  readonly leaseToken: string;
  readonly valuation: BuiltArenaValuation;
  readonly completedAt: string;
}

export interface FailArenaNoTradeRecoveryInput {
  readonly recoveryId: string;
  readonly leaseToken: string;
  readonly completedAt: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
}

export async function claimArenaNoTradeRecovery(
  client: ArenaNoTradeRecoveryRpcClient,
  input: ClaimArenaNoTradeRecoveryInput,
): Promise<ArenaNoTradeRecovery | null> {
  const workerId = identity(input.workerId, "workerId");
  if (
    !Number.isInteger(input.leaseSeconds)
    || input.leaseSeconds < 5
    || input.leaseSeconds > 3_600
  ) {
    throw new TypeError("leaseSeconds must be an integer between 5 and 3600");
  }
  const now = timestamp(input.now, "now");
  const response = await client.rpc("claim_arena_no_trade_recovery", {
    p_worker_id: workerId,
    p_lease_seconds: input.leaseSeconds,
    p_now: now,
  });
  if (response.error !== null) {
    throw rpcError("claim_arena_no_trade_recovery", response);
  }
  const raw = singleResult(response.data);
  if (raw === null) return null;
  const recovery = parseRecovery(raw);
  if (
    recovery.status !== "CLAIMED"
    || recovery.claimedBy !== workerId
    || recovery.leaseToken === null
    || recovery.leaseExpiresAt === null
    || Date.parse(recovery.leaseExpiresAt) <= Date.parse(now)
  ) {
    throw new TypeError("claim_arena_no_trade_recovery returned an inconsistent lease");
  }
  return recovery;
}

/** Exact retry is safe because Postgres fingerprints the full completion. */
export async function commitArenaNoTradeRecoveryExact(
  client: ArenaNoTradeRecoveryRpcClient,
  input: CommitArenaNoTradeRecoveryInput,
): Promise<ArenaNoTradeRecovery> {
  uuid(input.recoveryId, "recoveryId");
  uuid(input.roundEntryId, "roundEntryId");
  uuid(input.roundId, "roundId");
  uuid(input.seasonId, "seasonId");
  uuid(input.entrantId, "entrantId");
  uuid(input.runId, "runId");
  reason(input.reasonCode);
  uuid(input.leaseToken, "leaseToken");
  timestamp(input.completedAt, "completedAt");
  validateValuation(input.valuation);

  const arguments_ = Object.freeze({
    p_recovery_id: input.recoveryId,
    p_lease_token: input.leaseToken,
    p_valuation_canonical_json: input.valuation.canonicalJson,
    p_completed_at: input.completedAt,
  });
  const response = await retryExactRpcOnce(() => client.rpc(
    "commit_arena_no_trade_recovery",
    arguments_,
  ));
  if (response.error !== null) {
    throw rpcError("commit_arena_no_trade_recovery", response);
  }
  const recovery = parseRecovery(singleResult(response.data));
  if (
    recovery.recoveryId !== input.recoveryId
    || recovery.roundEntryId !== input.roundEntryId
    || recovery.roundId !== input.roundId
    || recovery.seasonId !== input.seasonId
    || recovery.entrantId !== input.entrantId
    || recovery.runId !== input.runId
    || recovery.reasonCode !== input.reasonCode
    || recovery.status !== "SUCCEEDED"
    || recovery.valuationId === null
    || recovery.result === null
  ) {
    throw new TypeError("commit_arena_no_trade_recovery returned inconsistent identity");
  }
  const result = parseCommitResult(recovery.result);
  if (
    result.reasonCode !== input.reasonCode
    || result.valuationId !== recovery.valuationId
    || result.ledgerSequence !== input.valuation.payload.ledgerSequence
    || result.ledgerSha256 !== input.valuation.payload.ledgerSha256
  ) {
    throw new TypeError("commit_arena_no_trade_recovery returned inconsistent valuation");
  }
  return recovery;
}

export async function failArenaNoTradeRecovery(
  client: ArenaNoTradeRecoveryRpcClient,
  input: FailArenaNoTradeRecoveryInput,
): Promise<ArenaNoTradeRecovery> {
  uuid(input.recoveryId, "recoveryId");
  uuid(input.leaseToken, "leaseToken");
  timestamp(input.completedAt, "completedAt");
  identity(input.errorCode, "errorCode");
  identity(input.errorMessage, "errorMessage");
  const response = await client.rpc("fail_arena_no_trade_recovery", {
    p_recovery_id: input.recoveryId,
    p_lease_token: input.leaseToken,
    p_completed_at: input.completedAt,
    p_error_code: input.errorCode,
    p_error_message: input.errorMessage,
    p_retryable: input.retryable,
  });
  if (response.error !== null) {
    throw rpcError("fail_arena_no_trade_recovery", response);
  }
  const recovery = parseRecovery(singleResult(response.data));
  if (
    recovery.recoveryId !== input.recoveryId
    || (recovery.status !== "REQUESTED" && recovery.status !== "FAILED")
  ) {
    throw new TypeError("fail_arena_no_trade_recovery returned inconsistent identity");
  }
  return recovery;
}

export class SupabaseArenaNoTradeRecoveryQueue {
  readonly #client: ArenaNoTradeRecoveryRpcClient;

  constructor(url: string, secretKey: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    }) as unknown as ArenaNoTradeRecoveryRpcClient;
  }

  claim(input: ClaimArenaNoTradeRecoveryInput) {
    return claimArenaNoTradeRecovery(this.#client, input);
  }

  commit(input: CommitArenaNoTradeRecoveryInput) {
    return commitArenaNoTradeRecoveryExact(this.#client, input);
  }

  fail(input: FailArenaNoTradeRecoveryInput) {
    return failArenaNoTradeRecovery(this.#client, input);
  }
}

function parseRecovery(value: unknown): ArenaNoTradeRecovery {
  assertNoJsonNumber(value, "Arena no-trade recovery result");
  const row = exactRecord(value, [
    "schema", "recoveryId", "roundEntryId", "roundId", "seasonId",
    "entrantId", "runId", "sourceWorkItemId", "reasonCode", "scheduledAt",
    "recordedBy", "status", "attemptCount", "nextAttemptAt", "claimedBy",
    "leaseToken", "leaseExpiresAt", "completedAt", "valuationId", "result",
    "errorCode", "errorMessage", "retryable",
  ], "Arena no-trade recovery result");
  if (row.schema !== "twofold.arena_no_trade_recovery/v1") {
    throw new TypeError("unsupported Arena no-trade recovery schema");
  }
  const status = recoveryStatus(row.status);
  const parsed = Object.freeze({
    schema: "twofold.arena_no_trade_recovery/v1" as const,
    recoveryId: uuid(row.recoveryId, "recoveryId"),
    roundEntryId: uuid(row.roundEntryId, "roundEntryId"),
    roundId: uuid(row.roundId, "roundId"),
    seasonId: uuid(row.seasonId, "seasonId"),
    entrantId: uuid(row.entrantId, "entrantId"),
    runId: uuid(row.runId, "runId"),
    sourceWorkItemId: uuid(row.sourceWorkItemId, "sourceWorkItemId"),
    reasonCode: reason(row.reasonCode),
    scheduledAt: timestamp(row.scheduledAt, "scheduledAt"),
    recordedBy: identity(row.recordedBy, "recordedBy"),
    status,
    attemptCount: integer(row.attemptCount, "attemptCount"),
    nextAttemptAt: timestamp(row.nextAttemptAt, "nextAttemptAt"),
    claimedBy: nullableIdentity(row.claimedBy, "claimedBy"),
    leaseToken: nullableUuid(row.leaseToken, "leaseToken"),
    leaseExpiresAt: nullableTimestamp(row.leaseExpiresAt, "leaseExpiresAt"),
    completedAt: nullableTimestamp(row.completedAt, "completedAt"),
    valuationId: nullableUuid(row.valuationId, "valuationId"),
    result: nullableObject(row.result, "result"),
    errorCode: nullableIdentity(row.errorCode, "errorCode"),
    errorMessage: nullableIdentity(row.errorMessage, "errorMessage"),
    retryable: nullableBoolean(row.retryable, "retryable"),
  }) satisfies ArenaNoTradeRecovery;
  const claimed = status === "CLAIMED";
  const terminal = status === "SUCCEEDED" || status === "FAILED";
  if (
    claimed !== (parsed.claimedBy !== null)
    || claimed !== (parsed.leaseToken !== null)
    || claimed !== (parsed.leaseExpiresAt !== null)
    || terminal !== (parsed.completedAt !== null)
    || (status === "SUCCEEDED"
      && (parsed.valuationId === null || parsed.result === null))
  ) {
    throw new TypeError("Arena no-trade recovery has an inconsistent lease shape");
  }
  return parsed;
}

function parseCommitResult(value: Readonly<Record<string, unknown>>) {
  const row = exactRecord(value, [
    "outcome", "reasonCode", "valuationId", "ledgerSequence", "ledgerSha256",
  ], "Arena no-trade recovery commit result");
  if (
    row.outcome !== "NO_TRADE_CARRY_FORWARD"
    && row.outcome !== "EXISTING_S2_VALUATION"
  ) {
    throw new TypeError("unsupported Arena no-trade recovery outcome");
  }
  return Object.freeze({
    outcome: row.outcome,
    reasonCode: reason(row.reasonCode),
    valuationId: uuid(row.valuationId, "result.valuationId"),
    ledgerSequence: integer(row.ledgerSequence, "result.ledgerSequence"),
    ledgerSha256: sha256(row.ledgerSha256, "result.ledgerSha256"),
  });
}

function validateValuation(value: BuiltArenaValuation): void {
  if (
    value.stage !== "S2_CLOSE"
    || uuid(value.snapshotId, "valuation.snapshotId") !== value.snapshotId
    || identity(value.canonicalJson, "valuation.canonicalJson")
      !== JSON.stringify(value.payload)
    || sha256(value.sha256, "valuation.sha256")
      !== createHash("sha256").update(value.canonicalJson, "utf8").digest("hex")
  ) {
    throw new TypeError("no-trade valuation bytes are inconsistent");
  }
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
    || keys.some((key) => !Object.hasOwn(row, key))
    || Object.keys(row).some((key) => !expected.has(key))
  ) {
    throw new TypeError(`${field} has an unexpected shape`);
  }
  return row;
}

function singleResult(value: unknown): unknown | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length !== 1) throw new TypeError("RPC returned more than one row");
    return value[0];
  }
  return value;
}

function rpcError(operation: string, result: RpcResultLike): Error {
  return new Error(`${operation} failed: ${result.error?.message ?? "unknown RPC error"}`);
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be SHA-256`);
  return parsed;
}

function integer(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!INTEGER_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
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

function reason(value: unknown): ArenaNoTradeReason {
  if (
    value !== "DECISION_UNAVAILABLE"
    && value !== "S1_PLAN_UNAVAILABLE"
    && value !== "S1_CHECKPOINT_UNAVAILABLE"
    && value !== "FINALIZATION_UNAVAILABLE"
  ) throw new TypeError("unsupported Arena no-trade reason");
  return value;
}

function recoveryStatus(value: unknown): ArenaNoTradeRecoveryStatus {
  if (
    value !== "REQUESTED" && value !== "CLAIMED"
    && value !== "SUCCEEDED" && value !== "FAILED"
  ) throw new TypeError("unsupported Arena no-trade recovery status");
  return value;
}

function nullableIdentity(value: unknown, field: string): string | null {
  return value === null ? null : identity(value, field);
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value === null || typeof value === "boolean") return value;
  throw new TypeError(`${field} must be boolean or null`);
}

function nullableObject(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object or null`);
  }
  return deepFreeze(structuredClone(value as Record<string, unknown>));
}

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") throw new TypeError(`${field} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoJsonNumber(item, field));
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => assertNoJsonNumber(item, field));
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
