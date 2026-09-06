import { sanitizeFailureMessage } from "./failure-safety.js";

/** A provider rejection is not a network failure. Keep safe diagnostics, not credentials. */
export class AlpacaRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(context: string, response: Response, body: string, credentials: {
    readonly apiKeyId: string; readonly apiSecretKey: string;
  }) {
    let detail = "provider returned no JSON error message";
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === "object" && "message" in parsed
        && typeof parsed.message === "string") detail = parsed.message;
    } catch { /* HTML and raw response bodies are not safe diagnostics. */ }
    super(sanitizeFailureMessage(
      `Alpaca ${context} request failed with HTTP ${response.status}; `
      + `requestId=${response.headers.get("x-request-id") ?? "unavailable"}; ${detail}`,
      { ...process.env, ALPACA_API_KEY_ID: credentials.apiKeyId,
        ALPACA_API_SECRET_KEY: credentials.apiSecretKey },
    ));
    this.name = "AlpacaRequestError";
    this.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    this.code = response.status === 401 || response.status === 403
      ? "ALPACA_PERMISSION_DENIED"
      : this.retryable ? "ALPACA_TRANSIENT_FAILURE" : "ALPACA_REQUEST_REJECTED";
  }
}
