import { describe, expect, it } from "vitest";

import {
  createDeterministicBaselinePolicy,
  deriveDeterministicBaselineDecision,
} from "../src/deterministic-baseline.js";

const LIQUID_100_SAMPLE = ["AAPL", "LULU", "MSFT", "NVDA"];

const holdGenesis = createDeterministicBaselinePolicy({
  policyId: "hold-genesis",
  rule: "HOLD_GENESIS",
  symbol: null,
});

describe("deterministic baseline policy", () => {
  it("freezes the policy as content-addressed canonical bytes", () => {
    expect(holdGenesis.policyCanonicalJson).toBe(
      '{"policyId":"hold-genesis","rule":"HOLD_GENESIS",'
      + '"schema":"twofold.deterministic_baseline_policy/v1","symbol":null}',
    );
    expect(holdGenesis.policySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins the hold-genesis content address quoted in the runbook", () => {
    // docs/arena-runbook.md publishes this as the entrant bundleSha256 an
    // operator copies into a Season config. A drift here silently invalidates
    // every registered hold baseline, so the value is pinned rather than
    // recomputed by the test.
    expect(holdGenesis.policySha256).toBe(
      "14a7e54b2244e417e48b653a27742ce41038855a306e8b4ad2ff1da7b6016b39",
    );
  });

  it("gives the same policy the same identity on every rebuild", () => {
    const rebuilt = createDeterministicBaselinePolicy({
      policyId: "hold-genesis",
      rule: "HOLD_GENESIS",
      symbol: null,
    });
    expect(rebuilt.policySha256).toBe(holdGenesis.policySha256);
  });

  it("separates two baselines that differ only by symbol", () => {
    const spy = createDeterministicBaselinePolicy({
      policyId: "all-in-spy",
      rule: "ALL_IN_SYMBOL",
      symbol: "SPY",
    });
    const qqq = createDeterministicBaselinePolicy({
      policyId: "all-in-qqq",
      rule: "ALL_IN_SYMBOL",
      symbol: "QQQ",
    });
    expect(spy.policySha256).not.toBe(qqq.policySha256);
  });

  it("rejects a hold policy that names a symbol", () => {
    expect(() => createDeterministicBaselinePolicy({
      policyId: "hold-genesis",
      rule: "HOLD_GENESIS",
      symbol: "SPY",
    })).toThrow(/must not name a symbol/);
  });

  it("rejects an all-in policy with no symbol", () => {
    expect(() => createDeterministicBaselinePolicy({
      policyId: "all-in-spy",
      rule: "ALL_IN_SYMBOL",
      symbol: null,
    })).toThrow(/symbol/);
  });
});

describe("deterministic baseline decision", () => {
  it("targets the genesis holding at the full weight with no cash", () => {
    const decision = deriveDeterministicBaselineDecision({
      policy: holdGenesis,
      genesisSymbol: "LULU",
      priceableSymbols: LIQUID_100_SAMPLE,
    });
    expect(decision.targets).toEqual([
      { symbol: "LULU", targetWeightBps: "10000" },
    ]);
    expect(decision.cashWeightBps).toBe("0");
  });

  it("reproduces the identical target in every Round", () => {
    const first = deriveDeterministicBaselineDecision({
      policy: holdGenesis,
      genesisSymbol: "LULU",
      priceableSymbols: LIQUID_100_SAMPLE,
    });
    const later = deriveDeterministicBaselineDecision({
      policy: holdGenesis,
      genesisSymbol: "LULU",
      priceableSymbols: [...LIQUID_100_SAMPLE].reverse(),
    });
    expect(later).toEqual(first);
  });

  it("switches an all-in baseline into its own named symbol", () => {
    const decision = deriveDeterministicBaselineDecision({
      policy: createDeterministicBaselinePolicy({
        policyId: "all-in-nvda",
        rule: "ALL_IN_SYMBOL",
        symbol: "NVDA",
      }),
      genesisSymbol: "LULU",
      priceableSymbols: LIQUID_100_SAMPLE,
    });
    expect(decision.targets).toEqual([
      { symbol: "NVDA", targetWeightBps: "10000" },
    ]);
  });

  it("fails closed when the sealed snapshot cannot price the target", () => {
    expect(() => deriveDeterministicBaselineDecision({
      policy: createDeterministicBaselinePolicy({
        policyId: "all-in-spy",
        rule: "ALL_IN_SYMBOL",
        symbol: "SPY",
      }),
      genesisSymbol: "LULU",
      priceableSymbols: LIQUID_100_SAMPLE,
    })).toThrow(/cannot price/);
  });

  it("fails closed when the genesis symbol is not priceable", () => {
    expect(() => deriveDeterministicBaselineDecision({
      policy: holdGenesis,
      genesisSymbol: "LULU",
      priceableSymbols: ["AAPL", "MSFT"],
    })).toThrow(/cannot price/);
  });

  it("rejects a duplicated priceable symbol set", () => {
    expect(() => deriveDeterministicBaselineDecision({
      policy: holdGenesis,
      genesisSymbol: "LULU",
      priceableSymbols: ["LULU", "LULU"],
    })).toThrow(/duplicate symbol/);
  });
});
