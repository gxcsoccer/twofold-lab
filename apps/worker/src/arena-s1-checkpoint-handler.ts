import { settleAcceptedTargetCycleS1AndPrepareS2 } from "@twofold/core";

import { buildArenaThroughS1Input } from "./arena-cycle-inputs.js";
import {
  loadArenaCycleMaterial,
  type ArenaCycleMaterialRpcClient,
} from "./arena-cycle-material.js";
import {
  registerArenaS1CheckpointExact,
  type ArenaS1CheckpointRpcClient,
} from "./arena-s1-checkpoint-repository.js";
import { buildFrozenOrderPlanRegistration } from "./order-plan-registration.js";
import type { ArenaWorkHandler } from "./arena-work-runner.js";

export type ArenaS1CheckpointClient = ArenaCycleMaterialRpcClient
  & ArenaS1CheckpointRpcClient;

export function createArenaS1CheckpointHandler(input: {
  readonly client: ArenaS1CheckpointClient;
  readonly recordedBy: string;
}): ArenaWorkHandler {
  if (input.recordedBy.trim() === "" || input.recordedBy !== input.recordedBy.trim()) {
    throw new TypeError("recordedBy must be a non-empty trimmed identity");
  }
  return async (item, signal) => {
    signal.throwIfAborted();
    if (item.phase !== "SETTLE_S1_AND_PREPARE_S2") {
      throw new TypeError("S1 checkpoint handler received a different Arena phase");
    }
    const material = await loadArenaCycleMaterial(input.client, {
      roundEntryId: item.roundEntryId,
      stage: "SETTLE_S1_AND_PREPARE_S2",
    });
    signal.throwIfAborted();
    const cycleInput = buildArenaThroughS1Input(material);
    const checkpoint = settleAcceptedTargetCycleS1AndPrepareS2(cycleInput);
    const registration = buildFrozenOrderPlanRegistration({
      idempotencyKey: `arena:${item.roundEntryId}:S2`,
      strategyAccountId: material.portfolio.strategyAccountId,
      runId: item.runId,
      acceptedSubmissionId: material.acceptedSubmission.submissionId,
      plannedAt: cycleInput.timeline.s2PlannedAt,
      plannedTradeDate: cycleInput.timeline.s2TradeDate,
      recordedBy: input.recordedBy,
      plan: checkpoint.s2Plan,
    });
    signal.throwIfAborted();
    const stored = await registerArenaS1CheckpointExact(input.client, {
      idempotencyKey: `arena:${item.roundEntryId}:SETTLE_S1_AND_PREPARE_S2`,
      roundEntryId: item.roundEntryId,
      expectedHeadSequence: material.portfolio.ledgerHead.sequence,
      expectedHeadSha256: material.portfolio.ledgerHead.sha256,
      registration,
      checkpointCanonicalJson: checkpoint.canonicalJson,
      checkpointSha256: checkpoint.contentSha256,
      recordedBy: input.recordedBy,
    });
    return Object.freeze({
      outcome: "S1_SETTLED_S2_PLAN_FROZEN",
      stageResultId: stored.stageResultId,
      frozenOrderPlanId: stored.s2FrozenOrderPlanId,
      artifactSha256: stored.artifactSha256,
      s1SettlementCount: checkpoint.s1.settlements.length.toString(),
      s2OrderCount: checkpoint.s2Plan.orders.length.toString(),
    });
  };
}
