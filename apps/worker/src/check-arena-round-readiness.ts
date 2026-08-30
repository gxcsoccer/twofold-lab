import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { getArenaStartGate } from "./arena-round-readiness-repository.js";
import { loadWorkerConfig } from "./config.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUND_INDEX_PATTERN = /^[1-9]\d*$/;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface RoundIdentity {
  readonly roundId: string;
  readonly roundIndex: string;
}

function option(name: string): string | undefined {
  return process.argv.slice(2)
    .find((argument) => argument.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function configuredRound(value: unknown, index: number): RoundIdentity {
  const candidate = record(value, `rounds[${index}]`);
  if (
    typeof candidate.roundId !== "string"
    || !UUID_PATTERN.test(candidate.roundId)
  ) throw new TypeError(`rounds[${index}].roundId must be a UUID`);
  if (
    typeof candidate.roundIndex !== "string"
    || !ROUND_INDEX_PATTERN.test(candidate.roundIndex)
  ) throw new TypeError(`rounds[${index}].roundIndex must be a canonical positive integer`);
  return Object.freeze({
    roundId: candidate.roundId,
    roundIndex: candidate.roundIndex,
  });
}

async function selectedRound(): Promise<RoundIdentity> {
  const configPath = resolve(
    repositoryRoot,
    option("config")
      ?? process.env.TWOFOLD_COMPETITION_CONFIG
      ?? "config/private-controlled-lab-s1.json",
  );
  const parsed = record(JSON.parse(await readFile(configPath, "utf8")), "config");
  if (parsed.schema !== "twofold.private_controlled_lab_config/v1") {
    throw new TypeError("unsupported competition config schema");
  }
  if (!Array.isArray(parsed.rounds)) {
    throw new TypeError("competition config rounds must be an array");
  }
  const requestedRoundIndex = option("round") ?? "1";
  if (!ROUND_INDEX_PATTERN.test(requestedRoundIndex)) {
    throw new TypeError("requested Round index must be a canonical positive integer");
  }
  const matches = parsed.rounds
    .map(configuredRound)
    .filter((candidate) => candidate.roundIndex === requestedRoundIndex);
  if (matches.length !== 1) {
    throw new TypeError("requested Round must be configured exactly once");
  }
  return matches[0]!;
}

async function main(): Promise<void> {
  const [round, worker] = await Promise.all([
    selectedRound(),
    Promise.resolve(loadWorkerConfig()),
  ]);
  const client = createClient(worker.supabaseUrl!, worker.supabaseSecretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const gate = await getArenaStartGate(client as never, {
    roundId: round.roundId,
    workerId: worker.workerId,
  });
  process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
  if (!gate.ready) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-round-readiness] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
