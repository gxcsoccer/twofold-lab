import {
  fetchAlpacaOpenReferences,
  type AlpacaOpenReferenceConfig,
  type AlpacaOpenReferenceDelivery,
  type AlpacaOpenReferenceMethod,
} from "./alpaca-open-reference.js";
import type {
  ArenaOpenReference,
  ArenaOpenReferenceStage,
} from "./arena-open-reference-repository.js";
import type { ArenaWorkHandler } from "./arena-work-runner.js";

export interface ArenaOpenReferenceRoundSchedule {
  readonly roundId: string;
  readonly symbols: readonly string[];
  readonly openReferenceMethod: AlpacaOpenReferenceMethod;
  readonly s1SessionDate: string;
  readonly s1OpenAt: string;
  readonly s1ReferenceAvailableAt: string;
  readonly s2SessionDate: string;
  readonly s2OpenAt: string;
  readonly s2ReferenceAvailableAt: string;
}

export interface ArenaOpenReferenceStore {
  load(
    roundId: string,
    stage: ArenaOpenReferenceStage,
  ): Promise<ArenaOpenReference | null>;
  schedule(roundId: string): Promise<ArenaOpenReferenceRoundSchedule>;
  persist(
    roundId: string,
    stage: ArenaOpenReferenceStage,
    delivery: AlpacaOpenReferenceDelivery,
  ): Promise<ArenaOpenReference>;
}

export function createArenaOpenReferenceHandler(input: {
  readonly config: AlpacaOpenReferenceConfig;
  readonly store: ArenaOpenReferenceStore;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}): ArenaWorkHandler {
  return async (item, signal) => {
    const stage = stageForPhase(item.phase);
    const existing = await input.store.load(item.roundId, stage);
    if (existing !== null) {
      return Object.freeze({
        outcome: "SHARED_OPEN_REFERENCE_REUSED",
        referenceSnapshotId: existing.referenceSnapshotId,
        contentSha256: existing.contentSha256,
      });
    }

    const schedule = await input.store.schedule(item.roundId);
    if (schedule.roundId !== item.roundId) {
      throw new TypeError("open-reference schedule belongs to another Round");
    }
    const timing = stage === "S1_OPEN_REFERENCE"
      ? {
          sessionDate: schedule.s1SessionDate,
          expectedOpenAt: schedule.s1OpenAt,
          availableAt: schedule.s1ReferenceAvailableAt,
        }
      : {
          sessionDate: schedule.s2SessionDate,
          expectedOpenAt: schedule.s2OpenAt,
          availableAt: schedule.s2ReferenceAvailableAt,
        };
    if (item.scheduledAt !== timing.availableAt) {
      throw new TypeError("work item is not bound to the frozen availability time");
    }
    const delivery = await fetchAlpacaOpenReferences(Object.freeze({
      ...input.config,
      symbols: schedule.symbols,
    }), {
      method: schedule.openReferenceMethod,
      ...timing,
      ...(input.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: input.fetchImplementation }),
      ...(input.now === undefined ? {} : { now: input.now }),
      signal,
    });
    const persisted = await input.store.persist(item.roundId, stage, delivery);
    return Object.freeze({
      outcome: "SHARED_OPEN_REFERENCE_CAPTURED",
      referenceSnapshotId: persisted.referenceSnapshotId,
      contentSha256: persisted.contentSha256,
    });
  };
}

function stageForPhase(phase: string): ArenaOpenReferenceStage {
  if (phase === "CAPTURE_S1_OPEN_REFERENCE") return "S1_OPEN_REFERENCE";
  if (phase === "CAPTURE_S2_OPEN_REFERENCE") return "S2_OPEN_REFERENCE";
  throw new TypeError(`open-reference handler cannot execute ${phase}`);
}
