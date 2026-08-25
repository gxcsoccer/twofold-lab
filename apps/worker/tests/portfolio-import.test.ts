import { describe, expect, it } from "vitest";

import {
  sha256Hex,
  validatePortfolioArtifacts,
} from "../src/portfolio-import.js";

const sourceBytes = Buffer.from(
  "FUTU statement export\nLULU,2024-01-02,2,100.00\n",
  "utf8",
);

function snapshotJson(sourceArtifactSha256 = sha256Hex(sourceBytes)): string {
  return JSON.stringify({
    snapshotId: "futu-statement-2026-08-24",
    schema: "twofold.initial_portfolio/v1",
    asOf: "2026-08-24T00:00:00.000Z",
    brokerLegalEntity: "FUTU_HK",
    accountRegion: "HK",
    baseCurrency: "USD",
    sourceArtifactSha256,
    cashBalances: [{
      currency: "USD",
      settledCash: "100.01",
      unsettledCash: "0",
    }],
    lots: [{
      lotId: "futu-lulu-2024-01-02-1",
      instrumentId: "instrument-lulu",
      symbol: "LULU",
      acquiredOn: "2024-01-02",
      quantity: "2",
      purchasePricePerShare: "100",
      buyFees: "1.99",
      currency: "USD",
    }],
  });
}

describe("real portfolio artifact validation", () => {
  it("binds the normalized snapshot to exact source bytes and replays opening entries", () => {
    expect(validatePortfolioArtifacts({
      snapshotJsonText: snapshotJson(),
      sourceBytes,
    })).toEqual({
      snapshotId: "futu-statement-2026-08-24",
      asOf: "2026-08-24T00:00:00.000Z",
      brokerLegalEntity: "FUTU_HK",
      accountRegion: "HK",
      baseCurrency: "USD",
      sourceArtifactSha256: sha256Hex(sourceBytes),
      sourceByteSize: sourceBytes.byteLength.toString(),
      cashCurrencies: ["USD"],
      lotCount: "1",
      positions: [{
        instrumentId: "instrument-lulu",
        symbol: "LULU",
        quantity: "2",
        lotCount: "1",
      }],
      openingTransactionCount: "2",
      ledgerPositionCount: "1",
    });
  });

  it("fails closed on source mismatch, numeric JSON money, and fractional shares", () => {
    expect(() => validatePortfolioArtifacts({
      snapshotJsonText: snapshotJson("a".repeat(64)),
      sourceBytes,
    })).toThrow("source artifact SHA-256 mismatch");

    const numericMoney = JSON.parse(snapshotJson()) as Record<string, unknown>;
    numericMoney.cashBalances = [{
      currency: "USD",
      settledCash: 100.01,
      unsettledCash: "0",
    }];
    expect(() => validatePortfolioArtifacts({
      snapshotJsonText: JSON.stringify(numericMoney),
      sourceBytes,
    })).toThrow("settledCash must be a string");

    const fractional = JSON.parse(snapshotJson()) as {
      lots: Array<Record<string, unknown>>;
    };
    fractional.lots[0]!.quantity = "0.5";
    expect(() => validatePortfolioArtifacts({
      snapshotJsonText: JSON.stringify(fractional),
      sourceBytes,
    })).toThrow("canonical positive integer string");
  });
});
