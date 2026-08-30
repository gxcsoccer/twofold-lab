import { createHash } from "node:crypto";

import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";
import type { FrozenOrderPlanRegistration } from "./order-plan-registration.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaS1PlanRpcClient {
  rpc(
    functionName: "register_arena_s1_plan" | "register_arena_s1_plan_v2",
    arguments_: Readonly<Record<string, unknown>>,
  ): PromiseLike<RpcResult>;
}

export interface ArenaS1PlanStageResult {
  readonly schema: "twofold.arena_cycle_stage_result/v1";
  readonly stageResultId: string;
  readonly roundEntryId: string;
  readonly phase: "PREPARE_S1_ORDERS";
  readonly strategyAccountId: string;
  readonly acceptedSubmissionId: string;
  readonly openingHeadSequence: string;
  readonly openingHeadSha256: string;
  readonly s1FrozenOrderPlanId: string;
  readonly s2FrozenOrderPlanId: null;
  readonly artifactSchema: "twofold.accepted_target_cycle_s1_plan/v1";
  readonly artifactSha256: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export async function registerArenaS1PlanExact(
  client: ArenaS1PlanRpcClient,
  input: {
    readonly idempotencyKey: string;
    readonly roundEntryId: string;
    readonly expectedHeadSequence: string;
    readonly expectedHeadSha256: string;
    readonly registration: FrozenOrderPlanRegistration;
    readonly resultCanonicalJson: string;
    readonly resultSha256: string;
    readonly recordedBy: string;
  },
): Promise<ArenaS1PlanStageResult> {
  identity(input.idempotencyKey, "idempotencyKey");
  uuid(input.roundEntryId, "roundEntryId");
  integer(input.expectedHeadSequence, "expectedHeadSequence");
  sha256(input.expectedHeadSha256, "expectedHeadSha256");
  identity(input.recordedBy, "recordedBy");
  sha256(input.resultSha256, "resultSha256");
  if (
    input.registration.rpcArguments.p_stage !== "S1"
    || input.registration.rpcArguments.p_recorded_by !== input.recordedBy
    || createHash("sha256").update(input.resultCanonicalJson, "utf8").digest("hex")
      !== input.resultSha256
  ) throw new TypeError("Arena S1 registration/result bytes are inconsistent");

  const arguments_ = Object.freeze({
    p_idempotency_key: input.idempotencyKey,
    p_round_entry_id: input.roundEntryId,
    p_expected_head_sequence: input.expectedHeadSequence,
    p_expected_head_sha256: input.expectedHeadSha256,
    p_plan_canonical_json: input.registration.planCanonicalJson,
    p_plan_sha256: input.registration.planSha256,
    p_result_canonical_json: input.resultCanonicalJson,
    p_result_sha256: input.resultSha256,
    p_recorded_by: input.recordedBy,
  });
  const functionName = volumeParticipationRpc(
    input.registration.planCanonicalJson,
  ) ? "register_arena_s1_plan_v2" : "register_arena_s1_plan";
  const response = await retryExactRpcOnce(() => client.rpc(
    functionName,
    arguments_,
  ));
  if (response.error !== null) {
    throw new Error(`register_arena_s1_plan failed: ${response.error.message}`);
  }
  assertNoJsonNumber(response.data, "register_arena_s1_plan result");
  const row = exactRecord(response.data, [
    "schema", "stageResultId", "roundEntryId", "phase",
    "strategyAccountId", "acceptedSubmissionId", "openingHeadSequence",
    "openingHeadSha256", "s1FrozenOrderPlanId", "s2FrozenOrderPlanId",
    "artifactSchema", "artifactSha256", "recordedBy", "recordedAt",
  ]);
  if (
    row.schema !== "twofold.arena_cycle_stage_result/v1"
    || row.phase !== "PREPARE_S1_ORDERS"
    || row.s2FrozenOrderPlanId !== null
    || row.artifactSchema !== "twofold.accepted_target_cycle_s1_plan/v1"
  ) throw new TypeError("register_arena_s1_plan returned an unsupported shape");
  const result: ArenaS1PlanStageResult = {
    schema: "twofold.arena_cycle_stage_result/v1",
    stageResultId: uuid(row.stageResultId, "stageResultId"),
    roundEntryId: uuid(row.roundEntryId, "result.roundEntryId"),
    phase: "PREPARE_S1_ORDERS",
    strategyAccountId: uuid(row.strategyAccountId, "strategyAccountId"),
    acceptedSubmissionId: uuid(
      row.acceptedSubmissionId,
      "acceptedSubmissionId",
    ),
    openingHeadSequence: integer(
      row.openingHeadSequence,
      "openingHeadSequence",
    ),
    openingHeadSha256: sha256(
      row.openingHeadSha256,
      "openingHeadSha256",
    ),
    s1FrozenOrderPlanId: uuid(
      row.s1FrozenOrderPlanId,
      "s1FrozenOrderPlanId",
    ),
    s2FrozenOrderPlanId: null,
    artifactSchema: "twofold.accepted_target_cycle_s1_plan/v1",
    artifactSha256: sha256(row.artifactSha256, "artifactSha256"),
    recordedBy: identity(row.recordedBy, "result.recordedBy"),
    recordedAt: timestamp(row.recordedAt, "recordedAt"),
  };
  if (
    result.roundEntryId !== input.roundEntryId
    || result.openingHeadSequence !== input.expectedHeadSequence
    || result.openingHeadSha256 !== input.expectedHeadSha256
    || result.strategyAccountId
      !== input.registration.rpcArguments.p_strategy_account_id
    || result.acceptedSubmissionId
      !== input.registration.rpcArguments.p_accepted_submission_id
    || result.artifactSha256 !== input.resultSha256
    || result.recordedBy !== input.recordedBy
  ) throw new TypeError("register_arena_s1_plan returned an inconsistent identity");
  return deepFreeze(result);
}

function volumeParticipationRpc(canonicalJson: string): boolean {
  const value: unknown = JSON.parse(canonicalJson);
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).executionModel
      === "SIMULATED_MINUTE_PARTICIPATION";
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("register_arena_s1_plan returned no object");
  }
  const row = value as Record<string, unknown>;
  const expected = [...keys].sort();
  const actual = Object.keys(row).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new TypeError("register_arena_s1_plan returned unexpected fields");
  return row;
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

function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be SHA-256`);
  return parsed;
}

function integer(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^(0|[1-9]\d*)$/.test(parsed)) {
    throw new TypeError(`${field} must be a canonical integer`);
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

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") throw new TypeError(`${field} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumber(item, `${field}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertNoJsonNumber(item, `${field}.${key}`);
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
