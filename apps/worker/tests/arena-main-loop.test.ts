import { describe, expect, it, vi } from "vitest";

import { runArenaWorkerLoop } from "../src/arena-main-loop.js";
import type { ArenaTickResult } from "../src/arena-tick-runner.js";

const result = {
  schema: "twofold.arena_worker_tick/v1",
  workerId: "worker:test",
  capabilities: ["RUN_EVOLUTION_CYCLE"],
  outcome: "completed",
  phaseOutcomes: {
    agent: "idle",
    cycle: "idle",
    market: "idle",
    corporateActionScan: "idle",
    corporateActionAccount: "idle",
    recovery: "idle",
    season: "idle",
    evolution: "completed",
  },
} as const satisfies ArenaTickResult;

describe("long-running Arena worker loop", () => {
  it("runs the composite tick and stops cleanly when shutdown aborts the poll", async () => {
    const controller = new AbortController();
    const tick = vi.fn(async () => {
      controller.abort(new Error("shutdown"));
      return result;
    });
    const onTick = vi.fn();

    await expect(runArenaWorkerLoop({
      runner: { tick },
      pollIntervalMs: 60_000,
      signal: controller.signal,
      onTick,
    })).resolves.toBeUndefined();

    expect(tick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith(result);
  });
});
