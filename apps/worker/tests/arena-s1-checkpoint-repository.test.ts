import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  registerArenaS1CheckpointExact,
  type ArenaS1CheckpointRpcClient,
} from "../src/arena-s1-checkpoint-repository.js";
import type { FrozenOrderPlanRegistration } from "../src/order-plan-registration.js";

const ids = Object.freeze({
  entry: "b1000000-0000-8000-8000-000000000001",
  account: "b2000000-0000-4000-8000-000000000001",
  submission: "b3000000-0000-4000-8000-000000000001",
  stageResult: "b4000000-0000-8000-8000-000000000001",
  s1Plan: "b5000000-0000-8000-8000-000000000001",
  s2Plan: "b6000000-0000-8000-8000-000000000001",
  run: "b7000000-0000-4000-8000-000000000001",
  decision: "b8000000-0000-8000-8000-000000000001",
});
const checkpointCanonicalJson = "{\"result\":\"s1-checkpoint\"}";
const checkpointSha256 = createHash("sha256")
  .update(checkpointCanonicalJson, "utf8")
  .digest("hex");
const registration = Object.freeze({
  manifestSchema: "twofold.frozen_order_plan/v1",
  planCanonicalJson: "{\"plan\":\"s2\"}",
  planSha256: "a".repeat(64),
  enginePlanFingerprintSha256: "b".repeat(64),
  rpcArguments: Object.freeze({
    p_idempotency_key: "ignored-generic-key",
    p_strategy_account_id: ids.account,
    p_run_id: ids.run,
    p_decision_id: ids.decision,
    p_accepted_submission_id: ids.submission,
    p_stage: "S2",
    p_planned_at: "2026-08-31T20:20:06.000Z",
    p_planned_trade_date: "2026-09-01",
    p_manifest_schema: "twofold.frozen_order_plan/v1",
    p_plan_canonical_json: "{\"plan\":\"s2\"}",
    p_plan_sha256: "a".repeat(64),
    p_recorded_by: "worker",
  }),
}) satisfies FrozenOrderPlanRegistration;

function client(data: unknown): ArenaS1CheckpointRpcClient {
  return { rpc: vi.fn(async () => ({ data, error: null, status: 200 })) };
}

function response(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schema: "twofold.arena_cycle_stage_result/v1",
    stageResultId: ids.stageResult,
    roundEntryId: ids.entry,
    phase: "SETTLE_S1_AND_PREPARE_S2",
    strategyAccountId: ids.account,
    acceptedSubmissionId: ids.submission,
    openingHeadSequence: "1",
    openingHeadSha256: "c".repeat(64),
    s1FrozenOrderPlanId: ids.s1Plan,
    s2FrozenOrderPlanId: ids.s2Plan,
    artifactSchema: "twofold.accepted_target_cycle_s1_checkpoint/v1",
    artifactSha256: checkpointSha256,
    recordedBy: "worker",
    recordedAt: "2026-08-31T20:20:07.000Z",
    ...overrides,
  };
}

describe("Arena S1 checkpoint repository", () => {
  it("registers exact checkpoint and S2 bytes through one RPC", async () => {
    const rpc = client(response());
    const result = await registerArenaS1CheckpointExact(rpc, {
      idempotencyKey: `arena:${ids.entry}:s1-checkpoint`,
      roundEntryId: ids.entry,
      expectedHeadSequence: "1",
      expectedHeadSha256: "c".repeat(64),
      registration,
      checkpointCanonicalJson,
      checkpointSha256,
      recordedBy: "worker",
    });
    expect(result.s2FrozenOrderPlanId).toBe(ids.s2Plan);
    expect(rpc.rpc).toHaveBeenCalledWith("register_arena_s1_checkpoint", {
      p_idempotency_key: `arena:${ids.entry}:s1-checkpoint`,
      p_round_entry_id: ids.entry,
      p_expected_head_sequence: "1",
      p_expected_head_sha256: "c".repeat(64),
      p_s2_plan_canonical_json: registration.planCanonicalJson,
      p_s2_plan_sha256: registration.planSha256,
      p_checkpoint_canonical_json: checkpointCanonicalJson,
      p_checkpoint_sha256: checkpointSha256,
      p_recorded_by: "worker",
    });
  });

  it("routes participation-capped checkpoints through the v2 boundary", async () => {
    const rpc = client(response());
    const v2 = {
      ...registration,
      planCanonicalJson:
        '{"executionModel":"SIMULATED_MINUTE_PARTICIPATION"}',
    } satisfies FrozenOrderPlanRegistration;
    await registerArenaS1CheckpointExact(rpc, {
      idempotencyKey: `arena:${ids.entry}:s1-checkpoint`,
      roundEntryId: ids.entry,
      expectedHeadSequence: "1",
      expectedHeadSha256: "c".repeat(64),
      registration: v2,
      checkpointCanonicalJson,
      checkpointSha256,
      recordedBy: "worker",
    });
    expect(rpc.rpc).toHaveBeenCalledWith(
      "register_arena_s1_checkpoint_v2",
      expect.any(Object),
    );
  });

  it("rejects a response that crosses the requested account", async () => {
    await expect(registerArenaS1CheckpointExact(client(response({
      strategyAccountId: "b2000000-0000-4000-8000-000000000099",
    })), {
      idempotencyKey: `arena:${ids.entry}:s1-checkpoint`,
      roundEntryId: ids.entry,
      expectedHeadSequence: "1",
      expectedHeadSha256: "c".repeat(64),
      registration,
      checkpointCanonicalJson,
      checkpointSha256,
      recordedBy: "worker",
    })).rejects.toThrow("inconsistent identity");
  });
});
