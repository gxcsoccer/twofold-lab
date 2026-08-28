import { describe, expect, it } from "vitest";

import { validateAcceptedTargetCycleProjection } from "./accepted-target-cycle";

const DECISION = "40000000-0000-4000-8000-000000000001";
const SUBMISSION = "50000000-0000-4000-8000-000000000001";

function projection(overrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.dashboard.accepted_target_cycle/v1",
    status: "COMPLETED",
    cycleId: "10000000-0000-8000-8000-000000000001",
    decisionId: DECISION,
    acceptedSubmissionId: SUBMISSION,
    s1: { status: "COMPLETED", orderCount: "1", settlementCount: "1" },
    s2: { status: "COMPLETED", orderCount: "1", settlementCount: "1" },
    ledger: { transactionCount: "4", headSequence: "2", headSha256: "a".repeat(64) },
    nav: {
      currency: "USD",
      positionMarketValue: "1610",
      brokerNav: "2110",
      taxReserveDeductions: "135",
      taxReservedNav: "1975",
      liquidationDeductions: "0",
      liquidationNav: "1975",
    },
    artifactSha256: "b".repeat(64),
    completedAt: "2026-08-26T20:15:00.000Z",
    ...overrides,
  };
}

describe("accepted target cycle dashboard projection", () => {
  it("accepts the exact completed S1/S2, ledger, and NAV contract", () => {
    expect(validateAcceptedTargetCycleProjection(
      projection(), DECISION, SUBMISSION,
    )).toEqual({ ok: true, value: projection() });
  });

  it("fails closed on identity, stage conservation, or NAV drift", () => {
    const result = validateAcceptedTargetCycleProjection(projection({
      decisionId: "40000000-0000-4000-8000-000000000002",
      s2: { status: "COMPLETED", orderCount: "2", settlementCount: "1" },
      nav: { ...projection().nav, liquidationNav: "1974" },
    }), DECISION, SUBMISSION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toMatch(
      /decisionId.*不一致[\s\S]*orderCount.*不守恒[\s\S]*Liquidation NAV 不守恒/,
    );
  });
});
