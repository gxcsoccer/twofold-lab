import type {
  AlpacaOpenReferenceDelivery,
  AlpacaOpenReferenceMethod,
} from "./alpaca-open-reference.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

export type ArenaOpenReferenceStage =
  | "S1_OPEN_REFERENCE"
  | "S2_OPEN_REFERENCE";

export interface RegisterArenaOpenReferenceArguments {
  readonly p_idempotency_key: string;
  readonly p_round_id: string;
  readonly p_stage: ArenaOpenReferenceStage;
  readonly p_source_version_id: string;
  readonly p_storage_bucket: string;
  readonly p_object_path: string;
  readonly p_byte_size: number;
  readonly p_response_sha256: string;
  readonly p_canonical_json: string;
  readonly p_recorded_by: string;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaOpenReferenceRpcClient {
  rpc(
    functionName: "register_arena_round_open_reference",
    arguments_: RegisterArenaOpenReferenceArguments,
  ): PromiseLike<RpcResult>;
}

export interface ArenaOpenReferenceFact {
  readonly factId: string;
  readonly symbol: string;
  readonly barStart: string;
  readonly sessionDate: string;
  readonly currency: "USD";
  readonly value: string;
  readonly observedVolume?: string;
  readonly factSha256: string;
}

export interface ArenaOpenReference {
  readonly schema:
    | "twofold.arena_round_open_reference/v1"
    | "twofold.arena_round_open_reference/v2";
  readonly roundId: string;
  readonly seasonId: string;
  readonly stage: ArenaOpenReferenceStage;
  readonly referenceSnapshotId: string;
  readonly sourceVersionId: string;
  readonly sourceArtifactId: string;
  readonly sourceContentSha256: string;
  readonly requestFingerprint: string;
  readonly method: AlpacaOpenReferenceMethod;
  readonly sessionDate: string;
  readonly expectedOpenAt: string;
  readonly observedAt: string;
  readonly contentSha256: string;
  readonly references: readonly ArenaOpenReferenceFact[];
  readonly boundBy: string;
  readonly boundAt: string;
}

export async function registerArenaOpenReferenceExact(
  client: ArenaOpenReferenceRpcClient,
  arguments_: RegisterArenaOpenReferenceArguments,
  expected: {
    readonly seasonId: string;
    readonly delivery: AlpacaOpenReferenceDelivery;
  },
): Promise<ArenaOpenReference> {
  validateArguments(arguments_, expected.delivery);
  const result = await retryExactRpcOnce(() => client.rpc(
    "register_arena_round_open_reference",
    arguments_,
  ));
  if (result.error !== null) {
    throw new Error(
      `register_arena_round_open_reference failed: ${result.error.message}`,
    );
  }
  const parsed = parseArenaOpenReference(result.data);
  const delivery = expected.delivery;
  if (
    parsed.roundId !== arguments_.p_round_id
    || parsed.seasonId !== expected.seasonId
    || parsed.stage !== arguments_.p_stage
    || parsed.sourceVersionId !== arguments_.p_source_version_id
    || parsed.sourceContentSha256 !== delivery.responseSha256
    || parsed.requestFingerprint !== delivery.requestFingerprint
    || parsed.method !== delivery.method
    || parsed.sessionDate !== delivery.sessionDate
    || parsed.expectedOpenAt !== delivery.expectedOpenAt
    || parsed.observedAt !== delivery.observedAt
    || parsed.contentSha256 !== delivery.contentSha256
    || parsed.boundBy !== arguments_.p_recorded_by
    || parsed.references.length !== delivery.references.length
    || parsed.references.some((reference, index) => {
      const source = delivery.references[index];
      return source === undefined
        || reference.symbol !== source.symbol
        || reference.barStart !== source.barStart
        || reference.sessionDate !== delivery.sessionDate
        || reference.currency !== source.currency
        || reference.value !== source.value
        || reference.observedVolume !== source.observedVolume
        || reference.factSha256 !== source.factSha256;
    })
  ) {
    throw new TypeError("register_arena_round_open_reference returned inconsistent content");
  }
  return parsed;
}

export function parseArenaOpenReference(value: unknown): ArenaOpenReference {
  assertNoJsonNumber(value, "Arena open reference");
  const row = exactRecord(value, [
    "schema", "roundId", "seasonId", "stage", "referenceSnapshotId",
    "sourceVersionId", "sourceArtifactId", "sourceContentSha256",
    "requestFingerprint", "method", "sessionDate", "expectedOpenAt",
    "observedAt", "contentSha256", "references", "boundBy", "boundAt",
  ], "Arena open reference");
  if (
    row.schema !== "twofold.arena_round_open_reference/v1"
    && row.schema !== "twofold.arena_round_open_reference/v2"
  ) {
    throw new TypeError("unsupported Arena open-reference schema");
  }
  const isVolumeParticipation =
    row.schema === "twofold.arena_round_open_reference/v2";
  const parsedMethod = method(row.method);
  if (
    (isVolumeParticipation
      && parsedMethod !== "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE")
    || (!isVolumeParticipation
      && parsedMethod !== "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE")
  ) throw new TypeError("Arena open-reference schema and method differ");
  if (!Array.isArray(row.references) || row.references.length === 0) {
    throw new TypeError("Arena open reference must contain facts");
  }
  const references = row.references.map((value_, index): ArenaOpenReferenceFact => {
    const fact = exactRecord(value_, [
      "factId", "symbol", "barStart", "sessionDate", "currency", "value",
      ...(isVolumeParticipation ? ["observedVolume"] : []),
      "factSha256",
    ], `Arena open reference facts[${index}]`);
    if (fact.currency !== "USD") throw new TypeError("reference currency must be USD");
    return Object.freeze({
      factId: uuid(fact.factId, `references[${index}].factId`),
      symbol: ticker(fact.symbol, `references[${index}].symbol`),
      barStart: timestamp(fact.barStart, `references[${index}].barStart`),
      sessionDate: date(fact.sessionDate, `references[${index}].sessionDate`),
      currency: "USD",
      value: positiveDecimal(fact.value, `references[${index}].value`),
      ...(isVolumeParticipation
        ? {
            observedVolume: wholeShareVolume(
              fact.observedVolume,
              `references[${index}].observedVolume`,
            ),
          }
        : {}),
      factSha256: digest(fact.factSha256, `references[${index}].factSha256`),
    });
  });
  for (let index = 1; index < references.length; index += 1) {
    if (references[index - 1]!.symbol >= references[index]!.symbol) {
      throw new TypeError("reference facts are not canonically ordered");
    }
  }
  return deepFreeze({
    schema: row.schema,
    roundId: uuid(row.roundId, "roundId"),
    seasonId: uuid(row.seasonId, "seasonId"),
    stage: stage(row.stage),
    referenceSnapshotId: uuid(row.referenceSnapshotId, "referenceSnapshotId"),
    sourceVersionId: uuid(row.sourceVersionId, "sourceVersionId"),
    sourceArtifactId: uuid(row.sourceArtifactId, "sourceArtifactId"),
    sourceContentSha256: digest(row.sourceContentSha256, "sourceContentSha256"),
    requestFingerprint: digest(row.requestFingerprint, "requestFingerprint"),
    method: parsedMethod,
    sessionDate: date(row.sessionDate, "sessionDate"),
    expectedOpenAt: timestamp(row.expectedOpenAt, "expectedOpenAt"),
    observedAt: timestamp(row.observedAt, "observedAt"),
    contentSha256: digest(row.contentSha256, "contentSha256"),
    references,
    boundBy: identity(row.boundBy, "boundBy"),
    boundAt: timestamp(row.boundAt, "boundAt"),
  });
}

function validateArguments(
  value: RegisterArenaOpenReferenceArguments,
  delivery: AlpacaOpenReferenceDelivery,
): void {
  identity(value.p_idempotency_key, "p_idempotency_key");
  uuid(value.p_round_id, "p_round_id");
  stage(value.p_stage);
  uuid(value.p_source_version_id, "p_source_version_id");
  identity(value.p_recorded_by, "p_recorded_by");
  if (!Number.isSafeInteger(value.p_byte_size) || value.p_byte_size <= 0) {
    throw new TypeError("p_byte_size must be a positive safe integer");
  }
  if (
    value.p_storage_bucket !== delivery.storageBucket
    || value.p_object_path !== delivery.objectPath
    || value.p_byte_size !== delivery.byteSize
    || value.p_response_sha256 !== delivery.responseSha256
    || value.p_canonical_json !== delivery.canonicalJson
  ) throw new TypeError("open-reference RPC arguments do not match delivery bytes");
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (
    Object.keys(record).length !== keys.length
    || Object.keys(record).some((key) => !expected.has(key))
  ) throw new TypeError(`${field} has an unexpected shape`);
  return record;
}

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") throw new TypeError(`${field} contains a numeric token`);
  if (Array.isArray(value)) value.forEach((item) => assertNoJsonNumber(item, field));
  else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => assertNoJsonNumber(item, field));
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

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
function digest(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!DIGEST_PATTERN.test(parsed)) throw new TypeError(`${field} must be SHA-256`);
  return parsed;
}
function ticker(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(parsed)) throw new TypeError(`${field} must be a ticker`);
  return parsed;
}
function positiveDecimal(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!DECIMAL_PATTERN.test(parsed) || parsed === "0") {
    throw new TypeError(`${field} must be a positive decimal`);
  }
  return parsed;
}
function wholeShareVolume(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^(?:0|[1-9]\d*)$/.test(parsed)) {
    throw new TypeError(`${field} must be a canonical whole-share volume`);
  }
  return parsed;
}
function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (new Date(parsed).toISOString() !== parsed) throw new TypeError(`${field} must be a timestamp`);
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
function stage(value: unknown): ArenaOpenReferenceStage {
  if (value !== "S1_OPEN_REFERENCE" && value !== "S2_OPEN_REFERENCE") {
    throw new TypeError("stage is invalid");
  }
  return value;
}
function method(value: unknown): AlpacaOpenReferenceMethod {
  if (
    value !== "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE"
    && value !== "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE"
  ) {
    throw new TypeError("method is invalid");
  }
  return value;
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
