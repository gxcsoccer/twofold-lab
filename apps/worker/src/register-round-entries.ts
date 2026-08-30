import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { registerArenaRoundEntryExact } from "./arena-round-repository.js";
import { loadWorkerConfig } from "./config.js";

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

function configPath(): string {
  const argument = process.argv.slice(2).find((value) => value.startsWith("--config="));
  return resolve(
    process.cwd(),
    argument?.slice("--config=".length)
      ?? process.env.TWOFOLD_COMPETITION_CONFIG
      ?? "config/private-controlled-lab-s1.json",
  );
}

function roundIndex(): string {
  return process.argv.slice(2)
    .find((value) => value.startsWith("--round="))
    ?.slice("--round=".length)
    ?? "1";
}

async function main(): Promise<void> {
  const config = JSON.parse(await readFile(configPath(), "utf8")) as CompetitionConfig;
  if (config.schema !== "twofold.private_controlled_lab_config/v1") {
    throw new TypeError("unsupported competition config schema");
  }
  const round = config.rounds.find(
    (candidate) => candidate.roundIndex === roundIndex(),
  );
  if (round === undefined) throw new TypeError("requested Round is not configured");
  if (config.entrants.length === 0) {
    throw new TypeError("competition has no entrants");
  }
  const worker = loadWorkerConfig();
  const client = createClient(worker.supabaseUrl!, worker.supabaseSecretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const entries = [];
  for (const entrant of [...config.entrants].sort(
    (left, right) => left.entrantCode.localeCompare(right.entrantCode, "en"),
  )) {
    entries.push(await registerArenaRoundEntryExact(client as never, {
      p_idempotency_key:
        `${config.season.seasonCode}:round:${round.roundIndex}:${entrant.entrantCode}`,
      p_round_id: round.roundId,
      p_entrant_id: entrant.entrantId,
      p_recorded_by: worker.workerId,
    }, {
      seasonId: config.season.seasonId,
      runId: entrant.runId,
    }));
  }
  process.stdout.write(`${JSON.stringify({
    schema: "twofold.arena_round_entry_batch/v1",
    roundId: round.roundId,
    roundIndex: round.roundIndex,
    entries,
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-round-entries] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
