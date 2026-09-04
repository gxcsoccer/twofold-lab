import type { CorporateActionReconciliationResult } from
  "./corporate-action-account-runner.js";
import type { CorporateActionAccountWork } from
  "./corporate-action-work-repository.js";

export interface CorporateActionAccountWorkSource {
  load(asOf: string): Promise<CorporateActionAccountWork>;
}

export type CorporateActionAccountReconcileHandler = (
  work: CorporateActionAccountWork,
  recordedBy: string,
  signal: AbortSignal,
) => Promise<CorporateActionReconciliationResult>;

/**
 * Polls only database-authoritative, time-fenced work. The database remains the
 * scheduler and safety boundary; this class only coordinates exact Core
 * derivation with immutable CAS commits.
 */
export class CorporateActionAccountReconciler {
  readonly #recordedBy: string;
  readonly #source: CorporateActionAccountWorkSource;
  readonly #reconcile: CorporateActionAccountReconcileHandler;
  readonly #now: () => Date;
  #running = false;

  constructor(input: {
    readonly recordedBy: string;
    readonly source: CorporateActionAccountWorkSource;
    readonly reconcile: CorporateActionAccountReconcileHandler;
    readonly now?: () => Date;
  }) {
    if (input.recordedBy.trim() === "" || input.recordedBy !== input.recordedBy.trim()) {
      throw new TypeError("recordedBy must be a trimmed non-empty identity");
    }
    this.#recordedBy = input.recordedBy;
    this.#source = input.source;
    this.#reconcile = input.reconcile;
    this.#now = input.now ?? (() => new Date());
  }

  async tick(signal: AbortSignal): Promise<"idle" | "completed" | "failed"> {
    signal.throwIfAborted();
    if (this.#running) return "idle";
    this.#running = true;
    try {
      const work = await this.#source.load(this.#now().toISOString());
      signal.throwIfAborted();
      if (work.items.length === 0) return "idle";
      const result = await this.#reconcile(work, this.#recordedBy, signal);
      signal.throwIfAborted();
      // Policy and timing blocks are durable fail-closed work. Operational
      // health reports their specific alert codes; they are not transport or
      // Worker failures and must not poison every subsequent tick.
      return result.prepared !== "0" || result.applied !== "0"
        ? "completed"
        : "idle";
    } catch (error) {
      if (signal.aborted) throw error;
      return "failed";
    } finally {
      this.#running = false;
    }
  }
}
