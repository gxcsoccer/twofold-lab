import { describe, expect, it, vi } from "vitest";

import {
  claimArenaWorkItem,
  completeArenaWorkItem,
  seedArenaRoundWork,
  type ArenaWorkRpcClient,
} from "../src/arena-work-repository.js";

const ids = {
  work: "a1000000-0000-8000-8000-000000000001",
  entry: "a2000000-0000-8000-8000-000000000001",
  round: "a3000000-0000-4000-8000-000000000001",
  season: "a4000000-0000-4000-8000-000000000001",
  entrant: "a5000000-0000-4000-8000-000000000001",
  run: "a6000000-0000-4000-8000-000000000001",
  lease: "a7000000-0000-4000-8000-000000000001",
} as const;

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "twofold.arena_work_item_result/v1",
    workItemId: ids.work,
    roundEntryId: ids.entry,
    roundId: ids.round,
    seasonId: ids.season,
    entrantId: ids.entrant,
    runId: ids.run,
    phase: "RUN_AGENT_DECISION",
    predecessorWorkItemId: null,
    scheduledAt: "2026-08-28T22:23:53.027Z",
    deadlineAt: "2026-08-31T13:15:00.000Z",
    nextAttemptAt: "2026-08-28T22:23:53.027Z",
    status: "CLAIMED",
    attemptCount: "1",
    claimedBy: "worker-1",
    leaseToken: ids.lease,
    leaseExpiresAt: "2026-08-28T22:25:00.000Z",
    completedAt: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    retryable: null,
    ...overrides,
  };
}

function client(data: unknown): ArenaWorkRpcClient {
  return { rpc: vi.fn(async () => ({ data, error: null, status: 200 })) };
}

describe("Arena work repository", () => {
  it("seeds a Round with exact string counts", async () => {
    const rpc = client({
      schema: "twofold.arena_work_seed_result/v1",
      roundId: ids.round,
      workItemCount: "10",
      recordedBy: "worker-1",
    });
    await expect(seedArenaRoundWork(rpc, {
      roundId: ids.round,
      recordedBy: "worker-1",
    })).resolves.toEqual({ roundId: ids.round, workItemCount: "10" });
  });

  it("claims one leased phase or returns no due work", async () => {
    await expect(claimArenaWorkItem(client(item()), {
      workerId: "worker-1",
      leaseSeconds: 60,
      now: "2026-08-28T22:24:00.000Z",
      roundId: ids.round,
    })).resolves.toMatchObject({
      phase: "RUN_AGENT_DECISION",
      status: "CLAIMED",
      leaseToken: ids.lease,
    });
    await expect(claimArenaWorkItem(client(null), {
      workerId: "worker-1",
      leaseSeconds: 60,
      now: "2026-08-28T22:24:00.000Z",
    })).resolves.toBeNull();
  });

  it("accepts the explicit S2 close capability", async () => {
    const rpc = client(item({ phase: "CAPTURE_S2_CLOSE" }));
    await expect(claimArenaWorkItem(rpc, {
      workerId: "market-worker",
      leaseSeconds: 60,
      now: "2026-09-01T20:20:00.000Z",
      roundId: ids.round,
      allowedPhases: ["CAPTURE_S2_CLOSE"],
    })).resolves.toMatchObject({ phase: "CAPTURE_S2_CLOSE" });
    expect(rpc.rpc).toHaveBeenCalledWith("claim_arena_work_item", expect.objectContaining({
      p_allowed_phases: ["CAPTURE_S2_CLOSE"],
    }));
  });

  it("accepts the two stage-correct order lifecycle capabilities", async () => {
    for (const phase of [
      "PREPARE_S1_ORDERS",
      "SETTLE_S1_AND_PREPARE_S2",
    ] as const) {
      const rpc = client(item({ phase }));
      await expect(claimArenaWorkItem(rpc, {
        workerId: "settlement-worker",
        leaseSeconds: 60,
        now: "2026-08-31T20:21:00.000Z",
        roundId: ids.round,
        allowedPhases: [phase],
      })).resolves.toMatchObject({ phase });
      expect(rpc.rpc).toHaveBeenCalledWith(
        "claim_arena_work_item",
        expect.objectContaining({ p_allowed_phases: [phase] }),
      );
    }
  });

  it("completes work only with string-safe output", async () => {
    const rpc = client(item({
      status: "SUCCEEDED",
      claimedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: "2026-08-28T22:24:30.000Z",
      result: { outcome: "ACCEPTED_TARGET" },
      retryable: false,
    }));
    await expect(completeArenaWorkItem(rpc, {
      workItemId: ids.work,
      leaseToken: ids.lease,
      completedAt: "2026-08-28T22:24:30.000Z",
      succeeded: true,
      result: { outcome: "ACCEPTED_TARGET" },
      errorCode: null,
      errorMessage: null,
      retryable: false,
    })).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("rejects numeric queue payloads and incomplete leases", async () => {
    await expect(claimArenaWorkItem(client(item({ attemptCount: 1 })), {
      workerId: "worker-1",
      leaseSeconds: 60,
      now: "2026-08-28T22:24:00.000Z",
    })).rejects.toThrow("numeric token");
    await expect(claimArenaWorkItem(client(item({ leaseToken: null })), {
      workerId: "worker-1",
      leaseSeconds: 60,
      now: "2026-08-28T22:24:00.000Z",
    })).rejects.toThrow("complete lease");
  });
});
