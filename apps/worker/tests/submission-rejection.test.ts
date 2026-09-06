import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_PERSISTED_FAILURE_MESSAGE_LENGTH } from "../src/failure-safety.js";
import { persistSafeSubmissionRejection } from "../src/submission-rejection.js";

afterEach(() => vi.unstubAllEnvs());

describe("submission rejection safety", () => {
  it("persists and returns the same redacted reason, including encoded credentials", async () => {
    const secret = "test-private/key+value";
    vi.stubEnv("SUPABASE_SECRET_KEY", secret);
    const persist = vi.fn(async (_reason: string) => undefined);

    const result = await persistSafeSubmissionRejection(
      `Rejected: ${secret}; encoded: ${encodeURIComponent(secret)}`, persist,
    );

    expect(result).toEqual({
      status: "rejected", reason: "Rejected: [REDACTED]; encoded: [REDACTED]",
    });
    expect(persist).toHaveBeenCalledExactlyOnceWith(result.reason);
    expect(JSON.stringify([result, persist.mock.calls])).not.toContain(secret);
    expect(JSON.stringify([result, persist.mock.calls])).not.toContain(encodeURIComponent(secret));
  });

  it("uses the same length-limited reason for storage and the caller", async () => {
    const persist = vi.fn(async (_reason: string) => undefined);
    const result = await persistSafeSubmissionRejection("x".repeat(4_000), persist);
    expect(result.reason).toHaveLength(MAX_PERSISTED_FAILURE_MESSAGE_LENGTH);
    expect(result.reason).toMatch(/\.\.\.\[TRUNCATED\]$/);
    expect(persist).toHaveBeenCalledExactlyOnceWith(result.reason);
  });

  it("preserves ordinary rejection messages", async () => {
    const persist = vi.fn(async (_reason: string) => undefined);
    await expect(persistSafeSubmissionRejection("Decision is closed", persist))
      .resolves.toEqual({ status: "rejected", reason: "Decision is closed" });
    expect(persist).toHaveBeenCalledExactlyOnceWith("Decision is closed");
  });

  it("does not report a recorded rejection if persistence fails", async () => {
    const failure = new Error("storage unavailable");
    await expect(persistSafeSubmissionRejection("Decision is closed", async () => {
      throw failure;
    })).rejects.toBe(failure);
  });
});
