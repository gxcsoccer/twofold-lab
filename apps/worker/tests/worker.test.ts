import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryControlPlaneRepository, type LeasedControlCommand } from "../src/repository.js";
import { TwofoldWorker } from "../src/worker.js";
import type { WorkerConfig } from "../src/config.js";

const config: WorkerConfig = {
  workerId: "test-worker",
  pollIntervalMs: 10,
  leaseSeconds: 60,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function command(kind: LeasedControlCommand["kind"]): LeasedControlCommand {
  return {
    commandId: "command-1",
    kind,
    arguments: {},
    leaseToken: "lease-1",
    leaseExpiresAt: "2026-08-23T10:00:00.000Z",
  };
}

describe("TwofoldWorker", () => {
  it("claims and completes a supported command", async () => {
    const repository = new InMemoryControlPlaneRepository();
    repository.queue.push(command("pause_after_safe_point"));
    const worker = new TwofoldWorker(config, repository, {
      pause_after_safe_point: async () => ({ accepted: true }),
    });

    await expect(worker.tick(new AbortController().signal)).resolves.toBe("completed");
    expect(repository.completions).toEqual([
      { commandId: "command-1", result: { accepted: true } },
    ]);
    expect(repository.failures).toEqual([]);
    expect(repository.heartbeats[0]?.capabilities).toEqual({
      commands: ["pause_after_safe_point"],
    });
  });

  it("fails closed when a handler is unavailable", async () => {
    const repository = new InMemoryControlPlaneRepository();
    repository.queue.push(command("freeze_config"));
    const worker = new TwofoldWorker(config, repository, {});

    await expect(worker.tick(new AbortController().signal)).resolves.toBe("failed");
    expect(repository.failures[0]?.failure).toMatchObject({
      code: "HANDLER_UNAVAILABLE",
      retryable: false,
    });
  });

  it("redacts credentials from persisted command failures", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "command-private-value");
    const repository = new InMemoryControlPlaneRepository();
    repository.queue.push(command("freeze_config"));
    const worker = new TwofoldWorker(config, repository, {
      freeze_config: async () => {
        throw new Error("provider rejected command-private-value");
      },
    });

    await expect(worker.tick(new AbortController().signal)).resolves.toBe("failed");
    expect(repository.failures[0]?.failure.message).toContain("[REDACTED]");
    expect(repository.failures[0]?.failure.message).not.toContain("command-private-value");
  });
});
