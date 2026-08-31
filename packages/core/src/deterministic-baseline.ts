import { createHash } from "node:crypto";

import { canonicalFinancialJson } from "./canonical-json.js";

export const DETERMINISTIC_BASELINE_POLICY_SCHEMA =
  "twofold.deterministic_baseline_policy/v1";

/**
 * Full weight of a target portfolio. A baseline always holds exactly one
 * instrument and no cash, so its marked weight is this constant in every Round
 * regardless of price: a single-position, zero-cash portfolio is by definition
 * 100% that position. That is what makes a baseline reproduce itself with zero
 * orders after it has converged, instead of drifting into rebalancing noise.
 */
const FULL_WEIGHT_BPS = "10000";

const POLICY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;

/**
 * `HOLD_GENESIS` never trades: it keeps the equal-start genesis holding for the
 * whole Season and measures what the contestants had to beat by doing nothing.
 * `ALL_IN_SYMBOL` performs one switch into a single named instrument and then
 * holds it, paying the real S1 disposition fees and CNY tax reserve on the way.
 */
export type DeterministicBaselineRule = "HOLD_GENESIS" | "ALL_IN_SYMBOL";

export interface DeterministicBaselinePolicyInput {
  readonly policyId: string;
  readonly rule: DeterministicBaselineRule;
  /** Required by `ALL_IN_SYMBOL`, and forbidden by `HOLD_GENESIS`. */
  readonly symbol: string | null;
}

export interface DeterministicBaselinePolicy {
  readonly schema: typeof DETERMINISTIC_BASELINE_POLICY_SCHEMA;
  readonly policyId: string;
  readonly rule: DeterministicBaselineRule;
  readonly symbol: string | null;
  readonly policyCanonicalJson: string;
  /**
   * Content address of the frozen policy bytes. This is the baseline's entrant
   * identity: it occupies the same immutable `bundleSha256` fence that an Agent
   * Bundle does, so a baseline cannot be silently redefined mid-Season either.
   */
  readonly policySha256: string;
}

export interface DeterministicBaselineTarget {
  readonly symbol: string;
  readonly targetWeightBps: string;
}

export interface DeterministicBaselineDecision {
  readonly policyId: string;
  readonly rule: DeterministicBaselineRule;
  readonly targets: readonly DeterministicBaselineTarget[];
  readonly cashWeightBps: string;
  readonly decisionSummary: string;
}

/**
 * Freeze one baseline strategy as content-addressed bytes.
 * @param input - Policy identity and rule parameters.
 * @returns The canonical policy document and its SHA-256.
 */
export function createDeterministicBaselinePolicy(
  input: DeterministicBaselinePolicyInput,
): DeterministicBaselinePolicy {
  const policyId = pattern(input.policyId, POLICY_ID_PATTERN, "policyId");
  if (input.rule !== "HOLD_GENESIS" && input.rule !== "ALL_IN_SYMBOL") {
    throw new TypeError("deterministic baseline rule is unsupported");
  }
  if (input.rule === "HOLD_GENESIS" && input.symbol !== null) {
    throw new TypeError("HOLD_GENESIS must not name a symbol");
  }
  const symbol = input.rule === "ALL_IN_SYMBOL"
    ? pattern(input.symbol, SYMBOL_PATTERN, "symbol")
    : null;
  const document = Object.freeze({
    schema: DETERMINISTIC_BASELINE_POLICY_SCHEMA,
    policyId,
    rule: input.rule,
    symbol,
  });
  const policyCanonicalJson = canonicalFinancialJson(document);
  return Object.freeze({
    ...document,
    policyCanonicalJson,
    policySha256: createHash("sha256")
      .update(policyCanonicalJson, "utf8")
      .digest("hex"),
  });
}

/**
 * Derive the baseline's target portfolio for one Round.
 *
 * The result is a pure function of the frozen policy and the Season's genesis:
 * it reads no market data and calls no model, which is what lets the Arena
 * record a decision that provably consumed zero provider tokens. Pricing still
 * has to exist for the resolved symbol, so a baseline naming an instrument that
 * the Round's sealed snapshot cannot price fails closed here rather than
 * producing an unpriceable order downstream.
 *
 * @param input - Frozen policy, the Season genesis holding, and the exact set of
 *   symbols the Round's sealed snapshot can price.
 * @returns The deterministic single-instrument target portfolio.
 */
export function deriveDeterministicBaselineDecision(input: {
  readonly policy: DeterministicBaselinePolicy;
  readonly genesisSymbol: string;
  readonly priceableSymbols: readonly string[];
}): DeterministicBaselineDecision {
  const genesisSymbol = pattern(
    input.genesisSymbol,
    SYMBOL_PATTERN,
    "genesisSymbol",
  );
  const resolved = input.policy.rule === "HOLD_GENESIS"
    ? genesisSymbol
    : pattern(input.policy.symbol, SYMBOL_PATTERN, "policy.symbol");

  const priceable = new Set(input.priceableSymbols);
  if (priceable.size !== input.priceableSymbols.length) {
    throw new TypeError("priceableSymbols contains a duplicate symbol");
  }
  if (!priceable.has(resolved)) {
    throw new RangeError(
      `deterministic baseline ${input.policy.policyId} requires ${resolved}, `
      + "which the Round's sealed snapshot cannot price",
    );
  }

  return Object.freeze({
    policyId: input.policy.policyId,
    rule: input.policy.rule,
    targets: Object.freeze([Object.freeze({
      symbol: resolved,
      targetWeightBps: FULL_WEIGHT_BPS,
    })]),
    cashWeightBps: "0",
    decisionSummary: input.policy.rule === "HOLD_GENESIS"
      ? `Deterministic baseline: hold the genesis ${resolved} position without trading.`
      : `Deterministic baseline: hold ${resolved} at the full portfolio weight.`,
  });
}

function pattern(value: unknown, expected: RegExp, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  if (!expected.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}
