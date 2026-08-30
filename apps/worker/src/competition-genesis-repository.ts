import { createHash } from "node:crypto";

import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

export const COMPETITION_STRATEGY_ACCOUNT_RESULT_SCHEMA =
  "twofold.competition_strategy_account_result/v1" as const;
export const COMPETITION_LEDGER_HEAD_RESULT_SCHEMA =
  "twofold.strategy_ledger_head_result/v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

export interface InitializeCompetitionStrategyAccountRpcArguments {
  readonly p_account_idempotency_key: string;
  readonly p_run_id: string;
  readonly p_account_code: string;
  readonly p_broker: string;
  readonly p_broker_region: string;
  readonly p_economic_state_canonical_json: string;
  readonly p_economic_state_sha256: string;
  readonly p_recorded_by: string;
}

export interface CompetitionLedgerHeadResult {
  readonly schema: typeof COMPETITION_LEDGER_HEAD_RESULT_SCHEMA;
  readonly strategyAccountId: string;
  readonly headSequence: string;
  readonly headSha256: string;
  readonly lastSettlementId: string | null;
  readonly accountingTransactionCount: string;
  readonly lotOriginCount: string;
  readonly acquisitionFxBindingCount: string;
  readonly settlementCount: string;
  readonly corporateActionMutationCount: string;
  readonly initializedBy: string;
  readonly initializedAt: string;
  readonly updatedAt: string;
}

export interface CompetitionStrategyAccountResult {
  readonly schema: typeof COMPETITION_STRATEGY_ACCOUNT_RESULT_SCHEMA;
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly competitionGenesisId: string;
  readonly economicStateSha256: string;
  readonly head: CompetitionLedgerHeadResult;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface CompetitionGenesisRpcClient {
  rpc(
    functionName: "initialize_competition_strategy_account",
    arguments_: InitializeCompetitionStrategyAccountRpcArguments,
  ): PromiseLike<RpcResult>;
}

export class CompetitionGenesisRpcError extends Error {
  readonly status: number;
  readonly databaseCode: string | null;

  constructor(result: RpcResult) {
    super(
      "initialize_competition_strategy_account failed: "
        + (result.error?.message ?? "unknown RPC error"),
    );
    this.name = "CompetitionGenesisRpcError";
    this.status = result.status;
    const code = (result.error as { code?: unknown } | null)?.code;
    this.databaseCode = typeof code === "string" ? code : null;
  }
}

/**
 * Invoke the sole database mutation boundary for a competition opening state.
 * One ambiguous transport failure is retried with the same argument object so
 * a lost success response cannot create a second account or ledger.
 */
export async function initializeCompetitionStrategyAccountExact(
  client: CompetitionGenesisRpcClient,
  arguments_: InitializeCompetitionStrategyAccountRpcArguments,
): Promise<CompetitionStrategyAccountResult> {
  validateArguments(arguments_);
  const result = await retryExactRpcOnce(() => client.rpc(
    "initialize_competition_strategy_account",
    arguments_,
  ));
  if (result.error !== null) throw new CompetitionGenesisRpcError(result);

  const record = exactRecord(singleResult(result.data), [
    "schema",
    "strategyAccountId",
    "runId",
    "competitionGenesisId",
    "economicStateSha256",
    "head",
  ], "initialize_competition_strategy_account result");
  assertNoJsonNumber(record, "initialize_competition_strategy_account result");
  const parsed = Object.freeze({
    schema: literal(
      record.schema,
      COMPETITION_STRATEGY_ACCOUNT_RESULT_SCHEMA,
      "schema",
    ),
    strategyAccountId: uuid(record.strategyAccountId, "strategyAccountId"),
    runId: uuid(record.runId, "runId"),
    competitionGenesisId: uuid(
      record.competitionGenesisId,
      "competitionGenesisId",
    ),
    economicStateSha256: sha256(
      record.economicStateSha256,
      "economicStateSha256",
    ),
    head: parseHead(record.head),
  }) satisfies CompetitionStrategyAccountResult;

  if (
    parsed.runId !== arguments_.p_run_id
    || parsed.economicStateSha256 !== arguments_.p_economic_state_sha256
    || parsed.head.strategyAccountId !== parsed.strategyAccountId
    || parsed.head.initializedBy !== arguments_.p_recorded_by
  ) {
    throw new TypeError(
      "initialize_competition_strategy_account returned a result inconsistent with the exact request",
    );
  }
  return parsed;
}

function validateArguments(
  value: InitializeCompetitionStrategyAccountRpcArguments,
): void {
  identity(value.p_account_idempotency_key, "p_account_idempotency_key");
  uuid(value.p_run_id, "p_run_id");
  identity(value.p_account_code, "p_account_code");
  identity(value.p_broker, "p_broker");
  identity(value.p_broker_region, "p_broker_region");
  identity(value.p_recorded_by, "p_recorded_by");
  sha256(value.p_economic_state_sha256, "p_economic_state_sha256");
  if (
    value.p_economic_state_canonical_json.trim()
      !== value.p_economic_state_canonical_json
  ) {
    throw new TypeError(
      "p_economic_state_canonical_json must be trimmed canonical JSON",
    );
  }
  let economicState: unknown;
  try {
    economicState = JSON.parse(value.p_economic_state_canonical_json) as unknown;
  } catch {
    throw new TypeError("p_economic_state_canonical_json must be valid JSON");
  }
  assertNoJsonNumber(economicState, "p_economic_state_canonical_json");
  const state = exactRecord(economicState, [
    "schema",
    "genesisId",
    "seasonId",
    "openingStateArtifactId",
    "snapshot",
    "acquisitionFxBindings",
  ], "p_economic_state_canonical_json");
  literal(
    state.schema,
    "twofold.competition_economic_state/v1",
    "economic state schema",
  );

  const actualSha256 = createHash("sha256")
    .update(value.p_economic_state_canonical_json, "utf8")
    .digest("hex");
  if (actualSha256 !== value.p_economic_state_sha256) {
    throw new TypeError(
      "p_economic_state_sha256 does not match exact economic-state bytes",
    );
  }
}

function parseHead(value: unknown): CompetitionLedgerHeadResult {
  const record = exactRecord(value, [
    "schema",
    "strategyAccountId",
    "headSequence",
    "headSha256",
    "lastSettlementId",
    "accountingTransactionCount",
    "lotOriginCount",
    "acquisitionFxBindingCount",
    "settlementCount",
    "corporateActionMutationCount",
    "initializedBy",
    "initializedAt",
    "updatedAt",
  ], "competition ledger head");
  const parsed = Object.freeze({
    schema: literal(
      record.schema,
      COMPETITION_LEDGER_HEAD_RESULT_SCHEMA,
      "head.schema",
    ),
    strategyAccountId: uuid(
      record.strategyAccountId,
      "head.strategyAccountId",
    ),
    headSequence: integer(record.headSequence, "head.headSequence"),
    headSha256: sha256(record.headSha256, "head.headSha256"),
    lastSettlementId: nullableUuid(
      record.lastSettlementId,
      "head.lastSettlementId",
    ),
    accountingTransactionCount: integer(
      record.accountingTransactionCount,
      "head.accountingTransactionCount",
    ),
    lotOriginCount: integer(record.lotOriginCount, "head.lotOriginCount"),
    acquisitionFxBindingCount: integer(
      record.acquisitionFxBindingCount,
      "head.acquisitionFxBindingCount",
    ),
    settlementCount: integer(record.settlementCount, "head.settlementCount"),
    corporateActionMutationCount: integer(
      record.corporateActionMutationCount,
      "head.corporateActionMutationCount",
    ),
    initializedBy: identity(record.initializedBy, "head.initializedBy"),
    initializedAt: timestamp(record.initializedAt, "head.initializedAt"),
    updatedAt: timestamp(record.updatedAt, "head.updatedAt"),
  }) satisfies CompetitionLedgerHeadResult;

  if (BigInt(parsed.headSequence) !== BigInt(parsed.settlementCount)
    + BigInt(parsed.corporateActionMutationCount)) {
    throw new TypeError("competition ledger head sequence does not reconcile");
  }
  if (parsed.lotOriginCount !== parsed.acquisitionFxBindingCount) {
    throw new TypeError("competition ledger head has an unbound acquisition FX lot");
  }
  if (
    BigInt(parsed.accountingTransactionCount) < 1n
    || BigInt(parsed.accountingTransactionCount) < BigInt(parsed.lotOriginCount)
  ) {
    throw new TypeError("competition ledger head accounting counters do not reconcile");
  }
  if ((parsed.headSequence === "0") !== (parsed.lastSettlementId === null)) {
    throw new TypeError("competition ledger head last settlement is inconsistent");
  }
  if (Date.parse(parsed.updatedAt) < Date.parse(parsed.initializedAt)) {
    throw new TypeError("competition ledger head update predates initialization");
  }
  return parsed;
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
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (
    Object.keys(record).length !== keys.length
    || keys.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !expected.has(key))
  ) {
    throw new TypeError(`${field} has an unexpected shape`);
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

function nullableUuid(value: unknown, field: string): string | null {
  if (value === null) return null;
  return uuid(value, field);
}

function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a SHA-256`);
  }
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
  if (typeof value === "number" || typeof value === "bigint") {
    throw new TypeError(`${path} contains a numeric token`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoJsonNumber(entry, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertNoJsonNumber(entry, `${path}.${key}`);
    }
  }
}
