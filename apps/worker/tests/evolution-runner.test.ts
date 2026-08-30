import { describe, expect, it, vi } from "vitest";

import {
  EvolutionRunner,
  evolutionWindowFor,
  type EvolutionCycleClaim,
  type EvolutionRepository,
} from "../src/evolution-runner.js";

const claim: EvolutionCycleClaim = Object.freeze({
  cycleId: "28ef9bc0-fe77-5d6d-b202-75e0a908c982",
  leaseToken: "bcfa8149-b1f1-55d0-9538-7ae6ddd31d30",
  windowStartedAt: "2026-08-29T18:00:00.000Z",
  windowEndedAt: "2026-08-30T00:00:00.000Z",
  policy: {
    schema: "twofold.evolution_policy/v1",
    analyzerVersion: "twofold-evolution/v1",
    rules: [{
      ruleId: "agent-terminal-failure",
      metricKey: "agent.decision.terminal_failure_rate",
      operator: "GTE",
      threshold: "0.1",
      severity: "HIGH",
      title: "Agent terminal failure rate is elevated",
      diagnosis: "The immutable decision surface exceeds the effective runtime budget.",
      lesson: "Runtime budget must scale with the immutable decision surface.",
      proposedExperimentMode: "LOCAL_REPLAY",
      proposedChangeSurface: "RUNTIME_BUDGET",
    }],
  } as const,
});

function repository(overrides: Partial<EvolutionRepository> = {}): EvolutionRepository {
  return {
    request: vi.fn(async () => undefined),
    claim: vi.fn(async () => claim),
    collect: vi.fn(async () => [Object.freeze({
      metricKey: "agent.decision.terminal_failure_rate",
      scope: "AGENT" as const,
      subject: "twofold-orchestrator",
      value: "0.25",
      unit: "RATIO" as const,
      sampleCount: "4",
      evidenceRefs: ["arena_work:one"],
    })]),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("scheduled evolution runner", () => {
  it("uses the latest fully closed six-hour UTC window", () => {
    expect(evolutionWindowFor(new Date("2026-08-30T06:04:59.999Z"))).toEqual({
      startedAt: "2026-08-29T18:00:00.000Z",
      endedAt: "2026-08-30T00:00:00.000Z",
      idempotencyKey: "evolution:6h:2026-08-30T00:00:00.000Z",
    });
    expect(evolutionWindowFor(new Date("2026-08-30T06:05:00.000Z"))).toEqual({
      startedAt: "2026-08-30T00:00:00.000Z",
      endedAt: "2026-08-30T06:00:00.000Z",
      idempotencyKey: "evolution:6h:2026-08-30T06:00:00.000Z",
    });
  });

  it("harvests, analyzes and persists findings under one lease", async () => {
    const store = repository();
    const runner = new EvolutionRunner({
      workerId: "worker:test",
      repository: store,
      now: () => new Date("2026-08-30T06:06:00.000Z"),
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("completed");
    expect(store.request).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "evolution:6h:2026-08-30T06:00:00.000Z",
    }));
    expect(store.collect).toHaveBeenCalledWith({
      windowStartedAt: claim.windowStartedAt,
      windowEndedAt: claim.windowEndedAt,
    });
    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({
      cycleId: claim.cycleId,
      leaseToken: claim.leaseToken,
      report: expect.objectContaining({
        schema: "twofold.evolution_analysis/v1",
        observationCount: "1",
        findings: [expect.objectContaining({
          proposedChangeSurface: "RUNTIME_BUDGET",
        })],
      }),
    }));
  });

  it("is idle when another worker owns every due cycle", async () => {
    const store = repository({ claim: vi.fn(async () => null) });
    const runner = new EvolutionRunner({ workerId: "worker:test", repository: store });
    await expect(runner.tick(new AbortController().signal)).resolves.toBe("idle");
    expect(store.collect).not.toHaveBeenCalled();
  });

  it("records a bounded failure before surfacing a failed phase", async () => {
    const store = repository({ collect: vi.fn(async () => { throw new Error("db down"); }) });
    const runner = new EvolutionRunner({ workerId: "worker:test", repository: store });
    await expect(runner.tick(new AbortController().signal)).resolves.toBe("failed");
    expect(store.fail).toHaveBeenCalledWith(expect.objectContaining({
      cycleId: claim.cycleId,
      errorCode: "EVOLUTION_ANALYSIS_FAILED",
      errorMessage: "db down",
    }));
  });
});
