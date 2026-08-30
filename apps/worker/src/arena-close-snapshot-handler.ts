import {
  fetchAlpacaDailyBars,
  type AlpacaMarketDataConfig,
  type AlpacaMarketDelivery,
} from "./market-data.js";
import type {
  ArenaCloseSnapshotStage,
  ArenaRoundCloseSnapshot,
} from "./arena-close-snapshot-repository.js";
import type { ArenaWorkHandler } from "./arena-work-runner.js";

export interface ArenaCloseSnapshotRoundSchedule {
  readonly roundId: string;
  readonly symbols: readonly string[];
  readonly s1SessionDate: string;
  readonly s1CloseAvailableAt: string;
  readonly s2SessionDate: string;
  readonly s2CloseAvailableAt: string;
}

export interface ArenaCloseSnapshotStore {
  load(
    roundId: string,
    stage: ArenaCloseSnapshotStage,
  ): Promise<ArenaRoundCloseSnapshot | null>;
  schedule(roundId: string): Promise<ArenaCloseSnapshotRoundSchedule>;
  persist(
    roundId: string,
    stage: ArenaCloseSnapshotStage,
    delivery: AlpacaMarketDelivery,
  ): Promise<ArenaRoundCloseSnapshot>;
}

/**
 * Captures one immutable daily close per Round stage. Every entrant-scoped
 * queue item first reads the shared binding, so provider traffic and evidence
 * cannot diverge by entrant.
 */
export function createArenaCloseSnapshotHandler(input: {
  readonly config: AlpacaMarketDataConfig;
  readonly store: ArenaCloseSnapshotStore;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}): ArenaWorkHandler {
  return async (item, signal) => {
    const stage = stageForPhase(item.phase);
    const existing = await input.store.load(item.roundId, stage);
    if (existing !== null) {
      assertSharedIdentity(existing, item.roundId, stage);
      return Object.freeze({
        outcome: "SHARED_CLOSE_SNAPSHOT_REUSED",
        snapshotId: existing.snapshotId,
        manifestSha256: existing.manifestSha256,
      });
    }

    const schedule = await input.store.schedule(item.roundId);
    if (schedule.roundId !== item.roundId) {
      throw new TypeError("close-snapshot schedule belongs to another Round");
    }
    const timing = stage === "S1_CLOSE"
      ? {
          sessionDate: schedule.s1SessionDate,
          availableAt: schedule.s1CloseAvailableAt,
        }
      : {
          sessionDate: schedule.s2SessionDate,
          availableAt: schedule.s2CloseAvailableAt,
        };
    if (item.scheduledAt !== timing.availableAt) {
      throw new TypeError("work item is not bound to the frozen close availability time");
    }

    const delivery = await fetchAlpacaDailyBars(Object.freeze({
      ...input.config,
      symbols: schedule.symbols,
    }), {
      targetSessionDate: timing.sessionDate,
      endAt: timing.availableAt,
      ...(input.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: input.fetchImplementation }),
      ...(input.now === undefined ? {} : { now: input.now }),
      signal,
    });
    const persisted = await input.store.persist(item.roundId, stage, delivery);
    assertSharedIdentity(persisted, item.roundId, stage);
    return Object.freeze({
      outcome: "SHARED_CLOSE_SNAPSHOT_CAPTURED",
      snapshotId: persisted.snapshotId,
      manifestSha256: persisted.manifestSha256,
    });
  };
}

function stageForPhase(phase: string): ArenaCloseSnapshotStage {
  if (phase === "CAPTURE_S1_CLOSE") return "S1_CLOSE";
  if (phase === "CAPTURE_S2_CLOSE") return "S2_CLOSE";
  throw new TypeError(`close-snapshot handler cannot execute ${phase}`);
}

function assertSharedIdentity(
  value: ArenaRoundCloseSnapshot,
  roundId: string,
  stage: ArenaCloseSnapshotStage,
): void {
  if (value.roundId !== roundId || value.stage !== stage) {
    throw new TypeError("close-snapshot store returned different shared evidence");
  }
}
