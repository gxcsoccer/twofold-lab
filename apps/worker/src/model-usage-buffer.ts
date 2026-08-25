import {
  normalizeHarnessTokenUsage,
  type HarnessTokenUsage,
  type ModelTokenUsage,
} from "@twofold/core";

export interface HarnessUsageAttemptKey {
  readonly sessionId: string;
  readonly turn: number;
  readonly step: number;
  readonly attempt: number;
}
export interface HarnessUsageSample extends HarnessUsageAttemptKey {
  readonly harnessEventSeq: number;
  readonly source: "stream_chunk" | "assistant_message";
  readonly usage: HarnessTokenUsage;
}

export type FrozenHarnessUsage =
  | {
      readonly usageStatus: "captured";
      readonly usageSource: "assistant_message" | "stream_chunk_fallback";
      readonly harnessEventSeq: string;
      readonly usage: ModelTokenUsage;
    }
  | {
      readonly usageStatus: "provider_unreported";
      readonly usageSource: "provider_unreported";
      readonly harnessEventSeq: null;
    };

interface BufferedSample {
  readonly harnessEventSeq: number;
  readonly source: HarnessUsageSample["source"];
  readonly usage: ModelTokenUsage;
}

function assertIndex(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function attemptKey(key: HarnessUsageAttemptKey): string {
  if (key.sessionId.length === 0) throw new TypeError("sessionId is required");
  assertIndex(key.turn, "turn");
  assertIndex(key.step, "step");
  assertIndex(key.attempt, "attempt");
  return `${key.sessionId}:${key.turn}:${key.step}:${key.attempt}`;
}

/**
 * Buffers transient Harness usage until step/end. The finalized assistant
 * message replaces usage chunks from the same physical attempt; if the model
 * request fails before a message exists, the last usage chunk is retained.
 */
export class HarnessUsageAttemptBuffer {
  private readonly samples = new Map<string, BufferedSample>();

  observe(sample: HarnessUsageSample): void {
    const key = attemptKey(sample);
    assertIndex(sample.harnessEventSeq, "harnessEventSeq");
    const current = this.samples.get(key);

    if (current?.source === "assistant_message") return;
    if (
      current !== undefined &&
      sample.source === "stream_chunk" &&
      sample.harnessEventSeq < current.harnessEventSeq
    ) {
      return;
    }

    this.samples.set(key, {
      harnessEventSeq: sample.harnessEventSeq,
      source: sample.source,
      usage: normalizeHarnessTokenUsage(sample.usage),
    });
  }

  freeze(key: HarnessUsageAttemptKey): FrozenHarnessUsage {
    const sample = this.samples.get(attemptKey(key));
    if (sample === undefined) {
      return Object.freeze({
        usageStatus: "provider_unreported",
        usageSource: "provider_unreported",
        harnessEventSeq: null,
      });
    }

    return Object.freeze({
      usageStatus: "captured",
      usageSource:
        sample.source === "assistant_message"
          ? "assistant_message"
          : "stream_chunk_fallback",
      harnessEventSeq: String(sample.harnessEventSeq),
      usage: sample.usage,
    });
  }
}
