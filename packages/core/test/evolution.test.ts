import { describe, expect, it } from "vitest";

import {
  analyzeEvolutionWindow,
  evaluateEvolutionExperiment,
  transitionEvolutionExperiment,
  type EvolutionAnalysisRule,
  type EvolutionExperimentSpec,
  type EvolutionMetricObservation,
} from "../src/evolution.js";

const observations: readonly EvolutionMetricObservation[] = [
  {
    metricKey: "agent.decision.terminal_failure_rate",
    scope: "AGENT",
    subject: "twofold-orchestrator",
    value: "0.25",
    unit: "RATIO",
    sampleCount: "4",
    evidenceRefs: ["run:94b61a35-fc0f-5f8f-8a33-6f0ae2aa010d"],
  },
  {
    metricKey: "platform.tick.failure_rate",
    scope: "PLATFORM",
    subject: "twofold-vercel-arena",
    value: "0",
    unit: "RATIO",
    sampleCount: "60",
    evidenceRefs: ["tick-window:2026-08-29T20:00:00.000Z"],
  },
];

const rules: readonly EvolutionAnalysisRule[] = [
  {
    ruleId: "agent-terminal-failure-pressure",
    metricKey: "agent.decision.terminal_failure_rate",
    operator: "GTE",
    threshold: "0.1",
    severity: "HIGH",
    title: "Agent terminal failures exceed the learning threshold",
    diagnosis: "The current decision surface exceeds one or more runtime limits.",
    lesson: "Budget must scale with the immutable decision surface, not with one demo size.",
    proposedExperimentMode: "LOCAL_REPLAY",
    proposedChangeSurface: "RUNTIME_BUDGET",
  },
  {
    ruleId: "platform-tick-instability",
    metricKey: "platform.tick.failure_rate",
    operator: "GT",
    threshold: "0",
    severity: "CRITICAL",
    title: "Worker ticks are failing",
    diagnosis: "At least one scheduled platform tick failed.",
    lesson: "Production evolution must stop when its collector is unhealthy.",
    proposedExperimentMode: "LOCAL_REPLAY",
    proposedChangeSurface: "PLATFORM_RUNTIME",
  },
];

describe("evolution analysis", () => {
  it("turns metric evidence into deterministic experience findings", () => {
    const report = analyzeEvolutionWindow({
      windowStartedAt: "2026-08-29T20:00:00.000Z",
      windowEndedAt: "2026-08-29T21:00:00.000Z",
      observations,
      rules,
      analyzerVersion: "evolution-rules/v1",
    });

    expect(report.schema).toBe("twofold.evolution_analysis/v1");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      ruleId: "agent-terminal-failure-pressure",
      metricKey: "agent.decision.terminal_failure_rate",
      observedValue: "0.25",
      threshold: "0.1",
      severity: "HIGH",
      proposedExperimentMode: "LOCAL_REPLAY",
    });
    expect(report.findings[0]?.findingSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(report)).not.toMatch(/"(?:value|threshold|sampleCount)":\d/);
  });

  it("rejects a future observation window or duplicate rule identity", () => {
    expect(() => analyzeEvolutionWindow({
      windowStartedAt: "2026-08-29T21:00:00.000Z",
      windowEndedAt: "2026-08-29T20:00:00.000Z",
      observations,
      rules: [rules[0]!, rules[0]!],
      analyzerVersion: "evolution-rules/v1",
    })).toThrow(/window/);
  });
});

function onlineSpec(): EvolutionExperimentSpec {
  return {
    schema: "twofold.evolution_experiment_spec/v1",
    experimentId: "10000000-0000-5000-8000-000000000001",
    experimentCode: "budget-surface-shadow-v1",
    mode: "ONLINE_SHADOW",
    hypothesis: "A decision-surface budget lowers terminal failures without violating cost.",
    sourceFindingSha256s: ["a".repeat(64)],
    changeSurface: "RUNTIME_BUDGET",
    baselineRef: "bundle:twofold-orchestrator@0.1.0",
    treatmentRef: "bundle:twofold-orchestrator-budget-v2@0.1.0",
    primaryMetric: {
      metricKey: "agent.decision.terminal_failure_rate",
      direction: "LOWER_IS_BETTER",
      minimumAbsoluteImprovement: "0.1",
    },
    guardrails: [{
      metricKey: "model.estimated_cost_usd",
      direction: "LOWER_IS_BETTER",
      maximumRegression: "0.1",
    }],
    onlineShadow: {
      seasonId: "20000000-0000-5000-8000-000000000001",
      startsAtRoundIndex: "2",
      maximumRounds: "2",
      rankingScope: "SHADOW",
    },
    expiresAt: "2026-09-30T00:00:00.000Z",
  };
}

describe("evolution experiment lifecycle", () => {
  it("requires human approval before an online shadow trial can be scheduled", () => {
    const proposed = transitionEvolutionExperiment(null, {
      type: "PROPOSE",
      spec: onlineSpec(),
      actor: { kind: "model", id: "evolution-analyst" },
      at: "2026-08-30T00:00:00.000Z",
    });
    expect(proposed.status).toBe("PROPOSED");
    expect(() => transitionEvolutionExperiment(proposed, {
      type: "SCHEDULE",
      actor: { kind: "worker", id: "evolution-worker" },
      at: "2026-08-30T00:01:00.000Z",
    })).toThrow(/human approval/);

    const approved = transitionEvolutionExperiment(proposed, {
      type: "APPROVE",
      actor: { kind: "human", id: "owner" },
      at: "2026-08-30T00:02:00.000Z",
    });
    const scheduled = transitionEvolutionExperiment(approved, {
      type: "SCHEDULE",
      actor: { kind: "worker", id: "evolution-worker" },
      at: "2026-08-30T00:03:00.000Z",
    });
    expect(scheduled).toMatchObject({ status: "SCHEDULED", rankingScope: "SHADOW" });
  });

  it("allows bounded local replay automatically but never auto-promotes", () => {
    const local: EvolutionExperimentSpec = {
      ...onlineSpec(),
      experimentId: "10000000-0000-5000-8000-000000000002",
      experimentCode: "budget-surface-local-v1",
      mode: "LOCAL_REPLAY",
      onlineShadow: null,
    };
    const proposed = transitionEvolutionExperiment(null, {
      type: "PROPOSE",
      spec: local,
      actor: { kind: "model", id: "evolution-analyst" },
      at: "2026-08-30T00:00:00.000Z",
    });
    const scheduled = transitionEvolutionExperiment(proposed, {
      type: "SCHEDULE",
      actor: { kind: "worker", id: "evolution-worker" },
      at: "2026-08-30T00:01:00.000Z",
    });
    const running = transitionEvolutionExperiment(scheduled, {
      type: "START",
      actor: { kind: "worker", id: "evolution-worker" },
      at: "2026-08-30T00:02:00.000Z",
    });
    const result = evaluateEvolutionExperiment(local, {
      baselineValue: "0.25",
      treatmentValue: "0",
      guardrails: [{
        metricKey: "model.estimated_cost_usd",
        baselineValue: "0.05",
        treatmentValue: "0.06",
      }],
    });
    expect(result.recommendation).toBe("PROMOTE_CANDIDATE");
    const completed = transitionEvolutionExperiment(running, {
      type: "COMPLETE",
      result,
      actor: { kind: "worker", id: "evolution-worker" },
      at: "2026-08-30T00:03:00.000Z",
    });
    expect(completed.status).toBe("COMPLETED");
    expect(() => transitionEvolutionExperiment(completed, {
      type: "PROMOTE",
      actor: { kind: "model", id: "evolution-analyst" },
      at: "2026-08-30T00:04:00.000Z",
    })).toThrow(/human/);
    expect(transitionEvolutionExperiment(completed, {
      type: "PROMOTE",
      actor: { kind: "human", id: "owner" },
      at: "2026-08-30T00:05:00.000Z",
    }).status).toBe("PROMOTED");
  });

  it("supports an absolute candidate ceiling in addition to relative regression", () => {
    const local: EvolutionExperimentSpec = {
      ...onlineSpec(),
      experimentId: "10000000-0000-5000-8000-000000000003",
      experimentCode: "hard-candidate-ceiling-v1",
      mode: "LOCAL_REPLAY",
      onlineShadow: null,
      guardrails: [{
        metricKey: "portfolio.constraint_violation_count",
        direction: "LOWER_IS_BETTER",
        maximumRegression: "0",
        candidateMaximum: "0",
      }],
    };

    const result = evaluateEvolutionExperiment(local, {
      baselineValue: "0.25",
      treatmentValue: "0",
      guardrails: [{
        metricKey: "portfolio.constraint_violation_count",
        baselineValue: "1",
        treatmentValue: "1",
      }],
    });

    expect(result.recommendation).toBe("REJECT");
    expect(result.guardrails[0]).toMatchObject({
      regression: "0",
      candidateMaximum: "0",
      candidateMaximumPassed: false,
      passed: false,
    });
  });

  it("rejects an online experiment that can affect official ranking", () => {
    expect(() => transitionEvolutionExperiment(null, {
      type: "PROPOSE",
      spec: {
        ...onlineSpec(),
        onlineShadow: { ...onlineSpec().onlineShadow!, rankingScope: "OFFICIAL" as never },
      },
      actor: { kind: "human", id: "owner" },
      at: "2026-08-30T00:00:00.000Z",
    })).toThrow(/SHADOW/);
  });
});
