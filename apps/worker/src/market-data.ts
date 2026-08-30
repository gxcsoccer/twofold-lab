import { createHash } from "node:crypto";

import { isLosslessNumber, parse } from "lossless-json";

import { boundedProviderSignal } from "./provider-deadline.js";

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const JSON_NUMBER_PATTERN = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const SESSION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ALPACA_DATA_ORIGIN = "https://data.alpaca.markets";
const MAX_ALPACA_PAGES = 100;

export const ALPACA_NORMALIZER_VERSION = "alpaca-bars-v1";
export const MARKET_SELECTION_POLICY = "latest-observation-for-target-session-v2";
export const PRIVATE_ARTIFACT_BUCKET = "twofold-private-artifacts";

export interface AlpacaMarketDataConfig {
  readonly apiKeyId: string;
  readonly apiSecretKey: string;
  readonly dataUrl: string;
  readonly symbols: readonly string[];
  readonly feed: "sip" | "iex";
  readonly lookbackDays: number;
  readonly sourceVersionKey: string;
  readonly sourceEffectiveFrom: string;
  readonly licenseScope: string;
}

export interface NormalizedMarketBar {
  readonly symbol: string;
  readonly timeframe: "1Day";
  readonly barStart: string;
  readonly barDate: string;
  readonly currency: "USD";
  readonly openPrice: string;
  readonly highPrice: string;
  readonly lowPrice: string;
  readonly closePrice: string;
  readonly volume: string;
  readonly tradeCount: string;
  readonly vwap: string;
  readonly factSha256: string;
}

export interface MarketSourceVersion {
  readonly provider: "alpaca";
  readonly dataset: "us_stock_daily_bars";
  readonly versionKey: string;
  readonly endpointBaseUrl: string;
  readonly feed: "sip" | "iex";
  readonly adjustment: "raw";
  readonly timeframe: "1Day";
  readonly normalizerVersion: string;
  readonly licenseScope: string;
  readonly configSha256: string;
  readonly effectiveFrom: string;
}

export interface AlpacaMarketDelivery {
  readonly source: MarketSourceVersion;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly providerRequestId?: string;
  readonly httpStatus: number;
  readonly retrievedAt: string;
  readonly firstObservedAt: string;
  readonly availableAt: string;
  readonly contentType: "application/json";
  readonly rawBody: string;
  readonly byteSize: number;
  readonly responseSha256: string;
  readonly normalizedManifestSha256: string;
  readonly objectPath: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly facts: readonly NormalizedMarketBar[];
  readonly symbols: readonly string[];
  readonly targetSessionDate: string;
  readonly cutoffAt: string;
}

export interface FetchAlpacaOptions {
  readonly endAt?: string;
  readonly targetSessionDate?: string;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireValue(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    throw new Error(`${name} is required for real market data`);
  }
  return normalized;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseSymbols(value: string | undefined): readonly string[] {
  const symbols = [...new Set((value ?? "LULU,SPY,QQQ")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean))].sort();
  if (symbols.length === 0 || symbols.some((symbol) => !SYMBOL_PATTERN.test(symbol))) {
    throw new Error("TWOFOLD_MARKET_SYMBOLS contains an invalid symbol");
  }
  return Object.freeze(symbols);
}

function requireIsoTimestamp(value: string, name: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return parsed.toISOString();
}

export function loadAlpacaMarketDataConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AlpacaMarketDataConfig {
  const dataUrl = (environment.ALPACA_DATA_URL ?? "https://data.alpaca.markets")
    .trim()
    .replace(/\/+$/, "");
  const parsedUrl = new URL(dataUrl);
  if (
    parsedUrl.origin !== ALPACA_DATA_ORIGIN
    || parsedUrl.username !== ""
    || parsedUrl.password !== ""
    || parsedUrl.pathname !== "/"
    || parsedUrl.search !== ""
    || parsedUrl.hash !== ""
  ) {
    throw new Error(`ALPACA_DATA_URL must use the trusted origin ${ALPACA_DATA_ORIGIN}`);
  }

  const feed = environment.TWOFOLD_MARKET_FEED?.trim() ?? "sip";
  if (feed !== "sip" && feed !== "iex") {
    throw new Error("TWOFOLD_MARKET_FEED must be sip or iex");
  }

  return Object.freeze({
    apiKeyId: requireValue(environment.ALPACA_API_KEY_ID, "ALPACA_API_KEY_ID"),
    apiSecretKey: requireValue(
      environment.ALPACA_API_SECRET_KEY,
      "ALPACA_API_SECRET_KEY",
    ),
    dataUrl,
    symbols: parseSymbols(environment.TWOFOLD_MARKET_SYMBOLS),
    feed,
    lookbackDays: positiveInteger(
      environment.TWOFOLD_MARKET_LOOKBACK_DAYS,
      14,
      "TWOFOLD_MARKET_LOOKBACK_DAYS",
    ),
    sourceVersionKey:
      environment.TWOFOLD_MARKET_SOURCE_VERSION?.trim()
      || `alpaca-${feed}-raw-1day-v1`,
    sourceEffectiveFrom: requireIsoTimestamp(
      environment.TWOFOLD_MARKET_SOURCE_EFFECTIVE_FROM
        ?? "2026-08-23T00:00:00Z",
      "TWOFOLD_MARKET_SOURCE_EFFECTIVE_FROM",
    ),
    licenseScope:
      environment.TWOFOLD_MARKET_LICENSE_SCOPE?.trim() || "private-research",
  });
}

function requireSessionDate(value: string, name: string): string {
  if (!SESSION_DATE_PATTERN.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a valid calendar date`);
  }
  return value;
}

function newYorkClock(value: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${read("year")}-${read("month")}-${read("day")}`,
    hour: Number(read("hour")),
    minute: Number(read("minute")),
  };
}

function assertCompletedSessionDate(targetSessionDate: string, observedAt: string): void {
  const clock = newYorkClock(new Date(observedAt));
  if (targetSessionDate > clock.date) {
    throw new Error("target session date is in the future in America/New_York");
  }
  if (
    targetSessionDate === clock.date
    && (clock.hour < 16 || (clock.hour === 16 && clock.minute < 20))
  ) {
    throw new Error(
      "refusing to seal a same-day daily bar before 16:20 America/New_York",
    );
  }
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

/** Expand a non-negative JSON number token into a canonical decimal string. */
export function canonicalJsonNumber(value: unknown, name: string): string {
  if (!isLosslessNumber(value)) {
    throw new Error(`${name} must be a JSON number`);
  }
  const raw = value.value;
  const match = JSON_NUMBER_PATTERN.exec(raw);
  if (!match) {
    throw new Error(`${name} must be a non-negative finite JSON number`);
  }

  const integer = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) {
    throw new Error(`${name} exponent is outside the supported range`);
  }

  let digits = (integer + fraction).replace(/^0+(?=\d)/, "");
  let scale = fraction.length - exponent;
  if (scale <= 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  } else if (digits.length <= scale) {
    digits = "0".repeat(scale - digits.length + 1) + digits;
  }

  const integerPart = scale === 0 ? digits : digits.slice(0, -scale);
  const fractionPart = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  const canonicalInteger = integerPart.replace(/^0+(?=\d)/, "") || "0";
  return fractionPart.length === 0
    ? canonicalInteger
    : `${canonicalInteger}.${fractionPart}`;
}

function canonicalInteger(value: unknown, name: string): string {
  const canonical = canonicalJsonNumber(value, name);
  if (canonical.includes(".")) {
    throw new Error(`${name} must be an integer`);
  }
  return canonical;
}

function normalizedFactMaterial(
  fact: Omit<NormalizedMarketBar, "factSha256">,
): string {
  return [
    fact.symbol,
    fact.timeframe,
    fact.barStart,
    fact.barDate,
    fact.currency,
    fact.openPrice,
    fact.highPrice,
    fact.lowPrice,
    fact.closePrice,
    fact.volume,
    fact.tradeCount,
    fact.vwap,
    ALPACA_NORMALIZER_VERSION,
  ].join("\u001f");
}

function normalizeBar(symbol: string, input: unknown): NormalizedMarketBar {
  const bar = asRecord(input, `bars.${symbol}[]`);
  const barStart = requireIsoTimestamp(asString(bar.t, `${symbol}.t`), `${symbol}.t`);
  const withoutHash = Object.freeze({
    symbol,
    timeframe: "1Day" as const,
    barStart,
    barDate: barStart.slice(0, 10),
    currency: "USD" as const,
    openPrice: canonicalJsonNumber(bar.o, `${symbol}.o`),
    highPrice: canonicalJsonNumber(bar.h, `${symbol}.h`),
    lowPrice: canonicalJsonNumber(bar.l, `${symbol}.l`),
    closePrice: canonicalJsonNumber(bar.c, `${symbol}.c`),
    volume: canonicalInteger(bar.v, `${symbol}.v`),
    tradeCount: canonicalInteger(bar.n, `${symbol}.n`),
    vwap: bar.vw === null || bar.vw === undefined
      ? ""
      : canonicalJsonNumber(bar.vw, `${symbol}.vw`),
  });
  return Object.freeze({
    ...withoutHash,
    factSha256: sha256(normalizedFactMaterial(withoutHash)),
  });
}

function responseContentType(response: Response): "application/json" {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new Error(`Alpaca returned unsupported content type: ${contentType ?? "missing"}`);
  }
  return contentType;
}

export async function fetchAlpacaDailyBars(
  config: AlpacaMarketDataConfig,
  options: FetchAlpacaOptions = {},
): Promise<AlpacaMarketDelivery> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => new Date());
  const endAt = requireIsoTimestamp(
    options.endAt
      ?? new Date(now().getTime() - 16 * 60 * 1_000).toISOString(),
    "endAt",
  );
  const startAt = new Date(
    new Date(endAt).getTime() - config.lookbackDays * 24 * 60 * 60 * 1_000,
  ).toISOString();

  const requestUrl = new URL("/v2/stocks/bars", config.dataUrl);
  requestUrl.searchParams.set("symbols", config.symbols.join(","));
  requestUrl.searchParams.set("timeframe", "1Day");
  requestUrl.searchParams.set("start", startAt);
  requestUrl.searchParams.set("end", endAt);
  requestUrl.searchParams.set("feed", config.feed);
  requestUrl.searchParams.set("adjustment", "raw");
  requestUrl.searchParams.set("sort", "asc");
  requestUrl.searchParams.set("limit", "10000");

  const requestFingerprint = sha256(requestUrl.toString());
  const providerSignal = boundedProviderSignal(options.signal);
  const rawPages: Array<{
    requestUrl: string;
    httpStatus: number;
    providerRequestId?: string;
    bodySha256: string;
    body: string;
    etag?: string;
    lastModified?: string;
  }> = [];
  const facts: NormalizedMarketBar[] = [];
  const seenFactKeys = new Set<string>();
  const seenPageTokens = new Set<string>();
  let nextPageToken: string | undefined;
  let firstObservedAt: string | undefined;

  for (let pageIndex = 0; pageIndex < MAX_ALPACA_PAGES; pageIndex += 1) {
    const pageUrl = new URL(requestUrl);
    if (nextPageToken !== undefined) {
      pageUrl.searchParams.set("page_token", nextPageToken);
    }

    const response = await fetchImplementation(pageUrl, {
      method: "GET",
      headers: {
        "APCA-API-KEY-ID": config.apiKeyId,
        "APCA-API-SECRET-KEY": config.apiSecretKey,
        Accept: "application/json",
      },
      redirect: "error",
      signal: providerSignal,
    });
    if (firstObservedAt === undefined) firstObservedAt = now().toISOString();
    const pageBody = await response.text();
    if (!response.ok) {
      throw new Error(`Alpaca market-data request failed with HTTP ${response.status}`);
    }
    responseContentType(response);

    const providerRequestId = response.headers.get("x-request-id")?.trim() || undefined;
    const etag = response.headers.get("etag")?.trim() || undefined;
    const lastModified = response.headers.get("last-modified")?.trim() || undefined;
    rawPages.push({
      requestUrl: pageUrl.toString(),
      httpStatus: response.status,
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      bodySha256: sha256(pageBody),
      body: pageBody,
      ...(etag === undefined ? {} : { etag }),
      ...(lastModified === undefined ? {} : { lastModified }),
    });

    const payload = asRecord(parse(pageBody), `Alpaca response page ${pageIndex + 1}`);
    const bars = asRecord(payload.bars, `Alpaca response page ${pageIndex + 1}.bars`);
    for (const symbol of config.symbols) {
      const symbolBars = bars[symbol];
      if (symbolBars === undefined) continue;
      if (!Array.isArray(symbolBars)) {
        throw new Error(`Alpaca response bars.${symbol} must be an array`);
      }
      for (const bar of symbolBars) {
        const fact = normalizeBar(symbol, bar);
        const factKey = `${fact.symbol}\u001f${fact.timeframe}\u001f${fact.barStart}`;
        if (seenFactKeys.has(factKey)) {
          throw new Error(`Alpaca pagination repeated market bar ${fact.symbol}/${fact.barStart}`);
        }
        seenFactKeys.add(factKey);
        facts.push(fact);
      }
    }

    const tokenValue = payload.next_page_token;
    if (tokenValue === null || tokenValue === undefined) {
      nextPageToken = undefined;
      break;
    }
    nextPageToken = asString(tokenValue, "Alpaca response.next_page_token");
    if (seenPageTokens.has(nextPageToken)) {
      throw new Error("Alpaca pagination repeated a next_page_token");
    }
    seenPageTokens.add(nextPageToken);
  }
  if (nextPageToken !== undefined) {
    throw new Error(`Alpaca pagination exceeded ${MAX_ALPACA_PAGES} pages`);
  }
  if (firstObservedAt === undefined || rawPages.length === 0) {
    throw new Error("Alpaca returned no response pages");
  }
  const retrievedAt = now().toISOString();

  for (const symbol of config.symbols) {
    if (!facts.some((fact) => fact.symbol === symbol)) {
      throw new Error(`Alpaca response is missing required bars for ${symbol}`);
    }
  }
  facts.sort((left, right) =>
    compareCanonicalText(left.symbol, right.symbol)
      || compareCanonicalText(left.barStart, right.barStart)
  );

  const commonDates = config.symbols
    .map((symbol) => new Set(
      facts.filter((fact) => fact.symbol === symbol).map((fact) => fact.barDate),
    ))
    .reduce<Set<string>>((common, dates, index) => {
      if (index === 0) return new Set(dates);
      return new Set([...common].filter((date) => dates.has(date)));
    }, new Set<string>());
  const targetSessionDate = options.targetSessionDate === undefined
    ? [...commonDates].sort().at(-1)
    : requireSessionDate(options.targetSessionDate, "targetSessionDate");
  if (targetSessionDate === undefined || !commonDates.has(targetSessionDate)) {
    throw new Error("Alpaca response has no complete common session date for all symbols");
  }
  assertCompletedSessionDate(targetSessionDate, retrievedAt);

  const normalizedManifestSha256 = sha256(
    facts.map((fact) => fact.factSha256).join("|"),
  );
  const rawBody = rawPages.length === 1
    ? rawPages[0]!.body
    : JSON.stringify({
        schema: "twofold.alpaca.paginated-response.v1",
        pages: rawPages.map((page) => ({
          requestUrl: page.requestUrl,
          httpStatus: page.httpStatus,
          providerRequestId: page.providerRequestId ?? null,
          bodySha256: page.bodySha256,
          etag: page.etag ?? null,
          lastModified: page.lastModified ?? null,
          body: page.body,
        })),
      });
  const responseSha256 = sha256(rawBody);
  const sourceConfig = {
    provider: "alpaca",
    dataset: "us_stock_daily_bars",
    endpointBaseUrl: config.dataUrl,
    feed: config.feed,
    adjustment: "raw",
    timeframe: "1Day",
    normalizerVersion: ALPACA_NORMALIZER_VERSION,
    licenseScope: config.licenseScope,
  } as const;
  const source: MarketSourceVersion = Object.freeze({
    ...sourceConfig,
    versionKey: config.sourceVersionKey,
    configSha256: sha256(JSON.stringify(sourceConfig)),
    effectiveFrom: config.sourceEffectiveFrom,
  });
  const providerRequestId = rawPages[0]?.providerRequestId;
  const etag = rawPages.length === 1 ? rawPages[0]?.etag : undefined;
  const lastModified = rawPages.length === 1 ? rawPages[0]?.lastModified : undefined;

  return Object.freeze({
    source,
    idempotencyKey:
      `alpaca:${config.sourceVersionKey}:${requestFingerprint}:${responseSha256}:`
      + sha256(firstObservedAt),
    requestFingerprint,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    httpStatus: rawPages[0]!.httpStatus,
    retrievedAt,
    firstObservedAt,
    availableAt: retrievedAt,
    contentType: "application/json",
    rawBody,
    byteSize: Buffer.byteLength(rawBody),
    responseSha256,
    normalizedManifestSha256,
    objectPath: `raw/alpaca/${responseSha256.slice(0, 2)}/${responseSha256}.json`,
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
    facts: Object.freeze(facts),
    symbols: config.symbols,
    targetSessionDate,
    cutoffAt: retrievedAt,
  });
}
