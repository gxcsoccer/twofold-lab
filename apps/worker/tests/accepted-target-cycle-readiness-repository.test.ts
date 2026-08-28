import { describe, expect, it, vi } from "vitest";

import {
  getAcceptedTargetCycleReadiness,
  type AcceptedTargetCycleReadiness,
} from "../src/accepted-target-cycle-readiness-repository.js";

const DECISION_ID = "40000000-0000-4000-8000-000000000001";

function readiness(
  overrides: Partial<AcceptedTargetCycleReadiness> = {},
): AcceptedTargetCycleReadiness {
  return {
    schema: "twofold.accepted_target_cycle_readiness/v1",
    status: "BLOCKED",
    decisionId: DECISION_ID,
    runId: "30000000-0000-4000-8000-000000000001",
    acceptedSubmissionId: "50000000-0000-4000-8000-000000000001",
    strategyAccountId: null,
    ledgerHeadSha256: null,
    cycleId: null,
    blockers: ["STRATEGY_ACCOUNT_MISSING"],
    ...overrides,
  };
}

describe("accepted target cycle readiness repository", () => {
  it("reads one exact, string-only causal readiness state", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: readiness(),
      error: null,
      status: 200,
    });

    await expect(getAcceptedTargetCycleReadiness({ rpc }, DECISION_ID))
      .resolves.toEqual(readiness());
    expect(rpc).toHaveBeenCalledWith("get_accepted_target_cycle_readiness", {
      p_decision_id: DECISION_ID,
    });
  });

  it("accepts ready and completed terminal shapes without inventing blockers", async () => {
    const ready = readiness({
      status: "READY_FOR_INPUT_BUILD",
      strategyAccountId: "20000000-0000-4000-8000-000000000001",
      ledgerHeadSha256: "a".repeat(64),
      blockers: [],
    });
    const completed = readiness({
      status: "COMPLETED",
      strategyAccountId: "20000000-0000-4000-8000-000000000001",
      ledgerHeadSha256: "a".repeat(64),
      cycleId: "10000000-0000-8000-8000-000000000001",
      blockers: [],
    });
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: ready, error: null, status: 200 })
      .mockResolvedValueOnce({ data: completed, error: null, status: 200 });

    await expect(getAcceptedTargetCycleReadiness({ rpc }, DECISION_ID))
      .resolves.toEqual(ready);
    await expect(getAcceptedTargetCycleReadiness({ rpc }, DECISION_ID))
      .resolves.toEqual(completed);
  });

  it("fails closed on schema drift, contradictory state, and JSON numbers", async () => {
    for (const invalid of [
      { ...readiness(), surprise: "field" },
      readiness({ status: "READY_FOR_INPUT_BUILD", blockers: ["LEDGER_HEAD_MISSING"] }),
      { ...readiness(), blockers: [1] },
    ]) {
      const rpc = vi.fn().mockResolvedValue({ data: invalid, error: null, status: 200 });
      await expect(getAcceptedTargetCycleReadiness({ rpc }, DECISION_ID))
        .rejects.toThrow();
    }
  });

  it("rejects request and response identity drift", async () => {
    const rpc = vi.fn();
    await expect(getAcceptedTargetCycleReadiness({ rpc }, "not-a-uuid"))
      .rejects.toThrow("decisionId");
    expect(rpc).not.toHaveBeenCalled();

    rpc.mockResolvedValue({
      data: readiness({ decisionId: "40000000-0000-4000-8000-000000000002" }),
      error: null,
      status: 200,
    });
    await expect(getAcceptedTargetCycleReadiness({ rpc }, DECISION_ID))
      .rejects.toThrow("different decision");
  });
});
