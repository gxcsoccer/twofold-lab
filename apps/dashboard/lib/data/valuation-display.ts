import type {
  PrivateArenaEntrantOverview,
  PrivateArenaNoTradeOverview,
  PrivateArenaOverview,
  PrivateArenaRoundStage,
  PrivateArenaScore,
} from "./contracts";


/**
 * Round stages that still expect a fresher S2_CLOSE valuation for this round.
 * S2_EXECUTION is deliberately excluded: S2_CLOSE is only published at finalize,
 * so a sealed S1_CLOSE mark is still the latest liquidation NAV while S2 trades.
 */
const ROUND_EXPECTS_S2_CLOSE = new Set<PrivateArenaRoundStage>([
  "FINALIZING",
  "COMPLETE",
]);

export type ValuationFreshness =
  | "CURRENT_ROUND_FINAL"
  | "CURRENT_ROUND_PARTIAL"
  | "PRIOR_ROUND_HISTORICAL"
  | "NO_TRADE_HISTORICAL"
  | "NONE";

export interface ValuationDisplayNote {
  freshness: ValuationFreshness;
  /** Short badge / cell label for the valuation column. */
  stageLabel: string;
  /** One-line explanation under Liquidation NAV or in the panel note. */
  explanation: string | null;
  /** True when the published NAV is not a live mark for the current round stage. */
  isHistorical: boolean;
}

function valuationStageLabel(stage: PrivateArenaScore["stage"]): string {
  if (stage === "OPENING") return "起始估值";
  if (stage === "S1_CLOSE") return "S1 收盘";
  return "S2 最终";
}

function noTradeHistoricalExplanation(
  noTrade: Pick<PrivateArenaNoTradeOverview, "status" | "reasonCode" | "outcome">,
): string {
  const prefix = "本轮未成交、展示的是历史估值";
  if (noTrade.status === "SUCCEEDED") {
    if (noTrade.reasonCode === "DECISION_UNAVAILABLE") {
      return `${prefix}（决策未完成，持仓结转）`;
    }
    if (noTrade.reasonCode === "S1_PLAN_UNAVAILABLE") {
      return `${prefix}（S1 计划未完成，持仓结转）`;
    }
    if (noTrade.reasonCode === "S1_CHECKPOINT_UNAVAILABLE") {
      return `${prefix}（S1 结算未完成，持仓结转）`;
    }
    if (noTrade.reasonCode === "FINALIZATION_UNAVAILABLE") {
      return `${prefix}（最终结算未完成，持仓结转）`;
    }
    return prefix;
  }
  if (noTrade.status === "FAILED") {
    return `${prefix}（持仓结转失败）`;
  }
  return `${prefix}（持仓结转仍在等待）`;
}

/**
 * Explain whether an entrant's published Liquidation NAV is the current round's
 * final mark, a partial in-round mark, or a historical carry from an earlier
 * round / no-trade path. Fail-closed: never invent fills or live marks.
 */
export function describeEntrantValuationDisplay(input: {
  readonly valuation: PrivateArenaScore | null;
  readonly noTrade: Pick<
    PrivateArenaNoTradeOverview,
    "status" | "reasonCode" | "outcome"
  > | null;
  readonly currentRoundIndex: string | null;
  readonly currentRoundStage: PrivateArenaRoundStage | null;
}): ValuationDisplayNote {
  const { valuation, noTrade, currentRoundIndex, currentRoundStage } = input;
  if (valuation === null) {
    return {
      freshness: "NONE",
      stageLabel: "等待估值",
      explanation: null,
      isHistorical: false,
    };
  }

  const stageLabel = valuationStageLabel(valuation.stage);
  const sameRound =
    currentRoundIndex !== null && valuation.roundIndex === currentRoundIndex;

  // A recovery that resolved to EXISTING_S2_VALUATION did not carry a stale mark
  // forward: the round entry already had its own S2_CLOSE valuation, so fall
  // through to the ordinary same-round / stage freshness checks below.
  const carriedForward =
    noTrade !== null && noTrade.outcome !== "EXISTING_S2_VALUATION";

  if (carriedForward) {
    return {
      freshness: "NO_TRADE_HISTORICAL",
      stageLabel: sameRound ? `${stageLabel} · 历史` : `R${valuation.roundIndex} · 历史`,
      explanation: noTradeHistoricalExplanation(noTrade),
      isHistorical: true,
    };
  }

  if (!sameRound) {
    return {
      freshness: "PRIOR_ROUND_HISTORICAL",
      stageLabel: `R${valuation.roundIndex} · ${stageLabel}`,
      explanation:
        currentRoundIndex === null
          ? `展示的是 Round ${valuation.roundIndex} 的封存估值，不是实时市值`
          : `当前为 Round ${currentRoundIndex}（${
              currentRoundStage ?? "未排程"
            }），展示的是 Round ${valuation.roundIndex} 的历史估值，不是本轮实时市值`,
      isHistorical: true,
    };
  }

  if (valuation.stage === "S2_CLOSE") {
    return {
      freshness: "CURRENT_ROUND_FINAL",
      stageLabel,
      explanation: null,
      isHistorical: false,
    };
  }

  const expectsFinal =
    currentRoundStage !== null && ROUND_EXPECTS_S2_CLOSE.has(currentRoundStage);
  return {
    freshness: "CURRENT_ROUND_PARTIAL",
    stageLabel: expectsFinal ? `${stageLabel} · 未更新` : stageLabel,
    explanation: expectsFinal
      ? `本轮阶段已到 ${currentRoundStage}，展示的仍是 ${stageLabel}（${valuation.valuationAt}），不是最新清算净值`
      : `展示的是本轮 ${stageLabel} 封存估值（${valuation.valuationAt}），尚未到 S2 最终清算`,
    isHistorical: expectsFinal,
  };
}

/** Panel-level note when any ranked entrant is showing historical NAV. */
export function describeSeasonValuationPanelNote(
  overview: Pick<PrivateArenaOverview, "currentRound" | "entrants">,
): string | null {
  const round = overview.currentRound;
  const notes = overview.entrants
    .filter((entrant): entrant is PrivateArenaEntrantOverview & {
      valuation: PrivateArenaScore;
    } => entrant.valuation !== null)
    .map((entrant) =>
      describeEntrantValuationDisplay({
        valuation: entrant.valuation,
        noTrade: entrant.noTrade,
        currentRoundIndex: round?.roundIndex ?? null,
        currentRoundStage: round?.stage ?? null,
      }))
    .filter((note) => note.isHistorical);

  if (notes.length === 0) return null;
  if (notes.some((note) => note.freshness === "NO_TRADE_HISTORICAL")) {
    return "部分参赛者本轮未成交，表格中的清算净值可能是历史估值，不是当前轮次的实时市值。";
  }
  return "表格中的清算净值可能来自更早轮次或更早估值时点，请对照「估值时点」与当前轮次阶段，勿当作实时市值。";
}

export { valuationStageLabel };
