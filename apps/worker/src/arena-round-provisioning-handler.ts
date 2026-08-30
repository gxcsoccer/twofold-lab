import type { TwoStageCycleCalendar } from "./alpaca-calendar.js";
import type { ArenaRoundProvisioning } from
  "./arena-round-provisioning-repository.js";

export interface ArenaRoundCalendarMaterial {
  readonly calendarArtifactId: string;
  readonly calendarArtifactSha256: string;
  readonly schedule: TwoStageCycleCalendar;
}

export interface ArenaRoundCalendarProvider {
  prepare(input: {
    readonly seasonId: string;
    readonly seasonCode: string;
    readonly roundIndex: string;
    readonly decisionSessionDate: string;
    readonly decisionAvailableAt: string;
    readonly calendarStartDate: string;
    readonly calendarEndDate: string;
    readonly recordedBy: string;
    readonly signal: AbortSignal;
  }): Promise<ArenaRoundCalendarMaterial>;
}

export type ArenaRoundProvisioningHandler = (
  item: ArenaRoundProvisioning,
  signal: AbortSignal,
) => Promise<ArenaRoundCalendarMaterial>;

/**
 * Turn the prior completed S2 close into a future executable exchange window.
 * The fetch horizon follows actual worker availability so a delayed scheduler
 * can skip already-missed sessions without changing the causal decision date.
 */
export function createArenaRoundProvisioningHandler(input: {
  readonly calendar: ArenaRoundCalendarProvider;
  readonly now?: () => Date;
}): ArenaRoundProvisioningHandler {
  const now = input.now ?? (() => new Date());
  return async (item, signal) => {
    signal.throwIfAborted();
    const observedAt = now().toISOString();
    const decisionAvailableAt = Date.parse(observedAt)
      > Date.parse(item.decisionAvailableAt)
      ? observedAt
      : item.decisionAvailableAt;
    const horizonBase = decisionAvailableAt.slice(0, 10)
      > item.decisionSessionDate
      ? decisionAvailableAt.slice(0, 10)
      : item.decisionSessionDate;
    return input.calendar.prepare({
      seasonId: item.seasonId,
      seasonCode: item.seasonCode,
      roundIndex: item.nextRoundIndex,
      decisionSessionDate: item.decisionSessionDate,
      decisionAvailableAt,
      calendarStartDate: item.decisionSessionDate,
      calendarEndDate: addUtcDays(horizonBase, 14),
      recordedBy: item.recordedBy,
      signal,
    });
  };
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
