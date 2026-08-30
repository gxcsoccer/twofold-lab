import { describe, expect, it, vi } from "vitest";

import { handleArenaCronRequest } from "./arena-cron.js";

const outcome = {
  schema: "twofold.arena_worker_tick/v1" as const,
  workerId: "worker:vercel",
  capabilities: [],
  outcome: "idle" as const,
  phaseOutcomes: {
    agent: "idle" as const,
    cycle: "idle" as const,
    market: "idle" as const,
    corporateActionScan: "idle" as const,
    corporateActionAccount: "idle" as const,
    recovery: "idle" as const,
    season: "idle" as const,
  },
};

describe("Arena cron HTTP boundary", () => {
  it("rejects missing or wrong bearer credentials before constructing a runner", async () => {
    const tick = vi.fn();
    const createRunner = vi.fn(() => ({ tick }));
    const response = await handleArenaCronRequest(
      new Request("https://example.test/api/arena/tick"),
      { cronSecret: "private-secret-123", createRunner },
    );

    expect(response.status).toBe(401);
    expect(createRunner).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });

  it("returns only the sanitized tick result and disables caching", async () => {
    const tick = vi.fn(async () => outcome);
    const response = await handleArenaCronRequest(
      new Request("https://example.test/api/arena/tick", {
        headers: { authorization: "Bearer private-secret-123" },
      }),
      {
        cronSecret: "private-secret-123",
        createRunner: () => ({ tick }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(outcome);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("normalizes accidental surrounding whitespace in the configured secret", async () => {
    const tick = vi.fn(async () => outcome);
    const response = await handleArenaCronRequest(
      new Request("https://example.test/api/arena/tick", {
        headers: { authorization: "Bearer private-secret-123" },
      }),
      {
        cronSecret: "  private-secret-123\n",
        createRunner: () => ({ tick }),
      },
    );

    expect(response.status).toBe(200);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("makes a fail-closed phase observable to the scheduler", async () => {
    const failed = { ...outcome, outcome: "failed" as const };
    const response = await handleArenaCronRequest(
      new Request("https://example.test/api/arena/tick", {
        headers: { authorization: "Bearer private-secret-123" },
      }),
      {
        cronSecret: "private-secret-123",
        createRunner: () => ({ tick: vi.fn(async () => failed) }),
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(failed);
  });
});
