export const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Bound external market/reference providers independently of the outer Worker
 * request. The parent still wins immediately on shutdown or platform abort.
 */
export function boundedProviderSignal(
  parent: AbortSignal | undefined,
  timeoutMilliseconds = PROVIDER_REQUEST_TIMEOUT_MS,
): AbortSignal {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new TypeError("timeoutMilliseconds must be a positive integer");
  }
  const timeout = AbortSignal.timeout(timeoutMilliseconds);
  return parent === undefined
    ? timeout
    : AbortSignal.any([parent, timeout]);
}
