import { isLosslessNumber, parse } from "lossless-json";

import { canonicalJson, sha256 } from "./arena-inputs.js";
import { canonicalJsonNumber, PRIVATE_ARTIFACT_BUCKET } from "./market-data.js";
import { loadAlpacaMarketDataConfig } from "./market-data.js";
import { boundedProviderSignal } from "./provider-deadline.js";

const TRUSTED_DATA_ORIGIN = "https://data.alpaca.markets";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/;
const POSITIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

export const ALPACA_CORPORATE_ACTION_NORMALIZER_VERSION =
  "alpaca-corporate-actions-v1";

const COLLECTION_TYPES = Object.freeze({
  reverse_splits: "REVERSE_SPLIT",
  forward_splits: "FORWARD_SPLIT",
  unit_splits: "UNIT_SPLIT",
  cash_dividends: "CASH_DIVIDEND",
  stock_dividends: "STOCK_DIVIDEND",
  spin_offs: "SPIN_OFF",
  cash_mergers: "CASH_MERGER",
  stock_mergers: "STOCK_MERGER",
  stock_and_cash_mergers: "STOCK_AND_CASH_MERGER",
  redemptions: "REDEMPTION",
  name_changes: "NAME_CHANGE",
  worthless_removals: "WORTHLESS_REMOVAL",
  rights_distributions: "RIGHTS_DISTRIBUTION",
  partial_calls: "PARTIAL_CALL",
  reorganizations: "REORGANIZATION",
  capital_gains_distributions: "CAPITAL_GAINS_DISTRIBUTION",
} as const);

export type AlpacaCorporateActionType =
  (typeof COLLECTION_TYPES)[keyof typeof COLLECTION_TYPES];

export interface AlpacaCorporateActionConfig {
  readonly apiKeyId: string;
  readonly apiSecretKey: string;
  readonly dataUrl: string;
  readonly symbols: readonly string[];
  readonly sourceVersionKey: string;
  readonly sourceEffectiveFrom: string;
  readonly licenseScope: string;
}

export function loadAlpacaCorporateActionConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AlpacaCorporateActionConfig {
  const market = loadAlpacaMarketDataConfig(environment);
  return Object.freeze({
    apiKeyId: market.apiKeyId,
    apiSecretKey: market.apiSecretKey,
    dataUrl: market.dataUrl,
    symbols: market.symbols,
    sourceVersionKey:
      environment.TWOFOLD_CORPORATE_ACTION_SOURCE_VERSION?.trim()
      || "alpaca-corporate-actions-v1",
    sourceEffectiveFrom: market.sourceEffectiveFrom,
    licenseScope: market.licenseScope,
  });
}

interface AlpacaCorporateActionBase {
  readonly schema: "twofold.alpaca_corporate_action_revision/v1";
  readonly source: "ALPACA_CORPORATE_ACTIONS_V1";
  readonly sourceActionId: string;
  readonly revisionSha256: string;
  readonly type: AlpacaCorporateActionType;
  readonly symbol: string;
  readonly status: "COMPLETE" | "INCOMPLETE";
  readonly interpretation: "SPLIT" | "CASH_DIVIDEND" | "UNSUPPORTED";
  readonly processDate: string | null;
  readonly exDate: string | null;
  readonly recordDate: string | null;
  readonly payableDate: string | null;
  readonly rawCanonicalJson: string;
}

export interface AlpacaSplitCorporateAction extends AlpacaCorporateActionBase {
  readonly type: "FORWARD_SPLIT" | "REVERSE_SPLIT";
  readonly interpretation: "SPLIT";
  readonly oldRate: string | null;
  readonly newRate: string | null;
}

export interface AlpacaCashDividendCorporateAction
  extends AlpacaCorporateActionBase {
  readonly type: "CASH_DIVIDEND";
  readonly interpretation: "CASH_DIVIDEND";
  readonly rate: string | null;
  readonly foreign: boolean | null;
  readonly special: boolean | null;
}

export interface AlpacaUnsupportedCorporateAction
  extends AlpacaCorporateActionBase {
  readonly interpretation: "UNSUPPORTED";
}

export type AlpacaCorporateAction =
  | AlpacaSplitCorporateAction
  | AlpacaCashDividendCorporateAction
  | AlpacaUnsupportedCorporateAction;

export interface AlpacaCorporateActionPage {
  readonly pageIndex: string;
  readonly requestUrl: string;
  readonly providerRequestId?: string;
  readonly rawBody: string;
  readonly byteSize: string;
  readonly responseSha256: string;
  readonly objectPath: string;
  readonly storageBucket: typeof PRIVATE_ARTIFACT_BUCKET;
}

export interface AlpacaCorporateActionScan {
  readonly schema: "twofold.alpaca_corporate_action_scan/v1";
  readonly source: {
    readonly provider: "alpaca";
    readonly dataset: "us_corporate_actions";
    readonly versionKey: string;
    readonly endpointBaseUrl: string;
    readonly feed: "none";
    readonly adjustment: "raw";
    readonly timeframe: "Event";
    readonly normalizerVersion: typeof ALPACA_CORPORATE_ACTION_NORMALIZER_VERSION;
    readonly licenseScope: string;
    readonly configSha256: string;
    readonly effectiveFrom: string;
  };
  readonly processDateStart: string;
  readonly processDateEnd: string;
  readonly observedAt: string;
  readonly requestFingerprint: string;
  readonly pages: readonly AlpacaCorporateActionPage[];
  readonly actions: readonly AlpacaCorporateAction[];
  readonly canonicalJson: string;
  readonly contentSha256: string;
}

export async function fetchAlpacaCorporateActions(
  config: AlpacaCorporateActionConfig,
  options: {
    readonly processDateStart: string;
    readonly processDateEnd: string;
    readonly fetchImplementation?: typeof fetch;
    readonly now?: () => Date;
    readonly signal?: AbortSignal;
  },
): Promise<AlpacaCorporateActionScan> {
  validateConfig(config);
  const processDateStart = date(options.processDateStart, "processDateStart");
  const processDateEnd = date(options.processDateEnd, "processDateEnd");
  if (processDateEnd < processDateStart) {
    throw new TypeError("corporate-action process-date interval is inverted");
  }
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const requestUrl = new URL("/v1/corporate-actions", config.dataUrl);
  requestUrl.searchParams.set("symbols", config.symbols.join(","));
  requestUrl.searchParams.set("region", "us");
  requestUrl.searchParams.set("start", processDateStart);
  requestUrl.searchParams.set("end", processDateEnd);
  requestUrl.searchParams.set("data_quality", "all");
  requestUrl.searchParams.set("limit", "1000");
  requestUrl.searchParams.set("sort", "asc");
  const requestFingerprint = sha256(requestUrl.toString());

  const fetchImplementation = options.fetchImplementation ?? fetch;
  const providerSignal = boundedProviderSignal(options.signal);
  const pages: AlpacaCorporateActionPage[] = [];
  const actions: AlpacaCorporateAction[] = [];
  const seenActionIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | null = null;

  for (let pageIndex = 0; pageIndex < 1_000; pageIndex += 1) {
    const pageUrl = new URL(requestUrl);
    if (pageToken !== null) pageUrl.searchParams.set("page_token", pageToken);
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
    const rawBody = await response.text();
    if (!response.ok) {
      throw new Error(
        `Alpaca corporate-action request failed with HTTP ${response.status}`,
      );
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim()
      !== "application/json") {
      throw new Error("Alpaca corporate-action response is not application/json");
    }
    const responseSha256 = sha256(rawBody);
    const providerRequestId = response.headers.get("x-request-id")?.trim() || undefined;
    pages.push(Object.freeze({
      pageIndex: pageIndex.toString(),
      requestUrl: pageUrl.toString(),
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      rawBody,
      byteSize: Buffer.byteLength(rawBody).toString(),
      responseSha256,
      objectPath:
        `raw/alpaca/${responseSha256.slice(0, 2)}/${responseSha256}.json`,
      storageBucket: PRIVATE_ARTIFACT_BUCKET,
    }));

    const payload = record(parse(rawBody), "Alpaca corporate-action response");
    const collections = record(
      payload.corporate_actions,
      "Alpaca corporate-action collections",
    );
    for (const collectionName of Object.keys(collections).sort()) {
      if (!(collectionName in COLLECTION_TYPES)) {
        throw new Error(
          `unknown corporate-action collection: ${collectionName}`,
        );
      }
      const candidates = collections[collectionName];
      if (!Array.isArray(candidates)) {
        throw new TypeError(`${collectionName} must be an array`);
      }
      const type = COLLECTION_TYPES[
        collectionName as keyof typeof COLLECTION_TYPES
      ];
      for (const [index, candidate] of candidates.entries()) {
        const action = normalizeAction(
          type,
          candidate,
          `${collectionName}[${index}]`,
        );
        if (seenActionIds.has(action.sourceActionId)) {
          throw new Error(
            `duplicate corporate action: ${action.sourceActionId}`,
          );
        }
        seenActionIds.add(action.sourceActionId);
        actions.push(action);
      }
    }

    const next = payload.next_page_token;
    if (next === null || next === undefined) break;
    if (typeof next !== "string" || next.trim() === "") {
      throw new TypeError("next_page_token must be a non-empty string or null");
    }
    if (seenPageTokens.has(next)) {
      throw new Error("Alpaca corporate-action pagination token repeated");
    }
    seenPageTokens.add(next);
    pageToken = next;
    if (pageIndex === 999) {
      throw new Error("Alpaca corporate-action pagination exceeded 1000 pages");
    }
  }

  actions.sort((left, right) =>
    (left.exDate ?? "9999-12-31").localeCompare(right.exDate ?? "9999-12-31", "en")
    || left.type.localeCompare(right.type, "en")
    || left.sourceActionId.localeCompare(right.sourceActionId, "en")
  );
  const sourceMaterial = {
    provider: "alpaca" as const,
    dataset: "us_corporate_actions" as const,
    endpointBaseUrl: config.dataUrl,
    feed: "none" as const,
    adjustment: "raw" as const,
    timeframe: "Event" as const,
    normalizerVersion: ALPACA_CORPORATE_ACTION_NORMALIZER_VERSION,
    licenseScope: config.licenseScope,
  } as const;
  const source = Object.freeze({
    ...sourceMaterial,
    versionKey: config.sourceVersionKey,
    configSha256: sha256(canonicalJson(sourceMaterial)),
    effectiveFrom: timestamp(
      config.sourceEffectiveFrom,
      "sourceEffectiveFrom",
    ),
  });
  const canonicalPayload = {
    actions: Object.freeze(actions),
    observedAt,
    pageResponseSha256: Object.freeze(pages.map((page) => page.responseSha256)),
    processDateEnd,
    processDateStart,
    requestFingerprint,
    schema: "twofold.alpaca_corporate_action_scan/v1" as const,
    source,
  };
  const serialized = canonicalJson(canonicalPayload);
  return Object.freeze({
    schema: "twofold.alpaca_corporate_action_scan/v1",
    source,
    processDateStart,
    processDateEnd,
    observedAt,
    requestFingerprint,
    pages: Object.freeze(pages),
    actions: Object.freeze(actions),
    canonicalJson: serialized,
    contentSha256: sha256(serialized),
  });
}

function normalizeAction(
  type: AlpacaCorporateActionType,
  value: unknown,
  field: string,
): AlpacaCorporateAction {
  const raw = record(value, field);
  const sourceActionId = requiredString(raw.id, `${field}.id`);
  if (!UUID_PATTERN.test(sourceActionId)) {
    throw new TypeError(`${field}.id must be a UUID`);
  }
  const symbol = affectedSymbol(type, raw, field);
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new TypeError(`${field}.symbol is invalid`);
  }
  const rawNumberFree = numberFreeJson(raw, field) as Record<string, unknown>;
  const rawCanonicalJson = canonicalJson(rawNumberFree);
  const base = {
    schema: "twofold.alpaca_corporate_action_revision/v1" as const,
    source: "ALPACA_CORPORATE_ACTIONS_V1" as const,
    sourceActionId,
    revisionSha256: sha256(rawCanonicalJson),
    type,
    symbol,
    processDate: optionalDate(raw.process_date, `${field}.process_date`),
    exDate: optionalDate(raw.ex_date, `${field}.ex_date`),
    recordDate: optionalDate(raw.record_date, `${field}.record_date`),
    payableDate: optionalDate(raw.payable_date, `${field}.payable_date`),
    rawCanonicalJson,
  };

  if (type === "FORWARD_SPLIT" || type === "REVERSE_SPLIT") {
    const oldRate = optionalPositiveNumber(raw.old_rate, `${field}.old_rate`);
    const newRate = optionalPositiveNumber(raw.new_rate, `${field}.new_rate`);
    const directionValid = oldRate !== null && newRate !== null && (
      type === "FORWARD_SPLIT"
        ? comparePositiveDecimal(newRate, oldRate) > 0
        : comparePositiveDecimal(newRate, oldRate) < 0
    );
    return Object.freeze({
      ...base,
      interpretation: "SPLIT",
      status: base.processDate !== null && base.exDate !== null && directionValid
        ? "COMPLETE"
        : "INCOMPLETE",
      type,
      oldRate,
      newRate,
    });
  }
  if (type === "CASH_DIVIDEND") {
    const rate = optionalPositiveNumber(raw.rate, `${field}.rate`);
    const foreign = optionalBoolean(raw.foreign, `${field}.foreign`);
    const special = optionalBoolean(raw.special, `${field}.special`);
    return Object.freeze({
      ...base,
      interpretation: "CASH_DIVIDEND",
      status:
        base.processDate !== null
        && base.exDate !== null
        && base.payableDate !== null
        && rate !== null
        && foreign !== null
        && special !== null
          ? "COMPLETE"
          : "INCOMPLETE",
      type,
      rate,
      foreign,
      special,
    });
  }
  return Object.freeze({
    ...base,
    interpretation: "UNSUPPORTED",
    status: base.processDate !== null && base.exDate !== null
      ? "COMPLETE"
      : "INCOMPLETE",
  });
}

function affectedSymbol(
  type: AlpacaCorporateActionType,
  raw: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const value = type === "CASH_MERGER"
    || type === "STOCK_MERGER"
    || type === "STOCK_AND_CASH_MERGER"
      ? raw.acquiree_symbol ?? raw.symbol
      : raw.symbol;
  const symbol = requiredString(value, `${field}.symbol`);
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new TypeError(`${field}.symbol is invalid`);
  }
  return symbol;
}

function numberFreeJson(value: unknown, field: string): unknown {
  if (isLosslessNumber(value)) return canonicalJsonNumber(value, field);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => numberFreeJson(item, `${field}[${index}]`));
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).map((key) => [
      key,
      numberFreeJson(source[key], `${field}.${key}`),
    ]));
  }
  throw new TypeError(`${field} contains a non-JSON value`);
}

function optionalPositiveNumber(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  const parsed = canonicalJsonNumber(value, field);
  if (!POSITIVE_DECIMAL_PATTERN.test(parsed) || parsed === "0") {
    throw new TypeError(`${field} must be positive`);
  }
  return parsed;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") throw new TypeError(`${field} must be boolean`);
  return value;
}

function comparePositiveDecimal(left: string, right: string): number {
  const [leftInteger, leftFraction = ""] = left.split(".");
  const [rightInteger, rightFraction = ""] = right.split(".");
  if (leftInteger!.length !== rightInteger!.length) {
    return leftInteger!.length < rightInteger!.length ? -1 : 1;
  }
  const integerOrder = leftInteger!.localeCompare(rightInteger!, "en");
  if (integerOrder !== 0) return integerOrder;
  const scale = Math.max(leftFraction.length, rightFraction.length);
  return leftFraction.padEnd(scale, "0").localeCompare(
    rightFraction.padEnd(scale, "0"),
    "en",
  );
}

function validateConfig(config: AlpacaCorporateActionConfig): void {
  const parsed = new URL(config.dataUrl);
  if (parsed.origin !== TRUSTED_DATA_ORIGIN
    || parsed.pathname !== "/"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new TypeError(`dataUrl must use ${TRUSTED_DATA_ORIGIN}`);
  }
  if (config.apiKeyId.trim() === "" || config.apiSecretKey.trim() === "") {
    throw new TypeError("Alpaca credentials are required");
  }
  if (config.symbols.length === 0
    || config.symbols.some((symbol) => !SYMBOL_PATTERN.test(symbol))
    || config.symbols.some(
      (symbol, index) => index > 0 && symbol <= config.symbols[index - 1]!,
    )) {
    throw new TypeError("symbols must be sorted unique tickers");
  }
  if (config.sourceVersionKey.trim() === "" || config.licenseScope.trim() === "") {
    throw new TypeError("corporate-action source identity is required");
  }
  timestamp(config.sourceEffectiveFrom, "sourceEffectiveFrom");
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${field} must be a date`);
  return date(value, field);
}

function date(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function timestamp(value: string, field: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${field} is invalid`);
  }
  return parsed.toISOString();
}
