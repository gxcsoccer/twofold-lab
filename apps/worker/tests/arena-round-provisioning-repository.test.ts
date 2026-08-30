import { describe, expect, it, vi } from "vitest";

import {
  claimArenaRoundProvisioning,
  commitArenaRoundProvisioningExact,
  failArenaRoundProvisioning,
  type ArenaRoundProvisioningRpcClient,
} from "../src/arena-round-provisioning-repository.js";

const provisioningId = "a1000000-0000-4000-8000-000000000001";
const sourceRoundId = "a2000000-0000-4000-8000-000000000001";
const seasonId = "a3000000-0000-4000-8000-000000000001";
const leaseToken = "a4000000-0000-4000-8000-000000000001";
const artifactId = "a5000000-0000-4000-8000-000000000001";

const schedule = Object.freeze({
  schema: "twofold.two_stage_cycle_calendar/v1" as const,
  decisionSessionDate: "2026-09-01",
  s1SessionDate: "2026-09-02",
  s1OpenAt: "2026-09-02T13:30:00.000Z",
  s1ReferenceAvailableAt: "2026-09-02T13:32:00.000Z",
  s1CloseAt: "2026-09-02T20:00:00.000Z",
  s1CloseAvailableAt: "2026-09-02T20:20:00.000Z",
  s2SessionDate: "2026-09-03",
  s2OpenAt: "2026-09-03T13:30:00.000Z",
  s2ReferenceAvailableAt: "2026-09-03T13:32:00.000Z",
  s2CloseAt: "2026-09-03T20:00:00.000Z",
  cycleReadyAt: "2026-09-03T20:20:00.000Z",
});

function claimResponse(overrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.arena_round_provisioning/v1",
    provisioningId,
    sourceRoundId,
    seasonId,
    seasonCode: "private-controlled-lab-s1",
    seasonClosesAt: "2026-09-26T00:00:00.000Z",
    nextRoundIndex: "2",
    decisionSnapshotId: "a6000000-0000-4000-8000-000000000001",
    decisionSessionDate: "2026-09-01",
    decisionAvailableAt: "2026-09-01T20:20:08.000Z",
    recordedBy: "twofold-worker",
    status: "CLAIMED",
    attemptCount: "1",
    nextAttemptAt: "2026-09-01T20:20:08.000Z",
    claimedBy: "twofold-worker",
    leaseToken,
    leaseExpiresAt: "2026-09-01T20:21:09.000Z",
    completedAt: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    retryable: null,
    ...overrides,
  };
}

function rpcClient(results: readonly unknown[]): ArenaRoundProvisioningRpcClient {
  let index = 0;
  return {
    rpc: vi.fn(async () => results[Math.min(index++, results.length - 1)] as never),
  };
}

describe("Arena Round provisioning repository", () => {
  it("claims and validates one number-free causal next-Round request", async () => {
    const client = rpcClient([{ data: claimResponse(), error: null, status: 200 }]);
    const item = await claimArenaRoundProvisioning(client, {
      workerId: "twofold-worker",
      leaseSeconds: 60,
      now: "2026-09-01T20:20:09.000Z",
    });

    expect(item).toMatchObject({
      provisioningId,
      sourceRoundId,
      nextRoundIndex: "2",
      decisionSessionDate: "2026-09-01",
      leaseToken,
    });
    expect(client.rpc).toHaveBeenCalledWith("claim_arena_round_provisioning", {
      p_worker_id: "twofold-worker",
      p_lease_seconds: 60,
      p_now: "2026-09-01T20:20:09.000Z",
    });
  });

  it("rejects numeric JSON tokens and claim identity drift", async () => {
    await expect(claimArenaRoundProvisioning(
      rpcClient([{ data: claimResponse({ nextRoundIndex: 2 }), error: null, status: 200 }]),
      { workerId: "twofold-worker", leaseSeconds: 60, now: "2026-09-01T20:20:09.000Z" },
    )).rejects.toThrow("numeric token");
    await expect(claimArenaRoundProvisioning(
      rpcClient([{ data: claimResponse({ claimedBy: "another-worker" }), error: null, status: 200 }]),
      { workerId: "twofold-worker", leaseSeconds: 60, now: "2026-09-01T20:20:09.000Z" },
    )).rejects.toThrow("inconsistent");
  });

  it("retries an ambiguous commit with the exact same immutable arguments", async () => {
    const committed = {
      schema: "twofold.arena_round_provisioning_commit/v1",
      outcome: "ROUND_PROVISIONED",
      provisioningId,
      seasonId,
      sourceRoundId,
      roundId: "a7000000-0000-4000-8000-000000000001",
      roundIndex: "2",
      entryCount: "2",
      workItemCount: "16",
    };
    const client = rpcClient([
      { data: null, error: { message: "gateway", code: "57000" }, status: 503 },
      { data: committed, error: null, status: 200 },
    ]);
    const input = {
      provisioningId,
      sourceRoundId,
      seasonId,
      roundIndex: "2",
      leaseToken,
      calendarArtifactId: artifactId,
      calendarArtifactSha256: "a".repeat(64),
      schedule,
      completedAt: "2026-09-01T20:20:10.000Z",
    } as const;

    await expect(commitArenaRoundProvisioningExact(client, input))
      .resolves.toEqual(committed);
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.rpc).mock.calls[0]).toEqual(
      vi.mocked(client.rpc).mock.calls[1],
    );
  });

  it("returns a failed lease through the dedicated retry boundary", async () => {
    const client = rpcClient([{
      data: claimResponse({
        status: "REQUESTED",
        claimedBy: null,
        leaseToken: null,
        leaseExpiresAt: null,
        attemptCount: "1",
        nextAttemptAt: "2026-09-01T20:21:10.000Z",
        result: { outcome: "FAILED" },
        errorCode: "ROUND_PROVISIONING_FAILED",
        errorMessage: "calendar unavailable",
        retryable: true,
      }),
      error: null,
      status: 200,
    }]);
    const result = await failArenaRoundProvisioning(client, {
      provisioningId,
      leaseToken,
      completedAt: "2026-09-01T20:20:10.000Z",
      errorCode: "ROUND_PROVISIONING_FAILED",
      errorMessage: "calendar unavailable",
      retryable: true,
    });
    expect(result.status).toBe("REQUESTED");
    expect(client.rpc).toHaveBeenCalledWith("fail_arena_round_provisioning", {
      p_provisioning_id: provisioningId,
      p_lease_token: leaseToken,
      p_completed_at: "2026-09-01T20:20:10.000Z",
      p_error_code: "ROUND_PROVISIONING_FAILED",
      p_error_message: "calendar unavailable",
      p_retryable: true,
    });
  });
});
