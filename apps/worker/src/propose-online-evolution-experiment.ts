import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  transitionEvolutionExperiment,
  type EvolutionExperimentSpec,
} from "@twofold/core";

import { loadWorkerConfig } from "./config.js";
import { SupabaseEvolutionExperimentStore } from "./evolution-experiment-repository.js";

interface ProposalFile {
  readonly spec: EvolutionExperimentSpec;
  readonly proposedAt: string;
  readonly actorId: string;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) throw new Error("usage: evolution:experiment:propose-online <proposal.json>");
  const proposal = JSON.parse(await readFile(resolve(path), "utf8")) as ProposalFile;
  if (proposal.spec.mode !== "ONLINE_SHADOW") {
    throw new TypeError("online proposal must use ONLINE_SHADOW mode");
  }
  const state = transitionEvolutionExperiment(null, {
    type: "PROPOSE",
    spec: proposal.spec,
    actor: { kind: "model", id: proposal.actorId },
    at: proposal.proposedAt,
  });
  const config = loadWorkerConfig();
  await new SupabaseEvolutionExperimentStore(
    config.supabaseUrl!, config.supabaseSecretKey!,
  ).propose({
    state,
    actorKind: "model",
    actorId: proposal.actorId,
    at: proposal.proposedAt,
    idempotencyKey: `${proposal.spec.experimentCode}:propose`,
  });
  process.stdout.write(`${JSON.stringify({
    schema: "twofold.online_evolution_experiment_proposal/v1",
    experimentId: state.spec.experimentId,
    status: state.status,
    rankingScope: state.rankingScope,
    humanApprovalRequired: true,
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-evolution-online-proposal] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
