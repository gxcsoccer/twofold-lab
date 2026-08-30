import { loadWorkerConfig } from "./config.js";
import { createArenaTickRunner } from "./create-arena-tick-runner.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const controller = new AbortController();
  const outcome = await createArenaTickRunner(config).tick(controller.signal);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-arena-tick] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
