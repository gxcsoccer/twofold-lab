import { describe, expect, it, vi } from "vitest";

import type { ArenaRoundProvisioning } from
  "../src/arena-round-provisioning-repository.js";
import type { ArenaRoundCalendarMaterial } from
  "../src/arena-round-provisioning-handler.js";
import {
  ArenaRoundProvisioningRunner,
  type ArenaRoundProvisioningQueue,
} from "../src/arena-round-provisioning-runner.js";

const item = {
  schema: "twofold.arena_round_provisioning/v1",
  provisioningId: "a1000000-0000-4000-8000-000000000001",
  sourceRoundId: "a2000000-0000-4000-8000-000000000001",
  seasonId: "a3000000-0000-4000-8000-000000000001",
  seasonCode: "private-controlled-lab-s1",
  seasonClosesAt: "2026-09-26T00:00:00.000Z",
  nextRoundIndex: "2",
  decisionSnapshotId: "a4000000-0000-4000-8000-000000000001",
  decisionSessionDate: "2026-09-01",
  decisionAvailableAt: "2026-09-01T20:20:08.000Z",
  recordedBy: "twofold-worker",
  status: "CLAIMED",
  attemptCount: "1",
  nextAttemptAt: "2026-09-01T20:20:08.000Z",
  claimedBy: "twofold-worker",
  leaseToken: "a5000000-0000-4000-8000-000000000001",
  leaseExpiresAt: "2026-09-01T20:21:09.000Z",
  completedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  retryable: null,
} as const satisfies ArenaRoundProvisioning;

function queue(): ArenaRoundProvisioningQueue {
  return {
    claim: vi.fn(async () => item),
    commit: vi.fn(async () => ({ outcome: "ROUND_PROVISIONED" } as never)),
    fail: vi.fn(async () => item),
  };
}

describe("Arena Round provisioning runner", () => {
  it("claims, prepares, and atomically commits the next Round", async () => {
    const repository = queue();
    const material = {
      calendarArtifactId: "a6000000-0000-4000-8000-000000000001",
      calendarArtifactSha256: "b".repeat(64),
      schedule: {
        schema: "twofold.two_stage_cycle_calendar/v1",
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
      },
    } satisfies ArenaRoundCalendarMaterial;
    const handler = vi.fn(async () => material);
    const runner = new ArenaRoundProvisioningRunner({
      workerId: "twofold-worker",
      leaseSeconds: 60,
      queue: repository,
      handler,
      now: () => new Date("2026-09-01T20:20:09.000Z"),
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("completed");
    expect(repository.claim).toHaveBeenCalledWith({
      workerId: "twofold-worker",
      leaseSeconds: 60,
      now: "2026-09-01T20:20:09.000Z",
    });
    expect(repository.commit).toHaveBeenCalledWith({
      provisioningId: item.provisioningId,
      sourceRoundId: item.sourceRoundId,
      seasonId: item.seasonId,
      roundIndex: item.nextRoundIndex,
      leaseToken: item.leaseToken,
      ...material,
      completedAt: "2026-09-01T20:20:09.000Z",
    });
  });

  it("sanitizes provider failures before returning a retryable lease", async () => {
    const repository = queue();
    const runner = new ArenaRoundProvisioningRunner({
      workerId: "twofold-worker",
      leaseSeconds: 60,
      queue: repository,
      handler: async () => { throw new Error("calendar secret=do-not-leak"); },
      now: () => new Date("2026-09-01T20:20:09.000Z"),
      failureEnvironment: { ALPACA_API_SECRET_KEY: "do-not-leak" },
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("failed");
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({
      provisioningId: item.provisioningId,
      leaseToken: item.leaseToken,
      errorCode: "ROUND_PROVISIONING_FAILED",
      retryable: true,
    }));
    expect(JSON.stringify(vi.mocked(repository.fail).mock.calls))
      .not.toContain("do-not-leak");
  });
});
