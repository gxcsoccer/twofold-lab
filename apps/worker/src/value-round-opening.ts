import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { SupabaseArenaRepository } from "./arena-repository.js";
import {
  buildArenaValuation,
  registerArenaValuationExact,
} from "./arena-valuation.js";
import { loadWorkerConfig } from "./config.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface CompetitionConfig {
  readonly schema: "twofold.private_controlled_lab_config/v1";
  readonly season: { readonly seasonId: string; readonly seasonCode: string };
  readonly rounds: ReadonlyArray<{
    readonly roundId: string;
    readonly roundIndex: string;
  }>;
  readonly entrants: ReadonlyArray<{
    readonly entrantId: string;
    readonly entrantCode: string;
    readonly runId: string;
  }>;
}

function option(name: string): string | undefined {
  return process.argv.slice(2)
    .find((argument) => argument.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const configPath = resolve(
    repositoryRoot,
    option("config")
      ?? process.env.TWOFOLD_COMPETITION_CONFIG
      ?? "config/private-controlled-lab-s1.json",
  );
  const config = JSON.parse(await readFile(configPath, "utf8")) as CompetitionConfig;
  if (config.schema !== "twofold.private_controlled_lab_config/v1") {
    throw new TypeError("unsupported competition config schema");
  }
  const roundIndex = option("round") ?? "1";
  const round = config.rounds.find((candidate) => candidate.roundIndex === roundIndex);
  if (round === undefined) throw new TypeError("requested Round is not configured");

  const worker = loadWorkerConfig();
  const repository = new SupabaseArenaRepository(
    worker.supabaseUrl!,
    worker.supabaseSecretKey!,
    worker.workerId,
  );
  const client = createClient(worker.supabaseUrl!, worker.supabaseSecretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const results = [];
  for (const entrant of [...config.entrants].sort(
    (left, right) => left.entrantCode.localeCompare(right.entrantCode, "en"),
  )) {
    const fence = await repository.roundEntrantFence(
      round.roundId,
      entrant.entrantId,
    );
    if (
      fence.roundIndex !== round.roundIndex
      || fence.seasonId !== config.season.seasonId
      || fence.runId !== entrant.runId
    ) {
      throw new TypeError(`Round entry mismatch for ${entrant.entrantCode}`);
    }
    const [snapshot, portfolioState] = await Promise.all([
      repository.marketSnapshot(fence.snapshotId),
      repository.portfolioState(entrant.runId),
    ]);
    const built = buildArenaValuation({
      stage: "OPENING",
      snapshot,
      portfolioState,
    });
    const arguments_ = {
      p_idempotency_key:
        `${config.season.seasonCode}:round:${round.roundIndex}:${entrant.entrantCode}:opening-valuation`,
      p_round_entry_id: fence.roundEntryId,
      p_stage: "OPENING" as const,
      p_snapshot_id: snapshot.snapshotId,
      p_canonical_json: built.canonicalJson,
      p_recorded_by: worker.workerId,
    };
    const expected = {
      roundId: round.roundId,
      seasonId: config.season.seasonId,
      entrantId: entrant.entrantId,
      runId: entrant.runId,
      expected: built,
    };
    const registered = await registerArenaValuationExact(
      client as never,
      arguments_,
      expected,
    );
    const replay = await registerArenaValuationExact(
      client as never,
      arguments_,
      expected,
    );
    if (replay.valuationId !== registered.valuationId) {
      throw new Error("opening valuation exact retry changed identity");
    }
    results.push({
      entrantCode: entrant.entrantCode,
      valuationId: registered.valuationId,
      roundEntryId: fence.roundEntryId,
      ledgerSequence: registered.ledgerSequence,
      brokerNav: registered.brokerNav,
      taxReservedNav: registered.taxReservedNav,
      liquidationNav: registered.liquidationNav,
      scoreBaseLiquidationNav: registered.scoreBaseLiquidationNav,
      valuationSha256: registered.valuationSha256,
      exactRetryVerified: true,
    });
  }

  const leaderboardResult = await client.rpc("get_arena_leaderboard", {
    p_season_id: config.season.seasonId,
  });
  if (leaderboardResult.error !== null) {
    throw new Error(`get_arena_leaderboard failed: ${leaderboardResult.error.message}`);
  }
  process.stdout.write(`${JSON.stringify({
    schema: "twofold.arena_opening_valuation_report/v1",
    seasonId: config.season.seasonId,
    roundId: round.roundId,
    roundIndex: round.roundIndex,
    entries: results,
    leaderboard: leaderboardResult.data,
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-round-opening-value] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
