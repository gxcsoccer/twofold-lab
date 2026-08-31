import type {
  PrivateArenaEntrantOverview,
  PrivateArenaOverview,
  PrivateArenaRoundStage,
  PrivateArenaWorkOverview,
  PrivateArenaWorkPhase,
  StatusTone,
} from "./contracts";

/**
 * `breached` means a frozen deadline was crossed, which can never be retried
 * into a success. `failed` is any other terminal failure — it needs attention
 * too, but claiming a fence was breached when it was not misreports the one
 * rule this console exists to enforce.
 */
export type SpineNodeState =
  | "sealed"
  | "current"
  | "upcoming"
  | "failed"
  | "breached";

export interface SpineNode {
  readonly id: "D" | "S1" | "S2" | "FINAL";
  readonly label: string;
  readonly state: SpineNodeState;
}

export interface RoundBoundary {
  readonly label: string;
  readonly at: string;
  /** The frozen time has already passed as of the projection's `asOf`, so the
   *  phase is late rather than upcoming. */
  readonly overdue: boolean;
}

export interface RoundSpineModel {
  readonly roundIndex: string;
  readonly nodes: readonly SpineNode[];
  readonly asOf: string;
  readonly boundary: RoundBoundary | null;
  readonly breachCount: number;
  readonly failureCount: number;
}

/** Which market session each work phase belongs to. */
const PHASE_NODE: Readonly<Record<PrivateArenaWorkPhase, SpineNode["id"]>> = {
  RUN_AGENT_DECISION: "D",
  PREPARE_S1_ORDERS: "S1",
  CAPTURE_S1_OPEN_REFERENCE: "S1",
  CAPTURE_S1_CLOSE: "S1",
  SETTLE_S1_AND_PREPARE_S2: "S2",
  CAPTURE_S2_OPEN_REFERENCE: "S2",
  CAPTURE_S2_CLOSE: "S2",
  FINALIZE_ACCEPTED_TARGET_CYCLE: "FINAL",
};

const STAGE_NODE: Readonly<Record<PrivateArenaRoundStage, SpineNode["id"]>> = {
  SCHEDULED: "D",
  DECISION_WINDOW: "D",
  WAITING_S1_OPEN: "S1",
  S1_EXECUTION: "S1",
  SETTLING_S1: "S2",
  S2_EXECUTION: "S2",
  FINALIZING: "FINAL",
  COMPLETE: "FINAL",
};

const NODE_ORDER: readonly SpineNode["id"][] = ["D", "S1", "S2", "FINAL"];

/** A frozen deadline was crossed. This can never be retried into a success. */
export function isDeadlineBreach(item: PrivateArenaWorkOverview): boolean {
  return item.errorCode === "DEADLINE_EXPIRED"
    || item.errorCode === "DEADLINE_EXPIRED_DURING_EXECUTION";
}

export interface PhaseState {
  readonly label: string;
  readonly succeeded: number;
  /** Entrants still expected to complete this phase. Canceled work is not: once
   *  an entrant is canceled into carry-forward it is no longer awaited. */
  readonly expected: number;
  readonly canceled: number;
  readonly tone: StatusTone;
  readonly scheduledAt: string | null;
  readonly deadlineAt: string | null;
}

/** Aggregates one phase across every entrant for the readable execution chain. */
export function derivePhaseState(
  entrants: readonly PrivateArenaEntrantOverview[],
  phase: PrivateArenaWorkPhase,
): PhaseState {
  const items = entrants.flatMap((entrant) =>
    entrant.work.filter((item) => item.phase === phase)
  );
  const succeeded = items.filter((item) => item.status === "SUCCEEDED").length;
  const canceled = items.filter((item) => item.status === "CANCELED").length;
  const base = {
    succeeded,
    expected: items.length - canceled,
    canceled,
    scheduledAt: items[0]?.scheduledAt ?? null,
    deadlineAt: items[0]?.deadlineAt ?? null,
  };

  if (items.length === 0) return { ...base, label: "尚未排程", tone: "neutral" };
  if (items.some(isDeadlineBreach)) return { ...base, label: "已越界", tone: "critical" };
  if (items.some((item) => item.status === "FAILED")) {
    return { ...base, label: "需要处理", tone: "critical" };
  }
  if (succeeded === items.length) return { ...base, label: "已封存", tone: "positive" };
  if (items.some((item) => item.status === "CLAIMED")) {
    return { ...base, label: "执行中", tone: "warning" };
  }
  // CANCELED is terminal. Once every item is either sealed or canceled there is
  // nothing left to wait for, so an all-canceled phase must not read as
  // scheduled.
  if (succeeded + canceled === items.length) {
    return succeeded > 0
      ? { ...base, label: "已封存", tone: "positive" }
      : { ...base, label: "已取消", tone: "neutral" };
  }
  return { ...base, label: "等待时点", tone: "neutral" };
}

function stageBoundary(
  round: NonNullable<PrivateArenaOverview["currentRound"]>,
): { readonly label: string; readonly at: string } | null {
  switch (round.stage) {
    case "SCHEDULED":
      return { label: "决策窗口开启", at: round.decisionWindowOpensAt };
    case "DECISION_WINDOW":
      return { label: "决策截止", at: round.decisionWindowClosesAt };
    case "WAITING_S1_OPEN":
      return { label: "S1 开盘", at: round.s1OpenAt };
    case "S1_EXECUTION":
      return { label: "S1 收盘", at: round.s1CloseAt };
    case "SETTLING_S1":
      return { label: "S2 开盘", at: round.s2OpenAt };
    case "S2_EXECUTION":
      return { label: "S2 收盘", at: round.s2CloseAt };
    case "FINALIZING":
      return { label: "可结算时点", at: round.cycleReadyAt };
    default:
      return null;
  }
}

/**
 * The frozen boundary this stage is bounded by, or null when the round has
 * nothing left to wait for.
 *
 * A stage can outlive its own boundary: `FINALIZING` begins at `s2CloseAt` and
 * persists until every S2 valuation is written, so a stalled finalization sits
 * past `cycleReadyAt`. The same is true of any stage the Worker falls behind on.
 * Rather than presenting a past instant as the "next" one, the boundary is
 * returned with `overdue` set, and callers say it is late.
 */
export function nextRoundBoundary(
  round: NonNullable<PrivateArenaOverview["currentRound"]>,
  asOf: string,
): RoundBoundary | null {
  const boundary = stageBoundary(round);
  if (boundary === null) return null;
  const at = Date.parse(boundary.at);
  const now = Date.parse(asOf);
  // An unreadable timestamp is not evidence that the boundary has passed.
  const overdue = Number.isFinite(at) && Number.isFinite(now) && now > at;
  return { ...boundary, overdue };
}

function monthDay(sessionDate: string): string {
  return sessionDate.length === 10 ? sessionDate.slice(5) : sessionDate;
}

function nodeState(
  items: readonly PrivateArenaWorkOverview[],
  isCurrent: boolean,
  isPast: boolean,
): SpineNodeState {
  if (items.some(isDeadlineBreach)) return "breached";
  // An ordinary terminal failure (ARENA_PHASE_FAILED, WORKER_ABORTED, …) is not
  // a crossed fence, and must not be painted as one.
  if (items.some((item) => item.status === "FAILED")) return "failed";
  if (items.length > 0 && items.every((item) => item.status === "SUCCEEDED")) {
    return "sealed";
  }
  if (items.some((item) => item.status === "CLAIMED")) return "current";
  // A session the round has already moved past is settled, even when one
  // entrant's work in it was canceled into a carry-forward. Only a breach can
  // make a past session read as anything other than sealed.
  if (isPast) return "sealed";
  return isCurrent ? "current" : "upcoming";
}

function countBreaches(entrants: readonly PrivateArenaEntrantOverview[]): number {
  return entrants.filter((entrant) => entrant.work.some(isDeadlineBreach)).length;
}

/** Entrants with a terminal failure that was not a crossed fence. */
function countFailures(entrants: readonly PrivateArenaEntrantOverview[]): number {
  return entrants.filter((entrant) =>
    entrant.work.some((item) => item.status === "FAILED" && !isDeadlineBreach(item))
  ).length;
}

/** Derives the always-visible round tape. Returns null when there is no frozen
 *  round to report — the spine then says so rather than inventing a state. */
export function deriveRoundSpine(
  overview: PrivateArenaOverview | null,
): RoundSpineModel | null {
  if (overview === null || overview.currentRound === null) return null;
  const round = overview.currentRound;
  const currentNode = STAGE_NODE[round.stage];
  const currentIndex = NODE_ORDER.indexOf(currentNode);

  const grouped = new Map<SpineNode["id"], PrivateArenaWorkOverview[]>(
    NODE_ORDER.map((id) => [id, []]),
  );
  for (const entrant of overview.entrants) {
    for (const item of entrant.work) {
      grouped.get(PHASE_NODE[item.phase])?.push(item);
    }
  }

  const labels: Readonly<Record<SpineNode["id"], string>> = {
    D: `D ${monthDay(round.decisionSessionDate)}`,
    S1: `S1 ${monthDay(round.s1SessionDate)}`,
    S2: `S2 ${monthDay(round.s2SessionDate)}`,
    FINAL: "结算",
  };

  return {
    roundIndex: round.roundIndex,
    asOf: overview.asOf,
    boundary: nextRoundBoundary(round, overview.asOf),
    breachCount: countBreaches(overview.entrants),
    failureCount: countFailures(overview.entrants),
    nodes: NODE_ORDER.map((id, index) => ({
      id,
      label: labels[id],
      state: nodeState(
        grouped.get(id) ?? [],
        id === currentNode,
        index < currentIndex,
      ),
    })),
  };
}
