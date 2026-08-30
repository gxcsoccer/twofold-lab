import { loadWorkerConfig } from "./config.js";
import { runArenaWorkerLoop } from "./arena-main-loop.js";
import { createArenaTickRunner } from "./create-arena-tick-runner.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const runner = createArenaTickRunner(config);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("SIGINT")));
  process.once("SIGTERM", () => controller.abort(new Error("SIGTERM")));
  process.stdout.write(
    `[twofold-arena-worker] started id=${config.workerId}\n`,
  );
  await runArenaWorkerLoop({
    runner,
    pollIntervalMs: config.pollIntervalMs,
    signal: controller.signal,
    onTick: (result) => {
      if (result.outcome === "failed") {
        process.stderr.write(
          `[twofold-arena-worker] tick failed phases=${JSON.stringify(result.phaseOutcomes)}\n`,
        );
      }
    },
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-arena-worker] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
