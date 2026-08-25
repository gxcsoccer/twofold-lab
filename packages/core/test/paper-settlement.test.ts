import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { nonNegativeDecimal, sequence } from "../src/decimal.js";
import { defineFutuFeeSchedule } from "../src/futu-fees.js";
import {
  PAPER_SETTLEMENT_AUTHORITY,
  createPaperOrderSettlement,
  type PaperOrderFill,
  type BuyPaperSettlementInput,
  type CnyFxEvidence,
  type CompletedPaperOrderExecution,
  type PaperSettlementLedgerHead,
  type SellPaperSettlementInput,
} from "../src/paper-settlement.js";
import {
  createS1SellOrderPlan,
  createS2BuyOrderPlan,
  type BuyOrderPlan,
  type MarketPriceEvidence,
  type OrderExecutionModel,
  type SellOrderPlan,
} from "../src/rebalance.js";
import type { ShadowTaxLot } from "../src/shadow-tax.js";

const D_DATE = "2026-08-24";
const D_CLOSE = "2026-08-24T20:15:00.000Z";
const S1_PLANNED = "2026-08-24T20:16:00.000Z";
const S1_DATE = "2026-08-25";
const S1_CLOSE = "2026-08-25T20:15:00.000Z";
const S2_PLANNED = "2026-08-25T20:16:00.000Z";
const S2_DATE = "2026-08-26";
const SETTLED_AT = "2026-08-26T14:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function zeroFeeSchedule() {
  return defineFutuFeeSchedule({
    feeScheduleId: "zero-fee-test-v1",
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
}

function closeEvidence(
  value: string,
  sessionDate: string,
  visibleAt: string,
): MarketPriceEvidence {
  return {
    value,
    kind: "OFFICIAL_CLOSE",
    sessionDate,
    visibleAt,
    snapshotId: `snapshot-close-${sessionDate}`,
    factId: `fact-close-${sessionDate}`,
  };
}

function buyPlan(
  executionModel: OrderExecutionModel = "SIMULATED_SLIPPAGE",
  slippageBps = "0",
): BuyOrderPlan {
  return createS2BuyOrderPlan({
    decisionId: "decision-buy",
    s1SessionDate: S1_DATE,
    plannedAt: S2_PLANNED,
    s2TradeDate: S2_DATE,
    preOrderTaxReservedNav: "1000",
    buyingPowerEvidence: {
      value: "2000",
      snapshotId: "buying-power-at-s1-close",
      visibleAt: S1_CLOSE,
    },
    positions: [{
      instrumentId: "lulu",
      symbol: "LULU",
      quantity: "0",
      mark: closeEvidence("10", S1_DATE, S1_CLOSE),
    }],
    targets: [{ instrumentId: "lulu", symbol: "LULU", weightBps: "10000" }],
    cashWeightBps: "0",
    slippageBps,
    executionModel,
    fillPriceScale: 8,
  });
}

function brokerActualFill(
  id: string,
  quantity: string,
  price: string,
): PaperOrderFill {
  const executedAt = "2026-08-26T13:31:00.000Z";
  return {
    fillId: id,
    quantity,
    price,
    executedAt,
    priceEvidence: {
      semantics: "BROKER_ACTUAL_EXECUTION_PRICE",
      sourceId: "alpaca-paper-api",
      sourceVersionId: "alpaca-order-v17",
      factId: `paper-fill-fact-${id}`,
      sourceArtifactId: `paper-order-artifact-${id}`,
      sourceContentSha256: HASH_B,
      observedAt: executedAt,
      providerExecutionId: `alpaca-execution-${id}`,
    },
  };
}

function sellPlan(quantity = "1", referencePrice = "200"): SellOrderPlan {
  const nav = (BigInt(quantity) * BigInt(referencePrice)).toString();
  return createS1SellOrderPlan({
    decisionId: `decision-sell-${quantity}-${referencePrice}`,
    decisionSessionDate: D_DATE,
    decisionCutoffAt: D_CLOSE,
    plannedAt: S1_PLANNED,
    s1TradeDate: S1_DATE,
    decisionCloseTaxReservedNav: nav,
    positions: [{
      instrumentId: "lulu",
      symbol: "LULU",
      quantity,
      mark: closeEvidence(referencePrice, D_DATE, D_CLOSE),
    }],
    targets: [],
    cashWeightBps: "10000",
    slippageBps: "0",
    fillPriceScale: 8,
    taxAllocationScale: 12,
    feeSchedules: [zeroFeeSchedule()],
  });
}

function ledgerHead(overrides: Partial<PaperSettlementLedgerHead> = {}): PaperSettlementLedgerHead {
  return {
    strategyAccountId: "strategy-account-1",
    runId: "run-1",
    headEventId: "ledger-head-event-1",
    headSequence: "42",
    headHash: HASH_A,
    capturedAt: "2026-08-26T13:59:00.000Z",
    currency: "USD",
    instrumentId: "lulu",
    cashAssetBalance: "3000",
    currentBuyingPower: "3000",
    taxReserveBalance: "0",
    positionQuantity: "0",
    positionGrossCostAssetBalance: "0",
    ...overrides,
  };
}

function fill(
  id: string,
  quantity: string,
  price: string,
  executedAt = "2026-08-26T13:31:00.000Z",
): PaperOrderFill {
  return {
    fillId: id,
    quantity,
    price,
    executedAt,
    priceEvidence: {
      semantics: "SIMULATED_SLIPPAGE_DERIVED_PRICE",
      sourceId: "official-open-source",
      sourceVersionId: "official-open-source-v17",
      factId: "official-open-fact-lulu",
      sourceArtifactId: "official-open-artifact-lulu",
      sourceContentSha256: HASH_B,
      observedAt: `${executedAt.slice(0, 10)}T13:30:00.000Z`,
      snapshotId: "official-open-snapshot-lulu",
      officialOpenSessionDate: executedAt.slice(0, 10),
      officialOpenPrice: price,
      slippageBps: "0",
      fillPriceScale: "8",
    },
  };
}

function buyExecution(
  plan: BuyOrderPlan,
  fills: readonly PaperOrderFill[],
  canceledQuantity = "0",
  terminalStatus: CompletedPaperOrderExecution["terminalStatus"] = "FILLED",
): CompletedPaperOrderExecution {
  const order = plan.orders[0]!;
  return {
    executionId: "paper-order-outcome-buy-1",
    orderId: order.orderId,
    decisionId: plan.decisionId,
    stage: "S2",
    side: "BUY",
    instrumentId: order.instrumentId,
    tradeDate: S2_DATE,
    currency: "USD",
    terminalStatus,
    canceledQuantity,
    fills,
  };
}

function sellExecution(
  plan: SellOrderPlan,
  quantity: string,
  price: string,
): CompletedPaperOrderExecution {
  const order = plan.orders[0]!;
  return {
    executionId: `paper-order-outcome-sell-${quantity}-${price}`,
    orderId: order.orderId,
    decisionId: plan.decisionId,
    stage: "S1",
    side: "SELL",
    instrumentId: order.instrumentId,
    tradeDate: S1_DATE,
    currency: "USD",
    terminalStatus: "FILLED",
    canceledQuantity: "0",
    fills: [fill("sell-1", quantity, price, "2026-08-25T13:31:00.000Z")],
  };
}

function fx(
  id: string,
  rate: string,
  effectiveAt: string,
): CnyFxEvidence {
  return {
    fxRateId: id,
    factId: `${id}-fact`,
    sourceVersionId: `${id}-source-version`,
    sourceArtifactId: `${id}-source-artifact`,
    sourceContentSha256: HASH_B,
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    cnyPerBaseUnit: rate,
    effectiveAt,
    visibleAt: effectiveAt,
    status: "FINAL",
  };
}

function oneLot(quantity = "1", grossPurchasePrice = "100"): ShadowTaxLot {
  return {
    lotId: "lulu-lot-1",
    instrumentId: "lulu",
    acquisitionSequence: sequence("1"),
    quantity: nonNegativeDecimal(quantity),
    grossPurchasePrice: nonNegativeDecimal(grossPurchasePrice),
    buyFees: nonNegativeDecimal("0"),
  };
}

function buyInput(
  plan: BuyOrderPlan,
  execution: CompletedPaperOrderExecution,
  overrides: Partial<BuyPaperSettlementInput> = {},
): BuyPaperSettlementInput {
  return {
    plan,
    orderId: plan.orders[0]!.orderId,
    execution,
    settledAt: SETTLED_AT,
    ledgerHead: ledgerHead(),
    planCashFence: {
      planFingerprint: plan.planFingerprint,
      remainingBuyingPower: plan.initialBuyingPower,
      priorSettlementIds: [],
    },
    availableLots: [],
    acquisitionFxEvidence: fx("usd-cny-buy", "7", "2026-08-26T13:45:00.000Z"),
    ...overrides,
  };
}

function sellInput(
  plan: SellOrderPlan,
  execution: CompletedPaperOrderExecution,
  overrides: Partial<SellPaperSettlementInput> = {},
): SellPaperSettlementInput {
  const lot = oneLot();
  return {
    plan,
    orderId: plan.orders[0]!.orderId,
    execution,
    settledAt: SETTLED_AT,
    ledgerHead: ledgerHead({
      capturedAt: "2026-08-25T13:59:00.000Z",
      cashAssetBalance: "0",
      currentBuyingPower: "0",
      positionQuantity: "1",
      positionGrossCostAssetBalance: "100",
    }),
    availableLots: [lot],
    sourceCountry: "US",
    dispositionFxEvidence: fx("usd-cny-disposition", "8", "2026-08-25T13:45:00.000Z"),
    acquisitionFxEvidence: [{
      lotId: lot.lotId,
      acquisitionTradeDate: "2025-01-02",
      acquisitionSettlementId: "historical-buy-settlement-1",
      remainingGrossPurchasePriceCny: "700",
      remainingBuyFeesCny: "0",
      evidence: fx("usd-cny-acquisition", "7", "2025-01-02T20:00:00.000Z"),
    }],
    ...overrides,
  };
}

describe("paper settlement preflight/audit intent", () => {
  it("aggregates every partial fill once, binds broker evidence, and hashes replay-stably", () => {
    const plan = buyPlan();
    const fills = [
      fill("buy-2", "30", "10", "2026-08-26T13:31:02.000Z"),
      fill("buy-1", "20", "10", "2026-08-26T13:31:01.000Z"),
      fill("buy-3", "50", "10", "2026-08-26T13:31:03.000Z"),
    ];
    const first = createPaperOrderSettlement(buyInput(plan, buyExecution(plan, fills)));
    const replay = createPaperOrderSettlement(buyInput(
      plan,
      buyExecution(plan, [...fills].reverse()),
    ));

    expect(first.status).toBe("READY");
    expect(replay).toEqual(first);
    if (first.status !== "READY") throw new Error("expected READY");
    expect(first.intent.authority).toBe(PAPER_SETTLEMENT_AUTHORITY);
    expect(first.intent.fee).toMatchObject({
      grossNotional: "1000",
      total: "2.29",
      components: {
        commission: "0.99",
        platform: "1.00",
        settlement: "0.30",
      },
    });
    expect(first.intent.execution.fills.map((item) => item.fillId)).toEqual([
      "buy-1",
      "buy-2",
      "buy-3",
    ]);
    expect(first.intent.execution.fills[0]!.priceEvidence).toMatchObject({
      semantics: "SIMULATED_SLIPPAGE_DERIVED_PRICE",
      sourceId: "official-open-source",
      factId: "official-open-fact-lulu",
      sourceArtifactId: "official-open-artifact-lulu",
    });
    expect(first.intent.frozenOrder.referencePriceEvidence.semantics).toBe(
      "FROZEN_ORDER_REFERENCE_PRICE",
    );
    expect(first.intent.cashFence).toMatchObject({
      currentBuyingPower: "3000",
      frozenRemainingBuyingPower: "2000",
      effectiveBuyingPowerLimit: "2000",
      cashEffect: "1002.29",
      frozenRemainingBuyingPowerAfter: "997.71",
    });
    expect(first.intent.balanceTransition).toMatchObject({
      cashAssetBalanceAfter: "1997.71",
      buyingPowerAfter: "1997.71",
      positionQuantityAfter: "100",
      positionGrossCostAfter: "1000",
    });
    expect(first.intent.lotTransition.createdLot).toMatchObject({
      quantity: "100",
      grossPurchasePrice: "1000",
      buyFees: "2.29",
      grossPurchasePriceCny: "7000",
      buyFeesCny: "16.03",
    });
    expect(first.intent.ledgerTransactions[0]!.postings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "securities.inventory",
          side: "DEBIT",
          amount: "1000",
        }),
        expect.objectContaining({
          accountId: "expense.broker_fee",
          side: "DEBIT",
          amount: "2.29",
        }),
      ]),
    );
    expect(first.contentSha256).toBe(
      createHash("sha256").update(first.canonicalJson, "utf8").digest("hex"),
    );
    expect(Object.isFrozen(first.intent)).toBe(true);
    expect(hasJsonNumber(JSON.parse(first.canonicalJson) as unknown)).toBe(false);
  });

  it("uses min(current buying power, frozen plan remaining) and rejects fence escape", () => {
    const plan = buyPlan();
    const partial = buyExecution(
      plan,
      [fill("partial-buy", "50", "10")],
      "50",
      "PARTIALLY_FILLED",
    );

    expect(() => createPaperOrderSettlement(buyInput(plan, partial, {
      planCashFence: {
        planFingerprint: plan.planFingerprint,
        remainingBuyingPower: "500",
        priorSettlementIds: [],
      },
    }))).toThrow("above effective buying-power limit 500");
    expect(() => createPaperOrderSettlement(buyInput(plan, partial, {
      ledgerHead: ledgerHead({ currentBuyingPower: "500" }),
    }))).toThrow("above effective buying-power limit 500");
    expect(() => createPaperOrderSettlement(buyInput(plan, partial, {
      planCashFence: {
        planFingerprint: plan.planFingerprint,
        remainingBuyingPower: "2000",
        priorSettlementIds: ["settlement-from-another-plan"],
      },
    }))).toThrow("outside its frozen plan");
  });

  it("replays the frozen per-order HALF_UP fee rounding into a positive cash effect", () => {
    const halfCentSchedule = defineFutuFeeSchedule({
      feeScheduleId: "half-cent-rounding-v1",
      brokerLegalEntity: "SIMULATED",
      accountRegion: "TEST",
      market: "US",
      product: "US_EQUITY_ETF",
      accountTier: "TEST",
      effectiveFrom: "2026-01-01",
      currency: "USD",
      commissionPerShare: "0.005",
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
    const plan = createS2BuyOrderPlan({
      decisionId: "decision-half-cent",
      s1SessionDate: S1_DATE,
      plannedAt: S2_PLANNED,
      s2TradeDate: S2_DATE,
      preOrderTaxReservedNav: "10",
      buyingPowerEvidence: {
        value: "20",
        snapshotId: "buying-power-half-cent",
        visibleAt: S1_CLOSE,
      },
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "0",
        mark: closeEvidence("10", S1_DATE, S1_CLOSE),
      }],
      targets: [{ instrumentId: "lulu", symbol: "LULU", weightBps: "10000" }],
      cashWeightBps: "0",
      slippageBps: "0",
      fillPriceScale: 8,
      feeSchedules: [halfCentSchedule],
    });
    const result = createPaperOrderSettlement(buyInput(
      plan,
      buyExecution(plan, [fill("half-cent", "1", "10")]),
      { ledgerHead: ledgerHead({ cashAssetBalance: "20", currentBuyingPower: "20" }) },
    ));

    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("expected READY");
    expect(result.intent.fee.components.commission).toBe("0.01");
    expect(result.intent.fee.total).toBe("0.01");
    expect(result.intent.cashFence).toMatchObject({ cashEffect: "10.01" });
    expect(result.intent.balanceTransition.cashAssetBalanceAfter).toBe("9.99");
  });

  it("keeps simulated-open and broker-actual evidence modes distinct", () => {
    const brokerPlan = buyPlan("BROKER_ACTUAL");
    const actual = createPaperOrderSettlement(buyInput(
      brokerPlan,
      buyExecution(brokerPlan, [brokerActualFill("actual-buy", "100", "11")]),
    ));
    expect(actual.status).toBe("READY");
    if (actual.status !== "READY") throw new Error("expected READY");
    expect(actual.intent.execution.fills[0]!.priceEvidence).toMatchObject({
      semantics: "BROKER_ACTUAL_EXECUTION_PRICE",
      providerExecutionId: "alpaca-execution-actual-buy",
    });
    expect(actual.intent.fee.grossNotional).toBe("1100");

    const simulatedPlan = buyPlan();
    expect(() => createPaperOrderSettlement(buyInput(
      simulatedPlan,
      buyExecution(simulatedPlan, [brokerActualFill("wrong-mode", "100", "10")]),
    ))).toThrow("requires derived official-open price evidence");
    expect(() => createPaperOrderSettlement(buyInput(
      brokerPlan,
      buyExecution(brokerPlan, [fill("wrong-mode", "100", "10")]),
    ))).toThrow("requires provider execution evidence");
    expect(() => buyPlan("BROKER_ACTUAL", "1")).toThrow(
      "BROKER_ACTUAL plans must freeze slippageBps at 0",
    );
  });

  it("represents a zero-fill terminal cancellation as an immutable no-op without FX", () => {
    const plan = buyPlan();
    const canceled = buyExecution(
      plan,
      [],
      plan.orders[0]!.quantity,
      "CANCELED",
    );
    const input = buyInput(plan, canceled);
    const { acquisitionFxEvidence: _unusedFx, ...withoutFx } = input;
    const result = createPaperOrderSettlement(withoutFx);

    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("expected READY");
    expect(result.intent.execution).toMatchObject({
      terminalStatus: "CANCELED",
      filledQuantity: "0",
      canceledQuantity: "100",
    });
    expect(result.intent.fee).toMatchObject({ grossNotional: "0", total: "0" });
    expect(result.intent.cashFence).toMatchObject({
      cashEffect: "0",
      frozenRemainingBuyingPowerAfter: "2000",
    });
    expect(result.intent.balanceTransition.cashAssetBalanceAfter).toBe("3000");
    expect(result.intent.ledgerTransactions).toEqual([]);

    const sell = sellPlan();
    const sellWithTaxEvidence = sellInput(sell, {
      ...sellExecution(sell, "1", "200"),
      terminalStatus: "CANCELED",
      canceledQuantity: "1",
      fills: [],
    });
    const {
      sourceCountry: _unusedCountry,
      dispositionFxEvidence: _unusedDispositionFx,
      acquisitionFxEvidence: _unusedAcquisitionFx,
      ...sellWithoutTaxEvidence
    } = sellWithTaxEvidence;
    const canceledSell = createPaperOrderSettlement(sellWithoutTaxEvidence);
    expect(canceledSell.status).toBe("READY");
    if (canceledSell.status !== "READY") throw new Error("expected READY");
    expect(canceledSell.intent.balanceTransition.positionQuantityAfter).toBe("1");
    expect(canceledSell.intent.ledgerTransactions).toEqual([]);
  });

  it("fails closed on JSON numbers and impossible terminal fill accounting", () => {
    const plan = buyPlan();
    const numericFill = {
      ...fill("numeric", "100", "10"),
      price: 10 as unknown as string,
    };
    expect(() => createPaperOrderSettlement(buyInput(
      plan,
      buyExecution(plan, [numericFill]),
    ))).toThrow("Decimal values must cross boundaries as strings");
    expect(() => createPaperOrderSettlement(buyInput(
      plan,
      buyExecution(plan, [], "99", "CANCELED"),
    ))).toThrow("Filled plus canceled quantity must equal");
    expect(() => createPaperOrderSettlement({
      ...buyInput(plan, buyExecution(plan, [fill("future-fill", "100", "10")])),
      settledAt: "2026-08-26T13:30:59.999Z",
      ledgerHead: ledgerHead({ capturedAt: "2026-08-26T13:30:30.000Z" }),
    })).toThrow("cannot execute after settlement time");
  });

  it("requires every simulated partial fill to use the same official-open fact", () => {
    const plan = buyPlan();
    const second = fill("second-open", "50", "11", "2026-08-26T13:31:02.000Z");
    expect(() => createPaperOrderSettlement(buyInput(
      plan,
      buyExecution(plan, [
        fill("first-open", "50", "10", "2026-08-26T13:31:01.000Z"),
        second,
      ]),
    ))).toThrow("must derive from one official-open fact");
  });

  it("returns TAX_UNRESOLVED instead of inventing a formal tax basis without FX", () => {
    const buy = buyPlan();
    const withFx = buyInput(buy, buyExecution(buy, [fill("buy", "100", "10")]));
    const { acquisitionFxEvidence: _unusedFx, ...withoutFx } = withFx;
    const buyResult = createPaperOrderSettlement(withoutFx);
    expect(buyResult.status).toBe("TAX_UNRESOLVED");
    if (buyResult.status !== "TAX_UNRESOLVED") throw new Error("expected unresolved");
    expect(buyResult.unresolved).toMatchObject({
      authority: PAPER_SETTLEMENT_AUTHORITY,
      status: "TAX_UNRESOLVED",
      reason: "BUY_ACQUISITION_FX_REQUIRED",
    });

    const sell = sellPlan();
    const sellResult = createPaperOrderSettlement(sellInput(
      sell,
      sellExecution(sell, "1", "200"),
      { acquisitionFxEvidence: [] },
    ));
    expect(sellResult.status).toBe("TAX_UNRESOLVED");
    if (sellResult.status !== "TAX_UNRESOLVED") throw new Error("expected unresolved");
    expect(sellResult.unresolved).toMatchObject({
      reason: "SELL_ACQUISITION_FX_REQUIRED",
      missingEvidenceIds: ["lulu-lot-1"],
    });
    expect(sellResult.canonicalJson).not.toContain("chinaCapitalGainsTax");
  });

  it("calculates FIFO tax from acquisition/disposition CNY facts, not a USD proxy", () => {
    const plan = sellPlan();
    const result = createPaperOrderSettlement(sellInput(
      plan,
      sellExecution(plan, "1", "200"),
    ));

    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("expected READY");
    expect(result.intent.tax).toMatchObject({
      currency: "CNY",
      grossProceedsCny: "1600",
      allocatedTaxBasisCny: "700",
      realizedGainCny: "900",
      taxableGainCny: "900",
      chinaCapitalGainsTaxCny: "180",
      taxReserveTradingCurrencyAmount: "22.5",
      dispositionFxEvidence: {
        fxRateId: "usd-cny-disposition",
        factId: "usd-cny-disposition-fact",
      },
      allocations: [{
        lotId: "lulu-lot-1",
        acquisitionFxRateId: "usd-cny-acquisition",
      }],
    });
    expect(result.intent.balanceTransition).toMatchObject({
      cashAssetBalanceAfter: "200",
      buyingPowerAfter: "177.5",
      taxReserveAfter: "22.5",
      positionQuantityAfter: "0",
      positionGrossCostAfter: "0",
    });
    expect(result.intent.ledgerTransactions).toHaveLength(2);
    expect(result.intent.ledgerTransactions[0]!.postings).toContainEqual(
      expect.objectContaining({
        accountId: "securities.inventory",
        side: "CREDIT",
        amount: "100",
      }),
    );
  });

  it("allocates the persisted remaining CNY lot basis across partial sells", () => {
    const plan = sellPlan("3", "200");
    const order = plan.orders[0]!;
    const lot = oneLot("3", "100");
    const execution: CompletedPaperOrderExecution = {
      ...sellExecution(plan, "1", "200"),
      terminalStatus: "PARTIALLY_FILLED",
      canceledQuantity: "2",
    };
    const result = createPaperOrderSettlement(sellInput(plan, execution, {
      ledgerHead: ledgerHead({
        capturedAt: "2026-08-25T13:59:00.000Z",
        cashAssetBalance: "0",
        currentBuyingPower: "0",
        positionQuantity: "3",
        positionGrossCostAssetBalance: "100",
      }),
      availableLots: [lot],
      acquisitionFxEvidence: [{
        lotId: lot.lotId,
        acquisitionTradeDate: "2025-01-02",
        acquisitionSettlementId: "historical-buy-settlement-1",
        // This carried total deliberately differs from 100 USD * 7. It proves
        // later partial sells conserve persisted CNY basis instead of re-FXing.
        remainingGrossPurchasePriceCny: "701",
        remainingBuyFeesCny: "0",
        evidence: fx("usd-cny-acquisition", "7", "2025-01-02T20:00:00.000Z"),
      }],
    }));

    expect(order.quantity).toBe("3");
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("expected READY");
    expect(result.intent.tax.allocatedTaxBasisCny).toBe("233.666666666667");
    expect(result.intent.tax.acquisitionLotBindings[0]).toMatchObject({
      remainingGrossPurchasePriceCny: "701",
      acquisitionTradeDate: "2025-01-02",
    });
  });

  it("rejects FX facts whose effective date is not the bound transaction date", () => {
    const plan = sellPlan();
    expect(() => createPaperOrderSettlement(sellInput(
      plan,
      sellExecution(plan, "1", "200"),
      {
        dispositionFxEvidence: fx(
          "wrong-day-disposition",
          "8",
          "2026-08-24T13:45:00.000Z",
        ),
      },
    ))).toThrow("disposition FX effective date must equal 2026-08-25");
  });

  it("rejects shorts and produces a balanced loss transaction without malformed signs", () => {
    const twoSharePlan = sellPlan("2", "200");
    const oneLotState = sellInput(
      twoSharePlan,
      sellExecution(twoSharePlan, "2", "200"),
    );
    expect(() => createPaperOrderSettlement(oneLotState)).toThrow(
      "would create a short position",
    );

    const lossPlan = sellPlan("1", "100");
    const loss = createPaperOrderSettlement(sellInput(
      lossPlan,
      sellExecution(lossPlan, "1", "50"),
      {
        dispositionFxEvidence: fx(
          "usd-cny-loss-disposition",
          "7",
          "2026-08-25T13:45:00.000Z",
        ),
      },
    ));
    expect(loss.status).toBe("READY");
    if (loss.status !== "READY") throw new Error("expected READY");
    expect(loss.intent.ledgerTransactions[0]!.postings).toContainEqual(
      expect.objectContaining({
        accountId: "expense.realized_loss",
        side: "DEBIT",
        amount: "50",
      }),
    );
    expect(loss.intent.tax.chinaCapitalGainsTaxCny).toBe("0");
  });

  it("rejects fill evidence that was not visible by settlement time", () => {
    const plan = buyPlan();
    const late = fill("late", "100", "10");
    const changed = {
      ...late,
      priceEvidence: {
        ...late.priceEvidence,
        observedAt: "2026-08-26T14:00:00.001Z",
      },
    };
    expect(() => createPaperOrderSettlement(buyInput(
      plan,
      buyExecution(plan, [changed]),
    ))).toThrow("not visible by settlement time");
  });
});

function hasJsonNumber(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.some(hasJsonNumber);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(hasJsonNumber);
  }
  return false;
}
