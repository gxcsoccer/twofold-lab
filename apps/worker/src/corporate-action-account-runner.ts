import {
  applyCashDividendCorporateAction,
  applySplitCorporateAction,
  canonicalFinancialJson,
  createCorporateActionAccountApplication,
  createCorporateActionAccountPreparation,
  type CashDividendEntitlement,
  type CommittableCorporateActionApplication,
  type SplitCorporateActionEvidence,
} from "@twofold/core";

import { deterministicUuidV8 } from "./accepted-target-cycle-service.js";
import { reconstructArenaAccountState } from "./arena-cycle-inputs.js";
import {
  commitCorporateActionAccountApplicationExact,
  registerCorporateActionAccountPreparationExact,
  type CorporateActionAccountRpcClient,
} from "./corporate-action-account-repository.js";
import type {
  CorporateActionAccountWork,
  CorporateActionAccountWorkItem,
} from "./corporate-action-work-repository.js";

export type CorporateActionReconciliationClient = CorporateActionAccountRpcClient;

export interface CorporateActionReconciliationResult {
  readonly prepared: string;
  readonly applied: string;
  readonly blocked: readonly Readonly<{
    strategyAccountId: string;
    sourceActionId: string;
    reason: string;
  }>[];
}

export interface CorporateActionDividendPolicyMaterial {
  readonly currency: string;
  readonly instrumentKind: "common_stock" | "adr" | "etf";
  readonly issuerTaxResidenceCountry: string;
  readonly distributionClassification:
    | "ordinary_dividend"
    | "interest_related_dividend"
    | "return_of_capital"
    | "capital_gain_distribution"
    | "substitute_payment"
    | "unclassified";
  readonly foreignWithholdingRate: string;
  readonly treatyOrLocalCapRate: string;
  readonly foreignTaxCreditEvidenceStatus:
    | "CONFIRMED"
    | "EVIDENCE_PENDING"
    | "DISALLOWED";
  readonly fx: Readonly<{
    fxRateId: string;
    sourceContentSha256: string;
    baseCurrency: string;
    quoteCurrency: "CNY";
    cnyPerBaseUnit: string;
    effectiveAt: string;
    visibleAt: string;
    status: "FINAL";
  }>;
}

export interface CorporateActionDividendPolicyProvider {
  load(
    item: CorporateActionAccountWorkItem,
    signal: AbortSignal,
  ): Promise<CorporateActionDividendPolicyMaterial>;
}

/**
 * Reconcile one database-authoritative work snapshot. Core derives every
 * economic artifact; the repository only admits exact bytes under stream/head
 * CAS. Unsupported or missed evidence remains blocked and is never guessed.
 */
export async function reconcileCorporateActionWork(
  client: CorporateActionReconciliationClient,
  work: CorporateActionAccountWork,
  recordedBy: string,
  options: Readonly<{
    dividendPolicy?: CorporateActionDividendPolicyProvider;
    signal?: AbortSignal;
  }> = {},
): Promise<CorporateActionReconciliationResult> {
  if (recordedBy.trim() === "" || recordedBy !== recordedBy.trim()) {
    throw new TypeError("recordedBy must be a trimmed non-empty identity");
  }
  let preparedCount = 0n;
  let appliedCount = 0n;
  const blocked: Array<{
    strategyAccountId: string;
    sourceActionId: string;
    reason: string;
  }> = [];
  const signal = options.signal ?? new AbortController().signal;
  for (const item of work.items) {
    signal.throwIfAborted();
    if (item.phase === "MISSED_PREPARATION" || item.phase === "UNSUPPORTED") {
      blocked.push(blockedItem(item, item.phase));
      continue;
    }
    if (item.evidenceStatus !== "COMPLETE") {
      blocked.push(blockedItem(item, "INCOMPLETE_EVIDENCE"));
      continue;
    }
    if (item.phase === "PREPARE") {
      const committed = await prepareAccountAction(client, item, work.asOf, recordedBy);
      if (committed === false) {
        blocked.push(blockedItem(item, "UNRESOLVED_CORE_PREPARATION"));
      } else {
        preparedCount += 1n;
      }
      continue;
    }
    const committed = await applyAccountAction(
      client,
      item,
      work.asOf,
      recordedBy,
      options.dividendPolicy,
      signal,
    );
    if (committed === false) {
      blocked.push(blockedItem(item, "CASH_DIVIDEND_TAX_EVIDENCE_NOT_READY"));
    } else {
      appliedCount += 1n;
    }
  }
  return Object.freeze({
    prepared: preparedCount.toString(),
    applied: appliedCount.toString(),
    blocked: Object.freeze(blocked.map((entry) => Object.freeze(entry))),
  });
}

async function prepareAccountAction(
  client: CorporateActionReconciliationClient,
  item: CorporateActionAccountWorkItem,
  capturedAt: string,
  recordedBy: string,
): Promise<boolean> {
  const replay = reconstructArenaAccountState(item.replayMaterial);
  const position = replay.positions.find(
    (candidate) => candidate.instrumentId === item.instrumentId,
  ) ?? null;
  let material: Parameters<typeof createCorporateActionAccountPreparation>[0]["material"];
  if (item.interpretation === "SPLIT") {
    const application = applySplitCorporateAction({
      action: splitEvidence(item),
      position,
      effectiveAt: item.exDateOpenAt,
      appliedAt: capturedAt,
    });
    if (application.status === "UNRESOLVED") return false;
    material = Object.freeze({
      actionType: item.actionType as "FORWARD_SPLIT" | "REVERSE_SPLIT",
      application,
    });
  } else {
    material = Object.freeze({
      actionType: "CASH_DIVIDEND",
      entitlement: Object.freeze({
        schema: "twofold.cash_dividend_entitlement/v1",
        instrumentId: item.instrumentId,
        symbol: item.symbol,
        quantity: position?.quantity ?? "0",
        capturedAt,
        exDateOpenAt: item.exDateOpenAt,
        ledgerHeadSequence: item.replayMaterial.portfolio.ledgerHead.sequence,
        ledgerHeadSha256: item.replayMaterial.portfolio.ledgerHead.sha256,
      }),
    });
  }
  const preparation = createCorporateActionAccountPreparation({
    strategyAccountId: item.strategyAccountId,
    runId: item.runId,
    sourceActionId: item.sourceActionId,
    revisionSha256: item.revisionSha256,
    ledgerHead: {
      sequence: item.replayMaterial.portfolio.ledgerHead.sequence,
      sha256: item.replayMaterial.portfolio.ledgerHead.sha256,
    },
    material,
    capturedAt,
  });
  const preparationId = deterministicUuidV8(
    "twofold.corporate_action_account_preparation/v1",
    preparation.contentSha256,
  );
  await registerCorporateActionAccountPreparationExact(client, Object.freeze({
    p_idempotency_key:
      `corporate-action:prepare:${item.strategyAccountId}:${item.sourceActionId}`
      + `:${item.revisionSha256}`,
    p_preparation_id: preparationId,
    p_strategy_account_id: item.strategyAccountId,
    p_run_id: item.runId,
    p_source_action_id: item.sourceActionId,
    p_revision_sha256: item.revisionSha256,
    p_preparation_canonical_json: preparation.canonicalJson,
    p_content_sha256: preparation.contentSha256,
    p_captured_at: capturedAt,
    p_expected_run_stream_seq: item.replayMaterial.runStreamHead.sequence,
    p_event_id: deterministicUuidV8(
      "twofold.event.corporate_action_account_preparation/v1",
      preparationId,
    ),
    p_recorded_by: recordedBy,
  }), {
    ledgerHeadSequence: item.replayMaterial.portfolio.ledgerHead.sequence,
    ledgerHeadSha256: item.replayMaterial.portfolio.ledgerHead.sha256,
  });
  return true;
}

async function applyAccountAction(
  client: CorporateActionReconciliationClient,
  item: CorporateActionAccountWorkItem,
  recordedAt: string,
  recordedBy: string,
  dividendPolicy: CorporateActionDividendPolicyProvider | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (item.preparation === null || item.preparationId === null
    || item.preparationSha256 === null) {
    throw new TypeError("APPLY work has no exact preparation");
  }
  const preparation = exactRecord(item.preparation, "preparation");
  const capturedAt = requiredString(preparation.capturedAt, "preparation.capturedAt");
  const preparedMaterial = exactRecord(preparation.material, "preparation.material");
  const replay = reconstructArenaAccountState(item.replayMaterial);
  let rederived: CommittableCorporateActionApplication;
  let applicationRecordedAt = recordedAt;
  if (item.interpretation === "CASH_DIVIDEND") {
    if (dividendPolicy === undefined) return false;
    const policy = await dividendPolicy.load(item, signal);
    signal.throwIfAborted();
    if (policy.fx.visibleAt > applicationRecordedAt) {
      applicationRecordedAt = policy.fx.visibleAt;
    }
    const entitlement = exactRecord(
      preparedMaterial.entitlement,
      "preparation.material.entitlement",
    ) as unknown as CashDividendEntitlement;
    const dividend = applyCashDividendCorporateAction({
      action: {
        schema: "twofold.cash_dividend_corporate_action_evidence/v1",
        source: "ALPACA_CORPORATE_ACTIONS_V1",
        sourceActionId: item.sourceActionId,
        revisionSha256: item.revisionSha256,
        instrumentId: item.instrumentId,
        symbol: item.symbol,
        type: "CASH_DIVIDEND",
        status: "COMPLETE",
        ratePerShare: requiredPositiveDecimal(item.normalizedAction.rate, "rate"),
        currency: requiredCurrency(policy.currency, "currency"),
        exDate: item.exDate,
        recordDate: requiredDate(item.normalizedAction.recordDate, "recordDate"),
        payableDate: requiredDate(item.payableDate, "payableDate"),
        processDate: requiredDate(item.normalizedAction.processDate, "processDate"),
        foreign: requiredBoolean(item.normalizedAction.foreign, "foreign"),
        special: requiredBoolean(item.normalizedAction.special, "special"),
        observedAt: item.observedAt,
      },
      entitlement,
      taxPolicy: {
        schema: "twofold.cash_dividend_tax_policy/v1",
        rulesetId: "cn_resident_direct_foreign_securities_strict_v1",
        instrumentKind: policy.instrumentKind,
        issuerTaxResidenceCountry: policy.issuerTaxResidenceCountry,
        distributionClassification: policy.distributionClassification,
        foreignWithholdingRate: policy.foreignWithholdingRate,
        treatyOrLocalCapRate: policy.treatyOrLocalCapRate,
        foreignTaxCreditEvidenceStatus: policy.foreignTaxCreditEvidenceStatus,
        cashScale: "2",
        taxScale: "8",
        reserveScale: "12",
        fx: policy.fx,
      },
      appliedAt: applicationRecordedAt,
    });
    if (dividend.status === "UNRESOLVED") return false;
    rederived = dividend;
  } else {
    const storedApplication = preparedMaterial.application;
    const position = replay.positions.find(
      (candidate) => candidate.instrumentId === item.instrumentId,
    ) ?? null;
    const split = applySplitCorporateAction({
      action: splitEvidence(item),
      position,
      effectiveAt: item.exDateOpenAt,
      appliedAt: capturedAt,
    });
    if (split.status === "UNRESOLVED"
      || canonicalFinancialJson(split) !== canonicalFinancialJson(storedApplication)) {
      throw new TypeError("stored split preparation differs from Core re-derivation");
    }
    rederived = split;
  }
  const application = createCorporateActionAccountApplication({
    strategyAccountId: item.strategyAccountId,
    runId: item.runId,
    actionType: item.actionType,
    preparationSha256: item.preparationSha256,
    openingLedgerHead: {
      sequence: item.replayMaterial.portfolio.ledgerHead.sequence,
      sha256: item.replayMaterial.portfolio.ledgerHead.sha256,
    },
    priorPortfolio: {
      cashAssetBalance: item.replayMaterial.portfolio.cash.settled,
      taxReserveBalance: item.replayMaterial.portfolio.cash.taxReserve,
      positions: replay.positions,
      ledgerTransactions: replay.priorLedgerTransactions,
    },
    application: rederived,
    recordedAt: applicationRecordedAt,
  });
  const applicationId = deterministicUuidV8(
    "twofold.corporate_action_account_application/v1",
    application.contentSha256,
  );
  await commitCorporateActionAccountApplicationExact(client, Object.freeze({
    p_idempotency_key:
      `corporate-action:apply:${item.strategyAccountId}:${item.sourceActionId}`
      + `:${item.revisionSha256}`,
    p_application_id: applicationId,
    p_strategy_account_id: item.strategyAccountId,
    p_run_id: item.runId,
    p_source_action_id: item.sourceActionId,
    p_revision_sha256: item.revisionSha256,
    p_application_canonical_json: application.canonicalJson,
    p_content_sha256: application.contentSha256,
    p_applied_at: applicationRecordedAt,
    p_expected_run_stream_seq: item.replayMaterial.runStreamHead.sequence,
    p_event_id: deterministicUuidV8(
      "twofold.event.corporate_action_account_application/v1",
      applicationId,
    ),
    p_recorded_by: recordedBy,
  }), {
    preparationId: item.preparationId,
    openingHeadSequence: application.openingLedgerHead.sequence,
    openingHeadSha256: application.openingLedgerHead.sha256,
    finalHeadSequence: application.finalLedgerHead.sequence,
    finalHeadSha256: application.finalLedgerHead.sha256,
  });
  return true;
}

function splitEvidence(item: CorporateActionAccountWorkItem): SplitCorporateActionEvidence {
  if (item.actionType !== "FORWARD_SPLIT" && item.actionType !== "REVERSE_SPLIT") {
    throw new TypeError("split work has a non-split action type");
  }
  return Object.freeze({
    schema: "twofold.split_corporate_action_evidence/v1",
    source: "ALPACA_CORPORATE_ACTIONS_V1",
    sourceActionId: item.sourceActionId,
    revisionSha256: item.revisionSha256,
    instrumentId: item.instrumentId,
    symbol: item.symbol,
    type: item.actionType,
    status: "COMPLETE",
    oldRate: requiredInteger(item.normalizedAction.oldRate, "oldRate"),
    newRate: requiredInteger(item.normalizedAction.newRate, "newRate"),
    exDate: item.exDate,
    processDate: requiredDate(item.normalizedAction.processDate, "processDate"),
    observedAt: item.observedAt,
  });
}

function exactRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^[1-9][0-9]*$/.test(parsed)) throw new TypeError(`${field} must be positive`);
  return parsed;
}

function requiredDate(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
  return value;
}

function requiredPositiveDecimal(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(parsed) || parsed === "0") {
    throw new TypeError(`${field} must be a positive decimal`);
  }
  return parsed;
}

function requiredCurrency(value: unknown, field: string): string {
  const parsed = requiredString(value, field);
  if (!/^[A-Z]{3}$/.test(parsed)) throw new TypeError(`${field} must be ISO currency`);
  return parsed;
}

function blockedItem(item: CorporateActionAccountWorkItem, reason: string) {
  return {
    strategyAccountId: item.strategyAccountId,
    sourceActionId: item.sourceActionId,
    reason,
  };
}
