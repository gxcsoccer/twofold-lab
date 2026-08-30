import {
  DEFAULT_FUTU_FEE_SCHEDULES,
  addDecimals,
  createOpeningLedgerTransactions,
  multiplyDecimals,
  nonNegativeDecimal,
  replayLedger,
  sequence,
  subtractDecimals,
  sumDecimals,
  validateInitialPortfolioSnapshot,
  type AcceptedTargetCycleS1PlanInput,
  type AcceptedTargetCycleThroughS1Input,
  type AcceptedTargetCycleInput,
  type CnyFxEvidence,
  type CycleOfficialOpenEvidence,
  type InitialPortfolioSnapshotInput,
  type LedgerTransaction,
  type LotAcquisitionFxBinding,
  type MarketPriceEvidence,
  type ShadowTaxLot,
} from "@twofold/core";

import type { ArenaCycleMaterial } from "./arena-cycle-material.js";

export interface CurrentPosition {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly grossCost: string;
  readonly lots: readonly ShadowTaxLot[];
  readonly acquisitionFxBindings: readonly LotAcquisitionFxBinding[];
}

export interface ArenaAccountReplayMaterial {
  readonly portfolio: ArenaCycleMaterial["portfolio"];
  readonly genesis: Readonly<Record<string, unknown>>;
  readonly priorCycles: readonly Readonly<Record<string, unknown>>[];
  readonly priorCorporateActions: readonly Readonly<Record<string, unknown>>[];
}

export interface ReconstructedArenaAccountState {
  readonly positions: readonly CurrentPosition[];
  readonly priorLedgerTransactions: readonly LedgerTransaction[];
}

/** Rebuild the exact FIFO/ledger state shared by cycles and corporate actions. */
export function reconstructArenaAccountState(
  material: ArenaAccountReplayMaterial,
): ReconstructedArenaAccountState {
  const genesis = exactRecord(material.genesis, [
    "schema", "genesisId", "seasonId", "openingStateArtifactId", "snapshot",
    "acquisitionFxBindings",
  ], "genesis");
  if (genesis.schema !== "twofold.competition_economic_state/v1") {
    throw new TypeError("account replay has unsupported competition genesis");
  }
  const snapshot = validateInitialPortfolioSnapshot(
    genesis.snapshot as InitialPortfolioSnapshotInput,
  );
  if (snapshot.baseCurrency !== material.portfolio.account.baseCurrency) {
    throw new TypeError("genesis and Strategy Account currencies differ");
  }
  const openingTransactions = createOpeningLedgerTransactions({
    runId: material.portfolio.runId,
    sourceEventId: `competition-genesis:${identity(genesis.genesisId, "genesisId")}`,
    snapshot,
  });
  const priorLedgerTransactions = Object.freeze([
    ...openingTransactions,
    ...extractPriorCycleTransactions(material.priorCycles),
    ...extractPriorCorporateActionTransactions(material.priorCorporateActions),
  ]);
  const positions = positionsFromLatestCorporateAction(
    material.priorCorporateActions,
    material.portfolio.ledgerHead.sequence,
    material.portfolio.ledgerHead.sha256,
  ) ?? (material.priorCycles.length === 0
    ? positionsFromGenesis(
        snapshot,
        array(genesis.acquisitionFxBindings, "genesis.acquisitionFxBindings"),
        identity(genesis.genesisId, "genesisId"),
      )
    : positionsFromLatestCycle(material.priorCycles.at(-1)!));
  assertPortfolioMatchesReplay(
    { portfolio: material.portfolio },
    positions,
    priorLedgerTransactions,
  );
  return Object.freeze({ positions, priorLedgerTransactions });
}

/**
 * Converts the database-authoritative, future-evidence-gated material into the
 * pure Core S1 input. It supports any frozen universe: current holdings and
 * zero-position target instruments are represented explicitly.
 */
export function buildArenaS1PlanInput(
  material: ArenaCycleMaterial,
): AcceptedTargetCycleS1PlanInput {
  if (material.stage !== "PREPARE_S1_ORDERS") {
    throw new TypeError("S1 planning requires PREPARE_S1_ORDERS material");
  }
  return buildArenaS1Base(material);
}

function buildArenaS1Base(
  material: ArenaCycleMaterial,
): AcceptedTargetCycleS1PlanInput {
  const genesis = exactRecord(material.genesis, [
    "schema", "genesisId", "seasonId", "openingStateArtifactId", "snapshot",
    "acquisitionFxBindings",
  ], "genesis");
  if (
    genesis.schema !== "twofold.competition_economic_state/v1"
    || genesis.seasonId !== material.roundEntry.seasonId
  ) throw new TypeError("competition genesis is outside the Arena Season");
  const replay = reconstructArenaAccountState(material);
  const { positions: currentPositions, priorLedgerTransactions } = replay;

  const decisionClose = exactRecord(
    material.evidence.decisionClose,
    [
      "schema", "snapshotId", "sourceVersionId", "manifestSha256",
      "sessionDate", "cutoffAt", "sealedAt", "marks",
    ],
    "evidence.decisionClose",
  );
  if (
    decisionClose.schema !== "twofold.arena_market_close_material/v1"
    || decisionClose.snapshotId !== material.round.decisionSnapshotId
    || decisionClose.sessionDate !== material.round.decisionSessionDate
  ) throw new TypeError("decision close is outside the Round fence");
  const marks = decisionMarks(
    array(decisionClose.marks, "evidence.decisionClose.marks"),
    material,
  );
  const positionById = new Map(
    currentPositions.map((position) => [position.instrumentId, position]),
  );
  const instruments = material.universe.map((instrument) => {
    if (instrument.currency !== material.portfolio.account.baseCurrency) {
      throw new TypeError(`unsupported cross-currency instrument ${instrument.symbol}`);
    }
    const position = positionById.get(instrument.instrumentId) ?? Object.freeze({
      instrumentId: instrument.instrumentId,
      symbol: instrument.symbol,
      quantity: "0",
      grossCost: "0",
      lots: Object.freeze([]),
      acquisitionFxBindings: Object.freeze([]),
    });
    if (position.symbol !== instrument.symbol) {
      throw new TypeError("current position symbol differs from stable universe");
    }
    const decisionCloseMark = marks.get(instrument.instrumentId);
    if (decisionCloseMark === undefined) {
      throw new TypeError(`decision close has no mark for ${instrument.symbol}`);
    }
    return Object.freeze({
      ...position,
      sourceCountry: instrument.sourceCountry,
      decisionCloseMark,
    });
  });
  if (positionById.size !== currentPositions.length || currentPositions.some(
    (position) => !material.universe.some(
      (instrument) => instrument.instrumentId === position.instrumentId,
    ),
  )) throw new TypeError("current position is outside the frozen universe");

  return Object.freeze({
    acceptedSubmission: Object.freeze({
      submissionId: material.acceptedSubmission.submissionId,
      decisionId: material.acceptedSubmission.decisionId,
      targets: Object.freeze(material.acceptedSubmission.targets.map((target) =>
        Object.freeze({ ...target }))),
      cashWeightBps: material.acceptedSubmission.cashWeightBps,
    }),
    account: Object.freeze({
      strategyAccountId: material.portfolio.strategyAccountId,
      runId: material.roundEntry.runId,
      currency: material.portfolio.account.baseCurrency,
      cashAssetBalance: material.portfolio.cash.settled,
      taxReserveBalance: material.portfolio.cash.taxReserve,
      headSequence: material.portfolio.ledgerHead.sequence,
      headHash: material.portfolio.ledgerHead.sha256,
      priorLedgerTransactions,
    }),
    timeline: Object.freeze({
      decisionSessionDate: material.round.decisionSessionDate,
      decisionCutoffAt: timestamp(decisionClose.cutoffAt, "decisionClose.cutoffAt"),
      s1PlannedAt: material.acceptedSubmission.acceptedAt,
      s1TradeDate: material.round.s1SessionDate,
    }),
    instruments: Object.freeze(instruments),
    feeSchedules: DEFAULT_FUTU_FEE_SCHEDULES,
    slippageBps: material.rulebook.slippageBps,
    executionModel: material.rulebook.executionModel,
    ...(material.rulebook.schema === "twofold.arena_execution_rulebook/v2"
      ? { maxParticipationBps: material.rulebook.maxParticipationBps }
      : {}),
    fillPriceScale: safeScale(
      material.rulebook.fillPriceScale,
      "rulebook.fillPriceScale",
    ),
    taxAllocationScale: safeScale(
      material.rulebook.taxAllocationScale,
      "rulebook.taxAllocationScale",
    ),
  });
}

/** Build the pre-S2 checkpoint input without accepting any S2 evidence. */
export function buildArenaThroughS1Input(
  material: ArenaCycleMaterial,
): AcceptedTargetCycleThroughS1Input {
  if (material.stage !== "SETTLE_S1_AND_PREPARE_S2") {
    throw new TypeError(
      "S1 settlement requires SETTLE_S1_AND_PREPARE_S2 material",
    );
  }
  return buildArenaThroughS1Base(material);
}

function buildArenaThroughS1Base(
  material: ArenaCycleMaterial,
): AcceptedTargetCycleThroughS1Input {
  const base = buildArenaS1Base(material);
  const open = exactRecord(material.evidence.s1Open, [
    "schema", "roundId", "seasonId", "stage", "referenceSnapshotId",
    "sourceVersionId", "sourceArtifactId", "sourceContentSha256",
    "requestFingerprint", "method", "sessionDate", "expectedOpenAt",
    "observedAt", "contentSha256", "references", "boundBy", "boundAt",
  ], "evidence.s1Open");
  const openContract = expectedOpenContract(material);
  if (
    open.schema !== openContract.schema
    || open.roundId !== material.roundEntry.roundId
    || open.seasonId !== material.roundEntry.seasonId
    || open.stage !== "S1_OPEN_REFERENCE"
    || open.method !== openContract.method
    || open.sessionDate !== material.round.s1SessionDate
    || open.expectedOpenAt !== material.round.s1OpenAt
  ) throw new TypeError("S1 open reference is outside the Round fence");
  const openObservedAt = timestamp(open.observedAt, "s1Open.observedAt");
  if (openObservedAt < material.round.s1OpenAt) {
    throw new TypeError("S1 open reference predates exchange open");
  }
  const openByInstrument = cycleOpenEvidence(material, open, {
    stage: "S1_OPEN_REFERENCE",
    sessionDate: material.round.s1SessionDate,
    label: "S1 open",
  });

  const close = exactRecord(material.evidence.s1Close, [
    "schema", "roundId", "seasonId", "stage", "snapshotId",
    "sourceVersionId", "manifestSha256", "sessionDate", "cutoffAt",
    "sealedAt", "marks", "boundBy", "boundAt",
  ], "evidence.s1Close");
  if (
    close.schema !== "twofold.arena_round_close_snapshot/v1"
    || close.roundId !== material.roundEntry.roundId
    || close.seasonId !== material.roundEntry.seasonId
    || close.stage !== "S1_CLOSE"
    || close.sessionDate !== material.round.s1SessionDate
  ) throw new TypeError("S1 close snapshot is outside the Round fence");
  const s1CloseMarks = roundCloseMarks(material, close, {
    stage: "S1_CLOSE",
    sessionDate: material.round.s1SessionDate,
    label: "S1 close",
  });

  const fx = exactRecord(material.evidence.s1DispositionFx, [
    "schema", "roundId", "seasonId", "stage", "fxRateId", "factId",
    "sourceVersionId", "sourceArtifactId", "sourceContentSha256",
    "rawBodySha256", "baseCurrency", "quoteCurrency", "cnyPerBaseUnit",
    "requestedSessionDate", "effectiveAt", "visibleAt", "status", "authority", "crossSha256",
    "boundBy", "boundAt",
  ], "evidence.s1DispositionFx");
  if (
    fx.schema !== "twofold.arena_round_tax_fx_reference/v1"
    || fx.roundId !== material.roundEntry.roundId
    || fx.seasonId !== material.roundEntry.seasonId
    || fx.stage !== "S1_DISPOSITION"
    || fx.requestedSessionDate !== material.round.s1SessionDate
    || String(fx.effectiveAt).slice(0, 10) > material.round.s1SessionDate
    || fx.baseCurrency !== material.portfolio.account.baseCurrency
    || fx.quoteCurrency !== "CNY"
    || (fx.status !== "ESTIMATED" && fx.status !== "FINAL")
  ) throw new TypeError("S1 disposition FX is outside the Round fence");
  const dispositionFx: CnyFxEvidence = Object.freeze({
    fxRateId: identity(fx.fxRateId, "s1DispositionFx.fxRateId"),
    factId: identity(fx.factId, "s1DispositionFx.factId"),
    sourceVersionId: identity(
      fx.sourceVersionId,
      "s1DispositionFx.sourceVersionId",
    ),
    sourceArtifactId: identity(
      fx.sourceArtifactId,
      "s1DispositionFx.sourceArtifactId",
    ),
    sourceContentSha256: sha256(
      fx.sourceContentSha256,
      "s1DispositionFx.sourceContentSha256",
    ),
    baseCurrency: material.portfolio.account.baseCurrency,
    quoteCurrency: "CNY",
    cnyPerBaseUnit: decimalString(
      fx.cnyPerBaseUnit,
      "s1DispositionFx.cnyPerBaseUnit",
    ),
    effectiveAt: timestamp(fx.effectiveAt, "s1DispositionFx.effectiveAt"),
    visibleAt: timestamp(fx.visibleAt, "s1DispositionFx.visibleAt"),
    status: fx.status as "ESTIMATED" | "FINAL",
  });
  const s1SettledAt = maximumTimestamp(
    timestamp(close.sealedAt, "s1Close.sealedAt"),
    dispositionFx.visibleAt,
  );
  if (s1SettledAt >= material.round.s2OpenAt) {
    throw new TypeError("S1 evidence was not complete before S2 open");
  }

  return Object.freeze({
    acceptedSubmission: base.acceptedSubmission,
    account: base.account,
    timeline: Object.freeze({
      ...base.timeline,
      s1ExecutedAt: openObservedAt,
      s1SettledAt,
      s1CloseAt: s1SettledAt,
      s2PlannedAt: s1SettledAt,
      s2TradeDate: material.round.s2SessionDate,
    }),
    instruments: Object.freeze(base.instruments.map((instrument) =>
      Object.freeze({
        ...instrument,
        s1CloseMark: s1CloseMarks.get(instrument.instrumentId)!,
      }))),
    s1OfficialOpenByInstrument: openByInstrument,
    dispositionFxByInstrument: Object.freeze(Object.fromEntries(
      material.universe.map((instrument) => [
        instrument.instrumentId,
        dispositionFx,
      ]),
    )),
    ...(base.feeSchedules === undefined
      ? {}
      : { feeSchedules: base.feeSchedules }),
    slippageBps: base.slippageBps,
    executionModel: material.rulebook.executionModel,
    ...(material.rulebook.schema !== "twofold.arena_execution_rulebook/v2"
      ? {}
      : { maxParticipationBps: material.rulebook.maxParticipationBps }),
    fillPriceScale: base.fillPriceScale,
    taxAllocationScale: base.taxAllocationScale,
  });
}

/** Build the complete deterministic Core cycle after all shared S2 evidence. */
export function buildArenaFullCycleInput(
  material: ArenaCycleMaterial,
): AcceptedTargetCycleInput {
  if (material.stage !== "FINALIZE_ACCEPTED_TARGET_CYCLE") {
    throw new TypeError(
      "final settlement requires FINALIZE_ACCEPTED_TARGET_CYCLE material",
    );
  }
  const throughS1 = buildArenaThroughS1Base(material);
  const open = exactRecord(material.evidence.s2Open, [
    "schema", "roundId", "seasonId", "stage", "referenceSnapshotId",
    "sourceVersionId", "sourceArtifactId", "sourceContentSha256",
    "requestFingerprint", "method", "sessionDate", "expectedOpenAt",
    "observedAt", "contentSha256", "references", "boundBy", "boundAt",
  ], "evidence.s2Open");
  const openContract = expectedOpenContract(material);
  if (
    open.schema !== openContract.schema
    || open.roundId !== material.roundEntry.roundId
    || open.seasonId !== material.roundEntry.seasonId
    || open.stage !== "S2_OPEN_REFERENCE"
    || open.method !== openContract.method
    || open.sessionDate !== material.round.s2SessionDate
    || open.expectedOpenAt !== material.round.s2OpenAt
  ) throw new TypeError("S2 open reference is outside the Round fence");
  const openObservedAt = timestamp(open.observedAt, "s2Open.observedAt");
  if (openObservedAt < material.round.s2OpenAt) {
    throw new TypeError("S2 open reference predates exchange open");
  }
  const s2OfficialOpenByInstrument = cycleOpenEvidence(material, open, {
    stage: "S2_OPEN_REFERENCE",
    sessionDate: material.round.s2SessionDate,
    label: "S2 open",
  });

  const close = exactRecord(material.evidence.s2Close, [
    "schema", "roundId", "seasonId", "stage", "snapshotId",
    "sourceVersionId", "manifestSha256", "sessionDate", "cutoffAt",
    "sealedAt", "marks", "boundBy", "boundAt",
  ], "evidence.s2Close");
  if (
    close.schema !== "twofold.arena_round_close_snapshot/v1"
    || close.roundId !== material.roundEntry.roundId
    || close.seasonId !== material.roundEntry.seasonId
    || close.stage !== "S2_CLOSE"
    || close.sessionDate !== material.round.s2SessionDate
  ) throw new TypeError("S2 close snapshot is outside the Round fence");
  const s2CloseMarks = roundCloseMarks(material, close, {
    stage: "S2_CLOSE",
    sessionDate: material.round.s2SessionDate,
    label: "S2 close",
  });

  const fx = exactRecord(material.evidence.s2AcquisitionFx, [
    "schema", "roundId", "seasonId", "stage", "fxRateId", "factId",
    "sourceVersionId", "sourceArtifactId", "sourceContentSha256",
    "rawBodySha256", "baseCurrency", "quoteCurrency", "cnyPerBaseUnit",
    "requestedSessionDate", "effectiveAt", "visibleAt", "status", "authority", "crossSha256",
    "boundBy", "boundAt",
  ], "evidence.s2AcquisitionFx");
  if (
    fx.schema !== "twofold.arena_round_tax_fx_reference/v1"
    || fx.roundId !== material.roundEntry.roundId
    || fx.seasonId !== material.roundEntry.seasonId
    || fx.stage !== "S2_ACQUISITION"
    || fx.requestedSessionDate !== material.round.s2SessionDate
    || String(fx.effectiveAt).slice(0, 10) > material.round.s2SessionDate
    || fx.baseCurrency !== material.portfolio.account.baseCurrency
    || fx.quoteCurrency !== "CNY"
    || (fx.status !== "ESTIMATED" && fx.status !== "FINAL")
  ) throw new TypeError("S2 acquisition FX is outside the Round fence");
  const acquisitionFx: CnyFxEvidence = Object.freeze({
    fxRateId: identity(fx.fxRateId, "s2AcquisitionFx.fxRateId"),
    factId: identity(fx.factId, "s2AcquisitionFx.factId"),
    sourceVersionId: identity(
      fx.sourceVersionId,
      "s2AcquisitionFx.sourceVersionId",
    ),
    sourceArtifactId: identity(
      fx.sourceArtifactId,
      "s2AcquisitionFx.sourceArtifactId",
    ),
    sourceContentSha256: sha256(
      fx.sourceContentSha256,
      "s2AcquisitionFx.sourceContentSha256",
    ),
    baseCurrency: material.portfolio.account.baseCurrency,
    quoteCurrency: "CNY",
    cnyPerBaseUnit: decimalString(
      fx.cnyPerBaseUnit,
      "s2AcquisitionFx.cnyPerBaseUnit",
    ),
    effectiveAt: timestamp(fx.effectiveAt, "s2AcquisitionFx.effectiveAt"),
    visibleAt: timestamp(fx.visibleAt, "s2AcquisitionFx.visibleAt"),
    status: fx.status as "ESTIMATED" | "FINAL",
  });
  const s2SettledAt = maximumTimestamp(
    timestamp(close.sealedAt, "s2Close.sealedAt"),
    acquisitionFx.visibleAt,
  );
  if (s2SettledAt < material.round.s2CloseAt) {
    throw new TypeError("final evidence predates the S2 exchange close");
  }

  return Object.freeze({
    acceptedSubmission: throughS1.acceptedSubmission,
    account: throughS1.account,
    timeline: Object.freeze({
      ...throughS1.timeline,
      s2ExecutedAt: openObservedAt,
      s2SettledAt,
      navAsOf: s2SettledAt,
    }),
    instruments: Object.freeze(throughS1.instruments.map((instrument) =>
      Object.freeze({
        ...instrument,
        finalMark: s2CloseMarks.get(instrument.instrumentId)!,
      }))),
    s1OfficialOpenByInstrument: throughS1.s1OfficialOpenByInstrument,
    s2OfficialOpenByInstrument,
    dispositionFxByInstrument: throughS1.dispositionFxByInstrument,
    acquisitionFxByInstrument: Object.freeze(Object.fromEntries(
      material.universe.map((instrument) => [
        instrument.instrumentId,
        acquisitionFx,
      ]),
    )),
    ...(throughS1.feeSchedules === undefined
      ? {}
      : { feeSchedules: throughS1.feeSchedules }),
    slippageBps: throughS1.slippageBps,
    executionModel: material.rulebook.executionModel,
    ...(material.rulebook.schema !== "twofold.arena_execution_rulebook/v2"
      ? {}
      : { maxParticipationBps: material.rulebook.maxParticipationBps }),
    fillPriceScale: throughS1.fillPriceScale,
    taxAllocationScale: throughS1.taxAllocationScale,
  });
}

function cycleOpenEvidence(
  material: ArenaCycleMaterial,
  open: Record<string, unknown>,
  expected: {
    readonly stage: "S1_OPEN_REFERENCE" | "S2_OPEN_REFERENCE";
    readonly sessionDate: string;
    readonly label: string;
  },
): Readonly<Record<string, CycleOfficialOpenEvidence | undefined>> {
  const volumeParticipation =
    material.rulebook.schema === "twofold.arena_execution_rulebook/v2";
  const bySymbol = new Map(material.universe.map((item) => [item.symbol, item]));
  const result: Record<string, CycleOfficialOpenEvidence> = {};
  for (const [index, candidate] of array(open.references, "s1Open.references").entries()) {
    const reference = exactRecord(candidate, [
      "factId", "symbol", "barStart", "sessionDate", "currency", "value",
      ...(volumeParticipation ? ["observedVolume"] : []),
      "factSha256",
    ], `s1Open.references[${index}]`);
    const instrument = bySymbol.get(identity(reference.symbol, "s1Open.symbol"));
    if (
      instrument === undefined
      || reference.sessionDate !== expected.sessionDate
      || reference.currency !== instrument.currency
      || result[instrument.instrumentId] !== undefined
    ) throw new TypeError(`${expected.label} reference does not cover the stable universe`);
    result[instrument.instrumentId] = Object.freeze({
      sourceId: material.rulebook.openReferenceMethod,
      sourceVersionId: identity(open.sourceVersionId, "s1Open.sourceVersionId"),
      factId: identity(reference.factId, "s1Open.factId"),
      sourceArtifactId: identity(open.sourceArtifactId, "s1Open.sourceArtifactId"),
      sourceContentSha256: sha256(
        open.sourceContentSha256,
        "s1Open.sourceContentSha256",
      ),
      observedAt: timestamp(open.observedAt, `${expected.label}.observedAt`),
      snapshotId: identity(
        open.referenceSnapshotId,
        `${expected.label}.referenceSnapshotId`,
      ),
      sessionDate: expected.sessionDate,
      value: decimalString(reference.value, `${expected.label}.value`),
      ...(volumeParticipation
        ? {
            observedVolume: canonicalIntegerString(
              reference.observedVolume,
              `${expected.label}.observedVolume`,
            ),
          }
        : {}),
    });
  }
  if (Object.keys(result).length !== material.universe.length) {
    throw new TypeError(`${expected.label} reference does not cover the frozen universe`);
  }
  return Object.freeze(result);
}

function expectedOpenContract(material: ArenaCycleMaterial): Readonly<{
  schema:
    | "twofold.arena_round_open_reference/v1"
    | "twofold.arena_round_open_reference/v2";
  method:
    | "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE"
    | "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE";
}> {
  return material.rulebook.schema === "twofold.arena_execution_rulebook/v2"
    ? Object.freeze({
        schema: "twofold.arena_round_open_reference/v2",
        method: "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
      })
    : Object.freeze({
        schema: "twofold.arena_round_open_reference/v1",
        method: "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE",
      });
}

function roundCloseMarks(
  material: ArenaCycleMaterial,
  close: Record<string, unknown>,
  expected: {
    readonly stage: "S1_CLOSE" | "S2_CLOSE";
    readonly sessionDate: string;
    readonly label: string;
  },
): ReadonlyMap<string, MarketPriceEvidence> {
  const bySymbol = new Map(material.universe.map((item) => [item.symbol, item]));
  const result = new Map<string, MarketPriceEvidence>();
  for (const [index, candidate] of array(close.marks, "s1Close.marks").entries()) {
    const mark = exactRecord(candidate, [
      "factId", "symbol", "barStart", "sessionDate", "currency", "value",
      "factSha256", "deliveryId", "observedAt", "sourceArtifactId",
      "sourceContentSha256",
    ], `s1Close.marks[${index}]`);
    const instrument = bySymbol.get(identity(mark.symbol, "s1Close.symbol"));
    if (
      instrument === undefined
      || mark.sessionDate !== expected.sessionDate
      || mark.currency !== instrument.currency
      || result.has(instrument.instrumentId)
    ) throw new TypeError(`${expected.label} mark does not bind the stable universe`);
    result.set(instrument.instrumentId, Object.freeze({
      value: decimalString(mark.value, `${expected.label}.value`),
      kind: "OFFICIAL_CLOSE",
      sessionDate: expected.sessionDate,
      visibleAt: timestamp(mark.observedAt, `${expected.label}.observedAt`),
      snapshotId: identity(close.snapshotId, `${expected.label}.snapshotId`),
      factId: identity(mark.factId, `${expected.label}.factId`),
    }));
  }
  if (result.size !== material.universe.length) {
    throw new TypeError(`${expected.label} does not cover the frozen universe`);
  }
  return result;
}

function maximumTimestamp(left: string, right: string): string {
  return left >= right ? left : right;
}

function positionsFromGenesis(
  snapshot: ReturnType<typeof validateInitialPortfolioSnapshot>,
  rawFxBindings: readonly unknown[],
  genesisId: string,
): readonly CurrentPosition[] {
  const fxByLot = new Map<string, LotAcquisitionFxBinding>();
  for (const [index, candidate] of rawFxBindings.entries()) {
    const fx = exactRecord(candidate, [
      "lotId", "instrumentId", "effectiveDate", "cnyPerUsd",
      "acquisitionTaxBasisCny", "authority", "sourceArtifactId",
      "sourceSha256", "observedAt", "availableAt",
    ], `genesis.acquisitionFxBindings[${index}]`);
    const lotId = identity(fx.lotId, `genesis.fx[${index}].lotId`);
    const lot = snapshot.lots.find((candidateLot) => candidateLot.lotId === lotId);
    if (
      lot === undefined
      || fx.instrumentId !== lot.instrumentId
      || fx.effectiveDate !== lot.acquiredOn
      || fxByLot.has(lotId)
    ) throw new TypeError("genesis acquisition FX does not bind one unique lot");
    const cnyPerUsd = decimalString(fx.cnyPerUsd, `genesis.fx[${index}].cnyPerUsd`);
    const computedBasis = addDecimals(
      multiplyDecimals(lot.grossPurchasePrice, cnyPerUsd),
      multiplyDecimals(lot.buyFees, cnyPerUsd),
    );
    if (computedBasis !== fx.acquisitionTaxBasisCny) {
      throw new TypeError("genesis acquisition FX does not reconcile tax basis");
    }
    const evidenceId = `competition-genesis:${genesisId}:${lotId}:fx`;
    fxByLot.set(lotId, Object.freeze({
      lotId,
      acquisitionTradeDate: lot.acquiredOn,
      acquisitionSettlementId: `competition-genesis:${genesisId}:${lotId}`,
      remainingGrossPurchasePriceCny: multiplyDecimals(
        lot.grossPurchasePrice,
        cnyPerUsd,
      ),
      remainingBuyFeesCny: multiplyDecimals(lot.buyFees, cnyPerUsd),
      evidence: Object.freeze({
        fxRateId: evidenceId,
        factId: evidenceId,
        sourceVersionId: identity(fx.authority, `genesis.fx[${index}].authority`),
        sourceArtifactId: identity(
          fx.sourceArtifactId,
          `genesis.fx[${index}].sourceArtifactId`,
        ),
        sourceContentSha256: sha256(
          fx.sourceSha256,
          `genesis.fx[${index}].sourceSha256`,
        ),
        baseCurrency: lot.currency,
        quoteCurrency: "CNY" as const,
        cnyPerBaseUnit: cnyPerUsd,
        effectiveAt: `${lot.acquiredOn}T00:00:00.000Z`,
        visibleAt: timestamp(fx.availableAt, `genesis.fx[${index}].availableAt`),
        status: "ESTIMATED" as const,
      }),
    }));
  }
  if (fxByLot.size !== snapshot.lots.length) {
    throw new TypeError("genesis requires one acquisition FX binding per lot");
  }

  const groups = new Map<string, typeof snapshot.lots>();
  for (const lot of snapshot.lots) {
    groups.set(lot.instrumentId, Object.freeze([
      ...(groups.get(lot.instrumentId) ?? []),
      lot,
    ]));
  }
  return Object.freeze([...groups.values()].map((lots) => Object.freeze({
    instrumentId: lots[0]!.instrumentId,
    symbol: lots[0]!.symbol,
    quantity: sumDecimals(lots.map((lot) => lot.quantity)),
    grossCost: sumDecimals(lots.map((lot) => lot.grossPurchasePrice)),
    lots: Object.freeze(lots.map((lot): ShadowTaxLot => Object.freeze({
      lotId: lot.lotId,
      instrumentId: lot.instrumentId,
      acquisitionSequence: sequence(lot.acquisitionSequence),
      quantity: nonNegativeDecimal(lot.quantity),
      grossPurchasePrice: nonNegativeDecimal(lot.grossPurchasePrice),
      buyFees: nonNegativeDecimal(lot.buyFees),
    }))),
    acquisitionFxBindings: Object.freeze(lots.map((lot) => fxByLot.get(lot.lotId)!)),
  })));
}

function positionsFromLatestCycle(wrapper: Readonly<Record<string, unknown>>): readonly CurrentPosition[] {
  const cycle = exactRecord(wrapper.cycle, undefined, "priorCycles.latest.cycle");
  return Object.freeze(array(cycle.positions, "priorCycles.latest.cycle.positions")
    .map((candidate, index) => {
      const position = exactRecord(candidate, [
        "instrumentId", "symbol", "quantity", "grossCost", "lots",
        "acquisitionFxBindings",
      ], `priorCycles.latest.positions[${index}]`);
      return Object.freeze({
        instrumentId: identity(position.instrumentId, `positions[${index}].instrumentId`),
        symbol: identity(position.symbol, `positions[${index}].symbol`),
        quantity: decimalString(position.quantity, `positions[${index}].quantity`),
        grossCost: decimalString(position.grossCost, `positions[${index}].grossCost`),
        lots: array(position.lots, `positions[${index}].lots`) as readonly ShadowTaxLot[],
        acquisitionFxBindings: array(
          position.acquisitionFxBindings,
          `positions[${index}].acquisitionFxBindings`,
        ) as readonly LotAcquisitionFxBinding[],
      });
    }));
}

function extractPriorCycleTransactions(
  wrappers: readonly Readonly<Record<string, unknown>>[],
): readonly LedgerTransaction[] {
  const transactions: LedgerTransaction[] = [];
  for (const [cycleIndex, wrapper] of wrappers.entries()) {
    const row = exactRecord(wrapper, [
      "cycleId", "cycleSha256", "completedAt", "cycle",
    ], `priorCycles[${cycleIndex}]`);
    const cycle = exactRecord(row.cycle, undefined, `priorCycles[${cycleIndex}].cycle`);
    for (const stage of ["s1", "s2"] as const) {
      const staged = exactRecord(cycle[stage], undefined, `priorCycles[${cycleIndex}].${stage}`);
      for (const [settlementIndex, candidate] of array(
        staged.settlements,
        `priorCycles[${cycleIndex}].${stage}.settlements`,
      ).entries()) {
        const settlement = exactRecord(
          candidate,
          undefined,
          `priorCycles[${cycleIndex}].${stage}.settlements[${settlementIndex}]`,
        );
        const intent = exactRecord(
          settlement.intent,
          undefined,
          `priorCycles[${cycleIndex}].${stage}.settlements[${settlementIndex}].intent`,
        );
        transactions.push(...array(
          intent.ledgerTransactions,
          `priorCycles[${cycleIndex}].${stage}.ledgerTransactions`,
        ) as readonly LedgerTransaction[]);
      }
    }
  }
  return Object.freeze(transactions);
}

function positionsFromLatestCorporateAction(
  wrappers: readonly Readonly<Record<string, unknown>>[],
  headSequence: string,
  headSha256: string,
): readonly CurrentPosition[] | null {
  for (const [reverseIndex, wrapper] of [...wrappers].reverse().entries()) {
    const index = wrappers.length - reverseIndex - 1;
    const row = exactRecord(wrapper, [
      "applicationId", "contentSha256", "appliedAt", "openingHeadSequence",
      "finalHeadSequence", "application",
    ], `priorCorporateActions[${index}]`);
    const application = exactRecord(
      row.application,
      undefined,
      `priorCorporateActions[${index}].application`,
    );
    const finalHead = exactRecord(
      application.finalLedgerHead,
      ["sequence", "sha256"],
      `priorCorporateActions[${index}].finalLedgerHead`,
    );
    if (finalHead.sequence !== headSequence || finalHead.sha256 !== headSha256) continue;
    return positionsFromArtifact(
      application.positions,
      `priorCorporateActions[${index}].application.positions`,
    );
  }
  return null;
}

function extractPriorCorporateActionTransactions(
  wrappers: readonly Readonly<Record<string, unknown>>[],
): readonly LedgerTransaction[] {
  const transactions: LedgerTransaction[] = [];
  for (const [index, wrapper] of wrappers.entries()) {
    const row = exactRecord(wrapper, [
      "applicationId", "contentSha256", "appliedAt", "openingHeadSequence",
      "finalHeadSequence", "application",
    ], `priorCorporateActions[${index}]`);
    const artifact = exactRecord(
      row.application,
      undefined,
      `priorCorporateActions[${index}].application`,
    );
    const application = exactRecord(
      artifact.application,
      undefined,
      `priorCorporateActions[${index}].application.application`,
    );
    transactions.push(...array(
      application.ledgerTransactions,
      `priorCorporateActions[${index}].ledgerTransactions`,
    ) as readonly LedgerTransaction[]);
  }
  return Object.freeze(transactions);
}

function positionsFromArtifact(value: unknown, field: string): readonly CurrentPosition[] {
  return Object.freeze(array(value, field).map((candidate, index) => {
    const position = exactRecord(candidate, [
      "instrumentId", "symbol", "quantity", "grossCost", "lots",
      "acquisitionFxBindings",
    ], `${field}[${index}]`);
    return Object.freeze({
      instrumentId: identity(position.instrumentId, `${field}[${index}].instrumentId`),
      symbol: identity(position.symbol, `${field}[${index}].symbol`),
      quantity: decimalString(position.quantity, `${field}[${index}].quantity`),
      grossCost: decimalString(position.grossCost, `${field}[${index}].grossCost`),
      lots: array(position.lots, `${field}[${index}].lots`) as readonly ShadowTaxLot[],
      acquisitionFxBindings: array(
        position.acquisitionFxBindings,
        `${field}[${index}].acquisitionFxBindings`,
      ) as readonly LotAcquisitionFxBinding[],
    });
  }));
}

function decisionMarks(
  candidates: readonly unknown[],
  material: ArenaCycleMaterial,
): ReadonlyMap<string, MarketPriceEvidence> {
  const instrumentBySymbol = new Map(
    material.universe.map((instrument) => [instrument.symbol, instrument]),
  );
  const marks = new Map<string, MarketPriceEvidence>();
  for (const [index, candidate] of candidates.entries()) {
    const mark = exactRecord(candidate, [
      "factId", "symbol", "currency", "value", "sessionDate", "visibleAt",
      "snapshotId", "factSha256", "sourceArtifactId", "sourceContentSha256",
    ], `decisionClose.marks[${index}]`);
    const symbol = identity(mark.symbol, `decisionClose.marks[${index}].symbol`);
    const instrument = instrumentBySymbol.get(symbol);
    if (
      instrument === undefined
      || instrument.currency !== mark.currency
      || mark.sessionDate !== material.round.decisionSessionDate
      || mark.snapshotId !== material.round.decisionSnapshotId
      || marks.has(instrument.instrumentId)
    ) throw new TypeError("decision close mark does not bind the stable universe");
    marks.set(instrument.instrumentId, Object.freeze({
      value: decimalString(mark.value, `decisionClose.marks[${index}].value`),
      kind: "OFFICIAL_CLOSE" as const,
      sessionDate: material.round.decisionSessionDate,
      visibleAt: timestamp(mark.visibleAt, `decisionClose.marks[${index}].visibleAt`),
      snapshotId: material.round.decisionSnapshotId,
      factId: identity(mark.factId, `decisionClose.marks[${index}].factId`),
    }));
  }
  if (marks.size !== material.universe.length) {
    throw new TypeError("decision close does not cover the frozen universe");
  }
  return marks;
}

function assertPortfolioMatchesReplay(
  material: Pick<ArenaCycleMaterial, "portfolio">,
  positions: readonly CurrentPosition[],
  transactions: readonly LedgerTransaction[],
): void {
  const projection = replayLedger(transactions);
  const durable = [...material.portfolio.positions].sort(byInstrumentId);
  const replayed = positions
    .filter((position) => position.quantity !== "0")
    .sort(byInstrumentId);
  if (
    durable.length !== replayed.length
    || durable.some((position, index) => {
      const expected = replayed[index]!;
      return position.instrumentId !== expected.instrumentId
        || position.symbol !== expected.symbol
        || position.quantity !== expected.quantity
        || position.grossCost !== expected.grossCost
        || position.currency !== material.portfolio.account.baseCurrency
        || position.lotCount !== expected.lots.length.toString();
    })
  ) throw new TypeError("durable portfolio positions diverge from cycle replay state");

  const cash = projection.balances.find(
    (balance) => balance.accountId === "asset.cash"
      && balance.currency === material.portfolio.account.baseCurrency,
  )?.amount ?? "0";
  if (
    cash !== material.portfolio.cash.settled
    || projection.positions.some((position) => {
      const expected = replayed.find(
        (candidate) => candidate.instrumentId === position.instrumentId,
      );
      return position.accountId === "securities.inventory"
        && (expected === undefined || expected.quantity !== position.quantity);
    })
  ) throw new TypeError("durable portfolio balances diverge from cycle replay state");
}

function byInstrumentId(
  left: { readonly instrumentId: string },
  right: { readonly instrumentId: string },
): number {
  return left.instrumentId.localeCompare(right.instrumentId, "en");
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
    ) throw new TypeError(`${field} has an unexpected shape`);
  }
  return row;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function decimalString(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^(0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(parsed)) {
    throw new TypeError(`${field} must be a canonical non-negative decimal`);
  }
  return parsed;
}

function canonicalIntegerString(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^(?:0|[1-9]\d*)$/.test(parsed)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
  return parsed;
}

function sha256(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new TypeError(`${field} must be SHA-256`);
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

function safeScale(value: string, field: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new TypeError(`${field} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 12) {
    throw new RangeError(`${field} must be between 0 and 12`);
  }
  return parsed;
}
