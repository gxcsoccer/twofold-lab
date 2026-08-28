import { describe, expect, it } from "vitest";

import {
  runAcceptedTargetCycle,
  type AcceptedTargetCycleInput,
} from "../src/decision-cycle.js";
import { nonNegativeDecimal, sequence } from "../src/decimal.js";
import { defineFutuFeeSchedule } from "../src/futu-fees.js";
import { createOpeningLedgerTransactions } from "../src/portfolio.js";
import { validateInitialPortfolioSnapshot } from "../src/portfolio.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function zeroFeeSchedule() {
  return defineFutuFeeSchedule({
    feeScheduleId: "zero-fee-cycle-v1",
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
  instrumentId: string,
  value: string,
  sessionDate: string,
  observedAt: string,
) {
  return {
    sourceId: "official-auction-test",
    sourceVersionId: "official-auction-test-v1",
    factId: `official-open-${instrumentId}-${sessionDate}`,
    sourceArtifactId: `official-open-artifact-${instrumentId}-${sessionDate}`,
    sourceContentSha256: HASH_B,
    observedAt,
    snapshotId: `official-open-snapshot-${sessionDate}`,
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

function cycleInput(): AcceptedTargetCycleInput {
  const openingSnapshot = validateInitialPortfolioSnapshot({
    snapshotId: "opening-futu-statement",
    schema: "twofold.initial_portfolio/v1",
    asOf: "2026-08-24T00:00:00.000Z",
    brokerLegalEntity: "FUTU_HK",
    accountRegion: "HK",
    baseCurrency: "USD",
    sourceArtifactSha256: HASH_A,
    cashBalances: [{
      currency: "USD",
      settledCash: "0",
      unsettledCash: "0",
    }],
    lots: [{
      lotId: "lulu-opening-lot",
      instrumentId: "10000000-0000-4000-8000-000000000001",
      symbol: "LULU",
      acquiredOn: "2025-01-02",
      quantity: "10",
      purchasePricePerShare: "100",
      buyFees: "0",
      currency: "USD",
    }],
  });
  const priorLedgerTransactions = createOpeningLedgerTransactions({
    runId: "20000000-0000-4000-8000-000000000001",
    sourceEventId: "opening-import-event",
    snapshot: openingSnapshot,
  });

  return {
    acceptedSubmission: {
      submissionId: "30000000-0000-4000-8000-000000000001",
      decisionId: "40000000-0000-4000-8000-000000000001",
      targets: [
        {
          instrumentId: "10000000-0000-4000-8000-000000000001",
          symbol: "LULU",
          targetWeightBps: "4000",
        },
        {
          instrumentId: "10000000-0000-4000-8000-000000000002",
          symbol: "QQQ",
          targetWeightBps: "4000",
        },
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
      decisionSessionDate: "2026-08-24",
      decisionCutoffAt: "2026-08-24T20:15:00.000Z",
      s1PlannedAt: "2026-08-24T20:16:00.000Z",
      s1TradeDate: "2026-08-25",
      s1ExecutedAt: "2026-08-25T13:31:00.000Z",
      s1SettledAt: "2026-08-25T13:32:00.000Z",
      s1CloseAt: "2026-08-25T20:15:00.000Z",
      s2PlannedAt: "2026-08-25T20:16:00.000Z",
      s2TradeDate: "2026-08-26",
      s2ExecutedAt: "2026-08-26T13:31:00.000Z",
      s2SettledAt: "2026-08-26T13:32:00.000Z",
      navAsOf: "2026-08-26T20:15:00.000Z",
    },
    instruments: [
      {
        instrumentId: "10000000-0000-4000-8000-000000000001",
        symbol: "LULU",
        sourceCountry: "US",
        quantity: "10",
        grossCost: "1000",
        lots: [{
          lotId: openingSnapshot.lots[0]!.lotId,
          instrumentId: openingSnapshot.lots[0]!.instrumentId,
          acquisitionSequence: sequence(openingSnapshot.lots[0]!.acquisitionSequence),
          quantity: nonNegativeDecimal(openingSnapshot.lots[0]!.quantity),
          grossPurchasePrice: nonNegativeDecimal(
            openingSnapshot.lots[0]!.grossPurchasePrice,
          ),
          buyFees: nonNegativeDecimal(openingSnapshot.lots[0]!.buyFees),
        }],
        acquisitionFxBindings: [{
          lotId: "lulu-opening-lot",
          acquisitionTradeDate: "2025-01-02",
          acquisitionSettlementId: "opening-import",
          remainingGrossPurchasePriceCny: "7000",
          remainingBuyFeesCny: "0",
          evidence: fx(
            "usd-cny-lulu-acquisition",
            "7",
            "2025-01-02T20:00:00.000Z",
          ),
        }],
        decisionCloseMark: closeMark(
          "200",
          "2026-08-24",
          "2026-08-24T20:15:00.000Z",
        ),
        s1CloseMark: closeMark(
          "200",
          "2026-08-25",
          "2026-08-25T20:15:00.000Z",
        ),
        finalMark: closeMark(
          "210",
          "2026-08-26",
          "2026-08-26T20:15:00.000Z",
        ),
      },
      {
        instrumentId: "10000000-0000-4000-8000-000000000002",
        symbol: "QQQ",
        sourceCountry: "US",
        quantity: "0",
        grossCost: "0",
        lots: [],
        acquisitionFxBindings: [],
        decisionCloseMark: closeMark(
          "100",
          "2026-08-24",
          "2026-08-24T20:15:00.000Z",
        ),
        s1CloseMark: closeMark(
          "100",
          "2026-08-25",
          "2026-08-25T20:15:00.000Z",
        ),
        finalMark: closeMark(
          "110",
          "2026-08-26",
          "2026-08-26T20:15:00.000Z",
        ),
      },
    ],
    s1OfficialOpenByInstrument: {
      "10000000-0000-4000-8000-000000000001": officialOpen(
        "lulu",
        "200",
        "2026-08-25",
        "2026-08-25T13:30:00.000Z",
      ),
    },
    s2OfficialOpenByInstrument: {
      "10000000-0000-4000-8000-000000000002": officialOpen(
        "qqq",
        "100",
        "2026-08-26",
        "2026-08-26T13:30:00.000Z",
      ),
    },
    dispositionFxByInstrument: {
      "10000000-0000-4000-8000-000000000001": fx(
        "usd-cny-lulu-disposition",
        "8",
        "2026-08-25T13:30:00.000Z",
      ),
    },
    acquisitionFxByInstrument: {
      "10000000-0000-4000-8000-000000000002": fx(
        "usd-cny-qqq-acquisition",
        "7",
        "2026-08-26T13:30:00.000Z",
      ),
    },
    feeSchedules: [zeroFeeSchedule()],
    slippageBps: "0",
    fillPriceScale: 8,
    taxAllocationScale: 12,
    liquidation: {
      estimatedCloseFeesForAllPositions: "0",
      estimatedUnrealizedLiquidationTax: "0",
    },
  };
}

describe("accepted target decision cycle", () => {
  it("settles S1 then S2 into one replayable ledger and produces NAV", () => {
    const result = runAcceptedTargetCycle(cycleInput());

    expect(result.s1.plan.orders).toHaveLength(1);
    expect(result.s1.settlements[0]?.intent).toMatchObject({
      stage: "S1",
      side: "SELL",
      execution: { filledQuantity: "6" },
      tax: {
        chinaCapitalGainsTaxCny: "1080",
        taxReserveTradingCurrencyAmount: "135",
      },
      balanceTransition: {
        cashAssetBalanceAfter: "1200",
        buyingPowerAfter: "1065",
        positionQuantityAfter: "4",
      },
    });
    expect(result.s2.plan.orders).toHaveLength(1);
    expect(result.s2.settlements[0]?.intent).toMatchObject({
      stage: "S2",
      side: "BUY",
      execution: { filledQuantity: "7" },
      balanceTransition: {
        cashAssetBalanceAfter: "500",
        buyingPowerAfter: "365",
        positionQuantityAfter: "7",
      },
    });

    expect(result.ledger).toMatchObject({ transactionCount: "4" });
    expect(result.ledger.balances).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accountId: "asset.cash",
        currency: "USD",
        amount: "500",
      }),
      expect.objectContaining({
        accountId: "securities.inventory",
        currency: "USD",
        amount: "1100",
      }),
      expect.objectContaining({
        accountId: "liability.china_tax_accrual",
        currency: "CNY",
        amount: "1080",
      }),
    ]));
    expect(result.positions).toEqual([
      expect.objectContaining({ symbol: "LULU", quantity: "4" }),
      expect.objectContaining({ symbol: "QQQ", quantity: "7" }),
    ]);
    expect(result.nav).toMatchObject({
      positionMarketValue: "1610",
      brokerNav: "2110",
      taxReserveDeductions: "135",
      taxReservedNav: "1975",
      liquidationNav: "1975",
    });
  });

  it("is byte- and hash-stable across exact replay", () => {
    const first = runAcceptedTargetCycle(cycleInput());
    const replay = runAcceptedTargetCycle(cycleInput());

    expect(replay.canonicalJson).toBe(first.canonicalJson);
    expect(replay.contentSha256).toBe(first.contentSha256);
    expect(replay.finalLedgerHead).toEqual(first.finalLedgerHead);
  });

  it("rejects a submission whose declared weights are not complete", () => {
    const input = cycleInput();
    expect(() => runAcceptedTargetCycle({
      ...input,
      acceptedSubmission: {
        ...input.acceptedSubmission,
        cashWeightBps: "1999",
      },
    })).toThrow("must total exactly 10000");
  });
});
