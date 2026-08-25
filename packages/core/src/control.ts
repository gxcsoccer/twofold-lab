import { nextSequence, sequence, type SequenceString } from "./decimal.js";
import type { EventEnvelope, EventPayload, JsonValue } from "./events.js";
import type {
  ControlPlaneIdentity,
  HealthIssue,
  HealthStatus,
  OrthogonalRuntimeState,
  PipelineStatus,
  RunStatus,
  SeasonStatus,
  StateProjectionMetadata,
} from "./states.js";

export const CONTROL_COMMAND_KINDS = [
  "pause_after_safe_point",
  "resume",
  "cancel_pending_simulated_orders",
  "run_data_repair",
  "freeze_config",
  "create_restatement",
] as const;
export type ControlCommandKind = (typeof CONTROL_COMMAND_KINDS)[number];

export const CONTROL_COMMAND_STATUSES = [
  "requested",
  "claimed",
  "succeeded",
  "failed",
  "rejected",
  "canceled",
] as const;
export type ControlCommandStatus = (typeof CONTROL_COMMAND_STATUSES)[number];

export type ControlCommandScope = "system" | "season" | "run";

export interface ControlCommandError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ControlCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly kind: ControlCommandKind;
  readonly scope: ControlCommandScope;
  readonly scopeId?: string;
  readonly status: ControlCommandStatus;
  readonly arguments: EventPayload;
  readonly expectedProjectionSequence?: SequenceString;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly claimedBy?: string;
  readonly claimedAt?: string;
  readonly completedAt?: string;
  readonly result?: EventPayload;
  readonly error?: ControlCommandError;
}

interface CommandRequestedPayload extends EventPayload {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly kind: ControlCommandKind;
  readonly scope: ControlCommandScope;
  readonly scopeId?: string;
  readonly arguments: EventPayload;
  readonly expectedProjectionSequence?: SequenceString;
  readonly requestedBy: string;
  readonly requestedAt: string;
}

interface CommandClaimedPayload extends EventPayload {
  readonly commandId: string;
  readonly claimedBy: string;
  readonly claimedAt: string;
}

interface CommandSucceededPayload extends EventPayload {
  readonly commandId: string;
  readonly completedAt: string;
  readonly result: EventPayload;
}

interface CommandFailedPayload extends EventPayload {
  readonly commandId: string;
  readonly completedAt: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
}

interface CommandRejectedPayload extends EventPayload {
  readonly commandId: string;
  readonly completedAt: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
}

interface CommandCanceledPayload extends EventPayload {
  readonly commandId: string;
  readonly completedAt: string;
}

interface SeasonStateChangedPayload extends EventPayload {
  readonly status: SeasonStatus;
}

interface RunStateChangedPayload extends EventPayload {
  readonly status: RunStatus;
}

interface PipelineStateChangedPayload extends EventPayload {
  readonly status: PipelineStatus;
}

interface HealthReportedPayload extends EventPayload {
  readonly status: HealthStatus;
  readonly issues: readonly JsonValue[];
}

export type ControlCommandEvent =
  | EventEnvelope<"control.command_requested", CommandRequestedPayload>
  | EventEnvelope<"control.command_claimed", CommandClaimedPayload>
  | EventEnvelope<"control.command_succeeded", CommandSucceededPayload>
  | EventEnvelope<"control.command_failed", CommandFailedPayload>
  | EventEnvelope<"control.command_rejected", CommandRejectedPayload>
  | EventEnvelope<"control.command_canceled", CommandCanceledPayload>;

export type ControlPlaneEvent =
  | EventEnvelope<"season.state_changed", SeasonStateChangedPayload>
  | EventEnvelope<"run.state_changed", RunStateChangedPayload>
  | EventEnvelope<"pipeline.state_changed", PipelineStateChangedPayload>
  | EventEnvelope<"health.reported", HealthReportedPayload>
  | ControlCommandEvent;

export interface ControlPlaneState
  extends OrthogonalRuntimeState,
    StateProjectionMetadata {
  readonly identity: ControlPlaneIdentity;
  readonly healthIssues: readonly HealthIssue[];
  readonly commands: Readonly<Record<string, ControlCommand>>;
}

export function createInitialControlPlaneState(
  identity: ControlPlaneIdentity,
): ControlPlaneState {
  return {
    identity: { ...identity },
    season: "draft",
    run: "queued",
    pipeline: "idle",
    health: "unknown",
    healthIssues: [],
    commands: {},
    lastAppliedSequence: sequence("0"),
  };
}

export function reduceControlCommand(
  current: ControlCommand | undefined,
  event: ControlCommandEvent,
): ControlCommand {
  switch (event.eventType) {
    case "control.command_requested": {
      if (current !== undefined) {
        throw new Error(`Command ${event.payload.commandId} has already been requested`);
      }

      return {
        commandId: event.payload.commandId,
        idempotencyKey: event.payload.idempotencyKey,
        kind: event.payload.kind,
        scope: event.payload.scope,
        ...(event.payload.scopeId === undefined ? {} : { scopeId: event.payload.scopeId }),
        status: "requested",
        arguments: event.payload.arguments,
        ...(event.payload.expectedProjectionSequence === undefined
          ? {}
          : { expectedProjectionSequence: event.payload.expectedProjectionSequence }),
        requestedBy: event.payload.requestedBy,
        requestedAt: event.payload.requestedAt,
      };
    }

    case "control.command_claimed": {
      assertCommand(current, event.payload.commandId, ["requested"]);
      return {
        ...current,
        status: "claimed",
        claimedBy: event.payload.claimedBy,
        claimedAt: event.payload.claimedAt,
      };
    }

    case "control.command_succeeded": {
      assertCommand(current, event.payload.commandId, ["claimed"]);
      return {
        ...current,
        status: "succeeded",
        completedAt: event.payload.completedAt,
        result: event.payload.result,
      };
    }

    case "control.command_failed": {
      assertCommand(current, event.payload.commandId, ["claimed"]);
      return {
        ...current,
        status: "failed",
        completedAt: event.payload.completedAt,
        error: {
          code: event.payload.errorCode,
          message: event.payload.errorMessage,
          retryable: event.payload.retryable,
        },
      };
    }

    case "control.command_rejected": {
      assertCommand(current, event.payload.commandId, ["requested", "claimed"]);
      return {
        ...current,
        status: "rejected",
        completedAt: event.payload.completedAt,
        error: {
          code: event.payload.errorCode,
          message: event.payload.errorMessage,
          retryable: event.payload.retryable,
        },
      };
    }

    case "control.command_canceled": {
      assertCommand(current, event.payload.commandId, ["requested"]);
      return {
        ...current,
        status: "canceled",
        completedAt: event.payload.completedAt,
      };
    }
  }
}

export function reduceControlPlane(
  state: ControlPlaneState,
  event: ControlPlaneEvent,
): ControlPlaneState {
  const expectedSequence = nextSequence(state.lastAppliedSequence);
  if (event.streamSequence !== expectedSequence) {
    throw new Error(
      `Out-of-order event: expected stream sequence ${expectedSequence}, received ${event.streamSequence}`,
    );
  }

  const projectionMetadata = {
    lastAppliedSequence: event.streamSequence,
    lastEventId: event.eventId,
    updatedAt: event.recordedAt,
  } as const;

  switch (event.eventType) {
    case "season.state_changed":
      return { ...state, ...projectionMetadata, season: event.payload.status };
    case "run.state_changed":
      return { ...state, ...projectionMetadata, run: event.payload.status };
    case "pipeline.state_changed":
      return { ...state, ...projectionMetadata, pipeline: event.payload.status };
    case "health.reported":
      return {
        ...state,
        ...projectionMetadata,
        health: event.payload.status,
        healthIssues: parseHealthIssues(event.payload.issues),
      };
    default: {
      const current = state.commands[event.payload.commandId];
      const command = reduceControlCommand(current, event);
      return {
        ...state,
        ...projectionMetadata,
        commands: { ...state.commands, [command.commandId]: command },
      };
    }
  }
}

function assertCommand(
  command: ControlCommand | undefined,
  commandId: string,
  allowedStatuses: readonly ControlCommandStatus[],
): asserts command is ControlCommand {
  if (command === undefined || command.commandId !== commandId) {
    throw new Error(`Unknown command ${commandId}`);
  }

  if (!allowedStatuses.includes(command.status)) {
    throw new Error(
      `Command ${commandId} cannot transition from ${command.status}`,
    );
  }
}

function parseHealthIssues(values: readonly JsonValue[]): readonly HealthIssue[] {
  return values.map((value, index) => {
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== "object"
    ) {
      throw new TypeError(`Invalid health issue at index ${index}`);
    }

    const issue = value as Readonly<Record<string, JsonValue | undefined>>;
    if (
      typeof issue.code !== "string" ||
      typeof issue.message !== "string" ||
      typeof issue.since !== "string" ||
      typeof issue.retryable !== "boolean"
    ) {
      throw new TypeError(`Invalid health issue at index ${index}`);
    }

    return {
      code: issue.code,
      message: issue.message,
      since: issue.since,
      retryable: issue.retryable,
    };
  });
}
