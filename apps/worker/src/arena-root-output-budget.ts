const BASE_SYMBOL_COUNT = 32;
const BASE_MAX_TOKENS = 8_192;
const TOKENS_PER_ADDITIONAL_SYMBOL = 128;
const ABSOLUTE_MAX_TOKENS = 32_768;

/**
 * Give a larger frozen decision surface proportionally more reasoning room,
 * while keeping one hard provider/output bound for every Arena entrant.
 */
export function arenaRootMaxTokens(symbolCount: number): number {
  if (!Number.isSafeInteger(symbolCount) || symbolCount <= 0) {
    throw new TypeError("decision symbol count must be a positive integer");
  }
  return Math.min(
    ABSOLUTE_MAX_TOKENS,
    BASE_MAX_TOKENS
      + Math.max(0, symbolCount - BASE_SYMBOL_COUNT)
        * TOKENS_PER_ADDITIONAL_SYMBOL,
  );
}
