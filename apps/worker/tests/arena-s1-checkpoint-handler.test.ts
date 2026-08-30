import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadArenaCycleMaterial,
  buildArenaThroughS1Input,
  settleAcceptedTargetCycleS1AndPrepareS2,
  buildFrozenOrderPlanRegistration,
  registerArenaS1CheckpointExact,
} = vi.hoisted(() => ({
  loadArenaCycleMaterial: vi.fn(),
  buildArenaThroughS1Input: vi.fn(),
  settleAcceptedTargetCycleS1AndPrepareS2: vi.fn(),
  buildFrozenOrderPlanRegistration: vi.fn(),
  registerArenaS1CheckpointExact: vi.fn(),
}));

vi.mock("../src/arena-cycle-material.js", () => ({ loadArenaCycleMaterial }));
vi.mock("../src/arena-cycle-inputs.js", () => ({ buildArenaThroughS1Input }));
vi.mock("@twofold/core", () => ({ settleAcceptedTargetCycleS1AndPrepareS2 }));
vi.mock("../src/order-plan-registration.js", () => ({
  buildFrozenOrderPlanRegistration,
}));
vi.mock("../src/arena-s1-checkpoint-repository.js", () => ({
  registerArenaS1CheckpointExact,
}));

import { createArenaS1CheckpointHandler } from "../src/arena-s1-checkpoint-handler.js";
import type { ArenaWorkItem } from "../src/arena-work-repository.js";

const ids = Object.freeze({
  work: "a1000000-0000-8000-8000-000000000001",
  entry: "a2000000-0000-8000-8000-000000000001",
  round: "a3000000-0000-4000-8000-000000000001",
  season: "a4000000-0000-4000-8000-000000000001",
  entrant: "a5000000-0000-4000-8000-000000000001",
  run: "a6000000-0000-4000-8000-000000000001",
  submission: "a7000000-0000-4000-8000-000000000001",
  account: "a8000000-0000-4000-8000-000000000001",
  lease: "a9000000-0000-4000-8000-000000000001",
  stageResult: "aa000000-0000-8000-8000-000000000001",
  s2Plan: "ab000000-0000-8000-8000-000000000001",
});
const item = Object.freeze({
  schema: "twofold.arena_work_item_result/v1",
  workItemId: ids.work,
  roundEntryId: ids.entry,
  roundId: ids.round,
  seasonId: ids.season,
  entrantId: ids.entrant,
  runId: ids.run,
  phase: "SETTLE_S1_AND_PREPARE_S2",
  predecessorWorkItemId: null,
  scheduledAt: "2026-08-31T20:20:00.000Z",
  deadlineAt: "2026-09-01T13:30:00.000Z",
  nextAttemptAt: "2026-08-31T20:20:00.000Z",
  status: "CLAIMED",
  attemptCount: "1",
  claimedBy: "worker",
  leaseToken: ids.lease,
  leaseExpiresAt: "2026-08-31T20:21:00.000Z",
  completedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  retryable: null,
}) satisfies ArenaWorkItem;

describe("Arena S1 checkpoint handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadArenaCycleMaterial.mockResolvedValue({
      acceptedSubmission: { submissionId: ids.submission },
      portfolio: {
        strategyAccountId: ids.account,
        ledgerHead: { sequence: "1", sha256: "a".repeat(64) },
      },
    });
    buildArenaThroughS1Input.mockReturnValue({
      timeline: {
        s2PlannedAt: "2026-08-31T20:20:06.000Z",
        s2TradeDate: "2026-09-01",
      },
    });
    settleAcceptedTargetCycleS1AndPrepareS2.mockReturnValue({
      s1: { settlements: [] },
      s2Plan: { stage: "S2", orders: [] },
      canonicalJson: "{\"checkpoint\":\"s1\"}",
      contentSha256: "b".repeat(64),
    });
    buildFrozenOrderPlanRegistration.mockReturnValue({ registration: "s2" });
    registerArenaS1CheckpointExact.mockResolvedValue({
      stageResultId: ids.stageResult,
      s2FrozenOrderPlanId: ids.s2Plan,
      artifactSha256: "b".repeat(64),
    });
  });

  it("settles only S1 evidence and atomically freezes the S2 plan", async () => {
    const client = { rpc: vi.fn() };
    const handler = createArenaS1CheckpointHandler({ client, recordedBy: "worker" });
    const result = await handler(item, new AbortController().signal);

    expect(loadArenaCycleMaterial).toHaveBeenCalledWith(client, {
      roundEntryId: ids.entry,
      stage: "SETTLE_S1_AND_PREPARE_S2",
    });
    expect(settleAcceptedTargetCycleS1AndPrepareS2).toHaveBeenCalledWith({
      timeline: {
        s2PlannedAt: "2026-08-31T20:20:06.000Z",
        s2TradeDate: "2026-09-01",
      },
    });
    expect(buildFrozenOrderPlanRegistration).toHaveBeenCalledWith({
      idempotencyKey: `arena:${ids.entry}:S2`,
      strategyAccountId: ids.account,
      runId: ids.run,
      acceptedSubmissionId: ids.submission,
      plannedAt: "2026-08-31T20:20:06.000Z",
      plannedTradeDate: "2026-09-01",
      recordedBy: "worker",
      plan: { stage: "S2", orders: [] },
    });
    expect(registerArenaS1CheckpointExact).toHaveBeenCalledWith(client, {
      idempotencyKey: `arena:${ids.entry}:SETTLE_S1_AND_PREPARE_S2`,
      roundEntryId: ids.entry,
      expectedHeadSequence: "1",
      expectedHeadSha256: "a".repeat(64),
      registration: { registration: "s2" },
      checkpointCanonicalJson: "{\"checkpoint\":\"s1\"}",
      checkpointSha256: "b".repeat(64),
      recordedBy: "worker",
    });
    expect(result).toEqual({
      outcome: "S1_SETTLED_S2_PLAN_FROZEN",
      stageResultId: ids.stageResult,
      frozenOrderPlanId: ids.s2Plan,
      artifactSha256: "b".repeat(64),
      s1SettlementCount: "0",
      s2OrderCount: "0",
    });
  });
});
