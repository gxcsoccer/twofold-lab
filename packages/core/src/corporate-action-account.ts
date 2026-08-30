import { createHash } from "node:crypto";

import { canonicalFinancialJson, compareCodePoints } from "./canonical-json.js";
import type {
  CashDividendCorporateActionApplication,
  CashDividendEntitlement,
  SplitCorporateActionApplication,
  SplitCorporateActionPosition,
} from "./corporate-actions.js";
import {
  addDecimals,
  compareDecimals,
  normalizeDecimal,
  subtractDecimals,
  sumDecimals,
} from "./fixed-decimal.js";
import {
  replayLedger,
  type LedgerProjection,
  type LedgerTransaction,
} from "./ledger.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

export type CorporateActionAccountActionType =
  | "FORWARD_SPLIT"
  | "REVERSE_SPLIT"
  | "CASH_DIVIDEND";

export type CommittableCorporateActionApplication =
  | Exclude<SplitCorporateActionApplication, { readonly status: "UNRESOLVED" }>
  | Exclude<CashDividendCorporateActionApplication, { readonly status: "UNRESOLVED" }>;

export type CorporateActionAccountPreparationMaterial =
  | Readonly<{
    actionType: "CASH_DIVIDEND";
    entitlement: CashDividendEntitlement;
  }>
  | Readonly<{
    actionType: "FORWARD_SPLIT" | "REVERSE_SPLIT";
    application: Exclude<
      SplitCorporateActionApplication,
      { readonly status: "UNRESOLVED" }
    >;
  }>;

export interface CorporateActionAccountPreparationInput {
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly ledgerHead: Readonly<{ sequence: string; sha256: string }>;
  readonly material: CorporateActionAccountPreparationMaterial;
  readonly capturedAt: string;
}

export interface CorporateActionAccountPreparationResult {
  readonly schema: "twofold.corporate_action_account_preparation/v1";
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly actionType: CorporateActionAccountActionType;
  readonly status: "PREPARED" | "NO_POSITION" | "NO_ENTITLEMENT";
  readonly capturedAt: string;
  readonly ledgerHead: Readonly<{ sequence: string; sha256: string }>;
  readonly material: CorporateActionAccountPreparationMaterial;
  readonly canonicalJson: string;
  readonly contentSha256: string;
}

/** Freeze ex-date entitlement or a split adjustment before the market opens. */
export function createCorporateActionAccountPreparation(
  input: CorporateActionAccountPreparationInput,
): CorporateActionAccountPreparationResult {
  identity(input.strategyAccountId, "strategyAccountId");
  identity(input.runId, "runId");
  identity(input.sourceActionId, "sourceActionId");
  if (!SHA256_PATTERN.test(input.revisionSha256)) {
    throw new TypeError("revisionSha256 must be a lowercase SHA-256");
  }
  const capturedAt = timestamp(input.capturedAt, "capturedAt");
  const ledgerHead = validateHead(input.ledgerHead, "ledgerHead");
  let status: CorporateActionAccountPreparationResult["status"];
  if (input.material.actionType === "CASH_DIVIDEND") {
    const entitlement = input.material.entitlement;
    if (entitlement.instrumentId.trim() === ""
      || entitlement.schema !== "twofold.cash_dividend_entitlement/v1"
      || entitlement.capturedAt !== capturedAt
      || entitlement.ledgerHeadSequence !== ledgerHead.sequence
      || entitlement.ledgerHeadSha256 !== ledgerHead.sha256) {
      throw new TypeError("dividend entitlement does not bind its preparation fence");
    }
    timestamp(entitlement.exDateOpenAt, "entitlement.exDateOpenAt");
    if (capturedAt >= entitlement.exDateOpenAt) {
      throw new RangeError("dividend entitlement must be frozen before ex-date open");
    }
    if (!INTEGER_PATTERN.test(entitlement.quantity)) {
      throw new TypeError("dividend entitlement quantity must be a whole-share string");
    }
    status = entitlement.quantity === "0" ? "NO_ENTITLEMENT" : "PREPARED";
  } else {
    const application = input.material.application;
    if (application.sourceActionId !== input.sourceActionId
      || application.revisionSha256 !== input.revisionSha256) {
      throw new TypeError("split preparation does not bind the requested revision");
    }
    const effectiveAt = timestamp(application.effectiveAt, "application.effectiveAt");
    if (capturedAt >= effectiveAt) {
      throw new RangeError("split must be prepared before its effective market open");
    }
    status = application.status === "NO_POSITION" ? "NO_POSITION" : "PREPARED";
  }
  const material = deepFreezeMaterial(input.material);
  const payload = Object.freeze({
    schema: "twofold.corporate_action_account_preparation/v1" as const,
    strategyAccountId: input.strategyAccountId,
    runId: input.runId,
    sourceActionId: input.sourceActionId,
    revisionSha256: input.revisionSha256,
    actionType: input.material.actionType,
    status,
    capturedAt,
    ledgerHead,
    material,
  });
  const canonicalJson = canonicalFinancialJson(payload);
  return Object.freeze({
    ...payload,
    canonicalJson,
    contentSha256: sha256(canonicalJson),
  });
}

export interface CorporateActionAccountApplicationInput {
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly actionType: CorporateActionAccountActionType;
  readonly preparationSha256: string;
  readonly openingLedgerHead: Readonly<{
    sequence: string;
    sha256: string;
  }>;
  readonly priorPortfolio: Readonly<{
    cashAssetBalance: string;
    taxReserveBalance: string;
    positions: readonly SplitCorporateActionPosition[];
    ledgerTransactions: readonly LedgerTransaction[];
  }>;
  readonly application: CommittableCorporateActionApplication;
  readonly recordedAt: string;
}

export interface CorporateActionAccountApplicationResult {
  readonly schema: "twofold.corporate_action_account_application/v1";
  readonly strategyAccountId: string;
  readonly runId: string;
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly actionType: CorporateActionAccountActionType;
  readonly status: CommittableCorporateActionApplication["status"];
  readonly recordedAt: string;
  readonly openingLedgerHead: Readonly<{ sequence: string; sha256: string }>;
  /** Hash of the exact economic delta; this, rather than the outer artifact, advances the head. */
  readonly mutationSha256: string;
  readonly mutationCanonicalJson: string;
  readonly preparationSha256: string;
  readonly application: CommittableCorporateActionApplication;
  readonly positions: readonly SplitCorporateActionPosition[];
  readonly ledger: LedgerProjection;
  readonly cash: Readonly<{
    settled: string;
    taxReserve: string;
    buyingPower: string;
  }>;
  readonly finalLedgerHead: Readonly<{ sequence: string; sha256: string }>;
  readonly canonicalJson: string;
  readonly contentSha256: string;
}

/**
 * Publishes one account-scoped corporate-action artifact from a prepared Core
 * application. Economic applications advance the account ledger head exactly
 * once; explicit NO_POSITION/NO_ENTITLEMENT evaluations are durable no-ops and
 * therefore do not invent ledger history.
 */
export function createCorporateActionAccountApplication(
  input: CorporateActionAccountApplicationInput,
): CorporateActionAccountApplicationResult {
  identity(input.strategyAccountId, "strategyAccountId");
  identity(input.runId, "runId");
  if (!SHA256_PATTERN.test(input.preparationSha256)) {
    throw new TypeError("preparationSha256 must be a lowercase SHA-256");
  }
  const recordedAt = timestamp(input.recordedAt, "recordedAt");
  const openingLedgerHead = validateHead(input.openingLedgerHead, "openingLedgerHead");
  const application = validateApplication(input.actionType, input.application, recordedAt);
  const priorPositions = validatePositions(input.priorPortfolio.positions);
  const priorCash = nonNegative(input.priorPortfolio.cashAssetBalance, "cashAssetBalance");
  const priorReserve = nonNegative(
    input.priorPortfolio.taxReserveBalance,
    "taxReserveBalance",
  );
  if (compareDecimals(priorReserve, priorCash) > 0) {
    throw new RangeError("prior tax reserve exceeds settled cash");
  }

  const priorLedger = replayLedger(input.priorPortfolio.ledgerTransactions);
  assertLedgerPositions(priorLedger, priorPositions);
  if (cashBalance(priorLedger) !== priorCash) {
    throw new TypeError("prior cash does not reconcile to ledger replay");
  }

  let positions = priorPositions;
  if (input.actionType !== "CASH_DIVIDEND" && application.status === "APPLIED") {
    const split = application as Extract<
      SplitCorporateActionApplication,
      { readonly status: "APPLIED" }
    >;
    const index = priorPositions.findIndex(
      (position) => position.instrumentId === split.position.instrumentId,
    );
    if (index < 0) throw new TypeError("split application has no matching prior position");
    positions = Object.freeze(priorPositions.map((position, candidateIndex) =>
      candidateIndex === index ? validatePosition(split.position) : position));
  }

  const ledgerTransactions = application.ledgerTransactions;
  const ledger = replayLedger([
    ...input.priorPortfolio.ledgerTransactions,
    ...ledgerTransactions,
  ]);
  assertLedgerPositions(ledger, positions);

  const settled = cashBalance(ledger);
  let taxReserve = priorReserve;
  if (input.actionType === "CASH_DIVIDEND" && application.status === "APPLIED") {
    const dividend = application as Extract<
      CashDividendCorporateActionApplication,
      { readonly status: "APPLIED" }
    >;
    if (settled !== addDecimals(priorCash, dividend.cashTransition.settledCashDelta)) {
      throw new TypeError("dividend settled-cash delta does not reconcile to ledger replay");
    }
    taxReserve = addDecimals(priorReserve, dividend.cashTransition.taxReserveDelta);
    if (subtractDecimals(settled, taxReserve)
      !== addDecimals(
        subtractDecimals(priorCash, priorReserve),
        dividend.cashTransition.buyingPowerDelta,
      )) {
      throw new TypeError("dividend buying-power transition does not reconcile");
    }
  } else if (settled !== priorCash) {
    throw new TypeError("non-dividend corporate action changed settled cash");
  }
  if (compareDecimals(taxReserve, settled) > 0) {
    throw new RangeError("corporate-action tax reserve exceeds settled cash");
  }
  const buyingPower = subtractDecimals(settled, taxReserve);

  const mutation = Object.freeze({
    schema: "twofold.corporate_action_account_mutation/v1" as const,
    strategyAccountId: input.strategyAccountId,
    runId: input.runId,
    sourceActionId: application.sourceActionId,
    revisionSha256: application.revisionSha256,
    preparationSha256: input.preparationSha256,
    actionType: input.actionType,
    status: application.status,
    recordedAt,
    application,
  });
  const mutationCanonicalJson = canonicalFinancialJson(mutation);
  const mutationSha256 = sha256(mutationCanonicalJson);
  const isEconomicMutation = application.status === "APPLIED";
  const finalSequence = isEconomicMutation
    ? (BigInt(openingLedgerHead.sequence) + 1n).toString()
    : openingLedgerHead.sequence;
  const finalSha256 = isEconomicMutation
    ? sha256(canonicalFinancialJson({
        previousHeadSha256: openingLedgerHead.sha256,
        corporateActionMutationSha256: mutationSha256,
        sequence: finalSequence,
      }))
    : openingLedgerHead.sha256;

  const payload = Object.freeze({
    schema: "twofold.corporate_action_account_application/v1" as const,
    strategyAccountId: input.strategyAccountId,
    runId: input.runId,
    sourceActionId: application.sourceActionId,
    revisionSha256: application.revisionSha256,
    actionType: input.actionType,
    status: application.status,
    recordedAt,
    openingLedgerHead,
    preparationSha256: input.preparationSha256,
    mutationCanonicalJson,
    mutationSha256,
    application,
    positions,
    ledger,
    cash: Object.freeze({ settled, taxReserve, buyingPower }),
    finalLedgerHead: Object.freeze({
      sequence: finalSequence,
      sha256: finalSha256,
    }),
  });
  const canonicalJson = canonicalFinancialJson(payload);
  return Object.freeze({
    ...payload,
    canonicalJson,
    contentSha256: sha256(canonicalJson),
  });
}

function validateApplication(
  actionType: CorporateActionAccountActionType,
  application: CommittableCorporateActionApplication,
  recordedAt: string,
): CommittableCorporateActionApplication {
  if (!SHA256_PATTERN.test(application.revisionSha256)) {
    throw new TypeError("application revisionSha256 must be a lowercase SHA-256");
  }
  identity(application.sourceActionId, "application.sourceActionId");
  if (actionType === "CASH_DIVIDEND") {
    if (application.status === "NO_POSITION" || !("appliedAt" in application)) {
      throw new TypeError("cash dividend cannot use split application status");
    }
    const appliedAt = timestamp(application.appliedAt, "application.appliedAt");
    if (recordedAt < appliedAt) {
      throw new RangeError("cash-dividend record cannot predate application");
    }
  } else {
    if (application.status === "NO_ENTITLEMENT" || !("effectiveAt" in application)) {
      throw new TypeError("split cannot use dividend application status");
    }
    // Brokers publish split-adjusted units before the opening auction so orders
    // can be sized in post-split shares. The embedded ledger transaction keeps
    // the exchange-open effectiveAt; recordedAt is the earlier operational
    // publication time and is fenced by the immutable preparation artifact.
    timestamp(application.effectiveAt, "application.effectiveAt");
  }
  return application;
}

function validateHead(
  value: Readonly<{ sequence: string; sha256: string }>,
  field: string,
): Readonly<{ sequence: string; sha256: string }> {
  if (!INTEGER_PATTERN.test(value.sequence) || !SHA256_PATTERN.test(value.sha256)) {
    throw new TypeError(`${field} is invalid`);
  }
  return Object.freeze({ sequence: value.sequence, sha256: value.sha256 });
}

function validatePositions(
  candidates: readonly SplitCorporateActionPosition[],
): readonly SplitCorporateActionPosition[] {
  const seen = new Set<string>();
  const positions = candidates.map((candidate) => {
    const position = validatePosition(candidate);
    if (seen.has(position.instrumentId)) {
      throw new TypeError("corporate-action portfolio has duplicate instruments");
    }
    seen.add(position.instrumentId);
    return position;
  });
  positions.sort((left, right) => compareCodePoints(left.instrumentId, right.instrumentId));
  return Object.freeze(positions);
}

function validatePosition(
  position: SplitCorporateActionPosition,
): SplitCorporateActionPosition {
  identity(position.instrumentId, "position.instrumentId");
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(position.symbol)
    || !INTEGER_PATTERN.test(position.quantity)
    || !DECIMAL_PATTERN.test(position.grossCost)) {
    throw new TypeError("corporate-action position has invalid scalar state");
  }
  if (position.lots.length !== position.acquisitionFxBindings.length
    || (position.quantity === "0" && (
      position.grossCost !== "0" || position.lots.length !== 0
    ))) {
    throw new TypeError("corporate-action position has invalid lot cardinality");
  }
  const bindingIds = new Set(position.acquisitionFxBindings.map((binding) => binding.lotId));
  if (bindingIds.size !== position.acquisitionFxBindings.length
    || position.lots.some((lot) =>
      lot.instrumentId !== position.instrumentId || !bindingIds.has(lot.lotId))
    || sumDecimals(position.lots.map((lot) => lot.quantity)) !== position.quantity
    || sumDecimals(position.lots.map((lot) => lot.grossPurchasePrice))
      !== position.grossCost) {
    throw new TypeError("corporate-action position does not reconcile to FIFO lots");
  }
  return Object.freeze({
    ...position,
    lots: Object.freeze([...position.lots]),
    acquisitionFxBindings: Object.freeze([...position.acquisitionFxBindings]),
  });
}

function assertLedgerPositions(
  ledger: LedgerProjection,
  positions: readonly SplitCorporateActionPosition[],
): void {
  const expected = new Map(positions
    .filter((position) => position.quantity !== "0")
    .map((position) => [position.instrumentId, position.quantity] as const));
  const actual = ledger.positions.filter(
    (position) => position.accountId === "securities.inventory"
      && position.quantity !== "0",
  );
  if (actual.length !== expected.size || actual.some((position) =>
    expected.get(position.instrumentId) !== position.quantity)) {
    throw new TypeError("corporate-action positions diverge from ledger replay");
  }
}

function cashBalance(ledger: LedgerProjection): string {
  const balances = ledger.balances.filter(
    (balance) => balance.accountId === "asset.cash" && balance.currency === "USD",
  );
  if (balances.length > 1) throw new TypeError("ledger has duplicate USD cash balances");
  const cash = balances[0]?.amount ?? "0";
  if (compareDecimals(cash, "0") < 0) throw new RangeError("ledger cash is negative");
  return cash;
}

function nonNegative(value: string, field: string): string {
  if (!DECIMAL_PATTERN.test(value) || normalizeDecimal(value) !== value) {
    throw new TypeError(`${field} must be a canonical non-negative decimal`);
  }
  return value;
}

function identity(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID`);
  return value;
}

function timestamp(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreezeMaterial(
  material: CorporateActionAccountPreparationMaterial,
): CorporateActionAccountPreparationMaterial {
  if (material.actionType === "CASH_DIVIDEND") {
    return Object.freeze({
      actionType: material.actionType,
      entitlement: Object.freeze({ ...material.entitlement }),
    });
  }
  return Object.freeze({
    actionType: material.actionType,
    application: material.application,
  });
}
