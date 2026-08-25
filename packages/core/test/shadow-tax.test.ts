import { describe, expect, it } from "vitest";

import {
  decimal,
  nonNegativeDecimal,
  sequence,
} from "../src/decimal.js";
import {
  calculateCapitalGainsTaxViews,
  calculateDividendShadowTax,
  calculateFifoDisposition,
  lockShadowTaxReserve,
  type FifoDispositionInput,
  type RealizedDispositionGain,
  type ShadowTaxLot,
} from "../src/shadow-tax.js";

function lot(input: {
  lotId: string;
  sequence: string;
  quantity: string;
  grossPurchasePrice: string;
  buyFees?: string;
}): ShadowTaxLot {
  return {
    lotId: input.lotId,
    instrumentId: "LULU",
    acquisitionSequence: sequence(input.sequence),
    quantity: nonNegativeDecimal(input.quantity),
    grossPurchasePrice: nonNegativeDecimal(input.grossPurchasePrice),
    buyFees: nonNegativeDecimal(input.buyFees ?? "0"),
  };
}

function disposition(
  overrides: Partial<FifoDispositionInput> = {},
): FifoDispositionInput {
  return {
    dispositionId: "sale-1",
    instrumentId: "LULU",
    taxYear: "2026",
    sourceCountry: "US",
    quantity: nonNegativeDecimal("1"),
    grossProceeds: nonNegativeDecimal("200"),
    sellFees: nonNegativeDecimal("0"),
    availableLots: [
      lot({ lotId: "lot-1", sequence: "1", quantity: "1", grossPurchasePrice: "100" }),
    ],
    allocationScale: 8,
    ...overrides,
  };
}

describe("strict China-resident foreign-securities shadow tax", () => {
  it("does not turn a losing disposition into a tax asset", () => {
    const result = calculateFifoDisposition(disposition({
      grossProceeds: nonNegativeDecimal("100"),
      availableLots: [
        lot({ lotId: "loss", sequence: "1", quantity: "1", grossPurchasePrice: "200" }),
      ],
    }));

    expect(result).toMatchObject({
      realizedGain: "-100",
      taxableGain: "0",
      chinaCapitalGainsTax: "0",
      taxLossAssetCreated: "0",
    });
  });

  it("taxes each disposition independently while keeping annual netting separate", () => {
    const facts: RealizedDispositionGain[] = [
      {
        dispositionId: "loss-first",
        taxYear: "2026",
        sourceCountry: "US",
        realizedGain: decimal("-50"),
      },
      {
        dispositionId: "gain-second",
        taxYear: "2026",
        sourceCountry: "US",
        realizedGain: decimal("50"),
      },
    ];

    expect(calculateCapitalGainsTaxViews(facts)).toEqual({
      rulesetId: "cn_resident_direct_foreign_securities_strict_v1",
      strictTax: "10",
      annualNettingSensitivityTax: "0",
      annualNettingSensitivityBuckets: [
        {
          taxYear: "2026",
          sourceCountry: "US",
          netRealizedGain: "0",
          taxableGain: "0",
          sensitivityTax: "0",
        },
      ],
      taxLossAssetCreated: "0",
    });
  });

  it("does not carry a later-year loss back into an earlier tax year", () => {
    const result = calculateCapitalGainsTaxViews([
      {
        dispositionId: "2026-gain",
        taxYear: "2026",
        sourceCountry: "US",
        realizedGain: decimal("50"),
      },
      {
        dispositionId: "2027-loss",
        taxYear: "2027",
        sourceCountry: "US",
        realizedGain: decimal("-50"),
      },
    ]);

    expect(result.strictTax).toBe("10");
    expect(result.annualNettingSensitivityTax).toBe("10");
    expect(result.annualNettingSensitivityBuckets).toEqual([
      {
        taxYear: "2026",
        sourceCountry: "US",
        netRealizedGain: "50",
        taxableGain: "50",
        sensitivityTax: "10",
      },
      {
        taxYear: "2027",
        sourceCountry: "US",
        netRealizedGain: "-50",
        taxableGain: "0",
        sensitivityTax: "0",
      },
    ]);
  });

  it("aggregates profitable and losing FIFO lots before applying max(0, gain)", () => {
    const result = calculateFifoDisposition(disposition({
      quantity: nonNegativeDecimal("2"),
      grossProceeds: nonNegativeDecimal("200"),
      // Deliberately reverse input order: acquisitionSequence controls FIFO.
      availableLots: [
        lot({ lotId: "loss-lot", sequence: "2", quantity: "1", grossPurchasePrice: "140" }),
        lot({ lotId: "gain-lot", sequence: "1", quantity: "1", grossPurchasePrice: "50" }),
      ],
    }));

    expect(result.allocations.map((allocation) => allocation.lotId)).toEqual([
      "gain-lot",
      "loss-lot",
    ]);
    expect(result).toMatchObject({
      allocatedTaxBasis: "190",
      realizedGain: "10",
      taxableGain: "10",
      chinaCapitalGainsTax: "2",
      remainingLots: [],
    });
  });

  it("allocates partial-lot purchase cost and fees deterministically with basis conservation", () => {
    const result = calculateFifoDisposition(disposition({
      quantity: nonNegativeDecimal("1"),
      grossProceeds: nonNegativeDecimal("60"),
      sellFees: nonNegativeDecimal("1"),
      availableLots: [
        lot({
          lotId: "partial",
          sequence: "1",
          quantity: "3",
          grossPurchasePrice: "100",
          buyFees: "2",
        }),
      ],
      allocationScale: 2,
    }));

    expect(result.allocations[0]).toMatchObject({
      quantity: "1",
      allocatedPurchasePrice: "33.33",
      allocatedBuyFees: "0.67",
      allocatedTaxBasis: "34",
    });
    expect(result.remainingLots[0]).toMatchObject({
      quantity: "2",
      grossPurchasePrice: "66.67",
      buyFees: "1.33",
    });
    expect(result.realizedGain).toBe("25");
    expect(result.chinaCapitalGainsTax).toBe("5");
  });

  it("locks newly accrued sale tax before the S2 buying-power check", () => {
    const sale = calculateFifoDisposition(disposition());
    const lock = lockShadowTaxReserve({
      grossBuyingCash: nonNegativeDecimal("200"),
      existingTaxReserve: nonNegativeDecimal("0"),
      newlyLockedTax: sale.chinaCapitalGainsTax,
    });

    expect(lock).toEqual({
      grossBuyingCash: "200",
      preFeeBuyingPowerAfterLock: "180",
      taxReserveAfterLock: "20",
    });
  });

  it("subtracts both existing and newly locked tax from gross buying cash", () => {
    expect(lockShadowTaxReserve({
      grossBuyingCash: nonNegativeDecimal("100"),
      existingTaxReserve: nonNegativeDecimal("20"),
      newlyLockedTax: nonNegativeDecimal("10"),
    })).toEqual({
      grossBuyingCash: "100",
      preFeeBuyingPowerAfterLock: "70",
      taxReserveAfterLock: "30",
    });
  });

  it("keeps values beyond JavaScript's safe integer range exact", () => {
    const result = calculateFifoDisposition(disposition({
      grossProceeds: nonNegativeDecimal("900719925474099300.01"),
      availableLots: [
        lot({
          lotId: "large",
          sequence: "1",
          quantity: "1",
          grossPurchasePrice: "900719925474099299.99",
        }),
      ],
    }));

    expect(result.realizedGain).toBe("0.02");
    expect(result.chinaCapitalGainsTax).toBe("0.004");
  });

  it("fails closed when an order exceeds available FIFO quantity", () => {
    expect(() => calculateFifoDisposition(disposition({
      quantity: nonNegativeDecimal("2"),
    }))).toThrow(/Insufficient FIFO quantity/);
  });
});

describe("dividend shadow-tax fail-closed boundary", () => {
  const ordinaryUsDividend = {
    instrumentKind: "common_stock" as const,
    issuerTaxResidenceCountry: "US",
    distributionClassification: "ordinary_dividend" as const,
    fxRateId: "usd-cny-2026-08-24",
    grossDividend: nonNegativeDecimal("100"),
    actualForeignIncomeTax: nonNegativeDecimal("10"),
    treatyOrLocalCap: nonNegativeDecimal("10"),
    chinaCreditLimit: nonNegativeDecimal("20"),
  };

  it("releases confirmed foreign-tax credit but not evidence-pending credit", () => {
    const confirmed = calculateDividendShadowTax({
      ...ordinaryUsDividend,
      evidenceStatus: "CONFIRMED",
    });
    const pending = calculateDividendShadowTax({
      ...ordinaryUsDividend,
      evidenceStatus: "EVIDENCE_PENDING",
    });

    expect(confirmed).toMatchObject({
      status: "RESOLVED",
      chinaGrossDividendTax: "20",
      foreignTaxCreditCandidate: "10",
      allowedForeignTaxCredit: "10",
      chinaDividendTaxAccrual: "10",
      netDividendCash: "90",
      taxReservedDividendValue: "80",
    });
    expect(pending).toMatchObject({
      status: "RESOLVED",
      foreignTaxCreditCandidate: "10",
      allowedForeignTaxCredit: "0",
      chinaDividendTaxAccrual: "20",
      netDividendCash: "90",
      taxReservedDividendValue: "70",
    });
  });

  it("caps credit and reports excess foreign withholding as a refund receivable", () => {
    expect(calculateDividendShadowTax({
      ...ordinaryUsDividend,
      actualForeignIncomeTax: nonNegativeDecimal("30"),
      evidenceStatus: "CONFIRMED",
    })).toMatchObject({
      status: "RESOLVED",
      foreignTaxCreditCandidate: "10",
      foreignTaxRefundReceivable: "20",
      allowedForeignTaxCredit: "10",
    });
  });

  it("never infers ADR residence and rejects non-ordinary ETF distributions", () => {
    expect(calculateDividendShadowTax({
      instrumentKind: "adr",
      distributionClassification: "ordinary_dividend",
      fxRateId: ordinaryUsDividend.fxRateId,
      grossDividend: ordinaryUsDividend.grossDividend,
      actualForeignIncomeTax: ordinaryUsDividend.actualForeignIncomeTax,
      treatyOrLocalCap: ordinaryUsDividend.treatyOrLocalCap,
      chinaCreditLimit: ordinaryUsDividend.chinaCreditLimit,
      evidenceStatus: "CONFIRMED",
    })).toEqual({
      status: "TAX_UNRESOLVED",
      reason: "ISSUER_TAX_RESIDENCE_REQUIRED",
    });

    expect(calculateDividendShadowTax({
      ...ordinaryUsDividend,
      instrumentKind: "etf",
      distributionClassification: "return_of_capital",
      evidenceStatus: "CONFIRMED",
    })).toEqual({
      status: "TAX_UNRESOLVED",
      reason: "DISTRIBUTION_CLASSIFICATION_UNSUPPORTED",
    });
  });
});
