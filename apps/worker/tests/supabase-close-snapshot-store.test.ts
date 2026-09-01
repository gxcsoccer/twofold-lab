import { describe, expect, it } from "vitest";

import {
  parseFrozenMarketSource,
  type SourceVersionRow,
} from "../src/supabase-close-snapshot-store.js";

const row: SourceVersionRow = {
  source_version_id: "ab7260c1-86c9-4acf-a05e-9b28e8414f17",
  provider: "alpaca",
  dataset: "us_stock_daily_bars",
  version_key: "alpaca-sip-raw-1day-liquid100-v1",
  endpoint_base_url: "https://data.alpaca.markets",
  feed: "sip",
  adjustment: "raw",
  timeframe: "1Day",
  normalizer_version: "alpaca-bars-v1",
  license_scope: "private-research",
  config_sha256: "e".repeat(64),
  effective_from: "2026-08-28T00:00:00+00:00",
};

describe("Round frozen market source", () => {
  it("parses the registered route and normalizes the effective instant", () => {
    expect(parseFrozenMarketSource(row)).toEqual({
      sourceVersionId: "ab7260c1-86c9-4acf-a05e-9b28e8414f17",
      provider: "alpaca",
      dataset: "us_stock_daily_bars",
      versionKey: "alpaca-sip-raw-1day-liquid100-v1",
      endpointBaseUrl: "https://data.alpaca.markets",
      feed: "sip",
      adjustment: "raw",
      timeframe: "1Day",
      normalizerVersion: "alpaca-bars-v1",
      licenseScope: "private-research",
      configSha256: "e".repeat(64),
      effectiveFrom: "2026-08-28T00:00:00.000Z",
    });
  });

  it("refuses an endpoint outside the trusted provider origin", () => {
    expect(() => parseFrozenMarketSource({
      ...row,
      endpoint_base_url: "https://data.alpaca.markets.example.com",
    })).toThrow(/endpoint_base_url must use the trusted origin/);
  });

  it("names the Round source version when a stored field is unusable", () => {
    expect(() => parseFrozenMarketSource({ ...row, effective_from: "not-a-date" }))
      .toThrow(
        `Round source version ${row.source_version_id as string} effective_from`
        + " must be a timestamp",
      );
    expect(() => parseFrozenMarketSource({ ...row, config_sha256: "abc" }))
      .toThrow(/config_sha256 must be SHA-256/);
  });

  it("refuses a missing source version identity before it reaches a query", () => {
    expect(() => parseFrozenMarketSource({ ...row, source_version_id: null }))
      .toThrow(/source_version_id must be a non-empty trimmed string/);
  });

  it("refuses a route the close fence would never admit", () => {
    expect(() => parseFrozenMarketSource({ ...row, timeframe: "1Min" }))
      .toThrow(/is not the Alpaca SIP daily-bars route/);
    // The fence compares the feed, so an IEX Round has to fail before a
    // snapshot is sealed rather than at registration.
    expect(() => parseFrozenMarketSource({ ...row, feed: "iex" }))
      .toThrow(/is not the Alpaca SIP daily-bars route/);
  });
});
