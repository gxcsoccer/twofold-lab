import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  JsonValue,
  PortfolioTargetsSubmission,
  ReadyDecisionPacket,
} from "@twofold-lab/dsh-twofold";
import { compareDecimals, subtractDecimals } from "@twofold/core";

import {
  ARENA_PROJECTION_SCHEMA_VERSION,
  DECISION_PACKET_SCHEMA_VERSION,
  emptyArenaUsage,
  type ArenaInvocationIdentity,
  type ArenaProjectionState,
} from "./arena-types.js";
import { arenaDecisionMaxBillableTokens } from "./arena-decision-budget.js";
import type { LoadedLiquidUniverse } from "./liquid-universe-reference.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_ARENA_BUDGET = Object.freeze({
  maxProviderRequests: "4",
  maxBillableTokens: "120000",
  maxEstimatedCostUsd: "1.00",
  maxDescendants: "1",
});

export type ArenaPresetId = "twofold" | "twofold-orchestrator";

export interface ArenaMarketBar {
  factId: string;
  symbol: string;
  barStart: string;
  barDate: string;
  currency: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
  tradeCount: string;
  vwap: string | null;
  factSha256: string;
}

export interface ArenaMarketSnapshot {
  snapshotId: string;
  sourceVersionId: string;
  manifestSha256: string;
  cutoffAt: string;
  targetSessionDate: string;
  selectionPolicy: string;
  sealedAt: string;
  symbols: readonly string[];
  bars: readonly ArenaMarketBar[];
}

export interface ArenaPortfolioPosition {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly quantity: string;
  readonly grossCost: string;
  readonly taxBasis: string;
  readonly currency: string;
  readonly lotCount: string;
}

/**
 * One database-authoritative, string-decimal account view bound to a ledger
 * head. It is deliberately independent of the market snapshot: holdings are
 * economic state; prices are evidence selected for the current Round.
 */
export interface ArenaPortfolioState {
  readonly schema: "twofold.strategy_portfolio_state/v1";
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly asOf: string;
  readonly account: {
    readonly accountCode: string;
    readonly broker: string;
    readonly brokerRegion: string;
    readonly baseCurrency: string;
    readonly liveTrading: false;
  };
  readonly ledgerHead: {
    readonly sequence: string;
    readonly sha256: string;
    readonly accountingTransactionCount: string;
    readonly lotOriginCount: string;
    readonly acquisitionFxBindingCount: string;
    readonly settlementCount: string;
    readonly corporateActionMutationCount: string;
  };
  readonly cash: {
    readonly settled: string;
    readonly taxReserve: string;
    readonly buyingPower: string;
  };
  readonly positions: readonly ArenaPortfolioPosition[];
}

export interface ArenaArtifactMaterial {
  content: string;
  sha256: string;
  byteSize: string;
  objectPath: string;
}

export interface BuiltArenaInputs {
  identity: Omit<
    ArenaInvocationIdentity,
    "packetArtifactId" | "bundleArtifactId"
  >;
  packet: ReadyDecisionPacket;
  packetArtifact: ArenaArtifactMaterial;
  bundleArtifact: ArenaArtifactMaterial;
  projection: ArenaProjectionState;
}

export interface ArenaCompetitionIdentity {
  readonly seasonId: string;
  readonly runId: string;
  readonly entrantCode: string;
  readonly bundleId: string;
  readonly bundleSha256: string;
  readonly presetId: ArenaPresetId;
  readonly executionClass: "ROOT_ONLY" | "ORCHESTRATED";
}

/**
 * Stable identity and timing assigned before an entrant starts one shared
 * competition Round. Rebuilding after a Worker restart must produce the same
 * decision packet bytes, not a second random decision.
 */
export interface ArenaRoundInvocationFence {
  readonly roundId: string;
  readonly roundIndex: string;
  readonly decisionId: string;
  readonly decisionAt: string;
  readonly submissionDeadlineAt: string;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortedJsonValue(record[key])]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedJsonValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(content: string, prefix: string): ArenaArtifactMaterial {
  const digest = sha256(content);
  return Object.freeze({
    content,
    sha256: digest,
    byteSize: String(Buffer.byteLength(content)),
    objectPath: `${prefix}/${digest}.json`,
  });
}

function uuidFromDigest(digest: string): string {
  const chars = digest.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const COMMON_BUNDLE_FILES = [
  "packages/dsh-twofold/package.json",
  "packages/dsh-twofold/cordis.patch.yml",
  "packages/dsh-twofold/src/contracts.ts",
  "packages/dsh-twofold/src/index.ts",
  "packages/dsh-twofold/src/orchestrator.ts",
  "packages/dsh-twofold/src/policy.ts",
] as const;

async function gitRevision(root: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
}

function requireHarnessRevision(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new TypeError("Harness revision must be a lowercase 40-hex commit");
  }
  return value;
}

export async function buildArenaBundleArtifact(input: {
  readonly repositoryRoot: string;
  readonly harnessRoot: string;
  readonly harnessRevision?: string;
  readonly presetId: ArenaPresetId;
}): Promise<{ bundleId: string; material: ArenaArtifactMaterial }> {
  const bundleFiles = [
    ...COMMON_BUNDLE_FILES,
    `profiles/twofold/agent-presets/${input.presetId}/agent.cordis.yml`,
    `profiles/twofold/agent-presets/${input.presetId}/preset.yml`,
  ];
  const files = await Promise.all(
    bundleFiles.map(async (path) => {
      const content = await readFile(resolve(input.repositoryRoot, path));
      return { path, sha256: sha256(content) };
    }),
  );
  const harnessRevision = requireHarnessRevision(
    input.harnessRevision ?? await gitRevision(input.harnessRoot),
  );
  const manifest = {
    schema_version: "twofold.dsh_agent_bundle_manifest/v1",
    bundle_id: `${input.presetId}@0.1.0`,
    preset_id: input.presetId,
    provider: "deepseek-official",
    model: "deepseek-v4-pro",
    harness: {
      repository: "deepseek-ai/deepseek-harness",
      revision: harnessRevision,
    },
    files,
  };
  const content = canonicalJson(manifest);
  return {
    bundleId: manifest.bundle_id,
    material: artifact(content, "arena/agent-bundles"),
  };
}

export async function buildArenaInputs(input: {
  repositoryRoot: string;
  harnessRoot: string;
  harnessRevision?: string;
  snapshot: ArenaMarketSnapshot;
  competitionIdentity?: ArenaCompetitionIdentity;
  roundFence?: ArenaRoundInvocationFence;
  portfolioState?: ArenaPortfolioState;
  decisionUniverse?: LoadedLiquidUniverse;
  now?: Date;
}): Promise<BuiltArenaInputs> {
  const now = input.now ?? new Date();
  if (input.roundFence !== undefined) {
    requireRoundFence(input.roundFence, input.snapshot);
    if (input.competitionIdentity === undefined) {
      throw new TypeError("a Round invocation fence requires a competition entrant");
    }
  }
  const decisionAt = input.roundFence?.decisionAt ?? now.toISOString();
  const submissionDeadlineAt = input.roundFence?.submissionDeadlineAt
    ?? new Date(now.getTime() + 15 * 60_000).toISOString();
  const decisionId = input.roundFence?.decisionId ?? randomUUID();
  const decisionPacketId = input.roundFence === undefined
    ? randomUUID()
    : uuidFromDigest(sha256(
        `twofold.arena_round_decision_packet/v1:${decisionId}`,
      ));
  const rootSessionId = `twofold-${decisionId}`;
  const presetId = input.competitionIdentity?.presetId ?? "twofold-orchestrator";
  const executionClass = input.competitionIdentity?.executionClass ?? "ORCHESTRATED";
  const { bundleId, material: bundleArtifact } = await buildArenaBundleArtifact({
    repositoryRoot: input.repositoryRoot,
    harnessRoot: input.harnessRoot,
    ...(input.harnessRevision === undefined
      ? {}
      : { harnessRevision: input.harnessRevision }),
    presetId,
  });
  if (input.competitionIdentity !== undefined) {
    requireCompetitionIdentity(input.competitionIdentity);
    if (
      input.competitionIdentity.bundleId !== bundleId
      || input.competitionIdentity.bundleSha256 !== bundleArtifact.sha256
      || input.competitionIdentity.presetId !== presetId
    ) {
      throw new TypeError(
        "competition entrant identity does not match the immutable Agent Bundle",
      );
    }
    if (input.portfolioState === undefined) {
      throw new TypeError(
        "competition Round requires a durable portfolio state",
      );
    }
    requirePortfolioState(
      input.portfolioState,
      input.competitionIdentity.runId,
      decisionAt,
    );
  } else if (input.portfolioState !== undefined) {
    throw new TypeError(
      "portfolio state requires an explicit competition Season and Run",
    );
  }
  // Legacy one-shot dogfood remains available outside a competition. Arena
  // scheduling must always pass competitionIdentity so Season and Run persist
  // across decisions instead of being re-derived from one Bundle or randomized.
  const runId = input.competitionIdentity?.runId ?? randomUUID();
  const seasonId = input.competitionIdentity?.seasonId
    ?? uuidFromDigest(sha256(`twofold-dogfood-season:${bundleArtifact.sha256}`));
  const budget = arenaBudgetForPreset(presetId, input.snapshot.symbols.length);
  const decisionUniverse = input.decisionUniverse === undefined
    ? undefined
    : packetLiquidUniverse(input.decisionUniverse, input.snapshot);

  const payload = {
    schema_version: DECISION_PACKET_SCHEMA_VERSION,
    decision: {
      decision_id: decisionId,
      decision_at: decisionAt,
      data_cutoff_at: input.snapshot.cutoffAt,
      submission_deadline_at: submissionDeadlineAt,
      scope: "paper_portfolio_targets_only",
    },
    ...(input.roundFence === undefined ? {} : {
      round: {
        round_id: input.roundFence.roundId,
        round_index: input.roundFence.roundIndex,
      },
    }),
    market_snapshot: {
      snapshot_id: input.snapshot.snapshotId,
      source_version_id: input.snapshot.sourceVersionId,
      manifest_sha256: input.snapshot.manifestSha256,
      cutoff_at: input.snapshot.cutoffAt,
      target_session_date: input.snapshot.targetSessionDate,
      selection_policy: input.snapshot.selectionPolicy,
      sealed_at: input.snapshot.sealedAt,
      symbols: [...input.snapshot.symbols],
      bars: input.snapshot.bars.map((bar) => ({
        fact_id: bar.factId,
        symbol: bar.symbol,
        bar_start: bar.barStart,
        bar_date: bar.barDate,
        currency: bar.currency,
        open_price: bar.openPrice,
        high_price: bar.highPrice,
        low_price: bar.lowPrice,
        close_price: bar.closePrice,
        volume: bar.volume,
        trade_count: bar.tradeCount,
        vwap: bar.vwap,
        fact_sha256: bar.factSha256,
      })),
    },
    ...(decisionUniverse === undefined ? {} : {
      decision_universe: decisionUniverse,
    }),
    portfolio_state: input.portfolioState === undefined
      ? {
          status: "not_configured",
          note: "A non-competition one-shot invocation has no durable Strategy Account.",
        }
      : packetPortfolioState(input.portfolioState),
    constraints: {
      // The sealed snapshot may be a superset of the decision universe: it also
      // prices the instruments a deterministic baseline holds. Eligibility must
      // therefore come from the frozen universe, never from the snapshot, or a
      // widened snapshot would silently grant Agents the ETFs the Liquid 100
      // builder deliberately excludes.
      eligible_symbols: input.decisionUniverse === undefined
        ? [...input.snapshot.symbols]
        : input.decisionUniverse.artifact.members
            .map((member) => member.symbol)
            .sort(),
      target_weight_total_bps: "10000",
      allow_cash: true,
      live_trading: false,
      ...(input.decisionUniverse === undefined ? {} : {
        minimum_positions:
          input.decisionUniverse.artifact.policy.constraints.minimumPositions,
        maximum_positions:
          input.decisionUniverse.artifact.policy.constraints.maximumPositions,
        maximum_position_weight_bps:
          input.decisionUniverse.artifact.policy.constraints.maximumPositionWeightBps,
        minimum_cash_weight_bps:
          input.decisionUniverse.artifact.policy.constraints.minimumCashWeightBps,
      }),
    },
    runtime_budget: {
      ...budget,
      note: "Provider requests and token usage include the root and all descendant Sessions.",
    },
  } satisfies Record<string, JsonValue>;
  // Persist the complete reconstructable packet envelope. The digest is kept
  // outside the envelope to avoid a self-referential hash; it can be recovered
  // exactly from the immutable artifact metadata on replay.
  const packetContent = canonicalJson({
    status: "ready",
    decision_packet_id: decisionPacketId,
    available_at: decisionAt,
    payload,
  });
  const packetArtifact = artifact(packetContent, "arena/decision-packets");
  const persistedPacket = JSON.parse(packetContent) as {
    status: "ready";
    decision_packet_id: string;
    available_at: string;
    payload: Record<string, JsonValue>;
  };
  const packet: ReadyDecisionPacket = Object.freeze({
    status: persistedPacket.status,
    decision_packet_id: persistedPacket.decision_packet_id,
    packet_sha256: packetArtifact.sha256,
    available_at: persistedPacket.available_at,
    payload: persistedPacket.payload,
  });

  const identity = Object.freeze({
    decisionId,
    runId,
    seasonId,
    decisionPacketId,
    rootSessionId,
    snapshotId: input.snapshot.snapshotId,
    packetSha256: packetArtifact.sha256,
    bundleId,
    bundleSha256: bundleArtifact.sha256,
    presetId,
    executionClass,
    provider: "deepseek-official" as const,
    model: "deepseek-v4-pro" as const,
    decisionAt,
    dataCutoffAt: input.snapshot.cutoffAt,
    submissionDeadlineAt,
  });
  const projection: ArenaProjectionState = {
    schemaVersion: ARENA_PROJECTION_SCHEMA_VERSION,
    decision: {
      decisionId,
      runId,
      seasonId,
      bundleId,
      bundleSha256: bundleArtifact.sha256,
      presetId: identity.presetId,
      status: "QUEUED",
      decisionPacketId,
      snapshotId: input.snapshot.snapshotId,
      packetSha256: packetArtifact.sha256,
      dataCutoffAt: input.snapshot.cutoffAt,
      startedAt: decisionAt,
      completedAt: null,
      failureCode: null,
      failureMessage: null,
    },
    rootSessionId,
    agents: [
      {
        sessionId: rootSessionId,
        parentSessionId: null,
        agentPath: "root",
        displayName: "Root Portfolio Manager",
        origin: "root",
        delegationDepth: "0",
        status: "QUEUED",
        provider: identity.provider,
        model: identity.model,
        startedAt: decisionAt,
        completedAt: null,
        lastEventSeq: "0",
        usage: emptyArenaUsage(),
      },
    ],
    treeUsage: emptyArenaUsage(),
    budget: {
      maxProviderRequests: budget.maxProviderRequests,
      usedProviderRequests: "0",
      maxBillableTokens: budget.maxBillableTokens,
      usedBillableTokens: "0",
      maxEstimatedCostUsd: budget.maxEstimatedCostUsd,
      usedEstimatedCostUsd: null,
      maxDescendants: budget.maxDescendants,
      activeDescendants: "0",
      enforcementStatus: "WITHIN_LIMITS",
    },
    submission: {
      status: "PENDING",
      acceptedSubmissionId: null,
      acceptedAt: null,
      rejectionCode: null,
    },
    updatedAt: decisionAt,
  };

  return Object.freeze({
    identity,
    packet,
    packetArtifact,
    bundleArtifact,
    projection,
  });
}

export function portfolioConstraintViolation(
  submission: PortfolioTargetsSubmission,
  packet: ReadyDecisionPacket,
): string | undefined {
  const value = packet.payload.constraints;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("decision packet constraints are invalid");
  }
  const constraints = value as Record<string, JsonValue>;
  const minimum = optionalConstraintInteger(constraints.minimum_positions);
  const maximum = optionalConstraintInteger(constraints.maximum_positions);
  const maximumWeight = optionalConstraintInteger(
    constraints.maximum_position_weight_bps,
  );
  const minimumCash = optionalConstraintInteger(
    constraints.minimum_cash_weight_bps,
  );
  if (
    minimum === undefined && maximum === undefined
    && maximumWeight === undefined && minimumCash === undefined
  ) return undefined;
  if (
    minimum === undefined || maximum === undefined
    || maximumWeight === undefined || minimumCash === undefined
  ) throw new TypeError("decision packet has a partial portfolio policy");
  if (submission.targets.length < minimum || submission.targets.length > maximum) {
    return `Portfolio must contain ${minimum}-${maximum} positions`;
  }
  const overweight = submission.targets.find(
    (target) => BigInt(target.target_weight_bps) > BigInt(maximumWeight),
  );
  if (overweight !== undefined) {
    return `${overweight.symbol} exceeds the ${maximumWeight} bps position cap`;
  }
  if (BigInt(submission.cash_weight_bps) < BigInt(minimumCash)) {
    return `Portfolio must retain at least ${minimumCash} bps cash`;
  }
  return undefined;
}

function optionalConstraintInteger(value: JsonValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError("portfolio constraint must be a canonical integer string");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 10_000) {
    throw new RangeError("portfolio constraint is out of range");
  }
  return parsed;
}

function packetLiquidUniverse(
  material: LoadedLiquidUniverse,
  snapshot: ArenaMarketSnapshot,
): Record<string, JsonValue> {
  const artifact = material.artifact;
  const memberSymbols = artifact.members.map((member) => member.symbol).sort();
  const snapshotSymbols = [...snapshot.symbols].sort();
  if (
    artifact.asOfSessionDate !== snapshot.targetSessionDate
    || artifact.frozenAt > snapshot.cutoffAt
    || memberSymbols.length > snapshotSymbols.length
    || memberSymbols.some((symbol) => !snapshotSymbols.includes(symbol))
  ) throw new TypeError("liquid universe does not match the bound market snapshot");
  const features = artifact.candidates.filter((candidate) => candidate.selected)
    .sort((left, right) => left.symbol.localeCompare(right.symbol, "en"))
    .map((candidate) => ({
      symbol: candidate.symbol,
      issuer_tax_residency: candidate.issuerTaxResidency,
      as_of_session_date: candidate.asOfSessionDate,
      history_session_count: candidate.historySessionCount,
      latest_close_price: candidate.latestClosePrice,
      median_dollar_volume_20d: candidate.medianDollarVolume20d,
      return_5d_bps: candidate.return5dBps,
      return_20d_bps: candidate.return20dBps,
      return_60d_bps: candidate.return60dBps,
      liquidity_rank: candidate.liquidityRank,
      selection_reason: candidate.selectionReason!,
    }));
  if (features.length !== artifact.members.length) {
    throw new TypeError("liquid universe features do not cover every member");
  }
  return {
    schema: "twofold.decision_universe_research/v1",
    name: artifact.name,
    artifact_sha256: material.sha256,
    frozen_at: artifact.frozenAt,
    as_of_session_date: artifact.asOfSessionDate,
    eligible_candidate_count: artifact.eligibleCandidateCount,
    member_count: String(artifact.members.length),
    policy: {
      ranking: "20_SESSION_MEDIAN_DOLLAR_VOLUME_DESC",
      minimum_price_usd: artifact.policy.minimumPriceUsd,
      minimum_median_dollar_volume_usd:
        artifact.policy.minimumMedianDollarVolumeUsd,
      minimum_history_sessions: artifact.policy.minimumHistorySessions,
      mandatory_current_holdings: [...artifact.policy.mandatorySymbols],
    },
    features,
  };
}

function requireRoundFence(
  fence: ArenaRoundInvocationFence,
  snapshot: ArenaMarketSnapshot,
): void {
  for (const [field, value] of [
    ["roundId", fence.roundId],
    ["decisionId", fence.decisionId],
  ] as const) {
    if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID`);
  }
  requireInteger(fence.roundIndex, "Round index");
  if (fence.roundIndex === "0") {
    throw new TypeError("Round index must be positive");
  }
  requireTimestamp(fence.decisionAt, "Round decisionAt");
  requireTimestamp(
    fence.submissionDeadlineAt,
    "Round submissionDeadlineAt",
  );
  if (
    fence.decisionAt < snapshot.sealedAt
    || fence.decisionAt < snapshot.cutoffAt
  ) {
    throw new TypeError("Round decision cannot precede its sealed snapshot");
  }
  if (fence.submissionDeadlineAt <= fence.decisionAt) {
    throw new TypeError("Round submission deadline must follow decisionAt");
  }
}

function arenaBudgetForPreset(
  presetId: ArenaPresetId,
  symbolCount: number,
): Readonly<{
  maxProviderRequests: string;
  maxBillableTokens: string;
  maxEstimatedCostUsd: string;
  maxDescendants: string;
}> {
  return Object.freeze({
    ...DEFAULT_ARENA_BUDGET,
    maxBillableTokens: arenaDecisionMaxBillableTokens(symbolCount),
    maxDescendants: presetId === "twofold" ? "0" : "1",
  });
}

function packetPortfolioState(state: ArenaPortfolioState): Record<string, JsonValue> {
  return {
    status: "configured",
    strategy_account_id: state.strategyAccountId,
    run_id: state.runId,
    as_of: state.asOf,
    account: {
      account_code: state.account.accountCode,
      broker: state.account.broker,
      broker_region: state.account.brokerRegion,
      base_currency: state.account.baseCurrency,
      live_trading: state.account.liveTrading,
    },
    ledger_head: {
      sequence: state.ledgerHead.sequence,
      sha256: state.ledgerHead.sha256,
      accounting_transaction_count:
        state.ledgerHead.accountingTransactionCount,
      lot_origin_count: state.ledgerHead.lotOriginCount,
      acquisition_fx_binding_count:
        state.ledgerHead.acquisitionFxBindingCount,
      settlement_count: state.ledgerHead.settlementCount,
      corporate_action_mutation_count:
        state.ledgerHead.corporateActionMutationCount,
    },
    cash: {
      settled: state.cash.settled,
      tax_reserve: state.cash.taxReserve,
      buying_power: state.cash.buyingPower,
    },
    positions: state.positions.map((position) => ({
      instrument_id: position.instrumentId,
      symbol: position.symbol,
      quantity: position.quantity,
      gross_cost: position.grossCost,
      tax_basis: position.taxBasis,
      currency: position.currency,
      lot_count: position.lotCount,
    })),
  };
}

function requirePortfolioState(
  state: ArenaPortfolioState,
  runId: string,
  decisionAt: string,
): void {
  if (state.schema !== "twofold.strategy_portfolio_state/v1") {
    throw new TypeError("unsupported portfolio state schema");
  }
  if (state.runId !== runId) {
    throw new TypeError("portfolio state belongs to a different competition Run");
  }
  if (state.account.liveTrading !== false) {
    throw new TypeError("competition portfolio state must be paper-only");
  }
  if (state.account.baseCurrency !== "USD") {
    throw new TypeError("competition portfolio state must use USD base currency");
  }
  for (const [field, value] of [
    ["strategyAccountId", state.strategyAccountId],
    ["runId", state.runId],
  ] as const) {
    if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID`);
  }
  requireTimestamp(state.asOf, "portfolio state asOf");
  if (state.asOf > decisionAt) {
    throw new TypeError("portfolio state cannot be newer than the decision");
  }
  if (!SHA256_PATTERN.test(state.ledgerHead.sha256)) {
    throw new TypeError("portfolio ledger head must be a SHA-256");
  }
  for (const [field, value] of [
    ["sequence", state.ledgerHead.sequence],
    ["accountingTransactionCount", state.ledgerHead.accountingTransactionCount],
    ["lotOriginCount", state.ledgerHead.lotOriginCount],
    ["acquisitionFxBindingCount", state.ledgerHead.acquisitionFxBindingCount],
    ["settlementCount", state.ledgerHead.settlementCount],
    ["corporateActionMutationCount", state.ledgerHead.corporateActionMutationCount],
  ] as const) requireInteger(value, `portfolio ledger ${field}`);
  if (BigInt(state.ledgerHead.sequence) !== BigInt(state.ledgerHead.settlementCount)
    + BigInt(state.ledgerHead.corporateActionMutationCount)) {
    throw new TypeError("portfolio ledger sequence does not reconcile");
  }
  if (
    state.ledgerHead.lotOriginCount
    !== state.ledgerHead.acquisitionFxBindingCount
  ) {
    throw new TypeError("portfolio ledger has an unbound acquisition FX lot");
  }
  for (const [field, value] of [
    ["settled", state.cash.settled],
    ["taxReserve", state.cash.taxReserve],
    ["buyingPower", state.cash.buyingPower],
  ] as const) requireNonNegativeDecimal(value, `portfolio cash ${field}`);
  if (
    subtractDecimals(state.cash.settled, state.cash.taxReserve)
    !== state.cash.buyingPower
    || compareDecimals(state.cash.taxReserve, state.cash.settled) > 0
  ) {
    throw new TypeError("portfolio cash and buying power do not reconcile");
  }
  const instrumentIds = new Set<string>();
  const symbols = new Set<string>();
  for (const [index, position] of state.positions.entries()) {
    if (!UUID_PATTERN.test(position.instrumentId)) {
      throw new TypeError(`portfolio position ${index} instrumentId must be a UUID`);
    }
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(position.symbol)) {
      throw new TypeError(`portfolio position ${index} symbol is invalid`);
    }
    if (instrumentIds.has(position.instrumentId) || symbols.has(position.symbol)) {
      throw new TypeError("portfolio positions must have unique instruments and symbols");
    }
    instrumentIds.add(position.instrumentId);
    symbols.add(position.symbol);
    requirePositiveDecimal(position.quantity, `portfolio position ${index} quantity`);
    requireNonNegativeDecimal(position.grossCost, `portfolio position ${index} grossCost`);
    requireNonNegativeDecimal(position.taxBasis, `portfolio position ${index} taxBasis`);
    requireInteger(position.lotCount, `portfolio position ${index} lotCount`);
    if (position.lotCount === "0" || position.currency !== state.account.baseCurrency) {
      throw new TypeError(`portfolio position ${index} has invalid lot or currency state`);
    }
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function requireInteger(value: string, field: string): void {
  if (!INTEGER_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
}

function requireNonNegativeDecimal(value: string, field: string): void {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative decimal`);
  }
}

function requirePositiveDecimal(value: string, field: string): void {
  requireNonNegativeDecimal(value, field);
  if (compareDecimals(value, "0") <= 0) {
    throw new TypeError(`${field} must be positive`);
  }
}

function requireTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
}

function requireCompetitionIdentity(value: ArenaCompetitionIdentity): void {
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!uuidPattern.test(value.seasonId) || !uuidPattern.test(value.runId)) {
    throw new TypeError("competition Season and Run must be canonical UUIDs");
  }
  if (value.entrantCode.trim() === "" || value.entrantCode !== value.entrantCode.trim()) {
    throw new TypeError("competition entrantCode must be a trimmed identity");
  }
  if (!/^[0-9a-f]{64}$/.test(value.bundleSha256)) {
    throw new TypeError("competition bundleSha256 must be a lowercase SHA-256");
  }
  if (value.presetId !== "twofold" && value.presetId !== "twofold-orchestrator") {
    throw new TypeError("competition preset is not supported by the trusted host");
  }
  if (value.executionClass !== "ROOT_ONLY" && value.executionClass !== "ORCHESTRATED") {
    throw new TypeError("competition executionClass is unsupported");
  }
}

export function relativeHarnessPath(repositoryRoot: string, harnessRoot: string): string {
  return relative(repositoryRoot, harnessRoot);
}
