import {
  addDecimals,
  compareDecimals,
  multiplyDecimals,
  normalizeDecimal,
  subtractDecimals,
} from "@twofold/core";

import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

export const PAPER_FILL_SETTLEMENT_RESULT_SCHEMA =
  "twofold.paper_fill_settlement_result/v1" as const;
export const STRATEGY_LEDGER_HEAD_RESULT_SCHEMA =
  "twofold.strategy_ledger_head_result/v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

export interface InitializeStrategyLedgerHeadRpcArguments {
  readonly p_strategy_account_id: string;
  readonly p_recorded_by: string;
}

export interface GetStrategyLedgerHeadRpcArguments {
  readonly p_strategy_account_id: string;
}

export interface StrategyLedgerHeadResult {
  readonly schema: typeof STRATEGY_LEDGER_HEAD_RESULT_SCHEMA;
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

export interface SettlePaperFillRpcArguments {
  readonly p_idempotency_key: string;
  readonly p_strategy_account_id: string;
  readonly p_frozen_order_plan_id: string;
  readonly p_order_id: string;
  readonly p_execution_price_evidence_id: string;
  /** Required only when settlement derives a positive S2 BUY fill and lot. */
  readonly p_tax_fx_rate_evidence_id: string | null;
  readonly p_executed_at: string;
  readonly p_settlement_date: string;
  readonly p_expected_head_sequence: string;
  readonly p_expected_head_sha256: string;
  readonly p_recorded_by: string;
}

export type PaperFillOutcome =
  | "FILLED"
  | "PARTIALLY_FILLED_CASH_LIMIT"
  | "CANCELED_CASH_LIMIT";

/**
 * String-only response from the database authority. Financial NUMERIC and
 * ledger BIGINT values must never cross PostgREST as JavaScript numbers.
 */
export interface PaperFillSettlementResult {
  readonly schema: typeof PAPER_FILL_SETTLEMENT_RESULT_SCHEMA;
  readonly settlement_id: string;
  readonly idempotency_key: string;
  readonly strategy_account_id: string;
  readonly frozen_order_plan_id: string;
  readonly order_id: string;
  readonly stage: "S2";
  readonly side: "BUY";
  readonly outcome: PaperFillOutcome;
  readonly execution_price_evidence_id: string;
  /** Actual acquisition-FX binding; always null for a zero-fill cancellation. */
  readonly tax_fx_rate_evidence_id: string | null;
  readonly executed_at: string;
  readonly settlement_date: string;
  readonly order_quantity: string;
  readonly fill_quantity: string;
  readonly canceled_quantity: string;
  readonly official_open_price: string;
  readonly fill_price: string;
  readonly gross_notional: string;
  readonly total_fees: string;
  readonly cash_effect: string;
  readonly tax_reserve_effect: string;
  readonly buying_power_before: string;
  readonly frozen_buying_power_remaining_before: string;
  readonly effective_buying_power_limit: string;
  readonly buying_power_after: string;
  readonly accounting_transaction_id: string | null;
  readonly created_lot_origin_id: string | null;
  readonly pre_head_sequence: string;
  readonly pre_head_sha256: string;
  readonly post_head_sequence: string;
  readonly post_head_sha256: string;
  readonly request_sha256: string;
  readonly recorded_by: string;
  readonly recorded_at: string;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export class FillSettlementRpcError extends Error {
  readonly operation:
    | "initialize_strategy_ledger_head"
    | "get_strategy_ledger_head"
    | "settle_paper_fill";
  readonly status: number;
  readonly databaseCode: string | null;

  constructor(
    operation: FillSettlementRpcError["operation"],
    result: RpcResult,
  ) {
    super(`${operation} failed: ${result.error?.message ?? "unknown RPC error"}`);
    this.name = "FillSettlementRpcError";
    this.operation = operation;
    this.status = result.status;
    const code = (result.error as { code?: unknown } | null)?.code;
    this.databaseCode = typeof code === "string" ? code : null;
  }
}

/** A fresh head may be loaded only for PostgreSQL serialization/CAS failure. */
export function isLedgerHeadConflict(error: unknown): boolean {
  return error instanceof FillSettlementRpcError
    && error.operation === "settle_paper_fill"
    && error.databaseCode === "40001";
}

export interface FillSettlementRpcClient {
  rpc(
    functionName: "initialize_strategy_ledger_head",
    arguments_: InitializeStrategyLedgerHeadRpcArguments,
  ): PromiseLike<RpcResult>;
  rpc(
    functionName: "get_strategy_ledger_head",
    arguments_: GetStrategyLedgerHeadRpcArguments,
  ): PromiseLike<RpcResult>;
  rpc(
    functionName: "settle_paper_fill",
    arguments_: SettlePaperFillRpcArguments,
  ): PromiseLike<RpcResult>;
}

export async function initializeStrategyLedgerHeadExact(
  client: FillSettlementRpcClient,
  arguments_: InitializeStrategyLedgerHeadRpcArguments,
): Promise<StrategyLedgerHeadResult> {
  requireUuid(arguments_.p_strategy_account_id, "p_strategy_account_id");
  requireIdentity(arguments_.p_recorded_by, "p_recorded_by");
  const result = await retryExactRpcOnce(() => client.rpc(
    "initialize_strategy_ledger_head",
    arguments_,
  ));
  if (result.error !== null) {
    throw new FillSettlementRpcError("initialize_strategy_ledger_head", result);
  }
  const parsed = parseStrategyLedgerHeadResult(
    result.data,
    "initialize_strategy_ledger_head result",
  );
  if (parsed.strategyAccountId !== arguments_.p_strategy_account_id) {
    throw new TypeError(
      "initialize_strategy_ledger_head returned a different strategy account",
    );
  }
  if (parsed.initializedBy !== arguments_.p_recorded_by) {
    throw new TypeError(
      "initialize_strategy_ledger_head returned a different initializer",
    );
  }
  return parsed;
}

/** Reload the authoritative CAS pointer after a deterministic head conflict. */
export async function getStrategyLedgerHeadExact(
  client: FillSettlementRpcClient,
  arguments_: GetStrategyLedgerHeadRpcArguments,
): Promise<StrategyLedgerHeadResult> {
  requireUuid(arguments_.p_strategy_account_id, "p_strategy_account_id");
  const result = await retryExactRpcOnce(() => client.rpc(
    "get_strategy_ledger_head",
    arguments_,
  ));
  if (result.error !== null) {
    throw new FillSettlementRpcError("get_strategy_ledger_head", result);
  }
  const parsed = parseStrategyLedgerHeadResult(
    result.data,
    "get_strategy_ledger_head result",
  );
  if (parsed.strategyAccountId !== arguments_.p_strategy_account_id) {
    throw new TypeError(
      "get_strategy_ledger_head returned a different strategy account",
    );
  }
  return parsed;
}

export async function settlePaperFillExact(
  client: FillSettlementRpcClient,
  arguments_: SettlePaperFillRpcArguments,
): Promise<PaperFillSettlementResult> {
  validateSettlementArguments(arguments_);
  const result = await retryExactRpcOnce(() => client.rpc(
    "settle_paper_fill",
    arguments_,
  ));
  if (result.error !== null) {
    throw new FillSettlementRpcError("settle_paper_fill", result);
  }
  const record = exactRecord(singleResult(result.data), [
    "schema",
    "settlement_id",
    "idempotency_key",
    "strategy_account_id",
    "frozen_order_plan_id",
    "order_id",
    "stage",
    "side",
    "outcome",
    "execution_price_evidence_id",
    "tax_fx_rate_evidence_id",
    "executed_at",
    "settlement_date",
    "order_quantity",
    "fill_quantity",
    "canceled_quantity",
    "official_open_price",
    "fill_price",
    "gross_notional",
    "total_fees",
    "cash_effect",
    "tax_reserve_effect",
    "buying_power_before",
    "frozen_buying_power_remaining_before",
    "effective_buying_power_limit",
    "buying_power_after",
    "accounting_transaction_id",
    "created_lot_origin_id",
    "pre_head_sequence",
    "pre_head_sha256",
    "post_head_sequence",
    "post_head_sha256",
    "request_sha256",
    "recorded_by",
    "recorded_at",
  ], "settle_paper_fill result");
  assertNoJsonNumber(record, "settle_paper_fill result");

  const parsed: PaperFillSettlementResult = Object.freeze({
    schema: requiredLiteral(
      record,
      "schema",
      PAPER_FILL_SETTLEMENT_RESULT_SCHEMA,
    ),
    settlement_id: requiredUuid(record, "settlement_id"),
    idempotency_key: requiredString(record, "idempotency_key"),
    strategy_account_id: requiredUuid(record, "strategy_account_id"),
    frozen_order_plan_id: requiredUuid(record, "frozen_order_plan_id"),
    order_id: requiredString(record, "order_id"),
    stage: requiredLiteral(record, "stage", "S2"),
    side: requiredLiteral(record, "side", "BUY"),
    outcome: requiredOutcome(record.outcome),
    execution_price_evidence_id: requiredUuid(
      record,
      "execution_price_evidence_id",
    ),
    tax_fx_rate_evidence_id: nullableUuid(record, "tax_fx_rate_evidence_id"),
    executed_at: requiredTimestamp(record, "executed_at"),
    settlement_date: requiredDate(record, "settlement_date"),
    order_quantity: requiredPositiveInteger(record, "order_quantity"),
    fill_quantity: requiredNonNegativeInteger(record, "fill_quantity"),
    canceled_quantity: requiredNonNegativeInteger(record, "canceled_quantity"),
    official_open_price: requiredPositiveDecimal(record, "official_open_price"),
    fill_price: requiredPositiveDecimal(record, "fill_price"),
    gross_notional: requiredNonNegativeDecimal(record, "gross_notional"),
    total_fees: requiredNonNegativeDecimal(record, "total_fees"),
    cash_effect: requiredNonNegativeDecimal(record, "cash_effect"),
    tax_reserve_effect: requiredCanonicalDecimal(record, "tax_reserve_effect"),
    buying_power_before: requiredNonNegativeDecimal(record, "buying_power_before"),
    frozen_buying_power_remaining_before: requiredNonNegativeDecimal(
      record,
      "frozen_buying_power_remaining_before",
    ),
    effective_buying_power_limit: requiredNonNegativeDecimal(
      record,
      "effective_buying_power_limit",
    ),
    buying_power_after: requiredNonNegativeDecimal(record, "buying_power_after"),
    accounting_transaction_id: nullableUuid(record, "accounting_transaction_id"),
    created_lot_origin_id: nullableUuid(record, "created_lot_origin_id"),
    pre_head_sequence: requiredNonNegativeInteger(record, "pre_head_sequence"),
    pre_head_sha256: requiredSha256(record, "pre_head_sha256"),
    post_head_sequence: requiredNonNegativeInteger(record, "post_head_sequence"),
    post_head_sha256: requiredSha256(record, "post_head_sha256"),
    request_sha256: requiredSha256(record, "request_sha256"),
    recorded_by: requiredString(record, "recorded_by"),
    recorded_at: requiredTimestamp(record, "recorded_at"),
  });

  verifySettlementIdentity(parsed, arguments_);
  verifySettlementArithmetic(parsed);
  return parsed;
}

function validateSettlementArguments(
  value: SettlePaperFillRpcArguments,
): void {
  requireIdentity(value.p_idempotency_key, "p_idempotency_key");
  requireUuid(value.p_strategy_account_id, "p_strategy_account_id");
  requireUuid(value.p_frozen_order_plan_id, "p_frozen_order_plan_id");
  requireIdentity(value.p_order_id, "p_order_id");
  requireUuid(
    value.p_execution_price_evidence_id,
    "p_execution_price_evidence_id",
  );
  if (value.p_tax_fx_rate_evidence_id !== null) {
    requireUuid(value.p_tax_fx_rate_evidence_id, "p_tax_fx_rate_evidence_id");
  }
  requireCanonicalTimestamp(value.p_executed_at, "p_executed_at");
  requireCalendarDate(value.p_settlement_date, "p_settlement_date");
  requireNonNegativeInteger(value.p_expected_head_sequence, "p_expected_head_sequence");
  requireSha256(value.p_expected_head_sha256, "p_expected_head_sha256");
  requireIdentity(value.p_recorded_by, "p_recorded_by");
}

function verifySettlementIdentity(
  result: PaperFillSettlementResult,
  arguments_: SettlePaperFillRpcArguments,
): void {
  if (
    result.idempotency_key !== arguments_.p_idempotency_key
    || result.strategy_account_id !== arguments_.p_strategy_account_id
    || result.frozen_order_plan_id !== arguments_.p_frozen_order_plan_id
    || result.order_id !== arguments_.p_order_id
    || result.execution_price_evidence_id
      !== arguments_.p_execution_price_evidence_id
    || result.executed_at !== arguments_.p_executed_at
    || result.settlement_date !== arguments_.p_settlement_date
    || result.pre_head_sequence !== arguments_.p_expected_head_sequence
    || result.pre_head_sha256 !== arguments_.p_expected_head_sha256
    || result.recorded_by !== arguments_.p_recorded_by
  ) {
    throw new TypeError(
      "settle_paper_fill returned a result inconsistent with the exact request",
    );
  }
  if (
    result.outcome === "CANCELED_CASH_LIMIT"
      ? result.tax_fx_rate_evidence_id !== null
      : result.tax_fx_rate_evidence_id === null
        || result.tax_fx_rate_evidence_id
          !== arguments_.p_tax_fx_rate_evidence_id
  ) {
    throw new TypeError(
      "settle_paper_fill returned an inconsistent acquisition FX binding",
    );
  }
}

function verifySettlementArithmetic(result: PaperFillSettlementResult): void {
  if (
    BigInt(result.fill_quantity) + BigInt(result.canceled_quantity)
      !== BigInt(result.order_quantity)
  ) {
    throw new TypeError("settle_paper_fill quantities do not conserve the order");
  }
  const expectedEffectiveLimit = compareDecimals(
    result.buying_power_before,
    result.frozen_buying_power_remaining_before,
  ) <= 0
    ? result.buying_power_before
    : result.frozen_buying_power_remaining_before;
  if (result.effective_buying_power_limit !== expectedEffectiveLimit) {
    throw new TypeError("settle_paper_fill effective buying-power limit is inconsistent");
  }
  const cashRequired = addDecimals(result.gross_notional, result.total_fees);
  if (result.cash_effect !== cashRequired) {
    throw new TypeError("settle_paper_fill cash effect does not equal notional plus fees");
  }
  if (compareDecimals(cashRequired, result.effective_buying_power_limit) > 0) {
    throw new TypeError("settle_paper_fill exceeds its effective buying-power limit");
  }
  if (
    result.buying_power_after
      !== subtractDecimals(result.buying_power_before, result.cash_effect)
  ) {
    throw new TypeError("settle_paper_fill buying power does not reconcile");
  }
  if (BigInt(result.post_head_sequence) !== BigInt(result.pre_head_sequence) + 1n) {
    throw new TypeError("settle_paper_fill did not advance the ledger head exactly once");
  }
  if (result.post_head_sha256 === result.pre_head_sha256) {
    throw new TypeError("settle_paper_fill did not change the ledger head hash");
  }
  if (result.tax_reserve_effect !== "0") {
    throw new TypeError("S2 BUY settlement cannot create a tax-reserve effect");
  }

  const filled = BigInt(result.fill_quantity);
  const canceled = BigInt(result.canceled_quantity);
  if (
    filled > 0n
    && result.gross_notional
      !== multiplyDecimals(result.fill_price, result.fill_quantity)
  ) {
    throw new TypeError("settle_paper_fill gross notional does not equal price times quantity");
  }
  if (result.outcome === "FILLED" && canceled !== 0n) {
    throw new TypeError("FILLED settlement cannot cancel shares");
  }
  if (
    result.outcome === "PARTIALLY_FILLED_CASH_LIMIT"
    && (filled === 0n || canceled === 0n)
  ) {
    throw new TypeError("PARTIALLY_FILLED_CASH_LIMIT requires fill and cancel quantities");
  }
  if (result.outcome === "CANCELED_CASH_LIMIT") {
    if (
      filled !== 0n
      || result.gross_notional !== "0"
      || result.total_fees !== "0"
      || result.cash_effect !== "0"
      || result.tax_reserve_effect !== "0"
      || result.accounting_transaction_id !== null
      || result.created_lot_origin_id !== null
      || result.tax_fx_rate_evidence_id !== null
    ) {
      throw new TypeError("CANCELED_CASH_LIMIT must not fabricate a fill or journal");
    }
  } else if (
    result.accounting_transaction_id === null
    || result.created_lot_origin_id === null
    || result.tax_fx_rate_evidence_id === null
  ) {
    throw new TypeError(
      "a positive BUY fill requires its journal, FIFO lot, and acquisition FX",
    );
  }
}

function singleResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new TypeError("RPC must return exactly one result");
    return value[0];
  }
  return value;
}

function parseStrategyLedgerHeadResult(
  value: unknown,
  field: string,
): StrategyLedgerHeadResult {
  const record = exactRecord(singleResult(value), [
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
  ], field);
  assertNoJsonNumber(record, field);
  const parsed: StrategyLedgerHeadResult = Object.freeze({
    schema: requiredLiteral(
      record,
      "schema",
      STRATEGY_LEDGER_HEAD_RESULT_SCHEMA,
    ),
    strategyAccountId: requiredUuid(record, "strategyAccountId"),
    headSequence: requiredNonNegativeInteger(record, "headSequence"),
    headSha256: requiredSha256(record, "headSha256"),
    lastSettlementId: nullableUuid(record, "lastSettlementId"),
    accountingTransactionCount: requiredNonNegativeInteger(
      record,
      "accountingTransactionCount",
    ),
    lotOriginCount: requiredNonNegativeInteger(record, "lotOriginCount"),
    acquisitionFxBindingCount: requiredNonNegativeInteger(
      record,
      "acquisitionFxBindingCount",
    ),
    settlementCount: requiredNonNegativeInteger(record, "settlementCount"),
    corporateActionMutationCount: requiredNonNegativeInteger(
      record,
      "corporateActionMutationCount",
    ),
    initializedBy: requiredString(record, "initializedBy"),
    initializedAt: requiredTimestamp(record, "initializedAt"),
    updatedAt: requiredTimestamp(record, "updatedAt"),
  });
  if (BigInt(parsed.headSequence) !== BigInt(parsed.settlementCount)
    + BigInt(parsed.corporateActionMutationCount)) {
    throw new TypeError(`${field} sequence does not match ledger mutation counts`);
  }
  if (BigInt(parsed.accountingTransactionCount) < 1n) {
    throw new TypeError(`${field} must include the opening accounting transaction`);
  }
  if (parsed.lotOriginCount !== parsed.acquisitionFxBindingCount) {
    throw new TypeError(`${field} has an unbound acquisition FX lot`);
  }
  if (
    BigInt(parsed.accountingTransactionCount)
      !== BigInt(parsed.lotOriginCount) + 1n
    || BigInt(parsed.lotOriginCount) > BigInt(parsed.settlementCount)
  ) {
    throw new TypeError(`${field} integrity counters do not describe v1 S2 settlement`);
  }
  if ((parsed.settlementCount === "0") !== (parsed.lastSettlementId === null)) {
    throw new TypeError(`${field} last settlement identity is inconsistent`);
  }
  if (Date.parse(parsed.updatedAt) < Date.parse(parsed.initializedAt)) {
    throw new TypeError(`${field} update time predates initialization`);
  }
  return parsed;
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
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${field} has unexpected or missing fields`);
  }
  return record;
}

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number" || typeof value === "bigint") {
    throw new TypeError(`${field} contains a numeric token`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumber(item, `${field}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertNoJsonNumber(nested, `${field}.${key}`);
    }
  }
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  requireIdentity(value, field);
  return value;
}

function requiredLiteral<T extends string>(
  record: Record<string, unknown>,
  field: string,
  literal: T,
): T {
  if (record[field] !== literal) throw new TypeError(`${field} must be ${literal}`);
  return literal;
}

function requiredOutcome(value: unknown): PaperFillOutcome {
  if (
    value !== "FILLED"
    && value !== "PARTIALLY_FILLED_CASH_LIMIT"
    && value !== "CANCELED_CASH_LIMIT"
  ) {
    throw new TypeError("outcome is unsupported");
  }
  return value;
}

function requiredUuid(record: Record<string, unknown>, field: string): string {
  const value = requiredString(record, field);
  requireUuid(value, field);
  return value;
}

function nullableUuid(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be a UUID or null`);
  requireUuid(value, field);
  return value;
}

function requiredSha256(record: Record<string, unknown>, field: string): string {
  const value = requiredString(record, field);
  requireSha256(value, field);
  return value;
}

function requiredNonNegativeInteger(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = requiredString(record, field);
  requireNonNegativeInteger(value, field);
  return value;
}

function requiredPositiveInteger(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = requiredNonNegativeInteger(record, field);
  if (value === "0") throw new TypeError(`${field} must be positive`);
  return value;
}

function requiredCanonicalDecimal(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = requiredString(record, field);
  if (normalizeDecimal(value) !== value) {
    throw new TypeError(`${field} must be a canonical decimal string`);
  }
  return value;
}

function requiredNonNegativeDecimal(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = requiredCanonicalDecimal(record, field);
  if (compareDecimals(value, "0") < 0) {
    throw new TypeError(`${field} must be non-negative`);
  }
  return value;
}

function requiredPositiveDecimal(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = requiredNonNegativeDecimal(record, field);
  if (value === "0") throw new TypeError(`${field} must be positive`);
  return value;
}

function requiredTimestamp(record: Record<string, unknown>, field: string): string {
  const value = requiredString(record, field);
  requireCanonicalTimestamp(value, field);
  return value;
}

function requiredDate(record: Record<string, unknown>, field: string): string {
  const value = requiredString(record, field);
  requireCalendarDate(value, field);
  return value;
}

function requireIdentity(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a UUID in canonical lowercase form`);
  }
}

function requireSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
}

function requireNonNegativeInteger(value: string, field: string): void {
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative integer string`);
  }
}

function requireCalendarDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a real calendar date`);
  }
}

function requireCanonicalTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a canonical ISO UTC timestamp`);
  }
}
