import { describe, expect, it } from "vitest";

import { defineFutuFeeSchedule } from "../src/futu-fees.js";
import { calculatePortfolioLiquidation } from "../src/liquidation.js";

const zeroFees = defineFutuFeeSchedule({
  feeScheduleId: "zero-fee-liquidation-test",
  brokerLegalEntity: "SIMULATED",
  accountRegion: "TEST",
  market: "US",
  product: "US_EQUITY_ETF",
  accountTier: "TEST",
  effectiveFrom: "2026-01-01",
  currency: "USD",
  commissionPerShare: "0",
  commissionMinimumPerOrder: "0",
  platformPerShare: "0",
  platformMinimumPerOrder: "0",
  settlementPerShare: "0",
  secRateOfGrossNotional: "0",
  secMinimumPerOrder: "0",
  finraTafPerShare: "0",
  finraTafMinimumPerOrder: "0",
  finraTafMaximumPerOrder: "0",
  catPerShare: "0",
});

function onePosition(markPrice: string) {
  return calculatePortfolioLiquidation({
    valuationDate: "2026-08-24",
    reportingCurrency: "USD",
    feeSchedules: [zeroFees],
    positions: [{
      instrumentId: "lulu",
      symbol: "LULU",
      quantity: "1",
      markPrice,
      lots: [{ lotId: "lot-1", quantity: "1", taxBasis: "100" }],
    }],
  });
}

describe("portfolio liquidation assessment", () => {
  it("derives the 100 -> 200 and 100 -> 225 tax thresholds", () => {
    expect(onePosition("200")).toMatchObject({
      aggregateMarkValue: "200",
      estimatedCloseFeesForAllPositions: "0",
      estimatedUnrealizedLiquidationTax: "20",
    });
    expect(onePosition("225")).toMatchObject({
      aggregateMarkValue: "225",
      estimatedUnrealizedLiquidationTax: "25",
    });
  });

  it("aggregates profitable and losing lots inside one instrument before tax", () => {
    const result = calculatePortfolioLiquidation({
      valuationDate: "2026-08-24",
      reportingCurrency: "USD",
      feeSchedules: [zeroFees],
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "2",
        markPrice: "105",
        lots: [
          { lotId: "gain", quantity: "1", taxBasis: "55" },
          { lotId: "loss", quantity: "1", taxBasis: "145" },
        ],
      }],
    });

    expect(result.instruments[0]).toMatchObject({
      aggregateMarkValue: "210",
      aggregateTaxBasis: "200",
      unrealizedGainAfterCloseFees: "10",
      estimatedUnrealizedLiquidationTax: "2",
    });
  });

  it("never offsets liquidation gains between different instruments", () => {
    const result = calculatePortfolioLiquidation({
      valuationDate: "2026-08-24",
      reportingCurrency: "USD",
      feeSchedules: [zeroFees],
      positions: [
        {
          instrumentId: "a",
          symbol: "A",
          quantity: "1",
          markPrice: "150",
          lots: [{ lotId: "a-lot", quantity: "1", taxBasis: "100" }],
        },
        {
          instrumentId: "b",
          symbol: "B",
          quantity: "1",
          markPrice: "50",
          lots: [{ lotId: "b-lot", quantity: "1", taxBasis: "100" }],
        },
      ],
    });
    expect(result.estimatedUnrealizedLiquidationTax).toBe("10");
  });

  it("fails closed when lot quantity does not reconcile to the position", () => {
    expect(() => calculatePortfolioLiquidation({
      valuationDate: "2026-08-24",
      reportingCurrency: "USD",
      feeSchedules: [zeroFees],
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "2",
        markPrice: "100",
        lots: [{ lotId: "lot-1", quantity: "1", taxBasis: "100" }],
      }],
    })).toThrow("does not equal position quantity");
  });
});
