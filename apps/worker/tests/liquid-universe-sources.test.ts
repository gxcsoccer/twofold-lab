import { describe, expect, it, vi } from "vitest";

import {
  fetchAlpacaUniverseAssets,
  fetchAlpacaUniverseBars,
  fetchNasdaqStockCatalog,
  fetchNasdaqTradedDirectory,
} from "../src/liquid-universe-sources.js";

describe("Liquid universe source adapters", () => {
  it("normalizes only the Alpaca asset identity fields used by the freeze", async () => {
    const fetchImplementation = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("APCA-API-KEY-ID")).toBe("key");
      expect(new Headers(init?.headers).get("APCA-API-SECRET-KEY")).toBe("secret");
      return new Response(JSON.stringify([{
        id: "10000000-0000-4000-8000-000000000001",
        symbol: "AAPL",
        name: "Apple Inc. Common Stock",
        exchange: "NASDAQ",
        status: "active",
        tradable: true,
        margin_requirement_long: "30",
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchAlpacaUniverseAssets({
      apiKeyId: "key",
      apiSecretKey: "secret",
      fetchImplementation,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    expect(result.data).toEqual([{
      assetId: "10000000-0000-4000-8000-000000000001",
      symbol: "AAPL",
      name: "Apple Inc. Common Stock",
      exchange: "NASDAQ",
      status: "active",
      tradable: true,
    }]);
    expect(result.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("normalizes Nasdaq stock and ETF-directory evidence", async () => {
    const screener = await fetchNasdaqStockCatalog({
      fetchImplementation: vi.fn(async () => new Response(JSON.stringify({
        data: { rows: [{
          symbol: "AAPL",
          name: "Apple Inc. Common Stock",
          country: "United States",
          ipoyear: "1980",
          lastsale: "$232.14",
          volume: "12,345,678",
        }, {
          symbol: "BLANK",
          name: "Missing country",
          country: "",
          ipoyear: "2020",
          lastsale: "$10",
          volume: "100",
        }] },
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    expect(screener.data).toEqual([{
      symbol: "AAPL",
      name: "Apple Inc. Common Stock",
      country: "United States",
      ipoYear: "1980",
      latestPrice: "232.14",
      latestVolume: "12345678",
    }]);

    const directory = await fetchNasdaqTradedDirectory({
      fetchImplementation: vi.fn(async () => new Response([
        "Nasdaq Traded|Symbol|Security Name|Listing Exchange|Market Category|ETF|Round Lot Size|Test Issue|Financial Status|CQS Symbol|NASDAQ Symbol|NextShares",
        "Y|AAPL|Apple Inc. Common Stock|Q|Q|N|100|N|N||AAPL|N",
        "Y|SPY|SPDR S&P 500 ETF|P||Y|100|N||SPY|SPY|N",
        "File Creation Time: 0830202621:32|||||||||||",
      ].join("\r\n"), { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    expect(directory.data).toEqual([{
      symbol: "AAPL", nasdaqTraded: true, etf: false, testIssue: false,
    }, {
      symbol: "SPY", nasdaqTraded: true, etf: true, testIssue: false,
    }]);
  });

  it("follows Alpaca pagination and keeps exact decimal bars through the cutoff", async () => {
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("symbols")).toBe("AAPL,MSFT");
      expect(url.searchParams.get("adjustment")).toBe("raw");
      const pageTwo = url.searchParams.get("page_token") === "next";
      return new Response(JSON.stringify(pageTwo ? {
        bars: { MSFT: [{ t: "2026-08-28T04:00:00Z", c: 500.125, v: 2000000 }] },
        next_page_token: null,
      } : {
        bars: { AAPL: [{ t: "2026-08-28T04:00:00Z", c: 232.14, v: 12345678 }] },
        next_page_token: "next",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const result = await fetchAlpacaUniverseBars({
      apiKeyId: "key",
      apiSecretKey: "secret",
      symbols: ["AAPL", "MSFT"],
      startDate: "2026-01-01",
      endDate: "2026-08-28",
      fetchImplementation,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(result.data).toEqual([{
      symbol: "AAPL", barDate: "2026-08-28", closePrice: "232.14", volume: "12345678",
    }, {
      symbol: "MSFT", barDate: "2026-08-28", closePrice: "500.125", volume: "2000000",
    }]);
    expect(JSON.parse(result.rawBody)).toMatchObject({
      schema: "twofold.alpaca_universe_bars_pages/v1",
      pages: [{}, {}],
    });
  });

  it("fails closed on repeated pages, duplicate bars, and untrusted origins", async () => {
    const page = (body: unknown) => vi.fn(async () => new Response(
      JSON.stringify(body),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    const base = {
      apiKeyId: "key",
      apiSecretKey: "secret",
      symbols: ["AAPL"],
      startDate: "2026-01-01",
      endDate: "2026-08-28",
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    } as const;
    await expect(fetchAlpacaUniverseBars({
      ...base,
      fetchImplementation: page({ bars: {}, next_page_token: "same" }),
    })).rejects.toThrow(/repeated/);
    await expect(fetchAlpacaUniverseBars({
      ...base,
      fetchImplementation: page({
        bars: { AAPL: [
          { t: "2026-08-28T04:00:00Z", c: 1, v: 1 },
          { t: "2026-08-28T04:00:00Z", c: 1, v: 1 },
        ] },
        next_page_token: null,
      }),
    })).rejects.toThrow(/duplicate/);
    await expect(fetchAlpacaUniverseBars({
      ...base,
      dataUrl: "https://attacker.example",
      fetchImplementation: page({}),
    })).rejects.toThrow(/trusted origin/);
  });
});
