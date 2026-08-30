import { describe, expect, it } from "vitest";

import {
  buildExecutionRulebookRegistration,
  buildUniverseRegistrations,
  type PrivateSeasonPolicyConfig,
} from "../src/private-season-policy.js";

const policy = Object.freeze({
  executionRulebook: {
    schema: "twofold.arena_execution_rulebook/v1",
    executionModel: "SIMULATED_SLIPPAGE",
    openReferenceMethod: "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE",
    slippageBps: "5",
    fillPriceScale: "8",
    feeScheduleId: "futu_hk_us_equity_fixed_2026-08-23",
    taxRulesetId: "cn_resident_direct_foreign_securities_strict_v1",
    taxAllocationScale: "12",
    rankingNav: "LIQUIDATION_NAV",
  },
  universe: [{
    instrumentId: "122dd8f9-709a-5652-a27c-a3b5c32755de",
    symbol: "LULU",
    instrumentType: "common_stock",
    primaryExchange: "NASDAQ",
    issuerTaxResidency: "US",
    effectiveFrom: "2007-07-27",
    issuer: "lululemon athletica inc.",
  }, {
    instrumentId: "1c198b76-be20-5a0c-87cf-58b0bf1ee36d",
    symbol: "QQQ",
    instrumentType: "etf",
    primaryExchange: "NASDAQ",
    issuerTaxResidency: "US",
    effectiveFrom: "1999-03-10",
    issuer: "Invesco QQQ Trust",
  }],
} as const satisfies PrivateSeasonPolicyConfig);

describe("private Season policy registration", () => {
  it("pins canonical rulebook bytes and digest independently of config key order", () => {
    expect(buildExecutionRulebookRegistration({
      seasonCode: "private-arena-s1",
      seasonId: "286387f5-c8b8-5b50-98c5-6cf6027e547f",
      recordedBy: "twofold-worker",
      rulebook: policy.executionRulebook,
    })).toEqual({
      p_idempotency_key: "private-arena-s1:execution-rulebook",
      p_season_id: "286387f5-c8b8-5b50-98c5-6cf6027e547f",
      p_rulebook_canonical_json:
        '{"executionModel":"SIMULATED_SLIPPAGE","feeScheduleId":"futu_hk_us_equity_fixed_2026-08-23","fillPriceScale":"8","openReferenceMethod":"ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE","rankingNav":"LIQUIDATION_NAV","schema":"twofold.arena_execution_rulebook/v1","slippageBps":"5","taxAllocationScale":"12","taxRulesetId":"cn_resident_direct_foreign_securities_strict_v1"}',
      p_rulebook_sha256:
        "dc394fe13e8a1562b03b4f0b3b22aac608a09c2ceb39b07a32b4434eb20bc94a",
      p_recorded_by: "twofold-worker",
    });
  });

  it("builds one exact instrument and symbol registration per universe member", () => {
    expect(buildUniverseRegistrations(
      policy.universe,
      "twofold-worker",
    )).toEqual([{
      instrument: {
        p_idempotency_key: "instrument:NASDAQ:LULU",
        p_instrument_id: "122dd8f9-709a-5652-a27c-a3b5c32755de",
        p_instrument_type: "common_stock",
        p_primary_exchange: "NASDAQ",
        p_trading_currency: "USD",
        p_issuer_tax_residency: "US",
        p_metadata: { issuer: "lululemon athletica inc." },
        p_recorded_by: "twofold-worker",
      },
      symbol: {
        p_idempotency_key: "instrument-symbol:NASDAQ:LULU:2007-07-27",
        p_instrument_id: "122dd8f9-709a-5652-a27c-a3b5c32755de",
        p_symbol: "LULU",
        p_exchange: "NASDAQ",
        p_effective_from: "2007-07-27",
        p_effective_to: null,
        p_metadata: { source: "competition-opening-policy" },
        p_recorded_by: "twofold-worker",
      },
    }, {
      instrument: {
        p_idempotency_key: "instrument:NASDAQ:QQQ",
        p_instrument_id: "1c198b76-be20-5a0c-87cf-58b0bf1ee36d",
        p_instrument_type: "etf",
        p_primary_exchange: "NASDAQ",
        p_trading_currency: "USD",
        p_issuer_tax_residency: "US",
        p_metadata: { issuer: "Invesco QQQ Trust" },
        p_recorded_by: "twofold-worker",
      },
      symbol: {
        p_idempotency_key: "instrument-symbol:NASDAQ:QQQ:1999-03-10",
        p_instrument_id: "1c198b76-be20-5a0c-87cf-58b0bf1ee36d",
        p_symbol: "QQQ",
        p_exchange: "NASDAQ",
        p_effective_from: "1999-03-10",
        p_effective_to: null,
        p_metadata: { source: "competition-opening-policy" },
        p_recorded_by: "twofold-worker",
      },
    }]);
  });

  it("admits a versioned minute-participation rulebook without weakening v1", () => {
    const rulebook = {
      schema: "twofold.arena_execution_rulebook/v2",
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      openReferenceMethod: "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
      maxParticipationBps: "100",
      slippageBps: "5",
      fillPriceScale: "8",
      feeScheduleId: "futu_hk_us_equity_fixed_2026-08-23",
      taxRulesetId: "cn_resident_direct_foreign_securities_strict_v1",
      taxAllocationScale: "12",
      rankingNav: "LIQUIDATION_NAV",
    } as const;

    const registration = buildExecutionRulebookRegistration({
      seasonCode: "private-arena-s2",
      seasonId: "386387f5-c8b8-5b50-98c5-6cf6027e547f",
      recordedBy: "twofold-worker",
      rulebook,
    });

    expect(JSON.parse(registration.p_rulebook_canonical_json)).toEqual(rulebook);
    expect(registration.p_rulebook_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => buildExecutionRulebookRegistration({
      seasonCode: "private-arena-s2",
      seasonId: "386387f5-c8b8-5b50-98c5-6cf6027e547f",
      recordedBy: "twofold-worker",
      rulebook: { ...rulebook, maxParticipationBps: "0" },
    })).toThrow("maxParticipationBps");
  });

  it("rejects an unsupported private policy before any RPC can run", () => {
    expect(() => buildExecutionRulebookRegistration({
      seasonCode: "private-arena-s1",
      seasonId: "286387f5-c8b8-5b50-98c5-6cf6027e547f",
      recordedBy: "twofold-worker",
      rulebook: { ...policy.executionRulebook, slippageBps: "5.0" } as never,
    })).toThrow("slippageBps");
    expect(() => buildUniverseRegistrations(
      [{ ...policy.universe[0]!, symbol: "lulu" }],
      "twofold-worker",
    )).toThrow("symbol");
  });
});
