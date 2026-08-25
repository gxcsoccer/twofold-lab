import { describe, expect, it } from "vitest";

import {
  createInitialControlPlaneState,
  eventId,
  reduceControlPlane,
  sequence,
  streamId,
  type ControlPlaneEvent,
  type EventPayload,
} from "../src/index.js";

const EVENT_TIME = "2026-08-23T10:00:00.000Z";

function controlEvent(
  streamSequence: string,
  eventType: ControlPlaneEvent["eventType"],
  payload: EventPayload,
): ControlPlaneEvent {
  return {
    eventId: eventId(`event-${streamSequence}`),
    streamId: streamId("control-stream"),
    streamType: "control",
    streamSequence: sequence(streamSequence),
    eventType,
    schemaVersion: "1",
    idempotencyKey: `event-${streamSequence}`,
    actor: { kind: "worker", id: "worker-1" },
    eventTime: EVENT_TIME,
    recordedAt: EVENT_TIME,
    payload,
    metadata: {},
  } as ControlPlaneEvent;
}

describe("control plane projection", () => {
  it("updates Season, Run, Pipeline and Health as orthogonal axes", () => {
    const initial = createInitialControlPlaneState({
      experimentId: "experiment-1",
      seasonId: "season-1",
      runId: "run-1",
    });

    const withRun = reduceControlPlane(
      initial,
      controlEvent("1", "run.state_changed", { status: "active" }),
    );
    const withHealth = reduceControlPlane(
      withRun,
      controlEvent("2", "health.reported", {
        status: "nav_unresolved",
        issues: [
          {
            code: "PRICE_MISSING",
            message: "LULU close is not available",
            since: EVENT_TIME,
            retryable: true,
          },
        ],
      }),
    );

    expect(initial.run).toBe("queued");
    expect(withHealth).toMatchObject({
      season: "draft",
      run: "active",
      pipeline: "idle",
      health: "nav_unresolved",
      lastAppliedSequence: "2",
    });
    expect(withHealth.healthIssues).toHaveLength(1);
  });

  it("reduces a command from request through claim to success without mutation", () => {
    const initial = createInitialControlPlaneState({
      experimentId: "experiment-1",
      seasonId: "season-1",
      runId: "run-1",
    });
    const requested = reduceControlPlane(
      initial,
      controlEvent("1", "control.command_requested", {
        commandId: "command-1",
        idempotencyKey: "pause-run-1",
        kind: "pause_after_safe_point",
        scope: "run",
        scopeId: "run-1",
        arguments: { reason: "operator_request" },
        expectedProjectionSequence: "0",
        requestedBy: "user-1",
        requestedAt: EVENT_TIME,
      }),
    );
    const claimed = reduceControlPlane(
      requested,
      controlEvent("2", "control.command_claimed", {
        commandId: "command-1",
        claimedBy: "worker-1",
        claimedAt: EVENT_TIME,
      }),
    );
    const succeeded = reduceControlPlane(
      claimed,
      controlEvent("3", "control.command_succeeded", {
        commandId: "command-1",
        completedAt: EVENT_TIME,
        result: { outcome: "paused" },
      }),
    );

    expect(initial.commands).toEqual({});
    expect(requested.commands["command-1"]?.status).toBe("requested");
    expect(claimed.commands["command-1"]?.status).toBe("claimed");
    expect(succeeded.commands["command-1"]).toMatchObject({
      status: "succeeded",
      result: { outcome: "paused" },
    });
  });

  it("fails closed on gaps and invalid command transitions", () => {
    const initial = createInitialControlPlaneState({
      experimentId: "experiment-1",
      seasonId: "season-1",
      runId: "run-1",
    });

    expect(() =>
      reduceControlPlane(
        initial,
        controlEvent("2", "pipeline.state_changed", { status: "deciding" }),
      ),
    ).toThrow(/Out-of-order event/);

    expect(() =>
      reduceControlPlane(
        initial,
        controlEvent("1", "control.command_succeeded", {
          commandId: "unknown",
          completedAt: EVENT_TIME,
          result: {},
        }),
      ),
    ).toThrow(/Unknown command/);
  });
});
