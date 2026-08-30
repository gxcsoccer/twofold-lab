import { canonicalJson } from "./arena-inputs.js";
import type { AlpacaCorporateActionScan } from "./alpaca-corporate-actions.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface RegisterCorporateActionScanArguments {
  readonly p_idempotency_key: string;
  readonly p_source_version_id: string;
  readonly p_request_fingerprint: string;
  readonly p_process_date_start: string;
  readonly p_process_date_end: string;
  readonly p_observed_at: string;
  readonly p_canonical_json: string;
  readonly p_content_sha256: string;
  readonly p_pages: readonly Readonly<{
    pageIndex: string;
    providerRequestId: string | null;
    storageBucket: string;
    objectPath: string;
    byteSize: string;
    responseSha256: string;
  }>[];
  readonly p_actions: AlpacaCorporateActionScan["actions"];
  readonly p_recorded_by: string;
}

export interface CorporateActionScanCommitResult {
  readonly schema: "twofold.corporate_action_scan_commit_result/v1";
  readonly scanId: string;
  readonly sourceVersionId: string;
  readonly requestFingerprint: string;
  readonly processDateStart: string;
  readonly processDateEnd: string;
  readonly observedAt: string;
  readonly contentSha256: string;
  readonly pageCount: string;
  readonly actionCount: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface CorporateActionScanRpcClient {
  rpc(
    functionName: "register_corporate_action_scan",
    arguments_: RegisterCorporateActionScanArguments,
  ): PromiseLike<RpcResult>;
}

export async function registerCorporateActionScanExact(
  client: CorporateActionScanRpcClient,
  arguments_: RegisterCorporateActionScanArguments,
  expected: AlpacaCorporateActionScan,
): Promise<CorporateActionScanCommitResult> {
  assertNoJsonNumber(arguments_, "corporate-action persistence request");
  validateArguments(arguments_, expected);
  const response = await retryExactRpcOnce(() => client.rpc(
    "register_corporate_action_scan",
    arguments_,
  ));
  if (response.error !== null) {
    throw new Error(
      `register_corporate_action_scan failed: ${response.error.message}`,
    );
  }
  assertNoJsonNumber(response.data, "corporate-action persistence result");
  const parsed = parseResult(response.data);
  if (parsed.sourceVersionId !== arguments_.p_source_version_id
    || parsed.requestFingerprint !== expected.requestFingerprint
    || parsed.processDateStart !== expected.processDateStart
    || parsed.processDateEnd !== expected.processDateEnd
    || parsed.observedAt !== expected.observedAt
    || parsed.contentSha256 !== expected.contentSha256
    || parsed.pageCount !== expected.pages.length.toString()
    || parsed.actionCount !== expected.actions.length.toString()
    || parsed.recordedBy !== arguments_.p_recorded_by) {
    throw new TypeError(
      "register_corporate_action_scan returned inconsistent content",
    );
  }
  return parsed;
}

function validateArguments(
  value: RegisterCorporateActionScanArguments,
  expected: AlpacaCorporateActionScan,
): void {
  identity(value.p_idempotency_key, "p_idempotency_key");
  uuid(value.p_source_version_id, "p_source_version_id");
  digest(value.p_request_fingerprint, "p_request_fingerprint");
  digest(value.p_content_sha256, "p_content_sha256");
  date(value.p_process_date_start, "p_process_date_start");
  date(value.p_process_date_end, "p_process_date_end");
  timestamp(value.p_observed_at, "p_observed_at");
  identity(value.p_canonical_json, "p_canonical_json");
  identity(value.p_recorded_by, "p_recorded_by");
  if (value.p_request_fingerprint !== expected.requestFingerprint
    || value.p_process_date_start !== expected.processDateStart
    || value.p_process_date_end !== expected.processDateEnd
    || value.p_observed_at !== expected.observedAt
    || value.p_canonical_json !== expected.canonicalJson
    || value.p_content_sha256 !== expected.contentSha256
    || value.p_pages.length !== expected.pages.length
    || value.p_actions.length !== expected.actions.length
    || canonicalJson(value.p_actions) !== canonicalJson(expected.actions)) {
    throw new TypeError("corporate-action RPC arguments do not match scan bytes");
  }
  value.p_pages.forEach((page, index) => {
    const source = expected.pages[index];
    if (source === undefined
      || page.pageIndex !== source.pageIndex
      || page.providerRequestId !== (source.providerRequestId ?? null)
      || page.storageBucket !== source.storageBucket
      || page.objectPath !== source.objectPath
      || page.byteSize !== source.byteSize
      || page.responseSha256 !== source.responseSha256) {
      throw new TypeError("corporate-action page arguments do not match raw bytes");
    }
    integer(page.pageIndex, `p_pages[${index}].pageIndex`);
    positiveInteger(page.byteSize, `p_pages[${index}].byteSize`);
    digest(page.responseSha256, `p_pages[${index}].responseSha256`);
  });
}

function parseResult(value: unknown): CorporateActionScanCommitResult {
  const row = exactRecord(value, [
    "schema", "scanId", "sourceVersionId", "requestFingerprint",
    "processDateStart", "processDateEnd", "observedAt", "contentSha256",
    "pageCount", "actionCount", "recordedBy", "recordedAt",
  ], "corporate-action scan commit result");
  if (row.schema !== "twofold.corporate_action_scan_commit_result/v1") {
    throw new TypeError("unsupported corporate-action commit-result schema");
  }
  return Object.freeze({
    schema: "twofold.corporate_action_scan_commit_result/v1",
    scanId: uuid(row.scanId, "scanId"),
    sourceVersionId: uuid(row.sourceVersionId, "sourceVersionId"),
    requestFingerprint: digest(row.requestFingerprint, "requestFingerprint"),
    processDateStart: date(row.processDateStart, "processDateStart"),
    processDateEnd: date(row.processDateEnd, "processDateEnd"),
    observedAt: timestamp(row.observedAt, "observedAt"),
    contentSha256: digest(row.contentSha256, "contentSha256"),
    pageCount: integer(row.pageCount, "pageCount"),
    actionCount: integer(row.actionCount, "actionCount"),
    recordedBy: identity(row.recordedBy, "recordedBy"),
    recordedAt: timestamp(row.recordedAt, "recordedAt"),
  });
}

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") {
    throw new TypeError(`${field} contains a numeric token`);
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoJsonNumber(item, field));
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => assertNoJsonNumber(item, field));
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
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} has an unexpected shape`);
  }
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

function digest(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be SHA-256`);
  return parsed;
}

function integer(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!INTEGER_PATTERN.test(parsed)) throw new TypeError(`${field} must be an integer`);
  return parsed;
}

function positiveInteger(value: unknown, field: string): string {
  const parsed = integer(value, field);
  if (parsed === "0") throw new TypeError(`${field} must be positive`);
  return parsed;
}

function date(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)
    || new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed) {
    throw new TypeError(`${field} must be a date`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (new Date(parsed).toISOString() !== parsed) {
    throw new TypeError(`${field} must be a timestamp`);
  }
  return parsed;
}
