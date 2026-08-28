import { describe, expect, it } from "vitest";

import { validateAcceptedTargetCycleReadiness } from "./accepted-target-cycle-readiness";

const DECISION_ID = "40000000-0000-4000-8000-000000000001";

function readiness(overrides: Record<string, unknown> = {}) {
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

describe("accepted target cycle readiness dashboard contract", () => {
  it("accepts the exact causal blocker returned by the coordination boundary", () => {
    expect(validateAcceptedTargetCycleReadiness(readiness(), DECISION_ID)).toEqual({
      ok: true,
      value: readiness(),
    });
  });

  it("fails closed on identity drift or contradictory terminal state", () => {
    expect(validateAcceptedTargetCycleReadiness(readiness({
      decisionId: "40000000-0000-4000-8000-000000000002",
    }), DECISION_ID)).toMatchObject({ ok: false });
    expect(validateAcceptedTargetCycleReadiness(readiness({
      status: "COMPLETED",
      cycleId: null,
    }), DECISION_ID)).toMatchObject({ ok: false });
  });
});
