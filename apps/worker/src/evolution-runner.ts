import {
  analyzeEvolutionWindow,
  type EvolutionAnalysisReport,
  type EvolutionAnalysisRule,
  type EvolutionMetricObservation,
} from "@twofold/core";

import { sanitizeFailureMessage } from "./failure-safety.js";

export interface EvolutionPolicy {
  readonly schema: "twofold.evolution_policy/v1";
  readonly analyzerVersion: string;
  readonly rules: readonly EvolutionAnalysisRule[];
}

export interface EvolutionCycleClaim {
  readonly cycleId: string;
  readonly leaseToken: string;
  readonly windowStartedAt: string;
  readonly windowEndedAt: string;
  readonly policy: EvolutionPolicy;
}

export interface EvolutionRepository {
  request(input: Readonly<{
    idempotencyKey: string;
    windowStartedAt: string;
    windowEndedAt: string;
    policy: EvolutionPolicy;
    recordedBy: string;
  }>): Promise<void>;
  claim(input: Readonly<{
    workerId: string;
    leaseSeconds: number;
  }>): Promise<EvolutionCycleClaim | null>;
  collect(input: Readonly<{
    windowStartedAt: string;
    windowEndedAt: string;
  }>): Promise<readonly EvolutionMetricObservation[]>;
  complete(input: Readonly<{
    cycleId: string;
    leaseToken: string;
    observations: readonly EvolutionMetricObservation[];
    report: EvolutionAnalysisReport;
    workerId: string;
  }>): Promise<void>;
  fail(input: Readonly<{
    cycleId: string;
    leaseToken: string;
    workerId: string;
    errorCode: string;
    errorMessage: string;
  }>): Promise<void>;
}

export const DEFAULT_EVOLUTION_POLICY: EvolutionPolicy = Object.freeze({
  schema: "twofold.evolution_policy/v1",
  analyzerVersion: "twofold-evolution/v1",
  rules: Object.freeze([
    Object.freeze({
      ruleId: "agent-terminal-failure",
      metricKey: "agent.decision.terminal_failure_rate",
      operator: "GTE" as const,
      threshold: "0.1",
      severity: "HIGH" as const,
      title: "Agent terminal failure rate is elevated",
      diagnosis: "The immutable decision surface exceeds the effective runtime budget.",
      lesson: "Runtime budget must scale with the immutable decision surface.",
      proposedExperimentMode: "LOCAL_REPLAY" as const,
      proposedChangeSurface: "RUNTIME_BUDGET",
    }),
    Object.freeze({
      ruleId: "platform-tick-failure",
      metricKey: "platform.tick.failure_rate",
      operator: "GTE" as const,
      threshold: "0.05",
      severity: "CRITICAL" as const,
      title: "The scheduled control loop is unreliable",
      diagnosis: "At least one bounded tick is failing before the next cadence boundary.",
      lesson: "A control loop is only real when its durable completion evidence is reliable.",
      proposedExperimentMode: "LOCAL_REPLAY" as const,
      proposedChangeSurface: "TICK_ORCHESTRATION",
    }),
    Object.freeze({
      ruleId: "work-retry-pressure",
      metricKey: "platform.work.retry_rate",
      operator: "GTE" as const,
      threshold: "0.1",
      severity: "MEDIUM" as const,
      title: "Durable work is retrying too often",
      diagnosis: "Queue attempts indicate unstable dependencies or undersized phase budgets.",
      lesson: "Retries are evidence of a boundary problem, not a substitute for fixing it.",
      proposedExperimentMode: "LOCAL_REPLAY" as const,
      proposedChangeSurface: "QUEUE_RETRY_POLICY",
    }),
    Object.freeze({
      ruleId: "provider-usage-blind-spot",
      metricKey: "platform.model.usage_unreported_rate",
      operator: "GTE" as const,
      threshold: "0.1",
      severity: "MEDIUM" as const,
      title: "Model usage evidence is incomplete",
      diagnosis: "Provider attempts are completing without exact token and cost evidence.",
      lesson: "Cost and capacity experiments require attempt-level usage evidence.",
      proposedExperimentMode: "ONLINE_SHADOW" as const,
      proposedChangeSurface: "MODEL_USAGE_CAPTURE",
    }),
  ]),
});

export function evolutionWindowFor(now: Date): Readonly<{
  startedAt: string;
  endedAt: string;
  idempotencyKey: string;
}> {
  if (!Number.isFinite(now.getTime())) throw new TypeError("now must be a valid date");
  const cadenceMilliseconds = 6 * 60 * 60 * 1_000;
  const lagMilliseconds = 5 * 60 * 1_000;
  const endedAtMilliseconds = Math.floor(
    (now.getTime() - lagMilliseconds) / cadenceMilliseconds,
  ) * cadenceMilliseconds;
  const endedAt = new Date(endedAtMilliseconds).toISOString();
  return Object.freeze({
    startedAt: new Date(endedAtMilliseconds - cadenceMilliseconds).toISOString(),
    endedAt,
    idempotencyKey: `evolution:6h:${endedAt}`,
  });
}

export class EvolutionRunner {
  readonly #workerId: string;
  readonly #repository: EvolutionRepository;
  readonly #policy: EvolutionPolicy;
  readonly #leaseSeconds: number;
  readonly #now: () => Date;
  readonly #failureEnvironment: Readonly<Record<string, string | undefined>>;

  constructor(input: {
    readonly workerId: string;
    readonly repository: EvolutionRepository;
    readonly policy?: EvolutionPolicy;
    readonly leaseSeconds?: number;
    readonly now?: () => Date;
    readonly failureEnvironment?: Readonly<Record<string, string | undefined>>;
  }) {
    if (input.workerId.trim() === "" || input.workerId !== input.workerId.trim()) {
      throw new TypeError("workerId must be a trimmed non-empty identity");
    }
    this.#workerId = input.workerId;
    this.#repository = input.repository;
    this.#policy = input.policy ?? DEFAULT_EVOLUTION_POLICY;
    this.#leaseSeconds = input.leaseSeconds ?? 180;
    this.#now = input.now ?? (() => new Date());
    this.#failureEnvironment = input.failureEnvironment ?? process.env;
  }

  async tick(signal: AbortSignal): Promise<"idle" | "completed" | "failed"> {
    signal.throwIfAborted();
    const window = evolutionWindowFor(this.#now());
    await this.#repository.request({
      idempotencyKey: window.idempotencyKey,
      windowStartedAt: window.startedAt,
      windowEndedAt: window.endedAt,
      policy: this.#policy,
      recordedBy: this.#workerId,
    });
    const cycle = await this.#repository.claim({
      workerId: this.#workerId,
      leaseSeconds: this.#leaseSeconds,
    });
    if (cycle === null) return "idle";

    try {
      signal.throwIfAborted();
      const observations = await this.#repository.collect({
        windowStartedAt: cycle.windowStartedAt,
        windowEndedAt: cycle.windowEndedAt,
      });
      const report = analyzeEvolutionWindow({
        windowStartedAt: cycle.windowStartedAt,
        windowEndedAt: cycle.windowEndedAt,
        observations,
        rules: cycle.policy.rules,
        analyzerVersion: cycle.policy.analyzerVersion,
      });
      await this.#repository.complete({
        cycleId: cycle.cycleId,
        leaseToken: cycle.leaseToken,
        observations,
        report,
        workerId: this.#workerId,
      });
      return "completed";
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      await this.#repository.fail({
        cycleId: cycle.cycleId,
        leaseToken: cycle.leaseToken,
        workerId: this.#workerId,
        errorCode: signal.aborted ? "WORKER_ABORTED" : "EVOLUTION_ANALYSIS_FAILED",
        errorMessage: sanitizeFailureMessage(rawMessage, this.#failureEnvironment),
      });
      return "failed";
    }
  }
}
