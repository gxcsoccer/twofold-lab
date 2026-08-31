import type { LiquidUniverseFreezeArtifact } from "./liquid-universe.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface SealedUniverseSnapshot {
  readonly snapshotId: string;
  readonly targetSessionDate: string;
  readonly sealedAt: string;
  readonly symbols: readonly string[];
}

export interface UsLiquid100ActivationPlan {
  readonly snapshotId: string;
  readonly decisionAvailableAt: string;
  readonly seasonOpensAt: string;
}

/**
 * Bind an immutable research universe to an immutable market snapshot, then
 * place the mutable control-plane work strictly before the Season opens.
 */
export function planUsLiquid100Activation(input: {
  readonly artifact: LiquidUniverseFreezeArtifact;
  readonly snapshot: SealedUniverseSnapshot;
  readonly now: string;
  readonly activationDelayMinutes: number;
}): UsLiquid100ActivationPlan {
  if (
    input.artifact.schema !== "twofold.liquid_universe_freeze/v1"
    || input.artifact.name !== "US Liquid 100"
    || input.artifact.members.length !== 100
  ) throw new TypeError("US Liquid 100 artifact must contain 100 members");
  if (!UUID_PATTERN.test(input.snapshot.snapshotId)) {
    throw new TypeError("snapshotId must be a UUID");
  }
  if (input.snapshot.targetSessionDate !== input.artifact.asOfSessionDate) {
    throw new TypeError("snapshot session does not match the frozen universe");
  }
  const artifactSymbols = input.artifact.members
    .map((member) => member.symbol)
    .sort(compareText);
  const snapshotSymbols = [...input.snapshot.symbols].sort(compareText);
  if (
    new Set(artifactSymbols).size !== 100
    || new Set(snapshotSymbols).size !== 100
    || artifactSymbols.some((symbol, index) => symbol !== snapshotSymbols[index])
  ) throw new TypeError("snapshot does not reproduce the frozen member set");
  if (
    !Number.isSafeInteger(input.activationDelayMinutes)
    || input.activationDelayMinutes < 1
    || input.activationDelayMinutes > 60
  ) throw new RangeError("activation delay must be an integer from 1 to 60 minutes");

  const now = instant(input.now, "now");
  const frozenAt = instant(input.artifact.frozenAt, "artifact.frozenAt");
  const sealedAt = instant(input.snapshot.sealedAt, "snapshot.sealedAt");
  const activationAt = new Date(Math.max(
    now + input.activationDelayMinutes * 60_000,
    frozenAt,
    sealedAt + 1,
  )).toISOString();
  return Object.freeze({
    snapshotId: input.snapshot.snapshotId,
    decisionAvailableAt: activationAt,
    seasonOpensAt: activationAt,
  });
}

function instant(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a timestamp`);
  return parsed;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
