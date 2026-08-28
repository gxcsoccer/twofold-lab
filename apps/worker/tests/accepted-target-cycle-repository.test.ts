import { describe, expect, it, vi } from "vitest";

import {
  commitAcceptedTargetCycleExact,
  type CommitAcceptedTargetCycleRpcArguments,
} from "../src/accepted-target-cycle-repository.js";

const HASH = "a".repeat(64);
const arguments_ = Object.freeze({
  p_idempotency_key: "cycle:decision-1:commit",
  p_cycle_id: "10000000-0000-8000-8000-000000000001",
  p_strategy_account_id: "20000000-0000-4000-8000-000000000001",
  p_run_id: "30000000-0000-4000-8000-000000000001",
  p_decision_id: "40000000-0000-4000-8000-000000000001",
  p_accepted_submission_id: "50000000-0000-4000-8000-000000000001",
  p_s1_frozen_order_plan_id: "60000000-0000-4000-8000-000000000001",
  p_s2_frozen_order_plan_id: "60000000-0000-4000-8000-000000000002",
  p_cycle_canonical_json: JSON.stringify({
    schema: "twofold.accepted_target_cycle/v1",
    decisionId: "40000000-0000-4000-8000-000000000001",
  }),
  p_cycle_sha256: HASH,
  p_completed_at: "2026-08-26T20:15:00.000Z",
  p_expected_run_stream_seq: "9",
  p_expected_projection_stream_seq: "0",
  p_event_id: "70000000-0000-8000-8000-000000000001",
  p_recorded_by: "twofold-worker",
}) satisfies CommitAcceptedTargetCycleRpcArguments;

function result(overrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.accepted_target_cycle_commit_result/v1",
    cycleId: arguments_.p_cycle_id,
    strategyAccountId: arguments_.p_strategy_account_id,
    runId: arguments_.p_run_id,
    decisionId: arguments_.p_decision_id,
    acceptedSubmissionId: arguments_.p_accepted_submission_id,
    s1FrozenOrderPlanId: arguments_.p_s1_frozen_order_plan_id,
    s2FrozenOrderPlanId: arguments_.p_s2_frozen_order_plan_id,
    cycleSha256: HASH,
    sourceEventId: arguments_.p_event_id,
    sourceStreamSeq: "10",
    projectionName: "dashboard.accepted_target_cycle",
    recordedBy: "twofold-worker",
    recordedAt: "2026-08-26T20:15:00.123Z",
    ...overrides,
  };
}

describe("accepted target cycle repository", () => {
  it("retries one ambiguous commit with byte-identical arguments", async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new Error("connection closed after commit"))
      .mockResolvedValueOnce({ data: result(), error: null, status: 200 });

    await expect(commitAcceptedTargetCycleExact(
      { rpc } as any,
      arguments_,
    )).resolves.toMatchObject({ sourceStreamSeq: "10", cycleSha256: HASH });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]).toBe(arguments_);
    expect(rpc.mock.calls[1]?.[1]).toBe(arguments_);
  });

  it("rejects numeric tokens and exact-request drift", async () => {
    const numeric = vi.fn().mockResolvedValue({
      data: result({ sourceStreamSeq: 10 }),
      error: null,
      status: 200,
    });
    await expect(commitAcceptedTargetCycleExact(
      { rpc: numeric } as any,
      arguments_,
    )).rejects.toThrow("numeric token");

    const drift = vi.fn().mockResolvedValue({
      data: result({ decisionId: "40000000-0000-4000-8000-000000000002" }),
      error: null,
      status: 200,
    });
    await expect(commitAcceptedTargetCycleExact(
      { rpc: drift } as any,
      arguments_,
    )).rejects.toThrow("inconsistent with the exact request");
  });

  it("fails before mutation on non-canonical request values", async () => {
    const rpc = vi.fn();
    await expect(commitAcceptedTargetCycleExact(
      { rpc } as any,
      { ...arguments_, p_expected_run_stream_seq: "09" },
    )).rejects.toThrow("canonical non-negative integer");
    expect(rpc).not.toHaveBeenCalled();
  });
});
