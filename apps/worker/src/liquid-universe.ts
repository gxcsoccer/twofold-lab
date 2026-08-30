import { createHash } from "node:crypto";

import {
  addDecimals,
  compareDecimals,
  divideDecimals,
  multiplyDecimals,
  normalizeDecimal,
  subtractDecimals,
} from "@twofold/core";

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_SHAPE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

export interface LiquidUniverseAsset {
  readonly assetId: string;
  readonly symbol: string;
  readonly name: string;
  readonly exchange: string;
  readonly status: string;
  readonly tradable: boolean;
}

export interface NasdaqStockCatalogEntry {
  readonly symbol: string;
  readonly name: string;
  readonly country: string;
  readonly ipoYear: string;
  readonly latestPrice: string;
  readonly latestVolume: string;
}

export interface NasdaqTradedSecurity {
  readonly symbol: string;
  readonly nasdaqTraded: boolean;
  readonly etf: boolean;
  readonly testIssue: boolean;
}

export interface LiquidUniverseBar {
  readonly symbol: string;
  readonly barDate: string;
  readonly closePrice: string;
  readonly volume: string;
}

export interface LiquidUniversePortfolioConstraints {
  readonly minimumPositions: string;
  readonly maximumPositions: string;
  readonly maximumPositionWeightBps: string;
  readonly minimumCashWeightBps: string;
}

export interface LiquidUniversePolicy {
  readonly name: string;
  readonly size: string;
  readonly minimumPriceUsd: string;
  readonly minimumMedianDollarVolumeUsd: string;
  readonly medianDollarVolumeSessions: string;
  readonly minimumHistorySessions: string;
  readonly allowedExchanges: readonly string[];
  readonly mandatorySymbols: readonly string[];
  readonly constraints: LiquidUniversePortfolioConstraints;
}

export interface LiquidUniverseSourceReference {
  readonly url: string;
  readonly responseSha256: string;
}

export interface LiquidUniverseSources {
  readonly observedAt: string;
  readonly alpacaAssets: LiquidUniverseSourceReference;
  readonly nasdaqStockScreener: LiquidUniverseSourceReference;
  readonly nasdaqTradedDirectory: LiquidUniverseSourceReference;
  readonly alpacaDailyBars: LiquidUniverseSourceReference;
}

export interface LiquidUniverseCandidate {
  readonly symbol: string;
  readonly assetId: string;
  readonly issuer: string;
  readonly issuerTaxResidency: string;
  readonly primaryExchange: string;
  readonly effectiveFrom: string;
  readonly asOfSessionDate: string;
  readonly historyStartDate: string;
  readonly historySessionCount: string;
  readonly latestClosePrice: string;
  readonly medianDollarVolume20d: string;
  readonly return5dBps: string;
  readonly return20dBps: string;
  readonly return60dBps: string;
  readonly liquidityRank: string;
  readonly selected: boolean;
  readonly selectionReason: "LIQUIDITY_RANK" | "MANDATORY_CURRENT_HOLDING" | null;
}

export interface LiquidUniverseMember {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly instrumentType: "common_stock";
  readonly primaryExchange: string;
  readonly issuerTaxResidency: string;
  readonly effectiveFrom: string;
  readonly issuer: string;
  readonly liquidityRank: string;
  readonly selectionReason: "LIQUIDITY_RANK" | "MANDATORY_CURRENT_HOLDING";
}

export interface LiquidUniverseFreezeArtifact {
  readonly schema: "twofold.liquid_universe_freeze/v1";
  readonly name: string;
  readonly asOfSessionDate: string;
  readonly frozenAt: string;
  readonly policy: LiquidUniversePolicy;
  readonly sources: LiquidUniverseSources;
  readonly eligibleCandidateCount: string;
  readonly members: readonly LiquidUniverseMember[];
  readonly candidates: readonly LiquidUniverseCandidate[];
}

export interface LiquidUniverseFreeze {
  readonly artifact: LiquidUniverseFreezeArtifact;
  readonly canonicalJson: string;
  readonly sha256: string;
}

interface RankedCandidate {
  readonly asset: LiquidUniverseAsset;
  readonly stock: NasdaqStockCatalogEntry;
  readonly features: Omit<
    LiquidUniverseCandidate,
    "liquidityRank" | "selected" | "selectionReason"
  >;
}

/**
 * Bound the expensive history request with source-declared last-session dollar
 * volume. Final membership never trusts this one-day rank: it is recomputed
 * from the frozen multi-session bars below.
 */
export function prefilterLiquidUniverseCandidates(input: {
  readonly asOfSessionDate: string;
  readonly limit: string;
  readonly policy: LiquidUniversePolicy;
  readonly assets: readonly LiquidUniverseAsset[];
  readonly stockCatalog: readonly NasdaqStockCatalogEntry[];
  readonly tradedDirectory: readonly NasdaqTradedSecurity[];
}): readonly string[] {
  const asOfSessionDate = date(input.asOfSessionDate, "asOfSessionDate");
  const limit = Number(positiveInteger(input.limit, "limit"));
  const policy = validatePolicy(input.policy);
  if (limit < Number(policy.size)) {
    throw new RangeError("prefilter limit cannot be smaller than universe size");
  }
  const assetBySymbol = uniqueBySymbol(input.assets, "assets", validateAsset);
  const stockBySymbol = uniqueBySymbol(
    input.stockCatalog,
    "stockCatalog",
    validateStock,
  );
  const directoryBySymbol = uniqueBySymbol(
    input.tradedDirectory,
    "tradedDirectory",
    validateDirectoryEntry,
  );
  const allowedExchanges = new Set(policy.allowedExchanges);
  const mandatory = new Set(policy.mandatorySymbols);
  const cutoffYear = Number(asOfSessionDate.slice(0, 4));
  const eligible = [...assetBySymbol.values()].filter((asset) => {
    const stock = stockBySymbol.get(asset.symbol);
    const directory = directoryBySymbol.get(asset.symbol);
    return asset.status === "active"
      && asset.tradable
      && allowedExchanges.has(asset.exchange)
      && stock !== undefined
      && (stock.country === "United States" || mandatory.has(asset.symbol))
      && countryCode(stock.country) !== null
      && commonEquityName(stock.name)
      && Number(stock.ipoYear) <= cutoffYear
      && compareDecimals(stock.latestPrice, policy.minimumPriceUsd) >= 0
      && directory !== undefined
      && directory.nasdaqTraded
      && !directory.etf
      && !directory.testIssue;
  }).map((asset) => ({
    symbol: asset.symbol,
    dollarVolume: multiplyDecimals(
      stockBySymbol.get(asset.symbol)!.latestPrice,
      stockBySymbol.get(asset.symbol)!.latestVolume,
    ),
  })).sort((left, right) =>
    -compareDecimals(left.dollarVolume, right.dollarVolume)
    || left.symbol.localeCompare(right.symbol, "en"));
  const available = new Set(eligible.map((candidate) => candidate.symbol));
  for (const symbol of policy.mandatorySymbols) {
    if (!available.has(symbol)) {
      throw new TypeError(`mandatory symbol ${symbol} is ineligible for discovery`);
    }
  }
  const selected = new Set(policy.mandatorySymbols);
  for (const candidate of eligible) {
    if (selected.size === limit) break;
    selected.add(candidate.symbol);
  }
  if (selected.size < limit) {
    throw new RangeError(`prefilter has only ${selected.size} eligible candidates`);
  }
  return Object.freeze([...selected].sort());
}

export function buildLiquidUniverseFreeze(input: {
  readonly asOfSessionDate: string;
  readonly policy: LiquidUniversePolicy;
  readonly sources: LiquidUniverseSources;
  readonly assets: readonly LiquidUniverseAsset[];
  readonly stockCatalog: readonly NasdaqStockCatalogEntry[];
  readonly tradedDirectory: readonly NasdaqTradedSecurity[];
  readonly bars: readonly LiquidUniverseBar[];
  readonly instrumentIdOverrides?: Readonly<Record<string, string>>;
  readonly effectiveFromOverrides?: Readonly<Record<string, string>>;
  readonly issuerTaxResidencyOverrides?: Readonly<Record<string, string>>;
  readonly issuerOverrides?: Readonly<Record<string, string>>;
}): LiquidUniverseFreeze {
  const asOfSessionDate = date(input.asOfSessionDate, "asOfSessionDate");
  const policy = validatePolicy(input.policy);
  const sources = validateSources(input.sources);
  if (sources.observedAt.slice(0, 10) < asOfSessionDate) {
    throw new TypeError("universe sources cannot predate the as-of session");
  }

  const assetBySymbol = uniqueBySymbol(input.assets, "assets", validateAsset);
  const stockBySymbol = uniqueBySymbol(
    input.stockCatalog,
    "stockCatalog",
    validateStock,
  );
  const directoryBySymbol = uniqueBySymbol(
    input.tradedDirectory,
    "tradedDirectory",
    validateDirectoryEntry,
  );
  const barsBySymbol = groupBars(input.bars, asOfSessionDate);
  const allowedExchanges = new Set(policy.allowedExchanges);
  const mandatory = new Set(policy.mandatorySymbols);
  const ranked: RankedCandidate[] = [];

  for (const symbol of [...assetBySymbol.keys()].sort()) {
    const asset = assetBySymbol.get(symbol)!;
    const stock = stockBySymbol.get(symbol);
    const directory = directoryBySymbol.get(symbol);
    if (
      asset.status !== "active"
      || !asset.tradable
      || !allowedExchanges.has(asset.exchange)
      || stock === undefined
      || (stock.country !== "United States" && !mandatory.has(symbol))
      || countryCode(stock.country) === null
      || !commonEquityName(stock.name)
      || directory === undefined
      || !directory.nasdaqTraded
      || directory.etf
      || directory.testIssue
    ) continue;
    const symbolBars = barsBySymbol.get(symbol) ?? [];
    const features = researchFeatures({
      asset,
      stock,
      bars: symbolBars,
      asOfSessionDate,
      policy,
    });
    if (features !== null) {
      const effectiveFrom = input.effectiveFromOverrides?.[symbol]
        ?? features.effectiveFrom;
      date(effectiveFrom, `effectiveFromOverrides.${symbol}`);
      const issuerTaxResidency = input.issuerTaxResidencyOverrides?.[symbol]
        ?? features.issuerTaxResidency;
      pattern(
        issuerTaxResidency,
        /^[A-Z]{2}$/,
        `issuerTaxResidencyOverrides.${symbol}`,
      );
      ranked.push({
        asset,
        stock,
        features: Object.freeze({
          ...features,
          issuer: input.issuerOverrides?.[symbol] === undefined
            ? features.issuer
            : identity(input.issuerOverrides[symbol]!, `issuerOverrides.${symbol}`),
          effectiveFrom,
          issuerTaxResidency,
        }),
      });
    }
  }

  ranked.sort((left, right) =>
    -compareDecimals(
      left.features.medianDollarVolume20d,
      right.features.medianDollarVolume20d,
    ) || left.asset.symbol.localeCompare(right.asset.symbol, "en")
  );
  const size = Number(policy.size);
  for (const symbol of mandatory) {
    if (!ranked.some((candidate) => candidate.asset.symbol === symbol)) {
      throw new TypeError(`mandatory symbol ${symbol} is ineligible`);
    }
  }
  if (ranked.length < size) {
    throw new RangeError(
      `US Liquid ${size} has only ${ranked.length} eligible candidates`,
    );
  }

  const selected = new Set<string>(mandatory);
  for (const candidate of ranked) {
    if (selected.size === size) break;
    selected.add(candidate.asset.symbol);
  }
  const overrides = input.instrumentIdOverrides ?? {};
  for (const [symbol, instrumentId] of Object.entries(overrides)) {
    ticker(symbol, `instrumentIdOverrides.${symbol}`);
    uuid(instrumentId, `instrumentIdOverrides.${symbol}`);
  }

  const candidates = ranked.map((candidate, index): LiquidUniverseCandidate => {
    const symbol = candidate.asset.symbol;
    const isSelected = selected.has(symbol);
    return Object.freeze({
      ...candidate.features,
      liquidityRank: String(index + 1),
      selected: isSelected,
      selectionReason: !isSelected
        ? null
        : mandatory.has(symbol)
          ? "MANDATORY_CURRENT_HOLDING"
          : "LIQUIDITY_RANK",
    });
  });
  const members = candidates
    .filter((candidate) => candidate.selected)
    .map((candidate): LiquidUniverseMember => Object.freeze({
      instrumentId: uuid(
        overrides[candidate.symbol]
          ?? stableInstrumentId(candidate.assetId, candidate.symbol),
        `instrumentId.${candidate.symbol}`,
      ),
      symbol: candidate.symbol,
      instrumentType: "common_stock",
      primaryExchange: candidate.primaryExchange,
      issuerTaxResidency: candidate.issuerTaxResidency,
      effectiveFrom: candidate.effectiveFrom,
      issuer: candidate.issuer,
      liquidityRank: candidate.liquidityRank,
      selectionReason: candidate.selectionReason!,
    }));

  const artifact = deepFreeze({
    schema: "twofold.liquid_universe_freeze/v1" as const,
    name: policy.name,
    asOfSessionDate,
    frozenAt: sources.observedAt,
    policy,
    sources,
    eligibleCandidateCount: String(candidates.length),
    members,
    candidates,
  });
  const canonicalJson = JSON.stringify(artifact);
  return Object.freeze({
    artifact,
    canonicalJson,
    sha256: createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
  });
}

function researchFeatures(input: {
  readonly asset: LiquidUniverseAsset;
  readonly stock: NasdaqStockCatalogEntry;
  readonly bars: readonly LiquidUniverseBar[];
  readonly asOfSessionDate: string;
  readonly policy: LiquidUniversePolicy;
}): RankedCandidate["features"] | null {
  const minimumHistory = Number(input.policy.minimumHistorySessions);
  const medianSessions = Number(input.policy.medianDollarVolumeSessions);
  if (
    input.bars.length < minimumHistory
    || input.bars.length < 61
    || input.bars.at(-1)?.barDate !== input.asOfSessionDate
  ) return null;
  const latest = input.bars.at(-1)!;
  if (compareDecimals(latest.closePrice, input.policy.minimumPriceUsd) < 0) {
    return null;
  }
  const dollarVolumes = input.bars.slice(-medianSessions).map((bar) =>
    multiplyDecimals(bar.closePrice, bar.volume));
  const medianDollarVolume20d = median(dollarVolumes);
  if (
    compareDecimals(
      medianDollarVolume20d,
      input.policy.minimumMedianDollarVolumeUsd,
    ) < 0
  ) return null;
  return Object.freeze({
    symbol: input.asset.symbol,
    assetId: input.asset.assetId,
    issuer: input.stock.name,
    issuerTaxResidency: countryCode(input.stock.country)!,
    primaryExchange: input.asset.exchange,
    effectiveFrom: `${input.stock.ipoYear}-01-01`,
    asOfSessionDate: input.asOfSessionDate,
    historyStartDate: input.bars[0]!.barDate,
    historySessionCount: String(input.bars.length),
    latestClosePrice: latest.closePrice,
    medianDollarVolume20d,
    return5dBps: returnBps(latest.closePrice, input.bars.at(-6)!.closePrice),
    return20dBps: returnBps(latest.closePrice, input.bars.at(-21)!.closePrice),
    return60dBps: returnBps(latest.closePrice, input.bars.at(-61)!.closePrice),
  });
}

function returnBps(current: string, prior: string): string {
  return divideDecimals(
    multiplyDecimals(subtractDecimals(current, prior), "10000"),
    prior,
    0,
    "HALF_UP",
  );
}

function median(values: readonly string[]): string {
  if (values.length === 0) throw new RangeError("median requires values");
  const sorted = [...values].sort(compareDecimals);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : divideDecimals(
        addDecimals(sorted[middle - 1]!, sorted[middle]!),
        "2",
        0,
        "HALF_UP",
      );
}

function groupBars(
  input: readonly LiquidUniverseBar[],
  asOfSessionDate: string,
): ReadonlyMap<string, readonly LiquidUniverseBar[]> {
  const grouped = new Map<string, LiquidUniverseBar[]>();
  const seen = new Set<string>();
  input.forEach((value, index) => {
    const symbol = ticker(value.symbol, `bars[${index}].symbol`);
    const barDate = date(value.barDate, `bars[${index}].barDate`);
    if (barDate > asOfSessionDate) {
      throw new TypeError("universe history contains future data");
    }
    const closePrice = positiveDecimal(
      value.closePrice,
      `bars[${index}].closePrice`,
    );
    const volume = positiveInteger(value.volume, `bars[${index}].volume`);
    const key = `${symbol}:${barDate}`;
    if (seen.has(key)) throw new TypeError(`duplicate universe bar ${key}`);
    seen.add(key);
    const bar = Object.freeze({ symbol, barDate, closePrice, volume });
    grouped.set(symbol, [...(grouped.get(symbol) ?? []), bar]);
  });
  for (const bars of grouped.values()) {
    bars.sort((left, right) => left.barDate.localeCompare(right.barDate, "en"));
  }
  return grouped;
}

function uniqueBySymbol<T extends { readonly symbol: string }>(
  values: readonly T[],
  field: string,
  validate: (value: T, field: string) => T,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  values.forEach((value, index) => {
    const parsed = validate(value, `${field}[${index}]`);
    if (result.has(parsed.symbol)) {
      throw new TypeError(`${field} contains duplicate symbol ${parsed.symbol}`);
    }
    result.set(parsed.symbol, parsed);
  });
  return result;
}

function validateAsset(value: LiquidUniverseAsset, field: string): LiquidUniverseAsset {
  return Object.freeze({
    assetId: pattern(value.assetId, UUID_SHAPE_PATTERN, `${field}.assetId`),
    symbol: ticker(value.symbol, `${field}.symbol`),
    name: identity(value.name, `${field}.name`),
    exchange: identity(value.exchange, `${field}.exchange`),
    status: identity(value.status, `${field}.status`),
    tradable: boolean(value.tradable, `${field}.tradable`),
  });
}

function validateStock(
  value: NasdaqStockCatalogEntry,
  field: string,
): NasdaqStockCatalogEntry {
  const ipoYear = pattern(value.ipoYear, /^\d{4}$/, `${field}.ipoYear`);
  return Object.freeze({
    symbol: ticker(value.symbol, `${field}.symbol`),
    name: identity(value.name, `${field}.name`),
    country: identity(value.country, `${field}.country`),
    ipoYear,
    latestPrice: positiveDecimal(value.latestPrice, `${field}.latestPrice`),
    latestVolume: positiveInteger(value.latestVolume, `${field}.latestVolume`),
  });
}

function validateDirectoryEntry(
  value: NasdaqTradedSecurity,
  field: string,
): NasdaqTradedSecurity {
  return Object.freeze({
    symbol: ticker(value.symbol, `${field}.symbol`),
    nasdaqTraded: boolean(value.nasdaqTraded, `${field}.nasdaqTraded`),
    etf: boolean(value.etf, `${field}.etf`),
    testIssue: boolean(value.testIssue, `${field}.testIssue`),
  });
}

function validatePolicy(value: LiquidUniversePolicy): LiquidUniversePolicy {
  const size = positiveInteger(value.size, "policy.size");
  const minimumHistorySessions = positiveInteger(
    value.minimumHistorySessions,
    "policy.minimumHistorySessions",
  );
  const medianSessions = positiveInteger(
    value.medianDollarVolumeSessions,
    "policy.medianDollarVolumeSessions",
  );
  if (Number(minimumHistorySessions) < 61) {
    throw new RangeError("minimumHistorySessions must be at least 61");
  }
  if (Number(medianSessions) > Number(minimumHistorySessions)) {
    throw new RangeError("median window cannot exceed minimum history");
  }
  const allowedExchanges = sortedUnique(
    value.allowedExchanges.map((exchange, index) =>
      pattern(exchange, /^[A-Z][A-Z0-9_]{1,31}$/, `allowedExchanges[${index}]`)),
    "allowedExchanges",
  );
  const mandatorySymbols = sortedUnique(
    value.mandatorySymbols.map((symbol, index) =>
      ticker(symbol, `mandatorySymbols[${index}]`)),
    "mandatorySymbols",
  );
  if (mandatorySymbols.length > Number(size)) {
    throw new RangeError("mandatory symbols exceed universe size");
  }
  const constraints = {
    minimumPositions: positiveInteger(
      value.constraints.minimumPositions,
      "constraints.minimumPositions",
    ),
    maximumPositions: positiveInteger(
      value.constraints.maximumPositions,
      "constraints.maximumPositions",
    ),
    maximumPositionWeightBps: positiveInteger(
      value.constraints.maximumPositionWeightBps,
      "constraints.maximumPositionWeightBps",
    ),
    minimumCashWeightBps: positiveInteger(
      value.constraints.minimumCashWeightBps,
      "constraints.minimumCashWeightBps",
    ),
  };
  if (
    Number(constraints.minimumPositions) > Number(constraints.maximumPositions)
    || Number(constraints.maximumPositions) > Number(size)
    || Number(constraints.maximumPositionWeightBps) > 10_000
    || Number(constraints.minimumCashWeightBps) > 10_000
  ) throw new RangeError("portfolio constraints are inconsistent");
  return deepFreeze({
    name: identity(value.name, "policy.name"),
    size,
    minimumPriceUsd: positiveDecimal(value.minimumPriceUsd, "minimumPriceUsd"),
    minimumMedianDollarVolumeUsd: positiveDecimal(
      value.minimumMedianDollarVolumeUsd,
      "minimumMedianDollarVolumeUsd",
    ),
    medianDollarVolumeSessions: medianSessions,
    minimumHistorySessions,
    allowedExchanges,
    mandatorySymbols,
    constraints,
  });
}

function validateSources(value: LiquidUniverseSources): LiquidUniverseSources {
  const source = (candidate: LiquidUniverseSourceReference, field: string) => {
    const url = new URL(identity(candidate.url, `${field}.url`));
    if (url.protocol !== "https:") throw new TypeError(`${field}.url must use HTTPS`);
    return Object.freeze({
      url: url.toString(),
      responseSha256: pattern(
        candidate.responseSha256,
        SHA256_PATTERN,
        `${field}.responseSha256`,
      ),
    });
  };
  return deepFreeze({
    observedAt: timestamp(value.observedAt, "sources.observedAt"),
    alpacaAssets: source(value.alpacaAssets, "sources.alpacaAssets"),
    nasdaqStockScreener: source(
      value.nasdaqStockScreener,
      "sources.nasdaqStockScreener",
    ),
    nasdaqTradedDirectory: source(
      value.nasdaqTradedDirectory,
      "sources.nasdaqTradedDirectory",
    ),
    alpacaDailyBars: source(
      value.alpacaDailyBars,
      "sources.alpacaDailyBars",
    ),
  });
}

function sortedUnique(values: readonly string[], field: string): readonly string[] {
  const sorted = [...values].sort();
  if (sorted.length === 0 || new Set(sorted).size !== sorted.length) {
    throw new TypeError(`${field} must be a non-empty unique list`);
  }
  return Object.freeze(sorted);
}

function positiveDecimal(value: string, field: string): string {
  const parsed = normalizeDecimal(pattern(
    value,
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/,
    field,
  ));
  if (parsed !== value || compareDecimals(parsed, "0") <= 0) {
    throw new TypeError(`${field} must be a canonical positive decimal`);
  }
  return parsed;
}

function positiveInteger(value: string, field: string): string {
  return pattern(value, POSITIVE_INTEGER_PATTERN, field);
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
  return value;
}

function ticker(value: string, field: string): string {
  return pattern(value, SYMBOL_PATTERN, field);
}

function uuid(value: string, field: string): string {
  return pattern(value, UUID_PATTERN, field);
}

function date(value: string, field: string): string {
  const parsed = pattern(value, DATE_PATTERN, field);
  if (new Date(`${parsed}T00:00:00.000Z`).toISOString().slice(0, 10) !== parsed) {
    throw new TypeError(`${field} must be a real calendar date`);
  }
  return parsed;
}

function timestamp(value: string, field: string): string {
  const parsed = new Date(identity(value, field));
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${field} is invalid`);
  const canonical = parsed.toISOString();
  if (canonical !== value) throw new TypeError(`${field} must be canonical UTC`);
  return canonical;
}

function pattern(value: string, expected: RegExp, field: string): string {
  const parsed = identity(value, field);
  if (!expected.test(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function identity(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function countryCode(value: string): string | null {
  return value === "United States" ? "US"
    : value === "Canada" ? "CA"
    : null;
}

function commonEquityName(value: string): boolean {
  return /\b(?:Common Stock|Common Shares|Capital Stock)\b/i.test(value)
    && !/\b(?:Preferred|Warrant|Rights?|Units?|Notes?|Bonds?|Debentures?)\b/i
      .test(value);
}

function stableInstrumentId(assetId: string, symbol: string): string {
  if (UUID_PATTERN.test(assetId)) return assetId;
  const chars = createHash("sha256").update(
    `twofold.alpaca_asset_instrument/v1:${assetId}:${symbol}`,
    "utf8",
  ).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}
