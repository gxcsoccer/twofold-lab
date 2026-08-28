import { beforeEach, describe, expect, it, vi } from "vitest";

const cycle = {
  submissionId: "50000000-0000-4000-8000-000000000001",
  decisionId: "40000000-0000-4000-8000-000000000001",
  s1: { plan: { stage: "S1" } },
  s2: { plan: { stage: "S2" } },
  canonicalJson: "{\"schema\":\"twofold.accepted_target_cycle/v1\"}",
  contentSha256: "a".repeat(64),
};
const s1Registration = { rpcArguments: { p_stage: "S1" } };
const s2Registration = { rpcArguments: { p_stage: "S2" } };

const runAcceptedTargetCycle = vi.fn(() => cycle);
const buildFrozenOrderPlanRegistration = vi.fn((input: any) =>
  input.plan.stage === "S1" ? s1Registration : s2Registration
);
const registerFrozenOrderPlanExact = vi.fn(async (_client: unknown, registration: unknown) => ({
  frozen_order_plan_id: registration === s1Registration
    ? "60000000-0000-4000-8000-000000000001"
    : "60000000-0000-4000-8000-000000000002",
}));
const commitAcceptedTargetCycleExact = vi.fn(async (_client: unknown, arguments_: any) => ({
  cycleId: arguments_.p_cycle_id,
}));

vi.mock("@twofold/core", () => ({ runAcceptedTargetCycle }));
vi.mock("../src/order-plan-registration.js", () => ({
  buildFrozenOrderPlanRegistration,
}));
vi.mock("../src/order-plan-repository.js", () => ({ registerFrozenOrderPlanExact }));
vi.mock("../src/accepted-target-cycle-repository.js", () => ({
  commitAcceptedTargetCycleExact,
}));

const { deterministicUuidV8, executeAcceptedTargetCycle } = await import(
  "../src/accepted-target-cycle-service.js"
);

describe("accepted target cycle service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hands one accepted submission through S1, S2, and one atomic cycle commit", async () => {
    const client = {};
    const cycleInput = {
      acceptedSubmission: {
        submissionId: cycle.submissionId,
        decisionId: cycle.decisionId,
      },
      account: {
        strategyAccountId: "20000000-0000-4000-8000-000000000001",
        runId: "30000000-0000-4000-8000-000000000001",
      },
      timeline: {
        s1PlannedAt: "2026-08-24T20:16:00.000Z",
        s1TradeDate: "2026-08-25",
        s2PlannedAt: "2026-08-25T20:16:00.000Z",
        s2TradeDate: "2026-08-26",
        navAsOf: "2026-08-26T20:15:00.000Z",
      },
    };

    await executeAcceptedTargetCycle(client as any, {
      cycleInput: cycleInput as any,
      expectedRunStreamSequence: "9",
      expectedProjectionStreamSequence: "0",
      idempotencyKey: "cycle:decision-1",
      recordedBy: "twofold-worker",
    });

    expect(runAcceptedTargetCycle).toHaveBeenCalledWith(cycleInput);
    expect(registerFrozenOrderPlanExact.mock.calls.map((call) => call[1])).toEqual([
      s1Registration,
      s2Registration,
    ]);
    const commit = commitAcceptedTargetCycleExact.mock.calls[0]?.[1];
    expect(commit).toMatchObject({
      p_decision_id: cycle.decisionId,
      p_accepted_submission_id: cycle.submissionId,
      p_s1_frozen_order_plan_id: "60000000-0000-4000-8000-000000000001",
      p_s2_frozen_order_plan_id: "60000000-0000-4000-8000-000000000002",
      p_cycle_canonical_json: cycle.canonicalJson,
      p_cycle_sha256: cycle.contentSha256,
      p_expected_run_stream_seq: "9",
    });
    expect(commit.p_cycle_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("derives the same RFC 9562 UUIDv8 for exact replay", () => {
    const first = deterministicUuidV8("twofold.test/v1", "stable-key");
    expect(first).toBe("c50198df-c434-8a2b-8d0b-c3c19bb9f7cc");
    expect(deterministicUuidV8("twofold.test/v1", "stable-key")).toBe(first);
    expect(deterministicUuidV8("twofold.test/v1", "other-key")).not.toBe(first);
  });
});
