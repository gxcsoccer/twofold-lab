import type { TwoStageCycleCalendar } from "./alpaca-calendar.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

export interface RegisterArenaRoundRpcArguments {
  readonly p_idempotency_key: string;
  readonly p_round_id: string;
  readonly p_season_id: string;
  readonly p_round_index: string;
  readonly p_decision_snapshot_id: string;
  readonly p_decision_window_opens_at: string;
  readonly p_decision_window_closes_at: string;
  readonly p_calendar_artifact_id: string;
  readonly p_calendar_artifact_sha256: string;
  readonly p_schedule: TwoStageCycleCalendar;
  readonly p_recorded_by: string;
}

export interface ArenaRoundIdentity {
  readonly schema: "twofold.arena_round_result/v1";
  readonly roundId: string;
  readonly seasonId: string;
  readonly roundIndex: string;
  readonly decisionSnapshotId: string;
  readonly decisionSessionDate: string;
  readonly decisionWindowOpensAt: string;
  readonly decisionWindowClosesAt: string;
  readonly s1SessionDate: string;
  readonly s2SessionDate: string;
  readonly cycleReadyAt: string;
  readonly calendarArtifactId: string;
  readonly calendarArtifactSha256: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaRoundRpcClient {
  rpc(
    functionName: "register_arena_round",
    arguments_: RegisterArenaRoundRpcArguments,
  ): PromiseLike<RpcResult>;
}

export async function registerArenaRoundExact(
  client: ArenaRoundRpcClient,
  arguments_: RegisterArenaRoundRpcArguments,
): Promise<ArenaRoundIdentity> {
  validateArguments(arguments_);
  const result = await retryExactRpcOnce(() => client.rpc(
    "register_arena_round",
    arguments_,
  ));
  if (result.error !== null) {
    throw new Error(
      `register_arena_round failed: ${result.error?.message ?? "unknown RPC error"}`,
    );
  }
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  assertNoJsonNumber(raw, "register_arena_round result");
  const row = exactRecord(raw, [
    "schema",
    "roundId",
    "seasonId",
    "roundIndex",
    "decisionSnapshotId",
    "decisionSessionDate",
    "decisionWindowOpensAt",
    "decisionWindowClosesAt",
    "s1SessionDate",
    "s2SessionDate",
    "cycleReadyAt",
    "calendarArtifactId",
    "calendarArtifactSha256",
    "recordedBy",
    "recordedAt",
  ]);
  if (row.schema !== "twofold.arena_round_result/v1") {
    throw new TypeError("unsupported Arena Round result schema");
  }
  const parsed: ArenaRoundIdentity = Object.freeze({
    schema: "twofold.arena_round_result/v1",
    roundId: uuid(row.roundId, "roundId"),
    seasonId: uuid(row.seasonId, "seasonId"),
    roundIndex: positiveInteger(row.roundIndex, "roundIndex"),
    decisionSnapshotId: uuid(row.decisionSnapshotId, "decisionSnapshotId"),
    decisionSessionDate: date(row.decisionSessionDate, "decisionSessionDate"),
    decisionWindowOpensAt: timestamp(
      row.decisionWindowOpensAt,
      "decisionWindowOpensAt",
    ),
    decisionWindowClosesAt: timestamp(
      row.decisionWindowClosesAt,
      "decisionWindowClosesAt",
    ),
    s1SessionDate: date(row.s1SessionDate, "s1SessionDate"),
    s2SessionDate: date(row.s2SessionDate, "s2SessionDate"),
    cycleReadyAt: timestamp(row.cycleReadyAt, "cycleReadyAt"),
    calendarArtifactId: uuid(row.calendarArtifactId, "calendarArtifactId"),
    calendarArtifactSha256: sha256(
      row.calendarArtifactSha256,
      "calendarArtifactSha256",
    ),
    recordedBy: identity(row.recordedBy, "recordedBy"),
    recordedAt: timestamp(row.recordedAt, "recordedAt"),
  });
  if (
    parsed.roundId !== arguments_.p_round_id
    || parsed.seasonId !== arguments_.p_season_id
    || parsed.roundIndex !== arguments_.p_round_index
    || parsed.decisionSnapshotId !== arguments_.p_decision_snapshot_id
    || parsed.decisionSessionDate !== arguments_.p_schedule.decisionSessionDate
    || parsed.decisionWindowOpensAt !== arguments_.p_decision_window_opens_at
    || parsed.decisionWindowClosesAt !== arguments_.p_decision_window_closes_at
    || parsed.s1SessionDate !== arguments_.p_schedule.s1SessionDate
    || parsed.s2SessionDate !== arguments_.p_schedule.s2SessionDate
    || parsed.cycleReadyAt !== arguments_.p_schedule.cycleReadyAt
    || parsed.calendarArtifactId !== arguments_.p_calendar_artifact_id
    || parsed.calendarArtifactSha256 !== arguments_.p_calendar_artifact_sha256
    || parsed.recordedBy !== arguments_.p_recorded_by
  ) {
    throw new TypeError("register_arena_round returned an inconsistent identity");
  }
  return parsed;
}

export interface RegisterArenaRoundEntryRpcArguments {
  readonly p_idempotency_key: string;
  readonly p_round_id: string;
  readonly p_entrant_id: string;
  readonly p_recorded_by: string;
}

export interface ArenaRoundEntryIdentity {
  readonly schema: "twofold.arena_round_entry_result/v1";
  readonly roundEntryId: string;
  readonly roundId: string;
  readonly seasonId: string;
  readonly entrantId: string;
  readonly runId: string;
  readonly decisionId: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface ArenaRoundEntryRpcClient {
  rpc(
    functionName: "register_arena_round_entry",
    arguments_: RegisterArenaRoundEntryRpcArguments,
  ): PromiseLike<RpcResult>;
}

export async function registerArenaRoundEntryExact(
  client: ArenaRoundEntryRpcClient,
  arguments_: RegisterArenaRoundEntryRpcArguments,
  expected: { readonly seasonId: string; readonly runId: string },
): Promise<ArenaRoundEntryIdentity> {
  identity(arguments_.p_idempotency_key, "p_idempotency_key");
  uuid(arguments_.p_round_id, "p_round_id");
  uuid(arguments_.p_entrant_id, "p_entrant_id");
  identity(arguments_.p_recorded_by, "p_recorded_by");
  uuid(expected.seasonId, "expected.seasonId");
  uuid(expected.runId, "expected.runId");
  const result = await retryExactRpcOnce(() => client.rpc(
    "register_arena_round_entry",
    arguments_,
  ));
  if (result.error !== null) {
    throw new Error(
      `register_arena_round_entry failed: ${result.error?.message ?? "unknown RPC error"}`,
    );
  }
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  assertNoJsonNumber(raw, "register_arena_round_entry result");
  const row = exactRecord(raw, [
    "schema",
    "roundEntryId",
    "roundId",
    "seasonId",
    "entrantId",
    "runId",
    "decisionId",
    "recordedBy",
    "recordedAt",
  ]);
  if (row.schema !== "twofold.arena_round_entry_result/v1") {
    throw new TypeError("unsupported Arena Round entry result schema");
  }
  const parsed: ArenaRoundEntryIdentity = Object.freeze({
    schema: "twofold.arena_round_entry_result/v1",
    roundEntryId: uuid(row.roundEntryId, "roundEntryId"),
    roundId: uuid(row.roundId, "roundId"),
    seasonId: uuid(row.seasonId, "seasonId"),
    entrantId: uuid(row.entrantId, "entrantId"),
    runId: uuid(row.runId, "runId"),
    decisionId: uuid(row.decisionId, "decisionId"),
    recordedBy: identity(row.recordedBy, "recordedBy"),
    recordedAt: timestamp(row.recordedAt, "recordedAt"),
  });
  if (
    parsed.roundId !== arguments_.p_round_id
    || parsed.entrantId !== arguments_.p_entrant_id
    || parsed.recordedBy !== arguments_.p_recorded_by
    || parsed.seasonId !== expected.seasonId
    || parsed.runId !== expected.runId
  ) {
    throw new TypeError(
      "register_arena_round_entry returned an inconsistent identity",
    );
  }
  return parsed;
}

function validateArguments(value: RegisterArenaRoundRpcArguments): void {
  identity(value.p_idempotency_key, "p_idempotency_key");
  uuid(value.p_round_id, "p_round_id");
  uuid(value.p_season_id, "p_season_id");
  positiveInteger(value.p_round_index, "p_round_index");
  uuid(value.p_decision_snapshot_id, "p_decision_snapshot_id");
  const opens = timestamp(
    value.p_decision_window_opens_at,
    "p_decision_window_opens_at",
  );
  const closes = timestamp(
    value.p_decision_window_closes_at,
    "p_decision_window_closes_at",
  );
  if (closes <= opens) throw new TypeError("decision window must have positive duration");
  if (closes >= value.p_schedule.s1OpenAt) {
    throw new TypeError("decision window must close before S1 open");
  }
  uuid(value.p_calendar_artifact_id, "p_calendar_artifact_id");
  sha256(value.p_calendar_artifact_sha256, "p_calendar_artifact_sha256");
  assertNoJsonNumber(value.p_schedule, "p_schedule");
  if (value.p_schedule.schema !== "twofold.two_stage_cycle_calendar/v1") {
    throw new TypeError("p_schedule uses an unsupported schema");
  }
  identity(value.p_recorded_by, "p_recorded_by");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Arena Round result must be an object");
  }
  const row = value as Record<string, unknown>;
  const expected = [...keys].sort();
  const actual = Object.keys(row).sort();
  if (
    expected.length !== actual.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new TypeError("Arena Round result has an unexpected shape");
  return row;
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

function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be a SHA-256`);
  return parsed;
}

function positiveInteger(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!POSITIVE_INTEGER_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a canonical positive integer`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || new Date(parsed).toISOString() !== parsed
  ) throw new TypeError(`${field} must be a canonical UTC timestamp`);
  return parsed;
}

function date(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed)
    || new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed
  ) throw new TypeError(`${field} must be a calendar date`);
  return parsed;
}

function assertNoJsonNumber(value: unknown, path: string): void {
  if (typeof value === "number") throw new TypeError(`${path} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumber(item, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertNoJsonNumber(nested, `${path}.${key}`);
    }
  }
}
