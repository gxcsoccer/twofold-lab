import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  claimArenaNoTradeRecovery,
  commitArenaNoTradeRecoveryExact,
  failArenaNoTradeRecovery,
  type ArenaNoTradeRecoveryRpcClient,
} from "../src/arena-no-trade-recovery-repository.js";

const ids = Object.freeze({
  recovery: "a1000000-0000-4000-8000-000000000001",
  entry: "a2000000-0000-4000-8000-000000000001",
  round: "a3000000-0000-4000-8000-000000000001",
  season: "a4000000-0000-4000-8000-000000000001",
  entrant: "a5000000-0000-4000-8000-000000000001",
  run: "a6000000-0000-4000-8000-000000000001",
  work: "a7000000-0000-4000-8000-000000000001",
  lease: "a8000000-0000-4000-8000-000000000001",
  valuation: "a9000000-0000-8000-8000-000000000001",
  snapshot: "aa000000-0000-4000-8000-000000000001",
});

function recoveryResponse(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function rpcClient(results: readonly unknown[]): ArenaNoTradeRecoveryRpcClient {
  let index = 0;
  return {
    rpc: vi.fn(async () => results[Math.min(index++, results.length - 1)] as never),
  };
}

const valuationPayload = Object.freeze({
    brokerNav: "18150",
    estimatedCloseFees: "2.84",
    estimatedUnrealizedLiquidationTax: "5.132",
    feeScheduleIds: ["futu_hk_us_equity_fixed_2026-08-23"],
    ledgerSequence: "0",
    ledgerSha256: "b".repeat(64),
    liquidationNav: "18142.028",
    portfolioAsOf: "2026-08-28T22:10:00.000Z",
    positionMarketValue: "18150",
    reportingCurrency: "USD",
    schema: "twofold.arena_valuation/v1" as const,
    scoreBaseLiquidationNav: "18118.66",
    settledCash: "0",
    taxReserve: "0",
    taxReservedNav: "18150",
    valuationAt: "2026-09-03T20:20:06.000Z",
    valuationDate: "2026-09-03",
});
const valuationCanonicalJson = JSON.stringify(valuationPayload);
const valuation = Object.freeze({
  stage: "S2_CLOSE" as const,
  snapshotId: ids.snapshot,
  payload: valuationPayload,
  canonicalJson: valuationCanonicalJson,
  sha256: createHash("sha256").update(valuationCanonicalJson).digest("hex"),
});

describe("Arena no-trade recovery repository", () => {
  it("claims one number-free recovery with a causal terminal-work identity", async () => {
    const client = rpcClient([{
      data: recoveryResponse(), error: null, status: 200,
    }]);

    await expect(claimArenaNoTradeRecovery(client, {
      workerId: "arena-worker",
      leaseSeconds: 60,
      now: "2026-09-03T20:20:07.000Z",
    })).resolves.toMatchObject({
      recoveryId: ids.recovery,
      reasonCode: "DECISION_UNAVAILABLE",
      leaseToken: ids.lease,
    });
    expect(client.rpc).toHaveBeenCalledWith("claim_arena_no_trade_recovery", {
      p_worker_id: "arena-worker",
      p_lease_seconds: 60,
      p_now: "2026-09-03T20:20:07.000Z",
    });
  });

  it("rejects numeric JSON tokens and claim identity drift", async () => {
    await expect(claimArenaNoTradeRecovery(rpcClient([{
      data: recoveryResponse({ attemptCount: 1 }), error: null, status: 200,
    }]), {
      workerId: "arena-worker", leaseSeconds: 60,
      now: "2026-09-03T20:20:07.000Z",
    })).rejects.toThrow("numeric token");
    await expect(claimArenaNoTradeRecovery(rpcClient([{
      data: recoveryResponse({ claimedBy: "other-worker" }),
      error: null, status: 200,
    }]), {
      workerId: "arena-worker", leaseSeconds: 60,
      now: "2026-09-03T20:20:07.000Z",
    })).rejects.toThrow("inconsistent lease");
  });

  it("retries an ambiguous commit with identical canonical valuation bytes", async () => {
    const committed = recoveryResponse({
      status: "SUCCEEDED",
      claimedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: "2026-09-03T20:20:08.000Z",
      valuationId: ids.valuation,
      result: {
        outcome: "NO_TRADE_CARRY_FORWARD",
        reasonCode: "DECISION_UNAVAILABLE",
        valuationId: ids.valuation,
        ledgerSequence: "0",
        ledgerSha256: "b".repeat(64),
      },
      retryable: false,
    });
    const client = rpcClient([
      { data: null, error: { message: "gateway", code: "57000" }, status: 503 },
      { data: committed, error: null, status: 200 },
    ]);
    const input = {
      recoveryId: ids.recovery,
      roundEntryId: ids.entry,
      roundId: ids.round,
      seasonId: ids.season,
      entrantId: ids.entrant,
      runId: ids.run,
      reasonCode: "DECISION_UNAVAILABLE" as const,
      leaseToken: ids.lease,
      valuation,
      completedAt: "2026-09-03T20:20:08.000Z",
    };

    await expect(commitArenaNoTradeRecoveryExact(client, input))
      .resolves.toMatchObject({ status: "SUCCEEDED", valuationId: ids.valuation });
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.rpc).mock.calls[0]).toEqual(
      vi.mocked(client.rpc).mock.calls[1],
    );
    expect(client.rpc).toHaveBeenCalledWith("commit_arena_no_trade_recovery", {
      p_recovery_id: ids.recovery,
      p_lease_token: ids.lease,
      p_valuation_canonical_json: valuation.canonicalJson,
      p_completed_at: "2026-09-03T20:20:08.000Z",
    });
  });

  it("returns a failed lease through the dedicated retry boundary", async () => {
    const client = rpcClient([{
      data: recoveryResponse({
        status: "REQUESTED",
        claimedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: "2026-09-03T20:21:08.000Z",
        result: { outcome: "FAILED" },
        errorCode: "NO_TRADE_RECOVERY_FAILED",
        errorMessage: "snapshot unavailable",
        retryable: true,
      }),
      error: null,
      status: 200,
    }]);
    await expect(failArenaNoTradeRecovery(client, {
      recoveryId: ids.recovery,
      leaseToken: ids.lease,
      completedAt: "2026-09-03T20:20:08.000Z",
      errorCode: "NO_TRADE_RECOVERY_FAILED",
      errorMessage: "snapshot unavailable",
      retryable: true,
    })).resolves.toMatchObject({ status: "REQUESTED", retryable: true });
  });
});
