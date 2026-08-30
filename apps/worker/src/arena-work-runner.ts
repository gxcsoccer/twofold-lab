import { sanitizeFailureMessage } from "./failure-safety.js";
import type {
  ArenaWorkItem,
  ArenaWorkPhase,
} from "./arena-work-repository.js";

export type ArenaWorkHandler = (
  item: ArenaWorkItem,
  signal: AbortSignal,
) => Promise<Readonly<Record<string, unknown>>>;

export type ArenaWorkHandlers = Partial<Record<ArenaWorkPhase, ArenaWorkHandler>>;

export class ArenaTerminalWorkError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArenaTerminalWorkError";
    this.code = code;
  }
}

export interface ArenaWorkQueue {
  claim(input: {
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly now: string;
    readonly allowedPhases: readonly ArenaWorkPhase[];
  }): Promise<ArenaWorkItem | null>;
  complete(input: {
    readonly workItemId: string;
    readonly leaseToken: string;
    readonly completedAt: string;
    readonly succeeded: boolean;
    readonly result: Readonly<Record<string, unknown>>;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly retryable: boolean;
  }): Promise<unknown>;
}

export class ArenaWorkRunner {
  readonly #workerId: string;
  readonly #leaseSeconds: number;
  readonly #queue: ArenaWorkQueue;
  readonly #handlers: ArenaWorkHandlers;
  readonly #now: () => Date;
  readonly #failureEnvironment: Readonly<Record<string, string | undefined>>;

  constructor(input: {
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly queue: ArenaWorkQueue;
    readonly handlers: ArenaWorkHandlers;
    readonly now?: () => Date;
    readonly failureEnvironment?: Readonly<Record<string, string | undefined>>;
  }) {
    this.#workerId = input.workerId;
    this.#leaseSeconds = input.leaseSeconds;
    this.#queue = input.queue;
    this.#handlers = input.handlers;
    this.#now = input.now ?? (() => new Date());
    this.#failureEnvironment = input.failureEnvironment ?? process.env;
  }

  async tick(signal: AbortSignal): Promise<"idle" | "completed" | "failed"> {
    signal.throwIfAborted();
    const allowedPhases = (Object.keys(this.#handlers) as ArenaWorkPhase[]).sort();
    if (allowedPhases.length === 0) return "idle";
    const item = await this.#queue.claim({
      workerId: this.#workerId,
      leaseSeconds: this.#leaseSeconds,
      now: this.#now().toISOString(),
      allowedPhases,
    });
    if (item === null) return "idle";
    const handler = this.#handlers[item.phase];
    if (handler === undefined || item.leaseToken === null) {
      throw new Error("queue returned work outside the advertised capabilities");
    }

    try {
      const result = await handler(item, signal);
      const completedAt = this.#now().toISOString();
      if (missedDeadline(item.deadlineAt, completedAt)) {
        await this.#queue.complete({
          workItemId: item.workItemId,
          leaseToken: item.leaseToken,
          completedAt,
          succeeded: false,
          result: Object.freeze({ outcome: "FAILED" }),
          errorCode: "DEADLINE_EXPIRED_DURING_EXECUTION",
          errorMessage: "Work crossed its frozen deadline",
          retryable: false,
        });
        return "failed";
      }
      await this.#queue.complete({
        workItemId: item.workItemId,
        leaseToken: item.leaseToken,
        completedAt,
        succeeded: true,
        result,
        errorCode: null,
        errorMessage: null,
        retryable: false,
      });
      return "completed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = this.#now().toISOString();
      const deadlineExpired = missedDeadline(item.deadlineAt, completedAt);
      const terminal = error instanceof ArenaTerminalWorkError;
      await this.#queue.complete({
        workItemId: item.workItemId,
        leaseToken: item.leaseToken,
        completedAt,
        succeeded: false,
        result: Object.freeze({ outcome: "FAILED" }),
        errorCode: signal.aborted
          ? "WORKER_ABORTED"
          : deadlineExpired
            ? "DEADLINE_EXPIRED_DURING_EXECUTION"
            : terminal
              ? error.code
              : "ARENA_PHASE_FAILED",
        errorMessage: deadlineExpired
          ? "Work crossed its frozen deadline"
          : sanitizeFailureMessage(message, this.#failureEnvironment),
        retryable: !signal.aborted && !deadlineExpired && !terminal,
      });
      return "failed";
    }
  }
}

function missedDeadline(deadlineAt: string | null, completedAt: string): boolean {
  return deadlineAt !== null && Date.parse(completedAt) > Date.parse(deadlineAt);
}
