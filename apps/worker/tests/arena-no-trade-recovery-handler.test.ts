import { describe, expect, it, vi } from "vitest";

import type { ArenaMarketSnapshot, ArenaPortfolioState } from
  "../src/arena-inputs.js";
import { createArenaNoTradeRecoveryHandler } from
  "../src/arena-no-trade-recovery-handler.js";
import type { ArenaNoTradeRecovery } from
  "../src/arena-no-trade-recovery-repository.js";

const ids = Object.freeze({
  recovery: "b1000000-0000-4000-8000-000000000001",
  entry: "b2000000-0000-4000-8000-000000000001",
  round: "b3000000-0000-4000-8000-000000000001",
  season: "b4000000-0000-4000-8000-000000000001",
  entrant: "b5000000-0000-4000-8000-000000000001",
  run: "b6000000-0000-4000-8000-000000000001",
  work: "b7000000-0000-4000-8000-000000000001",
  lease: "b8000000-0000-4000-8000-000000000001",
  snapshot: "b9000000-0000-4000-8000-000000000001",
  source: "ba000000-0000-4000-8000-000000000001",
  fact: "bb000000-0000-4000-8000-000000000001",
  instrument: "bc000000-0000-4000-8000-000000000001",
  account: "bd000000-0000-4000-8000-000000000001",
});

const item = Object.freeze({
  schema: "twofold.arena_no_trade_recovery/v1",
  recoveryId: ids.recovery,
  roundEntryId: ids.entry,
  roundId: ids.round,
  seasonId: ids.season,
  entrantId: ids.entrant,
  runId: ids.run,
  sourceWorkItemId: ids.work,
  reasonCode: "DECISION_UNAVAILABLE",
  scheduledAt: "2026-09-03T20:20:00.000Z",
  recordedBy: "arena-worker",
  status: "CLAIMED",
  attemptCount: "1",
  nextAttemptAt: "2026-09-03T20:20:00.000Z",
  claimedBy: "arena-worker",
  leaseToken: ids.lease,
  leaseExpiresAt: "2026-09-03T20:21:07.000Z",
  completedAt: null,
  valuationId: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  retryable: null,
}) satisfies ArenaNoTradeRecovery;

const snapshot = Object.freeze({
  snapshotId: ids.snapshot,
  sourceVersionId: ids.source,
  manifestSha256: "a".repeat(64),
  cutoffAt: "2026-09-03T20:20:05.000Z",
  targetSessionDate: "2026-09-03",
  selectionPolicy: "contract",
  sealedAt: "2026-09-03T20:20:06.000Z",
  symbols: ["LULU"],
  bars: [{
    factId: ids.fact,
    symbol: "LULU",
    barStart: "2026-09-03T04:00:00.000Z",
    barDate: "2026-09-03",
    currency: "USD",
    openPrice: "119",
    highPrice: "122",
    lowPrice: "118",
    closePrice: "121",
    volume: "100",
    tradeCount: "10",
    vwap: "120.5",
    factSha256: "b".repeat(64),
  }],
}) satisfies ArenaMarketSnapshot;

const portfolio = Object.freeze({
  schema: "twofold.strategy_portfolio_state/v1",
  strategyAccountId: ids.account,
  runId: ids.run,
  asOf: "2026-08-28T22:10:00.000Z",
  account: {
    accountCode: "PRIVATE-ARENA:TWO-FOLD",
    broker: "FUTU_HK",
    brokerRegion: "HK",
    baseCurrency: "USD",
    liveTrading: false as const,
  },
  ledgerHead: {
    sequence: "0",
    sha256: "c".repeat(64),
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
}) satisfies ArenaPortfolioState;

function source(overrides: Record<string, unknown> = {}) {
  return {
    closeSnapshot: vi.fn(async () => ({
      schema: "twofold.arena_round_close_snapshot/v1" as const,
      roundId: ids.round,
      seasonId: ids.season,
      stage: "S2_CLOSE" as const,
      snapshotId: ids.snapshot,
      sourceVersionId: ids.source,
      manifestSha256: "a".repeat(64),
      sessionDate: "2026-09-03",
      cutoffAt: "2026-09-03T20:20:05.000Z",
      sealedAt: "2026-09-03T20:20:06.000Z",
      marks: [{}] as never,
      boundBy: "market-worker",
      boundAt: "2026-09-03T20:20:06.500Z",
    })),
    marketSnapshot: vi.fn(async () => snapshot),
    portfolioState: vi.fn(async () => portfolio),
    scoreBase: vi.fn(async () => "18118.66"),
    ...overrides,
  };
}

describe("Arena no-trade recovery handler", () => {
  it("values the unchanged portfolio against the exact shared S2 close", async () => {
    const material = source();
    const handler = createArenaNoTradeRecoveryHandler({ source: material });

    await expect(handler(item, new AbortController().signal)).resolves
      .toMatchObject({
        stage: "S2_CLOSE",
        snapshotId: ids.snapshot,
        payload: {
          ledgerSequence: "0",
          ledgerSha256: "c".repeat(64),
          positionMarketValue: "18150",
          liquidationNav: "18142.028",
          scoreBaseLiquidationNav: "18118.66",
          valuationAt: "2026-09-03T20:20:06.000Z",
          valuationDate: "2026-09-03",
        },
      });
    expect(material.closeSnapshot).toHaveBeenCalledWith(ids.round);
    expect(material.marketSnapshot).toHaveBeenCalledWith(ids.snapshot);
    expect(material.portfolioState).toHaveBeenCalledWith(ids.run);
    expect(material.scoreBase).toHaveBeenCalledWith(ids.season, ids.entrant);
  });

  it("fails closed when close binding and sealed snapshot diverge", async () => {
    const material = source({
      marketSnapshot: vi.fn(async () => ({ ...snapshot, manifestSha256: "d".repeat(64) })),
    });
    const handler = createArenaNoTradeRecoveryHandler({ source: material });

    await expect(handler(item, new AbortController().signal))
      .rejects.toThrow("does not match its shared S2 binding");
    expect(material.portfolioState).not.toHaveBeenCalled();
  });
});
