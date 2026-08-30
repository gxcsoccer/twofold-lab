import {
  arenaAgentHandlers,
  createArenaAgentDecisionHandler,
  createRealArenaAgentDecisionExecution,
} from "./arena-agent-decision-handler.js";
import { SupabaseArenaWorkQueue } from "./arena-work-repository.js";
import { ArenaWorkRunner } from "./arena-work-runner.js";
import type { WorkerConfig } from "./config.js";

export function createArenaAgentDecisionRunner(
  config: WorkerConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ArenaWorkRunner {
  const queue = new SupabaseArenaWorkQueue(
    config.supabaseUrl!,
    config.supabaseSecretKey!,
  );
  const handler = createArenaAgentDecisionHandler({
    execute: createRealArenaAgentDecisionExecution({
      worker: config,
      environment,
    }),
  });
  return new ArenaWorkRunner({
    workerId: config.workerId,
    leaseSeconds: config.agentLeaseSeconds,
    queue,
    handlers: arenaAgentHandlers(environment, handler),
    failureEnvironment: environment,
  });
}

export function hasArenaAgentCapability(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const key = environment.DEEPSEEK_API_KEY;
  return key !== undefined && key.trim() !== "";
}
