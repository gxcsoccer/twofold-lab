import type {
  PrivateArenaNoTradeOverview,
  PrivateArenaWorkOverview,
} from "./contracts";

/** Lead sentence: what actually happened at the frozen fence. */
function deadlineLead(
  item: Pick<PrivateArenaWorkOverview, "errorCode" | "deadlineAt">,
  formatDeadline: (iso: string) => string,
): string {
  const fence = item.deadlineAt === null
    ? "冻结截止时间"
    : formatDeadline(item.deadlineAt);
  if (item.errorCode === "DEADLINE_EXPIRED_DURING_EXECUTION") {
    return `工作在 ${fence} 之后才返回，已记为失败。本轮不再重试，也不会补发成交；`;
  }
  if (item.errorCode === "DEADLINE_EXPIRED") {
    return `未领取的工作已在 ${fence} 被扫过并取消。本轮不再重试，也不会补发成交；`;
  }
  return `该阶段越过冻结截止线。本轮不再重试，也不会补发成交；`;
}

/** Carry-forward is only complete when no-trade work succeeded. */
function noTradeTrail(
  noTrade: Pick<PrivateArenaNoTradeOverview, "status"> | null,
): string {
  if (noTrade?.status === "SUCCEEDED") {
    return "该参赛者的账本逐字节保留，持仓不变，并按同一 S2 收盘估值结转。";
  }
  if (noTrade?.status === "FAILED") {
    return "该参赛者的账本逐字节保留，持仓不变。持仓结转失败。";
  }
  if (noTrade?.status === "REQUESTED" || noTrade?.status === "CLAIMED") {
    return "该参赛者的账本逐字节保留，持仓不变。持仓结转仍在等待。";
  }
  return "该参赛者的账本逐字节保留，持仓不变。";
}

/** Chinese alert copy for a deadline-breach card. Fail-closed: no invented events. */
export function describeDeadlineBreach(
  item: Pick<PrivateArenaWorkOverview, "errorCode" | "deadlineAt">,
  noTrade: Pick<PrivateArenaNoTradeOverview, "status"> | null,
  formatDeadline: (iso: string) => string,
): string {
  return `${deadlineLead(item, formatDeadline)}${noTradeTrail(noTrade)}`;
}
