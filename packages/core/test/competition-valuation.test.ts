import { describe, expect, it } from "vitest";

import {
  calculateCompetitionValuation,
} from "../src/index.js";

describe("competition liquidation valuation", () => {
  it("values the equal 150-share LULU opening state with real close friction", () => {
    const valuation = calculateCompetitionValuation({
      valuationDate: "2026-08-28",
      reportingCurrency: "USD",
      settledCash: "0",
      taxReserve: "0",
      positions: [{
        instrumentId: "3eec934a-1a87-5a1e-a9f9-fc7366d0458c",
        symbol: "LULU",
        quantity: "150",
        taxBasis: "18121.5",
        markPrice: "120.81",
      }],
    });

    expect(valuation.liquidation).toMatchObject({
      aggregateMarkValue: "18121.5",
      aggregateTaxBasis: "18121.5",
      estimatedUnrealizedLiquidationTax: "0",
    });
    expect(valuation.nav.brokerNav).toBe("18121.5");
    expect(valuation.nav.taxReservedNav).toBe("18121.5");
    expect(valuation.nav.liquidationDeductions).toBe(
      valuation.liquidation.estimatedCloseFeesForAllPositions,
    );
    expect(valuation.liquidation.estimatedCloseFeesForAllPositions).toBe("2.84");
    expect(valuation.nav.liquidationNav).toBe("18118.66");
  });

  it("deducts realized reserve, close fees and unrealized tax exactly once", () => {
    const valuation = calculateCompetitionValuation({
      valuationDate: "2026-08-28",
      reportingCurrency: "USD",
      settledCash: "50",
      taxReserve: "10",
      positions: [{
        instrumentId: "3eec934a-1a87-5a1e-a9f9-fc7366d0458c",
        symbol: "LULU",
        quantity: "150",
        taxBasis: "18121.5",
        markPrice: "140",
      }],
    });

    expect(valuation.liquidation.aggregateMarkValue).toBe("21000");
    expect(valuation.liquidation.estimatedCloseFeesForAllPositions).toBe("2.9");
    expect(valuation.liquidation.estimatedUnrealizedLiquidationTax).toBe("575.12");
    expect(valuation.nav).toMatchObject({
      brokerNav: "21050",
      taxReserveDeductions: "10",
      taxReservedNav: "21040",
      liquidationDeductions: "578.02",
      liquidationNav: "20461.98",
    });
  });

  it("is independent of input position order and preserves exact decimals", () => {
    const base = {
      valuationDate: "2026-08-28",
      reportingCurrency: "USD",
      settledCash: "9007199254740993.00000001",
      taxReserve: "0",
      positions: [
        {
          instrumentId: "00000000-0000-5000-8000-000000000002",
          symbol: "ZZZ",
          quantity: "1",
          taxBasis: "1",
          markPrice: "1.00000002",
        },
        {
          instrumentId: "00000000-0000-5000-8000-000000000001",
          symbol: "AAA",
          quantity: "1",
          taxBasis: "1",
          markPrice: "1.00000001",
        },
      ],
    } as const;

    const forward = calculateCompetitionValuation(base);
    const reverse = calculateCompetitionValuation({
      ...base,
      positions: [...base.positions].reverse(),
    });

    expect(forward).toEqual(reverse);
    expect(forward.nav.brokerNav).toBe("9007199254740995.00000004");
  });

  it("fails closed on a position currency mismatch", () => {
    expect(() => calculateCompetitionValuation({
      valuationDate: "2026-08-28",
      reportingCurrency: "USD",
      settledCash: "0",
      taxReserve: "0",
      positions: [{
        instrumentId: "3eec934a-1a87-5a1e-a9f9-fc7366d0458c",
        symbol: "LULU",
        quantity: "150",
        taxBasis: "18121.5",
        markPrice: "120.81",
        currency: "CNY",
      }],
    })).toThrow("does not match reporting currency");
  });

  it("rejects a reserve larger than settled cash", () => {
    expect(() => calculateCompetitionValuation({
      valuationDate: "2026-08-28",
      reportingCurrency: "USD",
      settledCash: "9",
      taxReserve: "10",
      positions: [],
    })).toThrow("taxReserve must not exceed settledCash");
  });
});
