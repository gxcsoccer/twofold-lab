import { describe, expect, it } from "vitest";

import { validateAcceptedTargetSubmission } from "./accepted-target-submission";

const DECISION = "40000000-0000-4000-8000-000000000001";
const SUBMISSION = "50000000-0000-4000-8000-000000000001";

function row(overrides: Record<string, unknown> = {}) {
  return {
    submission_id: SUBMISSION,
    decision_id: DECISION,
    targets: [
      { symbol: "LULU", target_weight_bps: "600", rationale: "Retain a small existing position." },
      { symbol: "MSFT", target_weight_bps: "8900", rationale: "Liquid momentum exposure." },
    ],
    cash_weight_bps: "500",
    decision_summary: "Two-position target with the required cash buffer.",
    submission_sha256: "a".repeat(64),
    accepted_at: "2026-08-29T21:31:13.222+00:00",
    ...overrides,
  };
}

describe("accepted target submission dashboard contract", () => {
  it("normalizes the exact accepted portfolio row for display", () => {
    expect(validateAcceptedTargetSubmission(row(), DECISION, SUBMISSION)).toEqual({
      ok: true,
      value: {
        submissionId: SUBMISSION,
        decisionId: DECISION,
        targets: [
          { symbol: "LULU", targetWeightBps: "600", rationale: "Retain a small existing position." },
          { symbol: "MSFT", targetWeightBps: "8900", rationale: "Liquid momentum exposure." },
        ],
        cashWeightBps: "500",
        decisionSummary: "Two-position target with the required cash buffer.",
        submissionSha256: "a".repeat(64),
        acceptedAt: "2026-08-29T21:31:13.222Z",
      },
    });
  });

  it("accepts every portfolio shape admitted by the database contract", () => {
    expect(validateAcceptedTargetSubmission(row({
      targets: [],
      cash_weight_bps: "10000",
      decision_summary: "Hold cash while no instrument clears the policy gate.",
    }), DECISION, SUBMISSION)).toMatchObject({
      ok: true,
      value: { targets: [], cashWeightBps: "10000" },
    });

    expect(validateAcceptedTargetSubmission(row({
      targets: [
        { symbol: "ABCDEFGHIJKLMNO", target_weight_bps: "9500" },
      ],
    }), DECISION, SUBMISSION)).toMatchObject({
      ok: true,
      value: {
        targets: [
          { symbol: "ABCDEFGHIJKLMNO", targetWeightBps: "9500" },
        ],
      },
    });
  });

  it("fails closed on identity mismatch, duplicate symbols, or weight drift", () => {
    const result = validateAcceptedTargetSubmission(row({
      decision_id: "40000000-0000-4000-8000-000000000002",
      targets: [
        { symbol: "LULU", target_weight_bps: "600", rationale: "One." },
        { symbol: "LULU", target_weight_bps: "8000", rationale: "Duplicate." },
      ],
    }), DECISION, SUBMISSION);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toMatch(
      /decision_id.*不一致[\s\S]*重复[\s\S]*权重.*10000/,
    );
  });
});
