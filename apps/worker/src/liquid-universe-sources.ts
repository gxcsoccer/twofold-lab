import { createHash } from "node:crypto";

import { parse } from "lossless-json";

import {
  canonicalJsonNumber,
} from "./market-data.js";
import type {
  LiquidUniverseAsset,
  LiquidUniverseBar,
  NasdaqStockCatalogEntry,
  NasdaqTradedSecurity,
} from "./liquid-universe.js";

const ALPACA_TRADING_ORIGIN = "https://paper-api.alpaca.markets";
const ALPACA_DATA_ORIGIN = "https://data.alpaca.markets";
const NASDAQ_SCREENER_ORIGIN = "https://api.nasdaq.com";
const NASDAQ_TRADER_ORIGIN = "https://www.nasdaqtrader.com";
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGES = 100;

export interface FetchedUniverseSource<T> {
  readonly url: string;
  readonly observedAt: string;
  readonly responseSha256: string;
  readonly rawBody: string;
  readonly data: readonly T[];
}

interface SharedFetchOptions {
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export async function fetchAlpacaUniverseAssets(options: SharedFetchOptions & {
  readonly apiKeyId: string;
  readonly apiSecretKey: string;
  readonly tradingUrl?: string;
}): Promise<FetchedUniverseSource<LiquidUniverseAsset>> {
  credentials(options.apiKeyId, options.apiSecretKey);
  const base = trustedBase(
    options.tradingUrl ?? ALPACA_TRADING_ORIGIN,
    ALPACA_TRADING_ORIGIN,
    "Alpaca trading URL",
  );
  const url = new URL("/v2/assets", base);
  url.searchParams.set("status", "active");
  url.searchParams.set("asset_class", "us_equity");
  const fetched = await fetchText(url, {
    ...options,
    headers: alpacaHeaders(options.apiKeyId, options.apiSecretKey),
    expectedContentType: "application/json",
  });
  const value = JSON.parse(fetched.rawBody) as unknown;
  if (!Array.isArray(value)) throw new TypeError("Alpaca assets must be an array");
  const data = value.map((candidate, index): LiquidUniverseAsset => {
    const row = record(candidate, `assets[${index}]`);
    return Object.freeze({
      assetId: pattern(row.id, UUID_PATTERN, `assets[${index}].id`),
      symbol: pattern(row.symbol, SYMBOL_PATTERN, `assets[${index}].symbol`),
      name: string(row.name, `assets[${index}].name`),
      exchange: string(row.exchange, `assets[${index}].exchange`),
      status: string(row.status, `assets[${index}].status`),
      tradable: boolean(row.tradable, `assets[${index}].tradable`),
    });
  }).sort((left, right) => left.symbol.localeCompare(right.symbol, "en"));
  return Object.freeze({ ...fetched, data: Object.freeze(data) });
}

export async function fetchNasdaqStockCatalog(
  options: SharedFetchOptions = {},
): Promise<FetchedUniverseSource<NasdaqStockCatalogEntry>> {
  const url = new URL("/api/screener/stocks", NASDAQ_SCREENER_ORIGIN);
  url.searchParams.set("tableonly", "true");
  url.searchParams.set("limit", "10000");
  url.searchParams.set("offset", "0");
  url.searchParams.set("download", "true");
  const fetched = await fetchText(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "User-Agent": "Twofold-Lab/1.0 (+private research)",
    },
    expectedContentType: "application/json",
  });
  const root = record(JSON.parse(fetched.rawBody), "Nasdaq screener response");
  const responseData = record(root.data, "Nasdaq screener response.data");
  if (!Array.isArray(responseData.rows)) {
    throw new TypeError("Nasdaq screener rows must be an array");
  }
  const data: NasdaqStockCatalogEntry[] = [];
  responseData.rows.forEach((candidate, index) => {
    const row = record(candidate, `Nasdaq rows[${index}]`);
    const symbol = optionalPattern(row.symbol, SYMBOL_PATTERN);
    const name = optionalString(row.name);
    const country = optionalString(row.country);
    const ipoYear = optionalPattern(row.ipoyear, /^\d{4}$/);
    const latestPrice = moneyValue(row.lastsale);
    const latestVolume = integerValue(row.volume);
    // The upstream stock screen contains blank classifications. Such rows are
    // not silently treated as US common equity; they simply cannot qualify.
    if (
      symbol === null || name === null || country === null || ipoYear === null
      || latestPrice === null || latestVolume === null
    ) return;
    data.push(Object.freeze({
      symbol,
      name,
      country,
      ipoYear,
      latestPrice,
      latestVolume,
    }));
  });
  data.sort((left, right) => left.symbol.localeCompare(right.symbol, "en"));
  assertUniqueSymbols(data, "Nasdaq stock catalog");
  return Object.freeze({ ...fetched, data: Object.freeze(data) });
}

export async function fetchNasdaqTradedDirectory(
  options: SharedFetchOptions = {},
): Promise<FetchedUniverseSource<NasdaqTradedSecurity>> {
  const url = new URL(
    "/dynamic/symdir/nasdaqtraded.txt",
    NASDAQ_TRADER_ORIGIN,
  );
  const fetched = await fetchText(url, {
    ...options,
    headers: { Accept: "text/plain" },
    expectedContentType: "text/plain",
  });
  const lines = fetched.rawBody.split(/\r?\n/).filter((line) => line !== "");
  const header = lines.shift()?.split("|");
  const expectedHeader = [
    "Nasdaq Traded", "Symbol", "Security Name", "Listing Exchange",
    "Market Category", "ETF", "Round Lot Size", "Test Issue",
    "Financial Status", "CQS Symbol", "NASDAQ Symbol", "NextShares",
  ];
  if (
    header === undefined
    || header.length !== expectedHeader.length
    || header.some((value, index) => value !== expectedHeader[index])
  ) throw new TypeError("Nasdaq traded directory header changed");
  const data: NasdaqTradedSecurity[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("File Creation Time:")) continue;
    const fields = line.split("|");
    if (fields.length !== expectedHeader.length) {
      throw new TypeError(`Nasdaq traded directory row ${index + 2} changed`);
    }
    // CQS and Nasdaq suffix conventions differ (ABR$D versus ABR-D, AAC.U
    // versus AAC=). Retain the representation that crosses our ticker boundary.
    const symbol = [fields[10], fields[1]].find(
      (candidate) => candidate !== undefined && SYMBOL_PATTERN.test(candidate),
    );
    if (symbol === undefined) continue;
    data.push(Object.freeze({
      symbol,
      nasdaqTraded: yesNo(fields[0], `directory[${index}].nasdaqTraded`),
      etf: yesNo(fields[5], `directory[${index}].etf`),
      testIssue: yesNo(fields[7], `directory[${index}].testIssue`),
    }));
  }
  data.sort((left, right) => left.symbol.localeCompare(right.symbol, "en"));
  assertUniqueSymbols(data, "Nasdaq traded directory");
  return Object.freeze({ ...fetched, data: Object.freeze(data) });
}

export async function fetchAlpacaUniverseBars(options: SharedFetchOptions & {
  readonly apiKeyId: string;
  readonly apiSecretKey: string;
  readonly symbols: readonly string[];
  readonly startDate: string;
  readonly endDate: string;
  readonly dataUrl?: string;
}): Promise<FetchedUniverseSource<LiquidUniverseBar>> {
  credentials(options.apiKeyId, options.apiSecretKey);
  const symbols = [...options.symbols].sort();
  if (
    symbols.length === 0 || symbols.length > 1_000
    || new Set(symbols).size !== symbols.length
    || symbols.some((symbol) => !SYMBOL_PATTERN.test(symbol))
  ) throw new TypeError("universe bar symbols must be 1-1000 unique tickers");
  const startDate = date(options.startDate, "startDate");
  const endDate = date(options.endDate, "endDate");
  if (startDate > endDate) throw new RangeError("bar startDate exceeds endDate");
  const base = trustedBase(
    options.dataUrl ?? ALPACA_DATA_ORIGIN,
    ALPACA_DATA_ORIGIN,
    "Alpaca data URL",
  );
  const url = new URL("/v2/stocks/bars", base);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("start", `${startDate}T00:00:00.000Z`);
  url.searchParams.set("end", `${addDays(endDate, 1)}T00:00:00.000Z`);
  url.searchParams.set("feed", "sip");
  url.searchParams.set("adjustment", "raw");
  url.searchParams.set("sort", "asc");
  url.searchParams.set("limit", "10000");

  const now = options.now ?? (() => new Date());
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const pages: Array<{ readonly url: string; readonly bodySha256: string; readonly body: string }> = [];
  const bars: LiquidUniverseBar[] = [];
  const seenBars = new Set<string>();
  const seenTokens = new Set<string>();
  let nextPageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const pageUrl = new URL(url);
    if (nextPageToken !== undefined) {
      pageUrl.searchParams.set("page_token", nextPageToken);
    }
    const response = await fetchImplementation(pageUrl, {
      method: "GET",
      headers: alpacaHeaders(options.apiKeyId, options.apiSecretKey),
      redirect: "error",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Alpaca universe bars failed with HTTP ${response.status}`);
    }
    requireContentType(response, "application/json");
    pages.push(Object.freeze({
      url: pageUrl.toString(),
      bodySha256: sha256(body),
      body,
    }));
    const payload = record(parse(body), `Alpaca bars page ${page + 1}`);
    const collections = record(payload.bars, `Alpaca bars page ${page + 1}.bars`);
    for (const [symbol, value] of Object.entries(collections)) {
      if (!symbols.includes(symbol)) {
        throw new TypeError(`Alpaca returned unrequested symbol ${symbol}`);
      }
      if (!Array.isArray(value)) {
        throw new TypeError(`Alpaca bars.${symbol} must be an array`);
      }
      for (const [index, candidate] of value.entries()) {
        const row = record(candidate, `bars.${symbol}[${index}]`);
        const barStart = timestamp(row.t, `bars.${symbol}[${index}].t`);
        const barDate = barStart.slice(0, 10);
        if (barDate < startDate || barDate > endDate) {
          throw new TypeError(`Alpaca returned ${symbol} outside the requested window`);
        }
        const closePrice = positiveJsonNumber(
          row.c,
          `bars.${symbol}[${index}].c`,
        );
        const volume = integerJsonNumber(row.v, `bars.${symbol}[${index}].v`);
        const key = `${symbol}:${barDate}`;
        if (seenBars.has(key)) throw new TypeError(`duplicate universe bar ${key}`);
        seenBars.add(key);
        bars.push(Object.freeze({ symbol, barDate, closePrice, volume }));
      }
    }
    if (payload.next_page_token === null || payload.next_page_token === undefined) {
      nextPageToken = undefined;
      break;
    }
    nextPageToken = string(payload.next_page_token, "next_page_token");
    if (seenTokens.has(nextPageToken)) {
      throw new TypeError("Alpaca universe bars pagination repeated a token");
    }
    seenTokens.add(nextPageToken);
  }
  if (nextPageToken !== undefined) {
    throw new RangeError(`Alpaca universe bars exceeded ${MAX_PAGES} pages`);
  }
  bars.sort((left, right) =>
    left.symbol.localeCompare(right.symbol, "en")
    || left.barDate.localeCompare(right.barDate, "en"));
  const rawBody = JSON.stringify({
    schema: "twofold.alpaca_universe_bars_pages/v1",
    pages,
  });
  return Object.freeze({
    url: url.toString(),
    observedAt: now().toISOString(),
    responseSha256: sha256(rawBody),
    rawBody,
    data: Object.freeze(bars),
  });
}

async function fetchText(
  url: URL,
  options: SharedFetchOptions & {
    readonly headers: Readonly<Record<string, string>>;
    readonly expectedContentType: "application/json" | "text/plain";
  },
): Promise<Omit<FetchedUniverseSource<never>, "data">> {
  const response = await (options.fetchImplementation ?? fetch)(url, {
    method: "GET",
    headers: options.headers,
    redirect: "error",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const rawBody = await response.text();
  if (!response.ok) throw new Error(`${url.origin} failed with HTTP ${response.status}`);
  requireContentType(response, options.expectedContentType);
  return Object.freeze({
    url: url.toString(),
    observedAt: (options.now ?? (() => new Date()))().toISOString(),
    responseSha256: sha256(rawBody),
    rawBody,
  });
}

function trustedBase(value: string, origin: string, field: string): string {
  const parsed = new URL(value);
  if (
    parsed.origin !== origin || parsed.pathname !== "/"
    || parsed.username !== "" || parsed.password !== ""
    || parsed.search !== "" || parsed.hash !== ""
  ) throw new TypeError(`${field} must use trusted origin ${origin}`);
  return parsed.toString();
}

function requireContentType(
  response: Response,
  expected: "application/json" | "text/plain",
): void {
  const actual = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (actual !== expected) {
    throw new TypeError(`source content type must be ${expected}, got ${actual ?? "missing"}`);
  }
}

function alpacaHeaders(apiKeyId: string, apiSecretKey: string) {
  return Object.freeze({
    "APCA-API-KEY-ID": apiKeyId,
    "APCA-API-SECRET-KEY": apiSecretKey,
    Accept: "application/json",
  });
}

function credentials(apiKeyId: string, apiSecretKey: string): void {
  if (apiKeyId.trim() === "" || apiSecretKey.trim() === "") {
    throw new TypeError("Alpaca credentials are required");
  }
}

function moneyValue(value: unknown): string | null {
  const raw = optionalString(value)?.replace(/^\$/, "").replaceAll(",", "");
  if (raw === undefined || raw === null || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    return null;
  }
  if (/^0(?:\.0+)?$/.test(raw)) return null;
  return raw.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

function integerValue(value: unknown): string | null {
  const raw = optionalString(value)?.replaceAll(",", "");
  return raw !== undefined && raw !== null && /^[1-9]\d*$/.test(raw) ? raw : null;
}

function positiveJsonNumber(value: unknown, field: string): string {
  const parsed = canonicalJsonNumber(value, field);
  if (parsed === "0") throw new TypeError(`${field} must be positive`);
  return parsed;
}

function integerJsonNumber(value: unknown, field: string): string {
  const parsed = positiveJsonNumber(value, field);
  if (parsed.includes(".")) throw new TypeError(`${field} must be an integer`);
  return parsed;
}

function yesNo(value: unknown, field: string): boolean {
  if (value === "Y") return true;
  if (value === "N") return false;
  throw new TypeError(`${field} must be Y or N`);
}

function assertUniqueSymbols(
  values: readonly { readonly symbol: string }[],
  field: string,
): void {
  if (new Set(values.map((value) => value.symbol)).size !== values.length) {
    throw new TypeError(`${field} contains duplicate symbols`);
  }
}

function addDays(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function date(value: string, field: string): string {
  if (
    !DATE_PATTERN.test(value)
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) throw new TypeError(`${field} must be a real YYYY-MM-DD date`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const raw = string(value, field);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} is invalid`);
  return parsed.toISOString();
}

function pattern(value: unknown, expected: RegExp, field: string): string {
  const parsed = string(value, field);
  if (!expected.test(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function optionalPattern(value: unknown, expected: RegExp): string | null {
  const parsed = optionalString(value);
  return parsed !== null && expected.test(parsed) ? parsed : null;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
