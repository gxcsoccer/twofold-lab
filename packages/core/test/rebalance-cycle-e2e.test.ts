import { describe, expect, it } from "vitest";

import {
  prepareAcceptedTargetCycleS1,
  runAcceptedTargetCycle,
  settleAcceptedTargetCycleS1AndPrepareS2,
  type AcceptedTargetCycleInput,
} from "../src/decision-cycle.js";
import { nonNegativeDecimal, sequence } from "../src/decimal.js";
import { defineFutuFeeSchedule } from "../src/futu-fees.js";
import {
  createOpeningLedgerTransactions,
  validateInitialPortfolioSnapshot,
} from "../src/portfolio.js";

/**
 * The rebalance that Round 1 of private-us-liquid-100-s4 never completed.
 *
 * `decision-cycle.test.ts` already proves the engine can carry an accepted
 * target from plan to NAV, but it does so on a timeline where the decision is
 * accepted the same UTC evening it is made. Production is not shaped like that.
 * A Round publishes a decision window that closes fifteen minutes before the S1
 * open, and 09:30 New York is 13:30 UTC, so the last legal instant to accept a
 * target falls on the *S1 session date*, after UTC midnight - and if the
 * decision session was a Friday, after two UTC midnights. Every acceptance in
 * that window was legal to the exchange and refused by the engine, which asked
 * only whether the UTC day had turned.
 *
 * So this fixture is the failing shape, not a convenient one: the live opening
 * state of both entrants (150 LULU, no cash, ledger head at sequence 0, zero
 * fills), the Round's own weekend-carry timeline, and an acceptance one minute
 * inside the published window. It asserts the whole chain the Round owed and
 * never delivered - fills with real quantity, a ledger that advances, tax and
 * fees, and a NAV - plus the retry behaviour that has to hold because the
 * staged Arena phases re-derive from frozen evidence rather than resume.
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const LULU = "10000000-0000-4000-8000-000000000001";
const QQQ = "10000000-0000-4000-8000-000000000002";

function zeroFeeSchedule() {
  return defineFutuFeeSchedule({
    feeScheduleId: "zero-fee-e2e-v1",
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

function closeMark(value: string, sessionDate: string, visibleAt: string) {
  return {
    value,
    kind: "OFFICIAL_CLOSE" as const,
    sessionDate,
    visibleAt,
    snapshotId: `close-snapshot-${sessionDate}`,
    factId: `close-fact-${sessionDate}-${value}`,
  };
}

function officialOpen(
  label: string,
  value: string,
  sessionDate: string,
  observedAt: string,
) {
  return {
    sourceId: "official-auction-test",
    sourceVersionId: "official-auction-test-v1",
    factId: `official-open-${label}-${sessionDate}`,
    sourceArtifactId: `official-open-artifact-${label}-${sessionDate}`,
    sourceContentSha256: HASH_B,
    observedAt,
    snapshotId: `official-open-snapshot-${label}-${sessionDate}`,
    sessionDate,
    value,
  };
}

function fx(id: string, rate: string, effectiveAt: string) {
  return {
    fxRateId: id,
    factId: `${id}-fact`,
    sourceVersionId: `${id}-source-version`,
    sourceArtifactId: `${id}-artifact`,
    sourceContentSha256: HASH_C,
    baseCurrency: "USD",
    quoteCurrency: "CNY" as const,
    cnyPerBaseUnit: rate,
    effectiveAt,
    visibleAt: effectiveAt,
    status: "FINAL" as const,
  };
}

/**
 * The live pre-round state of both entrants: one opening LULU lot, no cash, and
 * a ledger that has never moved past its opening import.
 */
function openingPortfolio() {
  const snapshot = validateInitialPortfolioSnapshot({
    snapshotId: "opening-futu-statement",
    schema: "twofold.initial_portfolio/v1",
    asOf: "2026-08-28T00:00:00.000Z",
    brokerLegalEntity: "FUTU_HK",
    accountRegion: "HK",
    baseCurrency: "USD",
    sourceArtifactSha256: HASH_A,
    cashBalances: [{ currency: "USD", settledCash: "0", unsettledCash: "0" }],
    lots: [{
      lotId: "lulu-opening-lot",
      instrumentId: LULU,
      symbol: "LULU",
      acquiredOn: "2025-01-02",
      quantity: "150",
      purchasePricePerShare: "100",
      buyFees: "0",
      currency: "USD",
    }],
  });
  return {
    snapshot,
    priorLedgerTransactions: createOpeningLedgerTransactions({
      runId: "20000000-0000-4000-8000-000000000001",
      sourceEventId: "opening-import-event",
      snapshot,
    }),
  };
}

/**
 * Round 1's published timeline: decision session Friday 2026-08-28, decision
 * window closing 13:15 UTC on Monday, S1 Monday, S2 Tuesday. `s1PlannedAt` is
 * the acceptance instant, one minute before the window closes - three calendar
 * days after the decision session and thirteen hours into the S1 trade date.
 */
function cycleInput(): AcceptedTargetCycleInput {
  const { snapshot, priorLedgerTransactions } = openingPortfolio();
  const openingLot = snapshot.lots[0]!;

  return {
    acceptedSubmission: {
      submissionId: "30000000-0000-4000-8000-000000000001",
      decisionId: "40000000-0000-4000-8000-000000000001",
      targets: [
        { instrumentId: LULU, symbol: "LULU", targetWeightBps: "3000" },
        { instrumentId: QQQ, symbol: "QQQ", targetWeightBps: "5000" },
      ],
      cashWeightBps: "2000",
    },
    account: {
      strategyAccountId: "50000000-0000-4000-8000-000000000001",
      runId: "20000000-0000-4000-8000-000000000001",
      currency: "USD",
      cashAssetBalance: "0",
      taxReserveBalance: "0",
      headSequence: "0",
      headHash: HASH_A,
      priorLedgerTransactions,
    },
    timeline: {
      decisionSessionDate: "2026-08-28",
      decisionCutoffAt: "2026-08-28T20:15:00.000Z",
      s1PlannedAt: "2026-08-31T13:14:00.000Z",
      s1TradeDate: "2026-08-31",
      s1SessionOpenAt: "2026-08-31T13:30:00.000Z",
      s1ExecutedAt: "2026-08-31T13:30:00.000Z",
      s1SettledAt: "2026-08-31T13:31:00.000Z",
      s1CloseAt: "2026-08-31T20:15:00.000Z",
      s2PlannedAt: "2026-08-31T20:20:05.000Z",
      s2TradeDate: "2026-09-01",
      s2SessionOpenAt: "2026-09-01T13:30:00.000Z",
      s2ExecutedAt: "2026-09-01T13:30:00.000Z",
      s2SettledAt: "2026-09-01T13:31:00.000Z",
      navAsOf: "2026-09-01T20:15:00.000Z",
    },
    instruments: [
      {
        instrumentId: LULU,
        symbol: "LULU",
        sourceCountry: "US",
        quantity: "150",
        grossCost: "15000",
        lots: [{
          lotId: openingLot.lotId,
          instrumentId: openingLot.instrumentId,
          acquisitionSequence: sequence(openingLot.acquisitionSequence),
          quantity: nonNegativeDecimal(openingLot.quantity),
          grossPurchasePrice: nonNegativeDecimal(openingLot.grossPurchasePrice),
          buyFees: nonNegativeDecimal(openingLot.buyFees),
        }],
        acquisitionFxBindings: [{
          lotId: "lulu-opening-lot",
          acquisitionTradeDate: "2025-01-02",
          acquisitionSettlementId: "opening-import",
          remainingGrossPurchasePriceCny: "105000",
          remainingBuyFeesCny: "0",
          evidence: fx("usd-cny-lulu-acquisition", "7", "2025-01-02T20:00:00.000Z"),
        }],
        decisionCloseMark: closeMark("120", "2026-08-28", "2026-08-28T20:15:00.000Z"),
        s1CloseMark: closeMark("120", "2026-08-31", "2026-08-31T20:15:00.000Z"),
        finalMark: closeMark("125", "2026-09-01", "2026-09-01T20:15:00.000Z"),
      },
      {
        instrumentId: QQQ,
        symbol: "QQQ",
        sourceCountry: "US",
        quantity: "0",
        grossCost: "0",
        lots: [],
        acquisitionFxBindings: [],
        decisionCloseMark: closeMark("50", "2026-08-28", "2026-08-28T20:15:00.000Z"),
        s1CloseMark: closeMark("50", "2026-08-31", "2026-08-31T20:15:00.000Z"),
        finalMark: closeMark("55", "2026-09-01", "2026-09-01T20:15:00.000Z"),
      },
    ],
    s1OfficialOpenByInstrument: {
      [LULU]: officialOpen("lulu", "120", "2026-08-31", "2026-08-31T13:30:00.000Z"),
    },
    s2OfficialOpenByInstrument: {
      [QQQ]: officialOpen("qqq", "50", "2026-09-01", "2026-09-01T13:30:00.000Z"),
    },
    dispositionFxByInstrument: {
      [LULU]: fx("usd-cny-lulu-disposition", "7.5", "2026-08-31T13:30:00.000Z"),
    },
    acquisitionFxByInstrument: {
      [QQQ]: fx("usd-cny-qqq-acquisition", "7.2", "2026-09-01T13:30:00.000Z"),
    },
    feeSchedules: [zeroFeeSchedule()],
    slippageBps: "0",
    fillPriceScale: 8,
    taxAllocationScale: 12,
  };
}

function s1PlanInput(full: AcceptedTargetCycleInput) {
  return {
    acceptedSubmission: full.acceptedSubmission,
    account: full.account,
    timeline: {
      decisionSessionDate: full.timeline.decisionSessionDate,
      decisionCutoffAt: full.timeline.decisionCutoffAt,
      s1PlannedAt: full.timeline.s1PlannedAt,
      s1TradeDate: full.timeline.s1TradeDate,
      ...(full.timeline.s1SessionOpenAt === undefined
        ? {}
        : { s1SessionOpenAt: full.timeline.s1SessionOpenAt }),
    },
    instruments: full.instruments.map((instrument) => ({
      instrumentId: instrument.instrumentId,
      symbol: instrument.symbol,
      sourceCountry: instrument.sourceCountry,
      quantity: instrument.quantity,
      grossCost: instrument.grossCost,
      lots: instrument.lots,
      acquisitionFxBindings: instrument.acquisitionFxBindings,
      decisionCloseMark: instrument.decisionCloseMark,
    })),
    ...(full.feeSchedules === undefined ? {} : { feeSchedules: full.feeSchedules }),
    slippageBps: full.slippageBps,
    fillPriceScale: full.fillPriceScale,
    taxAllocationScale: full.taxAllocationScale,
  };
}

function s1CheckpointInput(full: AcceptedTargetCycleInput) {
  return {
    acceptedSubmission: full.acceptedSubmission,
    account: full.account,
    timeline: {
      decisionSessionDate: full.timeline.decisionSessionDate,
      decisionCutoffAt: full.timeline.decisionCutoffAt,
      s1PlannedAt: full.timeline.s1PlannedAt,
      s1TradeDate: full.timeline.s1TradeDate,
      ...(full.timeline.s1SessionOpenAt === undefined
        ? {}
        : { s1SessionOpenAt: full.timeline.s1SessionOpenAt }),
      s1ExecutedAt: full.timeline.s1ExecutedAt,
      s1SettledAt: full.timeline.s1SettledAt,
      s1CloseAt: full.timeline.s1CloseAt,
      s2PlannedAt: full.timeline.s2PlannedAt,
      s2TradeDate: full.timeline.s2TradeDate,
      ...(full.timeline.s2SessionOpenAt === undefined
        ? {}
        : { s2SessionOpenAt: full.timeline.s2SessionOpenAt }),
    },
    instruments: full.instruments.map(({ finalMark: _finalMark, ...rest }) => rest),
    s1OfficialOpenByInstrument: full.s1OfficialOpenByInstrument,
    dispositionFxByInstrument: full.dispositionFxByInstrument,
    ...(full.feeSchedules === undefined ? {} : { feeSchedules: full.feeSchedules }),
    slippageBps: full.slippageBps,
    fillPriceScale: full.fillPriceScale,
    taxAllocationScale: full.taxAllocationScale,
  };
}

function withoutSessionOpens(full: AcceptedTargetCycleInput): AcceptedTargetCycleInput {
  const {
    s1SessionOpenAt: _s1SessionOpenAt,
    s2SessionOpenAt: _s2SessionOpenAt,
    ...timeline
  } = full.timeline;
  return { ...full, timeline };
}

describe("end-to-end rebalance on a Round's own published timeline", () => {
  it("carries an accepted target through S1 sell, S2 buy, fills, ledger, tax and NAV", () => {
    const result = runAcceptedTargetCycle(cycleInput());

    // S1: 150 LULU at 120 is 18000 of taxReserved NAV; a 30% target is 45
    // shares, so 105 shares have to go.
    expect(result.s1.plan.orders).toHaveLength(1);
    expect(result.s1.plan.orders[0]).toMatchObject({
      symbol: "LULU",
      side: "SELL",
      quantity: "105",
      plannedAt: "2026-08-31T13:14:00.000Z",
      plannedTradeDate: "2026-08-31",
    });

    const s1Intent = result.s1.settlements[0]?.intent;
    expect(s1Intent).toMatchObject({
      stage: "S1",
      side: "SELL",
      execution: {
        terminalStatus: "FILLED",
        filledQuantity: "105",
        canceledQuantity: "0",
        tradeDate: "2026-08-31",
      },
      // 105 shares gained 20 USD each; at 7.5 CNY that is 21000 CNY of gain,
      // and the 20% reserve converts back to 560 USD of unavailable cash.
      tax: {
        chinaCapitalGainsTaxCny: "4200",
        taxReserveTradingCurrencyAmount: "560",
      },
      balanceTransition: {
        cashAssetBalanceAfter: "12600",
        buyingPowerAfter: "12040",
        positionQuantityAfter: "45",
      },
    });
    // The observability finding was "0 fills with positive quantity". A filled
    // quantity in the aggregate is not evidence of that on its own.
    expect(s1Intent?.execution.fills.length).toBeGreaterThan(0);
    for (const fill of s1Intent?.execution.fills ?? []) {
      expect(Number(fill.quantity)).toBeGreaterThan(0);
      expect(fill.price).toBe("120");
    }

    // S2 buys against 17440 of taxReserved NAV: LULU already sits above its
    // 30% target, so only the 50% QQQ target draws an order.
    expect(result.s1.nav).toMatchObject({
      brokerNav: "18000",
      taxReserveDeductions: "560",
      taxReservedNav: "17440",
    });
    expect(result.s2.plan.orders).toHaveLength(1);
    expect(result.s2.plan.orders[0]).toMatchObject({
      symbol: "QQQ",
      side: "BUY",
      quantity: "174",
      plannedTradeDate: "2026-09-01",
    });

    const s2Intent = result.s2.settlements[0]?.intent;
    expect(s2Intent).toMatchObject({
      stage: "S2",
      side: "BUY",
      execution: {
        terminalStatus: "FILLED",
        filledQuantity: "174",
        tradeDate: "2026-09-01",
      },
      balanceTransition: {
        cashAssetBalanceAfter: "3900",
        buyingPowerAfter: "3340",
        positionQuantityAfter: "174",
      },
    });
    expect(s2Intent?.execution.fills.length).toBeGreaterThan(0);
    for (const fill of s2Intent?.execution.fills ?? []) {
      expect(Number(fill.quantity)).toBeGreaterThan(0);
      expect(fill.price).toBe("50");
    }

    // The ledger has to move: production showed head sequence 0 and no
    // transactions beyond the opening import.
    expect(result.ledger).toMatchObject({ transactionCount: "4" });
    expect(result.finalLedgerHead.sequence).toBe("2");
    expect(result.finalLedgerHead.sha256).not.toBe(HASH_A);
    expect(result.ledger.balances).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: "asset.cash",
        currency: "USD",
        amount: "3900",
      }),
      // 15000 of opening cost less the 10500 relieved by the sale, plus the
      // 8700 QQQ purchase.
      expect.objectContaining({
        accountId: "securities.inventory",
        currency: "USD",
        amount: "13200",
      }),
      expect.objectContaining({
        accountId: "liability.china_tax_accrual",
        currency: "CNY",
        amount: "4200",
      }),
    ]));
    expect(result.positions).toEqual([
      expect.objectContaining({ symbol: "LULU", quantity: "45" }),
      expect.objectContaining({ symbol: "QQQ", quantity: "174" }),
    ]);

    // Fees are zero by fixture, so every difference between the three NAVs is
    // attributable and checkable.
    expect(result.nav).toMatchObject({
      positionMarketValue: "15195",
      brokerNav: "19095",
      taxReserveDeductions: "560",
      taxReservedNav: "18535",
    });
    expect(Number(result.nav.liquidationDeductions)).toBeGreaterThan(0);
    expect(Number(result.nav.liquidationNav)).toBe(
      Number(result.nav.brokerNav)
        - Number(result.nav.taxReserveDeductions)
        - Number(result.nav.liquidationDeductions),
    );
    expect(Number(result.nav.liquidationNav)).toBeLessThan(
      Number(result.nav.taxReservedNav),
    );
  });

  it("cannot plan the same accepted target when no S1 session open is named", () => {
    // This is the Round 1 failure, isolated: the acceptance is inside the
    // published window, and the UTC-date proxy still refuses it. The default
    // stays refusing on purpose - a caller without an exchange calendar has no
    // business widening the fence - so the timeline field is what closes it.
    expect(() => runAcceptedTargetCycle(withoutSessionOpens(cycleInput())))
      .toThrow("S1 plan.plannedAt must precede the planned trade date");
  });

  it("refuses an S1 session open that belongs to another session", () => {
    const full = cycleInput();
    expect(() => runAcceptedTargetCycle({
      ...full,
      timeline: { ...full.timeline, s1SessionOpenAt: "2026-09-01T13:30:00.000Z" },
    })).toThrow("S1 plan.tradeSessionOpenAt must fall on the planned trade date");
  });

  it("agrees with the staged Arena entry points at every stage boundary", () => {
    // The Arena runs this cycle as three separate work items, each re-deriving
    // from frozen evidence. If a stage disagreed with the whole, a Round could
    // freeze one plan and then be unable to carry it - which is what happened.
    const full = cycleInput();
    const prepared = prepareAcceptedTargetCycleS1(s1PlanInput(full));
    const checkpoint = settleAcceptedTargetCycleS1AndPrepareS2(s1CheckpointInput(full));
    const completed = runAcceptedTargetCycle(full);

    expect(prepared.plan).toEqual(completed.s1.plan);
    expect(checkpoint.s1).toEqual(completed.s1);
    expect(checkpoint.s2Plan).toEqual(completed.s2.plan);
    expect(checkpoint.account).toMatchObject({
      cashAssetBalance: "12600",
      buyingPower: "12040",
      taxReserveBalance: "560",
      headSequence: "1",
    });
  });

  it("is byte-identical when a stage or the whole cycle is retried", () => {
    const first = runAcceptedTargetCycle(cycleInput());
    const retry = runAcceptedTargetCycle(cycleInput());

    expect(retry.canonicalJson).toBe(first.canonicalJson);
    expect(retry.contentSha256).toBe(first.contentSha256);
    expect(retry.finalLedgerHead).toEqual(first.finalLedgerHead);

    // A retried stage has to re-derive the same plan too: `frozen_order_plan`
    // is immutable per (decision_id, stage), so a re-registration that differed
    // by one byte would strand the decision instead of recovering it.
    const preparedRetry = prepareAcceptedTargetCycleS1(s1PlanInput(cycleInput()));
    expect(preparedRetry.contentSha256).toBe(
      prepareAcceptedTargetCycleS1(s1PlanInput(cycleInput())).contentSha256,
    );
    expect(preparedRetry.plan).toEqual(first.s1.plan);
  });
});
