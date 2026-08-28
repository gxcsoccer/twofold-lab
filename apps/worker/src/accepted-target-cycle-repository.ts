import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

export const ACCEPTED_TARGET_CYCLE_COMMIT_RESULT_SCHEMA =
  "twofold.accepted_target_cycle_commit_result/v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

export interface CommitAcceptedTargetCycleRpcArguments {
  readonly p_idempotency_key: string;
  readonly p_cycle_id: string;
  readonly p_strategy_account_id: string;
  readonly p_run_id: string;
  readonly p_decision_id: string;
  readonly p_accepted_submission_id: string;
  readonly p_s1_frozen_order_plan_id: string;
  readonly p_s2_frozen_order_plan_id: string;
  readonly p_cycle_canonical_json: string;
  readonly p_cycle_sha256: string;
  readonly p_completed_at: string;
  readonly p_expected_run_stream_seq: string;
  readonly p_expected_projection_stream_seq: string;
  readonly p_event_id: string;
  readonly p_recorded_by: string;
}

export interface AcceptedTargetCycleCommitResult {
  readonly schema: typeof ACCEPTED_TARGET_CYCLE_COMMIT_RESULT_SCHEMA;
  readonly cycleId: string;
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly decisionId: string;
  readonly acceptedSubmissionId: string;
  readonly s1FrozenOrderPlanId: string;
  readonly s2FrozenOrderPlanId: string;
  readonly cycleSha256: string;
  readonly sourceEventId: string;
  readonly sourceStreamSeq: string;
  readonly projectionName: "dashboard.accepted_target_cycle";
  readonly recordedBy: string;
  readonly recordedAt: string;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface AcceptedTargetCycleCommitRpcClient {
  rpc(
    functionName: "commit_accepted_target_cycle",
    arguments_: CommitAcceptedTargetCycleRpcArguments,
  ): PromiseLike<RpcResult>;
}

export async function commitAcceptedTargetCycleExact(
  client: AcceptedTargetCycleCommitRpcClient,
  arguments_: CommitAcceptedTargetCycleRpcArguments,
): Promise<AcceptedTargetCycleCommitResult> {
  validateArguments(arguments_);
  const result = await retryExactRpcOnce(() => client.rpc(
    "commit_accepted_target_cycle",
    arguments_,
  ));
  if (result.error !== null) {
    throw new Error(
      `commit_accepted_target_cycle failed: ${result.error?.message ?? "unknown RPC error"}`,
    );
  }

  const value = singleResult(result.data);
  assertNoJsonNumber(value, "commit_accepted_target_cycle result");
  const record = exactRecord(value, [
    "schema",
    "cycleId",
    "strategyAccountId",
    "runId",
    "decisionId",
    "acceptedSubmissionId",
    "s1FrozenOrderPlanId",
    "s2FrozenOrderPlanId",
    "cycleSha256",
    "sourceEventId",
    "sourceStreamSeq",
    "projectionName",
    "recordedBy",
    "recordedAt",
  ]);
  const parsed = Object.freeze({
    schema: literal(
      record.schema,
      ACCEPTED_TARGET_CYCLE_COMMIT_RESULT_SCHEMA,
      "schema",
    ),
    cycleId: uuid(record.cycleId, "cycleId"),
    strategyAccountId: uuid(record.strategyAccountId, "strategyAccountId"),
    runId: uuid(record.runId, "runId"),
    decisionId: uuid(record.decisionId, "decisionId"),
    acceptedSubmissionId: uuid(record.acceptedSubmissionId, "acceptedSubmissionId"),
    s1FrozenOrderPlanId: uuid(record.s1FrozenOrderPlanId, "s1FrozenOrderPlanId"),
    s2FrozenOrderPlanId: uuid(record.s2FrozenOrderPlanId, "s2FrozenOrderPlanId"),
    cycleSha256: sha256(record.cycleSha256, "cycleSha256"),
    sourceEventId: uuid(record.sourceEventId, "sourceEventId"),
    sourceStreamSeq: integer(record.sourceStreamSeq, "sourceStreamSeq"),
    projectionName: literal(
      record.projectionName,
      "dashboard.accepted_target_cycle",
      "projectionName",
    ),
    recordedBy: identity(record.recordedBy, "recordedBy"),
    recordedAt: timestamp(record.recordedAt, "recordedAt"),
  }) satisfies AcceptedTargetCycleCommitResult;

  if (
    parsed.cycleId !== arguments_.p_cycle_id
    || parsed.strategyAccountId !== arguments_.p_strategy_account_id
    || parsed.runId !== arguments_.p_run_id
    || parsed.decisionId !== arguments_.p_decision_id
    || parsed.acceptedSubmissionId !== arguments_.p_accepted_submission_id
    || parsed.s1FrozenOrderPlanId !== arguments_.p_s1_frozen_order_plan_id
    || parsed.s2FrozenOrderPlanId !== arguments_.p_s2_frozen_order_plan_id
    || parsed.cycleSha256 !== arguments_.p_cycle_sha256
    || parsed.sourceEventId !== arguments_.p_event_id
    || parsed.sourceStreamSeq
      !== (BigInt(arguments_.p_expected_run_stream_seq) + 1n).toString()
    || parsed.recordedBy !== arguments_.p_recorded_by
  ) {
    throw new TypeError(
      "commit_accepted_target_cycle returned a result inconsistent with the exact request",
    );
  }
  return parsed;
}

function validateArguments(value: CommitAcceptedTargetCycleRpcArguments): void {
  identity(value.p_idempotency_key, "p_idempotency_key");
  for (const field of [
    "p_cycle_id",
    "p_strategy_account_id",
    "p_run_id",
    "p_decision_id",
    "p_accepted_submission_id",
    "p_s1_frozen_order_plan_id",
    "p_s2_frozen_order_plan_id",
    "p_event_id",
  ] as const) uuid(value[field], field);
  sha256(value.p_cycle_sha256, "p_cycle_sha256");
  timestamp(value.p_completed_at, "p_completed_at");
  integer(value.p_expected_run_stream_seq, "p_expected_run_stream_seq");
  integer(
    value.p_expected_projection_stream_seq,
    "p_expected_projection_stream_seq",
  );
  identity(value.p_recorded_by, "p_recorded_by");
  if (value.p_cycle_canonical_json.trim() !== value.p_cycle_canonical_json) {
    throw new TypeError("p_cycle_canonical_json must be trimmed canonical JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.p_cycle_canonical_json);
  } catch {
    throw new TypeError("p_cycle_canonical_json must be valid JSON");
  }
  assertNoJsonNumber(parsed, "p_cycle_canonical_json");
}

function singleResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new TypeError("RPC must return exactly one result");
    return value[0];
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("commit_accepted_target_cycle result must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (
    Object.keys(record).length !== keys.length
    || keys.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !expected.has(key))
  ) {
    throw new TypeError("commit_accepted_target_cycle result has an unexpected shape");
  }
  return record;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a UUID in canonical lowercase form`);
  }
  return parsed;
}

function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256`);
  return parsed;
}

function integer(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || new Date(parsed).toISOString() !== parsed
  ) {
    throw new TypeError(`${field} must be a canonical ISO UTC timestamp`);
  }
  return parsed;
}

function literal<const T extends string>(
  value: unknown,
  expected: T,
  field: string,
): T {
  if (value !== expected) throw new TypeError(`${field} must equal ${expected}`);
  return expected;
}

function assertNoJsonNumber(value: unknown, path: string): void {
  if (typeof value === "number") throw new TypeError(`${path} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumber(item, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertNoJsonNumber(item, `${path}.${key}`);
    }
  }
}
