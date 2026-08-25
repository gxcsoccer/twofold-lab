import Decimal from "decimal.js";

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/New_York",
  timeZoneName: "short",
});

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
  return dateTime.format(new Date(value));
}

export function formatShortDate(value: string): string {
  return shortDate.format(new Date(value));
}
