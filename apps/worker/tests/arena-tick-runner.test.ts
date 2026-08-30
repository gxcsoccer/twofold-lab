import { describe, expect, it, vi } from "vitest";

import { ArenaTickRunner } from "../src/arena-tick-runner.js";

type TickOutcome = "idle" | "completed" | "failed";

function phase(
  name: string,
  calls: string[],
  outcome: TickOutcome = "idle",
) {
  return {
    tick: vi.fn(async () => {
      calls.push(name);
      return outcome;
    }),
  };
}

describe("Arena tick orchestration", () => {
  it("reconciles global and account corporate actions before contestant work", async () => {
    const calls: string[] = [];
    const runner = new ArenaTickRunner({
      workerId: "worker:test",
      agent: phase("agent", calls),
      cycle: phase("cycle", calls),
      market: phase("market", calls),
      corporateActionScan: phase("scan", calls, "completed"),
      corporateActionAccount: phase("account", calls, "completed"),
      recovery: phase("recovery", calls),
      season: phase("season", calls),
      evolution: phase("evolution", calls, "completed"),
      hasAgentCapability: true,
    });

    const result = await runner.tick(new AbortController().signal);

    expect(calls.slice(0, 2)).toEqual(["scan", "account"]);
    expect(calls.slice(2).sort()).toEqual([
      "agent", "cycle", "evolution", "market", "recovery", "season",
    ]);
    expect(result).toMatchObject({
      schema: "twofold.arena_worker_tick/v1",
      workerId: "worker:test",
      outcome: "completed",
      phaseOutcomes: {
        corporateActionScan: "completed",
        corporateActionAccount: "completed",
      },
    });
    expect(result.capabilities).toContain("RUN_AGENT_DECISION");
  });

  it("reports one fail-closed phase without hiding successful shared work", async () => {
    const calls: string[] = [];
    const runner = new ArenaTickRunner({
      workerId: "worker:test",
      agent: phase("agent", calls),
      cycle: phase("cycle", calls),
      market: phase("market", calls, "completed"),
      corporateActionScan: phase("scan", calls),
      corporateActionAccount: phase("account", calls, "failed"),
      recovery: phase("recovery", calls),
      season: phase("season", calls),
      evolution: phase("evolution", calls),
      hasAgentCapability: false,
    });

    const result = await runner.tick(new AbortController().signal);

    expect(result.outcome).toBe("failed");
    expect(result.phaseOutcomes.market).toBe("completed");
    expect(result.capabilities).not.toContain("RUN_AGENT_DECISION");
  });

  it("renews liveness before work and records the complete eight-phase result", async () => {
    const calls: string[] = [];
    const heartbeat = vi.fn(async () => { calls.push("heartbeat"); });
    const record = vi.fn(async () => { calls.push("record"); });
    const times = [
      new Date("2026-08-29T08:50:00.000Z"),
      new Date("2026-08-29T08:50:01.250Z"),
    ];
    const runner = new ArenaTickRunner({
      workerId: "worker:test",
      agent: phase("agent", calls),
      cycle: phase("cycle", calls),
      market: phase("market", calls),
      corporateActionScan: phase("scan", calls),
      corporateActionAccount: phase("account", calls),
      recovery: phase("recovery", calls),
      season: phase("season", calls),
      evolution: phase("evolution", calls),
      hasAgentCapability: true,
      observer: { heartbeat, record },
      now: () => times.shift()!,
    });

    const result = await runner.tick(new AbortController().signal);

    expect(calls[0]).toBe("heartbeat");
    expect(calls.at(-1)).toBe("record");
    expect(heartbeat).toHaveBeenCalledWith({
      workerId: "worker:test",
      capabilities: result.capabilities,
    });
    expect(record).toHaveBeenCalledWith({
      startedAt: "2026-08-29T08:50:00.000Z",
      finishedAt: "2026-08-29T08:50:01.250Z",
      result,
    });
    expect(Object.keys(result.phaseOutcomes)).toHaveLength(8);
    expect(result.capabilities).toContain("RUN_EVOLUTION_CYCLE");
  });
});
