import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  canonicalFinancialJson,
  createCompetitionGenesis,
} from "@twofold/core";

import {
  initializeCompetitionStrategyAccountExact,
} from "./competition-genesis-repository.js";
import { loadWorkerConfig } from "./config.js";
import { parseEcbUsdCnyReferenceCross } from "./ecb-fx.js";
import { PRIVATE_ARTIFACT_BUCKET } from "./market-data.js";

interface Config {
  readonly schema: "twofold.private_controlled_lab_config/v1";
  readonly season: {
    readonly seasonId: string;
    readonly seasonCode: string;
    readonly openingSnapshotId: string;
    readonly openingSessionDate: string;
    readonly openingInstrumentId: string;
    readonly openingSymbol: string;
    readonly openingQuantity: string;
    readonly openingCash: string;
    readonly genesisId: string;
    readonly fxSourceUrl: string;
  };
  readonly entrants: readonly {
    readonly entrantId: string;
    readonly entrantCode: string;
    readonly runId: string;
  }[];
  readonly universe: readonly {
    readonly instrumentId: string;
    readonly symbol: string;
    readonly instrumentType: "common_stock" | "etf";
    readonly primaryExchange: string;
    readonly issuerTaxResidency: string;
    readonly effectiveFrom: string;
    readonly issuer: string;
  }[];
}

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly source_version_id: string;
  readonly manifest_sha256: string;
  readonly cutoff_at: string;
  readonly target_session_date: string;
  readonly sealed_at: string;
}

interface MemberRow {
  readonly fact_id: string;
  readonly symbol: string;
}

interface FactRow {
  readonly fact_id: string;
  readonly fact_sha256: string;
  readonly bar_date: string;
  readonly currency: string;
  readonly close_price: string;
}

interface ArtifactRow {
  readonly artifact_id: string;
}

interface ExistingGenesisRow {
  readonly economic_state_canonical_json: string;
  readonly economic_state_sha256: string;
}

const ECB_ORIGIN = "https://www.ecb.europa.eu";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstRow<T>(value: unknown, operation: string): T {
  const row = Array.isArray(value) ? value[0] : value;
  if (row === null || typeof row !== "object") {
    throw new Error(`${operation} returned no row`);
  }
  return row as T;
}

function isDuplicateStorageError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { statusCode?: string | number; message?: string };
  return Number(candidate.statusCode) === 409
    || /already exists|duplicate/i.test(candidate.message ?? "");
}

async function uploadExact(
  client: SupabaseClient,
  path: string,
  content: string,
  contentType: string,
  expectedSha256: string,
): Promise<void> {
  const upload = await client.storage.from(PRIVATE_ARTIFACT_BUCKET).upload(
    path,
    Buffer.from(content, "utf8"),
    { contentType, upsert: false },
  );
  if (upload.error === null) return;
  if (!isDuplicateStorageError(upload.error)) {
    throw new Error(`artifact upload failed: ${upload.error.message}`);
  }
  const existing = await client.storage.from(PRIVATE_ARTIFACT_BUCKET).download(path);
  if (existing.error !== null) {
    throw new Error(`existing artifact download failed: ${existing.error.message}`);
  }
  const bytes = new Uint8Array(await existing.data.arrayBuffer());
  if (sha256(bytes) !== expectedSha256) {
    throw new Error("content-addressed artifact path contains different bytes");
  }
}

async function registerArtifact(input: {
  readonly client: SupabaseClient;
  readonly seasonId: string;
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly objectPath: string;
  readonly contentType: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly recordedBy: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}): Promise<string> {
  const result = await input.client.rpc("register_artifact", {
    p_idempotency_key: input.idempotencyKey,
    p_run_id: null,
    p_season_id: input.seasonId,
    p_source_event_id: null,
    p_artifact_kind: input.kind,
    p_storage_bucket: PRIVATE_ARTIFACT_BUCKET,
    p_object_path: input.objectPath,
    p_content_type: input.contentType,
    p_byte_size: Buffer.byteLength(input.content, "utf8"),
    p_sha256: input.contentSha256,
    p_created_by: input.recordedBy,
    p_metadata: input.metadata,
    p_supersedes_artifact_id: null,
  });
  if (result.error !== null) {
    throw new Error(`register_artifact failed: ${result.error.message}`);
  }
  return firstRow<ArtifactRow>(result.data, "register_artifact").artifact_id;
}

async function initializeAccounts(input: {
  readonly client: SupabaseClient;
  readonly config: Config;
  readonly canonicalJson: string;
  readonly sha256: string;
  readonly recordedBy: string;
}) {
  const accounts = [];
  for (const entrant of [...input.config.entrants].sort(
    (left, right) => left.entrantCode.localeCompare(right.entrantCode, "en"),
  )) {
    accounts.push(await initializeCompetitionStrategyAccountExact(
      input.client as never,
      {
      p_account_idempotency_key:
        `${input.config.season.seasonCode}:account:${entrant.entrantCode}`,
      p_run_id: entrant.runId,
      p_account_code: entrant.entrantCode,
      p_broker: "FUTU_HK",
      p_broker_region: "HK",
      p_economic_state_canonical_json: input.canonicalJson,
      p_economic_state_sha256: input.sha256,
      p_recorded_by: input.recordedBy,
      },
    ));
  }
  return Object.freeze(accounts);
}

async function main(): Promise<void> {
  const path = resolve(
    process.cwd(),
    process.env.TWOFOLD_COMPETITION_CONFIG
      ?? "config/private-controlled-lab-s1.json",
  );
  const config = JSON.parse(await readFile(path, "utf8")) as Config;
  if (config.schema !== "twofold.private_controlled_lab_config/v1") {
    throw new TypeError("unsupported private Season config schema");
  }
  const openingInstrument = config.universe.find((instrument) =>
    instrument.instrumentId === config.season.openingInstrumentId
    && instrument.symbol === config.season.openingSymbol);
  if (openingInstrument === undefined) {
    throw new TypeError("opening instrument is absent from the Season universe");
  }
  const worker = loadWorkerConfig();
  const client = createClient(worker.supabaseUrl!, worker.supabaseSecretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const existing = await client.from("competition_genesis")
    .select("economic_state_canonical_json,economic_state_sha256")
    .eq("season_id", config.season.seasonId)
    .eq("genesis_key", config.season.genesisId)
    .maybeSingle<ExistingGenesisRow>();
  if (existing.error !== null) {
    throw new Error(`read competition genesis failed: ${existing.error.message}`);
  }
  if (existing.data !== null) {
    const accounts = await initializeAccounts({
      client,
      config,
      canonicalJson: existing.data.economic_state_canonical_json,
      sha256: existing.data.economic_state_sha256,
      recordedBy: worker.workerId,
    });
    process.stdout.write(`${JSON.stringify({
      status: "EXACT_REPLAY",
      seasonId: config.season.seasonId,
      economicStateSha256: existing.data.economic_state_sha256,
      accounts,
    }, null, 2)}\n`);
    return;
  }

  const snapshotResult = await client.from("market_snapshot")
    .select(
      "snapshot_id,source_version_id,manifest_sha256,cutoff_at,target_session_date,sealed_at",
    )
    .eq("snapshot_id", config.season.openingSnapshotId)
    .single<SnapshotRow>();
  if (snapshotResult.error !== null) {
    throw new Error(`read opening market snapshot failed: ${snapshotResult.error.message}`);
  }
  const snapshot = snapshotResult.data;
  if (snapshot.target_session_date !== config.season.openingSessionDate) {
    throw new Error("opening snapshot session does not match Season config");
  }
  const memberResult = await client.from("market_snapshot_member")
    .select("fact_id,symbol")
    .eq("snapshot_id", snapshot.snapshot_id)
    .eq("symbol", config.season.openingSymbol)
    .single<MemberRow>();
  if (memberResult.error !== null) {
    throw new Error(`read opening snapshot member failed: ${memberResult.error.message}`);
  }
  const factResult = await client.from("market_bar_fact")
    .select("fact_id,fact_sha256,bar_date,currency,close_price")
    .eq("fact_id", memberResult.data.fact_id)
    .single<FactRow>();
  if (factResult.error !== null) {
    throw new Error(`read opening market fact failed: ${factResult.error.message}`);
  }
  const fact = factResult.data;
  if (
    fact.bar_date !== config.season.openingSessionDate
    || fact.currency !== "USD"
  ) {
    throw new Error("opening market fact has the wrong date or currency");
  }

  const sourceUrl = new URL(config.season.fxSourceUrl);
  if (sourceUrl.origin !== ECB_ORIGIN || sourceUrl.username || sourceUrl.password) {
    throw new Error("FX source must use the trusted ECB origin");
  }
  const observedAt = new Date().toISOString();
  const response = await fetch(sourceUrl, {
    headers: { Accept: "application/xml,text/xml" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok || new URL(response.url).origin !== ECB_ORIGIN) {
    throw new Error(`ECB source fetch failed with HTTP ${response.status}`);
  }
  const ecbXml = await response.text();
  const ecbRawSha256 = sha256(ecbXml);
  const fx = parseEcbUsdCnyReferenceCross({
    xml: ecbXml,
    effectiveDate: config.season.openingSessionDate,
    observedAt,
  });
  const ecbArtifactContent = canonicalFinancialJson({
    schema: "twofold.raw_source_envelope/v1",
    sourceUrl: sourceUrl.toString(),
    contentType: "application/xml",
    encoding: "base64",
    rawBodySha256: ecbRawSha256,
    rawBodyBase64: Buffer.from(ecbXml, "utf8").toString("base64"),
    observedAt,
  });
  const ecbArtifactSha256 = sha256(ecbArtifactContent);
  const ecbObjectPath = `competition-sources/ecb/${ecbArtifactSha256}.json`;
  await uploadExact(
    client,
    ecbObjectPath,
    ecbArtifactContent,
    "application/json",
    ecbArtifactSha256,
  );
  const ecbArtifactId = await registerArtifact({
    client,
    seasonId: config.season.seasonId,
    idempotencyKey: `ecb-reference-rates:${ecbArtifactSha256}`,
    kind: "official_tax_fx_rate",
    objectPath: ecbObjectPath,
    contentType: "application/json",
    content: ecbArtifactContent,
    contentSha256: ecbArtifactSha256,
    recordedBy: worker.workerId,
    metadata: {
      schema: "twofold.ecb_reference_source/v1",
      sourceUrl: sourceUrl.toString(),
      effectiveDate: config.season.openingSessionDate,
      observedAt,
      rawBodySha256: ecbRawSha256,
    },
  });

  const openingSource = {
    schema: "twofold.competition_opening_source/v1",
    seasonId: config.season.seasonId,
    genesisId: config.season.genesisId,
    market: {
      semantics: "ALPACA_SIP_RAW_DAILY_CLOSE_REFERENCE",
      snapshotId: snapshot.snapshot_id,
      snapshotSha256: snapshot.manifest_sha256,
      sourceVersionId: snapshot.source_version_id,
      cutoffAt: snapshot.cutoff_at,
      sealedAt: snapshot.sealed_at,
      sessionDate: snapshot.target_session_date,
      instrumentId: config.season.openingInstrumentId,
      symbol: config.season.openingSymbol,
      factId: fact.fact_id,
      factSha256: fact.fact_sha256,
      field: "close",
      value: fact.close_price,
      currency: fact.currency,
    },
    fx: {
      ...fx,
      sourceUrl: sourceUrl.toString(),
      sourceArtifactId: ecbArtifactId,
      sourceSha256: ecbArtifactSha256,
      rawBodySha256: ecbRawSha256,
    },
    terms: {
      quantity: config.season.openingQuantity,
      buyFees: "0",
      settledCash: config.season.openingCash,
      unsettledCash: "0",
    },
  };
  const openingContent = canonicalFinancialJson(openingSource);
  const openingSha256 = sha256(openingContent);
  const openingObjectPath =
    `competition-openings/${config.season.seasonId}/${openingSha256}.json`;
  await uploadExact(
    client,
    openingObjectPath,
    openingContent,
    "application/json",
    openingSha256,
  );
  const openingArtifactId = await registerArtifact({
    client,
    seasonId: config.season.seasonId,
    idempotencyKey: `competition-opening-source:${openingSha256}`,
    kind: "paper_account_opening_state",
    objectPath: openingObjectPath,
    contentType: "application/json",
    content: openingContent,
    contentSha256: openingSha256,
    recordedBy: worker.workerId,
    metadata: {
      schema: "twofold.competition_opening_source_metadata/v1",
      genesisId: config.season.genesisId,
      marketSnapshotId: snapshot.snapshot_id,
      ecbSourceSha256: ecbArtifactSha256,
      ecbRawBodySha256: ecbRawSha256,
    },
  });

  const instrumentResult = await client.rpc("register_instrument", {
    p_idempotency_key:
      `instrument:${openingInstrument.primaryExchange}:${openingInstrument.symbol}`,
    p_instrument_id: config.season.openingInstrumentId,
    p_instrument_type: openingInstrument.instrumentType,
    p_primary_exchange: openingInstrument.primaryExchange,
    p_trading_currency: "USD",
    p_issuer_tax_residency: openingInstrument.issuerTaxResidency,
    p_metadata: { issuer: openingInstrument.issuer },
    p_recorded_by: worker.workerId,
  });
  if (instrumentResult.error !== null) {
    throw new Error(`register_instrument failed: ${instrumentResult.error.message}`);
  }
  const symbolResult = await client.rpc("register_instrument_symbol_version", {
    p_idempotency_key:
      `instrument-symbol:${openingInstrument.primaryExchange}:`
      + `${openingInstrument.symbol}:${openingInstrument.effectiveFrom}`,
    p_instrument_id: config.season.openingInstrumentId,
    p_symbol: openingInstrument.symbol,
    p_exchange: openingInstrument.primaryExchange,
    p_effective_from: openingInstrument.effectiveFrom,
    p_effective_to: null,
    p_metadata: { source: "competition-opening-policy" },
    p_recorded_by: worker.workerId,
  });
  if (symbolResult.error !== null) {
    throw new Error(
      `register_instrument_symbol_version failed: ${symbolResult.error.message}`,
    );
  }

  const asOf = new Date().toISOString();
  const genesis = createCompetitionGenesis({
    schema: "twofold.competition_genesis/v1",
    genesisId: config.season.genesisId,
    seasonId: config.season.seasonId,
    asOf,
    brokerLegalEntity: "FUTU_HK",
    accountRegion: "HK",
    baseCurrency: "USD",
    openingStateArtifactId: openingArtifactId,
    openingStateArtifactSha256: openingSha256,
    cashBalances: [],
    lots: [{
      lotId: `${config.season.genesisId}:lot:1`,
      instrumentId: config.season.openingInstrumentId,
      symbol: config.season.openingSymbol,
      acquiredOn: config.season.openingSessionDate,
      quantity: config.season.openingQuantity,
      purchasePricePerShare: fact.close_price,
      buyFees: "0",
      currency: "USD",
      acquisitionFx: {
        effectiveDate: config.season.openingSessionDate,
        cnyPerUsd: fx.cnyPerUsd,
        authority: fx.authority,
        sourceArtifactId: ecbArtifactId,
        sourceSha256: ecbArtifactSha256,
        observedAt: fx.observedAt,
        availableAt: fx.availableAt,
      },
    }],
    entrants: config.entrants.map((entrant) => ({
      entrantId: entrant.entrantId,
      runId: entrant.runId,
      sourceEventId: `competition-genesis:${config.season.genesisId}`,
    })),
  });
  const accounts = await initializeAccounts({
    client,
    config,
    canonicalJson: genesis.economicCanonicalJson,
    sha256: genesis.economicSha256,
    recordedBy: worker.workerId,
  });

  process.stdout.write(`${JSON.stringify({
    status: "INITIALIZED",
    seasonId: config.season.seasonId,
    genesisId: config.season.genesisId,
    marketSnapshotId: snapshot.snapshot_id,
    openingPrice: fact.close_price,
    openingQuantity: config.season.openingQuantity,
    cnyPerUsd: fx.cnyPerUsd,
    economicStateSha256: genesis.economicSha256,
    openingSourceArtifactId: openingArtifactId,
    ecbSourceArtifactId: ecbArtifactId,
    accounts,
  }, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-genesis-initialize] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
