import {
  CONTROL_COMMAND_KINDS,
  type ControlCommandKind,
  type EventPayload,
} from "@twofold/core";

export interface LeasedControlCommand {
  readonly commandId: string;
  readonly kind: ControlCommandKind;
  readonly arguments: EventPayload;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export interface CommandFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface WorkerHeartbeat {
  readonly workerId: string;
  readonly observedAt: string;
  readonly leaseSeconds: number;
  readonly capabilities: EventPayload;
}

export interface ControlPlaneRepository {
  heartbeat(heartbeat: WorkerHeartbeat): Promise<void>;
  claimNext(workerId: string, leaseSeconds: number): Promise<LeasedControlCommand | undefined>;
  complete(command: LeasedControlCommand, workerId: string, result: EventPayload): Promise<void>;
  fail(command: LeasedControlCommand, workerId: string, failure: CommandFailure): Promise<void>;
}

export function isControlCommandKind(value: string): value is ControlCommandKind {
  return (CONTROL_COMMAND_KINDS as readonly string[]).includes(value);
}

export class InMemoryControlPlaneRepository implements ControlPlaneRepository {
  readonly heartbeats: WorkerHeartbeat[] = [];
  readonly completions: Array<{ commandId: string; result: EventPayload }> = [];
  readonly failures: Array<{ commandId: string; failure: CommandFailure }> = [];
  readonly queue: LeasedControlCommand[] = [];

  heartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
    this.heartbeats.push(heartbeat);
    return Promise.resolve();
  }

  claimNext(): Promise<LeasedControlCommand | undefined> {
    return Promise.resolve(this.queue.shift());
  }

  complete(command: LeasedControlCommand, _workerId: string, result: EventPayload): Promise<void> {
    this.completions.push({ commandId: command.commandId, result });
    return Promise.resolve();
  }

  fail(command: LeasedControlCommand, _workerId: string, failure: CommandFailure): Promise<void> {
    this.failures.push({ commandId: command.commandId, failure });
    return Promise.resolve();
  }
}
