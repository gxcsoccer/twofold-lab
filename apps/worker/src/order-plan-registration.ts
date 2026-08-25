import { createHash } from "node:crypto";

import {
  assertFrozenOrderPlanIntegrity,
  addDecimals,
  canonicalFinancialJson,
  compareDecimals,
  normalizeDecimal,
  STRICT_SHADOW_TAX_RULESET_ID,
  type BuyOrderPlan,
  type SellOrderPlan,
} from "@twofold/core";

export const FROZEN_ORDER_PLAN_MANIFEST_SCHEMA =
  "twofold.frozen_order_plan/v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

export type FrozenOrderPlan = SellOrderPlan | BuyOrderPlan;

export interface RegisterFrozenOrderPlanRpcArguments {
  readonly p_idempotency_key: string;
  readonly p_strategy_account_id: string;
  readonly p_run_id: string;
  readonly p_decision_id: string;
  readonly p_accepted_submission_id: string;
  readonly p_stage: "S1" | "S2";
  readonly p_planned_at: string;
  readonly p_planned_trade_date: string;
  readonly p_manifest_schema: typeof FROZEN_ORDER_PLAN_MANIFEST_SCHEMA;
  readonly p_plan_canonical_json: string;
  readonly p_plan_sha256: string;
  readonly p_recorded_by: string;
}

export interface FrozenOrderPlanRegistration {
  readonly manifestSchema: typeof FROZEN_ORDER_PLAN_MANIFEST_SCHEMA;
  readonly planCanonicalJson: string;
  readonly planSha256: string;
  readonly enginePlanFingerprintSha256: string;
  readonly rpcArguments: RegisterFrozenOrderPlanRpcArguments;
}

export function buildFrozenOrderPlanRegistration(input: {
  readonly idempotencyKey: string;
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly acceptedSubmissionId: string;
  readonly plannedAt: string;
  readonly plannedTradeDate: string;
  readonly recordedBy: string;
  readonly plan: FrozenOrderPlan;
}): FrozenOrderPlanRegistration {
  requireIdentity(input.idempotencyKey, "idempotencyKey");
  requireIdentity(input.recordedBy, "recordedBy");
  requireUuid(input.strategyAccountId, "strategyAccountId");
  requireUuid(input.runId, "runId");
  requireUuid(input.acceptedSubmissionId, "acceptedSubmissionId");
  requireCanonicalTimestamp(input.plannedAt, "plannedAt");
  requireCalendarDate(input.plannedTradeDate, "plannedTradeDate");
  if (input.plannedAt.slice(0, 10) >= input.plannedTradeDate) {
    throw new RangeError("plannedAt must precede plannedTradeDate");
  }

  const plan = input.plan;
  assertFrozenOrderPlanIntegrity(plan, plan.stage);
  requireUuid(plan.decisionId, "plan.decisionId");
  requireBoundedInteger(plan.slippageBps, "plan.slippageBps", 10_000n);
  requireBoundedInteger(plan.fillPriceScale, "plan.fillPriceScale", 12n);

  const seenOrderIds = new Set<string>();
  const wrappedOrders = plan.orders.map((order, index) => {
    requireIdentity(order.orderId, `plan.orders[${index}].orderId`);
    if (seenOrderIds.has(order.orderId)) {
      throw new TypeError(`Duplicate frozen order ID: ${order.orderId}`);
    }
    seenOrderIds.add(order.orderId);
    if (order.decisionId !== plan.decisionId || order.stage !== plan.stage) {
      throw new TypeError(`Frozen order ${order.orderId} is not bound to its plan`);
    }
    const expectedSide = plan.stage === "S1" ? "SELL" : "BUY";
    if (order.side !== expectedSide) {
      throw new TypeError(`Frozen order ${order.orderId} has the wrong side`);
    }
    if (
      order.plannedAt !== input.plannedAt
      || order.plannedTradeDate !== input.plannedTradeDate
    ) {
      throw new TypeError(
        `Frozen order ${order.orderId} does not match the registration window`,
      );
    }
    if (!POSITIVE_INTEGER_PATTERN.test(order.quantity)) {
      throw new TypeError(`Frozen order ${order.orderId} quantity must be positive`);
    }
    if (order.quantity.length > 26) {
      throw new RangeError(
        `Frozen order ${order.orderId} quantity exceeds NUMERIC(38,12) precision`,
      );
    }
    requireUuid(order.instrumentId, `plan.orders[${index}].instrumentId`);
    requireIdentity(order.feeScheduleId, `plan.orders[${index}].feeScheduleId`);
    requireIdentity(order.feeScheduleTerms, `plan.orders[${index}].feeScheduleTerms`);
    if (!/^[A-Z]{3}$/.test(order.feeCurrency)) {
      throw new TypeError(`plan.orders[${index}].feeCurrency must be ISO 4217`);
    }
    return Object.freeze({
      ...order,
      executionModel: plan.executionModel,
      slippageBps: plan.slippageBps,
      feeTermsSha256: sha256Utf8(order.feeScheduleTerms),
    });
  });

  const enginePlanFingerprintSha256 = sha256Utf8(plan.planFingerprint);
  const commonManifest = {
    manifestSchema: FROZEN_ORDER_PLAN_MANIFEST_SCHEMA,
    runId: input.runId,
    decisionId: plan.decisionId,
    acceptedSubmissionId: input.acceptedSubmissionId,
    stage: plan.stage,
    plannedAt: input.plannedAt,
    plannedTradeDate: input.plannedTradeDate,
    executionModel: plan.executionModel,
    slippageBps: plan.slippageBps,
    fillPriceScale: plan.fillPriceScale,
    enginePlanFingerprint: plan.planFingerprint,
    enginePlanFingerprintSha256,
    orders: Object.freeze(wrappedOrders),
  } as const;
  const manifest = plan.stage === "S1"
    ? {
        ...commonManifest,
        taxRulesetId: requireStrictTaxRuleset(plan.taxRulesetId),
        taxAllocationScale: requireBoundedInteger(
          plan.taxAllocationScale,
          "plan.taxAllocationScale",
          100n,
        ),
      }
    : {
        ...commonManifest,
        buyingPowerEvidence: validateBuyingPowerEvidence(
          plan,
          input.plannedAt,
        ),
        initialBuyingPower: plan.initialBuyingPower,
        reservedBuyingPower: plan.reservedBuyingPower,
        remainingUnreservedBuyingPower: plan.remainingUnreservedBuyingPower,
      };

  const planCanonicalJson = canonicalFinancialJson(manifest);
  const planSha256 = sha256Utf8(planCanonicalJson);
  const rpcArguments = Object.freeze({
    p_idempotency_key: input.idempotencyKey,
    p_strategy_account_id: input.strategyAccountId,
    p_run_id: input.runId,
    p_decision_id: plan.decisionId,
    p_accepted_submission_id: input.acceptedSubmissionId,
    p_stage: plan.stage,
    p_planned_at: input.plannedAt,
    p_planned_trade_date: input.plannedTradeDate,
    p_manifest_schema: FROZEN_ORDER_PLAN_MANIFEST_SCHEMA,
    p_plan_canonical_json: planCanonicalJson,
    p_plan_sha256: planSha256,
    p_recorded_by: input.recordedBy,
  });

  return Object.freeze({
    manifestSchema: FROZEN_ORDER_PLAN_MANIFEST_SCHEMA,
    planCanonicalJson,
    planSha256,
    enginePlanFingerprintSha256,
    rpcArguments,
  });
}

function requireIdentity(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
}

function requireUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a UUID in canonical lowercase form`);
  }
}

function requireCalendarDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a real calendar date`);
  }
}

function requireCanonicalTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a canonical ISO UTC timestamp`);
  }
}

function requireBoundedInteger(
  value: string,
  field: string,
  maximum: bigint,
): string {
  if (!NON_NEGATIVE_INTEGER_PATTERN.test(value) || BigInt(value) > maximum) {
    throw new RangeError(`${field} must be a canonical integer from 0 through ${maximum}`);
  }
  return value;
}

function requireStrictTaxRuleset(value: string): typeof STRICT_SHADOW_TAX_RULESET_ID {
  if (value !== STRICT_SHADOW_TAX_RULESET_ID) {
    throw new TypeError("Unsupported S1 shadow-tax ruleset");
  }
  return value;
}

function validateBuyingPowerEvidence(
  plan: BuyOrderPlan,
  plannedAt: string,
) {
  requireIdentity(
    plan.buyingPowerEvidence.snapshotId,
    "plan.buyingPowerEvidence.snapshotId",
  );
  requireCanonicalTimestamp(
    plan.buyingPowerEvidence.visibleAt,
    "plan.buyingPowerEvidence.visibleAt",
  );
  if (Date.parse(plan.buyingPowerEvidence.visibleAt) > Date.parse(plannedAt)) {
    throw new RangeError("Frozen buying-power evidence cannot postdate plannedAt");
  }
  for (const [field, value] of [
    ["initialBuyingPower", plan.initialBuyingPower],
    ["reservedBuyingPower", plan.reservedBuyingPower],
    ["remainingUnreservedBuyingPower", plan.remainingUnreservedBuyingPower],
  ] as const) {
    if (normalizeDecimal(value) !== value || compareDecimals(value, "0") < 0) {
      throw new TypeError(`plan.${field} must be a canonical non-negative decimal`);
    }
    requireAccountingDecimal(value, `plan.${field}`);
  }
  if (plan.buyingPowerEvidence.value !== plan.initialBuyingPower) {
    throw new TypeError("Frozen buying-power evidence must match initialBuyingPower");
  }
  if (
    addDecimals(plan.reservedBuyingPower, plan.remainingUnreservedBuyingPower)
    !== plan.initialBuyingPower
  ) {
    throw new TypeError("Frozen S2 buying-power totals do not conserve cash");
  }
  return plan.buyingPowerEvidence;
}

function requireAccountingDecimal(value: string, field: string): void {
  const [whole = "", fraction = ""] = value.split(".");
  if (whole.length > 26 || fraction.length > 12) {
    throw new RangeError(`${field} exceeds NUMERIC(38,12) precision`);
  }
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
