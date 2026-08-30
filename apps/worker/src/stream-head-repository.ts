import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";

export const EVENT_STREAM_HEAD_SCHEMA = "twofold.event_stream_head/v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

export interface EventStreamHead {
  readonly schema: typeof EVENT_STREAM_HEAD_SCHEMA;
  readonly streamId: string;
  readonly streamType: string;
  readonly sequence: string;
  readonly lastEventId: string | null;
}

interface RpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface EventStreamHeadRpcClient {
  rpc(
    functionName: "get_event_stream_head",
    arguments_: {
      readonly p_stream_id: string;
      readonly p_stream_type: string;
    },
  ): PromiseLike<RpcResult>;
}

export async function getEventStreamHead(
  client: EventStreamHeadRpcClient,
  streamId: string,
  streamType: string,
): Promise<EventStreamHead> {
  uuid(streamId, "streamId");
  identity(streamType, "streamType");
  const result = await retryExactRpcOnce(() => client.rpc(
    "get_event_stream_head",
    { p_stream_id: streamId, p_stream_type: streamType },
  ));
  if (result.error !== null) {
    throw new Error(
      `get_event_stream_head failed: ${result.error?.message ?? "unknown RPC error"}`,
    );
  }
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  assertNoJsonNumber(raw, "get_event_stream_head result");
  const record = exactRecord(raw);
  if (record.schema !== EVENT_STREAM_HEAD_SCHEMA) {
    throw new TypeError("unsupported event stream head schema");
  }
  const parsed: EventStreamHead = Object.freeze({
    schema: EVENT_STREAM_HEAD_SCHEMA,
    streamId: uuid(record.streamId, "result.streamId"),
    streamType: identity(record.streamType, "result.streamType"),
    sequence: integer(record.sequence, "result.sequence"),
    lastEventId: record.lastEventId === null
      ? null
      : uuid(record.lastEventId, "result.lastEventId"),
  });
  if (parsed.streamId !== streamId || parsed.streamType !== streamType) {
    throw new TypeError("get_event_stream_head returned a different stream");
  }
  if (parsed.sequence === "0" && parsed.lastEventId !== null) {
    throw new TypeError("a zero head cannot have a last event");
  }
  if (parsed.sequence !== "0" && parsed.lastEventId === null) {
    throw new TypeError("a nonzero head must have a last event");
  }
  return parsed;
}

function exactRecord(value: unknown): Record<string, unknown> {
  const keys = ["schema", "streamId", "streamType", "sequence", "lastEventId"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("event stream head must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length
    || keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new TypeError("event stream head has an unexpected shape");
  }
  return record;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!UUID_PATTERN.test(parsed)) throw new TypeError(`${field} must be a UUID`);
  return parsed;
}

function integer(value: unknown, field: string): string {
  const parsed = identity(value, field);
  if (!INTEGER_PATTERN.test(parsed)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
  return parsed;
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
