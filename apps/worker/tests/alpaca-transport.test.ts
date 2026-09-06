import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAlpacaDailyBars, loadAlpacaMarketDataConfig } from "../src/market-data.js";
import { fetchAlpacaOpenReferences, loadAlpacaOpenReferenceConfig } from "../src/alpaca-open-reference.js";
import { AlpacaRequestError } from "../src/alpaca-request-error.js";
import { ArenaWorkRunner } from "../src/arena-work-runner.js";
import type { ArenaWorkItem } from "../src/arena-work-repository.js";

const secret = "transport-test/secret+value";
const environment = { ALPACA_API_KEY_ID: "transport-test-key", ALPACA_API_SECRET_KEY: secret };
const now = () => new Date("2026-08-31T20:21:00.000Z");
const adapters = [
  { name: "daily bars", run: (fetchImplementation: typeof fetch, signal?: AbortSignal) =>
    fetchAlpacaDailyBars(loadAlpacaMarketDataConfig(environment), {
      fetchImplementation, now, ...(signal ? { signal } : {}),
    }) },
  { name: "open references", run: (fetchImplementation: typeof fetch, signal?: AbortSignal) =>
    fetchAlpacaOpenReferences(loadAlpacaOpenReferenceConfig(environment), {
      sessionDate: "2026-08-31", expectedOpenAt: "2026-08-31T13:30:00.000Z",
      availableAt: "2026-08-31T13:32:00.000Z", fetchImplementation, now,
      ...(signal ? { signal } : {}),
    }) },
];

afterEach(() => vi.restoreAllMocks());

describe.each(adapters)("$name transport failures", ({ run }) => {
  it.each(["fetch", "body"])("retains redacted nested root causes for %s failures", async (stage) => {
    const root = Object.assign(new Error(`lookup failed ${secret} ${encodeURIComponent(secret)}`), { code: "ENOTFOUND" });
    const fail = async (): Promise<never> => { throw new TypeError("fetch failed", { cause: root }); };
    const error = await run(async () => {
      if (stage === "fetch") return fail();
      const response = new Response("");
      vi.spyOn(response, "text").mockImplementation(fail);
      return response;
    }).catch((cause: unknown) => cause) as AlpacaRequestError;
    expect(error).toMatchObject({ code: "ALPACA_TRANSIENT_FAILURE", retryable: true });
    expect(error.message).toContain("ENOTFOUND");
    expect(error.message).toContain("lookup failed");
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(encodeURIComponent(secret));
    expect(error.cause).toBeUndefined();
  });

  it("bounds cyclic aggregate causes while retaining connection codes", async () => {
    const root = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const aggregate = new AggregateError([root], "connection attempts failed");
    root.cause = aggregate;
    const error = await run(async () => {
      throw new TypeError("fetch failed", { cause: aggregate });
    }).catch((cause: unknown) => cause) as AlpacaRequestError;
    expect(error.message).toContain("ECONNREFUSED");
    expect(error.message.length).toBeLessThanOrEqual(2_000);
  });

  it("bounds and redacts oversized nested diagnostics", async () => {
    const error = await run(async () => {
      throw new TypeError("fetch failed", { cause: new Error(`${secret} ${"x".repeat(5_000)}`) });
    }).catch((cause: unknown) => cause) as AlpacaRequestError;
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain(secret);
    expect(error.message.length).toBeLessThanOrEqual(2_000);
  });

  it.each([200, 400, 401, 403, 408, 429, 503])("preserves HTTP %s classification and request ID after a body failure", async (status) => {
    const error = await run(async () => {
      const response = new Response("", { status, headers: { "x-request-id": "body-request" } });
      vi.spyOn(response, "text").mockRejectedValue(new Error("stream terminated", {
        cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
      }));
      return response;
    }).catch((cause: unknown) => cause) as AlpacaRequestError;
    const retryable = [200, 408, 429, 503].includes(status);
    expect(error).toMatchObject({ retryable, code: status === 401 || status === 403
      ? "ALPACA_PERMISSION_DENIED" : retryable ? "ALPACA_TRANSIENT_FAILURE" : "ALPACA_REQUEST_REJECTED" });
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).toContain("requestId=body-request");
    expect(error.message).toContain("ECONNRESET");
  });

  it("gives parent cancellation precedence over a failed permission-response body", async () => {
    const parent = new AbortController();
    const reason = new Error("worker stopped");
    await expect(run(async () => {
      const response = new Response("", { status: 403 });
      vi.spyOn(response, "text").mockImplementation(async () => {
        parent.abort(reason);
        throw new Error("stream terminated");
      });
      return response;
    }, parent.signal)).rejects.toBe(reason);
  });

  it.each(["fetch", "body"])("classifies and redacts a %s failure", async (stage) => {
    const fail = () => { throw new TypeError(`socket failed ${secret} ${encodeURIComponent(secret)}`); };
    const fetchImplementation = vi.fn(async () => {
      if (stage === "fetch") fail();
      const response = new Response("", { headers: { "content-type": "application/json" } });
      vi.spyOn(response, "text").mockImplementation(async () => fail());
      return response;
    });
    const error = await run(fetchImplementation).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AlpacaRequestError);
    expect(error).toMatchObject({ code: "ALPACA_TRANSIENT_FAILURE", retryable: true });
    expect((error as Error).message).toContain("socket failed");
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error).message).not.toContain(encodeURIComponent(secret));
  });

  it.each(["fetch", "body"])("retries the provider timeout during %s without aborting the parent", async (stage) => {
    const timeout = new AbortController();
    const parent = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetchImplementation: typeof fetch = async (_url, init) => {
      const waitForTimeout = () => new Promise<never>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
        timeout.abort(new DOMException("provider deadline", "TimeoutError"));
      });
      if (stage === "fetch") return waitForTimeout();
      const response = new Response("");
      vi.spyOn(response, "text").mockImplementation(waitForTimeout);
      return response;
    };
    await expect(run(fetchImplementation, parent.signal)).rejects.toMatchObject({
      code: "ALPACA_TRANSIENT_FAILURE", retryable: true,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(20_000);
    expect(parent.signal.aborted).toBe(false);
  });

  it.each(["fetch", "body"])("preserves parent cancellation during %s", async (stage) => {
    const parent = new AbortController();
    const reason = new Error("worker stopped");
    const abort = async (): Promise<never> => { parent.abort(reason); throw reason; };
    const fetchImplementation: typeof fetch = async () => {
      if (stage === "fetch") return abort();
      const response = new Response("");
      vi.spyOn(response, "text").mockImplementation(abort);
      return response;
    };
    await expect(run(fetchImplementation, parent.signal)).rejects.toBe(reason);
  });

  it("does not start a request after parent cancellation", async () => {
    const parent = new AbortController();
    const reason = new Error("worker already stopped");
    parent.abort(reason);
    const fetchImplementation = vi.fn(async () => new Response("{}"));
    await expect(run(fetchImplementation, parent.signal)).rejects.toBe(reason);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("does not misclassify invalid provider JSON as a transport failure", async () => {
    const error = await run(async () => new Response("invalid json", {
      headers: { "content-type": "application/json" },
    })).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AlpacaRequestError);
  });

  it.each([false, true])("completes queue work with the correct retry policy (parent aborted: %s)", async (aborted) => {
    const parent = new AbortController();
    const complete = vi.fn(async () => undefined);
    const runner = new ArenaWorkRunner({ workerId: "test-worker", leaseSeconds: 60, now,
      queue: { complete, claim: async () => ({
        workItemId: "work", leaseToken: "lease", phase: "CAPTURE_S1_CLOSE", deadlineAt: null,
      }) as ArenaWorkItem },
      handlers: { CAPTURE_S1_CLOSE: async (_item, signal) => {
        await run(async () => {
          if (aborted) parent.abort(new Error("worker stopped"));
          throw new TypeError("DNS lookup failed");
        }, signal);
        return {};
      } },
    });
    await expect(runner.tick(parent.signal)).resolves.toBe("failed");
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: aborted ? "WORKER_ABORTED" : "ALPACA_TRANSIENT_FAILURE",
      retryable: !aborted,
    }));
  });
});
