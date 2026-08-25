import { createHash } from "node:crypto";

import {
  createOpeningLedgerTransactions,
  parseInitialPortfolioSnapshot,
  replayLedger,
} from "@twofold/core";

export interface PortfolioArtifactValidation {
  readonly snapshotId: string;
  readonly asOf: string;
  readonly brokerLegalEntity: string;
  readonly accountRegion: string;
  readonly baseCurrency: string;
  readonly sourceArtifactSha256: string;
  readonly sourceByteSize: string;
  readonly cashCurrencies: readonly string[];
  readonly lotCount: string;
  readonly positions: readonly {
    readonly instrumentId: string;
    readonly symbol: string;
    readonly quantity: string;
    readonly lotCount: string;
  }[];
  readonly openingTransactionCount: string;
  readonly ledgerPositionCount: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Validate a normalized, string-decimal portfolio snapshot against the exact
 * bytes of the original Futu statement/CSV. This function is read-only: it
 * deliberately performs no Supabase writes until the user has reviewed the
 * source-bound summary.
 */
export function validatePortfolioArtifacts(input: {
  readonly snapshotJsonText: string;
  readonly sourceBytes: Uint8Array;
}): PortfolioArtifactValidation {
  if (input.sourceBytes.byteLength === 0) {
    throw new TypeError("source artifact must not be empty");
  }

  let untrustedSnapshot: unknown;
  try {
    untrustedSnapshot = JSON.parse(input.snapshotJsonText) as unknown;
  } catch (error) {
    throw new TypeError(`snapshot file is not valid JSON: ${String(error)}`);
  }

  const snapshot = parseInitialPortfolioSnapshot(untrustedSnapshot);
  const actualSourceSha256 = sha256Hex(input.sourceBytes);
  if (actualSourceSha256 !== snapshot.sourceArtifactSha256) {
    throw new TypeError(
      `source artifact SHA-256 mismatch: expected ${snapshot.sourceArtifactSha256}, received ${actualSourceSha256}`,
    );
  }

  const openingTransactions = createOpeningLedgerTransactions({
    runId: `portfolio-validation:${snapshot.snapshotId}`,
    sourceEventId: `portfolio-source:${actualSourceSha256}`,
    snapshot,
  });
  const ledger = replayLedger(openingTransactions);
  const lotsByInstrument = new Map<
    string,
    { symbol: string; quantity: bigint; lotCount: bigint }
  >();
  for (const lot of snapshot.lots) {
    const current = lotsByInstrument.get(lot.instrumentId) ?? {
      symbol: lot.symbol,
      quantity: 0n,
      lotCount: 0n,
    };
    if (current.symbol !== lot.symbol) {
      throw new TypeError(
        `instrument ${lot.instrumentId} has conflicting symbols in one snapshot`,
      );
    }
    lotsByInstrument.set(lot.instrumentId, {
      symbol: current.symbol,
      quantity: current.quantity + BigInt(lot.quantity),
      lotCount: current.lotCount + 1n,
    });
  }

  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    asOf: snapshot.asOf,
    brokerLegalEntity: snapshot.brokerLegalEntity,
    accountRegion: snapshot.accountRegion,
    baseCurrency: snapshot.baseCurrency,
    sourceArtifactSha256: actualSourceSha256,
    sourceByteSize: input.sourceBytes.byteLength.toString(),
    cashCurrencies: Object.freeze(
      snapshot.cashBalances.map((balance) => balance.currency),
    ),
    lotCount: snapshot.lots.length.toString(),
    positions: Object.freeze(
      [...lotsByInstrument.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([instrumentId, position]) => Object.freeze({
          instrumentId,
          symbol: position.symbol,
          quantity: position.quantity.toString(),
          lotCount: position.lotCount.toString(),
        })),
    ),
    openingTransactionCount: openingTransactions.length.toString(),
    ledgerPositionCount: ledger.positions.length.toString(),
  });
}
