import { describe, expect, it } from "vitest";

import {
  FUTU_HK_US_EQUITY_FIXED_2026_08_23,
  canonicalFutuFeeScheduleTerms,
  calculateFutuOrderFees,
  calculateMaxAffordableFutuBuyFill,
  defineFutuFeeSchedule,
  parseCanonicalFutuFeeScheduleTerms,
  resolveFutuFeeSchedule,
} from "../src/futu-fees.js";

describe("Futu HK US equity fixed fees", () => {
  it("charges $2.29 for a 100-share buy at $100", () => {
    const result = calculateFutuOrderFees({
      tradeDate: "2026-08-24",
      side: "BUY",
      fills: [{ quantity: "100", price: "100" }],
    });

    expect(result).toMatchObject({
      feeScheduleId: "futu_hk_us_equity_fixed_2026-08-23",
      aggregateQuantity: "100",
      grossNotional: "10000",
      components: {
        commission: "0.99",
        platform: "1.00",
        settlement: "0.30",
        secRegulatory: "0.00",
        finraTaf: "0.00",
        cat: "0.00",
      },
      total: "2.29",
    });
  });

  it("charges $2.52 for a 100-share sell at $100", () => {
    const result = calculateFutuOrderFees({
      tradeDate: "2026-08-24",
      side: "SELL",
      fills: [{ quantity: "100", price: "100" }],
    });

    expect(result.components).toEqual({
      commission: "0.99",
      platform: "1.00",
      settlement: "0.30",
      secRegulatory: "0.21",
      finraTaf: "0.02",
      cat: "0.00",
    });
    expect(result.total).toBe("2.52");
  });

  it("applies commission and platform minima once across three fills", () => {
    const result = calculateFutuOrderFees({
      tradeDate: "2026-08-24",
      side: "BUY",
      fills: [
        { quantity: "20", price: "99.50" },
        { quantity: "30", price: "100" },
        { quantity: "50", price: "100.20" },
      ],
    });

    expect(result.aggregateQuantity).toBe("100");
    expect(result.grossNotional).toBe("10000");
    expect(result.components.commission).toBe("0.99");
    expect(result.components.platform).toBe("1.00");
    expect(result.total).toBe("2.29");
  });

  it("selects the ruleset by its exclusive effective-date boundary", () => {
    const oldSchedule = defineFutuFeeSchedule({
      ...FUTU_HK_US_EQUITY_FIXED_2026_08_23,
      feeScheduleId: "old",
      effectiveTo: "2026-09-01",
      commissionPerShare:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.commissionPerShare,
      commissionMinimumPerOrder:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.commissionMinimumPerOrder,
      platformPerShare:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.platformPerShare,
      platformMinimumPerOrder:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.platformMinimumPerOrder,
      settlementPerShare:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.settlementPerShare,
      secRateOfGrossNotional:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.secRateOfGrossNotional,
      secMinimumPerOrder:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.secMinimumPerOrder,
      finraTafPerShare:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.finraTafPerShare,
      finraTafMinimumPerOrder:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.finraTafMinimumPerOrder,
      finraTafMaximumPerOrder:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.finraTafMaximumPerOrder,
      catPerShare: FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.catPerShare,
    });
    const { effectiveTo: _oldEffectiveTo, ...oldScheduleWithoutEnd } =
      oldSchedule;
    const newSchedule = defineFutuFeeSchedule({
      ...oldScheduleWithoutEnd,
      feeScheduleId: "new",
      effectiveFrom: "2026-09-01",
      commissionPerShare: oldSchedule.rates.commissionPerShare,
      commissionMinimumPerOrder: "1.49",
      platformPerShare: oldSchedule.rates.platformPerShare,
      platformMinimumPerOrder: oldSchedule.rates.platformMinimumPerOrder,
      settlementPerShare: oldSchedule.rates.settlementPerShare,
      secRateOfGrossNotional: oldSchedule.rates.secRateOfGrossNotional,
      secMinimumPerOrder: oldSchedule.rates.secMinimumPerOrder,
      finraTafPerShare: oldSchedule.rates.finraTafPerShare,
      finraTafMinimumPerOrder: oldSchedule.rates.finraTafMinimumPerOrder,
      finraTafMaximumPerOrder: oldSchedule.rates.finraTafMaximumPerOrder,
      catPerShare: oldSchedule.rates.catPerShare,
    });
    const schedules = [oldSchedule, newSchedule];

    expect(resolveFutuFeeSchedule("2026-08-31", schedules).feeScheduleId).toBe(
      "old",
    );
    expect(resolveFutuFeeSchedule("2026-09-01", schedules).feeScheduleId).toBe(
      "new",
    );

    const oldResult = calculateFutuOrderFees({
      tradeDate: "2026-08-31",
      side: "BUY",
      fills: [{ quantity: "100", price: "100" }],
      schedules,
    });
    const newResult = calculateFutuOrderFees({
      tradeDate: "2026-09-01",
      side: "BUY",
      fills: [{ quantity: "100", price: "100" }],
      schedules,
    });

    expect(oldResult).toMatchObject({ feeScheduleId: "old", total: "2.29" });
    expect(newResult).toMatchObject({ feeScheduleId: "new", total: "2.79" });
    expect(oldResult.total).toBe("2.29");
  });

  it("fits 100 shares in $1,002.29 but not in $1,002.28", () => {
    const exact = calculateMaxAffordableFutuBuyFill({
      tradeDate: "2026-08-24",
      requestedQuantity: "100",
      price: "10",
      buyingPower: "1002.29",
    });
    const shortByOneCent = calculateMaxAffordableFutuBuyFill({
      tradeDate: "2026-08-24",
      requestedQuantity: "100",
      price: "10",
      buyingPower: "1002.28",
    });

    expect(exact).toMatchObject({
      affordableQuantity: "100",
      grossNotional: "1000",
      totalFees: "2.29",
      totalCashRequired: "1002.29",
      isFullyAffordable: true,
    });
    expect(shortByOneCent).toMatchObject({
      affordableQuantity: "99",
      grossNotional: "990",
      totalFees: "2.29",
      totalCashRequired: "992.29",
      isFullyAffordable: false,
    });
  });

  it("fails closed when no schedule or more than one schedule is effective", () => {
    expect(() => resolveFutuFeeSchedule("2026-08-22")).toThrow(
      /exactly one effective/,
    );
    expect(() =>
      resolveFutuFeeSchedule("2026-08-24", [
        FUTU_HK_US_EQUITY_FIXED_2026_08_23,
        FUTU_HK_US_EQUITY_FIXED_2026_08_23,
      ]),
    ).toThrow(/found 2/);
  });

  it("replays from exact frozen fee bytes even after the planning registry evolves", () => {
    const frozenTerms = canonicalFutuFeeScheduleTerms(
      FUTU_HK_US_EQUITY_FIXED_2026_08_23,
    );
    const revisedRegistryEntry = defineFutuFeeSchedule({
      ...FUTU_HK_US_EQUITY_FIXED_2026_08_23,
      effectiveTo: "2026-09-01",
      commissionPerShare:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.commissionPerShare,
      commissionMinimumPerOrder:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.commissionMinimumPerOrder,
      platformPerShare:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.platformPerShare,
      platformMinimumPerOrder:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.platformMinimumPerOrder,
      settlementPerShare:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.settlementPerShare,
      secRateOfGrossNotional:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.secRateOfGrossNotional,
      secMinimumPerOrder:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.secMinimumPerOrder,
      finraTafPerShare:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.finraTafPerShare,
      finraTafMinimumPerOrder:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.finraTafMinimumPerOrder,
      finraTafMaximumPerOrder:
        FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.finraTafMaximumPerOrder,
      catPerShare: FUTU_HK_US_EQUITY_FIXED_2026_08_23.rates.catPerShare,
    });

    expect(canonicalFutuFeeScheduleTerms(revisedRegistryEntry)).not.toBe(
      frozenTerms,
    );
    const restored = parseCanonicalFutuFeeScheduleTerms(frozenTerms);
    expect(restored.effectiveTo).toBeUndefined();
    expect(calculateFutuOrderFees({
      tradeDate: "2026-08-24",
      side: "BUY",
      fills: [{ quantity: "100", price: "10" }],
      schedules: [restored],
    }).total).toBe("2.29");
    expect(() => parseCanonicalFutuFeeScheduleTerms(` ${frozenTerms}`)).toThrow(
      "not byte-canonical",
    );
  });
});
