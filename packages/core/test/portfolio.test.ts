import { describe, expect, it } from "vitest";

import {
  createOpeningLedgerTransactions,
  parseInitialPortfolioSnapshot,
  validateInitialPortfolioSnapshot,
} from "../src/portfolio.js";

function snapshot() {
  return validateInitialPortfolioSnapshot({
    snapshotId: "statement-2026-08-24",
    schema: "twofold.initial_portfolio/v1",
    asOf: "2026-08-24T00:00:00.000Z",
    brokerLegalEntity: "FUTU_HK",
    accountRegion: "HK",
    baseCurrency: "USD",
    sourceArtifactSha256: "a".repeat(64),
    cashBalances: [{ currency: "USD", settledCash: "100.01", unsettledCash: "0" }],
    lots: [
      {
        lotId: "later-lot",
        instrumentId: "instrument-lulu",
        symbol: "LULU",
        acquiredOn: "2025-02-01",
        quantity: "2",
        purchasePricePerShare: "300.1",
        buyFees: "1.23",
        currency: "USD",
      },
      {
        lotId: "earlier-lot",
        instrumentId: "instrument-lulu",
        symbol: "LULU",
        acquiredOn: "2024-01-01",
        quantity: "1",
        purchasePricePerShare: "400",
        buyFees: "0.99",
        currency: "USD",
      },
    ],
  });
}

describe("initial portfolio import contract", () => {
  it("normalizes tax basis and assigns deterministic FIFO sequence", () => {
    const result = snapshot();
    expect(result.lots.map((lot) => ({
      id: lot.lotId,
      sequence: lot.acquisitionSequence,
      gross: lot.grossPurchasePrice,
      basis: lot.taxBasis,
    }))).toEqual([
      { id: "earlier-lot", sequence: "1", gross: "400", basis: "400.99" },
      { id: "later-lot", sequence: "2", gross: "600.2", basis: "601.43" },
    ]);
  });

  it("creates isolated, balanced opening entries for a Strategy Run", () => {
    const transactions = createOpeningLedgerTransactions({
      runId: "run-a",
      sourceEventId: "event-opening-a",
      snapshot: snapshot(),
    });
    expect(transactions).toHaveLength(3);
    expect(transactions.map((transaction) => transaction.transactionId)).toEqual([
      "run-a:opening:cash:USD:settled",
      "run-a:opening:lot:earlier-lot",
      "run-a:opening:lot:later-lot",
    ]);
    expect(transactions[1]?.postings[0]).toMatchObject({
      amount: "400.99",
      instrumentId: "instrument-lulu",
      quantity: "1",
    });
  });

  it("fails closed on duplicate lots, future acquisitions, and unverifiable sources", () => {
    const base = {
      snapshotId: "bad",
      schema: "twofold.initial_portfolio/v1" as const,
      asOf: "2026-08-24T00:00:00.000Z",
      brokerLegalEntity: "FUTU_HK",
      accountRegion: "HK",
      baseCurrency: "USD",
      sourceArtifactSha256: "b".repeat(64),
      cashBalances: [] as const,
    };
    const lot = {
      lotId: "duplicate",
      instrumentId: "instrument-lulu",
      symbol: "LULU",
      acquiredOn: "2026-08-25",
      quantity: "1",
      purchasePricePerShare: "1",
      buyFees: "0",
      currency: "USD",
    };
    expect(() => validateInitialPortfolioSnapshot({ ...base, lots: [lot] })).toThrow(
      "acquired after snapshot",
    );
    expect(() => validateInitialPortfolioSnapshot({
      ...base,
      sourceArtifactSha256: "not-a-hash",
      lots: [{ ...lot, acquiredOn: "2026-08-23" }],
    })).toThrow("sourceArtifactSha256");
    expect(() => validateInitialPortfolioSnapshot({
      ...base,
      lots: [
        { ...lot, acquiredOn: "2026-08-23" },
        { ...lot, acquiredOn: "2026-08-22" },
      ],
    })).toThrow("Duplicate lotId");
    expect(() => validateInitialPortfolioSnapshot({
      ...base,
      lots: [{ ...lot, acquiredOn: "2026-08-23", quantity: "0.5" }],
    })).toThrow("canonical positive integer string");
    expect(() => validateInitialPortfolioSnapshot({
      ...base,
      lots: [{
        ...lot,
        acquiredOn: "2026-08-23",
        purchasePricePerShare: "0",
      }],
    })).toThrow("purchasePricePerShare must be positive");
  });

  it("rejects JSON numbers and extra fields at the import boundary", () => {
    const valid = {
      snapshotId: "statement",
      schema: "twofold.initial_portfolio/v1",
      asOf: "2026-08-24T00:00:00.000Z",
      brokerLegalEntity: "FUTU_HK",
      accountRegion: "HK",
      baseCurrency: "USD",
      sourceArtifactSha256: "c".repeat(64),
      cashBalances: [{ currency: "USD", settledCash: "1", unsettledCash: "0" }],
      lots: [],
    };
    expect(parseInitialPortfolioSnapshot(valid).cashBalances[0]?.settledCash).toBe("1");
    expect(() => parseInitialPortfolioSnapshot({
      ...valid,
      cashBalances: [{ currency: "USD", settledCash: 1, unsettledCash: "0" }],
    })).toThrow("settledCash must be a string");
    expect(() => parseInitialPortfolioSnapshot({ ...valid, unexpected: true })).toThrow(
      "unexpected or missing fields",
    );
  });
});
