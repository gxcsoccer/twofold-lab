import type {
  PrivateArenaEntrantOverview,
  PrivateArenaOverview,
  PrivateArenaWorkOverview,
  PrivateArenaWorkStatus,
} from "./contracts";
import { isDeadlineBreach } from "./round-spine";

/**
 * Geometry for 「封存时序尺」.
 *
 * The axis is piecewise linear. Inside a market session, distance is exactly
 * proportional to time. Between sessions the real gap is compressed onto a
 * narrow band that is hatched and labelled, so the axis never silently lies
 * about how much time it skipped.
 */
interface AxisSegment {
  readonly fromAt: string;
  readonly toAt: string;
  readonly fromPct: number;
  readonly toPct: number;
}

export interface TimelineBand {
  readonly key: string;
  readonly label: string;
  readonly startPct: number;
  readonly spanPct: number;
  readonly compressed: boolean;
}

export interface TimelineSegment {
  readonly phase: string;
  readonly label: string;
  readonly status: PrivateArenaWorkStatus;
  readonly breached: boolean;
  readonly startPct: number;
  readonly spanPct: number;
  readonly title: string;
}

export interface TimelineFence {
  readonly key: string;
  readonly atPct: number;
  readonly breached: boolean;
}

export interface TimelineLane {
  readonly entrantId: string;
  readonly entrantCode: string;
  readonly executionLabel: string;
  readonly segments: readonly TimelineSegment[];
  readonly fences: readonly TimelineFence[];
}

export interface SealedTimeline {
  readonly bands: readonly TimelineBand[];
  readonly lanes: readonly TimelineLane[];
  readonly nowPct: number | null;
  readonly nowLabel: string;
  readonly nowIsLate: boolean;
}

/** Fixed share of the axis given to each interval of the round. */
const AXIS_SHARE: readonly { readonly key: string; readonly share: number }[] = [
  { key: "decision", share: 20 },
  { key: "overnight-1", share: 6 },
  { key: "s1", share: 30 },
  { key: "overnight-2", share: 6 },
  { key: "s2", share: 30 },
  { key: "settle", share: 8 },
];

/**
 * Preferred width for a phase block, and the floor it may shrink to when the
 * next phase starts soon after. A block never moves off its true position: the
 * position is the honest part, so crowding is resolved by trimming width, not
 * by nudging. Blocks also carry a `min-width` in px, which keeps a trimmed
 * block visible as a tick at any container width.
 */
const PREFERRED_SPAN_PCT = 2.4;
const MIN_SPAN_PCT = 0.3;
const SEGMENT_GAP_PCT = 0.2;

function parse(iso: string): number | null {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

function monthDay(sessionDate: string): string {
  return sessionDate.length === 10 ? sessionDate.slice(5) : sessionDate;
}

function buildAxis(
  round: NonNullable<PrivateArenaOverview["currentRound"]>,
  /** The settlement phase is scheduled *at* cycleReadyAt and its fence sits
   *  after it, so the axis has to reach past the round's ready time or the
   *  last phase collapses onto the right edge. */
  latestDeadlineAt: string | null,
): readonly AxisSegment[] | null {
  const cycleReady = parse(round.cycleReadyAt);
  const latest = latestDeadlineAt === null ? null : parse(latestDeadlineAt);
  const axisEnd = cycleReady !== null && latest !== null && latest > cycleReady
    ? latestDeadlineAt as string
    : round.cycleReadyAt;
  const anchors = [
    round.decisionWindowOpensAt,
    round.decisionWindowClosesAt,
    round.s1OpenAt,
    round.s1CloseAt,
    round.s2OpenAt,
    round.s2CloseAt,
    axisEnd,
  ];
  const times = anchors.map(parse);
  if (times.some((value) => value === null)) return null;
  // A frozen calendar must be monotonic; if it is not, refuse to draw an axis
  // rather than render a misleading one.
  for (let index = 1; index < times.length; index += 1) {
    if ((times[index] as number) < (times[index - 1] as number)) return null;
  }

  let cursor = 0;
  return AXIS_SHARE.map((entry, index) => {
    const fromPct = cursor;
    cursor += entry.share;
    return {
      fromAt: anchors[index],
      toAt: anchors[index + 1],
      fromPct,
      toPct: cursor,
    };
  });
}

/** Maps an instant onto the axis. Returns null when it lies outside the round. */
function positionOf(axis: readonly AxisSegment[], iso: string): number | null {
  const at = parse(iso);
  if (at === null) return null;
  const first = parse(axis[0].fromAt);
  const last = parse(axis[axis.length - 1].toAt);
  if (first === null || last === null) return null;
  if (at <= first) return 0;
  if (at >= last) return 100;

  for (const segment of axis) {
    const from = parse(segment.fromAt);
    const to = parse(segment.toAt);
    if (from === null || to === null) continue;
    if (at >= from && at <= to) {
      if (to === from) return segment.fromPct;
      const ratio = (at - from) / (to - from);
      return segment.fromPct + ratio * (segment.toPct - segment.fromPct);
    }
  }
  return null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function bandsOf(
  round: NonNullable<PrivateArenaOverview["currentRound"]>,
  axis: readonly AxisSegment[],
): readonly TimelineBand[] {
  const labels: readonly string[] = [
    `D ${monthDay(round.decisionSessionDate)} · 决策窗口`,
    "夜间（已压缩）",
    `S1 ${monthDay(round.s1SessionDate)} · 交易日`,
    "夜间（已压缩）",
    `S2 ${monthDay(round.s2SessionDate)} · 交易日`,
    "结算",
  ];
  return axis.map((segment, index) => ({
    key: AXIS_SHARE[index].key,
    label: labels[index],
    startPct: segment.fromPct,
    spanPct: segment.toPct - segment.fromPct,
    compressed: AXIS_SHARE[index].key.startsWith("overnight"),
  }));
}

function segmentOf(
  axis: readonly AxisSegment[],
  item: PrivateArenaWorkOverview,
  label: string,
  statusText: string,
  /** Where the following phase begins, so this block can be trimmed instead of
   *  covering it. Phases cluster at session boundaries inside the compressed
   *  bands, and a hidden phase is worse than a thin one. */
  nextStartPct: number,
): TimelineSegment | null {
  const rawStart = positionOf(axis, item.scheduledAt);
  if (rawStart === null) return null;
  // A phase landing exactly on the axis end still needs somewhere to draw, so
  // the last sliver of the axis is reserved. This is the one case where a block
  // moves, and it moves by at most MIN_SPAN_PCT.
  const start = Math.min(rawStart, 100 - MIN_SPAN_PCT);
  const end = item.deadlineAt === null ? null : positionOf(axis, item.deadlineAt);
  const rawSpan = end === null ? PREFERRED_SPAN_PCT : end - start;
  const room = Math.min(100, nextStartPct) - start - SEGMENT_GAP_PCT;
  const wanted = Math.max(PREFERRED_SPAN_PCT, rawSpan);
  const spanPct = Math.min(
    100 - start,
    Math.max(MIN_SPAN_PCT, Math.min(wanted, Math.max(0, room))),
  );
  return {
    phase: item.phase,
    label,
    status: item.status,
    breached: isDeadlineBreach(item),
    startPct: round2(start),
    spanPct: round2(spanPct),
    title: `${label} · ${statusText}`,
  };
}

/** Builds the instrument. Returns null when the round's frozen calendar cannot
 *  be trusted — the caller then shows the readable phase list only. */
export function buildSealedTimeline(
  overview: PrivateArenaOverview,
  phaseLabels: Readonly<Record<string, string>>,
  describe: (item: PrivateArenaWorkOverview) => string,
  executionLabel: (entrant: PrivateArenaEntrantOverview) => string,
  formatNow: (iso: string) => string,
): SealedTimeline | null {
  const round = overview.currentRound;
  if (round === null) return null;
  const deadlines = overview.entrants
    .flatMap((entrant) => entrant.work)
    .map((item) => item.deadlineAt)
    .filter((value): value is string => value !== null)
    .sort();
  const axis = buildAxis(round, deadlines.at(-1) ?? null);
  if (axis === null) return null;

  const lanes: TimelineLane[] = overview.entrants.map((entrant) => {
    const segments: TimelineSegment[] = [];
    const fences: TimelineFence[] = [];
    const starts = entrant.work.map((item) => positionOf(axis, item.scheduledAt));
    for (const [index, item] of entrant.work.entries()) {
      const following = starts.slice(index + 1).find((value) => value !== null);
      const segment = segmentOf(
        axis,
        item,
        phaseLabels[item.phase] ?? item.phase,
        describe(item),
        following ?? 100,
      );
      if (segment !== null) segments.push(segment);

      if (item.deadlineAt === null) continue;
      const atPct = positionOf(axis, item.deadlineAt);
      if (atPct === null) continue;
      fences.push({
        key: item.phase,
        atPct: round2(atPct),
        breached: isDeadlineBreach(item),
      });
    }
    return {
      entrantId: entrant.entrantId,
      entrantCode: entrant.entrantCode,
      executionLabel: executionLabel(entrant),
      segments,
      fences,
    };
  });

  const nowPct = positionOf(axis, overview.asOf);
  return {
    bands: bandsOf(round, axis),
    lanes,
    nowPct: nowPct === null ? null : round2(nowPct),
    nowLabel: formatNow(overview.asOf),
    // keep the flag inside the plot instead of letting it overflow the panel
    nowIsLate: nowPct !== null && nowPct > 78,
  };
}
