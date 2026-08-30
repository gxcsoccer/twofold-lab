import { describe, expect, it, vi } from "vitest";

import {
  recordArenaTickObservation,
  renewArenaTickHeartbeat,
  type ArenaTickObservationRpcClient,
} from "../src/arena-tick-observer.js";

const phaseOutcomes = Object.freeze({
  agent: "idle" as const,
  cycle: "completed" as const,
  market: "idle" as const,
  corporateActionScan: "idle" as const,
  corporateActionAccount: "idle" as const,
  recovery: "idle" as const,
  season: "idle" as const,
  evolution: "completed" as const,
});

function client(data: unknown = null): {
  rpc: ReturnType<typeof vi.fn>;
  value: ArenaTickObservationRpcClient;
} {
  const rpc = vi.fn(async () => ({ data, error: null }));
  return { rpc, value: { rpc } as ArenaTickObservationRpcClient };
}

describe("Arena tick observer", () => {
  it("renews a short liveness lease with the exact Arena capabilities", async () => {
    const rpc = client();

    await renewArenaTickHeartbeat(rpc.value, {
      workerId: "worker:test",
      leaseSeconds: 180,
      capabilities: ["CAPTURE_S1_OPEN_REFERENCE", "PROVISION_NEXT_ROUND"],
    });

    expect(rpc.rpc).toHaveBeenCalledWith("renew_worker_lease", {
      p_worker_id: "worker:test",
      p_lease_seconds: 180,
      p_capabilities: {
        schema: "twofold.arena_worker_capabilities/v1",
        arena: ["CAPTURE_S1_OPEN_REFERENCE", "PROVISION_NEXT_ROUND"],
      },
    });
  });

  it("records one exact, number-free eight-phase observation", async () => {
    const response = {
      schema: "twofold.arena_tick_observation/v1",
      tickId: "11111111-1111-4111-8111-111111111111",
      workerId: "worker:test",
      startedAt: "2026-08-29T08:50:00.000Z",
      finishedAt: "2026-08-29T08:50:01.250Z",
      outcome: "completed" as const,
      capabilities: ["CAPTURE_S1_OPEN_REFERENCE"],
      phaseOutcomes,
    };
    const rpc = client(response);

    await recordArenaTickObservation(rpc.value, {
      startedAt: response.startedAt,
      finishedAt: response.finishedAt,
      result: {
        schema: "twofold.arena_worker_tick/v1",
        workerId: response.workerId,
        capabilities: response.capabilities,
        outcome: response.outcome,
        phaseOutcomes,
      },
    });

    expect(rpc.rpc).toHaveBeenCalledWith("register_arena_tick_observation", {
      p_worker_id: response.workerId,
      p_started_at: response.startedAt,
      p_finished_at: response.finishedAt,
      p_outcome: response.outcome,
      p_capabilities: response.capabilities,
      p_phase_outcomes: phaseOutcomes,
    });
    expect(containsJsonNumber(response)).toBe(false);
  });

  it("rejects a response whose immutable identity differs from the request", async () => {
    const rpc = client({
      schema: "twofold.arena_tick_observation/v1",
      tickId: "11111111-1111-4111-8111-111111111111",
      workerId: "worker:other",
      startedAt: "2026-08-29T08:50:00.000Z",
      finishedAt: "2026-08-29T08:50:01.250Z",
      outcome: "completed",
      capabilities: ["CAPTURE_S1_OPEN_REFERENCE"],
      phaseOutcomes,
    });

    await expect(recordArenaTickObservation(rpc.value, {
      startedAt: "2026-08-29T08:50:00.000Z",
      finishedAt: "2026-08-29T08:50:01.250Z",
      result: {
        schema: "twofold.arena_worker_tick/v1",
        workerId: "worker:test",
        capabilities: ["CAPTURE_S1_OPEN_REFERENCE"],
        outcome: "completed",
        phaseOutcomes,
      },
    })).rejects.toThrow("inconsistent identity");
  });
});

function containsJsonNumber(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.some(containsJsonNumber);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsJsonNumber);
  }
  return false;
}
