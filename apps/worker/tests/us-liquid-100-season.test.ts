import { describe, expect, it } from "vitest";

import { buildUsLiquid100SeasonConfig } from
  "../src/us-liquid-100-season.js";
import type { LiquidUniverseFreezeArtifact } from
  "../src/liquid-universe.js";

const symbols = ["LULU", ...Array.from(
  { length: 99 },
  (_, index) => `S${index.toString().padStart(3, "0")}`,
)];
const artifact = {
  schema: "twofold.liquid_universe_freeze/v1",
  name: "US Liquid 100",
  asOfSessionDate: "2026-08-28",
  frozenAt: "2026-08-29T20:00:00.000Z",
  policy: {
    name: "US Liquid 100",
    size: "100",
    minimumPriceUsd: "5",
    minimumMedianDollarVolumeUsd: "20000000",
    medianDollarVolumeSessions: "20",
    minimumHistorySessions: "120",
    allowedExchanges: ["AMEX", "NASDAQ", "NYSE"],
    mandatorySymbols: ["LULU"],
    constraints: {
      minimumPositions: "5",
      maximumPositions: "10",
      maximumPositionWeightBps: "2000",
      minimumCashWeightBps: "500",
    },
  },
  sources: {
    observedAt: "2026-08-29T20:00:00.000Z",
    alpacaAssets: { url: "https://example.com/a", responseSha256: "1".repeat(64) },
    nasdaqStockScreener: { url: "https://example.com/b", responseSha256: "2".repeat(64) },
    nasdaqTradedDirectory: { url: "https://example.com/c", responseSha256: "3".repeat(64) },
    alpacaDailyBars: { url: "https://example.com/d", responseSha256: "4".repeat(64) },
  },
  eligibleCandidateCount: "500",
  members: symbols.map((symbol, index) => ({
    instrumentId: symbol === "LULU"
      ? "122dd8f9-709a-5652-a27c-a3b5c32755de"
      : `10000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
    symbol,
    instrumentType: "common_stock" as const,
    primaryExchange: "NASDAQ",
    issuerTaxResidency: "US",
    effectiveFrom: "2000-01-01",
    issuer: `${symbol} Corporation`,
    liquidityRank: String(index + 1),
    selectionReason: symbol === "LULU"
      ? "MANDATORY_CURRENT_HOLDING" as const
      : "LIQUIDITY_RANK" as const,
  })),
  candidates: [],
} as const satisfies LiquidUniverseFreezeArtifact;

describe("US Liquid 100 Season config", () => {
  it("creates a separate v2 Season with the frozen pool and equal LULU genesis", () => {
    const config = buildUsLiquid100SeasonConfig({
      seasonCode: "private-us-liquid-100-s1",
      displayName: "Private US Liquid 100 S1",
      artifact,
      artifactPath: "config/universes/us-liquid-100-2026-08-28.json",
      artifactSha256: "5".repeat(64),
      snapshotId: "2480b451-5c5b-4863-86c8-ec5827926536",
      decisionAvailableAt: "2026-08-29T20:00:01.000Z",
      calendar: {
        schema: "twofold.two_stage_cycle_calendar/v1",
        decisionSessionDate: "2026-08-28",
        s1SessionDate: "2026-08-31",
        s1OpenAt: "2026-08-31T13:30:00.000Z",
        s1ReferenceAvailableAt: "2026-08-31T13:32:00.000Z",
        s1CloseAt: "2026-08-31T20:00:00.000Z",
        s1CloseAvailableAt: "2026-08-31T20:20:00.000Z",
        s2SessionDate: "2026-09-01",
        s2OpenAt: "2026-09-01T13:30:00.000Z",
        s2ReferenceAvailableAt: "2026-09-01T13:32:00.000Z",
        s2CloseAt: "2026-09-01T20:00:00.000Z",
        cycleReadyAt: "2026-09-01T20:20:00.000Z",
      },
      bundles: {
        twofold: { bundleId: "twofold@0.1.0", bundleSha256: "6".repeat(64) },
        twofoldOrchestrator: {
          bundleId: "twofold-orchestrator@0.1.0",
          bundleSha256: "7".repeat(64),
        },
      },
    });

    expect(config.season.seasonCode).toBe("private-us-liquid-100-s1");
    expect(config.season.openingHolding).toBe("150 LULU");
    expect(config.season.openingQuantity).toBe("150");
    expect(config.season.openingCash).toBe("0");
    expect(config.executionRulebook).toMatchObject({
      schema: "twofold.arena_execution_rulebook/v2",
      executionModel: "SIMULATED_MINUTE_PARTICIPATION",
      maxParticipationBps: "100",
    });
    expect(config.universe).toHaveLength(100);
    expect(config.decisionUniverse).toEqual({
      schema: "twofold.liquid_universe_reference/v1",
      artifactPath: "config/universes/us-liquid-100-2026-08-28.json",
      artifactSha256: "5".repeat(64),
      memberCount: "100",
    });
    expect(config.rounds[0]?.decisionWindowClosesAt).toBe(
      "2026-08-31T13:15:00.000Z",
    );
    expect(config.season.opensAt).toBe("2026-08-29T20:00:00.000Z");
    expect(config.rounds[0]?.decisionWindowOpensAt).toBe(
      "2026-08-29T20:00:01.000Z",
    );
    expect(new Set(config.entrants.map((entrant) => entrant.runId)).size).toBe(2);

    const next = buildUsLiquid100SeasonConfig({
      seasonCode: "private-us-liquid-100-s2",
      displayName: "Private US Liquid 100 S2",
      seasonOpensAt: "2026-08-29T20:02:00.000Z",
      artifact,
      artifactPath: "config/universes/us-liquid-100-2026-08-28.json",
      artifactSha256: "5".repeat(64),
      snapshotId: "2480b451-5c5b-4863-86c8-ec5827926536",
      decisionAvailableAt: "2026-08-29T20:01:00.000Z",
      calendar: configCalendar(),
      bundles: {
        twofold: { bundleId: "twofold@0.1.0", bundleSha256: "6".repeat(64) },
        twofoldOrchestrator: {
          bundleId: "twofold-orchestrator@0.1.0",
          bundleSha256: "7".repeat(64),
        },
      },
    });
    expect(next.season.seasonId).not.toBe(config.season.seasonId);
    expect(next.season.opensAt).toBe("2026-08-29T20:02:00.000Z");
    expect(next.rounds[0].decisionWindowOpensAt).toBe(
      "2026-08-29T20:02:00.000Z",
    );
    expect(next.rounds[0].roundId).not.toBe(config.rounds[0].roundId);
    expect(next.entrants.map((entrant) => entrant.runId)).not.toEqual(
      config.entrants.map((entrant) => entrant.runId),
    );
  });

  it("rejects an incomplete pool or a snapshot/calendar mismatch", () => {
    expect(() => buildUsLiquid100SeasonConfig({
      seasonCode: "private-us-liquid-100-s1",
      displayName: "Private US Liquid 100 S1",
      artifact: { ...artifact, members: artifact.members.slice(0, 99) },
      artifactPath: "config/universes/x.json",
      artifactSha256: "5".repeat(64),
      snapshotId: "2480b451-5c5b-4863-86c8-ec5827926536",
      decisionAvailableAt: "2026-08-29T20:00:01.000Z",
      calendar: {
        schema: "twofold.two_stage_cycle_calendar/v1",
        decisionSessionDate: "2026-08-29",
        s1SessionDate: "2026-08-31",
        s1OpenAt: "2026-08-31T13:30:00.000Z",
        s1ReferenceAvailableAt: "2026-08-31T13:32:00.000Z",
        s1CloseAt: "2026-08-31T20:00:00.000Z",
        s1CloseAvailableAt: "2026-08-31T20:20:00.000Z",
        s2SessionDate: "2026-09-01",
        s2OpenAt: "2026-09-01T13:30:00.000Z",
        s2ReferenceAvailableAt: "2026-09-01T13:32:00.000Z",
        s2CloseAt: "2026-09-01T20:00:00.000Z",
        cycleReadyAt: "2026-09-01T20:20:00.000Z",
      },
      bundles: {
        twofold: { bundleId: "twofold@0.1.0", bundleSha256: "6".repeat(64) },
        twofoldOrchestrator: {
          bundleId: "twofold-orchestrator@0.1.0",
          bundleSha256: "7".repeat(64),
        },
      },
    })).toThrow(/100 members|decision session/);
  });
});

function configCalendar() {
  return {
    schema: "twofold.two_stage_cycle_calendar/v1" as const,
    decisionSessionDate: "2026-08-28",
    s1SessionDate: "2026-08-31",
    s1OpenAt: "2026-08-31T13:30:00.000Z",
    s1ReferenceAvailableAt: "2026-08-31T13:32:00.000Z",
    s1CloseAt: "2026-08-31T20:00:00.000Z",
    s1CloseAvailableAt: "2026-08-31T20:20:00.000Z",
    s2SessionDate: "2026-09-01",
    s2OpenAt: "2026-09-01T13:30:00.000Z",
    s2ReferenceAvailableAt: "2026-09-01T13:32:00.000Z",
    s2CloseAt: "2026-09-01T20:00:00.000Z",
    cycleReadyAt: "2026-09-01T20:20:00.000Z",
  };
}
