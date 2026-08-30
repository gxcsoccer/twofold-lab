import { describe, expect, it, vi } from "vitest";

import {
  getCorporateActionDividendFxReference,
  getCorporateActionDividendPolicyMaterial,
  registerCorporateActionDividendFxExact,
} from "../src/corporate-action-dividend-policy-repository.js";
import { fetchEcbUsdCnyReferenceCross } from "../src/ecb-fx.js";

const ids = {
  season: "11111111-1111-4111-8111-111111111111",
  action: "22222222-2222-4222-8222-222222222222",
  instrument: "33333333-3333-4333-8333-333333333333",
  fx: "44444444-4444-4444-8444-444444444444",
  fact: "55555555-5555-4555-8555-555555555555",
  artifact: "66666666-6666-4666-8666-666666666666",
} as const;
const revision = "a".repeat(64);

function fxRow() {
  return {
    schema: "twofold.corporate_action_dividend_fx_reference/v1",
    seasonId: ids.season,
    sourceActionId: ids.action,
    revisionSha256: revision,
    fxRateId: ids.fx,
    factId: ids.fact,
    sourceVersionId: "ecb-eurofxref-hist-90d-v1",
    sourceArtifactId: ids.artifact,
    sourceContentSha256: "b".repeat(64),
    rawBodySha256: "c".repeat(64),
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    cnyPerBaseUnit: "7.142857142857",
    effectiveAt: "2026-09-04T00:00:00.000Z",
    visibleAt: "2026-09-05T13:31:00.000Z",
    status: "FINAL",
    sourceStatus: "ESTIMATED",
    authority: "ECB_REFERENCE_CROSS",
    crossSha256: "d".repeat(64),
    boundBy: "worker:test",
    boundAt: "2026-09-05T13:31:01.000Z",
  };
}

describe("cash-dividend policy repository", () => {
  it("parses exact database-owned instrument and treaty material", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        schema: "twofold.corporate_action_dividend_policy_material/v1",
        seasonId: ids.season,
        sourceActionId: ids.action,
        revisionSha256: revision,
        instrumentId: ids.instrument,
        currency: "USD",
        instrumentKind: "common_stock",
        issuerTaxResidenceCountry: "US",
        distributionClassification: "ordinary_dividend",
        foreignWithholdingRate: "0.1",
        treatyOrLocalCapRate: "0.1",
        foreignTaxCreditEvidenceStatus: "EVIDENCE_PENDING",
      },
      error: null,
      status: 200,
    }));
    await expect(getCorporateActionDividendPolicyMaterial({ rpc }, {
      seasonId: ids.season,
      sourceActionId: ids.action,
      revisionSha256: revision,
      instrumentId: ids.instrument,
    })).resolves.toMatchObject({
      currency: "USD",
      instrumentKind: "common_stock",
      issuerTaxResidenceCountry: "US",
      foreignWithholdingRate: "0.1",
    });
  });

  it("rejects numeric JSON tokens in the shared FX envelope", async () => {
    const rpc = vi.fn(async () => ({
      data: { ...fxRow(), cnyPerBaseUnit: 7.14 },
      error: null,
      status: 200,
    }));
    await expect(getCorporateActionDividendFxReference({ rpc }, {
      seasonId: ids.season,
      sourceActionId: ids.action,
      revisionSha256: revision,
    })).rejects.toThrow("numeric token");
  });

  it("binds registration arguments to the exact captured ECB bytes", async () => {
    const xml = `<Cube><Cube time="2026-09-04">`
      + `<Cube currency="USD" rate="1.2"/>`
      + `<Cube currency="CNY" rate="8.5714285714284"/>`
      + `</Cube></Cube>`;
    const delivery = await fetchEcbUsdCnyReferenceCross(
      { sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml" },
      {
        effectiveDate: "2026-09-05",
        allowPreviousDate: true,
        now: () => new Date("2026-09-05T13:31:00.000Z"),
        fetchImplementation: vi.fn(async () => {
          const response = new Response(xml, {
            status: 200,
            headers: { "content-type": "application/xml" },
          });
          Object.defineProperty(response, "url", {
            value: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
          });
          return response;
        }) as unknown as typeof fetch,
      },
    );
    const row = {
      ...fxRow(),
      sourceContentSha256: delivery.envelopeSha256,
      rawBodySha256: delivery.rawBodySha256,
      cnyPerBaseUnit: delivery.cross.cnyPerUsd,
      crossSha256: delivery.crossSha256,
    };
    const rpc = vi.fn(async () => ({ data: row, error: null, status: 200 }));
    await expect(registerCorporateActionDividendFxExact({ rpc }, {
      p_idempotency_key: "dividend-fx:test",
      p_season_id: ids.season,
      p_source_action_id: ids.action,
      p_revision_sha256: revision,
      p_source_artifact_id: ids.artifact,
      p_source_artifact_sha256: delivery.envelopeSha256,
      p_raw_body_sha256: delivery.rawBodySha256,
      p_cross_canonical_json: delivery.crossCanonicalJson,
      p_cross_sha256: delivery.crossSha256,
      p_recorded_by: "worker:test",
    }, delivery)).resolves.toMatchObject({ fxRateId: ids.fx });

    await expect(registerCorporateActionDividendFxExact({ rpc }, {
      p_idempotency_key: "dividend-fx:test",
      p_season_id: ids.season,
      p_source_action_id: ids.action,
      p_revision_sha256: revision,
      p_source_artifact_id: ids.artifact,
      p_source_artifact_sha256: delivery.envelopeSha256,
      p_raw_body_sha256: delivery.rawBodySha256,
      p_cross_canonical_json: delivery.crossCanonicalJson,
      p_cross_sha256: "e".repeat(64),
      p_recorded_by: "worker:test",
    }, delivery)).rejects.toThrow("does not match captured ECB bytes");
  });
});
