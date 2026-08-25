import {
  decimal,
  nonNegativeDecimal,
  type DecimalString,
  type NonNegativeDecimalString,
  type SequenceString,
} from "./decimal.js";
import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  maxDecimal,
  minDecimal,
  multiplyDecimals,
  normalizeDecimal,
  subtractDecimals,
} from "./fixed-decimal.js";

export const STRICT_SHADOW_TAX_RULESET_ID =
  "cn_resident_direct_foreign_securities_strict_v1";
export const CHINA_INDIVIDUAL_INCOME_TAX_RATE = nonNegativeDecimal("0.2");

const ZERO = decimal("0");
const TAX_YEAR_PATTERN = /^\d{4}$/;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/**
 * One remaining broker tax lot. Purchase price and buy fees are totals for the
 * remaining quantity, not per-share values. This lets successive partial FIFO
 * dispositions conserve basis exactly after the explicit allocation rounding.
 */
export interface ShadowTaxLot {
  readonly lotId: string;
  readonly instrumentId: string;
  readonly acquisitionSequence: SequenceString;
  readonly quantity: NonNegativeDecimalString;
  readonly grossPurchasePrice: NonNegativeDecimalString;
  readonly buyFees: NonNegativeDecimalString;
}

export interface FifoDispositionInput {
  /** One sell order and all of its fills form exactly one disposition. */
  readonly dispositionId: string;
  readonly instrumentId: string;
  readonly taxYear: string;
  readonly sourceCountry: string;
  readonly quantity: NonNegativeDecimalString;
  readonly grossProceeds: NonNegativeDecimalString;
  readonly sellFees: NonNegativeDecimalString;
  readonly availableLots: readonly ShadowTaxLot[];
  /** Explicit HALF_UP scale for proportional basis allocation on partial lots. */
  readonly allocationScale: number;
}

export interface FifoLotAllocation {
  readonly lotId: string;
  readonly acquisitionSequence: SequenceString;
  readonly quantity: NonNegativeDecimalString;
  readonly allocatedPurchasePrice: NonNegativeDecimalString;
  readonly allocatedBuyFees: NonNegativeDecimalString;
  readonly allocatedTaxBasis: NonNegativeDecimalString;
}

export interface RealizedDispositionGain {
  readonly dispositionId: string;
  readonly taxYear: string;
  readonly sourceCountry: string;
  readonly realizedGain: DecimalString;
}

export interface FifoDispositionResult extends RealizedDispositionGain {
  readonly rulesetId: typeof STRICT_SHADOW_TAX_RULESET_ID;
  readonly instrumentId: string;
  readonly allocations: readonly FifoLotAllocation[];
  readonly remainingLots: readonly ShadowTaxLot[];
  readonly allocatedPurchasePrice: NonNegativeDecimalString;
  readonly allocatedBuyFees: NonNegativeDecimalString;
  readonly allocatedTaxBasis: NonNegativeDecimalString;
  readonly grossProceeds: NonNegativeDecimalString;
  readonly sellFees: NonNegativeDecimalString;
  readonly taxableGain: NonNegativeDecimalString;
  readonly chinaCapitalGainsTax: NonNegativeDecimalString;
  /** Strict v1 never creates an asset from a loss. */
  readonly taxLossAssetCreated: "0";
}

export interface AnnualNettingSensitivityBucket {
  readonly taxYear: string;
  readonly sourceCountry: string;
  readonly netRealizedGain: DecimalString;
  readonly taxableGain: NonNegativeDecimalString;
  readonly sensitivityTax: NonNegativeDecimalString;
}

export interface CapitalGainsTaxViews {
  readonly rulesetId: typeof STRICT_SHADOW_TAX_RULESET_ID;
  readonly strictTax: NonNegativeDecimalString;
  readonly annualNettingSensitivityTax: NonNegativeDecimalString;
  readonly annualNettingSensitivityBuckets: readonly AnnualNettingSensitivityBucket[];
  /** Losses are deliberately not carried between dispositions or years. */
  readonly taxLossAssetCreated: "0";
}

export interface ShadowTaxReserveLock {
  readonly grossBuyingCash: NonNegativeDecimalString;
  readonly existingTaxReserve: NonNegativeDecimalString;
  readonly newlyLockedTax: NonNegativeDecimalString;
}

export interface ShadowTaxReserveLockResult {
  readonly grossBuyingCash: NonNegativeDecimalString;
  readonly preFeeBuyingPowerAfterLock: NonNegativeDecimalString;
  readonly taxReserveAfterLock: NonNegativeDecimalString;
}

export type DividendInstrumentKind = "common_stock" | "adr" | "etf";
export type DividendEvidenceStatus =
  | "CONFIRMED"
  | "EVIDENCE_PENDING"
  | "DISALLOWED";
export type DividendDistributionClassification =
  | "ordinary_dividend"
  | "capital_gain_distribution"
  | "return_of_capital"
  | "interest_related_dividend"
  | "substitute_payment"
  | "unclassified";

export interface DividendShadowTaxInput {
  readonly instrumentKind: DividendInstrumentKind;
  readonly issuerTaxResidenceCountry?: string;
  readonly distributionClassification: DividendDistributionClassification;
  /** All amounts below must already use the same CNY conversion fact. */
  readonly fxRateId: string;
  readonly grossDividend: NonNegativeDecimalString;
  readonly actualForeignIncomeTax: NonNegativeDecimalString;
  readonly treatyOrLocalCap: NonNegativeDecimalString;
  readonly chinaCreditLimit: NonNegativeDecimalString;
  readonly evidenceStatus: DividendEvidenceStatus;
}

export type DividendTaxUnresolvedReason =
  | "ISSUER_TAX_RESIDENCE_REQUIRED"
  | "DISTRIBUTION_CLASSIFICATION_UNSUPPORTED"
  | "FX_RATE_REQUIRED";

export type DividendShadowTaxResult =
  | {
      readonly status: "TAX_UNRESOLVED";
      readonly reason: DividendTaxUnresolvedReason;
    }
  | {
      readonly status: "RESOLVED";
      readonly fxRateId: string;
      readonly issuerTaxResidenceCountry: string;
      readonly chinaGrossDividendTax: NonNegativeDecimalString;
      readonly foreignTaxCreditCandidate: NonNegativeDecimalString;
      readonly allowedForeignTaxCredit: NonNegativeDecimalString;
      readonly foreignTaxRefundReceivable: NonNegativeDecimalString;
      readonly chinaDividendTaxAccrual: NonNegativeDecimalString;
      readonly netDividendCash: NonNegativeDecimalString;
      /** Net broker cash less the still-locked China dividend tax reserve. */
      readonly taxReservedDividendValue: DecimalString;
    };

function asNonNegative(value: DecimalString, field: string): NonNegativeDecimalString {
  if (compareDecimals(value, ZERO) < 0) {
    throw new RangeError(`${field} must be non-negative`);
  }
  return nonNegativeDecimal(value);
}

function requireNonNegative(
  value: NonNegativeDecimalString,
  field: string,
): NonNegativeDecimalString {
  return asNonNegative(normalizeDecimal(value), field);
}

function requirePositive(
  value: NonNegativeDecimalString,
  field: string,
): NonNegativeDecimalString {
  const normalized = requireNonNegative(value, field);
  if (compareDecimals(normalized, ZERO) === 0) {
    throw new RangeError(`${field} must be positive`);
  }
  return normalized;
}

function requireIdentity(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} is required`);
}

function requireTaxCoordinates(taxYear: string, sourceCountry: string): void {
  if (!TAX_YEAR_PATTERN.test(taxYear)) {
    throw new TypeError(`Invalid tax year: ${taxYear}`);
  }
  if (!COUNTRY_CODE_PATTERN.test(sourceCountry)) {
    throw new TypeError(`Invalid source country: ${sourceCountry}`);
  }
}

function compareSequence(left: SequenceString, right: SequenceString): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function decimalScale(value: DecimalString): number {
  return value.split(".")[1]?.length ?? 0;
}

function proportionalAllocation(
  lotTotal: NonNegativeDecimalString,
  disposedQuantity: NonNegativeDecimalString,
  lotQuantity: NonNegativeDecimalString,
  allocationScale: number,
): NonNegativeDecimalString {
  if (compareDecimals(disposedQuantity, lotQuantity) === 0) return lotTotal;
  return asNonNegative(
    divideDecimals(
      multiplyDecimals(lotTotal, disposedQuantity),
      lotQuantity,
      allocationScale,
      "HALF_UP",
    ),
    "proportional allocation",
  );
}

function capitalGainsTax(gain: DecimalString): NonNegativeDecimalString {
  const taxableGain = maxDecimal(gain, ZERO);
  return asNonNegative(
    multiplyDecimals(taxableGain, CHINA_INDIVIDUAL_INCOME_TAX_RATE),
    "capital gains tax",
  );
}

/**
 * Consume lots in acquisition order and tax the aggregate sell order once.
 * In particular, max(0, gain) is never applied to individual fills or lots.
 */
export function calculateFifoDisposition(
  input: FifoDispositionInput,
): FifoDispositionResult {
  requireIdentity(input.dispositionId, "dispositionId");
  requireIdentity(input.instrumentId, "instrumentId");
  requireTaxCoordinates(input.taxYear, input.sourceCountry);
  if (!Number.isSafeInteger(input.allocationScale) || input.allocationScale < 0) {
    throw new RangeError(`Invalid allocation scale: ${input.allocationScale}`);
  }

  const dispositionQuantity = requirePositive(input.quantity, "disposition quantity");
  const grossProceeds = requireNonNegative(input.grossProceeds, "gross proceeds");
  const sellFees = requireNonNegative(input.sellFees, "sell fees");
  const seenLotIds = new Set<string>();
  const seenSequences = new Set<string>();
  const lots = [...input.availableLots].sort((left, right) =>
    compareSequence(left.acquisitionSequence, right.acquisitionSequence),
  );

  for (const lot of lots) {
    requireIdentity(lot.lotId, "lotId");
    if (lot.instrumentId !== input.instrumentId) {
      throw new TypeError(`Lot ${lot.lotId} belongs to a different instrument`);
    }
    if (seenLotIds.has(lot.lotId)) throw new TypeError(`Duplicate lot id: ${lot.lotId}`);
    if (seenSequences.has(lot.acquisitionSequence)) {
      throw new TypeError(`Duplicate acquisition sequence: ${lot.acquisitionSequence}`);
    }
    seenLotIds.add(lot.lotId);
    seenSequences.add(lot.acquisitionSequence);
    requirePositive(lot.quantity, `lot ${lot.lotId} quantity`);
    requireNonNegative(lot.grossPurchasePrice, `lot ${lot.lotId} purchase price`);
    requireNonNegative(lot.buyFees, `lot ${lot.lotId} buy fees`);
    if (
      input.allocationScale < decimalScale(lot.grossPurchasePrice) ||
      input.allocationScale < decimalScale(lot.buyFees)
    ) {
      throw new RangeError(
        `allocationScale cannot be lower than lot ${lot.lotId} money scale`,
      );
    }
  }

  let quantityRemaining = dispositionQuantity;
  let totalPurchasePrice = nonNegativeDecimal("0");
  let totalBuyFees = nonNegativeDecimal("0");
  const allocations: FifoLotAllocation[] = [];
  const remainingLots: ShadowTaxLot[] = [];

  for (const lot of lots) {
    const lotQuantity = requirePositive(lot.quantity, `lot ${lot.lotId} quantity`);
    if (compareDecimals(quantityRemaining, ZERO) === 0) {
      remainingLots.push(Object.freeze({ ...lot }));
      continue;
    }

    const disposedFromLot = asNonNegative(
      minDecimal(quantityRemaining, lotQuantity),
      "disposed lot quantity",
    );
    const purchasePrice = proportionalAllocation(
      requireNonNegative(lot.grossPurchasePrice, "lot purchase price"),
      disposedFromLot,
      lotQuantity,
      input.allocationScale,
    );
    const buyFees = proportionalAllocation(
      requireNonNegative(lot.buyFees, "lot buy fees"),
      disposedFromLot,
      lotQuantity,
      input.allocationScale,
    );
    const basis = asNonNegative(
      addDecimals(purchasePrice, buyFees),
      "allocated tax basis",
    );

    allocations.push(Object.freeze({
      lotId: lot.lotId,
      acquisitionSequence: lot.acquisitionSequence,
      quantity: disposedFromLot,
      allocatedPurchasePrice: purchasePrice,
      allocatedBuyFees: buyFees,
      allocatedTaxBasis: basis,
    }));
    totalPurchasePrice = asNonNegative(
      addDecimals(totalPurchasePrice, purchasePrice),
      "allocated purchase price",
    );
    totalBuyFees = asNonNegative(
      addDecimals(totalBuyFees, buyFees),
      "allocated buy fees",
    );
    quantityRemaining = asNonNegative(
      subtractDecimals(quantityRemaining, disposedFromLot),
      "remaining disposition quantity",
    );

    const remainingLotQuantity = asNonNegative(
      subtractDecimals(lotQuantity, disposedFromLot),
      "remaining lot quantity",
    );
    if (compareDecimals(remainingLotQuantity, ZERO) > 0) {
      remainingLots.push(Object.freeze({
        ...lot,
        quantity: remainingLotQuantity,
        grossPurchasePrice: asNonNegative(
          subtractDecimals(lot.grossPurchasePrice, purchasePrice),
          "remaining lot purchase price",
        ),
        buyFees: asNonNegative(
          subtractDecimals(lot.buyFees, buyFees),
          "remaining lot buy fees",
        ),
      }));
    }
  }

  if (compareDecimals(quantityRemaining, ZERO) !== 0) {
    throw new RangeError(
      `Insufficient FIFO quantity: ${quantityRemaining} remains unallocated`,
    );
  }

  const allocatedTaxBasis = asNonNegative(
    addDecimals(totalPurchasePrice, totalBuyFees),
    "allocated tax basis",
  );
  const realizedGain = subtractDecimals(
    subtractDecimals(grossProceeds, allocatedTaxBasis),
    sellFees,
  );
  const taxableGain = asNonNegative(maxDecimal(realizedGain, ZERO), "taxable gain");
  const tax = capitalGainsTax(realizedGain);

  return Object.freeze({
    rulesetId: STRICT_SHADOW_TAX_RULESET_ID,
    dispositionId: input.dispositionId,
    instrumentId: input.instrumentId,
    taxYear: input.taxYear,
    sourceCountry: input.sourceCountry,
    allocations: Object.freeze(allocations),
    remainingLots: Object.freeze(remainingLots),
    allocatedPurchasePrice: totalPurchasePrice,
    allocatedBuyFees: totalBuyFees,
    allocatedTaxBasis,
    grossProceeds,
    sellFees,
    realizedGain,
    taxableGain,
    chinaCapitalGainsTax: tax,
    taxLossAssetCreated: "0",
  });
}

/** Strict per-disposition main view plus a separately labelled annual netting sensitivity. */
export function calculateCapitalGainsTaxViews(
  dispositions: readonly RealizedDispositionGain[],
): CapitalGainsTaxViews {
  let strictTax = nonNegativeDecimal("0");
  const annualNets = new Map<string, {
    taxYear: string;
    sourceCountry: string;
    netRealizedGain: DecimalString;
  }>();
  const seenDispositionIds = new Set<string>();

  for (const disposition of dispositions) {
    requireIdentity(disposition.dispositionId, "dispositionId");
    requireTaxCoordinates(disposition.taxYear, disposition.sourceCountry);
    if (seenDispositionIds.has(disposition.dispositionId)) {
      throw new TypeError(`Duplicate disposition id: ${disposition.dispositionId}`);
    }
    seenDispositionIds.add(disposition.dispositionId);
    const gain = normalizeDecimal(disposition.realizedGain);
    strictTax = asNonNegative(
      addDecimals(strictTax, capitalGainsTax(gain)),
      "strict capital gains tax",
    );

    const key = `${disposition.taxYear}\u0000${disposition.sourceCountry}`;
    const current = annualNets.get(key);
    annualNets.set(key, {
      taxYear: disposition.taxYear,
      sourceCountry: disposition.sourceCountry,
      netRealizedGain: current === undefined
        ? gain
        : addDecimals(current.netRealizedGain, gain),
    });
  }

  let annualTax = nonNegativeDecimal("0");
  const buckets = [...annualNets.values()]
    .sort((left, right) =>
      left.taxYear.localeCompare(right.taxYear) ||
      left.sourceCountry.localeCompare(right.sourceCountry),
    )
    .map((bucket): AnnualNettingSensitivityBucket => {
      const taxableGain = asNonNegative(
        maxDecimal(bucket.netRealizedGain, ZERO),
        "annual net taxable gain",
      );
      const sensitivityTax = capitalGainsTax(bucket.netRealizedGain);
      annualTax = asNonNegative(
        addDecimals(annualTax, sensitivityTax),
        "annual netting sensitivity tax",
      );
      return Object.freeze({ ...bucket, taxableGain, sensitivityTax });
    });

  return Object.freeze({
    rulesetId: STRICT_SHADOW_TAX_RULESET_ID,
    strictTax,
    annualNettingSensitivityTax: annualTax,
    annualNettingSensitivityBuckets: Object.freeze(buckets),
    taxLossAssetCreated: "0",
  });
}

/** Lock a newly accrued shadow tax amount out of the next-stage buying power. */
export function lockShadowTaxReserve(
  input: ShadowTaxReserveLock,
): ShadowTaxReserveLockResult {
  const grossBuyingCash = requireNonNegative(
    input.grossBuyingCash,
    "gross buying cash",
  );
  const existingReserve = requireNonNegative(input.existingTaxReserve, "tax reserve");
  const newlyLockedTax = requireNonNegative(input.newlyLockedTax, "new tax accrual");
  const taxReserveAfterLock = asNonNegative(
    addDecimals(existingReserve, newlyLockedTax),
    "tax reserve after lock",
  );
  if (compareDecimals(taxReserveAfterLock, grossBuyingCash) > 0) {
    throw new RangeError("Shadow tax reserve exceeds gross buying cash");
  }

  return Object.freeze({
    grossBuyingCash,
    preFeeBuyingPowerAfterLock: asNonNegative(
      subtractDecimals(grossBuyingCash, taxReserveAfterLock),
      "pre-fee buying power after tax lock",
    ),
    taxReserveAfterLock,
  });
}

/**
 * A deliberately fail-closed dividend calculation. It never infers issuer tax
 * residence from an ADR listing and only treats an explicitly ordinary ETF
 * distribution as a dividend.
 */
export function calculateDividendShadowTax(
  input: DividendShadowTaxInput,
): DividendShadowTaxResult {
  if (input.fxRateId.trim().length === 0) {
    return Object.freeze({ status: "TAX_UNRESOLVED", reason: "FX_RATE_REQUIRED" });
  }
  if (
    input.issuerTaxResidenceCountry === undefined ||
    !COUNTRY_CODE_PATTERN.test(input.issuerTaxResidenceCountry)
  ) {
    return Object.freeze({
      status: "TAX_UNRESOLVED",
      reason: "ISSUER_TAX_RESIDENCE_REQUIRED",
    });
  }
  if (
    input.instrumentKind === "etf" &&
    input.distributionClassification !== "ordinary_dividend"
  ) {
    return Object.freeze({
      status: "TAX_UNRESOLVED",
      reason: "DISTRIBUTION_CLASSIFICATION_UNSUPPORTED",
    });
  }
  if (input.distributionClassification !== "ordinary_dividend") {
    return Object.freeze({
      status: "TAX_UNRESOLVED",
      reason: "DISTRIBUTION_CLASSIFICATION_UNSUPPORTED",
    });
  }

  const grossDividend = requireNonNegative(input.grossDividend, "gross dividend");
  const actualForeignIncomeTax = requireNonNegative(
    input.actualForeignIncomeTax,
    "actual foreign income tax",
  );
  const treatyOrLocalCap = requireNonNegative(
    input.treatyOrLocalCap,
    "treaty or local cap",
  );
  const chinaCreditLimit = requireNonNegative(
    input.chinaCreditLimit,
    "China credit limit",
  );
  if (compareDecimals(actualForeignIncomeTax, grossDividend) > 0) {
    throw new RangeError("Foreign withholding cannot exceed gross dividend");
  }

  const chinaGrossDividendTax = asNonNegative(
    multiplyDecimals(grossDividend, CHINA_INDIVIDUAL_INCOME_TAX_RATE),
    "China gross dividend tax",
  );
  const foreignTaxCreditCandidate = asNonNegative(
    minDecimal(
      minDecimal(actualForeignIncomeTax, treatyOrLocalCap),
      chinaCreditLimit,
    ),
    "foreign tax credit candidate",
  );
  const allowedForeignTaxCredit = input.evidenceStatus === "CONFIRMED"
    ? foreignTaxCreditCandidate
    : nonNegativeDecimal("0");
  const chinaDividendTaxAccrual = asNonNegative(
    maxDecimal(
      subtractDecimals(chinaGrossDividendTax, allowedForeignTaxCredit),
      ZERO,
    ),
    "China dividend tax accrual",
  );
  const foreignTaxRefundReceivable = asNonNegative(
    maxDecimal(subtractDecimals(actualForeignIncomeTax, treatyOrLocalCap), ZERO),
    "foreign tax refund receivable",
  );
  const netDividendCash = asNonNegative(
    subtractDecimals(grossDividend, actualForeignIncomeTax),
    "net dividend cash",
  );

  return Object.freeze({
    status: "RESOLVED",
    fxRateId: input.fxRateId,
    issuerTaxResidenceCountry: input.issuerTaxResidenceCountry,
    chinaGrossDividendTax,
    foreignTaxCreditCandidate,
    allowedForeignTaxCredit,
    foreignTaxRefundReceivable,
    chinaDividendTaxAccrual,
    netDividendCash,
    taxReservedDividendValue: subtractDecimals(
      netDividendCash,
      chinaDividendTaxAccrual,
    ),
  });
}
