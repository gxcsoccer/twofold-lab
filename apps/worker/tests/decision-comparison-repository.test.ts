import { describe, expect, it, vi } from "vitest";

import {
  comparePortfolioDecisions,
  createPortfolioDecisionEvidence,
} from "@twofold/core";

import {
  buildDecisionComparisonRegistration,
  registerDecisionComparisonArtifact,
} from "../src/decision-comparison-repository.js";

const snapshotId = "60000000-0000-4000-8000-000000000001";

function portfolio(decisionRef: string, policyRef: string, lulu: string) {
  return createPortfolioDecisionEvidence({
    decisionRef,
    policyRef,
    evidenceSnapshotId: snapshotId,
    targets: [
      { symbol: "LULU", targetWeightBps: lulu },
      { symbol: "SPY", targetWeightBps: String(9000n - BigInt(lulu)) },
    ],
    cashWeightBps: "1000",
  });
}

describe("decision comparison repository", () => {
  it("registers exact content-addressed comparison bytes", async () => {
    const comparison = comparePortfolioDecisions({
      official: portfolio("official:round-7", "official-v1", "4500"),
      candidate: portfolio("candidate:round-7", "candidate-v2", "5000"),
    });
    const registration = buildDecisionComparisonRegistration({
      comparison,
      experimentId: "70000000-0000-4000-8000-000000000001",
      trialId: "71000000-0000-4000-8000-000000000001",
      recordedBy: "twofold:evolution-worker",
    });
    const rpc = vi.fn(async () => ({
      data: {
        comparisonSha256: comparison.comparisonSha256,
        artifactSha256: registration.artifactSha256,
        evidenceSnapshotId: snapshotId,
      },
      error: null,
      status: 200,
    }));

    await expect(registerDecisionComparisonArtifact({ rpc }, registration))
      .resolves.toEqual({
        comparisonSha256: comparison.comparisonSha256,
        artifactSha256: registration.artifactSha256,
        evidenceSnapshotId: snapshotId,
      });
    expect(rpc).toHaveBeenCalledWith(
      "register_decision_comparison_artifact",
      expect.objectContaining({
        p_comparison_sha256: comparison.comparisonSha256,
        p_artifact_sha256: registration.artifactSha256,
        p_evidence_snapshot_id: snapshotId,
        p_official_decision_sha256: comparison.official.decisionSha256,
        p_candidate_decision_sha256: comparison.candidate.decisionSha256,
        p_comparison_canonical_json: registration.comparisonCanonicalJson,
      }),
    );
  });

  it("fails closed when persistence returns a different content identity", async () => {
    const comparison = comparePortfolioDecisions({
      official: portfolio("official:round-7", "official-v1", "4500"),
      candidate: portfolio("candidate:round-7", "candidate-v2", "5000"),
    });
    const registration = buildDecisionComparisonRegistration({
      comparison,
      experimentId: null,
      trialId: null,
      recordedBy: "twofold:evolution-worker",
    });
    const rpc = vi.fn(async () => ({
      data: {
        comparisonSha256: "f".repeat(64),
        artifactSha256: registration.artifactSha256,
        evidenceSnapshotId: snapshotId,
      },
      error: null,
      status: 200,
    }));

    await expect(registerDecisionComparisonArtifact({ rpc }, registration))
      .rejects.toThrow("different decision comparison identity");
  });
});
