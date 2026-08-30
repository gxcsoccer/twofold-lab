import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadArenaCycleMaterial,
  buildArenaS1PlanInput,
  prepareAcceptedTargetCycleS1,
  buildFrozenOrderPlanRegistration,
  registerArenaS1PlanExact,
} = vi.hoisted(() => ({
  loadArenaCycleMaterial: vi.fn(),
  buildArenaS1PlanInput: vi.fn(),
  prepareAcceptedTargetCycleS1: vi.fn(),
  buildFrozenOrderPlanRegistration: vi.fn(),
  registerArenaS1PlanExact: vi.fn(),
}));

vi.mock("../src/arena-cycle-material.js", () => ({ loadArenaCycleMaterial }));
vi.mock("../src/arena-cycle-inputs.js", () => ({ buildArenaS1PlanInput }));
vi.mock("@twofold/core", () => ({ prepareAcceptedTargetCycleS1 }));
vi.mock("../src/order-plan-registration.js", () => ({
  buildFrozenOrderPlanRegistration,
}));
vi.mock("../src/arena-s1-plan-repository.js", () => ({
  registerArenaS1PlanExact,
}));

import { createArenaS1PlanHandler } from "../src/arena-s1-plan-handler.js";
import type { ArenaWorkItem } from "../src/arena-work-repository.js";

const ids = Object.freeze({
  work: "d1000000-0000-8000-8000-000000000001",
  entry: "d2000000-0000-8000-8000-000000000001",
  round: "d3000000-0000-4000-8000-000000000001",
  season: "d4000000-0000-4000-8000-000000000001",
  entrant: "d5000000-0000-4000-8000-000000000001",
  run: "d6000000-0000-4000-8000-000000000001",
  decision: "d7000000-0000-8000-8000-000000000001",
  submission: "d8000000-0000-4000-8000-000000000001",
  account: "d9000000-0000-4000-8000-000000000001",
  lease: "da000000-0000-4000-8000-000000000001",
  stageResult: "db000000-0000-8000-8000-000000000001",
  plan: "dc000000-0000-8000-8000-000000000001",
});

const item = Object.freeze({
  schema: "twofold.arena_work_item_result/v1",
  workItemId: ids.work,
  roundEntryId: ids.entry,
  roundId: ids.round,
  seasonId: ids.season,
  entrantId: ids.entrant,
  runId: ids.run,
  phase: "PREPARE_S1_ORDERS",
  predecessorWorkItemId: null,
  scheduledAt: "2026-08-28T22:23:53.027Z",
  deadlineAt: "2026-08-31T13:30:00.000Z",
  nextAttemptAt: "2026-08-28T22:23:53.027Z",
  status: "CLAIMED",
  attemptCount: "1",
  claimedBy: "worker",
  leaseToken: ids.lease,
  leaseExpiresAt: "2026-08-29T01:01:00.000Z",
  completedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  retryable: null,
}) satisfies ArenaWorkItem;

describe("Arena S1 plan handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadArenaCycleMaterial.mockResolvedValue({
      roundEntry: { roundEntryId: ids.entry },
      acceptedSubmission: {
        submissionId: ids.submission,
        acceptedAt: "2026-08-28T22:30:00.000Z",
      },
      round: { s1SessionDate: "2026-08-31" },
      portfolio: {
        strategyAccountId: ids.account,
        ledgerHead: { sequence: "0", sha256: "a".repeat(64) },
      },
    });
    buildArenaS1PlanInput.mockReturnValue({ input: "core" });
    prepareAcceptedTargetCycleS1.mockReturnValue({
      plan: { stage: "S1", orders: [] },
      canonicalJson: "{\"result\":\"s1\"}",
      contentSha256: "b".repeat(64),
    });
    buildFrozenOrderPlanRegistration.mockReturnValue({ registration: "s1" });
    registerArenaS1PlanExact.mockResolvedValue({
      stageResultId: ids.stageResult,
      s1FrozenOrderPlanId: ids.plan,
      artifactSha256: "b".repeat(64),
    });
  });

  it("loads only PREPARE material, derives Core, and freezes exact bytes", async () => {
    const client = { rpc: vi.fn() };
    const handler = createArenaS1PlanHandler({ client, recordedBy: "worker" });
    const result = await handler(item, new AbortController().signal);

    expect(loadArenaCycleMaterial).toHaveBeenCalledWith(client, {
      roundEntryId: ids.entry,
      stage: "PREPARE_S1_ORDERS",
    });
    expect(prepareAcceptedTargetCycleS1).toHaveBeenCalledWith({ input: "core" });
    expect(buildFrozenOrderPlanRegistration).toHaveBeenCalledWith({
      idempotencyKey: `arena:${ids.entry}:S1`,
      strategyAccountId: ids.account,
      runId: ids.run,
      acceptedSubmissionId: ids.submission,
      plannedAt: "2026-08-28T22:30:00.000Z",
      plannedTradeDate: "2026-08-31",
      recordedBy: "worker",
      plan: { stage: "S1", orders: [] },
    });
    expect(registerArenaS1PlanExact).toHaveBeenCalledWith(client, {
      idempotencyKey: `arena:${ids.entry}:PREPARE_S1_ORDERS`,
      roundEntryId: ids.entry,
      expectedHeadSequence: "0",
      expectedHeadSha256: "a".repeat(64),
      registration: { registration: "s1" },
      resultCanonicalJson: "{\"result\":\"s1\"}",
      resultSha256: "b".repeat(64),
      recordedBy: "worker",
    });
    expect(result).toEqual({
      outcome: "S1_PLAN_FROZEN",
      stageResultId: ids.stageResult,
      frozenOrderPlanId: ids.plan,
      artifactSha256: "b".repeat(64),
      orderCount: "0",
    });
  });
});
