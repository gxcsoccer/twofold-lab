import { describe, expect, it, vi } from "vitest";

import {
  loadArenaCycleMaterial,
  type ArenaCycleMaterialStage,
  type ArenaCycleMaterialRpcClient,
} from "../src/arena-cycle-material.js";

const ids = Object.freeze({
  entry: "a1000000-0000-8000-8000-000000000001",
  round: "a2000000-0000-4000-8000-000000000001",
  season: "a3000000-0000-4000-8000-000000000001",
  entrant: "a4000000-0000-4000-8000-000000000001",
  run: "a5000000-0000-4000-8000-000000000001",
  decision: "a6000000-0000-8000-8000-000000000001",
  submission: "a7000000-0000-8000-8000-000000000001",
  account: "a8000000-0000-4000-8000-000000000001",
  snapshot: "a9000000-0000-4000-8000-000000000001",
  instrument: "aa000000-0000-4000-8000-000000000001",
});

function material(
  stage: ArenaCycleMaterialStage,
  evidence: Readonly<Record<string, unknown>>,
) {
  return {
    schema: "twofold.arena_cycle_material/v1",
    stage,
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
      targets: [{
        instrumentId: ids.instrument,
        symbol: "LULU",
        targetWeightBps: "10000",
      }],
      cashWeightBps: "0",
      acceptedAt: "2026-08-28T22:30:00.000Z",
    },
    universe: [{
      instrumentId: ids.instrument,
      symbol: "LULU",
      sourceCountry: "US",
      currency: "USD",
    }],
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
      asOf: "2026-08-28T21:37:32.616Z",
      account: {
        accountCode: "private-s1-twofold",
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
        instrumentId: ids.instrument,
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
      openingStateArtifactId: "ab000000-0000-4000-8000-000000000001",
      snapshot: {},
      acquisitionFxBindings: [],
    },
    priorCycles: [],
    priorCorporateActions: [],
    evidence,
  };
}

function client(data: unknown): ArenaCycleMaterialRpcClient {
  return {
    rpc: vi.fn(async () => ({ data, error: null, status: 200 })),
  };
}

describe("Arena cycle material", () => {
  it("gives S1 planning only the decision-close evidence", async () => {
    const evidence = { decisionClose: { schema: "decision-close" } };
    const rpc = client(material("PREPARE_S1_ORDERS", evidence));
    const loaded = await loadArenaCycleMaterial(rpc, {
      roundEntryId: ids.entry,
      stage: "PREPARE_S1_ORDERS",
    });
    expect(loaded.evidence).toEqual(evidence);
    expect(JSON.stringify(loaded.evidence)).not.toContain("s1Open");
    expect(rpc.rpc).toHaveBeenCalledWith("get_arena_cycle_material", {
      p_round_entry_id: ids.entry,
      p_stage: "PREPARE_S1_ORDERS",
    });
  });

  it("adds exactly S1 evidence at the checkpoint boundary", async () => {
    const evidence = {
      decisionClose: { schema: "decision-close" },
      s1Open: { schema: "s1-open" },
      s1Close: { schema: "s1-close" },
      s1DispositionFx: { schema: "s1-fx" },
    };
    const loaded = await loadArenaCycleMaterial(
      client(material("SETTLE_S1_AND_PREPARE_S2", evidence)),
      { roundEntryId: ids.entry, stage: "SETTLE_S1_AND_PREPARE_S2" },
    );
    expect(Object.keys(loaded.evidence).sort()).toEqual([
      "decisionClose", "s1Close", "s1DispositionFx", "s1Open",
    ]);
    expect(JSON.stringify(loaded.evidence)).not.toContain("s2Open");
  });

  it("accepts the versioned minute-participation policy as immutable material", async () => {
    const value = material(
      "PREPARE_S1_ORDERS",
      { decisionClose: { schema: "decision-close" } },
    ) as unknown as Record<string, any>;
    value.rulebook = {
      schema: "twofold.arena_execution_rulebook/v2",
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      openReferenceMethod: "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
      maxParticipationBps: "100",
      slippageBps: "5",
      fillPriceScale: "8",
      feeScheduleId: "futu_hk_us_equity_fixed_2026-08-23",
      taxRulesetId: "cn_resident_direct_foreign_securities_strict_v1",
      taxAllocationScale: "12",
      rankingNav: "LIQUIDATION_NAV",
    };

    const loaded = await loadArenaCycleMaterial(client(value), {
      roundEntryId: ids.entry,
      stage: "PREPARE_S1_ORDERS",
    });
    expect(loaded.rulebook).toEqual(value.rulebook);
  });

  it("rejects future evidence leakage and numeric financial tokens", async () => {
    await expect(loadArenaCycleMaterial(client(material(
      "PREPARE_S1_ORDERS",
      {
        decisionClose: { schema: "decision-close" },
        s1Open: { schema: "leaked-future-evidence" },
      },
    )), {
      roundEntryId: ids.entry,
      stage: "PREPARE_S1_ORDERS",
    })).rejects.toThrow("evidence shape");

    const invalid = material(
      "PREPARE_S1_ORDERS",
      { decisionClose: { schema: "decision-close" } },
    );
    invalid.portfolio.cash.settled = 0 as never;
    await expect(loadArenaCycleMaterial(client(invalid), {
      roundEntryId: ids.entry,
      stage: "PREPARE_S1_ORDERS",
    })).rejects.toThrow("numeric token");
  });
});
