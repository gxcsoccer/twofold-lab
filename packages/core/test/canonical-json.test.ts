import { describe, expect, it } from "vitest";

import { canonicalFinancialJson } from "../src/canonical-json.js";

describe("canonical financial JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalFinancialJson({ z: [{ b: "2", a: "1" }], a: true })).toBe(
      '{"a":true,"z":[{"a":"1","b":"2"}]}',
    );
  });

  it.each([1, 1n, undefined, { amount: 1 }, ["1", undefined]])(
    "rejects non-JSON or numeric financial value %#",
    (value) => {
      expect(() => canonicalFinancialJson(value)).toThrow(
        "Financial manifests may contain only",
      );
    },
  );

  it("rejects cycles and non-plain objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalFinancialJson(circular)).toThrow("circular references");
    expect(() => canonicalFinancialJson(new Date())).toThrow("plain objects");
  });
});
