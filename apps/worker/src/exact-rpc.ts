export interface RpcResultLike {
  error: { message: string; code?: string } | null;
  status: number;
}

/**
 * A status-zero PostgREST result means the client never received a response.
 * Gateway timeouts, throttling, and server errors are similarly ambiguous for
 * a mutating RPC. Callers must therefore reuse byte-for-byte-equivalent,
 * idempotency-fenced arguments when this helper invokes them a second time.
 */
export function hasAmbiguousRpcOutcome(result: RpcResultLike): boolean {
  // PostgREST maps PostgreSQL class 40 errors to HTTP 500. In this system,
  // 40001 is also the explicit ledger-head CAS failure and must be surfaced so
  // the caller reloads the head; replaying the stale request cannot succeed.
  if (result.error?.code === "40001") return false;
  return result.error !== null
    && (
      result.status === 0
      || result.status === 408
      || result.status === 425
      || result.status === 429
      || result.status >= 500
    );
}

export async function retryExactRpcOnce<T extends RpcResultLike>(
  invoke: () => PromiseLike<T>,
): Promise<T> {
  let first: T;
  try {
    first = await invoke();
  } catch {
    // A rejected fetch is indistinguishable from a response lost after the
    // database committed. Exact idempotency is therefore the recovery fence.
    return await invoke();
  }
  if (!hasAmbiguousRpcOutcome(first)) return first;
  return await invoke();
}
