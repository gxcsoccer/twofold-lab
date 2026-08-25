import type { ModelTokenUsage } from "@twofold/core";

import type { ArenaCostStatus, ArenaUsage } from "./arena-types.js";

function addIntegers(left: string, right: string): string {
  return (BigInt(left) + BigInt(right)).toString();
}

function decimalParts(value: string): { coefficient: bigint; scale: number } {
  const [integer = "0", fraction = ""] = value.split(".");
  return { coefficient: BigInt(integer + fraction), scale: fraction.length };
}

function powerOfTen(value: number): bigint {
  return 10n ** BigInt(value);
}

export function addDecimalStrings(left: string, right: string): string {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const sum =
    a.coefficient * powerOfTen(scale - a.scale)
    + b.coefficient * powerOfTen(scale - b.scale);
  if (scale === 0) return sum.toString();
  const digits = sum.toString().padStart(scale + 1, "0");
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
}

export function addUsageTokens(target: ArenaUsage, usage: ModelTokenUsage): void {
  target.uncachedInputTokens = addIntegers(
    target.uncachedInputTokens,
    usage.uncachedInputTokens,
  );
  target.cacheReadTokens = addIntegers(target.cacheReadTokens, usage.cacheReadTokens);
  target.cacheWriteTokens = addIntegers(target.cacheWriteTokens, usage.cacheWriteTokens);
  target.outputTokens = addIntegers(target.outputTokens, usage.outputTokens);
  target.reasoningTokens = addIntegers(
    target.reasoningTokens,
    usage.reasoningTokens ?? "0",
  );
  target.totalBillableTokens = [
    target.uncachedInputTokens,
    target.cacheReadTokens,
    target.cacheWriteTokens,
    target.outputTokens,
  ].reduce(addIntegers, "0");
}

export function addEstimatedCost(
  target: ArenaUsage,
  amount: string | null,
  pricingVersion: string | null,
): void {
  if (amount !== null) {
    target.estimatedCostUsd = addDecimalStrings(target.estimatedCostUsd ?? "0", amount);
  }
  if (pricingVersion !== null && !target.pricingVersions.includes(pricingVersion)) {
    target.pricingVersions.push(pricingVersion);
    target.pricingVersions.sort();
  }
}

export function costStatusForAttempts(
  attemptStatuses: readonly ("estimated" | "unpriced" | "unavailable")[],
): ArenaCostStatus {
  if (attemptStatuses.length === 0) return "UNAVAILABLE";
  const estimated = attemptStatuses.filter((status) => status === "estimated").length;
  const unpriced = attemptStatuses.filter((status) => status === "unpriced").length;
  const unavailable = attemptStatuses.length - estimated - unpriced;
  if (estimated === attemptStatuses.length) return "ESTIMATED";
  if (estimated > 0) return "PARTIAL";
  if (unpriced > 0 && unavailable === 0) return "UNPRICED";
  if (unpriced > 0) return "PARTIAL";
  return "UNAVAILABLE";
}

export function sumArenaUsage(usages: readonly ArenaUsage[]): ArenaUsage {
  const total: ArenaUsage = {
    providerRequestCount: "0",
    uncachedInputTokens: "0",
    cacheReadTokens: "0",
    cacheWriteTokens: "0",
    outputTokens: "0",
    reasoningTokens: "0",
    totalBillableTokens: "0",
    estimatedCostUsd: null,
    costStatus: "UNAVAILABLE",
    pricingVersions: [],
  };
  for (const usage of usages) {
    total.providerRequestCount = addIntegers(
      total.providerRequestCount,
      usage.providerRequestCount,
    );
    total.uncachedInputTokens = addIntegers(
      total.uncachedInputTokens,
      usage.uncachedInputTokens,
    );
    total.cacheReadTokens = addIntegers(total.cacheReadTokens, usage.cacheReadTokens);
    total.cacheWriteTokens = addIntegers(total.cacheWriteTokens, usage.cacheWriteTokens);
    total.outputTokens = addIntegers(total.outputTokens, usage.outputTokens);
    total.reasoningTokens = addIntegers(total.reasoningTokens, usage.reasoningTokens);
    total.totalBillableTokens = addIntegers(
      total.totalBillableTokens,
      usage.totalBillableTokens,
    );
    if (usage.estimatedCostUsd !== null) {
      total.estimatedCostUsd = addDecimalStrings(
        total.estimatedCostUsd ?? "0",
        usage.estimatedCostUsd,
      );
    }
    for (const version of usage.pricingVersions) {
      if (!total.pricingVersions.includes(version)) total.pricingVersions.push(version);
    }
  }
  total.pricingVersions.sort();
  const statuses = usages
    .filter((usage) => BigInt(usage.providerRequestCount) > 0n)
    .map((usage) => usage.costStatus);
  total.costStatus = statuses.length === 0
    ? "UNAVAILABLE"
    : statuses.every((status) => status === "ESTIMATED")
      ? "ESTIMATED"
      : statuses.every((status) => status === "UNPRICED")
        ? "UNPRICED"
        : statuses.every((status) => status === "UNAVAILABLE")
          ? "UNAVAILABLE"
          : "PARTIAL";
  return total;
}
