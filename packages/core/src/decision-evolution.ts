import { createHash } from "node:crypto";

import { canonicalFinancialJson } from "./canonical-json.js";
import {
  comparePortfolioDecisions,
  type PortfolioDecisionEvidence,
} from "./decision-evidence.js";
import {
  evaluateEvolutionExperiment,
  type EvolutionExperimentResult,
  type EvolutionExperimentSpec,
  type EvolutionMetricDirection,
} from "./evolution.js";
import { compareDecimals, normalizeDecimal } from "./fixed-decimal.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const PORTFOLIO_TERMINAL_NAV_METRIC = "portfolio.terminal_nav";

export const PORTFOLIO_REPLAY_GUARDRAIL_METRICS = Object.freeze([
  "portfolio.constraint_violation_count",
  "portfolio.turnover_bps",
  "portfolio.simulated_slippage_nav_cost",
  "portfolio.simulated_fee_nav_cost",
  "portfolio.simulated_tax_nav_cost",
  "portfolio.max_drawdown_bps",
  "portfolio.terminal_failure_count",
] as const);

export type PortfolioReplayGuardrailMetric =
  typeof PORTFOLIO_REPLAY_GUARDRAIL_METRICS[number];

export interface PortfolioReplayMetrics {
  readonly constraintViolationCount: string;
  readonly turnoverBps: string;
  readonly simulatedSlippageNavCost: string;
  readonly simulatedFeeNavCost: string;
  readonly simulatedTaxNavCost: string;
  readonly terminalNav: string;
  readonly maxDrawdownBps: string;
  readonly terminalFailureCount: string;
}

export interface PortfolioReplayOutcome {
  readonly schema: "twofold.portfolio_replay_outcome/v1";
  readonly evidenceSnapshotId: string;
  readonly decisionSha256: string;
  readonly replayPolicyRef: string;
  readonly replayInputSha256: string;
  readonly navCurrency: string;
  readonly metrics: PortfolioReplayMetrics;
  readonly outcomeSha256: string;
}

export interface PortfolioDecisionEvolutionEvaluation {
  readonly schema: "twofold.portfolio_decision_evolution_evaluation/v1";
  readonly experimentId: string;
  readonly evidenceSnapshotId: string;
  readonly comparisonSha256: string;
  readonly decisionDeltaTurnoverBps: string;
  readonly officialOutcome: PortfolioReplayOutcome;
  readonly candidateOutcome: PortfolioReplayOutcome;
  readonly result: EvolutionExperimentResult;
  readonly evaluationSha256: string;
}

export function createPortfolioReplayOutcome(input: {
  readonly evidenceSnapshotId: string;
  readonly decisionSha256: string;
  readonly replayPolicyRef: string;
  readonly replayInputSha256: string;
  readonly navCurrency: string;
  readonly metrics: PortfolioReplayMetrics;
}): PortfolioReplayOutcome {
  const metrics = Object.freeze({
    constraintViolationCount: integer(
      input.metrics.constraintViolationCount,
      "metrics.constraintViolationCount",
    ),
    turnoverBps: nonNegativeDecimal(input.metrics.turnoverBps, "metrics.turnoverBps"),
    simulatedSlippageNavCost: nonNegativeDecimal(
      input.metrics.simulatedSlippageNavCost,
      "metrics.simulatedSlippageNavCost",
    ),
    simulatedFeeNavCost: nonNegativeDecimal(
      input.metrics.simulatedFeeNavCost,
      "metrics.simulatedFeeNavCost",
    ),
    simulatedTaxNavCost: nonNegativeDecimal(
      input.metrics.simulatedTaxNavCost,
      "metrics.simulatedTaxNavCost",
    ),
    terminalNav: nonNegativeDecimal(input.metrics.terminalNav, "metrics.terminalNav"),
    maxDrawdownBps: nonNegativeDecimal(
      input.metrics.maxDrawdownBps,
      "metrics.maxDrawdownBps",
    ),
    terminalFailureCount: integer(
      input.metrics.terminalFailureCount,
      "metrics.terminalFailureCount",
    ),
  });
  const navCurrency = identity(input.navCurrency, "navCurrency");
  if (!CURRENCY_PATTERN.test(navCurrency)) {
    throw new TypeError("navCurrency must be an uppercase ISO-style currency code");
  }
  const decisionSha256 = sha(input.decisionSha256, "decisionSha256");
  const payload = Object.freeze({
    schema: "twofold.portfolio_replay_outcome/v1" as const,
    evidenceSnapshotId: identity(input.evidenceSnapshotId, "evidenceSnapshotId"),
    decisionSha256,
    replayPolicyRef: identity(input.replayPolicyRef, "replayPolicyRef"),
    replayInputSha256: sha(input.replayInputSha256, "replayInputSha256"),
    navCurrency,
    metrics,
  });
  return Object.freeze({
    ...payload,
    outcomeSha256: sha256(canonicalFinancialJson(payload)),
  });
}

export function evaluatePortfolioDecisionExperiment(input: {
  readonly spec: EvolutionExperimentSpec;
  readonly officialDecision: PortfolioDecisionEvidence;
  readonly candidateDecision: PortfolioDecisionEvidence;
  readonly officialOutcome: PortfolioReplayOutcome;
  readonly candidateOutcome: PortfolioReplayOutcome;
}): PortfolioDecisionEvolutionEvaluation {
  const comparison = comparePortfolioDecisions({
    official: input.officialDecision,
    candidate: input.candidateDecision,
  });
  const officialOutcome = assertPortfolioReplayOutcome(input.officialOutcome);
  const candidateOutcome = assertPortfolioReplayOutcome(input.candidateOutcome);
  if (
    officialOutcome.evidenceSnapshotId !== comparison.evidenceSnapshotId
    || candidateOutcome.evidenceSnapshotId !== comparison.evidenceSnapshotId
  ) throw new TypeError("portfolio replay outcomes crossed the comparison snapshot fence");
  if (
    officialOutcome.decisionSha256 !== comparison.official.decisionSha256
    || candidateOutcome.decisionSha256 !== comparison.candidate.decisionSha256
  ) throw new TypeError("portfolio replay outcome substituted a compared decision");
  if (officialOutcome.replayPolicyRef !== candidateOutcome.replayPolicyRef) {
    throw new TypeError("portfolio replay outcomes must use the same replay policy");
  }
  if (officialOutcome.replayInputSha256 !== candidateOutcome.replayInputSha256) {
    throw new TypeError("portfolio replay outcomes must use the same immutable replay input");
  }
  if (officialOutcome.navCurrency !== candidateOutcome.navCurrency) {
    throw new TypeError("portfolio replay outcomes must use the same NAV currency");
  }
  assertPortfolioExperimentSpec(input.spec);

  const result = evaluateEvolutionExperiment(input.spec, {
    baselineValue: officialOutcome.metrics.terminalNav,
    treatmentValue: candidateOutcome.metrics.terminalNav,
    guardrails: PORTFOLIO_REPLAY_GUARDRAIL_METRICS.map((metricKey) => ({
      metricKey,
      baselineValue: metricValue(officialOutcome.metrics, metricKey),
      treatmentValue: metricValue(candidateOutcome.metrics, metricKey),
    })),
  });
  const payload = Object.freeze({
    schema: "twofold.portfolio_decision_evolution_evaluation/v1" as const,
    experimentId: input.spec.experimentId,
    evidenceSnapshotId: comparison.evidenceSnapshotId,
    comparisonSha256: comparison.comparisonSha256,
    decisionDeltaTurnoverBps: comparison.turnoverBps,
    officialOutcome,
    candidateOutcome,
    result,
  });
  return Object.freeze({
    ...payload,
    evaluationSha256: sha256(canonicalFinancialJson(payload)),
  });
}

function assertPortfolioExperimentSpec(spec: EvolutionExperimentSpec): void {
  if (
    spec.mode !== "LOCAL_REPLAY"
    || spec.onlineShadow !== null
    || spec.primaryMetric.metricKey !== PORTFOLIO_TERMINAL_NAV_METRIC
    || spec.primaryMetric.direction !== "HIGHER_IS_BETTER"
  ) {
    throw new TypeError(
      "portfolio decision evaluation requires LOCAL_REPLAY with terminal NAV as its primary metric",
    );
  }
  const guardrails = new Map(spec.guardrails.map((item) => [item.metricKey, item]));
  if (guardrails.size !== PORTFOLIO_REPLAY_GUARDRAIL_METRICS.length) {
    throw new TypeError("portfolio evaluation must contain exactly the required portfolio guardrails");
  }
  for (const metricKey of PORTFOLIO_REPLAY_GUARDRAIL_METRICS) {
    const guardrail = guardrails.get(metricKey);
    if (guardrail === undefined || guardrail.direction !== lowerIsBetter(metricKey)) {
      throw new TypeError(`missing required portfolio guardrail ${metricKey}`);
    }
  }
  for (const hardMetric of [
    "portfolio.constraint_violation_count",
    "portfolio.terminal_failure_count",
  ] as const) {
    if (guardrails.get(hardMetric)?.candidateMaximum !== "0") {
      throw new TypeError(`${hardMetric} must preregister a zero candidateMaximum`);
    }
  }
}

function lowerIsBetter(_metricKey: PortfolioReplayGuardrailMetric): EvolutionMetricDirection {
  return "LOWER_IS_BETTER";
}

function metricValue(
  metrics: PortfolioReplayMetrics,
  metricKey: PortfolioReplayGuardrailMetric,
): string {
  if (metricKey === "portfolio.constraint_violation_count") {
    return metrics.constraintViolationCount;
  }
  if (metricKey === "portfolio.turnover_bps") return metrics.turnoverBps;
  if (metricKey === "portfolio.simulated_slippage_nav_cost") {
    return metrics.simulatedSlippageNavCost;
  }
  if (metricKey === "portfolio.simulated_fee_nav_cost") return metrics.simulatedFeeNavCost;
  if (metricKey === "portfolio.simulated_tax_nav_cost") return metrics.simulatedTaxNavCost;
  if (metricKey === "portfolio.max_drawdown_bps") return metrics.maxDrawdownBps;
  return metrics.terminalFailureCount;
}

function assertPortfolioReplayOutcome(value: PortfolioReplayOutcome): PortfolioReplayOutcome {
  if (value.schema !== "twofold.portfolio_replay_outcome/v1") {
    throw new TypeError("unsupported portfolio replay outcome schema");
  }
  const rebuilt = createPortfolioReplayOutcome({
    evidenceSnapshotId: value.evidenceSnapshotId,
    decisionSha256: value.decisionSha256,
    replayPolicyRef: value.replayPolicyRef,
    replayInputSha256: value.replayInputSha256,
    navCurrency: value.navCurrency,
    metrics: value.metrics,
  });
  if (rebuilt.outcomeSha256 !== value.outcomeSha256) {
    throw new TypeError("portfolio replay outcome fingerprint mismatch");
  }
  return rebuilt;
}

function nonNegativeDecimal(value: string, field: string): string {
  const parsed = normalizeDecimal(value);
  if (compareDecimals(parsed, "0") < 0) {
    throw new TypeError(`${field} must be non-negative`);
  }
  return parsed;
}

function integer(value: string, field: string): string {
  if (!INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
  return value;
}

function identity(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function sha(value: string, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256`);
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
