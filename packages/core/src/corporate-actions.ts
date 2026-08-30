import {
  compareDecimals,
  divideDecimals,
  multiplyDecimals,
  roundDecimal,
  subtractDecimals,
  sumDecimals,
} from "./fixed-decimal.js";
import { nonNegativeDecimal } from "./decimal.js";
import {
  createLedgerTransaction,
  type LedgerTransaction,
} from "./ledger.js";
import type { LotAcquisitionFxBinding } from "./paper-settlement.js";
import type { ShadowTaxLot } from "./shadow-tax.js";
import {
  calculateDividendShadowTax,
  CHINA_INDIVIDUAL_INCOME_TAX_RATE,
  STRICT_SHADOW_TAX_RULESET_ID,
  type DividendDistributionClassification,
  type DividendEvidenceStatus,
  type DividendInstrumentKind,
  type DividendTaxUnresolvedReason,
} from "./shadow-tax.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface CashDividendCorporateActionEvidence {
  readonly schema: "twofold.cash_dividend_corporate_action_evidence/v1";
  readonly source: "ALPACA_CORPORATE_ACTIONS_V1";
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly instrumentId: string;
  readonly symbol: string;
  readonly type: "CASH_DIVIDEND";
  readonly status: "COMPLETE" | "INCOMPLETE" | "DELETED";
  readonly ratePerShare: string;
  readonly currency: string;
  readonly exDate: string;
  readonly recordDate: string;
  readonly payableDate: string;
  readonly processDate: string;
  readonly foreign: boolean;
  readonly special: boolean;
  readonly observedAt: string;
}

export interface CashDividendEntitlement {
  readonly schema: "twofold.cash_dividend_entitlement/v1";
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly capturedAt: string;
  readonly exDateOpenAt: string;
  readonly ledgerHeadSequence: string;
  readonly ledgerHeadSha256: string;
}

export interface CashDividendTaxPolicy {
  readonly schema: "twofold.cash_dividend_tax_policy/v1";
  readonly rulesetId: typeof STRICT_SHADOW_TAX_RULESET_ID;
  readonly instrumentKind: DividendInstrumentKind;
  readonly issuerTaxResidenceCountry?: string | undefined;
  readonly distributionClassification: DividendDistributionClassification;
  readonly foreignWithholdingRate: string;
  readonly treatyOrLocalCapRate: string;
  readonly foreignTaxCreditEvidenceStatus: DividendEvidenceStatus;
  readonly cashScale: string;
  readonly taxScale: string;
  readonly reserveScale: string;
  readonly fx: Readonly<{
    fxRateId: string;
    sourceContentSha256: string;
    baseCurrency: string;
    quoteCurrency: "CNY";
    cnyPerBaseUnit: string;
    effectiveAt: string;
    visibleAt: string;
    status: "FINAL" | "PROVISIONAL";
  }>;
}

export type CashDividendCorporateActionApplication =
  | Readonly<{
    status: "APPLIED";
    sourceActionId: string;
    revisionSha256: string;
    appliedAt: string;
    entitlement: CashDividendEntitlement;
    taxPolicy: CashDividendTaxPolicy;
    grossDividend: string;
    foreignWithholding: string;
    netCash: string;
    cashTransition: Readonly<{
      settledCashDelta: string;
      taxReserveDelta: string;
      buyingPowerDelta: string;
    }>;
    tax: Readonly<{
      fxRateId: string;
      grossDividendCny: string;
      actualForeignIncomeTaxCny: string;
      chinaGrossDividendTaxCny: string;
      foreignTaxCreditCandidateCny: string;
      allowedForeignTaxCreditCny: string;
      foreignTaxRefundReceivableCny: string;
      chinaDividendTaxAccrualCny: string;
    }>;
    ledgerTransactions: readonly LedgerTransaction[];
  }>
  | Readonly<{
    status: "NO_ENTITLEMENT";
    sourceActionId: string;
    revisionSha256: string;
    appliedAt: string;
    entitlement: CashDividendEntitlement;
    taxPolicy: CashDividendTaxPolicy;
    ledgerTransactions: readonly [];
  }>
  | Readonly<{
    status: "UNRESOLVED";
    reason: DividendTaxUnresolvedReason
      | "GROSS_DIVIDEND_ROUNDS_TO_ZERO"
      | "SPECIAL_DIVIDEND_UNSUPPORTED"
      | "FOREIGN_DIVIDEND_UNSUPPORTED";
    sourceActionId: string;
    revisionSha256: string;
  }>;

/**
 * Applies one payable cash dividend from a position frozen before the ex-date
 * open. Gross rate, source withholding, China shadow-tax reserve, FX and money
 * scales are all explicit evidence or frozen policy; none are inferred from a
 * ticker, broker, nationality or current wall clock.
 */
export function applyCashDividendCorporateAction(input: {
  readonly action: CashDividendCorporateActionEvidence;
  readonly entitlement: CashDividendEntitlement;
  readonly taxPolicy: CashDividendTaxPolicy;
  readonly appliedAt: string;
}): CashDividendCorporateActionApplication {
  const action = validateCashDividendAction(input.action);
  const appliedAt = timestamp(input.appliedAt, "appliedAt");
  if (appliedAt.slice(0, 10) < action.payableDate) {
    throw new RangeError("cash dividend cannot be applied before its payable date");
  }
  if (action.observedAt > appliedAt) {
    throw new RangeError("cash-dividend evidence cannot be observed after application");
  }
  if (action.special) return unresolvedDividend(action, "SPECIAL_DIVIDEND_UNSUPPORTED");
  if (action.foreign) return unresolvedDividend(action, "FOREIGN_DIVIDEND_UNSUPPORTED");
  const entitlement = validateCashDividendEntitlement(input.entitlement, action);
  const policy = validateCashDividendTaxPolicy(input.taxPolicy, action, appliedAt);
  const frozenEntitlement = Object.freeze({ ...entitlement });
  const frozenPolicy = Object.freeze({
    ...policy,
    fx: Object.freeze({ ...policy.fx }),
  });
  if (entitlement.quantity === "0") {
    return Object.freeze({
      status: "NO_ENTITLEMENT",
      sourceActionId: action.sourceActionId,
      revisionSha256: action.revisionSha256,
      appliedAt,
      entitlement: frozenEntitlement,
      taxPolicy: frozenPolicy,
      ledgerTransactions: Object.freeze([]) as readonly [],
    });
  }

  const cashScale = scale(policy.cashScale, "cashScale");
  const taxScale = scale(policy.taxScale, "taxScale");
  const reserveScale = scale(policy.reserveScale, "reserveScale");
  const grossDividend = roundDecimal(
    multiplyDecimals(action.ratePerShare, entitlement.quantity),
    cashScale,
    "HALF_UP",
  );
  if (grossDividend === "0") return unresolvedDividend(action, "GROSS_DIVIDEND_ROUNDS_TO_ZERO");
  const foreignWithholding = roundDecimal(
    multiplyDecimals(grossDividend, policy.foreignWithholdingRate),
    cashScale,
    "HALF_UP",
  );
  const netCash = subtractDecimals(grossDividend, foreignWithholding);
  const grossDividendCny = roundDecimal(
    multiplyDecimals(grossDividend, policy.fx.cnyPerBaseUnit),
    taxScale,
    "HALF_UP",
  );
  const actualForeignIncomeTaxCny = roundDecimal(
    multiplyDecimals(foreignWithholding, policy.fx.cnyPerBaseUnit),
    taxScale,
    "HALF_UP",
  );
  const treatyOrLocalCapCny = roundDecimal(
    multiplyDecimals(grossDividendCny, policy.treatyOrLocalCapRate),
    taxScale,
    "HALF_UP",
  );
  const chinaCreditLimitCny = roundDecimal(
    multiplyDecimals(grossDividendCny, CHINA_INDIVIDUAL_INCOME_TAX_RATE),
    taxScale,
    "HALF_UP",
  );
  const tax = calculateDividendShadowTax({
    instrumentKind: policy.instrumentKind,
    ...(policy.issuerTaxResidenceCountry === undefined
      ? {}
      : { issuerTaxResidenceCountry: policy.issuerTaxResidenceCountry }),
    distributionClassification: policy.distributionClassification,
    fxRateId: policy.fx.fxRateId,
    grossDividend: nonNegativeDecimal(grossDividendCny),
    actualForeignIncomeTax: nonNegativeDecimal(actualForeignIncomeTaxCny),
    treatyOrLocalCap: nonNegativeDecimal(treatyOrLocalCapCny),
    chinaCreditLimit: nonNegativeDecimal(chinaCreditLimitCny),
    evidenceStatus: policy.foreignTaxCreditEvidenceStatus,
  });
  if (tax.status === "TAX_UNRESOLVED") {
    return unresolvedDividend(action, tax.reason);
  }
  const taxReserveDelta = divideDecimals(
    tax.chinaDividendTaxAccrual,
    policy.fx.cnyPerBaseUnit,
    reserveScale,
    "HALF_UP",
  );
  const buyingPowerDelta = subtractDecimals(netCash, taxReserveDelta);
  if (compareDecimals(buyingPowerDelta, "0") < 0) {
    throw new RangeError("cash-dividend tax reserve exceeds net broker cash");
  }

  const identity =
    `corporate-action:${action.sourceActionId}:${action.revisionSha256}:cash-dividend`;
  const brokerPostings = [{
    postingId: `${identity}:cash`,
    accountId: "asset.cash",
    accountKind: "ASSET" as const,
    side: "DEBIT" as const,
    amount: netCash,
    currency: action.currency,
    memo: "Net cash dividend received",
  }, ...(foreignWithholding === "0" ? [] : [{
    postingId: `${identity}:foreign-withholding`,
    accountId: "expense.foreign_dividend_withholding",
    accountKind: "EXPENSE" as const,
    side: "DEBIT" as const,
    amount: foreignWithholding,
    currency: action.currency,
    memo: "Foreign dividend withholding under frozen policy",
  }]), {
    postingId: `${identity}:income`,
    accountId: "income.dividend",
    accountKind: "INCOME" as const,
    side: "CREDIT" as const,
    amount: grossDividend,
    currency: action.currency,
    memo: `Gross ${action.symbol} cash dividend`,
  }];
  const transactions: LedgerTransaction[] = [createLedgerTransaction({
    transactionId: `${identity}:broker`,
    idempotencyKey: `${identity}:broker`,
    sourceEventId: `corporate-action:${action.sourceActionId}:${action.revisionSha256}`,
    eventTime: appliedAt,
    effectiveDate: action.payableDate,
    description: `Apply ${action.symbol} cash dividend`,
    postings: brokerPostings,
  })];
  if (tax.chinaDividendTaxAccrual !== "0") {
    transactions.push(createLedgerTransaction({
      transactionId: `${identity}:china-tax`,
      idempotencyKey: `${identity}:china-tax`,
      sourceEventId: `corporate-action:${action.sourceActionId}:${action.revisionSha256}`,
      eventTime: appliedAt,
      effectiveDate: action.payableDate,
      description: `Accrue China shadow tax for ${action.symbol} cash dividend`,
      postings: [{
        postingId: `${identity}:china-tax:expense`,
        accountId: "expense.china_dividend_tax",
        accountKind: "EXPENSE",
        side: "DEBIT",
        amount: tax.chinaDividendTaxAccrual,
        currency: "CNY",
        memo: "China dividend shadow-tax expense",
      }, {
        postingId: `${identity}:china-tax:liability`,
        accountId: "liability.china_tax_accrual",
        accountKind: "LIABILITY",
        side: "CREDIT",
        amount: tax.chinaDividendTaxAccrual,
        currency: "CNY",
        memo: "Unpaid China dividend shadow-tax accrual",
      }],
    }));
  }

  return Object.freeze({
    status: "APPLIED",
    sourceActionId: action.sourceActionId,
    revisionSha256: action.revisionSha256,
    appliedAt,
    entitlement: frozenEntitlement,
    taxPolicy: frozenPolicy,
    grossDividend,
    foreignWithholding,
    netCash,
    cashTransition: Object.freeze({
      settledCashDelta: netCash,
      taxReserveDelta,
      buyingPowerDelta,
    }),
    tax: Object.freeze({
      fxRateId: tax.fxRateId,
      grossDividendCny,
      actualForeignIncomeTaxCny,
      chinaGrossDividendTaxCny: tax.chinaGrossDividendTax,
      foreignTaxCreditCandidateCny: tax.foreignTaxCreditCandidate,
      allowedForeignTaxCreditCny: tax.allowedForeignTaxCredit,
      foreignTaxRefundReceivableCny: tax.foreignTaxRefundReceivable,
      chinaDividendTaxAccrualCny: tax.chinaDividendTaxAccrual,
    }),
    ledgerTransactions: Object.freeze(transactions),
  });
}

export interface SplitCorporateActionEvidence {
  readonly schema: "twofold.split_corporate_action_evidence/v1";
  readonly source: "ALPACA_CORPORATE_ACTIONS_V1";
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly instrumentId: string;
  readonly symbol: string;
  readonly type: "FORWARD_SPLIT" | "REVERSE_SPLIT";
  readonly status: "COMPLETE" | "INCOMPLETE" | "DELETED";
  readonly oldRate: string;
  readonly newRate: string;
  readonly exDate: string;
  readonly processDate: string;
  readonly observedAt: string;
}

export interface SplitCorporateActionPosition {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly grossCost: string;
  readonly lots: readonly ShadowTaxLot[];
  readonly acquisitionFxBindings: readonly LotAcquisitionFxBinding[];
}

export type SplitCorporateActionApplication =
  | Readonly<{
    status: "APPLIED";
    sourceActionId: string;
    revisionSha256: string;
    effectiveAt: string;
    position: SplitCorporateActionPosition;
    ledgerTransactions: readonly LedgerTransaction[];
  }>
  | Readonly<{
    status: "NO_POSITION";
    sourceActionId: string;
    revisionSha256: string;
    effectiveAt: string;
    position: null;
    ledgerTransactions: readonly [];
  }>
  | Readonly<{
    status: "UNRESOLVED";
    reason: "FRACTIONAL_SHARE_CASH_IN_LIEU_REQUIRED";
    sourceActionId: string;
    revisionSha256: string;
  }>;

/**
 * Prepares one split adjustment before the effective market open. The caller
 * may commit the returned transaction only at `effectiveAt`; separating
 * preparation from effect gives the scheduler a hard pre-open readiness gate.
 *
 * A split is represented as an equal-cost credit/re-debit of the security:
 * cash, inventory cost, tax basis, and acquisition identity remain unchanged,
 * while the ledger's instrument quantity moves from the old units to the new
 * units in one balanced transaction.
 */
export function applySplitCorporateAction(input: {
  readonly action: SplitCorporateActionEvidence;
  readonly position: SplitCorporateActionPosition | null;
  readonly effectiveAt: string;
  readonly appliedAt: string;
}): SplitCorporateActionApplication {
  const action = validateAction(input.action);
  const effectiveAt = timestamp(input.effectiveAt, "effectiveAt");
  const appliedAt = timestamp(input.appliedAt, "appliedAt");
  if (effectiveAt.slice(0, 10) !== action.exDate) {
    throw new TypeError("effectiveAt must use the corporate-action ex-date");
  }
  if (appliedAt >= effectiveAt) {
    throw new RangeError(
      "a split must be prepared before the effective market open",
    );
  }
  if (action.observedAt > appliedAt) {
    throw new RangeError("split evidence cannot be observed after preparation");
  }

  if (input.position === null || input.position.quantity === "0") {
    if (input.position !== null && input.position.lots.length !== 0) {
      throw new TypeError("a zero split position cannot retain FIFO lots");
    }
    return Object.freeze({
      status: "NO_POSITION",
      sourceActionId: action.sourceActionId,
      revisionSha256: action.revisionSha256,
      effectiveAt,
      position: null,
      ledgerTransactions: Object.freeze([]) as readonly [],
    });
  }

  const position = validatePosition(input.position, action);
  const oldRate = BigInt(action.oldRate);
  const newRate = BigInt(action.newRate);
  const adjustedQuantity = scaledInteger(
    position.quantity,
    oldRate,
    newRate,
  );
  const adjustedLots: ShadowTaxLot[] = [];
  for (const lot of position.lots) {
    const quantity = scaledInteger(lot.quantity, oldRate, newRate);
    if (quantity === null) return unresolved(action);
    adjustedLots.push(Object.freeze({ ...lot, quantity: quantity as ShadowTaxLot["quantity"] }));
  }
  if (adjustedQuantity === null) return unresolved(action);
  if (sumDecimals(adjustedLots.map((lot) => lot.quantity)) !== adjustedQuantity) {
    throw new TypeError("split-adjusted FIFO lots do not reconcile to the position");
  }

  const transactionIdentity =
    `corporate-action:${action.sourceActionId}:${action.revisionSha256}:split`;
  const transaction = createLedgerTransaction({
    transactionId: transactionIdentity,
    idempotencyKey: transactionIdentity,
    sourceEventId:
      `corporate-action:${action.sourceActionId}:${action.revisionSha256}`,
    eventTime: effectiveAt,
    effectiveDate: action.exDate,
    description:
      `${action.type === "FORWARD_SPLIT" ? "Forward" : "Reverse"} split `
      + `${action.symbol} ${action.oldRate}:${action.newRate}`,
    postings: [{
      postingId: `${transactionIdentity}:old-units`,
      accountId: "securities.inventory",
      accountKind: "ASSET",
      side: "CREDIT",
      amount: position.grossCost,
      currency: "USD",
      instrumentId: position.instrumentId,
      quantity: position.quantity,
      memo: "Remove pre-split units at unchanged carrying cost",
    }, {
      postingId: `${transactionIdentity}:new-units`,
      accountId: "securities.inventory",
      accountKind: "ASSET",
      side: "DEBIT",
      amount: position.grossCost,
      currency: "USD",
      instrumentId: position.instrumentId,
      quantity: adjustedQuantity,
      memo: "Recognize post-split units at unchanged carrying cost",
    }],
  });

  return Object.freeze({
    status: "APPLIED",
    sourceActionId: action.sourceActionId,
    revisionSha256: action.revisionSha256,
    effectiveAt,
    position: Object.freeze({
      ...position,
      quantity: adjustedQuantity,
      lots: Object.freeze(adjustedLots),
      acquisitionFxBindings: Object.freeze([...position.acquisitionFxBindings]),
    }),
    ledgerTransactions: Object.freeze([transaction]),
  });
}

function validateAction(
  action: SplitCorporateActionEvidence,
): SplitCorporateActionEvidence {
  if (action.schema !== "twofold.split_corporate_action_evidence/v1"
    || action.source !== "ALPACA_CORPORATE_ACTIONS_V1") {
    throw new TypeError("unsupported split evidence schema or source");
  }
  uuid(action.sourceActionId, "sourceActionId");
  uuid(action.instrumentId, "instrumentId");
  if (!SHA256_PATTERN.test(action.revisionSha256)) {
    throw new TypeError("revisionSha256 must be a lowercase SHA-256");
  }
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(action.symbol)) {
    throw new TypeError("split symbol is invalid");
  }
  if (action.status !== "COMPLETE") {
    throw new TypeError("split evidence must be complete before preparation");
  }
  if (!POSITIVE_INTEGER_PATTERN.test(action.oldRate)
    || !POSITIVE_INTEGER_PATTERN.test(action.newRate)) {
    throw new TypeError("split ratio must use positive integer strings");
  }
  const oldRate = BigInt(action.oldRate);
  const newRate = BigInt(action.newRate);
  if ((action.type === "FORWARD_SPLIT" && newRate <= oldRate)
    || (action.type === "REVERSE_SPLIT" && newRate >= oldRate)) {
    throw new TypeError("split ratio direction does not match its type");
  }
  calendarDate(action.exDate, "exDate");
  calendarDate(action.processDate, "processDate");
  timestamp(action.observedAt, "observedAt");
  return action;
}

function validateCashDividendAction(
  action: CashDividendCorporateActionEvidence,
): CashDividendCorporateActionEvidence {
  if (action.schema !== "twofold.cash_dividend_corporate_action_evidence/v1"
    || action.source !== "ALPACA_CORPORATE_ACTIONS_V1"
    || action.type !== "CASH_DIVIDEND") {
    throw new TypeError("unsupported cash-dividend evidence schema, source, or type");
  }
  uuid(action.sourceActionId, "sourceActionId");
  uuid(action.instrumentId, "instrumentId");
  if (!SHA256_PATTERN.test(action.revisionSha256)) {
    throw new TypeError("revisionSha256 must be a lowercase SHA-256");
  }
  if (action.status !== "COMPLETE") {
    throw new TypeError("cash-dividend evidence must be complete before application");
  }
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(action.symbol)) {
    throw new TypeError("cash-dividend symbol is invalid");
  }
  positiveDecimal(action.ratePerShare, "ratePerShare");
  if (!CURRENCY_PATTERN.test(action.currency)) {
    throw new TypeError("cash-dividend currency must be an uppercase ISO-like code");
  }
  const exDate = calendarDate(action.exDate, "exDate");
  const recordDate = calendarDate(action.recordDate, "recordDate");
  const payableDate = calendarDate(action.payableDate, "payableDate");
  calendarDate(action.processDate, "processDate");
  timestamp(action.observedAt, "observedAt");
  if (typeof action.foreign !== "boolean" || typeof action.special !== "boolean") {
    throw new TypeError("cash-dividend foreign/special flags must be boolean evidence");
  }
  if (recordDate < exDate || payableDate < recordDate) {
    throw new TypeError("cash-dividend record/payable dates are out of order");
  }
  return action;
}

function validateCashDividendEntitlement(
  entitlement: CashDividendEntitlement,
  action: CashDividendCorporateActionEvidence,
): CashDividendEntitlement {
  if (entitlement.schema !== "twofold.cash_dividend_entitlement/v1"
    || entitlement.instrumentId !== action.instrumentId
    || entitlement.symbol !== action.symbol) {
    throw new TypeError("cash-dividend entitlement does not match the action instrument");
  }
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(entitlement.quantity)) {
    throw new TypeError("cash-dividend entitlement quantity must be a whole-share string");
  }
  const capturedAt = timestamp(entitlement.capturedAt, "entitlement.capturedAt");
  const exDateOpenAt = timestamp(entitlement.exDateOpenAt, "entitlement.exDateOpenAt");
  if (exDateOpenAt.slice(0, 10) !== action.exDate) {
    throw new TypeError("entitlement ex-date open must fall on the action ex-date");
  }
  if (capturedAt >= exDateOpenAt) {
    throw new RangeError("cash-dividend entitlement must be frozen before the ex-date open");
  }
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(entitlement.ledgerHeadSequence)
    || !SHA256_PATTERN.test(entitlement.ledgerHeadSha256)) {
    throw new TypeError("cash-dividend entitlement requires an exact ledger head fence");
  }
  return entitlement;
}

function validateCashDividendTaxPolicy(
  policy: CashDividendTaxPolicy,
  action: CashDividendCorporateActionEvidence,
  appliedAt: string,
): CashDividendTaxPolicy {
  if (policy.schema !== "twofold.cash_dividend_tax_policy/v1"
    || policy.rulesetId !== STRICT_SHADOW_TAX_RULESET_ID) {
    throw new TypeError("unsupported cash-dividend tax policy");
  }
  if (!["common_stock", "adr", "etf"].includes(policy.instrumentKind)) {
    throw new TypeError("unsupported dividend instrument kind");
  }
  if (!["ordinary_dividend", "capital_gain_distribution", "return_of_capital",
    "interest_related_dividend", "substitute_payment", "unclassified"]
    .includes(policy.distributionClassification)) {
    throw new TypeError("unsupported dividend distribution classification");
  }
  if (!["CONFIRMED", "EVIDENCE_PENDING", "DISALLOWED"]
    .includes(policy.foreignTaxCreditEvidenceStatus)) {
    throw new TypeError("unsupported foreign-tax-credit evidence status");
  }
  rate(policy.foreignWithholdingRate, "foreignWithholdingRate");
  rate(policy.treatyOrLocalCapRate, "treatyOrLocalCapRate");
  scale(policy.cashScale, "cashScale");
  scale(policy.taxScale, "taxScale");
  scale(policy.reserveScale, "reserveScale");
  if (policy.fx.fxRateId.trim() === ""
    || !SHA256_PATTERN.test(policy.fx.sourceContentSha256)
    || policy.fx.baseCurrency !== action.currency
    || policy.fx.quoteCurrency !== "CNY"
    || policy.fx.status !== "FINAL") {
    throw new TypeError("cash-dividend tax policy requires final matching FX evidence");
  }
  positiveDecimal(policy.fx.cnyPerBaseUnit, "fx.cnyPerBaseUnit");
  const effectiveAt = timestamp(policy.fx.effectiveAt, "fx.effectiveAt");
  const visibleAt = timestamp(policy.fx.visibleAt, "fx.visibleAt");
  if (effectiveAt > visibleAt || visibleAt > appliedAt) {
    throw new RangeError("cash-dividend FX evidence crosses its visibility fence");
  }
  return policy;
}

function unresolvedDividend(
  action: CashDividendCorporateActionEvidence,
  reason: DividendTaxUnresolvedReason
    | "GROSS_DIVIDEND_ROUNDS_TO_ZERO"
    | "SPECIAL_DIVIDEND_UNSUPPORTED"
    | "FOREIGN_DIVIDEND_UNSUPPORTED",
): CashDividendCorporateActionApplication {
  return Object.freeze({
    status: "UNRESOLVED",
    reason,
    sourceActionId: action.sourceActionId,
    revisionSha256: action.revisionSha256,
  });
}

function positiveDecimal(value: string, field: string): string {
  if (!NON_NEGATIVE_DECIMAL_PATTERN.test(value)
    || compareDecimals(value, "0") <= 0) {
    throw new TypeError(`${field} must be a canonical positive decimal`);
  }
  return value;
}

function rate(value: string, field: string): string {
  if (!NON_NEGATIVE_DECIMAL_PATTERN.test(value)
    || compareDecimals(value, "1") > 0) {
    throw new TypeError(`${field} must be a canonical rate from 0 through 1`);
  }
  return value;
}

function scale(value: string, field: string): number {
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 18) {
    throw new RangeError(`${field} must be at most 18`);
  }
  return parsed;
}

function validatePosition(
  position: SplitCorporateActionPosition,
  action: SplitCorporateActionEvidence,
): SplitCorporateActionPosition {
  if (position.instrumentId !== action.instrumentId
    || position.symbol !== action.symbol) {
    throw new TypeError("split position does not match the evidence instrument");
  }
  if (!POSITIVE_INTEGER_PATTERN.test(position.quantity)) {
    throw new TypeError("split position quantity must be a positive integer");
  }
  if (compareDecimals(position.grossCost, "0") <= 0) {
    throw new TypeError("split position must have positive carrying cost");
  }
  if (position.lots.length === 0
    || position.lots.length !== position.acquisitionFxBindings.length) {
    throw new TypeError("split position requires one acquisition FX binding per lot");
  }
  const bindingLotIds = new Set<string>();
  for (const binding of position.acquisitionFxBindings) {
    if (bindingLotIds.has(binding.lotId)) {
      throw new TypeError("split position has duplicate acquisition FX bindings");
    }
    bindingLotIds.add(binding.lotId);
  }
  for (const lot of position.lots) {
    if (lot.instrumentId !== position.instrumentId
      || !POSITIVE_INTEGER_PATTERN.test(lot.quantity)
      || !bindingLotIds.has(lot.lotId)) {
      throw new TypeError("split FIFO lots do not bind the position and FX evidence");
    }
  }
  if (sumDecimals(position.lots.map((lot) => lot.quantity)) !== position.quantity
    || sumDecimals(position.lots.map((lot) => lot.grossPurchasePrice))
      !== position.grossCost) {
    throw new TypeError("split position does not reconcile to its FIFO lots");
  }
  return position;
}

function scaledInteger(
  quantity: string,
  oldRate: bigint,
  newRate: bigint,
): string | null {
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(quantity)) {
    throw new TypeError("split quantity must be a canonical non-negative integer");
  }
  const numerator = BigInt(quantity) * newRate;
  return numerator % oldRate === 0n ? (numerator / oldRate).toString() : null;
}

function unresolved(
  action: SplitCorporateActionEvidence,
): SplitCorporateActionApplication {
  return Object.freeze({
    status: "UNRESOLVED",
    reason: "FRACTIONAL_SHARE_CASH_IN_LIEU_REQUIRED",
    sourceActionId: action.sourceActionId,
    revisionSha256: action.revisionSha256,
  });
}

function timestamp(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function calendarDate(value: string, field: string): string {
  if (!DATE_PATTERN.test(value)
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a calendar date`);
  }
  return value;
}

function uuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID`);
  return value;
}
