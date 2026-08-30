import {
  absoluteDecimal,
  compareDecimals,
  createDecisionAdmissionEvidence,
  createPortfolioDecisionEvidence,
  divideDecimals,
  multiplyDecimals,
  subtractDecimals,
  sumDecimals,
  type DecisionAdmissionEvidence,
} from "@twofold/core";
import type {
  PortfolioTargetsSubmission,
  ReadyDecisionPacket,
} from "@twofold-lab/dsh-twofold";

import type { ArenaInvocationIdentity } from "./arena-types.js";

const ADMISSION_POLICY_REF = "twofold.arena_submission_admission/v1";

/**
 * Derive every admission observation from the exact packet visible to the
 * model. No network read or mutable account query may enter this boundary.
 */
export function buildArenaDecisionAdmissionEvidence(input: {
  readonly identity: ArenaInvocationIdentity;
  readonly packet: ReadyDecisionPacket;
  readonly submission: PortfolioTargetsSubmission;
  readonly acceptedAt: string;
}): DecisionAdmissionEvidence {
  const snapshot = record(
    input.packet.payload.market_snapshot,
    "packet.market_snapshot",
  );
  if (snapshot.snapshot_id !== input.identity.snapshotId) {
    throw new TypeError("decision packet snapshot differs from invocation identity");
  }
  const cutoffAt = timestamp(snapshot.cutoff_at, "market_snapshot.cutoff_at");
  const sealedAt = timestamp(snapshot.sealed_at, "market_snapshot.sealed_at");
  if (cutoffAt !== input.identity.dataCutoffAt) {
    throw new TypeError("decision packet cutoff differs from invocation identity");
  }
  const decision = createPortfolioDecisionEvidence({
    decisionRef: input.identity.decisionId,
    policyRef: `agent-bundle:${input.identity.bundleSha256}`,
    evidenceSnapshotId: input.identity.snapshotId,
    targets: input.submission.targets.map((target) => ({
      symbol: target.symbol,
      targetWeightBps: target.target_weight_bps,
    })),
    cashWeightBps: input.submission.cash_weight_bps,
  });
  const maximumInputAge = Date.parse(input.identity.submissionDeadlineAt)
    - Date.parse(input.identity.dataCutoffAt);
  if (!Number.isSafeInteger(maximumInputAge) || maximumInputAge < 0) {
    throw new TypeError("Arena submission window is not a valid input-age fence");
  }
  return createDecisionAdmissionEvidence({
    decision,
    observedAt: input.acceptedAt,
    dataCutoffAt: cutoffAt,
    evidenceSealedAt: sealedAt,
    marketJumpBps: maximumMarketJumpBps(snapshot.bars),
    maxTargetDeltaBps: maximumTargetDeltaBps(
      input.packet,
      input.submission,
    ),
    cooldownRemainingMs: "0",
    policy: {
      policyRef: ADMISSION_POLICY_REF,
      maxInputAgeMs: String(maximumInputAge),
      // V1 records the signal and rejects only a move above 100%. A tighter
      // regime belongs in a future immutable Season rulebook, not a hot flag.
      maxMarketJumpBps: "10000",
      minimumStableWindowMs: "0",
      maxTargetDeltaBps: "10000",
      maxCooldownRemainingMs: "0",
    },
  });
}

function maximumMarketJumpBps(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("market_snapshot.bars must be a non-empty array");
  }
  let maximum = "0";
  for (const [index, candidate] of value.entries()) {
    const bar = record(candidate, `market_snapshot.bars[${index}]`);
    const open = decimal(bar.open_price, `bars[${index}].open_price`, true);
    const close = decimal(bar.close_price, `bars[${index}].close_price`, true);
    const jump = divideDecimals(
      multiplyDecimals(absoluteDecimal(subtractDecimals(close, open)), "10000"),
      open,
      0,
      "HALF_UP",
    );
    if (compareDecimals(jump, maximum) > 0) maximum = jump;
  }
  return maximum;
}

function maximumTargetDeltaBps(
  packet: ReadyDecisionPacket,
  submission: PortfolioTargetsSubmission,
): string {
  const snapshot = record(packet.payload.market_snapshot, "packet.market_snapshot");
  const bars = array(snapshot.bars, "market_snapshot.bars");
  const closeBySymbol = new Map<string, string>();
  for (const [index, candidate] of bars.entries()) {
    const bar = record(candidate, `market_snapshot.bars[${index}]`);
    const symbol = identity(bar.symbol, `bars[${index}].symbol`);
    if (closeBySymbol.has(symbol)) throw new TypeError(`duplicate market bar ${symbol}`);
    closeBySymbol.set(
      symbol,
      decimal(bar.close_price, `bars[${index}].close_price`, true),
    );
  }
  const portfolio = record(packet.payload.portfolio_state, "packet.portfolio_state");
  const current = new Map<string, string>();
  let currentCashWeight = "10000";
  if (portfolio.status === "configured") {
    const cash = record(portfolio.cash, "portfolio_state.cash");
    const settled = decimal(cash.settled, "portfolio_state.cash.settled", false);
    const marketValues = array(
      portfolio.positions,
      "portfolio_state.positions",
    ).map((candidate, index) => {
      const position = record(candidate, `portfolio_state.positions[${index}]`);
      const symbol = identity(position.symbol, `positions[${index}].symbol`);
      const close = closeBySymbol.get(symbol);
      if (close === undefined) {
        throw new TypeError(`portfolio position ${symbol} has no packet close`);
      }
      return {
        symbol,
        value: multiplyDecimals(
          decimal(position.quantity, `positions[${index}].quantity`, true),
          close,
        ),
      };
    });
    const nav = sumDecimals([settled, ...marketValues.map((item) => item.value)]);
    if (compareDecimals(nav, "0") > 0) {
      for (const item of marketValues) {
        current.set(item.symbol, divideDecimals(
          multiplyDecimals(item.value, "10000"),
          nav,
          0,
          "HALF_UP",
        ));
      }
      currentCashWeight = divideDecimals(
        multiplyDecimals(settled, "10000"),
        nav,
        0,
        "HALF_UP",
      );
    }
  } else if (portfolio.status !== "not_configured") {
    throw new TypeError("portfolio_state.status is unsupported");
  }

  const target = new Map(
    submission.targets.map((item) => [item.symbol, item.target_weight_bps]),
  );
  let maximum = absoluteBigInt(
    BigInt(submission.cash_weight_bps) - BigInt(currentCashWeight),
  );
  for (const symbol of new Set([...current.keys(), ...target.keys()])) {
    const delta = BigInt(target.get(symbol) ?? "0")
      - BigInt(current.get(symbol) ?? "0");
    const absolute = absoluteBigInt(delta);
    if (absolute > maximum) maximum = absolute;
  }
  if (maximum > 10_000n) {
    throw new TypeError("derived target delta exceeds a complete portfolio");
  }
  return maximum.toString();
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function decimal(value: unknown, field: string, positive: boolean): string {
  const parsed = identity(value, field);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(parsed)) {
    throw new TypeError(`${field} must be a canonical decimal`);
  }
  if (positive && compareDecimals(parsed, "0") <= 0) {
    throw new TypeError(`${field} must be positive`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)
    || Number.isNaN(Date.parse(parsed))
    || new Date(Date.parse(parsed)).toISOString() !== parsed
  ) throw new TypeError(`${field} must be a canonical ISO UTC timestamp`);
  return parsed;
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}
