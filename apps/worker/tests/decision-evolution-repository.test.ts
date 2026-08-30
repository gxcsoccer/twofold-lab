import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createPortfolioDecisionEvidence,
  createPortfolioReplayOutcome,
  evaluatePortfolioDecisionExperiment,
  type EvolutionExperimentSpec,
} from "@twofold/core";

import {
  buildDecisionEvolutionRegistration,
  registerDecisionEvolutionEvaluation,
} from "../src/decision-evolution-repository.js";

const snapshot = "60000000-0000-4000-8000-000000000001";
const official = createPortfolioDecisionEvidence({
  decisionRef: "official",
  policyRef: "official-v1",
  evidenceSnapshotId: snapshot,
  targets: [{ symbol: "LULU", targetWeightBps: "9000" }],
  cashWeightBps: "1000",
});
const candidate = createPortfolioDecisionEvidence({
  decisionRef: "candidate",
  policyRef: "candidate-v2",
  evidenceSnapshotId: snapshot,
  targets: [{ symbol: "LULU", targetWeightBps: "8500" }],
  cashWeightBps: "1500",
});
const guardrails = [
  ["portfolio.constraint_violation_count", "0", "0"],
  ["portfolio.turnover_bps", "100", undefined],
  ["portfolio.simulated_slippage_nav_cost", "2", undefined],
  ["portfolio.simulated_fee_nav_cost", "2", undefined],
  ["portfolio.simulated_tax_nav_cost", "2", undefined],
  ["portfolio.max_drawdown_bps", "25", undefined],
  ["portfolio.terminal_failure_count", "0", "0"],
].map(([metricKey, maximumRegression, candidateMaximum]) => ({
  metricKey: metricKey!,
  direction: "LOWER_IS_BETTER" as const,
  maximumRegression: maximumRegression!,
  ...(candidateMaximum === undefined ? {} : { candidateMaximum }),
}));
const spec = {
  schema: "twofold.evolution_experiment_spec/v1",
  experimentId: "10000000-0000-5000-8000-000000000009",
  experimentCode: "portfolio-policy-replay-v1",
  mode: "LOCAL_REPLAY",
  hypothesis: "Candidate improves NAV without weakening constraints.",
  sourceFindingSha256s: ["a".repeat(64)],
  changeSurface: "PORTFOLIO_POLICY",
  baselineRef: "official",
  treatmentRef: "candidate",
  primaryMetric: {
    metricKey: "portfolio.terminal_nav",
    direction: "HIGHER_IS_BETTER",
    minimumAbsoluteImprovement: "1",
  },
  guardrails,
  onlineShadow: null,
  expiresAt: "2026-09-30T00:00:00.000Z",
} satisfies EvolutionExperimentSpec;

function outcome(decisionSha256: string, terminalNav: string) {
  return createPortfolioReplayOutcome({
    evidenceSnapshotId: snapshot,
    decisionSha256,
    replayPolicyRef: "arena-replay/v1",
    replayInputSha256: "b".repeat(64),
    navCurrency: "USD",
    metrics: {
      constraintViolationCount: "0",
      turnoverBps: "500",
      simulatedSlippageNavCost: "5",
      simulatedFeeNavCost: "3",
      simulatedTaxNavCost: "2",
      terminalNav,
      maxDrawdownBps: "200",
      terminalFailureCount: "0",
    },
  });
}

const evaluation = evaluatePortfolioDecisionExperiment({
  spec,
  officialDecision: official,
  candidateDecision: candidate,
  officialOutcome: outcome(official.decisionSha256, "1000"),
  candidateOutcome: outcome(candidate.decisionSha256, "1010"),
});

describe("decision evolution evaluation repository", () => {
  it("freezes exact bytes and verifies the persisted receipt", async () => {
    const experimentId = spec.experimentId;
    const trialId = "c136f417-4bd4-53e1-9b0c-fadd18628e8d";
    const registration = buildDecisionEvolutionRegistration({
      evaluation,
      experimentId,
      trialId,
      recordedBy: "twofold:evolution-local-replay",
    });
    expect(createHash("sha256").update(registration.evaluationCanonicalJson).digest("hex"))
      .toBe(registration.artifactSha256);
    const rpc = vi.fn(async () => ({
      data: {
        evaluationSha256: evaluation.evaluationSha256,
        artifactSha256: registration.artifactSha256,
        comparisonSha256: evaluation.comparisonSha256,
        resultSha256: evaluation.result.resultSha256,
      },
      error: null,
      status: 200,
    }));

    await expect(registerDecisionEvolutionEvaluation({ rpc }, registration))
      .resolves.toMatchObject({ evaluationSha256: evaluation.evaluationSha256 });
    expect(rpc).toHaveBeenCalledWith(
      "register_decision_evolution_evaluation",
      registration.rpcArguments,
    );
  });

  it("rejects a receipt whose immutable identity changed", async () => {
    const registration = buildDecisionEvolutionRegistration({
      evaluation,
      experimentId: spec.experimentId,
      trialId: "c136f417-4bd4-53e1-9b0c-fadd18628e8d",
      recordedBy: "twofold:evolution-local-replay",
    });
    await expect(registerDecisionEvolutionEvaluation({
      rpc: async () => ({
        data: {
          evaluationSha256: "f".repeat(64),
          artifactSha256: registration.artifactSha256,
          comparisonSha256: evaluation.comparisonSha256,
          resultSha256: evaluation.result.resultSha256,
        },
        error: null,
        status: 200,
      }),
    }, registration)).rejects.toThrow(/different decision evolution identity/);
  });
});
