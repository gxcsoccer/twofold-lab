import { describe, expect, it } from "vitest";

import { validatePrivateArenaOverview } from "./private-arena-overview";

const PHASES = [
  "RUN_AGENT_DECISION",
  "PREPARE_S1_ORDERS",
  "CAPTURE_S1_OPEN_REFERENCE",
  "CAPTURE_S1_CLOSE",
  "SETTLE_S1_AND_PREPARE_S2",
  "CAPTURE_S2_OPEN_REFERENCE",
  "CAPTURE_S2_CLOSE",
  "FINALIZE_ACCEPTED_TARGET_CYCLE",
] as const;

function overview(): Record<string, unknown> {
  return {
    schema: "twofold.private_arena_overview/v2",
    asOf: "2026-08-29T02:11:19.499Z",
    season: {
      schema: "twofold.private_arena_season_overview/v1",
      seasonId: "286387f5-c8b8-5b50-98c5-6cf6027e547f",
      seasonCode: "private-controlled-lab-s1",
      displayName: "Private Controlled Lab S1",
      opensAt: "2026-08-28T21:37:32.616Z",
      closesAt: "2026-09-26T00:00:00.000Z",
      status: "RUNNING",
      decisionCadence: "US_EQUITY_DAILY_AFTER_CLOSE",
      marketTimezone: "America/New_York",
      openingHolding: "150 LULU",
      openingCash: "0",
      entrantCount: "1",
      roundCount: "1",
    },
    currentRound: {
      schema: "twofold.private_arena_round_overview/v1",
      roundId: "9f96b47b-ae3d-40d3-9a63-52d88ce50bf6",
      roundIndex: "1",
      stage: "DECISION_WINDOW",
      entryCount: "1",
      finalCount: "0",
      decisionSessionDate: "2026-08-28",
      decisionWindowOpensAt: "2026-08-28T22:23:53.027Z",
      decisionWindowClosesAt: "2026-08-31T13:15:00.000Z",
      s1SessionDate: "2026-08-31",
      s1OpenAt: "2026-08-31T13:30:00.000Z",
      s1CloseAt: "2026-08-31T20:00:00.000Z",
      s2SessionDate: "2026-09-01",
      s2OpenAt: "2026-09-01T13:30:00.000Z",
      s2CloseAt: "2026-09-01T20:00:00.000Z",
      cycleReadyAt: "2026-09-01T20:20:00.000Z",
    },
    entrants: [{
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
      valuation: {
        schema: "twofold.private_arena_score/v1",
        stage: "OPENING",
        roundIndex: "1",
        valuationAt: "2026-08-28T22:22:41.570Z",
        brokerNav: "18121.5",
        taxReservedNav: "18121.5",
        liquidationNav: "18118.66",
        scoreBaseLiquidationNav: "18118.66",
        returnMultiple: "1",
        valuationSha256: "a".repeat(64),
      },
      work: PHASES.map((phase) => ({
        schema: "twofold.private_arena_work_overview/v1",
        phase,
        status: "REQUESTED",
        scheduledAt: "2026-08-28T22:23:53.027Z",
        deadlineAt: null,
        attemptCount: "0",
        errorCode: null,
      })),
    }],
  };
}

describe("private Arena overview", () => {
  it("accepts one exact number-free Season, Round, rank, and work DAG", () => {
    expect(validatePrivateArenaOverview(overview())).toMatchObject({ ok: true });
  });

  it("rejects numeric tokens and count drift instead of rendering partial rankings", () => {
    const value = overview();
    (value.season as Record<string, unknown>).entrantCount = "2";
    (value.currentRound as Record<string, unknown>).entryCount = 1;
    const result = validatePrivateArenaOverview(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toMatch(
      /JSON number token[\s\S]*entrantCount 与 entrants 数量不一致/,
    );
  });

  it("rejects a reordered phase or half-bound Round identity", () => {
    const value = overview();
    const entrant = (value.entrants as Record<string, unknown>[])[0];
    entrant.decisionId = null;
    const work = entrant.work as Record<string, unknown>[];
    [work[0], work[1]] = [work[1], work[0]];
    const result = validatePrivateArenaOverview(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toMatch(
      /roundEntryId 与 decisionId 必须同时存在[\s\S]*phase 顺序无效/,
    );
  });

  it("accepts an explicit completed no-trade carry-forward beside its rank", () => {
    const value = overview();
    const entrant = (value.entrants as Record<string, unknown>[])[0]!;
    entrant.noTrade = {
      schema: "twofold.private_arena_no_trade_overview/v1",
      status: "SUCCEEDED",
      reasonCode: "DECISION_UNAVAILABLE",
      sourcePhase: "RUN_AGENT_DECISION",
      scheduledAt: "2026-09-03T20:20:00.000Z",
      completedAt: "2026-09-03T20:20:08.000Z",
      valuationId: "a9000000-0000-8000-8000-000000000001",
      outcome: "NO_TRADE_CARRY_FORWARD",
    };

    expect(validatePrivateArenaOverview(value)).toMatchObject({ ok: true });
  });
});
