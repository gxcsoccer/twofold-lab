import { createClient } from "@supabase/supabase-js";

import {
  createArenaS1PlanHandler,
  type ArenaS1PlanClient,
} from "./arena-s1-plan-handler.js";
import {
  createArenaS1CheckpointHandler,
  type ArenaS1CheckpointClient,
} from "./arena-s1-checkpoint-handler.js";
import {
  createArenaFinalizationHandler,
  type ArenaFinalizationClient,
} from "./arena-finalization-handler.js";
import { SupabaseArenaWorkQueue } from "./arena-work-repository.js";
import { ArenaWorkRunner } from "./arena-work-runner.js";
import type { WorkerConfig } from "./config.js";

/** Entrant-local deterministic stages; market capture remains a shared runner. */
export function createArenaCycleRunner(config: WorkerConfig): ArenaWorkRunner {
  const client = createClient(config.supabaseUrl!, config.supabaseSecretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  }) as unknown as ArenaS1PlanClient
    & ArenaS1CheckpointClient
    & ArenaFinalizationClient;
  return new ArenaWorkRunner({
    workerId: config.workerId,
    leaseSeconds: config.leaseSeconds,
    queue: new SupabaseArenaWorkQueue(
      config.supabaseUrl!,
      config.supabaseSecretKey!,
    ),
    handlers: {
      PREPARE_S1_ORDERS: createArenaS1PlanHandler({
        client,
        recordedBy: config.workerId,
      }),
      SETTLE_S1_AND_PREPARE_S2: createArenaS1CheckpointHandler({
        client,
        recordedBy: config.workerId,
      }),
      FINALIZE_ACCEPTED_TARGET_CYCLE: createArenaFinalizationHandler({
        client,
        recordedBy: config.workerId,
      }),
    },
  });
}
