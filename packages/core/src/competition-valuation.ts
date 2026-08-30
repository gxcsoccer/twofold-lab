import {
  currency,
  type CurrencyCode,
  type DecimalString,
} from "./decimal.js";
import {
  compareDecimals,
  normalizeDecimal,
  type DecimalInput,
} from "./fixed-decimal.js";
import {
  calculatePortfolioLiquidation,
  type PortfolioLiquidationAssessment,
} from "./liquidation.js";
import {
  calculateNavSnapshot,
  type NavSnapshot,
} from "./nav-round.js";
import type { FutuFeeSchedule } from "./futu-fees.js";

export interface CompetitionValuationPosition {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly taxBasis: DecimalInput;
  readonly markPrice: DecimalInput;
  /** Defaults to reportingCurrency when omitted. */
  readonly currency?: string;
}

export interface CompetitionValuation {
  readonly valuationDate: string;
  readonly reportingCurrency: CurrencyCode;
  readonly settledCash: DecimalString;
  readonly taxReserve: DecimalString;
  readonly liquidation: PortfolioLiquidationAssessment;
  readonly nav: NavSnapshot;
}

/**
 * Build the competition's one authoritative score from durable account state
 * and one immutable mark set. Ranking uses liquidationNav: cash plus marked
 * positions, less realized-tax reserve, estimated close fees and unrealized
 * liquidation tax.
 */
export function calculateCompetitionValuation(input: {
  readonly valuationDate: string;
  readonly reportingCurrency: string;
  readonly settledCash: DecimalInput;
  readonly taxReserve: DecimalInput;
  readonly positions: readonly CompetitionValuationPosition[];
  readonly feeSchedules?: readonly FutuFeeSchedule[];
}): CompetitionValuation {
  const reportingCurrency = currency(input.reportingCurrency);
  const settledCash = requireNonNegative(input.settledCash, "settledCash");
  const taxReserve = requireNonNegative(input.taxReserve, "taxReserve");
  if (compareDecimals(taxReserve, settledCash) > 0) {
    throw new RangeError("taxReserve must not exceed settledCash");
  }

  const liquidation = calculatePortfolioLiquidation({
    valuationDate: input.valuationDate,
    reportingCurrency,
    positions: input.positions.map((position, index) => {
      const positionCurrency = currency(
        position.currency ?? reportingCurrency,
      );
      if (positionCurrency !== reportingCurrency) {
        throw new TypeError(
          `positions[${index}].currency does not match reporting currency`,
        );
      }
      return Object.freeze({
        instrumentId: position.instrumentId,
        symbol: position.symbol,
        quantity: position.quantity,
        markPrice: position.markPrice,
        // Liquidation tax is assessed after gains and losses within one
        // instrument offset. The portfolio reader already supplies the exact
        // aggregate basis, so one synthetic aggregate lot preserves that rule.
        lots: Object.freeze([{
          lotId: `aggregate:${position.instrumentId}`,
          quantity: position.quantity,
          taxBasis: position.taxBasis,
        }]),
      });
    }),
    ...(input.feeSchedules === undefined
      ? {}
      : { feeSchedules: input.feeSchedules }),
  });

  const nav = calculateNavSnapshot({
    currency: reportingCurrency,
    settledCash,
    unsettledCash: normalizeDecimal("0"),
    dividendReceivables: normalizeDecimal("0"),
    otherRecognizedReceivables: normalizeDecimal("0"),
    positionMarketValues: [liquidation.aggregateMarkValue],
    unpaidRealizedCapitalGainsTaxAccrual: taxReserve,
    pendingDividendChinaTaxTopUp: normalizeDecimal("0"),
    estimatedForeignWithholdingPayable: normalizeDecimal("0"),
    otherUnpaidChinaTaxAccrual: normalizeDecimal("0"),
    estimatedCloseFeesForAllPositions:
      liquidation.estimatedCloseFeesForAllPositions,
    estimatedUnrealizedLiquidationTax:
      liquidation.estimatedUnrealizedLiquidationTax,
  });

  return Object.freeze({
    valuationDate: input.valuationDate,
    reportingCurrency,
    settledCash,
    taxReserve,
    liquidation,
    nav,
  });
}

function requireNonNegative(
  value: DecimalInput,
  field: string,
): DecimalString {
  const normalized = normalizeDecimal(value);
  if (compareDecimals(normalized, "0") < 0) {
    throw new RangeError(`${field} must be non-negative`);
  }
  return normalized;
}
