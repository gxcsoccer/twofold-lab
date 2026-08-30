import {
  addDecimals,
  calculateCompetitionValuation,
  compareDecimals,
  normalizeDecimal,
  subtractDecimals,
  sumDecimals,
  type AcceptedTargetCycleInput,
  type AcceptedTargetCycleResult,
} from "@twofold/core";

import {
  canonicalJson,
  sha256,
  type ArenaMarketSnapshot,
  type ArenaPortfolioState,
} from "./arena-inputs.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

export type ArenaValuationStage = "OPENING" | "S1_CLOSE" | "S2_CLOSE";

export interface ArenaValuationPayload {
  readonly brokerNav: string;
  readonly estimatedCloseFees: string;
  readonly estimatedUnrealizedLiquidationTax: string;
  readonly feeScheduleIds: readonly string[];
  readonly ledgerSequence: string;
  readonly ledgerSha256: string;
  readonly liquidationNav: string;
  readonly portfolioAsOf: string;
  readonly positionMarketValue: string;
  readonly reportingCurrency: string;
  readonly schema: "twofold.arena_valuation/v1";
  readonly scoreBaseLiquidationNav: string;
  readonly settledCash: string;
  readonly taxReserve: string;
  readonly taxReservedNav: string;
  readonly valuationAt: string;
  readonly valuationDate: string;
}

export interface BuiltArenaValuation {
  readonly stage: ArenaValuationStage;
  readonly snapshotId: string;
  readonly payload: ArenaValuationPayload;
  readonly canonicalJson: string;
  readonly sha256: string;
}

/**
 * Convert the final Core cycle into the Arena's canonical S2 score artifact.
 * The valuation is independently re-derived from final positions and the same
 * frozen close marks, then required to equal the cycle NAV byte-for-byte.
 */
export function buildArenaCycleFinalValuation(input: {
  readonly cycleInput: AcceptedTargetCycleInput;
  readonly cycle: AcceptedTargetCycleResult;
  readonly snapshotId: string;
  readonly scoreBaseLiquidationNav: string;
}): BuiltArenaValuation {
  uuid(input.snapshotId, "snapshotId");
  const marks = new Map(input.cycleInput.instruments.map((instrument) => [
    instrument.instrumentId,
    instrument.finalMark,
  ] as const));
  const settledCash = subtractDecimals(
    input.cycle.nav.brokerNav,
    input.cycle.nav.positionMarketValue,
  );
  const valuation = calculateCompetitionValuation({
    valuationDate: input.cycleInput.timeline.s2TradeDate,
    reportingCurrency: input.cycle.nav.currency,
    settledCash,
    taxReserve: input.cycle.nav.taxReserveDeductions,
    positions: input.cycle.positions
      .filter((position) => position.quantity !== "0")
      .map((position) => {
        const mark = marks.get(position.instrumentId);
        if (mark === undefined) {
          throw new TypeError(`final position ${position.symbol} has no mark`);
        }
        return Object.freeze({
          instrumentId: position.instrumentId,
          symbol: position.symbol,
          quantity: position.quantity,
          taxBasis: sumDecimals(position.lots.map((lot) =>
            addDecimals(lot.grossPurchasePrice, lot.buyFees))),
          markPrice: mark.value,
          currency: input.cycle.nav.currency,
        });
      }),
    ...(input.cycleInput.feeSchedules === undefined
      ? {}
      : { feeSchedules: input.cycleInput.feeSchedules }),
  });
  for (const field of [
    "positionMarketValue", "brokerNav", "taxReserveDeductions",
    "taxReservedNav", "liquidationDeductions", "liquidationNav",
  ] as const) {
    if (valuation.nav[field] !== input.cycle.nav[field]) {
      throw new TypeError(`final Arena valuation diverges at ${field}`);
    }
  }
  const valuationAt = timestamp(
    input.cycleInput.timeline.navAsOf,
    "timeline.navAsOf",
  );
  const scoreBase = requirePositiveBase(input.scoreBaseLiquidationNav);
  const material = {
    brokerNav: valuation.nav.brokerNav,
    estimatedCloseFees:
      valuation.liquidation.estimatedCloseFeesForAllPositions,
    estimatedUnrealizedLiquidationTax:
      valuation.liquidation.estimatedUnrealizedLiquidationTax,
    feeScheduleIds: valuation.liquidation.feeScheduleIds,
    ledgerSequence: input.cycle.finalLedgerHead.sequence,
    ledgerSha256: input.cycle.finalLedgerHead.sha256,
    liquidationNav: valuation.nav.liquidationNav,
    portfolioAsOf: valuationAt,
    positionMarketValue: valuation.nav.positionMarketValue,
    reportingCurrency: valuation.nav.currency,
    schema: "twofold.arena_valuation/v1" as const,
    scoreBaseLiquidationNav: scoreBase,
    settledCash: valuation.settledCash,
    taxReserve: valuation.taxReserve,
    taxReservedNav: valuation.nav.taxReservedNav,
    valuationAt,
    valuationDate: input.cycleInput.timeline.s2TradeDate,
  };
  const serialized = canonicalJson(material);
  return Object.freeze({
    stage: "S2_CLOSE",
    snapshotId: input.snapshotId,
    payload: deepFreeze(JSON.parse(serialized) as ArenaValuationPayload),
    canonicalJson: serialized,
    sha256: sha256(serialized),
  });
}

/**
 * Join one database-authoritative portfolio to one sealed market snapshot and
 * produce the canonical score bytes. There is intentionally no fallback to a
 * newer quote or stale cached price: missing evidence makes valuation fail.
 */
export function buildArenaValuation(input: {
  readonly stage: ArenaValuationStage;
  readonly snapshot: ArenaMarketSnapshot;
  readonly portfolioState: ArenaPortfolioState;
  readonly valuationAt?: string;
  readonly scoreBaseLiquidationNav?: string;
}): BuiltArenaValuation {
  const marks = new Map(
    input.snapshot.bars.map((bar) => [bar.symbol, bar] as const),
  );
  if (marks.size !== input.snapshot.bars.length) {
    throw new TypeError("market snapshot contains duplicate marks");
  }
  const positions = input.portfolioState.positions.map((position) => {
    const bar = marks.get(position.symbol);
    if (bar === undefined) {
      throw new TypeError(
        `portfolio position ${position.symbol} is missing one exact mark`,
      );
    }
    if (
      bar.currency !== input.portfolioState.account.baseCurrency
      || bar.barDate !== input.snapshot.targetSessionDate
    ) {
      throw new TypeError(
        `portfolio position ${position.symbol} mark has mismatched evidence`,
      );
    }
    return Object.freeze({
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      quantity: position.quantity,
      taxBasis: position.taxBasis,
      markPrice: bar.closePrice,
      currency: position.currency,
    });
  });

  const valuation = calculateCompetitionValuation({
    valuationDate: input.snapshot.targetSessionDate,
    reportingCurrency: input.portfolioState.account.baseCurrency,
    settledCash: input.portfolioState.cash.settled,
    taxReserve: input.portfolioState.cash.taxReserve,
    positions,
  });
  const snapshotSealedAt = canonicalTimestamp(
    input.snapshot.sealedAt,
    "snapshot.sealedAt",
  );
  const portfolioAsOf = canonicalTimestamp(
    input.portfolioState.asOf,
    "portfolioState.asOf",
  );
  const valuationAt = input.valuationAt === undefined
    ? latestTimestamp(snapshotSealedAt, portfolioAsOf)
    : timestamp(input.valuationAt, "valuationAt");
  if (
    valuationAt < snapshotSealedAt
    || valuationAt < portfolioAsOf
  ) {
    throw new TypeError("valuationAt precedes its snapshot or portfolio state");
  }
  const scoreBase = input.stage === "OPENING"
    ? valuation.nav.liquidationNav
    : requirePositiveBase(input.scoreBaseLiquidationNav);
  if (
    input.stage === "OPENING"
    && input.scoreBaseLiquidationNav !== undefined
    && compareDecimals(input.scoreBaseLiquidationNav, scoreBase) !== 0
  ) {
    throw new TypeError("opening score base must equal opening Liquidation NAV");
  }

  const material = {
    brokerNav: valuation.nav.brokerNav,
    estimatedCloseFees:
      valuation.liquidation.estimatedCloseFeesForAllPositions,
    estimatedUnrealizedLiquidationTax:
      valuation.liquidation.estimatedUnrealizedLiquidationTax,
    feeScheduleIds: valuation.liquidation.feeScheduleIds,
    ledgerSequence: input.portfolioState.ledgerHead.sequence,
    ledgerSha256: input.portfolioState.ledgerHead.sha256,
    liquidationNav: valuation.nav.liquidationNav,
    portfolioAsOf,
    positionMarketValue: valuation.nav.positionMarketValue,
    reportingCurrency: valuation.nav.currency,
    schema: "twofold.arena_valuation/v1" as const,
    scoreBaseLiquidationNav: scoreBase,
    settledCash: valuation.settledCash,
    taxReserve: valuation.taxReserve,
    taxReservedNav: valuation.nav.taxReservedNav,
    valuationAt,
    valuationDate: input.snapshot.targetSessionDate,
  };
  const serialized = canonicalJson(material);
  const payload = JSON.parse(serialized) as ArenaValuationPayload;
  return Object.freeze({
    stage: input.stage,
    snapshotId: input.snapshot.snapshotId,
    payload: deepFreeze(payload),
    canonicalJson: serialized,
    sha256: sha256(serialized),
  });
}

export interface RegisterArenaValuationRpcArguments {
  readonly p_idempotency_key: string;
  readonly p_round_entry_id: string;
  readonly p_stage: ArenaValuationStage;
  readonly p_snapshot_id: string;
  readonly p_canonical_json: string;
  readonly p_recorded_by: string;
}

export interface ArenaValuationIdentity {
  readonly valuationId: string;
  readonly roundEntryId: string;
  readonly roundId: string;
  readonly seasonId: string;
  readonly entrantId: string;
  readonly runId: string;
  readonly stage: ArenaValuationStage;
  readonly snapshotId: string;
  readonly valuationAt: string;
  readonly valuationDate: string;
  readonly ledgerSequence: string;
  readonly ledgerSha256: string;
  readonly brokerNav: string;
  readonly taxReservedNav: string;
  readonly liquidationNav: string;
  readonly scoreBaseLiquidationNav: string;
  readonly valuationSha256: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

interface ArenaValuationRpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaValuationRpcClient {
  rpc(
    functionName: "register_arena_valuation",
    arguments_: RegisterArenaValuationRpcArguments,
  ): PromiseLike<ArenaValuationRpcResult>;
}

export async function registerArenaValuationExact(
  client: ArenaValuationRpcClient,
  arguments_: RegisterArenaValuationRpcArguments,
  expected: {
    readonly roundId: string;
    readonly seasonId: string;
    readonly entrantId: string;
    readonly runId: string;
    readonly expected: BuiltArenaValuation;
  },
): Promise<ArenaValuationIdentity> {
  identity(arguments_.p_idempotency_key, "p_idempotency_key");
  uuid(arguments_.p_round_entry_id, "p_round_entry_id");
  uuid(arguments_.p_snapshot_id, "p_snapshot_id");
  identity(arguments_.p_recorded_by, "p_recorded_by");
  if (
    arguments_.p_stage !== expected.expected.stage
    || arguments_.p_snapshot_id !== expected.expected.snapshotId
    || arguments_.p_canonical_json !== expected.expected.canonicalJson
  ) {
    throw new TypeError("valuation RPC arguments do not match canonical bytes");
  }

  const result = await retryExactRpcOnce(() => client.rpc(
    "register_arena_valuation",
    arguments_,
  ));
  if (result.error !== null) {
    throw new Error(
      `register_arena_valuation failed: ${result.error?.message ?? "unknown RPC error"}`,
    );
  }
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  assertNoJsonNumber(raw, "register_arena_valuation result");
  const row = exactRecord(raw, [
    "schema", "valuationId", "roundEntryId", "roundId", "seasonId",
    "entrantId", "runId", "stage", "snapshotId", "valuationAt",
    "valuationDate", "ledgerSequence", "ledgerSha256", "brokerNav",
    "taxReservedNav", "liquidationNav", "scoreBaseLiquidationNav",
    "valuationSha256", "recordedBy", "recordedAt",
  ]);
  if (row.schema !== "twofold.arena_valuation_result/v1") {
    throw new TypeError("unsupported Arena valuation result schema");
  }
  const parsed: ArenaValuationIdentity = Object.freeze({
    valuationId: uuid(row.valuationId, "valuationId"),
    roundEntryId: uuid(row.roundEntryId, "roundEntryId"),
    roundId: uuid(row.roundId, "roundId"),
    seasonId: uuid(row.seasonId, "seasonId"),
    entrantId: uuid(row.entrantId, "entrantId"),
    runId: uuid(row.runId, "runId"),
    stage: stage(row.stage),
    snapshotId: uuid(row.snapshotId, "snapshotId"),
    valuationAt: timestamp(row.valuationAt, "valuationAt"),
    valuationDate: date(row.valuationDate, "valuationDate"),
    ledgerSequence: integer(row.ledgerSequence, "ledgerSequence"),
    ledgerSha256: digest(row.ledgerSha256, "ledgerSha256"),
    brokerNav: decimal(row.brokerNav, "brokerNav"),
    taxReservedNav: decimal(row.taxReservedNav, "taxReservedNav"),
    liquidationNav: decimal(row.liquidationNav, "liquidationNav"),
    scoreBaseLiquidationNav: decimal(
      row.scoreBaseLiquidationNav,
      "scoreBaseLiquidationNav",
    ),
    valuationSha256: digest(row.valuationSha256, "valuationSha256"),
    recordedBy: identity(row.recordedBy, "recordedBy"),
    recordedAt: timestamp(row.recordedAt, "recordedAt"),
  });
  const payload = expected.expected.payload;
  if (
    parsed.roundEntryId !== arguments_.p_round_entry_id
    || parsed.roundId !== expected.roundId
    || parsed.seasonId !== expected.seasonId
    || parsed.entrantId !== expected.entrantId
    || parsed.runId !== expected.runId
    || parsed.stage !== expected.expected.stage
    || parsed.snapshotId !== expected.expected.snapshotId
    || parsed.valuationAt !== payload.valuationAt
    || parsed.valuationDate !== payload.valuationDate
    || parsed.ledgerSequence !== payload.ledgerSequence
    || parsed.ledgerSha256 !== payload.ledgerSha256
    || parsed.brokerNav !== payload.brokerNav
    || parsed.taxReservedNav !== payload.taxReservedNav
    || parsed.liquidationNav !== payload.liquidationNav
    || parsed.scoreBaseLiquidationNav !== payload.scoreBaseLiquidationNav
    || parsed.valuationSha256 !== expected.expected.sha256
    || parsed.recordedBy !== arguments_.p_recorded_by
  ) {
    throw new TypeError("register_arena_valuation returned inconsistent content");
  }
  return parsed;
}

function latestTimestamp(left: string, right: string): string {
  return left >= right ? left : right;
}

function requirePositiveBase(value: string | undefined): string {
  if (value === undefined) {
    throw new TypeError("a non-opening valuation requires its opening score base");
  }
  const normalized = normalizeDecimal(value);
  if (compareDecimals(normalized, "0") <= 0) {
    throw new TypeError("score base must be positive");
  }
  return normalized;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Arena valuation result must be an object");
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("Arena valuation result has an unexpected shape");
  }
  return row;
}

function assertNoJsonNumber(value: unknown, field: string): void {
  if (typeof value === "number") throw new TypeError(`${field} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoJsonNumber(item, field));
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => assertNoJsonNumber(item, field));
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

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

function digest(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!DIGEST_PATTERN.test(parsed)) throw new TypeError(`${field} must be SHA-256`);
  return parsed;
}

function integer(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!INTEGER_PATTERN.test(parsed)) throw new TypeError(`${field} must be an integer`);
  return parsed;
}

function decimal(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!DECIMAL_PATTERN.test(parsed)) throw new TypeError(`${field} must be a decimal`);
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  const time = Date.parse(parsed);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== parsed) {
    throw new TypeError(`${field} must be a canonical timestamp`);
  }
  return parsed;
}

function canonicalTimestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  const time = Date.parse(parsed);
  if (!Number.isFinite(time)) {
    throw new TypeError(`${field} must be a timestamp`);
  }
  return new Date(time).toISOString();
}

function date(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)
    || new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed) {
    throw new TypeError(`${field} must be a calendar date`);
  }
  return parsed;
}

function stage(value: unknown): ArenaValuationStage {
  if (value !== "OPENING" && value !== "S1_CLOSE" && value !== "S2_CLOSE") {
    throw new TypeError("stage must be an Arena valuation stage");
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
