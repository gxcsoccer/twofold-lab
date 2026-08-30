import { loadAlpacaOpenReferenceConfig } from "./alpaca-open-reference.js";
import { createArenaCloseSnapshotHandler } from "./arena-close-snapshot-handler.js";
import { createArenaOpenReferenceHandler } from "./arena-open-reference-handler.js";
import { createArenaTaxFxHandler } from "./arena-tax-fx-handler.js";
import { SupabaseArenaWorkQueue } from "./arena-work-repository.js";
import { ArenaWorkRunner } from "./arena-work-runner.js";
import type { WorkerConfig } from "./config.js";
import { loadAlpacaMarketDataConfig } from "./market-data.js";
import { loadEcbFxConfig } from "./ecb-fx.js";
import { SupabaseArenaCloseSnapshotStore } from "./supabase-close-snapshot-store.js";
import { SupabaseArenaOpenReferenceStore } from "./supabase-open-reference-store.js";
import { SupabaseArenaTaxFxStore } from "./supabase-tax-fx-store.js";

export function createArenaMarketEvidenceRunner(
  config: WorkerConfig,
): ArenaWorkRunner {
  const queue = new SupabaseArenaWorkQueue(
    config.supabaseUrl!,
    config.supabaseSecretKey!,
  );
  const openHandler = createArenaOpenReferenceHandler({
    config: loadAlpacaOpenReferenceConfig(),
    store: new SupabaseArenaOpenReferenceStore(
      config.supabaseUrl!,
      config.supabaseSecretKey!,
      config.workerId,
    ),
  });
  const closeHandler = createArenaCloseSnapshotHandler({
    config: loadAlpacaMarketDataConfig(),
    store: new SupabaseArenaCloseSnapshotStore(
      config.supabaseUrl!,
      config.supabaseSecretKey!,
      config.workerId,
    ),
  });
  const taxFxHandler = createArenaTaxFxHandler({
    config: loadEcbFxConfig(),
    store: new SupabaseArenaTaxFxStore(
      config.supabaseUrl!,
      config.supabaseSecretKey!,
      config.workerId,
    ),
  });
  const closeAndTaxFx = async (...arguments_: Parameters<typeof closeHandler>) =>
    Object.freeze({
      outcome: "SHARED_CLOSE_AND_TAX_FX_READY",
      close: await closeHandler(...arguments_),
      taxFx: await taxFxHandler(...arguments_),
    });
  return new ArenaWorkRunner({
    workerId: config.workerId,
    leaseSeconds: config.leaseSeconds,
    queue,
    handlers: {
      CAPTURE_S1_OPEN_REFERENCE: openHandler,
      CAPTURE_S1_CLOSE: closeAndTaxFx,
      CAPTURE_S2_OPEN_REFERENCE: openHandler,
      CAPTURE_S2_CLOSE: closeAndTaxFx,
    },
  });
}
