import { describe, expect, it } from "vitest";

import { planUsLiquid100Activation } from
  "../src/us-liquid-100-activation.js";
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
  frozenAt: "2026-08-29T20:05:34.413Z",
  members: symbols.map((symbol) => ({ symbol })),
} as unknown as LiquidUniverseFreezeArtifact;

describe("US Liquid 100 activation planning", () => {
  it("opens a new Season after both the sealed snapshot and preparation buffer", () => {
    expect(planUsLiquid100Activation({
      artifact,
      snapshot: {
        snapshotId: "e502936c-1c97-49d5-9351-deb16721cb5b",
        targetSessionDate: "2026-08-28",
        sealedAt: "2026-08-29T20:05:37.11948+00:00",
        symbols: [...symbols].reverse(),
      },
      now: "2026-08-29T20:20:00.000Z",
      activationDelayMinutes: 10,
    })).toEqual({
      snapshotId: "e502936c-1c97-49d5-9351-deb16721cb5b",
      decisionAvailableAt: "2026-08-29T20:30:00.000Z",
      seasonOpensAt: "2026-08-29T20:30:00.000Z",
    });
  });

  it("rejects a snapshot that does not reproduce the frozen member set", () => {
    expect(() => planUsLiquid100Activation({
      artifact,
      snapshot: {
        snapshotId: "e502936c-1c97-49d5-9351-deb16721cb5b",
        targetSessionDate: "2026-08-28",
        sealedAt: "2026-08-29T20:05:37.11948+00:00",
        symbols: symbols.slice(0, 99),
      },
      now: "2026-08-29T20:20:00.000Z",
      activationDelayMinutes: 10,
    })).toThrow(/member set/);
  });
});
