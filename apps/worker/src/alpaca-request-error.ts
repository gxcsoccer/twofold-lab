import { sanitizeFailureMessage } from "./failure-safety.js";

interface AlpacaCredentials {
  readonly apiKeyId: string;
  readonly apiSecretKey: string;
}

/** Classify HTTP and transport failures while retaining only safe diagnostics. */
export class AlpacaRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(context: string, response: Response | null, body: string, credentials: AlpacaCredentials,
    transportFailure = false) {
    let detail = "provider returned no JSON error message";
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === "object" && "message" in parsed
        && typeof parsed.message === "string") detail = parsed.message;
    } catch { /* HTML and raw response bodies are not safe diagnostics. */ }
    // Transport diagnostics are extracted separately from untrusted HTTP bodies.
    if (response === null || transportFailure) detail = body;
    super(sanitizeFailureMessage(
      `Alpaca ${context} request failed ${response === null ? "during transport" : `with HTTP ${response.status}`}; `
      + `requestId=${response?.headers.get("x-request-id") ?? "unavailable"}; ${detail}`,
      { ...process.env, ALPACA_API_KEY_ID: credentials.apiKeyId,
        ALPACA_API_SECRET_KEY: credentials.apiSecretKey },
    ));
    this.name = "AlpacaRequestError";
    this.retryable = response === null || (transportFailure && response.ok)
      || response.status === 408 || response.status === 429 || response.status >= 500;
    this.code = response?.status === 401 || response?.status === 403
      ? "ALPACA_PERMISSION_DENIED"
      : this.retryable ? "ALPACA_TRANSIENT_FAILURE" : "ALPACA_REQUEST_REJECTED";
  }
}

/** Copy only diagnostic fields, never retain the original (possibly secret) cause. */
function transportDiagnostic(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (seen.has(value) || seen.size >= 8) return;
    seen.add(value);
    if (value !== null && typeof value === "object") {
      const code = "code" in value && typeof value.code === "string" ? value.code : "";
      const message = "message" in value && typeof value.message === "string" ? value.message : "";
      parts.push([code, message].filter(Boolean).join(": "));
      if ("cause" in value) visit(value.cause);
      if (value instanceof AggregateError) {
        for (const nested of value.errors.slice(0, 8)) visit(nested);
      }
    } else if (value !== undefined) {
      parts.push(String(value));
    }
  };
  visit(error);
  // The constructor redacts before truncating, so secrets cannot be partially exposed.
  return parts.filter(Boolean).join("; caused by: ") || "unknown transport failure";
}

/** Wrap only fetch/body I/O, never JSON validation or evidence derivation. */
export async function withAlpacaTransportErrors<T>(
  context: string,
  credentials: AlpacaCredentials,
  parent: AbortSignal | undefined,
  operation: () => Promise<T>,
  response: Response | null = null,
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
      context, response, transportDiagnostic(error), credentials, true,
    );
  }
}
