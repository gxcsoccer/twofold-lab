import {
  currency,
  nonNegativeDecimal,
  type CurrencyCode,
  type NonNegativeDecimalString,
  type NonNegativeMoney,
} from "./decimal.js";

declare const tokenCountBrand: unique symbol;

/** A non-negative, arbitrary-precision integer serialized as a string. */
export type TokenCountString = string & { readonly [tokenCountBrand]: true };

const TOKEN_COUNT_PATTERN = /^(?:0|[1-9]\d*)$/;
const PRICING_UNIT_SCALE = 6;
const COST_SCALE = 18;

export const DEEPSEEK_WEEKDAY_UTC_PRICING_RULE =
  "deepseek-weekday-utc-v1";

export type DeepSeekPricingBand = "peak" | "off-peak";

export function tokenCount(value: string): TokenCountString {
  if (!TOKEN_COUNT_PATTERN.test(value)) {
    throw new TypeError(`Invalid token count string: ${value}`);
  }

  return value as TokenCountString;
}

/**
 * The token buckets exposed by DeepSeek Harness for one model request.
 * Harness counts are disjoint: inputTokens excludes cache reads and writes.
 */
export interface HarnessTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Informational subset of outputTokens; never add it to billed output again. */
  readonly reasoningTokens?: number;
}

/** Durable, JSON-safe representation of the Harness token buckets. */
export interface ModelTokenUsage {
  readonly uncachedInputTokens: TokenCountString;
  readonly cacheReadTokens: TokenCountString;
  readonly cacheWriteTokens: TokenCountString;
  readonly outputTokens: TokenCountString;
  readonly reasoningTokens?: TokenCountString;
}

export interface ModelPricing {
  readonly pricingVersion: string;
  readonly pricingBand: string;
  readonly selectionRule: string;
  readonly provider: string;
  readonly model: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly currency: CurrencyCode;
  /** All rates are currency units per one million tokens. */
  readonly uncachedInputPerMillion: NonNegativeDecimalString;
  readonly cacheReadPerMillion: NonNegativeDecimalString;
  readonly cacheWritePerMillion: NonNegativeDecimalString;
  readonly outputPerMillion: NonNegativeDecimalString;
}

export interface ModelCostEstimate {
  readonly pricingVersion: string;
  readonly pricingBand: string;
  readonly amount: NonNegativeMoney;
}

interface ModelUsageFactBase {
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly seasonId: string;
  readonly decisionId: string;
  readonly harnessSessionId: string;
  readonly turn: TokenCountString;
  readonly step: TokenCountString;
  readonly attempt: TokenCountString;
  readonly provider: string;
  readonly model: string;
  readonly providerRequestId?: string;
  readonly requestStartedAt: string;
  readonly completedAt: string;
}

export type ModelUsageFact =
  | (ModelUsageFactBase & {
      readonly usageStatus: "captured";
      readonly usageSource: "assistant_message" | "stream_chunk_fallback";
      readonly usage: ModelTokenUsage;
      readonly costStatus: "estimated";
      readonly costEstimate: ModelCostEstimate;
    })
  | (ModelUsageFactBase & {
      readonly usageStatus: "captured";
      readonly usageSource: "assistant_message" | "stream_chunk_fallback";
      readonly usage: ModelTokenUsage;
      readonly costStatus: "unpriced";
      readonly costEstimate?: never;
    })
  | (ModelUsageFactBase & {
      readonly usageStatus: "provider_unreported";
      readonly usageSource: "provider_unreported";
      readonly usage?: never;
      readonly costStatus: "unavailable";
      readonly costEstimate?: never;
    });

function safeHarnessCount(value: number, field: string): TokenCountString {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }

  return tokenCount(String(value));
}

/** Convert the transient numeric Harness API into the durable string boundary. */
export function normalizeHarnessTokenUsage(
  usage: HarnessTokenUsage,
): ModelTokenUsage {
  const outputTokens = safeHarnessCount(usage.outputTokens, "outputTokens");
  const reasoningTokens =
    usage.reasoningTokens === undefined
      ? undefined
      : safeHarnessCount(usage.reasoningTokens, "reasoningTokens");

  if (
    reasoningTokens !== undefined &&
    BigInt(reasoningTokens) > BigInt(outputTokens)
  ) {
    throw new TypeError("reasoningTokens cannot exceed outputTokens");
  }

  return Object.freeze({
    uncachedInputTokens: safeHarnessCount(usage.inputTokens, "inputTokens"),
    cacheReadTokens: safeHarnessCount(
      usage.cacheReadTokens ?? 0,
      "cacheReadTokens",
    ),
    cacheWriteTokens: safeHarnessCount(
      usage.cacheWriteTokens ?? 0,
      "cacheWriteTokens",
    ),
    outputTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  });
}

export function defineModelPricing(input: {
  readonly pricingVersion: string;
  readonly pricingBand: string;
  readonly selectionRule: string;
  readonly provider: string;
  readonly model: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly currency: string;
  readonly uncachedInputPerMillion: string;
  readonly cacheReadPerMillion: string;
  readonly cacheWritePerMillion: string;
  readonly outputPerMillion: string;
}): ModelPricing {
  if (
    input.pricingVersion.length === 0 ||
    input.pricingBand.length === 0 ||
    input.selectionRule.length === 0 ||
    input.provider.length === 0 ||
    input.model.length === 0
  ) {
    throw new TypeError(
      "pricingVersion, pricingBand, selectionRule, provider, and model are required",
    );
  }

  const effectiveFrom = Date.parse(input.effectiveFrom);
  const effectiveTo =
    input.effectiveTo === undefined ? undefined : Date.parse(input.effectiveTo);
  if (
    !Number.isFinite(effectiveFrom) ||
    (effectiveTo !== undefined &&
      (!Number.isFinite(effectiveTo) || effectiveTo <= effectiveFrom))
  ) {
    throw new TypeError("pricing effective window is invalid");
  }

  return Object.freeze({
    pricingVersion: input.pricingVersion,
    pricingBand: input.pricingBand,
    selectionRule: input.selectionRule,
    provider: input.provider,
    model: input.model,
    effectiveFrom: input.effectiveFrom,
    ...(input.effectiveTo === undefined
      ? {}
      : { effectiveTo: input.effectiveTo }),
    currency: currency(input.currency),
    uncachedInputPerMillion: nonNegativeDecimal(
      input.uncachedInputPerMillion,
    ),
    cacheReadPerMillion: nonNegativeDecimal(input.cacheReadPerMillion),
    cacheWritePerMillion: nonNegativeDecimal(input.cacheWritePerMillion),
    outputPerMillion: nonNegativeDecimal(input.outputPerMillion),
  });
}

/**
 * DeepSeek V4 Pro v1 band selector. Peak windows are Monday-Friday,
 * [01:00, 04:00) and [06:00, 10:00), all in UTC.
 */
export function deepseekPricingBandAt(
  requestStartedAt: string,
): DeepSeekPricingBand {
  const requestedAt = new Date(requestStartedAt);
  if (!Number.isFinite(requestedAt.getTime())) {
    throw new TypeError("model request time is invalid");
  }

  const weekday = requestedAt.getUTCDay();
  const hour = requestedAt.getUTCHours();
  const isWeekday = weekday >= 1 && weekday <= 5;
  const isPeakHour = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
  return isWeekday && isPeakHour ? "peak" : "off-peak";
}

function assertPricingBandForRequest(
  pricing: ModelPricing,
  requestStartedAt: string,
): void {
  if (pricing.selectionRule !== DEEPSEEK_WEEKDAY_UTC_PRICING_RULE) {
    throw new TypeError(
      `unsupported pricing selection rule: ${pricing.selectionRule}`,
    );
  }

  const selectedBand = deepseekPricingBandAt(requestStartedAt);
  if (pricing.pricingBand !== selectedBand) {
    throw new TypeError(
      `pricing band ${pricing.pricingBand} does not match selected band ${selectedBand}`,
    );
  }
}

function parseNonNegativeDecimal(value: NonNegativeDecimalString): {
  readonly coefficient: bigint;
  readonly scale: number;
} {
  const [integer = "0", fraction = ""] = value.split(".");
  return {
    coefficient: BigInt(integer + fraction),
    scale: fraction.length,
  };
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Format a non-negative fixed-point integer with HALF_UP rounding. */
function formatFixedPoint(
  coefficient: bigint,
  sourceScale: number,
  targetScale: number,
): string {
  let rounded = coefficient;
  let scale = sourceScale;

  if (sourceScale > targetScale) {
    const divisor = powerOfTen(sourceScale - targetScale);
    const quotient = coefficient / divisor;
    const remainder = coefficient % divisor;
    rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
    scale = targetScale;
  }

  const digits = rounded.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;

  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
}

/** Exact estimate from the versioned rate card; reasoning is already in output. */
export function estimateModelCost(
  input: {
    readonly provider: string;
    readonly model: string;
    readonly requestStartedAt: string;
    readonly usage: ModelTokenUsage;
  },
  pricing: ModelPricing,
): ModelCostEstimate {
  if (input.provider !== pricing.provider || input.model !== pricing.model) {
    throw new TypeError("pricing provider/model does not match model usage");
  }

  const requestedAt = Date.parse(input.requestStartedAt);
  const effectiveFrom = Date.parse(pricing.effectiveFrom);
  const effectiveTo =
    pricing.effectiveTo === undefined
      ? undefined
      : Date.parse(pricing.effectiveTo);
  if (
    !Number.isFinite(requestedAt) ||
    requestedAt < effectiveFrom ||
    (effectiveTo !== undefined && requestedAt >= effectiveTo)
  ) {
    throw new TypeError("pricing is not effective for the model request time");
  }

  assertPricingBandForRequest(pricing, input.requestStartedAt);

  const { usage } = input;
  const rateEntries = [
    [usage.uncachedInputTokens, pricing.uncachedInputPerMillion],
    [usage.cacheReadTokens, pricing.cacheReadPerMillion],
    [usage.cacheWriteTokens, pricing.cacheWritePerMillion],
    [usage.outputTokens, pricing.outputPerMillion],
  ] as const;
  const parsedRates = rateEntries.map(([tokens, rate]) => ({
    tokens: BigInt(tokens),
    ...parseNonNegativeDecimal(rate),
  }));
  const rateScale = Math.max(...parsedRates.map((entry) => entry.scale));
  const coefficient = parsedRates.reduce(
    (total, entry) =>
      total +
      entry.tokens *
        entry.coefficient *
        powerOfTen(rateScale - entry.scale),
    0n,
  );
  const amount = formatFixedPoint(
    coefficient,
    rateScale + PRICING_UNIT_SCALE,
    COST_SCALE,
  );

  return Object.freeze({
    pricingVersion: pricing.pricingVersion,
    pricingBand: pricing.pricingBand,
    amount: Object.freeze({
      amount: nonNegativeDecimal(amount),
      currency: pricing.currency,
    }),
  });
}

export function totalBillableTokens(
  usage: ModelTokenUsage,
): TokenCountString {
  return tokenCount(
    (
      BigInt(usage.uncachedInputTokens) +
      BigInt(usage.cacheReadTokens) +
      BigInt(usage.cacheWriteTokens) +
      BigInt(usage.outputTokens)
    ).toString(),
  );
}

export interface ModelBudgetCounters {
  readonly providerRequests: TokenCountString;
  readonly billableTokens: TokenCountString;
  readonly estimatedCost: NonNegativeMoney;
}

export interface ModelDecisionBudget {
  readonly maxProviderRequests: TokenCountString;
  readonly maxBillableTokens: TokenCountString;
  readonly maxEstimatedCost: NonNegativeMoney;
}

export type ModelBudgetViolation =
  | "provider_requests"
  | "billable_tokens"
  | "estimated_cost";

function sumExceedsDecimalLimit(
  left: NonNegativeDecimalString,
  right: NonNegativeDecimalString,
  limit: NonNegativeDecimalString,
): boolean {
  const values = [left, right, limit].map(parseNonNegativeDecimal);
  const scale = Math.max(...values.map((value) => value.scale));
  const [leftValue, rightValue, limitValue] = values.map(
    (value) =>
      value.coefficient * powerOfTen(scale - value.scale),
  );
  return (leftValue ?? 0n) + (rightValue ?? 0n) > (limitValue ?? 0n);
}

/**
 * Fail-closed preflight for the next provider request. `reservation` is the
 * request's worst-case token/cost allowance, not an optimistic average.
 */
export function checkModelBudgetReservation(
  current: ModelBudgetCounters,
  reservation: ModelBudgetCounters,
  budget: ModelDecisionBudget,
): Readonly<{ allowed: boolean; violations: readonly ModelBudgetViolation[] }> {
  if (
    current.estimatedCost.currency !== reservation.estimatedCost.currency ||
    current.estimatedCost.currency !== budget.maxEstimatedCost.currency
  ) {
    throw new TypeError("model budget currencies must match");
  }

  const violations: ModelBudgetViolation[] = [];
  if (
    BigInt(current.providerRequests) + BigInt(reservation.providerRequests) >
    BigInt(budget.maxProviderRequests)
  ) {
    violations.push("provider_requests");
  }
  if (
    BigInt(current.billableTokens) + BigInt(reservation.billableTokens) >
    BigInt(budget.maxBillableTokens)
  ) {
    violations.push("billable_tokens");
  }
  if (
    sumExceedsDecimalLimit(
      current.estimatedCost.amount,
      reservation.estimatedCost.amount,
      budget.maxEstimatedCost.amount,
    )
  ) {
    violations.push("estimated_cost");
  }

  return Object.freeze({
    allowed: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
