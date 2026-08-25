import {
  addDecimals,
  compareDecimals,
  negateDecimal,
  normalizeDecimal,
  type DecimalInput,
} from "./fixed-decimal.js";
import {
  currency,
  decimal,
  type CurrencyCode,
  type DecimalString,
} from "./decimal.js";

export const LEDGER_ACCOUNT_KINDS = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "INCOME",
  "EXPENSE",
] as const;
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];

export type LedgerSide = "DEBIT" | "CREDIT";

export interface LedgerPostingInput {
  readonly postingId: string;
  readonly accountId: string;
  readonly accountKind: LedgerAccountKind;
  readonly side: LedgerSide;
  readonly amount: DecimalInput;
  readonly currency: string;
  readonly instrumentId?: string;
  readonly quantity?: DecimalInput;
  readonly memo?: string;
}

export interface LedgerPosting {
  readonly postingId: string;
  readonly accountId: string;
  readonly accountKind: LedgerAccountKind;
  readonly side: LedgerSide;
  readonly amount: DecimalString;
  readonly currency: CurrencyCode;
  readonly instrumentId?: string;
  readonly quantity?: DecimalString;
  readonly memo?: string;
}

export interface LedgerTransactionInput {
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly sourceEventId: string;
  readonly eventTime: string;
  readonly effectiveDate: string;
  readonly description: string;
  readonly postings: readonly LedgerPostingInput[];
}

export interface LedgerTransaction {
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly sourceEventId: string;
  readonly eventTime: string;
  readonly effectiveDate: string;
  readonly description: string;
  readonly postings: readonly LedgerPosting[];
}

export interface LedgerBalance {
  readonly accountId: string;
  readonly accountKind: LedgerAccountKind;
  readonly currency: CurrencyCode;
  /** Positive values are in the account's normal balance direction. */
  readonly amount: DecimalString;
}

export interface LedgerPosition {
  readonly accountId: string;
  readonly instrumentId: string;
  /** Security units held in the account. V1 only supports whole shares. */
  readonly quantity: DecimalString;
}

export interface LedgerProjection {
  readonly transactionCount: string;
  readonly balances: readonly LedgerBalance[];
  readonly positions: readonly LedgerPosition[];
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim() === "") throw new TypeError(`${field} must be non-empty`);
}

function requireIsoTimestamp(value: string): void {
  const parsed = Date.parse(value);
  const canonicalInput = value.endsWith("Z") && !value.includes(".")
    ? `${value.slice(0, -1)}.000Z`
    : value;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(parsed)
    || new Date(parsed).toISOString() !== canonicalInput
  ) {
    throw new TypeError(`eventTime must be an ISO UTC timestamp: ${value}`);
  }
}

function requireCalendarDate(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`effectiveDate must use YYYY-MM-DD: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`effectiveDate is not a calendar date: ${value}`);
  }
}

function normalSide(kind: LedgerAccountKind): LedgerSide {
  return kind === "ASSET" || kind === "EXPENSE" ? "DEBIT" : "CREDIT";
}

function postingBalanceDelta(posting: LedgerPosting): DecimalString {
  return posting.side === normalSide(posting.accountKind)
    ? posting.amount
    : negateDecimal(posting.amount);
}

function requireCanonicalPositiveIntegerQuantity(
  value: DecimalInput,
  field: string,
): DecimalString {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError(
      `${field} must be a canonical positive integer string`,
    );
  }
  return decimal(value);
}

export function createLedgerTransaction(
  input: LedgerTransactionInput,
): LedgerTransaction {
  requireNonEmpty(input.transactionId, "transactionId");
  requireNonEmpty(input.idempotencyKey, "idempotencyKey");
  requireNonEmpty(input.sourceEventId, "sourceEventId");
  requireNonEmpty(input.description, "description");
  requireIsoTimestamp(input.eventTime);
  requireCalendarDate(input.effectiveDate);
  if (input.postings.length < 2) {
    throw new TypeError("A ledger transaction requires at least two postings");
  }

  const postingIds = new Set<string>();
  const totals = new Map<string, { debit: DecimalString; credit: DecimalString }>();
  const postings = input.postings.map((posting, index): LedgerPosting => {
    requireNonEmpty(posting.postingId, `postings[${index}].postingId`);
    requireNonEmpty(posting.accountId, `postings[${index}].accountId`);
    if (!(LEDGER_ACCOUNT_KINDS as readonly string[]).includes(posting.accountKind)) {
      throw new TypeError(
        `postings[${index}].accountKind must be one of ${LEDGER_ACCOUNT_KINDS.join(", ")}`,
      );
    }
    if (posting.side !== "DEBIT" && posting.side !== "CREDIT") {
      throw new TypeError(
        `postings[${index}].side must be DEBIT or CREDIT`,
      );
    }
    if (postingIds.has(posting.postingId)) {
      throw new TypeError(`Duplicate postingId: ${posting.postingId}`);
    }
    postingIds.add(posting.postingId);

    const amount = normalizeDecimal(posting.amount);
    if (compareDecimals(amount, "0") <= 0) {
      throw new RangeError(`postings[${index}].amount must be positive`);
    }

    if ((posting.instrumentId === undefined) !== (posting.quantity === undefined)) {
      throw new TypeError(
        `postings[${index}] must provide instrumentId and quantity together`,
      );
    }
    let postingQuantity: DecimalString | undefined;
    if (posting.instrumentId !== undefined) {
      requireNonEmpty(posting.instrumentId, `postings[${index}].instrumentId`);
      if (posting.accountKind !== "ASSET") {
        throw new TypeError(
          `postings[${index}] with instrumentId must use accountKind ASSET`,
        );
      }
      postingQuantity = requireCanonicalPositiveIntegerQuantity(
        posting.quantity!,
        `postings[${index}].quantity`,
      );
    }

    const postingCurrency = currency(posting.currency);
    const current = totals.get(postingCurrency) ?? {
      debit: decimal("0"),
      credit: decimal("0"),
    };
    totals.set(postingCurrency, {
      debit: posting.side === "DEBIT"
        ? addDecimals(current.debit, amount)
        : current.debit,
      credit: posting.side === "CREDIT"
        ? addDecimals(current.credit, amount)
        : current.credit,
    });

    return Object.freeze({
      postingId: posting.postingId,
      accountId: posting.accountId,
      accountKind: posting.accountKind,
      side: posting.side,
      amount,
      currency: postingCurrency,
      ...(posting.instrumentId === undefined ? {} : {
        instrumentId: posting.instrumentId,
        quantity: postingQuantity!,
      }),
      ...(posting.memo === undefined ? {} : { memo: posting.memo }),
    });
  });

  for (const [currencyCode, total] of totals) {
    if (compareDecimals(total.debit, total.credit) !== 0) {
      throw new RangeError(
        `Ledger transaction is not balanced for ${currencyCode}: debit=${total.debit}, credit=${total.credit}`,
      );
    }
  }

  return Object.freeze({
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
    sourceEventId: input.sourceEventId,
    eventTime: input.eventTime,
    effectiveDate: input.effectiveDate,
    description: input.description,
    postings: Object.freeze(postings),
  });
}

export function replayLedger(
  transactions: readonly LedgerTransaction[],
): LedgerProjection {
  const transactionIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const balances = new Map<string, LedgerBalance>();
  const positions = new Map<string, LedgerPosition>();

  for (const candidate of transactions) {
    // Re-validate deserialized or hand-constructed values. A TypeScript type is
    // not an integrity boundary for replayed database/event payloads.
    const transaction = createLedgerTransaction(candidate);
    if (transactionIds.has(transaction.transactionId)) {
      throw new TypeError(`Duplicate transactionId: ${transaction.transactionId}`);
    }
    if (idempotencyKeys.has(transaction.idempotencyKey)) {
      throw new TypeError(`Duplicate idempotencyKey: ${transaction.idempotencyKey}`);
    }
    transactionIds.add(transaction.transactionId);
    idempotencyKeys.add(transaction.idempotencyKey);

    const changedPositionKeys = new Set<string>();
    const changedAssetBalanceKeys = new Set<string>();
    for (const posting of transaction.postings) {
      const key = `${posting.accountId}\u0000${posting.currency}`;
      const current = balances.get(key);
      if (current !== undefined && current.accountKind !== posting.accountKind) {
        throw new TypeError(
          `Account ${posting.accountId}/${posting.currency} changed kind from ${current.accountKind} to ${posting.accountKind}`,
        );
      }

      balances.set(key, Object.freeze({
        accountId: posting.accountId,
        accountKind: posting.accountKind,
        currency: posting.currency,
        amount: addDecimals(current?.amount ?? "0", postingBalanceDelta(posting)),
      }));
      if (posting.accountKind === "ASSET") {
        changedAssetBalanceKeys.add(key);
      }

      if (posting.instrumentId !== undefined) {
        const positionKey = JSON.stringify([
          posting.accountId,
          posting.instrumentId,
        ]);
        const currentPosition = positions.get(positionKey);
        const quantityDelta = posting.side === "DEBIT"
          ? posting.quantity!
          : negateDecimal(posting.quantity!);
        positions.set(positionKey, Object.freeze({
          accountId: posting.accountId,
          instrumentId: posting.instrumentId,
          quantity: addDecimals(currentPosition?.quantity ?? "0", quantityDelta),
        }));
        changedPositionKeys.add(positionKey);
      }
    }

    // Posting order inside one balanced transaction must not affect validity,
    // but every committed transaction must leave every account/instrument
    // position non-negative because the paper-only v1 does not allow shorts.
    for (const positionKey of changedPositionKeys) {
      const position = positions.get(positionKey)!;
      if (compareDecimals(position.quantity, "0") < 0) {
        throw new RangeError(
          `Transaction ${transaction.transactionId} would create a negative position for ${position.accountId}/${position.instrumentId}`,
        );
      }
    }
    // V1 paper accounts have neither margin nor asset overdrafts. Validate at
    // the transaction boundary (not posting order) so balanced multi-posting
    // entries remain order-independent.
    for (const balanceKey of changedAssetBalanceKeys) {
      const balance = balances.get(balanceKey)!;
      if (compareDecimals(balance.amount, "0") < 0) {
        throw new RangeError(
          `Transaction ${transaction.transactionId} would create a negative asset balance for ${balance.accountId}/${balance.currency}`,
        );
      }
    }
  }

  return Object.freeze({
    transactionCount: transactions.length.toString(),
    balances: Object.freeze(
      [...balances.values()].sort((left, right) => {
        const accountOrder = left.accountId.localeCompare(right.accountId);
        return accountOrder === 0
          ? left.currency.localeCompare(right.currency)
          : accountOrder;
      }),
    ),
    positions: Object.freeze(
      [...positions.values()].sort((left, right) => {
        const accountOrder = left.accountId.localeCompare(right.accountId);
        return accountOrder === 0
          ? left.instrumentId.localeCompare(right.instrumentId)
          : accountOrder;
      }),
    ),
  });
}
