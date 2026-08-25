import {
  currency,
  nonNegativeDecimal,
  type CurrencyCode,
  type NonNegativeDecimalString,
} from "./decimal.js";

declare const integerQuantityBrand: unique symbol;

/** Integer-share quantity serialized without crossing a JavaScript number boundary. */
export type IntegerQuantityString = string & {
  readonly [integerQuantityBrand]: true;
};

export type FutuOrderSide = "BUY" | "SELL";

export interface FutuFeeRates {
  readonly commissionPerShare: NonNegativeDecimalString;
  readonly commissionMinimumPerOrder: NonNegativeDecimalString;
  readonly platformPerShare: NonNegativeDecimalString;
  readonly platformMinimumPerOrder: NonNegativeDecimalString;
  readonly settlementPerShare: NonNegativeDecimalString;
  readonly secRateOfGrossNotional: NonNegativeDecimalString;
  readonly secMinimumPerOrder: NonNegativeDecimalString;
  readonly finraTafPerShare: NonNegativeDecimalString;
  readonly finraTafMinimumPerOrder: NonNegativeDecimalString;
  readonly finraTafMaximumPerOrder: NonNegativeDecimalString;
  readonly catPerShare: NonNegativeDecimalString;
}

export interface FutuFeeSchedule {
  readonly feeScheduleId: string;
  readonly brokerLegalEntity: string;
  readonly accountRegion: string;
  readonly market: "US";
  readonly product: "US_EQUITY_ETF";
  readonly accountTier: string;
  readonly effectiveFrom: string;
  /** Exclusive ISO-8601 calendar date boundary. */
  readonly effectiveTo?: string;
  readonly currency: CurrencyCode;
  readonly roundingPolicy: "ROUND_HALF_UP_TO_CENT";
  readonly aggregationPolicy: "PER_ORDER";
  readonly rates: FutuFeeRates;
}

export interface FutuFillInput {
  readonly quantity: string;
  readonly price: string;
}

export interface FutuFeeComponents {
  readonly commission: NonNegativeDecimalString;
  readonly platform: NonNegativeDecimalString;
  readonly settlement: NonNegativeDecimalString;
  readonly secRegulatory: NonNegativeDecimalString;
  readonly finraTaf: NonNegativeDecimalString;
  readonly cat: NonNegativeDecimalString;
}

export interface FutuOrderFeeCalculation {
  readonly feeScheduleId: string;
  readonly tradeDate: string;
  readonly side: FutuOrderSide;
  readonly currency: CurrencyCode;
  readonly aggregateQuantity: IntegerQuantityString;
  readonly grossNotional: NonNegativeDecimalString;
  readonly components: FutuFeeComponents;
  readonly total: NonNegativeDecimalString;
}

export interface MaxAffordableFutuBuyFill {
  readonly feeScheduleId: string;
  readonly tradeDate: string;
  readonly currency: CurrencyCode;
  readonly requestedQuantity: IntegerQuantityString;
  readonly affordableQuantity: IntegerQuantityString;
  readonly grossNotional: NonNegativeDecimalString;
  readonly fees: FutuFeeComponents;
  readonly totalFees: NonNegativeDecimalString;
  readonly totalCashRequired: NonNegativeDecimalString;
  readonly buyingPower: NonNegativeDecimalString;
  readonly isFullyAffordable: boolean;
}

interface ParsedDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

const INTEGER_QUANTITY_PATTERN = /^(?:0|[1-9]\d*)$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CENT_SCALE = 2;

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function parseNonNegative(value: string, field: string): ParsedDecimal {
  let canonical: NonNegativeDecimalString;
  try {
    canonical = nonNegativeDecimal(value);
  } catch {
    throw new TypeError(`${field} must be a canonical non-negative decimal string`);
  }

  const [integer = "0", fraction = ""] = canonical.split(".");
  return Object.freeze({
    coefficient: BigInt(integer + fraction),
    scale: fraction.length,
  });
}

function assertPositive(value: ParsedDecimal, field: string): void {
  if (value.coefficient === 0n) {
    throw new TypeError(`${field} must be greater than zero`);
  }
}

function formatDecimal(value: ParsedDecimal, retainScale = false): string {
  if (value.scale === 0) return value.coefficient.toString();

  const digits = value.coefficient.toString().padStart(value.scale + 1, "0");
  const integer = digits.slice(0, -value.scale);
  const rawFraction = digits.slice(-value.scale);
  const fraction = retainScale ? rawFraction : rawFraction.replace(/0+$/, "");
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
}

function alignCoefficient(value: ParsedDecimal, scale: number): bigint {
  return value.coefficient * powerOfTen(scale - value.scale);
}

function compareDecimals(left: ParsedDecimal, right: ParsedDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = alignCoefficient(left, scale);
  const rightCoefficient = alignCoefficient(right, scale);
  if (leftCoefficient === rightCoefficient) return 0;
  return leftCoefficient < rightCoefficient ? -1 : 1;
}

function addDecimals(left: ParsedDecimal, right: ParsedDecimal): ParsedDecimal {
  const scale = Math.max(left.scale, right.scale);
  return Object.freeze({
    coefficient:
      alignCoefficient(left, scale) + alignCoefficient(right, scale),
    scale,
  });
}

function multiplyDecimals(left: ParsedDecimal, right: ParsedDecimal): ParsedDecimal {
  return Object.freeze({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  });
}

function multiplyByInteger(value: ParsedDecimal, quantity: bigint): ParsedDecimal {
  return Object.freeze({
    coefficient: value.coefficient * quantity,
    scale: value.scale,
  });
}

function maximum(left: ParsedDecimal, right: ParsedDecimal): ParsedDecimal {
  return compareDecimals(left, right) >= 0 ? left : right;
}

function minimum(left: ParsedDecimal, right: ParsedDecimal): ParsedDecimal {
  return compareDecimals(left, right) <= 0 ? left : right;
}

function roundHalfUpToCents(value: ParsedDecimal): NonNegativeDecimalString {
  let cents: bigint;
  if (value.scale <= CENT_SCALE) {
    cents = value.coefficient * powerOfTen(CENT_SCALE - value.scale);
  } else {
    const divisor = powerOfTen(value.scale - CENT_SCALE);
    const quotient = value.coefficient / divisor;
    const remainder = value.coefficient % divisor;
    cents = remainder * 2n >= divisor ? quotient + 1n : quotient;
  }

  return nonNegativeDecimal(
    formatDecimal({ coefficient: cents, scale: CENT_SCALE }, true),
  );
}

function integerQuantity(value: string, field: string): IntegerQuantityString {
  if (!INTEGER_QUANTITY_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative integer string`);
  }
  return value as IntegerQuantityString;
}

function positiveIntegerQuantity(
  value: string,
  field: string,
): IntegerQuantityString {
  const canonical = integerQuantity(value, field);
  if (canonical === "0") {
    throw new TypeError(`${field} must be greater than zero`);
  }
  return canonical;
}

function assertIsoDate(value: string, field: string): void {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new TypeError(`${field} must be an ISO-8601 calendar date`);
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError(`${field} must be a valid ISO-8601 calendar date`);
  }
}

export function defineFutuFeeSchedule(input: {
  readonly feeScheduleId: string;
  readonly brokerLegalEntity: string;
  readonly accountRegion: string;
  readonly market: "US";
  readonly product: "US_EQUITY_ETF";
  readonly accountTier: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly currency: string;
  readonly commissionPerShare: string;
  readonly commissionMinimumPerOrder: string;
  readonly platformPerShare: string;
  readonly platformMinimumPerOrder: string;
  readonly settlementPerShare: string;
  readonly secRateOfGrossNotional: string;
  readonly secMinimumPerOrder: string;
  readonly finraTafPerShare: string;
  readonly finraTafMinimumPerOrder: string;
  readonly finraTafMaximumPerOrder: string;
  readonly catPerShare: string;
}): FutuFeeSchedule {
  if (
    input.feeScheduleId.length === 0 ||
    input.brokerLegalEntity.length === 0 ||
    input.accountRegion.length === 0 ||
    input.accountTier.length === 0
  ) {
    throw new TypeError("fee schedule identity and account scope are required");
  }

  assertIsoDate(input.effectiveFrom, "effectiveFrom");
  if (input.effectiveTo !== undefined) {
    assertIsoDate(input.effectiveTo, "effectiveTo");
    if (input.effectiveTo <= input.effectiveFrom) {
      throw new TypeError("fee schedule effectiveTo must follow effectiveFrom");
    }
  }

  const rates = Object.freeze({
    commissionPerShare: nonNegativeDecimal(input.commissionPerShare),
    commissionMinimumPerOrder: nonNegativeDecimal(
      input.commissionMinimumPerOrder,
    ),
    platformPerShare: nonNegativeDecimal(input.platformPerShare),
    platformMinimumPerOrder: nonNegativeDecimal(
      input.platformMinimumPerOrder,
    ),
    settlementPerShare: nonNegativeDecimal(input.settlementPerShare),
    secRateOfGrossNotional: nonNegativeDecimal(
      input.secRateOfGrossNotional,
    ),
    secMinimumPerOrder: nonNegativeDecimal(input.secMinimumPerOrder),
    finraTafPerShare: nonNegativeDecimal(input.finraTafPerShare),
    finraTafMinimumPerOrder: nonNegativeDecimal(
      input.finraTafMinimumPerOrder,
    ),
    finraTafMaximumPerOrder: nonNegativeDecimal(
      input.finraTafMaximumPerOrder,
    ),
    catPerShare: nonNegativeDecimal(input.catPerShare),
  });

  if (
    compareDecimals(
      parseNonNegative(rates.finraTafMinimumPerOrder, "FINRA minimum"),
      parseNonNegative(rates.finraTafMaximumPerOrder, "FINRA maximum"),
    ) > 0
  ) {
    throw new TypeError("FINRA TAF minimum cannot exceed its maximum");
  }

  return Object.freeze({
    feeScheduleId: input.feeScheduleId,
    brokerLegalEntity: input.brokerLegalEntity,
    accountRegion: input.accountRegion,
    market: input.market,
    product: input.product,
    accountTier: input.accountTier,
    effectiveFrom: input.effectiveFrom,
    ...(input.effectiveTo === undefined
      ? {}
      : { effectiveTo: input.effectiveTo }),
    currency: currency(input.currency),
    roundingPolicy: "ROUND_HALF_UP_TO_CENT",
    aggregationPolicy: "PER_ORDER",
    rates,
  });
}

export const FUTU_HK_US_EQUITY_FIXED_2026_08_23 = defineFutuFeeSchedule({
  feeScheduleId: "futu_hk_us_equity_fixed_2026-08-23",
  brokerLegalEntity: "FUTU_HK",
  accountRegion: "HK",
  market: "US",
  product: "US_EQUITY_ETF",
  accountTier: "FIXED_PLATFORM_FEE",
  effectiveFrom: "2026-08-23",
  currency: "USD",
  commissionPerShare: "0.0049",
  commissionMinimumPerOrder: "0.99",
  platformPerShare: "0.005",
  platformMinimumPerOrder: "1.00",
  settlementPerShare: "0.003",
  secRateOfGrossNotional: "0.0000206",
  secMinimumPerOrder: "0.01",
  finraTafPerShare: "0.000195",
  finraTafMinimumPerOrder: "0.01",
  finraTafMaximumPerOrder: "9.79",
  catPerShare: "0",
});

export const DEFAULT_FUTU_FEE_SCHEDULES: readonly FutuFeeSchedule[] =
  Object.freeze([FUTU_HK_US_EQUITY_FIXED_2026_08_23]);

/**
 * Canonical, lossless terms used to bind a frozen paper order to the exact
 * fee rules selected at planning time. The schedule ID alone is not enough:
 * a caller could otherwise reuse an ID while silently changing its rates.
 */
export function canonicalFutuFeeScheduleTerms(
  schedule: FutuFeeSchedule,
): string {
  return JSON.stringify({
    feeScheduleId: schedule.feeScheduleId,
    brokerLegalEntity: schedule.brokerLegalEntity,
    accountRegion: schedule.accountRegion,
    market: schedule.market,
    product: schedule.product,
    accountTier: schedule.accountTier,
    effectiveFrom: schedule.effectiveFrom,
    effectiveTo: schedule.effectiveTo ?? null,
    currency: schedule.currency,
    roundingPolicy: schedule.roundingPolicy,
    aggregationPolicy: schedule.aggregationPolicy,
    rates: {
      commissionPerShare: schedule.rates.commissionPerShare,
      commissionMinimumPerOrder: schedule.rates.commissionMinimumPerOrder,
      platformPerShare: schedule.rates.platformPerShare,
      platformMinimumPerOrder: schedule.rates.platformMinimumPerOrder,
      settlementPerShare: schedule.rates.settlementPerShare,
      secRateOfGrossNotional: schedule.rates.secRateOfGrossNotional,
      secMinimumPerOrder: schedule.rates.secMinimumPerOrder,
      finraTafPerShare: schedule.rates.finraTafPerShare,
      finraTafMinimumPerOrder: schedule.rates.finraTafMinimumPerOrder,
      finraTafMaximumPerOrder: schedule.rates.finraTafMaximumPerOrder,
      catPerShare: schedule.rates.catPerShare,
    },
  });
}

/** Restores only byte-canonical terms previously frozen into an order plan. */
export function parseCanonicalFutuFeeScheduleTerms(
  canonicalTerms: string,
): FutuFeeSchedule {
  let value: unknown;
  try {
    value = JSON.parse(canonicalTerms) as unknown;
  } catch {
    throw new TypeError("Frozen Futu fee terms are not valid JSON");
  }
  const root = exactRecord(value, [
    "feeScheduleId",
    "brokerLegalEntity",
    "accountRegion",
    "market",
    "product",
    "accountTier",
    "effectiveFrom",
    "effectiveTo",
    "currency",
    "roundingPolicy",
    "aggregationPolicy",
    "rates",
  ], "Frozen Futu fee terms");
  const rates = exactRecord(root.rates, [
    "commissionPerShare",
    "commissionMinimumPerOrder",
    "platformPerShare",
    "platformMinimumPerOrder",
    "settlementPerShare",
    "secRateOfGrossNotional",
    "secMinimumPerOrder",
    "finraTafPerShare",
    "finraTafMinimumPerOrder",
    "finraTafMaximumPerOrder",
    "catPerShare",
  ], "Frozen Futu fee rates");
  if (stringValue(root.market, "market") !== "US") {
    throw new TypeError("Frozen Futu fee market must be US");
  }
  if (stringValue(root.product, "product") !== "US_EQUITY_ETF") {
    throw new TypeError("Frozen Futu fee product must be US_EQUITY_ETF");
  }
  if (stringValue(root.roundingPolicy, "roundingPolicy") !== "ROUND_HALF_UP_TO_CENT") {
    throw new TypeError("Unsupported frozen Futu fee rounding policy");
  }
  if (stringValue(root.aggregationPolicy, "aggregationPolicy") !== "PER_ORDER") {
    throw new TypeError("Unsupported frozen Futu fee aggregation policy");
  }
  if (root.effectiveTo !== null && typeof root.effectiveTo !== "string") {
    throw new TypeError("Frozen Futu fee effectiveTo must be a string or null");
  }
  const schedule = defineFutuFeeSchedule({
    feeScheduleId: stringValue(root.feeScheduleId, "feeScheduleId"),
    brokerLegalEntity: stringValue(root.brokerLegalEntity, "brokerLegalEntity"),
    accountRegion: stringValue(root.accountRegion, "accountRegion"),
    market: "US",
    product: "US_EQUITY_ETF",
    accountTier: stringValue(root.accountTier, "accountTier"),
    effectiveFrom: stringValue(root.effectiveFrom, "effectiveFrom"),
    ...(root.effectiveTo === null ? {} : { effectiveTo: root.effectiveTo }),
    currency: stringValue(root.currency, "currency"),
    commissionPerShare: stringValue(rates.commissionPerShare, "commissionPerShare"),
    commissionMinimumPerOrder: stringValue(
      rates.commissionMinimumPerOrder,
      "commissionMinimumPerOrder",
    ),
    platformPerShare: stringValue(rates.platformPerShare, "platformPerShare"),
    platformMinimumPerOrder: stringValue(
      rates.platformMinimumPerOrder,
      "platformMinimumPerOrder",
    ),
    settlementPerShare: stringValue(rates.settlementPerShare, "settlementPerShare"),
    secRateOfGrossNotional: stringValue(
      rates.secRateOfGrossNotional,
      "secRateOfGrossNotional",
    ),
    secMinimumPerOrder: stringValue(rates.secMinimumPerOrder, "secMinimumPerOrder"),
    finraTafPerShare: stringValue(rates.finraTafPerShare, "finraTafPerShare"),
    finraTafMinimumPerOrder: stringValue(
      rates.finraTafMinimumPerOrder,
      "finraTafMinimumPerOrder",
    ),
    finraTafMaximumPerOrder: stringValue(
      rates.finraTafMaximumPerOrder,
      "finraTafMaximumPerOrder",
    ),
    catPerShare: stringValue(rates.catPerShare, "catPerShare"),
  });
  if (canonicalFutuFeeScheduleTerms(schedule) !== canonicalTerms) {
    throw new TypeError("Frozen Futu fee terms are not byte-canonical");
  }
  return schedule;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const requiredKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== requiredKeys.length
    || actualKeys.some((key, index) => key !== requiredKeys[index])
  ) {
    throw new TypeError(`${field} has unexpected or missing fields`);
  }
  return record;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Frozen Futu fee ${field} must be a string`);
  }
  return value;
}

/** Select exactly one effective ruleset; gaps and overlaps deliberately fail closed. */
export function resolveFutuFeeSchedule(
  tradeDate: string,
  schedules: readonly FutuFeeSchedule[] = DEFAULT_FUTU_FEE_SCHEDULES,
): FutuFeeSchedule {
  assertIsoDate(tradeDate, "tradeDate");
  const matches = schedules.filter(
    (schedule) =>
      tradeDate >= schedule.effectiveFrom &&
      (schedule.effectiveTo === undefined || tradeDate < schedule.effectiveTo),
  );

  if (matches.length !== 1) {
    throw new TypeError(
      `expected exactly one effective Futu fee schedule for ${tradeDate}; found ${matches.length}`,
    );
  }

  return matches[0] as FutuFeeSchedule;
}

function centsSum(values: readonly NonNegativeDecimalString[]): NonNegativeDecimalString {
  const total = values.reduce(
    (sum, value) => sum + parseNonNegative(value, "fee component").coefficient,
    0n,
  );
  return nonNegativeDecimal(
    formatDecimal({ coefficient: total, scale: CENT_SCALE }, true),
  );
}

function zeroComponents(): FutuFeeComponents {
  return Object.freeze({
    commission: nonNegativeDecimal("0.00"),
    platform: nonNegativeDecimal("0.00"),
    settlement: nonNegativeDecimal("0.00"),
    secRegulatory: nonNegativeDecimal("0.00"),
    finraTaf: nonNegativeDecimal("0.00"),
    cat: nonNegativeDecimal("0.00"),
  });
}

function calculateComponents(
  side: FutuOrderSide,
  quantity: bigint,
  grossNotional: ParsedDecimal,
  schedule: FutuFeeSchedule,
): FutuFeeComponents {
  if (quantity === 0n) return zeroComponents();

  const rates = schedule.rates;
  const commission = maximum(
    multiplyByInteger(
      parseNonNegative(rates.commissionPerShare, "commissionPerShare"),
      quantity,
    ),
    parseNonNegative(
      rates.commissionMinimumPerOrder,
      "commissionMinimumPerOrder",
    ),
  );
  const platform = maximum(
    multiplyByInteger(
      parseNonNegative(rates.platformPerShare, "platformPerShare"),
      quantity,
    ),
    parseNonNegative(
      rates.platformMinimumPerOrder,
      "platformMinimumPerOrder",
    ),
  );
  const settlement = multiplyByInteger(
    parseNonNegative(rates.settlementPerShare, "settlementPerShare"),
    quantity,
  );
  const cat = multiplyByInteger(
    parseNonNegative(rates.catPerShare, "catPerShare"),
    quantity,
  );

  let secRegulatory: ParsedDecimal = { coefficient: 0n, scale: 0 };
  let finraTaf: ParsedDecimal = { coefficient: 0n, scale: 0 };
  if (side === "SELL") {
    secRegulatory = maximum(
      multiplyDecimals(
        grossNotional,
        parseNonNegative(
          rates.secRateOfGrossNotional,
          "secRateOfGrossNotional",
        ),
      ),
      parseNonNegative(rates.secMinimumPerOrder, "secMinimumPerOrder"),
    );
    finraTaf = minimum(
      maximum(
        multiplyByInteger(
          parseNonNegative(rates.finraTafPerShare, "finraTafPerShare"),
          quantity,
        ),
        parseNonNegative(
          rates.finraTafMinimumPerOrder,
          "finraTafMinimumPerOrder",
        ),
      ),
      parseNonNegative(
        rates.finraTafMaximumPerOrder,
        "finraTafMaximumPerOrder",
      ),
    );
  }

  return Object.freeze({
    commission: roundHalfUpToCents(commission),
    platform: roundHalfUpToCents(platform),
    settlement: roundHalfUpToCents(settlement),
    secRegulatory: roundHalfUpToCents(secRegulatory),
    finraTaf: roundHalfUpToCents(finraTaf),
    cat: roundHalfUpToCents(cat),
  });
}

function totalComponents(components: FutuFeeComponents): NonNegativeDecimalString {
  return centsSum([
    components.commission,
    components.platform,
    components.settlement,
    components.secRegulatory,
    components.finraTaf,
    components.cat,
  ]);
}

/**
 * Calculate all fees for one order. Fills are aggregated before per-order
 * minima are applied, so three partial fills cannot incur three minima.
 */
export function calculateFutuOrderFees(input: {
  readonly tradeDate: string;
  readonly side: FutuOrderSide;
  readonly fills: readonly FutuFillInput[];
  readonly schedules?: readonly FutuFeeSchedule[];
}): FutuOrderFeeCalculation {
  if (input.side !== "BUY" && input.side !== "SELL") {
    throw new TypeError("side must be BUY or SELL");
  }
  if (input.fills.length === 0) {
    throw new TypeError("at least one fill is required");
  }

  const schedule = resolveFutuFeeSchedule(
    input.tradeDate,
    input.schedules ?? DEFAULT_FUTU_FEE_SCHEDULES,
  );
  let aggregateQuantity = 0n;
  let grossNotional: ParsedDecimal = { coefficient: 0n, scale: 0 };

  for (const [index, fill] of input.fills.entries()) {
    const quantity = positiveIntegerQuantity(
      fill.quantity,
      `fills[${index}].quantity`,
    );
    const price = parseNonNegative(fill.price, `fills[${index}].price`);
    assertPositive(price, `fills[${index}].price`);
    const quantityValue = BigInt(quantity);
    aggregateQuantity += quantityValue;
    grossNotional = addDecimals(
      grossNotional,
      multiplyByInteger(price, quantityValue),
    );
  }

  const components = calculateComponents(
    input.side,
    aggregateQuantity,
    grossNotional,
    schedule,
  );

  return Object.freeze({
    feeScheduleId: schedule.feeScheduleId,
    tradeDate: input.tradeDate,
    side: input.side,
    currency: schedule.currency,
    aggregateQuantity: integerQuantity(
      aggregateQuantity.toString(),
      "aggregateQuantity",
    ),
    grossNotional: nonNegativeDecimal(formatDecimal(grossNotional)),
    components,
    total: totalComponents(components),
  });
}

/**
 * Find the largest integer S2 buy fill whose gross notional plus actual fees
 * fits buying power. Fee reservation is not subtracted a second time.
 */
export function calculateMaxAffordableFutuBuyFill(input: {
  readonly tradeDate: string;
  readonly requestedQuantity: string;
  readonly price: string;
  readonly buyingPower: string;
  readonly schedules?: readonly FutuFeeSchedule[];
}): MaxAffordableFutuBuyFill {
  const requestedQuantity = positiveIntegerQuantity(
    input.requestedQuantity,
    "requestedQuantity",
  );
  const price = parseNonNegative(input.price, "price");
  assertPositive(price, "price");
  const buyingPower = parseNonNegative(input.buyingPower, "buyingPower");
  const schedule = resolveFutuFeeSchedule(
    input.tradeDate,
    input.schedules ?? DEFAULT_FUTU_FEE_SCHEDULES,
  );

  const costForQuantity = (quantity: bigint): {
    readonly gross: ParsedDecimal;
    readonly components: FutuFeeComponents;
    readonly totalFees: NonNegativeDecimalString;
    readonly cashRequired: ParsedDecimal;
  } => {
    const gross = multiplyByInteger(price, quantity);
    const components = calculateComponents("BUY", quantity, gross, schedule);
    const totalFees = totalComponents(components);
    return Object.freeze({
      gross,
      components,
      totalFees,
      cashRequired: addDecimals(
        gross,
        parseNonNegative(totalFees, "totalFees"),
      ),
    });
  };

  let lower = 0n;
  let upper = BigInt(requestedQuantity);
  while (lower < upper) {
    const candidate = (lower + upper + 1n) / 2n;
    if (compareDecimals(costForQuantity(candidate).cashRequired, buyingPower) <= 0) {
      lower = candidate;
    } else {
      upper = candidate - 1n;
    }
  }

  const result = costForQuantity(lower);
  return Object.freeze({
    feeScheduleId: schedule.feeScheduleId,
    tradeDate: input.tradeDate,
    currency: schedule.currency,
    requestedQuantity,
    affordableQuantity: integerQuantity(lower.toString(), "affordableQuantity"),
    grossNotional: nonNegativeDecimal(formatDecimal(result.gross)),
    fees: result.components,
    totalFees: result.totalFees,
    totalCashRequired: nonNegativeDecimal(formatDecimal(result.cashRequired)),
    buyingPower: nonNegativeDecimal(input.buyingPower),
    isFullyAffordable: lower === BigInt(requestedQuantity),
  });
}
