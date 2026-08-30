import { describe, expect, it } from "vitest";

import {
  comparePortfolioDecisions,
  createDecisionAdmissionEvidence,
  createPortfolioDecisionEvidence,
} from "../src/decision-evidence.js";

const snapshotId = "60000000-0000-4000-8000-000000000001";

function decision(input: {
  decisionRef: string;
  policyRef: string;
  lulu: string;
  spy: string;
  cash: string;
  snapshot?: string;
}) {
  return createPortfolioDecisionEvidence({
    decisionRef: input.decisionRef,
    policyRef: input.policyRef,
    evidenceSnapshotId: input.snapshot ?? snapshotId,
    targets: [
      { symbol: "SPY", targetWeightBps: input.spy },
      { symbol: "LULU", targetWeightBps: input.lulu },
    ],
    cashWeightBps: input.cash,
  });
}

describe("decision evidence", () => {
  it("freezes an ALLOW result with every requested guard observation", () => {
    const portfolio = decision({
      decisionRef: "official:round-7",
      policyRef: "agent-bundle:official-v1",
      lulu: "4500",
      spy: "4500",
      cash: "1000",
    });
    const evidence = createDecisionAdmissionEvidence({
      decision: portfolio,
      observedAt: "2026-08-30T00:10:00.000Z",
      dataCutoffAt: "2026-08-30T00:00:00.000Z",
      evidenceSealedAt: "2026-08-30T00:00:30.000Z",
      marketJumpBps: "375",
      maxTargetDeltaBps: "1800",
      cooldownRemainingMs: "0",
      policy: {
        policyRef: "twofold.arena_submission_admission/v1",
        maxInputAgeMs: "900000",
        maxMarketJumpBps: "500",
        minimumStableWindowMs: "30000",
        maxTargetDeltaBps: "2000",
        maxCooldownRemainingMs: "0",
      },
    });

    expect(evidence.guardAction).toBe("ALLOW");
    expect(evidence.reasons).toEqual(["ALL_GUARDS_PASSED"]);
    expect(evidence.metrics).toEqual({
      inputAgeMs: "600000",
      marketJumpBps: "375",
      stableWindowMs: "570000",
      maxTargetDeltaBps: "1800",
      cooldownRemainingMs: "0",
    });
    expect(evidence.decision.decisionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks deterministically and preserves every failed reason", () => {
    const evidence = createDecisionAdmissionEvidence({
      decision: decision({
        decisionRef: "candidate:round-7",
        policyRef: "candidate-v2",
        lulu: "7000",
        spy: "2000",
        cash: "1000",
      }),
      observedAt: "2026-08-30T00:10:00.000Z",
      dataCutoffAt: "2026-08-30T00:00:00.000Z",
      evidenceSealedAt: "2026-08-30T00:09:50.000Z",
      marketJumpBps: "501",
      maxTargetDeltaBps: "2500",
      cooldownRemainingMs: "1",
      policy: {
        policyRef: "twofold.arena_submission_admission/v1",
        maxInputAgeMs: "599999",
        maxMarketJumpBps: "500",
        minimumStableWindowMs: "30000",
        maxTargetDeltaBps: "2000",
        maxCooldownRemainingMs: "0",
      },
    });

    expect(evidence.guardAction).toBe("BLOCK");
    expect(evidence.reasons).toEqual([
      "INPUT_STALE",
      "MARKET_JUMP_EXCEEDED",
      "STABLE_WINDOW_INSUFFICIENT",
      "TARGET_DELTA_EXCEEDED",
      "COOLDOWN_ACTIVE",
    ]);
  });

  it("creates a content-addressed same-snapshot decision diff", () => {
    const official = decision({
      decisionRef: "official:round-7",
      policyRef: "official-v1",
      lulu: "4500",
      spy: "4500",
      cash: "1000",
    });
    const candidate = decision({
      decisionRef: "candidate:round-7",
      policyRef: "candidate-v2",
      lulu: "5000",
      spy: "3500",
      cash: "1500",
    });

    const comparison = comparePortfolioDecisions({ official, candidate });

    expect(comparison.deltas).toEqual([
      {
        symbol: "LULU",
        officialWeightBps: "4500",
        candidateWeightBps: "5000",
        deltaBps: "500",
      },
      {
        symbol: "SPY",
        officialWeightBps: "4500",
        candidateWeightBps: "3500",
        deltaBps: "-1000",
      },
    ]);
    expect(comparison.cashDeltaBps).toBe("500");
    expect(comparison.maxAbsoluteDeltaBps).toBe("1000");
    expect(comparison.turnoverBps).toBe("1000");
    expect(comparison.identical).toBe(false);
    expect(comparison.comparisonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(comparePortfolioDecisions({ official, candidate }))
      .toEqual(comparison);
  });

  it("refuses to compare decisions from different evidence snapshots", () => {
    const official = decision({
      decisionRef: "official:round-7",
      policyRef: "official-v1",
      lulu: "4500",
      spy: "4500",
      cash: "1000",
    });
    const candidate = decision({
      decisionRef: "candidate:round-8",
      policyRef: "candidate-v2",
      lulu: "5000",
      spy: "3500",
      cash: "1500",
      snapshot: "60000000-0000-4000-8000-000000000002",
    });

    expect(() => comparePortfolioDecisions({ official, candidate }))
      .toThrow("same evidence snapshot");
  });
});
