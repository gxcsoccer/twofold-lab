import { describe, expect, it } from "vitest";

import { parseArenaOperationalHealth } from "./arena-health";

const healthy = Object.freeze({
  schema: "twofold.arena_operational_health/v1",
  checkedAt: "2026-08-29T09:00:00.000Z",
  ok: true,
  worker: {
    workerId: "twofold-vercel-arena",
    lastTickAt: "2026-08-29T08:59:01.250Z",
    lastOutcome: "idle",
    heartbeatAt: "2026-08-29T08:59:00.000Z",
    leaseExpiresAt: "2026-08-29T09:02:00.000Z",
    live: true,
  },
  activeSeasonCode: "private-controlled-lab-s1",
  latestCorporateActionScanAt: "2026-08-29T08:55:00.000Z",
  alerts: [],
});

describe("Arena operational health", () => {
  it("accepts the exact number-free private health contract", () => {
    expect(parseArenaOperationalHealth(healthy)).toEqual(healthy);
  });

  it("rejects an ok value that hides a critical alert", () => {
    expect(() => parseArenaOperationalHealth({
      ...healthy,
      alerts: [{
        code: "TICK_STALE",
        severity: "critical",
        detail: "The latest tick is stale.",
      }],
    })).toThrow("ok must match alerts");
  });

  it("rejects JSON numbers and unexpected fields", () => {
    expect(() => parseArenaOperationalHealth({
      ...healthy,
      ageSeconds: 30,
    })).toThrow();
  });
});
