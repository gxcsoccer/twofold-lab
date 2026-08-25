import {
  currency,
  decimal,
  nextSequence,
  sequence,
  type DecimalString,
  type CurrencyCode,
  type SequenceString,
} from "./decimal.js";
import {
  compareDecimals,
  multiplyDecimals,
  normalizeDecimal,
  subtractDecimals,
  sumDecimals,
} from "./fixed-decimal.js";

/**
 * All values are already expressed in the run's reporting currency. Fees and
 * withholding that have reduced broker cash must not be supplied again as
 * liabilities here.
 */
export interface NavComponents {
  readonly currency: string;
  readonly settledCash: DecimalString;
  readonly unsettledCash: DecimalString;
  readonly dividendReceivables: DecimalString;
  readonly otherRecognizedReceivables: DecimalString;
  readonly positionMarketValues: readonly DecimalString[];
  readonly unpaidRealizedCapitalGainsTaxAccrual: DecimalString;
  readonly pendingDividendChinaTaxTopUp: DecimalString;
  readonly estimatedForeignWithholdingPayable: DecimalString;
  readonly otherUnpaidChinaTaxAccrual: DecimalString;
  readonly estimatedCloseFeesForAllPositions: DecimalString;
  readonly estimatedUnrealizedLiquidationTax: DecimalString;
}

export interface NavSnapshot {
  readonly currency: CurrencyCode;
  readonly positionMarketValue: DecimalString;
  readonly brokerNav: DecimalString;
  readonly taxReserveDeductions: DecimalString;
  readonly taxReservedNav: DecimalString;
  readonly liquidationDeductions: DecimalString;
  readonly liquidationNav: DecimalString;
}

/** Computes all three NAVs from one immutable, already-resolved component set. */
export function calculateNavSnapshot(components: NavComponents): NavSnapshot {
  const reportingCurrency = currency(components.currency);
  const nonNegative = (value: DecimalString, field: string): DecimalString => {
    const normalized = normalizeDecimal(value);
    if (compareDecimals(normalized, "0") < 0) {
      throw new RangeError(`${field} must be non-negative`);
    }
    return normalized;
  };
  const settledCash = normalizeDecimal(components.settledCash);
  const unsettledCash = normalizeDecimal(components.unsettledCash);
  const dividendReceivables = nonNegative(
    components.dividendReceivables,
    "dividendReceivables",
  );
  const otherRecognizedReceivables = nonNegative(
    components.otherRecognizedReceivables,
    "otherRecognizedReceivables",
  );
  const positionMarketValue = sumDecimals(
    components.positionMarketValues.map((value, index) =>
      nonNegative(value, `positionMarketValues[${index}]`)
    ),
  );
  const brokerNav = sumDecimals([
    settledCash,
    unsettledCash,
    dividendReceivables,
    otherRecognizedReceivables,
    positionMarketValue,
  ]);
  const taxReserveDeductions = sumDecimals([
    nonNegative(
      components.unpaidRealizedCapitalGainsTaxAccrual,
      "unpaidRealizedCapitalGainsTaxAccrual",
    ),
    nonNegative(
      components.pendingDividendChinaTaxTopUp,
      "pendingDividendChinaTaxTopUp",
    ),
    nonNegative(
      components.estimatedForeignWithholdingPayable,
      "estimatedForeignWithholdingPayable",
    ),
    nonNegative(
      components.otherUnpaidChinaTaxAccrual,
      "otherUnpaidChinaTaxAccrual",
    ),
  ]);
  const taxReservedNav = subtractDecimals(brokerNav, taxReserveDeductions);
  const liquidationDeductions = sumDecimals([
    nonNegative(
      components.estimatedCloseFeesForAllPositions,
      "estimatedCloseFeesForAllPositions",
    ),
    nonNegative(
      components.estimatedUnrealizedLiquidationTax,
      "estimatedUnrealizedLiquidationTax",
    ),
  ]);
  const liquidationNav = subtractDecimals(
    taxReservedNav,
    liquidationDeductions,
  );

  return Object.freeze({
    currency: reportingCurrency,
    positionMarketValue,
    brokerNav,
    taxReserveDeductions,
    taxReservedNav,
    liquidationDeductions,
    liquidationNav,
  });
}

export type RoundRunStatus = "ACTIVE" | "TERMINATED";
export type RoundBoundaryType = "SUCCESS" | "FAILURE" | "RUIN";

export interface RoundState {
  readonly initialRoundBase: DecimalString;
  readonly roundBase: DecimalString;
  /** The current base must not be evaluated before this trading date. */
  readonly roundStartsOn: string;
  readonly successCount: SequenceString;
  readonly failureCount: SequenceString;
  readonly status: RoundRunStatus;
  readonly lastBoundaryDate: string | null;
  /** Every resolved close is recorded, including closes with no boundary. */
  readonly lastEvaluatedDate: string | null;
  /** Canonical normalized payload for exact-retry versus conflict detection. */
  readonly lastEvaluatedCloseFingerprint: string | null;
  /** Most recently finalized Season, retained for reporting and inspection. */
  readonly lastFinalizedSeasonId: string | null;
  /** Complete in-state idempotency history; Season count is intentionally small. */
  readonly finalizedSeasonIds: readonly string[];
  /** Index-aligned canonical payloads for finalizedSeasonIds. */
  readonly finalizedSeasonFingerprints: readonly string[];
}

export interface CreateRoundStateInput {
  readonly initialRoundBase: DecimalString;
  readonly startsOn: string;
}

export interface RoundCloseInput {
  readonly tradingDate: string;
  readonly nextTradingDate: string;
  readonly brokerNav: DecimalString;
  readonly liquidationNav: DecimalString;
  /** Delisting or debt can permanently prevent trading even above zero NAV. */
  readonly isPermanentlyUntradeable?: boolean;
}

export interface RoundBoundaryEvent {
  readonly type: RoundBoundaryType;
  readonly tradingDate: string;
  readonly roundBase: DecimalString;
  readonly brokerNav: DecimalString;
  readonly liquidationNav: DecimalString;
  readonly nextRoundBase: DecimalString | null;
  readonly nextRoundStartsOn: string | null;
}

export interface RoundCloseResult {
  readonly state: RoundState;
  readonly event: RoundBoundaryEvent | null;
}

export function createRoundState(input: CreateRoundStateInput): RoundState {
  const initialRoundBase = normalizeDecimal(input.initialRoundBase);
  if (compareDecimals(initialRoundBase, decimal("0")) <= 0) {
    throw new RangeError("Initial Round Base must be greater than zero");
  }
  assertTradingDate(input.startsOn, "startsOn");

  return Object.freeze({
    initialRoundBase,
    roundBase: initialRoundBase,
    roundStartsOn: input.startsOn,
    successCount: sequence("0"),
    failureCount: sequence("0"),
    status: "ACTIVE",
    lastBoundaryDate: null,
    lastEvaluatedDate: null,
    lastEvaluatedCloseFingerprint: null,
    lastFinalizedSeasonId: null,
    finalizedSeasonIds: Object.freeze([]),
    finalizedSeasonFingerprints: Object.freeze([]),
  });
}

/**
 * Applies the one-and-only Round boundary check for a resolved US close.
 * Replaying a date that already emitted a boundary is an idempotent no-op.
 */
export function evaluateRoundClose(
  state: RoundState,
  input: RoundCloseInput,
): RoundCloseResult {
  assertRoundState(state);
  assertTradingDate(input.tradingDate, "tradingDate");
  assertTradingDate(input.nextTradingDate, "nextTradingDate");
  if (input.nextTradingDate <= input.tradingDate) {
    throw new RangeError("nextTradingDate must be after tradingDate");
  }

  const brokerNav = normalizeDecimal(input.brokerNav);
  const liquidationNav = normalizeDecimal(input.liquidationNav);
  if (compareDecimals(liquidationNav, brokerNav) > 0) {
    throw new RangeError("liquidationNav must not exceed brokerNav");
  }
  const closeFingerprint = roundCloseFingerprint(input, brokerNav, liquidationNav);

  if (
    state.lastEvaluatedDate !== null &&
    input.tradingDate < state.lastEvaluatedDate
  ) {
    throw new RangeError("tradingDate must not precede lastEvaluatedDate");
  }

  // A resolved close is immutable. In particular, a later retry cannot turn a
  // no-boundary close into a boundary by supplying a different NAV.
  if (state.lastEvaluatedDate === input.tradingDate) {
    if (state.lastEvaluatedCloseFingerprint !== closeFingerprint) {
      throw new TypeError(
        "Round close date was replayed with a different immutable payload",
      );
    }
    return Object.freeze({ state, event: null });
  }

  if (
    state.status === "TERMINATED" ||
    input.tradingDate < state.roundStartsOn
  ) {
    return Object.freeze({
      state: withLastEvaluatedClose(state, input.tradingDate, closeFingerprint),
      event: null,
    });
  }

  const isRuin =
    compareDecimals(liquidationNav, decimal("0")) <= 0 ||
    input.isPermanentlyUntradeable === true;

  if (isRuin) {
    const event = boundaryEvent(
      "RUIN",
      state,
      input.tradingDate,
      brokerNav,
      liquidationNav,
      null,
      null,
    );
    const nextState = Object.freeze({
      ...state,
      failureCount: nextSequence(state.failureCount),
      status: "TERMINATED" as const,
      lastBoundaryDate: input.tradingDate,
      lastEvaluatedDate: input.tradingDate,
      lastEvaluatedCloseFingerprint: closeFingerprint,
    });
    return Object.freeze({ state: nextState, event });
  }

  const successThreshold = multiplyDecimals(state.roundBase, decimal("2"));
  if (compareDecimals(liquidationNav, successThreshold) >= 0) {
    return restartRound(
      "SUCCESS",
      state,
      input,
      brokerNav,
      liquidationNav,
      closeFingerprint,
    );
  }

  // nav <= 0.5 * base, written without division so no rounding is possible.
  if (
    compareDecimals(
      multiplyDecimals(liquidationNav, decimal("2")),
      state.roundBase,
    ) <= 0
  ) {
    return restartRound(
      "FAILURE",
      state,
      input,
      brokerNav,
      liquidationNav,
      closeFingerprint,
    );
  }

  return Object.freeze({
    state: withLastEvaluatedClose(state, input.tradingDate, closeFingerprint),
    event: null,
  });
}

export type SeasonEndNavResolution =
  | "RESOLVED"
  | "NAV_UNRESOLVED"
  | "TAX_UNRESOLVED";
export type SeasonEndRoundOutcome =
  | "NO_OPEN_ROUND"
  | "INCOMPLETE"
  | "UNRESOLVED";

export interface SeasonEndRoundEvent {
  readonly type: "INCOMPLETE" | "UNRESOLVED";
  readonly seasonId: string;
  readonly tradingDate: string;
  readonly roundBase: DecimalString;
  readonly resolution: SeasonEndNavResolution;
}

export interface SeasonEndRoundResult {
  readonly state: RoundState;
  readonly outcome: SeasonEndRoundOutcome;
  readonly event: SeasonEndRoundEvent | null;
}

/**
 * Finalizes only the Season's view of the Round. The trading state continues
 * unchanged, while the finalization id is retained to make retries idempotent.
 */
export function finalizeRoundAtSeasonEnd(
  state: RoundState,
  input: {
    readonly seasonId: string;
    readonly tradingDate: string;
    readonly resolution: SeasonEndNavResolution;
  },
): SeasonEndRoundResult {
  assertRoundState(state);
  assertSeasonId(input.seasonId);
  assertTradingDate(input.tradingDate, "tradingDate");
  assertSeasonEndResolution(input.resolution);
  const finalizationFingerprint = seasonFinalizationFingerprint(input);

  const existingSeasonIndex = state.finalizedSeasonIds.indexOf(input.seasonId);
  if (existingSeasonIndex >= 0) {
    if (
      state.finalizedSeasonFingerprints[existingSeasonIndex]
      !== finalizationFingerprint
    ) {
      throw new TypeError(
        "Season finalization ID was replayed with a different immutable payload",
      );
    }
    return Object.freeze({
      state,
      outcome: "NO_OPEN_ROUND",
      event: null,
    });
  }

  if (
    state.lastEvaluatedDate !== null &&
    input.tradingDate < state.lastEvaluatedDate
  ) {
    throw new RangeError(
      "Season end tradingDate must not precede lastEvaluatedDate",
    );
  }
  if (
    input.resolution === "RESOLVED" &&
    state.lastEvaluatedDate !== input.tradingDate
  ) {
    throw new RangeError(
      "A resolved Season end requires a Round close evaluation on tradingDate",
    );
  }

  const finalizedState = Object.freeze({
    ...state,
    lastFinalizedSeasonId: input.seasonId,
    finalizedSeasonIds: Object.freeze([
      ...state.finalizedSeasonIds,
      input.seasonId,
    ]),
    finalizedSeasonFingerprints: Object.freeze([
      ...state.finalizedSeasonFingerprints,
      finalizationFingerprint,
    ]),
  });

  // A boundary on the final close creates a zero-day next Round. It is not an
  // incomplete Round; neither is a terminated run.
  if (
    state.status === "TERMINATED" ||
    state.roundStartsOn > input.tradingDate
  ) {
    return Object.freeze({
      state: finalizedState,
      outcome: "NO_OPEN_ROUND",
      event: null,
    });
  }

  const type = input.resolution === "RESOLVED" ? "INCOMPLETE" : "UNRESOLVED";
  const event = Object.freeze({
    type,
    seasonId: input.seasonId,
    tradingDate: input.tradingDate,
    roundBase: state.roundBase,
    resolution: input.resolution,
  });

  return Object.freeze({ state: finalizedState, outcome: type, event });
}

function restartRound(
  type: "SUCCESS" | "FAILURE",
  state: RoundState,
  input: RoundCloseInput,
  brokerNav: DecimalString,
  liquidationNav: DecimalString,
  closeFingerprint: string,
): RoundCloseResult {
  const event = boundaryEvent(
    type,
    state,
    input.tradingDate,
    brokerNav,
    liquidationNav,
    liquidationNav,
    input.nextTradingDate,
  );
  const nextState = Object.freeze({
    ...state,
    roundBase: liquidationNav,
    roundStartsOn: input.nextTradingDate,
    successCount:
      type === "SUCCESS" ? nextSequence(state.successCount) : state.successCount,
    failureCount:
      type === "FAILURE" ? nextSequence(state.failureCount) : state.failureCount,
    lastBoundaryDate: input.tradingDate,
    lastEvaluatedDate: input.tradingDate,
    lastEvaluatedCloseFingerprint: closeFingerprint,
  });
  return Object.freeze({ state: nextState, event });
}

function boundaryEvent(
  type: RoundBoundaryType,
  state: RoundState,
  tradingDate: string,
  brokerNav: DecimalString,
  liquidationNav: DecimalString,
  nextRoundBase: DecimalString | null,
  nextRoundStartsOn: string | null,
): RoundBoundaryEvent {
  return Object.freeze({
    type,
    tradingDate,
    roundBase: state.roundBase,
    brokerNav,
    liquidationNav,
    nextRoundBase,
    nextRoundStartsOn,
  });
}

function assertTradingDate(value: string, name: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new TypeError(`${name} must be an ISO trading date (YYYY-MM-DD)`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]!
  ) {
    throw new TypeError(`${name} must be a real ISO calendar date (YYYY-MM-DD)`);
  }
}

function withLastEvaluatedClose(
  state: RoundState,
  tradingDate: string,
  fingerprint: string,
): RoundState {
  return Object.freeze({
    ...state,
    lastEvaluatedDate: tradingDate,
    lastEvaluatedCloseFingerprint: fingerprint,
  });
}

function roundCloseFingerprint(
  input: RoundCloseInput,
  brokerNav: DecimalString,
  liquidationNav: DecimalString,
): string {
  return JSON.stringify({
    brokerNav,
    isPermanentlyUntradeable: input.isPermanentlyUntradeable === true,
    liquidationNav,
    nextTradingDate: input.nextTradingDate,
    tradingDate: input.tradingDate,
  });
}

function seasonFinalizationFingerprint(input: {
  readonly seasonId: string;
  readonly tradingDate: string;
  readonly resolution: SeasonEndNavResolution;
}): string {
  return JSON.stringify({
    resolution: input.resolution,
    seasonId: input.seasonId,
    tradingDate: input.tradingDate,
  });
}

function assertRoundState(state: RoundState): void {
  const initialRoundBase = normalizeDecimal(state.initialRoundBase);
  const roundBase = normalizeDecimal(state.roundBase);
  if (compareDecimals(initialRoundBase, decimal("0")) <= 0) {
    throw new RangeError("RoundState.initialRoundBase must be greater than zero");
  }
  if (compareDecimals(roundBase, decimal("0")) <= 0) {
    throw new RangeError("RoundState.roundBase must be greater than zero");
  }
  if (state.status !== "ACTIVE" && state.status !== "TERMINATED") {
    throw new TypeError("RoundState.status must be ACTIVE or TERMINATED");
  }

  sequence(state.successCount);
  sequence(state.failureCount);
  assertTradingDate(state.roundStartsOn, "RoundState.roundStartsOn");
  if (state.lastBoundaryDate !== null) {
    assertTradingDate(state.lastBoundaryDate, "RoundState.lastBoundaryDate");
  }
  if (state.lastEvaluatedDate !== null) {
    assertTradingDate(state.lastEvaluatedDate, "RoundState.lastEvaluatedDate");
  }
  if (
    (state.lastEvaluatedDate === null)
    !== (state.lastEvaluatedCloseFingerprint === null)
  ) {
    throw new RangeError(
      "RoundState last evaluated date and fingerprint must be present together",
    );
  }
  if (
    state.lastEvaluatedCloseFingerprint !== null
    && state.lastEvaluatedCloseFingerprint.length === 0
  ) {
    throw new TypeError(
      "RoundState.lastEvaluatedCloseFingerprint must be non-empty",
    );
  }
  if (
    state.lastBoundaryDate !== null &&
    state.lastEvaluatedDate === null
  ) {
    throw new RangeError(
      "RoundState.lastBoundaryDate requires lastEvaluatedDate",
    );
  }
  if (
    state.lastBoundaryDate !== null &&
    state.lastEvaluatedDate !== null &&
    state.lastBoundaryDate > state.lastEvaluatedDate
  ) {
    throw new RangeError(
      "RoundState.lastBoundaryDate must not follow lastEvaluatedDate",
    );
  }
  if (!Array.isArray(state.finalizedSeasonIds)) {
    throw new TypeError("RoundState.finalizedSeasonIds must be an array");
  }
  if (!Array.isArray(state.finalizedSeasonFingerprints)) {
    throw new TypeError("RoundState.finalizedSeasonFingerprints must be an array");
  }
  if (
    state.finalizedSeasonIds.length
    !== state.finalizedSeasonFingerprints.length
  ) {
    throw new RangeError(
      "RoundState finalized Season IDs and fingerprints must be index-aligned",
    );
  }
  const seenSeasonIds = new Set<string>();
  for (const [index, seasonId] of state.finalizedSeasonIds.entries()) {
    assertSeasonId(seasonId);
    if (state.finalizedSeasonFingerprints[index]?.length === 0) {
      throw new TypeError("RoundState finalized Season fingerprints must be non-empty");
    }
    if (seenSeasonIds.has(seasonId)) {
      throw new RangeError("RoundState.finalizedSeasonIds must be unique");
    }
    seenSeasonIds.add(seasonId);
  }
  const expectedLastSeasonId =
    state.finalizedSeasonIds[state.finalizedSeasonIds.length - 1] ?? null;
  if (state.lastFinalizedSeasonId !== expectedLastSeasonId) {
    throw new RangeError(
      "RoundState.lastFinalizedSeasonId must match finalizedSeasonIds",
    );
  }
}

function assertSeasonId(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new TypeError("seasonId must be a non-empty trimmed string");
  }
}

function assertSeasonEndResolution(value: SeasonEndNavResolution): void {
  if (
    value !== "RESOLVED" &&
    value !== "NAV_UNRESOLVED" &&
    value !== "TAX_UNRESOLVED"
  ) {
    throw new TypeError(
      "resolution must be a supported Season end resolution",
    );
  }
}
