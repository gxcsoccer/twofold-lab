import { loadWorkerConfig } from "./config.js";
import { SupabaseControlPlaneRepository } from "./supabase-repository.js";
import { TwofoldWorker } from "./worker.js";

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason);
    }, { once: true });
  });
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const repository = new SupabaseControlPlaneRepository(
    config.supabaseUrl!,
    config.supabaseSecretKey!,
  );
  const worker = new TwofoldWorker(config, repository, {});
  const controller = new AbortController();

  process.once("SIGINT", () => controller.abort(new Error("SIGINT")));
  process.once("SIGTERM", () => controller.abort(new Error("SIGTERM")));

  process.stdout.write(
    `[twofold-worker] started id=${config.workerId} mode=supabase\n`,
  );

  while (!controller.signal.aborted) {
    await worker.tick(controller.signal);
    await wait(config.pollIntervalMs, controller.signal);
  }
}

void main().catch((error: unknown) => {
  if (error instanceof Error && (error.message === "SIGINT" || error.message === "SIGTERM")) {
    process.exitCode = 0;
    return;
  }
  process.stderr.write(`[twofold-worker] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
