import { describe, expect, it } from "vitest";

import { createLedgerTransaction, replayLedger } from "../src/ledger.js";

function buyTransaction() {
  return createLedgerTransaction({
    transactionId: "tx-buy-lulu",
    idempotencyKey: "fill:lulu-buy-1",
    sourceEventId: "event-fill-1",
    eventTime: "2026-08-24T13:30:00.000Z",
    effectiveDate: "2026-08-24",
    description: "Buy 10 LULU shares and recognize the fill fee",
    postings: [
      {
        postingId: "position-cost",
        accountId: "asset:position-cost:LULU",
        accountKind: "ASSET",
        side: "DEBIT",
        amount: "1000",
        currency: "USD",
        instrumentId: "instrument-lulu",
        quantity: "10",
      },
      {
        postingId: "fee-expense",
        accountId: "expense:broker-fee",
        accountKind: "EXPENSE",
        side: "DEBIT",
        amount: "2.29",
        currency: "USD",
      },
      {
        postingId: "cash",
        accountId: "asset:cash",
        accountKind: "ASSET",
        side: "CREDIT",
        amount: "1002.29",
        currency: "USD",
      },
    ],
  });
}

function openingCashTransaction() {
  return createLedgerTransaction({
    transactionId: "tx-opening-cash",
    idempotencyKey: "opening:cash",
    sourceEventId: "event-opening-cash",
    eventTime: "2026-08-24T00:00:00.000Z",
    effectiveDate: "2026-08-24",
    description: "Opening paper cash",
    postings: [
      {
        postingId: "cash",
        accountId: "asset:cash",
        accountKind: "ASSET",
        side: "DEBIT",
        amount: "2000",
        currency: "USD",
      },
      {
        postingId: "equity",
        accountId: "equity:opening",
        accountKind: "EQUITY",
        side: "CREDIT",
        amount: "2000",
        currency: "USD",
      },
    ],
  });
}

function sellTransaction(quantity = "4") {
  return createLedgerTransaction({
    transactionId: `tx-sell-lulu-${quantity}`,
    idempotencyKey: `fill:lulu-sell-${quantity}`,
    sourceEventId: `event-fill-sell-${quantity}`,
    eventTime: "2026-08-25T13:30:00.000Z",
    effectiveDate: "2026-08-25",
    description: `Sell ${quantity} LULU shares`,
    postings: [
      {
        postingId: "cash",
        accountId: "asset:cash",
        accountKind: "ASSET",
        side: "DEBIT",
        amount: "400",
        currency: "USD",
      },
      {
        postingId: "position-cost",
        accountId: "asset:position-cost:LULU",
        accountKind: "ASSET",
        side: "CREDIT",
        amount: "400",
        currency: "USD",
        instrumentId: "instrument-lulu",
        quantity,
      },
    ],
  });
}

describe("immutable balanced ledger", () => {
  it("accepts a balanced multi-posting fill without binary floating point", () => {
    const transaction = buyTransaction();
    expect(transaction.postings.map((posting) => posting.amount)).toEqual([
      "1000",
      "2.29",
      "1002.29",
    ]);
    expect(Object.isFrozen(transaction)).toBe(true);
    expect(Object.isFrozen(transaction.postings)).toBe(true);
  });

  it("fails closed when any currency is not independently balanced", () => {
    expect(() => createLedgerTransaction({
      transactionId: "tx-unbalanced",
      idempotencyKey: "tx-unbalanced",
      sourceEventId: "event-unbalanced",
      eventTime: "2026-08-24T13:30:00Z",
      effectiveDate: "2026-08-24",
      description: "Invalid transaction",
      postings: [
        {
          postingId: "debit",
          accountId: "asset:cash",
          accountKind: "ASSET",
          side: "DEBIT",
          amount: "10",
          currency: "USD",
        },
        {
          postingId: "credit",
          accountId: "equity:opening",
          accountKind: "EQUITY",
          side: "CREDIT",
          amount: "9.99",
          currency: "USD",
        },
      ],
    })).toThrow("not balanced for USD");
  });

  it("rejects an impossible event timestamp instead of accepting JS date rollover", () => {
    expect(() => createLedgerTransaction({
      ...openingCashTransaction(),
      eventTime: "2026-02-31T00:00:00Z",
    })).toThrow("eventTime must be an ISO UTC timestamp");
  });

  it("projects normal account balances deterministically", () => {
    const projection = replayLedger([openingCashTransaction(), buyTransaction()]);
    expect(projection.transactionCount).toBe("2");
    expect(projection.balances).toEqual([
      expect.objectContaining({ accountId: "asset:cash", amount: "997.71" }),
      expect.objectContaining({ accountId: "asset:position-cost:LULU", amount: "1000" }),
      expect.objectContaining({ accountId: "equity:opening", amount: "2000" }),
      expect.objectContaining({ accountId: "expense:broker-fee", amount: "2.29" }),
    ]);
    expect(projection.positions).toEqual([{
      accountId: "asset:position-cost:LULU",
      instrumentId: "instrument-lulu",
      quantity: "10",
    }]);
    expect(Object.isFrozen(projection.positions)).toBe(true);
  });

  it("projects DEBIT as an increase and CREDIT as a decrease", () => {
    const projection = replayLedger([
      openingCashTransaction(),
      buyTransaction(),
      sellTransaction(),
    ]);
    expect(projection.positions).toEqual([{
      accountId: "asset:position-cost:LULU",
      instrumentId: "instrument-lulu",
      quantity: "6",
    }]);
  });

  it("fails closed after a transaction would create a short position", () => {
    expect(() => replayLedger([
      openingCashTransaction(),
      buyTransaction(),
      sellTransaction("11"),
    ])).toThrow("would create a negative position");
  });

  it("fails closed when a balanced buy would overdraw paper cash", () => {
    expect(() => replayLedger([buyTransaction()])).toThrow(
      "would create a negative asset balance for asset:cash/USD",
    );
  });

  it("rejects replay duplicates instead of double-posting imported fills", () => {
    const transaction = buyTransaction();
    expect(() => replayLedger([
      openingCashTransaction(),
      transaction,
      transaction,
    ])).toThrow(
      "Duplicate transactionId",
    );
  });

  it("revalidates deserialized transactions before replaying balances", () => {
    const invalid = {
      ...buyTransaction(),
      postings: [buyTransaction().postings[0]],
    } as unknown as ReturnType<typeof buyTransaction>;
    expect(() => replayLedger([invalid])).toThrow(
      "at least two postings",
    );
  });

  it("rejects a deserialized transaction with an unknown account kind", () => {
    const transaction = buyTransaction();
    const invalid = {
      ...transaction,
      postings: transaction.postings.map((posting, index) => (
        index === 1 ? { ...posting, accountKind: "BOGUS" } : posting
      )),
    } as unknown as ReturnType<typeof buyTransaction>;

    expect(() => replayLedger([invalid])).toThrow(
      "accountKind must be one of",
    );
  });

  it("rejects a deserialized transaction with an unknown ledger side", () => {
    const transaction = buyTransaction();
    const invalid = {
      ...transaction,
      postings: transaction.postings.map((posting, index) => (
        index === 1 ? { ...posting, side: "BOGUS" } : posting
      )),
    } as unknown as ReturnType<typeof buyTransaction>;

    expect(() => replayLedger([invalid])).toThrow(
      "side must be DEBIT or CREDIT",
    );
  });

  it("requires quantity and stable instrument identity together", () => {
    expect(() => createLedgerTransaction({
      transactionId: "tx-bad-instrument",
      idempotencyKey: "tx-bad-instrument",
      sourceEventId: "event-bad-instrument",
      eventTime: "2026-08-24T13:30:00Z",
      effectiveDate: "2026-08-24",
      description: "Invalid instrument posting",
      postings: [
        {
          postingId: "debit",
          accountId: "asset:position-cost:LULU",
          accountKind: "ASSET",
          side: "DEBIT",
          amount: "10",
          currency: "USD",
          instrumentId: "instrument-lulu",
        },
        {
          postingId: "credit",
          accountId: "asset:cash",
          accountKind: "ASSET",
          side: "CREDIT",
          amount: "10",
          currency: "USD",
        },
      ],
    })).toThrow("instrumentId and quantity together");
  });

  it.each(["0", "-1", "1.5", "1.0", "01", "+1", " 1"])(
    "rejects non-canonical security quantity %s",
    (quantity) => {
      const transaction = buyTransaction();
      const postings = transaction.postings.map((posting) => (
        posting.instrumentId === undefined ? posting : { ...posting, quantity }
      ));
      expect(() => createLedgerTransaction({ ...transaction, postings })).toThrow(
        "canonical positive integer string",
      );
    },
  );

  it("rejects numeric security quantities even when they are whole and positive", () => {
    const transaction = buyTransaction();
    const postings = transaction.postings.map((posting) => (
      posting.instrumentId === undefined
        ? posting
        : { ...posting, quantity: 10 as unknown as string }
    ));
    expect(() => createLedgerTransaction({ ...transaction, postings })).toThrow(
      "canonical positive integer string",
    );
  });

  it("only permits instrument postings on ASSET accounts", () => {
    const transaction = buyTransaction();
    const postings = transaction.postings.map((posting) => (
      posting.instrumentId === undefined
        ? posting
        : { ...posting, accountKind: "EXPENSE" as const }
    ));
    expect(() => createLedgerTransaction({ ...transaction, postings })).toThrow(
      "must use accountKind ASSET",
    );
  });

  it("forbids quantity when no instrument identity is present", () => {
    const transaction = buyTransaction();
    const postings = transaction.postings.map((posting) => (
      posting.postingId === "cash" ? { ...posting, quantity: "1" } : posting
    ));
    expect(() => createLedgerTransaction({ ...transaction, postings })).toThrow(
      "instrumentId and quantity together",
    );
  });
});
