import type { ArenaNoTradeRecoveryHandler } from
  "./arena-no-trade-recovery-handler.js";
import type {
  ArenaNoTradeRecovery,
  ClaimArenaNoTradeRecoveryInput,
  CommitArenaNoTradeRecoveryInput,
  FailArenaNoTradeRecoveryInput,
} from "./arena-no-trade-recovery-repository.js";
import { sanitizeFailureMessage } from "./failure-safety.js";

export interface ArenaNoTradeRecoveryQueue {
  claim(input: ClaimArenaNoTradeRecoveryInput):
    Promise<ArenaNoTradeRecovery | null>;
  commit(input: CommitArenaNoTradeRecoveryInput):
    Promise<ArenaNoTradeRecovery>;
  fail(input: FailArenaNoTradeRecoveryInput):
    Promise<ArenaNoTradeRecovery>;
}

export class ArenaNoTradeRecoveryRunner {
  readonly #workerId: string;
  readonly #leaseSeconds: number;
  readonly #queue: ArenaNoTradeRecoveryQueue;
  readonly #handler: ArenaNoTradeRecoveryHandler;
  readonly #now: () => Date;
  readonly #failureEnvironment: Readonly<Record<string, string | undefined>>;

  constructor(input: {
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly queue: ArenaNoTradeRecoveryQueue;
    readonly handler: ArenaNoTradeRecoveryHandler;
    readonly now?: () => Date;
    readonly failureEnvironment?: Readonly<Record<string, string | undefined>>;
  }) {
    this.#workerId = input.workerId;
    this.#leaseSeconds = input.leaseSeconds;
    this.#queue = input.queue;
    this.#handler = input.handler;
    this.#now = input.now ?? (() => new Date());
    this.#failureEnvironment = input.failureEnvironment ?? process.env;
  }

  async tick(signal: AbortSignal): Promise<"idle" | "completed" | "failed"> {
    signal.throwIfAborted();
    const item = await this.#queue.claim({
      workerId: this.#workerId,
      leaseSeconds: this.#leaseSeconds,
      now: this.#now().toISOString(),
    });
    if (item === null) return "idle";
    if (item.leaseToken === null) {
      throw new Error("no-trade recovery queue returned an unleased request");
    }

    try {
      const valuation = await this.#handler(item, signal);
      await this.#queue.commit({
        recoveryId: item.recoveryId,
        roundEntryId: item.roundEntryId,
        roundId: item.roundId,
        seasonId: item.seasonId,
        entrantId: item.entrantId,
        runId: item.runId,
        reasonCode: item.reasonCode,
        leaseToken: item.leaseToken,
        valuation,
        completedAt: this.#now().toISOString(),
      });
      return "completed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#queue.fail({
        recoveryId: item.recoveryId,
        leaseToken: item.leaseToken,
        completedAt: this.#now().toISOString(),
        errorCode: signal.aborted
          ? "WORKER_ABORTED"
          : "NO_TRADE_RECOVERY_FAILED",
        errorMessage: sanitizeFailureMessage(message, this.#failureEnvironment),
        retryable: !signal.aborted,
      });
      return "failed";
    }
  }
}
