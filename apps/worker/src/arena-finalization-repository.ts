import { createHash } from "node:crypto";

import type { AcceptedTargetCycleResult } from "@twofold/core";

import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";
import type { BuiltArenaValuation } from "./arena-valuation.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaFinalizationRpcClient {
  rpc(
    functionName: "get_arena_leaderboard" | "finalize_arena_accepted_target_cycle",
    arguments_: Readonly<Record<string, unknown>>,
  ): PromiseLike<RpcResult>;
}

export async function loadArenaScoreBase(
  client: ArenaFinalizationRpcClient,
  input: { readonly seasonId: string; readonly entrantId: string },
): Promise<string> {
  uuid(input.seasonId, "seasonId");
  uuid(input.entrantId, "entrantId");
  const response = await retryExactRpcOnce(() => client.rpc(
    "get_arena_leaderboard",
    { p_season_id: input.seasonId },
  ));
  if (response.error !== null) {
    throw new Error(`get_arena_leaderboard failed: ${response.error.message}`);
  }
  assertNoJsonNumber(response.data, "Arena leaderboard");
  if (!Array.isArray(response.data)) {
    throw new TypeError("Arena leaderboard returned no array");
  }
  const matching = response.data.filter((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    return (candidate as Record<string, unknown>).entrantId === input.entrantId;
  });
  if (matching.length !== 1) {
    throw new TypeError("Arena leaderboard has no unique entrant score base");
  }
  const row = matching[0] as Record<string, unknown>;
  if (row.schema !== "twofold.arena_leaderboard_entry/v1") {
    throw new TypeError("unsupported Arena leaderboard schema");
  }
  return positiveDecimal(row.scoreBaseLiquidationNav, "scoreBaseLiquidationNav");
}

export interface ArenaFinalizationResult {
  readonly cycleId: string;
  readonly valuationId: string;
  readonly sourceStreamSeq: string;
}

export async function finalizeArenaCycleExact(
  client: ArenaFinalizationRpcClient,
  input: {
    readonly idempotencyKey: string;
    readonly roundEntryId: string;
    readonly cycle: AcceptedTargetCycleResult;
    readonly cycleId: string;
    readonly eventId: string;
    readonly completedAt: string;
    readonly valuation: BuiltArenaValuation;
    readonly expected: {
      readonly strategyAccountId: string;
      readonly runId: string;
      readonly seasonId: string;
      readonly entrantId: string;
    };
    readonly recordedBy: string;
  },
): Promise<ArenaFinalizationResult> {
  identity(input.idempotencyKey, "idempotencyKey");
  uuid(input.roundEntryId, "roundEntryId");
  uuid(input.cycleId, "cycleId");
  uuid(input.eventId, "eventId");
  timestamp(input.completedAt, "completedAt");
  identity(input.recordedBy, "recordedBy");
  Object.entries(input.expected).forEach(([field, value]) => uuid(value, field));
  if (
    sha256Utf8(input.cycle.canonicalJson) !== input.cycle.contentSha256
    || sha256Utf8(input.valuation.canonicalJson) !== input.valuation.sha256
    || input.valuation.stage !== "S2_CLOSE"
  ) throw new TypeError("Arena final cycle or valuation bytes are inconsistent");

  const arguments_ = Object.freeze({
    p_idempotency_key: input.idempotencyKey,
    p_round_entry_id: input.roundEntryId,
    p_cycle_id: input.cycleId,
    p_cycle_canonical_json: input.cycle.canonicalJson,
    p_cycle_sha256: input.cycle.contentSha256,
    p_completed_at: input.completedAt,
    p_event_id: input.eventId,
    p_valuation_canonical_json: input.valuation.canonicalJson,
    p_recorded_by: input.recordedBy,
  });
  const response = await retryExactRpcOnce(() => client.rpc(
    "finalize_arena_accepted_target_cycle",
    arguments_,
  ));
  if (response.error !== null) {
    throw new Error(
      `finalize_arena_accepted_target_cycle failed: ${response.error.message}`,
    );
  }
  assertNoJsonNumber(response.data, "Arena finalization result");
  const envelope = exactRecord(response.data, ["schema", "cycle", "valuation"]);
  if (envelope.schema !== "twofold.arena_cycle_finalization_result/v1") {
    throw new TypeError("unsupported Arena finalization schema");
  }
  const cycle = exactRecord(envelope.cycle, [
    "schema", "cycleId", "strategyAccountId", "runId", "decisionId",
    "acceptedSubmissionId", "s1FrozenOrderPlanId", "s2FrozenOrderPlanId",
    "cycleSha256", "sourceEventId", "sourceStreamSeq", "projectionName",
    "recordedBy", "recordedAt",
  ]);
  const valuation = exactRecord(envelope.valuation, [
    "schema", "valuationId", "roundEntryId", "roundId", "seasonId",
    "entrantId", "runId", "stage", "snapshotId", "valuationAt",
    "valuationDate", "ledgerSequence", "ledgerSha256", "brokerNav",
    "taxReservedNav", "liquidationNav", "scoreBaseLiquidationNav",
    "valuationSha256", "recordedBy", "recordedAt",
  ]);
  if (
    cycle.schema !== "twofold.accepted_target_cycle_commit_result/v1"
    || cycle.cycleId !== input.cycleId
    || cycle.strategyAccountId !== input.expected.strategyAccountId
    || cycle.runId !== input.expected.runId
    || cycle.decisionId !== input.cycle.decisionId
    || cycle.acceptedSubmissionId !== input.cycle.submissionId
    || cycle.cycleSha256 !== input.cycle.contentSha256
    || cycle.sourceEventId !== input.eventId
    || cycle.recordedBy !== input.recordedBy
    || valuation.schema !== "twofold.arena_valuation_result/v1"
    || valuation.roundEntryId !== input.roundEntryId
    || valuation.seasonId !== input.expected.seasonId
    || valuation.entrantId !== input.expected.entrantId
    || valuation.runId !== input.expected.runId
    || valuation.stage !== "S2_CLOSE"
    || valuation.snapshotId !== input.valuation.snapshotId
    || valuation.valuationSha256 !== input.valuation.sha256
    || valuation.recordedBy !== input.recordedBy
  ) throw new TypeError("Arena finalization returned an inconsistent identity");
  return Object.freeze({
    cycleId: uuid(cycle.cycleId, "result.cycleId"),
    valuationId: uuid(valuation.valuationId, "result.valuationId"),
    sourceStreamSeq: integer(cycle.sourceStreamSeq, "result.sourceStreamSeq"),
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Arena finalization result must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = [...keys].sort();
  const actual = Object.keys(record).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new TypeError("Arena finalization result has unexpected fields");
  return record;
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

function integer(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^(0|[1-9]\d*)$/.test(parsed)) {
    throw new TypeError(`${field} must be a canonical integer`);
  }
  return parsed;
}

function positiveDecimal(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(parsed) || Number(parsed) <= 0) {
    throw new TypeError(`${field} must be a canonical positive decimal`);
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

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") throw new TypeError(`${field} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumber(item, `${field}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      assertNoJsonNumber(item, `${field}.${key}`));
  }
}
