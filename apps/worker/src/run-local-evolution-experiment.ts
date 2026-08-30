import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadWorkerConfig } from "./config.js";
import { SupabaseEvolutionExperimentStore } from "./evolution-experiment-repository.js";
import {
  runLocalEvolutionExperiment,
  type LocalEvolutionExperimentPlan,
} from "./evolution-local-experiment.js";

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) {
    throw new Error("usage: evolution:experiment:local <plan.json>");
  }
  const plan = JSON.parse(await readFile(resolve(configPath), "utf8")) as LocalEvolutionExperimentPlan;
  const config = loadWorkerConfig();
  const result = await runLocalEvolutionExperiment(
    new SupabaseEvolutionExperimentStore(config.supabaseUrl!, config.supabaseSecretKey!),
    plan,
  );
  process.stdout.write(`${JSON.stringify({
    schema: "twofold.local_evolution_experiment_run/v1",
    experimentId: result.state.spec.experimentId,
    trialId: result.trialId,
    status: result.state.status,
    recommendation: result.result.recommendation,
    resultSha256: result.result.resultSha256,
    decisionEvaluationSha256:
      result.decisionEvaluation?.evaluationSha256 ?? null,
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-evolution-local] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
