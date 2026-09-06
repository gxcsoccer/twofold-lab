import { sanitizeFailureMessage } from "./failure-safety.js";

interface AlpacaCredentials {
  readonly apiKeyId: string;
  readonly apiSecretKey: string;
}

/** Classify HTTP and transport failures while retaining only safe diagnostics. */
export class AlpacaRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(context: string, response: Response | null, body: string, credentials: AlpacaCredentials) {
    let detail = "provider returned no JSON error message";
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === "object" && "message" in parsed
        && typeof parsed.message === "string") detail = parsed.message;
    } catch { /* HTML and raw response bodies are not safe diagnostics. */ }
    // A null Response denotes a transport exception, not an HTTP error body.
    if (response === null) detail = body;
    super(sanitizeFailureMessage(
      `Alpaca ${context} request failed ${response === null ? "during transport" : `with HTTP ${response.status}`}; `
      + `requestId=${response?.headers.get("x-request-id") ?? "unavailable"}; ${detail}`,
      { ...process.env, ALPACA_API_KEY_ID: credentials.apiKeyId,
        ALPACA_API_SECRET_KEY: credentials.apiSecretKey },
    ));
    this.name = "AlpacaRequestError";
    this.retryable = response === null || response.status === 408 || response.status === 429 || response.status >= 500;
    this.code = response?.status === 401 || response?.status === 403
      ? "ALPACA_PERMISSION_DENIED"
      : this.retryable ? "ALPACA_TRANSIENT_FAILURE" : "ALPACA_REQUEST_REJECTED";
  }
}

/** Wrap only fetch/body I/O, never JSON validation or evidence derivation. */
export async function withAlpacaTransportErrors<T>(
  context: string,
  credentials: AlpacaCredentials,
  parent: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  parent?.throwIfAborted();
  try {
    const result = await operation();
    parent?.throwIfAborted();
    return result;
  } catch (error) {
    // Parent cancellation is not a retryable provider timeout. Preserve its
    // original reason so the queue continues to record WORKER_ABORTED.
    parent?.throwIfAborted();
    throw new AlpacaRequestError(
      context, null, error instanceof Error ? error.message : String(error), credentials,
    );
  }
}
