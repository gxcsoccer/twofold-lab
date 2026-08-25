import { retryExactRpcOnce, type RpcResultLike } from "./exact-rpc.js";
import type {
  FrozenOrderPlanRegistration,
  RegisterFrozenOrderPlanRpcArguments,
} from "./order-plan-registration.js";

export interface FrozenOrderPlanRow {
  readonly frozen_order_plan_id: string;
  readonly run_id: string;
  readonly decision_id: string;
  readonly accepted_submission_id: string;
  readonly stage: "S1" | "S2";
  readonly plan_sha256: string;
}

interface FrozenOrderPlanRpcResult extends RpcResultLike {
  readonly data: unknown;
}

export interface FrozenOrderPlanRpcClient {
  rpc(
    functionName: "register_frozen_order_plan",
    arguments_: RegisterFrozenOrderPlanRpcArguments,
  ): PromiseLike<FrozenOrderPlanRpcResult>;
}

/**
 * Persists one already-canonical registration with at most one byte-identical
 * retry after an ambiguous transport result. Database identity/content checks
 * remain authoritative.
 */
export async function registerFrozenOrderPlanExact(
  client: FrozenOrderPlanRpcClient,
  registration: FrozenOrderPlanRegistration,
): Promise<FrozenOrderPlanRow> {
  const result = await retryExactRpcOnce(() => client.rpc(
    "register_frozen_order_plan",
    registration.rpcArguments,
  ));
  if (result.error !== null) {
    throw new Error(`register_frozen_order_plan failed: ${result.error.message}`);
  }
  const candidate = Array.isArray(result.data) ? result.data[0] : result.data;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("register_frozen_order_plan returned no row");
  }
  const row = candidate as Record<string, unknown>;
  const frozen = Object.freeze({
    frozen_order_plan_id: requiredString(row, "frozen_order_plan_id"),
    run_id: requiredString(row, "run_id"),
    decision_id: requiredString(row, "decision_id"),
    accepted_submission_id: requiredString(row, "accepted_submission_id"),
    stage: requiredStage(row.stage),
    plan_sha256: requiredString(row, "plan_sha256"),
  });
  if (
    frozen.run_id !== registration.rpcArguments.p_run_id
    || frozen.decision_id !== registration.rpcArguments.p_decision_id
    || frozen.accepted_submission_id
      !== registration.rpcArguments.p_accepted_submission_id
    || frozen.stage !== registration.rpcArguments.p_stage
    || frozen.plan_sha256 !== registration.planSha256
  ) {
    throw new TypeError(
      "register_frozen_order_plan returned a row inconsistent with the exact request",
    );
  }
  return frozen;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`register_frozen_order_plan row.${field} must be a string`);
  }
  return value;
}

function requiredStage(value: unknown): "S1" | "S2" {
  if (value !== "S1" && value !== "S2") {
    throw new TypeError("register_frozen_order_plan row.stage must be S1 or S2");
  }
  return value;
}
