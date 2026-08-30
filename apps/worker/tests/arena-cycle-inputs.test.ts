import { describe, expect, it } from "vitest";

import {
  prepareAcceptedTargetCycleS1,
  runAcceptedTargetCycle,
  settleAcceptedTargetCycleS1AndPrepareS2,
} from "@twofold/core";

import {
  buildArenaS1PlanInput,
  buildArenaFullCycleInput,
  buildArenaThroughS1Input,
} from "../src/arena-cycle-inputs.js";
import type { ArenaCycleMaterial } from "../src/arena-cycle-material.js";
import { buildArenaCycleFinalValuation } from "../src/arena-valuation.js";

const ids = Object.freeze({
  entry: "b1000000-0000-8000-8000-000000000001",
  round: "b2000000-0000-4000-8000-000000000001",
  season: "b3000000-0000-4000-8000-000000000001",
  entrant: "b4000000-0000-4000-8000-000000000001",
  run: "b5000000-0000-4000-8000-000000000001",
  decision: "b6000000-0000-8000-8000-000000000001",
  submission: "b7000000-0000-4000-8000-000000000001",
  account: "b8000000-0000-4000-8000-000000000001",
  snapshot: "b9000000-0000-4000-8000-000000000001",
  lulu: "ba000000-0000-4000-8000-000000000001",
  qqq: "bb000000-0000-4000-8000-000000000001",
  source: "bc000000-0000-4000-8000-000000000001",
  artifact: "bd000000-0000-4000-8000-000000000001",
  lot: "be000000-0000-4000-8000-000000000001",
  fxArtifact: "bf000000-0000-4000-8000-000000000001",
});

function material(): ArenaCycleMaterial {
  const acquisitionFx = {
    lotId: ids.lot,
    instrumentId: ids.lulu,
    effectiveDate: "2026-08-28",
    cnyPerUsd: "7.1234",
    acquisitionTaxBasisCny: "129086.6931",
    authority: "ECB_REFERENCE_CROSS",
    sourceArtifactId: ids.fxArtifact,
    sourceSha256: "f".repeat(64),
    observedAt: "2026-08-28T20:05:00.000Z",
    availableAt: "2026-08-28T20:06:00.000Z",
  };
  return {
    schema: "twofold.arena_cycle_material/v1",
    stage: "PREPARE_S1_ORDERS",
    roundEntry: {
      roundEntryId: ids.entry,
      roundId: ids.round,
      seasonId: ids.season,
      entrantId: ids.entrant,
      runId: ids.run,
      decisionId: ids.decision,
    },
    round: {
      roundIndex: "1",
      decisionSnapshotId: ids.snapshot,
      decisionSessionDate: "2026-08-28",
      decisionWindowOpensAt: "2026-08-28T22:23:53.027Z",
      decisionWindowClosesAt: "2026-08-31T13:15:00.000Z",
      s1SessionDate: "2026-08-31",
      s1OpenAt: "2026-08-31T13:30:00.000Z",
      s1ReferenceAvailableAt: "2026-08-31T13:32:00.000Z",
      s1CloseAt: "2026-08-31T20:00:00.000Z",
      s1CloseAvailableAt: "2026-08-31T20:20:00.000Z",
      s2SessionDate: "2026-09-01",
      s2OpenAt: "2026-09-01T13:30:00.000Z",
      s2ReferenceAvailableAt: "2026-09-01T13:32:00.000Z",
      s2CloseAt: "2026-09-01T20:00:00.000Z",
      cycleReadyAt: "2026-09-01T20:20:00.000Z",
    },
    acceptedSubmission: {
      submissionId: ids.submission,
      decisionId: ids.decision,
      targets: [
        { instrumentId: ids.lulu, symbol: "LULU", targetWeightBps: "5000" },
        { instrumentId: ids.qqq, symbol: "QQQ", targetWeightBps: "5000" },
      ],
      cashWeightBps: "0",
      acceptedAt: "2026-08-28T22:30:00.000Z",
    },
    universe: [
      { instrumentId: ids.lulu, symbol: "LULU", sourceCountry: "US", currency: "USD" },
      { instrumentId: ids.qqq, symbol: "QQQ", sourceCountry: "US", currency: "USD" },
    ],
    rulebook: {
      schema: "twofold.arena_execution_rulebook/v1",
      executionModel: "SIMULATED_SLIPPAGE",
      openReferenceMethod: "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE",
      slippageBps: "5",
      fillPriceScale: "8",
      feeScheduleId: "futu_hk_us_equity_fixed_2026-08-23",
      taxRulesetId: "cn_resident_direct_foreign_securities_strict_v1",
      taxAllocationScale: "12",
      rankingNav: "LIQUIDATION_NAV",
    },
    portfolio: {
      schema: "twofold.strategy_portfolio_state/v1",
      strategyAccountId: ids.account,
      runId: ids.run,
      asOf: "2026-08-28T22:10:00.000Z",
      account: {
        accountCode: "private-arena-twofold",
        broker: "FUTU_HK",
        brokerRegion: "HK",
        baseCurrency: "USD",
        liveTrading: false,
      },
      ledgerHead: {
        sequence: "0",
        sha256: "a".repeat(64),
        accountingTransactionCount: "1",
        lotOriginCount: "1",
        acquisitionFxBindingCount: "1",
        settlementCount: "0",
        corporateActionMutationCount: "0",
      },
      cash: { settled: "0", taxReserve: "0", buyingPower: "0" },
      positions: [{
        instrumentId: ids.lulu,
        symbol: "LULU",
        quantity: "150",
        grossCost: "18121.5",
        taxBasis: "18121.5",
        currency: "USD",
        lotCount: "1",
      }],
    },
    genesis: {
      schema: "twofold.competition_economic_state/v1",
      genesisId: "private-arena-s1:lulu-150-v1",
      seasonId: ids.season,
      openingStateArtifactId: "b0000000-0000-4000-8000-000000000001",
      snapshot: {
        snapshotId: "private-arena-s1:lulu-150-v1",
        schema: "twofold.initial_portfolio/v1",
        asOf: "2026-08-28T22:10:00.000Z",
        brokerLegalEntity: "FUTU_HK",
        accountRegion: "HK",
        baseCurrency: "USD",
        sourceArtifactSha256: "e".repeat(64),
        cashBalances: [],
        lots: [{
          lotId: ids.lot,
          instrumentId: ids.lulu,
          symbol: "LULU",
          acquiredOn: "2026-08-28",
          acquisitionSequence: "1",
          quantity: "150",
          purchasePricePerShare: "120.81",
          grossPurchasePrice: "18121.5",
          buyFees: "0",
          taxBasis: "18121.5",
          currency: "USD",
        }],
      },
      acquisitionFxBindings: [acquisitionFx],
    },
    priorCycles: [],
    priorCorporateActions: [],
    evidence: {
      decisionClose: {
        schema: "twofold.arena_market_close_material/v1",
        snapshotId: ids.snapshot,
        sourceVersionId: ids.source,
        manifestSha256: "1".repeat(64),
        sessionDate: "2026-08-28",
        cutoffAt: "2026-08-28T21:00:00.000Z",
        sealedAt: "2026-08-28T22:00:00.000Z",
        marks: [
          {
            factId: "ca000000-0000-4000-8000-000000000001",
            symbol: "LULU",
            currency: "USD",
            value: "120.81",
            sessionDate: "2026-08-28",
            visibleAt: "2026-08-28T20:01:00.000Z",
            snapshotId: ids.snapshot,
            factSha256: "2".repeat(64),
            sourceArtifactId: ids.artifact,
            sourceContentSha256: "3".repeat(64),
          },
          {
            factId: "cb000000-0000-4000-8000-000000000001",
            symbol: "QQQ",
            currency: "USD",
            value: "570",
            sessionDate: "2026-08-28",
            visibleAt: "2026-08-28T20:01:00.000Z",
            snapshotId: ids.snapshot,
            factSha256: "4".repeat(64),
            sourceArtifactId: ids.artifact,
            sourceContentSha256: "3".repeat(64),
          },
        ],
      },
    },
  };
}

function settleMaterial(): ArenaCycleMaterial {
  const value = structuredClone(material()) as unknown as Record<string, any>;
  value.stage = "SETTLE_S1_AND_PREPARE_S2";
  value.evidence.s1Open = {
    schema: "twofold.arena_round_open_reference/v1",
    roundId: ids.round,
    seasonId: ids.season,
    stage: "S1_OPEN_REFERENCE",
    referenceSnapshotId: "cc000000-0000-4000-8000-000000000001",
    sourceVersionId: ids.source,
    sourceArtifactId: ids.artifact,
    sourceContentSha256: "5".repeat(64),
    requestFingerprint: "6".repeat(64),
    method: "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE",
    sessionDate: "2026-08-31",
    expectedOpenAt: "2026-08-31T13:30:00.000Z",
    observedAt: "2026-08-31T13:32:05.000Z",
    contentSha256: "7".repeat(64),
    references: [
      {
        factId: "cd000000-0000-4000-8000-000000000001",
        symbol: "LULU",
        barStart: "2026-08-31T13:30:00.000Z",
        sessionDate: "2026-08-31",
        currency: "USD",
        value: "120.81",
        factSha256: "8".repeat(64),
      },
      {
        factId: "ce000000-0000-4000-8000-000000000001",
        symbol: "QQQ",
        barStart: "2026-08-31T13:30:00.000Z",
        sessionDate: "2026-08-31",
        currency: "USD",
        value: "571",
        factSha256: "9".repeat(64),
      },
    ],
    boundBy: "worker",
    boundAt: "2026-08-31T13:32:06.000Z",
  };
  value.evidence.s1Close = {
    schema: "twofold.arena_round_close_snapshot/v1",
    roundId: ids.round,
    seasonId: ids.season,
    stage: "S1_CLOSE",
    snapshotId: "cf000000-0000-4000-8000-000000000001",
    sourceVersionId: ids.source,
    manifestSha256: "a".repeat(64),
    sessionDate: "2026-08-31",
    cutoffAt: "2026-08-31T20:20:00.000Z",
    sealedAt: "2026-08-31T20:20:05.000Z",
    marks: [
      {
        factId: "da000000-0000-4000-8000-000000000001",
        symbol: "LULU",
        barStart: "2026-08-31T04:00:00.000Z",
        sessionDate: "2026-08-31",
        currency: "USD",
        value: "118.42",
        factSha256: "b".repeat(64),
        deliveryId: "db000000-0000-4000-8000-000000000001",
        observedAt: "2026-08-31T20:20:04.000Z",
        sourceArtifactId: ids.artifact,
        sourceContentSha256: "c".repeat(64),
      },
      {
        factId: "dc000000-0000-4000-8000-000000000001",
        symbol: "QQQ",
        barStart: "2026-08-31T04:00:00.000Z",
        sessionDate: "2026-08-31",
        currency: "USD",
        value: "568",
        factSha256: "d".repeat(64),
        deliveryId: "dd000000-0000-4000-8000-000000000001",
        observedAt: "2026-08-31T20:20:04.000Z",
        sourceArtifactId: ids.artifact,
        sourceContentSha256: "c".repeat(64),
      },
    ],
    boundBy: "worker",
    boundAt: "2026-08-31T20:20:06.000Z",
  };
  value.evidence.s1DispositionFx = {
    schema: "twofold.arena_round_tax_fx_reference/v1",
    roundId: ids.round,
    seasonId: ids.season,
    stage: "S1_DISPOSITION",
    fxRateId: "de000000-0000-4000-8000-000000000001",
    factId: "df000000-0000-4000-8000-000000000001",
    sourceVersionId: "ECB_REFERENCE_CROSS",
    sourceArtifactId: ids.fxArtifact,
    sourceContentSha256: "e".repeat(64),
    rawBodySha256: "f".repeat(64),
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    cnyPerBaseUnit: "6.741379310345",
    requestedSessionDate: "2026-08-31",
    effectiveAt: "2026-08-31T00:00:00.000Z",
    visibleAt: "2026-08-31T20:20:05.000Z",
    status: "ESTIMATED",
    authority: "ECB_REFERENCE_CROSS",
    crossSha256: "1".repeat(64),
    boundBy: "worker",
    boundAt: "2026-08-31T20:20:06.000Z",
  };
  return value as unknown as ArenaCycleMaterial;
}

function volumeParticipationSettleMaterial(): ArenaCycleMaterial {
  const value = structuredClone(settleMaterial()) as unknown as Record<string, any>;
  value.rulebook = {
    ...value.rulebook,
    schema: "twofold.arena_execution_rulebook/v2",
    executionModel: "SIMULATED_MINUTE_PARTICIPATION",
    openReferenceMethod: "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
    maxParticipationBps: "100",
  };
  value.evidence.s1Open.schema = "twofold.arena_round_open_reference/v2";
  value.evidence.s1Open.method =
    "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE";
  value.evidence.s1Open.references = value.evidence.s1Open.references.map(
    (reference: Record<string, unknown>) => ({
      ...reference,
      observedVolume: reference.symbol === "LULU" ? "4000" : "10000",
    }),
  );
  return value as unknown as ArenaCycleMaterial;
}

function finalMaterial(): ArenaCycleMaterial {
  const value = structuredClone(settleMaterial()) as unknown as Record<string, any>;
  value.stage = "FINALIZE_ACCEPTED_TARGET_CYCLE";
  value.evidence.s2Open = {
    schema: "twofold.arena_round_open_reference/v1",
    roundId: ids.round,
    seasonId: ids.season,
    stage: "S2_OPEN_REFERENCE",
    referenceSnapshotId: "e1000000-0000-4000-8000-000000000001",
    sourceVersionId: ids.source,
    sourceArtifactId: ids.artifact,
    sourceContentSha256: "2".repeat(64),
    requestFingerprint: "3".repeat(64),
    method: "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE",
    sessionDate: "2026-09-01",
    expectedOpenAt: "2026-09-01T13:30:00.000Z",
    observedAt: "2026-09-01T13:32:05.000Z",
    contentSha256: "4".repeat(64),
    references: [
      {
        factId: "e2000000-0000-4000-8000-000000000001",
        symbol: "LULU",
        barStart: "2026-09-01T13:30:00.000Z",
        sessionDate: "2026-09-01",
        currency: "USD",
        value: "119",
        factSha256: "5".repeat(64),
      },
      {
        factId: "e3000000-0000-4000-8000-000000000001",
        symbol: "QQQ",
        barStart: "2026-09-01T13:30:00.000Z",
        sessionDate: "2026-09-01",
        currency: "USD",
        value: "569",
        factSha256: "6".repeat(64),
      },
    ],
    boundBy: "worker",
    boundAt: "2026-09-01T13:32:06.000Z",
  };
  value.evidence.s2Close = {
    schema: "twofold.arena_round_close_snapshot/v1",
    roundId: ids.round,
    seasonId: ids.season,
    stage: "S2_CLOSE",
    snapshotId: "e4000000-0000-4000-8000-000000000001",
    sourceVersionId: ids.source,
    manifestSha256: "7".repeat(64),
    sessionDate: "2026-09-01",
    cutoffAt: "2026-09-01T20:20:00.000Z",
    sealedAt: "2026-09-01T20:20:05.000Z",
    marks: [
      {
        factId: "e5000000-0000-4000-8000-000000000001",
        symbol: "LULU",
        barStart: "2026-09-01T04:00:00.000Z",
        sessionDate: "2026-09-01",
        currency: "USD",
        value: "121",
        factSha256: "8".repeat(64),
        deliveryId: "e6000000-0000-4000-8000-000000000001",
        observedAt: "2026-09-01T20:20:04.000Z",
        sourceArtifactId: ids.artifact,
        sourceContentSha256: "9".repeat(64),
      },
      {
        factId: "e7000000-0000-4000-8000-000000000001",
        symbol: "QQQ",
        barStart: "2026-09-01T04:00:00.000Z",
        sessionDate: "2026-09-01",
        currency: "USD",
        value: "575",
        factSha256: "a".repeat(64),
        deliveryId: "e8000000-0000-4000-8000-000000000001",
        observedAt: "2026-09-01T20:20:04.000Z",
        sourceArtifactId: ids.artifact,
        sourceContentSha256: "b".repeat(64),
      },
    ],
    boundBy: "worker",
    boundAt: "2026-09-01T20:20:06.000Z",
  };
  value.evidence.s2AcquisitionFx = {
    schema: "twofold.arena_round_tax_fx_reference/v1",
    roundId: ids.round,
    seasonId: ids.season,
    stage: "S2_ACQUISITION",
    fxRateId: "e9000000-0000-4000-8000-000000000001",
    factId: "ea000000-0000-4000-8000-000000000001",
    sourceVersionId: "ECB_REFERENCE_CROSS",
    sourceArtifactId: ids.fxArtifact,
    sourceContentSha256: "c".repeat(64),
    rawBodySha256: "d".repeat(64),
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    cnyPerBaseUnit: "6.75",
    requestedSessionDate: "2026-09-01",
    effectiveAt: "2026-09-01T00:00:00.000Z",
    visibleAt: "2026-09-01T20:20:05.000Z",
    status: "ESTIMATED",
    authority: "ECB_REFERENCE_CROSS",
    crossSha256: "e".repeat(64),
    boundBy: "worker",
    boundAt: "2026-09-01T20:20:06.000Z",
  };
  return value as unknown as ArenaCycleMaterial;
}

describe("Arena cycle Core inputs", () => {
  it("builds a generic S1 plan over held and zero-position instruments", () => {
    const input = buildArenaS1PlanInput(material());
    expect(input.instruments.map((instrument) => ({
      symbol: instrument.symbol,
      quantity: instrument.quantity,
      sourceCountry: instrument.sourceCountry,
    }))).toEqual([
      { symbol: "LULU", quantity: "150", sourceCountry: "US" },
      { symbol: "QQQ", quantity: "0", sourceCountry: "US" },
    ]);
    expect(input.account.priorLedgerTransactions).toHaveLength(1);

    const prepared = prepareAcceptedTargetCycleS1(input);
    expect(prepared.plan.orders).toHaveLength(1);
    expect(prepared.plan.orders[0]).toMatchObject({
      side: "SELL",
      symbol: "LULU",
      quantity: "75",
      plannedTradeDate: "2026-08-31",
      referencePrice: "120.81",
    });
  });

  it("fails closed when the durable portfolio diverges from replay state", () => {
    const invalid = structuredClone(material());
    (invalid.portfolio.positions[0] as { quantity: string }).quantity = "149";
    expect(() => buildArenaS1PlanInput(invalid)).toThrow(
      "portfolio positions diverge",
    );
  });

  it("settles S1 and derives S2 without accepting any S2 market evidence", () => {
    const input = buildArenaThroughS1Input(settleMaterial());
    const checkpoint = settleAcceptedTargetCycleS1AndPrepareS2(input);
    expect(checkpoint.s1.settlements).toHaveLength(1);
    expect(checkpoint.s1.settlements[0]?.intent).toMatchObject({
      stage: "S1",
      side: "SELL",
      execution: { filledQuantity: "75" },
    });
    expect(checkpoint.s2Plan.orders).toHaveLength(1);
    expect(checkpoint.s2Plan.orders[0]).toMatchObject({
      stage: "S2",
      side: "BUY",
      symbol: "QQQ",
      plannedTradeDate: "2026-09-01",
    });
    expect(JSON.stringify(input)).not.toContain("S2_OPEN_REFERENCE");
  });

  it("passes the v2 minute-volume cap into Core and partially fills S1", () => {
    const input = buildArenaThroughS1Input(volumeParticipationSettleMaterial());
    expect(input).toMatchObject({
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      maxParticipationBps: "100",
      s1OfficialOpenByInstrument: {
        [ids.lulu]: { observedVolume: "4000" },
      },
    });

    const checkpoint = settleAcceptedTargetCycleS1AndPrepareS2(input);
    expect(checkpoint.s1.settlements[0]?.intent.execution).toMatchObject({
      terminalStatus: "PARTIALLY_FILLED",
      filledQuantity: "40",
      canceledQuantity: "35",
      liquidityEvidence: {
        observedVolume: "4000",
        maxParticipationBps: "100",
      },
    });
    expect(checkpoint.s2Plan).toMatchObject({
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      maxParticipationBps: "100",
    });
  });

  it("builds the complete cycle only after all shared S2 evidence exists", () => {
    const final = finalMaterial();
    const input = buildArenaFullCycleInput(final);
    const completed = runAcceptedTargetCycle(input);
    expect(completed.s1.settlements).toHaveLength(1);
    expect(completed.s2.settlements).toHaveLength(1);
    expect(completed.s2.settlements[0]?.intent).toMatchObject({
      stage: "S2",
      side: "BUY",
      tradeDate: "2026-09-01",
      tax: {
        status: "RESOLVED",
        dispositionFxEvidence: null,
      },
    });
    expect(completed.positions.map((position) => position.symbol)).toEqual([
      "LULU",
      "QQQ",
    ]);
    expect(completed.nav.currency).toBe("USD");
    const valuation = buildArenaCycleFinalValuation({
      cycleInput: input,
      cycle: completed,
      snapshotId: final.evidence.s2Close?.snapshotId as string,
      scoreBaseLiquidationNav: "18118.66",
    });
    expect(valuation.payload).toMatchObject({
      brokerNav: completed.nav.brokerNav,
      liquidationNav: completed.nav.liquidationNav,
      ledgerSequence: completed.finalLedgerHead.sequence,
      ledgerSha256: completed.finalLedgerHead.sha256,
      scoreBaseLiquidationNav: "18118.66",
      valuationDate: "2026-09-01",
    });
  });
});
