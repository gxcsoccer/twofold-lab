import type { SequenceString } from "./decimal.js";

declare const eventIdBrand: unique symbol;
declare const streamIdBrand: unique symbol;

export type EventId = string & { readonly [eventIdBrand]: true };
export type StreamId = string & { readonly [streamIdBrand]: true };

/**
 * JSON at the event boundary deliberately excludes `number`. Counts, ratios,
 * quantities and money must be explicitly represented as canonical strings.
 */
export type JsonScalar = string | boolean | null;
export type JsonObject = {
  readonly [key: string]: JsonValue | undefined;
};
export type JsonValue =
  | JsonScalar
  | readonly JsonValue[]
  | JsonObject;
export type EventPayload = JsonObject;

export type ActorKind = "human" | "worker" | "system" | "model";

export interface EventActor {
  readonly kind: ActorKind;
  readonly id: string;
}

export interface EventEnvelope<
  TType extends string = string,
  TPayload extends EventPayload = EventPayload,
> {
  readonly eventId: EventId;
  readonly streamId: StreamId;
  readonly streamType: "experiment" | "season" | "run" | "control";
  readonly streamSequence: SequenceString;
  readonly eventType: TType;
  readonly schemaVersion: string;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly causationId?: EventId;
  readonly actor: EventActor;
  readonly eventTime: string;
  readonly effectiveDate?: string;
  readonly settlementDate?: string;
  readonly recordedAt: string;
  readonly payload: TPayload;
  readonly metadata: EventPayload;
}

export function eventId(value: string): EventId {
  if (value.length === 0) {
    throw new TypeError("Event ID cannot be empty");
  }

  return value as EventId;
}

export function streamId(value: string): StreamId {
  if (value.length === 0) {
    throw new TypeError("Stream ID cannot be empty");
  }

  return value as StreamId;
}

export function assertJsonValue(value: unknown, path = "payload"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON objects`);
    }

    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }

  if (typeof value === "number") {
    throw new TypeError(`${path} contains a JavaScript number; use a decimal string`);
  }

  throw new TypeError(`${path} contains a non-JSON value`);
}

export function defineEvent<
  TType extends string,
  TPayload extends EventPayload,
>(envelope: EventEnvelope<TType, TPayload>): EventEnvelope<TType, TPayload> {
  assertJsonValue(envelope.payload);
  assertJsonValue(envelope.metadata);

  if (envelope.schemaVersion.length === 0 || envelope.idempotencyKey.length === 0) {
    throw new TypeError("schemaVersion and idempotencyKey are required");
  }

  return Object.freeze(envelope);
}
