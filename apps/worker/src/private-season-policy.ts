import { createHash } from "node:crypto";

import { canonicalFinancialJson } from "@twofold/core";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.]{0,11}$/;
const VENUE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ArenaExecutionRulebookV1 {
  readonly schema: "twofold.arena_execution_rulebook/v1";
  readonly executionModel: "SIMULATED_SLIPPAGE";
  readonly openReferenceMethod:
    "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE";
  readonly slippageBps: string;
  readonly fillPriceScale: string;
  readonly feeScheduleId: "futu_hk_us_equity_fixed_2026-08-23";
  readonly taxRulesetId:
    "cn_resident_direct_foreign_securities_strict_v1";
  readonly taxAllocationScale: string;
  readonly rankingNav: "LIQUIDATION_NAV";
}

export interface ArenaExecutionRulebookV2 {
  readonly schema: "twofold.arena_execution_rulebook/v2";
  readonly executionModel: "SIMULATED_MINUTE_PARTICIPATION";
  readonly openReferenceMethod:
    "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE";
  readonly maxParticipationBps: string;
  readonly slippageBps: string;
  readonly fillPriceScale: string;
  readonly feeScheduleId: "futu_hk_us_equity_fixed_2026-08-23";
  readonly taxRulesetId:
    "cn_resident_direct_foreign_securities_strict_v1";
  readonly taxAllocationScale: string;
  readonly rankingNav: "LIQUIDATION_NAV";
}

export type ArenaExecutionRulebook =
  | ArenaExecutionRulebookV1
  | ArenaExecutionRulebookV2;

export interface PrivateUniverseInstrument {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly instrumentType: "common_stock" | "etf";
  readonly primaryExchange: string;
  readonly issuerTaxResidency: string;
  readonly effectiveFrom: string;
  readonly issuer: string;
}

export interface PrivateSeasonPolicyConfig {
  readonly executionRulebook: ArenaExecutionRulebook;
  readonly universe: readonly PrivateUniverseInstrument[];
}

export interface RegisterArenaExecutionRulebookArguments {
  readonly p_idempotency_key: string;
  readonly p_season_id: string;
  readonly p_rulebook_canonical_json: string;
  readonly p_rulebook_sha256: string;
  readonly p_recorded_by: string;
}

export interface RegisterInstrumentArguments {
  readonly p_idempotency_key: string;
  readonly p_instrument_id: string;
  readonly p_instrument_type: "common_stock" | "etf";
  readonly p_primary_exchange: string;
  readonly p_trading_currency: "USD";
  readonly p_issuer_tax_residency: string;
  readonly p_metadata: { readonly issuer: string };
  readonly p_recorded_by: string;
}

export interface RegisterInstrumentSymbolArguments {
  readonly p_idempotency_key: string;
  readonly p_instrument_id: string;
  readonly p_symbol: string;
  readonly p_exchange: string;
  readonly p_effective_from: string;
  readonly p_effective_to: null;
  readonly p_metadata: {
    readonly source: "competition-opening-policy";
  };
  readonly p_recorded_by: string;
}

export interface UniverseRegistration {
  readonly instrument: RegisterInstrumentArguments;
  readonly symbol: RegisterInstrumentSymbolArguments;
}

export function buildExecutionRulebookRegistration(input: {
  readonly seasonCode: string;
  readonly seasonId: string;
  readonly recordedBy: string;
  readonly rulebook: ArenaExecutionRulebook;
}): RegisterArenaExecutionRulebookArguments {
  const seasonCode = identity(input.seasonCode, "seasonCode");
  const seasonId = uuid(input.seasonId, "seasonId");
  const recordedBy = identity(input.recordedBy, "recordedBy");
  validateRulebook(input.rulebook);
  const canonicalJson = canonicalFinancialJson(input.rulebook);
  return Object.freeze({
    p_idempotency_key: `${seasonCode}:execution-rulebook`,
    p_season_id: seasonId,
    p_rulebook_canonical_json: canonicalJson,
    p_rulebook_sha256: sha256(canonicalJson),
    p_recorded_by: recordedBy,
  });
}

export function buildUniverseRegistrations(
  universe: readonly PrivateUniverseInstrument[],
  recordedByInput: string,
): readonly UniverseRegistration[] {
  if (!Array.isArray(universe) || universe.length === 0) {
    throw new TypeError("universe must contain at least one instrument");
  }
  const recordedBy = identity(recordedByInput, "recordedBy");
  const instrumentIds = new Set<string>();
  const listings = new Set<string>();
  return Object.freeze(universe.map((entry, index) => {
    const instrumentId = uuid(entry.instrumentId, `universe[${index}].instrumentId`);
    const symbol = pattern(
      entry.symbol,
      SYMBOL_PATTERN,
      `universe[${index}].symbol`,
    );
    const exchange = pattern(
      entry.primaryExchange,
      VENUE_PATTERN,
      `universe[${index}].primaryExchange`,
    );
    if (entry.instrumentType !== "common_stock" && entry.instrumentType !== "etf") {
      throw new TypeError(`universe[${index}].instrumentType is unsupported`);
    }
    const residency = pattern(
      entry.issuerTaxResidency,
      /^[A-Z]{2}$/,
      `universe[${index}].issuerTaxResidency`,
    );
    const effectiveFrom = pattern(
      entry.effectiveFrom,
      DATE_PATTERN,
      `universe[${index}].effectiveFrom`,
    );
    if (Number.isNaN(Date.parse(`${effectiveFrom}T00:00:00.000Z`))) {
      throw new TypeError(`universe[${index}].effectiveFrom is not a valid date`);
    }
    const issuer = identity(entry.issuer, `universe[${index}].issuer`);
    const listing = `${exchange}:${symbol}`;
    if (instrumentIds.has(instrumentId) || listings.has(listing)) {
      throw new TypeError("universe contains a duplicate instrument or listing");
    }
    instrumentIds.add(instrumentId);
    listings.add(listing);
    return Object.freeze({
      instrument: Object.freeze({
        p_idempotency_key: `instrument:${listing}`,
        p_instrument_id: instrumentId,
        p_instrument_type: entry.instrumentType,
        p_primary_exchange: exchange,
        p_trading_currency: "USD" as const,
        p_issuer_tax_residency: residency,
        p_metadata: Object.freeze({ issuer }),
        p_recorded_by: recordedBy,
      }),
      symbol: Object.freeze({
        p_idempotency_key:
          `instrument-symbol:${listing}:${effectiveFrom}`,
        p_instrument_id: instrumentId,
        p_symbol: symbol,
        p_exchange: exchange,
        p_effective_from: effectiveFrom,
        p_effective_to: null,
        p_metadata: Object.freeze({
          source: "competition-opening-policy" as const,
        }),
        p_recorded_by: recordedBy,
      }),
    });
  }));
}

function validateRulebook(value: ArenaExecutionRulebook): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("executionRulebook must be an object");
  }
  const commonKeys = [
    "executionModel", "feeScheduleId", "fillPriceScale",
    "openReferenceMethod", "rankingNav", "schema", "slippageBps",
    "taxAllocationScale", "taxRulesetId",
  ];
  const expectedKeys = value.schema === "twofold.arena_execution_rulebook/v2"
    ? [...commonKeys, "maxParticipationBps"].sort()
    : commonKeys;
  if (
    Object.keys(value).sort().length !== expectedKeys.length
    || Object.keys(value).sort().some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError("executionRulebook must contain exactly its versioned fields");
  }
  if (
    value.schema !== "twofold.arena_execution_rulebook/v1"
    && value.schema !== "twofold.arena_execution_rulebook/v2"
  ) {
    throw new TypeError("executionRulebook.schema is unsupported");
  }
  if (value.schema === "twofold.arena_execution_rulebook/v1") {
    if (value.executionModel !== "SIMULATED_SLIPPAGE") {
      throw new TypeError("executionRulebook.executionModel is unsupported");
    }
    if (value.openReferenceMethod !== "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE") {
      throw new TypeError("executionRulebook.openReferenceMethod is unsupported");
    }
  } else {
    if (value.executionModel !== "SIMULATED_MINUTE_PARTICIPATION") {
      throw new TypeError("executionRulebook.executionModel is unsupported");
    }
    if (
      value.openReferenceMethod
      !== "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE"
    ) {
      throw new TypeError("executionRulebook.openReferenceMethod is unsupported");
    }
    decimalInteger(
      value.maxParticipationBps,
      1,
      10_000,
      "maxParticipationBps",
    );
  }
  decimalInteger(value.slippageBps, 0, 10_000, "slippageBps");
  decimalInteger(value.fillPriceScale, 0, 12, "fillPriceScale");
  if (value.feeScheduleId !== "futu_hk_us_equity_fixed_2026-08-23") {
    throw new TypeError("executionRulebook.feeScheduleId is unsupported");
  }
  if (value.taxRulesetId !== "cn_resident_direct_foreign_securities_strict_v1") {
    throw new TypeError("executionRulebook.taxRulesetId is unsupported");
  }
  decimalInteger(value.taxAllocationScale, 0, 12, "taxAllocationScale");
  if (value.rankingNav !== "LIQUIDATION_NAV") {
    throw new TypeError("executionRulebook.rankingNav is unsupported");
  }
}

function decimalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): string {
  const parsed = pattern(value, /^(0|[1-9][0-9]*)$/, field);
  const numeric = Number(parsed);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new TypeError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function pattern(value: unknown, expected: RegExp, field: string): string {
  const parsed = identity(value, field);
  if (!expected.test(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function uuid(value: unknown, field: string): string {
  return pattern(value, UUID_PATTERN, field);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
