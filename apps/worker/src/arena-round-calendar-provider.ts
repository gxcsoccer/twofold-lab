import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  fetchAlpacaCalendar,
  parseAlpacaCalendar,
  planTwoStageCycleCalendar,
  type AlpacaCalendarDelivery,
  type TwoStageCycleCalendar,
} from "./alpaca-calendar.js";
import type {
  ArenaRoundCalendarMaterial,
  ArenaRoundCalendarProvider,
} from "./arena-round-provisioning-handler.js";
import { canonicalJson, sha256 } from "./arena-inputs.js";
import { retryExactRpcOnce } from "./exact-rpc.js";
import { PRIVATE_ARTIFACT_BUCKET } from "./market-data.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ExchangeCalendarArtifact {
  readonly artifactId: string;
  readonly sha256: string;
  readonly storageBucket: string;
  readonly objectPath: string;
}

export interface ExchangeCalendarArtifactRepository {
  find(input: {
    readonly seasonId: string;
    readonly idempotencyKey: string;
  }): Promise<ExchangeCalendarArtifact | null>;
  download(artifact: ExchangeCalendarArtifact): Promise<string>;
  upload(input: {
    readonly storageBucket: string;
    readonly objectPath: string;
    readonly contentType: "application/json";
    readonly content: string;
    readonly sha256: string;
  }): Promise<void>;
  register(input: {
    readonly idempotencyKey: string;
    readonly seasonId: string;
    readonly storageBucket: string;
    readonly objectPath: string;
    readonly contentType: "application/json";
    readonly content: string;
    readonly sha256: string;
    readonly recordedBy: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }): Promise<ExchangeCalendarArtifact>;
}

export type FetchExchangeCalendar = (input: {
  readonly startDate: string;
  readonly endDate: string;
  readonly signal: AbortSignal;
}) => Promise<AlpacaCalendarDelivery>;

export class ExchangeCalendarProvider implements ArenaRoundCalendarProvider {
  readonly #artifacts: ExchangeCalendarArtifactRepository;
  readonly #fetchCalendar: FetchExchangeCalendar;

  constructor(input: {
    readonly artifacts: ExchangeCalendarArtifactRepository;
    readonly fetchCalendar: FetchExchangeCalendar;
  }) {
    this.#artifacts = input.artifacts;
    this.#fetchCalendar = input.fetchCalendar;
  }

  async prepare(
    input: Parameters<ArenaRoundCalendarProvider["prepare"]>[0],
  ): Promise<ArenaRoundCalendarMaterial> {
    input.signal.throwIfAborted();
    const delivery = await this.#fetchCalendar({
      startDate: input.calendarStartDate,
      endDate: input.calendarEndDate,
      signal: input.signal,
    });
    const schedule = planTwoStageCycleCalendar(
      input.decisionSessionDate,
      delivery.sessions,
      { decisionAvailableAt: input.decisionAvailableAt },
    );
    const idempotencyKey = `${input.seasonCode}:round:${input.roundIndex}`
      + `:exchange-calendar:${schedule.s1SessionDate}`;
    const existing = await this.#artifacts.find({
      seasonId: input.seasonId,
      idempotencyKey,
    });
    if (existing !== null) {
      return this.#materialFromStored(
        existing,
        await this.#artifacts.download(existing),
        input.decisionSessionDate,
      );
    }

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
    await this.#artifacts.upload({
      storageBucket: PRIVATE_ARTIFACT_BUCKET,
      objectPath,
      contentType: "application/json",
      content,
      sha256: digest,
    });
    const artifact = await this.#artifacts.register({
      idempotencyKey,
      seasonId: input.seasonId,
      storageBucket: PRIVATE_ARTIFACT_BUCKET,
      objectPath,
      contentType: "application/json",
      content,
      sha256: digest,
      recordedBy: input.recordedBy,
      metadata: Object.freeze({
        schema: "twofold.exchange_calendar_schedule_artifact_metadata/v1",
        provider: "alpaca",
        roundIndex: input.roundIndex,
        decisionSessionDate: input.decisionSessionDate,
        s1SessionDate: schedule.s1SessionDate,
        responseSha256: delivery.responseSha256,
      }),
    });
    if (
      artifact.sha256 !== digest
      || artifact.storageBucket !== PRIVATE_ARTIFACT_BUCKET
      || artifact.objectPath !== objectPath
    ) {
      throw new TypeError("registered exchange calendar artifact is inconsistent");
    }
    return Object.freeze({
      calendarArtifactId: artifact.artifactId,
      calendarArtifactSha256: artifact.sha256,
      schedule,
    });
  }

  #materialFromStored(
    artifact: ExchangeCalendarArtifact,
    content: string,
    decisionSessionDate: string,
  ): ArenaRoundCalendarMaterial {
    if (sha256(content) !== artifact.sha256) {
      throw new TypeError("exchange calendar artifact bytes do not match metadata");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(content) as unknown;
    } catch {
      throw new TypeError("stored exchange calendar artifact is not JSON");
    }
    if (
      raw === null || typeof raw !== "object" || Array.isArray(raw)
      || canonicalJson(raw) !== content
    ) {
      throw new TypeError("stored exchange calendar artifact is not canonical");
    }
    const row = raw as Record<string, unknown>;
    const expectedKeys = [
      "schema", "provider", "endpoint", "retrievedAt", "responseSha256",
      "rawBody", "schedule",
    ].sort();
    if (
      Object.keys(row).sort().some((key, index) => key !== expectedKeys[index])
      || Object.keys(row).length !== expectedKeys.length
      || row.schema !== "twofold.exchange_calendar_schedule_artifact/v1"
      || row.provider !== "alpaca"
      || typeof row.rawBody !== "string"
      || typeof row.responseSha256 !== "string"
      || sha256(row.rawBody) !== row.responseSha256
    ) {
      throw new TypeError("stored exchange calendar artifact has an invalid shape");
    }
    const stored = row.schedule as TwoStageCycleCalendar;
    if (
      stored?.schema !== "twofold.two_stage_cycle_calendar/v1"
      || stored.decisionSessionDate !== decisionSessionDate
    ) {
      throw new TypeError("stored exchange calendar schedule is inconsistent");
    }
    const cutoffProbe = new Date(
      Date.parse(stored.s1OpenAt) - 15 * 60_000 - 1,
    ).toISOString();
    const recomputed = planTwoStageCycleCalendar(
      decisionSessionDate,
      parseAlpacaCalendar(row.rawBody),
      { decisionAvailableAt: cutoffProbe },
    );
    if (canonicalJson(recomputed) !== canonicalJson(stored)) {
      throw new TypeError("stored exchange calendar schedule does not match raw bytes");
    }
    return Object.freeze({
      calendarArtifactId: artifact.artifactId,
      calendarArtifactSha256: artifact.sha256,
      schedule: Object.freeze({ ...stored }),
    });
  }
}

interface ArtifactRow {
  readonly artifact_id: unknown;
  readonly sha256: unknown;
  readonly storage_bucket: unknown;
  readonly object_path: unknown;
}

export class SupabaseExchangeCalendarArtifactRepository
implements ExchangeCalendarArtifactRepository {
  readonly #client: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async find(input: {
    readonly seasonId: string;
    readonly idempotencyKey: string;
  }): Promise<ExchangeCalendarArtifact | null> {
    const result = await this.#client.from("artifact_metadata")
      .select("artifact_id,sha256,storage_bucket,object_path")
      .eq("season_id", input.seasonId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (result.error !== null) {
      throw new Error(`read exchange calendar artifact failed: ${result.error.message}`);
    }
    return result.data === null ? null : parseArtifact(result.data as ArtifactRow);
  }

  async download(artifact: ExchangeCalendarArtifact): Promise<string> {
    const result = await this.#client.storage.from(artifact.storageBucket)
      .download(artifact.objectPath);
    if (result.error !== null) {
      throw new Error(`download exchange calendar artifact failed: ${result.error.message}`);
    }
    return Buffer.from(await result.data.arrayBuffer()).toString("utf8");
  }

  async upload(input: {
    readonly storageBucket: string;
    readonly objectPath: string;
    readonly contentType: "application/json";
    readonly content: string;
    readonly sha256: string;
  }): Promise<void> {
    const result = await this.#client.storage.from(input.storageBucket)
      .upload(input.objectPath, Buffer.from(input.content, "utf8"), {
        contentType: input.contentType,
        upsert: false,
      });
    if (result.error === null) return;
    if (!isDuplicate(result.error)) {
      throw new Error(`upload exchange calendar artifact failed: ${result.error.message}`);
    }
    const existing = await this.#client.storage.from(input.storageBucket)
      .download(input.objectPath);
    if (existing.error !== null) {
      throw new Error(`download duplicate calendar artifact failed: ${existing.error.message}`);
    }
    const bytes = Buffer.from(await existing.data.arrayBuffer());
    if (sha256(bytes) !== input.sha256) {
      throw new Error("content-addressed calendar path contains different bytes");
    }
  }

  async register(input: {
    readonly idempotencyKey: string;
    readonly seasonId: string;
    readonly storageBucket: string;
    readonly objectPath: string;
    readonly contentType: "application/json";
    readonly content: string;
    readonly sha256: string;
    readonly recordedBy: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  }): Promise<ExchangeCalendarArtifact> {
    const arguments_ = Object.freeze({
      p_idempotency_key: input.idempotencyKey,
      p_run_id: null,
      p_season_id: input.seasonId,
      p_source_event_id: null,
      p_artifact_kind: "exchange_calendar_schedule",
      p_storage_bucket: input.storageBucket,
      p_object_path: input.objectPath,
      p_content_type: input.contentType,
      p_byte_size: Buffer.byteLength(input.content, "utf8"),
      p_sha256: input.sha256,
      p_created_by: input.recordedBy,
      p_metadata: input.metadata,
      p_supersedes_artifact_id: null,
    });
    const result = await retryExactRpcOnce(() => this.#client.rpc(
      "register_artifact",
      arguments_,
    ));
    if (result.error !== null) {
      throw new Error(`register exchange calendar artifact failed: ${result.error.message}`);
    }
    const raw = Array.isArray(result.data) ? result.data[0] : result.data;
    return parseArtifact(raw as ArtifactRow);
  }
}

export function createSupabaseExchangeCalendarProvider(input: {
  readonly supabaseUrl: string;
  readonly supabaseSecretKey: string;
  readonly alpacaApiKeyId: string;
  readonly alpacaApiSecretKey: string;
}): ExchangeCalendarProvider {
  return new ExchangeCalendarProvider({
    artifacts: new SupabaseExchangeCalendarArtifactRepository(
      input.supabaseUrl,
      input.supabaseSecretKey,
    ),
    fetchCalendar: ({ startDate, endDate, signal }) => fetchAlpacaCalendar({
      apiKeyId: input.alpacaApiKeyId,
      apiSecretKey: input.alpacaApiSecretKey,
      startDate,
      endDate,
      signal,
    }),
  });
}

function parseArtifact(row: ArtifactRow): ExchangeCalendarArtifact {
  const artifact = Object.freeze({
    artifactId: uuid(row?.artifact_id, "artifact_id"),
    sha256: digest(row?.sha256, "sha256"),
    storageBucket: identity(row?.storage_bucket, "storage_bucket"),
    objectPath: identity(row?.object_path, "object_path"),
  });
  if (artifact.storageBucket !== PRIVATE_ARTIFACT_BUCKET) {
    throw new TypeError("exchange calendar artifact is outside the private bucket");
  }
  return artifact;
}

function isDuplicate(error: {
  statusCode?: string | number | undefined;
  message: string;
}): boolean {
  return Number(error.statusCode) === 409
    || /already exists|duplicate/i.test(error.message);
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function digest(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256`);
  return parsed;
}
