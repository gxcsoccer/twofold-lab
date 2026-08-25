import {
  calculateFutuOrderFees,
  type FutuFeeComponents,
  type FutuFeeSchedule,
} from "./futu-fees.js";
import {
  addDecimals,
  compareDecimals,
  maxDecimal,
  multiplyDecimals,
  normalizeDecimal,
  subtractDecimals,
  sumDecimals,
  type DecimalInput,
} from "./fixed-decimal.js";
import {
  currency,
  decimal,
  type CurrencyCode,
  type DecimalString,
} from "./decimal.js";
import { CHINA_INDIVIDUAL_INCOME_TAX_RATE } from "./shadow-tax.js";

export interface LiquidationTaxLot {
  readonly lotId: string;
  readonly quantity: DecimalInput;
  readonly taxBasis: DecimalInput;
}

export interface LiquidationPositionInput {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly markPrice: DecimalInput;
  readonly lots: readonly LiquidationTaxLot[];
}

export interface InstrumentLiquidationAssessment {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly markPrice: DecimalString;
  readonly aggregateMarkValue: DecimalString;
  readonly aggregateTaxBasis: DecimalString;
  readonly feeScheduleId: string;
  readonly feeCurrency: CurrencyCode;
  readonly estimatedCloseFeeComponents: FutuFeeComponents;
  readonly estimatedCloseFees: string;
  readonly unrealizedGainAfterCloseFees: DecimalString;
  readonly estimatedUnrealizedLiquidationTax: DecimalString;
}

export interface PortfolioLiquidationAssessment {
  readonly reportingCurrency: CurrencyCode;
  readonly feeScheduleIds: readonly string[];
  readonly instruments: readonly InstrumentLiquidationAssessment[];
  readonly aggregateMarkValue: DecimalString;
  readonly aggregateTaxBasis: DecimalString;
  readonly estimatedCloseFeesForAllPositions: DecimalString;
  readonly estimatedUnrealizedLiquidationTax: DecimalString;
}

const INTEGER_PATTERN = /^[1-9]\d*$/;

function requireIdentity(value: string, field: string): void {
  if (value.trim() === "") throw new TypeError(`${field} must be non-empty`);
}

function requireNonNegative(value: DecimalInput, field: string): DecimalString {
  const normalized = normalizeDecimal(value);
  if (compareDecimals(normalized, "0") < 0) {
    throw new RangeError(`${field} must be non-negative`);
  }
  return normalized;
}

function requirePositive(value: DecimalInput, field: string): DecimalString {
  const normalized = requireNonNegative(value, field);
  if (normalized === "0") throw new RangeError(`${field} must be positive`);
  return normalized;
}

/**
 * Estimate immediate close fees and tax one aggregate sell order per
 * instrument. Profitable and losing lots inside that instrument offset before
 * max(0, gain); different instruments never offset one another.
 */
export function calculatePortfolioLiquidation(input: {
  readonly valuationDate: string;
  readonly reportingCurrency: string;
  readonly positions: readonly LiquidationPositionInput[];
  readonly feeSchedules?: readonly FutuFeeSchedule[];
}): PortfolioLiquidationAssessment {
  const reportingCurrency = currency(input.reportingCurrency);
  const seenInstruments = new Set<string>();
  const assessments: InstrumentLiquidationAssessment[] = [];

  for (const [positionIndex, position] of input.positions.entries()) {
    requireIdentity(position.instrumentId, `positions[${positionIndex}].instrumentId`);
    requireIdentity(position.symbol, `positions[${positionIndex}].symbol`);
    if (!INTEGER_PATTERN.test(position.quantity)) {
      throw new TypeError(`positions[${positionIndex}].quantity must be a positive integer string`);
    }
    if (seenInstruments.has(position.instrumentId)) {
      throw new TypeError(`Duplicate liquidation instrumentId: ${position.instrumentId}`);
    }
    seenInstruments.add(position.instrumentId);
    const markPrice = requirePositive(position.markPrice, "markPrice");
    const seenLots = new Set<string>();
    let aggregateLotQuantity = decimal("0");
    let aggregateTaxBasis = decimal("0");
    for (const [lotIndex, lot] of position.lots.entries()) {
      requireIdentity(lot.lotId, `positions[${positionIndex}].lots[${lotIndex}].lotId`);
      if (seenLots.has(lot.lotId)) throw new TypeError(`Duplicate lotId: ${lot.lotId}`);
      seenLots.add(lot.lotId);
      aggregateLotQuantity = addDecimals(
        aggregateLotQuantity,
        requirePositive(lot.quantity, "lot.quantity"),
      );
      aggregateTaxBasis = addDecimals(
        aggregateTaxBasis,
        requireNonNegative(lot.taxBasis, "lot.taxBasis"),
      );
    }
    if (compareDecimals(aggregateLotQuantity, position.quantity) !== 0) {
      throw new RangeError(
        `Liquidation lot quantity ${aggregateLotQuantity} does not equal position quantity ${position.quantity} for ${position.instrumentId}`,
      );
    }

    const fee = calculateFutuOrderFees({
      tradeDate: input.valuationDate,
      side: "SELL",
      fills: [{ quantity: position.quantity, price: markPrice }],
      ...(input.feeSchedules === undefined ? {} : { schedules: input.feeSchedules }),
    });
    if (fee.currency !== reportingCurrency) {
      throw new TypeError(
        `Liquidation fee currency ${fee.currency} does not match reporting currency ${reportingCurrency}`,
      );
    }
    const aggregateMarkValue = normalizeDecimal(fee.grossNotional);
    const unrealizedGainAfterCloseFees = subtractDecimals(
      subtractDecimals(aggregateMarkValue, aggregateTaxBasis),
      fee.total,
    );
    const taxableGain = maxDecimal(unrealizedGainAfterCloseFees, "0");
    const estimatedUnrealizedLiquidationTax = multiplyDecimals(
      taxableGain,
      CHINA_INDIVIDUAL_INCOME_TAX_RATE,
    );

    assessments.push(Object.freeze({
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      quantity: position.quantity,
      markPrice,
      aggregateMarkValue,
      aggregateTaxBasis,
      feeScheduleId: fee.feeScheduleId,
      feeCurrency: fee.currency,
      estimatedCloseFeeComponents: fee.components,
      estimatedCloseFees: fee.total,
      unrealizedGainAfterCloseFees,
      estimatedUnrealizedLiquidationTax,
    }));
  }

  assessments.sort((left, right) => left.instrumentId.localeCompare(right.instrumentId));
  return Object.freeze({
    reportingCurrency,
    feeScheduleIds: Object.freeze(
      [...new Set(assessments.map((assessment) => assessment.feeScheduleId))].sort(),
    ),
    instruments: Object.freeze(assessments),
    aggregateMarkValue: sumDecimals(
      assessments.map((assessment) => assessment.aggregateMarkValue),
    ),
    aggregateTaxBasis: sumDecimals(
      assessments.map((assessment) => assessment.aggregateTaxBasis),
    ),
    estimatedCloseFeesForAllPositions: sumDecimals(
      assessments.map((assessment) => assessment.estimatedCloseFees),
    ),
    estimatedUnrealizedLiquidationTax: sumDecimals(
      assessments.map((assessment) => assessment.estimatedUnrealizedLiquidationTax),
    ),
  });
}
