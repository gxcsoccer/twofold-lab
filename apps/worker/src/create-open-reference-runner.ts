import { loadAlpacaOpenReferenceConfig } from "./alpaca-open-reference.js";
import { createArenaOpenReferenceHandler } from "./arena-open-reference-handler.js";
import { SupabaseArenaWorkQueue } from "./arena-work-repository.js";
import { ArenaWorkRunner } from "./arena-work-runner.js";
import type { WorkerConfig } from "./config.js";
import { SupabaseArenaOpenReferenceStore } from "./supabase-open-reference-store.js";

export function createOpenReferenceRunner(config: WorkerConfig): ArenaWorkRunner {
  const market = loadAlpacaOpenReferenceConfig();
  const queue = new SupabaseArenaWorkQueue(
    config.supabaseUrl!,
    config.supabaseSecretKey!,
  );
  const store = new SupabaseArenaOpenReferenceStore(
    config.supabaseUrl!,
    config.supabaseSecretKey!,
    config.workerId,
  );
  const handler = createArenaOpenReferenceHandler({ config: market, store });
  return new ArenaWorkRunner({
    workerId: config.workerId,
    leaseSeconds: config.leaseSeconds,
    queue,
    handlers: {
      CAPTURE_S1_OPEN_REFERENCE: handler,
      CAPTURE_S2_OPEN_REFERENCE: handler,
    },
  });
}
