import { parse } from "lossless-json";

import { canonicalJson, sha256 } from "./arena-inputs.js";
import { canonicalJsonNumber, PRIVATE_ARTIFACT_BUCKET } from "./market-data.js";
import { loadAlpacaMarketDataConfig } from "./market-data.js";
import { boundedProviderSignal } from "./provider-deadline.js";

const TRUSTED_DATA_ORIGIN = "https://data.alpaca.markets";
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;

export const ALPACA_OPEN_REFERENCE_NORMALIZER_VERSION =
  "alpaca-first-minute-open-reference-v1";
export const ALPACA_VWAP_VOLUME_REFERENCE_NORMALIZER_VERSION =
  "alpaca-first-minute-vwap-volume-reference-v2";

export type AlpacaOpenReferenceMethod =
  | "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE"
  | "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE";

export interface AlpacaOpenReferenceConfig {
  readonly apiKeyId: string;
  readonly apiSecretKey: string;
  readonly dataUrl: string;
  readonly symbols: readonly string[];
  readonly feed: "sip" | "iex";
  readonly sourceVersionKey: string;
  readonly liquiditySourceVersionKey: string;
  readonly sourceEffectiveFrom: string;
  readonly licenseScope: string;
}

export function loadAlpacaOpenReferenceConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AlpacaOpenReferenceConfig {
  const market = loadAlpacaMarketDataConfig(environment);
  if (market.feed !== "sip") {
    throw new TypeError("competition open references require the Alpaca SIP feed");
  }
  return Object.freeze({
    apiKeyId: market.apiKeyId,
    apiSecretKey: market.apiSecretKey,
    dataUrl: market.dataUrl,
    symbols: market.symbols,
    feed: "sip",
    sourceVersionKey:
      environment.TWOFOLD_OPEN_REFERENCE_SOURCE_VERSION?.trim()
      || "alpaca-sip-raw-1min-open-v1",
    liquiditySourceVersionKey:
      environment.TWOFOLD_LIQUIDITY_REFERENCE_SOURCE_VERSION?.trim()
      || "alpaca-sip-raw-1min-vwap-volume-v2",
    sourceEffectiveFrom: market.sourceEffectiveFrom,
    licenseScope: market.licenseScope,
  });
}

export interface AlpacaOpenReferenceFact {
  readonly barStart: string;
  readonly currency: "USD";
  readonly factSha256: string;
  readonly symbol: string;
  readonly value: string;
  readonly observedVolume?: string;
}

export interface AlpacaOpenReferenceDelivery {
  readonly schema:
    | "twofold.alpaca_open_reference_delivery/v1"
    | "twofold.alpaca_open_reference_delivery/v2";
  readonly method: AlpacaOpenReferenceMethod;
  readonly source: {
    readonly provider: "alpaca";
    readonly dataset: "us_stock_intraday_open_references";
    readonly versionKey: string;
    readonly endpointBaseUrl: string;
    readonly feed: "sip" | "iex";
    readonly adjustment: "raw";
    readonly timeframe: "1Min";
    readonly normalizerVersion:
      | typeof ALPACA_OPEN_REFERENCE_NORMALIZER_VERSION
      | typeof ALPACA_VWAP_VOLUME_REFERENCE_NORMALIZER_VERSION;
    readonly licenseScope: string;
    readonly configSha256: string;
    readonly effectiveFrom: string;
  };
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly providerRequestId?: string;
  readonly observedAt: string;
  readonly sessionDate: string;
  readonly expectedOpenAt: string;
  readonly rawBody: string;
  readonly byteSize: number;
  readonly responseSha256: string;
  readonly objectPath: string;
  readonly storageBucket: typeof PRIVATE_ARTIFACT_BUCKET;
  readonly references: readonly AlpacaOpenReferenceFact[];
  readonly canonicalJson: string;
  readonly contentSha256: string;
}

export async function fetchAlpacaOpenReferences(
  config: AlpacaOpenReferenceConfig,
  options: {
    readonly method?: AlpacaOpenReferenceMethod;
    readonly sessionDate: string;
    readonly expectedOpenAt: string;
    readonly availableAt: string;
    readonly fetchImplementation?: typeof fetch;
    readonly now?: () => Date;
    readonly signal?: AbortSignal;
  },
): Promise<AlpacaOpenReferenceDelivery> {
  validateConfig(config);
  const method = options.method ?? "ALPACA_SIP_FIRST_MINUTE_OPEN_REFERENCE";
  const volumeParticipation =
    method === "ALPACA_SIP_FIRST_MINUTE_VWAP_VOLUME_REFERENCE";
  const normalizerVersion = volumeParticipation
    ? ALPACA_VWAP_VOLUME_REFERENCE_NORMALIZER_VERSION
    : ALPACA_OPEN_REFERENCE_NORMALIZER_VERSION;
  const sourceVersionKey = volumeParticipation
    ? config.liquiditySourceVersionKey
    : config.sourceVersionKey;
  const sessionDate = date(options.sessionDate, "sessionDate");
  const expectedOpenAt = timestamp(options.expectedOpenAt, "expectedOpenAt");
  const availableAt = timestamp(options.availableAt, "availableAt");
  if (expectedOpenAt.slice(0, 10) !== sessionDate || availableAt <= expectedOpenAt) {
    throw new TypeError("open reference schedule is inconsistent");
  }
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  if (observedAt < availableAt) {
    throw new Error("refusing to fetch before reference availability");
  }
  const endAt = new Date(new Date(expectedOpenAt).getTime() + 60_000).toISOString();
  const requestUrl = new URL("/v2/stocks/bars", config.dataUrl);
  requestUrl.searchParams.set("symbols", config.symbols.join(","));
  requestUrl.searchParams.set("timeframe", "1Min");
  requestUrl.searchParams.set("start", expectedOpenAt);
  requestUrl.searchParams.set("end", endAt);
  requestUrl.searchParams.set("feed", config.feed);
  requestUrl.searchParams.set("adjustment", "raw");
  requestUrl.searchParams.set("sort", "asc");
  requestUrl.searchParams.set("limit", "10000");
  const requestFingerprint = sha256(requestUrl.toString());
  const providerSignal = boundedProviderSignal(options.signal);

  const response = await (options.fetchImplementation ?? fetch)(requestUrl, {
    method: "GET",
    headers: {
      "APCA-API-KEY-ID": config.apiKeyId,
      "APCA-API-SECRET-KEY": config.apiSecretKey,
      Accept: "application/json",
    },
    redirect: "error",
    signal: providerSignal,
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`Alpaca open-reference request failed with HTTP ${response.status}`);
  }
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim()
    !== "application/json") {
    throw new Error("Alpaca open-reference response is not application/json");
  }
  const payload = record(parse(rawBody), "Alpaca open-reference response");
  if (payload.next_page_token !== null && payload.next_page_token !== undefined) {
    throw new Error("one-minute open-reference response must not paginate");
  }
  const bars = record(payload.bars, "Alpaca open-reference bars");
  const references = config.symbols.map((symbol): AlpacaOpenReferenceFact => {
    const symbolBars = bars[symbol];
    if (!Array.isArray(symbolBars) || symbolBars.length === 0) {
      throw new Error(`Alpaca open-reference response is missing ${symbol}`);
    }
    if (symbolBars.length !== 1) {
      throw new Error(`Alpaca open-reference response has ambiguous ${symbol} bars`);
    }
    const bar = record(symbolBars[0], `${symbol} first-minute bar`);
    const barStart = timestamp(text(bar.t, `${symbol}.t`), `${symbol}.t`);
    if (barStart !== expectedOpenAt) {
      throw new Error(`Alpaca returned a wrong first-minute bar for ${symbol}`);
    }
    const value = canonicalJsonNumber(
      volumeParticipation ? bar.vw : bar.o,
      volumeParticipation ? `${symbol}.vw` : `${symbol}.o`,
    );
    if (value === "0") throw new Error(`${symbol} open reference must be positive`);
    const observedVolume = volumeParticipation
      ? canonicalJsonNumber(bar.v, `${symbol}.v`)
      : undefined;
    if (
      observedVolume !== undefined
      && !/^(?:0|[1-9]\d*)$/.test(observedVolume)
    ) {
      throw new TypeError(`${symbol} first-minute volume must be whole shares`);
    }
    const factMaterial = [
      symbol,
      barStart,
      "USD",
      value,
      ...(observedVolume === undefined ? [] : [observedVolume]),
      normalizerVersion,
    ].join("\u001f");
    return Object.freeze({
      barStart,
      currency: "USD",
      factSha256: sha256(factMaterial),
      symbol,
      value,
      ...(observedVolume === undefined ? {} : { observedVolume }),
    });
  });
  const responseSha256 = sha256(rawBody);
  const sourceMaterial = {
    provider: "alpaca",
    dataset: "us_stock_intraday_open_references",
    endpointBaseUrl: config.dataUrl,
    feed: config.feed,
    adjustment: "raw",
    timeframe: "1Min",
    normalizerVersion,
    licenseScope: config.licenseScope,
  } as const;
  const source = Object.freeze({
    ...sourceMaterial,
    versionKey: sourceVersionKey,
    configSha256: sha256(JSON.stringify(sourceMaterial)),
    effectiveFrom: timestamp(config.sourceEffectiveFrom, "sourceEffectiveFrom"),
  });
  const canonicalPayload = {
    expectedOpenAt,
    feed: config.feed,
    method,
    observedAt,
    references: Object.freeze(references),
    requestFingerprint,
    responseSha256,
    schema: volumeParticipation
      ? "twofold.alpaca_open_reference_delivery/v2" as const
      : "twofold.alpaca_open_reference_delivery/v1" as const,
    sessionDate,
    sourceVersionKey,
  };
  const serialized = canonicalJson(canonicalPayload);
  const providerRequestId = response.headers.get("x-request-id")?.trim() || undefined;
  return Object.freeze({
    schema: volumeParticipation
      ? "twofold.alpaca_open_reference_delivery/v2"
      : "twofold.alpaca_open_reference_delivery/v1",
    method,
    source,
    idempotencyKey:
      `alpaca-open:${sourceVersionKey}:${requestFingerprint}:`
      + `${responseSha256}:${sha256(observedAt)}`,
    requestFingerprint,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    observedAt,
    sessionDate,
    expectedOpenAt,
    rawBody,
    byteSize: Buffer.byteLength(rawBody),
    responseSha256,
    objectPath: `raw/alpaca/${responseSha256.slice(0, 2)}/${responseSha256}.json`,
    storageBucket: PRIVATE_ARTIFACT_BUCKET,
    references: Object.freeze(references),
    canonicalJson: serialized,
    contentSha256: sha256(serialized),
  });
}

function validateConfig(config: AlpacaOpenReferenceConfig): void {
  const parsed = new URL(config.dataUrl);
  if (
    parsed.origin !== TRUSTED_DATA_ORIGIN
    || parsed.pathname !== "/"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new TypeError(`dataUrl must use ${TRUSTED_DATA_ORIGIN}`);
  if (config.apiKeyId.trim() === "" || config.apiSecretKey.trim() === "") {
    throw new TypeError("Alpaca credentials are required");
  }
  if (config.feed !== "sip") {
    throw new TypeError("open-reference method requires the Alpaca SIP feed");
  }
  if (
    config.symbols.length === 0
    || config.symbols.some((symbol) => !SYMBOL_PATTERN.test(symbol))
    || config.symbols.some((symbol, index) => index > 0 && symbol <= config.symbols[index - 1]!)
  ) throw new TypeError("symbols must be sorted unique tickers");
  if (
    config.sourceVersionKey.trim() === ""
    || config.liquiditySourceVersionKey.trim() === ""
    || config.licenseScope.trim() === ""
  ) {
    throw new TypeError("source identity is required");
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${field} must be a string`);
  }
  return value;
}

function timestamp(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} is invalid`);
  return parsed.toISOString();
}

function date(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}
