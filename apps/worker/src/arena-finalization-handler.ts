import { runAcceptedTargetCycle } from "@twofold/core";

import { deterministicUuidV8 } from "./accepted-target-cycle-service.js";
import { buildArenaFullCycleInput } from "./arena-cycle-inputs.js";
import {
  loadArenaCycleMaterial,
  type ArenaCycleMaterialRpcClient,
} from "./arena-cycle-material.js";
import {
  finalizeArenaCycleExact,
  loadArenaScoreBase,
  type ArenaFinalizationRpcClient,
} from "./arena-finalization-repository.js";
import { buildArenaCycleFinalValuation } from "./arena-valuation.js";
import type { ArenaWorkHandler } from "./arena-work-runner.js";

export type ArenaFinalizationClient = ArenaCycleMaterialRpcClient
  & ArenaFinalizationRpcClient;

export function createArenaFinalizationHandler(input: {
  readonly client: ArenaFinalizationClient;
  readonly recordedBy: string;
}): ArenaWorkHandler {
  if (input.recordedBy.trim() === "" || input.recordedBy !== input.recordedBy.trim()) {
    throw new TypeError("recordedBy must be a non-empty trimmed identity");
  }
  return async (item, signal) => {
    signal.throwIfAborted();
    if (item.phase !== "FINALIZE_ACCEPTED_TARGET_CYCLE") {
      throw new TypeError("finalization handler received a different Arena phase");
    }
    const material = await loadArenaCycleMaterial(input.client, {
      roundEntryId: item.roundEntryId,
      stage: "FINALIZE_ACCEPTED_TARGET_CYCLE",
    });
    signal.throwIfAborted();
    const cycleInput = buildArenaFullCycleInput(material);
    const cycle = runAcceptedTargetCycle(cycleInput);
    const scoreBaseLiquidationNav = await loadArenaScoreBase(input.client, {
      seasonId: material.roundEntry.seasonId,
      entrantId: material.roundEntry.entrantId,
    });
    const snapshotId = evidenceIdentity(
      material.evidence.s2Close?.snapshotId,
      "evidence.s2Close.snapshotId",
    );
    const valuation = buildArenaCycleFinalValuation({
      cycleInput,
      cycle,
      snapshotId,
      scoreBaseLiquidationNav,
    });
    const cycleId = deterministicUuidV8(
      "twofold.accepted_target_cycle/v1",
      cycle.contentSha256,
    );
    const eventId = deterministicUuidV8(
      "twofold.event.accepted_target_cycle/v1",
      cycleId,
    );
    signal.throwIfAborted();
    const stored = await finalizeArenaCycleExact(input.client, {
      idempotencyKey: `arena:${item.roundEntryId}:FINALIZE_ACCEPTED_TARGET_CYCLE`,
      roundEntryId: item.roundEntryId,
      cycle,
      cycleId,
      eventId,
      completedAt: cycleInput.timeline.navAsOf,
      valuation,
      expected: {
        strategyAccountId: material.portfolio.strategyAccountId,
        runId: item.runId,
        seasonId: item.seasonId,
        entrantId: item.entrantId,
      },
      recordedBy: input.recordedBy,
    });
    return Object.freeze({
      outcome: "ACCEPTED_TARGET_CYCLE_FINALIZED",
      cycleId: stored.cycleId,
      valuationId: stored.valuationId,
      sourceStreamSeq: stored.sourceStreamSeq,
      s1SettlementCount: cycle.s1.settlements.length.toString(),
      s2SettlementCount: cycle.s2.settlements.length.toString(),
      liquidationNav: cycle.nav.liquidationNav,
    });
  };
}

function evidenceIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty identity`);
  }
  return value;
}
