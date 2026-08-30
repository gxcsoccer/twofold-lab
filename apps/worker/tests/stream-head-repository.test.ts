import { describe, expect, it, vi } from "vitest";

import {
  getEventStreamHead,
  type EventStreamHeadRpcClient,
} from "../src/stream-head-repository.js";

const streamId = "72000000-0000-4000-8000-000000000001";

function client(data: unknown): EventStreamHeadRpcClient {
  return {
    rpc: vi.fn(async () => ({ data, error: null, status: 200 })),
  };
}

describe("event stream head repository", () => {
  it("returns zero for a new stable Run stream", async () => {
    const rpc = client({
      schema: "twofold.event_stream_head/v1",
      streamId,
      streamType: "run",
      sequence: "0",
      lastEventId: null,
    });
    const head = await getEventStreamHead(rpc, streamId, "run");
    expect(head).toEqual({
      schema: "twofold.event_stream_head/v1",
      streamId,
      streamType: "run",
      sequence: "0",
      lastEventId: null,
    });
    expect(rpc.rpc).toHaveBeenCalledWith("get_event_stream_head", {
      p_stream_id: streamId,
      p_stream_type: "run",
    });
  });

  it("preserves an arbitrarily large sequence as a string", async () => {
    const head = await getEventStreamHead(client({
      schema: "twofold.event_stream_head/v1",
      streamId,
      streamType: "run",
      sequence: "9007199254740993",
      lastEventId: "73000000-0000-4000-8000-000000000001",
    }), streamId, "run");
    expect(head.sequence).toBe("9007199254740993");
  });

  it("rejects numeric sequences and inconsistent empty heads", async () => {
    await expect(getEventStreamHead(client({
      schema: "twofold.event_stream_head/v1",
      streamId,
      streamType: "run",
      sequence: 1,
      lastEventId: "73000000-0000-4000-8000-000000000001",
    }), streamId, "run")).rejects.toThrow("numeric token");

    await expect(getEventStreamHead(client({
      schema: "twofold.event_stream_head/v1",
      streamId,
      streamType: "run",
      sequence: "0",
      lastEventId: "73000000-0000-4000-8000-000000000001",
    }), streamId, "run")).rejects.toThrow("zero head cannot have a last event");
  });

  it("rejects a response for a different stream", async () => {
    await expect(getEventStreamHead(client({
      schema: "twofold.event_stream_head/v1",
      streamId: "72000000-0000-4000-8000-000000000002",
      streamType: "run",
      sequence: "1",
      lastEventId: "73000000-0000-4000-8000-000000000001",
    }), streamId, "run")).rejects.toThrow("different stream");
  });
});
