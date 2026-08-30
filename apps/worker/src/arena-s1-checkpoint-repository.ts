import { createHash } from "node:crypto";

import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";
import type { FrozenOrderPlanRegistration } from "./order-plan-registration.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaS1CheckpointRpcClient {
  rpc(
    functionName:
      | "register_arena_s1_checkpoint"
      | "register_arena_s1_checkpoint_v2",
    arguments_: Readonly<Record<string, unknown>>,
  ): PromiseLike<RpcResult>;
}

export interface ArenaS1CheckpointStageResult {
  readonly schema: "twofold.arena_cycle_stage_result/v1";
  readonly stageResultId: string;
  readonly roundEntryId: string;
  readonly phase: "SETTLE_S1_AND_PREPARE_S2";
  readonly strategyAccountId: string;
  readonly acceptedSubmissionId: string;
  readonly openingHeadSequence: string;
  readonly openingHeadSha256: string;
  readonly s1FrozenOrderPlanId: string;
  readonly s2FrozenOrderPlanId: string;
  readonly artifactSchema: "twofold.accepted_target_cycle_s1_checkpoint/v1";
  readonly artifactSha256: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export async function registerArenaS1CheckpointExact(
  client: ArenaS1CheckpointRpcClient,
  input: {
    readonly idempotencyKey: string;
    readonly roundEntryId: string;
    readonly expectedHeadSequence: string;
    readonly expectedHeadSha256: string;
    readonly registration: FrozenOrderPlanRegistration;
    readonly checkpointCanonicalJson: string;
    readonly checkpointSha256: string;
    readonly recordedBy: string;
  },
): Promise<ArenaS1CheckpointStageResult> {
  identity(input.idempotencyKey, "idempotencyKey");
  uuid(input.roundEntryId, "roundEntryId");
  integer(input.expectedHeadSequence, "expectedHeadSequence");
  sha256(input.expectedHeadSha256, "expectedHeadSha256");
  identity(input.recordedBy, "recordedBy");
  sha256(input.checkpointSha256, "checkpointSha256");
  if (
    input.registration.rpcArguments.p_stage !== "S2"
    || input.registration.rpcArguments.p_recorded_by !== input.recordedBy
    || createHash("sha256")
      .update(input.checkpointCanonicalJson, "utf8")
      .digest("hex") !== input.checkpointSha256
  ) throw new TypeError("Arena S1 checkpoint/S2 registration bytes are inconsistent");

  const arguments_ = Object.freeze({
    p_idempotency_key: input.idempotencyKey,
    p_round_entry_id: input.roundEntryId,
    p_expected_head_sequence: input.expectedHeadSequence,
    p_expected_head_sha256: input.expectedHeadSha256,
    p_s2_plan_canonical_json: input.registration.planCanonicalJson,
    p_s2_plan_sha256: input.registration.planSha256,
    p_checkpoint_canonical_json: input.checkpointCanonicalJson,
    p_checkpoint_sha256: input.checkpointSha256,
    p_recorded_by: input.recordedBy,
  });
  const functionName = volumeParticipationRpc(
    input.registration.planCanonicalJson,
  ) ? "register_arena_s1_checkpoint_v2" : "register_arena_s1_checkpoint";
  const response = await retryExactRpcOnce(() => client.rpc(
    functionName,
    arguments_,
  ));
  if (response.error !== null) {
    throw new Error(
      `register_arena_s1_checkpoint failed: ${response.error.message}`,
    );
  }
  assertNoJsonNumber(response.data, "register_arena_s1_checkpoint result");
  const row = exactRecord(response.data, [
    "schema", "stageResultId", "roundEntryId", "phase",
    "strategyAccountId", "acceptedSubmissionId", "openingHeadSequence",
    "openingHeadSha256", "s1FrozenOrderPlanId", "s2FrozenOrderPlanId",
    "artifactSchema", "artifactSha256", "recordedBy", "recordedAt",
  ]);
  if (
    row.schema !== "twofold.arena_cycle_stage_result/v1"
    || row.phase !== "SETTLE_S1_AND_PREPARE_S2"
    || row.artifactSchema
      !== "twofold.accepted_target_cycle_s1_checkpoint/v1"
  ) throw new TypeError("register_arena_s1_checkpoint returned an unsupported shape");
  const result: ArenaS1CheckpointStageResult = {
    schema: "twofold.arena_cycle_stage_result/v1",
    stageResultId: uuid(row.stageResultId, "stageResultId"),
    roundEntryId: uuid(row.roundEntryId, "result.roundEntryId"),
    phase: "SETTLE_S1_AND_PREPARE_S2",
    strategyAccountId: uuid(row.strategyAccountId, "strategyAccountId"),
    acceptedSubmissionId: uuid(
      row.acceptedSubmissionId,
      "acceptedSubmissionId",
    ),
    openingHeadSequence: integer(
      row.openingHeadSequence,
      "openingHeadSequence",
    ),
    openingHeadSha256: sha256(row.openingHeadSha256, "openingHeadSha256"),
    s1FrozenOrderPlanId: uuid(
      row.s1FrozenOrderPlanId,
      "s1FrozenOrderPlanId",
    ),
    s2FrozenOrderPlanId: uuid(
      row.s2FrozenOrderPlanId,
      "s2FrozenOrderPlanId",
    ),
    artifactSchema: "twofold.accepted_target_cycle_s1_checkpoint/v1",
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
    || result.artifactSha256 !== input.checkpointSha256
    || result.recordedBy !== input.recordedBy
  ) throw new TypeError(
    "register_arena_s1_checkpoint returned an inconsistent identity",
  );
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
    throw new TypeError("register_arena_s1_checkpoint returned no object");
  }
  const row = value as Record<string, unknown>;
  const expected = [...keys].sort();
  const actual = Object.keys(row).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new TypeError(
    "register_arena_s1_checkpoint returned unexpected fields",
  );
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
