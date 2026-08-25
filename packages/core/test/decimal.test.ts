import { describe, expect, it } from "vitest";

import {
  assertJsonValue,
  compareSequences,
  decimal,
  money,
  nextSequence,
  sequence,
} from "../src/index.js";

describe("decimal-safe boundary values", () => {
  it("keeps money as canonical strings through JSON serialization", () => {
    const value = money("9007199254740993.00000001", "USD");

    expect(JSON.parse(JSON.stringify(value))).toEqual({
      amount: "9007199254740993.00000001",
      currency: "USD",
    });
  });

  it.each(["1e3", "+1", "01.00", ".5", "NaN", "Infinity", "1."])(
    "rejects non-canonical decimal %s",
    (value) => {
      expect(() => decimal(value)).toThrow(TypeError);
    },
  );

  it("rejects JavaScript numbers anywhere in an event payload", () => {
    expect(() =>
      assertJsonValue({ amount: "10.50", nested: { unsafe: 10.5 } }),
    ).toThrow(/decimal string/);
  });

  it("rejects class instances that do not have plain JSON object semantics", () => {
    expect(() => assertJsonValue({ timestamp: new Date() })).toThrow(/plain JSON/);
  });

  it("increments and compares arbitrarily long string sequences", () => {
    const current = sequence("99999999999999999999");
    const next = nextSequence(current);

    expect(next).toBe("100000000000000000000");
    expect(compareSequences(current, next)).toBe(-1);
  });
});
