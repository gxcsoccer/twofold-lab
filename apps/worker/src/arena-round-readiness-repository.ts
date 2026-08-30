import type { RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTEGER_PATTERN = /^(0|[1-9]\d*)$/;

export const ARENA_ROUND_READINESS_SCHEMA =
  "twofold.arena_round_readiness/v1" as const;
export const ARENA_START_GATE_SCHEMA = "twofold.arena_start_gate/v1" as const;

export interface ArenaRoundReadinessEvidence {
  readonly rulebookCount: string;
  readonly genesisCount: string;
  readonly entrantCount: string;
  readonly initializedAccountCount: string;
  readonly ledgerHeadCount: string;
  readonly universeMemberCount: string;
  readonly roundEntryCount: string;
  readonly workItemCount: string;
  readonly acceptedDecisionCount: string;
  readonly frozenS1PlanCount: string;
  readonly preparedS1ResultCount: string;
  readonly successfulPreS1WorkCount: string;
}

export type ArenaRoundReadinessBlockerCode =
  | "ROUND_MISSING"
  | "RULEBOOK_INCOMPLETE"
  | "GENESIS_INCOMPLETE"
  | "COMPETITION_REQUIRES_TWO_ENTRANTS"
  | "EQUAL_GENESIS_ACCOUNTS_INCOMPLETE"
  | "DECISION_UNIVERSE_EMPTY"
  | "ROUND_ENTRIES_INCOMPLETE"
  | "ROUND_WORK_DAG_INCOMPLETE"
  | "ROUND_TICK_CAPACITY_INSUFFICIENT"
  | "ACCEPTED_DECISIONS_INCOMPLETE"
  | "S1_PLANS_INCOMPLETE";

export interface ArenaRoundReadiness {
  readonly schema: typeof ARENA_ROUND_READINESS_SCHEMA;
  readonly checkedAt: string;
  readonly status: "READY_FOR_S1" | "BLOCKED";
  readonly readyForS1: boolean;
  readonly seasonId: string | null;
  readonly seasonCode: string | null;
  readonly roundId: string;
  readonly roundIndex: string | null;
  readonly evidence: ArenaRoundReadinessEvidence;
  readonly blockers: readonly Readonly<{
    code: ArenaRoundReadinessBlockerCode;
    detail: string;
  }>[];
}

export interface ArenaOperationalHealth {
  readonly schema: "twofold.arena_operational_health/v1";
  readonly checkedAt: string;
  readonly ok: boolean;
  readonly worker: Readonly<{
    workerId: string;
    lastTickAt: string | null;
    lastOutcome: "idle" | "completed" | "failed" | null;
    heartbeatAt: string | null;
    leaseExpiresAt: string | null;
    live: boolean;
  }>;
  readonly activeSeasonCode: string | null;
  readonly latestCorporateActionScanAt: string | null;
  readonly alerts: readonly Readonly<{
    code: string;
    severity: "critical";
    detail: string;
  }>[];
}

export interface ArenaStartGate {
  readonly schema: typeof ARENA_START_GATE_SCHEMA;
  readonly ready: boolean;
  readonly round: ArenaRoundReadiness;
  readonly operations: ArenaOperationalHealth;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaStartGateRpcClient {
  rpc(
    functionName:
      | "get_arena_round_readiness"
      | "get_arena_operational_health",
    arguments_: Readonly<Record<string, unknown>>,
  ): PromiseLike<RpcResult>;
}

export async function getArenaStartGate(
  client: ArenaStartGateRpcClient,
  input: { readonly roundId: string; readonly workerId: string },
): Promise<ArenaStartGate> {
  const roundId = uuid(input.roundId, "roundId");
  const workerId = identity(input.workerId, "workerId");
  const [roundResponse, healthResponse] = await Promise.all([
    client.rpc("get_arena_round_readiness", { p_round_id: roundId }),
    client.rpc("get_arena_operational_health", { p_worker_id: workerId }),
  ]);
  if (roundResponse.error !== null) {
    throw new Error(
      `get_arena_round_readiness failed: ${roundResponse.error.message}`,
    );
  }
  if (healthResponse.error !== null) {
    throw new Error(
      `get_arena_operational_health failed: ${healthResponse.error.message}`,
    );
  }
  const round = parseRoundReadiness(roundResponse.data, roundId);
  const operations = parseOperationalHealth(healthResponse.data, workerId);
  return Object.freeze({
    schema: ARENA_START_GATE_SCHEMA,
    ready: round.readyForS1
      && operations.ok
      && operations.worker.live
      && operations.activeSeasonCode === round.seasonCode,
    round,
    operations,
  });
}

function parseRoundReadiness(
  value: unknown,
  expectedRoundId: string,
): ArenaRoundReadiness {
  assertNoJsonNumber(value, "Arena Round readiness");
  const record = exactRecord(value, [
    "schema", "checkedAt", "status", "readyForS1", "seasonId",
    "seasonCode", "roundId", "roundIndex", "evidence", "blockers",
  ], "Arena Round readiness");
  if (record.schema !== ARENA_ROUND_READINESS_SCHEMA) {
    throw new TypeError("unsupported Arena Round readiness schema");
  }
  const evidenceRecord = exactRecord(record.evidence, [
    "rulebookCount", "genesisCount", "entrantCount",
    "initializedAccountCount", "ledgerHeadCount", "universeMemberCount",
    "roundEntryCount", "workItemCount", "acceptedDecisionCount",
    "frozenS1PlanCount", "preparedS1ResultCount",
    "successfulPreS1WorkCount",
  ], "Arena Round readiness evidence");
  const evidence = Object.freeze(Object.fromEntries(
    Object.entries(evidenceRecord).map(([key, candidate]) => [
      key,
      integer(candidate, `evidence.${key}`),
    ]),
  )) as unknown as ArenaRoundReadinessEvidence;
  const blockers = parseBlockers(record.blockers);
  const status = record.status;
  if (status !== "READY_FOR_S1" && status !== "BLOCKED") {
    throw new TypeError("Arena Round readiness status is unsupported");
  }
  if (typeof record.readyForS1 !== "boolean") {
    throw new TypeError("readyForS1 must be boolean");
  }
  const parsed = Object.freeze({
    schema: ARENA_ROUND_READINESS_SCHEMA,
    checkedAt: timestamp(record.checkedAt, "checkedAt"),
    status,
    readyForS1: record.readyForS1,
    seasonId: nullableUuid(record.seasonId, "seasonId"),
    seasonCode: nullableIdentity(record.seasonCode, "seasonCode"),
    roundId: uuid(record.roundId, "roundId"),
    roundIndex: nullableInteger(record.roundIndex, "roundIndex"),
    evidence,
    blockers,
  }) satisfies ArenaRoundReadiness;
  if (parsed.roundId !== expectedRoundId) {
    throw new TypeError("readiness returned a different Round");
  }
  validateReadinessCoherence(parsed);
  return parsed;
}

function validateReadinessCoherence(value: ArenaRoundReadiness): void {
  if (value.readyForS1 !== (value.status === "READY_FOR_S1")) {
    throw new TypeError("readiness status contradicts readyForS1");
  }
  if (value.readyForS1 !== (value.blockers.length === 0)) {
    throw new TypeError("readiness status contradicts blockers");
  }
  if (value.seasonId === null || value.seasonCode === null || value.roundIndex === null) {
    if (
      value.readyForS1
      || value.blockers.length !== 1
      || value.blockers[0]?.code !== "ROUND_MISSING"
      || Object.values(value.evidence).some((candidate) => candidate !== "0")
    ) throw new TypeError("missing Round readiness is contradictory");
    return;
  }
  if (!value.readyForS1) return;
  const entrants = BigInt(value.evidence.entrantCount);
  if (
    value.evidence.rulebookCount !== "1"
    || value.evidence.genesisCount !== "1"
    || entrants < 2n
    || BigInt(value.evidence.initializedAccountCount) !== entrants
    || BigInt(value.evidence.ledgerHeadCount) !== entrants
    || BigInt(value.evidence.universeMemberCount) < 1n
    || BigInt(value.evidence.roundEntryCount) !== entrants
    || BigInt(value.evidence.workItemCount) !== entrants * 8n
    || BigInt(value.evidence.acceptedDecisionCount) !== entrants
    || BigInt(value.evidence.frozenS1PlanCount) !== entrants
    || BigInt(value.evidence.preparedS1ResultCount) !== entrants
    || BigInt(value.evidence.successfulPreS1WorkCount) !== entrants * 2n
  ) throw new TypeError("ready state contradicts its evidence counts");
}

function parseOperationalHealth(
  value: unknown,
  expectedWorkerId: string,
): ArenaOperationalHealth {
  assertNoJsonNumber(value, "Arena operational health");
  const record = exactRecord(value, [
    "schema", "checkedAt", "ok", "worker", "activeSeasonCode",
    "latestCorporateActionScanAt", "alerts",
  ], "Arena operational health");
  if (record.schema !== "twofold.arena_operational_health/v1") {
    throw new TypeError("unsupported Arena operational health schema");
  }
  const workerRecord = exactRecord(record.worker, [
    "workerId", "lastTickAt", "lastOutcome", "heartbeatAt",
    "leaseExpiresAt", "live",
  ], "Arena operational health worker");
  if (typeof record.ok !== "boolean" || typeof workerRecord.live !== "boolean") {
    throw new TypeError("operational health booleans are invalid");
  }
  const alerts = parseHealthAlerts(record.alerts);
  if (record.ok !== (alerts.length === 0)) {
    throw new TypeError("operational health ok must match alerts");
  }
  const lastOutcome = workerRecord.lastOutcome;
  if (
    lastOutcome !== null && lastOutcome !== "idle"
    && lastOutcome !== "completed" && lastOutcome !== "failed"
  ) throw new TypeError("worker.lastOutcome is unsupported");
  const workerId = identity(workerRecord.workerId, "worker.workerId");
  if (workerId !== expectedWorkerId) {
    throw new TypeError("operational health returned a different Worker");
  }
  return Object.freeze({
    schema: "twofold.arena_operational_health/v1" as const,
    checkedAt: timestamp(record.checkedAt, "operations.checkedAt"),
    ok: record.ok,
    worker: Object.freeze({
      workerId,
      lastTickAt: nullableTimestamp(workerRecord.lastTickAt, "worker.lastTickAt"),
      lastOutcome,
      heartbeatAt: nullableTimestamp(workerRecord.heartbeatAt, "worker.heartbeatAt"),
      leaseExpiresAt: nullableTimestamp(
        workerRecord.leaseExpiresAt,
        "worker.leaseExpiresAt",
      ),
      live: workerRecord.live,
    }),
    activeSeasonCode: nullableIdentity(record.activeSeasonCode, "activeSeasonCode"),
    latestCorporateActionScanAt: nullableTimestamp(
      record.latestCorporateActionScanAt,
      "latestCorporateActionScanAt",
    ),
    alerts,
  });
}

function parseBlockers(value: unknown): ArenaRoundReadiness["blockers"] {
  const allowed = new Set<ArenaRoundReadinessBlockerCode>([
    "ROUND_MISSING", "RULEBOOK_INCOMPLETE", "GENESIS_INCOMPLETE",
    "COMPETITION_REQUIRES_TWO_ENTRANTS",
    "EQUAL_GENESIS_ACCOUNTS_INCOMPLETE", "DECISION_UNIVERSE_EMPTY",
    "ROUND_ENTRIES_INCOMPLETE", "ROUND_WORK_DAG_INCOMPLETE",
    "ROUND_TICK_CAPACITY_INSUFFICIENT",
    "ACCEPTED_DECISIONS_INCOMPLETE", "S1_PLANS_INCOMPLETE",
  ]);
  return Object.freeze(array(value, "blockers").map((candidate, index) => {
    const item = exactRecord(candidate, ["code", "detail"], `blockers[${index}]`);
    const code = identity(item.code, `blockers[${index}].code`);
    if (!allowed.has(code as ArenaRoundReadinessBlockerCode)) {
      throw new TypeError(`blockers[${index}].code is unsupported`);
    }
    return Object.freeze({
      code: code as ArenaRoundReadinessBlockerCode,
      detail: identity(item.detail, `blockers[${index}].detail`),
    });
  }));
}

function parseHealthAlerts(value: unknown): ArenaOperationalHealth["alerts"] {
  return Object.freeze(array(value, "alerts").map((candidate, index) => {
    const item = exactRecord(candidate, ["code", "severity", "detail"], `alerts[${index}]`);
    if (item.severity !== "critical") {
      throw new TypeError(`alerts[${index}].severity is unsupported`);
    }
    return Object.freeze({
      code: identity(item.code, `alerts[${index}].code`),
      severity: "critical" as const,
      detail: identity(item.detail, `alerts[${index}].detail`),
    });
  }));
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
  ) throw new TypeError(`${field} has unexpected fields`);
  return record;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a trimmed non-empty string`);
  }
  return value;
}

function nullableIdentity(value: unknown, field: string): string | null {
  return value === null ? null : identity(value, field);
}

function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function integer(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!INTEGER_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a canonical integer`);
  }
  return parsed;
}

function nullableInteger(value: unknown, field: string): string | null {
  return value === null ? null : integer(value, field);
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || new Date(parsed).toISOString() !== parsed
  ) throw new TypeError(`${field} must be a UTC millisecond timestamp`);
  return parsed;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") throw new TypeError(`${field} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumber(item, `${field}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      assertNoJsonNumber(item, `${field}.${key}`));
  }
}
