import { createHash } from "node:crypto";

import { boundedProviderSignal } from "./provider-deadline.js";

const ALPACA_TRADING_ORIGIN = "https://api.alpaca.markets";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MARKET_TIME_ZONE = "America/New_York";

export interface AlpacaCalendarSession {
  readonly date: string;
  readonly open: string;
  readonly close: string;
  readonly settlementDate: string;
}

export interface TwoStageCycleCalendar {
  readonly schema: "twofold.two_stage_cycle_calendar/v1";
  readonly decisionSessionDate: string;
  readonly s1SessionDate: string;
  readonly s1OpenAt: string;
  readonly s1ReferenceAvailableAt: string;
  readonly s1CloseAt: string;
  readonly s1CloseAvailableAt: string;
  readonly s2SessionDate: string;
  readonly s2OpenAt: string;
  readonly s2ReferenceAvailableAt: string;
  readonly s2CloseAt: string;
  readonly cycleReadyAt: string;
}

export interface AlpacaCalendarDelivery {
  readonly schema: "twofold.alpaca_calendar_delivery/v1";
  readonly requestUrl: string;
  readonly retrievedAt: string;
  readonly responseSha256: string;
  readonly rawBody: string;
  readonly sessions: readonly AlpacaCalendarSession[];
}

export function parseAlpacaCalendar(rawBody: string): readonly AlpacaCalendarSession[] {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody) as unknown;
  } catch {
    throw new TypeError("Alpaca calendar response is not valid JSON");
  }
  assertNoJsonNumber(raw, "Alpaca calendar response");
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new TypeError("Alpaca calendar response must contain sessions");
  }

  const sessions = raw.map((item, index): AlpacaCalendarSession => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`calendar[${index}] must be an object`);
    }
    const row = item as Record<string, unknown>;
    const allowed = new Set([
      "date",
      "open",
      "close",
      "settlement_date",
      "session_open",
      "session_close",
    ]);
    if (Object.keys(row).some((key) => !allowed.has(key))) {
      throw new TypeError(`calendar[${index}] has an unexpected field`);
    }
    const date = calendarDate(row.date, `calendar[${index}].date`);
    const open = clock(row.open, `calendar[${index}].open`);
    const close = clock(row.close, `calendar[${index}].close`);
    const settlementDate = calendarDate(
      row.settlement_date,
      `calendar[${index}].settlement_date`,
    );
    if (close <= open) {
      throw new TypeError(`calendar[${index}] close must follow open`);
    }
    if (settlementDate <= date) {
      throw new TypeError(`calendar[${index}] settlement must follow trade date`);
    }
    return Object.freeze({ date, open, close, settlementDate });
  });
  for (let index = 1; index < sessions.length; index += 1) {
    if (sessions[index - 1]!.date >= sessions[index]!.date) {
      throw new TypeError("Alpaca calendar sessions must be strictly ordered");
    }
  }
  return Object.freeze(sessions);
}

/**
 * Freeze the two-session rebalance clock from the exchange calendar. The open
 * reference waits two minutes for a completed first-minute bar; daily close
 * marks wait twenty minutes, matching the daily-bar sealing fence.
 */
export function planTwoStageCycleCalendar(
  decisionSessionDate: string,
  sessions: readonly AlpacaCalendarSession[],
  options: { readonly decisionAvailableAt?: string } = {},
): TwoStageCycleCalendar {
  calendarDate(decisionSessionDate, "decisionSessionDate");
  const decisionAvailableAt = options.decisionAvailableAt === undefined
    ? null
    : canonicalTimestamp(
        options.decisionAvailableAt,
        "decisionAvailableAt",
      );
  const future = sessions.filter((session) => {
    if (session.date <= decisionSessionDate) return false;
    if (decisionAvailableAt === null) return true;
    const decisionCutoff = zonedWallTimeToUtc(session.date, session.open).getTime()
      - 15 * 60_000;
    return Date.parse(decisionAvailableAt) < decisionCutoff;
  });
  const s1 = future[0];
  const s2 = future[1];
  if (s1 === undefined || s2 === undefined) {
    throw new TypeError("two future market sessions are required for S1 and S2");
  }
  const s1Open = zonedWallTimeToUtc(s1.date, s1.open);
  const s1Close = zonedWallTimeToUtc(s1.date, s1.close);
  const s2Open = zonedWallTimeToUtc(s2.date, s2.open);
  const s2Close = zonedWallTimeToUtc(s2.date, s2.close);
  return Object.freeze({
    schema: "twofold.two_stage_cycle_calendar/v1",
    decisionSessionDate,
    s1SessionDate: s1.date,
    s1OpenAt: s1Open.toISOString(),
    s1ReferenceAvailableAt: addMinutes(s1Open, 2),
    s1CloseAt: s1Close.toISOString(),
    s1CloseAvailableAt: addMinutes(s1Close, 20),
    s2SessionDate: s2.date,
    s2OpenAt: s2Open.toISOString(),
    s2ReferenceAvailableAt: addMinutes(s2Open, 2),
    s2CloseAt: s2Close.toISOString(),
    cycleReadyAt: addMinutes(s2Close, 20),
  });
}

export async function fetchAlpacaCalendar(input: {
  readonly apiKeyId: string;
  readonly apiSecretKey: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}): Promise<AlpacaCalendarDelivery> {
  const startDate = calendarDate(input.startDate, "startDate");
  const endDate = calendarDate(input.endDate, "endDate");
  if (endDate < startDate) throw new TypeError("calendar endDate precedes startDate");
  const apiKeyId = secret(input.apiKeyId, "apiKeyId");
  const apiSecretKey = secret(input.apiSecretKey, "apiSecretKey");
  const providerSignal = boundedProviderSignal(input.signal);
  const requestUrl = new URL("/v2/calendar", ALPACA_TRADING_ORIGIN);
  requestUrl.searchParams.set("start", startDate);
  requestUrl.searchParams.set("end", endDate);
  const response = await (input.fetchImplementation ?? fetch)(requestUrl, {
    method: "GET",
    headers: {
      "APCA-API-KEY-ID": apiKeyId,
      "APCA-API-SECRET-KEY": apiSecretKey,
      accept: "application/json",
    },
    redirect: "error",
    signal: providerSignal,
  });
  if (!response.ok) throw new Error(`Alpaca calendar returned HTTP ${response.status}`);
  if (response.url !== "" && new URL(response.url).origin !== ALPACA_TRADING_ORIGIN) {
    throw new Error("Alpaca calendar response left the trusted origin");
  }
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim();
  if (contentType !== "application/json") {
    throw new Error("Alpaca calendar returned an unsupported content type");
  }
  const rawBody = await response.text();
  const sessions = parseAlpacaCalendar(rawBody);
  if (
    sessions.some((session) => session.date < startDate || session.date > endDate)
  ) {
    throw new Error("Alpaca calendar returned a session outside the requested range");
  }
  return Object.freeze({
    schema: "twofold.alpaca_calendar_delivery/v1",
    requestUrl: requestUrl.toString(),
    retrievedAt: (input.now ?? (() => new Date()))().toISOString(),
    responseSha256: createHash("sha256").update(rawBody, "utf8").digest("hex"),
    rawBody,
    sessions,
  });
}

function zonedWallTimeToUtc(date: string, time: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour!, minute!, 0, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const read = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value);
    const observed = Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      read("hour"),
      read("minute"),
      read("second"),
      0,
    );
    const difference = target - observed;
    guess += difference;
    if (difference === 0) break;
  }
  const resolved = new Date(guess);
  const check = formatter.formatToParts(resolved);
  const text = (type: Intl.DateTimeFormatPartTypes): string =>
    check.find((part) => part.type === type)?.value ?? "";
  if (
    `${text("year")}-${text("month")}-${text("day")}` !== date
    || `${text("hour")}:${text("minute")}` !== time
  ) {
    throw new TypeError(`market wall time does not exist: ${date} ${time}`);
  }
  return resolved;
}

function addMinutes(value: Date, minutes: number): string {
  return new Date(value.getTime() + minutes * 60_000).toISOString();
}

function secret(value: string, field: string): string {
  if (value.trim() === "") throw new TypeError(`${field} is required`);
  return value.trim();
}

function clock(value: unknown, field: string): string {
  if (typeof value !== "string" || !CLOCK_PATTERN.test(value)) {
    throw new TypeError(`${field} must use HH:mm`);
  }
  return value;
}

function calendarDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new TypeError(`${field} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a real date`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a canonical ISO UTC timestamp`);
  }
  return value;
}

function assertNoJsonNumber(value: unknown, path: string): void {
  if (typeof value === "number") throw new TypeError(`${path} contains a numeric token`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoJsonNumber(item, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assertNoJsonNumber(nested, `${path}.${key}`);
    }
  }
}
