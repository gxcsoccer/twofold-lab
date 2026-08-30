import type { ArenaAccountReplayMaterial } from "./arena-cycle-inputs.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";
import { parseArenaPortfolioState } from "./portfolio-state-repository.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type CorporateActionWorkPhase =
  | "PREPARE"
  | "APPLY"
  | "MISSED_PREPARATION"
  | "UNSUPPORTED";

export interface CorporateActionReplayMaterial extends ArenaAccountReplayMaterial {
  readonly schema: "twofold.corporate_action_account_replay_material/v1";
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly runStreamHead: Readonly<{
    schema: "twofold.event_stream_head/v1";
    streamId: string;
    streamType: "run";
    sequence: string;
    lastEventId: string | null;
  }>;
}

export interface CorporateActionAccountWorkItem {
  readonly seasonId: string;
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly actionType: "FORWARD_SPLIT" | "REVERSE_SPLIT" | "CASH_DIVIDEND";
  readonly symbol: string;
  readonly instrumentId: string;
  readonly interpretation: "SPLIT" | "CASH_DIVIDEND";
  readonly evidenceStatus: "COMPLETE" | "INCOMPLETE";
  readonly exDate: string;
  readonly payableDate: string | null;
  readonly exDateOpenAt: string;
  readonly dueAt: string;
  readonly observedAt: string;
  readonly phase: CorporateActionWorkPhase;
  readonly normalizedAction: Readonly<Record<string, unknown>>;
  readonly preparationId: string | null;
  readonly preparationSha256: string | null;
  readonly preparation: Readonly<Record<string, unknown>> | null;
  readonly replayMaterial: CorporateActionReplayMaterial;
}

export interface CorporateActionAccountWork {
  readonly schema: "twofold.corporate_action_account_work/v1";
  readonly asOf: string;
  readonly items: readonly CorporateActionAccountWorkItem[];
}

interface RpcResult extends RpcResultLike { readonly data: unknown }

export interface CorporateActionWorkRpcClient {
  rpc(
    functionName: "get_corporate_action_account_work",
    arguments_: { readonly p_as_of: string },
  ): PromiseLike<RpcResult>;
}

export async function loadCorporateActionAccountWork(
  client: CorporateActionWorkRpcClient,
  asOf: string,
): Promise<CorporateActionAccountWork> {
  timestamp(asOf, "asOf");
  const result = await retryExactRpcOnce(() => client.rpc(
    "get_corporate_action_account_work",
    { p_as_of: asOf },
  ));
  if (result.error !== null) {
    throw new Error(`get_corporate_action_account_work failed: ${result.error.message}`);
  }
  assertNoJsonNumber(result.data, "corporate-action work");
  const row = exactRecord(result.data, ["schema", "asOf", "items"], "work");
  if (row.schema !== "twofold.corporate_action_account_work/v1") {
    throw new TypeError("unsupported corporate-action work schema");
  }
  const parsedAsOf = timestamp(row.asOf, "work.asOf");
  if (parsedAsOf !== asOf || !Array.isArray(row.items)) {
    throw new TypeError("corporate-action work returned another as-of or invalid items");
  }
  const items = Object.freeze(row.items.map(parseItem));
  return Object.freeze({
    schema: "twofold.corporate_action_account_work/v1",
    asOf: parsedAsOf,
    items,
  });
}

function parseItem(value: unknown, index: number): CorporateActionAccountWorkItem {
  const field = `items[${index}]`;
  const row = exactRecord(value, [
    "seasonId","strategyAccountId","runId","sourceActionId","revisionSha256",
    "actionType","symbol","instrumentId","interpretation","evidenceStatus","exDate",
    "payableDate","exDateOpenAt","dueAt","observedAt","phase",
    "normalizedAction","preparationId","preparationSha256","preparation",
    "replayMaterial",
  ], field);
  const actionType = enumValue(row.actionType, [
    "FORWARD_SPLIT","REVERSE_SPLIT","CASH_DIVIDEND",
  ] as const, `${field}.actionType`);
  const interpretation = enumValue(row.interpretation, [
    "SPLIT","CASH_DIVIDEND",
  ] as const, `${field}.interpretation`);
  if ((actionType === "CASH_DIVIDEND") !== (interpretation === "CASH_DIVIDEND")) {
    throw new TypeError(`${field} action type and interpretation differ`);
  }
  const phase = enumValue(row.phase, [
    "PREPARE","APPLY","MISSED_PREPARATION","UNSUPPORTED",
  ] as const, `${field}.phase`);
  const replay = parseReplayMaterial(row.replayMaterial, field);
  const strategyAccountId = uuid(row.strategyAccountId, `${field}.strategyAccountId`);
  const runId = uuid(row.runId, `${field}.runId`);
  if (replay.strategyAccountId !== strategyAccountId || replay.runId !== runId) {
    throw new TypeError(`${field} replay material belongs to another account`);
  }
  const preparationId = nullableUuid(row.preparationId, `${field}.preparationId`);
  const preparationSha256 = nullableSha(
    row.preparationSha256,
    `${field}.preparationSha256`,
  );
  const preparation = row.preparation === null
    ? null
    : exactRecord(row.preparation, undefined, `${field}.preparation`);
  if ((phase === "APPLY") !== (
    preparationId !== null && preparationSha256 !== null && preparation !== null
  )) {
    throw new TypeError(`${field} APPLY work requires one exact preparation`);
  }
  return Object.freeze({
    seasonId: uuid(row.seasonId, `${field}.seasonId`),
    strategyAccountId,
    runId,
    sourceActionId: uuid(row.sourceActionId, `${field}.sourceActionId`),
    revisionSha256: sha(row.revisionSha256, `${field}.revisionSha256`),
    actionType,
    symbol: ticker(row.symbol, `${field}.symbol`),
    instrumentId: uuid(row.instrumentId, `${field}.instrumentId`),
    interpretation,
    evidenceStatus: enumValue(row.evidenceStatus, [
      "COMPLETE","INCOMPLETE",
    ] as const, `${field}.evidenceStatus`),
    exDate: date(row.exDate, `${field}.exDate`),
    payableDate: row.payableDate === null
      ? null
      : date(row.payableDate, `${field}.payableDate`),
    exDateOpenAt: timestamp(row.exDateOpenAt, `${field}.exDateOpenAt`),
    dueAt: timestamp(row.dueAt, `${field}.dueAt`),
    observedAt: timestamp(row.observedAt, `${field}.observedAt`),
    phase,
    normalizedAction: exactRecord(
      row.normalizedAction,
      undefined,
      `${field}.normalizedAction`,
    ),
    preparationId,
    preparationSha256,
    preparation,
    replayMaterial: replay,
  });
}

function parseReplayMaterial(value: unknown, field: string): CorporateActionReplayMaterial {
  const row = exactRecord(value, [
    "schema","strategyAccountId","runId","portfolio","genesis","priorCycles",
    "priorCorporateActions","runStreamHead",
  ], `${field}.replayMaterial`);
  if (row.schema !== "twofold.corporate_action_account_replay_material/v1") {
    throw new TypeError(`${field} has unsupported replay material`);
  }
  const strategyAccountId = uuid(
    row.strategyAccountId,
    `${field}.replayMaterial.strategyAccountId`,
  );
  const runId = uuid(row.runId, `${field}.replayMaterial.runId`);
  const portfolio = parseArenaPortfolioState(row.portfolio);
  if (portfolio.strategyAccountId !== strategyAccountId || portfolio.runId !== runId) {
    throw new TypeError(`${field} replay portfolio identity differs`);
  }
  if (!Array.isArray(row.priorCycles) || !Array.isArray(row.priorCorporateActions)) {
    throw new TypeError(`${field} replay histories must be arrays`);
  }
  const stream = exactRecord(row.runStreamHead, [
    "schema","streamId","streamType","sequence","lastEventId",
  ], `${field}.runStreamHead`);
  if (stream.schema !== "twofold.event_stream_head/v1"
    || stream.streamType !== "run"
    || uuid(stream.streamId, `${field}.streamId`) !== runId) {
    throw new TypeError(`${field} run stream head identity differs`);
  }
  return Object.freeze({
    schema: "twofold.corporate_action_account_replay_material/v1",
    strategyAccountId,
    runId,
    portfolio,
    genesis: exactRecord(row.genesis, undefined, `${field}.genesis`),
    priorCycles: Object.freeze(row.priorCycles.map((candidate, historyIndex) =>
      exactRecord(candidate, undefined, `${field}.priorCycles[${historyIndex}]`))),
    priorCorporateActions: Object.freeze(row.priorCorporateActions.map(
      (candidate, historyIndex) => exactRecord(
        candidate,
        undefined,
        `${field}.priorCorporateActions[${historyIndex}]`,
      ),
    )),
    runStreamHead: Object.freeze({
      schema: "twofold.event_stream_head/v1",
      streamId: runId,
      streamType: "run",
      sequence: integer(stream.sequence, `${field}.runStreamHead.sequence`),
      lastEventId: nullableUuid(stream.lastEventId, `${field}.lastEventId`),
    }),
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[] | undefined,
  field: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const row = value as Record<string, unknown>;
  if (keys !== undefined) {
    const actual = Object.keys(row).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
      throw new TypeError(`${field} has unexpected fields`);
    }
  }
  return Object.freeze(row);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as T[number];
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value;
}

function nullableUuid(value: unknown, field: string): string | null {
  return value === null ? null : uuid(value, field);
}

function sha(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256`);
  }
  return value;
}

function nullableSha(value: unknown, field: string): string | null {
  return value === null ? null : sha(value, field);
}

function integer(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${field} must be a non-negative integer string`);
  }
  return value;
}

function ticker(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(value)) {
    throw new TypeError(`${field} must be a ticker`);
  }
  return value;
}

function date(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a calendar date`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function assertNoJsonNumber(value: unknown, path: string): void {
  if (typeof value === "number") throw new TypeError(`${path} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((nested, index) => assertNoJsonNumber(nested, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertNoJsonNumber(nested, `${path}.${key}`);
    }
  }
}
