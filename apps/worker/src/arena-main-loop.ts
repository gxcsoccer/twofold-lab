import { setTimeout as delay } from "node:timers/promises";

import type { ArenaTickResult } from "./arena-tick-runner.js";

export interface ArenaMainTickRunner {
  tick(signal: AbortSignal): Promise<ArenaTickResult>;
}

/** Run complete durable ticks until shutdown, without retaining abort listeners. */
export async function runArenaWorkerLoop(input: {
  readonly runner: ArenaMainTickRunner;
  readonly pollIntervalMs: number;
  readonly signal: AbortSignal;
  readonly onTick?: (result: ArenaTickResult) => void;
}): Promise<void> {
  while (!input.signal.aborted) {
    const result = await input.runner.tick(input.signal);
    input.onTick?.(result);
    try {
      await delay(input.pollIntervalMs, undefined, { signal: input.signal });
    } catch (error) {
      if (input.signal.aborted) return;
      throw error;
    }
  }
}
