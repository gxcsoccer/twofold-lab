import type { WorkerConfig } from "./config.js";
import { SupabaseEvolutionRepository } from "./evolution-repository.js";
import { EvolutionRunner } from "./evolution-runner.js";

export function createEvolutionRunner(config: WorkerConfig): EvolutionRunner {
  return new EvolutionRunner({
    workerId: config.workerId,
    leaseSeconds: config.leaseSeconds,
    repository: new SupabaseEvolutionRepository(
      config.supabaseUrl!,
      config.supabaseSecretKey!,
    ),
  });
}
