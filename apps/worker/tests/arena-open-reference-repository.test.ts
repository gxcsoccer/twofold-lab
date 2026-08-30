import { describe, expect, it, vi } from "vitest";

import {
  registerArenaOpenReferenceExact,
  type ArenaOpenReferenceRpcClient,
} from "../src/arena-open-reference-repository.js";
import type { AlpacaOpenReferenceDelivery } from "../src/alpaca-open-reference.js";

const ids = {
  round: "a1000000-0000-4000-8000-000000000001",
  season: "a2000000-0000-4000-8000-000000000001",
  snapshot: "a3000000-0000-8000-8000-000000000001",
  source: "a4000000-0000-4000-8000-000000000001",
  artifact: "a5000000-0000-4000-8000-000000000001",
  fact: "a6000000-0000-8000-8000-000000000001",
} as const;

const delivery = {
  schema: "twofold.alpaca_open_reference_delivery/v1",
  method: "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE",
  source: {
    provider: "alpaca",
    dataset: "us_stock_intraday_open_references",
    versionKey: "alpaca-sip-raw-1min-open-v1",
    endpointBaseUrl: "https://data.alpaca.markets",
    feed: "sip",
    adjustment: "raw",
    timeframe: "1Min",
    normalizerVersion: "alpaca-first-minute-open-reference-v1",
    licenseScope: "private-research",
    configSha256: "1".repeat(64),
    effectiveFrom: "2026-08-23T00:00:00.000Z",
  },
  idempotencyKey: "alpaca-open:delivery",
  requestFingerprint: "2".repeat(64),
  providerRequestId: "request-1",
  observedAt: "2026-08-31T13:32:05.000Z",
  sessionDate: "2026-08-31",
  expectedOpenAt: "2026-08-31T13:30:00.000Z",
  rawBody: "{}",
  byteSize: 2,
  responseSha256: "3".repeat(64),
  objectPath: `raw/alpaca/33/${"3".repeat(64)}.json`,
  storageBucket: "twofold-private-artifacts",
  references: [{
    barStart: "2026-08-31T13:30:00.000Z",
    currency: "USD",
    factSha256: "4".repeat(64),
    symbol: "LULU",
    value: "120.81",
  }],
  canonicalJson: "{\"test\":\"canonical\"}",
  contentSha256: "5".repeat(64),
} as const satisfies AlpacaOpenReferenceDelivery;

const volumeDelivery = {
  ...delivery,
  schema: "twofold.alpaca_open_reference_delivery/v2",
  method: "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
  source: {
    ...delivery.source,
    versionKey: "alpaca-sip-raw-1min-vwap-volume-v2",
    normalizerVersion: "alpaca-first-minute-vwap-volume-reference-v2",
  },
  references: [{
    ...delivery.references[0],
    value: "120.82",
    observedVolume: "12345",
  }],
} as const satisfies AlpacaOpenReferenceDelivery;

function result(overrides: Record<string, unknown> = {}) {
  return {
    schema: "twofold.arena_round_open_reference/v1",
    roundId: ids.round,
    seasonId: ids.season,
    stage: "S1_OPEN_REFERENCE",
    referenceSnapshotId: ids.snapshot,
    sourceVersionId: ids.source,
    sourceArtifactId: ids.artifact,
    sourceContentSha256: delivery.responseSha256,
    requestFingerprint: delivery.requestFingerprint,
    method: delivery.method,
    sessionDate: delivery.sessionDate,
    expectedOpenAt: delivery.expectedOpenAt,
    observedAt: delivery.observedAt,
    contentSha256: delivery.contentSha256,
    references: [{
      factId: ids.fact,
      symbol: "LULU",
      barStart: delivery.expectedOpenAt,
      sessionDate: delivery.sessionDate,
      currency: "USD",
      value: "120.81",
      factSha256: "4".repeat(64),
    }],
    boundBy: "worker-1",
    boundAt: "2026-08-31T13:32:06.000Z",
    ...overrides,
  };
}

describe("Arena open-reference repository", () => {
  it("registers and verifies one shared exact reference set", async () => {
    const rpc: ArenaOpenReferenceRpcClient = {
      rpc: vi.fn(async () => ({ data: result(), error: null, status: 200 })),
    };
    const args = {
      p_idempotency_key: "round:1:s1-open",
      p_round_id: ids.round,
      p_stage: "S1_OPEN_REFERENCE" as const,
      p_source_version_id: ids.source,
      p_storage_bucket: delivery.storageBucket,
      p_object_path: delivery.objectPath,
      p_byte_size: delivery.byteSize,
      p_response_sha256: delivery.responseSha256,
      p_canonical_json: delivery.canonicalJson,
      p_recorded_by: "worker-1",
    };

    await expect(registerArenaOpenReferenceExact(rpc, args, {
      seasonId: ids.season,
      delivery,
    })).resolves.toMatchObject({
      referenceSnapshotId: ids.snapshot,
      stage: "S1_OPEN_REFERENCE",
      references: [{ symbol: "LULU", value: "120.81" }],
    });
    expect(rpc.rpc).toHaveBeenCalledWith(
      "register_arena_round_open_reference",
      args,
    );
  });

  it("keeps v2 VWAP and whole-share volume in the exact fact", async () => {
    const rpc: ArenaOpenReferenceRpcClient = {
      rpc: vi.fn(async () => ({
        data: result({
          schema: "twofold.arena_round_open_reference/v2",
          method: volumeDelivery.method,
          references: [{
            factId: ids.fact,
            symbol: "LULU",
            barStart: volumeDelivery.expectedOpenAt,
            sessionDate: volumeDelivery.sessionDate,
            currency: "USD",
            value: "120.82",
            observedVolume: "12345",
            factSha256: "4".repeat(64),
          }],
        }),
        error: null,
        status: 200,
      })),
    };
    const args = {
      p_idempotency_key: "round:1:s1-open-v2",
      p_round_id: ids.round,
      p_stage: "S1_OPEN_REFERENCE" as const,
      p_source_version_id: ids.source,
      p_storage_bucket: volumeDelivery.storageBucket,
      p_object_path: volumeDelivery.objectPath,
      p_byte_size: volumeDelivery.byteSize,
      p_response_sha256: volumeDelivery.responseSha256,
      p_canonical_json: volumeDelivery.canonicalJson,
      p_recorded_by: "worker-1",
    };

    await expect(registerArenaOpenReferenceExact(rpc, args, {
      seasonId: ids.season,
      delivery: volumeDelivery,
    })).resolves.toMatchObject({
      schema: "twofold.arena_round_open_reference/v2",
      method: "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
      references: [{
        symbol: "LULU",
        value: "120.82",
        observedVolume: "12345",
      }],
    });
  });

  it("rejects numeric tokens and content drift", async () => {
    const client = (data: unknown): ArenaOpenReferenceRpcClient => ({
      rpc: vi.fn(async () => ({ data, error: null, status: 200 })),
    });
    const args = {
      p_idempotency_key: "round:1:s1-open",
      p_round_id: ids.round,
      p_stage: "S1_OPEN_REFERENCE" as const,
      p_source_version_id: ids.source,
      p_storage_bucket: delivery.storageBucket,
      p_object_path: delivery.objectPath,
      p_byte_size: delivery.byteSize,
      p_response_sha256: delivery.responseSha256,
      p_canonical_json: delivery.canonicalJson,
      p_recorded_by: "worker-1",
    };
    await expect(registerArenaOpenReferenceExact(
      client(result({ references: [{ value: 120.81 }] })),
      args,
      { seasonId: ids.season, delivery },
    )).rejects.toThrow("numeric token");
    await expect(registerArenaOpenReferenceExact(
      client(result({ contentSha256: "9".repeat(64) })),
      args,
      { seasonId: ids.season, delivery },
    )).rejects.toThrow("inconsistent");
  });
});
