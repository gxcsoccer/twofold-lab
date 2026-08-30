import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  registerArenaS1PlanExact,
  type ArenaS1PlanRpcClient,
} from "../src/arena-s1-plan-repository.js";
import type { FrozenOrderPlanRegistration } from "../src/order-plan-registration.js";

const ids = Object.freeze({
  entry: "c1000000-0000-8000-8000-000000000001",
  account: "c2000000-0000-4000-8000-000000000001",
  submission: "c3000000-0000-4000-8000-000000000001",
  stageResult: "c4000000-0000-8000-8000-000000000001",
  plan: "c5000000-0000-8000-8000-000000000001",
  run: "c6000000-0000-4000-8000-000000000001",
  decision: "c7000000-0000-8000-8000-000000000001",
});
const resultCanonicalJson = "{\"result\":\"s1\"}";
const resultSha256 = createHash("sha256")
  .update(resultCanonicalJson, "utf8")
  .digest("hex");

const registration = Object.freeze({
  manifestSchema: "twofold.frozen_order_plan/v1",
  planCanonicalJson: "{\"plan\":\"s1\"}",
  planSha256: "a".repeat(64),
  enginePlanFingerprintSha256: "b".repeat(64),
  rpcArguments: Object.freeze({
    p_idempotency_key: "ignored-generic-key",
    p_strategy_account_id: ids.account,
    p_run_id: ids.run,
    p_decision_id: ids.decision,
    p_accepted_submission_id: ids.submission,
    p_stage: "S1",
    p_planned_at: "2026-08-28T22:30:00.000Z",
    p_planned_trade_date: "2026-08-31",
    p_manifest_schema: "twofold.frozen_order_plan/v1",
    p_plan_canonical_json: "{\"plan\":\"s1\"}",
    p_plan_sha256: "a".repeat(64),
    p_recorded_by: "worker",
  }),
}) satisfies FrozenOrderPlanRegistration;

function client(data: unknown): ArenaS1PlanRpcClient {
  return { rpc: vi.fn(async () => ({ data, error: null, status: 200 })) };
}

describe("Arena S1 plan repository", () => {
  it("registers exact plan/result bytes through the Round-aware RPC", async () => {
    const rpc = client({
      schema: "twofold.arena_cycle_stage_result/v1",
      stageResultId: ids.stageResult,
      roundEntryId: ids.entry,
      phase: "PREPARE_S1_ORDERS",
      strategyAccountId: ids.account,
      acceptedSubmissionId: ids.submission,
      openingHeadSequence: "0",
      openingHeadSha256: "c".repeat(64),
      s1FrozenOrderPlanId: ids.plan,
      s2FrozenOrderPlanId: null,
      artifactSchema: "twofold.accepted_target_cycle_s1_plan/v1",
      artifactSha256: resultSha256,
      recordedBy: "worker",
      recordedAt: "2026-08-29T01:00:00.000Z",
    });
    const result = await registerArenaS1PlanExact(rpc, {
      idempotencyKey: `arena:${ids.entry}:s1-plan`,
      roundEntryId: ids.entry,
      expectedHeadSequence: "0",
      expectedHeadSha256: "c".repeat(64),
      registration,
      resultCanonicalJson,
      resultSha256,
      recordedBy: "worker",
    });
    expect(result.s1FrozenOrderPlanId).toBe(ids.plan);
    expect(rpc.rpc).toHaveBeenCalledWith("register_arena_s1_plan", {
      p_idempotency_key: `arena:${ids.entry}:s1-plan`,
      p_round_entry_id: ids.entry,
      p_expected_head_sequence: "0",
      p_expected_head_sha256: "c".repeat(64),
      p_plan_canonical_json: registration.planCanonicalJson,
      p_plan_sha256: registration.planSha256,
      p_result_canonical_json: resultCanonicalJson,
      p_result_sha256: resultSha256,
      p_recorded_by: "worker",
    });
  });

  it("routes participation-capped plans through the v2 database boundary", async () => {
    const rpc = client({
      schema: "twofold.arena_cycle_stage_result/v1",
      stageResultId: ids.stageResult,
      roundEntryId: ids.entry,
      phase: "PREPARE_S1_ORDERS",
      strategyAccountId: ids.account,
      acceptedSubmissionId: ids.submission,
      openingHeadSequence: "0",
      openingHeadSha256: "c".repeat(64),
      s1FrozenOrderPlanId: ids.plan,
      s2FrozenOrderPlanId: null,
      artifactSchema: "twofold.accepted_target_cycle_s1_plan/v1",
      artifactSha256: resultSha256,
      recordedBy: "worker",
      recordedAt: "2026-08-29T01:00:00.000Z",
    });
    const v2 = {
      ...registration,
      planCanonicalJson:
        '{"executionModel":"SIMULATED_MINUTE_PARTICIPATION"}',
    } satisfies FrozenOrderPlanRegistration;
    await registerArenaS1PlanExact(rpc, {
      idempotencyKey: `arena:${ids.entry}:s1-plan`,
      roundEntryId: ids.entry,
      expectedHeadSequence: "0",
      expectedHeadSha256: "c".repeat(64),
      registration: v2,
      resultCanonicalJson,
      resultSha256,
      recordedBy: "worker",
    });
    expect(rpc.rpc).toHaveBeenCalledWith(
      "register_arena_s1_plan_v2",
      expect.any(Object),
    );
  });

  it("rejects a response that crosses the requested identity", async () => {
    await expect(registerArenaS1PlanExact(client({
      schema: "twofold.arena_cycle_stage_result/v1",
      stageResultId: ids.stageResult,
      roundEntryId: "c1000000-0000-8000-8000-000000000099",
      phase: "PREPARE_S1_ORDERS",
      strategyAccountId: ids.account,
      acceptedSubmissionId: ids.submission,
      openingHeadSequence: "0",
      openingHeadSha256: "c".repeat(64),
      s1FrozenOrderPlanId: ids.plan,
      s2FrozenOrderPlanId: null,
      artifactSchema: "twofold.accepted_target_cycle_s1_plan/v1",
      artifactSha256: resultSha256,
      recordedBy: "worker",
      recordedAt: "2026-08-29T01:00:00.000Z",
    }), {
      idempotencyKey: `arena:${ids.entry}:s1-plan`,
      roundEntryId: ids.entry,
      expectedHeadSequence: "0",
      expectedHeadSha256: "c".repeat(64),
      registration,
      resultCanonicalJson,
      resultSha256,
      recordedBy: "worker",
    })).rejects.toThrow("inconsistent identity");
  });
});
