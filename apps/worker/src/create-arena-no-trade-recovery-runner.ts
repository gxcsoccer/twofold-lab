import { createClient } from "@supabase/supabase-js";

import {
  getArenaRoundCloseSnapshot,
  type ArenaCloseSnapshotRpcClient,
} from "./arena-close-snapshot-repository.js";
import { loadArenaScoreBase, type ArenaFinalizationRpcClient } from
  "./arena-finalization-repository.js";
import { createArenaNoTradeRecoveryHandler } from
  "./arena-no-trade-recovery-handler.js";
import { SupabaseArenaNoTradeRecoveryQueue } from
  "./arena-no-trade-recovery-repository.js";
import { ArenaNoTradeRecoveryRunner } from
  "./arena-no-trade-recovery-runner.js";
import { SupabaseArenaRepository } from "./arena-repository.js";
import type { WorkerConfig } from "./config.js";

/** Recovery requires Supabase evidence only; it never needs a model key. */
export function createArenaNoTradeRecoveryRunner(
  config: WorkerConfig,
): ArenaNoTradeRecoveryRunner {
  const rpcClient = createClient(
    config.supabaseUrl!,
    config.supabaseSecretKey!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  ) as unknown as ArenaCloseSnapshotRpcClient & ArenaFinalizationRpcClient;
  const arena = new SupabaseArenaRepository(
    config.supabaseUrl!,
    config.supabaseSecretKey!,
    config.workerId,
  );
  return new ArenaNoTradeRecoveryRunner({
    workerId: config.workerId,
    leaseSeconds: config.leaseSeconds,
    queue: new SupabaseArenaNoTradeRecoveryQueue(
      config.supabaseUrl!,
      config.supabaseSecretKey!,
    ),
    handler: createArenaNoTradeRecoveryHandler({
      source: {
        closeSnapshot: (roundId) => getArenaRoundCloseSnapshot(
          rpcClient,
          roundId,
          "S2_CLOSE",
        ),
        marketSnapshot: (snapshotId) => arena.marketSnapshot(snapshotId),
        portfolioState: (runId) => arena.portfolioState(runId),
        scoreBase: (seasonId, entrantId) => loadArenaScoreBase(
          rpcClient,
          { seasonId, entrantId },
        ),
      },
    }),
  });
}
