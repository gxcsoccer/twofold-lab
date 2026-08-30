import { loadAlpacaCorporateActionConfig } from
  "./alpaca-corporate-actions.js";
import { CorporateActionScanner } from "./corporate-action-scanner.js";
import type { WorkerConfig } from "./config.js";
import { SupabaseCorporateActionStore } from
  "./supabase-corporate-action-store.js";

export function createCorporateActionScanner(
  config: WorkerConfig,
): CorporateActionScanner {
  return new CorporateActionScanner({
    config: loadAlpacaCorporateActionConfig(),
    store: new SupabaseCorporateActionStore(
      config.supabaseUrl!,
      config.supabaseSecretKey!,
      config.workerId,
    ),
    scanIntervalMs: 15 * 60 * 1_000,
    retryIntervalMs: 60_000,
    lookbackDays: 45,
    horizonDays: 45,
  });
}
