import { describe, expect, it, vi } from "vitest";
import { parse } from "lossless-json";

import {
  canonicalJsonNumber,
  fetchAlpacaDailyBars,
  loadAlpacaMarketDataConfig,
  type AlpacaMarketDataConfig,
} from "../src/market-data.js";

const config: AlpacaMarketDataConfig = {
  apiKeyId: "test-key-id",
  apiSecretKey: "test-secret-key",
  dataUrl: "https://data.alpaca.markets",
  symbols: ["LULU", "SPY"],
  feed: "sip",
  lookbackDays: 14,
  sourceVersionKey: "alpaca-sip-raw-1day-v1",
  sourceEffectiveFrom: "2026-08-23T00:00:00.000Z",
  licenseScope: "private-research",
};

const responseBody = JSON.stringify({
  bars: {
    LULU: [
      {
        t: "2026-08-21T04:00:00Z",
        o: 191.1,
        h: 196.2,
        l: 190.5,
        c: 195.3,
        v: 1234567,
        n: 23456,
        vw: 194.21,
      },
    ],
    SPY: [
      {
        t: "2026-08-21T04:00:00Z",
        o: 640.1,
        h: 644.2,
        l: 639.5,
        c: 643.3,
        v: 76543210,
        n: 345678,
        vw: 642.51,
      },
    ],
  },
  next_page_token: null,
});

describe("Alpaca real market-data adapter", () => {
  it("loads only explicit server-side credentials and normalizes the allowlist", () => {
    expect(loadAlpacaMarketDataConfig({
      ALPACA_API_KEY_ID: "key",
      ALPACA_API_SECRET_KEY: "secret",
      TWOFOLD_MARKET_SYMBOLS: "spy,lulu,SPY",
    })).toMatchObject({
      apiKeyId: "key",
      apiSecretKey: "secret",
      symbols: ["LULU", "SPY"],
      feed: "sip",
    });

    expect(() => loadAlpacaMarketDataConfig({})).toThrow(/API_KEY_ID/);
    expect(() => loadAlpacaMarketDataConfig({
      ALPACA_API_KEY_ID: "key",
      ALPACA_API_SECRET_KEY: "secret",
      ALPACA_DATA_URL: "https://attacker.example",
    })).toThrow(/trusted origin/);
  });

  it("preserves JSON decimal tokens without converting through JavaScript float", () => {
    expect(canonicalJsonNumber(parse("1.2300e2"), "value")).toBe("123");
    expect(canonicalJsonNumber(parse("1.234e-3"), "value")).toBe("0.001234");
    expect(canonicalJsonNumber(parse("900719925474099312345"), "value")).toBe(
      "900719925474099312345",
    );
    expect(() => canonicalJsonNumber(parse("-1"), "value")).toThrow(/non-negative/);
  });

  it("fetches SIP raw daily bars, records evidence, and never exposes credentials", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://data.alpaca.markets/v2/stocks/bars");
      expect(url.searchParams.get("symbols")).toBe("LULU,SPY");
      expect(url.searchParams.get("timeframe")).toBe("1Day");
      expect(url.searchParams.get("feed")).toBe("sip");
      expect(url.searchParams.get("adjustment")).toBe("raw");
      expect(new Headers(init?.headers).get("APCA-API-KEY-ID")).toBe("test-key-id");
      expect(new Headers(init?.headers).get("APCA-API-SECRET-KEY")).toBe(
        "test-secret-key",
      );
      expect(init?.redirect).toBe("error");
      return new Response(responseBody, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-request-id": "alpaca-request-1",
        },
      });
    }) as typeof fetch;
    const observedTimes = [
      new Date("2026-08-23T00:10:00.000Z"),
      new Date("2026-08-23T00:10:00.010Z"),
    ];

    const delivery = await fetchAlpacaDailyBars(config, {
      endAt: "2026-08-22T23:55:00Z",
      fetchImplementation: fetchMock,
      now: () => observedTimes.shift()!,
    });

    expect(delivery).toMatchObject({
      providerRequestId: "alpaca-request-1",
      httpStatus: 200,
      firstObservedAt: "2026-08-23T00:10:00.000Z",
      retrievedAt: "2026-08-23T00:10:00.010Z",
      availableAt: "2026-08-23T00:10:00.010Z",
      symbols: ["LULU", "SPY"],
      targetSessionDate: "2026-08-21",
      cutoffAt: "2026-08-23T00:10:00.010Z",
    });
    expect(delivery.facts).toHaveLength(2);
    expect(delivery.facts[0]).toMatchObject({
      symbol: "LULU",
      openPrice: "191.1",
      closePrice: "195.3",
      volume: "1234567",
      factSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(delivery.normalizedManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(delivery)).not.toContain("test-secret-key");
  });

  it("follows pagination and preserves every raw page in an auditable envelope", async () => {
    const pageOne = JSON.stringify({
      bars: { LULU: JSON.parse(responseBody).bars.LULU },
      next_page_token: "page-2",
    });
    const pageTwo = JSON.stringify({
      bars: { SPY: JSON.parse(responseBody).bars.SPY },
      next_page_token: null,
    });
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const body = url.searchParams.get("page_token") === "page-2" ? pageTwo : pageOne;
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": url.searchParams.has("page_token") ? "request-2" : "request-1",
        },
      });
    }) as typeof fetch;
    const observedTimes = [
      new Date("2026-08-23T00:10:00.000Z"),
      new Date("2026-08-23T00:10:00.020Z"),
    ];

    const delivery = await fetchAlpacaDailyBars(config, {
      endAt: "2026-08-22T23:55:00Z",
      fetchImplementation: fetchMock,
      now: () => observedTimes.shift()!,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delivery.facts).toHaveLength(2);
    const envelope = JSON.parse(delivery.rawBody) as {
      schema: string;
      pages: Array<{ body: string; bodySha256: string }>;
    };
    expect(envelope.schema).toBe("twofold.alpaca.paginated-response.v1");
    expect(envelope.pages.map((page) => page.body)).toEqual([pageOne, pageTwo]);
    expect(envelope.pages.every((page) => /^[0-9a-f]{64}$/.test(page.bodySha256))).toBe(true);
  });

  it("fails closed on missing symbols, an unfinished session, or provider errors", async () => {
    const response = (body: unknown, status = 200) => vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const times = () => new Date("2026-08-23T00:10:00Z");

    await expect(fetchAlpacaDailyBars(config, {
      endAt: "2026-08-22T23:55:00Z",
      fetchImplementation: response({ bars: { LULU: [] }, next_page_token: null }),
      now: times,
    })).rejects.toThrow(/missing required bars/);

    await expect(fetchAlpacaDailyBars(config, {
      endAt: "2026-08-21T19:00:00Z",
      targetSessionDate: "2026-08-21",
      fetchImplementation: response(JSON.parse(responseBody)),
      now: () => new Date("2026-08-21T19:01:00Z"),
    })).rejects.toThrow(/before 16:20 America\/New_York/);

    await expect(fetchAlpacaDailyBars(config, {
      endAt: "2026-08-22T23:55:00Z",
      fetchImplementation: response({ message: "unauthorized" }, 401),
      now: times,
    })).rejects.toThrow(/HTTP 401/);
  });
});
