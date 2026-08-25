import { describe, expect, it } from "vitest";

import {
  quoteArenaAttempt,
  type ArenaPricingRow,
} from "../src/arena-pricing.js";

function pricingRow(overrides: Partial<ArenaPricingRow> = {}): ArenaPricingRow {
  return {
    pricing_id: "price-off-peak",
    pricing_version: "deepseek-v4-pro-0813-usd-2026-08-23-freeze-v1",
    pricing_band: "off-peak",
    selection_rule: "deepseek-weekday-utc-v1",
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
    currency: "USD",
    unit_tokens: "1000000",
    uncached_input_rate: "0.66",
    cache_read_rate: "0.022",
    cache_write_rate: "0.66",
    output_rate: "1.98",
    effective_from: "2026-08-23T00:00:00Z",
    effective_to: null,
    ...overrides,
  };
}

describe("quoteArenaAttempt", () => {
  it("prices the worst case as cache-miss input plus maximum output", () => {
    const quote = quoteArenaAttempt({
      row: pricingRow(),
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      requestStartedAt: "2026-08-23T12:00:00Z",
      maxInputTokens: "1000000",
      maxOutputTokens: "1000000",
    });

    expect(quote).toEqual({
      pricingId: "price-off-peak",
      pricingVersion: "deepseek-v4-pro-0813-usd-2026-08-23-freeze-v1",
      maximumEstimatedCostUsd: "2.64",
    });
  });

  it("rejects a price band that does not match request time", () => {
    expect(() => quoteArenaAttempt({
      row: pricingRow({ pricing_band: "peak" }),
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      requestStartedAt: "2026-08-23T12:00:00Z",
      maxInputTokens: "1",
      maxOutputTokens: "1",
    })).toThrow("does not match selected band");
  });

  it("rejects a non-USD or non-million-unit price card", () => {
    expect(() => quoteArenaAttempt({
      row: pricingRow({ currency: "CNY" }),
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      requestStartedAt: "2026-08-23T12:00:00Z",
      maxInputTokens: "1",
      maxOutputTokens: "1",
    })).toThrow("requires USD pricing");
    expect(() => quoteArenaAttempt({
      row: pricingRow({ unit_tokens: "1000" }),
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      requestStartedAt: "2026-08-23T12:00:00Z",
      maxInputTokens: "1",
      maxOutputTokens: "1",
    })).toThrow("one million token units");
  });
});
