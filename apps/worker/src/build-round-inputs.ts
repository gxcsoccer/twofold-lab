import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildArenaInputs,
  type ArenaCompetitionIdentity,
} from "./arena-inputs.js";
import { SupabaseArenaRepository } from "./arena-repository.js";
import { loadWorkerConfig } from "./config.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const harnessRoot = resolve(
  process.env.DSH_HARNESS_ROOT ?? resolve(repositoryRoot, "../deepseek-harness"),
);

interface CompetitionConfig {
  readonly schema: "twofold.private_controlled_lab_config/v1";
  readonly season: { readonly seasonId: string };
  readonly rounds: ReadonlyArray<{
    readonly roundId: string;
    readonly roundIndex: string;
  }>;
  readonly entrants: ReadonlyArray<{
    readonly entrantId: string;
    readonly entrantCode: string;
    readonly executionClass: "ROOT_ONLY" | "ORCHESTRATED";
    readonly runId: string;
    readonly bundleId: string;
    readonly bundleSha256: string;
    readonly presetId: "twofold" | "twofold-orchestrator";
  }>;
}

function option(name: string): string | undefined {
  return process.argv.slice(2)
    .find((argument) => argument.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const path = resolve(
    repositoryRoot,
    option("config")
      ?? process.env.TWOFOLD_COMPETITION_CONFIG
      ?? "config/private-controlled-lab-s1.json",
  );
  const config = JSON.parse(await readFile(path, "utf8")) as CompetitionConfig;
  if (config.schema !== "twofold.private_controlled_lab_config/v1") {
    throw new TypeError("unsupported competition config schema");
  }
  const requestedRound = option("round") ?? "1";
  const round = config.rounds.find(
    (candidate) => candidate.roundIndex === requestedRound,
  );
  if (round === undefined) throw new TypeError("requested Round is not configured");
  const requestedEntrant = option("entrant");
  const entrants = requestedEntrant === undefined
    ? config.entrants
    : config.entrants.filter(
        (candidate) => candidate.entrantCode === requestedEntrant,
      );
  if (entrants.length === 0) throw new TypeError("requested entrant is not configured");

  const worker = loadWorkerConfig();
  const repository = new SupabaseArenaRepository(
    worker.supabaseUrl!,
    worker.supabaseSecretKey!,
    worker.workerId,
  );
  const outputs = [];
  for (const entrant of [...entrants].sort(
    (left, right) => left.entrantCode.localeCompare(right.entrantCode, "en"),
  )) {
    const identity: ArenaCompetitionIdentity = {
      seasonId: config.season.seasonId,
      runId: entrant.runId,
      entrantCode: entrant.entrantCode,
      bundleId: entrant.bundleId,
      bundleSha256: entrant.bundleSha256,
      presetId: entrant.presetId,
      executionClass: entrant.executionClass,
    };
    const fence = await repository.roundEntrantFence(
      round.roundId,
      entrant.entrantId,
    );
    if (
      fence.roundIndex !== round.roundIndex
      || fence.seasonId !== identity.seasonId
      || fence.runId !== identity.runId
    ) {
      throw new TypeError(`Round entry mismatch for ${entrant.entrantCode}`);
    }
    const [snapshot, portfolioState] = await Promise.all([
      repository.marketSnapshot(fence.snapshotId),
      repository.portfolioState(entrant.runId),
    ]);
    const built = await buildArenaInputs({
      repositoryRoot,
      harnessRoot,
      snapshot,
      competitionIdentity: identity,
      roundFence: fence,
      portfolioState,
    });
    const replay = await buildArenaInputs({
      repositoryRoot,
      harnessRoot,
      snapshot,
      competitionIdentity: identity,
      roundFence: fence,
      portfolioState,
    });
    if (
      replay.packetArtifact.content !== built.packetArtifact.content
      || replay.packetArtifact.sha256 !== built.packetArtifact.sha256
    ) {
      throw new Error("Round input replay changed exact packet bytes");
    }
    outputs.push({
      entrantCode: entrant.entrantCode,
      roundEntryDecisionId: fence.decisionId,
      marketSnapshotId: fence.snapshotId,
      portfolioLedgerSequence: portfolioState.ledgerHead.sequence,
      openingPosition: portfolioState.positions.map((position) => ({
        symbol: position.symbol,
        quantity: position.quantity,
      })),
      decisionPacketId: built.identity.decisionPacketId,
      packetSha256: built.packetArtifact.sha256,
      bundleSha256: built.bundleArtifact.sha256,
      submissionDeadlineAt: fence.submissionDeadlineAt,
      exactReplayVerified: true,
    });
  }
  process.stdout.write(`${JSON.stringify({
    schema: "twofold.arena_round_inputs_report/v1",
    roundId: round.roundId,
    roundIndex: round.roundIndex,
    entries: outputs,
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-round-inputs] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
