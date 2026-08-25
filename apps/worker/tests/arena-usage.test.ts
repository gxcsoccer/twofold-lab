import { describe, expect, it } from "vitest";

import { tokenCount } from "@twofold/core";

import { emptyArenaUsage, type ArenaUsage } from "../src/arena-types.js";
import {
  addDecimalStrings,
  addEstimatedCost,
  addUsageTokens,
  costStatusForAttempts,
  sumArenaUsage,
} from "../src/arena-usage.js";

function usage(overrides: Partial<ArenaUsage>): ArenaUsage {
  return {
    ...emptyArenaUsage(),
    ...overrides,
    pricingVersions: [...(overrides.pricingVersions ?? [])],
  };
}

describe("Arena usage accounting", () => {
  it("conserves disjoint token buckets without billing reasoning twice", () => {
    const total = emptyArenaUsage();

    addUsageTokens(total, {
      uncachedInputTokens: tokenCount("100"),
      cacheReadTokens: tokenCount("20"),
      cacheWriteTokens: tokenCount("5"),
      outputTokens: tokenCount("30"),
      reasoningTokens: tokenCount("18"),
    });
    addUsageTokens(total, {
      uncachedInputTokens: tokenCount("7"),
      cacheReadTokens: tokenCount("3"),
      cacheWriteTokens: tokenCount("0"),
      outputTokens: tokenCount("11"),
      reasoningTokens: tokenCount("4"),
    });

    expect(total).toMatchObject({
      uncachedInputTokens: "107",
      cacheReadTokens: "23",
      cacheWriteTokens: "5",
      outputTokens: "41",
      reasoningTokens: "22",
      totalBillableTokens: "176",
    });
    expect(BigInt(total.totalBillableTokens)).toBe(
      BigInt(total.uncachedInputTokens)
        + BigInt(total.cacheReadTokens)
        + BigInt(total.cacheWriteTokens)
        + BigInt(total.outputTokens),
    );
    expect(total.totalBillableTokens).not.toBe("198");
  });

  it("adds exact decimal costs and keeps pricing versions unique and sorted", () => {
    const total = emptyArenaUsage();

    addEstimatedCost(total, "0.000000000000000009", "deepseek-off-peak-v1");
    addEstimatedCost(total, "1.230000000000000001", "deepseek-peak-v1");
    addEstimatedCost(total, null, "deepseek-off-peak-v1");

    expect(total.estimatedCostUsd).toBe("1.23000000000000001");
    expect(total.pricingVersions).toEqual([
      "deepseek-off-peak-v1",
      "deepseek-peak-v1",
    ]);
    expect(addDecimalStrings("999999999999999999.9", "0.1")).toBe(
      "1000000000000000000",
    );
  });

  it("aggregates unpriced and estimated requests as partial without losing totals", () => {
    const estimated = usage({
      providerRequestCount: "2",
      uncachedInputTokens: "100",
      cacheReadTokens: "20",
      cacheWriteTokens: "5",
      outputTokens: "30",
      reasoningTokens: "12",
      totalBillableTokens: "155",
      estimatedCostUsd: "0.123",
      costStatus: "ESTIMATED",
      pricingVersions: ["deepseek-peak-v1"],
    });
    const unpriced = usage({
      providerRequestCount: "1",
      uncachedInputTokens: "50",
      cacheReadTokens: "10",
      outputTokens: "20",
      reasoningTokens: "7",
      totalBillableTokens: "80",
      costStatus: "UNPRICED",
    });

    const total = sumArenaUsage([estimated, unpriced, emptyArenaUsage()]);

    expect(total).toEqual({
      providerRequestCount: "3",
      uncachedInputTokens: "150",
      cacheReadTokens: "30",
      cacheWriteTokens: "5",
      outputTokens: "50",
      reasoningTokens: "19",
      totalBillableTokens: "235",
      estimatedCostUsd: "0.123",
      costStatus: "PARTIAL",
      pricingVersions: ["deepseek-peak-v1"],
    });
    expect(BigInt(total.totalBillableTokens)).toBe(
      BigInt(total.uncachedInputTokens)
        + BigInt(total.cacheReadTokens)
        + BigInt(total.cacheWriteTokens)
        + BigInt(total.outputTokens),
    );
    expect(sumArenaUsage([unpriced, emptyArenaUsage()]).costStatus).toBe(
      "UNPRICED",
    );
    expect(costStatusForAttempts(["unpriced", "unavailable"])).toBe("PARTIAL");
    expect(costStatusForAttempts([])).toBe("UNAVAILABLE");
  });

  it("preserves a node-level partial status in the tree aggregate", () => {
    const partial = usage({
      providerRequestCount: "2",
      uncachedInputTokens: "10",
      outputTokens: "5",
      totalBillableTokens: "15",
      estimatedCostUsd: "0.01",
      costStatus: "PARTIAL",
      pricingVersions: ["deepseek-flat-v1"],
    });

    expect(sumArenaUsage([partial, emptyArenaUsage()]).costStatus).toBe(
      "PARTIAL",
    );
  });
});
