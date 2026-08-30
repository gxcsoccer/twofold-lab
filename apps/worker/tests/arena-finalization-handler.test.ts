import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadArenaCycleMaterial,
  buildArenaFullCycleInput,
  runAcceptedTargetCycle,
  loadArenaScoreBase,
  buildArenaCycleFinalValuation,
  deterministicUuidV8,
  finalizeArenaCycleExact,
} = vi.hoisted(() => ({
  loadArenaCycleMaterial: vi.fn(),
  buildArenaFullCycleInput: vi.fn(),
  runAcceptedTargetCycle: vi.fn(),
  loadArenaScoreBase: vi.fn(),
  buildArenaCycleFinalValuation: vi.fn(),
  deterministicUuidV8: vi.fn(),
  finalizeArenaCycleExact: vi.fn(),
}));

vi.mock("../src/arena-cycle-material.js", () => ({ loadArenaCycleMaterial }));
vi.mock("../src/arena-cycle-inputs.js", () => ({ buildArenaFullCycleInput }));
vi.mock("@twofold/core", () => ({ runAcceptedTargetCycle }));
vi.mock("../src/arena-finalization-repository.js", () => ({
  loadArenaScoreBase,
  finalizeArenaCycleExact,
}));
vi.mock("../src/arena-valuation.js", () => ({ buildArenaCycleFinalValuation }));
vi.mock("../src/accepted-target-cycle-service.js", () => ({ deterministicUuidV8 }));

import { createArenaFinalizationHandler } from "../src/arena-finalization-handler.js";
import type { ArenaWorkItem } from "../src/arena-work-repository.js";

const ids = Object.freeze({
  work: "81000000-0000-8000-8000-000000000001",
  entry: "82000000-0000-8000-8000-000000000001",
  round: "83000000-0000-4000-8000-000000000001",
  season: "84000000-0000-4000-8000-000000000001",
  entrant: "85000000-0000-4000-8000-000000000001",
  run: "86000000-0000-4000-8000-000000000001",
  account: "87000000-0000-4000-8000-000000000001",
  snapshot: "88000000-0000-4000-8000-000000000001",
  lease: "89000000-0000-4000-8000-000000000001",
  cycle: "8a000000-0000-8000-8000-000000000001",
  event: "8b000000-0000-8000-8000-000000000001",
  valuation: "8c000000-0000-8000-8000-000000000001",
});
const item = Object.freeze({
  schema: "twofold.arena_work_item_result/v1",
  workItemId: ids.work,
  roundEntryId: ids.entry,
  roundId: ids.round,
  seasonId: ids.season,
  entrantId: ids.entrant,
  runId: ids.run,
  phase: "FINALIZE_ACCEPTED_TARGET_CYCLE",
  predecessorWorkItemId: null,
  scheduledAt: "2026-09-01T20:20:00.000Z",
  deadlineAt: null,
  nextAttemptAt: "2026-09-01T20:20:00.000Z",
  status: "CLAIMED",
  attemptCount: "1",
  claimedBy: "worker",
  leaseToken: ids.lease,
  leaseExpiresAt: "2026-09-01T20:21:00.000Z",
  completedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  retryable: null,
}) satisfies ArenaWorkItem;

describe("Arena finalization handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadArenaCycleMaterial.mockResolvedValue({
      roundEntry: { seasonId: ids.season, entrantId: ids.entrant },
      portfolio: { strategyAccountId: ids.account },
      evidence: { s2Close: { snapshotId: ids.snapshot } },
    });
    buildArenaFullCycleInput.mockReturnValue({
      timeline: { navAsOf: "2026-09-01T20:20:06.000Z" },
    });
    runAcceptedTargetCycle.mockReturnValue({
      canonicalJson: "{\"cycle\":\"exact\"}",
      contentSha256: "a".repeat(64),
      s1: { settlements: [] },
      s2: { settlements: [{ status: "READY" }] },
      nav: { liquidationNav: "18142.028" },
    });
    loadArenaScoreBase.mockResolvedValue("18118.66");
    buildArenaCycleFinalValuation.mockReturnValue({
      canonicalJson: "{\"valuation\":\"exact\"}",
      sha256: "b".repeat(64),
    });
    deterministicUuidV8
      .mockReturnValueOnce(ids.cycle)
      .mockReturnValueOnce(ids.event);
    finalizeArenaCycleExact.mockResolvedValue({
      cycleId: ids.cycle,
      valuationId: ids.valuation,
      sourceStreamSeq: "4",
    });
  });

  it("replays Core and publishes the final score through one atomic RPC", async () => {
    const client = { rpc: vi.fn() };
    const handler = createArenaFinalizationHandler({ client, recordedBy: "worker" });
    const result = await handler(item, new AbortController().signal);
    expect(loadArenaCycleMaterial).toHaveBeenCalledWith(client, {
      roundEntryId: ids.entry,
      stage: "FINALIZE_ACCEPTED_TARGET_CYCLE",
    });
    expect(loadArenaScoreBase).toHaveBeenCalledWith(client, {
      seasonId: ids.season,
      entrantId: ids.entrant,
    });
    expect(buildArenaCycleFinalValuation).toHaveBeenCalledWith({
      cycleInput: { timeline: { navAsOf: "2026-09-01T20:20:06.000Z" } },
      cycle: expect.objectContaining({ contentSha256: "a".repeat(64) }),
      snapshotId: ids.snapshot,
      scoreBaseLiquidationNav: "18118.66",
    });
    expect(finalizeArenaCycleExact).toHaveBeenCalledWith(client, expect.objectContaining({
      roundEntryId: ids.entry,
      cycleId: ids.cycle,
      eventId: ids.event,
      completedAt: "2026-09-01T20:20:06.000Z",
    }));
    expect(result).toEqual({
      outcome: "ACCEPTED_TARGET_CYCLE_FINALIZED",
      cycleId: ids.cycle,
      valuationId: ids.valuation,
      sourceStreamSeq: "4",
      s1SettlementCount: "0",
      s2SettlementCount: "1",
      liquidationNav: "18142.028",
    });
  });
});
