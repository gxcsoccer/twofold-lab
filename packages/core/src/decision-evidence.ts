import { createHash } from "node:crypto";

import { canonicalFinancialJson, compareCodePoints } from "./canonical-json.js";

const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;

export interface PortfolioDecisionTarget {
  readonly symbol: string;
  readonly targetWeightBps: string;
}

export interface PortfolioDecisionEvidence {
  readonly schema: "twofold.portfolio_decision_evidence/v1";
  readonly decisionRef: string;
  readonly policyRef: string;
  readonly evidenceSnapshotId: string;
  readonly targets: readonly PortfolioDecisionTarget[];
  readonly cashWeightBps: string;
  readonly decisionSha256: string;
}

export interface DecisionAdmissionPolicy {
  readonly policyRef: string;
  readonly maxInputAgeMs: string;
  readonly maxMarketJumpBps: string;
  readonly minimumStableWindowMs: string;
  readonly maxTargetDeltaBps: string;
  readonly maxCooldownRemainingMs: string;
}

export type DecisionAdmissionReason =
  | "ALL_GUARDS_PASSED"
  | "INPUT_STALE"
  | "MARKET_JUMP_EXCEEDED"
  | "STABLE_WINDOW_INSUFFICIENT"
  | "TARGET_DELTA_EXCEEDED"
  | "COOLDOWN_ACTIVE";

export interface DecisionAdmissionEvidence {
  readonly schema: "twofold.decision_admission_evidence/v1";
  readonly decision: PortfolioDecisionEvidence;
  readonly evidenceSnapshotId: string;
  readonly observedAt: string;
  readonly dataCutoffAt: string;
  readonly evidenceSealedAt: string;
  readonly policy: DecisionAdmissionPolicy;
  readonly metrics: Readonly<{
    inputAgeMs: string;
    marketJumpBps: string;
    stableWindowMs: string;
    maxTargetDeltaBps: string;
    cooldownRemainingMs: string;
  }>;
  readonly guardAction: "ALLOW" | "BLOCK";
  readonly reasons: readonly DecisionAdmissionReason[];
  readonly evidenceSha256: string;
}

export interface PortfolioDecisionDelta {
  readonly symbol: string;
  readonly officialWeightBps: string;
  readonly candidateWeightBps: string;
  readonly deltaBps: string;
}

export interface PortfolioDecisionComparison {
  readonly schema: "twofold.portfolio_decision_comparison/v1";
  readonly evidenceSnapshotId: string;
  readonly official: PortfolioDecisionEvidence;
  readonly candidate: PortfolioDecisionEvidence;
  readonly deltas: readonly PortfolioDecisionDelta[];
  readonly cashDeltaBps: string;
  readonly maxAbsoluteDeltaBps: string;
  readonly turnoverBps: string;
  readonly identical: boolean;
  readonly comparisonSha256: string;
}

export function createPortfolioDecisionEvidence(input: {
  readonly decisionRef: string;
  readonly policyRef: string;
  readonly evidenceSnapshotId: string;
  readonly targets: readonly PortfolioDecisionTarget[];
  readonly cashWeightBps: string;
}): PortfolioDecisionEvidence {
  const decisionRef = identity(input.decisionRef, "decisionRef");
  const policyRef = identity(input.policyRef, "policyRef");
  const evidenceSnapshotId = identity(
    input.evidenceSnapshotId,
    "evidenceSnapshotId",
  );
  const cashWeightBps = bps(input.cashWeightBps, "cashWeightBps", false);
  const symbols = new Set<string>();
  const targets = Object.freeze(input.targets.map((target, index) => {
    const symbol = identity(target.symbol, `targets[${index}].symbol`);
    if (!SYMBOL_PATTERN.test(symbol)) {
      throw new TypeError(`targets[${index}].symbol is invalid`);
    }
    if (symbols.has(symbol)) {
      throw new TypeError(`duplicate portfolio decision symbol ${symbol}`);
    }
    symbols.add(symbol);
    return Object.freeze({
      symbol,
      targetWeightBps: bps(
        target.targetWeightBps,
        `targets[${index}].targetWeightBps`,
        true,
      ),
    });
  }).sort((left, right) => compareCodePoints(left.symbol, right.symbol)));
  const total = targets.reduce(
    (sum, target) => sum + BigInt(target.targetWeightBps),
    BigInt(cashWeightBps),
  );
  if (total !== 10_000n) {
    throw new RangeError("portfolio decision targets plus cash must total 10000 bps");
  }
  const payload = Object.freeze({
    schema: "twofold.portfolio_decision_evidence/v1" as const,
    decisionRef,
    policyRef,
    evidenceSnapshotId,
    targets,
    cashWeightBps,
  });
  return Object.freeze({
    ...payload,
    decisionSha256: sha256(canonicalFinancialJson(payload)),
  });
}

export function createDecisionAdmissionEvidence(input: {
  readonly decision: PortfolioDecisionEvidence;
  readonly observedAt: string;
  readonly dataCutoffAt: string;
  readonly evidenceSealedAt: string;
  readonly marketJumpBps: string;
  readonly maxTargetDeltaBps: string;
  readonly cooldownRemainingMs: string;
  readonly policy: DecisionAdmissionPolicy;
}): DecisionAdmissionEvidence {
  assertPortfolioDecisionEvidence(input.decision);
  const observedAt = timestamp(input.observedAt, "observedAt");
  const dataCutoffAt = timestamp(input.dataCutoffAt, "dataCutoffAt");
  const evidenceSealedAt = timestamp(input.evidenceSealedAt, "evidenceSealedAt");
  const observedEpoch = Date.parse(observedAt);
  const cutoffEpoch = Date.parse(dataCutoffAt);
  const sealedEpoch = Date.parse(evidenceSealedAt);
  if (cutoffEpoch > observedEpoch) {
    throw new RangeError("dataCutoffAt cannot postdate observedAt");
  }
  if (sealedEpoch > observedEpoch) {
    throw new RangeError("evidenceSealedAt cannot postdate observedAt");
  }
  const policy = Object.freeze({
    policyRef: identity(input.policy.policyRef, "policy.policyRef"),
    maxInputAgeMs: integer(input.policy.maxInputAgeMs, "policy.maxInputAgeMs"),
    maxMarketJumpBps: integer(
      input.policy.maxMarketJumpBps,
      "policy.maxMarketJumpBps",
    ),
    minimumStableWindowMs: integer(
      input.policy.minimumStableWindowMs,
      "policy.minimumStableWindowMs",
    ),
    maxTargetDeltaBps: bps(
      input.policy.maxTargetDeltaBps,
      "policy.maxTargetDeltaBps",
      false,
    ),
    maxCooldownRemainingMs: integer(
      input.policy.maxCooldownRemainingMs,
      "policy.maxCooldownRemainingMs",
    ),
  });
  const metrics = Object.freeze({
    inputAgeMs: String(observedEpoch - cutoffEpoch),
    marketJumpBps: integer(input.marketJumpBps, "marketJumpBps"),
    stableWindowMs: String(observedEpoch - sealedEpoch),
    maxTargetDeltaBps: bps(
      input.maxTargetDeltaBps,
      "maxTargetDeltaBps",
      false,
    ),
    cooldownRemainingMs: integer(
      input.cooldownRemainingMs,
      "cooldownRemainingMs",
    ),
  });
  const reasons: DecisionAdmissionReason[] = [];
  if (BigInt(metrics.inputAgeMs) > BigInt(policy.maxInputAgeMs)) {
    reasons.push("INPUT_STALE");
  }
  if (BigInt(metrics.marketJumpBps) > BigInt(policy.maxMarketJumpBps)) {
    reasons.push("MARKET_JUMP_EXCEEDED");
  }
  if (BigInt(metrics.stableWindowMs) < BigInt(policy.minimumStableWindowMs)) {
    reasons.push("STABLE_WINDOW_INSUFFICIENT");
  }
  if (BigInt(metrics.maxTargetDeltaBps) > BigInt(policy.maxTargetDeltaBps)) {
    reasons.push("TARGET_DELTA_EXCEEDED");
  }
  if (
    BigInt(metrics.cooldownRemainingMs)
    > BigInt(policy.maxCooldownRemainingMs)
  ) {
    reasons.push("COOLDOWN_ACTIVE");
  }
  const guardAction = reasons.length === 0 ? "ALLOW" as const : "BLOCK" as const;
  const frozenReasons = Object.freeze(
    reasons.length === 0 ? ["ALL_GUARDS_PASSED" as const] : reasons,
  );
  const payload = Object.freeze({
    schema: "twofold.decision_admission_evidence/v1" as const,
    decision: input.decision,
    evidenceSnapshotId: input.decision.evidenceSnapshotId,
    observedAt,
    dataCutoffAt,
    evidenceSealedAt,
    policy,
    metrics,
    guardAction,
    reasons: frozenReasons,
  });
  return Object.freeze({
    ...payload,
    evidenceSha256: sha256(canonicalFinancialJson(payload)),
  });
}

export function comparePortfolioDecisions(input: {
  readonly official: PortfolioDecisionEvidence;
  readonly candidate: PortfolioDecisionEvidence;
}): PortfolioDecisionComparison {
  assertPortfolioDecisionEvidence(input.official);
  assertPortfolioDecisionEvidence(input.candidate);
  if (
    input.official.evidenceSnapshotId
    !== input.candidate.evidenceSnapshotId
  ) {
    throw new TypeError(
      "portfolio decisions must use the same evidence snapshot",
    );
  }
  const official = new Map(
    input.official.targets.map((target) => [target.symbol, target.targetWeightBps]),
  );
  const candidate = new Map(
    input.candidate.targets.map((target) => [target.symbol, target.targetWeightBps]),
  );
  const symbols = [...new Set([...official.keys(), ...candidate.keys()])]
    .sort(compareCodePoints);
  let maximum = 0n;
  let l1 = 0n;
  const deltas = Object.freeze(symbols.map((symbol) => {
    const officialWeightBps = official.get(symbol) ?? "0";
    const candidateWeightBps = candidate.get(symbol) ?? "0";
    const delta = BigInt(candidateWeightBps) - BigInt(officialWeightBps);
    const absolute = delta < 0n ? -delta : delta;
    if (absolute > maximum) maximum = absolute;
    l1 += absolute;
    return Object.freeze({
      symbol,
      officialWeightBps,
      candidateWeightBps,
      deltaBps: delta.toString(),
    });
  }));
  const cashDelta = BigInt(input.candidate.cashWeightBps)
    - BigInt(input.official.cashWeightBps);
  const absoluteCash = cashDelta < 0n ? -cashDelta : cashDelta;
  if (absoluteCash > maximum) maximum = absoluteCash;
  l1 += absoluteCash;
  if (l1 % 2n !== 0n) {
    throw new TypeError("portfolio decision L1 distance must be even");
  }
  const payload = Object.freeze({
    schema: "twofold.portfolio_decision_comparison/v1" as const,
    evidenceSnapshotId: input.official.evidenceSnapshotId,
    official: input.official,
    candidate: input.candidate,
    deltas,
    cashDeltaBps: cashDelta.toString(),
    maxAbsoluteDeltaBps: maximum.toString(),
    turnoverBps: (l1 / 2n).toString(),
    identical: l1 === 0n,
  });
  return Object.freeze({
    ...payload,
    comparisonSha256: sha256(canonicalFinancialJson(payload)),
  });
}

export function assertPortfolioDecisionEvidence(
  value: PortfolioDecisionEvidence,
): void {
  if (value.schema !== "twofold.portfolio_decision_evidence/v1") {
    throw new TypeError("unsupported portfolio decision evidence schema");
  }
  const rebuilt = createPortfolioDecisionEvidence({
    decisionRef: value.decisionRef,
    policyRef: value.policyRef,
    evidenceSnapshotId: value.evidenceSnapshotId,
    targets: value.targets,
    cashWeightBps: value.cashWeightBps,
  });
  if (rebuilt.decisionSha256 !== value.decisionSha256) {
    throw new TypeError("portfolio decision evidence fingerprint mismatch");
  }
}

function identity(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function integer(value: string, field: string): string {
  if (!INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
  return value;
}

function bps(value: string, field: string, positive: boolean): string {
  if (!(positive ? POSITIVE_INTEGER_PATTERN : INTEGER_PATTERN).test(value)) {
    throw new TypeError(`${field} must be a canonical ${positive ? "positive" : "non-negative"} integer`);
  }
  if (BigInt(value) > 10_000n) {
    throw new RangeError(`${field} cannot exceed 10000`);
  }
  return value;
}

function timestamp(value: string, field: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a canonical ISO UTC timestamp`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
