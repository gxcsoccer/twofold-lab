import { createHash } from "node:crypto";

import {
  createS1SellOrderPlan,
  createS2BuyOrderPlan,
  type MarketPriceEvidence,
} from "@twofold/core";
import { describe, expect, it } from "vitest";

import {
  buildFrozenOrderPlanRegistration,
  type FrozenOrderPlan,
} from "../src/order-plan-registration.js";

const RUN_ID = "70000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "70000000-0000-4000-8000-000000000002";
const DECISION_ID = "72000000-0000-4000-8000-000000000001";
const SUBMISSION_ID = "72000000-0000-4000-8000-000000000002";
const INSTRUMENT_ID = "71000000-0000-4000-8000-000000000001";
const D = "2026-08-24";
const D_CLOSE = "2026-08-24T20:15:00.000Z";
const S1_PLAN_FROZEN_AT = "2026-08-24T20:16:00.000Z";
const S1 = "2026-08-25";
const S1_CLOSE = "2026-08-25T20:15:00.000Z";
const S2 = "2026-08-26";

function closeEvidence(
  value: string,
  sessionDate: string,
  visibleAt: string,
): MarketPriceEvidence {
  return {
    value,
    kind: "OFFICIAL_CLOSE",
    sessionDate,
    visibleAt,
    snapshotId: `snapshot-${sessionDate}`,
    factId: `fact-${INSTRUMENT_ID}-${sessionDate}`,
  };
}

function s2Plan() {
  return createS2BuyOrderPlan({
    decisionId: DECISION_ID,
    s1SessionDate: S1,
    plannedAt: S1_CLOSE,
    s2TradeDate: S2,
    slippageBps: "5",
    fillPriceScale: 8,
    preOrderTaxReservedNav: "100",
    buyingPowerEvidence: {
      value: "100",
      snapshotId: "ledger-snapshot-s1-close",
      visibleAt: S1_CLOSE,
    },
    positions: [{
      instrumentId: INSTRUMENT_ID,
      symbol: "LULU",
      quantity: "0",
      mark: closeEvidence("10", S1, S1_CLOSE),
    }],
    targets: [{ instrumentId: INSTRUMENT_ID, symbol: "LULU", weightBps: "10000" }],
    cashWeightBps: "0",
  });
}

function registration(plan: FrozenOrderPlan) {
  return buildFrozenOrderPlanRegistration({
    idempotencyKey: `${DECISION_ID}:${plan.stage}`,
    strategyAccountId: ACCOUNT_ID,
    runId: RUN_ID,
    acceptedSubmissionId: SUBMISSION_ID,
    plannedAt: plan.stage === "S1" ? S1_PLAN_FROZEN_AT : S1_CLOSE,
    plannedTradeDate: plan.stage === "S1" ? S1 : S2,
    recordedBy: "twofold-worker",
    plan,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function containsNumber(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.some(containsNumber);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsNumber);
  }
  return false;
}

describe("frozen order plan registration adapter", () => {
  it("binds the exact Core S2 plan to the DB identity and fee hashes", () => {
    const plan = s2Plan();
    const result = registration(plan);
    const manifest = JSON.parse(result.planCanonicalJson) as Record<string, any>;

    expect(result.planSha256).toBe(sha256(result.planCanonicalJson));
    expect(result.enginePlanFingerprintSha256).toBe(sha256(plan.planFingerprint));
    expect(result.rpcArguments).toMatchObject({
      p_run_id: RUN_ID,
      p_decision_id: DECISION_ID,
      p_accepted_submission_id: SUBMISSION_ID,
      p_stage: "S2",
      p_plan_canonical_json: result.planCanonicalJson,
      p_plan_sha256: result.planSha256,
    });
    expect(manifest).toMatchObject({
      manifestSchema: "twofold.frozen_order_plan/v1",
      runId: RUN_ID,
      decisionId: DECISION_ID,
      acceptedSubmissionId: SUBMISSION_ID,
      stage: "S2",
      plannedAt: S1_CLOSE,
      plannedTradeDate: S2,
      executionModel: "SIMULATED_SLIPPAGE",
      slippageBps: "5",
      fillPriceScale: "8",
      enginePlanFingerprint: plan.planFingerprint,
      buyingPowerEvidence: plan.buyingPowerEvidence,
      initialBuyingPower: "100",
    });
    expect(manifest.orders[0]).toMatchObject({
      instrumentId: INSTRUMENT_ID,
      executionModel: "SIMULATED_SLIPPAGE",
      slippageBps: "5",
    });
    expect(manifest.orders[0].feeTermsSha256).toBe(
      sha256(manifest.orders[0].feeScheduleTerms),
    );
    expect(containsNumber(manifest)).toBe(false);
  });

  it("is byte-deterministic and rejects a mutated engine plan", () => {
    const plan = s2Plan();
    expect(registration(plan).planCanonicalJson).toBe(
      registration(plan).planCanonicalJson,
    );
    expect(() => registration({ ...plan, slippageBps: "6" })).toThrow(
      "frozen order plan fingerprint mismatch",
    );
  });

  it("binds the minute participation limit into engine, wrapper, and orders", () => {
    const plan = createS2BuyOrderPlan({
      decisionId: DECISION_ID,
      s1SessionDate: S1,
      plannedAt: S1_CLOSE,
      s2TradeDate: S2,
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      maxParticipationBps: "100",
      slippageBps: "5",
      fillPriceScale: 8,
      preOrderTaxReservedNav: "100",
      buyingPowerEvidence: {
        value: "100",
        snapshotId: "ledger-snapshot-s1-close",
        visibleAt: S1_CLOSE,
      },
      positions: [{
        instrumentId: INSTRUMENT_ID,
        symbol: "LULU",
        quantity: "0",
        mark: closeEvidence("10", S1, S1_CLOSE),
      }],
      targets: [{ instrumentId: INSTRUMENT_ID, symbol: "LULU", weightBps: "10000" }],
      cashWeightBps: "0",
    });

    const manifest = JSON.parse(registration(plan).planCanonicalJson) as
      Record<string, any>;
    expect(manifest).toMatchObject({
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      maxParticipationBps: "100",
    });
    expect(manifest.orders[0]).toMatchObject({
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      maxParticipationBps: "100",
    });
    expect(JSON.parse(manifest.enginePlanFingerprint)).toMatchObject({
      maxParticipationBps: "100",
    });
  });

  it("fails before DB admission when participation is zero", () => {
    const plan = {
      ...s2Plan(),
      executionModel: "SIMULATED_MINUTE_PARTICIPATION" as const,
      maxParticipationBps: "0",
    };

    expect(() => registration(plan)).toThrow("maxParticipationBps must be positive");
  });

  it("rejects non-canonical uppercase UUIDs before DB admission", () => {
    const plan = s2Plan();
    expect(() => buildFrozenOrderPlanRegistration({
      idempotencyKey: `${DECISION_ID}:S2:uppercase`,
      strategyAccountId: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF",
      runId: RUN_ID,
      acceptedSubmissionId: SUBMISSION_ID,
      plannedAt: S1_CLOSE,
      plannedTradeDate: S2,
      recordedBy: "twofold-worker",
      plan,
    })).toThrow("canonical lowercase form");
  });

  it("rejects a persistence window that differs from every frozen order", () => {
    const plan = s2Plan();
    expect(() => buildFrozenOrderPlanRegistration({
      idempotencyKey: `${DECISION_ID}:S2:wrong-date`,
      strategyAccountId: ACCOUNT_ID,
      runId: RUN_ID,
      acceptedSubmissionId: SUBMISSION_ID,
      plannedAt: S1_CLOSE,
      plannedTradeDate: "2026-08-27",
      recordedBy: "twofold-worker",
      plan,
    })).toThrow("does not match the registration window");
  });

  it("preserves a complete S1 no-op envelope and strict tax rules", () => {
    const plan = createS1SellOrderPlan({
      decisionId: DECISION_ID,
      decisionSessionDate: D,
      decisionCutoffAt: D_CLOSE,
      plannedAt: S1_PLAN_FROZEN_AT,
      s1TradeDate: S1,
      slippageBps: "5",
      fillPriceScale: 8,
      taxAllocationScale: 12,
      decisionCloseTaxReservedNav: "100",
      positions: [],
      targets: [],
      cashWeightBps: "10000",
    });
    const manifest = JSON.parse(registration(plan).planCanonicalJson) as Record<string, any>;

    expect(manifest.orders).toEqual([]);
    expect(manifest).toMatchObject({
      stage: "S1",
      taxRulesetId: "cn_resident_direct_foreign_securities_strict_v1",
      taxAllocationScale: "12",
    });
  });

  it("fails before DB admission when a plan uses a non-stable instrument ID", () => {
    const plan = createS2BuyOrderPlan({
      decisionId: DECISION_ID,
      s1SessionDate: S1,
      plannedAt: S1_CLOSE,
      s2TradeDate: S2,
      slippageBps: "5",
      fillPriceScale: 8,
      preOrderTaxReservedNav: "100",
      buyingPowerEvidence: {
        value: "100",
        snapshotId: "ledger-snapshot-s1-close",
        visibleAt: S1_CLOSE,
      },
      positions: [{
        instrumentId: "lulu",
        symbol: "LULU",
        quantity: "0",
        mark: closeEvidence("10", S1, S1_CLOSE),
      }],
      targets: [{ instrumentId: "lulu", symbol: "LULU", weightBps: "10000" }],
      cashWeightBps: "0",
    });

    expect(() => registration(plan)).toThrow("instrumentId must be a UUID");
  });

  it("rejects buying-power evidence that the settlement ledger would round", () => {
    const plan = createS2BuyOrderPlan({
      decisionId: DECISION_ID,
      s1SessionDate: S1,
      plannedAt: S1_CLOSE,
      s2TradeDate: S2,
      slippageBps: "5",
      fillPriceScale: 8,
      preOrderTaxReservedNav: "0.0000000000001",
      buyingPowerEvidence: {
        value: "0.0000000000001",
        snapshotId: "ledger-snapshot-too-precise",
        visibleAt: S1_CLOSE,
      },
      positions: [],
      targets: [],
      cashWeightBps: "10000",
    });

    expect(() => registration(plan)).toThrow("exceeds NUMERIC(38,12) precision");
  });
});
