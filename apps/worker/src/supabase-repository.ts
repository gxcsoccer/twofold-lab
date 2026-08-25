import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EventPayload, JsonValue } from "@twofold/core";
import {
  isControlCommandKind,
  type CommandFailure,
  type ControlPlaneRepository,
  type LeasedControlCommand,
  type WorkerHeartbeat,
} from "./repository.js";

interface ControlCommandRow {
  readonly command_id: string;
  readonly command_type: string;
  readonly arguments: JsonValue;
  readonly lease_token: string;
  readonly lease_expires_at: string;
}

function isEventPayload(value: JsonValue): value is EventPayload {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asEventPayload(value: JsonValue): EventPayload {
  if (!isEventPayload(value)) {
    throw new Error("control command arguments must be a JSON object");
  }
  return value;
}

function asLeasedCommand(row: ControlCommandRow): LeasedControlCommand {
  if (!isControlCommandKind(row.command_type)) {
    throw new Error(`unsupported control command kind: ${row.command_type}`);
  }
  return {
    commandId: row.command_id,
    kind: row.command_type,
    arguments: asEventPayload(row.arguments),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
  };
}

function rpcFailure(operation: string, error: { readonly message: string }): Error {
  return new Error(`${operation} failed: ${error.message}`);
}

export class SupabaseControlPlaneRepository implements ControlPlaneRepository {
  readonly #client: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.#client = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async heartbeat(heartbeat: WorkerHeartbeat): Promise<void> {
    const { error } = await this.#client.rpc("renew_worker_lease", {
      p_worker_id: heartbeat.workerId,
      p_lease_seconds: heartbeat.leaseSeconds,
      p_capabilities: heartbeat.capabilities,
    });
    if (error) throw rpcFailure("renew_worker_lease", error);
  }

  async claimNext(workerId: string, leaseSeconds: number): Promise<LeasedControlCommand | undefined> {
    const { data, error } = await this.#client.rpc("claim_control_command", {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw rpcFailure("claim_control_command", error);
    if (data === null || data === undefined) return undefined;
    const row = (Array.isArray(data) ? data[0] : data) as ControlCommandRow | undefined;
    return row === undefined ? undefined : asLeasedCommand(row);
  }

  async complete(
    command: LeasedControlCommand,
    workerId: string,
    result: EventPayload,
  ): Promise<void> {
    const { error } = await this.#client.rpc("complete_control_command", {
      p_command_id: command.commandId,
      p_worker_id: workerId,
      p_lease_token: command.leaseToken,
      p_result: result,
    });
    if (error) throw rpcFailure("complete_control_command", error);
  }

  async fail(
    command: LeasedControlCommand,
    workerId: string,
    failure: CommandFailure,
  ): Promise<void> {
    const { error } = await this.#client.rpc("fail_control_command", {
      p_command_id: command.commandId,
      p_worker_id: workerId,
      p_lease_token: command.leaseToken,
      p_error_code: failure.code,
      p_error_message: failure.message,
      p_retryable: failure.retryable,
    });
    if (error) throw rpcFailure("fail_control_command", error);
  }
}
