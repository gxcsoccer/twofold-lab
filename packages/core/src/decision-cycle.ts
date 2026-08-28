import { createHash } from "node:crypto";

import { canonicalFinancialJson, compareCodePoints } from "./canonical-json.js";
import { decimal, nonNegativeDecimal, sequence, type DecimalString } from "./decimal.js";
import type { FutuFeeSchedule } from "./futu-fees.js";
import {
  addDecimals,
  compareDecimals,
  multiplyDecimals,
  subtractDecimals,
  sumDecimals,
} from "./fixed-decimal.js";
import { replayLedger, type LedgerProjection, type LedgerTransaction } from "./ledger.js";
import { calculateNavSnapshot, type NavSnapshot } from "./nav-round.js";
import {
  createPaperOrderSettlement,
  type CnyFxEvidence,
  type CompletedPaperOrderExecution,
  type LotAcquisitionFxBinding,
  type PaperSettlementIntent,
  type PaperOrderSettlementResult,
  type SimulatedSlippageFillPriceEvidence,
} from "./paper-settlement.js";
import {
  applySimulatedSlippage,
  createS1SellOrderPlan,
  createS2BuyOrderPlan,
  executeS2BuyOrders,
  type BuyOrderPlan,
  type MarketPriceEvidence,
  type SellOrderPlan,
} from "./rebalance.js";
import type { ShadowTaxLot } from "./shadow-tax.js";

const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface AcceptedTargetWeight {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly targetWeightBps: string;
}

export interface AcceptedTargetSubmissionSnapshot {
  readonly submissionId: string;
  readonly decisionId: string;
  readonly targets: readonly AcceptedTargetWeight[];
  readonly cashWeightBps: string;
}

export interface CycleOfficialOpenEvidence {
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly factId: string;
  readonly sourceArtifactId: string;
  readonly sourceContentSha256: string;
  readonly observedAt: string;
  readonly snapshotId: string;
  readonly sessionDate: string;
  readonly value: string;
}

export interface AcceptedTargetCycleInstrument {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly sourceCountry: string;
  readonly quantity: string;
  readonly grossCost: string;
  readonly lots: readonly ShadowTaxLot[];
  readonly acquisitionFxBindings: readonly LotAcquisitionFxBinding[];
  readonly decisionCloseMark: MarketPriceEvidence;
  readonly s1CloseMark: MarketPriceEvidence;
  readonly finalMark: MarketPriceEvidence;
}

export interface AcceptedTargetCycleInput {
  readonly acceptedSubmission: AcceptedTargetSubmissionSnapshot;
  readonly account: {
    readonly strategyAccountId: string;
    readonly runId: string;
    readonly currency: string;
    readonly cashAssetBalance: string;
    readonly taxReserveBalance: string;
    readonly headSequence: string;
    readonly headHash: string;
    readonly priorLedgerTransactions: readonly LedgerTransaction[];
  };
  readonly timeline: {
    readonly decisionSessionDate: string;
    readonly decisionCutoffAt: string;
    readonly s1PlannedAt: string;
    readonly s1TradeDate: string;
    readonly s1ExecutedAt: string;
    readonly s1SettledAt: string;
    readonly s1CloseAt: string;
    readonly s2PlannedAt: string;
    readonly s2TradeDate: string;
    readonly s2ExecutedAt: string;
    readonly s2SettledAt: string;
    readonly navAsOf: string;
  };
  readonly instruments: readonly AcceptedTargetCycleInstrument[];
  readonly s1OfficialOpenByInstrument: Readonly<Record<string, CycleOfficialOpenEvidence | undefined>>;
  readonly s2OfficialOpenByInstrument: Readonly<Record<string, CycleOfficialOpenEvidence | undefined>>;
  readonly dispositionFxByInstrument: Readonly<Record<string, CnyFxEvidence | undefined>>;
  readonly acquisitionFxByInstrument: Readonly<Record<string, CnyFxEvidence | undefined>>;
  readonly feeSchedules?: readonly FutuFeeSchedule[];
  readonly slippageBps: string;
  readonly fillPriceScale: number;
  readonly taxAllocationScale: number;
  readonly liquidation: {
    readonly estimatedCloseFeesForAllPositions: string;
    readonly estimatedUnrealizedLiquidationTax: string;
  };
}

export interface AcceptedTargetCyclePosition {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly grossCost: DecimalString;
  readonly lots: readonly ShadowTaxLot[];
  readonly acquisitionFxBindings: readonly LotAcquisitionFxBinding[];
}

export interface AcceptedTargetCycleResult {
  readonly schema: "twofold.accepted_target_cycle/v1";
  readonly submissionId: string;
  readonly decisionId: string;
  readonly s1: {
    readonly plan: SellOrderPlan;
    readonly settlements: readonly ReadyPaperSettlement[];
    readonly nav: NavSnapshot;
  };
  readonly s2: {
    readonly plan: BuyOrderPlan;
    readonly settlements: readonly ReadyPaperSettlement[];
  };
  readonly positions: readonly AcceptedTargetCyclePosition[];
  readonly ledger: LedgerProjection;
  readonly nav: NavSnapshot;
  readonly finalLedgerHead: {
    readonly sequence: string;
    readonly sha256: string;
  };
  readonly canonicalJson: string;
  readonly contentSha256: string;
}

type ReadyPaperSettlement = Extract<PaperOrderSettlementResult, { status: "READY" }>;

interface MutablePosition {
  instrumentId: string;
  symbol: string;
  sourceCountry: string;
  quantity: string;
  grossCost: DecimalString;
  lots: ShadowTaxLot[];
  acquisitionFxBindings: LotAcquisitionFxBinding[];
  decisionCloseMark: MarketPriceEvidence;
  s1CloseMark: MarketPriceEvidence;
  finalMark: MarketPriceEvidence;
}

interface MutableAccountState {
  cash: DecimalString;
  buyingPower: DecimalString;
  taxReserve: DecimalString;
  headSequence: bigint;
  headHash: string;
}

/**
 * Complete deterministic domain cycle after one target submission has already
 * crossed the Arena acceptance boundary. It never calls a model or provider.
 * Persistence layers may use the result only as a replay oracle: authoritative
 * settlement must still lock and re-derive the same transitions atomically.
 */
export function runAcceptedTargetCycle(
  input: AcceptedTargetCycleInput,
): AcceptedTargetCycleResult {
  validateInput(input);
  const positions = initializePositions(input.instruments);
  const targets = normalizeTargets(input.acceptedSubmission, positions);
  const account: MutableAccountState = {
    cash: decimal(input.account.cashAssetBalance),
    buyingPower: subtractDecimals(
      input.account.cashAssetBalance,
      input.account.taxReserveBalance,
    ),
    taxReserve: decimal(input.account.taxReserveBalance),
    headSequence: BigInt(input.account.headSequence),
    headHash: input.account.headHash,
  };
  if (compareDecimals(account.buyingPower, "0") < 0) {
    throw new RangeError("Initial tax reserve cannot exceed cash");
  }

  const decisionCloseNav = navFor(
    input.account.currency,
    account,
    positions,
    "decisionCloseMark",
    input.liquidation,
  );
  const s1Plan = createS1SellOrderPlan({
    decisionId: input.acceptedSubmission.decisionId,
    decisionSessionDate: input.timeline.decisionSessionDate,
    decisionCutoffAt: input.timeline.decisionCutoffAt,
    plannedAt: input.timeline.s1PlannedAt,
    s1TradeDate: input.timeline.s1TradeDate,
    decisionCloseTaxReservedNav: decisionCloseNav.taxReservedNav,
    positions: [...positions.values()].map((position) => ({
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      quantity: position.quantity,
      mark: position.decisionCloseMark,
    })),
    targets,
    cashWeightBps: input.acceptedSubmission.cashWeightBps,
    slippageBps: input.slippageBps,
    fillPriceScale: input.fillPriceScale,
    taxAllocationScale: input.taxAllocationScale,
    ...(input.feeSchedules === undefined ? {} : { feeSchedules: input.feeSchedules }),
  });

  const appendedTransactions: LedgerTransaction[] = [];
  const s1Settlements: ReadyPaperSettlement[] = [];
  for (const order of s1Plan.orders) {
    const position = positions.get(order.instrumentId)!;
    const open = requiredOpen(
      input.s1OfficialOpenByInstrument,
      order.instrumentId,
      input.timeline.s1TradeDate,
      "S1",
    );
    const execution = fullExecution(
      order,
      open,
      input.timeline.s1ExecutedAt,
      Number(s1Plan.fillPriceScale),
      s1Plan.slippageBps,
    );
    const dispositionFxEvidence = input.dispositionFxByInstrument[order.instrumentId];
    const result = createPaperOrderSettlement({
      plan: s1Plan,
      orderId: order.orderId,
      execution,
      settledAt: input.timeline.s1SettledAt,
      ledgerHead: ledgerHead(input, account, position, "S1"),
      availableLots: position.lots,
      sourceCountry: position.sourceCountry,
      ...(dispositionFxEvidence === undefined ? {} : { dispositionFxEvidence }),
      acquisitionFxEvidence: position.acquisitionFxBindings,
    });
    if (result.status !== "READY") {
      throw new Error(`S1 settlement unresolved: ${result.unresolved.reason}`);
    }
    applySettlement(account, position, result.intent);
    position.acquisitionFxBindings = remainingAcquisitionBindings(
      position.acquisitionFxBindings,
      result.intent,
    );
    advanceHead(account, result.contentSha256);
    s1Settlements.push(result);
    appendedTransactions.push(...result.intent.ledgerTransactions);
  }

  const s1Nav = navFor(
    input.account.currency,
    account,
    positions,
    "s1CloseMark",
    input.liquidation,
  );
  const s2Plan = createS2BuyOrderPlan({
    decisionId: input.acceptedSubmission.decisionId,
    s1SessionDate: input.timeline.s1TradeDate,
    plannedAt: input.timeline.s2PlannedAt,
    s2TradeDate: input.timeline.s2TradeDate,
    preOrderTaxReservedNav: s1Nav.taxReservedNav,
    buyingPowerEvidence: {
      value: account.buyingPower,
      snapshotId: `${input.acceptedSubmission.decisionId}:s1-close-ledger`,
      visibleAt: input.timeline.s1CloseAt,
    },
    positions: [...positions.values()].map((position) => ({
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      quantity: position.quantity,
      mark: position.s1CloseMark,
    })),
    targets,
    cashWeightBps: input.acceptedSubmission.cashWeightBps,
    slippageBps: input.slippageBps,
    fillPriceScale: input.fillPriceScale,
    ...(input.feeSchedules === undefined ? {} : { feeSchedules: input.feeSchedules }),
  });
  const s2Execution = executeS2BuyOrders({
    plan: s2Plan,
    tradeDate: input.timeline.s2TradeDate,
    executedAt: input.timeline.s2ExecutedAt,
    officialOpenPrices: Object.fromEntries(
      Object.entries(input.s2OfficialOpenByInstrument).map(([id, value]) => [
        id,
        value === undefined ? undefined : marketOpen(value),
      ]),
    ),
    existingLots: [...positions.values()].flatMap((position) => position.lots),
  });

  let frozenRemainingBuyingPower = s2Plan.initialBuyingPower;
  const priorSettlementIds: string[] = [];
  const s2Settlements: ReadyPaperSettlement[] = [];
  for (const fill of s2Execution.fills) {
    const order = s2Plan.orders.find((candidate) => candidate.orderId === fill.orderId)!;
    const position = positions.get(order.instrumentId)!;
    const open = requiredOpen(
      input.s2OfficialOpenByInstrument,
      order.instrumentId,
      input.timeline.s2TradeDate,
      "S2",
    );
    const execution = executionFromBuyFill(
      order,
      fill,
      open,
      input.timeline.s2ExecutedAt,
      s2Plan.slippageBps,
      s2Plan.fillPriceScale,
    );
    const acquisitionFxEvidence = input.acquisitionFxByInstrument[order.instrumentId];
    const result = createPaperOrderSettlement({
      plan: s2Plan,
      orderId: order.orderId,
      execution,
      settledAt: input.timeline.s2SettledAt,
      ledgerHead: ledgerHead(input, account, position, "S2"),
      planCashFence: {
        planFingerprint: s2Plan.planFingerprint,
        remainingBuyingPower: frozenRemainingBuyingPower,
        priorSettlementIds,
      },
      availableLots: position.lots,
      ...(fill.fillQuantity === "0" || acquisitionFxEvidence === undefined
        ? {}
        : { acquisitionFxEvidence }),
    });
    if (result.status !== "READY") {
      throw new Error(`S2 settlement unresolved: ${result.unresolved.reason}`);
    }
    applySettlement(account, position, result.intent);
    if (result.intent.cashFence !== null) {
      frozenRemainingBuyingPower = result.intent.cashFence.frozenRemainingBuyingPowerAfter;
    }
    const binding = result.intent.tax.acquisitionLotBindings[0];
    if (binding !== undefined) position.acquisitionFxBindings.push(binding);
    advanceHead(account, result.contentSha256);
    priorSettlementIds.push(result.intent.settlementId);
    s2Settlements.push(result);
    appendedTransactions.push(...result.intent.ledgerTransactions);
  }

  const ledger = replayLedger([
    ...input.account.priorLedgerTransactions,
    ...appendedTransactions,
  ]);
  assertProjectionMatchesState(ledger, account, positions, input.account.currency);
  assertTaxAccrualMatchesSettlements(
    ledger,
    replayLedger(input.account.priorLedgerTransactions),
    s1Settlements,
  );
  const finalNav = navFor(
    input.account.currency,
    account,
    positions,
    "finalMark",
    input.liquidation,
  );
  const finalPositions = Object.freeze(
    [...positions.values()]
      .map((position): AcceptedTargetCyclePosition => Object.freeze({
        instrumentId: position.instrumentId,
        symbol: position.symbol,
        quantity: position.quantity,
        grossCost: position.grossCost,
        lots: Object.freeze([...position.lots]),
        acquisitionFxBindings: Object.freeze([...position.acquisitionFxBindings]),
      }))
      .sort((left, right) => compareCodePoints(left.symbol, right.symbol)),
  );
  const payload = Object.freeze({
    schema: "twofold.accepted_target_cycle/v1" as const,
    submissionId: input.acceptedSubmission.submissionId,
    decisionId: input.acceptedSubmission.decisionId,
    s1: Object.freeze({
      plan: s1Plan,
      settlements: Object.freeze(s1Settlements),
      nav: s1Nav,
    }),
    s2: Object.freeze({
      plan: s2Plan,
      settlements: Object.freeze(s2Settlements),
    }),
    positions: finalPositions,
    ledger,
    nav: finalNav,
    finalLedgerHead: Object.freeze({
      sequence: account.headSequence.toString(),
      sha256: account.headHash,
    }),
  });
  const canonicalJson = canonicalFinancialJson(payload);
  return Object.freeze({
    ...payload,
    canonicalJson,
    contentSha256: sha256(canonicalJson),
  });
}

function validateInput(input: AcceptedTargetCycleInput): void {
  for (const [field, value] of [
    ["submissionId", input.acceptedSubmission.submissionId],
    ["decisionId", input.acceptedSubmission.decisionId],
    ["strategyAccountId", input.account.strategyAccountId],
    ["runId", input.account.runId],
  ] as const) {
    if (value.trim().length === 0 || value.trim() !== value) {
      throw new TypeError(`${field} must be a non-empty trimmed string`);
    }
  }
  if (!INTEGER_PATTERN.test(input.account.headSequence)) {
    throw new TypeError("headSequence must be a canonical integer string");
  }
  if (!SHA256_PATTERN.test(input.account.headHash)) {
    throw new TypeError("headHash must be a lowercase SHA-256");
  }
  decimal(input.account.cashAssetBalance);
  decimal(input.account.taxReserveBalance);
  if (
    compareDecimals(input.account.cashAssetBalance, "0") < 0
    || compareDecimals(input.account.taxReserveBalance, "0") < 0
  ) {
    throw new RangeError("Opening cash and tax reserve must be non-negative");
  }
  replayLedger(input.account.priorLedgerTransactions);
}

function initializePositions(
  input: readonly AcceptedTargetCycleInstrument[],
): Map<string, MutablePosition> {
  const positions = new Map<string, MutablePosition>();
  const symbols = new Set<string>();
  for (const instrument of input) {
    if (positions.has(instrument.instrumentId)) {
      throw new TypeError(`Duplicate instrument ${instrument.instrumentId}`);
    }
    if (symbols.has(instrument.symbol)) {
      throw new TypeError(`Duplicate symbol ${instrument.symbol}`);
    }
    if (!INTEGER_PATTERN.test(instrument.quantity)) {
      throw new TypeError(`Position ${instrument.symbol} quantity must be a canonical integer`);
    }
    const quantity = BigInt(instrument.quantity);
    const grossCost = decimal(instrument.grossCost);
    if (compareDecimals(grossCost, "0") < 0) {
      throw new RangeError(`Position ${instrument.symbol} gross cost must be non-negative`);
    }
    const lotQuantity = sumDecimals(instrument.lots.map((lot) => lot.quantity));
    const lotGrossCost = sumDecimals(instrument.lots.map((lot) => lot.grossPurchasePrice));
    if (lotQuantity !== quantity.toString() || lotGrossCost !== grossCost) {
      throw new RangeError(`Position ${instrument.symbol} does not reconcile to its FIFO lots`);
    }
    if (instrument.acquisitionFxBindings.length !== instrument.lots.length) {
      throw new RangeError(`Position ${instrument.symbol} requires one acquisition FX binding per lot`);
    }
    symbols.add(instrument.symbol);
    positions.set(instrument.instrumentId, {
      instrumentId: instrument.instrumentId,
      symbol: instrument.symbol,
      sourceCountry: instrument.sourceCountry,
      quantity: quantity.toString(),
      grossCost,
      lots: [...instrument.lots],
      acquisitionFxBindings: [...instrument.acquisitionFxBindings],
      decisionCloseMark: instrument.decisionCloseMark,
      s1CloseMark: instrument.s1CloseMark,
      finalMark: instrument.finalMark,
    });
  }
  return positions;
}

function normalizeTargets(
  submission: AcceptedTargetSubmissionSnapshot,
  positions: ReadonlyMap<string, MutablePosition>,
) {
  if (!INTEGER_PATTERN.test(submission.cashWeightBps)) {
    throw new TypeError("cashWeightBps must be a canonical integer string");
  }
  let total = BigInt(submission.cashWeightBps);
  const seen = new Set<string>();
  const targets = submission.targets.map((target) => {
    const position = positions.get(target.instrumentId);
    if (position === undefined || position.symbol !== target.symbol) {
      throw new TypeError(`Accepted target ${target.symbol} is outside the frozen universe`);
    }
    if (seen.has(target.instrumentId)) {
      throw new TypeError(`Duplicate accepted target ${target.instrumentId}`);
    }
    if (!INTEGER_PATTERN.test(target.targetWeightBps) || target.targetWeightBps === "0") {
      throw new TypeError("Accepted target weights must be canonical positive integer strings");
    }
    seen.add(target.instrumentId);
    total += BigInt(target.targetWeightBps);
    return Object.freeze({
      instrumentId: target.instrumentId,
      symbol: target.symbol,
      weightBps: target.targetWeightBps,
    });
  });
  if (total !== 10_000n) {
    throw new RangeError(`Accepted target weights and cash must total exactly 10000 (got ${total})`);
  }
  return Object.freeze(targets);
}

function navFor(
  currency: string,
  account: MutableAccountState,
  positions: ReadonlyMap<string, MutablePosition>,
  markField: "decisionCloseMark" | "s1CloseMark" | "finalMark",
  liquidation: AcceptedTargetCycleInput["liquidation"],
): NavSnapshot {
  return calculateNavSnapshot({
    currency,
    settledCash: account.cash,
    unsettledCash: decimal("0"),
    dividendReceivables: decimal("0"),
    otherRecognizedReceivables: decimal("0"),
    positionMarketValues: [...positions.values()].map((position) =>
      multiplyDecimals(position.quantity, position[markField].value)
    ),
    unpaidRealizedCapitalGainsTaxAccrual: account.taxReserve,
    pendingDividendChinaTaxTopUp: decimal("0"),
    estimatedForeignWithholdingPayable: decimal("0"),
    otherUnpaidChinaTaxAccrual: decimal("0"),
    estimatedCloseFeesForAllPositions: decimal(
      liquidation.estimatedCloseFeesForAllPositions,
    ),
    estimatedUnrealizedLiquidationTax: decimal(
      liquidation.estimatedUnrealizedLiquidationTax,
    ),
  });
}

function marketOpen(evidence: CycleOfficialOpenEvidence): MarketPriceEvidence {
  return Object.freeze({
    value: evidence.value,
    kind: "OFFICIAL_OPEN" as const,
    sessionDate: evidence.sessionDate,
    visibleAt: evidence.observedAt,
    snapshotId: evidence.snapshotId,
    factId: evidence.factId,
  });
}

function requiredOpen(
  values: Readonly<Record<string, CycleOfficialOpenEvidence | undefined>>,
  instrumentId: string,
  tradeDate: string,
  stage: "S1" | "S2",
): CycleOfficialOpenEvidence {
  const value = values[instrumentId];
  if (value === undefined) throw new TypeError(`Missing ${stage} official open for ${instrumentId}`);
  if (value.sessionDate !== tradeDate) {
    throw new TypeError(`${stage} official open is for a different session`);
  }
  return value;
}

function fillEvidence(
  open: CycleOfficialOpenEvidence,
  slippageBps: string,
  fillPriceScale: string,
): SimulatedSlippageFillPriceEvidence {
  return Object.freeze({
    semantics: "SIMULATED_SLIPPAGE_DERIVED_PRICE",
    sourceId: open.sourceId,
    sourceVersionId: open.sourceVersionId,
    factId: open.factId,
    sourceArtifactId: open.sourceArtifactId,
    sourceContentSha256: open.sourceContentSha256,
    observedAt: open.observedAt,
    snapshotId: open.snapshotId,
    officialOpenSessionDate: open.sessionDate,
    officialOpenPrice: open.value,
    slippageBps,
    fillPriceScale,
  });
}

function fullExecution(
  order: SellOrderPlan["orders"][number],
  open: CycleOfficialOpenEvidence,
  executedAt: string,
  priceScale: number,
  slippageBps: string,
): CompletedPaperOrderExecution {
  return Object.freeze({
    executionId: `${order.orderId}:execution`,
    orderId: order.orderId,
    decisionId: order.decisionId,
    stage: "S1",
    side: "SELL",
    instrumentId: order.instrumentId,
    tradeDate: order.plannedTradeDate,
    currency: order.feeCurrency,
    terminalStatus: "FILLED",
    canceledQuantity: "0",
    fills: [Object.freeze({
      fillId: `${order.orderId}:fill:1`,
      quantity: order.quantity,
      price: applySimulatedSlippage({
        side: "SELL",
        officialOpenPrice: open.value,
        slippageBps,
        priceScale,
      }),
      executedAt,
      priceEvidence: fillEvidence(open, slippageBps, priceScale.toString()),
    })],
  });
}

function executionFromBuyFill(
  order: BuyOrderPlan["orders"][number],
  fill: ReturnType<typeof executeS2BuyOrders>["fills"][number],
  open: CycleOfficialOpenEvidence,
  executedAt: string,
  slippageBps: string,
  fillPriceScale: string,
): CompletedPaperOrderExecution {
  const terminalStatus = fill.status === "FILLED"
    ? "FILLED"
    : fill.status === "CANCELED_CASH_LIMIT"
      ? "CANCELED"
      : "PARTIALLY_FILLED";
  return Object.freeze({
    executionId: `${order.orderId}:execution`,
    orderId: order.orderId,
    decisionId: order.decisionId,
    stage: "S2",
    side: "BUY",
    instrumentId: order.instrumentId,
    tradeDate: order.plannedTradeDate,
    currency: order.feeCurrency,
    terminalStatus,
    canceledQuantity: fill.canceledQuantity,
    fills: fill.fillQuantity === "0" ? [] : [Object.freeze({
      fillId: `${order.orderId}:fill:1`,
      quantity: fill.fillQuantity,
      price: fill.fillPrice,
      executedAt,
      priceEvidence: fillEvidence(open, slippageBps, fillPriceScale),
    })],
  });
}

function ledgerHead(
  input: AcceptedTargetCycleInput,
  account: MutableAccountState,
  position: MutablePosition,
  stage: "S1" | "S2",
) {
  return Object.freeze({
    strategyAccountId: input.account.strategyAccountId,
    runId: input.account.runId,
    headEventId: `${input.acceptedSubmission.decisionId}:head:${account.headSequence}`,
    headSequence: account.headSequence.toString(),
    headHash: account.headHash,
    capturedAt: stage === "S1"
      ? input.timeline.s1ExecutedAt
      : input.timeline.s2ExecutedAt,
    currency: input.account.currency,
    instrumentId: position.instrumentId,
    cashAssetBalance: account.cash,
    currentBuyingPower: account.buyingPower,
    taxReserveBalance: account.taxReserve,
    positionQuantity: position.quantity,
    positionGrossCostAssetBalance: position.grossCost,
  });
}

function applySettlement(
  account: MutableAccountState,
  position: MutablePosition,
  settlement: PaperSettlementIntent,
): void {
  account.cash = settlement.balanceTransition.cashAssetBalanceAfter;
  account.buyingPower = settlement.balanceTransition.buyingPowerAfter;
  account.taxReserve = settlement.balanceTransition.taxReserveAfter;
  position.quantity = settlement.balanceTransition.positionQuantityAfter;
  position.grossCost = settlement.balanceTransition.positionGrossCostAfter;
  position.lots = [...settlement.lotTransition.remainingLots];
  if (settlement.lotTransition.createdLot !== null) {
    position.lots.push(settlement.lotTransition.createdLot);
  }
}

function remainingAcquisitionBindings(
  bindings: readonly LotAcquisitionFxBinding[],
  settlement: PaperSettlementIntent,
): LotAcquisitionFxBinding[] {
  const allocations = new Map(settlement.tax.allocations.map((allocation) => [
    allocation.lotId,
    allocation,
  ] as const));
  const remainingLotIds = new Set(
    settlement.lotTransition.remainingLots.map((lot) => lot.lotId),
  );
  return bindings.flatMap((binding) => {
    if (!remainingLotIds.has(binding.lotId)) return [];
    const allocation = allocations.get(binding.lotId);
    if (allocation === undefined) return [{ ...binding }];
    return [Object.freeze({
      ...binding,
      remainingGrossPurchasePriceCny: subtractDecimals(
        binding.remainingGrossPurchasePriceCny,
        allocation.allocatedPurchasePrice,
      ),
      remainingBuyFeesCny: subtractDecimals(
        binding.remainingBuyFeesCny,
        allocation.allocatedBuyFees,
      ),
    })];
  });
}

function advanceHead(account: MutableAccountState, settlementSha256: string): void {
  account.headSequence += 1n;
  account.headHash = sha256(canonicalFinancialJson({
    previousHeadSha256: account.headHash,
    settlementSha256,
    sequence: account.headSequence.toString(),
  }));
}

function balanceOf(
  ledger: LedgerProjection,
  accountId: string,
  currency: string,
): DecimalString {
  return ledger.balances.find(
    (balance) => balance.accountId === accountId && balance.currency === currency,
  )?.amount ?? decimal("0");
}

function assertProjectionMatchesState(
  ledger: LedgerProjection,
  account: MutableAccountState,
  positions: ReadonlyMap<string, MutablePosition>,
  currency: string,
): void {
  const cash = balanceOf(ledger, "asset.cash", currency);
  if (cash !== account.cash) {
    throw new Error(`Ledger cash ${cash} differs from cycle cash ${account.cash}`);
  }
  for (const position of positions.values()) {
    const quantity = ledger.positions.find(
      (candidate) => candidate.accountId === "securities.inventory"
        && candidate.instrumentId === position.instrumentId,
    )?.quantity ?? "0";
    if (quantity !== position.quantity) {
      throw new Error(
        `Ledger position ${position.symbol}=${quantity} differs from cycle state ${position.quantity}`,
      );
    }
  }
  // Quantities alone do not prove the cost side reconciles: inventory carries
  // gross purchase cost, with fees expensed separately.
  const inventory = balanceOf(ledger, "securities.inventory", currency);
  const grossCost = sumDecimals(
    [...positions.values()].map((position) => position.grossCost),
  );
  if (inventory !== grossCost) {
    throw new Error(
      `Ledger inventory ${inventory} differs from cycle gross cost ${grossCost}`,
    );
  }
}

/**
 * The realized-tax liability is booked in CNY, while the NAV deduction and the
 * S2 buying-power fence use the trading-currency reserve converted at each
 * disposition's own FX rate. The two views therefore cannot be reconciled by any
 * single rate once a cycle contains sells at different rates, and only the CNY
 * side is an accounting balance. This asserts the exact side: every CNY the
 * settlements claim to accrue must appear in the replayed ledger.
 */
function assertTaxAccrualMatchesSettlements(
  ledger: LedgerProjection,
  priorLedger: LedgerProjection,
  s1Settlements: readonly ReadyPaperSettlement[],
): void {
  const accrued = sumDecimals(
    s1Settlements.map((settlement) => settlement.intent.tax.chinaCapitalGainsTaxCny),
  );
  const expected = addDecimals(
    balanceOf(priorLedger, "liability.china_tax_accrual", "CNY"),
    accrued,
  );
  const actual = balanceOf(ledger, "liability.china_tax_accrual", "CNY");
  if (actual !== expected) {
    throw new Error(
      `Ledger CNY tax accrual ${actual} differs from settled accrual ${expected}`,
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
