import { describe, expect, it } from "vitest";

import {
  buildLiquidUniverseFreeze,
  prefilterLiquidUniverseCandidates,
  type LiquidUniverseAsset,
  type LiquidUniverseBar,
  type LiquidUniversePolicy,
  type NasdaqStockCatalogEntry,
  type NasdaqTradedSecurity,
} from "../src/liquid-universe.js";

const policy = Object.freeze({
  name: "US Liquid 100",
  size: "100",
  minimumPriceUsd: "5",
  minimumMedianDollarVolumeUsd: "20000000",
  medianDollarVolumeSessions: "20",
  minimumHistorySessions: "120",
  allowedExchanges: ["AMEX", "NASDAQ", "NYSE"],
  mandatorySymbols: ["ZZZ"],
  constraints: {
    minimumPositions: "5",
    maximumPositions: "10",
    maximumPositionWeightBps: "2000",
    minimumCashWeightBps: "500",
  },
} as const satisfies LiquidUniversePolicy);

function uuid(index: number): string {
  return `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function symbols(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `S${index.toString().padStart(3, "0")}`);
}

function assets(values: readonly string[]): LiquidUniverseAsset[] {
  return values.map((symbol, index) => ({
    assetId: uuid(index + 1),
    symbol,
    name: `${symbol} Corporation Common Stock`,
    exchange: "NASDAQ",
    status: "active",
    tradable: true,
  }));
}

function stocks(values: readonly string[]): NasdaqStockCatalogEntry[] {
  return values.map((symbol, index) => ({
    symbol,
    name: `${symbol} Corporation Common Stock`,
    country: "United States",
    ipoYear: "2000",
    latestPrice: String(100 + index),
    latestVolume: String(1_000_000 + index),
  }));
}

function directory(values: readonly string[]): NasdaqTradedSecurity[] {
  return values.map((symbol) => ({
    symbol,
    nasdaqTraded: true,
    etf: false,
    testIssue: false,
  }));
}

function history(
  values: readonly string[],
  rank: Readonly<Record<string, number>> = {},
): LiquidUniverseBar[] {
  return values.flatMap((symbol, symbolIndex) => {
    const liquidity = rank[symbol] ?? values.length - symbolIndex;
    return Array.from({ length: 120 }, (_, sessionIndex) => {
      const date = new Date("2026-03-02T00:00:00.000Z");
      date.setUTCDate(date.getUTCDate() + sessionIndex);
      return {
        symbol,
        barDate: date.toISOString().slice(0, 10),
        closePrice: String(100 + sessionIndex),
        volume: String(1_000_000 + liquidity * 10_000),
      };
    });
  });
}

const sources = Object.freeze({
  observedAt: "2026-08-30T00:00:00.000Z",
  alpacaAssets: {
    url: "https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity",
    responseSha256: "1".repeat(64),
  },
  nasdaqStockScreener: {
    url: "https://api.nasdaq.com/api/screener/stocks",
    responseSha256: "2".repeat(64),
  },
  nasdaqTradedDirectory: {
    url: "https://www.nasdaqtrader.com/dynamic/symdir/nasdaqtraded.txt",
    responseSha256: "3".repeat(64),
  },
  alpacaDailyBars: {
    url: "https://data.alpaca.markets/v2/stocks/bars",
    responseSha256: "4".repeat(64),
  },
});

describe("US Liquid 100 freeze", () => {
  it("prefilters a bounded discovery set without special-casing holdings", () => {
    const all = [...symbols(5), "ZZZ", "ETF"];
    const result = prefilterLiquidUniverseCandidates({
      asOfSessionDate: "2026-06-29",
      limit: "3",
      policy: {
        ...policy,
        size: "2",
        constraints: {
          ...policy.constraints,
          minimumPositions: "1",
          maximumPositions: "2",
        },
      },
      assets: assets(all),
      stockCatalog: stocks(all),
      tradedDirectory: directory(all).map((entry) =>
        entry.symbol === "ETF" ? { ...entry, etf: true } : entry),
    });

    expect(result).toHaveLength(3);
    expect(result).toContain("ZZZ");
    expect(result).not.toContain("ETF");
  });

  it("selects exactly 100 eligible names by 20-session median dollar volume", () => {
    const liquid = symbols(101);
    const all = [...liquid, "ZZZ"];
    const result = buildLiquidUniverseFreeze({
      asOfSessionDate: "2026-06-29",
      policy,
      sources,
      assets: assets(all),
      stockCatalog: stocks(all),
      tradedDirectory: directory(all),
      bars: history(all, { ZZZ: 1 }),
      instrumentIdOverrides: {
        ZZZ: "122dd8f9-709a-5652-a27c-a3b5c32755de",
      },
    });

    expect(result.artifact.schema).toBe("twofold.liquid_universe_freeze/v1");
    expect(result.artifact.members).toHaveLength(100);
    expect(result.artifact.members.map((member) => member.symbol)).toContain("ZZZ");
    expect(result.artifact.members.find((member) => member.symbol === "ZZZ"))
      .toMatchObject({
        instrumentId: "122dd8f9-709a-5652-a27c-a3b5c32755de",
        selectionReason: "MANDATORY_CURRENT_HOLDING",
      });
    expect(result.artifact.candidates).toHaveLength(102);
    expect(result.artifact.candidates.filter((candidate) => candidate.selected))
      .toHaveLength(100);
    expect(result.canonicalJson).toBe(JSON.stringify(result.artifact));
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("freezes deterministic string-decimal research features", () => {
    const all = [...symbols(99), "ZZZ"];
    const result = buildLiquidUniverseFreeze({
      asOfSessionDate: "2026-06-29",
      policy,
      sources,
      assets: assets(all),
      stockCatalog: stocks(all),
      tradedDirectory: directory(all),
      bars: history(all),
      instrumentIdOverrides: {
        ZZZ: "122dd8f9-709a-5652-a27c-a3b5c32755de",
      },
    });
    const feature = result.artifact.candidates.find(
      (candidate) => candidate.symbol === "S000",
    )!;

    expect(feature).toMatchObject({
      asOfSessionDate: "2026-06-29",
      historySessionCount: "120",
      latestClosePrice: "219",
      return5dBps: "234",
      return20dBps: "1005",
      return60dBps: "3774",
      selected: true,
    });
    expect(feature.medianDollarVolume20d).toMatch(/^\d+$/);
    const assertNumberFree = (value: unknown): void => {
      if (typeof value === "number") throw new Error("numeric token");
      if (Array.isArray(value)) return value.forEach(assertNumberFree);
      if (value !== null && typeof value === "object") {
        Object.values(value).forEach(assertNumberFree);
      }
    };
    expect(() => assertNumberFree(result.artifact)).not.toThrow();
  });

  it("fails closed on ETFs, foreign issuers, inactive assets, and weak history", () => {
    const all = [...symbols(99), "ZZZ"];
    const base = {
      asOfSessionDate: "2026-06-29",
      policy,
      sources,
      assets: assets(all),
      stockCatalog: stocks(all),
      tradedDirectory: directory(all),
      bars: history(all),
      instrumentIdOverrides: {
        ZZZ: "122dd8f9-709a-5652-a27c-a3b5c32755de",
      },
    } as const;

    expect(() => buildLiquidUniverseFreeze({
      ...base,
      tradedDirectory: base.tradedDirectory.map((entry) =>
        entry.symbol === "S000" ? { ...entry, etf: true } : entry),
    })).toThrow(/only 99 eligible/);
    expect(() => buildLiquidUniverseFreeze({
      ...base,
      stockCatalog: base.stockCatalog.map((entry) =>
        entry.symbol === "S000" ? { ...entry, country: "Canada" } : entry),
    })).toThrow(/only 99 eligible/);
    expect(() => buildLiquidUniverseFreeze({
      ...base,
      assets: base.assets.map((entry) =>
        entry.symbol === "S000" ? { ...entry, tradable: false } : entry),
    })).toThrow(/only 99 eligible/);
    expect(() => buildLiquidUniverseFreeze({
      ...base,
      bars: base.bars.filter((bar) =>
        bar.symbol !== "S000" || bar.barDate > "2026-05-01"),
    })).toThrow(/only 99 eligible/);
  });

  it("does not waive eligibility for a mandatory current holding", () => {
    const all = [...symbols(100), "ZZZ"];
    expect(() => buildLiquidUniverseFreeze({
      asOfSessionDate: "2026-06-29",
      policy,
      sources,
      assets: assets(all),
      stockCatalog: stocks(all),
      tradedDirectory: directory(all).map((entry) =>
        entry.symbol === "ZZZ" ? { ...entry, etf: true } : entry),
      bars: history(all),
      instrumentIdOverrides: {
        ZZZ: "122dd8f9-709a-5652-a27c-a3b5c32755de",
      },
    })).toThrow(/mandatory symbol ZZZ is ineligible/);
  });
});
