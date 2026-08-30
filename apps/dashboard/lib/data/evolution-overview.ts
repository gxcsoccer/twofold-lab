export interface EvolutionOverview {
  readonly configured: boolean;
  readonly error: string | null;
  readonly cycleCount: string;
  readonly findingCount: string;
  readonly experimentCount: string;
  readonly portfolioReplayCount: string;
  readonly cycles: ReadonlyArray<{
    cycleId: string;
    windowStartedAt: string;
    windowEndedAt: string;
    status: string;
    findingCount: string;
    reportSha256: string | null;
  }>;
  readonly findings: ReadonlyArray<{
    findingSha256: string;
    severity: string;
    scope: string;
    subject: string;
    title: string;
    lesson: string;
    observedValue: string;
    threshold: string;
  }>;
  readonly experiments: ReadonlyArray<{
    experimentId: string;
    experimentCode: string;
    mode: string;
    status: string;
    rankingScope: "SHADOW" | null;
    trialScope: "LOCAL" | "SHADOW" | null;
    humanApprovedAt: string | null;
    recommendation: string | null;
    updatedAt: string;
  }>;
  readonly decisionEvaluations: ReadonlyArray<{
    evaluationSha256: string;
    experimentId: string;
    evidenceSnapshotId: string;
    comparisonSha256: string;
    decisionDeltaTurnoverBps: string;
    navCurrency: string;
    official: PortfolioReplayMetricView;
    candidate: PortfolioReplayMetricView;
    recommendation: string;
    recordedAt: string;
  }>;
}

interface PortfolioReplayMetricView {
  readonly constraintViolationCount: string;
  readonly turnoverBps: string;
  readonly simulatedSlippageNavCost: string;
  readonly simulatedFeeNavCost: string;
  readonly simulatedTaxNavCost: string;
  readonly terminalNav: string;
  readonly maxDrawdownBps: string;
  readonly terminalFailureCount: string;
}

interface EvolutionRows {
  readonly cycles: readonly Record<string, unknown>[];
  readonly findings: readonly Record<string, unknown>[];
  readonly experiments: readonly Record<string, unknown>[];
  readonly trials: readonly Record<string, unknown>[];
  readonly decisionEvaluations: readonly Record<string, unknown>[];
}

export function buildEvolutionOverview(rows: EvolutionRows): EvolutionOverview {
  const trialByExperiment = new Map<string, "LOCAL" | "SHADOW">();
  for (const row of rows.trials) {
    const mode = text(row.mode);
    const scope = text(row.ranking_scope);
    if (
      (mode === "LOCAL_REPLAY" && scope !== "LOCAL")
      || (mode === "ONLINE_SHADOW" && scope !== "SHADOW")
    ) throw new TypeError("evolution trial has an invalid ranking scope");
    trialByExperiment.set(text(row.experiment_id), scope as "LOCAL" | "SHADOW");
  }
  return Object.freeze({
    configured: true,
    error: null,
    cycleCount: String(rows.cycles.length),
    findingCount: String(rows.findings.length),
    experimentCount: String(rows.experiments.length),
    portfolioReplayCount: String(rows.decisionEvaluations.length),
    cycles: Object.freeze(rows.cycles.map((row) => {
      const report = objectOrNull(row.analysis_report);
      const findings = report === null || !Array.isArray(report.findings)
        ? []
        : report.findings;
      return Object.freeze({
        cycleId: text(row.cycle_id),
        windowStartedAt: text(row.window_started_at),
        windowEndedAt: text(row.window_ended_at),
        status: text(row.status),
        findingCount: String(findings.length),
        reportSha256: nullableText(row.report_sha256),
      });
    })),
    findings: Object.freeze(rows.findings.map((row) => {
      const finding = object(row.finding);
      return Object.freeze({
        findingSha256: text(row.finding_sha256),
        severity: text(finding.severity),
        scope: text(finding.scope),
        subject: text(finding.subject),
        title: text(finding.title),
        lesson: text(finding.lesson),
        observedValue: text(finding.observedValue),
        threshold: text(finding.threshold),
      });
    })),
    experiments: Object.freeze(rows.experiments.map((row) => {
      const result = objectOrNull(row.result);
      const rankingScope = nullableText(row.ranking_scope);
      if (rankingScope !== null && rankingScope !== "SHADOW") {
        throw new TypeError("evolution experiment has an invalid ranking scope");
      }
      const experimentId = text(row.experiment_id);
      return Object.freeze({
        experimentId,
        experimentCode: text(row.experiment_code),
        mode: text(row.mode),
        status: text(row.status),
        rankingScope,
        trialScope: trialByExperiment.get(experimentId) ?? null,
        humanApprovedAt: nullableText(row.human_approved_at),
        recommendation: result === null ? null : nullableText(result.recommendation),
        updatedAt: text(row.updated_at),
      });
    })),
    decisionEvaluations: Object.freeze(rows.decisionEvaluations.map((row) => {
      const evaluation = object(row.evaluation);
      const officialOutcome = object(evaluation.officialOutcome);
      const candidateOutcome = object(evaluation.candidateOutcome);
      const navCurrency = text(officialOutcome.navCurrency);
      if (text(candidateOutcome.navCurrency) !== navCurrency) {
        throw new TypeError("portfolio replay outcomes use different NAV currencies");
      }
      const result = object(evaluation.result);
      return Object.freeze({
        evaluationSha256: text(row.evaluation_sha256),
        experimentId: text(row.experiment_id),
        evidenceSnapshotId: text(row.evidence_snapshot_id),
        comparisonSha256: text(row.comparison_sha256),
        decisionDeltaTurnoverBps: text(evaluation.decisionDeltaTurnoverBps),
        navCurrency,
        official: replayMetrics(officialOutcome.metrics),
        candidate: replayMetrics(candidateOutcome.metrics),
        recommendation: text(result.recommendation),
        recordedAt: text(row.recorded_at),
      });
    })),
  });
}

export function unavailableEvolutionOverview(error: string | null): EvolutionOverview {
  return Object.freeze({
    configured: false,
    error,
    cycleCount: "0",
    findingCount: "0",
    experimentCount: "0",
    portfolioReplayCount: "0",
    cycles: [],
    findings: [],
    experiments: [],
    decisionEvaluations: [],
  });
}

function replayMetrics(value: unknown): PortfolioReplayMetricView {
  const metrics = object(value);
  return Object.freeze({
    constraintViolationCount: text(metrics.constraintViolationCount),
    turnoverBps: text(metrics.turnoverBps),
    simulatedSlippageNavCost: text(metrics.simulatedSlippageNavCost),
    simulatedFeeNavCost: text(metrics.simulatedFeeNavCost),
    simulatedTaxNavCost: text(metrics.simulatedTaxNavCost),
    terminalNav: text(metrics.terminalNav),
    maxDrawdownBps: text(metrics.maxDrawdownBps),
    terminalFailureCount: text(metrics.terminalFailureCount),
  });
}

function object(value: unknown): Record<string, unknown> {
  const parsed = objectOrNull(value);
  if (parsed === null) throw new TypeError("expected an object");
  return parsed;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new TypeError("expected non-empty text");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}
