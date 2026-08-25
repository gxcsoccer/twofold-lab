import { describe, expect, it, vi } from "vitest";

import { registerFrozenOrderPlanExact } from "../src/order-plan-repository.js";
import type { FrozenOrderPlanRegistration } from "../src/order-plan-registration.js";

const registration = Object.freeze({
  manifestSchema: "twofold.frozen_order_plan/v1",
  planCanonicalJson: "{}",
  planSha256: "a".repeat(64),
  enginePlanFingerprintSha256: "b".repeat(64),
  rpcArguments: Object.freeze({
    p_idempotency_key: "plan:S2",
    p_strategy_account_id: "70000000-0000-4000-8000-000000000002",
    p_run_id: "70000000-0000-4000-8000-000000000001",
    p_decision_id: "72000000-0000-4000-8000-000000000001",
    p_accepted_submission_id: "72000000-0000-4000-8000-000000000002",
    p_stage: "S2",
    p_planned_at: "2026-08-25T20:15:00.000Z",
    p_planned_trade_date: "2026-08-26",
    p_manifest_schema: "twofold.frozen_order_plan/v1",
    p_plan_canonical_json: "{}",
    p_plan_sha256: "a".repeat(64),
    p_recorded_by: "worker-test",
  }),
}) satisfies FrozenOrderPlanRegistration;

const returnedRow = {
  frozen_order_plan_id: "74000000-0000-4000-8000-000000000001",
  run_id: registration.rpcArguments.p_run_id,
  decision_id: registration.rpcArguments.p_decision_id,
  accepted_submission_id: registration.rpcArguments.p_accepted_submission_id,
  stage: registration.rpcArguments.p_stage,
  plan_sha256: registration.planSha256,
};

describe("frozen order plan repository", () => {
  it("retries an ambiguous response once with the exact same frozen arguments", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "timeout" }, status: 504 })
      .mockResolvedValueOnce({ data: returnedRow, error: null, status: 200 });

    await expect(registerFrozenOrderPlanExact({ rpc }, registration)).resolves.toEqual(
      returnedRow,
    );
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]?.[1]).toBe(registration.rpcArguments);
    expect(rpc.mock.calls[1]?.[1]).toBe(registration.rpcArguments);
  });

  it("does not retry or accept a deterministic conflict/response mismatch", async () => {
    const conflictRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "identity reused" },
      status: 409,
    });
    await expect(registerFrozenOrderPlanExact(
      { rpc: conflictRpc },
      registration,
    )).rejects.toThrow("identity reused");
    expect(conflictRpc).toHaveBeenCalledTimes(1);

    const mismatchRpc = vi.fn().mockResolvedValue({
      data: { ...returnedRow, plan_sha256: "c".repeat(64) },
      error: null,
      status: 200,
    });
    await expect(registerFrozenOrderPlanExact(
      { rpc: mismatchRpc },
      registration,
    )).rejects.toThrow("inconsistent with the exact request");
  });
});
