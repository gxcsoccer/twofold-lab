import {
  fetchEcbUsdCnyReferenceCross,
  type EcbFxConfig,
  type EcbUsdCnyDelivery,
} from "./ecb-fx.js";
import type {
  ArenaRoundTaxFxReference,
  ArenaTaxFxStage,
} from "./arena-tax-fx-repository.js";
import type { ArenaWorkHandler } from "./arena-work-runner.js";

export interface ArenaTaxFxSchedule {
  readonly roundId: string;
  readonly s1SessionDate: string;
  readonly s1FxAvailableAt: string;
  readonly s2SessionDate: string;
  readonly s2FxAvailableAt: string;
}

export interface ArenaTaxFxStore {
  load(roundId: string, stage: ArenaTaxFxStage): Promise<ArenaRoundTaxFxReference | null>;
  schedule(roundId: string): Promise<ArenaTaxFxSchedule>;
  persist(
    roundId: string,
    stage: ArenaTaxFxStage,
    delivery: EcbUsdCnyDelivery,
  ): Promise<ArenaRoundTaxFxReference>;
}

export function createArenaTaxFxHandler(input: {
  readonly config: EcbFxConfig;
  readonly store: ArenaTaxFxStore;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
}): ArenaWorkHandler {
  return async (item, signal) => {
    const stage = stageForPhase(item.phase);
    const existing = await input.store.load(item.roundId, stage);
    if (existing !== null) {
      assertIdentity(existing, item.roundId, stage);
      return Object.freeze({
        outcome: "SHARED_TAX_FX_REUSED",
        fxRateId: existing.fxRateId,
        crossSha256: existing.crossSha256,
      });
    }
    const schedule = await input.store.schedule(item.roundId);
    if (schedule.roundId !== item.roundId) {
      throw new TypeError("tax-FX schedule belongs to another Round");
    }
    const timing = stage === "S1_DISPOSITION"
      ? { sessionDate: schedule.s1SessionDate, availableAt: schedule.s1FxAvailableAt }
      : { sessionDate: schedule.s2SessionDate, availableAt: schedule.s2FxAvailableAt };
    if (item.scheduledAt !== timing.availableAt) {
      throw new TypeError("tax-FX work is not bound to the close evidence boundary");
    }
    const delivery = await fetchEcbUsdCnyReferenceCross(input.config, {
      effectiveDate: timing.sessionDate,
      ...(input.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: input.fetchImplementation }),
      ...(input.now === undefined ? {} : { now: input.now }),
      signal,
    });
    const persisted = await input.store.persist(item.roundId, stage, delivery);
    assertIdentity(persisted, item.roundId, stage);
    return Object.freeze({
      outcome: "SHARED_TAX_FX_CAPTURED",
      fxRateId: persisted.fxRateId,
      crossSha256: persisted.crossSha256,
    });
  };
}

function stageForPhase(phase: string): ArenaTaxFxStage {
  if (phase === "CAPTURE_S1_CLOSE") return "S1_DISPOSITION";
  if (phase === "CAPTURE_S2_CLOSE") return "S2_ACQUISITION";
  throw new TypeError(`tax-FX handler cannot execute ${phase}`);
}

function assertIdentity(
  value: ArenaRoundTaxFxReference,
  roundId: string,
  stage: ArenaTaxFxStage,
): void {
  if (value.roundId !== roundId || value.stage !== stage) {
    throw new TypeError("tax-FX store returned different shared evidence");
  }
}
