import { describe, expect, it } from "vitest";

import type {
  PrivateArenaOverview,
  PrivateArenaWorkOverview,
  PrivateArenaWorkPhase,
  PrivateArenaWorkStatus,
} from "./contracts";
import {
  derivePhaseState,
  deriveRoundSpine,
  isDeadlineBreach,
  nextRoundBoundary,
} from "./round-spine";

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

function work(
  phase: PrivateArenaWorkPhase,
  status: PrivateArenaWorkStatus,
  errorCode: string | null = null,
): PrivateArenaWorkOverview {
  return {
    schema: "twofold.private_arena_work_overview/v1",
    phase,
    status,
    scheduledAt: "2026-08-31T20:15:00.000Z",
    deadlineAt: "2026-08-31T22:00:00.000Z",
    attemptCount: "1",
    errorCode,
  };
}

function overview(
  statuses: Partial<Record<PrivateArenaWorkPhase, PrivateArenaWorkStatus>> = {},
  errors: Partial<Record<PrivateArenaWorkPhase, string>> = {},
  stage: NonNullable<PrivateArenaOverview["currentRound"]>["stage"] = "S2_EXECUTION",
  asOf = "2026-09-01T14:47:12.000Z",
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
    currentRound: {
      schema: "twofold.private_arena_round_overview/v1",
      roundId: "9f96b47b-ae3d-40d3-9a63-52d88ce50bf6",
      roundIndex: "4",
      stage,
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
      valuation: null,
      work: PHASES.map((phase) =>
        work(phase, statuses[phase] ?? "REQUESTED", errors[phase] ?? null)),
    }],
  };
}

describe("round spine", () => {
  it("reports no tape rather than inventing one when no Round is frozen", () => {
    expect(deriveRoundSpine(null)).toBeNull();
    expect(deriveRoundSpine({ ...overview(), currentRound: null })).toBeNull();
  });

  it("seals a session only when every phase in it succeeded", () => {
    const spine = deriveRoundSpine(overview({
      RUN_AGENT_DECISION: "SUCCEEDED",
      PREPARE_S1_ORDERS: "SUCCEEDED",
      CAPTURE_S1_OPEN_REFERENCE: "SUCCEEDED",
      CAPTURE_S1_CLOSE: "SUCCEEDED",
    }));
    const byId = new Map(spine?.nodes.map((node) => [node.id, node.state]));
    expect(byId.get("D")).toBe("sealed");
    expect(byId.get("S1")).toBe("sealed");
    expect(byId.get("S2")).toBe("current");
    expect(byId.get("FINAL")).toBe("upcoming");
  });

  it("marks the session breached when a frozen deadline was crossed", () => {
    const spine = deriveRoundSpine(overview(
      { RUN_AGENT_DECISION: "FAILED" },
      { RUN_AGENT_DECISION: "DEADLINE_EXPIRED_DURING_EXECUTION" },
    ));
    expect(spine?.nodes.find((node) => node.id === "D")?.state).toBe("breached");
    expect(spine?.breachCount).toBe(1);
    expect(spine?.failureCount).toBe(0);
  });

  it("separates an ordinary failure from a crossed fence", () => {
    const spine = deriveRoundSpine(overview(
      { RUN_AGENT_DECISION: "FAILED" },
      { RUN_AGENT_DECISION: "ARENA_PHASE_FAILED" },
    ));
    // Rust-for-breach would tell the operator a frozen deadline was crossed
    // when it was not.
    expect(spine?.nodes.find((node) => node.id === "D")?.state).toBe("failed");
    expect(spine?.breachCount).toBe(0);
    expect(spine?.failureCount).toBe(1);
  });

  it("does not let a partially claimed session read as sealed", () => {
    const spine = deriveRoundSpine(overview({
      RUN_AGENT_DECISION: "SUCCEEDED",
      PREPARE_S1_ORDERS: "SUCCEEDED",
      CAPTURE_S1_OPEN_REFERENCE: "CLAIMED",
    }));
    expect(spine?.nodes.find((node) => node.id === "S1")?.state).toBe("current");
  });

  it("labels sessions from the frozen calendar and pads the round index", () => {
    const spine = deriveRoundSpine(overview());
    expect(spine?.nodes.map((node) => node.label)).toEqual([
      "D 08-31",
      "S1 09-01",
      "S2 09-02",
      "结算",
    ]);
    expect(spine?.roundIndex).toBe("4");
  });

  it("names the next frozen boundary for each stage", () => {
    const round = overview().currentRound;
    if (round === null) throw new Error("fixture must have a round");
    const asOf = "2026-09-01T14:47:12.000Z";
    expect(nextRoundBoundary({ ...round, stage: "S2_EXECUTION" }, asOf))
      .toEqual({ label: "S2 收盘", at: round.s2CloseAt, overdue: false });
    expect(nextRoundBoundary({ ...round, stage: "COMPLETE" }, asOf)).toBeNull();
  });

  it("flags a boundary the stage has already outlived", () => {
    const round = overview().currentRound;
    if (round === null) throw new Error("fixture must have a round");
    // The decision window closed on 08-31; the projection is dated 09-01.
    expect(nextRoundBoundary({ ...round, stage: "DECISION_WINDOW" }, "2026-09-01T14:47:12.000Z"))
      .toEqual({ label: "决策截止", at: round.decisionWindowClosesAt, overdue: true });
  });

  it("does not present a stalled finalization as an upcoming boundary", () => {
    // FINALIZING starts at s2CloseAt and persists until every S2 valuation is
    // written, so a stalled Worker leaves the stage sitting past cycleReadyAt.
    const stalled = deriveRoundSpine(
      overview({}, {}, "FINALIZING", "2026-09-03T18:00:00.000Z"),
    );
    expect(stalled?.boundary).toEqual({
      label: "可结算时点",
      at: "2026-09-02T20:25:00.000Z",
      overdue: true,
    });

    const onTime = deriveRoundSpine(
      overview({}, {}, "FINALIZING", "2026-09-02T20:10:00.000Z"),
    );
    expect(onTime?.boundary?.overdue).toBe(false);
  });

  it("does not call a boundary overdue when a timestamp is unreadable", () => {
    const round = overview().currentRound;
    if (round === null) throw new Error("fixture must have a round");
    expect(nextRoundBoundary({ ...round, stage: "S2_EXECUTION" }, "not-a-date")?.overdue)
      .toBe(false);
  });

  it("treats only deadline error codes as fence breaches", () => {
    expect(isDeadlineBreach(work("RUN_AGENT_DECISION", "FAILED", "DEADLINE_EXPIRED")))
      .toBe(true);
    expect(isDeadlineBreach(
      work("RUN_AGENT_DECISION", "FAILED", "DEADLINE_EXPIRED_DURING_EXECUTION"),
    )).toBe(true);
    expect(isDeadlineBreach(work("RUN_AGENT_DECISION", "FAILED", "PROVIDER_TIMEOUT")))
      .toBe(false);
  });
});

describe("phase state", () => {
  it("reports nothing scheduled when the phase has no work", () => {
    const state = derivePhaseState([], "CAPTURE_S1_CLOSE");
    expect(state).toMatchObject({ label: "尚未排程", succeeded: 0, expected: 0 });
  });

  it("treats an all-canceled phase as terminal, not as waiting", () => {
    const entrant = overview({ CAPTURE_S2_CLOSE: "CANCELED" }).entrants[0];
    const state = derivePhaseState([entrant], "CAPTURE_S2_CLOSE");
    expect(state.label).toBe("已取消");
    expect(state.canceled).toBe(1);
    // Nothing is still awaited, so the denominator is empty rather than 1.
    expect(state.expected).toBe(0);
  });

  it("excludes canceled entrants from the denominator", () => {
    const sealed = overview({ CAPTURE_S1_CLOSE: "SUCCEEDED" }).entrants[0];
    const dropped = overview({ CAPTURE_S1_CLOSE: "CANCELED" }).entrants[0];
    const state = derivePhaseState([sealed, dropped], "CAPTURE_S1_CLOSE");
    expect(state).toMatchObject({
      label: "已封存",
      tone: "positive",
      succeeded: 1,
      expected: 1,
      canceled: 1,
    });
  });

  it("still reports waiting while an entrant has not reached the phase", () => {
    const sealed = overview({ CAPTURE_S1_CLOSE: "SUCCEEDED" }).entrants[0];
    const pending = overview({ CAPTURE_S1_CLOSE: "REQUESTED" }).entrants[0];
    const state = derivePhaseState([sealed, pending], "CAPTURE_S1_CLOSE");
    expect(state).toMatchObject({ label: "等待时点", succeeded: 1, expected: 2 });
  });

  it("separates a crossed fence from an ordinary failure", () => {
    const breached = overview(
      { RUN_AGENT_DECISION: "FAILED" },
      { RUN_AGENT_DECISION: "DEADLINE_EXPIRED" },
    ).entrants[0];
    expect(derivePhaseState([breached], "RUN_AGENT_DECISION"))
      .toMatchObject({ label: "已越界", tone: "critical" });

    const failed = overview(
      { RUN_AGENT_DECISION: "FAILED" },
      { RUN_AGENT_DECISION: "WORKER_ABORTED" },
    ).entrants[0];
    expect(derivePhaseState([failed], "RUN_AGENT_DECISION"))
      .toMatchObject({ label: "需要处理", tone: "critical" });
  });

  it("reports work in flight while any attempt is claimed", () => {
    const claimed = overview({ CAPTURE_S2_CLOSE: "CLAIMED" }).entrants[0];
    expect(derivePhaseState([claimed], "CAPTURE_S2_CLOSE"))
      .toMatchObject({ label: "执行中", tone: "warning" });
  });
});
