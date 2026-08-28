import { createHash } from "node:crypto";

import {
  runAcceptedTargetCycle,
  type AcceptedTargetCycleInput,
  type AcceptedTargetCycleResult,
} from "@twofold/core";

import {
  commitAcceptedTargetCycleExact,
  type AcceptedTargetCycleCommitResult,
  type AcceptedTargetCycleCommitRpcClient,
} from "./accepted-target-cycle-repository.js";
import {
  buildFrozenOrderPlanRegistration,
  type FrozenOrderPlanRegistration,
} from "./order-plan-registration.js";
import {
  registerFrozenOrderPlanExact,
  type FrozenOrderPlanRow,
  type FrozenOrderPlanRpcClient,
} from "./order-plan-repository.js";

export type AcceptedTargetCycleClient = FrozenOrderPlanRpcClient
  & AcceptedTargetCycleCommitRpcClient;

export interface ExecuteAcceptedTargetCycleInput {
  readonly cycleInput: AcceptedTargetCycleInput;
  readonly expectedRunStreamSequence: string;
  readonly expectedProjectionStreamSequence: string;
  readonly idempotencyKey: string;
  readonly recordedBy: string;
}

export interface ExecutedAcceptedTargetCycle {
  readonly cycle: AcceptedTargetCycleResult;
  readonly s1Registration: FrozenOrderPlanRegistration;
  readonly s1Plan: FrozenOrderPlanRow;
  readonly s2Registration: FrozenOrderPlanRegistration;
  readonly s2Plan: FrozenOrderPlanRow;
  readonly commit: AcceptedTargetCycleCommitResult;
}

/**
 * The sole application handoff from an accepted target to durable execution.
 * The Core owns financial derivation; Supabase admits the exact plans and one
 * content-addressed cycle artifact under the run-stream CAS fence and the
 * strategy ledger-head row lock.
 *
 * This spans three durable RPCs and is deliberately NOT atomic across them.
 * `frozen_order_plan` is immutable and unique per `(decision_id, stage)`, so a
 * crash after either plan registration commits that plan permanently: recovery
 * requires re-deriving byte-identical plans from the same frozen inputs, and any
 * input change strands the decision. Callers must therefore treat the cycle
 * input as frozen evidence, not as something recomputed at retry time. Folding
 * all three writes into one RPC is the tracked follow-up; see docs/status.md.
 */
export async function executeAcceptedTargetCycle(
  client: AcceptedTargetCycleClient,
  input: ExecuteAcceptedTargetCycleInput,
): Promise<ExecutedAcceptedTargetCycle> {
  requireIdentity(input.idempotencyKey, "idempotencyKey");
  requireIdentity(input.recordedBy, "recordedBy");
  requireInteger(input.expectedRunStreamSequence, "expectedRunStreamSequence");
  requireInteger(
    input.expectedProjectionStreamSequence,
    "expectedProjectionStreamSequence",
  );

  const cycle = runAcceptedTargetCycle(input.cycleInput);
  const common = {
    strategyAccountId: input.cycleInput.account.strategyAccountId,
    runId: input.cycleInput.account.runId,
    acceptedSubmissionId: cycle.submissionId,
    recordedBy: input.recordedBy,
  } as const;
  const s1Registration = buildFrozenOrderPlanRegistration({
    ...common,
    idempotencyKey: `${input.idempotencyKey}:plan:S1`,
    plannedAt: input.cycleInput.timeline.s1PlannedAt,
    plannedTradeDate: input.cycleInput.timeline.s1TradeDate,
    plan: cycle.s1.plan,
  });
  const s1Plan = await registerFrozenOrderPlanExact(client, s1Registration);
  const s2Registration = buildFrozenOrderPlanRegistration({
    ...common,
    idempotencyKey: `${input.idempotencyKey}:plan:S2`,
    plannedAt: input.cycleInput.timeline.s2PlannedAt,
    plannedTradeDate: input.cycleInput.timeline.s2TradeDate,
    plan: cycle.s2.plan,
  });
  const s2Plan = await registerFrozenOrderPlanExact(client, s2Registration);

  const cycleId = deterministicUuidV8(
    "twofold.accepted_target_cycle/v1",
    cycle.contentSha256,
  );
  const eventId = deterministicUuidV8(
    "twofold.event.accepted_target_cycle/v1",
    cycleId,
  );
  const commit = await commitAcceptedTargetCycleExact(client, Object.freeze({
    p_idempotency_key: `${input.idempotencyKey}:commit`,
    p_cycle_id: cycleId,
    p_strategy_account_id: input.cycleInput.account.strategyAccountId,
    p_run_id: input.cycleInput.account.runId,
    p_decision_id: cycle.decisionId,
    p_accepted_submission_id: cycle.submissionId,
    p_s1_frozen_order_plan_id: s1Plan.frozen_order_plan_id,
    p_s2_frozen_order_plan_id: s2Plan.frozen_order_plan_id,
    p_cycle_canonical_json: cycle.canonicalJson,
    p_cycle_sha256: cycle.contentSha256,
    p_completed_at: input.cycleInput.timeline.navAsOf,
    p_expected_run_stream_seq: input.expectedRunStreamSequence,
    p_expected_projection_stream_seq: input.expectedProjectionStreamSequence,
    p_event_id: eventId,
    p_recorded_by: input.recordedBy,
  }));

  return Object.freeze({
    cycle,
    s1Registration,
    s1Plan,
    s2Registration,
    s2Plan,
    commit,
  });
}

export function deterministicUuidV8(namespace: string, stableKey: string): string {
  requireIdentity(namespace, "namespace");
  requireIdentity(stableKey, "stableKey");
  const bytes = (value: string) => Buffer.byteLength(value, "utf8").toString();
  const digest = createHash("sha256")
    .update(`${bytes(namespace)}:${namespace}:${bytes(stableKey)}:${stableKey}`, "utf8")
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function requireIdentity(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty trimmed string`);
  }
}

function requireInteger(value: string, field: string): void {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
}
