import type { ArenaPortfolioState } from "./arena-inputs.js";
import type { ArenaExecutionRulebook } from "./private-season-policy.js";
import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type ArenaCycleMaterialStage =
  | "PREPARE_S1_ORDERS"
  | "SETTLE_S1_AND_PREPARE_S2"
  | "FINALIZE_ACCEPTED_TARGET_CYCLE";

export interface ArenaCycleMaterialTarget {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly targetWeightBps: string;
}

export interface ArenaCycleMaterialInstrument {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly sourceCountry: string;
  readonly currency: string;
}

export interface ArenaCycleMaterial {
  readonly schema: "twofold.arena_cycle_material/v1";
  readonly stage: ArenaCycleMaterialStage;
  readonly roundEntry: {
    readonly roundEntryId: string;
    readonly roundId: string;
    readonly seasonId: string;
    readonly entrantId: string;
    readonly runId: string;
    readonly decisionId: string;
  };
  readonly round: {
    readonly roundIndex: string;
    readonly decisionSnapshotId: string;
    readonly decisionSessionDate: string;
    readonly decisionWindowOpensAt: string;
    readonly decisionWindowClosesAt: string;
    readonly s1SessionDate: string;
    readonly s1OpenAt: string;
    readonly s1ReferenceAvailableAt: string;
    readonly s1CloseAt: string;
    readonly s1CloseAvailableAt: string;
    readonly s2SessionDate: string;
    readonly s2OpenAt: string;
    readonly s2ReferenceAvailableAt: string;
    readonly s2CloseAt: string;
    readonly cycleReadyAt: string;
  };
  readonly acceptedSubmission: {
    readonly submissionId: string;
    readonly decisionId: string;
    readonly targets: readonly ArenaCycleMaterialTarget[];
    readonly cashWeightBps: string;
    readonly acceptedAt: string;
  };
  readonly universe: readonly ArenaCycleMaterialInstrument[];
  readonly rulebook: ArenaExecutionRulebook;
  readonly portfolio: ArenaPortfolioState;
  readonly genesis: Readonly<Record<string, unknown>>;
  readonly priorCycles: readonly Readonly<Record<string, unknown>>[];
  readonly priorCorporateActions: readonly Readonly<Record<string, unknown>>[];
  readonly evidence: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface ArenaCycleMaterialRpcClient {
  rpc(
    functionName: "get_arena_cycle_material",
    arguments_: {
      readonly p_round_entry_id: string;
      readonly p_stage: ArenaCycleMaterialStage;
    },
  ): PromiseLike<RpcResult>;
}

export async function loadArenaCycleMaterial(
  client: ArenaCycleMaterialRpcClient,
  input: {
    readonly roundEntryId: string;
    readonly stage: ArenaCycleMaterialStage;
  },
): Promise<ArenaCycleMaterial> {
  uuid(input.roundEntryId, "roundEntryId");
  stage(input.stage);
  const result = await retryExactRpcOnce(() => client.rpc(
    "get_arena_cycle_material",
    {
      p_round_entry_id: input.roundEntryId,
      p_stage: input.stage,
    },
  ));
  if (result.error !== null) {
    throw new Error(`get_arena_cycle_material failed: ${result.error.message}`);
  }
  assertNoJsonNumber(result.data, "Arena cycle material");
  const parsed = parseMaterial(Array.isArray(result.data)
    ? result.data[0]
    : result.data);
  if (
    parsed.stage !== input.stage
    || parsed.roundEntry.roundEntryId !== input.roundEntryId
  ) {
    throw new TypeError("Arena cycle material returned a different stage or entry");
  }
  return deepFreeze(parsed);
}

function parseMaterial(value: unknown): ArenaCycleMaterial {
  const row = exactRecord(value, [
    "schema", "stage", "roundEntry", "round", "acceptedSubmission",
    "universe", "rulebook", "portfolio", "genesis", "priorCycles",
    "priorCorporateActions", "evidence",
  ], "Arena cycle material");
  if (row.schema !== "twofold.arena_cycle_material/v1") {
    throw new TypeError("unsupported Arena cycle material schema");
  }
  const parsedStage = stage(row.stage);
  const entry = exactRecord(row.roundEntry, [
    "roundEntryId", "roundId", "seasonId", "entrantId", "runId",
    "decisionId",
  ], "roundEntry");
  const roundEntry = {
    roundEntryId: uuid(entry.roundEntryId, "roundEntry.roundEntryId"),
    roundId: uuid(entry.roundId, "roundEntry.roundId"),
    seasonId: uuid(entry.seasonId, "roundEntry.seasonId"),
    entrantId: uuid(entry.entrantId, "roundEntry.entrantId"),
    runId: uuid(entry.runId, "roundEntry.runId"),
    decisionId: uuid(entry.decisionId, "roundEntry.decisionId"),
  };

  const roundRow = exactRecord(row.round, [
    "roundIndex", "decisionSnapshotId", "decisionSessionDate",
    "decisionWindowOpensAt", "decisionWindowClosesAt", "s1SessionDate",
    "s1OpenAt", "s1ReferenceAvailableAt", "s1CloseAt",
    "s1CloseAvailableAt", "s2SessionDate", "s2OpenAt",
    "s2ReferenceAvailableAt", "s2CloseAt", "cycleReadyAt",
  ], "round");
  const round = {
    roundIndex: integer(roundRow.roundIndex, "round.roundIndex", false),
    decisionSnapshotId: uuid(
      roundRow.decisionSnapshotId,
      "round.decisionSnapshotId",
    ),
    decisionSessionDate: date(
      roundRow.decisionSessionDate,
      "round.decisionSessionDate",
    ),
    decisionWindowOpensAt: timestamp(
      roundRow.decisionWindowOpensAt,
      "round.decisionWindowOpensAt",
    ),
    decisionWindowClosesAt: timestamp(
      roundRow.decisionWindowClosesAt,
      "round.decisionWindowClosesAt",
    ),
    s1SessionDate: date(roundRow.s1SessionDate, "round.s1SessionDate"),
    s1OpenAt: timestamp(roundRow.s1OpenAt, "round.s1OpenAt"),
    s1ReferenceAvailableAt: timestamp(
      roundRow.s1ReferenceAvailableAt,
      "round.s1ReferenceAvailableAt",
    ),
    s1CloseAt: timestamp(roundRow.s1CloseAt, "round.s1CloseAt"),
    s1CloseAvailableAt: timestamp(
      roundRow.s1CloseAvailableAt,
      "round.s1CloseAvailableAt",
    ),
    s2SessionDate: date(roundRow.s2SessionDate, "round.s2SessionDate"),
    s2OpenAt: timestamp(roundRow.s2OpenAt, "round.s2OpenAt"),
    s2ReferenceAvailableAt: timestamp(
      roundRow.s2ReferenceAvailableAt,
      "round.s2ReferenceAvailableAt",
    ),
    s2CloseAt: timestamp(roundRow.s2CloseAt, "round.s2CloseAt"),
    cycleReadyAt: timestamp(roundRow.cycleReadyAt, "round.cycleReadyAt"),
  };
  assertIncreasing([
    round.decisionWindowOpensAt,
    round.decisionWindowClosesAt,
    round.s1OpenAt,
    round.s1ReferenceAvailableAt,
    round.s1CloseAt,
    round.s1CloseAvailableAt,
    round.s2OpenAt,
    round.s2ReferenceAvailableAt,
    round.s2CloseAt,
    round.cycleReadyAt,
  ], "round timeline");

  const submissionRow = exactRecord(row.acceptedSubmission, [
    "submissionId", "decisionId", "targets", "cashWeightBps", "acceptedAt",
  ], "acceptedSubmission");
  if (!Array.isArray(submissionRow.targets) || submissionRow.targets.length === 0) {
    throw new TypeError("acceptedSubmission.targets must be non-empty");
  }
  const targets = submissionRow.targets.map((candidate, index) => {
    const target = exactRecord(candidate, [
      "instrumentId", "symbol", "targetWeightBps",
    ], `acceptedSubmission.targets[${index}]`);
    return {
      instrumentId: uuid(target.instrumentId, `targets[${index}].instrumentId`),
      symbol: ticker(target.symbol, `targets[${index}].symbol`),
      targetWeightBps: bps(target.targetWeightBps, `targets[${index}].targetWeightBps`),
    };
  });
  const cashWeightBps = bps(
    submissionRow.cashWeightBps,
    "acceptedSubmission.cashWeightBps",
  );
  const invested = targets.reduce(
    (total, target) => total + BigInt(target.targetWeightBps),
    BigInt(cashWeightBps),
  );
  if (invested !== 10_000n) {
    throw new TypeError("accepted target and cash weights must total 10000");
  }
  const acceptedSubmission = {
    submissionId: uuid(
      submissionRow.submissionId,
      "acceptedSubmission.submissionId",
    ),
    decisionId: uuid(
      submissionRow.decisionId,
      "acceptedSubmission.decisionId",
    ),
    targets,
    cashWeightBps,
    acceptedAt: timestamp(
      submissionRow.acceptedAt,
      "acceptedSubmission.acceptedAt",
    ),
  };
  if (
    acceptedSubmission.decisionId !== roundEntry.decisionId
    || acceptedSubmission.acceptedAt > round.decisionWindowClosesAt
  ) {
    throw new TypeError("accepted submission crossed its Round identity or deadline");
  }

  if (!Array.isArray(row.universe) || row.universe.length === 0) {
    throw new TypeError("universe must be a non-empty array");
  }
  const universe = row.universe.map((candidate, index) => {
    const instrument = exactRecord(candidate, [
      "instrumentId", "symbol", "sourceCountry", "currency",
    ], `universe[${index}]`);
    return {
      instrumentId: uuid(
        instrument.instrumentId,
        `universe[${index}].instrumentId`,
      ),
      symbol: ticker(instrument.symbol, `universe[${index}].symbol`),
      sourceCountry: country(
        instrument.sourceCountry,
        `universe[${index}].sourceCountry`,
      ),
      currency: currency(instrument.currency, `universe[${index}].currency`),
    };
  });
  if (
    new Set(universe.map((instrument) => instrument.instrumentId)).size
      !== universe.length
    || new Set(universe.map((instrument) => instrument.symbol)).size
      !== universe.length
    || acceptedSubmission.targets.some((target) => !universe.some(
      (instrument) => instrument.instrumentId === target.instrumentId
        && instrument.symbol === target.symbol,
    ))
  ) {
    throw new TypeError("universe identities must be unique and contain every target");
  }

  const rulebook = parseRulebook(row.rulebook);
  const portfolio = parsePortfolio(row.portfolio, roundEntry.runId);
  const genesis = exactRecord(row.genesis, [
    "schema", "genesisId", "seasonId", "openingStateArtifactId", "snapshot",
    "acquisitionFxBindings",
  ], "genesis");
  if (
    genesis.schema !== "twofold.competition_economic_state/v1"
    || genesis.seasonId !== roundEntry.seasonId
  ) {
    throw new TypeError("competition genesis does not belong to the Round Season");
  }
  if (!Array.isArray(row.priorCycles)) {
    throw new TypeError("priorCycles must be an array");
  }
  const priorCycles = row.priorCycles.map((cycle, index) =>
    exactRecord(cycle, undefined, `priorCycles[${index}]`));
  if (!Array.isArray(row.priorCorporateActions)) {
    throw new TypeError("priorCorporateActions must be an array");
  }
  const priorCorporateActions = row.priorCorporateActions.map((action, index) =>
    exactRecord(action, undefined, `priorCorporateActions[${index}]`));
  const evidence = parseEvidence(row.evidence, parsedStage);

  return {
    schema: "twofold.arena_cycle_material/v1",
    stage: parsedStage,
    roundEntry,
    round,
    acceptedSubmission,
    universe,
    rulebook,
    portfolio,
    genesis,
    priorCycles,
    priorCorporateActions,
    evidence,
  };
}

function parseEvidence(
  value: unknown,
  requestedStage: ArenaCycleMaterialStage,
): Record<string, Readonly<Record<string, unknown>>> {
  const keys = requestedStage === "PREPARE_S1_ORDERS"
    ? ["decisionClose"]
    : requestedStage === "SETTLE_S1_AND_PREPARE_S2"
      ? ["decisionClose", "s1Open", "s1Close", "s1DispositionFx"]
      : [
          "decisionClose", "s1Open", "s1Close", "s1DispositionFx",
          "s2Open", "s2Close", "s2AcquisitionFx",
        ];
  const evidence = exactRecord(value, keys, "evidence shape");
  return Object.fromEntries(keys.map((key) => [
    key,
    exactRecord(evidence[key], undefined, `evidence.${key}`),
  ]));
}

function parseRulebook(value: unknown): ArenaExecutionRulebook {
  const candidate = exactRecord(value, undefined, "rulebook");
  const v2 = candidate.schema === "twofold.arena_execution_rulebook/v2";
  const row = exactRecord(value, [
    "schema", "executionModel", "openReferenceMethod", "slippageBps",
    "fillPriceScale", "feeScheduleId", "taxRulesetId", "taxAllocationScale",
    "rankingNav",
    ...(v2 ? ["maxParticipationBps"] : []),
  ], "rulebook");
  if (
    (
      !v2
      && (
        row.schema !== "twofold.arena_execution_rulebook/v1"
        || row.executionModel !== "SIMULATED_SLIPPAGE"
        || row.openReferenceMethod
          !== "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE"
      )
    )
    || (
      v2
      && (
        row.executionModel !== "SIMULATED_MINUTE_PARTICIPATION"
        || row.openReferenceMethod
          !== "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE"
      )
    )
    || row.feeScheduleId !== "futu_hk_us_equity_fixed_2026-08-23"
    || row.taxRulesetId !== "cn_resident_direct_foreign_securities_strict_v1"
    || row.rankingNav !== "LIQUIDATION_NAV"
  ) throw new TypeError("unsupported Arena execution rulebook");
  const slippageBps = integer(row.slippageBps, "rulebook.slippageBps", true);
  const fillPriceScale = integer(row.fillPriceScale, "rulebook.fillPriceScale", true);
  const taxAllocationScale = integer(
    row.taxAllocationScale,
    "rulebook.taxAllocationScale",
    true,
  );
  const maxParticipationBps = v2
    ? integer(
        row.maxParticipationBps,
        "rulebook.maxParticipationBps",
        false,
      )
    : undefined;
  if (
    BigInt(slippageBps) > 10_000n
    || BigInt(fillPriceScale) > 12n
    || BigInt(taxAllocationScale) > 12n
    || (maxParticipationBps !== undefined
      && (
        BigInt(maxParticipationBps) === 0n
        || BigInt(maxParticipationBps) > 10_000n
      ))
  ) throw new TypeError("Arena execution rulebook scale is out of range");
  return row as unknown as ArenaExecutionRulebook;
}

function parsePortfolio(value: unknown, runId: string): ArenaPortfolioState {
  const row = exactRecord(value, [
    "schema", "strategyAccountId", "runId", "asOf", "account", "ledgerHead",
    "cash", "positions",
  ], "portfolio");
  if (
    row.schema !== "twofold.strategy_portfolio_state/v1"
    || row.runId !== runId
  ) throw new TypeError("portfolio does not belong to the Round Run");
  uuid(row.strategyAccountId, "portfolio.strategyAccountId");
  timestamp(row.asOf, "portfolio.asOf");
  exactRecord(row.account, undefined, "portfolio.account");
  const head = exactRecord(row.ledgerHead, undefined, "portfolio.ledgerHead");
  sha256(head.sha256, "portfolio.ledgerHead.sha256");
  exactRecord(row.cash, undefined, "portfolio.cash");
  if (!Array.isArray(row.positions)) {
    throw new TypeError("portfolio.positions must be an array");
  }
  return row as unknown as ArenaPortfolioState;
}

function exactRecord(
  value: unknown,
  keys: readonly string[] | undefined,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const row = value as Record<string, unknown>;
  if (keys !== undefined) {
    const expected = [...keys].sort();
    const actual = Object.keys(row).sort();
    if (
      actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])
    ) throw new TypeError(`${field} has an unexpected evidence shape or fields`);
  }
  return row;
}

function stage(value: unknown): ArenaCycleMaterialStage {
  if (
    value !== "PREPARE_S1_ORDERS"
    && value !== "SETTLE_S1_AND_PREPARE_S2"
    && value !== "FINALIZE_ACCEPTED_TARGET_CYCLE"
  ) throw new TypeError("unsupported Arena cycle material stage");
  return value;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!SHA256_PATTERN.test(parsed)) throw new TypeError(`${field} must be SHA-256`);
  return parsed;
}

function integer(value: unknown, field: string, allowZero: boolean): string {
  const parsed = identity(value, field);
  const pattern = allowZero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!pattern.test(parsed)) throw new TypeError(`${field} must be a canonical integer`);
  return parsed;
}

function bps(value: unknown, field: string): string {
  const parsed = integer(value, field, true);
  if (BigInt(parsed) > 10_000n) throw new TypeError(`${field} exceeds 10000`);
  return parsed;
}

function ticker(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(parsed)) {
    throw new TypeError(`${field} must be an uppercase ticker`);
  }
  return parsed;
}

function country(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^[A-Z]{2}$/.test(parsed)) {
    throw new TypeError(`${field} must be an ISO country code`);
  }
  return parsed;
}

function currency(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^[A-Z]{3}$/.test(parsed)) {
    throw new TypeError(`${field} must be an ISO currency code`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || new Date(parsed).toISOString() !== parsed
  ) throw new TypeError(`${field} must be a canonical UTC timestamp`);
  return parsed;
}

function date(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed)
    || new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed
  ) throw new TypeError(`${field} must be a calendar date`);
  return parsed;
}

function assertIncreasing(values: readonly string[], field: string): void {
  if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) {
    throw new TypeError(`${field} must be strictly increasing`);
  }
}

function assertNoJsonNumber(value: unknown, path: string): void {
  if (typeof value === "number") throw new TypeError(`${path} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((nested, index) => assertNoJsonNumber(nested, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertNoJsonNumber(nested, `${path}.${key}`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
