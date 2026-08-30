import { describe, expect, it } from "vitest";

import { arenaDecisionMaxBillableTokens } from "../src/arena-decision-budget.js";

describe("arenaDecisionMaxBillableTokens", () => {
  it("keeps the small-universe floor and scales with the frozen decision surface", () => {
    expect(arenaDecisionMaxBillableTokens(3)).toBe("120000");
    expect(arenaDecisionMaxBillableTokens(32)).toBe("120000");
    expect(arenaDecisionMaxBillableTokens(100)).toBe("259264");
    expect(arenaDecisionMaxBillableTokens(200)).toBe("464064");
    expect(arenaDecisionMaxBillableTokens(500)).toBe("512000");
  });

  it("rejects a non-positive or inexact symbol count", () => {
    expect(() => arenaDecisionMaxBillableTokens(0)).toThrow(/symbol count/);
    expect(() => arenaDecisionMaxBillableTokens(1.5)).toThrow(/symbol count/);
  });
});
