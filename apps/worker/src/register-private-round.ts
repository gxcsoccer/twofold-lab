import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  fetchAlpacaCalendar,
  planTwoStageCycleCalendar,
  type TwoStageCycleCalendar,
} from "./alpaca-calendar.js";
import { canonicalJson, sha256 } from "./arena-inputs.js";
import { registerArenaRoundExact } from "./arena-round-repository.js";
import { loadWorkerConfig } from "./config.js";
import { PRIVATE_ARTIFACT_BUCKET } from "./market-data.js";

interface RoundConfig {
  readonly roundId: string;
  readonly roundIndex: string;
  readonly decisionSnapshotId: string;
  readonly decisionSessionDate: string;
  readonly decisionWindowOpensAt: string;
  readonly decisionWindowClosesAt: string;
  readonly calendarStartDate: string;
  readonly calendarEndDate: string;
}

interface PrivateSeasonConfig {
  readonly schema: "twofold.private_controlled_lab_config/v1";
  readonly season: { readonly seasonId: string; readonly seasonCode: string };
  readonly rounds: readonly RoundConfig[];
}

interface ArtifactRow {
  readonly artifact_id: string;
  readonly sha256: string;
  readonly storage_bucket: string;
  readonly object_path: string;
}

interface StoredRoundRow {
  readonly calendar_artifact_id: string;
  readonly calendar_artifact_sha256: string;
  readonly schedule: TwoStageCycleCalendar;
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

function requestedRoundIndex(): string {
  return process.argv.slice(2)
    .find((value) => value.startsWith("--round="))
    ?.slice("--round=".length)
    ?? "1";
}

async function downloadArtifact(
  client: SupabaseClient,
  row: ArtifactRow,
): Promise<string> {
  const result = await client.storage.from(row.storage_bucket).download(row.object_path);
  if (result.error !== null) {
    throw new Error(`download exchange calendar artifact failed: ${result.error.message}`);
  }
  const content = Buffer.from(await result.data.arrayBuffer()).toString("utf8");
  if (sha256(content) !== row.sha256) {
    throw new Error("exchange calendar artifact bytes do not match metadata");
  }
  return content;
}

function scheduleFromArtifact(content: string): TwoStageCycleCalendar {
  const value = JSON.parse(content) as {
    schema?: unknown;
    responseSha256?: unknown;
    rawBody?: unknown;
    schedule?: TwoStageCycleCalendar;
  };
  if (
    value.schema !== "twofold.exchange_calendar_schedule_artifact/v1"
    || typeof value.responseSha256 !== "string"
    || typeof value.rawBody !== "string"
    || sha256(value.rawBody) !== value.responseSha256
    || value.schedule?.schema !== "twofold.two_stage_cycle_calendar/v1"
    || canonicalJson(value) !== content
  ) {
    throw new TypeError("stored exchange calendar artifact is not exact");
  }
  return value.schedule;
}

async function existingArtifact(
  client: SupabaseClient,
  idempotencyKey: string,
): Promise<ArtifactRow | null> {
  const result = await client.from("artifact_metadata")
    .select("artifact_id,sha256,storage_bucket,object_path")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (result.error !== null) {
    throw new Error(`read exchange calendar artifact failed: ${result.error.message}`);
  }
  return result.data as ArtifactRow | null;
}

async function createCalendarArtifact(
  client: SupabaseClient,
  config: PrivateSeasonConfig,
  round: RoundConfig,
  workerId: string,
): Promise<{ readonly artifact: ArtifactRow; readonly schedule: TwoStageCycleCalendar }> {
  const idempotencyKey =
    `${config.season.seasonCode}:round:${round.roundIndex}:exchange-calendar`;
  const existing = await existingArtifact(client, idempotencyKey);
  if (existing !== null) {
    return {
      artifact: existing,
      schedule: scheduleFromArtifact(await downloadArtifact(client, existing)),
    };
  }

  const delivery = await fetchAlpacaCalendar({
    apiKeyId: process.env.ALPACA_API_KEY_ID ?? "",
    apiSecretKey: process.env.ALPACA_API_SECRET_KEY ?? "",
    startDate: round.calendarStartDate,
    endDate: round.calendarEndDate,
  });
  const schedule = planTwoStageCycleCalendar(
    round.decisionSessionDate,
    delivery.sessions,
  );
  const content = canonicalJson({
    schema: "twofold.exchange_calendar_schedule_artifact/v1",
    provider: "alpaca",
    endpoint: delivery.requestUrl,
    retrievedAt: delivery.retrievedAt,
    responseSha256: delivery.responseSha256,
    rawBody: delivery.rawBody,
    schedule,
  });
  const digest = sha256(content);
  const objectPath = `arena/exchange-calendars/${digest}.json`;
  const upload = await client.storage.from(PRIVATE_ARTIFACT_BUCKET)
    .upload(objectPath, Buffer.from(content, "utf8"), {
      contentType: "application/json",
      upsert: false,
    });
  if (upload.error !== null) {
    const duplicate = Number(upload.error.statusCode) === 409
      || /already exists|duplicate/i.test(upload.error.message);
    if (!duplicate) {
      throw new Error(`upload exchange calendar artifact failed: ${upload.error.message}`);
    }
  }
  const registered = await client.rpc("register_artifact", {
    p_idempotency_key: idempotencyKey,
    p_run_id: null,
    p_season_id: config.season.seasonId,
    p_source_event_id: null,
    p_artifact_kind: "exchange_calendar_schedule",
    p_storage_bucket: PRIVATE_ARTIFACT_BUCKET,
    p_object_path: objectPath,
    p_content_type: "application/json",
    p_byte_size: Buffer.byteLength(content),
    p_sha256: digest,
    p_created_by: workerId,
    p_metadata: {
      schema: "twofold.exchange_calendar_schedule_artifact_metadata/v1",
      provider: "alpaca",
      roundIndex: round.roundIndex,
      decisionSessionDate: round.decisionSessionDate,
      responseSha256: delivery.responseSha256,
    },
    p_supersedes_artifact_id: null,
  });
  if (registered.error !== null) {
    throw new Error(`register exchange calendar artifact failed: ${registered.error.message}`);
  }
  const artifact = (Array.isArray(registered.data)
    ? registered.data[0]
    : registered.data) as ArtifactRow;
  return { artifact, schedule };
}

async function main(): Promise<void> {
  const config = JSON.parse(await readFile(configPath(), "utf8")) as PrivateSeasonConfig;
  if (config.schema !== "twofold.private_controlled_lab_config/v1") {
    throw new TypeError("unsupported private Season config schema");
  }
  const round = config.rounds.find(
    (candidate) => candidate.roundIndex === requestedRoundIndex(),
  );
  if (round === undefined) throw new TypeError("requested Round is not configured");
  const worker = loadWorkerConfig();
  const client = createClient(worker.supabaseUrl!, worker.supabaseSecretKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const existingRound = await client.from("arena_round")
    .select("calendar_artifact_id,calendar_artifact_sha256,schedule")
    .eq("season_id", config.season.seasonId)
    .eq("round_index", round.roundIndex)
    .maybeSingle();
  if (existingRound.error !== null) {
    throw new Error(`read Arena Round failed: ${existingRound.error.message}`);
  }
  const material = existingRound.data === null
    ? await createCalendarArtifact(client, config, round, worker.workerId)
    : {
        artifact: {
          artifact_id: (existingRound.data as StoredRoundRow).calendar_artifact_id,
          sha256: (existingRound.data as StoredRoundRow).calendar_artifact_sha256,
          storage_bucket: PRIVATE_ARTIFACT_BUCKET,
          object_path: "already-bound-by-round",
        },
        schedule: (existingRound.data as StoredRoundRow).schedule,
      };
  const registered = await registerArenaRoundExact(client as never, {
    p_idempotency_key:
      `${config.season.seasonCode}:round:${round.roundIndex}`,
    p_round_id: round.roundId,
    p_season_id: config.season.seasonId,
    p_round_index: round.roundIndex,
    p_decision_snapshot_id: round.decisionSnapshotId,
    p_decision_window_opens_at: round.decisionWindowOpensAt,
    p_decision_window_closes_at: round.decisionWindowClosesAt,
    p_calendar_artifact_id: material.artifact.artifact_id,
    p_calendar_artifact_sha256: material.artifact.sha256,
    p_schedule: material.schedule,
    p_recorded_by: worker.workerId,
  });
  process.stdout.write(`${JSON.stringify(registered, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`[twofold-round-register] fatal: ${String(error)}\n`);
  process.exitCode = 1;
});
