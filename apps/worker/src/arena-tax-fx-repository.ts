import type { EcbUsdCnyDelivery } from "./ecb-fx.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

export type ArenaTaxFxStage = "S1_DISPOSITION" | "S2_ACQUISITION";

export interface ArenaRoundTaxFxReference {
  readonly schema: "twofold.arena_round_tax_fx_reference/v1";
  readonly roundId: string;
  readonly seasonId: string;
  readonly stage: ArenaTaxFxStage;
  readonly fxRateId: string;
  readonly factId: string;
  readonly sourceVersionId: string;
  readonly sourceArtifactId: string;
  readonly sourceContentSha256: string;
  readonly rawBodySha256: string;
  readonly baseCurrency: "USD";
  readonly quoteCurrency: "CNY";
  readonly cnyPerBaseUnit: string;
  readonly requestedSessionDate: string;
  readonly effectiveAt: string;
  readonly visibleAt: string;
  readonly status: "ESTIMATED";
  readonly authority: "ECB_REFERENCE_CROSS";
  readonly crossSha256: string;
  readonly boundBy: string;
  readonly boundAt: string;
}

export interface RegisterArenaTaxFxArguments {
  readonly p_idempotency_key: string;
  readonly p_round_id: string;
  readonly p_stage: ArenaTaxFxStage;
  readonly p_source_artifact_id: string;
  readonly p_source_artifact_sha256: string;
  readonly p_raw_body_sha256: string;
  readonly p_cross_canonical_json: string;
  readonly p_cross_sha256: string;
  readonly p_recorded_by: string;
}

interface RpcResult extends RpcResultLike { readonly data: unknown }
export interface ArenaTaxFxRpcClient {
  rpc(functionName: string, arguments_: Record<string, unknown>): PromiseLike<RpcResult>;
}

export async function getArenaRoundTaxFx(
  client: ArenaTaxFxRpcClient,
  roundId: string,
  fxStage: ArenaTaxFxStage,
): Promise<ArenaRoundTaxFxReference | null> {
  uuid(roundId, "roundId");
  stage(fxStage);
  const result = await client.rpc("get_arena_round_tax_fx_reference", {
    p_round_id: roundId,
    p_stage: fxStage,
  });
  if (result.error !== null) {
    throw new Error(`get_arena_round_tax_fx_reference failed: ${result.error.message}`);
  }
  return result.data === null ? null : parse(result.data);
}

export async function registerArenaRoundTaxFxExact(
  client: ArenaTaxFxRpcClient,
  arguments_: RegisterArenaTaxFxArguments,
  expected: {
    readonly seasonId: string;
    readonly delivery: EcbUsdCnyDelivery;
  },
): Promise<ArenaRoundTaxFxReference> {
  identity(arguments_.p_idempotency_key, "p_idempotency_key");
  uuid(arguments_.p_round_id, "p_round_id");
  stage(arguments_.p_stage);
  uuid(arguments_.p_source_artifact_id, "p_source_artifact_id");
  sha256(arguments_.p_source_artifact_sha256, "p_source_artifact_sha256");
  sha256(arguments_.p_raw_body_sha256, "p_raw_body_sha256");
  sha256(arguments_.p_cross_sha256, "p_cross_sha256");
  identity(arguments_.p_cross_canonical_json, "p_cross_canonical_json");
  identity(arguments_.p_recorded_by, "p_recorded_by");
  uuid(expected.seasonId, "expected.seasonId");
  if (
    arguments_.p_source_artifact_sha256 !== expected.delivery.envelopeSha256
    || arguments_.p_raw_body_sha256 !== expected.delivery.rawBodySha256
    || arguments_.p_cross_canonical_json !== expected.delivery.crossCanonicalJson
    || arguments_.p_cross_sha256 !== expected.delivery.crossSha256
  ) throw new TypeError("tax-FX RPC arguments do not match captured ECB bytes");

  const result = await retryExactRpcOnce(() => client.rpc(
    "register_arena_round_tax_fx_reference",
    arguments_ as unknown as Record<string, unknown>,
  ));
  if (result.error !== null) {
    throw new Error(
      `register_arena_round_tax_fx_reference failed: ${result.error.message}`,
    );
  }
  const parsed = parse(result.data);
  if (
    parsed.roundId !== arguments_.p_round_id
    || parsed.seasonId !== expected.seasonId
    || parsed.stage !== arguments_.p_stage
    || parsed.sourceArtifactId !== arguments_.p_source_artifact_id
    || parsed.sourceContentSha256 !== expected.delivery.envelopeSha256
    || parsed.rawBodySha256 !== expected.delivery.rawBodySha256
    || parsed.cnyPerBaseUnit !== expected.delivery.cross.cnyPerUsd
    || parsed.effectiveAt !== `${expected.delivery.cross.effectiveDate}T00:00:00.000Z`
    || parsed.crossSha256 !== expected.delivery.crossSha256
    || parsed.boundBy !== arguments_.p_recorded_by
  ) throw new TypeError("registered Arena tax-FX result is inconsistent");
  return parsed;
}

function parse(value: unknown): ArenaRoundTaxFxReference {
  assertNoJsonNumber(value, "Arena tax-FX reference");
  const row = exactRecord(value, [
    "schema", "roundId", "seasonId", "stage", "fxRateId", "factId",
    "sourceVersionId", "sourceArtifactId", "sourceContentSha256",
    "rawBodySha256", "baseCurrency", "quoteCurrency", "cnyPerBaseUnit",
    "requestedSessionDate", "effectiveAt", "visibleAt", "status", "authority", "crossSha256",
    "boundBy", "boundAt",
  ]);
  if (row.schema !== "twofold.arena_round_tax_fx_reference/v1") {
    throw new TypeError("unsupported Arena tax-FX schema");
  }
  if (
    row.baseCurrency !== "USD" || row.quoteCurrency !== "CNY"
    || row.status !== "ESTIMATED" || row.authority !== "ECB_REFERENCE_CROSS"
  ) throw new TypeError("Arena tax-FX semantics are not supported");
  const requestedSessionDate = date(
    row.requestedSessionDate,
    "requestedSessionDate",
  );
  const effectiveAt = timestamp(row.effectiveAt, "effectiveAt");
  if (effectiveAt.slice(0, 10) > requestedSessionDate) {
    throw new TypeError("Arena tax-FX effective date follows its requested session");
  }
  return Object.freeze({
    schema: "twofold.arena_round_tax_fx_reference/v1",
    roundId: uuid(row.roundId, "roundId"),
    seasonId: uuid(row.seasonId, "seasonId"),
    stage: stage(row.stage),
    fxRateId: uuid(row.fxRateId, "fxRateId"),
    factId: uuid(row.factId, "factId"),
    sourceVersionId: identity(row.sourceVersionId, "sourceVersionId"),
    sourceArtifactId: uuid(row.sourceArtifactId, "sourceArtifactId"),
    sourceContentSha256: sha256(row.sourceContentSha256, "sourceContentSha256"),
    rawBodySha256: sha256(row.rawBodySha256, "rawBodySha256"),
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    cnyPerBaseUnit: positiveDecimal(row.cnyPerBaseUnit, "cnyPerBaseUnit"),
    requestedSessionDate,
    effectiveAt,
    visibleAt: timestamp(row.visibleAt, "visibleAt"),
    status: "ESTIMATED",
    authority: "ECB_REFERENCE_CROSS",
    crossSha256: sha256(row.crossSha256, "crossSha256"),
    boundBy: identity(row.boundBy, "boundBy"),
    boundAt: timestamp(row.boundAt, "boundAt"),
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Arena tax-FX reference must be an object");
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (Object.keys(record).length !== keys.length
    || Object.keys(record).some((key) => !expected.has(key))) {
    throw new TypeError("Arena tax-FX reference has an unexpected shape");
  }
  return record;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}
function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}
function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA.test(parsed)) throw new TypeError(`${field} must be SHA-256`);
  return parsed;
}
function positiveDecimal(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!DECIMAL.test(parsed) || parsed === "0") {
    throw new TypeError(`${field} must be a positive decimal`);
  }
  return parsed;
}
function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (new Date(parsed).toISOString() !== parsed) {
    throw new TypeError(`${field} must be a canonical timestamp`);
  }
  return parsed;
}
function date(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)
    || new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed) {
    throw new TypeError(`${field} must be a calendar date`);
  }
  return parsed;
}
function stage(value: unknown): ArenaTaxFxStage {
  if (value !== "S1_DISPOSITION" && value !== "S2_ACQUISITION") {
    throw new TypeError("unsupported Arena tax-FX stage");
  }
  return value;
}
function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") throw new TypeError(`${field} contains a numeric token`);
  if (Array.isArray(value)) value.forEach((item) => assertNoJsonNumber(item, field));
  else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => assertNoJsonNumber(item, field));
  }
}
