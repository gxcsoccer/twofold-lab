export type ArenaPhaseOutcome = "idle" | "completed" | "failed";

export interface ArenaTickPhase {
  tick(signal: AbortSignal): Promise<ArenaPhaseOutcome>;
}

export interface ArenaTickObserver {
  heartbeat(input: Readonly<{
    workerId: string;
    capabilities: readonly string[];
  }>): Promise<void>;
  record(input: Readonly<{
    startedAt: string;
    finishedAt: string;
    result: ArenaTickResult;
  }>): Promise<void>;
}

export interface ArenaTickResult {
  readonly schema: "twofold.arena_worker_tick/v1";
  readonly workerId: string;
  readonly capabilities: readonly string[];
  readonly outcome: ArenaPhaseOutcome;
  readonly phaseOutcomes: Readonly<{
    agent: ArenaPhaseOutcome;
    cycle: ArenaPhaseOutcome;
    market: ArenaPhaseOutcome;
    corporateActionScan: ArenaPhaseOutcome;
    corporateActionAccount: ArenaPhaseOutcome;
    recovery: ArenaPhaseOutcome;
    season: ArenaPhaseOutcome;
    evolution: ArenaPhaseOutcome;
  }>;
}

/** One bounded, serverless-safe pass through the durable Arena state machine. */
export class ArenaTickRunner {
  readonly #workerId: string;
  readonly #agent: ArenaTickPhase;
  readonly #cycle: ArenaTickPhase;
  readonly #market: ArenaTickPhase;
  readonly #corporateActionScan: ArenaTickPhase;
  readonly #corporateActionAccount: ArenaTickPhase;
  readonly #recovery: ArenaTickPhase;
  readonly #season: ArenaTickPhase;
  readonly #evolution: ArenaTickPhase;
  readonly #hasAgentCapability: boolean;
  readonly #observer: ArenaTickObserver | undefined;
  readonly #now: () => Date;

  constructor(input: {
    readonly workerId: string;
    readonly agent: ArenaTickPhase;
    readonly cycle: ArenaTickPhase;
    readonly market: ArenaTickPhase;
    readonly corporateActionScan: ArenaTickPhase;
    readonly corporateActionAccount: ArenaTickPhase;
    readonly recovery: ArenaTickPhase;
    readonly season: ArenaTickPhase;
    readonly evolution: ArenaTickPhase;
    readonly hasAgentCapability: boolean;
    readonly observer?: ArenaTickObserver;
    readonly now?: () => Date;
  }) {
    if (input.workerId.trim() === "" || input.workerId !== input.workerId.trim()) {
      throw new TypeError("workerId must be a trimmed non-empty identity");
    }
    this.#workerId = input.workerId;
    this.#agent = input.agent;
    this.#cycle = input.cycle;
    this.#market = input.market;
    this.#corporateActionScan = input.corporateActionScan;
    this.#corporateActionAccount = input.corporateActionAccount;
    this.#recovery = input.recovery;
    this.#season = input.season;
    this.#evolution = input.evolution;
    this.#hasAgentCapability = input.hasAgentCapability;
    this.#observer = input.observer;
    this.#now = input.now ?? (() => new Date());
  }

  async tick(signal: AbortSignal): Promise<ArenaTickResult> {
    signal.throwIfAborted();
    const startedAt = this.#now().toISOString();
    const capabilities = this.#capabilities();
    await this.#observer?.heartbeat({ workerId: this.#workerId, capabilities });
    signal.throwIfAborted();
    const corporateActionScan = await this.#corporateActionScan.tick(signal);
    const corporateActionAccount = await this.#corporateActionAccount.tick(signal);
    const [agent, cycle, market, recovery, season, evolution] = await Promise.all([
      this.#agent.tick(signal),
      this.#cycle.tick(signal),
      this.#market.tick(signal),
      this.#recovery.tick(signal),
      this.#season.tick(signal),
      this.#evolution.tick(signal),
    ]);
    const phaseOutcomes = Object.freeze({
      agent,
      cycle,
      market,
      corporateActionScan,
      corporateActionAccount,
      recovery,
      season,
      evolution,
    });
    const outcomes = Object.values(phaseOutcomes);
    const outcome = outcomes.includes("failed")
      ? "failed"
      : outcomes.includes("completed")
        ? "completed"
        : "idle";
    const result = Object.freeze({
      schema: "twofold.arena_worker_tick/v1" as const,
      workerId: this.#workerId,
      capabilities,
      outcome,
      phaseOutcomes,
    });
    await this.#observer?.record({
      startedAt,
      finishedAt: this.#now().toISOString(),
      result,
    });
    return result;
  }

  #capabilities(): readonly string[] {
    return Object.freeze([
      ...(this.#hasAgentCapability ? ["RUN_AGENT_DECISION"] : []),
      "PREPARE_S1_ORDERS",
      "SETTLE_S1_AND_PREPARE_S2",
      "FINALIZE_ACCEPTED_TARGET_CYCLE",
      "CAPTURE_S1_OPEN_REFERENCE",
      "CAPTURE_S1_CLOSE",
      "CAPTURE_S2_OPEN_REFERENCE",
      "CAPTURE_S2_CLOSE",
      "RECONCILE_CORPORATE_ACTIONS",
      "RECOVER_NO_TRADE_ENTRY",
      "PROVISION_NEXT_ROUND",
      "RUN_EVOLUTION_CYCLE",
    ]);
  }
}
