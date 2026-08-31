import { describe, expect, it } from "vitest";

import type {
  PrivateArenaEntrantOverview,
  PrivateArenaOverview,
  PrivateArenaWorkOverview,
  PrivateArenaWorkPhase,
  PrivateArenaWorkStatus,
} from "./contracts";
import { buildSealedTimeline, rulerSegmentTone } from "./sealed-timeline";

const PHASES = [
  "RUN_AGENT_DECISION",
  "PREPARE_S1_ORDERS",
  "CAPTURE_S1_OPEN_REFERENCE",
  "CAPTURE_S1_CLOSE",
  "SETTLE_S1_AND_PREPARE_S2",
  "CAPTURE_S2_OPEN_REFERENCE",
  "CAPTURE_S2_CLOSE",
  "FINALIZE_ACCEPTED_TARGET_CYCLE",
] as const satisfies readonly PrivateArenaWorkPhase[];

/** Round 4: D 08-31 close, S1 09-01, S2 09-02, all in UTC. */
const ROUND = {
  schema: "twofold.private_arena_round_overview/v1",
  roundId: "9f96b47b-ae3d-40d3-9a63-52d88ce50bf6",
  roundIndex: "4",
  stage: "S2_EXECUTION",
  entryCount: "1",
  finalCount: "0",
  decisionSessionDate: "2026-08-31",
  decisionWindowOpensAt: "2026-08-31T20:15:00.000Z",
  decisionWindowClosesAt: "2026-08-31T22:00:00.000Z",
  s1SessionDate: "2026-09-01",
  s1OpenAt: "2026-09-01T13:30:00.000Z",
  s1CloseAt: "2026-09-01T20:00:00.000Z",
  s2SessionDate: "2026-09-02",
  s2OpenAt: "2026-09-02T13:30:00.000Z",
  s2CloseAt: "2026-09-02T20:00:00.000Z",
  cycleReadyAt: "2026-09-02T20:25:00.000Z",
} as const satisfies NonNullable<PrivateArenaOverview["currentRound"]>;

function work(
  phase: PrivateArenaWorkPhase,
  scheduledAt: string,
  deadlineAt: string | null,
  status: PrivateArenaWorkStatus = "SUCCEEDED",
  errorCode: string | null = null,
): PrivateArenaWorkOverview {
  return {
    schema: "twofold.private_arena_work_overview/v1",
    phase,
    status,
    scheduledAt,
    deadlineAt,
    attemptCount: "1",
    errorCode,
  };
}

function entrant(work_: PrivateArenaWorkOverview[]): PrivateArenaEntrantOverview {
  return {
    schema: "twofold.private_arena_entrant_overview/v2",
    rank: "1",
    entrantId: "6222a8e6-dc96-48c5-bb1b-0906403fc177",
    entrantCode: "twofold",
    runId: "ccb09ac5-8779-4aab-a497-d580949617cb",
    bundleId: "twofold@0.1.0",
    presetId: "twofold",
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
    executionClass: "ROOT_ONLY",
    roundEntryId: "d9be82d5-6ea1-8390-8031-1e80128c8053",
    decisionId: "40a4d120-cfac-83ee-8016-5d99c26fdf23",
    noTrade: null,
    valuation: null,
    work: work_,
  };
}

function overview(
  work_: PrivateArenaWorkOverview[],
  asOf = "2026-09-02T14:47:12.000Z",
  round: NonNullable<PrivateArenaOverview["currentRound"]> | null = ROUND,
): PrivateArenaOverview {
  return {
    schema: "twofold.private_arena_overview/v2",
    asOf,
    season: {
      schema: "twofold.private_arena_season_overview/v1",
      seasonId: "286387f5-c8b8-5b50-98c5-6cf6027e547f",
      seasonCode: "private-us-liquid-100-s2",
      displayName: "Private US Liquid 100 S2",
      opensAt: "2026-08-24T20:05:00.000Z",
      closesAt: "2026-09-27T00:00:00.000Z",
      status: "RUNNING",
      decisionCadence: "US_EQUITY_DAILY_AFTER_CLOSE",
      marketTimezone: "America/New_York",
      openingHolding: "150 LULU",
      openingCash: "0",
      entrantCount: "1",
      roundCount: "4",
    },
    currentRound: round,
    entrants: [entrant(work_)],
  };
}

const LABELS = Object.fromEntries(PHASES.map((phase) => [phase, phase]));

function build(value: PrivateArenaOverview) {
  return buildSealedTimeline(
    value,
    LABELS,
    (item) => item.status,
    () => "单 Agent",
    (iso) => iso,
  );
}

describe("sealed timeline geometry", () => {
  it("gives each session a fixed share and marks the compressed gaps", () => {
    const timeline = build(overview([]));
    expect(timeline?.bands.map((band) => [band.startPct, band.spanPct])).toEqual([
      [0, 20], [20, 6], [26, 30], [56, 6], [62, 30], [92, 8],
    ]);
    expect(timeline?.bands.filter((band) => band.compressed).map((band) => band.key))
      .toEqual(["overnight-1", "overnight-2"]);
  });

  it("places an instant proportionally inside its own session", () => {
    // S1 runs 13:30–20:00 across 26%–56%. 16:45 is exactly half way.
    const timeline = build(overview([], "2026-09-01T16:45:00.000Z"));
    expect(timeline?.nowPct).toBe(41);
  });

  it("keeps the S2 session linear too", () => {
    // S2 runs 13:30–20:00 across 62%–92%; 16:45 is half way again.
    const timeline = build(overview([], "2026-09-02T16:45:00.000Z"));
    expect(timeline?.nowPct).toBe(77);
  });

  it("clamps instants outside the round instead of drawing off-axis", () => {
    expect(build(overview([], "2026-08-01T00:00:00.000Z"))?.nowPct).toBe(0);
    expect(build(overview([], "2026-12-01T00:00:00.000Z"))?.nowPct).toBe(100);
  });

  it("spans a segment from its schedule to its frozen deadline", () => {
    const timeline = build(overview([
      work("CAPTURE_S1_CLOSE", "2026-09-01T20:00:00.000Z", "2026-09-01T20:20:00.000Z"),
    ]));
    const segment = timeline?.lanes[0].segments[0];
    // 20:00 is the S1 close (56%); the deadline falls in the compressed gap.
    expect(segment?.startPct).toBe(56);
    expect(segment?.spanPct).toBeGreaterThan(0);
    expect(timeline?.lanes[0].fences[0].atPct).toBeGreaterThan(56);
  });

  it("keeps a zero-length window visible rather than collapsing it", () => {
    const timeline = build(overview([
      work("CAPTURE_S1_OPEN_REFERENCE", "2026-09-01T13:31:00.000Z", "2026-09-01T13:31:00.000Z"),
    ]));
    expect(timeline?.lanes[0].segments[0].spanPct).toBeGreaterThanOrEqual(2.4);
  });

  it("never lets a segment overflow the axis, even at the very end", () => {
    const timeline = build(overview([
      work("FINALIZE_ACCEPTED_TARGET_CYCLE", "2026-09-02T20:25:00.000Z", null),
    ]));
    const segment = timeline?.lanes[0].segments[0];
    expect(segment?.startPct).toBeLessThan(100);
    expect(segment?.spanPct).toBeGreaterThan(0);
    expect((segment?.startPct ?? 0) + (segment?.spanPct ?? 0)).toBeLessThanOrEqual(100);
  });

  it("keeps every segment inside the axis across a full round", () => {
    const timeline = build(overview([
      work("RUN_AGENT_DECISION", "2026-08-31T20:15:00.000Z", "2026-08-31T22:00:00.000Z"),
      work("PREPARE_S1_ORDERS", "2026-09-01T13:20:00.000Z", "2026-09-01T13:25:00.000Z"),
      work("CAPTURE_S1_OPEN_REFERENCE", "2026-09-01T13:31:00.000Z", "2026-09-01T13:40:00.000Z"),
      work("CAPTURE_S1_CLOSE", "2026-09-01T20:05:00.000Z", "2026-09-01T20:20:00.000Z"),
      work("SETTLE_S1_AND_PREPARE_S2", "2026-09-02T13:15:00.000Z", "2026-09-02T13:25:00.000Z"),
      work("CAPTURE_S2_OPEN_REFERENCE", "2026-09-02T13:31:00.000Z", "2026-09-02T13:40:00.000Z"),
      work("CAPTURE_S2_CLOSE", "2026-09-02T20:00:00.000Z", "2026-09-02T20:20:00.000Z"),
      work("FINALIZE_ACCEPTED_TARGET_CYCLE", "2026-09-02T20:25:00.000Z", "2026-09-02T21:10:00.000Z"),
    ]));
    const segments = timeline?.lanes[0].segments ?? [];
    expect(segments).toHaveLength(8);
    for (const segment of segments) {
      expect(segment.startPct).toBeGreaterThanOrEqual(0);
      expect(segment.spanPct).toBeGreaterThan(0);
      expect(segment.startPct + segment.spanPct).toBeLessThanOrEqual(100);
    }
    // Phases stay in schedule order and no block covers the next one's start.
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index].startPct).toBeGreaterThanOrEqual(segments[index - 1].startPct);
    }
    // The settlement phase must reach the settle band, not collapse on the edge.
    expect(segments[7].startPct).toBeGreaterThan(92);
  });

  it("flags a crossed fence on the phase and on the lane", () => {
    const timeline = build(overview([
      work(
        "RUN_AGENT_DECISION",
        "2026-08-31T20:15:00.000Z",
        "2026-08-31T22:00:00.000Z",
        "FAILED",
        "DEADLINE_EXPIRED_DURING_EXECUTION",
      ),
    ]));
    expect(timeline?.lanes[0].segments[0].breached).toBe(true);
    expect(timeline?.lanes[0].fences[0].breached).toBe(true);
  });

  it("refuses to draw an axis when the frozen calendar is not monotonic", () => {
    const broken = { ...ROUND, s1OpenAt: "2026-08-30T13:30:00.000Z" };
    expect(build(overview([], "2026-09-02T14:47:12.000Z", broken))).toBeNull();
  });

  it("returns nothing when there is no Round to draw", () => {
    expect(build(overview([], "2026-09-02T14:47:12.000Z", null))).toBeNull();
  });
});

describe("ruler segment tone", () => {
  it("uses breached for a crossed fence even when status is FAILED", () => {
    expect(rulerSegmentTone({ breached: true, status: "FAILED" })).toBe("breached");
    expect(rulerSegmentTone({ breached: true, status: "CANCELED" })).toBe("breached");
  });

  it("lowercases ordinary status when the fence was not crossed", () => {
    expect(rulerSegmentTone({ breached: false, status: "FAILED" })).toBe("failed");
    expect(rulerSegmentTone({ breached: false, status: "CANCELED" })).toBe("canceled");
    expect(rulerSegmentTone({ breached: false, status: "SUCCEEDED" })).toBe("succeeded");
    expect(rulerSegmentTone({ breached: false, status: "CLAIMED" })).toBe("claimed");
    expect(rulerSegmentTone({ breached: false, status: "REQUESTED" })).toBe("requested");
  });
});
