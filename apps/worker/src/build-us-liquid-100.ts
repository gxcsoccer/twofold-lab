import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchAlpacaCalendar,
  planTwoStageCycleCalendar,
} from "./alpaca-calendar.js";
import { buildArenaBundleArtifact } from "./arena-inputs.js";
import {
  buildLiquidUniverseFreeze,
  prefilterLiquidUniverseCandidates,
  type LiquidUniversePolicy,
} from "./liquid-universe.js";
import {
  fetchAlpacaUniverseAssets,
  fetchAlpacaUniverseBars,
  fetchNasdaqStockCatalog,
  fetchNasdaqTradedDirectory,
} from "./liquid-universe-sources.js";
import {
  fetchAlpacaDailyBars,
  loadAlpacaMarketDataConfig,
} from "./market-data.js";
import { SupabaseMarketDataRepository } from "./market-data-repository.js";
import { loadWorkerConfig } from "./config.js";
import { buildUsLiquid100SeasonConfig } from "./us-liquid-100-season.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const LULU_INSTRUMENT_ID = "122dd8f9-709a-5652-a27c-a3b5c32755de";
const policy = Object.freeze({
  name: "US Liquid 100",
  size: "100",
  minimumPriceUsd: "5",
  minimumMedianDollarVolumeUsd: "20000000",
  medianDollarVolumeSessions: "20",
  minimumHistorySessions: "120",
  allowedExchanges: ["AMEX", "NASDAQ", "NYSE"],
  mandatorySymbols: ["LULU"],
  constraints: {
    minimumPositions: "5",
    maximumPositions: "10",
    maximumPositionWeightBps: "2000",
    minimumCashWeightBps: "500",
  },
} as const satisfies LiquidUniversePolicy);

interface Arguments {
  readonly sessionDate: string;
  readonly artifactPath: string;
  readonly seasonConfigPath: string | null;
  readonly prefilterSize: string;
  readonly lookbackDays: number;
  readonly persistSnapshot: boolean;
  readonly seasonCode: string;
  readonly displayName: string;
}

function argument(name: string): string | undefined {
  return process.argv.slice(2)
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

function arguments_(): Arguments {
  const sessionDate = argument("session-date");
  if (sessionDate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    throw new TypeError("--session-date=YYYY-MM-DD is required");
  }
  const artifactPath = argument("artifact")
    ?? `config/universes/us-liquid-100-${sessionDate}.json`;
  const seasonConfigPath = argument("season-config") ?? null;
  const prefilterSize = argument("prefilter-size") ?? "500";
  if (!/^[1-9]\d*$/.test(prefilterSize) || Number(prefilterSize) < 100) {
    throw new TypeError("--prefilter-size must be an integer of at least 100");
  }
  const lookbackDays = Number(argument("lookback-days") ?? "260");
  if (!Number.isSafeInteger(lookbackDays) || lookbackDays < 180) {
    throw new TypeError("--lookback-days must be an integer of at least 180");
  }
  const persistSnapshot = process.argv.includes("--persist-snapshot");
  const seasonCode = argument("season-code") ?? "private-us-liquid-100-s1";
  const displayName = argument("display-name") ?? "Private US Liquid 100 S1";
  if (seasonConfigPath !== null && !persistSnapshot) {
    throw new TypeError("--season-config requires --persist-snapshot");
  }
  return {
    sessionDate,
    artifactPath,
    seasonConfigPath,
    prefilterSize,
    lookbackDays,
    persistSnapshot,
    seasonCode,
    displayName,
  };
}

async function main(): Promise<void> {
  const input = arguments_();
  const apiKeyId = secret("ALPACA_API_KEY_ID");
  const apiSecretKey = secret("ALPACA_API_SECRET_KEY");
  const catalogSignal = AbortSignal.timeout(120_000);
  const [assets, stockCatalog, tradedDirectory] = await Promise.all([
    fetchAlpacaUniverseAssets({
      apiKeyId,
      apiSecretKey,
      signal: catalogSignal,
    }),
    fetchNasdaqStockCatalog({ signal: catalogSignal }),
    fetchNasdaqTradedDirectory({ signal: catalogSignal }),
  ]);
  const candidates = prefilterLiquidUniverseCandidates({
    asOfSessionDate: input.sessionDate,
    limit: input.prefilterSize,
    policy,
    assets: assets.data,
    stockCatalog: stockCatalog.data,
    tradedDirectory: tradedDirectory.data,
  });
  const startDate = addDays(input.sessionDate, -input.lookbackDays);
  const bars = await fetchAlpacaUniverseBars({
    apiKeyId,
    apiSecretKey,
    symbols: candidates,
    startDate,
    endDate: input.sessionDate,
    signal: AbortSignal.timeout(120_000),
  });
  const observedAt = [
    assets.observedAt,
    stockCatalog.observedAt,
    tradedDirectory.observedAt,
    bars.observedAt,
  ].sort().at(-1)!;
  const freeze = buildLiquidUniverseFreeze({
    asOfSessionDate: input.sessionDate,
    policy,
    sources: {
      observedAt,
      alpacaAssets: {
        url: assets.url,
        responseSha256: assets.responseSha256,
      },
      nasdaqStockScreener: {
        url: stockCatalog.url,
        responseSha256: stockCatalog.responseSha256,
      },
      nasdaqTradedDirectory: {
        url: tradedDirectory.url,
        responseSha256: tradedDirectory.responseSha256,
      },
      alpacaDailyBars: {
        url: bars.url,
        responseSha256: bars.responseSha256,
      },
    },
    assets: assets.data,
    stockCatalog: stockCatalog.data,
    tradedDirectory: tradedDirectory.data,
    bars: bars.data,
    instrumentIdOverrides: { LULU: LULU_INSTRUMENT_ID },
    effectiveFromOverrides: { LULU: "2007-07-27" },
    // Preserve the already-registered immutable LULU identity used by the
    // equal-genesis Season. New instruments use source-derived residency.
    issuerTaxResidencyOverrides: { LULU: "US" },
    issuerOverrides: { LULU: "lululemon athletica inc." },
  });
  const artifactAbsolutePath = insideRepository(input.artifactPath);
  await mkdir(dirname(artifactAbsolutePath), { recursive: true });
  await writeFile(artifactAbsolutePath, freeze.canonicalJson, {
    encoding: "utf8",
    mode: 0o600,
  });

  let snapshot:
    | {
        readonly snapshotId: string;
        readonly snapshotManifestSha256: string;
        readonly snapshotAvailableAt: string;
      }
    | null = null;
  if (input.persistSnapshot) {
    const worker = loadWorkerConfig();
    const memberSymbols = freeze.artifact.members
      .map((member) => member.symbol)
      .sort();
    const market = loadAlpacaMarketDataConfig({
      ...process.env,
      TWOFOLD_MARKET_SYMBOLS: memberSymbols.join(","),
      // The research artifact owns long history. The database decision
      // snapshot needs only a compact recent delivery from which one common
      // target close is sealed; pushing 100 x 180 bars through one RPC is both
      // redundant and vulnerable to hosted statement timeouts.
      TWOFOLD_MARKET_LOOKBACK_DAYS: "7",
      TWOFOLD_MARKET_SOURCE_VERSION: "alpaca-sip-raw-1day-liquid100-v1",
      TWOFOLD_MARKET_SOURCE_EFFECTIVE_FROM: `${input.sessionDate}T00:00:00.000Z`,
    });
    const delivery = await fetchAlpacaDailyBars(market, {
      endAt: `${addDays(input.sessionDate, 1)}T00:00:00.000Z`,
      targetSessionDate: input.sessionDate,
      signal: AbortSignal.timeout(120_000),
    });
    snapshot = await new SupabaseMarketDataRepository(
      worker.supabaseUrl!,
      worker.supabaseSecretKey!,
    ).persist(delivery);
  }

  let seasonConfigPath: string | null = null;
  if (input.seasonConfigPath !== null && snapshot !== null) {
    const calendarEndDate = addDays(input.sessionDate, 14);
    const calendarDelivery = await fetchAlpacaCalendar({
      apiKeyId,
      apiSecretKey,
      startDate: input.sessionDate,
      endDate: calendarEndDate,
    });
    const calendar = planTwoStageCycleCalendar(
      input.sessionDate,
      calendarDelivery.sessions,
      { decisionAvailableAt: freeze.artifact.frozenAt },
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
      artifact: freeze.artifact,
      artifactPath: relative(repositoryRoot, artifactAbsolutePath),
      artifactSha256: freeze.sha256,
      snapshotId: snapshot.snapshotId,
      decisionAvailableAt: snapshot.snapshotAvailableAt,
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
    const configAbsolutePath = insideRepository(input.seasonConfigPath);
    await mkdir(dirname(configAbsolutePath), { recursive: true });
    await writeFile(configAbsolutePath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    seasonConfigPath = relative(repositoryRoot, configAbsolutePath);
  }

  process.stdout.write(`${JSON.stringify({
    schema: freeze.artifact.schema,
    artifactPath: relative(repositoryRoot, artifactAbsolutePath),
    artifactSha256: freeze.sha256,
    asOfSessionDate: freeze.artifact.asOfSessionDate,
    prefilteredCandidateCount: String(candidates.length),
    eligibleCandidateCount: freeze.artifact.eligibleCandidateCount,
    memberCount: String(freeze.artifact.members.length),
    mandatorySymbols: freeze.artifact.policy.mandatorySymbols,
    symbols: freeze.artifact.members.map((member) => member.symbol).sort(),
    snapshot,
    seasonConfigPath,
  }, null, 2)}\n`);
}

function secret(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function insideRepository(path: string): string {
  const absolute = resolve(repositoryRoot, path);
  const relativePath = relative(repositoryRoot, absolute);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new TypeError("output path must be inside the repository");
  }
  return absolute;
}

function addDays(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-liquid-100] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
