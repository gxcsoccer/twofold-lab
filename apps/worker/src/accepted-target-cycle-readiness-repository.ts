import type { RpcResultLike } from "./exact-rpc.js";

export const ACCEPTED_TARGET_CYCLE_READINESS_SCHEMA =
  "twofold.accepted_target_cycle_readiness/v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type AcceptedTargetCycleReadinessStatus =
  | "BLOCKED"
  | "READY_FOR_INPUT_BUILD"
  | "COMPLETED";

export type AcceptedTargetCycleBlocker =
  | "DECISION_NOT_FOUND"
  | "ACCEPTED_SUBMISSION_MISSING"
  | "STRATEGY_ACCOUNT_MISSING"
  | "LEDGER_HEAD_MISSING";

export interface AcceptedTargetCycleReadiness {
  readonly schema: typeof ACCEPTED_TARGET_CYCLE_READINESS_SCHEMA;
  readonly status: AcceptedTargetCycleReadinessStatus;
  readonly decisionId: string;
  readonly runId: string | null;
  readonly acceptedSubmissionId: string | null;
  readonly strategyAccountId: string | null;
  readonly ledgerHeadSha256: string | null;
  readonly cycleId: string | null;
  readonly blockers: readonly AcceptedTargetCycleBlocker[];
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface AcceptedTargetCycleReadinessRpcClient {
  rpc(
    functionName: "get_accepted_target_cycle_readiness",
    arguments_: { readonly p_decision_id: string },
  ): PromiseLike<RpcResult>;
}

export async function getAcceptedTargetCycleReadiness(
  client: AcceptedTargetCycleReadinessRpcClient,
  decisionId: string,
): Promise<AcceptedTargetCycleReadiness> {
  const expectedDecisionId = uuid(decisionId, "decisionId");
  const result = await client.rpc("get_accepted_target_cycle_readiness", {
    p_decision_id: expectedDecisionId,
  });
  if (result.error !== null) {
    throw new Error(
      `get_accepted_target_cycle_readiness failed: ${result.error?.message ?? "unknown RPC error"}`,
    );
  }

  assertNoJsonNumber(result.data, "get_accepted_target_cycle_readiness result");
  const record = exactRecord(result.data, [
    "schema",
    "status",
    "decisionId",
    "runId",
    "acceptedSubmissionId",
    "strategyAccountId",
    "ledgerHeadSha256",
    "cycleId",
    "blockers",
  ]);
  const parsed = Object.freeze({
    schema: literal(
      record.schema,
      ACCEPTED_TARGET_CYCLE_READINESS_SCHEMA,
      "schema",
    ),
    status: readinessStatus(record.status),
    decisionId: uuid(record.decisionId, "decisionId"),
    runId: nullableUuid(record.runId, "runId"),
    acceptedSubmissionId: nullableUuid(
      record.acceptedSubmissionId,
      "acceptedSubmissionId",
    ),
    strategyAccountId: nullableUuid(record.strategyAccountId, "strategyAccountId"),
    ledgerHeadSha256: nullableSha256(record.ledgerHeadSha256, "ledgerHeadSha256"),
    cycleId: nullableUuid(record.cycleId, "cycleId"),
    blockers: blockers(record.blockers),
  }) satisfies AcceptedTargetCycleReadiness;

  if (parsed.decisionId !== expectedDecisionId) {
    throw new TypeError("readiness returned a different decision");
  }
  validateCoherence(parsed);
  return parsed;
}

function validateCoherence(value: AcceptedTargetCycleReadiness): void {
  if (value.status === "READY_FOR_INPUT_BUILD") {
    if (
      value.blockers.length !== 0
      || value.runId === null
      || value.acceptedSubmissionId === null
      || value.strategyAccountId === null
      || value.ledgerHeadSha256 === null
      || value.cycleId !== null
    ) throw new TypeError("ready state contradicts its durable prerequisites");
    return;
  }
  if (value.status === "COMPLETED") {
    if (
      value.blockers.length !== 0
      || value.runId === null
      || value.acceptedSubmissionId === null
      || value.strategyAccountId === null
      || value.cycleId === null
    ) throw new TypeError("completed state contradicts its durable prerequisites");
    return;
  }

  if (value.blockers.length !== 1 || value.cycleId !== null) {
    throw new TypeError("blocked state must expose exactly one causal blocker");
  }
  const blocker = value.blockers[0];
  const coherent = blocker === "DECISION_NOT_FOUND"
    ? value.runId === null
    : blocker === "ACCEPTED_SUBMISSION_MISSING"
      ? value.runId !== null && value.acceptedSubmissionId === null
      : blocker === "STRATEGY_ACCOUNT_MISSING"
        ? value.runId !== null
          && value.acceptedSubmissionId !== null
          && value.strategyAccountId === null
        : value.runId !== null
          && value.acceptedSubmissionId !== null
          && value.strategyAccountId !== null
          && value.ledgerHeadSha256 === null;
  if (!coherent) throw new TypeError("blocked state contradicts its causal blocker");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("readiness result must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (
    Object.keys(record).length !== keys.length
    || keys.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !expected.has(key))
  ) throw new TypeError("readiness result has an unexpected shape");
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
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function nullableSha256(value: unknown, field: string): string | null {
  if (value === null) return null;
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256`);
  return parsed;
}

function literal<const T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new TypeError(`${field} must equal ${expected}`);
  return expected;
}

function readinessStatus(value: unknown): AcceptedTargetCycleReadinessStatus {
  if (
    value !== "BLOCKED"
    && value !== "READY_FOR_INPUT_BUILD"
    && value !== "COMPLETED"
  ) throw new TypeError("status is not a supported readiness state");
  return value;
}

function blockers(value: unknown): readonly AcceptedTargetCycleBlocker[] {
  if (!Array.isArray(value)) throw new TypeError("blockers must be an array");
  const allowed = new Set<AcceptedTargetCycleBlocker>([
    "DECISION_NOT_FOUND",
    "ACCEPTED_SUBMISSION_MISSING",
    "STRATEGY_ACCOUNT_MISSING",
    "LEDGER_HEAD_MISSING",
  ]);
  const parsed = value.map((item) => {
    if (typeof item !== "string" || !allowed.has(item as AcceptedTargetCycleBlocker)) {
      throw new TypeError("blockers contains an unsupported code");
    }
    return item as AcceptedTargetCycleBlocker;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError("blockers must not contain duplicates");
  }
  return Object.freeze(parsed);
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
