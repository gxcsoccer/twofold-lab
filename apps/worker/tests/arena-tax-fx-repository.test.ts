import { describe, expect, it, vi } from "vitest";

import {
  registerArenaRoundTaxFxExact,
  type ArenaTaxFxRpcClient,
} from "../src/arena-tax-fx-repository.js";
import type { EcbUsdCnyDelivery } from "../src/ecb-fx.js";

const delivery = {
  schema: "twofold.ecb_usd_cny_delivery/v1",
  sourceUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml",
  rawXml: "<xml/>",
  rawBodySha256: "1".repeat(64),
  observedAt: "2026-08-31T20:20:05.000Z",
  envelopeCanonicalJson: "{}",
  envelopeSha256: "2".repeat(64),
  objectPath: `competition-sources/ecb/${"2".repeat(64)}.json`,
  cross: {
    schema: "twofold.ecb_usd_cny_reference_cross/v1",
    effectiveDate: "2026-08-31",
    eurToUsd: "1.16",
    eurToCny: "7.82",
    cnyPerUsd: "6.741379310345",
    derivation: "EUR_CNY_DIV_EUR_USD_HALF_UP_12",
    authority: "ECB_REFERENCE_CROSS",
    observedAt: "2026-08-31T20:20:05.000Z",
    availableAt: "2026-08-31T20:20:05.000Z",
    status: "ESTIMATED",
  },
  crossCanonicalJson: "{\"cross\":\"exact\"}",
  crossSha256: "3".repeat(64),
} as const satisfies EcbUsdCnyDelivery;

const ids = {
  round: "a1000000-0000-4000-8000-000000000001",
  season: "a2000000-0000-4000-8000-000000000001",
  artifact: "a3000000-0000-4000-8000-000000000001",
  fx: "a4000000-0000-8000-8000-000000000001",
  fact: "a5000000-0000-8000-8000-000000000001",
} as const;

function result(overrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.arena_round_tax_fx_reference/v1",
    roundId: ids.round,
    seasonId: ids.season,
    stage: "S1_DISPOSITION",
    fxRateId: ids.fx,
    factId: ids.fact,
    sourceVersionId: "ecb-eurofxref-hist-90d-v1",
    sourceArtifactId: ids.artifact,
    sourceContentSha256: delivery.envelopeSha256,
    rawBodySha256: delivery.rawBodySha256,
    baseCurrency: "USD",
    quoteCurrency: "CNY",
    cnyPerBaseUnit: delivery.cross.cnyPerUsd,
    effectiveAt: "2026-08-31T00:00:00.000Z",
    visibleAt: delivery.observedAt,
    status: "ESTIMATED",
    authority: "ECB_REFERENCE_CROSS",
    crossSha256: delivery.crossSha256,
    boundBy: "worker-1",
    boundAt: "2026-08-31T20:20:06.000Z",
    ...overrides,
  };
}

describe("Arena Round tax-FX repository", () => {
  it("registers exact ECB cross evidence", async () => {
    const rpc: ArenaTaxFxRpcClient = {
      rpc: vi.fn(async () => ({ data: result(), error: null, status: 200 })),
    };
    const arguments_ = {
      p_idempotency_key: "round:1:s1-fx",
      p_round_id: ids.round,
      p_stage: "S1_DISPOSITION" as const,
      p_source_artifact_id: ids.artifact,
      p_source_artifact_sha256: delivery.envelopeSha256,
      p_raw_body_sha256: delivery.rawBodySha256,
      p_cross_canonical_json: delivery.crossCanonicalJson,
      p_cross_sha256: delivery.crossSha256,
      p_recorded_by: "worker-1",
    };
    await expect(registerArenaRoundTaxFxExact(rpc, arguments_, {
      seasonId: ids.season,
      delivery,
    })).resolves.toMatchObject({
      stage: "S1_DISPOSITION",
      cnyPerBaseUnit: delivery.cross.cnyPerUsd,
      status: "ESTIMATED",
    });
    expect(rpc.rpc).toHaveBeenCalledWith(
      "register_arena_round_tax_fx_reference",
      arguments_,
    );
  });

  it("rejects numeric drift at the exact boundary", async () => {
    const rpc: ArenaTaxFxRpcClient = {
      rpc: vi.fn(async () => ({
        data: result({ cnyPerBaseUnit: 6.74 }), error: null, status: 200,
      })),
    };
    await expect(registerArenaRoundTaxFxExact(rpc, {
      p_idempotency_key: "round:1:s1-fx",
      p_round_id: ids.round,
      p_stage: "S1_DISPOSITION",
      p_source_artifact_id: ids.artifact,
      p_source_artifact_sha256: delivery.envelopeSha256,
      p_raw_body_sha256: delivery.rawBodySha256,
      p_cross_canonical_json: delivery.crossCanonicalJson,
      p_cross_sha256: delivery.crossSha256,
      p_recorded_by: "worker-1",
    }, { seasonId: ids.season, delivery })).rejects.toThrow("numeric token");
  });
});
