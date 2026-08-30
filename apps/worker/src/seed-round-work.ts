import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { seedArenaRoundWork } from "./arena-work-repository.js";
import { loadWorkerConfig } from "./config.js";

interface CompetitionConfig {
  readonly schema: "twofold.private_controlled_lab_config/v1";
  readonly rounds: ReadonlyArray<{
    readonly roundId: string;
    readonly roundIndex: string;
  }>;
}

function option(name: string): string | undefined {
  return process.argv.slice(2)
    .find((argument) => argument.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const path = resolve(
    process.cwd(),
    option("config")
      ?? process.env.TWOFOLD_COMPETITION_CONFIG
      ?? "config/private-controlled-lab-s1.json",
  );
  const config = JSON.parse(await readFile(path, "utf8")) as CompetitionConfig;
  if (config.schema !== "twofold.private_controlled_lab_config/v1") {
    throw new TypeError("unsupported competition config schema");
  }
  const roundIndex = option("round") ?? "1";
  const round = config.rounds.find(
    (candidate) => candidate.roundIndex === roundIndex,
  );
  if (round === undefined) throw new TypeError("requested Round is not configured");
  const worker = loadWorkerConfig();
  const client = createClient(worker.supabaseUrl!, worker.supabaseSecretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const result = await seedArenaRoundWork(client as never, {
    roundId: round.roundId,
    recordedBy: worker.workerId,
  });
  process.stdout.write(`${JSON.stringify({
    schema: "twofold.arena_round_work_report/v1",
    ...result,
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-round-work] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
