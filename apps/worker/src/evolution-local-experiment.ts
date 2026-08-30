import {
  comparePortfolioDecisions,
  evaluatePortfolioDecisionExperiment,
  evaluateEvolutionExperiment,
  transitionEvolutionExperiment,
  type EvolutionExperimentResult,
  type EvolutionExperimentSpec,
  type EvolutionExperimentState,
  type PortfolioDecisionComparison,
  type PortfolioDecisionEvolutionEvaluation,
  type PortfolioDecisionEvidence,
  type PortfolioReplayOutcome,
} from "@twofold/core";

export interface LocalEvolutionExperimentPlan {
  readonly spec: EvolutionExperimentSpec;
  readonly proposedAt: string;
  readonly scheduledAt: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly actorId: string;
  readonly trialCode: string;
  readonly inputEvidence: Readonly<Record<string, unknown>>;
  readonly evaluation?: Readonly<{
    baselineValue: string;
    treatmentValue: string;
    guardrails: ReadonlyArray<{
      metricKey: string;
      baselineValue: string;
      treatmentValue: string;
    }>;
  }>;
  readonly decisionComparison?: Readonly<{
    official: PortfolioDecisionEvidence;
    candidate: PortfolioDecisionEvidence;
    officialOutcome: PortfolioReplayOutcome;
    candidateOutcome: PortfolioReplayOutcome;
  }>;
}

export interface EvolutionExperimentStore {
  propose(input: Readonly<{
    state: EvolutionExperimentState;
    actorKind: "model";
    actorId: string;
    at: string;
    idempotencyKey: string;
  }>): Promise<void>;
  transition(input: Readonly<{
    experimentId: string;
    action: "SCHEDULE" | "START" | "COMPLETE";
    actorKind: "worker";
    actorId: string;
    at: string;
    idempotencyKey: string;
    result: EvolutionExperimentResult | null;
  }>): Promise<void>;
  registerTrial(input: Readonly<{
    trialCode: string;
    experimentId: string;
    seasonId: null;
    roundId: null;
    rankingScope: "LOCAL";
    inputEvidence: Readonly<Record<string, unknown>>;
    scheduledAt: string;
    expiresAt: string;
    recordedBy: string;
  }>): Promise<string>;
  registerDecisionComparison(input: Readonly<{
    experimentId: string;
    trialId: string;
    comparison: PortfolioDecisionComparison;
    recordedBy: string;
  }>): Promise<void>;
  registerDecisionEvaluation(input: Readonly<{
    experimentId: string;
    trialId: string;
    evaluation: PortfolioDecisionEvolutionEvaluation;
    recordedBy: string;
  }>): Promise<void>;
  completeTrial(input: Readonly<{
    trialId: string;
    result: EvolutionExperimentResult;
    completedAt: string;
    recordedBy: string;
  }>): Promise<void>;
}

export async function runLocalEvolutionExperiment(
  store: EvolutionExperimentStore,
  plan: LocalEvolutionExperimentPlan,
): Promise<Readonly<{
  trialId: string;
  result: EvolutionExperimentResult;
  state: EvolutionExperimentState;
  decisionEvaluation: PortfolioDecisionEvolutionEvaluation | null;
}>> {
  if (plan.spec.mode !== "LOCAL_REPLAY" || plan.spec.onlineShadow !== null) {
    throw new TypeError("local replay requires a LOCAL_REPLAY experiment spec");
  }
  // Validate the shared evidence fence before creating either the experiment
  // or its trial. Invalid challenger material must leave no durable footprint.
  if ((plan.evaluation === undefined) === (plan.decisionComparison === undefined)) {
    throw new TypeError(
      "local replay requires exactly one legacy evaluation or decision comparison replay",
    );
  }
  const decisionComparison = plan.decisionComparison === undefined
    ? null
    : comparePortfolioDecisions(plan.decisionComparison);
  const decisionEvaluation = plan.decisionComparison === undefined
    ? null
    : evaluatePortfolioDecisionExperiment({
        spec: plan.spec,
        officialDecision: plan.decisionComparison.official,
        candidateDecision: plan.decisionComparison.candidate,
        officialOutcome: plan.decisionComparison.officialOutcome,
        candidateOutcome: plan.decisionComparison.candidateOutcome,
      });
  const actor = Object.freeze({ kind: "worker" as const, id: plan.actorId });
  let state = transitionEvolutionExperiment(null, {
    type: "PROPOSE",
    spec: plan.spec,
    actor: { kind: "model", id: plan.actorId },
    at: plan.proposedAt,
  });
  await store.propose({
    state,
    actorKind: "model",
    actorId: plan.actorId,
    at: plan.proposedAt,
    idempotencyKey: `${plan.spec.experimentCode}:propose`,
  });
  state = transitionEvolutionExperiment(state, {
    type: "SCHEDULE", actor, at: plan.scheduledAt,
  });
  await store.transition({
    experimentId: plan.spec.experimentId,
    action: "SCHEDULE",
    actorKind: "worker",
    actorId: plan.actorId,
    at: plan.scheduledAt,
    idempotencyKey: `${plan.spec.experimentCode}:schedule`,
    result: null,
  });
  const trialId = await store.registerTrial({
    trialCode: plan.trialCode,
    experimentId: plan.spec.experimentId,
    seasonId: null,
    roundId: null,
    rankingScope: "LOCAL",
    inputEvidence: plan.inputEvidence,
    scheduledAt: plan.scheduledAt,
    expiresAt: plan.spec.expiresAt,
    recordedBy: plan.actorId,
  });
  if (decisionComparison !== null) {
    await store.registerDecisionComparison({
      experimentId: plan.spec.experimentId,
      trialId,
      comparison: decisionComparison,
      recordedBy: plan.actorId,
    });
  }
  state = transitionEvolutionExperiment(state, {
    type: "START", actor, at: plan.startedAt,
  });
  await store.transition({
    experimentId: plan.spec.experimentId,
    action: "START",
    actorKind: "worker",
    actorId: plan.actorId,
    at: plan.startedAt,
    idempotencyKey: `${plan.spec.experimentCode}:start`,
    result: null,
  });
  const result = decisionEvaluation?.result
    ?? evaluateEvolutionExperiment(plan.spec, plan.evaluation!);
  if (decisionEvaluation !== null) {
    await store.registerDecisionEvaluation({
      experimentId: plan.spec.experimentId,
      trialId,
      evaluation: decisionEvaluation,
      recordedBy: plan.actorId,
    });
  }
  await store.completeTrial({
    trialId,
    result,
    completedAt: plan.completedAt,
    recordedBy: plan.actorId,
  });
  state = transitionEvolutionExperiment(state, {
    type: "COMPLETE", actor, at: plan.completedAt, result,
  });
  await store.transition({
    experimentId: plan.spec.experimentId,
    action: "COMPLETE",
    actorKind: "worker",
    actorId: plan.actorId,
    at: plan.completedAt,
    idempotencyKey: `${plan.spec.experimentCode}:complete`,
    result,
  });
  return Object.freeze({ trialId, result, state, decisionEvaluation });
}
