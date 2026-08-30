import { describe, expect, it } from "vitest";

import { decimal, nonNegativeDecimal, sequence } from "../src/decimal.js";
import { defineFutuFeeSchedule } from "../src/futu-fees.js";
import { calculateNavSnapshot } from "../src/nav-round.js";
import {
  assertFrozenOrderPlanIntegrity,
  createS1SellOrderPlan,
  createS2BuyOrderPlan,
  executeS1SellOrders,
  executeS2BuyOrders,
  type FrozenBuyOrder,
  type MarketPriceEvidence,
} from "../src/rebalance.js";

const decisionId = "decision-1";
const D_CLOSE = "2026-08-24";
const D_CLOSE_VISIBLE_AT = "2026-08-24T20:15:00.000Z";
const S1_PLAN_FROZEN_AT = "2026-08-24T20:16:00.000Z";
const S1_DATE = "2026-08-25";
const S1_OPEN_VISIBLE_AT = "2026-08-25T13:30:00.000Z";
const S1_CLOSE_VISIBLE_AT = "2026-08-25T20:15:00.000Z";
const S2_DATE = "2026-08-26";
const S2_OPEN_VISIBLE_AT = "2026-08-26T13:30:00.000Z";

function testFeeSchedule(
  feeScheduleId: string,
  currency = "USD",
  commissionMinimumPerOrder = "0",
) {
  return defineFutuFeeSchedule({
    feeScheduleId,
    brokerLegalEntity: "SIMULATED",
    accountRegion: "TEST",
    market: "US",
    product: "US_EQUITY_ETF",
    accountTier: "TEST",
    effectiveFrom: "2026-01-01",
    currency,
    commissionPerShare: "0",
    commissionMinimumPerOrder,
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
}

function closeMark(
  value: string,
  id: string,
  sessionDate = D_CLOSE,
  visibleAt = D_CLOSE_VISIBLE_AT,
): MarketPriceEvidence {
  return {
    value,
    kind: "OFFICIAL_CLOSE",
    sessionDate,
    visibleAt,
    snapshotId: "snapshot-close",
    factId: `fact-close-${id}`,
  };
}

function openPrice(
  value: string,
  id: string,
  sessionDate = S1_DATE,
  visibleAt = S1_OPEN_VISIBLE_AT,
): MarketPriceEvidence {
  return {
    value,
    kind: "OFFICIAL_OPEN",
    sessionDate,
    visibleAt,
    snapshotId: "snapshot-open",
    factId: `fact-open-${id}`,
  };
}

function planningBuyingPowerEvidence(
  value: string,
  snapshotId = "buying-power-snapshot",
  visibleAt = S1_CLOSE_VISIBLE_AT,
) {
  return {
    value,
    snapshotId,
    visibleAt,
  } as const;
}

const s1SellContext = {
  decisionSessionDate: D_CLOSE,
  decisionCutoffAt: D_CLOSE_VISIBLE_AT,
  plannedAt: S1_PLAN_FROZEN_AT,
  s1TradeDate: S1_DATE,
  slippageBps: "0",
  fillPriceScale: 8,
  taxAllocationScale: 12,
} as const;

const s2PlanContext = {
  s1SessionDate: S1_DATE,
  plannedAt: S1_CLOSE_VISIBLE_AT,
  s2TradeDate: S2_DATE,
  slippageBps: "0",
  fillPriceScale: 8,
} as const;

describe("two-stage deterministic rebalance", () => {
  it("sizes S1 sells only from the decision-close NAV and close price", () => {
    const plan = createS1SellOrderPlan({
      decisionId,
      ...s1SellContext,
      decisionCloseTaxReservedNav: "1000",
      positions: [
        { instrumentId: "lulu", symbol: "LULU", quantity: "10", mark: closeMark("100", "lulu") },
      ],
      targets: [{ instrumentId: "lulu", symbol: "LULU", weightBps: "5000" }],
      cashWeightBps: "5000",
    });

    expect(plan.orders).toEqual([
      expect.objectContaining({
        stage: "S1",
        side: "SELL",
        quantity: "5",
        referencePrice: "100",
        plannedAt: S1_PLAN_FROZEN_AT,
      }),
    ]);
  });

  it("uses the S1 close pre-order NAV as the buy denominator", () => {
    const common = {
      decisionId,
      ...s2PlanContext,
      buyingPowerEvidence: planningBuyingPowerEvidence("200"),
      positions: [
        {
          instrumentId: "new",
          symbol: "NEW",
          quantity: "0",
          mark: closeMark("10", "new", S1_DATE, S1_CLOSE_VISIBLE_AT),
        },
      ],
      targets: [{ instrumentId: "new", symbol: "NEW", weightBps: "5000" }],
      cashWeightBps: "5000",
    } as const;

    const nav200 = createS2BuyOrderPlan({ ...common, preOrderTaxReservedNav: "200" });
    const nav220 = createS2BuyOrderPlan({ ...common, preOrderTaxReservedNav: "220" });

    expect(nav200.orders[0]).toMatchObject({ targetAmount: "100", quantity: "10" });
    expect(nav220.orders[0]).toMatchObject({ targetAmount: "110", quantity: "11" });
  });

  it("executes S1 sells, consumes FIFO lots, and locks tax before S2", () => {
    const zeroFeeSchedule = testFeeSchedule("zero-fee-test");
    const sellPlan = createS1SellOrderPlan({
      decisionId,
      ...s1SellContext,
      decisionCloseTaxReservedNav: "200",
      positions: [
        { instrumentId: "lulu", symbol: "LULU", quantity: "1", mark: closeMark("200", "lulu") },
      ],
      targets: [],
      cashWeightBps: "10000",
      feeSchedules: [zeroFeeSchedule],
    });

    const result = executeS1SellOrders({
      plan: sellPlan,
      tradeDate: S1_DATE,
      executedAt: "2026-08-25T13:31:00.000Z",
      officialOpenPrices: { lulu: openPrice("200", "lulu") },
      availableLots: [{
        lotId: "lulu-lot-1",
        instrumentId: "lulu",
        acquisitionSequence: sequence("1"),
        quantity: nonNegativeDecimal("1"),
        grossPurchasePrice: nonNegativeDecimal("100"),
        buyFees: nonNegativeDecimal("0"),
      }],
      sourceCountryByInstrument: { lulu: "US" },
      grossBuyingCashBeforeSells: "0",
      existingTaxReserve: "0",
    });

    expect(result).toMatchObject({
      grossSaleProceeds: "200",
      grossBuyingCashAfterSells: "200",
      totalSellFees: "0",
      netSaleCashProceeds: "200",
      newlyLockedTax: "20",
      taxReserveAfterLock: "20",
      preFeeBuyingPowerAfterTaxLock: "180",
      remainingLots: [],
    });
    expect(result.fills[0]?.disposition).toMatchObject({
      realizedGain: "100",
      chinaCapitalGainsTax: "20",
    });
    const postSellNav = calculateNavSnapshot({
      currency: "USD",
      // Broker cash stays gross here. Passing preFeeBuyingPowerAfterTaxLock
      // would deduct the same tax reserve twice.
      settledCash: decimal(result.grossBuyingCashAfterSells),
      unsettledCash: decimal("0"),
      dividendReceivables: decimal("0"),
      otherRecognizedReceivables: decimal("0"),
      positionMarketValues: [],
      unpaidRealizedCapitalGainsTaxAccrual: decimal(result.taxReserveAfterLock),
      pendingDividendChinaTaxTopUp: decimal("0"),
      estimatedForeignWithholdingPayable: decimal("0"),
      otherUnpaidChinaTaxAccrual: decimal("0"),
      estimatedCloseFeesForAllPositions: decimal("0"),
      estimatedUnrealizedLiquidationTax: decimal("0"),
    });
    expect(postSellNav.taxReservedNav).toBe(result.preFeeBuyingPowerAfterTaxLock);
  });

  it("freezes S1 tax rules and copies untouched lots at the execution boundary", () => {
    const zeroFeeSchedule = testFeeSchedule("zero-fee-test");
    const sellPlan = createS1SellOrderPlan({
      decisionId,
      ...s1SellContext,
      decisionCloseTaxReservedNav: "200",
      positions: [
        { instrumentId: "lulu", symbol: "LULU", quantity: "1", mark: closeMark("200", "lulu") },
      ],
      targets: [],
      cashWeightBps: "10000",
      feeSchedules: [zeroFeeSchedule],
    });
    const untouchedLot = {
      lotId: "aapl-lot-1",
      instrumentId: "aapl",
      acquisitionSequence: sequence("1"),
      quantity: nonNegativeDecimal("1"),
      grossPurchasePrice: nonNegativeDecimal("50"),
      buyFees: nonNegativeDecimal("0"),
    };
    const execution = {
      plan: sellPlan,
      tradeDate: S1_DATE,
      executedAt: "2026-08-25T13:31:00.000Z",
      officialOpenPrices: { lulu: openPrice("200", "lulu") },
      availableLots: [
        {
          lotId: "lulu-lot-1",
          instrumentId: "lulu",
          acquisitionSequence: sequence("1"),
          quantity: nonNegativeDecimal("1"),
          grossPurchasePrice: nonNegativeDecimal("100"),
          buyFees: nonNegativeDecimal("0"),
        },
        untouchedLot,
      ],
      sourceCountryByInstrument: { lulu: "US" },
      grossBuyingCashBeforeSells: "0",
      existingTaxReserve: "0",
    } as const;

    expect(() => executeS1SellOrders({
      ...execution,
      plan: { ...sellPlan, taxAllocationScale: "2" },
    })).toThrow("S1 frozen order plan fingerprint mismatch");

    const result = executeS1SellOrders(execution);
    (untouchedLot as unknown as { quantity: string }).quantity = "999";
    const returnedUntouchedLot = result.remainingLots.find(
      (lot) => lot.lotId === "aapl-lot-1",
    );
    expect(returnedUntouchedLot?.quantity).toBe("1");
    expect(Object.isFrozen(returnedUntouchedLot)).toBe(true);
  });

  it("prioritizes target gaps and uses stable instrument ID as the tie-breaker", () => {
    const plan = createS2BuyOrderPlan({
      decisionId,
      ...s2PlanContext,
      preOrderTaxReservedNav: "1000",
      buyingPowerEvidence: planningBuyingPowerEvidence("1000"),
      positions: [
        { instrumentId: "b", symbol: "B", quantity: "0", mark: closeMark("10", "b", S1_DATE, S1_CLOSE_VISIBLE_AT) },
        { instrumentId: "a", symbol: "A", quantity: "0", mark: closeMark("10", "a", S1_DATE, S1_CLOSE_VISIBLE_AT) },
      ],
      targets: [
        { instrumentId: "b", symbol: "B", weightBps: "5000" },
        { instrumentId: "a", symbol: "A", weightBps: "5000" },
      ],
      cashWeightBps: "0",
    });

    expect(plan.orders.map((order) => [order.instrumentId, order.priority])).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    expect(Number(plan.remainingUnreservedBuyingPower)).toBeGreaterThanOrEqual(0);
  });

  it("does not round a sub-share 1bp target across an order boundary", () => {
    const buy = createS2BuyOrderPlan({
      decisionId,
      ...s2PlanContext,
      preOrderTaxReservedNav: "9999.999999999",
      buyingPowerEvidence: planningBuyingPowerEvidence("100"),
      positions: [
        { instrumentId: "a", symbol: "A", quantity: "0", mark: closeMark("1", "a", S1_DATE, S1_CLOSE_VISIBLE_AT) },
      ],
      targets: [{ instrumentId: "a", symbol: "A", weightBps: "1" }],
      cashWeightBps: "9999",
    });
    expect(buy.orders).toEqual([]);

    const sell = createS1SellOrderPlan({
      decisionId,
      ...s1SellContext,
      decisionCloseTaxReservedNav: "10000.000000001",
      positions: [
        { instrumentId: "a", symbol: "A", quantity: "2", mark: closeMark("1", "a") },
      ],
      targets: [{ instrumentId: "a", symbol: "A", weightBps: "1" }],
      cashWeightBps: "9999",
    });
    expect(sell.orders).toEqual([]);
  });

  it("does not double-deduct an estimated fee reservation", () => {
    const plan = createS2BuyOrderPlan({
      decisionId,
      ...s2PlanContext,
      preOrderTaxReservedNav: "1000",
      buyingPowerEvidence: planningBuyingPowerEvidence("1002.29"),
      positions: [
        { instrumentId: "lulu", symbol: "LULU", quantity: "0", mark: closeMark("10", "lulu", S1_DATE, S1_CLOSE_VISIBLE_AT) },
      ],
      targets: [{ instrumentId: "lulu", symbol: "LULU", weightBps: "10000" }],
      cashWeightBps: "0",
    });

    expect(plan.orders[0]).toMatchObject({
      quantity: "100",
      estimatedGrossNotional: "1000",
      feeScheduleId: "futu_hk_us_equity_fixed_2026-08-23",
      feeCurrency: "USD",
      estimatedTotalFees: "2.29",
      reservedBuyingPower: "1002.29",
    });
    expect(plan.remainingUnreservedBuyingPower).toBe("0");
  });

  it("partially fills a frozen S2 order after a gap-up without mutating it", () => {
    const plan = createS2BuyOrderPlan({
      decisionId,
      ...s2PlanContext,
      preOrderTaxReservedNav: "1000",
      buyingPowerEvidence: planningBuyingPowerEvidence("1002.02"),
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "0",
        mark: closeMark("100", "lulu", S1_DATE, S1_CLOSE_VISIBLE_AT),
      }],
      targets: [{ instrumentId: "lulu", symbol: "LULU", weightBps: "10000" }],
      cashWeightBps: "0",
    });
    const order = plan.orders[0] as FrozenBuyOrder;
    expect(order.quantity).toBe("10");
    const reserializedOrder = Object.fromEntries(
      Object.entries(order).reverse(),
    ) as unknown as FrozenBuyOrder;
    const existingLots = [{
      lotId: "lulu-existing-lot",
      instrumentId: "lulu",
      acquisitionSequence: sequence("1"),
      quantity: nonNegativeDecimal("1"),
      grossPurchasePrice: nonNegativeDecimal("90"),
      buyFees: nonNegativeDecimal("2"),
    }] as const;

    const result = executeS2BuyOrders({
      plan: { ...plan, orders: [reserializedOrder] },
      tradeDate: S2_DATE,
      executedAt: "2026-08-26T13:31:00.000Z",
      officialOpenPrices: {
        lulu: openPrice("120", "lulu", S2_DATE, S2_OPEN_VISIBLE_AT),
      },
      existingLots,
    });

    expect(result.fills[0]).toMatchObject({
      orderQuantity: "10",
      fillQuantity: "8",
      canceledQuantity: "2",
      fillPrice: "120",
      createdLot: {
        lotId: `${decisionId}:S2:BUY:lulu:fill:1:lot`,
        instrumentId: "lulu",
        acquisitionSequence: "2",
        quantity: "8",
        grossPurchasePrice: "960",
        buyFees: "2.01",
      },
      status: "PARTIALLY_FILLED_CASH_LIMIT",
    });
    expect(result.createdLots).toEqual([result.fills[0]?.createdLot]);
    expect(order.quantity).toBe("10");
    expect(result.remainingBuyingPower).toBe("40.01");
    expect(() => executeS2BuyOrders({
      plan,
      tradeDate: S2_DATE,
      executedAt: "2026-08-26T13:31:00.000Z",
      officialOpenPrices: {
        lulu: openPrice("120", "lulu", S2_DATE, S2_OPEN_VISIBLE_AT),
      },
      existingLots: [...existingLots, result.createdLots[0]!],
    })).toThrow("already has a persisted FIFO lot");
  });

  it("freezes and enforces a first-minute participation cap independently of cash", () => {
    const plan = createS2BuyOrderPlan({
      decisionId,
      ...s2PlanContext,
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      maxParticipationBps: "100",
      preOrderTaxReservedNav: "1000",
      buyingPowerEvidence: planningBuyingPowerEvidence("1002.29"),
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "0",
        mark: closeMark("100", "lulu", S1_DATE, S1_CLOSE_VISIBLE_AT),
      }],
      targets: [{ instrumentId: "lulu", symbol: "LULU", weightBps: "10000" }],
      cashWeightBps: "0",
    });

    expect(plan).toMatchObject({
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      maxParticipationBps: "100",
    });
    expect(() => assertFrozenOrderPlanIntegrity({
      ...plan,
      maxParticipationBps: "101",
    })).toThrow("fingerprint mismatch");

    const result = executeS2BuyOrders({
      plan,
      tradeDate: S2_DATE,
      executedAt: "2026-08-26T13:31:00.000Z",
      officialOpenPrices: {
        lulu: {
          ...openPrice("100", "lulu", S2_DATE, S2_OPEN_VISIBLE_AT),
          observedVolume: "500",
        },
      },
      existingLots: [],
    });

    expect(result.fills[0]).toMatchObject({
      orderQuantity: "10",
      fillQuantity: "5",
      canceledQuantity: "5",
      status: "PARTIALLY_FILLED_LIQUIDITY_LIMIT",
      liquidity: {
        observedVolume: "500",
        maxParticipationBps: "100",
        maximumFillQuantity: "5",
      },
    });
  });

  it("fails closed when a participation-capped execution lacks volume", () => {
    const plan = createS2BuyOrderPlan({
      decisionId,
      ...s2PlanContext,
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      maxParticipationBps: "100",
      preOrderTaxReservedNav: "100",
      buyingPowerEvidence: planningBuyingPowerEvidence("100"),
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "0",
        mark: closeMark("10", "lulu", S1_DATE, S1_CLOSE_VISIBLE_AT),
      }],
      targets: [{ instrumentId: "lulu", symbol: "LULU", weightBps: "10000" }],
      cashWeightBps: "0",
    });

    expect(() => executeS2BuyOrders({
      plan,
      tradeDate: S2_DATE,
      executedAt: "2026-08-26T13:31:00.000Z",
      officialOpenPrices: {
        lulu: openPrice("10", "lulu", S2_DATE, S2_OPEN_VISIBLE_AT),
      },
      existingLots: [],
    })).toThrow("observedVolume");
  });

  it("fails closed when a required S2 price is absent", () => {
    const plan = createS2BuyOrderPlan({
      decisionId,
      ...s2PlanContext,
      preOrderTaxReservedNav: "100",
      buyingPowerEvidence: planningBuyingPowerEvidence("100"),
      positions: [
        { instrumentId: "lulu", symbol: "LULU", quantity: "0", mark: closeMark("10", "lulu", S1_DATE, S1_CLOSE_VISIBLE_AT) },
      ],
      targets: [{ instrumentId: "lulu", symbol: "LULU", weightBps: "10000" }],
      cashWeightBps: "0",
    });

    expect(() => executeS2BuyOrders({
      plan,
      tradeDate: S2_DATE,
      executedAt: "2026-08-26T13:31:00.000Z",
      officialOpenPrices: {},
      existingLots: [],
    })).toThrow("Missing S2 official open price");
  });

  it("rejects a close fact that became visible even one millisecond after the cutoff", () => {
    expect(() => createS1SellOrderPlan({
      decisionId,
      ...s1SellContext,
      decisionCloseTaxReservedNav: "100",
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "1",
        mark: closeMark(
          "100",
          "late-lulu",
          D_CLOSE,
          "2026-08-24T20:15:00.999Z",
        ),
      }],
      targets: [],
      cashWeightBps: "10000",
    })).toThrow("was not visible at cutoff");
  });

  it("keeps the decision evidence cutoff at or before the real plan-freeze time", () => {
    expect(() => createS1SellOrderPlan({
      decisionId,
      ...s1SellContext,
      decisionCutoffAt: "2026-08-24T20:16:00.001Z",
      decisionCloseTaxReservedNav: "100",
      positions: [],
      targets: [],
      cashWeightBps: "10000",
    })).toThrow("decisionCutoffAt cannot postdate plannedAt");
  });

  it("rejects a future close falsely labeled as visible before its session", () => {
    expect(() => createS1SellOrderPlan({
      decisionId,
      decisionSessionDate: D_CLOSE,
      decisionCutoffAt: "2026-08-23T20:15:00.000Z",
      plannedAt: S1_PLAN_FROZEN_AT,
      s1TradeDate: S1_DATE,
      slippageBps: "0",
      fillPriceScale: 8,
      taxAllocationScale: 12,
      decisionCloseTaxReservedNav: "100",
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "1",
        mark: closeMark(
          "100",
          "impossible-early-close",
          D_CLOSE,
          "2026-08-23T20:15:00.000Z",
        ),
      }],
      targets: [],
      cashWeightBps: "10000",
    })).toThrow("cannot precede its official-close session date");
  });

  it("does not backfill an order planned after its execution session began", () => {
    expect(() => createS1SellOrderPlan({
      decisionId,
      decisionSessionDate: D_CLOSE,
      decisionCutoffAt: "2026-08-24T20:15:00.000Z",
      plannedAt: "2026-08-25T20:15:00.000Z",
      s1TradeDate: S1_DATE,
      slippageBps: "0",
      fillPriceScale: 8,
      taxAllocationScale: 12,
      decisionCloseTaxReservedNav: "100",
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "1",
        mark: closeMark(
          "100",
          "late-plan",
          D_CLOSE,
          "2026-08-25T20:15:00.000Z",
        ),
      }],
      targets: [],
      cashWeightBps: "10000",
    })).toThrow("plannedAt must precede the planned trade date");
  });

  it("validates the S1/S2 calendar ordering even for an all-cash plan", () => {
    expect(() => createS2BuyOrderPlan({
      decisionId,
      s1SessionDate: S1_DATE,
      plannedAt: S1_CLOSE_VISIBLE_AT,
      s2TradeDate: D_CLOSE,
      slippageBps: "0",
      fillPriceScale: 8,
      preOrderTaxReservedNav: "100",
      buyingPowerEvidence: planningBuyingPowerEvidence("100"),
      positions: [],
      targets: [],
      cashWeightBps: "10000",
    })).toThrow("plannedTradeDate must follow");
  });

  it("rejects a fill-price scale that cannot be stored exactly by the ledger", () => {
    expect(() => createS2BuyOrderPlan({
      decisionId,
      ...s2PlanContext,
      fillPriceScale: 13,
      preOrderTaxReservedNav: "100",
      buyingPowerEvidence: planningBuyingPowerEvidence("100"),
      positions: [],
      targets: [],
      cashWeightBps: "10000",
    })).toThrow("fillPriceScale must be an integer from 0 through 12");
  });

  it("rejects a frozen S2 array that disagrees with numeric order priority", () => {
    const plan = createS2BuyOrderPlan({
      decisionId,
      ...s2PlanContext,
      preOrderTaxReservedNav: "100",
      buyingPowerEvidence: planningBuyingPowerEvidence("100"),
      positions: [
        {
          instrumentId: "lulu",
          symbol: "LULU",
          quantity: "0",
          mark: closeMark("10", "lulu", S1_DATE, S1_CLOSE_VISIBLE_AT),
        },
        {
          instrumentId: "spy",
          symbol: "SPY",
          quantity: "0",
          mark: closeMark("10", "spy", S1_DATE, S1_CLOSE_VISIBLE_AT),
        },
      ],
      targets: [
        { instrumentId: "lulu", symbol: "LULU", weightBps: "5000" },
        { instrumentId: "spy", symbol: "SPY", weightBps: "5000" },
      ],
      cashWeightBps: "0",
    });
    expect(plan.orders).toHaveLength(2);
    expect(() => assertFrozenOrderPlanIntegrity({
      ...plan,
      orders: Object.freeze([...plan.orders].reverse()),
    })).toThrow("priorities must strictly increase");
  });

  it("rejects mixed decisions, changed execution dates, and changed fee rules", () => {
    const plan = createS2BuyOrderPlan({
      decisionId,
      ...s2PlanContext,
      preOrderTaxReservedNav: "100",
      buyingPowerEvidence: planningBuyingPowerEvidence("100"),
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "0",
        mark: closeMark("10", "lulu", S1_DATE, S1_CLOSE_VISIBLE_AT),
      }],
      targets: [{ instrumentId: "lulu", symbol: "LULU", weightBps: "10000" }],
      cashWeightBps: "0",
    });
    const order = plan.orders[0] as FrozenBuyOrder;
    const baseExecution = {
      plan,
      tradeDate: S2_DATE,
      executedAt: "2026-08-26T13:31:00.000Z",
      officialOpenPrices: {
        lulu: openPrice("10", "lulu", S2_DATE, S2_OPEN_VISIBLE_AT),
      },
      existingLots: [],
    } as const;

    expect(() => executeS2BuyOrders({
      ...baseExecution,
      plan: { ...plan, decisionId: "decision-2" },
    })).toThrow("frozen order plan fingerprint mismatch");

    expect(() => executeS2BuyOrders({
      ...baseExecution,
      plan: { ...plan, orders: [{ ...order, quantity: "999" }] },
    })).toThrow("frozen order plan fingerprint mismatch");

    expect(() => executeS2BuyOrders({
      ...baseExecution,
      plan: {
        ...plan,
        orders: [{ ...order, feeScheduleTerms: "{}" }],
      },
    })).toThrow("frozen order plan fingerprint mismatch");

    expect(() => executeS2BuyOrders({
      ...baseExecution,
      plan: { ...plan, slippageBps: "500" },
    })).toThrow("frozen order plan fingerprint mismatch");

    expect(() => executeS2BuyOrders({
      ...baseExecution,
      plan: { ...plan, initialBuyingPower: decimal("101") },
    })).toThrow("frozen order plan fingerprint mismatch");

    expect(() => executeS2BuyOrders({
      ...baseExecution,
      plan: {
        ...plan,
        buyingPowerEvidence: {
          ...plan.buyingPowerEvidence,
          value: decimal("99"),
        },
      },
    })).toThrow("frozen order plan fingerprint mismatch");

    expect(() => executeS2BuyOrders({
      ...baseExecution,
      tradeDate: "2026-08-27",
      executedAt: "2026-08-27T13:31:00.000Z",
    })).toThrow("was planned for 2026-08-26");

    expect(() => executeS2BuyOrders({
      ...baseExecution,
      executedAt: "2026-08-25T13:31:00.000Z",
    })).toThrow("executedAt must fall on tradeDate");
  });
});
