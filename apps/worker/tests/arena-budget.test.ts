import { describe, expect, it } from "vitest";

import {
  checkArenaAttemptBudget,
  reserveGenerateOptions,
} from "../src/arena-budget.js";

describe("reserveGenerateOptions", () => {
  it("uses a conservative byte-level input bound and the exact output cap", () => {
    const reservation = reserveGenerateOptions({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      system: "只使用决策包",
      messages: [
        {
          id: "message-1" as never,
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "Allocate LULU, QQQ and SPY." }],
        },
      ],
      tools: [{
        name: "read_decision_packet",
        description: "Read immutable facts",
        parameters: { type: "object", properties: {} },
      }],
      maxTokens: 8_192,
    });

    expect(BigInt(reservation.maxInputTokens)).toBeGreaterThan(1_024n);
    expect(reservation.maxOutputTokens).toBe("8192");
    expect(reservation.maxBillableTokens).toBe(
      (BigInt(reservation.maxInputTokens) + 8_192n).toString(),
    );
  });

  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a non-positive or inexact maxTokens value: %s",
    (maxTokens) => {
      expect(() => reserveGenerateOptions({
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
        messages: [],
        ...(maxTokens === undefined ? {} : { maxTokens }),
      })).toThrow("maxTokens must be a positive safe integer");
    },
  );

  it("charges UTF-8 bytes rather than JavaScript code units", () => {
    const ascii = reserveGenerateOptions({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      system: "a".repeat(20),
      messages: [],
      maxTokens: 1,
    });
    const unicode = reserveGenerateOptions({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
      system: "界".repeat(20),
      messages: [],
      maxTokens: 1,
    });

    expect(BigInt(unicode.maxInputTokens)).toBeGreaterThan(
      BigInt(ascii.maxInputTokens),
    );
  });
});

describe("checkArenaAttemptBudget", () => {
  const quote = {
    pricingId: "price-1",
    pricingVersion: "v1",
    maximumEstimatedCostUsd: "0.25",
  };
  const reservation = {
    maxInputTokens: "20000",
    maxOutputTokens: "8000",
    maxBillableTokens: "28000",
  };

  it("reserves concurrent in-flight requests as held worst cases", () => {
    const check = checkArenaAttemptBudget({
      settledProviderRequests: "1",
      settledBillableTokens: "10000",
      settledEstimatedCostUsd: "0.1",
      heldReservations: [{
        maxBillableTokens: "28000",
        maximumEstimatedCostUsd: "0.25",
      }],
      reservation,
      quote,
      maxProviderRequests: "4",
      maxBillableTokens: "120000",
      maxEstimatedCostUsd: "1",
    });

    expect(check).toEqual({ allowed: true, violations: [] });
  });

  it("denies before dispatch when held reservations would exceed cost", () => {
    const check = checkArenaAttemptBudget({
      settledProviderRequests: "1",
      settledBillableTokens: "10000",
      settledEstimatedCostUsd: "0.6",
      heldReservations: [{
        maxBillableTokens: "28000",
        maximumEstimatedCostUsd: "0.25",
      }],
      reservation,
      quote,
      maxProviderRequests: "4",
      maxBillableTokens: "120000",
      maxEstimatedCostUsd: "1",
    });

    expect(check.allowed).toBe(false);
    expect(check.violations).toEqual(["estimated_cost"]);
  });

  it("denies before dispatch when request or token reservations overflow", () => {
    const check = checkArenaAttemptBudget({
      settledProviderRequests: "3",
      settledBillableTokens: "100000",
      settledEstimatedCostUsd: "0",
      heldReservations: [],
      reservation,
      quote,
      maxProviderRequests: "3",
      maxBillableTokens: "120000",
      maxEstimatedCostUsd: "1",
    });

    expect(check.allowed).toBe(false);
    expect(check.violations).toEqual(["provider_requests", "billable_tokens"]);
  });
});
