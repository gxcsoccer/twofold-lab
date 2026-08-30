import { createHash } from "node:crypto";

import { canonicalFinancialJson, compareCodePoints } from "./canonical-json.js";
import {
  currency,
  decimal,
  nextSequence,
  nonNegativeDecimal,
  sequence,
  type CurrencyCode,
  type DecimalString,
  type NonNegativeDecimalString,
  type SequenceString,
} from "./decimal.js";
import {
  calculateFutuOrderFees,
  canonicalFutuFeeScheduleTerms,
  parseCanonicalFutuFeeScheduleTerms,
  type FutuFeeComponents,
} from "./futu-fees.js";
import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  minDecimal,
  multiplyDecimals,
  normalizeDecimal,
  subtractDecimals,
  sumDecimals,
  type DecimalInput,
} from "./fixed-decimal.js";
import {
  createLedgerTransaction,
  type LedgerTransaction,
} from "./ledger.js";
import {
  applySimulatedSlippage,
  assertFrozenOrderPlanIntegrity,
  type BuyOrderPlan,
  type FrozenBuyOrder,
  type FrozenSellOrder,
  type OrderExecutionModel,
  type SellOrderPlan,
} from "./rebalance.js";
import { calculateVolumeParticipationLimit } from "./execution-liquidity.js";
import {
  calculateFifoDisposition,
  type FifoLotAllocation,
  type ShadowTaxLot,
} from "./shadow-tax.js";

export const PAPER_SETTLEMENT_INTENT_SCHEMA =
  "twofold.paper_settlement_intent/v1" as const;
export const PAPER_SETTLEMENT_UNRESOLVED_SCHEMA =
  "twofold.paper_settlement_unresolved/v1" as const;
export const PAPER_SETTLEMENT_RULESET_ID =
  "twofold.paper_settlement_fifo_no_margin_v1" as const;
export const PAPER_SETTLEMENT_AUTHORITY =
  "PREFLIGHT_OR_POST_COMMIT_AUDIT_ONLY" as const;

const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CNY_RESERVE_SCALE = 12;

interface PaperFillEvidenceIdentity {
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly factId: string;
  readonly sourceArtifactId: string;
  readonly sourceContentSha256: string;
  readonly observedAt: string;
}

export interface BrokerActualFillPriceEvidence extends PaperFillEvidenceIdentity {
  /** An observed provider fill. No simulated slippage may be layered on it. */
  readonly semantics: "BROKER_ACTUAL_EXECUTION_PRICE";
  readonly providerExecutionId: string;
}

export interface SimulatedSlippageFillPriceEvidence extends PaperFillEvidenceIdentity {
  /** A derived price; factId/source identity refer to the official-open input. */
  readonly semantics: "SIMULATED_SLIPPAGE_DERIVED_PRICE";
  readonly snapshotId: string;
  readonly officialOpenSessionDate: string;
  readonly officialOpenPrice: DecimalInput;
  readonly slippageBps: string;
  readonly fillPriceScale: string;
}

export interface SimulatedMinuteParticipationFillPriceEvidence
  extends PaperFillEvidenceIdentity {
  readonly semantics: "SIMULATED_MINUTE_PARTICIPATION_DERIVED_PRICE";
  readonly snapshotId: string;
  readonly officialOpenSessionDate: string;
  readonly officialOpenPrice: DecimalInput;
  readonly observedVolume: string;
  readonly maxParticipationBps: string;
  readonly slippageBps: string;
  readonly fillPriceScale: string;
}

export type PaperFillPriceEvidence =
  | BrokerActualFillPriceEvidence
  | SimulatedSlippageFillPriceEvidence
  | SimulatedMinuteParticipationFillPriceEvidence;

export interface MinuteParticipationLiquidityEvidence
  extends PaperFillEvidenceIdentity {
  readonly semantics: "MINUTE_VOLUME_PARTICIPATION_CAP";
  readonly snapshotId: string;
  readonly sessionDate: string;
  readonly observedVolume: string;
  readonly maxParticipationBps: string;
}

export interface PaperOrderFill {
  readonly fillId: string;
  readonly quantity: string;
  readonly price: DecimalInput;
  readonly executedAt: string;
  readonly priceEvidence: PaperFillPriceEvidence;
}

export interface CompletedPaperOrderExecution {
  readonly executionId: string;
  readonly orderId: string;
  readonly decisionId: string;
  readonly stage: "S1" | "S2";
  readonly side: "BUY" | "SELL";
  readonly instrumentId: string;
  readonly tradeDate: string;
  readonly currency: string;
  readonly terminalStatus: "FILLED" | "PARTIALLY_FILLED" | "CANCELED";
  readonly canceledQuantity: string;
  readonly liquidityEvidence?: MinuteParticipationLiquidityEvidence;
  /** All fills for the terminal order outcome; fee minima apply once to this array. */
  readonly fills: readonly PaperOrderFill[];
}

export interface PaperSettlementLedgerHead {
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly headEventId: string;
  readonly headSequence: string;
  readonly headHash: string;
  readonly capturedAt: string;
  readonly currency: string;
  readonly instrumentId: string;
  readonly cashAssetBalance: DecimalInput;
  readonly currentBuyingPower: DecimalInput;
  readonly taxReserveBalance: DecimalInput;
  readonly positionQuantity: string;
  /** Broker-currency gross purchase cost, excluding separately expensed fees. */
  readonly positionGrossCostAssetBalance: DecimalInput;
}

export interface FrozenPlanCashFence {
  readonly planFingerprint: string;
  readonly remainingBuyingPower: DecimalInput;
  readonly priorSettlementIds: readonly string[];
}

export interface CnyFxEvidence {
  readonly fxRateId: string;
  readonly factId: string;
  readonly sourceVersionId: string;
  readonly sourceArtifactId: string;
  readonly sourceContentSha256: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: "CNY";
  /** CNY paid for one unit of baseCurrency. */
  readonly cnyPerBaseUnit: DecimalInput;
  readonly effectiveAt: string;
  readonly visibleAt: string;
  readonly status: "ESTIMATED" | "FINAL";
}

export interface LotAcquisitionFxBinding {
  readonly lotId: string;
  readonly acquisitionTradeDate: string;
  readonly acquisitionSettlementId: string;
  /** Remaining CNY totals after every earlier partial FIFO disposition. */
  readonly remainingGrossPurchasePriceCny: DecimalInput;
  readonly remainingBuyFeesCny: DecimalInput;
  readonly evidence: CnyFxEvidence;
}

export interface NormalizedLotAcquisitionFxBinding {
  readonly lotId: string;
  readonly acquisitionTradeDate: string;
  readonly acquisitionSettlementId: string;
  readonly remainingGrossPurchasePriceCny: DecimalString;
  readonly remainingBuyFeesCny: DecimalString;
  readonly evidence: ResolvedCnyFxEvidence;
}

export interface BuyPaperSettlementInput {
  readonly plan: BuyOrderPlan;
  readonly orderId: string;
  readonly execution: CompletedPaperOrderExecution;
  readonly settledAt: string;
  readonly ledgerHead: PaperSettlementLedgerHead;
  readonly planCashFence: FrozenPlanCashFence;
  readonly availableLots: readonly ShadowTaxLot[];
  readonly acquisitionFxEvidence?: CnyFxEvidence;
}

export interface SellPaperSettlementInput {
  readonly plan: SellOrderPlan;
  readonly orderId: string;
  readonly execution: CompletedPaperOrderExecution;
  readonly settledAt: string;
  readonly ledgerHead: PaperSettlementLedgerHead;
  readonly availableLots: readonly ShadowTaxLot[];
  readonly sourceCountry?: string;
  readonly dispositionFxEvidence?: CnyFxEvidence;
  readonly acquisitionFxEvidence?: readonly LotAcquisitionFxBinding[];
}

export type PaperOrderSettlementInput =
  | BuyPaperSettlementInput
  | SellPaperSettlementInput;

export interface NormalizedPaperFill {
  readonly fillId: string;
  readonly quantity: string;
  readonly price: DecimalString;
  readonly executedAt: string;
  readonly priceEvidence: PaperFillPriceEvidence;
}

export interface NormalizedPaperOrderExecution {
  readonly executionId: string;
  readonly orderId: string;
  readonly decisionId: string;
  readonly stage: "S1" | "S2";
  readonly side: "BUY" | "SELL";
  readonly instrumentId: string;
  readonly tradeDate: string;
  readonly currency: CurrencyCode;
  readonly terminalStatus: "FILLED" | "PARTIALLY_FILLED" | "CANCELED";
  readonly orderQuantity: string;
  readonly filledQuantity: string;
  readonly canceledQuantity: string;
  readonly liquidityEvidence?: MinuteParticipationLiquidityEvidence;
  readonly fills: readonly NormalizedPaperFill[];
}

export interface NormalizedPaperSettlementLedgerHead {
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly headEventId: string;
  readonly headSequence: SequenceString;
  readonly headHash: string;
  readonly capturedAt: string;
  readonly currency: CurrencyCode;
  readonly instrumentId: string;
  readonly cashAssetBalance: DecimalString;
  readonly currentBuyingPower: DecimalString;
  readonly taxReserveBalance: DecimalString;
  readonly positionQuantity: string;
  readonly positionGrossCostAssetBalance: DecimalString;
}

export interface FrozenOrderSettlementBinding {
  readonly planSchema: "twofold.frozen_order_plan/v1";
  readonly planFingerprint: string;
  readonly orderId: string;
  readonly decisionId: string;
  readonly stage: "S1" | "S2";
  readonly side: "BUY" | "SELL";
  readonly instrumentId: string;
  readonly symbol: string;
  readonly orderQuantity: string;
  readonly plannedAt: string;
  readonly plannedTradeDate: string;
  readonly referencePrice: DecimalString;
  readonly referencePriceEvidence: {
    readonly semantics: "FROZEN_ORDER_REFERENCE_PRICE";
    readonly sessionDate: string;
    readonly visibleAt: string;
    readonly snapshotId: string;
    readonly factId: string;
  };
  readonly feeScheduleId: string;
  readonly feeCurrency: CurrencyCode;
  readonly feeScheduleTerms: string;
  readonly feeScheduleTermsSha256: string;
}

export interface SettlementBalanceTransition {
  readonly cashAssetBalanceBefore: DecimalString;
  readonly cashAssetBalanceAfter: DecimalString;
  readonly buyingPowerBefore: DecimalString;
  readonly buyingPowerAfter: DecimalString;
  readonly taxReserveBefore: DecimalString;
  readonly taxReserveAfter: DecimalString;
  readonly positionQuantityBefore: string;
  readonly positionQuantityAfter: string;
  readonly positionGrossCostBefore: DecimalString;
  readonly positionGrossCostAfter: DecimalString;
}

export interface ResolvedCnyFxEvidence extends Omit<CnyFxEvidence, "baseCurrency" | "cnyPerBaseUnit"> {
  readonly baseCurrency: CurrencyCode;
  readonly cnyPerBaseUnit: DecimalString;
}

export interface CnyLotTaxAllocation extends FifoLotAllocation {
  readonly acquisitionFxRateId: string;
}

export interface PaperSettlementIntent {
  readonly schema: typeof PAPER_SETTLEMENT_INTENT_SCHEMA;
  /** This document is evidence, never an authorization or an RPC command. */
  readonly authority: typeof PAPER_SETTLEMENT_AUTHORITY;
  readonly settlementRulesetId: typeof PAPER_SETTLEMENT_RULESET_ID;
  readonly settlementId: string;
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly decisionId: string;
  readonly stage: "S1" | "S2";
  readonly side: "BUY" | "SELL";
  readonly orderId: string;
  readonly instrumentId: string;
  readonly symbol: string;
  readonly tradeDate: string;
  readonly settledAt: string;
  readonly currency: CurrencyCode;
  readonly ledgerHead: NormalizedPaperSettlementLedgerHead;
  readonly frozenOrder: FrozenOrderSettlementBinding;
  readonly execution: NormalizedPaperOrderExecution;
  readonly fee: {
    readonly feeScheduleId: string;
    readonly currency: CurrencyCode;
    readonly grossNotional: DecimalString;
    readonly components: FutuFeeComponents;
    readonly total: NonNegativeDecimalString;
  };
  readonly cashFence: null | {
    readonly planFingerprint: string;
    readonly currentBuyingPower: DecimalString;
    readonly frozenRemainingBuyingPower: DecimalString;
    readonly effectiveBuyingPowerLimit: DecimalString;
    /** Positive all-in BUY spend, matching DB cash_effect sign; zero on cancel. */
    readonly cashEffect: DecimalString;
    readonly frozenRemainingBuyingPowerAfter: DecimalString;
    readonly priorSettlementIds: readonly string[];
  };
  readonly balanceTransition: SettlementBalanceTransition;
  readonly lotTransition: {
    readonly lotsBefore: readonly ShadowTaxLot[];
    readonly createdLot: null | (ShadowTaxLot & {
      readonly currency: CurrencyCode;
      readonly grossPurchasePriceCny: DecimalString;
      readonly buyFeesCny: DecimalString;
      readonly acquisitionTradeDate: string;
      readonly acquisitionSettlementId: string;
      readonly acquisitionFxEvidence: ResolvedCnyFxEvidence;
    });
    readonly disposedAllocations: readonly FifoLotAllocation[];
    readonly remainingLots: readonly ShadowTaxLot[];
  };
  readonly tax: {
    readonly status: "RESOLVED";
    readonly sourceCountry: string | null;
    readonly currency: "CNY";
    readonly dispositionFxEvidence: ResolvedCnyFxEvidence | null;
    readonly acquisitionLotBindings: readonly NormalizedLotAcquisitionFxBinding[];
    readonly allocations: readonly CnyLotTaxAllocation[];
    readonly grossProceedsCny: DecimalString;
    readonly sellFeesCny: DecimalString;
    readonly allocatedTaxBasisCny: DecimalString;
    readonly realizedGainCny: DecimalString;
    readonly taxableGainCny: DecimalString;
    readonly chinaCapitalGainsTaxCny: DecimalString;
    readonly taxReserveTradingCurrencyAmount: DecimalString;
  };
  readonly ledgerTransactions: readonly LedgerTransaction[];
}

export type PaperSettlementTaxUnresolvedReason =
  | "BUY_ACQUISITION_FX_REQUIRED"
  | "SELL_SOURCE_COUNTRY_REQUIRED"
  | "SELL_DISPOSITION_FX_REQUIRED"
  | "SELL_ACQUISITION_FX_REQUIRED";

export interface PaperSettlementUnresolvedRecord {
  readonly schema: typeof PAPER_SETTLEMENT_UNRESOLVED_SCHEMA;
  readonly authority: typeof PAPER_SETTLEMENT_AUTHORITY;
  readonly settlementRulesetId: typeof PAPER_SETTLEMENT_RULESET_ID;
  readonly status: "TAX_UNRESOLVED";
  readonly reason: PaperSettlementTaxUnresolvedReason;
  readonly missingEvidenceIds: readonly string[];
  readonly settlementId: string;
  readonly settledAt: string;
  readonly ledgerHead: NormalizedPaperSettlementLedgerHead;
  readonly frozenOrder: FrozenOrderSettlementBinding;
  readonly execution: NormalizedPaperOrderExecution;
  readonly fee: {
    readonly feeScheduleId: string;
    readonly currency: CurrencyCode;
    readonly grossNotional: DecimalString;
    readonly components: FutuFeeComponents;
    readonly total: NonNegativeDecimalString;
  };
}

export type PaperOrderSettlementResult =
  | {
      readonly status: "READY";
      readonly intent: PaperSettlementIntent;
      readonly canonicalJson: string;
      readonly contentSha256: string;
    }
  | {
      readonly status: "TAX_UNRESOLVED";
      readonly unresolved: PaperSettlementUnresolvedRecord;
      readonly canonicalJson: string;
      readonly contentSha256: string;
    };

interface PreparedSettlement {
  readonly plan: BuyOrderPlan | SellOrderPlan;
  readonly order: FrozenBuyOrder | FrozenSellOrder;
  readonly settledAt: string;
  readonly settlementId: string;
  readonly ledgerHead: NormalizedPaperSettlementLedgerHead;
  readonly execution: NormalizedPaperOrderExecution;
  readonly frozenOrder: FrozenOrderSettlementBinding;
  readonly fee: PaperSettlementIntent["fee"];
  readonly lots: readonly ShadowTaxLot[];
}

/**
 * Build one terminal, order-level preflight/audit candidate. It is pure and is
 * deliberately NOT an authorization/request payload: a database settlement
 * boundary must ignore caller-computed amounts, lock and re-read authoritative
 * state, recompute its own transition, and commit atomically (or not at all).
 */
export function createPaperOrderSettlement(
  input: PaperOrderSettlementInput,
): PaperOrderSettlementResult {
  const prepared = prepareSettlement(input);
  if (prepared.execution.terminalStatus === "CANCELED") {
    return createCanceledSettlement(input, prepared);
  }
  return input.plan.stage === "S2"
    ? createBuySettlement(input as BuyPaperSettlementInput, prepared)
    : createSellSettlement(input as SellPaperSettlementInput, prepared);
}

function prepareSettlement(input: PaperOrderSettlementInput): PreparedSettlement {
  requireIsoTimestamp(input.settledAt, "settledAt");
  requireIdentity(input.orderId, "orderId");
  const expectedStage = input.plan.stage;
  assertFrozenOrderPlanIntegrity(input.plan, expectedStage);

  const seenOrderIds = new Set<string>();
  let order: FrozenBuyOrder | FrozenSellOrder | undefined;
  for (const candidate of input.plan.orders) {
    requireIdentity(candidate.orderId, "plan.order.orderId");
    if (seenOrderIds.has(candidate.orderId)) {
      throw new TypeError(`Duplicate frozen order ID: ${candidate.orderId}`);
    }
    seenOrderIds.add(candidate.orderId);
    if (candidate.orderId === input.orderId) order = candidate;
  }
  if (order === undefined) {
    throw new TypeError(`Frozen order ${input.orderId} is not present in its plan`);
  }
  const expectedSide = expectedStage === "S1" ? "SELL" : "BUY";
  if (
    order.decisionId !== input.plan.decisionId
    || order.stage !== expectedStage
    || order.side !== expectedSide
  ) {
    throw new TypeError(`Frozen order ${order.orderId} is not bound to its plan`);
  }
  const orderQuantity = requirePositiveInteger(order.quantity, "order.quantity");
  requireIsoTimestamp(order.plannedAt, "order.plannedAt");
  requireCalendarDate(order.plannedTradeDate, "order.plannedTradeDate");

  const ledgerHead = normalizeLedgerHead(input.ledgerHead, order, input.settledAt);
  const lots = normalizeLots(input.availableLots, order.instrumentId, ledgerHead);
  const execution = normalizeExecution(
    input.execution,
    input.plan,
    order,
    orderQuantity,
    input.settledAt,
  );

  const schedule = parseCanonicalFutuFeeScheduleTerms(order.feeScheduleTerms);
  if (
    schedule.feeScheduleId !== order.feeScheduleId
    || schedule.currency !== order.feeCurrency
  ) {
    throw new TypeError("Frozen order fee identity does not match its exact terms");
  }
  const calculation = execution.terminalStatus === "CANCELED"
    ? {
        feeScheduleId: schedule.feeScheduleId,
        currency: schedule.currency,
        grossNotional: nonNegativeDecimal("0"),
        components: zeroFeeComponents(),
        total: nonNegativeDecimal("0"),
      }
    : calculateFutuOrderFees({
        tradeDate: execution.tradeDate,
        side: execution.side,
        fills: execution.fills.map((fill) => ({
          quantity: fill.quantity,
          price: fill.price,
        })),
        schedules: [schedule],
      });
  if (calculation.currency !== execution.currency) {
    throw new TypeError("Paper fill currency does not match frozen fee currency");
  }
  const fee = Object.freeze({
    feeScheduleId: calculation.feeScheduleId,
    currency: calculation.currency,
    grossNotional: decimal(calculation.grossNotional),
    components: calculation.components,
    total: calculation.total,
  });
  const frozenOrder = freezeCanonical<FrozenOrderSettlementBinding>({
    planSchema: input.plan.schema,
    planFingerprint: input.plan.planFingerprint,
    orderId: order.orderId,
    decisionId: order.decisionId,
    stage: order.stage,
    side: order.side,
    instrumentId: order.instrumentId,
    symbol: order.symbol,
    orderQuantity: order.quantity,
    plannedAt: order.plannedAt,
    plannedTradeDate: order.plannedTradeDate,
    referencePrice: order.referencePrice,
    referencePriceEvidence: {
      semantics: "FROZEN_ORDER_REFERENCE_PRICE",
      sessionDate: order.referencePriceEvidence.sessionDate,
      visibleAt: order.referencePriceEvidence.visibleAt,
      snapshotId: order.referencePriceEvidence.snapshotId,
      factId: order.referencePriceEvidence.factId,
    },
    feeScheduleId: order.feeScheduleId,
    feeCurrency: schedule.currency,
    feeScheduleTerms: canonicalFutuFeeScheduleTerms(schedule),
    feeScheduleTermsSha256: sha256Utf8(order.feeScheduleTerms),
  });

  return Object.freeze({
    plan: input.plan,
    order,
    settledAt: input.settledAt,
    settlementId: `${order.orderId}:paper-settlement:v1`,
    ledgerHead,
    execution,
    frozenOrder,
    fee,
    lots,
  });
}

function createCanceledSettlement(
  input: PaperOrderSettlementInput,
  prepared: PreparedSettlement,
): PaperOrderSettlementResult {
  const plan = input.plan;
  const fence = plan.stage === "S2"
    ? normalizeCashFence(
        (input as BuyPaperSettlementInput).planCashFence,
        plan,
        prepared.settlementId,
      )
    : null;
  const effectiveLimit = fence === null
    ? null
    : minDecimal(prepared.ledgerHead.currentBuyingPower, fence.remainingBuyingPower);
  const intent = freezeCanonical<PaperSettlementIntent>({
    ...intentHeader(prepared),
    cashFence: fence === null || effectiveLimit === null ? null : {
      planFingerprint: plan.planFingerprint,
      currentBuyingPower: prepared.ledgerHead.currentBuyingPower,
      frozenRemainingBuyingPower: fence.remainingBuyingPower,
      effectiveBuyingPowerLimit: effectiveLimit,
      cashEffect: "0",
      frozenRemainingBuyingPowerAfter: fence.remainingBuyingPower,
      priorSettlementIds: fence.priorSettlementIds,
    },
    balanceTransition: balanceTransitionFor(prepared.ledgerHead, {
      cash: prepared.ledgerHead.cashAssetBalance,
      buyingPower: prepared.ledgerHead.currentBuyingPower,
      taxReserve: prepared.ledgerHead.taxReserveBalance,
      quantity: prepared.ledgerHead.positionQuantity,
      grossCost: prepared.ledgerHead.positionGrossCostAssetBalance,
    }),
    lotTransition: {
      lotsBefore: prepared.lots,
      createdLot: null,
      disposedAllocations: [],
      remainingLots: prepared.lots,
    },
    tax: {
      status: "RESOLVED",
      sourceCountry: null,
      currency: "CNY",
      dispositionFxEvidence: null,
      acquisitionLotBindings: [],
      allocations: [],
      grossProceedsCny: "0",
      sellFeesCny: "0",
      allocatedTaxBasisCny: "0",
      realizedGainCny: "0",
      taxableGainCny: "0",
      chinaCapitalGainsTaxCny: "0",
      taxReserveTradingCurrencyAmount: "0",
    },
    ledgerTransactions: [],
  });
  return readyResult(intent);
}

function createBuySettlement(
  input: BuyPaperSettlementInput,
  prepared: PreparedSettlement,
): PaperOrderSettlementResult {
  const plan = input.plan;
  const order = prepared.order as FrozenBuyOrder;
  const fx = input.acquisitionFxEvidence;
  if (fx === undefined) {
    return unresolvedResult(
      prepared,
      "BUY_ACQUISITION_FX_REQUIRED",
      [order.instrumentId],
    );
  }
  const acquisitionFx = normalizeFxEvidence(
    fx,
    prepared.ledgerHead.currency,
    prepared.settledAt,
    prepared.execution.tradeDate,
    "acquisition",
  );
  const fence = normalizeCashFence(input.planCashFence, plan, prepared.settlementId);
  const effectiveLimit = minDecimal(
    prepared.ledgerHead.currentBuyingPower,
    fence.remainingBuyingPower,
  );
  const cashRequired = addDecimals(prepared.fee.grossNotional, prepared.fee.total);
  if (compareDecimals(cashRequired, effectiveLimit) > 0) {
    throw new RangeError(
      `Paper buy requires ${cashRequired}, above effective buying-power limit ${effectiveLimit}`,
    );
  }
  if (compareDecimals(cashRequired, prepared.ledgerHead.cashAssetBalance) > 0) {
    throw new RangeError("Paper buy would create a negative cash asset");
  }

  const postCash = subtractDecimals(prepared.ledgerHead.cashAssetBalance, cashRequired);
  const postBuyingPower = subtractDecimals(
    prepared.ledgerHead.currentBuyingPower,
    cashRequired,
  );
  const postFence = subtractDecimals(fence.remainingBuyingPower, cashRequired);
  const postQuantity = (
    BigInt(prepared.ledgerHead.positionQuantity)
    + BigInt(prepared.execution.filledQuantity)
  ).toString();
  const postGrossCost = addDecimals(
    prepared.ledgerHead.positionGrossCostAssetBalance,
    prepared.fee.grossNotional,
  );
  const latestSequence = prepared.lots.reduce<SequenceString>(
    (latest, lot) => compareSequence(lot.acquisitionSequence, latest) > 0
      ? lot.acquisitionSequence
      : latest,
    sequence("0"),
  );
  const createdLot = Object.freeze({
    lotId: `${prepared.settlementId}:lot`,
    instrumentId: order.instrumentId,
    acquisitionSequence: nextSequence(latestSequence),
    quantity: nonNegativeDecimal(prepared.execution.filledQuantity),
    grossPurchasePrice: nonNegativeDecimal(prepared.fee.grossNotional),
    buyFees: prepared.fee.total,
    currency: prepared.ledgerHead.currency,
    grossPurchasePriceCny: multiplyDecimals(
      prepared.fee.grossNotional,
      acquisitionFx.cnyPerBaseUnit,
    ),
    buyFeesCny: multiplyDecimals(
      prepared.fee.total,
      acquisitionFx.cnyPerBaseUnit,
    ),
    acquisitionTradeDate: prepared.execution.tradeDate,
    acquisitionSettlementId: prepared.settlementId,
    acquisitionFxEvidence: acquisitionFx,
  });
  const brokerTransaction = createBuyLedgerTransaction(
    prepared,
    cashRequired,
  );
  const balanceTransition = balanceTransitionFor(prepared.ledgerHead, {
    cash: postCash,
    buyingPower: postBuyingPower,
    taxReserve: prepared.ledgerHead.taxReserveBalance,
    quantity: postQuantity,
    grossCost: postGrossCost,
  });

  const intent = freezeCanonical<PaperSettlementIntent>({
    ...intentHeader(prepared),
    cashFence: {
      planFingerprint: plan.planFingerprint,
      currentBuyingPower: prepared.ledgerHead.currentBuyingPower,
      frozenRemainingBuyingPower: fence.remainingBuyingPower,
      effectiveBuyingPowerLimit: effectiveLimit,
      cashEffect: cashRequired,
      frozenRemainingBuyingPowerAfter: postFence,
      priorSettlementIds: fence.priorSettlementIds,
    },
    balanceTransition,
    lotTransition: {
      lotsBefore: prepared.lots,
      createdLot,
      disposedAllocations: [],
      remainingLots: prepared.lots,
    },
    tax: {
      status: "RESOLVED",
      sourceCountry: null,
      currency: "CNY",
      dispositionFxEvidence: null,
      acquisitionLotBindings: [{
        lotId: createdLot.lotId,
        acquisitionTradeDate: createdLot.acquisitionTradeDate,
        acquisitionSettlementId: createdLot.acquisitionSettlementId,
        remainingGrossPurchasePriceCny: createdLot.grossPurchasePriceCny,
        remainingBuyFeesCny: createdLot.buyFeesCny,
        evidence: acquisitionFx,
      }],
      allocations: [],
      grossProceedsCny: "0",
      sellFeesCny: "0",
      allocatedTaxBasisCny: addDecimals(
        createdLot.grossPurchasePriceCny,
        createdLot.buyFeesCny,
      ),
      realizedGainCny: "0",
      taxableGainCny: "0",
      chinaCapitalGainsTaxCny: "0",
      taxReserveTradingCurrencyAmount: "0",
    },
    ledgerTransactions: [brokerTransaction],
  });
  return readyResult(intent);
}

function createSellSettlement(
  input: SellPaperSettlementInput,
  prepared: PreparedSettlement,
): PaperOrderSettlementResult {
  const plan = input.plan;
  const order = prepared.order as FrozenSellOrder;
  const filled = BigInt(prepared.execution.filledQuantity);
  if (filled > BigInt(prepared.ledgerHead.positionQuantity)) {
    throw new RangeError("Paper sell would create a short position");
  }
  if (input.sourceCountry === undefined) {
    return unresolvedResult(
      prepared,
      "SELL_SOURCE_COUNTRY_REQUIRED",
      [order.instrumentId],
    );
  }
  if (input.dispositionFxEvidence === undefined) {
    return unresolvedResult(
      prepared,
      "SELL_DISPOSITION_FX_REQUIRED",
      [prepared.execution.tradeDate],
    );
  }

  const brokerDisposition = calculateFifoDisposition({
    dispositionId: order.orderId,
    instrumentId: order.instrumentId,
    taxYear: prepared.execution.tradeDate.slice(0, 4),
    sourceCountry: input.sourceCountry,
    quantity: nonNegativeDecimal(prepared.execution.filledQuantity),
    grossProceeds: nonNegativeDecimal(prepared.fee.grossNotional),
    sellFees: prepared.fee.total,
    availableLots: prepared.lots,
    allocationScale: Number(plan.taxAllocationScale),
  });
  const allocatedLotIds = brokerDisposition.allocations.map((allocation) => allocation.lotId);
  const acquisitionBindings = normalizeAcquisitionBindings(
    input.acquisitionFxEvidence ?? [],
    prepared,
  );
  const missingLotIds = allocatedLotIds.filter((lotId) => !acquisitionBindings.has(lotId));
  if (missingLotIds.length > 0) {
    return unresolvedResult(
      prepared,
      "SELL_ACQUISITION_FX_REQUIRED",
      missingLotIds.sort(),
    );
  }
  const dispositionFx = normalizeFxEvidence(
    input.dispositionFxEvidence,
    prepared.ledgerHead.currency,
    prepared.settledAt,
    prepared.execution.tradeDate,
    "disposition",
  );
  const consumedLots = allocatedLotIds.map((lotId) => {
    const lot = prepared.lots.find((candidate) => candidate.lotId === lotId)!;
    const binding = acquisitionBindings.get(lotId)!;
    return Object.freeze({
      lotId: lot.lotId,
      instrumentId: lot.instrumentId,
      acquisitionSequence: lot.acquisitionSequence,
      quantity: lot.quantity,
      grossPurchasePrice: nonNegativeDecimal(binding.remainingGrossPurchasePriceCny),
      buyFees: nonNegativeDecimal(binding.remainingBuyFeesCny),
    });
  });
  const grossProceedsCny = multiplyDecimals(
    prepared.fee.grossNotional,
    dispositionFx.cnyPerBaseUnit,
  );
  const sellFeesCny = multiplyDecimals(
    prepared.fee.total,
    dispositionFx.cnyPerBaseUnit,
  );
  const cnyDisposition = calculateFifoDisposition({
    dispositionId: order.orderId,
    instrumentId: order.instrumentId,
    taxYear: prepared.execution.tradeDate.slice(0, 4),
    sourceCountry: input.sourceCountry,
    quantity: nonNegativeDecimal(prepared.execution.filledQuantity),
    grossProceeds: nonNegativeDecimal(grossProceedsCny),
    sellFees: nonNegativeDecimal(sellFeesCny),
    availableLots: consumedLots,
    allocationScale: Number(plan.taxAllocationScale),
  });
  for (const [index, allocation] of cnyDisposition.allocations.entries()) {
    const brokerAllocation = brokerDisposition.allocations[index];
    if (
      brokerAllocation === undefined
      || allocation.lotId !== brokerAllocation.lotId
      || allocation.quantity !== brokerAllocation.quantity
    ) {
      throw new TypeError("CNY FIFO allocation diverged from broker-currency FIFO order");
    }
  }

  const taxReserveTradingCurrencyAmount = divideDecimals(
    cnyDisposition.chinaCapitalGainsTax,
    dispositionFx.cnyPerBaseUnit,
    CNY_RESERVE_SCALE,
    "HALF_UP",
  );
  const netSaleCash = subtractDecimals(prepared.fee.grossNotional, prepared.fee.total);
  if (compareDecimals(netSaleCash, "0") < 0) {
    throw new RangeError("Paper sell fees exceed gross proceeds");
  }
  const postCash = addDecimals(prepared.ledgerHead.cashAssetBalance, netSaleCash);
  const postTaxReserve = addDecimals(
    prepared.ledgerHead.taxReserveBalance,
    taxReserveTradingCurrencyAmount,
  );
  const postBuyingPower = subtractDecimals(
    addDecimals(prepared.ledgerHead.currentBuyingPower, netSaleCash),
    taxReserveTradingCurrencyAmount,
  );
  if (compareDecimals(postBuyingPower, "0") < 0) {
    throw new RangeError("Resolved sell tax reserve would create negative buying power");
  }
  if (compareDecimals(postTaxReserve, postCash) > 0) {
    throw new RangeError("Resolved sell tax reserve exceeds the post-settlement cash asset");
  }
  const postQuantity = (
    BigInt(prepared.ledgerHead.positionQuantity) - filled
  ).toString();
  const postGrossCost = subtractDecimals(
    prepared.ledgerHead.positionGrossCostAssetBalance,
    brokerDisposition.allocatedPurchasePrice,
  );
  if (compareDecimals(postGrossCost, "0") < 0) {
    throw new RangeError("Paper sell would create a negative position-cost asset");
  }
  const cnyAllocations = cnyDisposition.allocations.map((allocation) => Object.freeze({
    ...allocation,
    acquisitionFxRateId: acquisitionBindings.get(allocation.lotId)!.evidence.fxRateId,
  }));
  const acquisitionLotBindings = allocatedLotIds.map(
    (lotId) => acquisitionBindings.get(lotId)!,
  );
  const balanceTransition = balanceTransitionFor(prepared.ledgerHead, {
    cash: postCash,
    buyingPower: postBuyingPower,
    taxReserve: postTaxReserve,
    quantity: postQuantity,
    grossCost: postGrossCost,
  });
  const ledgerTransactions = [
    createSellLedgerTransaction(prepared, brokerDisposition.allocatedPurchasePrice, netSaleCash),
    ...createTaxLedgerTransactions(prepared, cnyDisposition.chinaCapitalGainsTax),
  ];
  const intent = freezeCanonical<PaperSettlementIntent>({
    ...intentHeader(prepared),
    cashFence: null,
    balanceTransition,
    lotTransition: {
      lotsBefore: prepared.lots,
      createdLot: null,
      disposedAllocations: brokerDisposition.allocations,
      remainingLots: brokerDisposition.remainingLots,
    },
    tax: {
      status: "RESOLVED",
      sourceCountry: input.sourceCountry,
      currency: "CNY",
      dispositionFxEvidence: dispositionFx,
      acquisitionLotBindings,
      allocations: cnyAllocations,
      grossProceedsCny,
      sellFeesCny,
      allocatedTaxBasisCny: cnyDisposition.allocatedTaxBasis,
      realizedGainCny: cnyDisposition.realizedGain,
      taxableGainCny: cnyDisposition.taxableGain,
      chinaCapitalGainsTaxCny: cnyDisposition.chinaCapitalGainsTax,
      taxReserveTradingCurrencyAmount,
    },
    ledgerTransactions,
  });
  return readyResult(intent);
}

function intentHeader(prepared: PreparedSettlement) {
  return {
    schema: PAPER_SETTLEMENT_INTENT_SCHEMA,
    authority: PAPER_SETTLEMENT_AUTHORITY,
    settlementRulesetId: PAPER_SETTLEMENT_RULESET_ID,
    settlementId: prepared.settlementId,
    strategyAccountId: prepared.ledgerHead.strategyAccountId,
    runId: prepared.ledgerHead.runId,
    decisionId: prepared.order.decisionId,
    stage: prepared.order.stage,
    side: prepared.order.side,
    orderId: prepared.order.orderId,
    instrumentId: prepared.order.instrumentId,
    symbol: prepared.order.symbol,
    tradeDate: prepared.execution.tradeDate,
    settledAt: prepared.settledAt,
    currency: prepared.ledgerHead.currency,
    ledgerHead: prepared.ledgerHead,
    frozenOrder: prepared.frozenOrder,
    execution: prepared.execution,
    fee: prepared.fee,
  } as const;
}

function readyResult(intent: PaperSettlementIntent): PaperOrderSettlementResult {
  const canonicalJson = canonicalFinancialJson(intent);
  return Object.freeze({
    status: "READY",
    intent,
    canonicalJson,
    contentSha256: sha256Utf8(canonicalJson),
  });
}

function unresolvedResult(
  prepared: PreparedSettlement,
  reason: PaperSettlementTaxUnresolvedReason,
  missingEvidenceIds: readonly string[],
): PaperOrderSettlementResult {
  const unresolved = freezeCanonical<PaperSettlementUnresolvedRecord>({
    schema: PAPER_SETTLEMENT_UNRESOLVED_SCHEMA,
    authority: PAPER_SETTLEMENT_AUTHORITY,
    settlementRulesetId: PAPER_SETTLEMENT_RULESET_ID,
    status: "TAX_UNRESOLVED",
    reason,
    missingEvidenceIds: [...new Set(missingEvidenceIds)].sort(),
    settlementId: prepared.settlementId,
    settledAt: prepared.settledAt,
    ledgerHead: prepared.ledgerHead,
    frozenOrder: prepared.frozenOrder,
    execution: prepared.execution,
    fee: prepared.fee,
  });
  const canonicalJson = canonicalFinancialJson(unresolved);
  return Object.freeze({
    status: "TAX_UNRESOLVED",
    unresolved,
    canonicalJson,
    contentSha256: sha256Utf8(canonicalJson),
  });
}

function normalizeExecution(
  execution: CompletedPaperOrderExecution,
  plan: BuyOrderPlan | SellOrderPlan,
  order: FrozenBuyOrder | FrozenSellOrder,
  orderQuantity: bigint,
  settledAt: string,
): NormalizedPaperOrderExecution {
  requireIdentity(execution.executionId, "execution.executionId");
  if (
    execution.orderId !== order.orderId
    || execution.decisionId !== plan.decisionId
    || execution.stage !== order.stage
    || execution.side !== order.side
    || execution.instrumentId !== order.instrumentId
  ) {
    throw new TypeError("Paper execution is not bound to the frozen order");
  }
  requireCalendarDate(execution.tradeDate, "execution.tradeDate");
  if (execution.tradeDate !== order.plannedTradeDate) {
    throw new TypeError("Paper execution tradeDate differs from the frozen order");
  }
  const executionCurrency = currency(execution.currency);
  if (executionCurrency !== order.feeCurrency) {
    throw new TypeError("Paper execution currency differs from the frozen order");
  }
  if (
    execution.terminalStatus !== "FILLED"
    && execution.terminalStatus !== "PARTIALLY_FILLED"
    && execution.terminalStatus !== "CANCELED"
  ) {
    throw new TypeError("Paper execution must have a supported terminal status");
  }
  if (!Array.isArray(execution.fills)) {
    throw new TypeError("Paper settlement fills must be an array");
  }
  if (execution.terminalStatus !== "CANCELED" && execution.fills.length === 0) {
    throw new TypeError("A filled paper settlement requires every fill for one terminal order");
  }

  const seenFillIds = new Set<string>();
  const seenProviderExecutionIds = new Set<string>();
  const liquidityEvidence = normalizeLiquidityEvidence(
    execution.liquidityEvidence,
    plan,
    execution.tradeDate,
    settledAt,
  );
  const fills = execution.fills.map((fill, index): NormalizedPaperFill => {
    requireIdentity(fill.fillId, `execution.fills[${index}].fillId`);
    if (seenFillIds.has(fill.fillId)) throw new TypeError(`Duplicate fillId: ${fill.fillId}`);
    seenFillIds.add(fill.fillId);
    const quantity = requirePositiveInteger(
      fill.quantity,
      `execution.fills[${index}].quantity`,
    ).toString();
    const price = requirePositiveDecimal(fill.price, `execution.fills[${index}].price`);
    requireIsoTimestamp(fill.executedAt, `execution.fills[${index}].executedAt`);
    if (fill.executedAt.slice(0, 10) !== execution.tradeDate) {
      throw new TypeError("Paper fill executedAt must fall on tradeDate");
    }
    if (Date.parse(fill.executedAt) < Date.parse(order.plannedAt)) {
      throw new RangeError("Paper fill cannot execute before its frozen order was planned");
    }
    if (Date.parse(fill.executedAt) > Date.parse(settledAt)) {
      throw new RangeError("Paper fill cannot execute after settlement time");
    }
    const evidence = normalizeFillEvidence(
      fill.priceEvidence,
      plan.executionModel,
      order.side,
      price,
      execution.tradeDate,
      plan.slippageBps,
      plan.fillPriceScale,
      plan.maxParticipationBps,
      fill.executedAt,
      settledAt,
      seenProviderExecutionIds,
      index,
    );
    return Object.freeze({
      fillId: fill.fillId,
      quantity,
      price,
      executedAt: fill.executedAt,
      priceEvidence: evidence,
    });
  }).sort((left, right) =>
    compareCodePoints(left.executedAt, right.executedAt)
    || compareCodePoints(left.fillId, right.fillId)
  );
  if (
    (plan.executionModel === "SIMULATED_SLIPPAGE"
      || plan.executionModel === "SIMULATED_MINUTE_PARTICIPATION")
    && fills.length > 1
  ) {
    const oneOfficialOpenFact = canonicalFinancialJson(fills[0]!.priceEvidence);
    if (
      fills.some(
        (fill) => canonicalFinancialJson(fill.priceEvidence) !== oneOfficialOpenFact,
      )
    ) {
      throw new TypeError(
        "Every simulated partial fill for one order must derive from one official-open fact",
      );
    }
  }
  const filledQuantity = fills.reduce(
    (total, fill) => total + BigInt(fill.quantity),
    0n,
  );
  const canceledQuantity = requireInteger(
    execution.canceledQuantity,
    "execution.canceledQuantity",
  );
  if (liquidityEvidence !== undefined) {
    const liquidity = calculateVolumeParticipationLimit({
      requestedQuantity: orderQuantity.toString(),
      observedVolume: liquidityEvidence.observedVolume,
      maxParticipationBps: liquidityEvidence.maxParticipationBps,
    });
    if (filledQuantity > BigInt(liquidity.maximumFillQuantity)) {
      throw new RangeError("Paper execution exceeds frozen minute liquidity");
    }
    for (const fill of fills) {
      if (
        fill.priceEvidence.semantics
          !== "SIMULATED_MINUTE_PARTICIPATION_DERIVED_PRICE"
        || fill.priceEvidence.factId !== liquidityEvidence.factId
        || fill.priceEvidence.snapshotId !== liquidityEvidence.snapshotId
        || fill.priceEvidence.observedVolume !== liquidityEvidence.observedVolume
        || fill.priceEvidence.maxParticipationBps
          !== liquidityEvidence.maxParticipationBps
      ) {
        throw new TypeError(
          "fill price and liquidity evidence must bind one minute fact",
        );
      }
    }
  }
  if (filledQuantity + canceledQuantity !== orderQuantity) {
    throw new RangeError("Filled plus canceled quantity must equal the frozen order quantity");
  }
  if (
    (execution.terminalStatus === "FILLED" && canceledQuantity !== 0n)
    || (execution.terminalStatus === "PARTIALLY_FILLED" && canceledQuantity === 0n)
    || (
      execution.terminalStatus === "CANCELED"
      && (filledQuantity !== 0n || canceledQuantity !== orderQuantity)
    )
  ) {
    throw new TypeError("Paper execution terminal status does not match canceled quantity");
  }

  return freezeCanonical<NormalizedPaperOrderExecution>({
    executionId: execution.executionId,
    orderId: execution.orderId,
    decisionId: execution.decisionId,
    stage: execution.stage,
    side: execution.side,
    instrumentId: execution.instrumentId,
    tradeDate: execution.tradeDate,
    currency: executionCurrency,
    terminalStatus: execution.terminalStatus,
    orderQuantity: orderQuantity.toString(),
    filledQuantity: filledQuantity.toString(),
    canceledQuantity: canceledQuantity.toString(),
    ...(liquidityEvidence === undefined ? {} : { liquidityEvidence }),
    fills,
  });
}

function normalizeLiquidityEvidence(
  evidence: MinuteParticipationLiquidityEvidence | undefined,
  plan: BuyOrderPlan | SellOrderPlan,
  tradeDate: string,
  settledAt: string,
): MinuteParticipationLiquidityEvidence | undefined {
  if (plan.executionModel !== "SIMULATED_MINUTE_PARTICIPATION") {
    if (evidence !== undefined) {
      throw new TypeError("liquidity evidence is not allowed by the frozen plan");
    }
    return undefined;
  }
  if (evidence === undefined) {
    throw new TypeError("minute-participation execution requires liquidity evidence");
  }
  requireExactObjectKeys(evidence, [
    "semantics", "sourceId", "sourceVersionId", "factId",
    "sourceArtifactId", "sourceContentSha256", "observedAt", "snapshotId",
    "sessionDate", "observedVolume", "maxParticipationBps",
  ], "execution.liquidityEvidence");
  if (evidence.semantics !== "MINUTE_VOLUME_PARTICIPATION_CAP") {
    throw new TypeError("unsupported execution liquidity evidence");
  }
  for (const [field, value] of [
    ["sourceId", evidence.sourceId],
    ["sourceVersionId", evidence.sourceVersionId],
    ["factId", evidence.factId],
    ["sourceArtifactId", evidence.sourceArtifactId],
    ["snapshotId", evidence.snapshotId],
  ] as const) requireIdentity(value, `execution.liquidityEvidence.${field}`);
  requireSha256(
    evidence.sourceContentSha256,
    "execution.liquidityEvidence.sourceContentSha256",
  );
  requireIsoTimestamp(evidence.observedAt, "execution.liquidityEvidence.observedAt");
  requireCalendarDate(evidence.sessionDate, "execution.liquidityEvidence.sessionDate");
  if (
    evidence.sessionDate !== tradeDate
    || evidence.observedAt.slice(0, 10) !== tradeDate
    || Date.parse(evidence.observedAt) > Date.parse(settledAt)
  ) throw new TypeError("execution liquidity evidence is outside the trade fence");
  const observedVolume = requireInteger(
    evidence.observedVolume,
    "execution.liquidityEvidence.observedVolume",
  ).toString();
  const maxParticipationBps = requireInteger(
    evidence.maxParticipationBps,
    "execution.liquidityEvidence.maxParticipationBps",
  ).toString();
  if (
    maxParticipationBps !== plan.maxParticipationBps
    || BigInt(maxParticipationBps) === 0n
    || BigInt(maxParticipationBps) > 10_000n
  ) throw new TypeError("liquidity evidence differs from the frozen plan");
  return freezeCanonical({
    semantics: "MINUTE_VOLUME_PARTICIPATION_CAP" as const,
    sourceId: evidence.sourceId,
    sourceVersionId: evidence.sourceVersionId,
    factId: evidence.factId,
    sourceArtifactId: evidence.sourceArtifactId,
    sourceContentSha256: evidence.sourceContentSha256,
    observedAt: evidence.observedAt,
    snapshotId: evidence.snapshotId,
    sessionDate: evidence.sessionDate,
    observedVolume,
    maxParticipationBps,
  });
}

function normalizeFillEvidence(
  evidence: PaperFillPriceEvidence,
  executionModel: OrderExecutionModel,
  side: "BUY" | "SELL",
  fillPrice: DecimalString,
  tradeDate: string,
  planSlippageBps: string,
  planFillPriceScale: string,
  planMaxParticipationBps: string | undefined,
  executedAt: string,
  settledAt: string,
  seenProviderExecutionIds: Set<string>,
  index: number,
): PaperFillPriceEvidence {
  for (const [field, value] of [
    ["sourceId", evidence.sourceId],
    ["sourceVersionId", evidence.sourceVersionId],
    ["factId", evidence.factId],
    ["sourceArtifactId", evidence.sourceArtifactId],
  ] as const) {
    requireIdentity(value, `execution.fills[${index}].priceEvidence.${field}`);
  }
  requireSha256(
    evidence.sourceContentSha256,
    `execution.fills[${index}].priceEvidence.sourceContentSha256`,
  );
  requireIsoTimestamp(
    evidence.observedAt,
    `execution.fills[${index}].priceEvidence.observedAt`,
  );
  if (Date.parse(evidence.observedAt) > Date.parse(settledAt)) {
    throw new RangeError("Paper fill evidence was not visible by settlement time");
  }
  if (
    executionModel === "SIMULATED_SLIPPAGE"
    || executionModel === "SIMULATED_MINUTE_PARTICIPATION"
  ) {
    const volumeParticipation =
      executionModel === "SIMULATED_MINUTE_PARTICIPATION";
    const expectedSemantics = volumeParticipation
      ? "SIMULATED_MINUTE_PARTICIPATION_DERIVED_PRICE"
      : "SIMULATED_SLIPPAGE_DERIVED_PRICE";
    if (evidence.semantics !== expectedSemantics) {
      throw new TypeError(volumeParticipation
        ? "SIMULATED_MINUTE_PARTICIPATION plan requires matching derived price evidence"
        : "SIMULATED_SLIPPAGE plan requires derived official-open price evidence");
    }
    requireExactObjectKeys(evidence, [
      "semantics",
      "sourceId",
      "sourceVersionId",
      "factId",
      "sourceArtifactId",
      "sourceContentSha256",
      "observedAt",
      "snapshotId",
      "officialOpenSessionDate",
      "officialOpenPrice",
      ...(volumeParticipation
        ? ["observedVolume", "maxParticipationBps"]
        : []),
      "slippageBps",
      "fillPriceScale",
    ], `execution.fills[${index}].priceEvidence`);
    requireIdentity(evidence.snapshotId, `execution.fills[${index}].priceEvidence.snapshotId`);
    requireCalendarDate(
      evidence.officialOpenSessionDate,
      `execution.fills[${index}].priceEvidence.officialOpenSessionDate`,
    );
    if (evidence.officialOpenSessionDate !== tradeDate) {
      throw new TypeError("Simulated fill official-open session must equal tradeDate");
    }
    if (evidence.observedAt.slice(0, 10) !== tradeDate) {
      throw new TypeError("Official-open evidence must become visible on tradeDate");
    }
    if (Date.parse(evidence.observedAt) > Date.parse(executedAt)) {
      throw new RangeError("Official-open evidence was not visible by simulated execution");
    }
    const officialOpenPrice = requirePositiveDecimal(
      evidence.officialOpenPrice,
      `execution.fills[${index}].priceEvidence.officialOpenPrice`,
    );
    const slippageBps = requireInteger(
      evidence.slippageBps,
      `execution.fills[${index}].priceEvidence.slippageBps`,
    ).toString();
    const fillPriceScale = requireInteger(
      evidence.fillPriceScale,
      `execution.fills[${index}].priceEvidence.fillPriceScale`,
    ).toString();
    let observedVolume: string | undefined;
    let maxParticipationBps: string | undefined;
    if (volumeParticipation) {
      const volumeEvidence = evidence as
        SimulatedMinuteParticipationFillPriceEvidence;
      observedVolume = requireInteger(
        volumeEvidence.observedVolume,
        `execution.fills[${index}].priceEvidence.observedVolume`,
      ).toString();
      const participation = requireInteger(
        volumeEvidence.maxParticipationBps,
        `execution.fills[${index}].priceEvidence.maxParticipationBps`,
      );
      if (participation === 0n) {
        throw new TypeError("maxParticipationBps must be positive");
      }
      maxParticipationBps = participation.toString();
      if (
        maxParticipationBps !== planMaxParticipationBps
        || BigInt(maxParticipationBps) > 10_000n
      ) {
        throw new TypeError(
          "Simulated fill participation differs from its frozen plan",
        );
      }
    }
    if (slippageBps !== planSlippageBps || fillPriceScale !== planFillPriceScale) {
      throw new TypeError("Simulated fill derivation settings differ from its frozen plan");
    }
    const expectedFillPrice = applySimulatedSlippage({
      side,
      officialOpenPrice,
      slippageBps,
      priceScale: Number(fillPriceScale),
    });
    if (fillPrice !== expectedFillPrice) {
      throw new TypeError(
        `Simulated fill price ${fillPrice} differs from derived price ${expectedFillPrice}`,
      );
    }
    return freezeCanonical<
      SimulatedSlippageFillPriceEvidence
      | SimulatedMinuteParticipationFillPriceEvidence
    >({
      semantics: evidence.semantics,
      sourceId: evidence.sourceId,
      sourceVersionId: evidence.sourceVersionId,
      factId: evidence.factId,
      sourceArtifactId: evidence.sourceArtifactId,
      sourceContentSha256: evidence.sourceContentSha256,
      observedAt: evidence.observedAt,
      snapshotId: evidence.snapshotId,
      officialOpenSessionDate: evidence.officialOpenSessionDate,
      officialOpenPrice,
      ...(observedVolume === undefined
        ? {}
        : { observedVolume, maxParticipationBps: maxParticipationBps! }),
      slippageBps,
      fillPriceScale,
    });
  }

  if (evidence.semantics !== "BROKER_ACTUAL_EXECUTION_PRICE") {
    throw new TypeError("BROKER_ACTUAL plan requires provider execution evidence");
  }
  requireExactObjectKeys(evidence, [
    "semantics",
    "sourceId",
    "sourceVersionId",
    "factId",
    "sourceArtifactId",
    "sourceContentSha256",
    "observedAt",
    "providerExecutionId",
  ], `execution.fills[${index}].priceEvidence`);
  requireIdentity(
    evidence.providerExecutionId,
    `execution.fills[${index}].priceEvidence.providerExecutionId`,
  );
  if (Date.parse(evidence.observedAt) < Date.parse(executedAt)) {
    throw new RangeError("Broker fill evidence cannot be observed before execution");
  }
  if (seenProviderExecutionIds.has(evidence.providerExecutionId)) {
    throw new TypeError(`Duplicate providerExecutionId: ${evidence.providerExecutionId}`);
  }
  seenProviderExecutionIds.add(evidence.providerExecutionId);
  return freezeCanonical<BrokerActualFillPriceEvidence>({
    semantics: evidence.semantics,
    sourceId: evidence.sourceId,
    sourceVersionId: evidence.sourceVersionId,
    factId: evidence.factId,
    sourceArtifactId: evidence.sourceArtifactId,
    sourceContentSha256: evidence.sourceContentSha256,
    observedAt: evidence.observedAt,
    providerExecutionId: evidence.providerExecutionId,
  });
}

function normalizeLedgerHead(
  head: PaperSettlementLedgerHead,
  order: FrozenBuyOrder | FrozenSellOrder,
  settledAt: string,
): NormalizedPaperSettlementLedgerHead {
  for (const [field, value] of [
    ["strategyAccountId", head.strategyAccountId],
    ["runId", head.runId],
    ["headEventId", head.headEventId],
  ] as const) requireIdentity(value, `ledgerHead.${field}`);
  const headSequence = sequenceValue(head.headSequence, "ledgerHead.headSequence");
  requireSha256(head.headHash, "ledgerHead.headHash");
  requireIsoTimestamp(head.capturedAt, "ledgerHead.capturedAt");
  if (Date.parse(head.capturedAt) > Date.parse(settledAt)) {
    throw new RangeError("Ledger head cannot be captured after settlement time");
  }
  const headCurrency = currency(head.currency);
  if (headCurrency !== order.feeCurrency) {
    throw new TypeError("Ledger currency differs from frozen order fee currency");
  }
  if (head.instrumentId !== order.instrumentId) {
    throw new TypeError("Ledger position instrument differs from frozen order");
  }
  const cashAssetBalance = requireNonNegativeDecimal(
    head.cashAssetBalance,
    "ledgerHead.cashAssetBalance",
  );
  const currentBuyingPower = requireNonNegativeDecimal(
    head.currentBuyingPower,
    "ledgerHead.currentBuyingPower",
  );
  const taxReserveBalance = requireNonNegativeDecimal(
    head.taxReserveBalance,
    "ledgerHead.taxReserveBalance",
  );
  if (compareDecimals(currentBuyingPower, cashAssetBalance) > 0) {
    throw new RangeError("Current buying power cannot exceed the cash asset balance");
  }
  if (compareDecimals(taxReserveBalance, cashAssetBalance) > 0) {
    throw new RangeError("Tax reserve cannot exceed the cash asset balance");
  }
  const positionQuantity = requireInteger(
    head.positionQuantity,
    "ledgerHead.positionQuantity",
  ).toString();
  const positionGrossCostAssetBalance = requireNonNegativeDecimal(
    head.positionGrossCostAssetBalance,
    "ledgerHead.positionGrossCostAssetBalance",
  );
  if (
    (positionQuantity === "0")
    !== (positionGrossCostAssetBalance === "0")
  ) {
    throw new RangeError("Zero position quantity and gross-cost asset must occur together");
  }
  return freezeCanonical<NormalizedPaperSettlementLedgerHead>({
    strategyAccountId: head.strategyAccountId,
    runId: head.runId,
    headEventId: head.headEventId,
    headSequence,
    headHash: head.headHash,
    capturedAt: head.capturedAt,
    currency: headCurrency,
    instrumentId: head.instrumentId,
    cashAssetBalance,
    currentBuyingPower,
    taxReserveBalance,
    positionQuantity,
    positionGrossCostAssetBalance,
  });
}

function normalizeLots(
  inputLots: readonly ShadowTaxLot[],
  instrumentId: string,
  head: NormalizedPaperSettlementLedgerHead,
): readonly ShadowTaxLot[] {
  if (!Array.isArray(inputLots)) throw new TypeError("availableLots must be an array");
  const seenIds = new Set<string>();
  const seenSequences = new Set<string>();
  const lots = inputLots.map((lot, index) => {
    requireIdentity(lot.lotId, `availableLots[${index}].lotId`);
    if (lot.instrumentId !== instrumentId) {
      throw new TypeError(`Lot ${lot.lotId} belongs to a different instrument`);
    }
    if (seenIds.has(lot.lotId)) throw new TypeError(`Duplicate lotId: ${lot.lotId}`);
    seenIds.add(lot.lotId);
    const acquisitionSequence = sequenceValue(
      lot.acquisitionSequence,
      `availableLots[${index}].acquisitionSequence`,
    );
    if (seenSequences.has(acquisitionSequence)) {
      throw new TypeError(`Duplicate acquisition sequence: ${acquisitionSequence}`);
    }
    seenSequences.add(acquisitionSequence);
    return Object.freeze({
      lotId: lot.lotId,
      instrumentId: lot.instrumentId,
      acquisitionSequence,
      quantity: nonNegativeDecimal(
        requirePositiveInteger(lot.quantity, `availableLots[${index}].quantity`).toString(),
      ),
      grossPurchasePrice: nonNegativeDecimal(requireNonNegativeDecimal(
        lot.grossPurchasePrice,
        `availableLots[${index}].grossPurchasePrice`,
      )),
      buyFees: nonNegativeDecimal(requireNonNegativeDecimal(
        lot.buyFees,
        `availableLots[${index}].buyFees`,
      )),
    });
  }).sort((left, right) => compareSequence(
    left.acquisitionSequence,
    right.acquisitionSequence,
  ));
  const totalQuantity = sumDecimals(lots.map((lot) => lot.quantity));
  const totalGrossCost = sumDecimals(lots.map((lot) => lot.grossPurchasePrice));
  if (totalQuantity !== head.positionQuantity) {
    throw new RangeError("Available FIFO lot quantity does not match ledger position quantity");
  }
  if (totalGrossCost !== head.positionGrossCostAssetBalance) {
    throw new RangeError("Available FIFO lot gross cost does not match position-cost asset");
  }
  return freezeCanonical<readonly ShadowTaxLot[]>(lots);
}

function normalizeCashFence(
  fence: FrozenPlanCashFence,
  plan: BuyOrderPlan,
  settlementId: string,
) {
  if (fence.planFingerprint !== plan.planFingerprint) {
    throw new TypeError("Plan cash fence fingerprint differs from frozen plan");
  }
  const remainingBuyingPower = requireNonNegativeDecimal(
    fence.remainingBuyingPower,
    "planCashFence.remainingBuyingPower",
  );
  if (compareDecimals(remainingBuyingPower, plan.initialBuyingPower) > 0) {
    throw new RangeError("Frozen plan remaining buying power exceeds its initial limit");
  }
  if (!Array.isArray(fence.priorSettlementIds)) {
    throw new TypeError("planCashFence.priorSettlementIds must be an array");
  }
  const priorSettlementIds = [...fence.priorSettlementIds].map((id, index) => {
    requireIdentity(id, `planCashFence.priorSettlementIds[${index}]`);
    return id;
  }).sort();
  if (new Set(priorSettlementIds).size !== priorSettlementIds.length) {
    throw new TypeError("Plan cash fence contains duplicate prior settlement IDs");
  }
  if (priorSettlementIds.includes(settlementId)) {
    throw new TypeError("Paper order was already included in its frozen plan cash fence");
  }
  const validPriorSettlementIds = new Set(
    plan.orders.map((order) => `${order.orderId}:paper-settlement:v1`),
  );
  for (const priorSettlementId of priorSettlementIds) {
    if (!validPriorSettlementIds.has(priorSettlementId)) {
      throw new TypeError(
        `Plan cash fence references settlement outside its frozen plan: ${priorSettlementId}`,
      );
    }
  }
  const currentOrderIndex = plan.orders.findIndex(
    (order) => `${order.orderId}:paper-settlement:v1` === settlementId,
  );
  if (currentOrderIndex < 0) {
    throw new TypeError("Plan cash fence current order is absent from its frozen plan");
  }
  const expectedPriorSettlementIds = plan.orders
    .slice(0, currentOrderIndex)
    .map((order) => `${order.orderId}:paper-settlement:v1`)
    .sort();
  if (
    priorSettlementIds.length !== expectedPriorSettlementIds.length
    || priorSettlementIds.some(
      (id, index) => id !== expectedPriorSettlementIds[index],
    )
  ) {
    throw new RangeError("Frozen S2 order priority would be bypassed");
  }
  return Object.freeze({ remainingBuyingPower, priorSettlementIds: Object.freeze(priorSettlementIds) });
}

function normalizeAcquisitionBindings(
  bindings: readonly LotAcquisitionFxBinding[],
  prepared: PreparedSettlement,
): ReadonlyMap<string, NormalizedLotAcquisitionFxBinding> {
  if (!Array.isArray(bindings)) {
    throw new TypeError("acquisitionFxEvidence must be an array");
  }
  const knownLotIds = new Set(prepared.lots.map((lot) => lot.lotId));
  const lotsById = new Map(prepared.lots.map((lot) => [lot.lotId, lot] as const));
  const byLot = new Map<string, NormalizedLotAcquisitionFxBinding>();
  for (const [index, binding] of bindings.entries()) {
    requireIdentity(binding.lotId, `acquisitionFxEvidence[${index}].lotId`);
    if (!knownLotIds.has(binding.lotId)) {
      throw new TypeError(`Acquisition FX references unknown lot ${binding.lotId}`);
    }
    if (byLot.has(binding.lotId)) {
      throw new TypeError(`Duplicate acquisition FX for lot ${binding.lotId}`);
    }
    requireCalendarDate(
      binding.acquisitionTradeDate,
      `acquisitionFxEvidence[${index}].acquisitionTradeDate`,
    );
    requireIdentity(
      binding.acquisitionSettlementId,
      `acquisitionFxEvidence[${index}].acquisitionSettlementId`,
    );
    const remainingGrossPurchasePriceCny = requireNonNegativeDecimal(
      binding.remainingGrossPurchasePriceCny,
      `acquisitionFxEvidence[${index}].remainingGrossPurchasePriceCny`,
    );
    const remainingBuyFeesCny = requireNonNegativeDecimal(
      binding.remainingBuyFeesCny,
      `acquisitionFxEvidence[${index}].remainingBuyFeesCny`,
    );
    const lot = lotsById.get(binding.lotId)!;
    if (
      (compareDecimals(lot.grossPurchasePrice, "0") === 0)
      !== (compareDecimals(remainingGrossPurchasePriceCny, "0") === 0)
    ) {
      throw new RangeError("Broker-currency and CNY remaining gross basis must agree on zero");
    }
    if (
      (compareDecimals(lot.buyFees, "0") === 0)
      !== (compareDecimals(remainingBuyFeesCny, "0") === 0)
    ) {
      throw new RangeError("Broker-currency and CNY remaining buy fees must agree on zero");
    }
    const evidence = normalizeFxEvidence(
      binding.evidence,
      prepared.ledgerHead.currency,
      prepared.settledAt,
      binding.acquisitionTradeDate,
      "acquisition",
    );
    byLot.set(binding.lotId, freezeCanonical<NormalizedLotAcquisitionFxBinding>({
      lotId: binding.lotId,
      acquisitionTradeDate: binding.acquisitionTradeDate,
      acquisitionSettlementId: binding.acquisitionSettlementId,
      remainingGrossPurchasePriceCny,
      remainingBuyFeesCny,
      evidence,
    }));
  }
  return byLot;
}

function normalizeFxEvidence(
  evidence: CnyFxEvidence,
  baseCurrency: CurrencyCode,
  settledAt: string,
  expectedEffectiveDate: string,
  role: "acquisition" | "disposition",
): ResolvedCnyFxEvidence {
  requireExactObjectKeys(evidence, [
    "fxRateId",
    "factId",
    "sourceVersionId",
    "sourceArtifactId",
    "sourceContentSha256",
    "baseCurrency",
    "quoteCurrency",
    "cnyPerBaseUnit",
    "effectiveAt",
    "visibleAt",
    "status",
  ], `${role}FxEvidence`);
  for (const [field, value] of [
    ["fxRateId", evidence.fxRateId],
    ["factId", evidence.factId],
    ["sourceVersionId", evidence.sourceVersionId],
    ["sourceArtifactId", evidence.sourceArtifactId],
  ] as const) requireIdentity(value, `fxEvidence.${field}`);
  requireSha256(evidence.sourceContentSha256, "fxEvidence.sourceContentSha256");
  if (currency(evidence.baseCurrency) !== baseCurrency || evidence.quoteCurrency !== "CNY") {
    throw new TypeError("FX evidence must convert the settlement currency into CNY");
  }
  const cnyPerBaseUnit = requirePositiveDecimal(
    evidence.cnyPerBaseUnit,
    "fxEvidence.cnyPerBaseUnit",
  );
  requireIsoTimestamp(evidence.effectiveAt, "fxEvidence.effectiveAt");
  requireIsoTimestamp(evidence.visibleAt, "fxEvidence.visibleAt");
  if (Date.parse(evidence.visibleAt) > Date.parse(settledAt)) {
    throw new RangeError("FX evidence was not visible by settlement time");
  }
  if (evidence.effectiveAt.slice(0, 10) !== expectedEffectiveDate) {
    throw new TypeError(
      `${role} FX effective date must equal ${expectedEffectiveDate}`,
    );
  }
  if (evidence.status !== "ESTIMATED" && evidence.status !== "FINAL") {
    throw new TypeError("FX evidence status must be ESTIMATED or FINAL");
  }
  return freezeCanonical<ResolvedCnyFxEvidence>({
    fxRateId: evidence.fxRateId,
    factId: evidence.factId,
    sourceVersionId: evidence.sourceVersionId,
    sourceArtifactId: evidence.sourceArtifactId,
    sourceContentSha256: evidence.sourceContentSha256,
    baseCurrency,
    quoteCurrency: "CNY",
    cnyPerBaseUnit,
    effectiveAt: evidence.effectiveAt,
    visibleAt: evidence.visibleAt,
    status: evidence.status,
  });
}

function createBuyLedgerTransaction(
  prepared: PreparedSettlement,
  cashRequired: DecimalString,
): LedgerTransaction {
  const postings = [
    {
      postingId: `${prepared.settlementId}:broker:position`,
      accountId: "securities.inventory",
      accountKind: "ASSET" as const,
      side: "DEBIT" as const,
      amount: prepared.fee.grossNotional,
      currency: prepared.ledgerHead.currency,
      instrumentId: prepared.order.instrumentId,
      quantity: prepared.execution.filledQuantity,
      memo: "Paper buy gross position cost",
    },
    ...(compareDecimals(prepared.fee.total, "0") === 0 ? [] : [{
      postingId: `${prepared.settlementId}:broker:fee`,
      accountId: "expense.broker_fee",
      accountKind: "EXPENSE" as const,
      side: "DEBIT" as const,
      amount: prepared.fee.total,
      currency: prepared.ledgerHead.currency,
      memo: "Exact frozen-schedule paper buy fees",
    }]),
    {
      postingId: `${prepared.settlementId}:broker:cash`,
      accountId: "asset.cash",
      accountKind: "ASSET" as const,
      side: "CREDIT" as const,
      amount: cashRequired,
      currency: prepared.ledgerHead.currency,
      memo: "Paper buy cash outflow",
    },
  ];
  return createLedgerTransaction({
    transactionId: `${prepared.settlementId}:broker`,
    idempotencyKey: `${prepared.settlementId}:broker`,
    sourceEventId: prepared.execution.executionId,
    eventTime: prepared.settledAt,
    effectiveDate: prepared.execution.tradeDate,
    description: `Settle paper buy ${prepared.order.orderId}`,
    postings,
  });
}

function createSellLedgerTransaction(
  prepared: PreparedSettlement,
  allocatedPurchasePrice: DecimalString,
  netSaleCash: DecimalString,
): LedgerTransaction {
  if (compareDecimals(allocatedPurchasePrice, "0") === 0) {
    throw new RangeError("A sold v1 position must have positive gross purchase cost");
  }
  const gainBeforeSellFees = subtractDecimals(
    prepared.fee.grossNotional,
    allocatedPurchasePrice,
  );
  const postings = [
    ...(compareDecimals(netSaleCash, "0") === 0 ? [] : [{
      postingId: `${prepared.settlementId}:broker:cash`,
      accountId: "asset.cash",
      accountKind: "ASSET" as const,
      side: "DEBIT" as const,
      amount: netSaleCash,
      currency: prepared.ledgerHead.currency,
      memo: "Paper sell net cash proceeds",
    }]),
    ...(compareDecimals(prepared.fee.total, "0") === 0 ? [] : [{
      postingId: `${prepared.settlementId}:broker:fee`,
      accountId: "expense.broker_fee",
      accountKind: "EXPENSE" as const,
      side: "DEBIT" as const,
      amount: prepared.fee.total,
      currency: prepared.ledgerHead.currency,
      memo: "Exact frozen-schedule paper sell fees",
    }]),
    {
      postingId: `${prepared.settlementId}:broker:position`,
      accountId: "securities.inventory",
      accountKind: "ASSET" as const,
      side: "CREDIT" as const,
      amount: allocatedPurchasePrice,
      currency: prepared.ledgerHead.currency,
      instrumentId: prepared.order.instrumentId,
      quantity: prepared.execution.filledQuantity,
      memo: "Remove FIFO gross position cost",
    },
    ...(compareDecimals(gainBeforeSellFees, "0") > 0 ? [{
      postingId: `${prepared.settlementId}:broker:gain`,
      accountId: "income.realized_gain",
      accountKind: "INCOME" as const,
      side: "CREDIT" as const,
      amount: gainBeforeSellFees,
      currency: prepared.ledgerHead.currency,
      memo: "Paper realized gain before sell fees",
    }] : compareDecimals(gainBeforeSellFees, "0") < 0 ? [{
      postingId: `${prepared.settlementId}:broker:loss`,
      accountId: "expense.realized_loss",
      accountKind: "EXPENSE" as const,
      side: "DEBIT" as const,
      amount: subtractDecimals("0", gainBeforeSellFees),
      currency: prepared.ledgerHead.currency,
      memo: "Paper realized loss before sell fees",
    }] : []),
  ];
  return createLedgerTransaction({
    transactionId: `${prepared.settlementId}:broker`,
    idempotencyKey: `${prepared.settlementId}:broker`,
    sourceEventId: prepared.execution.executionId,
    eventTime: prepared.settledAt,
    effectiveDate: prepared.execution.tradeDate,
    description: `Settle paper sell ${prepared.order.orderId}`,
    postings,
  });
}

function createTaxLedgerTransactions(
  prepared: PreparedSettlement,
  taxCny: DecimalString,
): readonly LedgerTransaction[] {
  if (compareDecimals(taxCny, "0") === 0) return [];
  return [createLedgerTransaction({
    transactionId: `${prepared.settlementId}:tax`,
    idempotencyKey: `${prepared.settlementId}:tax`,
    sourceEventId: prepared.execution.executionId,
    eventTime: prepared.settledAt,
    effectiveDate: prepared.execution.tradeDate,
    description: `Accrue CNY shadow tax for ${prepared.order.orderId}`,
    postings: [
      {
        postingId: `${prepared.settlementId}:tax:expense`,
        accountId: "expense.china_capital_gains_tax",
        accountKind: "EXPENSE",
        side: "DEBIT",
        amount: taxCny,
        currency: "CNY",
        memo: "China capital-gains shadow tax in CNY",
      },
      {
        postingId: `${prepared.settlementId}:tax:liability`,
        accountId: "liability.china_tax_accrual",
        accountKind: "LIABILITY",
        side: "CREDIT",
        amount: taxCny,
        currency: "CNY",
        memo: "Unpaid China capital-gains shadow-tax accrual",
      },
    ],
  })];
}

function zeroFeeComponents(): FutuFeeComponents {
  return Object.freeze({
    commission: nonNegativeDecimal("0"),
    platform: nonNegativeDecimal("0"),
    settlement: nonNegativeDecimal("0"),
    secRegulatory: nonNegativeDecimal("0"),
    finraTaf: nonNegativeDecimal("0"),
    cat: nonNegativeDecimal("0"),
  });
}

function balanceTransitionFor(
  head: NormalizedPaperSettlementLedgerHead,
  after: {
    readonly cash: DecimalString;
    readonly buyingPower: DecimalString;
    readonly taxReserve: DecimalString;
    readonly quantity: string;
    readonly grossCost: DecimalString;
  },
): SettlementBalanceTransition {
  for (const [field, value] of [
    ["cash", after.cash],
    ["buyingPower", after.buyingPower],
    ["taxReserve", after.taxReserve],
    ["grossCost", after.grossCost],
  ] as const) {
    if (compareDecimals(value, "0") < 0) {
      throw new RangeError(`Settlement would create a negative ${field} asset or fence`);
    }
  }
  requireInteger(after.quantity, "post-settlement position quantity");
  return Object.freeze({
    cashAssetBalanceBefore: head.cashAssetBalance,
    cashAssetBalanceAfter: after.cash,
    buyingPowerBefore: head.currentBuyingPower,
    buyingPowerAfter: after.buyingPower,
    taxReserveBefore: head.taxReserveBalance,
    taxReserveAfter: after.taxReserve,
    positionQuantityBefore: head.positionQuantity,
    positionQuantityAfter: after.quantity,
    positionGrossCostBefore: head.positionGrossCostAssetBalance,
    positionGrossCostAfter: after.grossCost,
  });
}

function requireIdentity(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
}

function requireExactObjectKeys(
  value: object,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${field} must have its exact execution-model-specific shape`);
  }
}

function requireInteger(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative integer string`);
  }
  return BigInt(value);
}

function requirePositiveInteger(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical positive integer string`);
  }
  return BigInt(value);
}

function requireNonNegativeDecimal(value: DecimalInput, field: string): DecimalString {
  const normalized = normalizeDecimal(value);
  if (compareDecimals(normalized, "0") < 0) {
    throw new RangeError(`${field} must be non-negative`);
  }
  return normalized;
}

function requirePositiveDecimal(value: DecimalInput, field: string): DecimalString {
  const normalized = requireNonNegativeDecimal(value, field);
  if (normalized === "0") throw new RangeError(`${field} must be positive`);
  return normalized;
}

function requireSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
}

function requireIsoTimestamp(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a canonical ISO UTC timestamp`);
  }
}

function requireCalendarDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a real calendar date`);
  }
}

function sequenceValue(value: unknown, field: string): SequenceString {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a canonical sequence string`);
  }
  try {
    return sequence(value);
  } catch {
    throw new TypeError(`${field} must be a canonical sequence string`);
  }
}

function compareSequence(left: SequenceString, right: SequenceString): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function freezeCanonical<T>(value: unknown): T {
  const parsed = JSON.parse(canonicalFinancialJson(value)) as T;
  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
