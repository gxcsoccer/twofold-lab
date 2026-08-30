import { describe, expect, it } from "vitest";

import { arenaRootMaxTokens } from "../src/arena-root-output-budget.js";

describe("Arena root output budget", () => {
  it("scales with the frozen decision surface and remains bounded", () => {
    expect(arenaRootMaxTokens(3)).toBe(8_192);
    expect(arenaRootMaxTokens(32)).toBe(8_192);
    expect(arenaRootMaxTokens(100)).toBe(16_896);
    expect(arenaRootMaxTokens(200)).toBe(29_696);
    expect(arenaRootMaxTokens(500)).toBe(32_768);
  });

  it("rejects an invalid decision universe size", () => {
    expect(() => arenaRootMaxTokens(0)).toThrow(/symbol count/);
    expect(() => arenaRootMaxTokens(1.5)).toThrow(/symbol count/);
  });
});
