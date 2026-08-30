import { describe, expect, it, vi } from "vitest";

import {
  registerCorporateActionScanExact,
  type RegisterCorporateActionScanArguments,
} from "../src/corporate-action-repository.js";
import type { AlpacaCorporateActionScan } from "../src/alpaca-corporate-actions.js";

const scan = {
  schema: "twofold.alpaca_corporate_action_scan/v1",
  source: {
    provider: "alpaca",
    dataset: "us_corporate_actions",
    versionKey: "alpaca-corporate-actions-v1",
    endpointBaseUrl: "https://data.alpaca.markets",
    feed: "none",
    adjustment: "raw",
    timeframe: "Event",
    normalizerVersion: "alpaca-corporate-actions-v1",
    licenseScope: "private-research",
    configSha256: "1".repeat(64),
    effectiveFrom: "2026-08-01T00:00:00.000Z",
  },
  processDateStart: "2026-08-01",
  processDateEnd: "2026-09-30",
  observedAt: "2026-08-29T12:00:00.000Z",
  requestFingerprint: "2".repeat(64),
  pages: [{
    pageIndex: "0",
    requestUrl: "https://data.alpaca.markets/v1/corporate-actions?symbols=LULU",
    rawBody: "{}",
    byteSize: "2",
    responseSha256: "3".repeat(64),
    objectPath: `raw/alpaca/${"3".repeat(2)}/${"3".repeat(64)}.json`,
    storageBucket: "twofold-private-artifacts",
  }],
  actions: [{
    schema: "twofold.alpaca_corporate_action_revision/v1",
    source: "ALPACA_CORPORATE_ACTIONS_V1",
    sourceActionId: "22222222-2222-4222-8222-222222222222",
    revisionSha256: "4".repeat(64),
    type: "FORWARD_SPLIT",
    symbol: "LULU",
    status: "COMPLETE",
    interpretation: "SPLIT",
    processDate: "2026-08-29",
    exDate: "2026-09-01",
    recordDate: "2026-08-31",
    payableDate: "2026-09-01",
    rawCanonicalJson:
      '{"ex_date":"2026-09-01","id":"22222222-2222-4222-8222-222222222222","new_rate":"2","old_rate":"1","process_date":"2026-08-29","symbol":"LULU"}',
    oldRate: "1",
    newRate: "2",
  }],
  canonicalJson: "{\"schema\":\"twofold.alpaca_corporate_action_scan/v1\"}",
  contentSha256: "5".repeat(64),
} as const satisfies AlpacaCorporateActionScan;

const arguments_: RegisterCorporateActionScanArguments = {
  p_idempotency_key: `corporate-action-scan:${scan.contentSha256}`,
  p_source_version_id: "11111111-1111-4111-8111-111111111111",
  p_request_fingerprint: scan.requestFingerprint,
  p_process_date_start: scan.processDateStart,
  p_process_date_end: scan.processDateEnd,
  p_observed_at: scan.observedAt,
  p_canonical_json: scan.canonicalJson,
  p_content_sha256: scan.contentSha256,
  p_pages: scan.pages.map((page) => ({
    pageIndex: page.pageIndex,
    providerRequestId: null,
    storageBucket: page.storageBucket,
    objectPath: page.objectPath,
    byteSize: page.byteSize,
    responseSha256: page.responseSha256,
  })),
  p_actions: scan.actions,
  p_recorded_by: "worker-1",
};

const result = {
  schema: "twofold.corporate_action_scan_commit_result/v1",
  scanId: "33333333-3333-4333-8333-333333333333",
  sourceVersionId: arguments_.p_source_version_id,
  requestFingerprint: scan.requestFingerprint,
  processDateStart: scan.processDateStart,
  processDateEnd: scan.processDateEnd,
  observedAt: scan.observedAt,
  contentSha256: scan.contentSha256,
  pageCount: "1",
  actionCount: "1",
  recordedBy: "worker-1",
  recordedAt: "2026-08-29T12:00:01.000Z",
};

describe("corporate-action scan repository", () => {
  it("retries an ambiguous RPC once and verifies the exact commit identity", async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ data: result, error: null });

    await expect(registerCorporateActionScanExact(
      { rpc },
      arguments_,
      scan,
    )).resolves.toEqual(result);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith(
      "register_corporate_action_scan",
      arguments_,
    );
  });

  it("rejects a success response that does not match the submitted bytes", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ...result, contentSha256: "f".repeat(64) },
      error: null,
    });
    await expect(registerCorporateActionScanExact(
      { rpc },
      arguments_,
      scan,
    )).rejects.toThrow(/inconsistent/i);
  });

  it("refuses JSON numeric tokens at the persistence boundary", async () => {
    const rpc = vi.fn();
    await expect(registerCorporateActionScanExact(
      { rpc },
      { ...arguments_, p_pages: [{ ...arguments_.p_pages[0]!, byteSize: 2 as never }] },
      scan,
    )).rejects.toThrow(/numeric token/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});
