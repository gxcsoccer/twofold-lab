import type { ArenaMarketSnapshot, ArenaPortfolioState } from "./arena-inputs.js";
import type { ArenaRoundCloseSnapshot } from
  "./arena-close-snapshot-repository.js";
import type { ArenaNoTradeRecovery } from
  "./arena-no-trade-recovery-repository.js";
import { buildArenaValuation, type BuiltArenaValuation } from
  "./arena-valuation.js";

export interface ArenaNoTradeRecoverySource {
  closeSnapshot(roundId: string): Promise<ArenaRoundCloseSnapshot | null>;
  marketSnapshot(snapshotId: string): Promise<ArenaMarketSnapshot>;
  portfolioState(runId: string): Promise<ArenaPortfolioState>;
  scoreBase(seasonId: string, entrantId: string): Promise<string>;
}

export type ArenaNoTradeRecoveryHandler = (
  item: ArenaNoTradeRecovery,
  signal: AbortSignal,
) => Promise<BuiltArenaValuation>;

/**
 * Revalue the byte-identical ledger at the Round-shared S2 close. This handler
 * never creates a target, order, fill, settlement, or accounting transaction.
 */
export function createArenaNoTradeRecoveryHandler(input: {
  readonly source: ArenaNoTradeRecoverySource;
}): ArenaNoTradeRecoveryHandler {
  return async (item, signal) => {
    signal.throwIfAborted();
    const close = await input.source.closeSnapshot(item.roundId);
    if (close === null) {
      throw new Error("shared S2 close snapshot is unavailable");
    }
    if (
      close.stage !== "S2_CLOSE"
      || close.roundId !== item.roundId
      || close.seasonId !== item.seasonId
    ) {
      throw new TypeError("shared S2 close binding has inconsistent identity");
    }

    signal.throwIfAborted();
    const snapshot = await input.source.marketSnapshot(close.snapshotId);
    if (
      snapshot.snapshotId !== close.snapshotId
      || snapshot.sourceVersionId !== close.sourceVersionId
      || snapshot.manifestSha256 !== close.manifestSha256
      || snapshot.targetSessionDate !== close.sessionDate
      || !sameInstant(snapshot.cutoffAt, close.cutoffAt)
      || !sameInstant(snapshot.sealedAt, close.sealedAt)
    ) {
      throw new TypeError("sealed market snapshot does not match its shared S2 binding");
    }

    signal.throwIfAborted();
    const [portfolioState, scoreBaseLiquidationNav] = await Promise.all([
      input.source.portfolioState(item.runId),
      input.source.scoreBase(item.seasonId, item.entrantId),
    ]);
    if (portfolioState.runId !== item.runId) {
      throw new TypeError("no-trade portfolio belongs to a different Run");
    }
    signal.throwIfAborted();
    const valuation = buildArenaValuation({
      stage: "S2_CLOSE",
      snapshot,
      portfolioState,
      scoreBaseLiquidationNav,
    });
    if (
      valuation.payload.ledgerSequence !== portfolioState.ledgerHead.sequence
      || valuation.payload.ledgerSha256 !== portfolioState.ledgerHead.sha256
    ) {
      throw new TypeError("no-trade valuation changed the ledger head");
    }
    return valuation;
  };
}

/**
 * PostgREST returns timestamptz values with an explicit offset and may retain
 * microseconds; the close-binding RPC deliberately publishes canonical
 * millisecond ISO instants. Compare the represented millisecond while the
 * immutable snapshot identity and manifest hash remain exact.
 */
function sameInstant(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && leftTime === rightTime;
}
