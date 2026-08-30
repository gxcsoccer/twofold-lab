import { createHash } from "node:crypto";

import { canonicalFinancialJson, compareCodePoints } from "./canonical-json.js";
import {
  compareDecimals,
  normalizeDecimal,
  subtractDecimals,
} from "./fixed-decimal.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type EvolutionMetricScope = "AGENT" | "PLATFORM" | "DATA" | "ACCOUNTING";
export type EvolutionMetricUnit =
  | "COUNT"
  | "RATIO"
  | "MILLISECONDS"
  | "TOKENS"
  | "USD";
export type EvolutionRuleOperator = "GT" | "GTE" | "LT" | "LTE" | "EQ";
export type EvolutionSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type EvolutionExperimentMode = "LOCAL_REPLAY" | "ONLINE_SHADOW";
export type EvolutionMetricDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";

export interface EvolutionMetricObservation {
  readonly metricKey: string;
  readonly scope: EvolutionMetricScope;
  readonly subject: string;
  readonly value: string;
  readonly unit: EvolutionMetricUnit;
  readonly sampleCount: string;
  readonly evidenceRefs: readonly string[];
}

export interface EvolutionAnalysisRule {
  readonly ruleId: string;
  readonly metricKey: string;
  readonly operator: EvolutionRuleOperator;
  readonly threshold: string;
  readonly severity: EvolutionSeverity;
  readonly title: string;
  readonly diagnosis: string;
  readonly lesson: string;
  readonly proposedExperimentMode: EvolutionExperimentMode;
  readonly proposedChangeSurface: string;
}

export interface EvolutionFinding {
  readonly schema: "twofold.evolution_finding/v1";
  readonly findingSha256: string;
  readonly ruleId: string;
  readonly metricKey: string;
  readonly scope: EvolutionMetricScope;
  readonly subject: string;
  readonly observedValue: string;
  readonly unit: EvolutionMetricUnit;
  readonly sampleCount: string;
  readonly operator: EvolutionRuleOperator;
  readonly threshold: string;
  readonly severity: EvolutionSeverity;
  readonly title: string;
  readonly diagnosis: string;
  readonly lesson: string;
  readonly evidenceRefs: readonly string[];
  readonly proposedExperimentMode: EvolutionExperimentMode;
  readonly proposedChangeSurface: string;
}

export interface EvolutionAnalysisReport {
  readonly schema: "twofold.evolution_analysis/v1";
  readonly reportSha256: string;
  readonly analyzerVersion: string;
  readonly windowStartedAt: string;
  readonly windowEndedAt: string;
  readonly observationCount: string;
  readonly findings: readonly EvolutionFinding[];
}

export function analyzeEvolutionWindow(input: {
  readonly windowStartedAt: string;
  readonly windowEndedAt: string;
  readonly observations: readonly EvolutionMetricObservation[];
  readonly rules: readonly EvolutionAnalysisRule[];
  readonly analyzerVersion: string;
}): EvolutionAnalysisReport {
  const windowStartedAt = timestamp(input.windowStartedAt, "windowStartedAt");
  const windowEndedAt = timestamp(input.windowEndedAt, "windowEndedAt");
  if (Date.parse(windowEndedAt) <= Date.parse(windowStartedAt)) {
    throw new TypeError("evolution window must end after it starts");
  }
  const analyzerVersion = identity(input.analyzerVersion, "analyzerVersion");
  const observations = input.observations.map(parseObservation);
  const observationKeys = observations.map(
    (item) => `${item.metricKey}\u001f${item.scope}\u001f${item.subject}`,
  );
  if (new Set(observationKeys).size !== observationKeys.length) {
    throw new TypeError("evolution observations must have unique metric/scope/subject identity");
  }
  const rules = input.rules.map(parseRule);
  if (new Set(rules.map((rule) => rule.ruleId)).size !== rules.length) {
    throw new TypeError("evolution rules must have unique ruleId identity");
  }

  const findings = rules.flatMap((rule) => observations
    .filter((observation) =>
      observation.metricKey === rule.metricKey
      && matches(observation.value, rule.operator, rule.threshold)
    )
    .map((observation) => finding(rule, observation)))
    .sort((left, right) =>
      compareCodePoints(left.ruleId, right.ruleId)
      || compareCodePoints(left.subject, right.subject)
      || compareCodePoints(left.findingSha256, right.findingSha256)
    );

  const payload = Object.freeze({
    schema: "twofold.evolution_analysis/v1" as const,
    analyzerVersion,
    windowStartedAt,
    windowEndedAt,
    observationCount: String(observations.length),
    findings: Object.freeze(findings),
  });
  return Object.freeze({
    ...payload,
    reportSha256: sha256(canonicalFinancialJson(payload)),
  });
}

function parseObservation(
  value: EvolutionMetricObservation,
  index: number,
): EvolutionMetricObservation {
  const path = `observations[${index}]`;
  const metricKey = code(value.metricKey, `${path}.metricKey`);
  if (!(["AGENT", "PLATFORM", "DATA", "ACCOUNTING"] as const).includes(value.scope)) {
    throw new TypeError(`${path}.scope is unsupported`);
  }
  if (!(["COUNT", "RATIO", "MILLISECONDS", "TOKENS", "USD"] as const).includes(value.unit)) {
    throw new TypeError(`${path}.unit is unsupported`);
  }
  const sampleCount = positiveInteger(value.sampleCount, `${path}.sampleCount`);
  const evidenceRefs = uniqueIdentities(value.evidenceRefs, `${path}.evidenceRefs`);
  return Object.freeze({
    metricKey,
    scope: value.scope,
    subject: identity(value.subject, `${path}.subject`),
    value: normalizeDecimal(value.value),
    unit: value.unit,
    sampleCount,
    evidenceRefs,
  });
}

function parseRule(value: EvolutionAnalysisRule, index: number): EvolutionAnalysisRule {
  const path = `rules[${index}]`;
  if (!(["GT", "GTE", "LT", "LTE", "EQ"] as const).includes(value.operator)) {
    throw new TypeError(`${path}.operator is unsupported`);
  }
  if (!(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const).includes(value.severity)) {
    throw new TypeError(`${path}.severity is unsupported`);
  }
  if (!(["LOCAL_REPLAY", "ONLINE_SHADOW"] as const).includes(
    value.proposedExperimentMode,
  )) throw new TypeError(`${path}.proposedExperimentMode is unsupported`);
  return Object.freeze({
    ruleId: code(value.ruleId, `${path}.ruleId`),
    metricKey: code(value.metricKey, `${path}.metricKey`),
    operator: value.operator,
    threshold: normalizeDecimal(value.threshold),
    severity: value.severity,
    title: identity(value.title, `${path}.title`),
    diagnosis: identity(value.diagnosis, `${path}.diagnosis`),
    lesson: identity(value.lesson, `${path}.lesson`),
    proposedExperimentMode: value.proposedExperimentMode,
    proposedChangeSurface: code(
      value.proposedChangeSurface.toLowerCase(),
      `${path}.proposedChangeSurface`,
    ).toUpperCase(),
  });
}

function matches(left: string, operator: EvolutionRuleOperator, right: string): boolean {
  const comparison = compareDecimals(left, right);
  if (operator === "GT") return comparison > 0;
  if (operator === "GTE") return comparison >= 0;
  if (operator === "LT") return comparison < 0;
  if (operator === "LTE") return comparison <= 0;
  return comparison === 0;
}

function finding(
  rule: EvolutionAnalysisRule,
  observation: EvolutionMetricObservation,
): EvolutionFinding {
  const payload = Object.freeze({
    schema: "twofold.evolution_finding/v1" as const,
    ruleId: rule.ruleId,
    metricKey: observation.metricKey,
    scope: observation.scope,
    subject: observation.subject,
    observedValue: observation.value,
    unit: observation.unit,
    sampleCount: observation.sampleCount,
    operator: rule.operator,
    threshold: rule.threshold,
    severity: rule.severity,
    title: rule.title,
    diagnosis: rule.diagnosis,
    lesson: rule.lesson,
    evidenceRefs: observation.evidenceRefs,
    proposedExperimentMode: rule.proposedExperimentMode,
    proposedChangeSurface: rule.proposedChangeSurface,
  });
  return Object.freeze({
    ...payload,
    findingSha256: sha256(canonicalFinancialJson(payload)),
  });
}

export interface EvolutionExperimentSpec {
  readonly schema: "twofold.evolution_experiment_spec/v1";
  readonly experimentId: string;
  readonly experimentCode: string;
  readonly mode: EvolutionExperimentMode;
  readonly hypothesis: string;
  readonly sourceFindingSha256s: readonly string[];
  readonly changeSurface: string;
  readonly baselineRef: string;
  readonly treatmentRef: string;
  readonly primaryMetric: Readonly<{
    metricKey: string;
    direction: EvolutionMetricDirection;
    minimumAbsoluteImprovement: string;
  }>;
  readonly guardrails: ReadonlyArray<{
    metricKey: string;
    direction: EvolutionMetricDirection;
    maximumRegression: string;
    /** Optional absolute ceiling for the treatment, independent of baseline quality. */
    candidateMaximum?: string;
  }>;
  readonly onlineShadow: Readonly<{
    seasonId: string;
    startsAtRoundIndex: string;
    maximumRounds: string;
    rankingScope: "SHADOW";
  }> | null;
  readonly expiresAt: string;
}

export type EvolutionExperimentStatus =
  | "PROPOSED"
  | "APPROVED"
  | "SCHEDULED"
  | "RUNNING"
  | "COMPLETED"
  | "PROMOTED"
  | "CANCELED"
  | "FAILED";

export interface EvolutionExperimentResult {
  readonly schema: "twofold.evolution_experiment_result/v1";
  readonly recommendation: "PROMOTE_CANDIDATE" | "REJECT" | "INCONCLUSIVE";
  readonly baselineValue: string;
  readonly treatmentValue: string;
  readonly primaryImprovement: string;
  readonly minimumAbsoluteImprovement: string;
  readonly guardrails: ReadonlyArray<{
    metricKey: string;
    baselineValue: string;
    treatmentValue: string;
    regression: string;
    maximumRegression: string;
    candidateMaximum?: string;
    candidateMaximumPassed?: boolean;
    passed: boolean;
  }>;
  readonly resultSha256: string;
}

export interface EvolutionExperimentState {
  readonly schema: "twofold.evolution_experiment_state/v1";
  readonly spec: EvolutionExperimentSpec;
  readonly specSha256: string;
  readonly status: EvolutionExperimentStatus;
  readonly rankingScope: "SHADOW" | null;
  readonly proposedAt: string;
  readonly humanApprovedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly promotedAt: string | null;
  readonly result: EvolutionExperimentResult | null;
  readonly updatedAt: string;
}

export type EvolutionActor = Readonly<{
  kind: "human" | "worker" | "model";
  id: string;
}>;

export type EvolutionExperimentCommand =
  | Readonly<{ type: "PROPOSE"; spec: EvolutionExperimentSpec; actor: EvolutionActor; at: string }>
  | Readonly<{ type: "APPROVE" | "SCHEDULE" | "START" | "PROMOTE" | "CANCEL"; actor: EvolutionActor; at: string }>
  | Readonly<{ type: "COMPLETE"; result: EvolutionExperimentResult; actor: EvolutionActor; at: string }>
  | Readonly<{ type: "FAIL"; actor: EvolutionActor; at: string }>;

export function transitionEvolutionExperiment(
  state: EvolutionExperimentState | null,
  command: EvolutionExperimentCommand,
): EvolutionExperimentState {
  const at = timestamp(command.at, "command.at");
  actor(command.actor);
  if (state === null) {
    if (command.type !== "PROPOSE") {
      throw new TypeError("an evolution experiment must begin with PROPOSE");
    }
    const spec = parseExperimentSpec(command.spec, at);
    return Object.freeze({
      schema: "twofold.evolution_experiment_state/v1",
      spec,
      specSha256: sha256(canonicalFinancialJson(spec)),
      status: "PROPOSED",
      rankingScope: spec.onlineShadow?.rankingScope ?? null,
      proposedAt: at,
      humanApprovedAt: null,
      startedAt: null,
      completedAt: null,
      promotedAt: null,
      result: null,
      updatedAt: at,
    });
  }
  if (Date.parse(at) < Date.parse(state.updatedAt)) {
    throw new TypeError("experiment command cannot precede current state");
  }
  if (Date.parse(at) >= Date.parse(state.spec.expiresAt)
    && command.type !== "CANCEL") {
    throw new TypeError("experiment has expired");
  }
  if (command.type === "PROPOSE") throw new TypeError("experiment is already proposed");

  if (command.type === "APPROVE") {
    requireStatus(state, "PROPOSED", command.type);
    requireHuman(command.actor, "online experiment approval");
    return updateState(state, at, {
      status: "APPROVED",
      humanApprovedAt: at,
    });
  }
  if (command.type === "SCHEDULE") {
    if (state.spec.mode === "ONLINE_SHADOW" && state.humanApprovedAt === null) {
      throw new TypeError("ONLINE_SHADOW scheduling requires human approval");
    }
    if (state.status !== "PROPOSED" && state.status !== "APPROVED") {
      throw new TypeError(`SCHEDULE is invalid from ${state.status}`);
    }
    return updateState(state, at, { status: "SCHEDULED" });
  }
  if (command.type === "START") {
    requireStatus(state, "SCHEDULED", command.type);
    return updateState(state, at, { status: "RUNNING", startedAt: at });
  }
  if (command.type === "COMPLETE") {
    requireStatus(state, "RUNNING", command.type);
    if (command.result.resultSha256 !== sha256(canonicalFinancialJson({
      schema: command.result.schema,
      recommendation: command.result.recommendation,
      baselineValue: command.result.baselineValue,
      treatmentValue: command.result.treatmentValue,
      primaryImprovement: command.result.primaryImprovement,
      minimumAbsoluteImprovement: command.result.minimumAbsoluteImprovement,
      guardrails: command.result.guardrails,
    }))) throw new TypeError("experiment result hash is inconsistent");
    return updateState(state, at, {
      status: "COMPLETED",
      completedAt: at,
      result: command.result,
    });
  }
  if (command.type === "PROMOTE") {
    requireStatus(state, "COMPLETED", command.type);
    requireHuman(command.actor, "experiment promotion");
    if (state.result?.recommendation !== "PROMOTE_CANDIDATE") {
      throw new TypeError("only a promote candidate can be promoted");
    }
    return updateState(state, at, { status: "PROMOTED", promotedAt: at });
  }
  if (command.type === "CANCEL") {
    if (["PROMOTED", "CANCELED", "FAILED"].includes(state.status)) {
      throw new TypeError(`CANCEL is invalid from ${state.status}`);
    }
    requireHuman(command.actor, "experiment cancellation");
    return updateState(state, at, { status: "CANCELED", completedAt: at });
  }
  requireStatus(state, "RUNNING", command.type);
  return updateState(state, at, { status: "FAILED", completedAt: at });
}

function parseExperimentSpec(
  value: EvolutionExperimentSpec,
  proposedAt: string,
): EvolutionExperimentSpec {
  if (value.schema !== "twofold.evolution_experiment_spec/v1") {
    throw new TypeError("unsupported evolution experiment spec");
  }
  const mode = value.mode;
  if (mode !== "LOCAL_REPLAY" && mode !== "ONLINE_SHADOW") {
    throw new TypeError("experiment mode is unsupported");
  }
  const primaryDirection = direction(value.primaryMetric.direction, "primaryMetric.direction");
  const primaryMetric = Object.freeze({
    metricKey: code(value.primaryMetric.metricKey, "primaryMetric.metricKey"),
    direction: primaryDirection,
    minimumAbsoluteImprovement: nonNegativeDecimal(
      value.primaryMetric.minimumAbsoluteImprovement,
      "primaryMetric.minimumAbsoluteImprovement",
    ),
  });
  const guardrails = value.guardrails.map((guardrail, index) => Object.freeze({
    metricKey: code(guardrail.metricKey, `guardrails[${index}].metricKey`),
    direction: direction(guardrail.direction, `guardrails[${index}].direction`),
    maximumRegression: nonNegativeDecimal(
      guardrail.maximumRegression,
      `guardrails[${index}].maximumRegression`,
    ),
    ...(guardrail.candidateMaximum === undefined ? {} : {
      candidateMaximum: nonNegativeDecimal(
        guardrail.candidateMaximum,
        `guardrails[${index}].candidateMaximum`,
      ),
    }),
  }));
  if (new Set(guardrails.map((guardrail) => guardrail.metricKey)).size
    !== guardrails.length) throw new TypeError("experiment guardrail metrics must be unique");
  let onlineShadow: EvolutionExperimentSpec["onlineShadow"] = null;
  if (mode === "ONLINE_SHADOW") {
    if (value.onlineShadow === null || value.onlineShadow.rankingScope !== "SHADOW") {
      throw new TypeError("ONLINE_SHADOW experiments must use SHADOW ranking scope");
    }
    onlineShadow = Object.freeze({
      seasonId: uuid(value.onlineShadow.seasonId, "onlineShadow.seasonId"),
      startsAtRoundIndex: positiveInteger(
        value.onlineShadow.startsAtRoundIndex,
        "onlineShadow.startsAtRoundIndex",
      ),
      maximumRounds: positiveInteger(
        value.onlineShadow.maximumRounds,
        "onlineShadow.maximumRounds",
      ),
      rankingScope: "SHADOW" as const,
    });
  } else if (value.onlineShadow !== null) {
    throw new TypeError("LOCAL_REPLAY cannot define an online shadow window");
  }
  const expiresAt = timestamp(value.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(proposedAt)) {
    throw new TypeError("experiment expiry must follow proposal time");
  }
  return Object.freeze({
    schema: value.schema,
    experimentId: uuid(value.experimentId, "experimentId"),
    experimentCode: code(value.experimentCode, "experimentCode"),
    mode,
    hypothesis: identity(value.hypothesis, "hypothesis"),
    sourceFindingSha256s: uniquePatterns(
      value.sourceFindingSha256s,
      SHA256_PATTERN,
      "sourceFindingSha256s",
    ),
    changeSurface: identity(value.changeSurface, "changeSurface"),
    baselineRef: identity(value.baselineRef, "baselineRef"),
    treatmentRef: identity(value.treatmentRef, "treatmentRef"),
    primaryMetric,
    guardrails: Object.freeze(guardrails),
    onlineShadow,
    expiresAt,
  });
}

export function evaluateEvolutionExperiment(
  specInput: EvolutionExperimentSpec,
  input: Readonly<{
    baselineValue: string;
    treatmentValue: string;
    guardrails: ReadonlyArray<{
      metricKey: string;
      baselineValue: string;
      treatmentValue: string;
    }>;
  }>,
): EvolutionExperimentResult {
  const spec = parseExperimentSpec(specInput, "1970-01-01T00:00:00.000Z");
  const baselineValue = normalizeDecimal(input.baselineValue);
  const treatmentValue = normalizeDecimal(input.treatmentValue);
  const primaryImprovement = improvement(
    baselineValue,
    treatmentValue,
    spec.primaryMetric.direction,
  );
  const evidenceByMetric = new Map(input.guardrails.map((item) => [item.metricKey, item]));
  if (evidenceByMetric.size !== input.guardrails.length) {
    throw new TypeError("guardrail evidence metrics must be unique");
  }
  const guardrails = spec.guardrails.map((guardrail) => {
    const evidence = evidenceByMetric.get(guardrail.metricKey);
    if (evidence === undefined) {
      throw new TypeError(`missing guardrail evidence for ${guardrail.metricKey}`);
    }
    const baseline = normalizeDecimal(evidence.baselineValue);
    const treatment = normalizeDecimal(evidence.treatmentValue);
    const signedImprovement = improvement(baseline, treatment, guardrail.direction);
    const regression = compareDecimals(signedImprovement, "0") < 0
      ? subtractDecimals("0", signedImprovement)
      : normalizeDecimal("0");
    const regressionPassed = compareDecimals(regression, guardrail.maximumRegression) <= 0;
    const candidateMaximumPassed = guardrail.candidateMaximum === undefined
      ? true
      : compareDecimals(treatment, guardrail.candidateMaximum) <= 0;
    return Object.freeze({
      metricKey: guardrail.metricKey,
      baselineValue: baseline,
      treatmentValue: treatment,
      regression,
      maximumRegression: guardrail.maximumRegression,
      ...(guardrail.candidateMaximum === undefined ? {} : {
        candidateMaximum: guardrail.candidateMaximum,
        candidateMaximumPassed,
      }),
      passed: regressionPassed && candidateMaximumPassed,
    });
  });
  const recommendation = guardrails.some((guardrail) => !guardrail.passed)
    ? "REJECT" as const
    : compareDecimals(
        primaryImprovement,
        spec.primaryMetric.minimumAbsoluteImprovement,
      ) >= 0
      ? "PROMOTE_CANDIDATE" as const
      : "INCONCLUSIVE" as const;
  const payload = Object.freeze({
    schema: "twofold.evolution_experiment_result/v1" as const,
    recommendation,
    baselineValue,
    treatmentValue,
    primaryImprovement,
    minimumAbsoluteImprovement: spec.primaryMetric.minimumAbsoluteImprovement,
    guardrails: Object.freeze(guardrails),
  });
  return Object.freeze({
    ...payload,
    resultSha256: sha256(canonicalFinancialJson(payload)),
  });
}

function improvement(
  baseline: string,
  treatment: string,
  metricDirection: EvolutionMetricDirection,
): string {
  return metricDirection === "HIGHER_IS_BETTER"
    ? subtractDecimals(treatment, baseline)
    : subtractDecimals(baseline, treatment);
}

function updateState(
  state: EvolutionExperimentState,
  updatedAt: string,
  patch: Partial<EvolutionExperimentState>,
): EvolutionExperimentState {
  return Object.freeze({ ...state, ...patch, updatedAt });
}

function requireStatus(
  state: EvolutionExperimentState,
  expected: EvolutionExperimentStatus,
  command: string,
): void {
  if (state.status !== expected) {
    throw new TypeError(`${command} is invalid from ${state.status}`);
  }
}

function requireHuman(value: EvolutionActor, action: string): void {
  if (value.kind !== "human") throw new TypeError(`${action} requires a human actor`);
}

function actor(value: EvolutionActor): void {
  if (value.kind !== "human" && value.kind !== "worker" && value.kind !== "model") {
    throw new TypeError("unsupported evolution actor kind");
  }
  identity(value.id, "actor.id");
}

function direction(value: unknown, field: string): EvolutionMetricDirection {
  if (value !== "HIGHER_IS_BETTER" && value !== "LOWER_IS_BETTER") {
    throw new TypeError(`${field} is unsupported`);
  }
  return value;
}

function nonNegativeDecimal(value: string, field: string): string {
  const parsed = normalizeDecimal(value);
  if (compareDecimals(parsed, "0") < 0) {
    throw new TypeError(`${field} must be non-negative`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !TIMESTAMP_PATTERN.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw new TypeError(`${field} must be a canonical UTC timestamp`);
  return value;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a trimmed non-empty string`);
  }
  return value;
}

function code(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!CODE_PATTERN.test(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function positiveInteger(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!POSITIVE_INTEGER_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a positive integer string`);
  }
  return parsed;
}

function uniqueIdentities(values: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${field} must be a non-empty array`);
  }
  const parsed = values.map((value, index) => identity(value, `${field}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new TypeError(`${field} must be unique`);
  return Object.freeze(parsed.sort(compareCodePoints));
}

function uniquePatterns(
  values: readonly string[],
  pattern: RegExp,
  field: string,
): readonly string[] {
  const parsed = uniqueIdentities(values, field);
  if (parsed.some((value) => !pattern.test(value))) {
    throw new TypeError(`${field} contains an invalid value`);
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
