import { describe, expect, it, vi } from "vitest";

import {
  fetchAlpacaOpenReferences,
  loadAlpacaOpenReferenceConfig,
  type AlpacaOpenReferenceConfig,
} from "../src/alpaca-open-reference.js";

const config: AlpacaOpenReferenceConfig = {
  apiKeyId: "key-id",
  apiSecretKey: "secret-key",
  dataUrl: "https://data.alpaca.markets",
  symbols: ["LULU", "SPY"],
  feed: "sip",
  sourceVersionKey: "alpaca-sip-raw-1min-open-v1",
  liquiditySourceVersionKey: "alpaca-sip-raw-1min-vwap-volume-v2",
  sourceEffectiveFrom: "2026-08-23T00:00:00.000Z",
  licenseScope: "private-research",
};

const rawBody = JSON.stringify({
  bars: {
    LULU: [{
      t: "2026-08-31T13:30:00Z",
      o: 120.81,
      h: 121.12,
      l: 120.5,
      c: 121,
      v: 12345,
      n: 321,
      vw: 120.9,
    }],
    SPY: [{
      t: "2026-08-31T13:30:00Z",
      o: 650.123456789012345678,
      h: 651,
      l: 650,
      c: 650.5,
      v: 987654,
      n: 4321,
      vw: 650.4,
    }],
  },
  next_page_token: null,
});

describe("Alpaca first-minute open reference", () => {
  it("derives a SIP-only intraday source from server market configuration", () => {
    expect(loadAlpacaOpenReferenceConfig({
      ALPACA_API_KEY_ID: "key",
      ALPACA_API_SECRET_KEY: "secret",
      TWOFOLD_MARKET_SYMBOLS: "SPY,LULU",
      TWOFOLD_MARKET_FEED: "sip",
    })).toMatchObject({
      symbols: ["LULU", "SPY"],
      feed: "sip",
      sourceVersionKey: "alpaca-sip-raw-1min-open-v1",
      liquiditySourceVersionKey: "alpaca-sip-raw-1min-vwap-volume-v2",
    });
    expect(() => loadAlpacaOpenReferenceConfig({
      ALPACA_API_KEY_ID: "key",
      ALPACA_API_SECRET_KEY: "secret",
      TWOFOLD_MARKET_FEED: "iex",
    })).toThrow("require the Alpaca SIP feed");
  });

  it("captures one exact SIP reference per symbol only after availability", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(
        "https://data.alpaca.markets/v2/stocks/bars",
      );
      expect(url.searchParams.get("symbols")).toBe("LULU,SPY");
      expect(url.searchParams.get("timeframe")).toBe("1Min");
      expect(url.searchParams.get("start")).toBe("2026-08-31T13:30:00.000Z");
      expect(url.searchParams.get("end")).toBe("2026-08-31T13:31:00.000Z");
      expect(url.searchParams.get("feed")).toBe("sip");
      expect(new Headers(init?.headers).get("APCA-API-SECRET-KEY")).toBe(
        "secret-key",
      );
      return new Response(rawBody, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "request-open-1",
        },
      });
    }) as typeof fetch;

    const delivery = await fetchAlpacaOpenReferences(config, {
      sessionDate: "2026-08-31",
      expectedOpenAt: "2026-08-31T13:30:00.000Z",
      availableAt: "2026-08-31T13:32:00.000Z",
      fetchImplementation: fetchMock,
      now: () => new Date("2026-08-31T13:32:05.000Z"),
    });

    expect(delivery).toMatchObject({
      providerRequestId: "request-open-1",
      observedAt: "2026-08-31T13:32:05.000Z",
      sessionDate: "2026-08-31",
      expectedOpenAt: "2026-08-31T13:30:00.000Z",
      method: "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE",
    });
    expect(delivery.references).toEqual([
      expect.objectContaining({ symbol: "LULU", value: "120.81" }),
      expect.objectContaining({ symbol: "SPY" }),
    ]);
    expect(delivery.canonicalJson).not.toContain("secret-key");
    expect(delivery.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(delivery.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("preserves provider decimal tokens beyond JavaScript precision", async () => {
    const preciseBody = rawBody.replace(
      '"o":650.1234567890124',
      '"o":650.123456789012345678',
    );
    const delivery = await fetchAlpacaOpenReferences(config, {
      sessionDate: "2026-08-31",
      expectedOpenAt: "2026-08-31T13:30:00.000Z",
      availableAt: "2026-08-31T13:32:00.000Z",
      fetchImplementation: vi.fn(async () => new Response(preciseBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
      now: () => new Date("2026-08-31T13:32:05.000Z"),
    });

    expect(delivery.references.find((item) => item.symbol === "SPY")?.value)
      .toBe("650.123456789012345678");
  });

  it("freezes first-minute VWAP and whole-share volume for rulebook v2", async () => {
    const delivery = await fetchAlpacaOpenReferences(config, {
      method: "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
      sessionDate: "2026-08-31",
      expectedOpenAt: "2026-08-31T13:30:00.000Z",
      availableAt: "2026-08-31T13:32:00.000Z",
      fetchImplementation: vi.fn(async () => new Response(rawBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
      now: () => new Date("2026-08-31T13:32:05.000Z"),
    });

    expect(delivery).toMatchObject({
      schema: "twofold.alpaca_open_reference_delivery/v2",
      method: "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE",
      source: {
        versionKey: "alpaca-sip-raw-1min-vwap-volume-v2",
        normalizerVersion: "alpaca-first-minute-vwap-volume-reference-v2",
      },
      references: [
        { symbol: "LULU", value: "120.9", observedVolume: "12345" },
        { symbol: "SPY", value: "650.4", observedVolume: "987654" },
      ],
    });
    expect(delivery.canonicalJson).toContain('"observedVolume":"12345"');
  });

  it("fails before the frozen availability time or on wrong/missing bars", async () => {
    const response = (body: string) => vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const base = {
      sessionDate: "2026-08-31",
      expectedOpenAt: "2026-08-31T13:30:00.000Z",
      availableAt: "2026-08-31T13:32:00.000Z",
    } as const;

    await expect(fetchAlpacaOpenReferences(config, {
      ...base,
      fetchImplementation: response(rawBody),
      now: () => new Date("2026-08-31T13:31:59.999Z"),
    })).rejects.toThrow("before reference availability");

    await expect(fetchAlpacaOpenReferences(config, {
      ...base,
      fetchImplementation: response(rawBody.replace(
        "2026-08-31T13:30:00Z",
        "2026-08-31T13:31:00Z",
      )),
      now: () => new Date("2026-08-31T13:32:05.000Z"),
    })).rejects.toThrow("wrong first-minute bar");

    const missing = JSON.stringify({
      bars: { LULU: JSON.parse(rawBody).bars.LULU },
      next_page_token: null,
    });
    await expect(fetchAlpacaOpenReferences(config, {
      ...base,
      fetchImplementation: response(missing),
      now: () => new Date("2026-08-31T13:32:05.000Z"),
    })).rejects.toThrow("missing SPY");
  });
});

describe("Alpaca inclusive end boundary", () => {
  // Regression for the first real S1 open reference: Alpaca's `end` is
  // inclusive, so a one-minute window returns the opening bar and the one
  // after it. Requiring a single bar failed every symbol in the Round.
  const twoBarBody = (() => {
    const parsed = JSON.parse(rawBody) as {
      bars: Record<string, Array<Record<string, unknown>>>;
    };
    for (const symbol of Object.keys(parsed.bars)) {
      parsed.bars[symbol] = [
        parsed.bars[symbol]![0]!,
        { ...parsed.bars[symbol]![0]!, t: "2026-08-31T13:31:00Z", o: 999 },
      ];
    }
    return JSON.stringify(parsed);
  })();

  const response = (body: string) => vi.fn(async () => new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-open-two-bars",
    },
  })) as unknown as typeof fetch;

  it("selects the opening minute when the next minute is also returned", async () => {
    const delivery = await fetchAlpacaOpenReferences(config, {
      sessionDate: "2026-08-31",
      expectedOpenAt: "2026-08-31T13:30:00.000Z",
      availableAt: "2026-08-31T13:32:00.000Z",
      fetchImplementation: response(twoBarBody),
      now: () => new Date("2026-08-31T13:32:05.000Z"),
    });
    for (const reference of delivery.references) {
      expect(reference.barStart).toBe("2026-08-31T13:30:00.000Z");
    }
  });

  it("still rejects a genuinely duplicated opening bar", async () => {
    const parsed = JSON.parse(rawBody) as {
      bars: Record<string, Array<Record<string, unknown>>>;
    };
    const first = Object.keys(parsed.bars)[0]!;
    parsed.bars[first] = [parsed.bars[first]![0]!, parsed.bars[first]![0]!];
    await expect(fetchAlpacaOpenReferences(config, {
      sessionDate: "2026-08-31",
      expectedOpenAt: "2026-08-31T13:30:00.000Z",
      availableAt: "2026-08-31T13:32:00.000Z",
      fetchImplementation: response(JSON.stringify(parsed)),
      now: () => new Date("2026-08-31T13:32:05.000Z"),
    })).rejects.toThrow(/ambiguous/);
  });
});
