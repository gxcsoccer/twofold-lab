import {
  fetchAlpacaDailyBars,
  type AlpacaMarketDataConfig,
  type AlpacaMarketDelivery,
  type MarketSourceVersion,
} from "./market-data.js";
import type {
  ArenaCloseSnapshotStage,
  ArenaRoundCloseSnapshot,
} from "./arena-close-snapshot-repository.js";
import type { ArenaWorkHandler } from "./arena-work-runner.js";

/**
 * The daily-bars source version frozen with the Round's decision snapshot.
 * The evidence fence admits a close only under this exact source, so it is
 * Round state rather than deployment configuration.
 */
export interface ArenaCloseSnapshotFrozenSource extends MarketSourceVersion {
  readonly sourceVersionId: string;
}

export interface ArenaCloseSnapshotRoundSchedule {
  readonly roundId: string;
  readonly symbols: readonly string[];
  readonly source: ArenaCloseSnapshotFrozenSource;
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
    assertCloseCanCarryAnS2Plan(stage, schedule, input.now?.() ?? new Date());

    const delivery = await fetchAlpacaDailyBars(Object.freeze({
      ...input.config,
      // Deployment configuration names the route this Worker ingests with
      // today. A Round admits a close only under the source version frozen
      // with its decision snapshot, so the Round's own route wins here.
      symbols: schedule.symbols,
      dataUrl: schedule.source.endpointBaseUrl,
      feed: schedule.source.feed,
      licenseScope: schedule.source.licenseScope,
      sourceVersionKey: schedule.source.versionKey,
      sourceEffectiveFrom: schedule.source.effectiveFrom,
    }), {
      targetSessionDate: timing.sessionDate,
      endAt: timing.availableAt,
      ...(input.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: input.fetchImplementation }),
      ...(input.now === undefined ? {} : { now: input.now }),
      signal,
    });
    assertFrozenMarketSource(delivery.source, schedule.source);
    const persisted = await input.store.persist(item.roundId, stage, delivery);
    assertSharedIdentity(persisted, item.roundId, stage);
    return Object.freeze({
      outcome: "SHARED_CLOSE_SNAPSHOT_CAPTURED",
      snapshotId: persisted.snapshotId,
      manifestSha256: persisted.manifestSha256,
    });
  };
}

/**
 * The S2 plan's plannedAt is the sealed evidence instant, and a plan may not
 * be written on its own trade date. A close first sealed on the S2 session
 * date can therefore never carry a legal plan, however healthy the capture
 * looks. Refusing here costs one provider request and leaves no unusable
 * snapshot behind; the alternative is discovering it at settlement, hours
 * later, against evidence that already looks bound and correct.
 *
 * Reuse is never refused: evidence sealed in time stays legal no matter when
 * a later entrant item consumes it.
 */
function assertCloseCanCarryAnS2Plan(
  stage: ArenaCloseSnapshotStage,
  schedule: ArenaCloseSnapshotRoundSchedule,
  sealingAt: Date,
): void {
  if (stage !== "S1_CLOSE") return;
  const sealingDate = sealingAt.toISOString().slice(0, 10);
  if (sealingDate >= schedule.s2SessionDate) {
    throw new TypeError(
      `an S1 close first sealed on ${sealingDate} cannot plan S2 orders for `
      + `${schedule.s2SessionDate}: the plan instant is the sealed evidence, `
      + "so this Round can no longer settle S1",
    );
  }
}

const FROZEN_SOURCE_FIELDS = Object.freeze([
  "provider", "dataset", "versionKey", "endpointBaseUrl", "feed", "adjustment",
  "timeframe", "normalizerVersion", "licenseScope", "configSha256",
  "effectiveFrom",
] as const satisfies readonly (keyof MarketSourceVersion)[]);

/**
 * Names every field that keeps a capture out of the Round's frozen source.
 * The database fence can only report that the close missed the fence, so the
 * difference has to be observable here.
 */
export function assertFrozenMarketSource(
  captured: MarketSourceVersion,
  frozen: ArenaCloseSnapshotFrozenSource,
): void {
  const differences = FROZEN_SOURCE_FIELDS
    .filter((field) => captured[field] !== frozen[field])
    .map((field) => `${field} ${captured[field]} is not ${frozen[field]}`);
  if (differences.length > 0) {
    throw new TypeError(
      `captured close source does not match the Round source version `
      + `${frozen.sourceVersionId}: ${differences.join("; ")}`,
    );
  }
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
