import { sanitizeFailureMessage } from "./failure-safety.js";

/** Persist and return one sanitized reason; never expose the original to either sink. */
export async function persistSafeSubmissionRejection(
  reason: string,
  persist: (safeReason: string) => Promise<void>,
): Promise<{ readonly status: "rejected"; readonly reason: string }> {
  const safeReason = sanitizeFailureMessage(reason);
  await persist(safeReason);
  return { status: "rejected", reason: safeReason };
}
