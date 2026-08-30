import { describe, expect, it } from "vitest";

import {
  createPortfolioDecisionEvidence,
  createPortfolioReplayOutcome,
  evaluatePortfolioDecisionExperiment,
  type EvolutionExperimentSpec,
} from "../src/index.js";

const evidenceSnapshotId = "60000000-0000-4000-8000-000000000001";

const officialDecision = createPortfolioDecisionEvidence({
  decisionRef: "official:round-7",
  policyRef: "official-v1",
  evidenceSnapshotId,
  targets: [
    { symbol: "LULU", targetWeightBps: "4500" },
    { symbol: "SPY", targetWeightBps: "4500" },
  ],
  cashWeightBps: "1000",
});

const candidateDecision = createPortfolioDecisionEvidence({
  decisionRef: "candidate:round-7",
  policyRef: "candidate-v2",
  evidenceSnapshotId,
  targets: [
    { symbol: "LULU", targetWeightBps: "5000" },
    { symbol: "SPY", targetWeightBps: "4000" },
  ],
  cashWeightBps: "1000",
});

function spec(overrides: Partial<EvolutionExperimentSpec> = {}): EvolutionExperimentSpec {
  return {
    schema: "twofold.evolution_experiment_spec/v1",
    experimentId: "10000000-0000-5000-8000-000000000009",
    experimentCode: "portfolio-policy-replay-v1",
    mode: "LOCAL_REPLAY",
    hypothesis: "The candidate improves terminal NAV without weakening portfolio constraints.",
    sourceFindingSha256s: ["a".repeat(64)],
    changeSurface: "PORTFOLIO_POLICY",
    baselineRef: "policy:official-v1",
    treatmentRef: "policy:candidate-v2",
    primaryMetric: {
      metricKey: "portfolio.terminal_nav",
      direction: "HIGHER_IS_BETTER",
      minimumAbsoluteImprovement: "10",
    },
    guardrails: [
      {
        metricKey: "portfolio.constraint_violation_count",
        direction: "LOWER_IS_BETTER",
        maximumRegression: "0",
        candidateMaximum: "0",
      },
      {
        metricKey: "portfolio.turnover_bps",
        direction: "LOWER_IS_BETTER",
        maximumRegression: "100",
      },
      {
        metricKey: "portfolio.simulated_slippage_nav_cost",
        direction: "LOWER_IS_BETTER",
        maximumRegression: "2",
      },
      {
        metricKey: "portfolio.simulated_fee_nav_cost",
        direction: "LOWER_IS_BETTER",
        maximumRegression: "2",
      },
      {
        metricKey: "portfolio.simulated_tax_nav_cost",
        direction: "LOWER_IS_BETTER",
        maximumRegression: "2",
      },
      {
        metricKey: "portfolio.max_drawdown_bps",
        direction: "LOWER_IS_BETTER",
        maximumRegression: "25",
      },
      {
        metricKey: "portfolio.terminal_failure_count",
        direction: "LOWER_IS_BETTER",
        maximumRegression: "0",
        candidateMaximum: "0",
      },
    ],
    onlineShadow: null,
    expiresAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

function outcome(
  role: "official" | "candidate",
  overrides: Partial<Parameters<typeof createPortfolioReplayOutcome>[0]["metrics"]> = {},
) {
  const decision = role === "official" ? officialDecision : candidateDecision;
  return createPortfolioReplayOutcome({
    evidenceSnapshotId,
    decisionSha256: decision.decisionSha256,
    replayPolicyRef: "arena-replay/v1",
    replayInputSha256: "b".repeat(64),
    navCurrency: "USD",
    metrics: {
      constraintViolationCount: "0",
      turnoverBps: role === "official" ? "600" : "650",
      simulatedSlippageNavCost: role === "official" ? "5" : "5.5",
      simulatedFeeNavCost: role === "official" ? "3" : "3.5",
      simulatedTaxNavCost: role === "official" ? "2" : "2.5",
      terminalNav: role === "official" ? "1000" : "1020",
      maxDrawdownBps: role === "official" ? "200" : "210",
      terminalFailureCount: "0",
      ...overrides,
    },
  });
}

describe("portfolio decision evolution evaluation", () => {
  it("binds the same-snapshot diff to all replay metrics and only recommends promotion", () => {
    const evaluation = evaluatePortfolioDecisionExperiment({
      spec: spec(),
      officialDecision,
      candidateDecision,
      officialOutcome: outcome("official"),
      candidateOutcome: outcome("candidate"),
    });

    expect(evaluation).toMatchObject({
      schema: "twofold.portfolio_decision_evolution_evaluation/v1",
      evidenceSnapshotId,
      decisionDeltaTurnoverBps: "500",
      result: {
        recommendation: "PROMOTE_CANDIDATE",
        baselineValue: "1000",
        treatmentValue: "1020",
      },
    });
    expect(evaluation.result.guardrails.map((item) => item.metricKey)).toEqual([
      "portfolio.constraint_violation_count",
      "portfolio.turnover_bps",
      "portfolio.simulated_slippage_nav_cost",
      "portfolio.simulated_fee_nav_cost",
      "portfolio.simulated_tax_nav_cost",
      "portfolio.max_drawdown_bps",
      "portfolio.terminal_failure_count",
    ]);
    expect(evaluation.evaluationSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(evaluation)).not.toMatch(
      /"(?:turnoverBps|terminalNav|candidateMaximum)":\d/,
    );
  });

  it("rejects a candidate that has any hard constraint or terminal failure", () => {
    const evaluation = evaluatePortfolioDecisionExperiment({
      spec: spec(),
      officialDecision,
      candidateDecision,
      officialOutcome: outcome("official"),
      candidateOutcome: outcome("candidate", {
        constraintViolationCount: "1",
        terminalFailureCount: "1",
      }),
    });

    expect(evaluation.result.recommendation).toBe("REJECT");
    expect(evaluation.result.guardrails.filter((item) => !item.passed)).toMatchObject([
      { metricKey: "portfolio.constraint_violation_count", candidateMaximum: "0" },
      { metricKey: "portfolio.terminal_failure_count", candidateMaximum: "0" },
    ]);
  });

  it("fails closed on cross-snapshot outcomes, substituted decisions or incomplete metrics", () => {
    const wrongSnapshotOutcome = createPortfolioReplayOutcome({
      evidenceSnapshotId: "60000000-0000-4000-8000-000000000002",
      decisionSha256: candidateDecision.decisionSha256,
      replayPolicyRef: "arena-replay/v1",
      replayInputSha256: "b".repeat(64),
      navCurrency: "USD",
      metrics: outcome("candidate").metrics,
    });
    expect(() => evaluatePortfolioDecisionExperiment({
      spec: spec(),
      officialDecision,
      candidateDecision,
      officialOutcome: outcome("official"),
      candidateOutcome: wrongSnapshotOutcome,
    })).toThrow(/snapshot/);

    expect(() => evaluatePortfolioDecisionExperiment({
      spec: spec({
        guardrails: spec().guardrails.filter(
          (item) => item.metricKey !== "portfolio.simulated_tax_nav_cost",
        ),
      }),
      officialDecision,
      candidateDecision,
      officialOutcome: outcome("official"),
      candidateOutcome: outcome("candidate"),
    })).toThrow(/required portfolio guardrail/);
  });
});
