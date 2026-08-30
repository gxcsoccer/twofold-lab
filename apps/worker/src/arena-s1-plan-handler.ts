import { prepareAcceptedTargetCycleS1 } from "@twofold/core";

import { buildArenaS1PlanInput } from "./arena-cycle-inputs.js";
import {
  loadArenaCycleMaterial,
  type ArenaCycleMaterialRpcClient,
} from "./arena-cycle-material.js";
import {
  registerArenaS1PlanExact,
  type ArenaS1PlanRpcClient,
} from "./arena-s1-plan-repository.js";
import {
  buildFrozenOrderPlanRegistration,
} from "./order-plan-registration.js";
import type { ArenaWorkHandler } from "./arena-work-runner.js";

export type ArenaS1PlanClient = ArenaCycleMaterialRpcClient
  & ArenaS1PlanRpcClient;

export function createArenaS1PlanHandler(input: {
  readonly client: ArenaS1PlanClient;
  readonly recordedBy: string;
}): ArenaWorkHandler {
  if (input.recordedBy.trim() === "" || input.recordedBy !== input.recordedBy.trim()) {
    throw new TypeError("recordedBy must be a non-empty trimmed identity");
  }
  return async (item, signal) => {
    signal.throwIfAborted();
    if (item.phase !== "PREPARE_S1_ORDERS") {
      throw new TypeError("S1 plan handler received a different Arena phase");
    }
    const material = await loadArenaCycleMaterial(input.client, {
      roundEntryId: item.roundEntryId,
      stage: "PREPARE_S1_ORDERS",
    });
    signal.throwIfAborted();
    const cycleInput = buildArenaS1PlanInput(material);
    const prepared = prepareAcceptedTargetCycleS1(cycleInput);
    const registration = buildFrozenOrderPlanRegistration({
      idempotencyKey: `arena:${item.roundEntryId}:S1`,
      strategyAccountId: material.portfolio.strategyAccountId,
      runId: item.runId,
      acceptedSubmissionId: material.acceptedSubmission.submissionId,
      plannedAt: material.acceptedSubmission.acceptedAt,
      plannedTradeDate: material.round.s1SessionDate,
      recordedBy: input.recordedBy,
      plan: prepared.plan,
    });
    signal.throwIfAborted();
    const stored = await registerArenaS1PlanExact(input.client, {
      idempotencyKey: `arena:${item.roundEntryId}:PREPARE_S1_ORDERS`,
      roundEntryId: item.roundEntryId,
      expectedHeadSequence: material.portfolio.ledgerHead.sequence,
      expectedHeadSha256: material.portfolio.ledgerHead.sha256,
      registration,
      resultCanonicalJson: prepared.canonicalJson,
      resultSha256: prepared.contentSha256,
      recordedBy: input.recordedBy,
    });
    return Object.freeze({
      outcome: "S1_PLAN_FROZEN",
      stageResultId: stored.stageResultId,
      frozenOrderPlanId: stored.s1FrozenOrderPlanId,
      artifactSha256: stored.artifactSha256,
      orderCount: prepared.plan.orders.length.toString(),
    });
  };
}
