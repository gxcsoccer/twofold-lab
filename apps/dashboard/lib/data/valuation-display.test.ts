import { describe, expect, it } from "vitest";

import {
  describeEntrantValuationDisplay,
  describeSeasonValuationPanelNote,
  valuationStageLabel,
} from "./valuation-display";

const baseValuation = {
  schema: "twofold.private_arena_score/v1" as const,
  stage: "S2_CLOSE" as const,
  roundIndex: "1",
  valuationAt: "2026-09-01T20:39:15.419Z",
  brokerNav: "17697.17",
  taxReservedNav: "17697.17",
  liquidationNav: "17697.17",
  scoreBaseLiquidationNav: "17697.17",
  returnMultiple: "0.977",
  valuationSha256: "a".repeat(64),
};

describe("valuationStageLabel", () => {
  it("labels sealed stages without inventing live marks", () => {
    expect(valuationStageLabel("OPENING")).toBe("起始估值");
    expect(valuationStageLabel("S1_CLOSE")).toBe("S1 收盘");
    expect(valuationStageLabel("S2_CLOSE")).toBe("S2 最终");
  });
});

describe("describeEntrantValuationDisplay", () => {
  it("flags prior-round NAV while the current round is still settling", () => {
    const note = describeEntrantValuationDisplay({
      valuation: baseValuation,
      noTrade: null,
      currentRoundIndex: "2",
      currentRoundStage: "SETTLING_S1",
    });
    expect(note.isHistorical).toBe(true);
    expect(note.freshness).toBe("PRIOR_ROUND_HISTORICAL");
    expect(note.stageLabel).toContain("R1");
    expect(note.explanation).toContain("当前为 Round 2");
    expect(note.explanation).toContain("历史估值");
    expect(note.explanation).not.toContain("实时市值相同");
  });

  it("explains no-trade carry as historical NAV with the required Chinese copy", () => {
    const note = describeEntrantValuationDisplay({
      valuation: baseValuation,
      noTrade: {
        status: "SUCCEEDED",
        reasonCode: "S1_CHECKPOINT_UNAVAILABLE",
      },
      currentRoundIndex: "2",
      currentRoundStage: "SETTLING_S1",
    });
    expect(note.freshness).toBe("NO_TRADE_HISTORICAL");
    expect(note.isHistorical).toBe(true);
    expect(note.explanation).toContain("本轮未成交、展示的是历史估值");
    expect(note.explanation).toContain("S1 结算未完成");
  });

  it("keeps current-round S2_CLOSE as non-historical", () => {
    const note = describeEntrantValuationDisplay({
      valuation: { ...baseValuation, roundIndex: "2" },
      noTrade: null,
      currentRoundIndex: "2",
      currentRoundStage: "COMPLETE",
    });
    expect(note.freshness).toBe("CURRENT_ROUND_FINAL");
    expect(note.isHistorical).toBe(false);
    expect(note.explanation).toBeNull();
  });

  it("marks stale opening/S1 marks once the round expects S2 close", () => {
    const note = describeEntrantValuationDisplay({
      valuation: {
        ...baseValuation,
        stage: "OPENING",
        roundIndex: "2",
        valuationAt: "2026-09-05T20:00:00.000Z",
      },
      noTrade: null,
      currentRoundIndex: "2",
      currentRoundStage: "FINALIZING",
    });
    expect(note.freshness).toBe("CURRENT_ROUND_PARTIAL");
    expect(note.isHistorical).toBe(true);
    expect(note.stageLabel).toContain("未更新");
    expect(note.explanation).toContain("不是最新清算净值");
  });
});

describe("describeSeasonValuationPanelNote", () => {
  it("surfaces a panel warning when any entrant shows historical NAV", () => {
    const note = describeSeasonValuationPanelNote({
      currentRound: {
        schema: "twofold.private_arena_round_overview/v1",
        roundId: "r2",
        roundIndex: "2",
        stage: "SETTLING_S1",
        entryCount: "2",
        finalCount: "0",
        decisionSessionDate: "2026-09-04",
        decisionWindowOpensAt: "2026-09-04T20:00:00.000Z",
        decisionWindowClosesAt: "2026-09-05T13:15:00.000Z",
        s1SessionDate: "2026-09-05",
        s1OpenAt: "2026-09-05T13:30:00.000Z",
        s1CloseAt: "2026-09-05T20:00:00.000Z",
        s2SessionDate: "2026-09-08",
        s2OpenAt: "2026-09-08T13:30:00.000Z",
        s2CloseAt: "2026-09-08T20:00:00.000Z",
        cycleReadyAt: "2026-09-08T20:20:00.000Z",
      },
      entrants: [
        {
          schema: "twofold.private_arena_entrant_overview/v2",
          rank: "1",
          entrantId: "e1",
          entrantCode: "twofold",
          runId: "run-1",
          bundleId: "twofold@0.1.0",
          presetId: "twofold",
          provider: "deepseek-official",
          model: "deepseek-v4-pro",
          executionClass: "ROOT_ONLY",
          roundEntryId: "re1",
          decisionId: "d1",
          noTrade: {
            schema: "twofold.private_arena_no_trade_overview/v1",
            status: "SUCCEEDED",
            reasonCode: "S1_CHECKPOINT_UNAVAILABLE",
            sourcePhase: "SETTLE_S1_AND_PREPARE_S2",
            scheduledAt: "2026-09-05T20:20:00.000Z",
            completedAt: "2026-09-05T20:25:00.000Z",
            valuationId: "v1",
            outcome: "NO_TRADE_CARRY_FORWARD",
          },
          valuation: baseValuation,
          work: [],
        },
      ],
    });
    expect(note).toContain("本轮未成交");
    expect(note).toContain("历史估值");
  });
});
