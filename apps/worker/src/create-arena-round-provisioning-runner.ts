import { createSupabaseExchangeCalendarProvider } from
  "./arena-round-calendar-provider.js";
import { createArenaRoundProvisioningHandler } from
  "./arena-round-provisioning-handler.js";
import { SupabaseArenaRoundProvisioningQueue } from
  "./arena-round-provisioning-repository.js";
import { ArenaRoundProvisioningRunner } from
  "./arena-round-provisioning-runner.js";
import type { WorkerConfig } from "./config.js";
import { loadAlpacaMarketDataConfig } from "./market-data.js";

export function createArenaRoundProvisioningRunner(
  config: WorkerConfig,
): ArenaRoundProvisioningRunner {
  const alpaca = loadAlpacaMarketDataConfig();
  const calendar = createSupabaseExchangeCalendarProvider({
    supabaseUrl: config.supabaseUrl!,
    supabaseSecretKey: config.supabaseSecretKey!,
    alpacaApiKeyId: alpaca.apiKeyId,
    alpacaApiSecretKey: alpaca.apiSecretKey,
  });
  return new ArenaRoundProvisioningRunner({
    workerId: config.workerId,
    leaseSeconds: config.leaseSeconds,
    queue: new SupabaseArenaRoundProvisioningQueue(
      config.supabaseUrl!,
      config.supabaseSecretKey!,
    ),
    handler: createArenaRoundProvisioningHandler({ calendar }),
  });
}
