export const MAX_PERSISTED_FAILURE_MESSAGE_LENGTH = 2_000;

const REDACTION = "[REDACTED]";
const TRUNCATION = "...[TRUNCATED]";
const SECRET_ENV_NAME = /(?:^|_)(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)(?:$|_)/;

function secretValues(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  return [...new Set(
    Object.entries(environment)
      .filter(([name, value]) =>
        !name.startsWith("NEXT_PUBLIC_")
        && SECRET_ENV_NAME.test(name)
        && value !== undefined
        && value.length > 0,
      )
      .map(([, value]) => value as string),
  )].sort((left, right) => right.length - left.length);
}

/** Remove ambient credentials before an error reaches a durable projection or GUI. */
export function sanitizeFailureMessage(
  message: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  let safe = message;
  for (const secret of secretValues(environment)) {
    safe = safe.replaceAll(secret, REDACTION);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) safe = safe.replaceAll(encoded, REDACTION);
  }
  if (safe.length <= MAX_PERSISTED_FAILURE_MESSAGE_LENGTH) return safe;
  return `${safe.slice(
    0,
    MAX_PERSISTED_FAILURE_MESSAGE_LENGTH - TRUNCATION.length,
  )}${TRUNCATION}`;
}
