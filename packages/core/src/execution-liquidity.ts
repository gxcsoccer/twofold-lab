const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

export interface VolumeParticipationLimit {
  readonly requestedQuantity: string;
  readonly observedVolume: string;
  readonly maxParticipationBps: string;
  readonly maximumFillQuantity: string;
  readonly canceledQuantity: string;
  readonly constrained: boolean;
}

/**
 * One deterministic market-capacity fence for a simulated order. The observed
 * volume and participation rate are immutable evidence/policy inputs; integer
 * flooring deliberately never invents fractional or minimum-share liquidity.
 */
export function calculateVolumeParticipationLimit(input: {
  readonly requestedQuantity: string;
  readonly observedVolume: string;
  readonly maxParticipationBps: string;
}): VolumeParticipationLimit {
  const requested = integer(input.requestedQuantity, "requestedQuantity");
  const observed = integer(input.observedVolume, "observedVolume");
  const participation = integer(
    input.maxParticipationBps,
    "maxParticipationBps",
  );
  if (participation === 0n || participation > 10_000n) {
    throw new RangeError(
      "maxParticipationBps must be a canonical integer from 1 through 10000",
    );
  }
  const marketCapacity = observed * participation / 10_000n;
  const maximumFill = requested < marketCapacity ? requested : marketCapacity;
  return Object.freeze({
    requestedQuantity: requested.toString(),
    observedVolume: observed.toString(),
    maxParticipationBps: participation.toString(),
    maximumFillQuantity: maximumFill.toString(),
    canceledQuantity: (requested - maximumFill).toString(),
    constrained: maximumFill < requested,
  });
}

function integer(value: string, field: string): bigint {
  if (!INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative integer string`);
  }
  return BigInt(value);
}
