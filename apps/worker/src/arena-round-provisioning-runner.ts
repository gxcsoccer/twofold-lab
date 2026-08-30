import type { ArenaRoundProvisioningHandler } from
  "./arena-round-provisioning-handler.js";
import type {
  ArenaRoundProvisioning,
  ArenaRoundProvisioningCommit,
  ClaimArenaRoundProvisioningInput,
  CommitArenaRoundProvisioningInput,
  FailArenaRoundProvisioningInput,
} from "./arena-round-provisioning-repository.js";
import { sanitizeFailureMessage } from "./failure-safety.js";

export interface ArenaRoundProvisioningQueue {
  claim(input: ClaimArenaRoundProvisioningInput):
    Promise<ArenaRoundProvisioning | null>;
  commit(input: CommitArenaRoundProvisioningInput):
    Promise<ArenaRoundProvisioningCommit>;
  fail(input: FailArenaRoundProvisioningInput):
    Promise<ArenaRoundProvisioning>;
}

export class ArenaRoundProvisioningRunner {
  readonly #workerId: string;
  readonly #leaseSeconds: number;
  readonly #queue: ArenaRoundProvisioningQueue;
  readonly #handler: ArenaRoundProvisioningHandler;
  readonly #now: () => Date;
  readonly #failureEnvironment: Readonly<Record<string, string | undefined>>;

  constructor(input: {
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly queue: ArenaRoundProvisioningQueue;
    readonly handler: ArenaRoundProvisioningHandler;
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
      throw new Error("provisioning queue returned an unleased request");
    }

    try {
      const material = await this.#handler(item, signal);
      await this.#queue.commit({
        provisioningId: item.provisioningId,
        sourceRoundId: item.sourceRoundId,
        seasonId: item.seasonId,
        roundIndex: item.nextRoundIndex,
        leaseToken: item.leaseToken,
        ...material,
        completedAt: this.#now().toISOString(),
      });
      return "completed";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#queue.fail({
        provisioningId: item.provisioningId,
        leaseToken: item.leaseToken,
        completedAt: this.#now().toISOString(),
        errorCode: signal.aborted
          ? "WORKER_ABORTED"
          : "ROUND_PROVISIONING_FAILED",
        errorMessage: sanitizeFailureMessage(message, this.#failureEnvironment),
        retryable: !signal.aborted,
      });
      return "failed";
    }
  }
}
