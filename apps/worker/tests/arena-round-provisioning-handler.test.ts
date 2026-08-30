import { describe, expect, it, vi } from "vitest";

import { createArenaRoundProvisioningHandler } from
  "../src/arena-round-provisioning-handler.js";
import type { ArenaRoundProvisioning } from
  "../src/arena-round-provisioning-repository.js";

const item = Object.freeze({
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
  leaseExpiresAt: "2026-09-03T12:01:00.000Z",
  completedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  retryable: null,
}) satisfies ArenaRoundProvisioning;

describe("Arena Round provisioning handler", () => {
  it("requests enough authoritative calendar to recover after scheduler delay", async () => {
    const material = {
      calendarArtifactId: "a6000000-0000-4000-8000-000000000001",
      calendarArtifactSha256: "a".repeat(64),
      schedule: { schema: "twofold.two_stage_cycle_calendar/v1" },
    } as never;
    const calendar = { prepare: vi.fn(async () => material) };
    const handler = createArenaRoundProvisioningHandler({
      calendar,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    const signal = new AbortController().signal;

    await expect(handler(item, signal)).resolves.toBe(material);
    expect(calendar.prepare).toHaveBeenCalledWith({
      seasonId: item.seasonId,
      seasonCode: item.seasonCode,
      roundIndex: item.nextRoundIndex,
      decisionSessionDate: "2026-09-01",
      decisionAvailableAt: "2026-09-03T12:00:00.000Z",
      calendarStartDate: "2026-09-01",
      calendarEndDate: "2026-09-17",
      recordedBy: item.recordedBy,
      signal,
    });
  });
});
