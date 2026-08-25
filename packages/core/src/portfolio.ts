import {
  addDecimals,
  compareDecimals,
  multiplyDecimals,
  normalizeDecimal,
  type DecimalInput,
} from "./fixed-decimal.js";
import {
  currency,
  type CurrencyCode,
  type DecimalString,
} from "./decimal.js";
import {
  createLedgerTransaction,
  type LedgerTransaction,
} from "./ledger.js";

export const INITIAL_PORTFOLIO_SCHEMA = "twofold.initial_portfolio/v1";

export interface InitialCashBalanceInput {
  readonly currency: string;
  readonly settledCash: DecimalInput;
  readonly unsettledCash: DecimalInput;
}

export interface InitialPositionLotInput {
  readonly lotId: string;
  readonly instrumentId: string;
  readonly symbol: string;
  readonly acquiredOn: string;
  readonly quantity: DecimalInput;
  readonly purchasePricePerShare: DecimalInput;
  readonly buyFees: DecimalInput;
  readonly currency: string;
}

export interface InitialPortfolioSnapshotInput {
  readonly snapshotId: string;
  readonly schema: typeof INITIAL_PORTFOLIO_SCHEMA;
  readonly asOf: string;
  readonly brokerLegalEntity: string;
  readonly accountRegion: string;
  readonly baseCurrency: string;
  readonly sourceArtifactSha256: string;
  readonly cashBalances: readonly InitialCashBalanceInput[];
  readonly lots: readonly InitialPositionLotInput[];
}

export interface InitialCashBalance {
  readonly currency: CurrencyCode;
  readonly settledCash: DecimalString;
  readonly unsettledCash: DecimalString;
}

export interface InitialPositionLot {
  readonly lotId: string;
  readonly instrumentId: string;
  readonly symbol: string;
  readonly acquiredOn: string;
  readonly acquisitionSequence: string;
  readonly quantity: DecimalString;
  readonly purchasePricePerShare: DecimalString;
  readonly grossPurchasePrice: DecimalString;
  readonly buyFees: DecimalString;
  readonly taxBasis: DecimalString;
  readonly currency: CurrencyCode;
}

export interface InitialPortfolioSnapshot {
  readonly snapshotId: string;
  readonly schema: typeof INITIAL_PORTFOLIO_SCHEMA;
  readonly asOf: string;
  readonly brokerLegalEntity: string;
  readonly accountRegion: string;
  readonly baseCurrency: CurrencyCode;
  readonly sourceArtifactSha256: string;
  readonly cashBalances: readonly InitialCashBalance[];
  readonly lots: readonly InitialPositionLot[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type UnknownRecord = Record<string, unknown>;

function exactRecord(value: unknown, keys: readonly string[], field: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const record = value as UnknownRecord;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} has unexpected or missing fields`);
  }
  return record;
}

function stringField(record: UnknownRecord, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new TypeError(`${field}.${key} must be a string`);
  return value;
}

function arrayField(record: UnknownRecord, key: string, field: string): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new TypeError(`${field}.${key} must be an array`);
  return value;
}

function requireIdentity(value: string, field: string): void {
  if (value.trim() === "") throw new TypeError(`${field} must be non-empty`);
}

function requireNonNegative(value: DecimalInput, field: string): DecimalString {
  const normalized = normalizeDecimal(value);
  if (compareDecimals(normalized, "0") < 0) {
    throw new RangeError(`${field} must be non-negative`);
  }
  return normalized;
}

function requirePositive(value: DecimalInput, field: string): DecimalString {
  const normalized = requireNonNegative(value, field);
  if (normalized === "0") throw new RangeError(`${field} must be positive`);
  return normalized;
}

function requirePositiveInteger(value: DecimalInput, field: string): DecimalString {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError(`${field} must be a canonical positive integer string`);
  }
  return normalizeDecimal(value);
}

function requireCalendarDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a valid calendar date`);
  }
}

function requireIsoTimestamp(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError("asOf must be an ISO UTC timestamp");
  }
}

export function validateInitialPortfolioSnapshot(
  input: InitialPortfolioSnapshotInput,
): InitialPortfolioSnapshot {
  if (input.schema !== INITIAL_PORTFOLIO_SCHEMA) {
    throw new TypeError(`Unsupported initial portfolio schema: ${input.schema}`);
  }
  requireIdentity(input.snapshotId, "snapshotId");
  requireIdentity(input.brokerLegalEntity, "brokerLegalEntity");
  requireIdentity(input.accountRegion, "accountRegion");
  requireIsoTimestamp(input.asOf);
  if (!SHA256_PATTERN.test(input.sourceArtifactSha256)) {
    throw new TypeError("sourceArtifactSha256 must be a lowercase SHA-256 digest");
  }
  if (input.cashBalances.length === 0 && input.lots.length === 0) {
    throw new TypeError("initial portfolio cannot be empty");
  }

  const baseCurrency = currency(input.baseCurrency);
  const seenCurrencies = new Set<string>();
  const cashBalances = input.cashBalances.map((balance, index): InitialCashBalance => {
    const balanceCurrency = currency(balance.currency);
    if (seenCurrencies.has(balanceCurrency)) {
      throw new TypeError(`Duplicate cash currency: ${balanceCurrency}`);
    }
    seenCurrencies.add(balanceCurrency);
    return Object.freeze({
      currency: balanceCurrency,
      settledCash: requireNonNegative(
        balance.settledCash,
        `cashBalances[${index}].settledCash`,
      ),
      unsettledCash: requireNonNegative(
        balance.unsettledCash,
        `cashBalances[${index}].unsettledCash`,
      ),
    });
  }).sort((left, right) => left.currency.localeCompare(right.currency));

  const seenLots = new Set<string>();
  const lots = input.lots.map((lot, index): InitialPositionLot => {
    requireIdentity(lot.lotId, `lots[${index}].lotId`);
    requireIdentity(lot.instrumentId, `lots[${index}].instrumentId`);
    requireIdentity(lot.symbol, `lots[${index}].symbol`);
    requireCalendarDate(lot.acquiredOn, `lots[${index}].acquiredOn`);
    if (`${lot.acquiredOn}T00:00:00.000Z` > input.asOf) {
      throw new RangeError(`lots[${index}] was acquired after snapshot asOf`);
    }
    if (seenLots.has(lot.lotId)) throw new TypeError(`Duplicate lotId: ${lot.lotId}`);
    seenLots.add(lot.lotId);

    const quantity = requirePositiveInteger(
      lot.quantity,
      `lots[${index}].quantity`,
    );
    const purchasePricePerShare = requirePositive(
      lot.purchasePricePerShare,
      `lots[${index}].purchasePricePerShare`,
    );
    const buyFees = requireNonNegative(lot.buyFees, `lots[${index}].buyFees`);
    const grossPurchasePrice = multiplyDecimals(quantity, purchasePricePerShare);
    const taxBasis = addDecimals(grossPurchasePrice, buyFees);

    return Object.freeze({
      lotId: lot.lotId,
      instrumentId: lot.instrumentId,
      symbol: lot.symbol,
      acquiredOn: lot.acquiredOn,
      acquisitionSequence: "",
      quantity,
      purchasePricePerShare,
      grossPurchasePrice,
      buyFees,
      taxBasis,
      currency: currency(lot.currency),
    });
  }).sort((left, right) =>
    left.acquiredOn.localeCompare(right.acquiredOn)
    || left.lotId.localeCompare(right.lotId)
  ).map((lot, index) => Object.freeze({
    ...lot,
    acquisitionSequence: (index + 1).toString(),
  }));

  return Object.freeze({
    snapshotId: input.snapshotId,
    schema: input.schema,
    asOf: input.asOf,
    brokerLegalEntity: input.brokerLegalEntity,
    accountRegion: input.accountRegion,
    baseCurrency,
    sourceArtifactSha256: input.sourceArtifactSha256,
    cashBalances: Object.freeze(cashBalances),
    lots: Object.freeze(lots),
  });
}

/** Parse an untrusted JSON value and reject numeric JSON tokens or schema drift. */
export function parseInitialPortfolioSnapshot(value: unknown): InitialPortfolioSnapshot {
  const root = exactRecord(value, [
    "snapshotId",
    "schema",
    "asOf",
    "brokerLegalEntity",
    "accountRegion",
    "baseCurrency",
    "sourceArtifactSha256",
    "cashBalances",
    "lots",
  ], "initialPortfolio");

  const cashBalances = arrayField(root, "cashBalances", "initialPortfolio")
    .map((entry, index): InitialCashBalanceInput => {
      const record = exactRecord(
        entry,
        ["currency", "settledCash", "unsettledCash"],
        `initialPortfolio.cashBalances[${index}]`,
      );
      return {
        currency: stringField(record, "currency", `cashBalances[${index}]`),
        settledCash: stringField(record, "settledCash", `cashBalances[${index}]`),
        unsettledCash: stringField(record, "unsettledCash", `cashBalances[${index}]`),
      };
    });
  const lots = arrayField(root, "lots", "initialPortfolio")
    .map((entry, index): InitialPositionLotInput => {
      const record = exactRecord(entry, [
        "lotId",
        "instrumentId",
        "symbol",
        "acquiredOn",
        "quantity",
        "purchasePricePerShare",
        "buyFees",
        "currency",
      ], `initialPortfolio.lots[${index}]`);
      return {
        lotId: stringField(record, "lotId", `lots[${index}]`),
        instrumentId: stringField(record, "instrumentId", `lots[${index}]`),
        symbol: stringField(record, "symbol", `lots[${index}]`),
        acquiredOn: stringField(record, "acquiredOn", `lots[${index}]`),
        quantity: stringField(record, "quantity", `lots[${index}]`),
        purchasePricePerShare: stringField(
          record,
          "purchasePricePerShare",
          `lots[${index}]`,
        ),
        buyFees: stringField(record, "buyFees", `lots[${index}]`),
        currency: stringField(record, "currency", `lots[${index}]`),
      };
    });

  const schema = stringField(root, "schema", "initialPortfolio");
  if (schema !== INITIAL_PORTFOLIO_SCHEMA) {
    throw new TypeError(`Unsupported initial portfolio schema: ${schema}`);
  }
  return validateInitialPortfolioSnapshot({
    snapshotId: stringField(root, "snapshotId", "initialPortfolio"),
    schema,
    asOf: stringField(root, "asOf", "initialPortfolio"),
    brokerLegalEntity: stringField(root, "brokerLegalEntity", "initialPortfolio"),
    accountRegion: stringField(root, "accountRegion", "initialPortfolio"),
    baseCurrency: stringField(root, "baseCurrency", "initialPortfolio"),
    sourceArtifactSha256: stringField(
      root,
      "sourceArtifactSha256",
      "initialPortfolio",
    ),
    cashBalances,
    lots,
  });
}

/**
 * Build balanced opening journal entries from one validated snapshot. Each run
 * gets new transaction identities while sharing the immutable source snapshot.
 */
export function createOpeningLedgerTransactions(input: {
  readonly runId: string;
  readonly sourceEventId: string;
  readonly snapshot: InitialPortfolioSnapshot;
}): readonly LedgerTransaction[] {
  requireIdentity(input.runId, "runId");
  requireIdentity(input.sourceEventId, "sourceEventId");
  const effectiveDate = input.snapshot.asOf.slice(0, 10);
  const transactions: LedgerTransaction[] = [];

  for (const cash of input.snapshot.cashBalances) {
    for (const [cashKind, amount] of [
      ["settled", cash.settledCash],
      ["unsettled", cash.unsettledCash],
    ] as const) {
      if (amount === "0") continue;
      const transactionId = `${input.runId}:opening:cash:${cash.currency}:${cashKind}`;
      transactions.push(createLedgerTransaction({
        transactionId,
        idempotencyKey: transactionId,
        sourceEventId: input.sourceEventId,
        eventTime: input.snapshot.asOf,
        effectiveDate,
        description: `Opening ${cashKind} cash from ${input.snapshot.snapshotId}`,
        postings: [
          {
            postingId: `${transactionId}:asset`,
            accountId: `asset:cash:${cashKind}`,
            accountKind: "ASSET",
            side: "DEBIT",
            amount,
            currency: cash.currency,
          },
          {
            postingId: `${transactionId}:equity`,
            accountId: "equity:opening-balance",
            accountKind: "EQUITY",
            side: "CREDIT",
            amount,
            currency: cash.currency,
          },
        ],
      }));
    }
  }

  for (const lot of input.snapshot.lots) {
    const transactionId = `${input.runId}:opening:lot:${lot.lotId}`;
    transactions.push(createLedgerTransaction({
      transactionId,
      idempotencyKey: transactionId,
      sourceEventId: input.sourceEventId,
      eventTime: input.snapshot.asOf,
      effectiveDate,
      description: `Opening ${lot.symbol} tax lot ${lot.lotId}`,
      postings: [
        {
          postingId: `${transactionId}:asset`,
          accountId: `asset:position-cost:${lot.instrumentId}`,
          accountKind: "ASSET",
          side: "DEBIT",
          amount: lot.taxBasis,
          currency: lot.currency,
          instrumentId: lot.instrumentId,
          quantity: lot.quantity,
        },
        {
          postingId: `${transactionId}:equity`,
          accountId: "equity:opening-balance",
          accountKind: "EQUITY",
          side: "CREDIT",
          amount: lot.taxBasis,
          currency: lot.currency,
        },
      ],
    }));
  }

  return Object.freeze(transactions);
}
