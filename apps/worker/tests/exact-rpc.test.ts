import { describe, expect, it, vi } from "vitest";

import {
  hasAmbiguousRpcOutcome,
  retryExactRpcOnce,
} from "../src/exact-rpc.js";

describe("exact RPC retry", () => {
  it("replays one ambiguous transport outcome with the same invocation", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "fetch failed" }, status: 0 })
      .mockResolvedValueOnce({ data: [{ event_id: "event-1" }], error: null, status: 200 });

    await expect(retryExactRpcOnce(invoke)).resolves.toMatchObject({
      error: null,
      status: 200,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("recovers when the first client promise rejects after an unknown outcome", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error("socket closed before response"))
      .mockResolvedValueOnce({
        data: [{ event_id: "event-1" }],
        error: null,
        status: 200,
      });

    await expect(retryExactRpcOnce(invoke)).resolves.toMatchObject({
      error: null,
      status: 200,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not retry a deterministic database rejection", async () => {
    const result = {
      data: null,
      error: { message: "stream head conflict" },
      status: 409,
    };
    const invoke = vi.fn().mockResolvedValue(result);

    await expect(retryExactRpcOnce(invoke)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not mistake PostgREST's HTTP 500 mapping for ledger CAS as transport ambiguity", async () => {
    const result = {
      data: null,
      error: { code: "40001", message: "strategy ledger head compare-and-swap failed" },
      status: 500,
    };
    const invoke = vi.fn().mockResolvedValue(result);

    await expect(retryExactRpcOnce(invoke)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(hasAmbiguousRpcOutcome(result)).toBe(false);
  });

  it("never performs more than one exact retry", async () => {
    const result = {
      data: null,
      error: { message: "gateway unavailable" },
      status: 503,
    };
    const invoke = vi.fn().mockResolvedValue(result);

    await expect(retryExactRpcOnce(invoke)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(hasAmbiguousRpcOutcome(result)).toBe(true);
  });
});
