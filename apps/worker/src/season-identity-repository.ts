import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface RegisterArenaSeasonRpcArguments {
  readonly p_idempotency_key: string;
  readonly p_season_id: string;
  readonly p_season_code: string;
  readonly p_display_name: string;
  readonly p_opens_at: string;
  readonly p_closes_at: string;
  readonly p_decision_cadence: "US_EQUITY_DAILY_AFTER_CLOSE";
  readonly p_market_timezone: "America/New_York";
  readonly p_config: Readonly<Record<string, unknown>>;
  readonly p_recorded_by: string;
}

export interface RegisterSeasonEntrantRpcArguments {
  readonly p_idempotency_key: string;
  readonly p_entrant_id: string;
  readonly p_season_id: string;
  readonly p_entrant_code: string;
  readonly p_run_id: string;
  readonly p_bundle_id: string;
  readonly p_bundle_sha256: string;
  readonly p_preset_id: string;
  readonly p_provider: string;
  readonly p_model: string;
  readonly p_execution_class: "ROOT_ONLY" | "ORCHESTRATED";
  readonly p_metadata: Readonly<Record<string, unknown>>;
  readonly p_recorded_by: string;
}

export interface ArenaSeasonIdentity {
  readonly seasonId: string;
  readonly seasonCode: string;
  readonly displayName: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly decisionCadence: "US_EQUITY_DAILY_AFTER_CLOSE";
  readonly marketTimezone: "America/New_York";
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface SeasonEntrantIdentity {
  readonly entrantId: string;
  readonly seasonId: string;
  readonly entrantCode: string;
  readonly runId: string;
  readonly bundleId: string;
  readonly bundleSha256: string;
  readonly presetId: string;
  readonly provider: string;
  readonly model: string;
  readonly executionClass: "ROOT_ONLY" | "ORCHESTRATED";
  readonly recordedBy: string;
  readonly recordedAt: string;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface SeasonIdentityRpcClient {
  rpc(
    functionName: "register_arena_season",
    arguments_: RegisterArenaSeasonRpcArguments,
  ): PromiseLike<RpcResult>;
  rpc(
    functionName: "register_season_entrant",
    arguments_: RegisterSeasonEntrantRpcArguments,
  ): PromiseLike<RpcResult>;
}

export async function registerArenaSeasonExact(
  client: SeasonIdentityRpcClient,
  arguments_: RegisterArenaSeasonRpcArguments,
): Promise<ArenaSeasonIdentity> {
  validateSeasonArguments(arguments_);
  const result = await retryExactRpcOnce(() => client.rpc(
    "register_arena_season",
    arguments_,
  ));
  if (result.error !== null) {
    throw new Error(
      `register_arena_season failed: ${result.error.message}`,
    );
  }
  const record = exactRecord(singleResult(result.data), [
    "season_id", "idempotency_key", "season_code", "display_name",
    "opens_at", "closes_at", "decision_cadence", "market_timezone",
    "config", "recorded_by", "recorded_at",
  ], "register_arena_season result");
  assertNoJsonNumber(record, "register_arena_season result");
  const parsed: ArenaSeasonIdentity = Object.freeze({
    seasonId: uuid(record.season_id, "season_id"),
    seasonCode: identity(record.season_code, "season_code"),
    displayName: identity(record.display_name, "display_name"),
    opensAt: timestamp(record.opens_at, "opens_at"),
    closesAt: timestamp(record.closes_at, "closes_at"),
    decisionCadence: literal(
      record.decision_cadence,
      "US_EQUITY_DAILY_AFTER_CLOSE",
      "decision_cadence",
    ),
    marketTimezone: literal(
      record.market_timezone,
      "America/New_York",
      "market_timezone",
    ),
    recordedBy: identity(record.recorded_by, "recorded_by"),
    recordedAt: timestamp(record.recorded_at, "recorded_at"),
  });
  if (
    parsed.seasonId !== arguments_.p_season_id
    || parsed.seasonCode !== arguments_.p_season_code
    || parsed.displayName !== arguments_.p_display_name
    || parsed.opensAt !== timestamp(arguments_.p_opens_at, "p_opens_at")
    || parsed.closesAt !== timestamp(arguments_.p_closes_at, "p_closes_at")
    || parsed.recordedBy !== arguments_.p_recorded_by
    || record.idempotency_key !== arguments_.p_idempotency_key
    || !sameJson(record.config, arguments_.p_config)
  ) {
    throw new TypeError("register_arena_season returned an inconsistent identity");
  }
  return parsed;
}

export async function registerSeasonEntrantExact(
  client: SeasonIdentityRpcClient,
  arguments_: RegisterSeasonEntrantRpcArguments,
): Promise<SeasonEntrantIdentity> {
  validateEntrantArguments(arguments_);
  const result = await retryExactRpcOnce(() => client.rpc(
    "register_season_entrant",
    arguments_,
  ));
  if (result.error !== null) {
    throw new Error(
      `register_season_entrant failed: ${result.error.message}`,
    );
  }
  const record = exactRecord(singleResult(result.data), [
    "entrant_id", "idempotency_key", "season_id", "entrant_code", "run_id",
    "bundle_id", "bundle_sha256", "preset_id", "provider", "model",
    "execution_class", "metadata", "recorded_by", "recorded_at",
  ], "register_season_entrant result");
  assertNoJsonNumber(record, "register_season_entrant result");
  const parsed: SeasonEntrantIdentity = Object.freeze({
    entrantId: uuid(record.entrant_id, "entrant_id"),
    seasonId: uuid(record.season_id, "season_id"),
    entrantCode: identity(record.entrant_code, "entrant_code"),
    runId: uuid(record.run_id, "run_id"),
    bundleId: identity(record.bundle_id, "bundle_id"),
    bundleSha256: sha256(record.bundle_sha256, "bundle_sha256"),
    presetId: identity(record.preset_id, "preset_id"),
    provider: identity(record.provider, "provider"),
    model: identity(record.model, "model"),
    executionClass: executionClass(record.execution_class),
    recordedBy: identity(record.recorded_by, "recorded_by"),
    recordedAt: timestamp(record.recorded_at, "recorded_at"),
  });
  if (
    parsed.entrantId !== arguments_.p_entrant_id
    || parsed.seasonId !== arguments_.p_season_id
    || parsed.entrantCode !== arguments_.p_entrant_code
    || parsed.runId !== arguments_.p_run_id
    || parsed.bundleId !== arguments_.p_bundle_id
    || parsed.bundleSha256 !== arguments_.p_bundle_sha256
    || parsed.presetId !== arguments_.p_preset_id
    || parsed.provider !== arguments_.p_provider
    || parsed.model !== arguments_.p_model
    || parsed.executionClass !== arguments_.p_execution_class
    || parsed.recordedBy !== arguments_.p_recorded_by
    || record.idempotency_key !== arguments_.p_idempotency_key
    || !sameJson(record.metadata, arguments_.p_metadata)
  ) {
    throw new TypeError(
      "register_season_entrant returned a result inconsistent with the exact request",
    );
  }
  return parsed;
}

function validateSeasonArguments(value: RegisterArenaSeasonRpcArguments): void {
  identity(value.p_idempotency_key, "p_idempotency_key");
  uuid(value.p_season_id, "p_season_id");
  identity(value.p_season_code, "p_season_code");
  identity(value.p_display_name, "p_display_name");
  const opens = timestamp(value.p_opens_at, "p_opens_at");
  const closes = timestamp(value.p_closes_at, "p_closes_at");
  if (closes <= opens) throw new TypeError("Season closes_at must follow opens_at");
  assertNoJsonNumber(value.p_config, "p_config");
  identity(value.p_recorded_by, "p_recorded_by");
}

function validateEntrantArguments(value: RegisterSeasonEntrantRpcArguments): void {
  identity(value.p_idempotency_key, "p_idempotency_key");
  uuid(value.p_entrant_id, "p_entrant_id");
  uuid(value.p_season_id, "p_season_id");
  identity(value.p_entrant_code, "p_entrant_code");
  uuid(value.p_run_id, "p_run_id");
  identity(value.p_bundle_id, "p_bundle_id");
  sha256(value.p_bundle_sha256, "p_bundle_sha256");
  identity(value.p_preset_id, "p_preset_id");
  identity(value.p_provider, "p_provider");
  identity(value.p_model, "p_model");
  executionClass(value.p_execution_class);
  assertNoJsonNumber(value.p_metadata, "p_metadata");
  identity(value.p_recorded_by, "p_recorded_by");
}

function singleResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new TypeError("RPC must return exactly one result");
    return value[0];
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expected = [...keys].sort();
  const actual = Object.keys(record).sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${field} has unexpected or missing fields`);
  }
  return record;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a canonical lowercase UUID`);
  }
  return parsed;
}

function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256`);
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  const date = new Date(parsed);
  if (!Number.isFinite(date.valueOf())) throw new TypeError(`${field} must be a timestamp`);
  return date.toISOString();
}

function literal<const T extends string>(
  value: unknown,
  expected: T,
  field: string,
): T {
  if (value !== expected) throw new TypeError(`${field} must be ${expected}`);
  return expected;
}

function executionClass(value: unknown): "ROOT_ONLY" | "ORCHESTRATED" {
  if (value !== "ROOT_ONLY" && value !== "ORCHESTRATED") {
    throw new TypeError("execution_class is unsupported");
  }
  return value;
}

function assertNoJsonNumber(value: unknown, path: string): void {
  if (typeof value === "number" || typeof value === "bigint") {
    throw new TypeError(`${path} contains a numeric token`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoJsonNumber(entry, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertNoJsonNumber(entry, `${path}.${key}`);
    }
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, sortJson(record[key])]),
  );
}
