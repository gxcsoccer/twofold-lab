import {
  canonicalFutuFeeScheduleTerms,
  calculateFutuOrderFees,
  calculateMaxAffordableFutuBuyFill,
  parseCanonicalFutuFeeScheduleTerms,
  resolveFutuFeeSchedule,
  type FutuFeeComponents,
  type FutuFeeSchedule,
} from "./futu-fees.js";
import {
  compareDecimals,
  divideDecimals,
  maxDecimal,
  multiplyDecimals,
  normalizeDecimal,
  subtractDecimals,
  sumDecimals,
  type DecimalInput,
} from "./fixed-decimal.js";
import {
  compareSequences,
  decimal,
  nextSequence,
  nonNegativeDecimal,
  sequence,
  type DecimalString,
} from "./decimal.js";
import {
  calculateFifoDisposition,
  lockShadowTaxReserve,
  STRICT_SHADOW_TAX_RULESET_ID,
  type FifoDispositionResult,
  type ShadowTaxLot,
} from "./shadow-tax.js";
import { canonicalFinancialJson } from "./canonical-json.js";

export interface PortfolioTargetWeight {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly weightBps: string;
}

export type MarketPriceKind = "OFFICIAL_CLOSE" | "OFFICIAL_OPEN";

export interface MarketPriceEvidence {
  readonly value: DecimalInput;
  readonly kind: MarketPriceKind;
  readonly sessionDate: string;
  readonly visibleAt: string;
  readonly snapshotId: string;
  readonly factId: string;
}

export interface FrozenMarketPriceEvidence {
  readonly value: DecimalString;
  readonly kind: MarketPriceKind;
  readonly sessionDate: string;
  readonly visibleAt: string;
  readonly snapshotId: string;
  readonly factId: string;
}

export interface BuyingPowerEvidence {
  readonly value: DecimalInput;
  readonly snapshotId: string;
  readonly visibleAt: string;
}

export interface FrozenBuyingPowerEvidence {
  readonly value: DecimalString;
  readonly snapshotId: string;
  readonly visibleAt: string;
}

export type OrderExecutionModel = "SIMULATED_SLIPPAGE" | "BROKER_ACTUAL";

export interface MarkedPosition {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly mark: MarketPriceEvidence;
}

export interface FrozenSellOrder {
  readonly orderId: string;
  readonly decisionId: string;
  readonly stage: "S1";
  readonly side: "SELL";
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly referencePrice: DecimalString;
  readonly referencePriceEvidence: FrozenMarketPriceEvidence;
  readonly plannedAt: string;
  readonly plannedTradeDate: string;
  readonly feeScheduleId: string;
  readonly feeCurrency: string;
  readonly feeScheduleTerms: string;
  readonly targetWeightBps: string;
}

export interface FrozenBuyOrder {
  readonly orderId: string;
  readonly decisionId: string;
  readonly stage: "S2";
  readonly side: "BUY";
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly referencePrice: DecimalString;
  readonly referencePriceEvidence: FrozenMarketPriceEvidence;
  readonly plannedAt: string;
  readonly plannedTradeDate: string;
  readonly targetWeightBps: string;
  readonly targetAmount: DecimalString;
  readonly currentMarketValue: DecimalString;
  readonly targetGap: DecimalString;
  readonly priority: string;
  readonly estimatedGrossNotional: string;
  readonly feeScheduleId: string;
  readonly feeCurrency: string;
  readonly feeScheduleTerms: string;
  readonly estimatedFees: FutuFeeComponents;
  readonly estimatedTotalFees: string;
  readonly reservedBuyingPower: string;
}

export interface SellOrderPlan {
  readonly schema: "twofold.frozen_order_plan/v1";
  readonly decisionId: string;
  readonly stage: "S1";
  readonly executionModel: OrderExecutionModel;
  readonly slippageBps: string;
  readonly fillPriceScale: string;
  readonly taxRulesetId: typeof STRICT_SHADOW_TAX_RULESET_ID;
  readonly taxAllocationScale: string;
  readonly orders: readonly FrozenSellOrder[];
  readonly planFingerprint: string;
}

export interface BuyOrderPlan {
  readonly schema: "twofold.frozen_order_plan/v1";
  readonly decisionId: string;
  readonly stage: "S2";
  readonly executionModel: OrderExecutionModel;
  readonly slippageBps: string;
  readonly fillPriceScale: string;
  readonly buyingPowerEvidence: FrozenBuyingPowerEvidence;
  readonly orders: readonly FrozenBuyOrder[];
  readonly planFingerprint: string;
  readonly initialBuyingPower: DecimalString;
  readonly reservedBuyingPower: DecimalString;
  readonly remainingUnreservedBuyingPower: DecimalString;
}

export interface ExecutedBuyOrder {
  readonly fillId: string;
  readonly orderId: string;
  readonly decisionId: string;
  readonly instrumentId: string;
  readonly symbol: string;
  readonly tradeDate: string;
  readonly executedAt: string;
  readonly buyingPowerSnapshotId: string;
  /** The immutable S1 order quantity. */
  readonly orderQuantity: string;
  readonly fillQuantity: string;
  readonly canceledQuantity: string;
  readonly officialOpenPrice: DecimalString;
  readonly officialOpenEvidence: FrozenMarketPriceEvidence;
  readonly fillPrice: DecimalString;
  readonly grossNotional: string;
  readonly fees: FutuFeeComponents;
  readonly totalFees: string;
  readonly totalCashRequired: string;
  readonly feeScheduleId: string;
  readonly feeCurrency: string;
  /** One filled buy order creates exactly one immutable FIFO-origin lot. */
  readonly createdLot: ShadowTaxLot | null;
  readonly status: "FILLED" | "PARTIALLY_FILLED_CASH_LIMIT" | "CANCELED_CASH_LIMIT";
}

export interface BuyExecutionResult {
  readonly fills: readonly ExecutedBuyOrder[];
  readonly createdLots: readonly ShadowTaxLot[];
  readonly buyingPowerEvidence: FrozenBuyingPowerEvidence;
  readonly initialBuyingPower: DecimalString;
  readonly remainingBuyingPower: DecimalString;
}

export interface ExecutedSellOrder {
  readonly fillId: string;
  readonly orderId: string;
  readonly decisionId: string;
  readonly instrumentId: string;
  readonly symbol: string;
  readonly tradeDate: string;
  readonly executedAt: string;
  readonly orderQuantity: string;
  readonly fillQuantity: string;
  readonly officialOpenPrice: DecimalString;
  readonly officialOpenEvidence: FrozenMarketPriceEvidence;
  readonly fillPrice: DecimalString;
  readonly grossProceeds: string;
  readonly fees: FutuFeeComponents;
  readonly totalFees: string;
  readonly feeScheduleId: string;
  readonly feeCurrency: string;
  readonly netCashProceeds: DecimalString;
  readonly disposition: FifoDispositionResult;
  readonly status: "FILLED";
}

export interface SellExecutionResult {
  readonly fills: readonly ExecutedSellOrder[];
  readonly remainingLots: readonly ShadowTaxLot[];
  readonly initialGrossBuyingCash: DecimalString;
  readonly grossBuyingCashAfterSells: DecimalString;
  readonly grossSaleProceeds: DecimalString;
  readonly totalSellFees: DecimalString;
  readonly netSaleCashProceeds: DecimalString;
  readonly newlyLockedTax: DecimalString;
  readonly taxReserveAfterLock: DecimalString;
  readonly preFeeBuyingPowerAfterTaxLock: DecimalString;
}

const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

function requireIdentity(value: string, field: string): void {
  if (value.trim() === "") throw new TypeError(`${field} must be non-empty`);
}

function requireInteger(value: string, field: string, positive = false): bigint {
  if (!INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative integer string`);
  }
  const parsed = BigInt(value);
  if (positive && parsed === 0n) throw new RangeError(`${field} must be positive`);
  return parsed;
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

function requireCalendarDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a valid calendar date`);
  }
}

function requireIsoTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(
      `${field} must be a canonical ISO UTC timestamp with milliseconds`,
    );
  }
}

function validatePriceEvidence(
  evidence: MarketPriceEvidence,
  expectedKind: MarketPriceKind,
  expectedSessionDate: string,
  cutoffAt: string,
  field: string,
): FrozenMarketPriceEvidence {
  requireCalendarDate(expectedSessionDate, `${field}.expectedSessionDate`);
  requireIsoTimestamp(cutoffAt, `${field}.cutoffAt`);
  requireCalendarDate(evidence.sessionDate, `${field}.sessionDate`);
  requireIsoTimestamp(evidence.visibleAt, `${field}.visibleAt`);
  requireIdentity(evidence.snapshotId, `${field}.snapshotId`);
  requireIdentity(evidence.factId, `${field}.factId`);
  if (evidence.kind !== expectedKind) {
    throw new TypeError(`${field}.kind must be ${expectedKind}`);
  }
  if (evidence.sessionDate !== expectedSessionDate) {
    throw new TypeError(
      `${field}.sessionDate must equal ${expectedSessionDate}; received ${evidence.sessionDate}`,
    );
  }
  if (
    expectedKind === "OFFICIAL_OPEN"
    && evidence.visibleAt.slice(0, 10) !== expectedSessionDate
  ) {
    throw new TypeError(
      `${field}.visibleAt must fall on its official-open session date`,
    );
  }
  if (
    expectedKind === "OFFICIAL_CLOSE"
    && evidence.visibleAt.slice(0, 10) < expectedSessionDate
  ) {
    throw new TypeError(
      `${field}.visibleAt cannot precede its official-close session date`,
    );
  }
  if (Date.parse(evidence.visibleAt) > Date.parse(cutoffAt)) {
    throw new RangeError(`${field} was not visible at cutoff ${cutoffAt}`);
  }
  return Object.freeze({
    value: requirePositive(evidence.value, `${field}.value`),
    kind: evidence.kind,
    sessionDate: evidence.sessionDate,
    visibleAt: evidence.visibleAt,
    snapshotId: evidence.snapshotId,
    factId: evidence.factId,
  });
}

function canonicalOrderPlanFingerprint(
  plan: Readonly<Record<string, unknown>>,
): string {
  // The complete canonical JSON is deliberately retained instead of a weak
  // in-process hash. Persistence must store this value immutably (or store a
  // cryptographic digest of it) and execution always recomputes it.
  return canonicalFinancialJson(plan);
}

function requireScale(value: number, field: string): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 12) {
    throw new RangeError(`${field} must be an integer from 0 through 12`);
  }
  return value.toString();
}

function validatePlanRules(
  plan: SellOrderPlan | BuyOrderPlan,
  expectedStage: "S1" | "S2",
): void {
  if (plan.stage !== "S1" && plan.stage !== "S2") {
    throw new TypeError("Frozen order plan stage must be S1 or S2");
  }
  if (plan.schema !== "twofold.frozen_order_plan/v1") {
    throw new TypeError("Unsupported frozen order plan schema");
  }
  if (plan.stage !== expectedStage) {
    throw new TypeError(`Frozen order plan stage must be ${expectedStage}`);
  }
  if (
    plan.executionModel !== "SIMULATED_SLIPPAGE"
    && plan.executionModel !== "BROKER_ACTUAL"
  ) {
    throw new TypeError("Unsupported execution model");
  }
  const slippageBps = requireInteger(plan.slippageBps, "plan.slippageBps");
  if (slippageBps > 10_000n) {
    throw new RangeError("plan.slippageBps cannot exceed 10000");
  }
  if (plan.executionModel === "BROKER_ACTUAL" && slippageBps !== 0n) {
    throw new RangeError("BROKER_ACTUAL plans must freeze slippageBps at 0");
  }
  const fillPriceScale = requireInteger(
    plan.fillPriceScale,
    "plan.fillPriceScale",
  );
  if (fillPriceScale > 12n) {
    throw new RangeError("plan.fillPriceScale cannot exceed 12");
  }
  if (expectedStage === "S1") {
    const sellPlan = plan as SellOrderPlan;
    if (sellPlan.taxRulesetId !== STRICT_SHADOW_TAX_RULESET_ID) {
      throw new TypeError("Unsupported frozen tax ruleset");
    }
    const allocationScale = requireInteger(
      sellPlan.taxAllocationScale,
      "plan.taxAllocationScale",
    );
    if (allocationScale > 100n) {
      throw new RangeError("plan.taxAllocationScale cannot exceed 100");
    }
  } else {
    let previousPriority = 0n;
    for (const [index, order] of plan.orders.entries()) {
      const priority = requireInteger(
        (order as FrozenBuyOrder).priority,
        `plan.orders[${index}].priority`,
        true,
      );
      if (priority <= previousPriority) {
        throw new RangeError(
          "S2 order priorities must strictly increase with frozen array order",
        );
      }
      previousPriority = priority;
    }
  }
}

/** Recomputes the complete canonical engine payload before persistence/execution. */
export function assertFrozenOrderPlanIntegrity(
  plan: SellOrderPlan | BuyOrderPlan,
  expectedStage: "S1" | "S2" = plan.stage,
): void {
  requireIdentity(plan.decisionId, "plan.decisionId");
  requireIdentity(plan.planFingerprint, "plan.planFingerprint");
  validatePlanRules(plan, expectedStage);
  const { planFingerprint: _claimedFingerprint, ...payload } = plan;
  if (plan.planFingerprint !== canonicalOrderPlanFingerprint(payload)) {
    throw new TypeError(`${expectedStage} frozen order plan fingerprint mismatch`);
  }
}

function validatePlanningWindow(
  referenceSessionDate: string,
  plannedAt: string,
  plannedTradeDate: string,
  field: string,
): void {
  requireCalendarDate(referenceSessionDate, `${field}.referenceSessionDate`);
  requireIsoTimestamp(plannedAt, `${field}.plannedAt`);
  requireCalendarDate(plannedTradeDate, `${field}.plannedTradeDate`);
  if (plannedTradeDate <= referenceSessionDate) {
    throw new RangeError(
      `${field}.plannedTradeDate must follow the reference session date`,
    );
  }
  if (plannedAt.slice(0, 10) >= plannedTradeDate) {
    throw new RangeError(
      `${field}.plannedAt must precede the planned trade date`,
    );
  }
}

function validateFrozenOrderReference(
  order: FrozenSellOrder | FrozenBuyOrder,
  field: string,
): FrozenMarketPriceEvidence {
  validatePlanningWindow(
    order.referencePriceEvidence.sessionDate,
    order.plannedAt,
    order.plannedTradeDate,
    field,
  );
  const evidence = validatePriceEvidence(
    order.referencePriceEvidence,
    "OFFICIAL_CLOSE",
    order.referencePriceEvidence.sessionDate,
    order.plannedAt,
    `${field}.referencePriceEvidence`,
  );
  if (evidence.value !== normalizeDecimal(order.referencePrice)) {
    throw new TypeError(`${field}.referencePrice must match its frozen evidence`);
  }
  return evidence;
}

function validateTargets(
  targets: readonly PortfolioTargetWeight[],
  cashWeightBps: string,
): ReadonlyMap<string, PortfolioTargetWeight> {
  const cash = requireInteger(cashWeightBps, "cashWeightBps");
  if (cash > 10_000n) throw new RangeError("cashWeightBps cannot exceed 10000");

  const byInstrument = new Map<string, PortfolioTargetWeight>();
  let total = cash;
  for (const [index, target] of targets.entries()) {
    requireIdentity(target.instrumentId, `targets[${index}].instrumentId`);
    requireIdentity(target.symbol, `targets[${index}].symbol`);
    if (byInstrument.has(target.instrumentId)) {
      throw new TypeError(`Duplicate target instrumentId: ${target.instrumentId}`);
    }
    const weight = requireInteger(target.weightBps, `targets[${index}].weightBps`);
    if (weight > 10_000n) throw new RangeError("target weight cannot exceed 10000 bps");
    total += weight;
    byInstrument.set(target.instrumentId, Object.freeze({ ...target }));
  }
  if (total !== 10_000n) {
    throw new RangeError(`portfolio targets must total 10000 bps; received ${total}`);
  }
  return byInstrument;
}

function validatePositions(
  positions: readonly MarkedPosition[],
  context: {
    readonly kind: MarketPriceKind;
    readonly sessionDate: string;
    readonly cutoffAt: string;
  },
): ReadonlyMap<string, Readonly<MarkedPosition & {
  markPrice: DecimalString;
  markEvidence: FrozenMarketPriceEvidence;
}>> {
  const byInstrument = new Map<
    string,
    Readonly<MarkedPosition & {
      markPrice: DecimalString;
      markEvidence: FrozenMarketPriceEvidence;
    }>
  >();
  for (const [index, position] of positions.entries()) {
    requireIdentity(position.instrumentId, `positions[${index}].instrumentId`);
    requireIdentity(position.symbol, `positions[${index}].symbol`);
    requireInteger(position.quantity, `positions[${index}].quantity`);
    if (byInstrument.has(position.instrumentId)) {
      throw new TypeError(`Duplicate position instrumentId: ${position.instrumentId}`);
    }
    const markEvidence = validatePriceEvidence(
      position.mark,
      context.kind,
      context.sessionDate,
      context.cutoffAt,
      `positions[${index}].mark`,
    );
    byInstrument.set(position.instrumentId, Object.freeze({
      ...position,
      markPrice: markEvidence.value,
      markEvidence,
    }));
  }
  return byInstrument;
}

function targetAmount(nav: DecimalInput, weightBps: string): DecimalString {
  const weighted = multiplyDecimals(nav, weightBps);
  // Basis points divide by an exact power of ten. Preserve every input digit
  // and shift four places instead of rounding to an arbitrary money scale;
  // otherwise a sub-share target can cross an integer order boundary.
  const inputScale = weighted.includes(".")
    ? weighted.length - weighted.indexOf(".") - 1
    : 0;
  return divideDecimals(weighted, "10000", inputScale + 4, "DOWN");
}

function floorShares(amount: DecimalInput, price: DecimalInput): string {
  const quantity = divideDecimals(amount, price, 0, "DOWN");
  if (!INTEGER_PATTERN.test(quantity)) {
    throw new RangeError(`Calculated share quantity is not non-negative: ${quantity}`);
  }
  return quantity;
}

/** D-close sell sizing. Future S1 prices never enter this calculation. */
export function createS1SellOrderPlan(input: {
  readonly decisionId: string;
  readonly decisionSessionDate: string;
  /** Latest timestamp whose facts may influence D-close sizing. */
  readonly decisionCutoffAt: string;
  /** Actual plan-freeze time, after the target submission was accepted. */
  readonly plannedAt: string;
  readonly s1TradeDate: string;
  readonly decisionCloseTaxReservedNav: DecimalInput;
  readonly positions: readonly MarkedPosition[];
  readonly targets: readonly PortfolioTargetWeight[];
  readonly cashWeightBps: string;
  readonly slippageBps: string;
  readonly executionModel?: OrderExecutionModel;
  readonly fillPriceScale: number;
  readonly taxAllocationScale: number;
  readonly feeSchedules?: readonly FutuFeeSchedule[];
}): SellOrderPlan {
  requireIdentity(input.decisionId, "decisionId");
  const slippageBps = requireInteger(input.slippageBps, "slippageBps").toString();
  if (BigInt(slippageBps) > 10_000n) {
    throw new RangeError("slippageBps cannot exceed 10000");
  }
  const executionModel = input.executionModel ?? "SIMULATED_SLIPPAGE";
  if (executionModel === "BROKER_ACTUAL" && slippageBps !== "0") {
    throw new RangeError("BROKER_ACTUAL plans must freeze slippageBps at 0");
  }
  const fillPriceScale = requireScale(input.fillPriceScale, "fillPriceScale");
  const taxAllocationScale = requireScale(
    input.taxAllocationScale,
    "taxAllocationScale",
  );
  validatePlanningWindow(
    input.decisionSessionDate,
    input.plannedAt,
    input.s1TradeDate,
    "S1 plan",
  );
  requireIsoTimestamp(input.decisionCutoffAt, "S1 plan.decisionCutoffAt");
  if (Date.parse(input.decisionCutoffAt) > Date.parse(input.plannedAt)) {
    throw new RangeError("S1 plan decisionCutoffAt cannot postdate plannedAt");
  }
  const feeSchedule = resolveFutuFeeSchedule(
    input.s1TradeDate,
    input.feeSchedules,
  );
  const nav = requireNonNegative(
    input.decisionCloseTaxReservedNav,
    "decisionCloseTaxReservedNav",
  );
  const targets = validateTargets(input.targets, input.cashWeightBps);
  const positions = validatePositions(input.positions, {
    kind: "OFFICIAL_CLOSE",
    sessionDate: input.decisionSessionDate,
    cutoffAt: input.decisionCutoffAt,
  });
  const orders: FrozenSellOrder[] = [];

  for (const position of [...positions.values()].sort((left, right) =>
    left.instrumentId.localeCompare(right.instrumentId)
  )) {
    const target = targets.get(position.instrumentId);
    const weightBps = target?.weightBps ?? "0";
    const currentMarketValue = multiplyDecimals(position.quantity, position.markPrice);
    const desiredAmount = targetAmount(nav, weightBps);
    const excess = maxDecimal(subtractDecimals(currentMarketValue, desiredAmount), "0");
    let quantity = floorShares(excess, position.markPrice);
    const heldQuantity = BigInt(position.quantity);
    if (BigInt(quantity) > heldQuantity) quantity = position.quantity;
    if (quantity === "0") continue;

    orders.push(Object.freeze({
      orderId: `${input.decisionId}:S1:SELL:${position.instrumentId}`,
      decisionId: input.decisionId,
      stage: "S1",
      side: "SELL",
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      quantity,
      referencePrice: position.markPrice,
      referencePriceEvidence: position.markEvidence,
      plannedAt: input.plannedAt,
      plannedTradeDate: input.s1TradeDate,
      feeScheduleId: feeSchedule.feeScheduleId,
      feeCurrency: feeSchedule.currency,
      feeScheduleTerms: canonicalFutuFeeScheduleTerms(feeSchedule),
      targetWeightBps: weightBps,
    }));
  }

  const frozenOrders = Object.freeze(orders);
  const fingerprintPayload = Object.freeze({
    schema: "twofold.frozen_order_plan/v1" as const,
    decisionId: input.decisionId,
    stage: "S1" as const,
    executionModel,
    slippageBps,
    fillPriceScale,
    taxRulesetId: STRICT_SHADOW_TAX_RULESET_ID,
    taxAllocationScale,
    orders: frozenOrders,
  });
  return Object.freeze({
    ...fingerprintPayload,
    planFingerprint: canonicalOrderPlanFingerprint(fingerprintPayload),
  });
}

/**
 * S1-close buy sizing. Orders are prioritized by target gap, then stable
 * instrument ID, and reserve estimated stock value plus fees exactly once.
 */
export function createS2BuyOrderPlan(input: {
  readonly decisionId: string;
  readonly s1SessionDate: string;
  readonly plannedAt: string;
  readonly s2TradeDate: string;
  readonly preOrderTaxReservedNav: DecimalInput;
  readonly buyingPowerEvidence: BuyingPowerEvidence;
  readonly positions: readonly MarkedPosition[];
  readonly targets: readonly PortfolioTargetWeight[];
  readonly cashWeightBps: string;
  readonly slippageBps: string;
  readonly executionModel?: OrderExecutionModel;
  readonly fillPriceScale: number;
  readonly feeSchedules?: readonly FutuFeeSchedule[];
}): BuyOrderPlan {
  requireIdentity(input.decisionId, "decisionId");
  const slippageBps = requireInteger(input.slippageBps, "slippageBps").toString();
  if (BigInt(slippageBps) > 10_000n) {
    throw new RangeError("slippageBps cannot exceed 10000");
  }
  const executionModel = input.executionModel ?? "SIMULATED_SLIPPAGE";
  if (executionModel === "BROKER_ACTUAL" && slippageBps !== "0") {
    throw new RangeError("BROKER_ACTUAL plans must freeze slippageBps at 0");
  }
  const fillPriceScale = requireScale(input.fillPriceScale, "fillPriceScale");
  validatePlanningWindow(
    input.s1SessionDate,
    input.plannedAt,
    input.s2TradeDate,
    "S2 plan",
  );
  // Resolve even for an all-cash or zero-gap plan so a ruleset gap cannot be
  // hidden merely because this particular plan produces no orders.
  resolveFutuFeeSchedule(input.s2TradeDate, input.feeSchedules);
  const nav = requireNonNegative(input.preOrderTaxReservedNav, "preOrderTaxReservedNav");
  requireIdentity(input.buyingPowerEvidence.snapshotId, "buyingPowerEvidence.snapshotId");
  requireIsoTimestamp(input.buyingPowerEvidence.visibleAt, "buyingPowerEvidence.visibleAt");
  if (input.buyingPowerEvidence.visibleAt.slice(0, 10) !== input.s1SessionDate) {
    throw new TypeError(
      "buyingPowerEvidence.visibleAt must fall on the S1 planning session",
    );
  }
  if (Date.parse(input.buyingPowerEvidence.visibleAt) > Date.parse(input.plannedAt)) {
    throw new RangeError("buyingPowerEvidence was not visible at the planning cutoff");
  }
  const initialBuyingPower = requireNonNegative(
    input.buyingPowerEvidence.value,
    "buyingPowerEvidence.value",
  );
  const buyingPowerEvidence = Object.freeze({
    value: initialBuyingPower,
    snapshotId: input.buyingPowerEvidence.snapshotId,
    visibleAt: input.buyingPowerEvidence.visibleAt,
  });
  const targets = validateTargets(input.targets, input.cashWeightBps);
  const positions = validatePositions(input.positions, {
    kind: "OFFICIAL_CLOSE",
    sessionDate: input.s1SessionDate,
    cutoffAt: input.plannedAt,
  });

  const candidates = [...targets.values()].flatMap((target) => {
    if (target.weightBps === "0") return [];
    const position = positions.get(target.instrumentId);
    if (position === undefined) {
      throw new TypeError(
        `S1 close mark is required for target instrument ${target.instrumentId}`,
      );
    }
    const desiredAmount = targetAmount(nav, target.weightBps);
    const currentMarketValue = multiplyDecimals(position.quantity, position.markPrice);
    const gap = maxDecimal(subtractDecimals(desiredAmount, currentMarketValue), "0");
    const desiredQuantity = floorShares(gap, position.markPrice);
    if (desiredQuantity === "0") return [];
    return [{ target, position, desiredAmount, currentMarketValue, gap, desiredQuantity }];
  }).sort((left, right) => {
    const gapOrder = compareDecimals(right.gap, left.gap);
    return gapOrder === 0
      ? left.target.instrumentId.localeCompare(right.target.instrumentId)
      : gapOrder;
  });

  let remainingBuyingPower = initialBuyingPower;
  let reservedBuyingPower = decimal("0");
  const orders: FrozenBuyOrder[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const affordable = calculateMaxAffordableFutuBuyFill({
      tradeDate: input.s2TradeDate,
      requestedQuantity: candidate.desiredQuantity,
      price: candidate.position.markPrice,
      buyingPower: remainingBuyingPower,
      ...(input.feeSchedules === undefined ? {} : { schedules: input.feeSchedules }),
    });
    if (affordable.affordableQuantity === "0") continue;

    remainingBuyingPower = requireNonNegative(
      subtractDecimals(remainingBuyingPower, affordable.totalCashRequired),
      "remaining unreserved buying power",
    );
    reservedBuyingPower = sumDecimals([
      reservedBuyingPower,
      affordable.totalCashRequired,
    ]);
    orders.push(Object.freeze({
      orderId: `${input.decisionId}:S2:BUY:${candidate.target.instrumentId}`,
      decisionId: input.decisionId,
      stage: "S2",
      side: "BUY",
      instrumentId: candidate.target.instrumentId,
      symbol: candidate.target.symbol,
      quantity: affordable.affordableQuantity,
      referencePrice: candidate.position.markPrice,
      referencePriceEvidence: candidate.position.markEvidence,
      plannedAt: input.plannedAt,
      plannedTradeDate: input.s2TradeDate,
      targetWeightBps: candidate.target.weightBps,
      targetAmount: candidate.desiredAmount,
      currentMarketValue: candidate.currentMarketValue,
      targetGap: candidate.gap,
      priority: (index + 1).toString(),
      estimatedGrossNotional: affordable.grossNotional,
      feeScheduleId: affordable.feeScheduleId,
      feeCurrency: affordable.currency,
      feeScheduleTerms: canonicalFutuFeeScheduleTerms(
        resolveFutuFeeSchedule(input.s2TradeDate, input.feeSchedules),
      ),
      estimatedFees: affordable.fees,
      estimatedTotalFees: affordable.totalFees,
      reservedBuyingPower: affordable.totalCashRequired,
    }));
  }

  const frozenOrders = Object.freeze(orders);
  const fingerprintPayload = Object.freeze({
    schema: "twofold.frozen_order_plan/v1" as const,
    decisionId: input.decisionId,
    stage: "S2" as const,
    executionModel,
    slippageBps,
    fillPriceScale,
    buyingPowerEvidence,
    orders: frozenOrders,
    initialBuyingPower,
    reservedBuyingPower,
    remainingUnreservedBuyingPower: remainingBuyingPower,
  });
  return Object.freeze({
    ...fingerprintPayload,
    planFingerprint: canonicalOrderPlanFingerprint(fingerprintPayload),
  });
}

export function applySimulatedSlippage(input: {
  readonly side: "BUY" | "SELL";
  readonly officialOpenPrice: DecimalInput;
  readonly slippageBps: string;
  readonly priceScale?: number;
}): DecimalString {
  const open = requirePositive(input.officialOpenPrice, "officialOpenPrice");
  const bps = requireInteger(input.slippageBps, "slippageBps");
  if (bps > 10_000n) throw new RangeError("slippageBps cannot exceed 10000");
  const factor = input.side === "BUY" ? 10_000n + bps : 10_000n - bps;
  return divideDecimals(
    multiplyDecimals(open, factor.toString()),
    "10000",
    input.priceScale ?? 8,
    "HALF_UP",
  );
}

/**
 * Pure S1 simulation: aggregate every frozen order into one taxable
 * disposition, consume FIFO lots, and lock the resulting shadow tax before S2.
 * Its account-state inputs are not a trusted settlement boundary. A persisted
 * fill must be recomputed atomically from the database ledger head.
 */
export function executeS1SellOrders(input: {
  readonly plan: SellOrderPlan;
  readonly tradeDate: string;
  readonly executedAt: string;
  readonly officialOpenPrices: Readonly<Record<string, MarketPriceEvidence | undefined>>;
  readonly availableLots: readonly ShadowTaxLot[];
  readonly sourceCountryByInstrument: Readonly<Record<string, string | undefined>>;
  readonly grossBuyingCashBeforeSells: DecimalInput;
  readonly existingTaxReserve: DecimalInput;
}): SellExecutionResult {
  const plan = input.plan;
  assertFrozenOrderPlanIntegrity(plan, "S1");
  if (plan.executionModel !== "SIMULATED_SLIPPAGE") {
    throw new TypeError("executeS1SellOrders only executes SIMULATED_SLIPPAGE plans");
  }
  requireCalendarDate(input.tradeDate, "tradeDate");
  requireIsoTimestamp(input.executedAt, "executedAt");
  if (input.executedAt.slice(0, 10) !== input.tradeDate) {
    throw new TypeError("executedAt must fall on tradeDate");
  }
  const initialGrossBuyingCash = requireNonNegative(
    input.grossBuyingCashBeforeSells,
    "grossBuyingCashBeforeSells",
  );
  const existingTaxReserve = requireNonNegative(
    input.existingTaxReserve,
    "existingTaxReserve",
  );
  const lotsByInstrument = new Map<string, ShadowTaxLot[]>();
  const seenLotIds = new Set<string>();
  const seenLotSequences = new Set<string>();
  for (const [index, lot] of input.availableLots.entries()) {
    requireIdentity(lot.lotId, `availableLots[${index}].lotId`);
    requireIdentity(lot.instrumentId, `availableLots[${index}].instrumentId`);
    if (seenLotIds.has(lot.lotId)) {
      throw new TypeError(`Duplicate available lot id: ${lot.lotId}`);
    }
    seenLotIds.add(lot.lotId);
    const acquisitionSequence = sequence(lot.acquisitionSequence);
    const sequenceKey = `${lot.instrumentId}\u0000${acquisitionSequence}`;
    if (seenLotSequences.has(sequenceKey)) {
      throw new TypeError(
        `Duplicate acquisition sequence ${acquisitionSequence} for ${lot.instrumentId}`,
      );
    }
    seenLotSequences.add(sequenceKey);
    const frozenLot = Object.freeze({
      ...lot,
      acquisitionSequence,
      quantity: nonNegativeDecimal(
        requireInteger(lot.quantity, `availableLots[${index}].quantity`, true).toString(),
      ),
      grossPurchasePrice: nonNegativeDecimal(
        requireNonNegative(
          lot.grossPurchasePrice,
          `availableLots[${index}].grossPurchasePrice`,
        ),
      ),
      buyFees: nonNegativeDecimal(
        requireNonNegative(lot.buyFees, `availableLots[${index}].buyFees`),
      ),
    });
    const lots = lotsByInstrument.get(frozenLot.instrumentId) ?? [];
    lots.push(frozenLot);
    lotsByInstrument.set(frozenLot.instrumentId, lots);
  }

  const seenOrders = new Set<string>();
  const fills: ExecutedSellOrder[] = [];
  let grossSaleProceeds = decimal("0");
  let totalSellFees = decimal("0");
  let netSaleCashProceeds = decimal("0");
  let newlyLockedTax = decimal("0");

  for (const order of [...plan.orders].sort((left, right) =>
    left.instrumentId.localeCompare(right.instrumentId)
  )) {
    requireIdentity(order.orderId, "order.orderId");
    if (seenOrders.has(order.orderId)) throw new TypeError(`Duplicate orderId: ${order.orderId}`);
    seenOrders.add(order.orderId);
    if (order.decisionId !== plan.decisionId) {
      throw new TypeError(`Order ${order.orderId} belongs to a different decision`);
    }
    if (order.stage !== "S1" || order.side !== "SELL") {
      throw new TypeError(`Order ${order.orderId} is not a frozen S1 sell order`);
    }
    if (order.plannedTradeDate !== input.tradeDate) {
      throw new TypeError(
        `Order ${order.orderId} was planned for ${order.plannedTradeDate}, not ${input.tradeDate}`,
      );
    }
    validateFrozenOrderReference(order, `orders.${order.orderId}`);
    if (Date.parse(order.plannedAt) > Date.parse(input.executedAt)) {
      throw new RangeError(`Order ${order.orderId} cannot execute before it was planned`);
    }
    const applicableFeeSchedule = parseCanonicalFutuFeeScheduleTerms(
      order.feeScheduleTerms,
    );
    if (
      order.feeScheduleId !== applicableFeeSchedule.feeScheduleId
      || order.feeCurrency !== applicableFeeSchedule.currency
    ) {
      throw new TypeError(`Order ${order.orderId} fee identity does not match its frozen terms`);
    }
    requireInteger(order.quantity, "order.quantity", true);
    const openEvidence = input.officialOpenPrices[order.instrumentId];
    if (openEvidence === undefined) {
      throw new TypeError(`Missing S1 official open price for ${order.instrumentId}`);
    }
    const officialOpenEvidence = validatePriceEvidence(
      openEvidence,
      "OFFICIAL_OPEN",
      input.tradeDate,
      input.executedAt,
      `officialOpenPrices.${order.instrumentId}`,
    );
    const officialOpenPrice = officialOpenEvidence.value;
    const fillPrice = applySimulatedSlippage({
      side: "SELL",
      officialOpenPrice,
      slippageBps: plan.slippageBps,
      priceScale: Number(plan.fillPriceScale),
    });
    const fee = calculateFutuOrderFees({
      tradeDate: input.tradeDate,
      side: "SELL",
      fills: [{ quantity: order.quantity, price: fillPrice }],
      schedules: [applicableFeeSchedule],
    });
    const grossProceeds = normalizeDecimal(fee.grossNotional);
    const netCashProceeds = subtractDecimals(grossProceeds, fee.total);
    if (compareDecimals(netCashProceeds, "0") < 0) {
      throw new RangeError(`Sell fees exceed gross proceeds for ${order.orderId}`);
    }
    const sourceCountry = input.sourceCountryByInstrument[order.instrumentId];
    if (sourceCountry === undefined) {
      throw new TypeError(`Missing issuer tax source country for ${order.instrumentId}`);
    }
    const disposition = calculateFifoDisposition({
      dispositionId: order.orderId,
      instrumentId: order.instrumentId,
      taxYear: input.tradeDate.slice(0, 4),
      sourceCountry,
      quantity: nonNegativeDecimal(order.quantity),
      grossProceeds: nonNegativeDecimal(grossProceeds),
      sellFees: fee.total,
      availableLots: lotsByInstrument.get(order.instrumentId) ?? [],
      allocationScale: Number(plan.taxAllocationScale),
    });
    lotsByInstrument.set(order.instrumentId, [...disposition.remainingLots]);

    grossSaleProceeds = sumDecimals([grossSaleProceeds, grossProceeds]);
    totalSellFees = sumDecimals([totalSellFees, fee.total]);
    netSaleCashProceeds = sumDecimals([netSaleCashProceeds, netCashProceeds]);
    newlyLockedTax = sumDecimals([
      newlyLockedTax,
      disposition.chinaCapitalGainsTax,
    ]);
    fills.push(Object.freeze({
      fillId: `${order.orderId}:fill:1`,
      orderId: order.orderId,
      decisionId: order.decisionId,
      instrumentId: order.instrumentId,
      symbol: order.symbol,
      tradeDate: input.tradeDate,
      executedAt: input.executedAt,
      orderQuantity: order.quantity,
      fillQuantity: order.quantity,
      officialOpenPrice,
      officialOpenEvidence,
      fillPrice,
      grossProceeds,
      feeScheduleId: fee.feeScheduleId,
      feeCurrency: fee.currency,
      fees: fee.components,
      totalFees: fee.total,
      netCashProceeds,
      disposition,
      status: "FILLED",
    }));
  }

  const grossBuyingCashAfterSells = sumDecimals([
    initialGrossBuyingCash,
    netSaleCashProceeds,
  ]);
  const lock = lockShadowTaxReserve({
    grossBuyingCash: nonNegativeDecimal(grossBuyingCashAfterSells),
    existingTaxReserve: nonNegativeDecimal(existingTaxReserve),
    newlyLockedTax: nonNegativeDecimal(newlyLockedTax),
  });

  return Object.freeze({
    fills: Object.freeze(fills),
    remainingLots: Object.freeze(
      [...lotsByInstrument.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([, lots]) => lots),
    ),
    initialGrossBuyingCash,
    grossBuyingCashAfterSells,
    grossSaleProceeds,
    totalSellFees,
    netSaleCashProceeds,
    newlyLockedTax,
    taxReserveAfterLock: lock.taxReserveAfterLock,
    preFeeBuyingPowerAfterTaxLock: lock.preFeeBuyingPowerAfterLock,
  });
}

/**
 * Pure S2 simulation in frozen priority order without borrowing. It uses the
 * plan-time cash fence for deterministic replay; real settlement must derive
 * current cash from the database ledger after intervening events and atomically
 * apply min(current cash, frozen limit). This result must not be persisted as a
 * fill by itself.
 */
export function executeS2BuyOrders(input: {
  readonly plan: BuyOrderPlan;
  readonly tradeDate: string;
  readonly executedAt: string;
  readonly officialOpenPrices: Readonly<Record<string, MarketPriceEvidence | undefined>>;
  /** Current remaining lots; used to allocate the next FIFO sequence safely. */
  readonly existingLots: readonly ShadowTaxLot[];
}): BuyExecutionResult {
  const plan = input.plan;
  assertFrozenOrderPlanIntegrity(plan, "S2");
  if (plan.executionModel !== "SIMULATED_SLIPPAGE") {
    throw new TypeError("executeS2BuyOrders only executes SIMULATED_SLIPPAGE plans");
  }
  requireCalendarDate(input.tradeDate, "tradeDate");
  requireIsoTimestamp(input.executedAt, "executedAt");
  if (input.executedAt.slice(0, 10) !== input.tradeDate) {
    throw new TypeError("executedAt must fall on tradeDate");
  }
  const initialBuyingPower = plan.initialBuyingPower;
  const buyingPowerEvidence = plan.buyingPowerEvidence;
  if (buyingPowerEvidence.value !== initialBuyingPower) {
    throw new TypeError(
      "Frozen S2 buying-power evidence must match initialBuyingPower",
    );
  }
  const seenOrders = new Set<string>();
  let remainingBuyingPower = initialBuyingPower;
  const fills: ExecutedBuyOrder[] = [];
  const createdLots: ShadowTaxLot[] = [];
  const latestSequenceByInstrument = new Map<
    string,
    ReturnType<typeof sequence>
  >();
  const seenLotIds = new Set<string>();
  const seenLotSequences = new Set<string>();
  for (const [index, lot] of input.existingLots.entries()) {
    requireIdentity(lot.lotId, `existingLots[${index}].lotId`);
    requireIdentity(lot.instrumentId, `existingLots[${index}].instrumentId`);
    if (seenLotIds.has(lot.lotId)) {
      throw new TypeError(`Duplicate existing lot id: ${lot.lotId}`);
    }
    seenLotIds.add(lot.lotId);
    requireInteger(lot.quantity, `existingLots[${index}].quantity`, true);
    requireNonNegative(
      lot.grossPurchasePrice,
      `existingLots[${index}].grossPurchasePrice`,
    );
    requireNonNegative(lot.buyFees, `existingLots[${index}].buyFees`);
    const lotSequence = sequence(lot.acquisitionSequence);
    const lotSequenceKey = `${lot.instrumentId}\u0000${lotSequence}`;
    if (seenLotSequences.has(lotSequenceKey)) {
      throw new TypeError(
        `Duplicate acquisition sequence ${lotSequence} for ${lot.instrumentId}`,
      );
    }
    seenLotSequences.add(lotSequenceKey);
    const current = latestSequenceByInstrument.get(lot.instrumentId);
    if (current === undefined || compareSequences(lotSequence, current) > 0) {
      latestSequenceByInstrument.set(lot.instrumentId, lotSequence);
    }
  }

  const orders = [...plan.orders].sort((left, right) => {
    const priorityOrder = BigInt(left.priority) - BigInt(right.priority);
    if (priorityOrder !== 0n) return priorityOrder < 0n ? -1 : 1;
    return left.instrumentId.localeCompare(right.instrumentId);
  });

  for (const order of orders) {
    requireIdentity(order.orderId, "order.orderId");
    if (seenOrders.has(order.orderId)) throw new TypeError(`Duplicate orderId: ${order.orderId}`);
    seenOrders.add(order.orderId);
    if (order.decisionId !== plan.decisionId) {
      throw new TypeError(`Order ${order.orderId} belongs to a different decision`);
    }
    if (order.stage !== "S2" || order.side !== "BUY") {
      throw new TypeError(`Order ${order.orderId} is not a frozen S2 buy order`);
    }
    if (order.plannedTradeDate !== input.tradeDate) {
      throw new TypeError(
        `Order ${order.orderId} was planned for ${order.plannedTradeDate}, not ${input.tradeDate}`,
      );
    }
    validateFrozenOrderReference(order, `orders.${order.orderId}`);
    if (Date.parse(order.plannedAt) > Date.parse(input.executedAt)) {
      throw new RangeError(`Order ${order.orderId} cannot execute before it was planned`);
    }
    const applicableFeeSchedule = parseCanonicalFutuFeeScheduleTerms(
      order.feeScheduleTerms,
    );
    if (
      order.feeScheduleId !== applicableFeeSchedule.feeScheduleId
      || order.feeCurrency !== applicableFeeSchedule.currency
    ) {
      throw new TypeError(`Order ${order.orderId} fee identity does not match its frozen terms`);
    }
    const fillId = `${order.orderId}:fill:1`;
    const createdLotId = `${fillId}:lot`;
    if (seenLotIds.has(createdLotId)) {
      throw new TypeError(
        `Buy order ${order.orderId} already has a persisted FIFO lot`,
      );
    }
    const requested = requireInteger(order.quantity, "order.quantity", true);
    const openEvidence = input.officialOpenPrices[order.instrumentId];
    if (openEvidence === undefined) {
      throw new TypeError(`Missing S2 official open price for ${order.instrumentId}`);
    }
    const officialOpenEvidence = validatePriceEvidence(
      openEvidence,
      "OFFICIAL_OPEN",
      input.tradeDate,
      input.executedAt,
      `officialOpenPrices.${order.instrumentId}`,
    );
    const officialOpenPrice = officialOpenEvidence.value;
    const fillPrice = applySimulatedSlippage({
      side: "BUY",
      officialOpenPrice,
      slippageBps: plan.slippageBps,
      priceScale: Number(plan.fillPriceScale),
    });
    const affordable = calculateMaxAffordableFutuBuyFill({
      tradeDate: input.tradeDate,
      requestedQuantity: order.quantity,
      price: fillPrice,
      buyingPower: remainingBuyingPower,
      schedules: [applicableFeeSchedule],
    });
    const filled = BigInt(affordable.affordableQuantity);
    const canceled = requested - filled;
    const status = filled === requested
      ? "FILLED"
      : filled === 0n
        ? "CANCELED_CASH_LIMIT"
        : "PARTIALLY_FILLED_CASH_LIMIT";

    remainingBuyingPower = requireNonNegative(
      subtractDecimals(remainingBuyingPower, affordable.totalCashRequired),
      "remaining buying power",
    );
    let createdLot: ShadowTaxLot | null = null;
    if (filled > 0n) {
      const acquisitionSequence = nextSequence(
        latestSequenceByInstrument.get(order.instrumentId) ?? sequence("0"),
      );
      createdLot = Object.freeze({
        lotId: createdLotId,
        instrumentId: order.instrumentId,
        acquisitionSequence,
        quantity: nonNegativeDecimal(affordable.affordableQuantity),
        grossPurchasePrice: nonNegativeDecimal(affordable.grossNotional),
        buyFees: affordable.totalFees,
      });
      createdLots.push(createdLot);
      seenLotIds.add(createdLotId);
      latestSequenceByInstrument.set(order.instrumentId, acquisitionSequence);
    }
    fills.push(Object.freeze({
      fillId,
      orderId: order.orderId,
      decisionId: order.decisionId,
      instrumentId: order.instrumentId,
      symbol: order.symbol,
      tradeDate: input.tradeDate,
      executedAt: input.executedAt,
      buyingPowerSnapshotId: buyingPowerEvidence.snapshotId,
      orderQuantity: order.quantity,
      fillQuantity: affordable.affordableQuantity,
      canceledQuantity: canceled.toString(),
      officialOpenPrice,
      officialOpenEvidence,
      fillPrice,
      grossNotional: affordable.grossNotional,
      fees: affordable.fees,
      totalFees: affordable.totalFees,
      totalCashRequired: affordable.totalCashRequired,
      feeScheduleId: affordable.feeScheduleId,
      feeCurrency: affordable.currency,
      createdLot,
      status,
    }));
  }

  return Object.freeze({
    fills: Object.freeze(fills),
    createdLots: Object.freeze(createdLots),
    buyingPowerEvidence,
    initialBuyingPower,
    remainingBuyingPower,
  });
}

/** Helper for callers that require a branded non-negative boundary value. */
export function asNonNegativeRebalanceAmount(value: DecimalInput) {
  return nonNegativeDecimal(requireNonNegative(value, "rebalance amount"));
}
