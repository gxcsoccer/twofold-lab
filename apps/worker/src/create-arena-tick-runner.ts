import {
  createArenaAgentDecisionRunner,
  hasArenaAgentCapability,
} from "./create-agent-decision-runner.js";
import { createArenaCycleRunner } from "./create-arena-cycle-runner.js";
import { createArenaMarketEvidenceRunner } from "./create-market-evidence-runner.js";
import { createCorporateActionAccountReconciler } from
  "./create-corporate-action-account-reconciler.js";
import { createCorporateActionScanner } from
  "./create-corporate-action-scanner.js";
import { createArenaNoTradeRecoveryRunner } from
  "./create-arena-no-trade-recovery-runner.js";
import { createArenaRoundProvisioningRunner } from
  "./create-arena-round-provisioning-runner.js";
import { ArenaTickRunner } from "./arena-tick-runner.js";
import { createEvolutionRunner } from "./create-evolution-runner.js";
import { SupabaseArenaTickObserver } from "./arena-tick-observer.js";
import type { WorkerConfig } from "./config.js";

export function createArenaTickRunner(config: WorkerConfig): ArenaTickRunner {
  return new ArenaTickRunner({
    workerId: config.workerId,
    agent: createArenaAgentDecisionRunner(config),
    cycle: createArenaCycleRunner(config),
    market: createArenaMarketEvidenceRunner(config),
    corporateActionScan: createCorporateActionScanner(config),
    corporateActionAccount: createCorporateActionAccountReconciler(config),
    recovery: createArenaNoTradeRecoveryRunner(config),
    season: createArenaRoundProvisioningRunner(config),
    evolution: createEvolutionRunner(config),
    hasAgentCapability: hasArenaAgentCapability(),
    observer: new SupabaseArenaTickObserver(
      config.supabaseUrl!,
      config.supabaseSecretKey!,
      180,
    ),
  });
}
