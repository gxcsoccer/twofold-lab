import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { loadWorkerConfig } from "./config.js";
import {
  buildExecutionRulebookRegistration,
  buildUniverseRegistrations,
  type PrivateSeasonPolicyConfig,
} from "./private-season-policy.js";
import {
  registerArenaSeasonExact,
  registerSeasonEntrantExact,
  type RegisterSeasonEntrantRpcArguments,
} from "./season-identity-repository.js";
import {
  loadLiquidUniverseReference,
  type LiquidUniverseReference,
} from "./liquid-universe-reference.js";

interface PrivateSeasonConfig extends PrivateSeasonPolicyConfig {
  readonly schema: "twofold.private_controlled_lab_config/v1";
  readonly season: {
    readonly seasonId: string;
    readonly seasonCode: string;
    readonly displayName: string;
    readonly opensAt: string;
    readonly closesAt: string;
    readonly decisionCadence: "US_EQUITY_DAILY_AFTER_CLOSE";
    readonly marketTimezone: "America/New_York";
    readonly openingSnapshotId: string;
    readonly openingSessionDate: string;
    readonly openingInstrumentId: string;
    readonly openingSymbol: string;
    readonly openingQuantity: string;
    readonly openingHolding: string;
    readonly openingCash: string;
    readonly genesisId: string;
    readonly fxSourceUrl: string;
  };
  readonly entrants: readonly {
    readonly entrantId: string;
    readonly entrantCode: string;
    readonly runId: string;
    readonly bundleId: string;
    readonly bundleSha256: string;
    readonly presetId: string;
    readonly provider: string;
    readonly model: string;
    readonly executionClass: "ROOT_ONLY" | "ORCHESTRATED";
    readonly track: string;
  }[];
  readonly decisionUniverse?: LiquidUniverseReference;
}

function configPath(): string {
  const argument = process.argv.slice(2).find((value) => value.startsWith("--config="));
  return resolve(
    process.cwd(),
    argument?.slice("--config=".length)
      ?? "config/private-controlled-lab-s1.json",
  );
}

async function main(): Promise<void> {
  const parsed = JSON.parse(await readFile(configPath(), "utf8")) as PrivateSeasonConfig;
  if (parsed.schema !== "twofold.private_controlled_lab_config/v1") {
    throw new TypeError("unsupported private Season config schema");
  }
  if (parsed.entrants.length === 0) {
    throw new TypeError("private Season requires at least one entrant");
  }
  if (parsed.decisionUniverse !== undefined) {
    const loaded = await loadLiquidUniverseReference(
      process.cwd(),
      parsed.decisionUniverse,
    );
    const frozenUniverse = loaded.artifact.members.map((member) => ({
      instrumentId: member.instrumentId,
      symbol: member.symbol,
      instrumentType: member.instrumentType,
      primaryExchange: member.primaryExchange,
      issuerTaxResidency: member.issuerTaxResidency,
      effectiveFrom: member.effectiveFrom,
      issuer: member.issuer,
    }));
    if (JSON.stringify(parsed.universe) !== JSON.stringify(frozenUniverse)) {
      throw new TypeError("Season universe differs from its frozen artifact");
    }
  }
  const worker = loadWorkerConfig();
  const client = createClient(worker.supabaseUrl!, worker.supabaseSecretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const season = parsed.season;
  const registeredSeason = await registerArenaSeasonExact(client as never, {
    p_idempotency_key: season.seasonCode,
    p_season_id: season.seasonId,
    p_season_code: season.seasonCode,
    p_display_name: season.displayName,
    p_opens_at: season.opensAt,
    p_closes_at: season.closesAt,
    p_decision_cadence: season.decisionCadence,
    p_market_timezone: season.marketTimezone,
    p_config: {
      openingSnapshotId: season.openingSnapshotId,
      openingSessionDate: season.openingSessionDate,
      openingHolding: season.openingHolding,
      openingCash: season.openingCash,
    },
    p_recorded_by: worker.workerId,
  });

  const rulebookArguments = buildExecutionRulebookRegistration({
    seasonCode: season.seasonCode,
    seasonId: season.seasonId,
    recordedBy: worker.workerId,
    rulebook: parsed.executionRulebook,
  });
  const rulebook = await client.rpc(
    "register_arena_execution_rulebook",
    rulebookArguments,
  );
  if (rulebook.error !== null) {
    throw new Error(
      `register_arena_execution_rulebook failed: ${rulebook.error.message}`,
    );
  }

  for (const registration of buildUniverseRegistrations(
    parsed.universe,
    worker.workerId,
  )) {
    const instrument = await client.rpc(
      "register_instrument",
      registration.instrument,
    );
    if (instrument.error !== null) {
      throw new Error(`register_instrument failed: ${instrument.error.message}`);
    }
    const symbol = await client.rpc(
      "register_instrument_symbol_version",
      registration.symbol,
    );
    if (symbol.error !== null) {
      throw new Error(
        `register_instrument_symbol_version failed: ${symbol.error.message}`,
      );
    }
  }

  const entrants = [];
  for (const entrant of parsed.entrants) {
    const manifest = {
      schema: "twofold.competition_run_manifest/v1",
      seasonId: season.seasonId,
      entrantId: entrant.entrantId,
      entrantCode: entrant.entrantCode,
      bundleId: entrant.bundleId,
      bundleSha256: entrant.bundleSha256,
      presetId: entrant.presetId,
      provider: entrant.provider,
      model: entrant.model,
      executionClass: entrant.executionClass,
      lotMethod: "FIFO",
    };
    const run = await client.rpc("register_run_manifest", {
      p_idempotency_key: `${season.seasonCode}:run:${entrant.entrantCode}`,
      p_run_id: entrant.runId,
      p_manifest_schema: "twofold.run_manifest/v1",
      p_manifest: manifest,
      p_recorded_by: worker.workerId,
      p_source_sha256: entrant.bundleSha256,
      p_source_artifact_id: null,
    });
    if (run.error !== null) {
      throw new Error(`register_run_manifest failed: ${run.error.message}`);
    }

    const arguments_: RegisterSeasonEntrantRpcArguments = {
      p_idempotency_key:
        `${season.seasonCode}:entrant:${entrant.entrantCode}`,
      p_entrant_id: entrant.entrantId,
      p_season_id: season.seasonId,
      p_entrant_code: entrant.entrantCode,
      p_run_id: entrant.runId,
      p_bundle_id: entrant.bundleId,
      p_bundle_sha256: entrant.bundleSha256,
      p_preset_id: entrant.presetId,
      p_provider: entrant.provider,
      p_model: entrant.model,
      p_execution_class: entrant.executionClass,
      p_metadata: { track: entrant.track },
      p_recorded_by: worker.workerId,
    };
    entrants.push(await registerSeasonEntrantExact(client as never, arguments_));
  }

  process.stdout.write(`${JSON.stringify({
    seasonId: registeredSeason.seasonId,
    seasonCode: registeredSeason.seasonCode,
    executionRulebookSha256: rulebookArguments.p_rulebook_sha256,
    universe: parsed.universe.map(({ instrumentId, symbol }) => ({
      instrumentId,
      symbol,
    })),
    entrants: entrants.map((entrant) => ({
      entrantId: entrant.entrantId,
      entrantCode: entrant.entrantCode,
      runId: entrant.runId,
      bundleSha256: entrant.bundleSha256,
    })),
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-season-register] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
