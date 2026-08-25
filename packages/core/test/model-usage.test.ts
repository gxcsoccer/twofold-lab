import { describe, expect, it } from "vitest";

import {
  checkModelBudgetReservation,
  currency,
  DEEPSEEK_WEEKDAY_UTC_PRICING_RULE,
  deepseekPricingBandAt,
  defineModelPricing,
  estimateModelCost,
  nonNegativeDecimal,
  normalizeHarnessTokenUsage,
  tokenCount,
  totalBillableTokens,
} from "../src/index.js";

const pricing = defineModelPricing({
  pricingVersion: "test-v1",
  pricingBand: "off-peak",
  selectionRule: DEEPSEEK_WEEKDAY_UTC_PRICING_RULE,
  provider: "deepseek-official",
  model: "deepseek-v4-pro",
  effectiveFrom: "2026-08-23T00:00:00Z",
  effectiveTo: "2026-08-24T00:00:00Z",
  currency: "USD",
  uncachedInputPerMillion: "2",
  cacheReadPerMillion: "0.5",
  cacheWritePerMillion: "2.5",
  outputPerMillion: "8",
});

const costInput = (usage: ReturnType<typeof normalizeHarnessTokenUsage>) => ({
  provider: "deepseek-official",
  model: "deepseek-v4-pro",
  requestStartedAt: "2026-08-23T12:00:00Z",
  usage,
});

describe("model usage accounting", () => {
  it("normalizes disjoint Harness buckets at the durable string boundary", () => {
    expect(
      normalizeHarnessTokenUsage({
        inputTokens: 1_000,
        cacheReadTokens: 2_000,
        cacheWriteTokens: 300,
        outputTokens: 400,
        reasoningTokens: 250,
      }),
    ).toEqual({
      uncachedInputTokens: "1000",
      cacheReadTokens: "2000",
      cacheWriteTokens: "300",
      outputTokens: "400",
      reasoningTokens: "250",
    });
  });

  it("prices each bucket exactly and does not double-count reasoning", () => {
    const usage = normalizeHarnessTokenUsage({
      inputTokens: 1_000,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 300,
      outputTokens: 400,
      reasoningTokens: 250,
    });

    expect(estimateModelCost(costInput(usage), pricing)).toEqual({
      pricingVersion: "test-v1",
      pricingBand: "off-peak",
      amount: { amount: "0.00695", currency: "USD" },
    });
    expect(totalBillableTokens(usage)).toBe("3700");
  });

  it.each([
    {
      pricingBand: "off-peak",
      requestStartedAt: "2026-08-23T12:00:00Z",
      uncachedInputPerMillion: "0.66",
      cacheReadPerMillion: "0.022",
      cacheWritePerMillion: "0.66",
      outputPerMillion: "1.98",
      expectedAmount: "0.025806",
    },
    {
      pricingBand: "peak",
      requestStartedAt: "2026-08-24T01:00:00Z",
      uncachedInputPerMillion: "1.32",
      cacheReadPerMillion: "0.044",
      cacheWritePerMillion: "1.32",
      outputPerMillion: "3.96",
      expectedAmount: "0.051612",
    },
  ])("reproduces the frozen V4 Pro 0813 $pricingBand estimate", (rate) => {
    const v4Pro0813 = defineModelPricing({
      pricingVersion: "deepseek-v4-pro-0813-usd-2026-08-23-freeze-v1",
      pricingBand: rate.pricingBand,
      selectionRule: DEEPSEEK_WEEKDAY_UTC_PRICING_RULE,
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      effectiveFrom: "2026-08-23T00:00:00Z",
      currency: "USD",
      uncachedInputPerMillion: rate.uncachedInputPerMillion,
      cacheReadPerMillion: rate.cacheReadPerMillion,
      cacheWritePerMillion: rate.cacheWritePerMillion,
      outputPerMillion: rate.outputPerMillion,
    });
    const usage = normalizeHarnessTokenUsage({
      inputTokens: 18_940,
      cacheReadTokens: 42_300,
      outputTokens: 6_250,
      reasoningTokens: 4_120,
    });

    expect(
      estimateModelCost(
        {
          ...costInput(usage),
          requestStartedAt: rate.requestStartedAt,
        },
        v4Pro0813,
      ),
    ).toEqual({
      pricingVersion: "deepseek-v4-pro-0813-usd-2026-08-23-freeze-v1",
      pricingBand: rate.pricingBand,
      amount: { amount: rate.expectedAmount, currency: "USD" },
    });
  });

  it("keeps arbitrarily large durable counts exact", () => {
    const usage = {
      uncachedInputTokens: tokenCount("900719925474099300000"),
      cacheReadTokens: tokenCount("0"),
      cacheWriteTokens: tokenCount("0"),
      outputTokens: tokenCount("1"),
    };

    expect(estimateModelCost(costInput(usage), pricing).amount.amount).toBe(
      "1801439850948198.600008",
    );
  });

  it("rounds estimates to 18 decimal places with ROUND_HALF_UP", () => {
    const tinyPricing = defineModelPricing({
      pricingVersion: "tiny-v1",
      pricingBand: "off-peak",
      selectionRule: DEEPSEEK_WEEKDAY_UTC_PRICING_RULE,
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      effectiveFrom: "2026-08-23T00:00:00Z",
      currency: "USD",
      uncachedInputPerMillion: "0.0000000000005",
      cacheReadPerMillion: "0",
      cacheWritePerMillion: "0",
      outputPerMillion: "0",
    });
    const usage = normalizeHarnessTokenUsage({ inputTokens: 1, outputTokens: 0 });

    expect(estimateModelCost(costInput(usage), tinyPricing).amount.amount).toBe(
      "0.000000000000000001",
    );
  });

  it("rejects a mismatched route or out-of-window rate card", () => {
    const usage = normalizeHarnessTokenUsage({ inputTokens: 1, outputTokens: 1 });

    expect(() =>
      estimateModelCost(
        {
          ...costInput(usage),
          model: "another-model",
        },
        pricing,
      ),
    ).toThrow(/provider\/model/);
    expect(() =>
      estimateModelCost(
        {
          ...costInput(usage),
          requestStartedAt: "2026-08-24T00:00:00Z",
        },
        pricing,
      ),
    ).toThrow(/not effective/);
  });

  it.each([
    ["2026-08-24T00:59:59Z", "off-peak"],
    ["2026-08-24T01:00:00Z", "peak"],
    ["2026-08-24T03:59:59Z", "peak"],
    ["2026-08-24T04:00:00Z", "off-peak"],
    ["2026-08-24T06:00:00Z", "peak"],
    ["2026-08-24T09:59:59Z", "peak"],
    ["2026-08-24T10:00:00Z", "off-peak"],
    ["2026-08-23T02:00:00Z", "off-peak"],
  ] as const)("selects the DeepSeek band at %s", (requestStartedAt, band) => {
    expect(deepseekPricingBandAt(requestStartedAt)).toBe(band);
  });

  it("fails closed when a caller supplies the wrong or unknown pricing band rule", () => {
    const usage = normalizeHarnessTokenUsage({ inputTokens: 1, outputTokens: 1 });
    const peakPricing = defineModelPricing({
      ...pricing,
      pricingBand: "peak",
    });
    const unknownRulePricing = defineModelPricing({
      ...pricing,
      selectionRule: "unknown-rule-v1",
    });

    expect(() => estimateModelCost(costInput(usage), peakPricing)).toThrow(
      /does not match selected band/,
    );
    expect(() => estimateModelCost(costInput(usage), unknownRulePricing)).toThrow(
      /unsupported pricing selection rule/,
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe transient Harness token count %s",
    (inputTokens) => {
      expect(() =>
        normalizeHarnessTokenUsage({ inputTokens, outputTokens: 1 }),
      ).toThrow(/safe integer/);
    },
  );

  it("rejects reasoning counts larger than the containing output bucket", () => {
    expect(() =>
      normalizeHarnessTokenUsage({
        inputTokens: 1,
        outputTokens: 4,
        reasoningTokens: 5,
      }),
    ).toThrow(/cannot exceed/);
  });

  it("fails closed when a worst-case provider reservation exceeds frozen budgets", () => {
    const usd = currency("USD");
    const check = checkModelBudgetReservation(
      {
        providerRequests: tokenCount("1"),
        billableTokens: tokenCount("60000"),
        estimatedCost: { amount: nonNegativeDecimal("0.40"), currency: usd },
      },
      {
        providerRequests: tokenCount("1"),
        billableTokens: tokenCount("50000"),
        estimatedCost: { amount: nonNegativeDecimal("0.65"), currency: usd },
      },
      {
        maxProviderRequests: tokenCount("2"),
        maxBillableTokens: tokenCount("100000"),
        maxEstimatedCost: { amount: nonNegativeDecimal("1.00"), currency: usd },
      },
    );

    expect(check).toEqual({
      allowed: false,
      violations: ["billable_tokens", "estimated_cost"],
    });
  });
});
