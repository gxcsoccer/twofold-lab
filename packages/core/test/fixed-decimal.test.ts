import { describe, expect, it } from "vitest";

import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  multiplyDecimals,
  normalizeDecimal,
  roundDecimal,
  subtractDecimals,
  sumDecimals,
} from "../src/fixed-decimal.js";

describe("fixed decimal arithmetic", () => {
  it("normalizes without crossing a JavaScript number boundary", () => {
    expect(normalizeDecimal("9007199254740993.1200")).toBe("9007199254740993.12");
    expect(normalizeDecimal("-0.000")).toBe("0");
  });

  it("adds, subtracts, and compares different scales exactly", () => {
    expect(addDecimals("0.1", "0.02")).toBe("0.12");
    expect(subtractDecimals("1002.29", "1000")).toBe("2.29");
    expect(sumDecimals(["0.1", "0.2", "0.7"])).toBe("1");
    expect(compareDecimals("1.00", "1")).toBe(0);
  });

  it("multiplies and divides with explicit HALF_UP rounding", () => {
    expect(multiplyDecimals("100", "0.003")).toBe("0.3");
    expect(divideDecimals("1", "8", 2)).toBe("0.13");
    expect(divideDecimals("-1", "8", 2)).toBe("-0.13");
  });

  it("rounds positive and negative ties away from zero", () => {
    expect(roundDecimal("1.005", 2)).toBe("1.01");
    expect(roundDecimal("-1.005", 2)).toBe("-1.01");
    expect(roundDecimal("1.009", 2, "DOWN")).toBe("1");
  });

  it("fails closed on unsupported input", () => {
    expect(() => normalizeDecimal("1e3")).toThrow(TypeError);
    expect(() => divideDecimals("1", "0", 2)).toThrow("Cannot divide by zero");
    expect(() => roundDecimal("1", -1)).toThrow(RangeError);
  });
});
