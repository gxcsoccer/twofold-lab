const BASE_SYMBOL_COUNT = 32;
const BASE_MAX_BILLABLE_TOKENS = 120_000;
const BILLABLE_TOKENS_PER_ADDITIONAL_SYMBOL = 2_048;
const ABSOLUTE_MAX_BILLABLE_TOKENS = 512_000;

/**
 * Bound the complete decision tree, not one model call. The frozen packet is
 * replayed through multiple root turns and may also be handed to one research
 * descendant, so its budget grows linearly with the decision surface while a
 * hard ceiling still limits cost and context amplification.
 */
export function arenaDecisionMaxBillableTokens(symbolCount: number): string {
  if (!Number.isSafeInteger(symbolCount) || symbolCount <= 0) {
    throw new TypeError("decision symbol count must be a positive integer");
  }
  return String(Math.min(
    ABSOLUTE_MAX_BILLABLE_TOKENS,
    BASE_MAX_BILLABLE_TOKENS
      + Math.max(0, symbolCount - BASE_SYMBOL_COUNT)
        * BILLABLE_TOKENS_PER_ADDITIONAL_SYMBOL,
  ));
}
