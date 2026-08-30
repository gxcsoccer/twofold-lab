import { describe, expect, it } from "vitest";

import { compareCodePoints } from "../src/canonical-json.js";
import { createCompetitionGenesis } from "../src/competition-genesis.js";
import {
  runAcceptedTargetCycle,
  type AcceptedTargetCycleInput,
  type AcceptedTargetCycleResult,
} from "../src/decision-cycle.js";
import { nonNegativeDecimal, sequence } from "../src/decimal.js";
import { compareDecimals } from "../src/fixed-decimal.js";
import { FUTU_HK_US_EQUITY_FIXED_2026_08_23 } from "../src/futu-fees.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const LULU = "93000000-0000-4000-8000-000000000001";
const QQQ = "93000000-0000-4000-8000-000000000002";
const SPY = "93000000-0000-4000-8000-000000000003";

const ENTRANTS = {
  twofold: {
    entrantId: "94000000-0000-4000-8000-000000000001",
    runId: "95000000-0000-4000-8000-000000000001",
    strategyAccountId: "96000000-0000-4000-8000-000000000001",
    submissionId: "97000000-0000-4000-8000-000000000001",
    decisionId: "98000000-0000-4000-8000-000000000001",
    targets: [
      { instrumentId: LULU, symbol: "LULU", targetWeightBps: "4000" },
      { instrumentId: QQQ, symbol: "QQQ", targetWeightBps: "3000" },
      { instrumentId: SPY, symbol: "SPY", targetWeightBps: "3000" },
    ],
    cashWeightBps: "0",
  },
  "twofold-orchestrator": {
    entrantId: "94000000-0000-4000-8000-000000000002",
    runId: "95000000-0000-4000-8000-000000000002",
    strategyAccountId: "96000000-0000-4000-8000-000000000002",
    submissionId: "97000000-0000-4000-8000-000000000002",
    decisionId: "98000000-0000-4000-8000-000000000002",
    targets: [
      { instrumentId: LULU, symbol: "LULU", targetWeightBps: "1500" },
      { instrumentId: QQQ, symbol: "QQQ", targetWeightBps: "3500" },
      { instrumentId: SPY, symbol: "SPY", targetWeightBps: "4500" },
    ],
    cashWeightBps: "500",
  },
} as const;

type EntrantCode = keyof typeof ENTRANTS;

function genesis() {
  return createCompetitionGenesis({
    schema: "twofold.competition_genesis/v1",
    genesisId: "private-controlled-lab-v2-rehearsal:lulu-150",
    seasonId: "91000000-0000-4000-8000-000000000001",
    asOf: "2026-08-28T21:00:00.000Z",
    brokerLegalEntity: "FUTU_HK",
    accountRegion: "HK",
    baseCurrency: "USD",
    openingStateArtifactId: "92000000-0000-4000-8000-000000000001",
    openingStateArtifactSha256: HASH_A,
    cashBalances: [],
    lots: [{
      lotId: "lulu-genesis-lot",
      instrumentId: LULU,
      symbol: "LULU",
      acquiredOn: "2026-08-28",
      quantity: "150",
      purchasePricePerShare: "120",
      buyFees: "0",
      currency: "USD",
      acquisitionFx: {
        effectiveDate: "2026-08-28",
        cnyPerUsd: "7.1",
        authority: "ECB_REFERENCE_CROSS",
        sourceArtifactId: "92000000-0000-4000-8000-000000000002",
        sourceSha256: HASH_B,
        observedAt: "2026-08-28T15:59:00.000Z",
        availableAt: "2026-08-28T16:00:00.000Z",
      },
    }],
    entrants: Object.entries(ENTRANTS).map(([code, entrant], index) => ({
      entrantId: entrant.entrantId,
      runId: entrant.runId,
      sourceEventId:
        `99000000-0000-4000-8000-00000000000${index + 1}`,
      code,
    })),
  });
}

function closeMark(
  symbol: string,
  value: string,
  sessionDate: string,
  visibleAt: string,
) {
  return {
    value,
    kind: "OFFICIAL_CLOSE" as const,
    sessionDate,
    visibleAt,
    snapshotId: `shared-close-${sessionDate}`,
    factId: `shared-close-${symbol}-${sessionDate}`,
  };
}

function minuteOpen(
  symbol: string,
  value: string,
  observedVolume: string,
  sessionDate: string,
  observedAt: string,
) {
  return {
    sourceId: "alpaca-sip",
    sourceVersionId: "alpaca-sip-raw-1min-vwap-volume-v2",
    factId: `shared-open-${symbol}-${sessionDate}`,
    sourceArtifactId: `shared-open-artifact-${sessionDate}`,
    sourceContentSha256: HASH_C,
    observedAt,
    snapshotId: `shared-open-snapshot-${sessionDate}`,
    sessionDate,
    value,
    observedVolume,
  };
}

function fx(id: string, rate: string, effectiveAt: string) {
  return {
    fxRateId: id,
    factId: `${id}-fact`,
    sourceVersionId: "ecb-reference-cross-v1",
    sourceArtifactId: `${id}-artifact`,
    sourceContentSha256: HASH_B,
    baseCurrency: "USD",
    quoteCurrency: "CNY" as const,
    cnyPerBaseUnit: rate,
    effectiveAt,
    visibleAt: effectiveAt,
    status: "FINAL" as const,
  };
}

function cycleInput(
  code: EntrantCode,
  competition: ReturnType<typeof genesis>,
): AcceptedTargetCycleInput {
  const entrant = ENTRANTS[code];
  const run = competition.runs.find((candidate) =>
    candidate.runId === entrant.runId
  )!;
  const openingLot = competition.economicState.snapshot.lots[0]!;
  const openingFx = competition.economicState.acquisitionFxBindings[0]!;
  const acquisitionEvidence = fx(
    "lulu-opening-acquisition-fx",
    openingFx.cnyPerUsd,
    `${openingFx.effectiveDate}T20:00:00.000Z`,
  );

  return {
    acceptedSubmission: {
      submissionId: entrant.submissionId,
      decisionId: entrant.decisionId,
      targets: entrant.targets,
      cashWeightBps: entrant.cashWeightBps,
    },
    account: {
      strategyAccountId: entrant.strategyAccountId,
      runId: entrant.runId,
      currency: "USD",
      cashAssetBalance: "0",
      taxReserveBalance: "0",
      headSequence: "0",
      headHash: run.instanceSha256,
      priorLedgerTransactions: run.openingTransactions,
    },
    timeline: {
      decisionSessionDate: "2026-08-28",
      decisionCutoffAt: "2026-08-28T20:20:00.000Z",
      s1PlannedAt: "2026-08-29T09:00:00.000Z",
      s1TradeDate: "2026-08-31",
      s1ExecutedAt: "2026-08-31T13:31:00.000Z",
      s1SettledAt: "2026-08-31T13:32:00.000Z",
      s1CloseAt: "2026-08-31T20:20:00.000Z",
      s2PlannedAt: "2026-08-31T20:21:00.000Z",
      s2TradeDate: "2026-09-01",
      s2ExecutedAt: "2026-09-01T13:31:00.000Z",
      s2SettledAt: "2026-09-01T13:32:00.000Z",
      navAsOf: "2026-09-01T20:20:00.000Z",
    },
    instruments: [
      {
        instrumentId: LULU,
        symbol: "LULU",
        sourceCountry: "US",
        quantity: "150",
        grossCost: openingLot.grossPurchasePrice,
        lots: [{
          lotId: openingLot.lotId,
          instrumentId: openingLot.instrumentId,
          acquisitionSequence: sequence(openingLot.acquisitionSequence),
          quantity: nonNegativeDecimal(openingLot.quantity),
          grossPurchasePrice: nonNegativeDecimal(openingLot.grossPurchasePrice),
          buyFees: nonNegativeDecimal(openingLot.buyFees),
        }],
        acquisitionFxBindings: [{
          lotId: openingLot.lotId,
          acquisitionTradeDate: openingLot.acquiredOn,
          acquisitionSettlementId: competition.genesisId,
          remainingGrossPurchasePriceCny: openingFx.acquisitionTaxBasisCny,
          remainingBuyFeesCny: "0",
          evidence: acquisitionEvidence,
        }],
        decisionCloseMark: closeMark(
          "LULU", "120", "2026-08-28", "2026-08-28T20:20:00.000Z",
        ),
        s1CloseMark: closeMark(
          "LULU", "121", "2026-08-31", "2026-08-31T20:20:00.000Z",
        ),
        finalMark: closeMark(
          "LULU", "119", "2026-09-01", "2026-09-01T20:20:00.000Z",
        ),
      },
      {
        instrumentId: QQQ,
        symbol: "QQQ",
        sourceCountry: "US",
        quantity: "0",
        grossCost: "0",
        lots: [],
        acquisitionFxBindings: [],
        decisionCloseMark: closeMark(
          "QQQ", "400", "2026-08-28", "2026-08-28T20:20:00.000Z",
        ),
        s1CloseMark: closeMark(
          "QQQ", "400", "2026-08-31", "2026-08-31T20:20:00.000Z",
        ),
        finalMark: closeMark(
          "QQQ", "440", "2026-09-01", "2026-09-01T20:20:00.000Z",
        ),
      },
      {
        instrumentId: SPY,
        symbol: "SPY",
        sourceCountry: "US",
        quantity: "0",
        grossCost: "0",
        lots: [],
        acquisitionFxBindings: [],
        decisionCloseMark: closeMark(
          "SPY", "500", "2026-08-28", "2026-08-28T20:20:00.000Z",
        ),
        s1CloseMark: closeMark(
          "SPY", "500", "2026-08-31", "2026-08-31T20:20:00.000Z",
        ),
        finalMark: closeMark(
          "SPY", "475", "2026-09-01", "2026-09-01T20:20:00.000Z",
        ),
      },
    ],
    s1OfficialOpenByInstrument: {
      [LULU]: minuteOpen(
        "LULU", "121", "5000", "2026-08-31", "2026-08-31T13:31:00.000Z",
      ),
    },
    s2OfficialOpenByInstrument: {
      [QQQ]: minuteOpen(
        "QQQ", "400", "3000", "2026-09-01", "2026-09-01T13:31:00.000Z",
      ),
      [SPY]: minuteOpen(
        "SPY", "500", "99", "2026-09-01", "2026-09-01T13:31:00.000Z",
      ),
    },
    dispositionFxByInstrument: {
      [LULU]: fx(
        "lulu-disposition-fx", "7.1", "2026-08-31T13:31:00.000Z",
      ),
    },
    acquisitionFxByInstrument: {
      [QQQ]: fx("qqq-acquisition-fx", "7.1", "2026-09-01T13:31:00.000Z"),
      [SPY]: fx("spy-acquisition-fx", "7.1", "2026-09-01T13:31:00.000Z"),
    },
    feeSchedules: [FUTU_HK_US_EQUITY_FIXED_2026_08_23],
    slippageBps: "5",
    executionModel: "SIMULATED_MINUTE_PARTICIPATION",
    maxParticipationBps: "100",
    fillPriceScale: 8,
    taxAllocationScale: 12,
  };
}

function rank(
  results: ReadonlyArray<{
    readonly entrantCode: EntrantCode;
    readonly cycle: AcceptedTargetCycleResult;
  }>,
) {
  const sorted = [...results].sort((left, right) =>
    compareDecimals(
      right.cycle.nav.liquidationNav,
      left.cycle.nav.liquidationNav,
    ) || compareCodePoints(left.entrantCode, right.entrantCode)
  );
  let priorNav: string | undefined;
  let priorRank = 0;
  return sorted.map((entry, index) => {
    if (entry.cycle.nav.liquidationNav !== priorNav) priorRank = index + 1;
    priorNav = entry.cycle.nav.liquidationNav;
    return {
      rank: priorRank.toString(),
      entrantCode: entry.entrantCode,
      liquidationNav: entry.cycle.nav.liquidationNav,
    };
  });
}

function rehearse(order: readonly EntrantCode[]) {
  const competition = genesis();
  const cycles = order.map((entrantCode) => ({
    entrantCode,
    cycle: runAcceptedTargetCycle(cycleInput(entrantCode, competition)),
  }));
  return { competition, cycles, leaderboard: rank(cycles) };
}

describe("volume-participation Season rehearsal", () => {
  it("runs equal 150-LULU entrants through shared evidence to stable ranking", () => {
    const forward = rehearse(["twofold", "twofold-orchestrator"]);
    const reverse = rehearse(["twofold-orchestrator", "twofold"]);

    expect(forward.competition.runs).toHaveLength(2);
    expect(new Set(forward.competition.runs.map((run) => run.economicSha256))).toEqual(
      new Set([forward.competition.economicSha256]),
    );
    for (const run of forward.competition.runs) {
      expect(run.ledger.positions).toEqual([expect.objectContaining({
        instrumentId: LULU,
        quantity: "150",
      })]);
    }

    for (const { cycle } of forward.cycles) {
      const lulu = cycle.s1.settlements[0]!.intent.execution;
      expect(lulu).toMatchObject({
        terminalStatus: "PARTIALLY_FILLED",
        filledQuantity: "50",
        liquidityEvidence: {
          factId: "shared-open-LULU-2026-08-31",
          observedVolume: "5000",
          maxParticipationBps: "100",
        },
      });
      const spy = cycle.s2.settlements.find((settlement) =>
        settlement.intent.instrumentId === SPY
      )!.intent.execution;
      expect(spy).toMatchObject({
        terminalStatus: "CANCELED",
        filledQuantity: "0",
        liquidityEvidence: {
          observedVolume: "99",
          maxParticipationBps: "100",
        },
      });
    }

    expect(forward.leaderboard).toEqual([
      {
        rank: "1",
        entrantCode: "twofold",
        liquidationNav: "18343.772",
      },
      {
        rank: "2",
        entrantCode: "twofold-orchestrator",
        liquidationNav: "17933.204",
      },
    ]);
    expect(reverse.leaderboard).toEqual(forward.leaderboard);
    expect(Object.fromEntries(reverse.cycles.map(({ entrantCode, cycle }) => [
      entrantCode,
      cycle.contentSha256,
    ]))).toEqual(Object.fromEntries(forward.cycles.map(({ entrantCode, cycle }) => [
      entrantCode,
      cycle.contentSha256,
    ])));

    // Capacity is a fair counterfactual bound, not a pool depleted by whichever
    // entrant happens to be evaluated first.
    expect(forward.cycles.reduce(
      (sum, entry) =>
        sum + BigInt(entry.cycle.s1.settlements[0]!.intent.execution.filledQuantity),
      0n,
    )).toBe(100n);
  });
});
