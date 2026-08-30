import { describe, expect, it, vi } from "vitest";

import {
  getArenaStartGate,
  type ArenaRoundReadiness,
} from "../src/arena-round-readiness-repository.js";

const ROUND_ID = "9f96b47b-ae3d-40d3-9a63-52d88ce50bf6";

function readiness(
  overrides: Partial<ArenaRoundReadiness> = {},
): ArenaRoundReadiness {
  return {
    schema: "twofold.arena_round_readiness/v1",
    checkedAt: "2026-08-29T10:14:45.668Z",
    status: "READY_FOR_S1",
    readyForS1: true,
    seasonId: "286387f5-c8b8-5b50-98c5-6cf6027e547f",
    seasonCode: "private-controlled-lab-s1",
    roundId: ROUND_ID,
    roundIndex: "1",
    evidence: {
      rulebookCount: "1",
      genesisCount: "1",
      entrantCount: "2",
      initializedAccountCount: "2",
      ledgerHeadCount: "2",
      universeMemberCount: "3",
      roundEntryCount: "2",
      workItemCount: "16",
      acceptedDecisionCount: "2",
      frozenS1PlanCount: "2",
      preparedS1ResultCount: "2",
      successfulPreS1WorkCount: "4",
    },
    blockers: [],
    ...overrides,
  };
}

function health(overrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.arena_operational_health/v1",
    checkedAt: "2026-08-29T10:14:45.668Z",
    ok: true,
    worker: {
      workerId: "twofold-vercel-arena",
      lastTickAt: "2026-08-29T10:14:08.686Z",
      lastOutcome: "idle",
      heartbeatAt: "2026-08-29T10:14:06.986Z",
      leaseExpiresAt: "2026-08-29T10:17:06.986Z",
      live: true,
    },
    activeSeasonCode: "private-controlled-lab-s1",
    latestCorporateActionScanAt: "2026-08-29T10:06:06.554Z",
    alerts: [],
    ...overrides,
  };
}

function client(round: unknown, operationalHealth: unknown) {
  return {
    rpc: vi.fn(async (name: string) => ({
      data: name === "get_arena_round_readiness" ? round : operationalHealth,
      error: null,
      status: 200,
    })),
  };
}

describe("Arena Round readiness repository", () => {
  it("combines immutable Round readiness with dynamic Worker health", async () => {
    const rpc = client(readiness(), health());

    await expect(getArenaStartGate(rpc, {
      roundId: ROUND_ID,
      workerId: "twofold-vercel-arena",
    })).resolves.toMatchObject({
      schema: "twofold.arena_start_gate/v1",
      ready: true,
      round: { status: "READY_FOR_S1", readyForS1: true },
      operations: { ok: true },
    });
    expect(rpc.rpc).toHaveBeenCalledWith("get_arena_round_readiness", {
      p_round_id: ROUND_ID,
    });
    expect(rpc.rpc).toHaveBeenCalledWith("get_arena_operational_health", {
      p_worker_id: "twofold-vercel-arena",
    });
  });

  it("fails the start gate when either static or dynamic evidence is unhealthy", async () => {
    const blocked = readiness({
      status: "BLOCKED",
      readyForS1: false,
      blockers: [{
        code: "S1_PLANS_INCOMPLETE",
        detail: "Every accepted decision must have a successful immutable S1 plan before open.",
      }],
    });
    const unhealthy = health({
      ok: false,
      alerts: [{
        code: "TICK_STALE",
        severity: "critical",
        detail: "The latest Arena tick is stale.",
      }],
    });

    await expect(getArenaStartGate(client(blocked, health()), {
      roundId: ROUND_ID,
      workerId: "twofold-vercel-arena",
    })).resolves.toMatchObject({ ready: false });
    await expect(getArenaStartGate(client(readiness({
      status: "BLOCKED",
      readyForS1: false,
      blockers: [{
        code: "ROUND_TICK_CAPACITY_INSUFFICIENT",
        detail: "The frozen cadence cannot drain before its deadlines.",
      }],
    }), health()), {
      roundId: ROUND_ID,
      workerId: "twofold-vercel-arena",
    })).resolves.toMatchObject({ ready: false });
    await expect(getArenaStartGate(client(readiness(), unhealthy), {
      roundId: ROUND_ID,
      workerId: "twofold-vercel-arena",
    })).resolves.toMatchObject({ ready: false });

    await expect(getArenaStartGate(client(readiness(), health({
      worker: { ...health().worker, live: false },
    })), {
      roundId: ROUND_ID,
      workerId: "twofold-vercel-arena",
    })).resolves.toMatchObject({ ready: false });
  });

  it("rejects count contradictions, schema drift, and JSON numeric tokens", async () => {
    for (const invalid of [
      readiness({ evidence: { ...readiness().evidence, workItemCount: "15" } }),
      { ...readiness(), unexpected: "field" },
      { ...readiness(), evidence: { ...readiness().evidence, entrantCount: 2 } },
    ]) {
      await expect(getArenaStartGate(client(invalid, health()), {
        roundId: ROUND_ID,
        workerId: "twofold-vercel-arena",
      })).rejects.toThrow();
    }
  });

  it("rejects response identity drift and an ok health value hiding alerts", async () => {
    await expect(getArenaStartGate(client(
      readiness({ roundId: "9f96b47b-ae3d-40d3-9a63-52d88ce50bf7" }),
      health(),
    ), {
      roundId: ROUND_ID,
      workerId: "twofold-vercel-arena",
    })).rejects.toThrow("different Round");

    await expect(getArenaStartGate(client(readiness(), health({
      alerts: [{ code: "TICK_STALE", severity: "critical", detail: "stale" }],
    })), {
      roundId: ROUND_ID,
      workerId: "twofold-vercel-arena",
    })).rejects.toThrow("ok must match alerts");
  });
});
