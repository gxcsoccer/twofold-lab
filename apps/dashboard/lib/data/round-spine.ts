import type {
  PrivateArenaEntrantOverview,
  PrivateArenaOverview,
  PrivateArenaRoundStage,
  PrivateArenaWorkOverview,
  PrivateArenaWorkPhase,
  StatusTone,
} from "./contracts";

export type SpineNodeState = "sealed" | "current" | "upcoming" | "breached";

export interface SpineNode {
  readonly id: "D" | "S1" | "S2" | "FINAL";
  readonly label: string;
  readonly state: SpineNodeState;
}

export interface RoundSpineModel {
  readonly roundIndex: string;
  readonly nodes: readonly SpineNode[];
  readonly asOf: string;
  readonly boundaryLabel: string | null;
  readonly boundaryAt: string | null;
  readonly breachCount: number;
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

export function workTone(item: PrivateArenaWorkOverview): StatusTone {
  if (item.status === "SUCCEEDED") return "positive";
  if (item.status === "FAILED") return "critical";
  if (item.status === "CANCELED") return "neutral";
  if (item.status === "CLAIMED") return "warning";
  return "neutral";
}

/** The next frozen boundary the operator is waiting on, or null when the
 *  round has nothing left to wait for. */
export function nextRoundBoundary(
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

function monthDay(sessionDate: string): string {
  return sessionDate.length === 10 ? sessionDate.slice(5) : sessionDate;
}

function nodeState(
  items: readonly PrivateArenaWorkOverview[],
  isCurrent: boolean,
  isPast: boolean,
): SpineNodeState {
  if (items.some(isDeadlineBreach)) return "breached";
  if (items.some((item) => item.status === "FAILED")) return "breached";
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

  const boundary = nextRoundBoundary(round);
  return {
    roundIndex: round.roundIndex,
    asOf: overview.asOf,
    boundaryLabel: boundary?.label ?? null,
    boundaryAt: boundary?.at ?? null,
    breachCount: countBreaches(overview.entrants),
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
