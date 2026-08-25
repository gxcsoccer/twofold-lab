import type { ControlCommandKind, EventPayload } from "@twofold/core";
import type { WorkerConfig } from "./config.js";
import type {
  ControlPlaneRepository,
  LeasedControlCommand,
} from "./repository.js";
import { sanitizeFailureMessage } from "./failure-safety.js";

export type CommandHandler = (
  command: LeasedControlCommand,
  signal: AbortSignal,
) => Promise<EventPayload>;

export type CommandHandlers = Partial<Record<ControlCommandKind, CommandHandler>>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TwofoldWorker {
  constructor(
    private readonly config: WorkerConfig,
    private readonly repository: ControlPlaneRepository,
    private readonly handlers: CommandHandlers,
  ) {}

  async tick(signal: AbortSignal): Promise<"idle" | "completed" | "failed"> {
    signal.throwIfAborted();
    await this.repository.heartbeat({
      workerId: this.config.workerId,
      observedAt: new Date().toISOString(),
      leaseSeconds: this.config.leaseSeconds,
      capabilities: { commands: Object.keys(this.handlers) },
    });

    const command = await this.repository.claimNext(
      this.config.workerId,
      this.config.leaseSeconds,
    );
    if (command === undefined) return "idle";

    const handler = this.handlers[command.kind];
    if (handler === undefined) {
      await this.repository.fail(command, this.config.workerId, {
        code: "HANDLER_UNAVAILABLE",
        message: sanitizeFailureMessage(
          `No worker handler is configured for ${command.kind}`,
        ),
        retryable: false,
      });
      return "failed";
    }

    try {
      const result = await handler(command, signal);
      await this.repository.complete(command, this.config.workerId, result);
      return "completed";
    } catch (error) {
      await this.repository.fail(command, this.config.workerId, {
        code: signal.aborted ? "WORKER_ABORTED" : "COMMAND_FAILED",
        message: sanitizeFailureMessage(errorMessage(error)),
        retryable: !signal.aborted,
      });
      return "failed";
    }
  }
}
