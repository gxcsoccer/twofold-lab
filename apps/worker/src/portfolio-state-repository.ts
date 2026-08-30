import { compareDecimals, subtractDecimals } from "@twofold/core";

import type { ArenaPortfolioState } from "./arena-inputs.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

export const STRATEGY_PORTFOLIO_STATE_SCHEMA =
  "twofold.strategy_portfolio_state/v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface StrategyPortfolioStateRpcClient {
  rpc(
    functionName: "get_strategy_portfolio_state",
    arguments_: { readonly p_run_id: string },
  ): PromiseLike<RpcResult>;
}

/**
 * Load the account and all financial values through one database statement.
 * The RPC serializes NUMERIC/BIGINT as strings, so no JavaScript floating point
 * value can silently alter a portfolio shown to the Agent.
 */
export async function loadArenaPortfolioState(
  client: StrategyPortfolioStateRpcClient,
  runId: string,
): Promise<ArenaPortfolioState> {
  uuid(runId, "runId");
  const result = await retryExactRpcOnce(() => client.rpc(
    "get_strategy_portfolio_state",
    { p_run_id: runId },
  ));
  if (result.error !== null) {
    throw new Error(
      `get_strategy_portfolio_state failed: ${result.error?.message ?? "unknown RPC error"}`,
    );
  }
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  assertNoJsonNumber(raw, "get_strategy_portfolio_state result");
  const parsed = parseArenaPortfolioState(raw);
  if (parsed.runId !== runId) {
    throw new TypeError("get_strategy_portfolio_state returned a different Run");
  }
  return deepFreeze(parsed);
}

export function parseArenaPortfolioState(value: unknown): ArenaPortfolioState {
  const row = exactRecord(value, [
    "schema",
    "strategyAccountId",
    "runId",
    "asOf",
    "account",
    "ledgerHead",
    "cash",
    "positions",
  ], "portfolio state");
  if (row.schema !== STRATEGY_PORTFOLIO_STATE_SCHEMA) {
    throw new TypeError("unsupported strategy portfolio state schema");
  }

  const accountRow = exactRecord(row.account, [
    "accountCode",
    "broker",
    "brokerRegion",
    "baseCurrency",
    "liveTrading",
  ], "portfolio account");
  if (accountRow.liveTrading !== false) {
    throw new TypeError("strategy portfolio state cannot enable live trading");
  }
  const account = {
    accountCode: identity(accountRow.accountCode, "account.accountCode"),
    broker: identity(accountRow.broker, "account.broker"),
    brokerRegion: identity(accountRow.brokerRegion, "account.brokerRegion"),
    baseCurrency: currency(accountRow.baseCurrency, "account.baseCurrency"),
    liveTrading: false as const,
  };

  const headRow = exactRecord(row.ledgerHead, [
    "sequence",
    "sha256",
    "accountingTransactionCount",
    "lotOriginCount",
    "acquisitionFxBindingCount",
    "settlementCount",
    "corporateActionMutationCount",
  ], "portfolio ledger head");
  const ledgerHead = {
    sequence: integer(headRow.sequence, "ledgerHead.sequence"),
    sha256: sha256(headRow.sha256, "ledgerHead.sha256"),
    accountingTransactionCount: integer(
      headRow.accountingTransactionCount,
      "ledgerHead.accountingTransactionCount",
    ),
    lotOriginCount: integer(headRow.lotOriginCount, "ledgerHead.lotOriginCount"),
    acquisitionFxBindingCount: integer(
      headRow.acquisitionFxBindingCount,
      "ledgerHead.acquisitionFxBindingCount",
    ),
    settlementCount: integer(
      headRow.settlementCount,
      "ledgerHead.settlementCount",
    ),
    corporateActionMutationCount: integer(
      headRow.corporateActionMutationCount,
      "ledgerHead.corporateActionMutationCount",
    ),
  };
  if (BigInt(ledgerHead.sequence) !== BigInt(ledgerHead.settlementCount)
    + BigInt(ledgerHead.corporateActionMutationCount)) {
    throw new TypeError("strategy portfolio ledger sequence does not reconcile");
  }
  if (ledgerHead.lotOriginCount !== ledgerHead.acquisitionFxBindingCount) {
    throw new TypeError("strategy portfolio ledger has an unbound acquisition FX lot");
  }
  if (ledgerHead.accountingTransactionCount === "0") {
    throw new TypeError("strategy portfolio ledger has no opening transaction");
  }

  const cashRow = exactRecord(row.cash, [
    "settled",
    "taxReserve",
    "buyingPower",
  ], "portfolio cash");
  const cash = {
    settled: nonNegativeDecimal(cashRow.settled, "cash.settled"),
    taxReserve: nonNegativeDecimal(cashRow.taxReserve, "cash.taxReserve"),
    buyingPower: nonNegativeDecimal(cashRow.buyingPower, "cash.buyingPower"),
  };
  if (
    compareDecimals(cash.taxReserve, cash.settled) > 0
    || subtractDecimals(cash.settled, cash.taxReserve) !== cash.buyingPower
  ) {
    throw new TypeError("strategy portfolio cash and buying power do not reconcile");
  }

  if (!Array.isArray(row.positions)) {
    throw new TypeError("portfolio positions must be an array");
  }
  const seenInstruments = new Set<string>();
  const seenSymbols = new Set<string>();
  const positions = row.positions.map((item, index) => {
    const position = exactRecord(item, [
      "instrumentId",
      "symbol",
      "quantity",
      "grossCost",
      "taxBasis",
      "currency",
      "lotCount",
    ], `portfolio positions[${index}]`);
    const instrumentId = uuid(position.instrumentId, `positions[${index}].instrumentId`);
    const symbol = ticker(position.symbol, `positions[${index}].symbol`);
    if (seenInstruments.has(instrumentId) || seenSymbols.has(symbol)) {
      throw new TypeError("strategy portfolio positions are not unique");
    }
    seenInstruments.add(instrumentId);
    seenSymbols.add(symbol);
    const parsed = {
      instrumentId,
      symbol,
      quantity: positiveDecimal(position.quantity, `positions[${index}].quantity`),
      grossCost: nonNegativeDecimal(position.grossCost, `positions[${index}].grossCost`),
      taxBasis: nonNegativeDecimal(position.taxBasis, `positions[${index}].taxBasis`),
      currency: currency(position.currency, `positions[${index}].currency`),
      lotCount: integer(position.lotCount, `positions[${index}].lotCount`),
    };
    if (parsed.lotCount === "0" || parsed.currency !== account.baseCurrency) {
      throw new TypeError("strategy portfolio position has invalid lot or currency state");
    }
    return parsed;
  });
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index - 1]!.symbol >= positions[index]!.symbol) {
      throw new TypeError("strategy portfolio positions are not canonically ordered");
    }
  }

  return {
    schema: STRATEGY_PORTFOLIO_STATE_SCHEMA,
    strategyAccountId: uuid(row.strategyAccountId, "strategyAccountId"),
    runId: uuid(row.runId, "runId"),
    asOf: timestamp(row.asOf, "asOf"),
    account,
    ledgerHead,
    cash,
    positions,
  };
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
  const expected = new Set(keys);
  if (
    Object.keys(row).length !== keys.length
    || keys.some((key) => !Object.hasOwn(row, key))
    || Object.keys(row).some((key) => !expected.has(key))
  ) {
    throw new TypeError(`${field} has an unexpected shape`);
  }
  return row;
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

function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256`);
  return parsed;
}

function integer(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!INTEGER_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
  return parsed;
}

function nonNegativeDecimal(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!DECIMAL_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a canonical non-negative decimal`);
  }
  return parsed;
}

function positiveDecimal(value: unknown, field: string): string {
  const parsed = nonNegativeDecimal(value, field);
  if (compareDecimals(parsed, "0") <= 0) {
    throw new TypeError(`${field} must be positive`);
  }
  return parsed;
}

function ticker(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(parsed)) {
    throw new TypeError(`${field} must be an uppercase ticker`);
  }
  return parsed;
}

function currency(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^[A-Z]{3}$/.test(parsed)) throw new TypeError(`${field} must be a currency`);
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || new Date(parsed).toISOString() !== parsed
  ) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function assertNoJsonNumber(value: unknown, path: string): void {
  if (typeof value === "number") throw new TypeError(`${path} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumber(item, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertNoJsonNumber(nested, `${path}.${key}`);
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
