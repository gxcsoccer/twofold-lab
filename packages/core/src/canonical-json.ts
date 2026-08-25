/**
 * Deterministic JSON for financial manifests. Decimal values must already be
 * strings; accepting a JavaScript number here would reintroduce binary-float
 * ambiguity at a hashing/idempotency boundary.
 */
export function canonicalFinancialJson(value: unknown): string {
  return encodeCanonicalValue(value, new Set<object>());
}

function encodeCanonicalValue(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(
      "Financial manifests may contain only null, strings, booleans, arrays, and plain objects",
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError("Financial manifests must not contain circular references");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry) => encodeCanonicalValue(entry, ancestors))
        .join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Financial manifest objects must be plain objects");
    }
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => (
        `${JSON.stringify(key)}:${encodeCanonicalValue(record[key], ancestors)}`
      ))
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
