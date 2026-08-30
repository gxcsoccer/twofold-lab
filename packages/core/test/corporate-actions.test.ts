import { describe, expect, it } from "vitest";

import {
  applyCashDividendCorporateAction,
  applySplitCorporateAction,
  createCorporateActionAccountApplication,
  createCorporateActionAccountPreparation,
  createOpeningLedgerTransactions,
  nonNegativeDecimal,
  replayLedger,
  sequence,
  validateInitialPortfolioSnapshot,
  type SplitCorporateActionPosition,
} from "../src/index.js";

const instrumentId = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
const revisionSha256 = "a".repeat(64);

function openingTransactions() {
  const snapshot = validateInitialPortfolioSnapshot({
    snapshotId: "opening-snapshot",
    schema: "twofold.initial_portfolio/v1",
    asOf: "2026-08-28T20:00:00.000Z",
    brokerLegalEntity: "FUTU_HK",
    accountRegion: "HK",
    baseCurrency: "USD",
    sourceArtifactSha256: "b".repeat(64),
    cashBalances: [],
    lots: [{
      lotId: "opening-lulu-lot",
      instrumentId,
      symbol: "LULU",
      acquiredOn: "2026-08-28",
      quantity: "150",
      purchasePricePerShare: "200",
      buyFees: "0",
      currency: "USD",
    }],
  });
  return createOpeningLedgerTransactions({
    runId: "run-1",
    sourceEventId: "opening-event",
    snapshot,
  });
}

function position(quantity = "150"): SplitCorporateActionPosition {
  return {
    instrumentId,
    symbol: "LULU",
    quantity,
    grossCost: "30000",
    lots: [{
      lotId: "opening-lulu-lot",
      instrumentId,
      acquisitionSequence: sequence("1"),
      quantity: nonNegativeDecimal(quantity),
      grossPurchasePrice: nonNegativeDecimal("30000"),
      buyFees: nonNegativeDecimal("0"),
    }],
    acquisitionFxBindings: [{
      lotId: "opening-lulu-lot",
      acquisitionTradeDate: "2026-08-28",
      acquisitionSettlementId: "opening-lulu-settlement",
      remainingGrossPurchasePriceCny: "214500",
      remainingBuyFeesCny: "0",
      evidence: {
        fxRateId: "opening-fx",
        factId: "opening-fx-fact",
        sourceVersionId: "opening-fx-version",
        sourceArtifactId: "opening-fx-artifact",
        sourceContentSha256: "c".repeat(64),
        baseCurrency: "USD",
        quoteCurrency: "CNY",
        cnyPerBaseUnit: "7.15",
        effectiveAt: "2026-08-28T00:00:00.000Z",
        visibleAt: "2026-08-28T00:00:00.000Z",
        status: "FINAL",
      },
    }],
  };
}

function action(type: "FORWARD_SPLIT" | "REVERSE_SPLIT", oldRate: string, newRate: string) {
  return {
    schema: "twofold.split_corporate_action_evidence/v1" as const,
    source: "ALPACA_CORPORATE_ACTIONS_V1" as const,
    sourceActionId: actionId,
    revisionSha256,
    instrumentId,
    symbol: "LULU",
    type,
    status: "COMPLETE" as const,
    oldRate,
    newRate,
    exDate: "2026-09-01",
    processDate: "2026-08-31",
    observedAt: "2026-08-31T12:00:00.000Z",
  };
}

describe("split corporate actions", () => {
  it("applies a forward split to the ledger, position, and every FIFO lot without changing cost", () => {
    const result = applySplitCorporateAction({
      action: action("FORWARD_SPLIT", "1", "10"),
      position: position(),
      effectiveAt: "2026-09-01T13:30:00.000Z",
      appliedAt: "2026-09-01T13:29:00.000Z",
    });

    expect(result.status).toBe("APPLIED");
    if (result.status !== "APPLIED") throw new Error("expected split application");
    expect(result.position).toMatchObject({
      quantity: "1500",
      grossCost: "30000",
      lots: [{ quantity: "1500", grossPurchasePrice: "30000", buyFees: "0" }],
    });
    expect(result.position.acquisitionFxBindings).toEqual(
      position().acquisitionFxBindings,
    );

    const before = replayLedger(openingTransactions());
    const after = replayLedger([...openingTransactions(), ...result.ledgerTransactions]);
    expect(after.balances).toEqual(before.balances);
    expect(after.positions).toContainEqual(expect.objectContaining({
      accountId: "securities.inventory",
      instrumentId,
      quantity: "1500",
    }));
  });

  it("applies an exact reverse split while preserving acquisition identity", () => {
    const result = applySplitCorporateAction({
      action: action("REVERSE_SPLIT", "10", "1"),
      position: position(),
      effectiveAt: "2026-09-01T13:30:00.000Z",
      appliedAt: "2026-09-01T13:29:00.000Z",
    });

    expect(result.status).toBe("APPLIED");
    if (result.status !== "APPLIED") throw new Error("expected split application");
    expect(result.position.quantity).toBe("15");
    expect(result.position.lots[0]).toMatchObject({
      lotId: "opening-lulu-lot",
      acquisitionSequence: "1",
      quantity: "15",
    });
  });

  it("fails closed when a reverse split needs cash-in-lieu for a fractional lot", () => {
    const result = applySplitCorporateAction({
      action: action("REVERSE_SPLIT", "10", "1"),
      position: position("151"),
      effectiveAt: "2026-09-01T13:30:00.000Z",
      appliedAt: "2026-09-01T13:29:00.000Z",
    });

    expect(result).toEqual({
      status: "UNRESOLVED",
      reason: "FRACTIONAL_SHARE_CASH_IN_LIEU_REQUIRED",
      sourceActionId: actionId,
      revisionSha256,
    });
  });

  it("rejects incomplete evidence, wrong ratio direction, and late application", () => {
    expect(() => applySplitCorporateAction({
      action: { ...action("FORWARD_SPLIT", "1", "10"), status: "INCOMPLETE" },
      position: position(),
      effectiveAt: "2026-09-01T13:30:00.000Z",
      appliedAt: "2026-09-01T13:29:00.000Z",
    })).toThrow(/complete/i);
    expect(() => applySplitCorporateAction({
      action: action("FORWARD_SPLIT", "10", "1"),
      position: position(),
      effectiveAt: "2026-09-01T13:30:00.000Z",
      appliedAt: "2026-09-01T13:29:00.000Z",
    })).toThrow(/ratio/i);
    expect(() => applySplitCorporateAction({
      action: action("FORWARD_SPLIT", "1", "10"),
      position: position(),
      effectiveAt: "2026-09-01T13:30:00.000Z",
      appliedAt: "2026-09-01T13:30:00.001Z",
    })).toThrow(/before the effective market open/i);
  });
});

describe("cash-dividend corporate actions", () => {
  const dividendAction = {
    schema: "twofold.cash_dividend_corporate_action_evidence/v1" as const,
    source: "ALPACA_CORPORATE_ACTIONS_V1" as const,
    sourceActionId: "33333333-3333-4333-8333-333333333333",
    revisionSha256: "d".repeat(64),
    instrumentId,
    symbol: "LULU",
    type: "CASH_DIVIDEND" as const,
    status: "COMPLETE" as const,
    ratePerShare: "0.2",
    currency: "USD",
    exDate: "2026-09-01",
    recordDate: "2026-09-01",
    payableDate: "2026-09-15",
    processDate: "2026-09-15",
    foreign: false,
    special: false,
    observedAt: "2026-09-15T12:00:00.000Z",
  };
  const entitlement = {
    schema: "twofold.cash_dividend_entitlement/v1" as const,
    instrumentId,
    symbol: "LULU",
    quantity: "150",
    capturedAt: "2026-08-31T20:00:00.000Z",
    exDateOpenAt: "2026-09-01T13:30:00.000Z",
    ledgerHeadSequence: "0",
    ledgerHeadSha256: "e".repeat(64),
  };
  const taxPolicy = {
    schema: "twofold.cash_dividend_tax_policy/v1" as const,
    rulesetId: "cn_resident_direct_foreign_securities_strict_v1" as const,
    instrumentKind: "common_stock" as const,
    issuerTaxResidenceCountry: "US",
    distributionClassification: "ordinary_dividend" as const,
    foreignWithholdingRate: "0.1",
    treatyOrLocalCapRate: "0.1",
    foreignTaxCreditEvidenceStatus: "CONFIRMED" as const,
    cashScale: "2",
    taxScale: "8",
    reserveScale: "12",
    fx: {
      fxRateId: "usd-cny-2026-09-15",
      sourceContentSha256: "f".repeat(64),
      baseCurrency: "USD",
      quoteCurrency: "CNY" as const,
      cnyPerBaseUnit: "7.2",
      effectiveAt: "2026-09-15T00:00:00.000Z",
      visibleAt: "2026-09-15T11:00:00.000Z",
      status: "FINAL" as const,
    },
  };

  it("credits net broker cash and locks the CNY dividend-tax reserve without changing shares", () => {
    const result = applyCashDividendCorporateAction({
      action: dividendAction,
      entitlement,
      taxPolicy,
      appliedAt: "2026-09-15T12:01:00.000Z",
    });

    expect(result.status).toBe("APPLIED");
    if (result.status !== "APPLIED") throw new Error("expected dividend application");
    expect(result).toMatchObject({
      grossDividend: "30",
      foreignWithholding: "3",
      netCash: "27",
      cashTransition: {
        settledCashDelta: "27",
        taxReserveDelta: "3",
        buyingPowerDelta: "24",
      },
      tax: {
        grossDividendCny: "216",
        actualForeignIncomeTaxCny: "21.6",
        chinaGrossDividendTaxCny: "43.2",
        allowedForeignTaxCreditCny: "21.6",
        chinaDividendTaxAccrualCny: "21.6",
      },
    });

    const before = replayLedger(openingTransactions());
    const after = replayLedger([...openingTransactions(), ...result.ledgerTransactions]);
    expect(after.positions).toEqual(before.positions);
    expect(after.balances).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "asset.cash", currency: "USD", amount: "27" }),
      expect.objectContaining({ accountId: "income.dividend", currency: "USD", amount: "30" }),
      expect.objectContaining({
        accountId: "expense.foreign_dividend_withholding",
        currency: "USD",
        amount: "3",
      }),
      expect.objectContaining({
        accountId: "liability.china_tax_accrual",
        currency: "CNY",
        amount: "21.6",
      }),
    ]));
  });

  it("records an explicit no-entitlement application for an account with zero ex-date shares", () => {
    expect(applyCashDividendCorporateAction({
      action: dividendAction,
      entitlement: { ...entitlement, quantity: "0" },
      taxPolicy,
      appliedAt: "2026-09-15T12:01:00.000Z",
    })).toMatchObject({
      status: "NO_ENTITLEMENT",
      sourceActionId: dividendAction.sourceActionId,
      revisionSha256: dividendAction.revisionSha256,
      appliedAt: "2026-09-15T12:01:00.000Z",
      entitlement: { quantity: "0" },
      ledgerTransactions: [],
    });
  });

  it("keeps the full China reserve locked while foreign-tax-credit evidence is pending", () => {
    const result = applyCashDividendCorporateAction({
      action: dividendAction,
      entitlement,
      taxPolicy: {
        ...taxPolicy,
        foreignTaxCreditEvidenceStatus: "EVIDENCE_PENDING",
      },
      appliedAt: "2026-09-15T12:01:00.000Z",
    });
    expect(result.status).toBe("APPLIED");
    if (result.status !== "APPLIED") throw new Error("expected dividend application");
    expect(result.tax.allowedForeignTaxCreditCny).toBe("0");
    expect(result.tax.chinaDividendTaxAccrualCny).toBe("43.2");
    expect(result.cashTransition).toEqual({
      settledCashDelta: "27",
      taxReserveDelta: "6",
      buyingPowerDelta: "21",
    });
  });

  it("fails closed before payable date or without tax-classification evidence", () => {
    expect(() => applyCashDividendCorporateAction({
      action: dividendAction,
      entitlement,
      taxPolicy,
      appliedAt: "2026-09-14T23:59:59.999Z",
    })).toThrow(/payable/i);
    expect(applyCashDividendCorporateAction({
      action: dividendAction,
      entitlement,
      taxPolicy: {
        ...taxPolicy,
        instrumentKind: "adr",
        issuerTaxResidenceCountry: undefined,
      },
      appliedAt: "2026-09-15T12:01:00.000Z",
    })).toEqual({
      status: "UNRESOLVED",
      reason: "ISSUER_TAX_RESIDENCE_REQUIRED",
      sourceActionId: dividendAction.sourceActionId,
      revisionSha256: dividendAction.revisionSha256,
    });
    expect(() => applyCashDividendCorporateAction({
      action: dividendAction,
      entitlement: {
        ...entitlement,
        capturedAt: "2026-09-01T13:30:00.000Z",
      },
      taxPolicy,
      appliedAt: "2026-09-15T12:01:00.000Z",
    })).toThrow(/before the ex-date open/i);
  });

  it("fails closed for special or provider-flagged foreign dividends", () => {
    expect(applyCashDividendCorporateAction({
      action: { ...dividendAction, special: true },
      entitlement,
      taxPolicy,
      appliedAt: "2026-09-15T12:01:00.000Z",
    })).toMatchObject({ status: "UNRESOLVED", reason: "SPECIAL_DIVIDEND_UNSUPPORTED" });
    expect(applyCashDividendCorporateAction({
      action: { ...dividendAction, foreign: true },
      entitlement,
      taxPolicy,
      appliedAt: "2026-09-15T12:01:00.000Z",
    })).toMatchObject({ status: "UNRESOLVED", reason: "FOREIGN_DIVIDEND_UNSUPPORTED" });
  });

  it("publishes one content-addressed account mutation and advances the ledger head once", () => {
    const dividend = applyCashDividendCorporateAction({
      action: dividendAction,
      entitlement,
      taxPolicy,
      appliedAt: "2026-09-15T12:01:00.000Z",
    });
    if (dividend.status !== "APPLIED") throw new Error("expected dividend application");

    const artifact = createCorporateActionAccountApplication({
      strategyAccountId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      actionType: "CASH_DIVIDEND",
      preparationSha256: "9".repeat(64),
      openingLedgerHead: { sequence: "0", sha256: "e".repeat(64) },
      priorPortfolio: {
        cashAssetBalance: "0",
        taxReserveBalance: "0",
        positions: [position()],
        ledgerTransactions: openingTransactions(),
      },
      application: dividend,
      recordedAt: "2026-09-15T12:01:01.000Z",
    });

    expect(artifact).toMatchObject({
      schema: "twofold.corporate_action_account_application/v1",
      actionType: "CASH_DIVIDEND",
      preparationSha256: "9".repeat(64),
      status: "APPLIED",
      openingLedgerHead: { sequence: "0", sha256: "e".repeat(64) },
      cash: { settled: "27", taxReserve: "3", buyingPower: "24" },
      finalLedgerHead: { sequence: "1" },
      positions: [{ symbol: "LULU", quantity: "150", grossCost: "30000" }],
      ledger: { transactionCount: "3" },
    });
    expect(artifact.mutationSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.finalLedgerHead.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(artifact.canonicalJson)).toEqual(
      JSON.parse(JSON.stringify({
        ...artifact,
        canonicalJson: undefined,
        contentSha256: undefined,
      })),
    );
  });

  it("records a no-entitlement evaluation without inventing an economic head advance", () => {
    const noEntitlement = applyCashDividendCorporateAction({
      action: dividendAction,
      entitlement: { ...entitlement, quantity: "0" },
      taxPolicy,
      appliedAt: "2026-09-15T12:01:00.000Z",
    });
    if (noEntitlement.status === "UNRESOLVED") {
      throw new Error("expected no-entitlement application");
    }
    const artifact = createCorporateActionAccountApplication({
      strategyAccountId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      actionType: "CASH_DIVIDEND",
      preparationSha256: "9".repeat(64),
      openingLedgerHead: { sequence: "0", sha256: "e".repeat(64) },
      priorPortfolio: {
        cashAssetBalance: "0",
        taxReserveBalance: "0",
        positions: [position()],
        ledgerTransactions: openingTransactions(),
      },
      application: noEntitlement,
      recordedAt: "2026-09-15T12:01:01.000Z",
    });
    expect(artifact.status).toBe("NO_ENTITLEMENT");
    expect(artifact.finalLedgerHead).toEqual(artifact.openingLedgerHead);
    expect(artifact.ledger.transactionCount).toBe("1");
  });
});

describe("split account application", () => {
  it("publishes post-split orderable units pre-open while preserving the exchange effective time", () => {
    const split = applySplitCorporateAction({
      action: action("FORWARD_SPLIT", "1", "10"),
      position: position(),
      effectiveAt: "2026-09-01T13:30:00.000Z",
      appliedAt: "2026-09-01T13:29:00.000Z",
    });
    if (split.status !== "APPLIED") throw new Error("expected split application");
    const input = {
      strategyAccountId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      actionType: "FORWARD_SPLIT" as const,
      preparationSha256: "9".repeat(64),
      openingLedgerHead: { sequence: "0", sha256: "e".repeat(64) },
      priorPortfolio: {
        cashAssetBalance: "0",
        taxReserveBalance: "0",
        positions: [position()],
        ledgerTransactions: openingTransactions(),
      },
      application: split,
      recordedAt: "2026-09-01T13:30:00.000Z",
    };
    const artifact = createCorporateActionAccountApplication(input);
    expect(artifact.positions[0]).toMatchObject({ quantity: "1500", grossCost: "30000" });
    expect(artifact.finalLedgerHead.sequence).toBe("1");
    const preOpenPublished = createCorporateActionAccountApplication({
      ...input,
      recordedAt: "2026-09-01T13:29:59.999Z",
    });
    expect(preOpenPublished.application.ledgerTransactions[0]?.eventTime)
      .toBe("2026-09-01T13:30:00.000Z");
  });

  it("freezes the prepared split against the exact pre-open ledger head", () => {
    const split = applySplitCorporateAction({
      action: action("FORWARD_SPLIT", "1", "10"),
      position: position(),
      effectiveAt: "2026-09-01T13:30:00.000Z",
      appliedAt: "2026-09-01T13:29:00.000Z",
    });
    if (split.status === "UNRESOLVED") throw new Error("expected split preparation");
    const prepared = createCorporateActionAccountPreparation({
      strategyAccountId: "44444444-4444-4444-8444-444444444444",
      runId: "55555555-5555-4555-8555-555555555555",
      sourceActionId: actionId,
      revisionSha256,
      ledgerHead: { sequence: "0", sha256: "e".repeat(64) },
      material: { actionType: "FORWARD_SPLIT", application: split },
      capturedAt: "2026-09-01T13:29:00.000Z",
    });
    expect(prepared).toMatchObject({
      schema: "twofold.corporate_action_account_preparation/v1",
      status: "PREPARED",
      ledgerHead: { sequence: "0", sha256: "e".repeat(64) },
    });
    expect(prepared.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
