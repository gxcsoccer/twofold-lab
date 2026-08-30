import { describe, expect, it, vi } from "vitest";

import {
  createPortfolioDecisionEvidence,
  createPortfolioReplayOutcome,
} from "@twofold/core";

import {
  runLocalEvolutionExperiment,
  type EvolutionExperimentStore,
  type LocalEvolutionExperimentPlan,
} from "../src/evolution-local-experiment.js";

const plan = Object.freeze({
  spec: {
    schema: "twofold.evolution_experiment_spec/v1",
    experimentId: "982437ce-99f5-58f7-82bf-79a72d9d23c1",
    experimentCode: "runtime-surface-scaling-replay-v1",
    mode: "LOCAL_REPLAY",
    hypothesis: "Scaling the runtime budget with the frozen universe lowers terminal failures.",
    sourceFindingSha256s: ["c6e9109e2c85a5704d368fa5cbc781a50f71eaabe74b07d1ab29c03bf4d0f49a"],
    changeSurface: "RUNTIME_BUDGET",
    baselineRef: "seasons:s2+s3",
    treatmentRef: "season:s4",
    primaryMetric: {
      metricKey: "agent.decision.terminal_failure_rate",
      direction: "LOWER_IS_BETTER",
      minimumAbsoluteImprovement: "0.1",
    },
    guardrails: [{
      metricKey: "platform.model.estimated_cost_usd_per_decision",
      direction: "LOWER_IS_BETTER",
      maximumRegression: "0.01",
    }],
    onlineShadow: null,
    expiresAt: "2026-09-30T00:00:00.000Z",
  },
  proposedAt: "2026-08-30T05:00:00.000Z",
  scheduledAt: "2026-08-30T05:01:00.000Z",
  startedAt: "2026-08-30T05:02:00.000Z",
  completedAt: "2026-08-30T05:03:00.000Z",
  actorId: "twofold:evolution-local-replay",
  trialCode: "runtime-surface-scaling-replay-v1:trial-1",
  inputEvidence: {
    schema: "twofold.evolution_trial_evidence/v1",
    design: "TEMPORAL_HOLDOUT_REPLAY",
    expectedOutcome: "Lower terminal failure rate without more than USD 0.01 extra cost per decision.",
    sealedEvidenceRefs: ["season:s2", "season:s3", "season:s4"],
    marketRegimes: ["2026-08-29-us-close"],
  },
  evaluation: {
    baselineValue: "0.5",
    treatmentValue: "0",
    guardrails: [{
      metricKey: "platform.model.estimated_cost_usd_per_decision",
      baselineValue: "0.032217933",
      treatmentValue: "0.03967249",
    }],
  },
} as const) satisfies LocalEvolutionExperimentPlan;

function store(): EvolutionExperimentStore {
  return {
    propose: vi.fn(async () => undefined),
    transition: vi.fn(async () => undefined),
    registerTrial: vi.fn(async () => "c136f417-4bd4-53e1-9b0c-fadd18628e8d"),
    registerDecisionComparison: vi.fn(async () => undefined),
    registerDecisionEvaluation: vi.fn(async () => undefined),
    completeTrial: vi.fn(async () => undefined),
  };
}

describe("local evolution experiment", () => {
  it("preregisters, runs and preserves the result without promoting it", async () => {
    const repository = store();
    const result = await runLocalEvolutionExperiment(repository, plan);

    expect(result.result.recommendation).toBe("PROMOTE_CANDIDATE");
    expect(result.result.primaryImprovement).toBe("0.5");
    expect(result.state.status).toBe("COMPLETED");
    expect(repository.propose).toHaveBeenCalledOnce();
    expect(repository.registerTrial).toHaveBeenCalledWith(expect.objectContaining({
      rankingScope: "LOCAL",
      inputEvidence: plan.inputEvidence,
    }));
    expect(repository.completeTrial).toHaveBeenCalledWith(expect.objectContaining({
      result: result.result,
    }));
    expect(repository.transition).toHaveBeenCalledTimes(3);
    expect(repository.transition).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "PROMOTE",
    }));
  });

  it("evaluates and records an official-versus-candidate replay inside the local trial", async () => {
    const repository = store();
    const evidenceSnapshotId = "60000000-0000-4000-8000-000000000001";
    const portfolio = (
      decisionRef: string,
      policyRef: string,
      lulu: string,
    ) => createPortfolioDecisionEvidence({
      decisionRef,
      policyRef,
      evidenceSnapshotId,
      targets: [
        { symbol: "LULU", targetWeightBps: lulu },
        { symbol: "SPY", targetWeightBps: String(9000n - BigInt(lulu)) },
      ],
      cashWeightBps: "1000",
    });
    const portfolioSpec = {
      ...plan.spec,
      experimentId: "982437ce-99f5-58f7-82bf-79a72d9d23c9",
      experimentCode: "portfolio-policy-replay-v1",
      changeSurface: "PORTFOLIO_POLICY",
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
    } as const;
    const official = portfolio("official:round-7", "official-v1", "4500");
    const candidate = portfolio("candidate:round-7", "candidate-v2", "5000");
    const replay = (
      decisionSha256: string,
      terminalNav: string,
      turnoverBps: string,
    ) => createPortfolioReplayOutcome({
      evidenceSnapshotId,
      decisionSha256,
      replayPolicyRef: "arena-replay/v1",
      replayInputSha256: "b".repeat(64),
      navCurrency: "USD",
      metrics: {
        constraintViolationCount: "0",
        turnoverBps,
        simulatedSlippageNavCost: "5",
        simulatedFeeNavCost: "3",
        simulatedTaxNavCost: "2",
        terminalNav,
        maxDrawdownBps: "200",
        terminalFailureCount: "0",
      },
    });
    const { evaluation: _legacyEvaluation, ...planWithoutEvaluation } = plan;
    const comparedPlan = {
      ...planWithoutEvaluation,
      spec: portfolioSpec,
      decisionComparison: {
        official,
        candidate,
        officialOutcome: replay(official.decisionSha256, "1000", "600"),
        candidateOutcome: replay(candidate.decisionSha256, "1020", "650"),
      },
    } satisfies LocalEvolutionExperimentPlan;

    const completed = await runLocalEvolutionExperiment(repository, comparedPlan);

    expect(completed.result.recommendation).toBe("PROMOTE_CANDIDATE");
    expect(repository.registerDecisionComparison).toHaveBeenCalledWith(
      expect.objectContaining({
        experimentId: portfolioSpec.experimentId,
        trialId: "c136f417-4bd4-53e1-9b0c-fadd18628e8d",
        recordedBy: plan.actorId,
        comparison: expect.objectContaining({
          evidenceSnapshotId,
          maxAbsoluteDeltaBps: "500",
          turnoverBps: "500",
        }),
      }),
    );
    expect(repository.registerDecisionEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        experimentId: portfolioSpec.experimentId,
        trialId: "c136f417-4bd4-53e1-9b0c-fadd18628e8d",
        recordedBy: plan.actorId,
        evaluation: expect.objectContaining({
          comparisonSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          decisionDeltaTurnoverBps: "500",
          result: expect.objectContaining({ recommendation: "PROMOTE_CANDIDATE" }),
        }),
      }),
    );
    expect(repository.transition).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "PROMOTE",
    }));
  });

  it("rejects a cross-snapshot comparison before any experiment write", async () => {
    const repository = store();
    const portfolio = (
      snapshot: string,
      decisionRef: string,
    ) => createPortfolioDecisionEvidence({
      decisionRef,
      policyRef: "candidate-v1",
      evidenceSnapshotId: snapshot,
      targets: [{ symbol: "LULU", targetWeightBps: "9000" }],
      cashWeightBps: "1000",
    });
    const { evaluation: _legacyEvaluation, ...planWithoutEvaluation } = plan;
    const invalidPlan = {
      ...planWithoutEvaluation,
      decisionComparison: {
        official: portfolio(
          "60000000-0000-4000-8000-000000000001",
          "official:round-7",
        ),
        candidate: portfolio(
          "60000000-0000-4000-8000-000000000002",
          "candidate:round-7",
        ),
        officialOutcome: {} as never,
        candidateOutcome: {} as never,
      },
    } satisfies LocalEvolutionExperimentPlan;

    await expect(runLocalEvolutionExperiment(repository, invalidPlan))
      .rejects.toThrow("same evidence snapshot");
    expect(repository.propose).not.toHaveBeenCalled();
    expect(repository.registerTrial).not.toHaveBeenCalled();
  });
});
