import { describe, expect, it } from "vitest";

import {
  boundedProviderSignal,
  PROVIDER_REQUEST_TIMEOUT_MS,
} from "../src/provider-deadline.js";

describe("provider request deadline", () => {
  it("uses one explicit production timeout policy", () => {
    expect(PROVIDER_REQUEST_TIMEOUT_MS).toBe(20_000);
  });

  it("propagates the parent abort without waiting for the provider timeout", () => {
    const parent = new AbortController();
    const reason = new Error("request ended");
    const signal = boundedProviderSignal(parent.signal);

    parent.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it("bounds a hanging provider independently of the parent request", async () => {
    const signal = boundedProviderSignal(undefined, 5);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(() => boundedProviderSignal(undefined, 0)).toThrow(
      "timeoutMilliseconds must be a positive integer",
    );
  });
});
