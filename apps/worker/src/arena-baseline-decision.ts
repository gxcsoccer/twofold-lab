import {
  createDecisionAdmissionEvidence,
  createPortfolioDecisionEvidence,
  deriveDeterministicBaselineDecision,
  type DecisionAdmissionEvidence,
  type DeterministicBaselineDecision,
  type DeterministicBaselinePolicy,
} from "@twofold/core";

import {
  canonicalJson,
  sha256,
  type ArenaArtifactMaterial,
  type ArenaMarketSnapshot,
  type ArenaPortfolioState,
} from "./arena-inputs.js";
import type { ArenaRoundEntrantFence } from "./arena-repository.js";

export const BASELINE_PACKET_SCHEMA = "twofold.baseline_decision_packet/v1";

/**
 * Weight arithmetic scale. Marked values are exact decimal strings, so the bps
 * conversion is done on scaled integers rather than binary floats.
 */
const WEIGHT_SCALE = 12n;
const FULL_WEIGHT_BPS = 10_000n;

/**
 * A deterministic baseline's decision identity.
 *
 * This is deliberately NOT `ArenaInvocationIdentity`. That type describes a
 * Harness Agent invocation - it pins a trusted preset, an execution class, and
 * a locked provider/model route. A baseline has none of those, and widening the
 * Agent type to pretend otherwise would make one type mean two different things
 * on the code path that runs the real contestants.
 */
export interface BaselineInvocationIdentity {
  readonly decisionId: string;
  readonly runId: string;
  readonly seasonId: string;
  readonly roundEntryId: string;
  readonly entrantCode: string;
  readonly policyId: string;
  readonly policySha256: string;
  /**
   * Occupies the `root_harness_session_id` slot. The `baseline:` prefix is what
   * the database check constraint binds `decision_kind` to, so a baseline
   * decision can never be read back as an Agent result or the reverse.
   */
  readonly rootExecutionId: string;
  readonly decisionPacketId: string;
  readonly snapshotId: string;
  readonly marketManifestSha256: string;
  readonly packetSha256: string;
  readonly decisionAt: string;
  readonly dataCutoffAt: string;
  readonly submissionDeadlineAt: string;
  /**
   * The Round's frozen decision instant, shared by the admission evidence, the
   * invocation open time, and the accepted-submission time.
   * `accept_portfolio_targets_with_evidence` compares `observedAt` against
   * `p_accepted_at` byte-for-byte and `open_decision_invocation` rejects a
   * differing `p_opened_at` on retry, so this is deliberately not a clock read:
   * a second `now()` on a retry would break both fences.
   */
  readonly observedAt: string;
  /**
   * Derived from the decision, not random: a retry after the invocation is
   * already open must present the same submission identity or the RPC refuses
   * it as an idempotency key reused with different content.
   */
  readonly submissionId: string;
}

export interface BuiltBaselineDecisionInputs {
  readonly identity: BaselineInvocationIdentity;
  readonly decision: DeterministicBaselineDecision;
  readonly packetArtifact: ArenaArtifactMaterial;
  readonly policyArtifact: ArenaArtifactMaterial;
  readonly admissionEvidence: DecisionAdmissionEvidence;
  readonly maxTargetDeltaBps: string;
}

/**
 * Build every byte a deterministic baseline needs for one Round.
 *
 * Pure by construction: given the same frozen policy, Round fence, sealed
 * snapshot, and account state it produces identical artifacts, so a Worker
 * restart replays the same decision instead of creating a second one.
 *
 * @param input - Frozen policy, immutable Round seat, sealed market snapshot,
 *   and durable account state.
 * @returns Content-addressed packet and policy artifacts plus ALLOW admission
 *   evidence bound to the same snapshot.
 */
export function buildBaselineDecisionInputs(input: {
  readonly policy: DeterministicBaselinePolicy;
  readonly entrantCode: string;
  readonly fence: ArenaRoundEntrantFence;
  readonly snapshot: ArenaMarketSnapshot;
  readonly portfolioState: ArenaPortfolioState;
  readonly genesisSymbol: string;
}): BuiltBaselineDecisionInputs {
  const { policy, fence, snapshot, portfolioState } = input;
  // Deterministic by construction: the observation instant is the Round's own
  // frozen decision time, never a clock read. A Worker retry rebuilds the exact
  // same value, so open_decision_invocation and accept_portfolio_targets both
  // re-attach to the existing row instead of rejecting a differing p_opened_at
  // or p_accepted_at as an idempotency key reused with different content.
  const observedAt = fence.decisionAt;
  if (snapshot.snapshotId !== fence.snapshotId) {
    throw new TypeError("baseline snapshot is outside the Round fence");
  }

  // The policy SHA-256 covers {policyId, rule, symbol}; for HOLD_GENESIS the
  // symbol is null and the instrument comes from the Season config, which that
  // hash does not cover. Make the durable ledger authoritative instead: the
  // account's own single holding must equal the declared genesis symbol, so
  // editing the config mid-Season fails closed rather than silently retargeting
  // the baseline at a different instrument.
  if (policy.rule === "HOLD_GENESIS") {
    const held = portfolioState.positions;
    if (held.length !== 1 || held[0]!.symbol !== input.genesisSymbol) {
      throw new TypeError(
        "HOLD_GENESIS account holdings do not match the declared genesis symbol",
      );
    }
  }

  // A hold account that received a cash dividend must keep that cash, not spend
  // it on more shares. Preserve the observed split instead of forcing the full
  // weight onto the position.
  const cashBps = computeCashWeightBps({ snapshot, portfolioState });
  const decision = deriveDeterministicBaselineDecision({
    policy,
    genesisSymbol: input.genesisSymbol,
    priceableSymbols: [...snapshot.symbols],
    ...(policy.rule === "HOLD_GENESIS"
      ? {
          holdWeights: {
            positionBps: (FULL_WEIGHT_BPS - cashBps).toString(),
            cashBps: cashBps.toString(),
          },
        }
      : {}),
  });
  const target = decision.targets[0]!;

  const rootExecutionId = `baseline:${policy.policyId}:${fence.roundEntryId}`;
  const decisionPacketId = uuidFromDigest(sha256(
    `${BASELINE_PACKET_SCHEMA}:${fence.decisionId}`,
  ));

  const policyArtifact = artifact(
    policy.policyCanonicalJson,
    "arena/baseline-policies",
  );

  const packet = {
    schema: BASELINE_PACKET_SCHEMA,
    decision_packet_id: decisionPacketId,
    available_at: fence.decisionAt,
    payload: {
      policy: {
        schema: policy.schema,
        policy_id: policy.policyId,
        rule: policy.rule,
        symbol: policy.symbol,
        policy_sha256: policy.policySha256,
      },
      market_snapshot: {
        snapshot_id: snapshot.snapshotId,
        source_version_id: snapshot.sourceVersionId,
        manifest_sha256: snapshot.manifestSha256,
        session_date: snapshot.targetSessionDate,
        cutoff_at: snapshot.cutoffAt,
        sealed_at: snapshot.sealedAt,
        symbols: [...snapshot.symbols].sort(),
      },
      portfolio_state: {
        ledger_head: portfolioState.ledgerHead,
        cash: portfolioState.cash,
        positions: [...portfolioState.positions].sort(
          (left, right) => compare(left.instrumentId, right.instrumentId),
        ),
      },
      // The baseline reads no market feature and calls no model: the target is
      // a pure function of the frozen policy above. It is recorded here so the
      // packet alone is enough to reproduce and audit the decision.
      derived_target: {
        targets: decision.targets.map((entry) => ({
          symbol: entry.symbol,
          target_weight_bps: entry.targetWeightBps,
        })),
        cash_weight_bps: decision.cashWeightBps,
      },
    },
  };
  const packetArtifact = artifact(
    canonicalJson(packet),
    "arena/baseline-decision-packets",
  );

  const maxTargetDeltaBps = computeMaxTargetDeltaBps({
    snapshot,
    portfolioState,
    targetSymbol: target.symbol,
    targetWeightBps: target.targetWeightBps,
    targetCashWeightBps: decision.cashWeightBps,
  });

  const admissionEvidence = createDecisionAdmissionEvidence({
    decision: createPortfolioDecisionEvidence({
      // The accept RPC compares this against the raw invocation decision_id.
      decisionRef: fence.decisionId,
      policyRef: `baseline-policy:${policy.policySha256}`,
      evidenceSnapshotId: snapshot.snapshotId,
      targets: decision.targets.map((entry) => ({
        symbol: entry.symbol,
        targetWeightBps: entry.targetWeightBps,
      })),
      cashWeightBps: decision.cashWeightBps,
    }),
    observedAt,
    dataCutoffAt: snapshot.cutoffAt,
    evidenceSealedAt: snapshot.sealedAt,
    // A baseline target is not derived from any market observation, so a price
    // jump or a cooldown cannot invalidate it the way it invalidates a model's
    // reading of the same packet. The guards stay in the record - bound to the
    // baseline policyRef, so which regime applied is explicit - rather than
    // being silently skipped.
    marketJumpBps: "0",
    maxTargetDeltaBps,
    cooldownRemainingMs: "0",
    policy: baselineAdmissionPolicy({
      dataCutoffAt: snapshot.cutoffAt,
      submissionDeadlineAt: fence.submissionDeadlineAt,
    }),
  });

  return Object.freeze({
    identity: Object.freeze({
      decisionId: fence.decisionId,
      runId: fence.runId,
      seasonId: fence.seasonId,
      roundEntryId: fence.roundEntryId,
      entrantCode: input.entrantCode,
      policyId: policy.policyId,
      policySha256: policy.policySha256,
      rootExecutionId,
      decisionPacketId,
      snapshotId: snapshot.snapshotId,
      marketManifestSha256: snapshot.manifestSha256,
      packetSha256: packetArtifact.sha256,
      decisionAt: fence.decisionAt,
      dataCutoffAt: snapshot.cutoffAt,
      submissionDeadlineAt: fence.submissionDeadlineAt,
      observedAt,
      submissionId: uuidFromDigest(sha256(
        `twofold.baseline_submission/v1:${fence.decisionId}`,
      )),
    }),
    decision,
    packetArtifact,
    policyArtifact,
    admissionEvidence,
    maxTargetDeltaBps,
  });
}

/**
 * A baseline is defined as a full-weight single-instrument allocation, so a
 * 10000 bps reallocation is its normal opening move rather than an anomaly.
 * The ceiling is therefore the full weight; the observation is still recorded
 * exactly, which is what makes a hold (0) distinguishable from a switch.
 *
 * The input-age ceiling is the Round's own frozen window rather than a fixed
 * span: a decision claimed late inside its own submission window is on time by
 * definition, and a hard-coded span shorter than the window would turn that
 * into a BLOCK that the accept RPC then refuses outright.
 */
function baselineAdmissionPolicy(input: {
  readonly dataCutoffAt: string;
  readonly submissionDeadlineAt: string;
}) {
  const windowMs = Date.parse(input.submissionDeadlineAt)
    - Date.parse(input.dataCutoffAt);
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError("baseline Round window is not a positive interval");
  }
  return Object.freeze({
    policyRef: "twofold.deterministic_baseline_admission/v1",
    maxInputAgeMs: String(windowMs),
    maxMarketJumpBps: "10000",
    minimumStableWindowMs: "0",
    maxTargetDeltaBps: "10000",
    maxCooldownRemainingMs: "0",
  });
}

/**
 * Largest absolute per-symbol weight change this decision implies, in bps.
 * Reported as evidence of how much the baseline actually reallocates: zero once
 * it has converged onto its own instrument, full weight on the opening switch.
 */
export function computeMaxTargetDeltaBps(input: {
  readonly snapshot: ArenaMarketSnapshot;
  readonly portfolioState: ArenaPortfolioState;
  readonly targetSymbol: string;
  /** Defaults to the full weight, i.e. an all-in switch. */
  readonly targetWeightBps?: string;
  readonly targetCashWeightBps?: string;
}): string {
  const targetBps = BigInt(input.targetWeightBps ?? FULL_WEIGHT_BPS.toString());
  const targetCashBps = BigInt(input.targetCashWeightBps ?? "0");
  const closeBySymbol = new Map(
    input.snapshot.bars.map((bar) => [bar.symbol, bar.closePrice]),
  );
  const cash = scaled(input.portfolioState.cash.settled);
  let total = cash;
  const markedBySymbol = new Map<string, bigint>();
  for (const position of input.portfolioState.positions) {
    const close = closeBySymbol.get(position.symbol);
    if (close === undefined) {
      throw new RangeError(
        `sealed snapshot cannot mark held position ${position.symbol}`,
      );
    }
    // Quantity is numeric(38,12), not an integer: a split or other corporate
    // action can leave a fractional holding. Both operands are scaled and the
    // product is divided back down, so the result stays in the same fixed-point
    // space as cash without ever parsing a decimal as an integer.
    const marked = (scaled(position.quantity) * scaled(close))
      / 10n ** WEIGHT_SCALE;
    markedBySymbol.set(
      position.symbol,
      (markedBySymbol.get(position.symbol) ?? 0n) + marked,
    );
    total += marked;
  }
  if (total <= 0n) {
    throw new RangeError("baseline cannot weight an empty portfolio");
  }

  let maximum = 0n;
  for (const [symbol, marked] of markedBySymbol) {
    const current = (marked * FULL_WEIGHT_BPS) / total;
    const delta = symbol === input.targetSymbol
      ? abs(targetBps - current)
      : current;
    if (delta > maximum) maximum = delta;
  }
  if (!markedBySymbol.has(input.targetSymbol)) maximum = targetBps;
  const cashDelta = abs(targetCashBps - (cash * FULL_WEIGHT_BPS) / total);
  if (cashDelta > maximum) maximum = cashDelta;
  return maximum.toString();
}

/** Marked cash weight of the account, in basis points. */
export function computeCashWeightBps(input: {
  readonly snapshot: ArenaMarketSnapshot;
  readonly portfolioState: ArenaPortfolioState;
}): bigint {
  const closeBySymbol = new Map(
    input.snapshot.bars.map((bar) => [bar.symbol, bar.closePrice]),
  );
  const cash = scaled(input.portfolioState.cash.settled);
  let total = cash;
  for (const position of input.portfolioState.positions) {
    const close = closeBySymbol.get(position.symbol);
    if (close === undefined) {
      throw new RangeError(
        `sealed snapshot cannot mark held position ${position.symbol}`,
      );
    }
    total += (scaled(position.quantity) * scaled(close)) / 10n ** WEIGHT_SCALE;
  }
  if (total <= 0n) {
    throw new RangeError("baseline cannot weight an empty portfolio");
  }
  return (cash * FULL_WEIGHT_BPS) / total;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function scaled(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`baseline weighting requires a non-negative decimal: ${value}`);
  }
  const [whole, fraction = ""] = value.split(".");
  const scale = Number(WEIGHT_SCALE);
  if (fraction.length > scale) {
    throw new RangeError(`decimal ${value} exceeds the baseline weighting scale`);
  }
  return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
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
  const hex = chars.join("");
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20, 32),
  ].join("-");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
