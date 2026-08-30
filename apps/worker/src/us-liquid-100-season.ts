import { createHash } from "node:crypto";

import type { TwoStageCycleCalendar } from "./alpaca-calendar.js";
import type { LiquidUniverseFreezeArtifact } from "./liquid-universe.js";
import type {
  ArenaExecutionRulebookV2,
  PrivateUniverseInstrument,
} from "./private-season-policy.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LULU_INSTRUMENT_ID = "122dd8f9-709a-5652-a27c-a3b5c32755de";

export interface AgentBundleReference {
  readonly bundleId: string;
  readonly bundleSha256: string;
}

export interface UsLiquid100SeasonConfig {
  readonly schema: "twofold.private_controlled_lab_config/v1";
  readonly season: {
    readonly seasonId: string;
    readonly seasonCode: string;
    readonly displayName: string;
    readonly opensAt: string;
    readonly closesAt: string;
    readonly decisionCadence: "US_EQUITY_DAILY_AFTER_CLOSE";
    readonly marketTimezone: "America/New_York";
    readonly openingSnapshotId: string;
    readonly openingSessionDate: string;
    readonly openingInstrumentId: typeof LULU_INSTRUMENT_ID;
    readonly openingSymbol: "LULU";
    readonly openingQuantity: "150";
    readonly openingHolding: "150 LULU";
    readonly openingCash: "0";
    readonly genesisId: string;
    readonly fxSourceUrl: string;
  };
  readonly executionRulebook: ArenaExecutionRulebookV2;
  readonly decisionUniverse: {
    readonly schema: "twofold.liquid_universe_reference/v1";
    readonly artifactPath: string;
    readonly artifactSha256: string;
    readonly memberCount: "100";
  };
  readonly universe: readonly PrivateUniverseInstrument[];
  readonly rounds: readonly [{
    readonly roundId: string;
    readonly roundIndex: "1";
    readonly decisionSnapshotId: string;
    readonly decisionSessionDate: string;
    readonly decisionWindowOpensAt: string;
    readonly decisionWindowClosesAt: string;
    readonly calendarStartDate: string;
    readonly calendarEndDate: string;
  }];
  readonly entrants: readonly [{
    readonly entrantId: string;
    readonly entrantCode: "twofold";
    readonly runId: string;
    readonly bundleId: string;
    readonly bundleSha256: string;
    readonly presetId: "twofold";
    readonly provider: "deepseek-official";
    readonly model: "deepseek-v4-pro";
    readonly executionClass: "ROOT_ONLY";
    readonly track: "MAIN_ARENA";
  }, {
    readonly entrantId: string;
    readonly entrantCode: "twofold-orchestrator";
    readonly runId: string;
    readonly bundleId: string;
    readonly bundleSha256: string;
    readonly presetId: "twofold-orchestrator";
    readonly provider: "deepseek-official";
    readonly model: "deepseek-v4-pro";
    readonly executionClass: "ORCHESTRATED";
    readonly track: "MAIN_ARENA";
  }];
}

export function buildUsLiquid100SeasonConfig(input: {
  readonly seasonCode: string;
  readonly displayName: string;
  readonly seasonOpensAt?: string;
  readonly artifact: LiquidUniverseFreezeArtifact;
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly snapshotId: string;
  readonly decisionAvailableAt: string;
  readonly calendar: TwoStageCycleCalendar;
  readonly bundles: {
    readonly twofold: AgentBundleReference;
    readonly twofoldOrchestrator: AgentBundleReference;
  };
}): UsLiquid100SeasonConfig {
  const seasonCode = seasonIdentity(input.seasonCode, "seasonCode");
  const displayName = displayIdentity(input.displayName, "displayName");
  const artifact = input.artifact;
  if (
    artifact.schema !== "twofold.liquid_universe_freeze/v1"
    || artifact.name !== "US Liquid 100"
    || artifact.policy.name !== "US Liquid 100"
    || artifact.policy.size !== "100"
    || artifact.members.length !== 100
  ) throw new TypeError("US Liquid 100 freeze must contain exactly 100 members");
  if (
    artifact.asOfSessionDate !== input.calendar.decisionSessionDate
    || input.calendar.schema !== "twofold.two_stage_cycle_calendar/v1"
  ) throw new TypeError("universe and Round decision session do not match");
  const symbols = artifact.members.map((member) => member.symbol);
  if (
    new Set(symbols).size !== 100
    || !symbols.includes("LULU")
    || artifact.policy.mandatorySymbols.length !== 1
    || artifact.policy.mandatorySymbols[0] !== "LULU"
  ) throw new TypeError("US Liquid 100 must contain the eligible opening holding");
  const lulu = artifact.members.find((member) => member.symbol === "LULU")!;
  if (lulu.instrumentId !== LULU_INSTRUMENT_ID) {
    throw new TypeError("LULU stable instrument identity changed");
  }
  const artifactPath = relativeArtifactPath(input.artifactPath);
  const artifactSha256 = sha256(input.artifactSha256, "artifactSha256");
  const snapshotId = uuid(input.snapshotId, "snapshotId");
  const decisionAvailableAt = timestamp(
    input.decisionAvailableAt,
    "decisionAvailableAt",
  );
  const requestedSeasonOpensAt = input.seasonOpensAt === undefined
    ? artifact.frozenAt
    : timestamp(input.seasonOpensAt, "seasonOpensAt");
  const seasonOpensAt = latestTimestamp(
    artifact.frozenAt,
    requestedSeasonOpensAt,
  );
  validateBundle(input.bundles.twofold, "bundles.twofold");
  validateBundle(input.bundles.twofoldOrchestrator, "bundles.twofoldOrchestrator");
  const decisionWindowClosesAt = new Date(
    Date.parse(input.calendar.s1OpenAt) - 15 * 60_000,
  ).toISOString();
  const decisionWindowOpensAt = latestTimestamp(
    seasonOpensAt,
    decisionAvailableAt,
  );
  if (Date.parse(decisionWindowOpensAt) >= Date.parse(decisionWindowClosesAt)) {
    throw new RangeError("universe froze after the first decision deadline");
  }
  const seasonId = deterministicUuid(`${seasonCode}:season`);
  const roundId = deterministicUuid(`${seasonCode}:round:1`);
  const executionRulebook: ArenaExecutionRulebookV2 = Object.freeze({
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
  });
  const universe = artifact.members.map((member): PrivateUniverseInstrument =>
    Object.freeze({
      instrumentId: member.instrumentId,
      symbol: member.symbol,
      instrumentType: member.instrumentType,
      primaryExchange: member.primaryExchange,
      issuerTaxResidency: member.issuerTaxResidency,
      effectiveFrom: member.effectiveFrom,
      issuer: member.issuer,
    }));

  return deepFreeze({
    schema: "twofold.private_controlled_lab_config/v1" as const,
    season: {
      seasonId,
      seasonCode,
      displayName,
      opensAt: seasonOpensAt,
      closesAt: `${addDays(artifact.asOfSessionDate, 30)}T00:00:00.000Z`,
      decisionCadence: "US_EQUITY_DAILY_AFTER_CLOSE" as const,
      marketTimezone: "America/New_York" as const,
      openingSnapshotId: snapshotId,
      openingSessionDate: artifact.asOfSessionDate,
      openingInstrumentId: LULU_INSTRUMENT_ID,
      openingSymbol: "LULU" as const,
      openingQuantity: "150" as const,
      openingHolding: "150 LULU" as const,
      openingCash: "0" as const,
      genesisId: `${seasonCode}:lulu-150:${artifactSha256.slice(0, 16)}`,
      fxSourceUrl:
        "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
    },
    executionRulebook,
    decisionUniverse: {
      schema: "twofold.liquid_universe_reference/v1" as const,
      artifactPath,
      artifactSha256,
      memberCount: "100" as const,
    },
    universe,
    rounds: [{
      roundId,
      roundIndex: "1" as const,
      decisionSnapshotId: snapshotId,
      decisionSessionDate: artifact.asOfSessionDate,
      decisionWindowOpensAt,
      decisionWindowClosesAt,
      calendarStartDate: artifact.asOfSessionDate,
      calendarEndDate: addDays(artifact.asOfSessionDate, 14),
    }] as const,
    entrants: [{
      entrantId: deterministicUuid(`${seasonCode}:entrant:twofold`),
      entrantCode: "twofold" as const,
      runId: deterministicUuid(`${seasonCode}:run:twofold`),
      bundleId: input.bundles.twofold.bundleId,
      bundleSha256: input.bundles.twofold.bundleSha256,
      presetId: "twofold" as const,
      provider: "deepseek-official" as const,
      model: "deepseek-v4-pro" as const,
      executionClass: "ROOT_ONLY" as const,
      track: "MAIN_ARENA" as const,
    }, {
      entrantId: deterministicUuid(`${seasonCode}:entrant:twofold-orchestrator`),
      entrantCode: "twofold-orchestrator" as const,
      runId: deterministicUuid(`${seasonCode}:run:twofold-orchestrator`),
      bundleId: input.bundles.twofoldOrchestrator.bundleId,
      bundleSha256: input.bundles.twofoldOrchestrator.bundleSha256,
      presetId: "twofold-orchestrator" as const,
      provider: "deepseek-official" as const,
      model: "deepseek-v4-pro" as const,
      executionClass: "ORCHESTRATED" as const,
      track: "MAIN_ARENA" as const,
    }] as const,
  });
}

function validateBundle(value: AgentBundleReference, field: string): void {
  if (value.bundleId.trim() === "" || value.bundleId !== value.bundleId.trim()) {
    throw new TypeError(`${field}.bundleId is invalid`);
  }
  sha256(value.bundleSha256, `${field}.bundleSha256`);
}

function seasonIdentity(value: string, field: string): string {
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(value)) {
    throw new TypeError(`${field} must be a lowercase slug`);
  }
  return value;
}

function displayIdentity(value: string, field: string): string {
  if (value.trim() !== value || value.length < 3 || value.length > 100) {
    throw new TypeError(`${field} must be a trimmed display name`);
  }
  return value;
}

function relativeArtifactPath(value: string): string {
  if (
    !value.startsWith("config/universes/")
    || value.includes("..")
    || !value.endsWith(".json")
  ) throw new TypeError("artifactPath must be a config/universes JSON path");
  return value;
}

function uuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID`);
  return value;
}

function sha256(value: string, field: string): string {
  if (!SHA256_PATTERN.test(value)) throw new TypeError(`${field} must be SHA-256`);
  return value;
}

function timestamp(value: string, field: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || new Date(value).toISOString() !== value
  ) throw new TypeError(`${field} must be a canonical UTC timestamp`);
  return value;
}

function latestTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function deterministicUuid(value: string): string {
  const chars = createHash("sha256").update(value, "utf8")
    .digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function addDays(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
