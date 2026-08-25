import { describe, expect, it } from "vitest";

import { HarnessUsageAttemptBuffer } from "../src/model-usage-buffer.js";

const key = {
  sessionId: "session-1",
  turn: 1,
  step: 2,
  attempt: 0,
} as const;

describe("HarnessUsageAttemptBuffer", () => {
  it("uses the finalized assistant message instead of an earlier usage chunk", () => {
    const buffer = new HarnessUsageAttemptBuffer();
    buffer.observe({
      ...key,
      harnessEventSeq: 10,
      source: "stream_chunk",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    buffer.observe({
      ...key,
      harnessEventSeq: 11,
      source: "assistant_message",
      usage: { inputTokens: 12, cacheReadTokens: 5, outputTokens: 3 },
    });

    expect(buffer.freeze(key)).toEqual({
      usageStatus: "captured",
      usageSource: "assistant_message",
      harnessEventSeq: "11",
      usage: {
        uncachedInputTokens: "12",
        cacheReadTokens: "5",
        cacheWriteTokens: "0",
        outputTokens: "3",
      },
    });
  });

  it("falls back to the last usage chunk when no final message exists", () => {
    const buffer = new HarnessUsageAttemptBuffer();
    buffer.observe({
      ...key,
      harnessEventSeq: 10,
      source: "stream_chunk",
      usage: { inputTokens: 8, outputTokens: 1 },
    });
    buffer.observe({
      ...key,
      harnessEventSeq: 12,
      source: "stream_chunk",
      usage: { inputTokens: 9, outputTokens: 1 },
    });

    expect(buffer.freeze(key)).toMatchObject({
      usageSource: "stream_chunk_fallback",
      harnessEventSeq: "12",
      usage: { uncachedInputTokens: "9" },
    });
  });

  it("keeps retry attempts independent and exposes missing usage explicitly", () => {
    const buffer = new HarnessUsageAttemptBuffer();
    buffer.observe({
      ...key,
      harnessEventSeq: 10,
      source: "assistant_message",
      usage: { inputTokens: 8, outputTokens: 1 },
    });

    expect(buffer.freeze({ ...key, attempt: 1 })).toEqual({
      usageStatus: "provider_unreported",
      usageSource: "provider_unreported",
      harnessEventSeq: null,
    });
    expect(buffer.freeze(key)).toMatchObject({ usageStatus: "captured" });
  });
});
