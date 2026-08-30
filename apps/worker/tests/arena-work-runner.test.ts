import { describe, expect, it, vi } from "vitest";

import type { ArenaWorkItem } from "../src/arena-work-repository.js";
import {
  ArenaTerminalWorkError,
  ArenaWorkRunner,
  type ArenaWorkQueue,
} from "../src/arena-work-runner.js";

function work(): ArenaWorkItem {
  return {
    schema: "twofold.arena_work_item_result/v1",
    workItemId: "a1000000-0000-8000-8000-000000000001",
    roundEntryId: "a2000000-0000-8000-8000-000000000001",
    roundId: "a3000000-0000-4000-8000-000000000001",
    seasonId: "a4000000-0000-4000-8000-000000000001",
    entrantId: "a5000000-0000-4000-8000-000000000001",
    runId: "a6000000-0000-4000-8000-000000000001",
    phase: "CAPTURE_S1_OPEN_REFERENCE",
    predecessorWorkItemId: null,
    scheduledAt: "2026-08-31T13:32:00.000Z",
    deadlineAt: "2026-08-31T20:00:00.000Z",
    nextAttemptAt: "2026-08-31T13:32:00.000Z",
    status: "CLAIMED",
    attemptCount: "1",
    claimedBy: "worker-1",
    leaseToken: "a7000000-0000-4000-8000-000000000001",
    leaseExpiresAt: "2026-08-31T13:33:00.000Z",
    completedAt: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    retryable: null,
  };
}

function queue(item: ArenaWorkItem | null): ArenaWorkQueue {
  return {
    claim: vi.fn(async () => item),
    complete: vi.fn(async () => undefined),
  };
}

describe("Arena work runner", () => {
  it("claims only phases with configured handlers and completes exact output", async () => {
    const repository = queue(work());
    const runner = new ArenaWorkRunner({
      workerId: "worker-1",
      leaseSeconds: 60,
      queue: repository,
      handlers: {
        CAPTURE_S1_OPEN_REFERENCE: vi.fn(async () => ({
          outcome: "SHARED_EVIDENCE_BOUND",
          evidenceId: "evidence-1",
        })),
      },
      now: () => new Date("2026-08-31T13:32:01.000Z"),
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("completed");
    expect(repository.claim).toHaveBeenCalledWith({
      workerId: "worker-1",
      leaseSeconds: 60,
      now: "2026-08-31T13:32:01.000Z",
      allowedPhases: ["CAPTURE_S1_OPEN_REFERENCE"],
    });
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({
      succeeded: true,
      result: {
        outcome: "SHARED_EVIDENCE_BOUND",
        evidenceId: "evidence-1",
      },
      retryable: false,
    }));
  });

  it("does not claim anything when this process has no capabilities", async () => {
    const repository = queue(work());
    const runner = new ArenaWorkRunner({
      workerId: "worker-1",
      leaseSeconds: 60,
      queue: repository,
      handlers: {},
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("idle");
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it("returns a failed lease safely and asks the queue to retry", async () => {
    const repository = queue(work());
    const runner = new ArenaWorkRunner({
      workerId: "worker-1",
      leaseSeconds: 60,
      queue: repository,
      handlers: {
        CAPTURE_S1_OPEN_REFERENCE: async () => {
          throw new Error("provider failed secret=should-not-leak");
        },
      },
      now: () => new Date("2026-08-31T13:32:01.000Z"),
      failureEnvironment: { ALPACA_API_SECRET_KEY: "should-not-leak" },
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("failed");
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({
      succeeded: false,
      result: { outcome: "FAILED" },
      errorCode: "ARENA_PHASE_FAILED",
      retryable: true,
    }));
    expect(JSON.stringify(vi.mocked(repository.complete).mock.calls)).not.toContain(
      "should-not-leak",
    );
  });

  it("does not retry an invocation that already reached a terminal outcome", async () => {
    const repository = queue(work());
    const runner = new ArenaWorkRunner({
      workerId: "worker-1",
      leaseSeconds: 60,
      queue: repository,
      handlers: {
        CAPTURE_S1_OPEN_REFERENCE: async () => {
          throw new ArenaTerminalWorkError(
            "NO_ACCEPTED_SUBMISSION",
            "decision ended without an accepted target",
          );
        },
      },
      now: () => new Date("2026-08-31T13:32:01.000Z"),
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("failed");
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({
      succeeded: false,
      errorCode: "NO_ACCEPTED_SUBMISSION",
      retryable: false,
    }));
  });

  it("never publishes a handler success after the frozen market deadline", async () => {
    const repository = queue({
      ...work(),
      deadlineAt: "2026-08-31T20:00:00.000Z",
      leaseExpiresAt: "2026-08-31T20:00:30.000Z",
    });
    const times = [
      new Date("2026-08-31T19:59:59.000Z"),
      new Date("2026-08-31T20:00:00.001Z"),
    ];
    const runner = new ArenaWorkRunner({
      workerId: "worker-1",
      leaseSeconds: 60,
      queue: repository,
      handlers: {
        CAPTURE_S1_OPEN_REFERENCE: vi.fn(async () => ({
          outcome: "SHARED_EVIDENCE_BOUND",
        })),
      },
      now: () => times.shift()!,
    });

    await expect(runner.tick(new AbortController().signal)).resolves.toBe("failed");
    expect(repository.complete).toHaveBeenCalledTimes(1);
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({
      completedAt: "2026-08-31T20:00:00.001Z",
      succeeded: false,
      errorCode: "DEADLINE_EXPIRED_DURING_EXECUTION",
      retryable: false,
    }));
  });
});
