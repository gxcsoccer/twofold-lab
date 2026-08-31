import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import {
  fetchAlpacaCalendar,
  planTwoStageCycleCalendar,
} from "./alpaca-calendar.js";
import { buildArenaBundleArtifact } from "./arena-inputs.js";
import { loadWorkerConfig } from "./config.js";
import { parseLiquidUniverseArtifact } from "./liquid-universe-reference.js";
import { planUsLiquid100Activation } from "./us-liquid-100-activation.js";
import { buildUsLiquid100SeasonConfig } from "./us-liquid-100-season.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly target_session_date: string;
  readonly sealed_at: string;
  readonly symbols: string[];
}

interface Arguments {
  readonly artifactPath: string;
  readonly snapshotId: string;
  readonly seasonCode: string;
  readonly displayName: string;
  readonly outputPath: string;
  readonly activationDelayMinutes: number;
}

function option(name: string): string | undefined {
  return process.argv.slice(2)
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

function baselineSymbols(): readonly string[] {
  const raw = option("baseline-symbols");
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((symbol) => {
    const normalized = symbol.trim();
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(normalized)) {
      throw new TypeError(`baseline symbol ${symbol} is invalid`);
    }
    return normalized;
  });
}

function arguments_(): Arguments {
  const artifactPath = option("artifact");
  const snapshotId = option("snapshot-id");
  const seasonCode = option("season-code") ?? "private-us-liquid-100-s2";
  const displayName = option("display-name") ?? "Private US Liquid 100 S2";
  const outputPath = option("output") ?? `config/${seasonCode}.json`;
  const activationDelayMinutes = Number(option("activation-delay-minutes") ?? "10");
  if (artifactPath === undefined) throw new TypeError("--artifact is required");
  if (snapshotId === undefined) throw new TypeError("--snapshot-id is required");
  return {
    artifactPath,
    snapshotId,
    seasonCode,
    displayName,
    outputPath,
    activationDelayMinutes,
  };
}

async function main(): Promise<void> {
  const input = arguments_();
  const artifactAbsolutePath = insideRepository(input.artifactPath);
  const artifactContent = await readFile(artifactAbsolutePath, "utf8");
  const artifact = parseLiquidUniverseArtifact(
    JSON.parse(artifactContent) as unknown,
  );
  const artifactSha256 = createHash("sha256")
    .update(artifactContent, "utf8")
    .digest("hex");

  const worker = loadWorkerConfig();
  const client = createClient(worker.supabaseUrl!, worker.supabaseSecretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const snapshotResult = await client.from("market_snapshot")
    .select("snapshot_id,target_session_date,sealed_at,symbols")
    .eq("snapshot_id", input.snapshotId)
    .single<SnapshotRow>();
  if (snapshotResult.error !== null) {
    throw new Error(`read sealed market snapshot failed: ${snapshotResult.error.message}`);
  }
  const activation = planUsLiquid100Activation({
    artifact,
    snapshot: {
      snapshotId: snapshotResult.data.snapshot_id,
      targetSessionDate: snapshotResult.data.target_session_date,
      sealedAt: snapshotResult.data.sealed_at,
      symbols: snapshotResult.data.symbols,
    },
    now: new Date().toISOString(),
    activationDelayMinutes: input.activationDelayMinutes,
    // Instruments a deterministic baseline holds that are deliberately outside
    // the decision universe, e.g. --baseline-symbols=SPY,QQQ. The snapshot must
    // then seal exactly the 100 members plus these, and Agents still see only
    // the 100 as eligible.
    baselineSymbols: baselineSymbols(),
  });

  const apiKeyId = secret("ALPACA_API_KEY_ID");
  const apiSecretKey = secret("ALPACA_API_SECRET_KEY");
  const calendarEndDate = addDays(artifact.asOfSessionDate, 14);
  const calendarDelivery = await fetchAlpacaCalendar({
    apiKeyId,
    apiSecretKey,
    startDate: artifact.asOfSessionDate,
    endDate: calendarEndDate,
  });
  const calendar = planTwoStageCycleCalendar(
    artifact.asOfSessionDate,
    calendarDelivery.sessions,
    { decisionAvailableAt: activation.decisionAvailableAt },
  );
  const harnessRoot = resolve(
    process.env.DSH_HARNESS_ROOT ?? resolve(repositoryRoot, "../deepseek-harness"),
  );
  const [twofold, twofoldOrchestrator] = await Promise.all([
    buildArenaBundleArtifact({
      repositoryRoot,
      harnessRoot,
      presetId: "twofold",
    }),
    buildArenaBundleArtifact({
      repositoryRoot,
      harnessRoot,
      presetId: "twofold-orchestrator",
    }),
  ]);
  const config = buildUsLiquid100SeasonConfig({
    seasonCode: input.seasonCode,
    displayName: input.displayName,
    seasonOpensAt: activation.seasonOpensAt,
    artifact,
    artifactPath: relative(repositoryRoot, artifactAbsolutePath),
    artifactSha256,
    snapshotId: activation.snapshotId,
    decisionAvailableAt: activation.decisionAvailableAt,
    calendar,
    bundles: {
      twofold: {
        bundleId: twofold.bundleId,
        bundleSha256: twofold.material.sha256,
      },
      twofoldOrchestrator: {
        bundleId: twofoldOrchestrator.bundleId,
        bundleSha256: twofoldOrchestrator.material.sha256,
      },
    },
  });

  const outputAbsolutePath = insideRepository(input.outputPath);
  await mkdir(dirname(outputAbsolutePath), { recursive: true });
  await writeFile(outputAbsolutePath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    schema: "twofold.us_liquid_100_season_preparation/v1",
    seasonId: config.season.seasonId,
    seasonCode: config.season.seasonCode,
    roundId: config.rounds[0].roundId,
    openingSnapshotId: config.season.openingSnapshotId,
    memberCount: config.decisionUniverse.memberCount,
    seasonOpensAt: config.season.opensAt,
    decisionWindowOpensAt: config.rounds[0].decisionWindowOpensAt,
    decisionWindowClosesAt: config.rounds[0].decisionWindowClosesAt,
    outputPath: relative(repositoryRoot, outputAbsolutePath),
  }, null, 2)}\n`);
}

function insideRepository(path: string): string {
  const absolute = resolve(repositoryRoot, path);
  const relativePath = relative(repositoryRoot, absolute);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new TypeError("path must be inside the repository");
  }
  return absolute;
}

function secret(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function addDays(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-liquid-100-prepare] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
