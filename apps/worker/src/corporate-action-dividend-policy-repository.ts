import type { EcbUsdCnyDelivery } from "./ecb-fx.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

export interface CorporateActionDividendFxReference {
  readonly schema: "twofold.corporate_action_dividend_fx_reference/v1";
  readonly seasonId: string;
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly fxRateId: string;
  readonly factId: string;
  readonly sourceVersionId: "ecb-eurofxref-hist-90d-v1";
  readonly sourceArtifactId: string;
  readonly sourceContentSha256: string;
  readonly rawBodySha256: string;
  readonly baseCurrency: "USD";
  readonly quoteCurrency: "CNY";
  readonly cnyPerBaseUnit: string;
  readonly effectiveAt: string;
  readonly visibleAt: string;
  readonly status: "FINAL";
  readonly sourceStatus: "ESTIMATED";
  readonly authority: "ECB_REFERENCE_CROSS";
  readonly crossSha256: string;
  readonly boundBy: string;
  readonly boundAt: string;
}

export interface CorporateActionDividendPolicyMaterialRow {
  readonly schema: "twofold.corporate_action_dividend_policy_material/v1";
  readonly seasonId: string;
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly instrumentId: string;
  readonly currency: "USD";
  readonly instrumentKind: "common_stock" | "adr" | "etf";
  readonly issuerTaxResidenceCountry: string;
  readonly distributionClassification:
    | "ordinary_dividend"
    | "interest_related_dividend"
    | "return_of_capital";
  readonly foreignWithholdingRate: string;
  readonly treatyOrLocalCapRate: string;
  readonly foreignTaxCreditEvidenceStatus: "EVIDENCE_PENDING";
}

export interface RegisterCorporateActionDividendFxArguments {
  readonly p_idempotency_key: string;
  readonly p_season_id: string;
  readonly p_source_action_id: string;
  readonly p_revision_sha256: string;
  readonly p_source_artifact_id: string;
  readonly p_source_artifact_sha256: string;
  readonly p_raw_body_sha256: string;
  readonly p_cross_canonical_json: string;
  readonly p_cross_sha256: string;
  readonly p_recorded_by: string;
}

interface RpcResult extends RpcResultLike { readonly data: unknown }
export interface CorporateActionDividendPolicyRpcClient {
  rpc(functionName: string, arguments_: Record<string, unknown>): PromiseLike<RpcResult>;
}

export async function getCorporateActionDividendFxReference(
  client: CorporateActionDividendPolicyRpcClient,
  identity: Readonly<{
    seasonId: string;
    sourceActionId: string;
    revisionSha256: string;
  }>,
): Promise<CorporateActionDividendFxReference | null> {
  validateIdentity(identity);
  const result = await client.rpc("get_corporate_action_dividend_fx_reference", {
    p_season_id: identity.seasonId,
    p_source_action_id: identity.sourceActionId,
    p_revision_sha256: identity.revisionSha256,
  });
  if (result.error !== null) {
    throw new Error(`get cash-dividend FX failed: ${result.error.message}`);
  }
  return result.data === null ? null : parseFx(result.data);
}

export async function getCorporateActionDividendPolicyMaterial(
  client: CorporateActionDividendPolicyRpcClient,
  identity: Readonly<{
    seasonId: string;
    sourceActionId: string;
    revisionSha256: string;
    instrumentId: string;
  }>,
): Promise<CorporateActionDividendPolicyMaterialRow> {
  validateIdentity(identity);
  uuid(identity.instrumentId, "instrumentId");
  const result = await client.rpc("get_corporate_action_dividend_policy_material", {
    p_season_id: identity.seasonId,
    p_source_action_id: identity.sourceActionId,
    p_revision_sha256: identity.revisionSha256,
    p_instrument_id: identity.instrumentId,
  });
  if (result.error !== null) {
    throw new Error(`get cash-dividend policy material failed: ${result.error.message}`);
  }
  const row = exactRecord(result.data, [
    "schema","seasonId","sourceActionId","revisionSha256","instrumentId",
    "currency","instrumentKind","issuerTaxResidenceCountry",
    "distributionClassification","foreignWithholdingRate",
    "treatyOrLocalCapRate","foreignTaxCreditEvidenceStatus",
  ], "cash-dividend policy material");
  if (row.schema !== "twofold.corporate_action_dividend_policy_material/v1"
    || row.currency !== "USD"
    || !["common_stock","adr","etf"].includes(String(row.instrumentKind))
    || !["ordinary_dividend","interest_related_dividend","return_of_capital"]
      .includes(String(row.distributionClassification))
    || row.foreignTaxCreditEvidenceStatus !== "EVIDENCE_PENDING") {
    throw new TypeError("unsupported cash-dividend policy material");
  }
  const parsed = Object.freeze({
    schema: "twofold.corporate_action_dividend_policy_material/v1" as const,
    seasonId: uuid(row.seasonId, "seasonId"),
    sourceActionId: uuid(row.sourceActionId, "sourceActionId"),
    revisionSha256: sha(row.revisionSha256, "revisionSha256"),
    instrumentId: uuid(row.instrumentId, "instrumentId"),
    currency: "USD" as const,
    instrumentKind: row.instrumentKind as CorporateActionDividendPolicyMaterialRow["instrumentKind"],
    issuerTaxResidenceCountry: country(row.issuerTaxResidenceCountry),
    distributionClassification:
      row.distributionClassification as CorporateActionDividendPolicyMaterialRow["distributionClassification"],
    foreignWithholdingRate: rate(row.foreignWithholdingRate, "foreignWithholdingRate"),
    treatyOrLocalCapRate: rate(row.treatyOrLocalCapRate, "treatyOrLocalCapRate"),
    foreignTaxCreditEvidenceStatus: "EVIDENCE_PENDING" as const,
  });
  if (parsed.seasonId !== identity.seasonId
    || parsed.sourceActionId !== identity.sourceActionId
    || parsed.revisionSha256 !== identity.revisionSha256
    || parsed.instrumentId !== identity.instrumentId) {
    throw new TypeError("cash-dividend policy material belongs to another action");
  }
  return parsed;
}

export async function registerCorporateActionDividendFxExact(
  client: CorporateActionDividendPolicyRpcClient,
  arguments_: RegisterCorporateActionDividendFxArguments,
  delivery: EcbUsdCnyDelivery,
): Promise<CorporateActionDividendFxReference> {
  validateIdentity({
    seasonId: arguments_.p_season_id,
    sourceActionId: arguments_.p_source_action_id,
    revisionSha256: arguments_.p_revision_sha256,
  });
  identity(arguments_.p_idempotency_key, "p_idempotency_key");
  uuid(arguments_.p_source_artifact_id, "p_source_artifact_id");
  sha(arguments_.p_source_artifact_sha256, "p_source_artifact_sha256");
  sha(arguments_.p_raw_body_sha256, "p_raw_body_sha256");
  sha(arguments_.p_cross_sha256, "p_cross_sha256");
  identity(arguments_.p_recorded_by, "p_recorded_by");
  if (arguments_.p_source_artifact_sha256 !== delivery.envelopeSha256
    || arguments_.p_raw_body_sha256 !== delivery.rawBodySha256
    || arguments_.p_cross_canonical_json !== delivery.crossCanonicalJson
    || arguments_.p_cross_sha256 !== delivery.crossSha256) {
    throw new TypeError("cash-dividend FX RPC does not match captured ECB bytes");
  }
  const result = await retryExactRpcOnce(() => client.rpc(
    "register_corporate_action_dividend_fx_reference",
    arguments_ as unknown as Record<string, unknown>,
  ));
  if (result.error !== null) {
    throw new Error(`register cash-dividend FX failed: ${result.error.message}`);
  }
  const parsed = parseFx(result.data);
  if (parsed.seasonId !== arguments_.p_season_id
    || parsed.sourceActionId !== arguments_.p_source_action_id
    || parsed.revisionSha256 !== arguments_.p_revision_sha256
    || parsed.sourceArtifactId !== arguments_.p_source_artifact_id
    || parsed.sourceContentSha256 !== delivery.envelopeSha256
    || parsed.rawBodySha256 !== delivery.rawBodySha256
    || parsed.cnyPerBaseUnit !== delivery.cross.cnyPerUsd
    || parsed.crossSha256 !== delivery.crossSha256
    || parsed.boundBy !== arguments_.p_recorded_by) {
    throw new TypeError("registered cash-dividend FX result is inconsistent");
  }
  return parsed;
}

function parseFx(value: unknown): CorporateActionDividendFxReference {
  assertNoJsonNumber(value, "cash-dividend FX reference");
  const row = exactRecord(value, [
    "schema","seasonId","sourceActionId","revisionSha256","fxRateId","factId",
    "sourceVersionId","sourceArtifactId","sourceContentSha256","rawBodySha256",
    "baseCurrency","quoteCurrency","cnyPerBaseUnit","effectiveAt","visibleAt",
    "status","sourceStatus","authority","crossSha256","boundBy","boundAt",
  ], "cash-dividend FX reference");
  if (row.schema !== "twofold.corporate_action_dividend_fx_reference/v1"
    || row.sourceVersionId !== "ecb-eurofxref-hist-90d-v1"
    || row.baseCurrency !== "USD" || row.quoteCurrency !== "CNY"
    || row.status !== "FINAL" || row.sourceStatus !== "ESTIMATED"
    || row.authority !== "ECB_REFERENCE_CROSS") {
    throw new TypeError("unsupported cash-dividend FX semantics");
  }
  return Object.freeze({
    schema: "twofold.corporate_action_dividend_fx_reference/v1",
    seasonId: uuid(row.seasonId, "seasonId"),
    sourceActionId: uuid(row.sourceActionId, "sourceActionId"),
    revisionSha256: sha(row.revisionSha256, "revisionSha256"),
    fxRateId: uuid(row.fxRateId, "fxRateId"),
    factId: uuid(row.factId, "factId"),
    sourceVersionId: "ecb-eurofxref-hist-90d-v1",
    sourceArtifactId: uuid(row.sourceArtifactId, "sourceArtifactId"),
    sourceContentSha256: sha(row.sourceContentSha256, "sourceContentSha256"),
    rawBodySha256: sha(row.rawBodySha256, "rawBodySha256"),
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    cnyPerBaseUnit: positiveDecimal(row.cnyPerBaseUnit, "cnyPerBaseUnit"),
    effectiveAt: timestamp(row.effectiveAt, "effectiveAt"),
    visibleAt: timestamp(row.visibleAt, "visibleAt"),
    status: "FINAL",
    sourceStatus: "ESTIMATED",
    authority: "ECB_REFERENCE_CROSS",
    crossSha256: sha(row.crossSha256, "crossSha256"),
    boundBy: identity(row.boundBy, "boundBy"),
    boundAt: timestamp(row.boundAt, "boundAt"),
  });
}

function validateIdentity(value: {seasonId: string; sourceActionId: string; revisionSha256: string}): void {
  uuid(value.seasonId, "seasonId");
  uuid(value.sourceActionId, "sourceActionId");
  sha(value.revisionSha256, "revisionSha256");
}
function exactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const row = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (Object.keys(row).length !== keys.length
    || Object.keys(row).some((key) => !expected.has(key))) {
    throw new TypeError(`${field} has an unexpected shape`);
  }
  return row;
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
function sha(value: unknown, field: string): string {
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
function rate(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!DECIMAL.test(parsed) || Number(parsed) > 1) {
    throw new TypeError(`${field} must be a rate`);
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
function country(value: unknown): string {
  const parsed = identity(value, "issuerTaxResidenceCountry");
  if (!/^[A-Z]{2}$/.test(parsed)) throw new TypeError("invalid issuer tax residence");
  return parsed;
}
function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") throw new TypeError(`${field} contains a numeric token`);
  if (Array.isArray(value)) value.forEach((item) => assertNoJsonNumber(item, field));
  else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => assertNoJsonNumber(item, field));
  }
}
