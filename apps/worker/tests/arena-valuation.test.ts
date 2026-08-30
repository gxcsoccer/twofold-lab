import { describe, expect, it, vi } from "vitest";

import type {
  ArenaMarketSnapshot,
  ArenaPortfolioState,
} from "../src/arena-inputs.js";
import {
  buildArenaValuation,
  registerArenaValuationExact,
  type ArenaValuationRpcClient,
} from "../src/arena-valuation.js";

const ids = {
  valuation: "a1000000-0000-8000-8000-000000000001",
  entry: "a2000000-0000-8000-8000-000000000001",
  round: "a3000000-0000-4000-8000-000000000001",
  season: "a4000000-0000-4000-8000-000000000001",
  entrant: "a5000000-0000-4000-8000-000000000001",
  run: "a6000000-0000-4000-8000-000000000001",
  snapshot: "a7000000-0000-4000-8000-000000000001",
  instrument: "a8000000-0000-4000-8000-000000000001",
} as const;

const snapshot: ArenaMarketSnapshot = Object.freeze({
  snapshotId: ids.snapshot,
  sourceVersionId: "a9000000-0000-4000-8000-000000000001",
  manifestSha256: "1".repeat(64),
  cutoffAt: "2026-08-28T21:00:00.000Z",
  targetSessionDate: "2026-08-28",
  selectionPolicy: "contract",
  sealedAt: "2026-08-28T22:00:00.000Z",
  symbols: ["LULU"],
  bars: [{
    factId: "aa000000-0000-4000-8000-000000000001",
    symbol: "LULU",
    barStart: "2026-08-28T04:00:00.000Z",
    barDate: "2026-08-28",
    currency: "USD",
    openPrice: "120",
    highPrice: "122",
    lowPrice: "119",
    closePrice: "120.81",
    volume: "1000000",
    tradeCount: "10000",
    vwap: "120.5",
    factSha256: "2".repeat(64),
  }],
});

const portfolio: ArenaPortfolioState = Object.freeze({
  schema: "twofold.strategy_portfolio_state/v1",
  strategyAccountId: "ab000000-0000-4000-8000-000000000001",
  runId: ids.run,
  asOf: "2026-08-28T22:10:00.000Z",
  account: {
    accountCode: "TWO-LULU",
    broker: "FUTU_SIMULATED",
    brokerRegion: "HK",
    baseCurrency: "USD",
    liveTrading: false as const,
  },
  ledgerHead: {
    sequence: "0",
    sha256: "4".repeat(64),
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
});

describe("Arena valuation", () => {
  it("builds deterministic opening score bytes from portfolio plus snapshot", () => {
    const first = buildArenaValuation({
      stage: "OPENING",
      snapshot,
      portfolioState: portfolio,
    });
    const replay = buildArenaValuation({
      stage: "OPENING",
      snapshot,
      portfolioState: portfolio,
    });

    expect(first).toEqual(replay);
    expect(first.payload).toMatchObject({
      schema: "twofold.arena_valuation/v1",
      valuationAt: portfolio.asOf,
      valuationDate: "2026-08-28",
      positionMarketValue: "18121.5",
      brokerNav: "18121.5",
      taxReservedNav: "18121.5",
      estimatedCloseFees: "2.84",
      estimatedUnrealizedLiquidationTax: "0",
      liquidationNav: "18118.66",
      scoreBaseLiquidationNav: "18118.66",
    });
    expect(first.canonicalJson).toBe(JSON.stringify(first.payload));
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when a held instrument has no exact mark", () => {
    expect(() => buildArenaValuation({
      stage: "OPENING",
      snapshot: { ...snapshot, bars: [] },
      portfolioState: portfolio,
    })).toThrow("missing one exact mark");
  });

  it("registers only the expected string-safe valuation identity", async () => {
    const built = buildArenaValuation({
      stage: "OPENING",
      snapshot,
      portfolioState: portfolio,
    });
    const rpc: ArenaValuationRpcClient = {
      rpc: vi.fn(async () => ({
        data: {
          schema: "twofold.arena_valuation_result/v1",
          valuationId: ids.valuation,
          roundEntryId: ids.entry,
          roundId: ids.round,
          seasonId: ids.season,
          entrantId: ids.entrant,
          runId: ids.run,
          stage: "OPENING",
          snapshotId: ids.snapshot,
          valuationAt: portfolio.asOf,
          valuationDate: "2026-08-28",
          ledgerSequence: "0",
          ledgerSha256: "4".repeat(64),
          brokerNav: "18121.5",
          taxReservedNav: "18121.5",
          liquidationNav: "18118.66",
          scoreBaseLiquidationNav: "18118.66",
          valuationSha256: built.sha256,
          recordedBy: "worker-1",
          recordedAt: "2026-08-28T22:11:00.000Z",
        },
        error: null,
        status: 200,
      })),
    };
    const args = {
      p_idempotency_key: "season:round:1:twofold:opening",
      p_round_entry_id: ids.entry,
      p_stage: "OPENING",
      p_snapshot_id: ids.snapshot,
      p_canonical_json: built.canonicalJson,
      p_recorded_by: "worker-1",
    } as const;

    await expect(registerArenaValuationExact(rpc, args, {
      roundId: ids.round,
      seasonId: ids.season,
      entrantId: ids.entrant,
      runId: ids.run,
      expected: built,
    })).resolves.toMatchObject({
      valuationId: ids.valuation,
      liquidationNav: "18118.66",
    });
    expect(rpc.rpc).toHaveBeenCalledWith("register_arena_valuation", args);
  });

  it("rejects a numeric JSON token returned by the database", async () => {
    const built = buildArenaValuation({
      stage: "OPENING", snapshot, portfolioState: portfolio,
    });
    const rpc: ArenaValuationRpcClient = {
      rpc: vi.fn(async () => ({
        data: { schema: "twofold.arena_valuation_result/v1", ledgerSequence: 0 },
        error: null,
        status: 200,
      })),
    };
    await expect(registerArenaValuationExact(rpc, {
      p_idempotency_key: "season:round:1:twofold:opening",
      p_round_entry_id: ids.entry,
      p_stage: "OPENING",
      p_snapshot_id: ids.snapshot,
      p_canonical_json: built.canonicalJson,
      p_recorded_by: "worker-1",
    }, {
      roundId: ids.round,
      seasonId: ids.season,
      entrantId: ids.entrant,
      runId: ids.run,
      expected: built,
    })).rejects.toThrow("numeric token");
  });
});
