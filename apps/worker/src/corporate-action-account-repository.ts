import { createHash } from "node:crypto";

import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface RegisterCorporateActionAccountPreparationArguments {
  readonly p_idempotency_key: string;
  readonly p_preparation_id: string;
  readonly p_strategy_account_id: string;
  readonly p_run_id: string;
  readonly p_source_action_id: string;
  readonly p_revision_sha256: string;
  readonly p_preparation_canonical_json: string;
  readonly p_content_sha256: string;
  readonly p_captured_at: string;
  readonly p_expected_run_stream_seq: string;
  readonly p_event_id: string;
  readonly p_recorded_by: string;
}

export interface CommitCorporateActionAccountApplicationArguments {
  readonly p_idempotency_key: string;
  readonly p_application_id: string;
  readonly p_strategy_account_id: string;
  readonly p_run_id: string;
  readonly p_source_action_id: string;
  readonly p_revision_sha256: string;
  readonly p_application_canonical_json: string;
  readonly p_content_sha256: string;
  readonly p_applied_at: string;
  readonly p_expected_run_stream_seq: string;
  readonly p_event_id: string;
  readonly p_recorded_by: string;
}

export interface CorporateActionAccountPreparationCommitResult {
  readonly schema: "twofold.corporate_action_account_preparation_result/v1";
  readonly preparationId: string;
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly actionType: "FORWARD_SPLIT" | "REVERSE_SPLIT" | "CASH_DIVIDEND";
  readonly status: "PREPARED" | "NO_POSITION" | "NO_ENTITLEMENT";
  readonly ledgerHeadSequence: string;
  readonly ledgerHeadSha256: string;
  readonly contentSha256: string;
  readonly capturedAt: string;
  readonly sourceStreamSeq: string;
}

export interface CorporateActionAccountApplicationCommitResult {
  readonly schema: "twofold.corporate_action_account_application_result/v1";
  readonly applicationId: string;
  readonly preparationId: string;
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly actionType: "FORWARD_SPLIT" | "REVERSE_SPLIT" | "CASH_DIVIDEND";
  readonly status: "APPLIED" | "NO_POSITION" | "NO_ENTITLEMENT";
  readonly openingHeadSequence: string;
  readonly openingHeadSha256: string;
  readonly finalHeadSequence: string;
  readonly finalHeadSha256: string;
  readonly mutationSha256: string;
  readonly contentSha256: string;
  readonly appliedAt: string;
  readonly sourceStreamSeq: string;
}

interface RpcResult extends RpcResultLike { readonly data: unknown }

export interface CorporateActionAccountRpcClient {
  rpc(
    functionName:
      | "register_corporate_action_account_preparation"
      | "commit_corporate_action_account_application",
    arguments_:
      | RegisterCorporateActionAccountPreparationArguments
      | CommitCorporateActionAccountApplicationArguments,
  ): PromiseLike<RpcResult>;
}

export async function registerCorporateActionAccountPreparationExact(
  client: CorporateActionAccountRpcClient,
  arguments_: RegisterCorporateActionAccountPreparationArguments,
  expected: Readonly<{ ledgerHeadSequence: string; ledgerHeadSha256: string }>,
): Promise<CorporateActionAccountPreparationCommitResult> {
  validatePreparationArguments(arguments_);
  const result = await retryExactRpcOnce(() => client.rpc(
    "register_corporate_action_account_preparation",
    arguments_,
  ));
  if (result.error !== null) {
    throw new Error(
      `register_corporate_action_account_preparation failed: ${result.error.message}`,
    );
  }
  assertNoJsonNumber(result.data, "corporate-action preparation result");
  const parsed = parsePreparationResult(single(result.data));
  if (parsed.preparationId !== arguments_.p_preparation_id
    || parsed.strategyAccountId !== arguments_.p_strategy_account_id
    || parsed.runId !== arguments_.p_run_id
    || parsed.sourceActionId !== arguments_.p_source_action_id
    || parsed.revisionSha256 !== arguments_.p_revision_sha256
    || parsed.contentSha256 !== arguments_.p_content_sha256
    || parsed.capturedAt !== arguments_.p_captured_at
    || parsed.ledgerHeadSequence !== expected.ledgerHeadSequence
    || parsed.ledgerHeadSha256 !== expected.ledgerHeadSha256
    || BigInt(parsed.sourceStreamSeq)
       !== BigInt(arguments_.p_expected_run_stream_seq) + 1n) {
    throw new TypeError("corporate-action preparation RPC returned a different fence");
  }
  return parsed;
}

export async function commitCorporateActionAccountApplicationExact(
  client: CorporateActionAccountRpcClient,
  arguments_: CommitCorporateActionAccountApplicationArguments,
  expected: Readonly<{
    preparationId: string;
    openingHeadSequence: string;
    openingHeadSha256: string;
    finalHeadSequence: string;
    finalHeadSha256: string;
  }>,
): Promise<CorporateActionAccountApplicationCommitResult> {
  validateApplicationArguments(arguments_);
  const result = await retryExactRpcOnce(() => client.rpc(
    "commit_corporate_action_account_application",
    arguments_,
  ));
  if (result.error !== null) {
    throw new Error(
      `commit_corporate_action_account_application failed: ${result.error.message}`,
    );
  }
  assertNoJsonNumber(result.data, "corporate-action application result");
  const parsed = parseApplicationResult(single(result.data));
  if (parsed.applicationId !== arguments_.p_application_id
    || parsed.preparationId !== expected.preparationId
    || parsed.strategyAccountId !== arguments_.p_strategy_account_id
    || parsed.runId !== arguments_.p_run_id
    || parsed.sourceActionId !== arguments_.p_source_action_id
    || parsed.revisionSha256 !== arguments_.p_revision_sha256
    || parsed.contentSha256 !== arguments_.p_content_sha256
    || parsed.appliedAt !== arguments_.p_applied_at
    || parsed.openingHeadSequence !== expected.openingHeadSequence
    || parsed.openingHeadSha256 !== expected.openingHeadSha256
    || BigInt(parsed.sourceStreamSeq)
       !== BigInt(arguments_.p_expected_run_stream_seq) + 1n) {
    throw new TypeError("corporate-action application RPC returned a different identity");
  }
  if (parsed.finalHeadSequence !== expected.finalHeadSequence
    || parsed.finalHeadSha256 !== expected.finalHeadSha256) {
    throw new TypeError("corporate-action application RPC returned a different final ledger head");
  }
  return parsed;
}

function validatePreparationArguments(
  value: RegisterCorporateActionAccountPreparationArguments,
): void {
  validateCommon(value);
  exactBytes(
    value.p_preparation_canonical_json,
    value.p_content_sha256,
    "preparation",
  );
  timestamp(value.p_captured_at, "p_captured_at");
  uuid(value.p_preparation_id, "p_preparation_id");
}

function validateApplicationArguments(
  value: CommitCorporateActionAccountApplicationArguments,
): void {
  validateCommon(value);
  exactBytes(
    value.p_application_canonical_json,
    value.p_content_sha256,
    "application",
  );
  timestamp(value.p_applied_at, "p_applied_at");
  uuid(value.p_application_id, "p_application_id");
}

function validateCommon(value: {
  readonly p_idempotency_key: string;
  readonly p_strategy_account_id: string;
  readonly p_run_id: string;
  readonly p_source_action_id: string;
  readonly p_revision_sha256: string;
  readonly p_content_sha256: string;
  readonly p_expected_run_stream_seq: string;
  readonly p_event_id: string;
  readonly p_recorded_by: string;
}): void {
  for (const [field, candidate] of [
    ["p_strategy_account_id", value.p_strategy_account_id],
    ["p_run_id", value.p_run_id],
    ["p_source_action_id", value.p_source_action_id],
    ["p_event_id", value.p_event_id],
  ] as const) uuid(candidate, field);
  sha(value.p_revision_sha256, "p_revision_sha256");
  sha(value.p_content_sha256, "p_content_sha256");
  integer(value.p_expected_run_stream_seq, "p_expected_run_stream_seq");
  for (const [field, candidate] of [
    ["p_idempotency_key", value.p_idempotency_key],
    ["p_recorded_by", value.p_recorded_by],
  ] as const) {
    if (candidate.trim() === "" || candidate !== candidate.trim()) {
      throw new TypeError(`${field} must be a trimmed non-empty string`);
    }
  }
}

function parsePreparationResult(
  value: unknown,
): CorporateActionAccountPreparationCommitResult {
  const row = exactRecord(value, [
    "schema","preparationId","strategyAccountId","runId","sourceActionId",
    "revisionSha256","actionType","status","ledgerHeadSequence",
    "ledgerHeadSha256","contentSha256","capturedAt","sourceStreamSeq",
  ], "corporate-action preparation result");
  if (row.schema !== "twofold.corporate_action_account_preparation_result/v1") {
    throw new TypeError("unsupported corporate-action preparation result schema");
  }
  return Object.freeze({
    schema: row.schema,
    preparationId: uuid(row.preparationId, "preparationId"),
    strategyAccountId: uuid(row.strategyAccountId, "strategyAccountId"),
    runId: uuid(row.runId, "runId"),
    sourceActionId: uuid(row.sourceActionId, "sourceActionId"),
    revisionSha256: sha(row.revisionSha256, "revisionSha256"),
    actionType: actionType(row.actionType),
    status: preparationStatus(row.status),
    ledgerHeadSequence: integer(row.ledgerHeadSequence, "ledgerHeadSequence"),
    ledgerHeadSha256: sha(row.ledgerHeadSha256, "ledgerHeadSha256"),
    contentSha256: sha(row.contentSha256, "contentSha256"),
    capturedAt: timestamp(row.capturedAt, "capturedAt"),
    sourceStreamSeq: positiveInteger(row.sourceStreamSeq, "sourceStreamSeq"),
  });
}

function parseApplicationResult(
  value: unknown,
): CorporateActionAccountApplicationCommitResult {
  const row = exactRecord(value, [
    "schema","applicationId","preparationId","strategyAccountId","runId",
    "sourceActionId","revisionSha256","actionType","status",
    "openingHeadSequence","openingHeadSha256","finalHeadSequence",
    "finalHeadSha256","mutationSha256","contentSha256","appliedAt",
    "sourceStreamSeq",
  ], "corporate-action application result");
  if (row.schema !== "twofold.corporate_action_account_application_result/v1") {
    throw new TypeError("unsupported corporate-action application result schema");
  }
  return Object.freeze({
    schema: row.schema,
    applicationId: uuid(row.applicationId, "applicationId"),
    preparationId: uuid(row.preparationId, "preparationId"),
    strategyAccountId: uuid(row.strategyAccountId, "strategyAccountId"),
    runId: uuid(row.runId, "runId"),
    sourceActionId: uuid(row.sourceActionId, "sourceActionId"),
    revisionSha256: sha(row.revisionSha256, "revisionSha256"),
    actionType: actionType(row.actionType),
    status: applicationStatus(row.status),
    openingHeadSequence: integer(row.openingHeadSequence, "openingHeadSequence"),
    openingHeadSha256: sha(row.openingHeadSha256, "openingHeadSha256"),
    finalHeadSequence: integer(row.finalHeadSequence, "finalHeadSequence"),
    finalHeadSha256: sha(row.finalHeadSha256, "finalHeadSha256"),
    mutationSha256: sha(row.mutationSha256, "mutationSha256"),
    contentSha256: sha(row.contentSha256, "contentSha256"),
    appliedAt: timestamp(row.appliedAt, "appliedAt"),
    sourceStreamSeq: positiveInteger(row.sourceStreamSeq, "sourceStreamSeq"),
  });
}

function exactBytes(value: string, expectedSha: string, field: string): void {
  if (value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} canonical JSON must be trimmed`);
  }
  JSON.parse(value);
  if (createHash("sha256").update(value, "utf8").digest("hex") !== expectedSha) {
    throw new TypeError(`${field} SHA-256 does not match exact bytes`);
  }
}

function exactRecord(value: unknown, keys: readonly string[], field: string) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} has unexpected fields`);
  }
  return row;
}

function single(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length !== 1) throw new TypeError("RPC must return exactly one result");
  return value[0];
}

function actionType(value: unknown) {
  if (value !== "FORWARD_SPLIT" && value !== "REVERSE_SPLIT"
    && value !== "CASH_DIVIDEND") throw new TypeError("invalid actionType");
  return value;
}

function preparationStatus(value: unknown) {
  if (value !== "PREPARED" && value !== "NO_POSITION"
    && value !== "NO_ENTITLEMENT") throw new TypeError("invalid preparation status");
  return value;
}

function applicationStatus(value: unknown) {
  if (value !== "APPLIED" && value !== "NO_POSITION"
    && value !== "NO_ENTITLEMENT") throw new TypeError("invalid application status");
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value;
}

function sha(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256`);
  }
  return value;
}

function integer(value: unknown, field: string): string {
  if (typeof value !== "string" || !INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a non-negative integer string`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): string {
  const parsed = integer(value, field);
  if (parsed === "0") throw new TypeError(`${field} must be positive`);
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function assertNoJsonNumber(value: unknown, path: string): void {
  if (typeof value === "number") throw new TypeError(`${path} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((nested, index) => assertNoJsonNumber(nested, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertNoJsonNumber(nested, `${path}.${key}`);
    }
  }
}
