import { describe, expect, it, vi } from "vitest";

import type { BuiltArenaValuation } from "../src/arena-valuation.js";
import type { ArenaNoTradeRecovery } from
  "../src/arena-no-trade-recovery-repository.js";
import {
  ArenaNoTradeRecoveryRunner,
  type ArenaNoTradeRecoveryQueue,
} from "../src/arena-no-trade-recovery-runner.js";

const item = Object.freeze({
  schema: "twofold.arena_no_trade_recovery/v1",
  recoveryId: "c1000000-0000-4000-8000-000000000001",
  roundEntryId: "c2000000-0000-4000-8000-000000000001",
  roundId: "c3000000-0000-4000-8000-000000000001",
  seasonId: "c4000000-0000-4000-8000-000000000001",
  entrantId: "c5000000-0000-4000-8000-000000000001",
  runId: "c6000000-0000-4000-8000-000000000001",
  sourceWorkItemId: "c7000000-0000-4000-8000-000000000001",
  reasonCode: "DECISION_UNAVAILABLE",
  scheduledAt: "2026-09-03T20:20:00.000Z",
  recordedBy: "arena-worker",
  status: "CLAIMED",
  attemptCount: "1",
  nextAttemptAt: "2026-09-03T20:20:00.000Z",
  claimedBy: "arena-worker",
  leaseToken: "c8000000-0000-4000-8000-000000000001",
  leaseExpiresAt: "2026-09-03T20:21:07.000Z",
  completedAt: null,
  valuationId: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  retryable: null,
}) satisfies ArenaNoTradeRecovery;

const valuation = Object.freeze({
  stage: "S2_CLOSE",
  snapshotId: "c9000000-0000-4000-8000-000000000001",
  payload: {
    ledgerSequence: "0",
    ledgerSha256: "a".repeat(64),
  },
  canonicalJson: "{\"valuation\":\"exact\"}",
  sha256: "b".repeat(64),
}) as unknown as BuiltArenaValuation;

function queue(): ArenaNoTradeRecoveryQueue {
  return {
    claim: vi.fn(async () => item),
    commit: vi.fn(async () => item),
    fail: vi.fn(async () => item),
  };
}

describe("Arena no-trade recovery runner", () => {
  it("claims, values, and atomically commits the carry-forward", async () => {
    const repository = queue();
    const handler = vi.fn(async () => valuation);
    const runner = new ArenaNoTradeRecoveryRunner({
      workerId: "arena-worker",
      leaseSeconds: 60,
      queue: repository,
      handler,
      now: () => new Date("2026-09-03T20:20:07.000Z"),
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("completed");
    expect(repository.commit).toHaveBeenCalledWith({
      recoveryId: item.recoveryId,
      roundEntryId: item.roundEntryId,
      roundId: item.roundId,
      seasonId: item.seasonId,
      entrantId: item.entrantId,
      runId: item.runId,
      reasonCode: item.reasonCode,
      leaseToken: item.leaseToken,
      valuation,
      completedAt: "2026-09-03T20:20:07.000Z",
    });
  });

  it("sanitizes failures before releasing a retryable recovery lease", async () => {
    const repository = queue();
    const runner = new ArenaNoTradeRecoveryRunner({
      workerId: "arena-worker",
      leaseSeconds: 60,
      queue: repository,
      handler: async () => { throw new Error("snapshot token=do-not-leak"); },
      now: () => new Date("2026-09-03T20:20:07.000Z"),
      failureEnvironment: { SUPABASE_SECRET_KEY: "do-not-leak" },
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("failed");
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({
      recoveryId: item.recoveryId,
      leaseToken: item.leaseToken,
      errorCode: "NO_TRADE_RECOVERY_FAILED",
      retryable: true,
    }));
    expect(JSON.stringify(vi.mocked(repository.fail).mock.calls))
      .not.toContain("do-not-leak");
  });
});
