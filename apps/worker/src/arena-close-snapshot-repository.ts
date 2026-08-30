import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

export type ArenaCloseSnapshotStage = "S1_CLOSE" | "S2_CLOSE";

export interface ArenaCloseMark {
  readonly factId: string;
  readonly symbol: string;
  readonly barStart: string;
  readonly sessionDate: string;
  readonly currency: "USD";
  readonly value: string;
  readonly factSha256: string;
  readonly deliveryId: string;
  readonly observedAt: string;
  readonly sourceArtifactId: string;
  readonly sourceContentSha256: string;
}

export interface ArenaRoundCloseSnapshot {
  readonly schema: "twofold.arena_round_close_snapshot/v1";
  readonly roundId: string;
  readonly seasonId: string;
  readonly stage: ArenaCloseSnapshotStage;
  readonly snapshotId: string;
  readonly sourceVersionId: string;
  readonly manifestSha256: string;
  readonly sessionDate: string;
  readonly cutoffAt: string;
  readonly sealedAt: string;
  readonly marks: readonly ArenaCloseMark[];
  readonly boundBy: string;
  readonly boundAt: string;
}

export interface RegisterArenaCloseSnapshotArguments {
  readonly p_idempotency_key: string;
  readonly p_round_id: string;
  readonly p_stage: ArenaCloseSnapshotStage;
  readonly p_snapshot_id: string;
  readonly p_recorded_by: string;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaCloseSnapshotRpcClient {
  rpc(functionName: string, arguments_: Record<string, unknown>): PromiseLike<RpcResult>;
}

export async function getArenaRoundCloseSnapshot(
  client: ArenaCloseSnapshotRpcClient,
  roundId: string,
  closeStage: ArenaCloseSnapshotStage,
): Promise<ArenaRoundCloseSnapshot | null> {
  uuid(roundId, "roundId");
  stage(closeStage);
  const result = await client.rpc("get_arena_round_close_snapshot", {
    p_round_id: roundId,
    p_stage: closeStage,
  });
  if (result.error !== null) {
    throw new Error(
      `get_arena_round_close_snapshot failed: ${result.error.message}`,
    );
  }
  if (result.data === null) return null;
  return parseCloseSnapshot(result.data);
}

export async function registerArenaRoundCloseSnapshotExact(
  client: ArenaCloseSnapshotRpcClient,
  arguments_: RegisterArenaCloseSnapshotArguments,
  expected: {
    readonly seasonId: string;
    readonly manifestSha256: string;
    readonly sessionDate: string;
  },
): Promise<ArenaRoundCloseSnapshot> {
  identity(arguments_.p_idempotency_key, "p_idempotency_key");
  uuid(arguments_.p_round_id, "p_round_id");
  stage(arguments_.p_stage);
  uuid(arguments_.p_snapshot_id, "p_snapshot_id");
  identity(arguments_.p_recorded_by, "p_recorded_by");
  uuid(expected.seasonId, "expected.seasonId");
  sha256(expected.manifestSha256, "expected.manifestSha256");
  date(expected.sessionDate, "expected.sessionDate");

  const result = await retryExactRpcOnce(() => client.rpc(
    "register_arena_round_close_snapshot",
    arguments_ as unknown as Record<string, unknown>,
  ));
  if (result.error !== null) {
    throw new Error(
      `register_arena_round_close_snapshot failed: ${result.error.message}`,
    );
  }
  const parsed = parseCloseSnapshot(result.data);
  if (
    parsed.roundId !== arguments_.p_round_id
    || parsed.seasonId !== expected.seasonId
    || parsed.stage !== arguments_.p_stage
    || parsed.snapshotId !== arguments_.p_snapshot_id
    || parsed.manifestSha256 !== expected.manifestSha256
    || parsed.sessionDate !== expected.sessionDate
    || parsed.boundBy !== arguments_.p_recorded_by
  ) {
    throw new TypeError(
      "register_arena_round_close_snapshot returned inconsistent evidence",
    );
  }
  return parsed;
}

function parseCloseSnapshot(value: unknown): ArenaRoundCloseSnapshot {
  assertNoJsonNumber(value, "Arena close snapshot");
  const row = exactRecord(value, [
    "schema", "roundId", "seasonId", "stage", "snapshotId",
    "sourceVersionId", "manifestSha256", "sessionDate", "cutoffAt",
    "sealedAt", "marks", "boundBy", "boundAt",
  ], "Arena close snapshot");
  if (row.schema !== "twofold.arena_round_close_snapshot/v1") {
    throw new TypeError("unsupported Arena close-snapshot schema");
  }
  if (!Array.isArray(row.marks) || row.marks.length === 0) {
    throw new TypeError("Arena close snapshot must contain marks");
  }
  const marks = row.marks.map((value_, index) => {
    const mark = exactRecord(value_, [
      "factId", "symbol", "barStart", "sessionDate", "currency", "value",
      "factSha256", "deliveryId", "observedAt", "sourceArtifactId",
      "sourceContentSha256",
    ], `marks[${index}]`);
    if (mark.currency !== "USD") {
      throw new TypeError(`marks[${index}].currency must equal USD`);
    }
    return Object.freeze({
      factId: uuid(mark.factId, `marks[${index}].factId`),
      symbol: ticker(mark.symbol, `marks[${index}].symbol`),
      barStart: timestamp(mark.barStart, `marks[${index}].barStart`),
      sessionDate: date(mark.sessionDate, `marks[${index}].sessionDate`),
      currency: "USD" as const,
      value: positiveDecimal(mark.value, `marks[${index}].value`),
      factSha256: sha256(mark.factSha256, `marks[${index}].factSha256`),
      deliveryId: uuid(mark.deliveryId, `marks[${index}].deliveryId`),
      observedAt: timestamp(mark.observedAt, `marks[${index}].observedAt`),
      sourceArtifactId: uuid(
        mark.sourceArtifactId,
        `marks[${index}].sourceArtifactId`,
      ),
      sourceContentSha256: sha256(
        mark.sourceContentSha256,
        `marks[${index}].sourceContentSha256`,
      ),
    });
  });
  for (let index = 1; index < marks.length; index += 1) {
    if (marks[index - 1]!.symbol >= marks[index]!.symbol) {
      throw new TypeError("Arena close marks are not canonically ordered");
    }
  }
  return deepFreeze({
    schema: "twofold.arena_round_close_snapshot/v1",
    roundId: uuid(row.roundId, "roundId"),
    seasonId: uuid(row.seasonId, "seasonId"),
    stage: stage(row.stage),
    snapshotId: uuid(row.snapshotId, "snapshotId"),
    sourceVersionId: uuid(row.sourceVersionId, "sourceVersionId"),
    manifestSha256: sha256(row.manifestSha256, "manifestSha256"),
    sessionDate: date(row.sessionDate, "sessionDate"),
    cutoffAt: timestamp(row.cutoffAt, "cutoffAt"),
    sealedAt: timestamp(row.sealedAt, "sealedAt"),
    marks: Object.freeze(marks),
    boundBy: identity(row.boundBy, "boundBy"),
    boundAt: timestamp(row.boundAt, "boundAt"),
  });
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
  const expected = new Set(keys);
  if (
    Object.keys(record).length !== keys.length
    || Object.keys(record).some((key) => !expected.has(key))
  ) throw new TypeError(`${field} has an unexpected shape`);
  return record;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
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
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be SHA-256`);
  return parsed;
}

function positiveDecimal(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!DECIMAL_PATTERN.test(parsed) || parsed === "0") {
    throw new TypeError(`${field} must be a positive decimal`);
  }
  return parsed;
}

function ticker(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(parsed)) {
    throw new TypeError(`${field} must be a ticker`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (new Date(parsed).toISOString() !== parsed) {
    throw new TypeError(`${field} must be a canonical timestamp`);
  }
  return parsed;
}

function date(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed)
    || new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed
  ) throw new TypeError(`${field} must be a date`);
  return parsed;
}

function stage(value: unknown): ArenaCloseSnapshotStage {
  if (value !== "S1_CLOSE" && value !== "S2_CLOSE") {
    throw new TypeError("stage must be S1_CLOSE or S2_CLOSE");
  }
  return value;
}

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") {
    throw new TypeError(`${field} contains a numeric token`);
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoJsonNumber(item, field));
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => assertNoJsonNumber(item, field));
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
