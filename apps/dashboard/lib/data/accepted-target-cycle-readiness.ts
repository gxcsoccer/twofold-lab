import type {
  AcceptedTargetCycleBlocker,
  AcceptedTargetCycleReadiness,
} from "./contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BLOCKERS = new Set<AcceptedTargetCycleBlocker>([
  "DECISION_NOT_FOUND",
  "ACCEPTED_SUBMISSION_MISSING",
  "STRATEGY_ACCOUNT_MISSING",
  "LEDGER_HEAD_MISSING",
]);

export type AcceptedTargetCycleReadinessValidation =
  | { ok: true; value: AcceptedTargetCycleReadiness }
  | { ok: false; issues: string[] };

export function validateAcceptedTargetCycleReadiness(
  value: unknown,
  expectedDecisionId: string,
): AcceptedTargetCycleReadinessValidation {
  const issues: string[] = [];
  if (containsNumber(value)) issues.push("readiness 不允许 JSON number");
  const state = exactObject(value, [
    "schema",
    "status",
    "decisionId",
    "runId",
    "acceptedSubmissionId",
    "strategyAccountId",
    "ledgerHeadSha256",
    "cycleId",
    "blockers",
  ], issues);
  if (!state) return { ok: false, issues };

  if (state.schema !== "twofold.accepted_target_cycle_readiness/v1") {
    issues.push("readiness.schema 无效");
  }
  const statuses = new Set(["BLOCKED", "READY_FOR_INPUT_BUILD", "COMPLETED"]);
  if (typeof state.status !== "string" || !statuses.has(state.status)) {
    issues.push("readiness.status 无效");
  }
  const decisionId = requiredString(state.decisionId, UUID, "decisionId", issues);
  const runId = nullableString(state.runId, UUID, "runId", issues);
  const submissionId = nullableString(
    state.acceptedSubmissionId,
    UUID,
    "acceptedSubmissionId",
    issues,
  );
  const accountId = nullableString(state.strategyAccountId, UUID, "strategyAccountId", issues);
  const head = nullableString(state.ledgerHeadSha256, SHA256, "ledgerHeadSha256", issues);
  const cycleId = nullableString(state.cycleId, UUID, "cycleId", issues);
  if (decisionId !== null && decisionId !== expectedDecisionId) {
    issues.push("readiness.decisionId 与页面 decision 不一致");
  }

  const blockers = validateBlockers(state.blockers, issues);
  if (blockers !== null && typeof state.status === "string") {
    if (state.status === "READY_FOR_INPUT_BUILD") {
      if (
        blockers.length !== 0 || runId === null || submissionId === null
        || accountId === null || head === null || cycleId !== null
      ) issues.push("readiness READY_FOR_INPUT_BUILD 与持久化前置条件矛盾");
    } else if (state.status === "COMPLETED") {
      if (
        blockers.length !== 0 || runId === null || submissionId === null
        || accountId === null || cycleId === null
      ) issues.push("readiness COMPLETED 与持久化前置条件矛盾");
    } else if (state.status === "BLOCKED") {
      if (blockers.length !== 1 || cycleId !== null) {
        issues.push("readiness BLOCKED 必须只暴露一个因果阻塞点");
      } else if (!coherentBlocker(blockers[0]!, runId, submissionId, accountId, head)) {
        issues.push("readiness blocker 与持久化前置条件矛盾");
      }
    }
  }

  return issues.length === 0
    ? { ok: true, value: value as AcceptedTargetCycleReadiness }
    : { ok: false, issues };
}

function coherentBlocker(
  blocker: AcceptedTargetCycleBlocker,
  runId: string | null,
  submissionId: string | null,
  accountId: string | null,
  head: string | null,
): boolean {
  if (blocker === "DECISION_NOT_FOUND") return runId === null;
  if (blocker === "ACCEPTED_SUBMISSION_MISSING") {
    return runId !== null && submissionId === null;
  }
  if (blocker === "STRATEGY_ACCOUNT_MISSING") {
    return runId !== null && submissionId !== null && accountId === null;
  }
  return runId !== null && submissionId !== null && accountId !== null && head === null;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  issues: string[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push("readiness 必须是对象");
    return null;
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  for (const key of keys) if (!Object.hasOwn(record, key)) issues.push(`readiness.${key} 缺失`);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) issues.push(`readiness.${key} 不属于 v1 schema`);
  }
  return record;
}

function requiredString(
  value: unknown,
  pattern: RegExp,
  field: string,
  issues: string[],
): string | null {
  if (typeof value !== "string" || !pattern.test(value)) {
    issues.push(`readiness.${field} 格式无效`);
    return null;
  }
  return value;
}

function nullableString(
  value: unknown,
  pattern: RegExp,
  field: string,
  issues: string[],
): string | null {
  if (value === null) return null;
  return requiredString(value, pattern, field, issues);
}

function validateBlockers(
  value: unknown,
  issues: string[],
): AcceptedTargetCycleBlocker[] | null {
  if (!Array.isArray(value)) {
    issues.push("readiness.blockers 必须是数组");
    return null;
  }
  const result: AcceptedTargetCycleBlocker[] = [];
  for (const blocker of value) {
    if (typeof blocker !== "string" || !BLOCKERS.has(blocker as AcceptedTargetCycleBlocker)) {
      issues.push("readiness.blockers 包含未知代码");
      return null;
    }
    result.push(blocker as AcceptedTargetCycleBlocker);
  }
  if (new Set(result).size !== result.length) issues.push("readiness.blockers 不得重复");
  return result;
}

function containsNumber(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.some(containsNumber);
  return value !== null && typeof value === "object"
    ? Object.values(value).some(containsNumber)
    : false;
}
