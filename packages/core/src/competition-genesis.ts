import { createHash } from "node:crypto";

import { canonicalFinancialJson, compareCodePoints } from "./canonical-json.js";
import { compareDecimals, multiplyDecimals, normalizeDecimal } from "./fixed-decimal.js";
import { replayLedger, type LedgerProjection, type LedgerTransaction } from "./ledger.js";
import {
  createOpeningLedgerTransactions,
  INITIAL_PORTFOLIO_SCHEMA,
  type InitialCashBalanceInput,
  type InitialPortfolioSnapshot,
  type InitialPositionLotInput,
  validateInitialPortfolioSnapshot,
} from "./portfolio.js";
import type { DecimalString } from "./decimal.js";

export const COMPETITION_GENESIS_SCHEMA = "twofold.competition_genesis/v1";
export const COMPETITION_GENESIS_RESULT_SCHEMA =
  "twofold.competition_genesis_result/v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface CompetitionGenesisAcquisitionFxInput {
  readonly effectiveDate: string;
  readonly cnyPerUsd: string;
  readonly authority: string;
  readonly sourceArtifactId: string;
  readonly sourceSha256: string;
  readonly observedAt: string;
  readonly availableAt: string;
}

export interface CompetitionGenesisLotInput extends InitialPositionLotInput {
  readonly acquisitionFx: CompetitionGenesisAcquisitionFxInput;
}

export interface CompetitionGenesisEntrantInput {
  readonly entrantId: string;
  readonly runId: string;
  readonly sourceEventId: string;
}

export interface CompetitionGenesisInput {
  readonly schema: typeof COMPETITION_GENESIS_SCHEMA;
  readonly genesisId: string;
  readonly seasonId: string;
  readonly asOf: string;
  readonly brokerLegalEntity: string;
  readonly accountRegion: string;
  readonly baseCurrency: string;
  readonly openingStateArtifactId: string;
  readonly openingStateArtifactSha256: string;
  readonly cashBalances: readonly InitialCashBalanceInput[];
  readonly lots: readonly CompetitionGenesisLotInput[];
  readonly entrants: readonly CompetitionGenesisEntrantInput[];
}

export interface CompetitionGenesisAcquisitionFxBinding {
  readonly lotId: string;
  readonly instrumentId: string;
  readonly effectiveDate: string;
  readonly cnyPerUsd: DecimalString;
  readonly acquisitionTaxBasisCny: DecimalString;
  readonly authority: string;
  readonly sourceArtifactId: string;
  readonly sourceSha256: string;
  readonly observedAt: string;
  readonly availableAt: string;
}

export interface CompetitionGenesisEconomicState {
  readonly schema: "twofold.competition_economic_state/v1";
  readonly genesisId: string;
  readonly seasonId: string;
  readonly openingStateArtifactId: string;
  readonly snapshot: InitialPortfolioSnapshot;
  readonly acquisitionFxBindings:
    readonly CompetitionGenesisAcquisitionFxBinding[];
}

export interface CompetitionGenesisRun {
  readonly entrantId: string;
  readonly runId: string;
  readonly sourceEventId: string;
  readonly economicSha256: string;
  readonly openingTransactions: readonly LedgerTransaction[];
  readonly ledger: LedgerProjection;
  readonly instanceCanonicalJson: string;
  readonly instanceSha256: string;
}

export interface CompetitionGenesisResult {
  readonly schema: typeof COMPETITION_GENESIS_RESULT_SCHEMA;
  readonly genesisId: string;
  readonly seasonId: string;
  readonly economicState: CompetitionGenesisEconomicState;
  readonly economicCanonicalJson: string;
  readonly economicSha256: string;
  readonly runs: readonly CompetitionGenesisRun[];
}

/**
 * Freeze one evidence-bound economic starting state and clone it into isolated
 * Strategy Runs. The economic hash is shared; all ledger identities are scoped
 * to a run. This is the fairness boundary for a competition, not an importer
 * for a contestant's personal brokerage account.
 */
export function createCompetitionGenesis(
  input: CompetitionGenesisInput,
): CompetitionGenesisResult {
  if (input.schema !== COMPETITION_GENESIS_SCHEMA) {
    throw new TypeError(`Unsupported competition genesis schema: ${input.schema}`);
  }
  requireIdentity(input.genesisId, "genesisId");
  requireIdentity(input.seasonId, "seasonId");
  requireIdentity(input.openingStateArtifactId, "openingStateArtifactId");
  if (!SHA256_PATTERN.test(input.openingStateArtifactSha256)) {
    throw new TypeError(
      "openingStateArtifactSha256 must be a lowercase SHA-256 digest",
    );
  }
  if (input.entrants.length === 0) {
    throw new TypeError("competition genesis requires at least one entrant");
  }

  const snapshot = validateInitialPortfolioSnapshot({
    snapshotId: input.genesisId,
    schema: INITIAL_PORTFOLIO_SCHEMA,
    asOf: input.asOf,
    brokerLegalEntity: input.brokerLegalEntity,
    accountRegion: input.accountRegion,
    baseCurrency: input.baseCurrency,
    sourceArtifactSha256: input.openingStateArtifactSha256,
    cashBalances: input.cashBalances,
    lots: input.lots.map(({ acquisitionFx: _acquisitionFx, ...lot }) => lot),
  });

  const inputLotById = new Map(input.lots.map((lot) => [lot.lotId, lot]));
  const acquisitionFxBindings = snapshot.lots.map(
    (lot): CompetitionGenesisAcquisitionFxBinding => {
      const acquisitionFx = inputLotById.get(lot.lotId)!.acquisitionFx;
      requireIdentity(
        acquisitionFx.authority,
        `lots[${lot.lotId}].acquisitionFx.authority`,
      );
      requireIdentity(
        acquisitionFx.sourceArtifactId,
        `lots[${lot.lotId}].acquisitionFx.sourceArtifactId`,
      );
      if (!SHA256_PATTERN.test(acquisitionFx.sourceSha256)) {
        throw new TypeError(
          `lots[${lot.lotId}].acquisitionFx.sourceSha256 must be a lowercase SHA-256 digest`,
        );
      }
      if (acquisitionFx.effectiveDate !== lot.acquiredOn) {
        throw new TypeError(
          `lots[${lot.lotId}] acquisition FX date must equal acquiredOn`,
        );
      }
      requireIsoTimestamp(
        acquisitionFx.observedAt,
        `lots[${lot.lotId}].acquisitionFx.observedAt`,
      );
      requireIsoTimestamp(
        acquisitionFx.availableAt,
        `lots[${lot.lotId}].acquisitionFx.availableAt`,
      );
      if (acquisitionFx.observedAt > acquisitionFx.availableAt) {
        throw new RangeError(
          `lots[${lot.lotId}] acquisition FX was available before observation`,
        );
      }
      if (acquisitionFx.availableAt > snapshot.asOf) {
        throw new RangeError(
          `lots[${lot.lotId}] acquisition FX was unavailable at genesis`,
        );
      }
      const cnyPerUsd = normalizeDecimal(acquisitionFx.cnyPerUsd);
      if (compareDecimals(cnyPerUsd, "0") <= 0) {
        throw new RangeError(
          `lots[${lot.lotId}].acquisitionFx.cnyPerUsd must be positive`,
        );
      }

      return Object.freeze({
        lotId: lot.lotId,
        instrumentId: lot.instrumentId,
        effectiveDate: acquisitionFx.effectiveDate,
        cnyPerUsd,
        acquisitionTaxBasisCny: multiplyDecimals(lot.taxBasis, cnyPerUsd),
        authority: acquisitionFx.authority,
        sourceArtifactId: acquisitionFx.sourceArtifactId,
        sourceSha256: acquisitionFx.sourceSha256,
        observedAt: acquisitionFx.observedAt,
        availableAt: acquisitionFx.availableAt,
      });
    },
  );

  const economicState: CompetitionGenesisEconomicState = Object.freeze({
    schema: "twofold.competition_economic_state/v1",
    genesisId: input.genesisId,
    seasonId: input.seasonId,
    openingStateArtifactId: input.openingStateArtifactId,
    snapshot,
    acquisitionFxBindings: Object.freeze(acquisitionFxBindings),
  });
  const economicCanonicalJson = canonicalFinancialJson(economicState);
  const economicSha256 = sha256(economicCanonicalJson);

  const seenEntrants = new Set<string>();
  const seenRuns = new Set<string>();
  const entrants = [...input.entrants].sort(
    (left, right) => compareCodePoints(left.entrantId, right.entrantId)
      || compareCodePoints(left.runId, right.runId),
  );
  const runs = entrants.map((entrant): CompetitionGenesisRun => {
    requireIdentity(entrant.entrantId, "entrantId");
    requireIdentity(entrant.runId, "runId");
    requireIdentity(entrant.sourceEventId, "sourceEventId");
    if (seenEntrants.has(entrant.entrantId)) {
      throw new TypeError(`Duplicate entrantId: ${entrant.entrantId}`);
    }
    if (seenRuns.has(entrant.runId)) {
      throw new TypeError(`Duplicate runId: ${entrant.runId}`);
    }
    seenEntrants.add(entrant.entrantId);
    seenRuns.add(entrant.runId);

    const openingTransactions = createOpeningLedgerTransactions({
      runId: entrant.runId,
      sourceEventId: entrant.sourceEventId,
      snapshot,
    });
    const ledger = replayLedger(openingTransactions);
    const instanceCanonicalJson = canonicalFinancialJson({
      schema: "twofold.competition_genesis_instance/v1",
      genesisId: input.genesisId,
      seasonId: input.seasonId,
      entrantId: entrant.entrantId,
      runId: entrant.runId,
      sourceEventId: entrant.sourceEventId,
      economicSha256,
      openingTransactionIds: openingTransactions.map(
        (transaction) => transaction.transactionId,
      ),
    });

    return Object.freeze({
      entrantId: entrant.entrantId,
      runId: entrant.runId,
      sourceEventId: entrant.sourceEventId,
      economicSha256,
      openingTransactions,
      ledger,
      instanceCanonicalJson,
      instanceSha256: sha256(instanceCanonicalJson),
    });
  });

  return Object.freeze({
    schema: COMPETITION_GENESIS_RESULT_SCHEMA,
    genesisId: input.genesisId,
    seasonId: input.seasonId,
    economicState,
    economicCanonicalJson,
    economicSha256,
    runs: Object.freeze(runs),
  });
}

function requireIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be non-empty`);
  }
}

function requireIsoTimestamp(value: string, field: string): void {
  const parsed = Date.parse(value);
  const canonicalInput = value.endsWith("Z") && !value.includes(".")
    ? `${value.slice(0, -1)}.000Z`
    : value;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || Number.isNaN(parsed)
    || new Date(parsed).toISOString() !== canonicalInput
  ) {
    throw new TypeError(`${field} must be an ISO UTC timestamp`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
