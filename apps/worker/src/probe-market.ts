import { createArenaMarketEvidenceRunner } from "./create-market-evidence-runner.js";
import { loadWorkerConfig } from "./config.js";

async function main(): Promise<void> {
  const runner = createArenaMarketEvidenceRunner(loadWorkerConfig());
  try {
    const result = await runner.tick(AbortSignal.timeout(60_000));
    process.stdout.write(`outcome: ${result}\n`);
  } catch (error) {
    const e = error as Error;
    process.stdout.write(`RAW ERROR: ${e.message}\n`);
    process.stdout.write(`STACK:\n${(e.stack ?? "").split("\n").slice(1, 6).join("\n")}\n`);
  }
}
void main();
