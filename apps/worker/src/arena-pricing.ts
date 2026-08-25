import {
  defineModelPricing,
  estimateModelCost,
  tokenCount,
} from "@twofold/core";

import type { ArenaCostQuote } from "./arena-budget.js";

export interface ArenaPricingRow {
  readonly pricing_id: string;
  readonly pricing_version: string;
  readonly pricing_band: string;
  readonly selection_rule: string;
  readonly provider: string;
  readonly model: string;
  readonly currency: string;
  readonly unit_tokens: string | number;
  readonly uncached_input_rate: string | number;
  readonly cache_read_rate: string | number;
  readonly cache_write_rate: string | number;
  readonly output_rate: string | number;
  readonly effective_from: string;
  readonly effective_to: string | null;
}

export function quoteArenaAttempt(input: {
  readonly row: ArenaPricingRow;
  readonly provider: string;
  readonly model: string;
  readonly requestStartedAt: string;
  readonly maxInputTokens: string;
  readonly maxOutputTokens: string;
}): ArenaCostQuote {
  if (String(input.row.unit_tokens) !== "1000000") {
    throw new TypeError("Arena pricing must use one million token units");
  }
  const pricing = defineModelPricing({
    pricingVersion: input.row.pricing_version,
    pricingBand: input.row.pricing_band,
    selectionRule: input.row.selection_rule,
    provider: input.row.provider,
    model: input.row.model,
    effectiveFrom: input.row.effective_from,
    ...(input.row.effective_to === null
      ? {}
      : { effectiveTo: input.row.effective_to }),
    currency: input.row.currency,
    uncachedInputPerMillion: String(input.row.uncached_input_rate),
    cacheReadPerMillion: String(input.row.cache_read_rate),
    cacheWritePerMillion: String(input.row.cache_write_rate),
    outputPerMillion: String(input.row.output_rate),
  });
  const estimate = estimateModelCost({
    provider: input.provider,
    model: input.model,
    requestStartedAt: input.requestStartedAt,
    usage: {
      uncachedInputTokens: tokenCount(input.maxInputTokens),
      cacheReadTokens: tokenCount("0"),
      cacheWriteTokens: tokenCount("0"),
      outputTokens: tokenCount(input.maxOutputTokens),
    },
  }, pricing);
  if (estimate.amount.currency !== "USD") {
    throw new TypeError("Arena model budget requires USD pricing");
  }
  return Object.freeze({
    pricingId: input.row.pricing_id,
    pricingVersion: estimate.pricingVersion,
    maximumEstimatedCostUsd: estimate.amount.amount,
  });
}
