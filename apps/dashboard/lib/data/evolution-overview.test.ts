import { describe, expect, it } from "vitest";

import { buildEvolutionOverview } from "./evolution-overview.js";

describe("evolution overview", () => {
  it("keeps official and experimental ranking scopes explicit", () => {
    const overview = buildEvolutionOverview({
      cycles: [{
        cycle_id: "cycle-1", window_started_at: "2026-08-29T18:00:00.000Z",
        window_ended_at: "2026-08-30T00:00:00.000Z", status: "SUCCEEDED",
        report_sha256: "a".repeat(64), analysis_report: { findings: [{}, {}] },
      }],
      findings: [{
        finding_sha256: "b".repeat(64), finding: {
          severity: "HIGH", scope: "AGENT", subject: "twofold-orchestrator",
          title: "Runtime failure", lesson: "Scale budget with surface.",
          observedValue: "0.75", threshold: "0.1",
        },
      }],
      experiments: [{
        experiment_id: "experiment-1", experiment_code: "runtime-replay",
        mode: "LOCAL_REPLAY", status: "COMPLETED", ranking_scope: null,
        human_approved_at: null, result: { recommendation: "PROMOTE_CANDIDATE" },
        updated_at: "2026-08-30T05:03:00.000Z",
      }],
      trials: [{
        trial_id: "trial-1", experiment_id: "experiment-1",
        trial_code: "runtime-replay:trial-1", mode: "LOCAL_REPLAY",
        ranking_scope: "LOCAL", season_id: null, round_id: null,
      }],
      decisionEvaluations: [{
        evaluation_sha256: "c".repeat(64),
        experiment_id: "experiment-1",
        evidence_snapshot_id: "snapshot-1",
        comparison_sha256: "d".repeat(64),
        evaluation: {
          decisionDeltaTurnoverBps: "500",
          officialOutcome: {
            navCurrency: "USD",
            metrics: {
              constraintViolationCount: "0", turnoverBps: "600",
              simulatedSlippageNavCost: "5", simulatedFeeNavCost: "3",
              simulatedTaxNavCost: "2", terminalNav: "1000",
              maxDrawdownBps: "200", terminalFailureCount: "0",
            },
          },
          candidateOutcome: {
            navCurrency: "USD",
            metrics: {
              constraintViolationCount: "0", turnoverBps: "650",
              simulatedSlippageNavCost: "5.5", simulatedFeeNavCost: "3.5",
              simulatedTaxNavCost: "2.5", terminalNav: "1020",
              maxDrawdownBps: "210", terminalFailureCount: "0",
            },
          },
          result: { recommendation: "PROMOTE_CANDIDATE" },
        },
        recorded_at: "2026-08-30T05:02:30.000Z",
      }],
    });

    expect(overview.cycleCount).toBe("1");
    expect(overview.findingCount).toBe("1");
    expect(overview.experiments[0]).toMatchObject({
      recommendation: "PROMOTE_CANDIDATE",
      rankingScope: null,
      trialScope: "LOCAL",
    });
    expect(overview.portfolioReplayCount).toBe("1");
    expect(overview.decisionEvaluations[0]).toMatchObject({
      experimentId: "experiment-1",
      decisionDeltaTurnoverBps: "500",
      navCurrency: "USD",
      official: { terminalNav: "1000", terminalFailureCount: "0" },
      candidate: { terminalNav: "1020", terminalFailureCount: "0" },
      recommendation: "PROMOTE_CANDIDATE",
    });
  });

  it("rejects a shadow trial that claims official ranking", () => {
    expect(() => buildEvolutionOverview({
      cycles: [], findings: [], experiments: [], decisionEvaluations: [],
      trials: [{
        trial_id: "trial-1", experiment_id: "experiment-1",
        trial_code: "bad", mode: "ONLINE_SHADOW",
        ranking_scope: "OFFICIAL", season_id: "season", round_id: "round",
      }],
    })).toThrow(/ranking scope/);
  });
});
