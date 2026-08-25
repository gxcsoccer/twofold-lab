import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import {
  checkModelBudgetReservation,
  nonNegativeMoney,
  tokenCount,
  type ModelBudgetViolation,
} from "@twofold/core";

import { addDecimalStrings } from "./arena-usage.js";

const BASE_REQUEST_OVERHEAD_BYTES = 1_024;
const PER_MESSAGE_OVERHEAD_BYTES = 128;
const PER_TOOL_OVERHEAD_BYTES = 256;

export interface ArenaTokenReservation {
  readonly maxInputTokens: string;
  readonly maxOutputTokens: string;
  readonly maxBillableTokens: string;
}

export interface ArenaCostQuote {
  readonly pricingId: string;
  readonly pricingVersion: string;
  readonly maximumEstimatedCostUsd: string;
}

export interface ArenaHeldReservation {
  readonly maxBillableTokens: string;
  readonly maximumEstimatedCostUsd: string;
}

function positiveSafeInteger(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

/**
 * Conservatively reserve one token for every UTF-8 byte in the complete
 * provider-facing request representation, plus explicit per-item framing.
 * A byte-level upper bound is intentionally much less optimistic than the
 * Harness token meter: it is suitable for a fail-closed preflight while the
 * provider remains the authority for settled usage.
 */
export function reserveGenerateOptions(
  options: Pick<
    GenerateOptions,
    | "provider"
    | "model"
    | "reasoningEffort"
    | "messages"
    | "system"
    | "tools"
    | "temperature"
    | "maxTokens"
    | "stop"
  >,
): ArenaTokenReservation {
  const maxOutputTokens = positiveSafeInteger(options.maxTokens, "maxTokens");
  const request = {
    provider: options.provider,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    system: options.system ?? "",
    messages: options.messages,
    tools: options.tools ?? [],
    temperature: options.temperature,
    maxTokens: maxOutputTokens,
    stop: options.stop ?? [],
  };
  const serialized = JSON.stringify(request);
  if (serialized === undefined) {
    throw new TypeError("model request cannot be serialized for budget reservation");
  }
  const maxInputTokens =
    Buffer.byteLength(serialized, "utf8")
    + BASE_REQUEST_OVERHEAD_BYTES
    + options.messages.length * PER_MESSAGE_OVERHEAD_BYTES
    + (options.tools?.length ?? 0) * PER_TOOL_OVERHEAD_BYTES;
  if (!Number.isSafeInteger(maxInputTokens)) {
    throw new TypeError("model request is too large for an exact budget reservation");
  }

  return Object.freeze({
    maxInputTokens: String(maxInputTokens),
    maxOutputTokens: String(maxOutputTokens),
    maxBillableTokens: String(BigInt(maxInputTokens) + BigInt(maxOutputTokens)),
  });
}

export function checkArenaAttemptBudget(input: {
  readonly settledProviderRequests: string;
  readonly settledBillableTokens: string;
  readonly settledEstimatedCostUsd: string;
  readonly heldReservations: readonly ArenaHeldReservation[];
  readonly reservation: ArenaTokenReservation;
  readonly quote: ArenaCostQuote;
  readonly maxProviderRequests: string;
  readonly maxBillableTokens: string;
  readonly maxEstimatedCostUsd: string;
}): Readonly<{ allowed: boolean; violations: readonly ModelBudgetViolation[] }> {
  const heldTokens = input.heldReservations.reduce(
    (total, held) => total + BigInt(held.maxBillableTokens),
    0n,
  );
  const heldCost = input.heldReservations.reduce(
    (total, held) => addDecimalStrings(total, held.maximumEstimatedCostUsd),
    "0",
  );
  return checkModelBudgetReservation(
    {
      providerRequests: tokenCount(
        (BigInt(input.settledProviderRequests) + BigInt(input.heldReservations.length)).toString(),
      ),
      billableTokens: tokenCount(
        (BigInt(input.settledBillableTokens) + heldTokens).toString(),
      ),
      estimatedCost: nonNegativeMoney(
        addDecimalStrings(input.settledEstimatedCostUsd, heldCost),
        "USD",
      ),
    },
    {
      providerRequests: tokenCount("1"),
      billableTokens: tokenCount(input.reservation.maxBillableTokens),
      estimatedCost: nonNegativeMoney(
        input.quote.maximumEstimatedCostUsd,
        "USD",
      ),
    },
    {
      maxProviderRequests: tokenCount(input.maxProviderRequests),
      maxBillableTokens: tokenCount(input.maxBillableTokens),
      maxEstimatedCost: nonNegativeMoney(input.maxEstimatedCostUsd, "USD"),
    },
  );
}
