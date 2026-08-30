import { createHash } from "node:crypto";

import { compareDecimals, divideDecimals, normalizeDecimal } from "@twofold/core";

import { boundedProviderSignal } from "./provider-deadline.js";

const ECB_ORIGIN = "https://www.ecb.europa.eu";
const DEFAULT_ECB_SOURCE =
  `${ECB_ORIGIN}/stats/eurofxref/eurofxref-hist-90d.xml`;

export interface EcbFxConfig {
  readonly sourceUrl: string;
}

export interface EcbUsdCnyDelivery {
  readonly schema: "twofold.ecb_usd_cny_delivery/v1";
  readonly sourceUrl: string;
  readonly rawXml: string;
  readonly rawBodySha256: string;
  readonly observedAt: string;
  readonly envelopeCanonicalJson: string;
  readonly envelopeSha256: string;
  readonly objectPath: string;
  readonly cross: EcbUsdCnyReferenceCross & { readonly status: "ESTIMATED" };
  readonly crossCanonicalJson: string;
  readonly crossSha256: string;
}

export function loadEcbFxConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): EcbFxConfig {
  const source = new URL(
    environment.TWOFOLD_ECB_FX_URL?.trim() || DEFAULT_ECB_SOURCE,
  );
  if (
    source.origin !== ECB_ORIGIN
    || source.pathname !== "/stats/eurofxref/eurofxref-hist-90d.xml"
    || source.username !== ""
    || source.password !== ""
    || source.search !== ""
    || source.hash !== ""
  ) {
    throw new Error("TWOFOLD_ECB_FX_URL must use the trusted ECB source");
  }
  return Object.freeze({ sourceUrl: source.toString() });
}

export async function fetchEcbUsdCnyReferenceCross(
  config: EcbFxConfig,
  options: {
    readonly effectiveDate: string;
    /** Freeze the latest source date no later than the requested date. */
    readonly allowPreviousDate?: boolean;
    readonly fetchImplementation?: typeof fetch;
    readonly now?: () => Date;
    readonly signal?: AbortSignal;
  },
): Promise<EcbUsdCnyDelivery> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => new Date());
  const providerSignal = boundedProviderSignal(options.signal);
  const response = await fetchImplementation(config.sourceUrl, {
    method: "GET",
    headers: { Accept: "application/xml,text/xml" },
    redirect: "error",
    signal: providerSignal,
  });
  if (!response.ok) {
    throw new Error(`ECB source fetch failed with HTTP ${response.status}`);
  }
  const finalUrl = new URL(response.url);
  if (finalUrl.toString() !== config.sourceUrl) {
    throw new Error("ECB response left the frozen trusted source");
  }
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/xml" && contentType !== "text/xml") {
    throw new Error(`ECB returned unsupported content type: ${contentType ?? "missing"}`);
  }
  const rawXml = await response.text();
  const observedAt = now().toISOString();
  const effectiveDate = options.allowPreviousDate === true
    ? latestReferenceDateAtOrBefore(rawXml, options.effectiveDate)
    : options.effectiveDate;
  const cross = Object.freeze({
    ...parseEcbUsdCnyReferenceCross({
      xml: rawXml,
      effectiveDate,
      observedAt,
    }),
    status: "ESTIMATED" as const,
  });
  const rawBodySha256 = sha256(rawXml);
  const envelopeCanonicalJson = canonicalJson({
    schema: "twofold.raw_source_envelope/v1",
    sourceUrl: config.sourceUrl,
    contentType,
    encoding: "base64",
    rawBodySha256,
    rawBodyBase64: Buffer.from(rawXml, "utf8").toString("base64"),
    observedAt,
  });
  const envelopeSha256 = sha256(envelopeCanonicalJson);
  const crossCanonicalJson = canonicalJson(cross);
  const crossSha256 = sha256(crossCanonicalJson);
  return Object.freeze({
    schema: "twofold.ecb_usd_cny_delivery/v1",
    sourceUrl: config.sourceUrl,
    rawXml,
    rawBodySha256,
    observedAt,
    envelopeCanonicalJson,
    envelopeSha256,
    objectPath: `competition-sources/ecb/${envelopeSha256}.json`,
    cross,
    crossCanonicalJson,
    crossSha256,
  });
}

function latestReferenceDateAtOrBefore(xml: string, requestedDate: string): string {
  requireDate(requestedDate);
  const dates = [...xml.matchAll(/\btime=["'](\d{4}-\d{2}-\d{2})["']/g)]
    .map((match) => match[1]!)
    .filter((date) => date <= requestedDate)
    .sort((left, right) => right.localeCompare(left, "en"));
  const selected = dates[0];
  if (selected === undefined) {
    throw new TypeError(`ECB has no reference date on or before ${requestedDate}`);
  }
  return selected;
}

export interface EcbUsdCnyReferenceCross {
  readonly schema: "twofold.ecb_usd_cny_reference_cross/v1";
  readonly effectiveDate: string;
  readonly eurToUsd: string;
  readonly eurToCny: string;
  readonly cnyPerUsd: string;
  readonly derivation: "EUR_CNY_DIV_EUR_USD_HALF_UP_12";
  readonly authority: "ECB_REFERENCE_CROSS";
  readonly observedAt: string;
  readonly availableAt: string;
}

/**
 * ECB reference rates are quoted as units of currency per EUR. The USD/CNY
 * cross is therefore EUR/CNY divided by EUR/USD. Retrieval time is used as the
 * conservative availability fence; no earlier publication time is invented.
 */
export function parseEcbUsdCnyReferenceCross(input: {
  readonly xml: string;
  readonly effectiveDate: string;
  readonly observedAt: string;
}): EcbUsdCnyReferenceCross {
  requireDate(input.effectiveDate);
  const observedAt = requireTimestamp(input.observedAt);
  if (input.effectiveDate > observedAt.slice(0, 10)) {
    throw new RangeError("ECB effective date cannot follow observation");
  }
  const datePattern = new RegExp(
    `<Cube\\s+time=["']${escapeRegex(input.effectiveDate)}["'][^>]*>([\\s\\S]*?)<\\/Cube>`,
  );
  const dateBlock = datePattern.exec(input.xml)?.[1];
  if (dateBlock === undefined) {
    throw new TypeError(`ECB reference date is absent: ${input.effectiveDate}`);
  }
  const rates = new Map<string, string>();
  for (const match of dateBlock.matchAll(/<Cube\s+([^>]*?)\s*\/>/g)) {
    const attributes = match[1] ?? "";
    const currency = /\bcurrency=["']([A-Z]{3})["']/.exec(attributes)?.[1];
    const rate = /\brate=["']([^"']+)["']/.exec(attributes)?.[1];
    if (currency !== undefined && rate !== undefined) rates.set(currency, rate);
  }
  const eurToUsd = positiveRate(rates.get("USD"), "USD");
  const eurToCny = positiveRate(rates.get("CNY"), "CNY");

  return Object.freeze({
    schema: "twofold.ecb_usd_cny_reference_cross/v1",
    effectiveDate: input.effectiveDate,
    eurToUsd,
    eurToCny,
    cnyPerUsd: divideDecimals(eurToCny, eurToUsd, 12, "HALF_UP"),
    derivation: "EUR_CNY_DIV_EUR_USD_HALF_UP_12",
    authority: "ECB_REFERENCE_CROSS",
    observedAt,
    availableAt: observedAt,
  });
}

function positiveRate(value: string | undefined, currency: string): string {
  if (value === undefined) throw new TypeError(`ECB ${currency} rate is absent`);
  const normalized = normalizeDecimal(value);
  if (compareDecimals(normalized, "0") <= 0) {
    throw new RangeError(`ECB ${currency} rate must be positive`);
  }
  return normalized;
}

function requireDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("ECB effectiveDate must use YYYY-MM-DD");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== value) {
    throw new TypeError("ECB effectiveDate must be a calendar date");
  }
}

function requireTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError("ECB observedAt must be canonical UTC milliseconds");
  }
  const parsed = new Date(value);
  if (parsed.toISOString() !== value) throw new TypeError("ECB observedAt is invalid");
  return value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item === null || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, sort(record[key])]),
    );
  };
  return JSON.stringify(sort(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
