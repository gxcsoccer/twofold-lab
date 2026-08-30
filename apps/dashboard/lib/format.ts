import Decimal from "decimal.js";

/**
 * Timestamps are composed from parts rather than handed to a locale format,
 * because zh-CN puts the zone abbreviation in the middle ("2026年9月2日 GMT-4
 * 16:00"). An operator console wants one sortable, unambiguous shape in the
 * data face: `2026-09-02 16:00 EDT`.
 */
const marketParts = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZone: "America/New_York",
  timeZoneName: "short",
});

function marketTimeParts(value: string): Record<string, string> | null {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const part of marketParts.formatToParts(at)) {
    parts[part.type] = part.value;
  }
  return parts;
}

const shortDate = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/New_York",
});

function groupInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatInteger(value: string): string {
  return /^(0|[1-9]\d*)$/.test(value) ? groupInteger(value) : value;
}

export function formatCurrency(value: Decimal.Value): string {
  const decimal = new Decimal(value);
  const [integer, fraction] = decimal.abs().toFixed(2).split(".");
  const sign = decimal.isNegative() ? "-" : "";
  return sign + "$" + groupInteger(integer) + "." + fraction;
}

export function formatUsdCost(value: Decimal.Value): string {
  const decimal = new Decimal(value);
  const digits = decimal.abs().lessThan(1) ? 6 : 4;
  const [integer, fraction] = decimal.abs().toFixed(digits).split(".");
  const sign = decimal.isNegative() ? "-" : "";
  return sign + "$" + groupInteger(integer) + "." + fraction;
}

export function formatUsdCostPerDecision(
  totalCost: Decimal.Value | null,
  decisionCount: string,
): string {
  if (totalCost === null) return "—";
  const count = new Decimal(decisionCount);
  if (!count.isInteger() || !count.isPositive()) return "—";
  return formatUsdCost(new Decimal(totalCost).dividedBy(count));
}

export function formatPercent(value: Decimal.Value, digits = 2): string {
  const decimal = new Decimal(value);
  const prefix = decimal.isPositive() ? "+" : "";
  return prefix + decimal.toFixed(digits) + "%";
}

export function formatDateTime(value: string): string {
  const parts = marketTimeParts(value);
  // An unparseable timestamp is shown verbatim rather than as "Invalid Date".
  if (parts === null) return value;
  return `${parts.year}-${parts.month}-${parts.day} `
    + `${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/** Time of day only, for the now-cursor and the round spine. */
export function formatClock(value: string): string {
  const parts = marketTimeParts(value);
  if (parts === null) return value;
  return `${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

export function formatShortDate(value: string): string {
  return shortDate.format(new Date(value));
}
